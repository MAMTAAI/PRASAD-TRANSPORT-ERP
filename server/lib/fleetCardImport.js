// server/lib/fleetCardImport.js
// ─────────────────────────────────────────────────────────────────────────────
// READING WHAT IOCL, BPCL AND HPCL EXPORT.
//
// There is no API. All three portals give a human a CSV, and the three CSVs
// agree on nothing: not the column names, not the date format, not what a
// "transaction type" is, not even where the header row sits. So the parsing is
// per provider and the normalising is shared, which is the only arrangement
// that survives one of them redesigning their export.
//
// MEASURED AGAINST THE REAL FILES, 4-Sep-2026:
//
//   IOCL  FinancialTransactionStatement<customer><mon><yy>.csv
//         13 preamble lines, then a header containing "Merchant Name".
//         Dates DD/MM/YYYY. Txn Type carries the meaning: "CCMS Sale Auth",
//         "CCMS Sale Completion", "Recharge", "Loyalty Award", "Loyalty
//         Redeem", "Sale", "CCMS Recharge".
//         ⚠ "CCMS Sale Completion" IS NOT DIESEL. The name says it is the
//         settled half of a sale; the data says otherwise. All 44 of those rows
//         carry NO vehicle, NO litres and a round amount — 20,000 / 40,000 /
//         2,00,000 — and share no key with any Sale Auth row: zero overlap on
//         Txn ID, ITPSTxnID, FCCTransactionId, and on vehicle+date+amount.
//         They are wallet settlements to the dealer, not fills.
//         The diesel is "CCMS Sale Auth" (707 rows, with vehicle, litres and
//         RSP) plus plain "Sale" (58). Completion is imported as OTHER so it is
//         visible and countable, and is kept out of the fuel figure — booking
//         it as diesel would have added 82,90,290 of fuel that never went into
//         a tank. Checked against the file before this line was written.
//
//   BPCL  "Sales Transaction.csv" and "Cms Recharge.csv" — two separate
//         exports from the same screen. Preamble then a header starting
//         "S.No.". Dates DD-MMM-YYYY. The sales file names the vehicle AND the
//         pump AND the rate, which the pumps' own paper bills often do not.
//
//   HPCL  DriveTrack's export was not reachable on 4-Sep (the session dropped
//         and it needs a captcha to log back in). The shape below is written
//         from its on-screen columns and is marked UNVERIFIED; the first real
//         file will confirm or correct it, and until then the importer refuses
//         rather than guessing.
//
// NOTHING HERE POSTS TO A LEDGER. It fills fleet_card_statement_txns, which is
// evidence. Money moves when somebody settles, and that is a different route.
// ─────────────────────────────────────────────────────────────────────────────

/** A CSV parser that survives quoted commas and embedded newlines. The exports
 *  carry addresses like "29A, RAMESH MITRA ROAD, KOLKATA" in one field. */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const money = (s) => {
  const n = Number(String(s ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Registrations are typed by four different people and printed by three oil
 *  companies. Same rule the database uses (reg_key in migration 149). */
export const regKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * DD/MM/YYYY, DD-MM-YYYY and DD-MMM-YYYY, all of which appear across the three
 * exports. Returns 'YYYY-MM-DD' or null.
 *
 * DAY FIRST, ALWAYS. Every one of these portals is Indian and prints day
 * first — and the ambiguity is not academic: 08/06/2026 is a real BPCL recharge
 * that would land in August instead of June, in a system whose whole point is
 * matching things by date.
 */
export function toISO(v) {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})/);
  if (m) {
    const mo = MONTHS[m[2].toUpperCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Find the row that carries the column names. The preamble above it differs in
 *  length between providers and between months of the same provider. */
function headerRow(rows, needle) {
  const i = rows.findIndex((r) => r.some((c) => new RegExp(needle, 'i').test(clean(c))));
  if (i < 0) throw Object.assign(new Error(`header row not found (looking for "${needle}")`), { code: 'NO_HEADER' });
  return i;
}

const indexer = (header) => {
  const norm = header.map((h) => clean(h).toLowerCase());
  return (...names) => {
    // BOTH SIDES GET CLEANED. BPCL writes "Product Volume /  Quantity (Litres)"
    // with a double space inside it; collapsing only the header meant the
    // search term never matched and every one of 324 sales imported with zero
    // litres. Silent, because a missing column reads as an empty one.
    const want = names.map((n) => clean(n).toLowerCase());
    for (const n of want) {
      const i = norm.indexOf(n);
      if (i >= 0) return i;
    }
    // Fall back to a contains-match: the exports pad names with stray spaces
    // and one of them writes "Product Volume /  Quantity (Litres)" with a
    // double space inside it.
    for (const n of want) {
      const i = norm.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
};

// ── IOCL XtraPower ──────────────────────────────────────────────────────────
//
// One file carries sales, recharges and loyalty together, told apart by Txn
// Type. The pair of Sale Auth / Sale Completion rows is the trap; see the
// header note.
function parseIOCL(rows, ctx) {
  const hi = headerRow(rows, 'Merchant Name');
  const H = rows[hi];
  const at = indexer(H);
  const c = {
    txnId: at('Txn ID'), date: at('Txn Date'), settled: at('Settlement Date'),
    type: at('Txn Type'), mode: at('Txn Mode'), card: at('Customer ID/Card PAN'),
    veh: at('Vehicle No. (Card)'), vehUser: at('VehicleNo (User Entry)'),
    merchant: at('Merchant Name'), merchantId: at('Merchant ID'),
    loc: at('Location'), state: at('State'),
    product: at('Product'), rsp: at('RSP'), qty: at('Quantity'),
    amount: at('Amount'), balance: at('Balance'), status: at('Status'),
  };
  const body = rows.slice(hi + 1).filter((r) => r.length > 8 && /^\s*\d+\s*$/.test(clean(r[0])));

  const out = [];
  for (const r of body) {
    const type = clean(r[c.type]);
    const txnId = clean(r[c.txnId]);
    const amount = money(r[c.amount]);
    if (amount === null) continue;

    let kind = 'OTHER';
    let direction = 'DR';
    // See the note on `unit` in migration 150: a Loyalty row's amount is XTRA
    // POINTS. The rupees arrive as a separate CCMS Recharge leg under the same
    // Txn ID, which is why the dedup key carries `kind` as well as the id.
    let unit = 'INR';
    if (/recharge/i.test(type)) { kind = 'RECHARGE'; direction = 'CR'; }
    else if (/loyalty award/i.test(type)) { kind = 'LOYALTY_AWARD'; direction = 'CR'; unit = 'POINTS'; }
    else if (/loyalty redeem/i.test(type)) { kind = 'LOYALTY_REDEEM'; direction = 'DR'; unit = 'POINTS'; }
    // Checked BEFORE the /sale/ test on purpose: "CCMS Sale Completion" matches
    // both, and it is a wallet settlement, not a fill. See the header.
    else if (/completion/i.test(type)) { kind = 'OTHER'; direction = 'DR'; }
    else if (/sale/i.test(type)) { kind = 'SALE'; direction = 'DR'; }
    else if (/revers|refund/i.test(type)) { kind = 'REVERSAL'; direction = 'CR'; }
    else if (/fee|charge/i.test(type)) { kind = 'FEE'; direction = 'DR'; }

    const vehRaw = clean(r[c.veh]) === '-' ? clean(r[c.vehUser]) : clean(r[c.veh]);
    // On a Recharge row IOCL puts the oil company's own document number in the
    // Product column — the freight invoice the deduction came out of, and the
    // only thread back from a top-up to the bill that funded it.
    const product = clean(r[c.product]);
    const isDoc = kind === 'RECHARGE' && /^\d{10,}$/.test(product);

    out.push({
      provider_txn_id: txnId || `IOCL-${clean(r[c.date])}-${amount}-${clean(r[c.merchant])}`.slice(0, 120),
      txn_date: toISO(r[c.date]),
      settlement_date: toISO(r[c.settled]),
      kind,
      provider_txn_type: type,
      direction,
      card_pan: clean(r[c.card]) || null,
      vehicle_raw: vehRaw || null,
      merchant_name: clean(r[c.merchant]) || null,
      merchant_code: clean(r[c.merchantId]) || null,
      location: [clean(r[c.loc]), clean(r[c.state])].filter(Boolean).join(', ') || null,
      product: isDoc ? null : (product || null),
      quantity: money(r[c.qty]),
      rate: money(r[c.rsp]),
      amount,
      unit,
      balance_after: money(r[c.balance]),
      status: clean(r[c.status]) || null,
      source_doc_no: isDoc ? product : null,
      raw: Object.fromEntries(H.map((h, i) => [clean(h), clean(r[i])]).filter(([k, v]) => k && v)),
    });
  }
  return { provider: 'IOCL', rows: out, header: H, ...ctx };
}

// ── BPCL SmartFleet — sales ─────────────────────────────────────────────────
function parseBpclSales(rows) {
  const hi = headerRow(rows, '^S\\.No\\.$');
  const H = rows[hi];
  const at = indexer(H);
  const c = {
    txnId: at('Transaction ID'), date: at('Transaction Date'), time: at('Transaction Time'),
    mode: at('Transaction mode'), cardName: at('Name of Card'), card: at('Card Number'),
    veh: at('Vehicle Number'),
    merchant: at('Fuel Station Name (Retail Outlet Name)'),
    merchantId: at('Fuel Station ID (Retail Outlet SAP CC No.)'),
    city: at('Fuel Station (Retail Outlet) City'), state: at('Fuel Station (Retail Outlet) State'),
    type: at('Transaction Type'), category: at('Transaction Category'),
    product: at('Product Name'), qty: at('Product Volume /  Quantity (Litres)'),
    rate: at('Rate (Rs. / Litre)'), amount: at('Total Transaction Amount (Rs.)'),
    dc: at('Credit / Debit'), status: at('Settlement Status'),
  };
  const body = rows.slice(hi + 1).filter((r) => r.length > 8 && clean(r[0]) && /^\d/.test(clean(r[0])));
  const out = [];
  for (const r of body) {
    const amount = money(r[c.amount]);
    if (amount === null) continue;
    const dc = clean(r[c.dc]).toUpperCase();
    const category = clean(r[c.category]);
    const kind = /sale/i.test(category) ? 'SALE' : (/revers|refund/i.test(category) ? 'REVERSAL' : 'OTHER');
    out.push({
      provider_txn_id: clean(r[c.txnId]),
      txn_date: toISO(r[c.date]),
      settlement_date: null,
      kind,
      provider_txn_type: [clean(r[c.type]), category].filter(Boolean).join(' / '),
      direction: dc.startsWith('CR') ? 'CR' : 'DR',
      card_pan: clean(r[c.card]) || null,
      vehicle_raw: clean(r[c.veh]) || clean(r[c.cardName]) || null,
      merchant_name: clean(r[c.merchant]) || null,
      merchant_code: clean(r[c.merchantId]) || null,
      location: [clean(r[c.city]), clean(r[c.state])].filter(Boolean).join(', ') || null,
      product: clean(r[c.product]) || null,
      quantity: money(r[c.qty]),
      rate: money(r[c.rate]),
      amount,
      unit: 'INR',
      balance_after: null,
      status: clean(r[c.status]) || null,
      source_doc_no: null,
      raw: Object.fromEntries(H.map((h, i) => [clean(h), clean(r[i])]).filter(([k, v]) => k && v)),
    });
  }
  return { provider: 'BPCL', rows: out, header: H };
}

// ── BPCL SmartFleet — CMS recharges ─────────────────────────────────────────
//
// PCVO vs Net Banking is the distinction that matters to the books: PCVO is the
// oil company deducting from what it owes us on freight, Net Banking is our own
// bank paying money in. They are not the same entry and must not net together.
function parseBpclRecharge(rows) {
  const hi = headerRow(rows, '^S\\.No\\.$');
  const H = rows[hi];
  const at = indexer(H);
  const c = {
    txnId: at('Transaction ID'), date: at('Transaction Date'),
    type: at('Transaction Type'), category: at('Transaction Category'),
    amount: at('Transaction Amount (Rs.)'), dc: at('Credit / Debit'),
    opening: at('Opening CMS Balance (Rs.)'), closing: at('Closing CMS Balance (Rs.)'),
    status: at('Settlement Status'),
  };
  const body = rows.slice(hi + 1).filter((r) => r.length > 8 && clean(r[0]) && /^\d/.test(clean(r[0])));
  const out = [];
  for (const r of body) {
    const amount = money(r[c.amount]);
    if (amount === null) continue;
    const type = clean(r[c.type]);
    out.push({
      provider_txn_id: clean(r[c.txnId]),
      txn_date: toISO(r[c.date]),
      settlement_date: null,
      kind: 'RECHARGE',
      provider_txn_type: [type, clean(r[c.category])].filter(Boolean).join(' / '),
      direction: 'CR',
      card_pan: null,
      vehicle_raw: null,
      merchant_name: null,
      merchant_code: null,
      location: null,
      product: null,
      quantity: null,
      rate: null,
      amount,
      unit: 'INR',
      balance_after: money(r[c.closing]),
      status: clean(r[c.status]) || null,
      // PCVO = the freight deduction. Recorded here so the settlement screen can
      // tell it from money we paid in ourselves without re-reading the type.
      source_doc_no: /pcvo/i.test(type) ? 'PCVO' : null,
      raw: Object.fromEntries(H.map((h, i) => [clean(h), clean(r[i])]).filter(([k, v]) => k && v)),
    });
  }
  return { provider: 'BPCL', rows: out, header: H };
}

// ── HPCL DriveTrack — UNVERIFIED ────────────────────────────────────────────
function parseHPCL() {
  throw Object.assign(
    new Error('HPCL DriveTrack export not supported yet — no real file has been seen. '
            + 'Download one from Reports and it will be added; guessing at the columns '
            + 'would import wrong money silently.'),
    { code: 'HPCL_UNSUPPORTED' },
  );
}

/**
 * Work out which export this is, and parse it.
 *
 * SNIFFED FROM THE CONTENT, NOT THE FILENAME. Operators rename downloads, and a
 * BPCL sales file read as a recharge file would import 324 sales as 324 credits
 * — money flowing the wrong way through the card.
 */
export function parseFleetCardCsv(text, hint = {}) {
  const rows = parseCsv(text);
  const head = rows.slice(0, 20).map((r) => r.join(' ')).join('\n');

  if (/Customer Transaction Details Report|XTRAPOWER/i.test(head)
      || rows.some((r) => r.some((c) => /Vehicle No\. \(Card\)/i.test(clean(c))))) {
    const period = head.match(/Period\s*:\s*([\d/.-]+)\s*To\s*([\d/.-]+)/i);
    const acct = head.match(/Customer ID\s*:?\s*(\d{6,})/i);
    return parseIOCL(rows, {
      period_from: period ? toISO(period[1]) : null,
      period_to: period ? toISO(period[2]) : null,
      account_no: acct ? acct[1] : hint.account_no ?? null,
    });
  }

  if (/CMS Recharge Report/i.test(head)) {
    const out = parseBpclRecharge(rows);
    return { ...out, ...bpclHeaderInfo(head) };
  }
  if (/Bharat Petroleum|Sales Transaction|SmartFleet/i.test(head)
      || rows.some((r) => r.some((c) => /Fuel Station Name/i.test(clean(c))))) {
    const out = parseBpclSales(rows);
    return { ...out, ...bpclHeaderInfo(head) };
  }
  if (/DriveTrack|HPCL/i.test(head)) return parseHPCL();

  throw Object.assign(new Error('unrecognised fleet-card export — no IOCL, BPCL or HPCL marker found'),
    { code: 'UNKNOWN_FORMAT' });
}

function bpclHeaderInfo(head) {
  const acct = head.match(/Account Number\s*,?\s*([A-Z0-9]{6,})/i);
  const org = head.match(/Organization Name\s*,?\s*([^,\n]+)/i);
  const period = head.match(/Period\s*,?\s*([\d]{1,2} \w{3} \d{4})\s*-\s*([\d]{1,2} \w{3} \d{4})/i);
  return {
    account_no: acct ? clean(acct[1]) : null,
    account_name: org ? clean(org[1]) : null,
    period_from: period ? toISO(period[1]) : null,
    period_to: period ? toISO(period[2]) : null,
  };
}
