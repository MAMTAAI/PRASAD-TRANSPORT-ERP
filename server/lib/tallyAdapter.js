// server/lib/tallyAdapter.js
// ─────────────────────────────────────────────────────────────────────────────
// Direct Tally Prime connector — native XML over Tally's HTTP server (:9000).
//
// Zero-double-push guarantee, two independent walls:
//   1. tally_sync.source is UNIQUE — our side records intent before sending and
//      refuses a second push of anything already SYNCED.
//   2. Every voucher carries our tally_guid as REMOTEID — Tally deduplicates on
//      it, so even a crash between "Tally accepted" and "we recorded it"
//      cannot create a duplicate on re-push.
//
// Tally offline is a STATE, not an error: pushes park as PENDING and the
// "Sync to Tally" button (or a later sweep) retries when Tally Prime is open.
// ─────────────────────────────────────────────────────────────────────────────
import { query, queryOne, withTransaction } from '../db/pool.js';

const TALLY_URL = process.env.TALLY_URL ?? 'http://localhost:9000';
const COMPANY = process.env.TALLY_COMPANY ?? '';   // blank = Tally's active company

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tallyDate = (iso) => String(iso ?? '').slice(0, 10).replace(/-/g, ''); // YYYYMMDD

// ── XML builders ────────────────────────────────────────────────────────────

function envelope(body) {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    (COMPANY ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '') +
    `</REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

const ledgerLine = (name, amount, isDeemedPositive) =>
  `<ALLLEDGERENTRIES.LIST>` +
  `<LEDGERNAME>${esc(name)}</LEDGERNAME>` +
  // Tally sign convention: Dr = deemed positive with a NEGATIVE amount.
  `<ISDEEMEDPOSITIVE>${isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
  `<AMOUNT>${isDeemedPositive ? '-' : ''}${Number(amount).toFixed(2)}</AMOUNT>` +
  `</ALLLEDGERENTRIES.LIST>`;

/**
 * A double-entry voucher (Receipt / Payment / Contra) from our ledger lines.
 * @param {object} v { guid, type, date, narration, ref, lines: [{ledger, dr_cr, amount}] }
 */
export function buildVoucherXml(v) {
  const lines = v.lines.map((l) => ledgerLine(l.ledger, l.amount, l.dr_cr === 'DR')).join('');
  return envelope(
    `<VOUCHER REMOTEID="${esc(v.guid)}" VCHTYPE="${esc(v.type)}" ACTION="Create">` +
    `<DATE>${tallyDate(v.date)}</DATE>` +
    `<GUID>${esc(v.guid)}</GUID>` +
    `<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${esc(v.ref ?? v.guid.slice(0, 8))}</VOUCHERNUMBER>` +
    `<NARRATION>${esc(v.narration ?? '')}</NARRATION>` +
    `<ISINVOICE>No</ISINVOICE>` +
    lines +
    `</VOUCHER>`
  );
}

/**
 * A freight Sales invoice: Dr customer / Cr Freight Income.
 * @param {object} inv { guid, date, customer, amount, tripCode, vehicleNo, narration }
 */
export function buildSalesInvoiceXml(inv) {
  return envelope(
    `<VOUCHER REMOTEID="${esc(inv.guid)}" VCHTYPE="Sales" ACTION="Create">` +
    `<DATE>${tallyDate(inv.date)}</DATE>` +
    `<GUID>${esc(inv.guid)}</GUID>` +
    `<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${esc(inv.tripCode ?? inv.guid.slice(0, 8))}</VOUCHERNUMBER>` +
    `<PARTYLEDGERNAME>${esc(inv.customer)}</PARTYLEDGERNAME>` +
    `<NARRATION>${esc(inv.narration ?? `Freight bill ${inv.tripCode ?? ''} vehicle ${inv.vehicleNo ?? ''}`)}</NARRATION>` +
    `<ISINVOICE>No</ISINVOICE>` +
    ledgerLine(inv.customer, inv.amount, true) +          // Dr customer
    ledgerLine('Freight Income', inv.amount, false) +     // Cr income
    `</VOUCHER>`
  );
}

// ── Transport ───────────────────────────────────────────────────────────────

export async function tallyAlive() {
  try {
    // An empty POST makes Tally answer with its banner — cheapest liveness probe.
    const res = await fetch(TALLY_URL, { method: 'POST', body: '', signal: AbortSignal.timeout(3000) });
    return { up: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { up: false, detail: err.message };
  }
}

async function send(xml) {
  const res = await fetch(TALLY_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml;charset=utf-8' },
    body: xml,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tally HTTP ${res.status}: ${text.slice(0, 200)}`);
  // Tally reports import results inside the body, HTTP 200 regardless.
  const created = Number(text.match(/<CREATED>(\d+)<\/CREATED>/)?.[1] ?? 0);
  const altered = Number(text.match(/<ALTERED>(\d+)<\/ALTERED>/)?.[1] ?? 0);
  const errors = Number(text.match(/<ERRORS>(\d+)<\/ERRORS>/)?.[1] ?? 0);
  const lineError = text.match(/<LINEERROR>([^<]+)<\/LINEERROR>/)?.[1];
  if (errors > 0 || lineError) throw new Error(`tally rejected: ${lineError ?? `${errors} error(s)`}`);
  return { created, altered, response: text.slice(0, 4000) };
}

// ── Push paths ──────────────────────────────────────────────────────────────

const TYPE_MAP = { RECEIPT: 'Receipt', PAYMENT: 'Payment', CONTRA: 'Contra' };

/** Push one of OUR vouchers (a voucher_id group in ledger_entries) to Tally. */
export async function pushVoucher(voucherId) {
  const sourceKey = `VOUCHER:${voucherId}`;

  const { rows: lines } = await query(
    `SELECT ledger_name AS ledger, dr_cr, amount, entry_date, particulars, source_ref
       FROM ledger_entries WHERE voucher_id = $1::uuid ORDER BY dr_cr`, [voucherId]);
  if (!lines.length) throw Object.assign(new Error(`voucher ${voucherId} not found`), { code: 'NOT_FOUND' });

  // Voucher type from its shape: bank/cash side tells receipt vs payment;
  // two bank/cash lines = contra.
  const isMoneyAcct = (n) => /cash|bank|sbi|hdfc|icici|axis/i.test(n);
  const moneyLines = lines.filter((l) => isMoneyAcct(l.ledger));
  const type = moneyLines.length >= 2 ? 'Contra'
    : moneyLines[0]?.dr_cr === 'DR' ? 'Receipt' : 'Payment';

  return pushWithRegistry(sourceKey, type, (guid) => buildVoucherXml({
    guid, type,
    date: lines[0].entry_date,
    narration: lines[0].particulars,
    ref: lines[0].source_ref,
    lines,
  }));
}

/** Push a settled trip's freight bill as a Tally Sales voucher. */
export async function pushTripInvoice(tripId) {
  const trip = await queryOne(
    `SELECT id, trip_code, customer_name, vehicle_no, freight_amount,
            COALESCE(unloading_date, loading_date, CURRENT_DATE) AS bill_date, status
       FROM trips WHERE id = $1::uuid`, [tripId]);
  if (!trip) throw Object.assign(new Error('trip not found'), { code: 'NOT_FOUND' });
  if (trip.status !== 'SETTLED') {
    // Only TARA-settled freight goes to Tally — an unsettled bill in Tally
    // would double when the settlement voucher followed.
    throw Object.assign(new Error(`trip is ${trip.status}; only SETTLED trips push as Sales`), { code: 'NOT_SETTLED' });
  }
  if (!trip.freight_amount) throw Object.assign(new Error('trip has no freight_amount'), { code: 'NO_AMOUNT' });

  return pushWithRegistry(`TRIP:${tripId}`, 'Sales', (guid) => buildSalesInvoiceXml({
    guid,
    date: trip.bill_date,
    customer: `Debtors: ${trip.customer_name}`,
    amount: trip.freight_amount,
    tripCode: trip.trip_code,
    vehicleNo: trip.vehicle_no,
  }));
}

/** The idempotency spine shared by both push paths. */
async function pushWithRegistry(sourceKey, voucherType, buildXml) {
  // Claim (or re-open) the registry row FIRST — the intent is durable before
  // any network I/O, and a SYNCED row is a hard stop.
  const reg = await withTransaction(async (tx) => {
    const { rows: [existing] } = await tx.query(
      `SELECT source, tally_guid, status FROM tally_sync WHERE source = $1 FOR UPDATE`, [sourceKey]);
    if (existing?.status === 'SYNCED') {
      throw Object.assign(new Error(`${sourceKey} already synced to Tally (guid ${existing.tally_guid})`), { code: 'ALREADY_SYNCED' });
    }
    if (existing) return existing;
    const { rows: [made] } = await tx.query(
      `INSERT INTO tally_sync (source, voucher_type) VALUES ($1, $2) RETURNING source, tally_guid, status`,
      [sourceKey, voucherType]);
    return made;
  });

  const xml = buildXml(reg.tally_guid);
  await query(`UPDATE tally_sync SET request_xml = $2, attempts = attempts + 1 WHERE source = $1`, [sourceKey, xml]);

  try {
    const out = await send(xml);
    await query(
      `UPDATE tally_sync SET status = 'SYNCED', tally_synced_at = now(), response_xml = $2, last_error = NULL
        WHERE source = $1`, [sourceKey, out.response]);
    return { pushed: true, source: sourceKey, tally_guid: reg.tally_guid, created: out.created, altered: out.altered };
  } catch (err) {
    await query(
      `UPDATE tally_sync SET status = 'FAILED', last_error = $2 WHERE source = $1`,
      [sourceKey, String(err.message).slice(0, 1000)]);
    // FAILED is retryable — PENDING/FAILED rows re-push; SYNCED never does.
    throw Object.assign(err, { code: err.code ?? 'TALLY_PUSH_FAILED', tally_guid: reg.tally_guid });
  }
}

// ── Master verification ─────────────────────────────────────────────────────

/** Pull Tally's List of Accounts and diff against our party ledgers. */
export async function masterCheck() {
  const exportXml =
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Ledgers</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
    (COMPANY ? `<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY>` : '') +
    `</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="List of Ledgers" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const res = await fetch(TALLY_URL, {
    method: 'POST', headers: { 'content-type': 'text/xml;charset=utf-8' },
    body: exportXml, signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const tallyNames = new Set(
    [...text.matchAll(/<LEDGER NAME="([^"]+)"/g)].map((m) => m[1].trim().toUpperCase())
  );
  if (!tallyNames.size) {
    // Also accept <NAME>x</NAME> shape (differs across Tally releases).
    for (const m of text.matchAll(/<NAME(?:\.LIST)?>\s*([^<]+?)\s*<\/NAME/g)) tallyNames.add(m[1].trim().toUpperCase());
  }

  const { rows: ours } = await query(
    `SELECT ledger_name FROM ledgers WHERE group_head IN
       ('Sundry Debtors (Customers)','Sundry Debtors','Sundry Creditors (Vendors)','Sundry Creditors',
        'Sundry Creditors (Fuel Pumps)','Bank Accounts','Cash-in-Hand','Current Assets - Driver Advances')
      ORDER BY ledger_name`);

  const missingInTally = ours.filter((r) => !tallyNames.has(r.ledger_name.trim().toUpperCase())).map((r) => r.ledger_name);
  return {
    tally_ledgers: tallyNames.size,
    our_party_ledgers: ours.length,
    missing_in_tally: missingInTally,
    note: missingInTally.length
      ? 'Create these in Tally (or import masters) BEFORE pushing vouchers that reference them — Tally rejects vouchers naming unknown ledgers.'
      : 'Every party ledger exists in Tally — vouchers will import cleanly.',
  };
}

export default { buildVoucherXml, buildSalesInvoiceXml, pushVoucher, pushTripInvoice, tallyAlive, masterCheck };
