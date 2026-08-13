// server/db/seed/remaining-from-firestore.js
// ---------------------------------------------------------------------------
// The collections neither from-firestore.js nor tyres-from-firestore.js ever
// handled. RECORDS ONLY — this script posts nothing to the ledger. The money
// side is a separate, explicit step (post-missing-history.js) so that loading
// history can never quietly move the books.
//
//   node server/db/seed/remaining-from-firestore.js            DRY RUN
//   node server/db/seed/remaining-from-firestore.js --live     commit
//
// Idempotent on legacy_id; primary keys are UUIDv5 over the Firestore document
// id so every database that runs this ends up with identical rows (see the note
// in tyres-from-firestore.js about why that matters here).
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { initDb, withTransaction, closePool, DB_TARGET } from '../pool.js';

const LIVE = process.argv.includes('--live');
const fileArg = process.argv.indexOf('--file');
const BACKUPS = join(process.cwd(), 'backups');
const newest = () => {
  const f = readdirSync(BACKUPS).filter((x) => /^firestore-backup-.*\.json$/.test(x)).sort();
  return join(BACKUPS, f[f.length - 1]);
};

const NS = 'prasad-erp/firestore/';
const uuidFor = (kind, id) => {
  const h = createHash('sha1').update(`${NS}${kind}/${id}`).digest('hex').slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
};

const norm = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const txt = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const money = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).replace(/[^0-9.-]/g, '');
  return s === '' || s === '-' ? null : s;            // stays a string for numeric
};
const int = (v) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : null; };
const bool = (v) => (v === undefined || v === null || v === '' ? null : !!v);
const asDate = (v) => {
  if (!v) return null;
  if (typeof v === 'object' && v._seconds != null) return new Date(v._seconds * 1000).toISOString().slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const asTs = (v) => {
  if (!v) return null;
  if (typeof v === 'object' && v._seconds != null) return new Date(v._seconds * 1000).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const report = { target: null, mode: LIVE ? 'LIVE' : 'DRY-RUN', loaded: {}, skipped: [], notes: [] };
const skip = (coll, id, why) => report.skipped.push({ coll, id, why });

const file = fileArg > -1 ? process.argv[fileArg + 1] : newest();
const dump = JSON.parse(readFileSync(file, 'utf8')).collections ?? {};
const docs = (k) => Object.entries(dump[k] ?? {}).map(([id, w]) => ({ __id: id, ...(w.__data__ ?? w) }));

await initDb();
report.target = DB_TARGET;
console.log(`[remaining] ${report.mode} - source ${file} - target ${DB_TARGET}`);

await withTransaction(async (t) => {
  const lookup = async (table, col = 'legacy_id') => {
    const { rows } = await t.query(`SELECT id, ${col} AS k FROM ${table} WHERE ${col} IS NOT NULL`);
    return new Map(rows.map((r) => [String(r.k), r.id]));
  };
  const vendors = await lookup('vendors');
  const customers = await lookup('customers');
  const vehicles = await lookup('vehicles');
  const drivers = await lookup('drivers');
  const { rows: loans } = await t.query(`SELECT id, legacy_id, loan_account_no, vehicle_no FROM loan_master`);
  const loanByAc = new Map(loans.filter((l) => l.loan_account_no).map((l) => [norm(l.loan_account_no), l.id]));
  const loanByVeh = new Map(loans.filter((l) => l.vehicle_no).map((l) => [norm(l.vehicle_no), l.id]));

  const run = async (coll, table, map) => {
    const src = docs(coll);
    if (!src.length) { console.log(`  ${coll}: absent`); return; }
    let n = 0;
    for (const r of src) {
      const row = map(r);
      if (!row) continue;                                  // mapper skipped it
      const cols = ['id', 'legacy_id', ...Object.keys(row)];
      const vals = [uuidFor(table, r.__id), r.__id, ...Object.values(row)];
      const ph = vals.map((_, i) => `$${i + 1}`).join(',');
      const upd = Object.keys(row).map((c) => `${c}=EXCLUDED.${c}`).join(', ');
      await t.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})
         ON CONFLICT (legacy_id) DO UPDATE SET ${upd}`, vals);
      n++;
    }
    report.loaded[coll] = { found: src.length, loaded: n, table };
    console.log(`  ${coll}: ${n}/${src.length} -> ${table}`);
  };

  // All 18 of these point at one vendor document that no longer exists in
  // Firestore, so the id cannot resolve. Falling back to the name is safe ONLY
  // when the name is unique among vendors — three rows here are called NIRMALA
  // PETROLUM, and picking one of those would post another vendor's money to the
  // wrong khata. AGARWAL TRADING occurs exactly once, so it resolves; anything
  // ambiguous is left for a human.
  const { rows: venByName } = await t.query(
    `SELECT upper(trim(vendor_name)) AS k, min(id::text) AS id, count(*)::int AS n
       FROM vendors GROUP BY 1`);
  const uniqueVendorName = new Map(venByName.filter((v) => v.n === 1).map((v) => [v.k, v.id]));
  let vendorRepairs = 0;

  await run('VENDOR_TXNS', 'vendor_txns', (r) => {
    let vid = vendors.get(String(r.vendor_id));
    let remarks = txt(r.remarks);
    if (!vid) {
      const byName = uniqueVendorName.get(String(r.vendor_name ?? '').trim().toUpperCase());
      if (!byName) {
        skip('VENDOR_TXNS', r.__id, `vendor_id '${r.vendor_id}' is not in vendors and the name '${r.vendor_name}' is not unique — refusing to guess`);
        return null;
      }
      vid = byName;
      vendorRepairs++;
      remarks = `${remarks ?? ''} [vendor resolved by name: doc ${r.vendor_id} no longer exists]`.trim();
    }
    return { vendor_id: vid, vendor_name: txt(r.vendor_name), txn_date: asDate(r.txn_date),
             txn_type: txt(r.txn_type), amount: money(r.amount), payment_mode: txt(r.payment_mode),
             remarks };
  });
  if (vendorRepairs) report.notes.push(`VENDOR_TXNS: ${vendorRepairs} rows resolved by unique vendor name because their vendor document was deleted from Firestore. Stamped into remarks.`);

  await run('EMI_PAYMENTS', 'emi_payments', (r) => {
    const lid = loanByAc.get(norm(r.Loan_Account_No)) ?? loanByVeh.get(norm(r.Vehicle_No));
    if (!lid) { skip('EMI_PAYMENTS', r.__id, `no loan for account '${r.Loan_Account_No}' / vehicle '${r.Vehicle_No}' — emi_payments.loan_id is NOT NULL`); return null; }
    return { loan_id: lid, payment_date: asDate(r.Date_of_Payment), emi_month: txt(r.EMI_Month_Year),
             months_paid: int(r.Months_Paid), principal_part: money(r.Principal_Part),
             interest_part: money(r.Interest_Part), total_paid: money(r.Total_EMI_Paid),
             payment_mode: txt(r.Payment_Mode), ref_no: txt(r.Ref_No),
             paid_from_account: txt(r.Payment_From_Account), company: txt(r.Company_Name) };
  });

  await run('COMPANY_BILLS', 'company_bills', (r) => ({
    bill_no: txt(r.bill_no) ?? r.__id, bill_date: asDate(r.bill_date),
    customer_id: customers.get(String(r.customer_id)) ?? null,
    customer_name: txt(r.customer_name) ?? 'UNKNOWN', company: txt(r.company), branch: txt(r.branch),
    location: txt(r.location), location_code: txt(r.location_code),
    period_from: asDate(r.period_from), period_to: asDate(r.period_to),
    total_gross: money(r.total_gross), total_shortage: money(r.total_shortage_deduction),
    total_tds: money(r.total_tds_deduction), total_net: money(r.total_net_expected),
    status: txt(r.status),
  }));

  await run('TOLL_TRANSACTIONS', 'toll_transactions', (r) => {
    const vno = txt(r.Vehicle_No);
    if (!vno) { skip('TOLL_TRANSACTIONS', r.__id, 'no Vehicle_No — toll_transactions.vehicle_no is NOT NULL'); return null; }
    return { ext_txn_id: txt(r.ext_txn_id) ?? r.__id, txn_ref: txt(r.Transaction_Ref),
             vehicle_id: vehicles.get(String(r.vehicle_id)) ?? null, vehicle_no: vno,
             txn_datetime: asTs(r.txn_datetime ?? r.Txn_Date), txn_date: asDate(r.Txn_Date),
             amount: money(r.Amount), plaza_name: txt(r.Toll_Plaza_Name),
             lat: money(r.lat), lng: money(r.long), provider: txt(r.provider_name),
             invoice_no: txt(r.invoice_no), invoice_date: asDate(r.invoice_date),
             loading_loc: txt(r.loading_loc), dest_loc: txt(r.dest_loc),
             billing_type: txt(r.billing_type), is_billable: bool(r.is_billable),
             claim_status: txt(r.claim_status), claim_no: txt(r.claim_no),
             company: txt(r.company), tag_id: txt(r.tag_account) };
  });

  await run('TOLL_CLAIMS', 'toll_claims', (r) => ({
    claim_no: txt(r.claim_no) ?? r.__id, claim_date: asDate(r.claim_date),
    vendor_name: txt(r.vendor_name) ?? 'UNKNOWN', vendor_code: txt(r.vendor_code),
    plant_name: txt(r.plant_name), plant_code: txt(r.plant_code),
    period_from: asDate(r.period_from) ?? asDate(r.claim_date),
    period_to: asDate(r.period_to) ?? asDate(r.claim_date),
    fortnight_label: txt(r.fortnight_label), groups: JSON.stringify(r.groups ?? []),
    txn_count: int(r.txn_count), total: money(r.total), status: txt(r.status),
  }));

  await run('FLEET_CARDS', 'fleet_cards', (r) => ({
    name: txt(r.name) ?? r.__id, provider: txt(r.provider) ?? 'UNKNOWN',
    opening_balance: money(r.current_balance) ?? '0',
  }));

  await run('GST_MANAGEMENT', 'gst_returns', (r) => ({
    entry_date: asDate(r.Entry_Date), customer_name: txt(r.Customer_Name) ?? 'UNKNOWN',
    invoice_no: txt(r.Invoice_No), gst_type: txt(r.GST_Type), taxable_amt: money(r.Taxable_Amt),
    gst_rate: money(r.GST_Rate), total_gst: money(r.Total_GST),
    reverse_charge: bool(r.rcm), is_submitted: bool(r.is_submitted),
  }));

  await run('TDS_MANAGEMENT', 'tds_entries', (r) => ({
    entry_date: asDate(r.Date), consignee_name: txt(r.Consignee_Name) ?? 'UNKNOWN',
    gross_freight: money(r.Gross_Freight), tds_rate: money(r.TDS_Rate),
    tds_deducted: money(r.TDS_Deducted), status: txt(r.Status),
  }));

  await run('Vehicle_Assignments', 'vehicle_assignments', (r) => {
    const veh = vehicles.get(String(r.vehicleId));
    const drv = drivers.get(String(r.driverId));
    if (!veh || !drv) { skip('Vehicle_Assignments', r.__id, `unresolved ${!veh ? `vehicleId '${r.vehicleId}'` : ''}${!veh && !drv ? ' and ' : ''}${!drv ? `driverId '${r.driverId}'` : ''} — both are NOT NULL`); return null; }
    return { vehicle_id: veh, driver_id: drv,
             assigned_at: asTs(r.assignedAt ?? r.assignDate), remarks: txt(r.driverMobile) };
  });

  // The legacy freight rates. 029 put a unique index on (lane, window,
  // rate_type); the derived IOCL rules already occupy some of those slots, so a
  // clash means the rule is already priced and the legacy row is redundant —
  // reported, not forced.
  await run('RATE_MASTER', 'rate_master', (r) => ({
    customer_name: txt(r.Customer) ?? 'UNKNOWN', source: txt(r.Source), destination: txt(r.Destination),
    route: [txt(r.Source), txt(r.Destination)].filter(Boolean).join(' - ') || null,
    calc_type: txt(r.Calc_Type), rate: money(r.Rate_Value), rtkm_distance: money(r.RTKM_Distance),
    valid_from: asDate(r.Effective_From), valid_to: asDate(r.Effective_To),
    // rate_master_status_check accepts only ACTIVE / INACTIVE; Firestore wrote 'Active'.
    status: (txt(r.Status) ?? 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    rate_type: txt(r.Calc_Type) === 'PER_UNIT' ? 'PER_UNIT' : 'RTKM',
  }));

  // fastag_credits has no legacy_id column — it dedups on ext_credit_id, which
  // is the provider's own transaction id and just as stable. This is the wallet
  // funding side that the toll spend has to be netted against.
  {
    const src = docs('FASTAG_CREDITS');
    let n = 0;
    for (const r of src) {
      const ext = txt(r.ext_txn_id) ?? r.__id;
      await t.query(
        `INSERT INTO fastag_credits (id, ext_credit_id, account_id, vehicle_no, amount, credit_date, credit_at, provider, remarks)
         VALUES ($1::uuid,$2,$3,$4,$5::numeric,$6::date,$7::timestamptz,$8,$9)
         ON CONFLICT (ext_credit_id) DO UPDATE SET amount=EXCLUDED.amount, credit_date=EXCLUDED.credit_date`,
        [uuidFor('fastag_credits', r.__id), ext, txt(r.account_id), txt(r.vehicle_no),
         money(r.amount), asDate(r.txn_date), asTs(r.txn_datetime ?? r.txn_date),
         txt(r.provider_name), txt(r.mode)]);
      n++;
    }
    if (src.length) { report.loaded.FASTAG_CREDITS = { found: src.length, loaded: n, table: 'fastag_credits' };
      console.log(`  FASTAG_CREDITS: ${n}/${src.length} -> fastag_credits`); }
  }

  // SAVED_DOCUMENTS is deliberately not loaded: those two rows are HTML letter
  // bodies from the AI Letter Pad, and `documents` is a file table whose
  // sha256 and storage_path are NOT NULL. Forcing them in would mean inventing
  // a file that does not exist. They are content, and they need a content home.
  report.notes.push('SAVED_DOCUMENTS (2) not loaded: HTML letter bodies do not fit `documents`, which requires sha256 + storage_path of a real file.');

  if (!LIVE) throw Object.assign(new Error('dry run'), { code: 'DRY_RUN_ROLLBACK' });
}).catch((e) => { if (e.code !== 'DRY_RUN_ROLLBACK') throw e; });

const out = join(BACKUPS, `remaining-load-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  skipped: ${report.skipped.length}`);
const bySkip = {};
for (const s of report.skipped) bySkip[s.coll] = (bySkip[s.coll] ?? 0) + 1;
for (const [k, v] of Object.entries(bySkip)) console.log(`   ${k}: ${v} — e.g. ${report.skipped.find((s) => s.coll === k).why}`);
report.notes.forEach((n) => console.log(`  NOTE ${n}`));
console.log(`  report: ${out}`);
if (!LIVE) console.log('\n  DRY RUN - rolled back. Re-run with --live to commit.');
await closePool();
