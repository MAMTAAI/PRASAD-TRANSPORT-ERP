// server/lib/payslipPdf.js
// ─────────────────────────────────────────────────────────────────────────────
// One A4 settlement slip per person per month, from a payroll_slips row.
// Trip-basis drivers get the zero-balance ledger (every trip, its korki, the
// cash paid, opening → closing); salaried drivers and staff get the payroll
// line. WinAnsi fonts cannot draw '₹', so amounts are printed as "Rs.".
// ─────────────────────────────────────────────────────────────────────────────
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const money = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The standard fonts know WinAnsi only: arrows, rupee signs and odd dashes become ASCII, anything else a '?'.
const SAFE = { '→': '->', '←': '<-', '₹': 'Rs.', '–': '-', '—': '-', '•': '*', '·': '.', '…': '...', '‘': "'", '’': "'", '“': '"', '”': '"' };
const safe = (v) => String(v ?? '').replace(/[^ -~ -ÿ]/g, (ch) => SAFE[ch] ?? '?');
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const periodLabel = (p) => `${MON[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const KIND_TITLE = { TRIP: 'Trip Basis · Monthly Ledger Slip', MONTHLY: 'Fixed Salary · Monthly Settlement Slip', STAFF: 'Salary / Remuneration Slip' };

/**
 * @param {object} slip   payroll_slips row (lines parsed)
 * @param {object} firm   { company_name, address, city, state, gstin, pan_no }
 * @returns {Promise<Uint8Array>}
 */
export async function payslipPdf(slip, firm) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]);
  const W = 595.28; const M = 40; let y = 800;
  const ink = rgb(0.08, 0.1, 0.16); const dim = rgb(0.4, 0.44, 0.55); const line = rgb(0.8, 0.83, 0.9); const good = rgb(0.05, 0.5, 0.35); const warn = rgb(0.7, 0.35, 0);
  const text = (s, x, yy, size = 10, f = font, color = ink) => page.drawText(safe(s), { x, y: yy, size, font: f, color });
  const right = (s, xr, yy, size = 10, f = font, color = ink) => { const t = safe(s); const w = f.widthOfTextAtSize(t, size); page.drawText(t, { x: xr - w, y: yy, size, font: f, color }); };
  const hr = (yy, c = line) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.6, color: c });
  const newPage = () => { page = pdf.addPage([595.28, 841.89]); y = 800; };

  text(firm.company_name ?? '', M, y, 15, bold); y -= 16;
  text([firm.address, firm.city, firm.state].filter(Boolean).join(', '), M, y, 8.5, font, dim); y -= 12;
  text(`PAN ${firm.pan_no ?? '—'}${firm.gstin ? ` · GSTIN ${firm.gstin}` : ''}`, M, y, 8.5, font, dim);
  right(KIND_TITLE[slip.kind] ?? 'Settlement Slip', W - M, y + 28, 11, bold);
  right(periodLabel(slip.period), W - M, y + 14, 10, font, dim);
  right(`Generated ${day(slip.generated_at ?? new Date())}`, W - M, y, 8.5, font, dim);
  y -= 18; hr(y); y -= 20;
  text(slip.person_name, M, y, 14, bold); right(slip.person_kind, W - M, y, 9, font, dim); y -= 24;

  const kv = (rows) => { for (const [k, v, c] of rows) { text(k, M, y, 9.5, font, dim); right(v, W - M, y, 10, bold, c ?? ink); y -= 15; } };
  if (slip.kind === 'TRIP') {
    kv([['Opening balance (driver owed us at month start)', money(slip.opening), Number(slip.opening) > 0 ? warn : ink],
      ['Earned this month (trip pay credited)', money(slip.earned), good],
      ['Advances / cash given this month', money(slip.advances)],
      ['Shortage & challans charged (korki)', money(slip.korki)],
      ['Paid to driver this month', money(slip.paid)],
      ['Closing balance', money(slip.closing), Number(slip.closing) > 0 ? warn : Number(slip.closing) < 0 ? good : ink]]);
    y -= 4; text(Number(slip.closing) === 0 ? 'ZERO BALANCE — every trip of the month settled and paid.' : Number(slip.closing) > 0 ? 'Driver owes the company the closing balance (advances not yet recovered).' : 'The company owes the driver the closing balance (earned, not yet paid).', M, y, 9, bold, Number(slip.closing) === 0 ? good : warn); y -= 22;
    hr(y); y -= 14;
    const cols = [[M, 'Trip'], [M + 92, 'Lorry'], [M + 168, 'Completed'], [M + 238, 'Basis']];
    const rcols = [[W - M - 220, 'Earning'], [W - M - 150, 'Korki'], [W - M - 80, 'Net'], [W - M, 'Status']];
    for (const [x, l] of cols) text(l, x, y, 8, bold, dim); for (const [x, l] of rcols) right(l, x, y, 8, bold, dim); y -= 12; hr(y, line); y -= 12;
    const lines = Array.isArray(slip.lines) ? slip.lines : [];
    if (!lines.length) { text('No completed trips this month.', M, y, 9, font, dim); y -= 14; }
    for (const l of lines) {
      if (y < 90) { newPage(); }
      text(l.trip ?? '', M, y, 8.5); text((l.vehicle ?? '').replace(/\s+/g, ' '), M + 92, y, 8.5); text(day(l.completed), M + 168, y, 8.5); text(`${l.basis ?? ''}${l.ownership === 'ATTACHED' ? ' (attached → owner)' : ''}`, M + 238, y, 7.5, font, dim);
      right(money(l.earning), W - M - 220, y, 8.5); right(money(Number(l.advances || 0) + Number(l.shortage || 0) + Number(l.challans || 0)), W - M - 150, y, 8.5); right(money(l.net), W - M - 80, y, 8.5, bold);
      right(l.status === 'PAID' ? `PAID ${day(l.paid_on)}` : l.status === 'BLOCKED' ? 'BLOCKED' : l.status, W - M, y, 8, font, l.status === 'PAID' ? good : l.status === 'BLOCKED' ? warn : dim);
      y -= 12;
      if (l.block) { text(`   ${l.block}`, M + 238, y, 7, font, warn); y -= 10; }
    }
  } else {
    const l = (Array.isArray(slip.lines) ? slip.lines[0] : null) ?? {};
    kv([[slip.kind === 'STAFF' ? 'Gross for the month' : 'Monthly salary', money(slip.earned)],
      ['Advances recovered', money(slip.advances)],
      ['Other deductions (shortage, challans, other)', money(Math.max(0, Number(slip.korki) - Number(slip.advances)))],
      ['Net payable', money(l.net ?? Number(slip.earned) - Number(slip.korki)), good],
      ['Status', l.status === 'PAID' ? `PAID on ${day(l.paid_on)}` : l.status === 'POSTED' ? 'APPROVED — awaiting disbursal' : l.status ?? 'DRAFT', l.status === 'PAID' ? good : warn]]);
    if (slip.kind === 'MONTHLY') { y -= 6; kv([['Opening khata balance', money(slip.opening)], ['Closing khata balance', money(slip.closing), Number(slip.closing) > 0 ? warn : ink]]); }
  }
  y = Math.min(y, 70);
  hr(60); text('Computed by the ERP from trips, advances and vouchers; nothing typed. Queries: Accounts desk.', M, 48, 7.5, font, dim);
  right(`${slip.person_name} · ${slip.period}`, W - M, 48, 7.5, font, dim);
  return pdf.save();
}
