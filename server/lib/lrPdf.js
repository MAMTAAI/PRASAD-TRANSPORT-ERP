// server/lib/lrPdf.js
// ═══════════════════════════════════════════════════════════════════════════
// LORRY RECEIPT (LR) — PROVISIONAL FORMAT
//
// READ THIS BEFORE CHANGING THE LAYOUT. The owner is sending the firm's real
// printed LR format; it had not arrived when SEND LR COPY was wired up on
// 2-Sep-2026. The instruction was explicit: build a stub so the button works,
// the exact printing layout comes later. So this file is a placeholder with a
// deliberate, visible watermark — it must never be mistaken for the document
// of record, and the office must not be able to hand one to a consignee
// believing it is the real thing.
//
// WHAT IS NOT A PLACEHOLDER: every value on the page. The consignor, consignee,
// lorry, driver, product, quantity and dates are read from the trip row. A stub
// layout carrying invented figures would be far worse than no button — it is
// the exact failure the dashboard's honesty contract exists to prevent. Where
// the trip record is blank the field prints "-", not a plausible value.
//
// pdf-lib, not a headless browser: it is already a dependency (statementPdf.js
// authors account statements with it) and the box runs Chrome for WhatsApp on
// 2 GB of RAM already.
//
// Encoding note, inherited from statementPdf: the WinAnsi standard fonts cannot
// encode '₹', and a missing glyph THROWS at draw time. Amounts are "Rs 1,234.00"
// and every string that reaches drawText goes through ascii().
// ═══════════════════════════════════════════════════════════════════════════
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const A4 = [595.28, 841.89];
const M = 36;
const INK = rgb(0.09, 0.11, 0.15);
const MUT = rgb(0.42, 0.47, 0.55);
const LINE = rgb(0.78, 0.81, 0.85);
const BAND = rgb(0.94, 0.95, 0.97);
const ACC = rgb(0.72, 0.45, 0);
const WARN = rgb(0.78, 0.25, 0.1);

/** WinAnsi-safe. Anything the standard fonts cannot draw becomes a plain
 *  equivalent rather than throwing halfway down the page — Assamese and Hindi
 *  place names DO appear in these records. */
const ascii = (v) => String(v ?? '')
  .replace(/[₹]/g, 'Rs ')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E]/g, '');

/** A value the trip record does not hold. Never guessed, never blank-looking. */
const val = (v) => {
  const s = ascii(v).trim();
  return s || '-';
};

const inr = (n) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return '-';
  return 'Rs ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** pdf-lib does not wrap or clip: a long consignee name is drawn straight over
 *  the box border and out through the page edge. Customer names in this data
 *  run to 40+ characters, so every value that sits in a fixed-width cell goes
 *  through here. Truncation is visible ('..'), never silent. */
const fit = (v, font, size, maxWidth) => {
  let s = ascii(v);
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(s + '..', size) > maxWidth) s = s.slice(0, -1);
  return s + '..';
};

const dmy = (d) => {
  if (!d) return '-';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '-' : t.toLocaleDateString('en-GB');
};

/**
 * Build a provisional LR.
 *
 * @param {object} spec
 *   trip     — the trips row (already fetched and scoped by the caller)
 *   company  — the operating company row, or null
 *   lrNo     — what to print as the LR number
 *   issuedBy — the staff name generating it, printed in the footer
 * @returns {Promise<Uint8Array>}
 */
export async function buildLrPdf({ trip = {}, company = null, lrNo = '', issuedBy = '' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(A4);
  const firm = ascii(company?.company_name || trip.operating_company || 'PRASAD TRANSPORT');

  doc.setTitle(`Lorry Receipt ${ascii(lrNo)} (provisional format)`);
  doc.setCreator('PRASAD TRANSPORT ERP');
  doc.setSubject('PROVISIONAL LR — final printing layout pending from the office');

  let y = A4[1] - M;
  const W = A4[0] - 2 * M;
  const text = (s, x, size = 9, f = font, color = INK) =>
    page.drawText(ascii(s), { x, y, size, font: f, color });
  const at = (s, x, yy, size = 9, f = font, color = INK) =>
    page.drawText(ascii(s), { x, y: yy, size, font: f, color });
  const rule = (yy, color = LINE, thickness = 0.7) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: A4[0] - M, y: yy }, thickness, color });

  // ── Letterhead ───────────────────────────────────────────────────────────
  text(firm, M, 17, bold, ACC);
  y -= 15;
  const addr = [company?.address, company?.city, company?.state, company?.pincode]
    .filter(Boolean).join(', ');
  if (addr) { text(addr, M, 8.5, font, MUT); y -= 10; }
  const ids = [
    company?.gstin ? `GSTIN: ${company.gstin}` : null,
    company?.pan_no ? `PAN: ${company.pan_no}` : null,
    company?.phone ? `Ph: ${company.phone}` : null,
  ].filter(Boolean).join('   ');
  if (ids) { text(ids, M, 8.5, font, MUT); y -= 10; }

  y -= 4;
  at('LORRY RECEIPT', M, y, 13, bold);
  const rightTop = `LR No: ${val(lrNo)}`;
  at(rightTop, A4[0] - M - bold.widthOfTextAtSize(ascii(rightTop), 10), y, 10, bold);
  y -= 12;
  const dline = `Date: ${dmy(trip.loading_date || trip.created_at)}`;
  at(dline, A4[0] - M - font.widthOfTextAtSize(ascii(dline), 9), y, 9, font, MUT);
  y -= 8;
  rule(y, INK, 1.1);
  y -= 6;

  // ── THE BANNER. Not decoration — the whole reason this document is
  //    allowed to exist before the format arrives. ─────────────────────────
  page.drawRectangle({ x: M, y: y - 26, width: W, height: 26,
    color: rgb(0.99, 0.94, 0.9), borderColor: WARN, borderWidth: 0.9 });
  at('PROVISIONAL FORMAT - NOT THE FIRM\'S PRINTED LR', M + 8, y - 11, 9.5, bold, WARN);
  at('The office\'s approved LR layout is awaited. Every particular below is read from the ERP trip record - only the layout is provisional.',
     M + 8, y - 21, 7.2, font, MUT);
  y -= 34;

  // ── Parties ──────────────────────────────────────────────────────────────
  const colW = (W - 10) / 2;
  const boxTop = y;
  const boxH = 74;
  const partyBox = (x, heading, lines) => {
    page.drawRectangle({ x, y: boxTop - boxH, width: colW, height: boxH,
      borderColor: LINE, borderWidth: 0.7 });
    page.drawRectangle({ x, y: boxTop - 15, width: colW, height: 15, color: BAND });
    at(heading, x + 6, boxTop - 11, 8, bold, MUT);
    let yy = boxTop - 28;
    for (const [label, value] of lines) {
      at(label, x + 6, yy, 7.5, font, MUT);
      at(fit(val(value), bold, 8.5, colW - 68), x + 62, yy, 8.5, bold);
      yy -= 12;
    }
  };
  partyBox(M, 'CONSIGNOR (FROM)', [
    ['Loading pt', trip.loading_point],
    ['Customer', trip.customer_name],
    ['Challan No', trip.challan_no],
    ['Assessee', trip.registered_assessee],
  ]);
  partyBox(M + colW + 10, 'CONSIGNEE (TO)', [
    ['Consignee', trip.consignee_name],
    ['Unloading', trip.unloading_location],
    ['Trip Code', trip.trip_code],
    ['Status', trip.status],
  ]);
  y = boxTop - boxH - 14;

  // ── Vehicle & driver ─────────────────────────────────────────────────────
  const strip = (heading, pairs) => {
    page.drawRectangle({ x: M, y: y - 15, width: W, height: 15, color: BAND });
    at(heading, M + 6, y - 11, 8, bold, MUT);
    y -= 15;
    const cw = W / pairs.length;
    page.drawRectangle({ x: M, y: y - 26, width: W, height: 26, borderColor: LINE, borderWidth: 0.7 });
    pairs.forEach(([label, value], i) => {
      at(label, M + 6 + i * cw, y - 10, 7.5, font, MUT);
      at(fit(val(value), bold, 9, cw - 12), M + 6 + i * cw, y - 21, 9, bold);
    });
    y -= 34;
  };
  strip('VEHICLE & DRIVER', [
    ['Lorry No', trip.vehicle_no],
    ['Driver', trip.driver_name],
    ['Driver Mobile', trip.driver_mobile],
    ['Loading Date', dmy(trip.loading_date)],
  ]);

  // ── Goods ────────────────────────────────────────────────────────────────
  const cols = [
    { label: 'DESCRIPTION OF GOODS', w: W * 0.44, get: () => val(trip.product_type) },
    { label: 'QUANTITY (KL)', w: W * 0.16, get: () => (trip.loaded_qty === null || trip.loaded_qty === undefined ? '-' : Number(trip.loaded_qty).toFixed(3)), align: 'right' },
    { label: 'RTKM', w: W * 0.14, get: () => (trip.rtkm === null || trip.rtkm === undefined ? '-' : Number(trip.rtkm).toFixed(2)), align: 'right' },
    { label: 'FREIGHT', w: W * 0.26, get: () => inr(trip.freight_amount), align: 'right' },
  ];
  page.drawRectangle({ x: M, y: y - 16, width: W, height: 16, color: BAND });
  let x = M + 6;
  for (const c of cols) {
    const lw = bold.widthOfTextAtSize(ascii(c.label), 7.5);
    at(c.label, c.align === 'right' ? x + c.w - 12 - lw : x, y - 11, 7.5, bold, MUT);
    x += c.w;
  }
  y -= 16;
  page.drawRectangle({ x: M, y: y - 22, width: W, height: 22, borderColor: LINE, borderWidth: 0.7 });
  x = M + 6;
  for (const c of cols) {
    const v = c.get();
    const vw = font.widthOfTextAtSize(ascii(v), 9.5);
    at(c.align === 'right' ? v : fit(v, font, 9.5, c.w - 12),
       c.align === 'right' ? x + c.w - 12 - vw : x, y - 15, 9.5, font);
    x += c.w;
  }
  y -= 32;

  // Freight terms are NOT on the trip record — "to pay" vs "paid" lives on the
  // billing side and guessing it on a document a consignee reads is how a
  // lorry gets held at a gate. Stated as unrecorded rather than assumed.
  at('Freight terms: as per the running contract between the parties. Not recorded on this trip.',
     M, y, 7.5, font, MUT);
  y -= 18;

  // ── Signature blocks ─────────────────────────────────────────────────────
  const sigW = (W - 20) / 3;
  ['Consignor / Loading In-charge', 'Driver', 'For ' + firm].forEach((label, i) => {
    const sx = M + i * (sigW + 10);
    page.drawLine({ start: { x: sx, y: y - 34 }, end: { x: sx + sigW, y: y - 34 }, thickness: 0.7, color: LINE });
    at(label, sx, y - 44, 7.5, font, MUT);
  });
  y -= 58;

  // ── Footer ───────────────────────────────────────────────────────────────
  rule(y);
  y -= 11;
  at(`Generated from the PRASAD TRANSPORT ERP on ${new Date().toLocaleString('en-GB')}`
     + (issuedBy ? ` by ${issuedBy}` : ''), M, y, 7, font, MUT);
  y -= 9;
  // Two lines, not one: at 7pt this sentence is wider than the 523pt text
  // column, and pdf-lib does not wrap — it draws straight off the right edge.
  at('Provisional layout, pending the office\'s approved LR format. Particulars are read from the trip record;', M, y, 7, font, MUT);
  y -= 8;
  at('a blank is a field the record does not hold, and has not been filled in.', M, y, 7, font, MUT);

  return doc.save();
}
