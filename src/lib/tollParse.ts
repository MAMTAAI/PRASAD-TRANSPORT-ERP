// 🛣️ TOLL PARSE — pure parsing / mapping / rendering logic for the offline
// FASTag reconciliation engine. NO firebase imports — this module is unit-
// testable in Node (scripts/toll-parse-test.cjs runs it against the owner's
// real ICICI statement). Firestore-bound operations live in tollEngine.ts.
import { getField, toISODate, round2 } from './accounting/tripMath';

// ── Types ────────────────────────────────────────────────────────────────
export interface TollTxn {
  vehicle_no: string;      // normalized plate (NL01AA3054)
  tag_account: string;
  txn_datetime: string;    // 'YYYY-MM-DD HH:mm:ss'
  txn_date: string;        // 'YYYY-MM-DD'
  plaza: string;
  lane: string;
  ref_no: string;          // Unique Transaction ID / RRN
  amount: number;          // debit
}

export interface ParsedStatement {
  company: string;         // Corporate Name from the statement ('' if unknown)
  period_from: string;     // YYYY-MM-DD ('' if unknown)
  period_to: string;
  bank: string;
  txns: TollTxn[];
  skipped: number;         // non-toll rows (payments/credits)
}

export interface TollMap {
  txn: TollTxn;
  trip: any | null;
  confidence: 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED';
}

export const normalizePlate = (v: any): string =>
  String(v || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

// ── Date helpers ─────────────────────────────────────────────────────────
/** '30-06-2026 12:45:34' → { iso: '2026-06-30 12:45:34', date: '2026-06-30' } */
export function parseDdMmYyyyTime(s: string): { iso: string; date: string } | null {
  const m = String(s).trim().match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[\sT]*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = toISODate(s);
    return d ? { iso: `${d} 00:00:00`, date: d } : null;
  }
  const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return { iso: `${date} ${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}`, date };
}

export const fmtDDMMYYYY = (iso: string, sep = '/') => {
  const d = toISODate(iso);
  return d ? `${d.slice(8, 10)}${sep}${d.slice(5, 7)}${sep}${d.slice(0, 4)}` : '';
};
/** Annexure txn-date format: '08.07.2026 10:15' */
export const fmtTxnStamp = (dtIso: string) => {
  const [d, t] = String(dtIso).split(' ');
  return `${fmtDDMMYYYY(d, '.')} ${(t || '').slice(0, 5)}`.trim();
};

// ── ICICI FASTag e-statement text parser ─────────────────────────────────
const PLATE_RE = '[A-Z]{2}\\s?\\d{1,2}\\s?[A-Z]{0,3}\\s?\\d{4}';

/** Parse the ICICI FASTag e-statement (real-format verified). Structure:
 *  "Corporate Name: X", "Statement Period: a to b", then per-vehicle sections
 *  headed "PLATE - tagAccount" with rows:
 *  "DD-MM-YYYY HH:mm:ss  Trip (RRN No / Trip No)  <ref> / <trip>  Plaza Name:X- Lane ID:Y  CR  DR"
 *  Payment rows (credits) are skipped. */
export function parseIciciText(text: string): ParsedStatement {
  const clean = text.replace(/\s+/g, ' ');
  const company = (clean.match(/Corporate Name:?\s*([A-Z][A-Z &.]+?)(?=\s{0,3}(?:Statement|Customer|Address|GSTIN|$))/i)?.[1] || '').trim();
  const period = clean.match(/Statement Period:?\s*(\d{2}-\d{2}-\d{4})\s*to\s*(\d{2}-\d{2}-\d{4})/i);

  const txns: TollTxn[] = [];
  let skipped = 0;
  // Walk plate-headers ("NL01AA3054 - 42201715") and datetime rows in order.
  const tokenRe = new RegExp(`(${PLATE_RE})\\s*-\\s*(\\d{5,})|(\\d{2}-\\d{2}-\\d{4}\\s+\\d{2}:\\d{2}:\\d{2})`, 'g');
  const tokens: { plate?: string; tag?: string; dt?: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(clean))) {
    if (m[1]) tokens.push({ plate: normalizePlate(m[1]), tag: m[2], start: m.index, end: m.index + m[0].length });
    else tokens.push({ dt: m[3], start: m.index, end: m.index + m[0].length });
  }
  let curPlate = '', curTag = '';
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.plate) { curPlate = tk.plate; curTag = tk.tag || ''; continue; }
    const chunk = clean.slice(tk.end, tokens[i + 1] ? tokens[i + 1].start : tk.end + 400);
    if (/^\s*Payment\b/i.test(chunk)) { skipped++; continue; }
    if (!/Plaza Name\s*:/i.test(chunk)) { skipped++; continue; }
    const ref = (chunk.match(/Trip\s*\(RRN No \/ Trip No\)\s*([A-Za-z0-9]+\s*\/\s*[A-Za-z0-9]+|[A-Za-z0-9/ ]+?)\s*Plaza Name/i)?.[1] || '')
      .replace(/\s*\/\s*/, ' / ').trim();
    const plaza = (chunk.match(/Plaza Name\s*:\s*(.*?)\s*-\s*Lane/i)?.[1] || '').trim();
    const lane = (chunk.match(/Lane\s*ID\s*:\s*([A-Za-z0-9]+)/i)?.[1] || '').trim();
    const amounts = chunk.match(/[\d,]+\.\d{2}/g) || [];
    if (amounts.length < 2) { skipped++; continue; }
    // Column order is CR then DR; take the LAST numeric cell of the row.
    const dr = parseFloat(amounts[amounts.length - 1].replace(/,/g, '')) || 0;
    if (dr <= 0) { skipped++; continue; }
    const dt = parseDdMmYyyyTime(tk.dt || '');
    if (!dt || !curPlate) { skipped++; continue; }
    txns.push({
      vehicle_no: curPlate, tag_account: curTag,
      txn_datetime: dt.iso, txn_date: dt.date,
      plaza, lane, ref_no: ref || `AUTO-${curPlate}-${dt.iso.replace(/[^0-9]/g, '')}`,
      amount: dr,
    });
  }
  return {
    company, bank: /ICICI/i.test(text) ? 'ICICI' : '',
    period_from: period ? toISODate(period[1]) : '',
    period_to: period ? toISODate(period[2]) : '',
    txns, skipped,
  };
}

// ── Generic CSV / Excel rows parser (any bank export) ────────────────────
export function rowsToTxns(rows: any[][]): { txns: TollTxn[]; skipped: number } {
  if (!rows.length) return { txns: [], skipped: 0 };
  const headers = rows[0].map((h: any) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const idx = (keys: string[]) => headers.findIndex(h => keys.some(k => h.includes(k)));
  const vI = idx(['vehicle', 'plate', 'licence', 'license', 'reg', 'vrn', 'lpn']);
  const dI = idx(['dateandtime', 'datetime', 'txndate', 'transactiondate', 'date']);
  const pI = idx(['plaza', 'tollname', 'location', 'description']);
  const rI = idx(['uniquetransaction', 'transactionref', 'transactionid', 'refno', 'rrn', 'txnid', 'ref']);
  const drI = idx(['debit', 'amountrsdr', 'dramount', 'deduction', 'amount', 'fee']);
  const tagI = idx(['tagaccount', 'tagid']);
  const txns: TollTxn[] = []; let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const plate = normalizePlate(vI > -1 ? r[vI] : '');
    const amt = parseFloat(String(drI > -1 ? r[drI] : '').replace(/[^0-9.]/g, '')) || 0;
    const dt = parseDdMmYyyyTime(String(dI > -1 ? r[dI] : ''));
    if (!plate || amt <= 0 || !dt) { skipped++; continue; }
    const desc = String(pI > -1 ? r[pI] : '');
    const plaza = (desc.match(/Plaza Name\s*:\s*(.*?)\s*-\s*Lane/i)?.[1] || desc).trim();
    txns.push({
      vehicle_no: plate, tag_account: String(tagI > -1 ? (r[tagI] ?? '') : ''),
      txn_datetime: dt.iso, txn_date: dt.date, plaza,
      lane: (desc.match(/Lane\s*ID\s*:\s*([A-Za-z0-9]+)/i)?.[1] || ''),
      ref_no: String(rI > -1 ? (r[rI] ?? '') : '').trim() || `AUTO-${plate}-${dt.iso.replace(/[^0-9]/g, '')}`,
      amount: amt,
    });
  }
  return { txns, skipped };
}

export function parseCsvText(text: string): any[][] {
  return text.split(/\r?\n/).filter(l => l.trim()).map(line =>
    line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, '')));
}

// ── Auto trip-mapping engine ─────────────────────────────────────────────
/** Map each toll txn to the trip whose Loading_Date ≤ txn datetime ≤
 *  Unloading_Date for the same vehicle. Open (in-transit) trips accept tolls
 *  from loading up to now. Multiple candidates → nearest loading date. */
export function mapTollsToTrips(txns: TollTxn[], trips: any[]): TollMap[] {
  const byVehicle = new Map<string, any[]>();
  for (const t of trips) {
    const v = normalizePlate(getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no']));
    if (!v) continue;
    if (!byVehicle.has(v)) byVehicle.set(v, []);
    byVehicle.get(v)!.push(t);
  }
  return txns.map(txn => {
    const cands = byVehicle.get(txn.vehicle_no) || [];
    if (!cands.length) return { txn, trip: null, confidence: 'UNMATCHED' as const };
    const ts = new Date(txn.txn_datetime.replace(' ', 'T')).getTime();
    const inWindow = cands.filter(t => {
      const ld = toISODate(getField(t, ['loading_date', 'Loading_Date', 'start_date', 'date']));
      if (!ld) return false;
      const from = new Date(`${ld}T00:00:00`).getTime();
      const ud = toISODate(getField(t, ['unloading_date', 'Unloading_Date']));
      const to = ud ? new Date(`${ud}T23:59:59`).getTime()
        : (String(getField(t, ['trip_status', 'Trip_Status'])) !== 'COMPLETED' ? Date.now() : from + 15 * 86400000);
      return ts >= from && ts <= to;
    });
    if (!inWindow.length) return { txn, trip: null, confidence: 'UNMATCHED' as const };
    if (inWindow.length === 1) return { txn, trip: inWindow[0], confidence: 'MATCHED' as const };
    const sorted = [...inWindow].sort((a, b) => {
      const la = new Date(toISODate(getField(a, ['loading_date', 'Loading_Date', 'start_date'])) || 0).getTime();
      const lb = new Date(toISODate(getField(b, ['loading_date', 'Loading_Date', 'start_date'])) || 0).getTime();
      return Math.abs(ts - la) - Math.abs(ts - lb);
    });
    return { txn, trip: sorted[0], confidence: 'AMBIGUOUS' as const };
  });
}

// ── IOCL claim building (exact reproduced format) ────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n: number): string { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`; }
function three(n: number): string { return n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n); }
/** Indian-system amount in words (matches "Twenty Three Thousand Three Hundred Twenty"). */
export function amountInWordsINR(n: number): string {
  n = Math.round(n);
  if (n <= 0) return 'Zero';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const parts = [];
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return parts.join(' ');
}

/** Claim No like 110246990726012 = vendorCode(no leading zeros) + MM + YY + seq. */
export const generateClaimNo = (vendorCode: string, dateISO: string, seq: number) =>
  `${String(vendorCode).replace(/^0+/, '')}${dateISO.slice(5, 7)}${dateISO.slice(2, 4)}${String(seq).padStart(3, '0')}`;

export interface ClaimTripGroup {
  truck_no: string; truck_type: string;
  invoice_no: string; invoice_date: string;   // ISO
  loading_loc: string; loading_code: string;
  dest_name: string; dest_code: string;
  txns: any[];                                 // TOLL_TRANSACTIONS docs
  total: number;
}

/** Group unclaimed mapped toll docs by trip → claim rows (auto from mapping). */
export function groupTollsForClaim(tollDocs: any[]): ClaimTripGroup[] {
  const groups = new Map<string, ClaimTripGroup>();
  for (const t of tollDocs) {
    const key = t.trip_db_id || `${t.Vehicle_No}|${t.invoice_no}`;
    if (!groups.has(key)) {
      groups.set(key, {
        truck_no: t.Vehicle_No || '', truck_type: 'BULK',
        invoice_no: t.invoice_no || '', invoice_date: t.invoice_date || '',
        loading_loc: t.loading_loc || '', loading_code: t.loading_code || '',
        dest_name: t.dest_loc || '', dest_code: '',
        txns: [], total: 0,
      });
    }
    const g = groups.get(key)!;
    g.txns.push(t);
    g.total = round2(g.total + (parseFloat(t.Amount) || 0));
  }
  return [...groups.values()].map(g => ({
    ...g,
    txns: g.txns.sort((a, b) => String(a.txn_datetime || a.Txn_Date).localeCompare(String(b.txn_datetime || b.Txn_Date))),
  })).sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || '') || a.truck_no.localeCompare(b.truck_no));
}

export interface ClaimData {
  claim_no: string; claim_date: string;        // ISO
  vendor_name: string; vendor_code: string;
  plant_name: string; plant_code: string;
  period_from: string; period_to: string;      // ISO
  fortnight_label: string;                     // '1st' | '2nd'
  groups: ClaimTripGroup[];
  total: number;
}

/** Render the EXACT IOCL claim document: Page 1 = "Claim for Reimbursement of
 *  Toll" (summary), following pages = "Claim for Reimbursement of Toll
 *  Charges :" (Annexure-I detail). Layout reproduced from the owner's real
 *  signed claims. */
export function renderIoclClaimHtml(c: ClaimData): string {
  const label = (t: string) => `<span class="lbl">${t}</span>`;
  const headBlock = (title: string) => `
    <div class="doc-head">
      <div class="io-logo"><span class="io-mark">Indian</span>Oil<div class="io-tag">The Energy of India</div></div>
      <div class="doc-title">${title}</div>
      <div style="width:70px"></div>
    </div>
    <div class="period-line"><b>Period of Claim:</b>&nbsp;&nbsp;${fmtDDMMYYYY(c.period_from, '-')} &nbsp;to&nbsp; ${fmtDDMMYYYY(c.period_to, '-')} &nbsp;::&nbsp; ${c.fortnight_label} fortnight of month</div>
    <table class="meta"><tr>
      <td>${label('Claim No')} ${c.claim_no}</td><td>${label('Date')} ${new Date(c.claim_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-')}</td></tr>
      <tr><td>${label('Vendor')} ${c.vendor_name}</td><td>${label('Vendor Code')} ${c.vendor_code}</td></tr>
      <tr><td>${label('Plant')} ${c.plant_name}</td><td>${label('Plant Code')} ${c.plant_code}</td></tr>
      <tr><td>${label('Claim Type')} FASTag</td><td>${label('GST')} Yes</td></tr>
    </table>`;

  const summaryRows = c.groups.map((g, i) => `
    <tr>
      <td class="c">${i + 1}</td><td class="c">${g.truck_no}</td><td class="c">${g.truck_type}</td>
      <td class="c">${g.invoice_no}</td><td class="c">${fmtDDMMYYYY(g.invoice_date)}</td>
      <td>${g.loading_loc}</td><td class="c">${g.loading_code}</td>
      <td>${g.dest_name}${g.dest_code ? ' ' + g.dest_code : ''}</td>
      <td class="r">${g.total.toFixed(1)}</td>
    </tr>`).join('');

  let sn = 0;
  const annexRows = c.groups.map(g => g.txns.map(t => {
    sn++;
    return `<tr>
      <td class="c">${sn}</td><td class="c">${g.truck_no}</td><td class="c">${g.invoice_no}</td>
      <td class="c">${fmtDDMMYYYY(g.invoice_date)}</td><td>${g.loading_loc}</td><td>${g.dest_name}</td>
      <td class="ref">${t.Transaction_Ref || ''}</td>
      <td class="c">${fmtTxnStamp(t.txn_datetime || t.Txn_Date || '')}</td>
      <td class="c">${t.Toll_Plaza_Name || ''}</td>
      <td class="r">${(parseFloat(t.Amount) || 0).toFixed(1)}</td>
      <td class="r">${(parseFloat(t.Amount) || 0).toFixed(1)}</td>
      <td class="c">Full</td>
    </tr>`;
  }).join('')).join('');

  return `<!doctype html><html><head><title>Toll Claim ${c.claim_no}</title><style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11px; margin: 0; padding: 18px 26px; }
    .doc-head { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #e8a51c; padding-bottom: 6px; }
    .io-logo { font-size: 17px; font-weight: bold; color: #1a3c8f; } .io-mark { color: #e8641c; }
    .io-tag { font-size: 8px; font-style: italic; color: #555; }
    .doc-title { font-size: 18px; font-weight: 600; text-align: center; flex: 1; }
    .period-line { border-bottom: 1px solid #e8a51c; padding: 6px 2px; margin-bottom: 10px; }
    .meta { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    .meta td { padding: 5px 2px; width: 50%; }
    .lbl { background: #fce4e4; padding: 2px 10px; margin-right: 10px; display: inline-block; min-width: 90px; }
    .sec { font-size: 13px; margin: 14px 0 4px; border-bottom: 1px solid #e8a51c; padding-bottom: 4px; }
    table.grid { width: 100%; border-collapse: collapse; margin-top: 6px; }
    .grid th { background: #bdd7ee; border: 1px solid #555; padding: 5px 4px; font-size: 10px; font-weight: bold; text-align: center; }
    .grid td { border: 1px solid #555; padding: 4px; font-size: 10px; }
    .c { text-align: center; } .r { text-align: right; } .ref { font-size: 9px; word-break: break-all; }
    .total-row td { font-weight: bold; background: #eef5fb; }
    .sign { margin-top: 45px; display: flex; justify-content: space-between; align-items: flex-end; }
    .pageno { text-align: right; margin-top: 18px; font-size: 10px; }
    .page-break { page-break-before: always; }
    @media print { body { padding: 10px 14px; } .grid th { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .lbl { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style></head><body>

  ${headBlock('Claim for Reimbursement of Toll')}
  <div class="sec">Declaration:</div>
  <div style="text-align: justify; line-height: 1.5;">☑ I/we hereby declare that claimed toll charges have been incurred during the assigned journey of the following vehicles on the designated route demarcated by Indian Oil Corporation Ltd. No other claim pertaining to Toll Reimbursement for the period is pending on behalf of Indian Oil. I/We certify that the claimed amount(s) are true to the best of my/our knowledge and belief.</div>
  <div class="sec">Summary of Claims:</div>
  <table class="grid"><thead><tr>
    <th>SN</th><th>Truck No</th><th>Truck Type</th><th>Invoice No</th><th>Invoice Date</th>
    <th>Loading Location</th><th>Loading Loc Code</th><th>Destination Name</th><th>Net Payable Toll (INR)</th>
  </tr></thead><tbody>${summaryRows}</tbody></table>
  <p style="margin-top: 16px;">Note: Detailed information of claimed Toll Charges amount is enclosed as Annexure-I.</p>
  <div class="sign">
    <div>INR&nbsp; ${amountInWordsINR(c.total)}<br/><br/><span style="border-top: 1px solid #e8a51c; padding-top: 4px; display: inline-block;">Total Claimed Amount in Words</span></div>
    <div style="text-align: left;"><span style="border-top: 1px solid #e8a51c; padding-top: 4px; display: inline-block; min-width: 220px;">For and On Behalf of<br/>M/s ${c.vendor_name}<br/>Authorized Signatory</span></div>
  </div>
  <div class="pageno">Page : 1 of 1</div>

  <div class="page-break"></div>
  ${headBlock('Claim for Reimbursement of Toll Charges :')}
  <table class="grid"><thead><tr>
    <th>SN</th><th>Truck No</th><th>Invoice No</th><th>Invoice Date</th><th>Loading Location</th>
    <th>Destination Name</th><th>Transaction Ref No</th><th>Txn Date</th><th>Toll</th>
    <th>Txn Amount</th><th>Amount Payable</th><th>Remarks</th>
  </tr></thead><tbody>
    ${annexRows}
    <tr class="total-row"><td colspan="9" class="r">TOTAL</td><td class="r">${c.total.toFixed(1)}</td><td class="r">${c.total.toFixed(1)}</td><td></td></tr>
  </tbody></table>

  <script>window.onload = function () { setTimeout(function () { window.print(); }, 400); }</script>
  </body></html>`;
}
