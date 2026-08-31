// ═══════════════════════════════════════════════════════════════════════════
// statementPdf.js — server-side account statement PDFs (pdf-lib)
//
// The first server-authored PDF in the system. Every other "PDF" is a
// window.print() popup in the browser, which cannot be mailed, WhatsApp'd or
// generated for a party that is not sitting at the screen. This builds the
// bytes on the server, so a portal user's "Download statement" and the office's
// master export produce the same document from the same scoped query.
//
// Deliberately dependency-light: pdf-lib is already in package.json (the
// client uses it to re-compress uploads) and it authors PDFs without a
// headless browser — which matters on a 2 GB box that already runs Chrome for
// WhatsApp.
//
// Encoding note: the WinAnsi standard fonts cannot encode '₹', so amounts are
// written "Rs 12,345.00". A missing glyph throws at draw time — this is not a
// cosmetic choice.
// ═══════════════════════════════════════════════════════════════════════════
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const A4 = [595.28, 841.89];
const M = 40;                       // page margin
const INK = rgb(0.09, 0.11, 0.15);
const MUT = rgb(0.42, 0.47, 0.55);
const LINE = rgb(0.85, 0.87, 0.9);
const BAND = rgb(0.945, 0.955, 0.97);
const ACC = rgb(0.72, 0.45, 0);     // the letterhead amber

export const inr = (n) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '-';
  return 'Rs ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Financial-year window: Apr 1 → Mar 31, labelled "FY 2026-27". */
export function fyWindow(from, to) {
  const today = new Date();
  if (!from) {
    const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    from = `${y}-04-01`;
  }
  if (!to) to = today.toISOString().slice(0, 10);
  const fyStart = Number(from.slice(0, 4));
  const label = `${from} to ${to} (FY ${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')})`;
  return { from, to, label };
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * Build a statement PDF.
 * @param {object} spec
 *   firm      — letterhead line ("PRASAD TRANSPORT" / company name)
 *   title     — document title ("Account Statement")
 *   party     — { name, lines: [] } identity block
 *   period    — human period label
 *   sections  — [{ heading, columns: [{key,label,w,align?}], rows: [{}...],
 *                 note? }]
 *   summary   — [[label, value], ...] closing box
 * @returns {Promise<Uint8Array>}
 */
export async function buildStatementPdf(spec) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`${spec.title} — ${spec.party?.name ?? ''}`);
  doc.setCreator('PRASAD TRANSPORT ERP');

  let page, y;
  const pages = [];
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    y = A4[1] - M;
  };
  const text = (s, x, size = 9, f = font, color = INK) =>
    page.drawText(String(s), { x, y, size, font: f, color });
  const rule = (yy, color = LINE, thickness = 0.7) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: A4[0] - M, y: yy }, thickness, color });

  const header = (first) => {
    if (first) {
      text(spec.firm ?? 'PRASAD TRANSPORT', M, 16, bold, ACC); y -= 18;
      text(spec.title, M, 11, bold); y -= 14;
      text(`Period: ${spec.period}`, M, 9, font, MUT); y -= 6;
      rule(y); y -= 16;
      if (spec.party) {
        text(spec.party.name, M, 11, bold); y -= 13;
        for (const l of spec.party.lines ?? []) { text(l, M, 8.5, font, MUT); y -= 11; }
        y -= 6;
      }
    } else {
      text(`${spec.firm ?? 'PRASAD TRANSPORT'} — ${spec.title} (contd.)`, M, 9, bold, MUT);
      y -= 16;
    }
  };

  const tableHead = (cols) => {
    page.drawRectangle({ x: M, y: y - 4, width: A4[0] - 2 * M, height: 15, color: BAND });
    let x = M + 4;
    for (const c of cols) {
      const label = c.label;
      const lx = c.align === 'right' ? x + c.w - 6 - bold.widthOfTextAtSize(label, 8) : x;
      page.drawText(label, { x: lx, y, size: 8, font: bold, color: MUT });
      x += c.w;
    }
    y -= 17;
  };

  newPage();
  header(true);

  for (const sec of spec.sections ?? []) {
    if (y < M + 90) { newPage(); header(false); }
    if (sec.heading) { text(sec.heading, M, 10.5, bold, ACC); y -= 15; }
    tableHead(sec.columns);
    for (const row of sec.rows) {
      if (y < M + 40) { newPage(); header(false); tableHead(sec.columns); }
      let x = M + 4;
      for (const c of sec.columns) {
        const raw = row[c.key];
        const s = clip(raw, c.max ?? 40);
        const lx = c.align === 'right' ? x + c.w - 6 - font.widthOfTextAtSize(s, 8) : x;
        page.drawText(s, { x: lx, y, size: 8, font: row._bold ? bold : font, color: INK });
        x += c.w;
      }
      y -= 12;
      rule(y + 3, LINE, 0.3);
    }
    if (!sec.rows.length) { text('— no entries in this period —', M + 4, 8.5, font, MUT); y -= 14; }
    if (sec.note) { y -= 2; text(sec.note, M, 7.5, font, MUT); y -= 12; }
    y -= 10;
  }

  if (spec.summary?.length) {
    if (y < M + 30 + spec.summary.length * 14) { newPage(); header(false); }
    const boxH = spec.summary.length * 14 + 14;
    page.drawRectangle({ x: M, y: y - boxH + 10, width: A4[0] - 2 * M, height: boxH, color: BAND });
    y -= 4;
    for (const [label, value] of spec.summary) {
      page.drawText(String(label), { x: M + 8, y, size: 9, font: bold, color: INK });
      const v = String(value);
      page.drawText(v, { x: A4[0] - M - 8 - bold.widthOfTextAtSize(v, 9), y, size: 9, font: bold, color: INK });
      y -= 14;
    }
  }

  // Footer on every page — who made it, when, and page numbering.
  const stamp = `System generated · ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · PRASAD TRANSPORT ERP`;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M - 10 }, end: { x: A4[0] - M, y: M - 10 }, thickness: 0.5, color: LINE });
    p.drawText(stamp, { x: M, y: M - 22, size: 7, font, color: MUT });
    const pn = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pn, { x: A4[0] - M - font.widthOfTextAtSize(pn, 7), y: M - 22, size: 7, font, color: MUT });
  });

  return doc.save();
}
