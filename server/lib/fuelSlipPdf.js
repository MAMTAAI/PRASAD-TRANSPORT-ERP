// server/lib/fuelSlipPdf.js
// ═══════════════════════════════════════════════════════════════════════════
// THE FUEL SLIP THE PUMP FILES — A5, colour, one slip per pump per issue.
//
// Owner, 6-Sep-2026: "company wise and pump wise, HSD + cash + mobil, chhota
// slip, colour print". So:
//   · A5 (half of A4). A pump spikes these on a hook; A4 was a whole sheet for
//     six lines of content.
//   · Colour, and the colour MEANS something: each operating company gets its
//     own band, so a pump serving two of our firms can tell at a glance which
//     one authorised the issue and which one it bills.
//   · Three line kinds on one slip — HSD, MOBIL, and cash handed over — because
//     a driver takes diesel and engine oil in one stop and the pump writes one
//     entry in its book.
//
// EVERY FIGURE COMES FROM THE RECORD. Where a value is missing the field prints
// "-", never a plausible number: this document goes to a third party who bills
// us from it, so an invented figure is worse than a blank one.
//
// NOTE ON MOBIL: production has never stored it. `fuel_entries.fuel_type` holds
// only FIXED / HSD / ADVANCE today, so until the entry screen offers MOBIL the
// line simply does not appear. The slip is ready for it; the capture is not.
//
// Encoding, inherited from lrPdf/statementPdf: WinAnsi standard fonts cannot
// encode '₹' and a missing glyph THROWS at draw time, halfway down the page.
// Amounts are "Rs 1,234.00" and every string reaching drawText goes through
// ascii().
// ═══════════════════════════════════════════════════════════════════════════
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const A5 = [419.53, 595.28];
const M = 26;

const INK = rgb(0.09, 0.11, 0.15);
const MUT = rgb(0.45, 0.49, 0.56);
const LINE = rgb(0.80, 0.83, 0.87);
const SOFT = rgb(0.96, 0.97, 0.98);
const WHITE = rgb(1, 1, 1);
const CASH = rgb(0.72, 0.35, 0.02);

/** One accent per operating company, so a pump serving two of our firms can
 *  tell them apart across the counter without reading the name. */
const ACCENTS = {
  'PRASAD TRANSPORT': rgb(0.05, 0.42, 0.35),
  'JAISWAL ENTERPRISE': rgb(0.10, 0.31, 0.60),
  'GAUTAM PRASAD': rgb(0.44, 0.19, 0.55),
};
const accentFor = (name) => {
  const n = String(name ?? '').toUpperCase();
  for (const [k, v] of Object.entries(ACCENTS)) if (n.includes(k)) return v;
  return rgb(0.20, 0.25, 0.32);
};

const ascii = (v) => String(v ?? '')
  .replace(/[₹]/g, 'Rs ')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E]/g, '');

const val = (v) => { const s = ascii(v).trim(); return s || '-'; };

const inr = (n) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '-';
  return 'Rs ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const day = (d) => {
  if (!d) return '-';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '-'
    : t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/** pdf-lib neither wraps nor clips: a long pump name would be drawn straight
 *  over whatever sits beside it. */
const fit = (s, font, size, width) => {
  let t = ascii(s);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
};

/**
 * Normalise whatever the caller has into the slip's line items.
 * Accepts either an explicit `items` array or a single fuel_entries-shaped row.
 */
function linesOf(slip) {
  if (Array.isArray(slip.items) && slip.items.length) {
    return slip.items.map((i) => ({
      label: val(i.label ?? i.fuel_type ?? 'HSD'),
      qty: Number(i.qty ?? i.liters ?? 0),
      unit: i.unit ?? 'L',
      rate: Number(i.rate ?? 0),
      amount: Number(i.amount ?? 0),
    }));
  }
  const litres = Number(slip.liters ?? 0);
  if (!litres && !Number(slip.amount ?? 0)) return [];
  return [{
    label: val(slip.fuel_type || 'HSD'),
    qty: litres, unit: 'L',
    rate: Number(slip.rate ?? 0), amount: Number(slip.amount ?? 0),
  }];
}

/**
 * @param {object} slip   fuel_entries row, or { items: [...] } for a multi-item
 *                        issue: memo_no, entry_date, vehicle_no, driver_name,
 *                        route_name, trip_code, vendor_name, cash_given_to_pump
 * @param {object|null} company  { company_name, address, city, state, pincode,
 *                                 gstin, pan_no, phone }
 * @returns {Promise<Uint8Array>}
 */
export async function buildFuelSlipPdf({ slip = {}, company = null, issuedBy = '' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(A5);

  const W = A5[0];
  const CW = W - 2 * M;
  const firm = ascii(company?.company_name || 'PRASAD TRANSPORT');
  const ACC = accentFor(firm);
  const slipNo = val(slip.memo_no || String(slip.slip_id ?? slip.id ?? '').slice(0, 8));

  doc.setTitle(`Fuel Slip ${slipNo}`);
  doc.setCreator('PRASAD TRANSPORT ERP');
  doc.setSubject(`Issue authorisation for ${val(slip.vehicle_no)}`);

  const at = (s, x, y, size = 8.5, f = font, color = INK) =>
    page.drawText(ascii(s), { x, y, size, font: f, color });
  const right = (s, xr, y, size = 8.5, f = font, color = INK) => {
    const t = ascii(s);
    page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };
  const rule = (y, color = LINE, thickness = 0.6) =>
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness, color });

  // ── Coloured company band ────────────────────────────────────────────────
  const BAND_H = 52;
  page.drawRectangle({ x: 0, y: A5[1] - BAND_H, width: W, height: BAND_H, color: ACC });
  at(fit(firm, bold, 13, CW - 120), M, A5[1] - 22, 13, bold, WHITE);
  const addr = [company?.city, company?.state].filter(Boolean).join(', ');
  if (addr) at(fit(addr, font, 7, CW - 130), M, A5[1] - 33, 7, font, WHITE);
  if (company?.gstin) at(`GSTIN ${company.gstin}`, M, A5[1] - 43, 7, font, WHITE);
  right('FUEL SLIP', W - M, A5[1] - 22, 13, bold, WHITE);
  right(slipNo, W - M, A5[1] - 34, 9, bold, WHITE);
  right(day(slip.entry_date || slip.date), W - M, A5[1] - 44, 7.5, font, WHITE);

  let y = A5[1] - BAND_H - 20;

  // ── Pump ─────────────────────────────────────────────────────────────────
  at('TO (PUMP)', M, y, 6.5, bold, MUT);
  right('VEHICLE', W - M, y, 6.5, bold, MUT);
  y -= 13;
  at(fit(slip.vendor_name, bold, 12, CW - 130), M, y, 12, bold, ACC);
  right(val(slip.vehicle_no), W - M, y, 12, bold);
  y -= 18;

  // ── Driver / trip ────────────────────────────────────────────────────────
  page.drawRectangle({ x: M, y: y - 26, width: CW, height: 32, color: SOFT });
  at('DRIVER', M + 8, y, 6.5, bold, MUT);
  at('TRIP', M + 175, y, 6.5, bold, MUT);
  y -= 12;
  at(fit(slip.driver_name, bold, 10, 155), M + 8, y, 10, bold);
  at(fit(slip.trip_code, bold, 10, 150), M + 175, y, 10, bold);
  y -= 12;
  at(fit(slip.route_name, font, 7.5, CW - 16), M + 8, y, 7.5, font, MUT);
  y -= 24;

  // ── Items: HSD / MOBIL / anything else issued ────────────────────────────
  const items = linesOf(slip);
  // A slip is PRICED only once the pump's bill has given us a rate. Until then
  // it authorises quantities and says so, rather than printing a number the
  // pump could bill us from.
  const priced = items.some((i) => Number(i.rate) > 0);

  const cQty = M + 168, cRate = M + 252, cAmt = W - M;
  at('ISSUE AGAINST THIS SLIP', M, y, 6.5, bold, MUT); y -= 11;
  page.drawRectangle({ x: M, y: y - 4, width: CW, height: 15, color: ACC });
  at('PARTICULARS', M + 6, y, 6.5, bold, WHITE);
  right('QTY', cQty, y, 6.5, bold, WHITE);
  if (priced) {
    right('RATE', cRate, y, 6.5, bold, WHITE);
    right('VALUE', cAmt - 6, y, 6.5, bold, WHITE);
  } else {
    right('VALUE', cAmt - 6, y, 6.5, bold, WHITE);
  }
  y -= 20;
  let goods = 0;
  if (!items.length) {
    at('- no quantity recorded on this slip -', M + 6, y, 9, font, MUT);
    y -= 16;
  }
  for (const it of items) {
    goods += it.amount;
    at(it.label, M + 6, y, 10, bold);
    right(it.qty ? `${it.qty.toLocaleString('en-IN')} ${it.unit}` : '-', cQty, y, 9.5);
    // Owner, 6-Sep-2026: the pump's rate changes constantly and is not known
    // when the slip is issued, so the slip does not claim one. It authorises a
    // QUANTITY; the money is settled from the pump's own bill. Printing a
    // guessed rate here would hand a third party a figure to bill us from.
    if (priced) {
      right(inr(it.rate).replace('Rs ', ''), cRate, y, 9.5);
      right(inr(it.amount), cAmt - 6, y, 9.5, bold);
    } else {
      right('as per bill', cAmt - 6, y, 8.5, font, MUT);
    }
    y -= 15;
    rule(y + 5, LINE, 0.4);
  }

  // ── Cash, deliberately set apart from goods ──────────────────────────────
  const cash = Number(slip.cash_given_to_pump ?? 0);
  if (cash > 0) {
    y -= 2;
    at('CASH handed to driver at pump', M + 6, y, 9.5, bold, CASH);
    right(inr(cash), cAmt - 6, y, 9.5, bold, CASH);
    y -= 15;
    rule(y + 5, LINE, 0.4);
  }

  // ── Total ────────────────────────────────────────────────────────────────
  // With no rate there is no fuel value, so the only number we can honestly
  // total is the cash actually handed over. Printing "Rs 0.00" against 150 L of
  // diesel would read as free fuel.
  y -= 6;
  page.drawRectangle({ x: M, y: y - 6, width: CW, height: 22, color: ACC });
  if (priced) {
    at('TOTAL', M + 6, y, 10, bold, WHITE);
    right(inr(goods + cash), cAmt - 6, y, 12, bold, WHITE);
  } else if (cash > 0) {
    at('CASH TOTAL  (fuel billed separately)', M + 6, y, 9, bold, WHITE);
    right(inr(cash), cAmt - 6, y, 12, bold, WHITE);
  } else {
    at('QUANTITY AUTHORISED  -  value as per pump bill', M + 6, y, 9, bold, WHITE);
  }
  y -= 28;

  // ── The instruction that makes it a control document ─────────────────────
  at('Issue only what is listed above. Reply on WhatsApp before issuing if anything', M, y, 7.5, font, INK); y -= 10;
  at('does not match - do not issue and correct it later.', M, y, 7.5, font, INK); y -= 10;
  at(`Billed under slip ${slipNo} on our fortnightly reconciliation.`, M, y, 7.5, font, MUT);

  // ── Signatures, anchored to the foot ─────────────────────────────────────
  // Anchored rather than flowed: the number of item lines varies per slip, so a
  // flowed block would sit at a different height on every copy the pump files.
  const sigY = 76;
  const sigW = (CW - 24) / 2;
  page.drawLine({ start: { x: M, y: sigY }, end: { x: M + sigW, y: sigY }, thickness: 0.6, color: LINE });
  page.drawLine({ start: { x: M + sigW + 24, y: sigY }, end: { x: W - M, y: sigY }, thickness: 0.6, color: LINE });
  at('Driver signature', M, sigY - 10, 7, font, MUT);
  at('Pump stamp / attendant', M + sigW + 24, sigY - 10, 7, font, MUT);

  at(`Issued by ${val(issuedBy || 'Prasad Transport ERP')} - ${day(new Date())}`, M, 34, 6.5, font, MUT);
  right('Computer generated', W - M, 34, 6.5, font, MUT);
  page.drawRectangle({ x: 0, y: 0, width: W, height: 6, color: ACC });

  return doc.save();
}

export default buildFuelSlipPdf;
