// server/lib/fastagStatement.js
// ═══════════════════════════════════════════════════════════════════════════
// READ A FASTag STATEMENT ATTACHMENT INTO THE ROWS tollImport ALREADY EATS.
//
// Owner, 6-Sep-2026: the providers without an API mail a daily/weekly CSV or
// Excel statement. Parse the attachment; never scrape the portal — a scraper
// breaks silently the first time a bank moves a div, and a toll ledger that
// stops filling itself without saying so is worse than one that was never
// automated.
//
// THIS FILE ONLY READS. It does not insert, does not post a voucher and does
// not decide a trip: it hands rows to POST /api/v1/toll/bulk-import, which
// already owns the whole ingestion contract — the ext_txn_id UNIQUE lock, the
// ON CONFLICT DO NOTHING, the 5-minute vehicle+time+amount near-duplicate
// sweep, the ledger voucher and (since migration 179) the honest trip matcher.
// Duplicating any of that here would give the same rupee two ways in.
//
// EVERY PROVIDER NAMES ITS COLUMNS DIFFERENTLY. The header map below is the
// whole point of the file: banks ship "Txn Date", "Transaction Date/Time",
// "TXN DATE & TIME" and "Date" for one concept. An unrecognised header is
// reported, never guessed — a statement parsed into the wrong column is money
// booked against the wrong lorry.
// ═══════════════════════════════════════════════════════════════════════════
import XLSX from 'xlsx';

/** reg_key's shape, in JS: the importer matches on vehicle_no_norm. */
export const normReg = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

const clean = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** One concept, every spelling a provider has actually used. */
const HEADERS = {
  vehicle: ['vehicleno', 'vehiclenumber', 'vrn', 'vehiclergnno', 'regno', 'registrationnumber', 'vehicle'],
  datetime: ['txndatetime', 'transactiondatetime', 'txndate', 'transactiondate', 'date', 'datetime', 'readerreadtime', 'transactiontime'],
  amount: ['amount', 'txnamount', 'transactionamount', 'deductedamount', 'debitamount', 'tollamount', 'amountinr'],
  ref: ['txnrefno', 'transactionrefno', 'txnid', 'transactionid', 'referenceno', 'refno', 'txnreferencenumber', 'utrno', 'lanetxnid'],
  plaza: ['plazaname', 'tollplaza', 'plaza', 'tollplazaname', 'merchantname', 'location'],
  tag: ['tagid', 'tagno', 'epc', 'fastagid'],
  type: ['type', 'txntype', 'transactiontype', 'drcr', 'debitcredit'],
};

/** Which column index holds each concept, or null when the file lacks it. */
export function mapHeaders(headerRow) {
  const cols = headerRow.map(clean);
  const out = {};
  for (const [concept, aliases] of Object.entries(HEADERS)) {
    out[concept] = cols.findIndex((c) => aliases.includes(c));
    if (out[concept] === -1) {
      // Fall back to a contains-match before giving up — "vehicleno1" and
      // "txndatetimeist" are the same concept with a suffix.
      out[concept] = cols.findIndex((c) => aliases.some((a) => c.includes(a)));
    }
    if (out[concept] === -1) out[concept] = null;
  }
  return out;
}

const RE_AMOUNT = /-?[\d,]+(?:\.\d+)?/;
const toAmount = (v) => {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.abs(v);
  const m = String(v).replace(/[₹\s]/g, '').match(RE_AMOUNT);
  return m ? Math.abs(Number(m[0].replace(/,/g, ''))) : 0;
};

/**
 * Statements arrive as "14-08-2026 23:47:11", "2026-08-14 23:47", Excel serial
 * numbers, and occasionally "14/08/26". Date.parse() reads the middle one and
 * gets the first WRONG — it takes 14-08-2026 as a US month. So day-first is
 * parsed explicitly and only then handed to Date.
 */
export function toDateTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') {
    // Excel serial: days since 1899-12-30, fractional part = time of day.
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})[ T]*(\d{1,2}):?(\d{2})?:?(\d{2})?/);
  if (dmy) {
    const [, d, mo, yRaw, hh = '0', mi = '0', ss = '0'] = dmy;
    const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    const dt = new Date(Date.UTC(y, Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)));
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** A credit/recharge line is not a toll. Booking one as a crossing would turn
 *  money coming IN into an expense going out. */
const isCredit = (typeStr) => /credit|recharge|top ?up|cr\b/i.test(String(typeStr ?? ''));

/**
 * @param {Buffer} buf         the attachment
 * @param {string} filename    used only for the audit trail and format sniffing
 * @param {object} opts        { companyHint, bank }
 * @returns {{ rows: object[], skipped: object[], headerMap: object, sheet: string }}
 */
export function parseFastagStatement(buf, filename = '', opts = {}) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: null });

  // Providers put a title, an account summary and a blank line above the real
  // header. Find the first row that actually names a vehicle AND an amount.
  let headerIdx = -1;
  let headerMap = null;
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const m = mapHeaders(grid[i] ?? []);
    if (m.vehicle != null && m.amount != null && m.datetime != null) { headerIdx = i; headerMap = m; break; }
  }
  if (headerIdx === -1) {
    return {
      rows: [], skipped: [], headerMap: null, sheet: sheetName,
      error: 'NO_HEADER_ROW: could not find a row naming a vehicle, a date and an amount',
    };
  }

  const rows = [];
  const skipped = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const at = (k) => (headerMap[k] == null ? null : r[headerMap[k]]);

    const vehicle_norm = normReg(at('vehicle'));
    const txn_datetime = toDateTime(at('datetime'));
    const amount = toAmount(at('amount'));
    const typeStr = at('type');

    if (!vehicle_norm && !txn_datetime && !amount) continue;           // padding row
    if (isCredit(typeStr)) { skipped.push({ line: i + 1, reason: 'CREDIT_NOT_A_TOLL', vehicle_norm }); continue; }
    if (!vehicle_norm || !txn_datetime || !(amount > 0)) {
      skipped.push({ line: i + 1, reason: 'INCOMPLETE_ROW', vehicle_norm, txn_datetime, amount });
      continue;
    }

    const ref = at('ref');
    rows.push({
      vehicle_norm,
      txn_datetime,
      amount,
      // The provider's own id is the dedup key the importer trusts first. With
      // no ref the importer still catches a repeat on its vehicle+time+amount
      // sweep, so a statement without one is usable, not rejected.
      ext_txn_id: ref ? String(ref).trim() : null,
      txn_ref: ref ? String(ref).trim() : null,
      plaza_name: at('plaza') ? String(at('plaza')).trim() : null,
      tag_id: at('tag') ? String(at('tag')).trim() : null,
      bank: opts.bank ?? null,
      company_hint: opts.companyHint ?? null,
      source_file: filename || null,
    });
  }
  return { rows, skipped, headerMap, sheet: sheetName };
}

/** Does this message look like a provider's statement? Kept deliberately wide
 *  on subject and narrow on extension: a false positive costs one parse that
 *  finds no header row, a false negative costs a day of tolls. */
export function looksLikeFastagStatement({ from = '', subject = '', filename = '' } = {}) {
  const hay = `${from} ${subject}`.toLowerCase();
  const named = /fastag|toll|netc|nhai|tag statement|plaza/.test(hay);
  const ext = /\.(csv|xlsx|xls)$/i.test(filename);
  const fileNamed = /fastag|toll|netc|statement|txn|transaction/i.test(filename);
  return ext && (named || fileNamed);
}

export default { parseFastagStatement, looksLikeFastagStatement, mapHeaders, toDateTime, normReg };
