// scripts/ocr-live-check.mjs — end-to-end proof of the driver → OCR → desk
// pipeline on a box, against the RUNNING API and agent loop:
//   dev-bypass driver logs in → uploads a generated PNG to the vault → files it
//   as a staged paper → partner.document.submitted fires → BHUVANESHWARI reads
//   it (ocr_status PENDING → DONE/FAILED) → the row carries ocr_data.
// Everything it creates is deleted at the end (the staged row and the file).
//   cd /var/www/prasad-erp && DOTENV_CONFIG_PATH=/var/www/prasad-erp/.env node scripts/ocr-live-check.mjs
import 'dotenv/config';
import { deflateSync } from 'node:zlib';
import { query, closePool } from '../server/db/pool.js';
import { remove as removeFile } from '../server/lib/storage.js';

const BASE = process.env.CHECK_BASE ?? `http://127.0.0.1:${process.env.API_PORT ?? 3300}`;
const out = {};
const call = async (path, { token, method = 'GET', body, form } = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};

// A valid 64×32 PNG: white with a black block — enough for tesseract to run on.
function makePng(w = 64, h = 32) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w + 1) * h, 255);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; if (y > 8 && y < 24) for (let x = 10; x < 40; x++) raw[y * (w + 1) + 1 + x] = 0; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const mobile = String(process.env.OTP_DEV_BYPASS_MOBILES ?? '').split(/[,\s]+/).filter(Boolean)[0];
if (!mobile) { console.log(JSON.stringify({ skipped: 'OTP_DEV_BYPASS_MOBILES not set' })); process.exit(0); }

await call('/api/v1/auth/otp/request', { method: 'POST', body: { mobile } });
const v = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { mobile, code: process.env.OTP_DEV_CODE ?? '123456' } });
out.driver_login = { status: v.status, role: v.j.role };
const token = v.j.token;
let docId = null; let fileKey = null;
try {
  if (!token) throw new Error('no driver token');
  const form = new FormData();
  form.append('file', new Blob([makePng()], { type: 'image/png' }), 'ocr-live-check.png');
  form.append('path', 'driver-docs/ocr-live-check.png');
  const up = await call('/api/v1/files', { method: 'POST', token, form });
  out.upload = { status: up.status, key: up.j.key ?? up.j.path ?? null, error: up.j.error };
  fileKey = up.j.key ?? up.j.path ?? null;
  if (!fileKey) throw new Error(`upload failed: ${JSON.stringify(up.j).slice(0, 200)}`);

  const d = await call('/api/v1/portal/driver/documents', { method: 'POST', token,
    body: { doc_type: 'POD', file_key: fileKey, remarks: 'ocr live check — auto-removed' } });
  out.staged = { status: d.status, id: d.j.id, state: d.j.status, error: d.j.error };
  docId = d.j.id;
  if (!docId) throw new Error(`staging failed: ${JSON.stringify(d.j).slice(0, 200)}`);

  const { rows: ev } = await query(
    `SELECT event_type, emitted_by FROM agent_events WHERE aggregate_id = $1::uuid ORDER BY id DESC LIMIT 3`, [docId]);
  out.event = ev[0] ?? null;

  const started = Date.now();
  let row = null;
  while (Date.now() - started < 150_000) {
    const { rows } = await query(`SELECT ocr_status, ocr_engine, ocr_error, ocr_data, ocr_text FROM partner_documents WHERE id = $1::uuid`, [docId]);
    row = rows[0];
    if (row && row.ocr_status !== 'PENDING' && row.ocr_status !== 'RUNNING') break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  out.ocr = row ? {
    status: row.ocr_status, engine: row.ocr_engine, error: row.ocr_error,
    kind: row.ocr_data?.kind ?? null, suggest: row.ocr_data?.suggest ?? null, match: row.ocr_data?.match ?? null,
    text_chars: (row.ocr_text ?? '').length, waited_s: Math.round((Date.now() - started) / 1000),
  } : null;
  const { rows: ev2 } = await query(
    `SELECT event_type FROM agent_events WHERE aggregate_id = $1::uuid AND event_type = 'document.extracted' LIMIT 1`, [docId]);
  out.extracted_event = ev2.length > 0;
} catch (e) {
  out.error = e.message;
} finally {
  if (docId) { await query('DELETE FROM partner_documents WHERE id = $1::uuid', [docId]); out.cleaned_row = true; }
  if (fileKey) { try { await removeFile(fileKey); out.cleaned_file = true; } catch (e) { out.cleaned_file = e.message; } }
  if (token) await call('/api/v1/auth/logout', { method: 'POST', token });
}
console.log(JSON.stringify(out, null, 2));
await closePool();
process.exit(out.ocr && ['DONE', 'FAILED'].includes(out.ocr.status) && out.staged?.status === 201 ? 0 : 1);
