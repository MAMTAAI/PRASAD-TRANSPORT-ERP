// server/lib/gstExport.js
// ─────────────────────────────────────────────────────────────────────────────
// GST return packs for a Goods Transport Agency, built from the output
// register (v_gst_output_docs) and the net month view (v_gst_net_month).
//
//   GSTR-1  — the GST Offline Tool's CSV sheets (b2b, exemp, hsn, docs) with
//             the exact column headings the tool imports, the portal JSON
//             (GST3.x schema: b2b / nil / hsn / doc_issue) and an Excel
//             workbook carrying all the sheets.
//   GSTR-3B — the table-wise summary (3.1, 4, 5, 6.1) the CA keys into the
//             portal, with the set-off already applied (Rule 88A).
//   CA pack — one workbook: summary, every GSTR-1 sheet, GSTR-3B, the ITC
//             register, the GSTR-2B reconciliation and the attention list.
//
// Nothing here rounds differently from the database: taxable and tax come
// from the documents as they are; only totals are summed in paise.
// ─────────────────────────────────────────────────────────────────────────────
import * as XLSXmod from 'xlsx';

const XLSX = XLSXmod.default ?? XLSXmod;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fix2 = (v) => n2(v).toFixed(2);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => (d instanceof Date ? d : new Date(d));
/** 31-Aug-2026 — the offline tool's CSV date. */
export const dMonY = (d) => { if (!d) return ''; const x = ymd(d); return `${pad(x.getUTCDate())}-${MON[x.getUTCMonth()]}-${x.getUTCFullYear()}`; };
/** 31-08-2026 — the portal JSON date. */
export const ddmmyyyy = (d) => { if (!d) return ''; const x = ymd(d); return `${pad(x.getUTCDate())}-${pad(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}`; };
export const periodLabel = (p) => (p && p.length === 6 ? `${MON[Number(p.slice(0, 2)) - 1]} ${p.slice(2)}` : p ?? '');
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const csvOf = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

const pos = (code, states) => (code ? `${code}-${states[code] ?? ''}` : '');
const sac = (firm) => firm?.gst_sac ?? '996791';
/** IOCL numbers its AC5 bills in more than one series (11024699AS…, MNP…); the docs table lists each series on its own line. */
const seriesOf = (docs) => {
  const m = new Map();
  for (const d of docs) if (d.doc_kind === 'AC5' && d.doc_status === 'ISSUED') { const k = String(d.doc_no).replace(/\d+$/, ''); if (!m.has(k)) m.set(k, []); m.get(k).push(d.doc_no); }
  for (const v of m.values()) v.sort();
  return m;
};
const SAC_DESC = 'Goods transport agency services for road transport';

/**
 * GSTR-1 sheets from the period's issued documents.
 * @param docs   rows of v_gst_output_docs (issued only unless projecting)
 * @param firm   v_gst_overview row
 * @param states { code: name }
 */
export function gstr1Sheets(docs, firm, states) {
  const issues = [];
  const b2b = [['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount']];
  const exempt = { INTRB2B: 0, INTRAB2B: 0, INTRB2C: 0, INTRAB2C: 0 };
  const hsn = new Map(); // rate → totals
  let docMin = null, docMax = null, docCount = 0;
  for (const d of docs) {
    if (d.doc_status !== 'ISSUED') continue;
    if (d.needs) issues.push({ doc: d.doc_no, customer: d.customer_name, needs: d.needs, taxable: d.taxable });
    if (d.treatment === 'EXEMPT') {
      const key = `${d.supply_type === 'INTER' ? 'INTR' : 'INTRA'}${d.recipient_gstin ? 'B2B' : 'B2C'}`;
      exempt[key] = n2(exempt[key] + n2(d.taxable));
      continue;
    }
    if (!d.recipient_gstin) continue;             // reported on the attention list, never with a blank GSTIN
    b2b.push([d.recipient_gstin, d.customer_name, d.doc_no, dMonY(d.doc_date), fix2(d.invoice_value), pos(d.place_of_supply, states), d.treatment === 'RCM' ? 'Y' : 'N', '', 'Regular B2B', '', fix2(d.rate), fix2(d.taxable), '0.00']);
    const k = String(n2(d.rate));
    const h = hsn.get(k) ?? { rate: n2(d.rate), qty: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    h.value = n2(h.value + n2(d.invoice_value)); h.taxable = n2(h.taxable + n2(d.taxable));
    h.igst = n2(h.igst + n2(d.igst)); h.cgst = n2(h.cgst + n2(d.cgst)); h.sgst = n2(h.sgst + n2(d.sgst));
    hsn.set(k, h);
    if (d.doc_kind === 'BILL') { docCount += 1; if (!docMin || d.doc_no < docMin) docMin = d.doc_no; if (!docMax || d.doc_no > docMax) docMax = d.doc_no; }
  }
  const exemp = [['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies'],
    ['Inter-State supplies to registered persons', '0.00', fix2(exempt.INTRB2B), '0.00'],
    ['Intra-State supplies to registered persons', '0.00', fix2(exempt.INTRAB2B), '0.00'],
    ['Inter-State supplies to unregistered persons', '0.00', fix2(exempt.INTRB2C), '0.00'],
    ['Intra-State supplies to unregistered persons', '0.00', fix2(exempt.INTRAB2C), '0.00']];
  const hsnRows = [['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount', 'Rate']];
  for (const h of [...hsn.values()].sort((a, b) => a.rate - b.rate)) hsnRows.push([sac(firm), SAC_DESC, 'OTH-OTHERS', '0', fix2(h.value), fix2(h.taxable), fix2(h.igst), fix2(h.cgst), fix2(h.sgst), '0.00', fix2(h.rate)]);
  const docsRows = [['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled']];
  if (docCount) docsRows.push(['Invoices for outward supply', docMin, docMax, String(docCount), '0']);
  for (const nos of seriesOf(docs).values()) docsRows.push(['Invoices for outward supply', nos[0], nos[nos.length - 1], String(nos.length), '0']);
  return { b2b, exemp, hsn: hsnRows, docs: docsRows, issues };
}

/** The portal / offline-tool JSON for GSTR-1. */
export function gstr1Json(docs, firm, period, states) {
  const byCtin = new Map();
  const exempt = { INTRB2B: 0, INTRAB2B: 0, INTRB2C: 0, INTRAB2C: 0 };
  const hsn = new Map();
  let docMin = null, docMax = null, docCount = 0;
  for (const d of docs) {
    if (d.doc_status !== 'ISSUED') continue;
    if (d.treatment === 'EXEMPT') { const key = `${d.supply_type === 'INTER' ? 'INTR' : 'INTRA'}${d.recipient_gstin ? 'B2B' : 'B2C'}`; exempt[key] = n2(exempt[key] + n2(d.taxable)); continue; }
    if (!d.recipient_gstin) continue;
    const inter = d.supply_type === 'INTER';
    const itm = { num: 1, itm_det: { rt: n2(d.rate), txval: n2(d.taxable), csamt: 0 } };
    if (inter) itm.itm_det.iamt = n2(d.igst); else { itm.itm_det.camt = n2(d.cgst); itm.itm_det.samt = n2(d.sgst); }
    const inv = { inum: d.doc_no, idt: ddmmyyyy(d.doc_date), val: n2(d.invoice_value), pos: d.place_of_supply, rchrg: d.treatment === 'RCM' ? 'Y' : 'N', inv_typ: 'R', itms: [itm] };
    if (!byCtin.has(d.recipient_gstin)) byCtin.set(d.recipient_gstin, { ctin: d.recipient_gstin, inv: [] });
    byCtin.get(d.recipient_gstin).inv.push(inv);
    const k = String(n2(d.rate));
    const h = hsn.get(k) ?? { rt: n2(d.rate), txval: 0, iamt: 0, camt: 0, samt: 0 };
    h.txval = n2(h.txval + n2(d.taxable)); h.iamt = n2(h.iamt + n2(d.igst)); h.camt = n2(h.camt + n2(d.cgst)); h.samt = n2(h.samt + n2(d.sgst));
    hsn.set(k, h);
    if (d.doc_kind === 'BILL') { docCount += 1; if (!docMin || d.doc_no < docMin) docMin = d.doc_no; if (!docMax || d.doc_no > docMax) docMax = d.doc_no; }
  }
  const out = { gstin: firm.gstin, fp: period, version: 'GST3.1.5', hash: 'hash' };
  if (byCtin.size) out.b2b = [...byCtin.values()];
  const nil = Object.entries(exempt).filter(([, v]) => v > 0).map(([sply_ty, v]) => ({ sply_ty, expt_amt: v, nil_amt: 0, ngsup_amt: 0 }));
  if (nil.length) out.nil = { inv: nil };
  if (hsn.size) out.hsn = { data: [...hsn.values()].sort((a, b) => a.rt - b.rt).map((h, i) => ({ num: i + 1, hsn_sc: sac(firm), desc: SAC_DESC, uqc: 'OTH', qty: 0, txval: h.txval, iamt: h.iamt, camt: h.camt, samt: h.samt, csamt: 0, rt: h.rt })) };
  const series = [];
  if (docCount) series.push({ num: 1, from: docMin, to: docMax, totnum: docCount, cancel: 0, net_issue: docCount });
  for (const nos of seriesOf(docs).values()) series.push({ num: series.length + 1, from: nos[0], to: nos[nos.length - 1], totnum: nos.length, cancel: 0, net_issue: nos.length });
  if (series.length) out.doc_issue = { doc_det: [{ doc_num: 1, docs: series }] };
  return out;
}

/** GSTR-3B table rows from one v_gst_net_month row. */
export function gstr3bRows(m, firm, period) {
  const r = (t, label, taxable, igst, cgst, sgst, note = '') => [t, label, fix2(taxable), fix2(igst), fix2(cgst), fix2(sgst), note];
  const rows = [['Table', 'Particulars', 'Taxable value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Note']];
  rows.push(['', `${firm.company_name} · GSTIN ${firm.gstin ?? '—'} · ${periodLabel(period)} · scheme ${firm.gst_scheme}`, '', '', '', '', '']);
  rows.push(r('3.1(a)', 'Outward taxable supplies (other than zero rated, nil rated and exempted)', m.fcm_taxable, m.fcm_igst, m.fcm_cgst, m.fcm_sgst, m.fcm_taxable > 0 ? 'forward charge invoices' : ''));
  rows.push(r('3.1(b)', 'Outward taxable supplies (zero rated)', 0, 0, 0, 0));
  rows.push(r('3.1(c)', 'Other outward supplies (nil rated, exempted)', n2(m.exempt_taxable) + n2(m.rcm_taxable), 0, 0, 0, `includes ₹${fix2(m.rcm_taxable)} of GTA supplies under reverse charge (GSTR-1 table 4B, tax ₹${fix2(m.rcm_tax)} payable by the recipients) — CA to confirm placement`));
  rows.push(r('3.1(d)', 'Inward supplies (liable to reverse charge)', 0, 0, 0, 0, 'hire of goods carriages to a GTA is exempt (Notification 12/2017 entry 22)'));
  rows.push(r('3.1(e)', 'Non-GST outward supplies', 0, 0, 0, 0));
  rows.push(r('4(A)(5)', 'ITC available — all other ITC', m.gst_purchases, m.itc_igst, m.itc_cgst, m.itc_sgst, m.itc_eligible > 0 ? 'eligible under the 12% option' : (firm.gst_scheme === 'RCM' || firm.gst_scheme === 'FCM_5') ? 'nil — credit barred under the current scheme' : ''));
  rows.push(r('4(B)(2)', 'ITC reversed — others', 0, 0, 0, 0));
  rows.push(r('4(D)(2)', 'Ineligible ITC — others (not availed, on record)', 0, 0, 0, 0, m.itc_blocked > 0 ? `₹${fix2(m.itc_blocked)} of GST paid on purchases is not claimable under scheme ${firm.gst_scheme}` : ''));
  rows.push(['5', 'Exempt / nil-rated inward supplies (intra-state)', fix2(m.exempt_inward), '', '', '', 'toll charges']);
  rows.push(['5', 'Non-GST inward supplies (intra-state)', fix2(m.non_gst_inward), '', '', '', 'diesel']);
  rows.push(['6.1', 'Tax payable in cash after set-off (Rule 88A)', '', fix2(m.pay_igst), fix2(m.pay_cgst), fix2(m.pay_sgst), `net ₹${fix2(m.net_payable)}`]);
  rows.push(['6.1', 'ITC carried forward', '', fix2(m.carry_igst), fix2(m.carry_cgst), fix2(m.carry_sgst), '']);
  return rows;
}

/** Rows for the ITC register sheet / CSV. */
export function itcRows(list) {
  const rows = [['Period', 'Category', 'Supplier', 'Supplier GSTIN', 'Invoice no', 'Invoice date', 'Description', 'Total', 'Taxable', 'Rate', 'IGST', 'CGST', 'SGST', 'GST', 'GST known', 'Eligibility', 'Reason', 'Status', 'Source']];
  for (const r of list) rows.push([periodLabel(r.period), r.category, r.supplier_name ?? '', r.supplier_gstin ?? '', r.invoice_no ?? '', r.invoice_date ? String(r.invoice_date).slice(0, 10) : '', r.description ?? '', fix2(r.amount_total), r.taxable_value == null ? '' : fix2(r.taxable_value), r.gst_rate == null ? '' : fix2(r.gst_rate), fix2(r.igst), fix2(r.cgst), fix2(r.sgst), fix2(r.gst_amount), r.gst_known ? 'Y' : 'N', r.eligibility, r.eligibility_reason ?? '', r.status, r.source_kind]);
  return rows;
}

export function attentionRows(docs, itc) {
  const rows = [['What', 'Document / entry', 'Party', 'Amount', 'Needs']];
  for (const d of docs) if (d.doc_status === 'ISSUED' && d.needs) rows.push(['Outward document', d.doc_no, d.customer_name ?? '', fix2(d.taxable), d.needs]);
  for (const r of itc) if (['NEEDS_INVOICE', 'NO_GSTIN'].includes(r.eligibility)) rows.push(['Purchase', r.invoice_no ?? r.description ?? r.source_id, r.supplier_name ?? '', fix2(r.amount_total), r.eligibility_reason ?? r.eligibility]);
  return rows;
}

/** An .xlsx buffer from { sheetName: rows[][] }. */
export function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['(empty)']]);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Parse an uploaded GSTR-2B (portal JSON, or CSV/XLSX export) into lines. */
export function parse2b(buf, filename = '') {
  const lines = [];
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (/\.json$/i.test(filename) || text.trim().startsWith('{')) {
    const j = JSON.parse(text);
    const b2b = j?.data?.docdata?.b2b ?? j?.docdata?.b2b ?? j?.b2b ?? [];
    for (const s of b2b) for (const inv of s.inv ?? []) {
      lines.push({ supplier_gstin: s.ctin, supplier_name: s.trdnm ?? s.lgnm ?? null, invoice_no: inv.inum, invoice_date: parseAnyDate(inv.dt ?? inv.idt), invoice_value: n2(inv.val), taxable_value: n2(inv.txval ?? sumItems(inv, 'txval')), igst: n2(inv.igst ?? sumItems(inv, 'iamt')), cgst: n2(inv.cgst ?? sumItems(inv, 'camt')), sgst: n2(inv.sgst ?? sumItems(inv, 'samt')), itc_available: inv.itcavl ? inv.itcavl === 'Y' : null });
    }
    return lines;
  }
  let rows;
  if (/\.xlsx?$/i.test(filename)) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const name = wb.SheetNames.find((n) => /b2b/i.test(n)) ?? wb.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false });
  } else {
    rows = XLSX.utils.sheet_to_json(XLSX.read(text, { type: 'string' }).Sheets.Sheet1, { header: 1, raw: false });
  }
  const hi = rows.findIndex((r) => r.some((c) => /gstin/i.test(String(c ?? ''))) && r.some((c) => /invoice/i.test(String(c ?? ''))));
  if (hi < 0) throw new Error('No header row with GSTIN and Invoice columns found');
  const H = rows[hi].map((c) => String(c ?? '').toLowerCase());
  const col = (...res) => { for (const re of res) { const i = H.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
  const cg = col(/gstin of supplier|supplier gstin|^gstin/), cn = col(/trade|legal name|supplier name/), ci = col(/invoice number|invoice no|inv no/), cd = col(/invoice date/), cv = col(/invoice value/), ct = col(/taxable/), cI = col(/integrated/), cC = col(/central/), cS = col(/state\/ut|state tax/), ca = col(/itc availability|itc available/);
  for (const r of rows.slice(hi + 1)) {
    const g = String(r[cg] ?? '').trim().toUpperCase(); const inv = String(r[ci] ?? '').trim();
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) || !inv) continue;
    lines.push({ supplier_gstin: g, supplier_name: cn >= 0 ? String(r[cn] ?? '') : null, invoice_no: inv, invoice_date: parseAnyDate(r[cd]), invoice_value: n2(r[cv]), taxable_value: n2(r[ct]), igst: n2(r[cI]), cgst: n2(r[cC]), sgst: n2(r[cS]), itc_available: ca >= 0 ? /^y/i.test(String(r[ca] ?? '')) : null });
  }
  return lines;
}
const sumItems = (inv, k) => (inv.items ?? inv.itms ?? []).reduce((s, it) => s + n2(it[k] ?? it.itm_det?.[k]), 0);
export function parseAnyDate(v) {
  if (!v) return null; const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/); if (m) { const mi = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()); if (mi >= 0) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(mi + 1)}-${pad(m[1])}`; }
  return null;
}
