// tools/attach-held-invoices.mjs
// ─────────────────────────────────────────────────────────────────────────────
// ATTACH THE AC5 INVOICES THE IMPORTER REFUSED TO ATTACH.
//
// iocl_ac5_loading.py classifies a parsed AC5 as DUP_SHAPE when it matches an
// existing trip on vehicle + loading date + quantity but its invoice number is
// on no trip at all. It will not attach those by itself, and it is right not
// to: deciding that two records describe the same movement is a judgement, and
// a dedup rule that guesses wrong writes a wrong invoice number onto a real
// trip. So they are held, and a person decides.
//
// This is the tool that carries out the decision. It is deliberately NOT part
// of the importer.
//
// WHAT IT VERIFIES BEFORE WRITING ANYTHING — and it refuses the row, not the
// run, when a check fails:
//
//   1. the trip exists;
//   2. the trip's iocl_invoice_no IS NULL. The report's own wording says the
//      matched trip "has no invoice number recorded", but that is the SCRIPT'S
//      description, not something its index enforces: by_shape is built from
//      every trip, invoice or not, and DUP_SHAPE only means this INVOICE is on
//      no trip. A matched trip carrying a DIFFERENT invoice is possible, and
//      overwriting it would destroy a recorded fact;
//   3. the vehicle, loading date and quantity still match the PDF — the trip
//      may have been edited since the report was written;
//   4. the invoice number is not already on some other trip.
//
// Quantities need no writing: an exact match on quantity is part of what makes
// a DUP_SHAPE, so the trip already carries the AC5's figure.
//
// NO LEDGER, NO VOUCHER. Attaching an invoice number to a trip records which
// paper the movement came in on. It moves no money and posts nothing — TARA is
// not involved and must not be.
//
//   node tools/attach-held-invoices.mjs                  # dry run (default)
//   node tools/attach-held-invoices.mjs --apply
//   node tools/attach-held-invoices.mjs --apply --only PT00630,PT00647
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { query, withTransaction, closePool } from '../server/db/pool.js';

const REPO = path.resolve(import.meta.dirname, '..');
const REPORT = process.env.AC5_REPORT
  || path.join(REPO, 'reports', 'iocl_recon', 'ac5_loading.json');

const APPLY = process.argv.includes('--apply');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 && process.argv[onlyArg + 1]
  ? new Set(process.argv[onlyArg + 1].split(',').map((s) => s.trim().toUpperCase()))
  : null;
const ACTOR = process.env.ATTACH_ACTOR || 'attach-held-invoices';

const norm = (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase();
const q3 = (v) => (v === null || v === undefined ? null : Number(v).toFixed(3));

let report;
try { report = JSON.parse(readFileSync(REPORT, 'utf8')); }
catch (e) {
  console.error(`cannot read ${REPORT}: ${e.message}`);
  console.error('Run the importer first — it writes this file on every pass.');
  process.exit(1);
}

// IOCL mails the same invoice more than once, so the report can list one
// (trip, invoice) pair twice. Deduped here rather than relying on the UPDATE
// being idempotent, so the printed count is the number of real decisions.
const held = [];
const seen = new Set();
for (const r of report.dup_shape ?? []) {
  const key = `${r.trip}|${r.doc_no}`;
  if (seen.has(key)) continue;
  seen.add(key);
  held.push(r);
}

if (!held.length) {
  console.log('Nothing held for review in', REPORT);
  await closePool();
  process.exit(0);
}

console.log(`\nAC5 held-invoice attachment   ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}`);
console.log(`report: ${REPORT}`);
console.log(`window: ${(report.window ?? []).join(' .. ')}`);
console.log(`${held.length} distinct (trip, invoice) pair(s) held\n`);

const ok = [];
const refused = [];

for (const h of held) {
  const code = String(h.trip).toUpperCase();
  if (ONLY && !ONLY.has(code)) continue;
  const inv = String(h.doc_no);

  const { rows } = await query(
    `SELECT id, trip_code, vehicle_no, loading_date, loaded_qty, iocl_invoice_no,
            operating_company, product_type
       FROM trips WHERE upper(trip_code) = $1`, [code]);
  if (!rows.length) { refused.push([code, inv, 'no such trip']); continue; }
  if (rows.length > 1) { refused.push([code, inv, `${rows.length} trips share this code`]); continue; }
  const t = rows[0];

  if (t.iocl_invoice_no && String(t.iocl_invoice_no) !== inv) {
    refused.push([code, inv, `trip already carries invoice ${t.iocl_invoice_no} — not overwriting`]);
    continue;
  }
  if (String(t.iocl_invoice_no ?? '') === inv) {
    refused.push([code, inv, 'already attached (nothing to do)']);
    continue;
  }
  if (norm(t.vehicle_no) !== norm(h.vehicle_no)) {
    refused.push([code, inv, `vehicle moved: trip ${t.vehicle_no} vs pdf ${h.vehicle_no}`]);
    continue;
  }
  const tripDate = t.loading_date ? new Date(t.loading_date).toISOString().slice(0, 10) : null;
  if (tripDate !== h.loading_date) {
    refused.push([code, inv, `date moved: trip ${tripDate} vs pdf ${h.loading_date}`]);
    continue;
  }
  if (q3(t.loaded_qty) !== q3(h.qty_kl)) {
    refused.push([code, inv, `qty moved: trip ${q3(t.loaded_qty)} vs pdf ${q3(h.qty_kl)}`]);
    continue;
  }
  const { rows: clash } = await query(
    'SELECT trip_code FROM trips WHERE iocl_invoice_no = $1 AND id <> $2::uuid', [inv, t.id]);
  if (clash.length) {
    refused.push([code, inv, `invoice already on ${clash.map((c) => c.trip_code).join(', ')}`]);
    continue;
  }

  ok.push({ id: t.id, code, inv, vehicle: t.vehicle_no, date: tripDate,
            qty: q3(t.loaded_qty), company: t.operating_company, product: t.product_type });
}

console.log('WILL ATTACH');
if (!ok.length) console.log('  (none)');
for (const r of ok) {
  console.log(`  ${r.code.padEnd(9)} inv ${r.inv}  ${String(r.vehicle).padEnd(12)} ${r.date}  ${String(r.qty).padStart(8)} KL  ${r.company ?? '(company unassigned)'}`);
}
if (refused.length) {
  console.log('\nREFUSED — each of these needs a person, not a retry');
  for (const [c, i, why] of refused) console.log(`  ${c.padEnd(9)} inv ${i}  ${why}`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write.\n');
  await closePool();
  process.exit(0);
}

if (ok.length) {
  // One transaction: either the whole approved batch lands or none of it does.
  // A half-attached batch is the worst outcome — the next run would see some
  // rows as DUP_INVOICE and some still held, and nobody could tell whether that
  // was the decision or the crash.
  await withTransaction(async (client) => {
    for (const r of ok) {
      await client.query(
        `UPDATE trips
            SET iocl_invoice_no = $2,
                remarks = COALESCE(NULLIF(btrim(remarks), '') || ' | ', '')
                          || 'AC5 invoice ' || $2 || ' attached ' || to_char(now(), 'YYYY-MM-DD')
                          || ' by ' || $3
          WHERE id = $1::uuid`,
        [r.id, r.inv, ACTOR]);
    }
  });
  console.log(`\n✅ attached ${ok.length} invoice(s).`);
} else {
  console.log('\nNothing to attach.');
}

// Read back, so the run reports what the DATABASE says rather than what the
// script believes it did.
const codes = ok.map((r) => r.code);
if (codes.length) {
  const { rows } = await query(
    `SELECT trip_code, iocl_invoice_no, vehicle_no, loading_date, loaded_qty
       FROM trips WHERE upper(trip_code) = ANY($1) ORDER BY trip_code`, [codes]);
  console.log('\nAFTER — read back from the database');
  for (const r of rows) {
    console.log(`  ${r.trip_code.padEnd(9)} inv ${r.iocl_invoice_no ?? '(still null)'}  ${r.vehicle_no}  ${new Date(r.loading_date).toISOString().slice(0, 10)}`);
  }
}
console.log('');
await closePool();
