// ═════════════════════════════════════════════════════════════════════════════
// lockerPdf.js — the Digital Locker's "PDF" of an approved driver paper
//
// Owner, 2026-09-03: "If a document is already approved by the Admin, the
// driver must have a button to View and Download as PDF directly from their
// app." The paper the office approved is a photo; this wraps that photo in a
// one-page A4 PDF with the company name, the driver, the paper's title, the
// approval date and validity, and a footer stamp — so a checkpost sees an
// office-issued sheet, not a loose gallery image.
//
// pdf-lib only (same as statementPdf.js): no headless browser on the box.
// JPEG and PNG are embedded natively; anything else (a PDF upload, HEIC) is
// refused with a clear error rather than a blank page.
// ═════════════════════════════════════════════════════════════════════════════
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openStream } from './storage.js';

const A4 = [595.28, 841.89];
const M = 36;
const INK = rgb(0.09, 0.11, 0.15);
const MUT = rgb(0.42, 0.47, 0.55);
const GREEN = rgb(0.09, 0.64, 0.29);
const BAND = rgb(0.945, 0.955, 0.97);

/** Read a vault key or an absolute http(s) URL into a Buffer. */
export async function readImageBytes(ref) {
  const s = String(ref ?? '').trim();
  if (!s) throw Object.assign(new Error('no file on record'), { code: 'NO_FILE' });
  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s);
    if (!res.ok) throw Object.assign(new Error(`file fetch failed (${res.status})`), { code: 'FETCH_FAILED' });
    return Buffer.from(await res.arrayBuffer());
  }
  const key = s.replace(/^\/?api\/v1\/files\//, '').replace(/^\/+/, '');
  const stream = await openStream(key);
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

const isJpg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * spec = { title, driverName, driverMobile, vehicleNo, approvedOn, validTill,
 *          approvedBy, docNumber, imageBytes }
 * Returns Uint8Array of the PDF.
 */
export async function buildLockerPdf(spec) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${spec.title} — ${spec.driverName}`);
  doc.setAuthor('Prasad Transport ERP');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(A4);
  const W = A4[0];
  const text = (s, x, y, size = 10, f = font, color = INK) => page.drawText(String(s ?? ''), { x, y, size, font: f, color });

  // Letterhead band
  page.drawRectangle({ x: 0, y: A4[1] - 74, width: W, height: 74, color: BAND });
  text('PRASAD TRANSPORT', M, A4[1] - 34, 16, bold);
  text('Approved document · Digital Locker', M, A4[1] - 52, 9, font, MUT);
  const right = (s, y, size, f = font, color = MUT) => text(s, W - M - f.widthOfTextAtSize(s, size), y, size, f, color);
  right(`Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, A4[1] - 34, 8);
  right('Verify with the office: this sheet is issued from the ERP', A4[1] - 48, 8);

  // Title + facts
  let y = A4[1] - 74 - 34;
  text(spec.title, M, y, 18, bold);
  y -= 26;
  const kv = [
    ['Driver', `${spec.driverName ?? '-'}${spec.driverMobile ? '  ·  +91 ' + spec.driverMobile : ''}`],
    ...(spec.vehicleNo ? [['Lorry', spec.vehicleNo]] : []),
    ...(spec.docNumber ? [['Number', spec.docNumber]] : []),
    ['Approved by office', `${spec.approvedOn ?? '-'}${spec.approvedBy ? '  ·  ' + spec.approvedBy : ''}`],
    ...(spec.validTill ? [['Valid till', spec.validTill]] : []),
  ];
  for (const [k, v] of kv) {
    text(k.toUpperCase(), M, y, 7.5, bold, MUT);
    text(v, M + 120, y, 10, font, INK);
    y -= 16;
  }

  // The paper itself, scaled to the remaining box
  const bytes = spec.imageBytes;
  const img = isJpg(bytes) ? await doc.embedJpg(bytes) : isPng(bytes) ? await doc.embedPng(bytes) : null;
  if (!img) throw Object.assign(new Error('the stored file is not a JPEG or PNG image'), { code: 'NOT_AN_IMAGE' });
  const boxTop = y - 10;
  const boxBottom = M + 40;
  const boxW = W - 2 * M;
  const boxH = boxTop - boxBottom;
  const scale = Math.min(boxW / img.width, boxH / img.height, 1.5);
  const w = img.width * scale, h = img.height * scale;
  const x = M + (boxW - w) / 2, yy = boxBottom + (boxH - h) / 2;
  page.drawRectangle({ x: M, y: boxBottom, width: boxW, height: boxH, borderColor: rgb(0.85, 0.87, 0.9), borderWidth: 1 });
  page.drawImage(img, { x, y: yy, width: w, height: h });

  // Stamp
  page.drawRectangle({ x: W - M - 150, y: boxBottom + 8, width: 142, height: 30, borderColor: GREEN, borderWidth: 2, opacity: 0.9 });
  text('APPROVED · PRASAD TRANSPORT', W - M - 143, boxBottom + 19, 8.5, bold, GREEN);

  // Footer
  text('Issued to the driver through the Prasad Transport driver app. The office copy is the record; this sheet reproduces it.', M, M + 18, 7, font, MUT);
  text(`Ref: ${spec.ref ?? '-'}`, M, M + 6, 7, font, MUT);
  return doc.save();
}
