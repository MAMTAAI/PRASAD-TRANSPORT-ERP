// scripts/audit-firestore-gap.mjs
// ---------------------------------------------------------------------------
// READ-ONLY audit: what money exists in the Firestore export that never
// reached PostgreSQL? Writes nothing, anywhere.
//
//   node scripts/audit-firestore-gap.mjs                 newest export, DB_TARGET
//   node scripts/audit-firestore-gap.mjs --file X.json --target aws
//
// Every collection is matched by legacy_id (the Firestore document id), which
// is the only key that survives the crossing. Counting rows on both sides and
// calling it equal would hide the case that matters most: the same number of
// rows carrying different facts.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';

const fileArg = process.argv.indexOf('--file');
const targetArg = process.argv.indexOf('--target');
if (targetArg > -1) process.env.DB_TARGET = process.argv[targetArg + 1];
const { initDb, query, closePool, DB_TARGET } = await import('../server/db/pool.js');

const BACKUPS = join(process.cwd(), 'backups');
const newest = () => {
  const f = readdirSync(BACKUPS).filter((x) => /^firestore-backup-.*\.json$/.test(x)).sort();
  return join(BACKUPS, f[f.length - 1]);
};
const file = fileArg > -1 ? process.argv[fileArg + 1] : newest();
const dump = JSON.parse(readFileSync(file, 'utf8')).collections ?? {};
const docs = (k) => Object.entries(dump[k] ?? {}).map(([id, w]) => ({ __id: id, ...(w.__data__ ?? w) }));

const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const inr = (n) => 'Rs ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// collection -> { table, amount field(s) }. Tables without legacy_id cannot be
// matched per row; those are reported as count-only and flagged as such.
const MAP = [
  { coll: 'LEDGER_ENTRIES', table: 'ledger_entries', amt: ['amount'] },
  { coll: 'LEDGERS', table: 'ledgers', amt: ['opening_balance', 'current_balance'] },
  { coll: 'TRIPS', table: 'trips', amt: ['freight_amount', 'total_freight'] },
  { coll: 'FUEL_ENTRIES', table: 'fuel_entries', amt: ['amount', 'total_amount'] },
  { coll: 'DRIVER_TRANSACTIONS', table: 'driver_transactions', amt: ['amount'] },
  { coll: 'LOAN_MASTER', table: 'loan_master', amt: ['loan_amount', 'emi_amount'] },
  { coll: 'VENDOR_TXNS', table: 'vendor_txns', amt: ['amount'] },
  { coll: 'EMI_PAYMENTS', table: 'emi_payments', amt: ['amount', 'emi_amount'] },
  { coll: 'COMPANY_BILLS', table: 'company_bills', amt: ['total_amount', 'amount'] },
  { coll: 'TOLL_TRANSACTIONS', table: 'toll_transactions', amt: ['amount'] },
  { coll: 'TOLL_CLAIMS', table: 'toll_claims', amt: ['amount'] },
  { coll: 'FASTAG_CREDITS', table: 'fastag_credits', amt: ['amount'] },
  { coll: 'FLEET_CARDS', table: 'fleet_cards', amt: ['balance'] },
  { coll: 'GST_MANAGEMENT', table: 'gst_returns', amt: ['tax_amount', 'amount'] },
  { coll: 'TDS_MANAGEMENT', table: 'tds_entries', amt: ['tds_amount', 'amount'] },
  { coll: 'TYRE_MASTER', table: 'tyres', amt: ['cost'] },
  { coll: 'TYRE_FITMENTS', table: 'tyre_fitments', amt: [] },
  { coll: 'VEHICLES', table: 'vehicles', amt: [] },
  { coll: 'VENDORS', table: 'vendors', amt: ['current_balance'] },
  { coll: 'CUSTOMERS', table: 'customers', amt: ['current_balance'] },
  { coll: 'DRIVERS', table: 'drivers', amt: [] },
  { coll: 'RTKM_MASTER', table: 'rtkm_master', amt: [] },
  { coll: 'RATE_MASTER', table: 'rate_master', amt: [] },
  { coll: 'VEHICLE_ASSIGNMENTS', table: 'vehicle_assignments', amt: [] },
  { coll: 'Vehicle_Assignments', table: 'vehicle_assignments', amt: [] },
  { coll: 'USERS', table: 'users', amt: [] },
  { coll: 'COMPANIES', table: 'companies', amt: [] },
  { coll: 'SAVED_DOCUMENTS', table: 'documents', amt: [] },
];

// These two have no table of their own — they are ACCOUNTING EVENTS whose only
// home in PostgreSQL is ledger_entries, reached through a voucher.
const EVENTS = ['BANK_TRANSACTIONS', 'JOURNAL'];

await initDb();
console.log(`\nAUDIT  source=${file}\n       target=${DB_TARGET}\n${'='.repeat(96)}`);

const hasLegacy = new Set(
  (await query(`SELECT table_name FROM information_schema.columns
                 WHERE table_schema='public' AND column_name='legacy_id'`)).rows.map((r) => r.table_name));
const tables = new Set(
  (await query(`SELECT table_name FROM information_schema.tables
                 WHERE table_schema='public' AND table_type='BASE TABLE'`)).rows.map((r) => r.table_name));

const findings = [];
console.log('COLLECTION'.padEnd(24) + 'FS'.padStart(6) + 'PG'.padStart(8) + 'MATCHED'.padStart(9)
          + 'MISSING'.padStart(9) + '   MONEY AT STAKE');
console.log('-'.repeat(96));

for (const M of MAP) {
  const src = docs(M.coll);
  if (!src.length) continue;
  if (!tables.has(M.table)) {
    findings.push({ coll: M.coll, kind: 'NO_TABLE', missing: src.length, amount: 0 });
    console.log(M.coll.padEnd(24) + String(src.length).padStart(6) + '       -' + '        -'
      + String(src.length).padStart(9) + '   (no such table in PG)');
    continue;
  }
  const { rows: [{ n: pgCount }] } = await query(`SELECT count(*)::int AS n FROM ${M.table}`);
  let matched = null, missingIds = [];
  if (hasLegacy.has(M.table)) {
    const { rows } = await query(`SELECT legacy_id FROM ${M.table} WHERE legacy_id IS NOT NULL`);
    const have = new Set(rows.map((r) => String(r.legacy_id)));
    missingIds = src.filter((d) => !have.has(String(d.__id))).map((d) => d.__id);
    matched = src.length - missingIds.length;
  }
  const missSet = new Set(missingIds);
  const amount = src.filter((d) => missSet.has(d.__id))
    .reduce((a, d) => a + M.amt.reduce((s, f) => s + (d[f] !== undefined ? money(d[f]) : 0), 0), 0);
  if (missingIds.length) findings.push({ coll: M.coll, table: M.table, kind: 'MISSING_ROWS', missing: missingIds.length, amount, ids: missingIds.slice(0, 5) });
  console.log(M.coll.padEnd(24) + String(src.length).padStart(6) + String(pgCount).padStart(8)
    + String(matched ?? '-').padStart(9) + String(missingIds.length).padStart(9)
    + (amount ? '   ' + inr(amount) : (missingIds.length ? '   (no amount field)' : '')));
}

console.log('-'.repeat(96));
console.log('ACCOUNTING EVENTS — no table of their own; they belong in ledger_entries via a voucher');
console.log('-'.repeat(96));

for (const key of EVENTS) {
  const src = docs(key);
  if (!src.length) { console.log(`${key.padEnd(24)} absent from export`); continue; }
  // Match generously: legacy_id, source_ref, or the ref/particulars text.
  const { rows: le } = await query(
    `SELECT coalesce(legacy_id,'') AS legacy_id, coalesce(source_ref,'') AS source_ref,
            coalesce(source_type,'') AS source_type, coalesce(particulars,'') AS particulars
       FROM ledger_entries`);
  const byLegacy = new Set(le.map((r) => r.legacy_id).filter(Boolean));
  const byRef = new Set(le.map((r) => r.source_ref).filter(Boolean));
  let found = 0; const missing = [];
  for (const d of src) {
    const ref = String(d.ref_no ?? d.source_ref ?? '').trim();
    const hit = byLegacy.has(String(d.__id))
      || (ref && byRef.has(ref))
      || (d.source_type && byRef.has(String(d.source_ref ?? '')));
    if (hit) found++; else missing.push(d);
  }
  const amt = missing.reduce((a, d) => a + money(d.amount ?? d.total), 0);
  console.log(`${key.padEnd(24)}${String(src.length).padStart(6)}${'-'.padStart(8)}${String(found).padStart(9)}${String(missing.length).padStart(9)}   ${inr(amt)}`);
  if (missing.length) findings.push({ coll: key, kind: 'EVENTS_NOT_POSTED', missing: missing.length, amount: amt, sample: missing.slice(0, 6).map((d) => ({ id: d.__id, date: d.date, type: d.type, amount: d.amount, party: d.party_name, ref: d.ref_no, particulars: String(d.particulars ?? '').slice(0, 60) })) });
}

// ---- is what DID cross actually balanced? -------------------------------
console.log('\n' + '='.repeat(96));
const { rows: [h] } = await query(`SELECT * FROM v_accounting_health`);
const bad = Object.entries(h).filter(([k, v]) => k !== 'merged_aliases' && Number(v) !== 0);
console.log('v_accounting_health:', bad.length ? 'FAIL ' + JSON.stringify(bad) : 'ALL ZERO');

const { rows: [tb] } = await query(
  `SELECT to_char(sum(CASE WHEN dr_cr='DR' THEN amount ELSE 0 END),'FM999999999990.00') AS dr,
          to_char(sum(CASE WHEN dr_cr='CR' THEN amount ELSE 0 END),'FM999999999990.00') AS cr,
          count(*)::int AS n FROM ledger_entries`);
console.log(`ledger_entries: ${tb.n} rows | Dr ${tb.dr} | Cr ${tb.cr} | diff ${(Number(tb.dr) - Number(tb.cr)).toFixed(2)}`);

console.log('\nFINDINGS');
console.log('-'.repeat(96));
if (!findings.length) console.log('  none — every mapped collection is fully represented.');
for (const f of findings.sort((a, b) => b.amount - a.amount)) {
  console.log(`  ${f.kind.padEnd(18)} ${f.coll.padEnd(22)} missing=${String(f.missing).padStart(5)}  ${f.amount ? inr(f.amount) : ''}`);
  if (f.sample) f.sample.forEach((s) => console.log(`      ${s.date ?? ''} ${String(s.type ?? '').padEnd(14)} ${String(s.amount ?? '').padStart(11)}  ${s.party ?? ''} | ${s.particulars ?? ''}`));
}
console.log();
await closePool();
