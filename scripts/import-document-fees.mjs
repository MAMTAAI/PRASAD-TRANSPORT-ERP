// ═══════════════════════════════════════════════════════════════════════════
// import-document-fees.mjs — put the money on the compliance documents.
//
// The document tree carries no fee: a filename says what a permit is and when
// it expires, never what it cost. So the fee arrives separately, as a sheet the
// office already keeps, and this loads it onto the rows the vault created.
//
//   node scripts/import-document-fees.mjs --emit-template fees.csv   # blank sheet
//   node scripts/import-document-fees.mjs --csv fees.csv             # dry run
//   node scripts/import-document-fees.mjs --csv fees.csv --apply     # write
//
// COLUMNS
//   vehicle_no, doc_type      the key - must already exist in vehicle_documents
//   amount                    fee paid, blank = leave alone
//   payment_mode              CASH / UPI / NEFT / CHEQUE / CARD
//   receipt_no, application_no
//   inspected_on              dd-mm-yyyy or yyyy-mm-dd
//   remarks
//
// A BLANK CELL MEANS "DO NOT TOUCH", NOT "SET TO EMPTY".
// The sheet is filled in over weeks by different people. If a blank overwrote,
// then re-importing a half-filled sheet would silently wipe the fees someone
// entered last week. Only cells with content are written.
//
// It refuses to create rows. A fee for a (vehicle, document) the vault has
// never seen means either the document is missing or the sheet has a typo -
// both are worth a human look, and neither is fixed by inventing a row with a
// price and no paperwork behind it.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
dotenv.config({ path: join(ROOT, '.env') });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CSV = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;
const EMIT = args.includes('--emit-template') ? args[args.indexOf('--emit-template') + 1] : null;

const COLS = ['vehicle_no', 'doc_type', 'doc_name', 'next_due_date',
              'amount', 'payment_mode', 'receipt_no', 'application_no', 'inspected_on', 'remarks'];

// ── CSV, handling quoted cells and embedded commas ─────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Accepts 12-08-2026, 12/08/2026 and 2026-08-12. Indian sheets are dd-mm.
function parseDate(s) {
  const t = String(s).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  return undefined;   // present but unreadable - distinct from absent
}

// "1,250.00" / "Rs 1250" / "1250/-" all mean the same number.
function parseAmount(s) {
  const t = String(s).replace(/[₹,\s]|rs\.?|\/-/gi, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const main = async () => {
  const c = new pg.Client({
    host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  });
  await c.connect();

  if (EMIT) {
    const { rows } = await c.query(`
      SELECT v.vehicle_no, d.doc_type, COALESCE(d.doc_name, d.doc_type) AS doc_name,
             to_char(d.next_due_date, 'DD-MM-YYYY') AS next_due_date,
             d.amount, d.payment_mode, d.receipt_no, d.application_no,
             to_char(d.inspected_on, 'DD-MM-YYYY') AS inspected_on, NULL AS remarks
        FROM vehicle_documents d JOIN vehicles v ON v.id = d.vehicle_id
       ORDER BY v.vehicle_no, d.doc_type`);
    const out = [COLS.join(',')];
    for (const r of rows) out.push(COLS.map((k) => csvCell(r[k])).join(','));
    writeFileSync(EMIT, out.join('\n') + '\n');
    console.log(`wrote ${EMIT} with ${rows.length} rows.`);
    console.log('Fill the amount / payment_mode / receipt_no columns and re-run with --csv.');
    await c.end();
    return;
  }

  if (!CSV || !existsSync(CSV)) {
    console.error('usage: --emit-template <file.csv>   |   --csv <file.csv> [--apply]');
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(CSV, 'utf8'));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const idx = (n) => header.indexOf(n);
  if (idx('vehicle_no') < 0 || idx('doc_type') < 0) {
    console.error('CSV must have vehicle_no and doc_type columns.');
    process.exit(1);
  }

  const { rows: existing } = await c.query(`
    SELECT d.id, v.vehicle_no, d.doc_type FROM vehicle_documents d JOIN vehicles v ON v.id = d.vehicle_id`);
  const key = (v, t) => v.toUpperCase().replace(/\s+/g, '') + '|' + t.toLowerCase().trim();
  const byKey = new Map(existing.map((r) => [key(r.vehicle_no, r.doc_type), r.id]));

  const updates = [], noRow = [], badCell = [], empty = [];
  for (const [n, r] of rows.entries()) {
    const vNo = (r[idx('vehicle_no')] || '').trim();
    const dType = (r[idx('doc_type')] || '').trim();
    if (!vNo || !dType) continue;
    const id = byKey.get(key(vNo, dType));
    if (!id) { noRow.push({ line: n + 2, vNo, dType }); continue; }

    const set = {};
    const amount = idx('amount') >= 0 ? parseAmount(r[idx('amount')]) : null;
    if (amount === undefined) { badCell.push({ line: n + 2, col: 'amount', val: r[idx('amount')] }); continue; }
    if (amount !== null) set.amount = amount;

    for (const col of ['payment_mode', 'receipt_no', 'application_no', 'remarks']) {
      if (idx(col) < 0) continue;
      const v = (r[idx(col)] || '').trim();
      if (v) set[col] = v;
    }
    if (idx('inspected_on') >= 0) {
      const d = parseDate(r[idx('inspected_on')]);
      if (d === undefined) { badCell.push({ line: n + 2, col: 'inspected_on', val: r[idx('inspected_on')] }); continue; }
      if (d) set.inspected_on = d;
    }

    if (!Object.keys(set).length) { empty.push({ vNo, dType }); continue; }
    updates.push({ id, vNo, dType, set });
  }

  console.log(`=== DOCUMENT FEE IMPORT (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  console.log(`csv rows          : ${rows.length}`);
  console.log(`updates to write  : ${updates.length}`);
  console.log(`blank (untouched) : ${empty.length}`);
  console.log(`no matching row   : ${noRow.length}`);
  console.log(`unreadable cells  : ${badCell.length}`);

  if (noRow.length) {
    console.log('\n--- no such (vehicle, document) in the vault - NOT created ---');
    noRow.slice(0, 20).forEach((r) => console.log(`   line ${r.line}: ${r.vNo}  ${r.dType}`));
  }
  if (badCell.length) {
    console.log('\n--- unreadable cells (row skipped entirely) ---');
    badCell.slice(0, 20).forEach((r) => console.log(`   line ${r.line}: ${r.col} = "${r.val}"`));
  }
  if (updates.length) {
    const withFee = updates.filter((u) => u.set.amount != null);
    const total = withFee.reduce((s, u) => s + u.set.amount, 0);
    console.log(`\n--- ${withFee.length} rows carry a fee, total ${total.toLocaleString('en-IN')} ---`);
    updates.slice(0, 12).forEach((u) => console.log(`   ${u.vNo.padEnd(14)} ${u.dType.padEnd(18)} ${JSON.stringify(u.set)}`));
    if (updates.length > 12) console.log(`   ... and ${updates.length - 12} more`);
  }

  if (!APPLY) { console.log('\nDRY RUN - nothing written. Re-run with --apply.'); await c.end(); return; }

  let n = 0;
  for (const u of updates) {
    const keys = Object.keys(u.set);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await c.query(`UPDATE vehicle_documents SET ${sets}, updated_at = now() WHERE id = $1`,
                  [u.id, ...keys.map((k) => u.set[k])]);
    n++;
  }
  console.log(`\nAPPLIED: ${n} documents updated.`);
  await c.end();
};

main().catch((e) => { console.error('FATAL: ' + e.message); process.exit(1); });
