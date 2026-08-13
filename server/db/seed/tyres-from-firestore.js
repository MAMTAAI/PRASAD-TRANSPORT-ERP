// server/db/seed/tyres-from-firestore.js
// ---------------------------------------------------------------------------
// Firestore TYRE_MASTER / TYRE_FITMENTS (and BATTERY_* if they ever hold data)
// -> PostgreSQL `tyres` / `tyre_fitments` / `batteries` / `battery_fitments`.
//
//   node server/db/seed/tyres-from-firestore.js             DRY RUN (default)
//   node server/db/seed/tyres-from-firestore.js --live      commit
//   node server/db/seed/tyres-from-firestore.js --file backups/firestore-backup-X.json
//
// Sibling of from-firestore.js and shares its properties: IDEMPOTENT (keys on
// legacy_id, ON CONFLICT DO UPDATE), TRANSACTIONAL (one transaction per
// collection), LOSSLESS (any repair is reported AND stamped into the row) and
// READ-ONLY at the source. It differs in one way on purpose: this one DRY RUNS
// unless told otherwise, matching the safety rule the rest of this system
// states out loud — nothing writes without --live.
//
// *** IT POSTS NO VOUCHERS, AND THAT IS DELIBERATE. ***
// 036 makes a tyre purchase post Dr Tyre Stock / Cr bank-or-vendor. These rows
// are HISTORY: they were bought in the Firestore era, which wrote its own
// BANK_TRANSACTIONS row at the time. Re-posting them now would invent cash
// movements on dates that are already closed.
//
// The consequence is stated rather than hidden: the balance sheet will show
// Tyre Stock at 0.00 while real tyres sit in the yard. Those Firestore
// BANK_TRANSACTIONS were never migrated into ledger_entries either (checked:
// zero entries for any of these invoice numbers), so the cost is currently in
// NEITHER book. Correcting that is one opening-stock journal
// — Dr Tyre Stock / Cr <the owner's chosen equity or suspense account> —
// and the credit side is an accounting policy decision, not something a loader
// should pick. The run prints the exact figure to post.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { initDb, withTransaction, query, closePool, DB_TARGET } from '../pool.js';

const LIVE = process.argv.includes('--live');
const fileArg = process.argv.indexOf('--file');
const BACKUPS_DIR = join(process.cwd(), 'backups');

const report = {
  source: null, target: null, mode: LIVE ? 'LIVE' : 'DRY-RUN',
  started_at: new Date().toISOString(),
  collections: {}, repairs: [], skipped: [], notes: [],
};
const repair = (coll, id, what) => report.repairs.push({ coll, id, what });
const skip = (coll, id, why) => report.skipped.push({ coll, id, why });

function newestBackup() {
  const files = readdirSync(BACKUPS_DIR).filter((f) => /^firestore-backup-.*\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`no firestore-backup-*.json in ${BACKUPS_DIR}`);
  return join(BACKUPS_DIR, files[files.length - 1]);
}

const norm = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
/** Money stays a string all the way into pg so no rupee value meets a JS float. */
const money = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
/** Firestore timestamp {_seconds} | ISO string | Date -> YYYY-MM-DD */
const asDate = (v) => {
  if (!v) return null;
  if (typeof v === 'object' && v._seconds != null) return new Date(v._seconds * 1000).toISOString().slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
/** 'IN STOCK' -> 'IN_STOCK'; the tables use the underscored spelling. */
const normStatus = (v) => (v == null ? null : String(v).trim().toUpperCase().replace(/\s+/g, '_'));

const rows = (coll) => Object.entries(coll ?? {}).map(([id, w]) => ({ __id: id, ...(w.__data__ ?? w) }));

// These tables are NOT in autoSync's SYNC_TABLES, so each database has to be
// loaded on its own — and left to gen_random_uuid() each would mint a DIFFERENT
// id for the same Firestore document. That is exactly the divergence that put
// four duplicated stock ledgers on the replica and cost migrations 037 and 038:
// the moment anything replicates these tables by id, every row lands twice.
// Deriving the id from the source document id (UUID v5 over a fixed namespace)
// makes the load reproducible everywhere — same document, same primary key, on
// every database and on every re-run.
const NS = 'prasad-erp/firestore/';
const uuidFor = (kind, legacyId) => {
  const h = createHash('sha1').update(`${NS}${kind}/${legacyId}`).digest('hex').slice(0, 32).split('');
  h[12] = '5';                                                    // version 5
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);       // RFC 4122 variant
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
};

// ONE transaction for components AND fitments, not one per collection like the
// sibling loader. A fitment resolves its component by serial, so it has to see
// the rows the component pass just inserted — with a transaction each, a dry
// run rolls the tyres back first and then reports every fitment as an orphan,
// which is a lie about the data. Sharing the transaction also makes the load
// all-or-nothing, which is what you want for a set this interdependent.

(async () => {
  const file = fileArg > -1 ? process.argv[fileArg + 1] : newestBackup();
  report.source = file;
  const dump = JSON.parse(readFileSync(file, 'utf8')).collections ?? {};

  await initDb();
  report.target = DB_TARGET;
  console.log(`[tyre-load] ${report.mode} - source ${file} - target ${DB_TARGET}`);

  // Firestore recorded WHEN THE ROW WAS TYPED IN, not when the tyre was bought;
  // one invoice here is dated 2025-12-22 but was entered in July. The bank row
  // written at purchase time carries the real date, so prefer it and say so.
  const bankDateByRef = new Map();
  for (const b of rows(dump.BANK_TRANSACTIONS)) {
    const ref = String(b.ref_no ?? '').trim();
    if (ref && b.date && !bankDateByRef.has(ref)) bankDateByRef.set(ref, asDate(b.date));
  }

  // ---- components --------------------------------------------------------
  const COMPONENTS = [
    { key: 'TYRE_MASTER', table: 'tyres' },
    { key: 'BATTERY_MASTER', table: 'batteries' },
  ];
  await withTransaction(async (t) => {
  for (const C of COMPONENTS) {
    const src = rows(dump[C.key]);
    report.collections[C.key] = { found: src.length, loaded: 0 };
    if (!src.length) { console.log(`  ${C.key}: absent from the export - nothing to load`); continue; }
    let loaded = 0;
    {
      for (const r of src) {
        const serial = String(r.serial_no ?? '').trim();
        if (!serial) { skip(C.key, r.__id, 'no serial_no'); continue; }
        const invoice = String(r.invoice_no ?? '').trim() || null;
        const bankDate = invoice ? bankDateByRef.get(invoice) : null;
        if (bankDate) {
          repair(C.key, r.__id, `purchase_date ${bankDate} taken from the BANK_TRANSACTIONS row for invoice ${invoice}; Firestore only had createdAt ${asDate(r.createdAt)}`);
        }
        const pdate = bankDate ?? asDate(r.purchase_date) ?? asDate(r.createdAt);
        const common = [
          uuidFor(C.table, r.__id), r.__id, serial, r.brand ?? null, money(r.cost ?? r.purchase_cost),
          money(r.base_cost), money(r.gst_amount), num(r.gst_percent),
          invoice, r.invoice_file_url || null, r.vendor ?? r.vendor_name ?? null,
          normStatus(r.status) ?? 'IN_STOCK', pdate,
        ];
        if (C.table === 'tyres') {
          await t.query(
            `INSERT INTO tyres (id, legacy_id, serial_no, brand, purchase_cost, base_cost, gst_amount,
                                gst_percent, invoice_no, invoice_url, vendor_name, status, purchase_date,
                                tyre_type, total_km_run)
             VALUES ($1::uuid,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric,$8,$9,$10,$11,$12,$13::date,$14,$15::numeric)
             ON CONFLICT (legacy_id) DO UPDATE SET
               serial_no=EXCLUDED.serial_no, brand=EXCLUDED.brand, purchase_cost=EXCLUDED.purchase_cost,
               base_cost=EXCLUDED.base_cost, gst_amount=EXCLUDED.gst_amount, gst_percent=EXCLUDED.gst_percent,
               invoice_no=EXCLUDED.invoice_no, invoice_url=EXCLUDED.invoice_url,
               vendor_name=EXCLUDED.vendor_name, status=EXCLUDED.status,
               purchase_date=EXCLUDED.purchase_date, tyre_type=EXCLUDED.tyre_type,
               total_km_run=EXCLUDED.total_km_run, updated_at=now()`,
            [...common, normStatus(r.type) ?? 'NEW', money(r.total_km_run ?? 0)]);
        } else {
          await t.query(
            `INSERT INTO batteries (id, legacy_id, serial_no, brand, purchase_cost, base_cost, gst_amount,
                                    gst_percent, invoice_no, invoice_url, vendor_name, status, purchase_date,
                                    capacity_ah, warranty_months)
             VALUES ($1::uuid,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric,$8,$9,$10,$11,$12,$13::date,$14::numeric,$15::int)
             ON CONFLICT (legacy_id) DO UPDATE SET
               serial_no=EXCLUDED.serial_no, brand=EXCLUDED.brand, purchase_cost=EXCLUDED.purchase_cost,
               status=EXCLUDED.status, purchase_date=EXCLUDED.purchase_date, updated_at=now()`,
            [...common, num(r.capacity_ah), num(r.warranty_months)]);
        }
        loaded++;
      }
    }
    report.collections[C.key].loaded = loaded;
    console.log(`  ${C.key}: ${loaded}/${src.length} -> ${C.table}`);
  }

  // ---- fitments ----------------------------------------------------------
  const { rows: vehRows } = await t.query(`SELECT id, vehicle_no FROM vehicles`);
  const byPlate = new Map(vehRows.map((v) => [norm(v.vehicle_no), v]));

  const FITMENTS = [
    { key: 'TYRE_FITMENTS', table: 'tyre_fitments', comp: 'tyres', idCol: 'tyre_id', serialCol: 'tyre_serial' },
    { key: 'BATTERY_FITMENTS', table: 'battery_fitments', comp: 'batteries', idCol: 'battery_id', serialCol: 'battery_serial' },
  ];
  for (const F of FITMENTS) {
    const src = rows(dump[F.key]);
    report.collections[F.key] = { found: src.length, loaded: 0 };
    if (!src.length) { console.log(`  ${F.key}: absent from the export - nothing to load`); continue; }
    // t.query, not query: the components were inserted in THIS transaction.
    const { rows: comps } = await t.query(`SELECT id, serial_no, purchase_cost FROM ${F.comp}`);
    const bySerial = new Map(comps.map((c) => [norm(c.serial_no), c]));
    let loaded = 0;
    {
      for (const r of src) {
        const serial = String(r[F.serialCol] ?? r.tyre_serial ?? r.battery_serial ?? '').trim();
        const plateRaw = String(r.vehicle_no ?? '').trim();
        let veh = byPlate.get(norm(plateRaw));
        let removalReason = r.removal_reason ?? null;

        // A truncated plate is repaired only on hard evidence, never on a hunch:
        // exactly ONE fleet plate may end with what was typed, AND the same
        // component must have another fitment on that very plate. Anything less
        // certain is skipped for a human, because inventing a vehicle would
        // attach a real tyre to the wrong truck's cost history.
        if (!veh && plateRaw) {
          const cands = [...byPlate.entries()].filter(([k]) => k !== norm(plateRaw) && k.endsWith(norm(plateRaw)));
          const corroborated = cands.length === 1 && src.some((o) => o !== r
            && norm(o[F.serialCol] ?? o.tyre_serial ?? o.battery_serial ?? '') === norm(serial)
            && norm(o.vehicle_no) === cands[0][0]);
          if (corroborated) {
            veh = cands[0][1];
            const stamp = `[plate repaired: '${plateRaw}' -> '${veh.vehicle_no}']`;
            removalReason = removalReason ? `${removalReason} ${stamp}` : stamp;
            repair(F.key, r.__id, `vehicle_no '${plateRaw}' resolved to '${veh.vehicle_no}' - unique suffix match, corroborated by another fitment of the same component on that plate. Stamped into removal_reason.`);
          }
        }
        if (!veh) {
          skip(F.key, r.__id, `vehicle_no '${plateRaw}' is not in the fleet master and could not be resolved on evidence - ${F.table}.vehicle_id is NOT NULL`);
          continue;
        }

        const comp = bySerial.get(norm(serial));
        if (!comp) { skip(F.key, r.__id, `serial '${serial}' has no row in ${F.comp}`); continue; }

        await t.query(
          `INSERT INTO ${F.table} (id, legacy_id, ${F.serialCol}, ${F.idCol}, vehicle_id, vehicle_no, position,
                                   fitment_date, fitment_km, removal_date, removal_km, removal_reason, cost)
           VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::date,$9::numeric,$10::date,$11::numeric,$12,$13::numeric)
           ON CONFLICT (legacy_id) DO UPDATE SET
             vehicle_id=EXCLUDED.vehicle_id, vehicle_no=EXCLUDED.vehicle_no, position=EXCLUDED.position,
             fitment_date=EXCLUDED.fitment_date, fitment_km=EXCLUDED.fitment_km,
             removal_date=EXCLUDED.removal_date, removal_km=EXCLUDED.removal_km,
             removal_reason=EXCLUDED.removal_reason, cost=EXCLUDED.cost`,
          [uuidFor(F.table, r.__id), r.__id, serial, comp.id, veh.id, veh.vehicle_no, r.position ?? null,
           asDate(r.fitment_date) ?? asDate(r.createdAt), money(r.fitting_km ?? r.fitment_km),
           asDate(r.removal_date), money(r.removal_km), removalReason,
           money(r.cost ?? comp.purchase_cost)]);
        loaded++;
      }
    }
    report.collections[F.key].loaded = loaded;
    console.log(`  ${F.key}: ${loaded}/${src.length} -> ${F.table}`);
  }
  if (!LIVE) throw Object.assign(new Error('dry run'), { code: 'DRY_RUN_ROLLBACK' });
  }).catch((e) => { if (e.code !== 'DRY_RUN_ROLLBACK') throw e; });

  // ---- the opening-stock figure this loader deliberately does not post ----
  const tyreRows = rows(dump.TYRE_MASTER);
  const openingStock = tyreRows
    .filter((r) => normStatus(r.status) !== 'SCRAPPED')
    .reduce((a, r) => a + (Number(r.cost) || 0), 0);
  report.notes.push(`No voucher posted. Opening stock that would restate the balance sheet: Rs ${openingStock.toFixed(2)} across ${tyreRows.length} tyres (Dr Tyre Stock / Cr an account the owner chooses).`);

  report.finished_at = new Date().toISOString();
  const out = join(BACKUPS_DIR, `tyre-migration-report-${report.finished_at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n  repairs: ${report.repairs.length}   skipped: ${report.skipped.length}`);
  report.skipped.forEach((s) => console.log(`   SKIP ${s.coll} ${s.id}: ${s.why}`));
  console.log(`  opening stock NOT posted: Rs ${openingStock.toFixed(2)}`);
  console.log(`  report: ${out}`);
  if (!LIVE) console.log('\n  DRY RUN - every transaction was rolled back. Re-run with --live to commit.');
  await closePool();
})().catch((e) => { console.error('[tyre-load] FAILED:', e.message); process.exit(1); });
