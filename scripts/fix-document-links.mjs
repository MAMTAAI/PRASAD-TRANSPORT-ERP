// scripts/fix-document-links.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Repair stored document links so every saved PDF/photo actually opens.
//
// Two distinct faults, one sweep:
//
//   1. vehicle_documents.document_url holds WINDOWS PATHS
//      (F:\Prasad_Transport_Data\vehicle-documents\<PLATE>\rc.pdf) — a bulk
//      import wrote the disk path instead of a served URL. A browser cannot
//      open F:\ anything, so every View/Download button on the vault is dead
//      even though all 271 files exist. Fix: copy the file into the ERP's
//      object store under UPLOAD_DIR and rewrite the row to
//      /api/v1/files/vehicle-docs/<plate>/<name>.
//
//   2. drivers.*_photo_url / vehicles.*_doc_url rows carry /api/v1/files/<key>
//      whose EXTENSION does not match the file on disk (row says
//      dl_photo.webp, disk holds dl_photo.pdf). The Firestore rows kept the
//      old Firebase path while the storage import saved the real bytes under
//      the real extension. Fix: if exactly one file with the same stem exists,
//      rewrite the URL to it. Ambiguous or missing files are REPORTED, never
//      guessed.
//
// Dry run by default; nothing writes without --commit. Idempotent: a second
// run finds nothing left to fix.
//
//   node -r dotenv/config scripts/fix-document-links.mjs            # dry run
//   node -r dotenv/config scripts/fix-document-links.mjs --commit
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import pg from 'pg';

const COMMIT = process.argv.includes('--commit');
const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || 'uploads');

const client = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'prasad_erp',
  user: process.env.PGUSER || 'prasad_app',
  password: process.env.PGPASSWORD,
});

// Same hygiene as server/lib/storage.js safeKey — a segment the file route
// would refuse must never be minted here.
const safeSegment = (s) => {
  const cleaned = String(s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '');
  return cleaned || 'x';
};

const report = { rehosted: 0, rehostSkipped: [], extFixed: 0, alreadyOk: 0, missing: [], ambiguous: [] };

// ── 1. vehicle_documents: F:\ windows paths → re-host into the object store ──
async function rehostVehicleDocs() {
  const { rows } = await client.query(
    String.raw`SELECT id, doc_type, document_url FROM vehicle_documents
      WHERE document_url ~ '^[A-Za-z]:[\\/]'`);
  console.log(`\nvehicle_documents with Windows-path URLs: ${rows.length}`);

  for (const r of rows) {
    const src = r.document_url;
    if (!existsSync(src)) {
      report.rehostSkipped.push({ id: r.id, doc_type: r.doc_type, src, why: 'file not on disk' });
      continue;
    }
    // Keep the human-readable layout the import used: parent dir is the plate.
    const plate = safeSegment(basename(dirname(src)));
    // Lowercase the extension so the served content-type matches (.PDF → .pdf).
    const name = safeSegment(basename(src)).replace(/\.([A-Za-z0-9]+)$/, (_, e) => '.' + e.toLowerCase());
    const key = `vehicle-docs/${plate}/${name}`;
    const dest = join(UPLOAD_DIR, 'vehicle-docs', plate, name);
    const url = `/api/v1/files/${key}`;

    if (COMMIT) {
      mkdirSync(dirname(dest), { recursive: true });
      // The original under F:\...\vehicle-documents stays where it is — this
      // copies into the store, it does not move the archive.
      if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) copyFileSync(src, dest);
      await client.query(
        'UPDATE vehicle_documents SET document_url = $2, updated_at = now() WHERE id = $1',
        [r.id, url]);
    }
    report.rehosted++;
    if (report.rehosted <= 5) console.log(`  ${COMMIT ? 'FIXED' : 'would fix'}: ${src}  ->  ${url}`);
  }
}

// ── 2. /api/v1/files/<key> whose extension does not match the disk ──────────
const stemFix = (urlValue) => {
  const key = urlValue.replace(/^\/api\/v1\/files\//, '').split('?')[0];
  const full = join(UPLOAD_DIR, key);
  if (existsSync(full)) return { ok: true };
  const dir = dirname(full);
  const stem = basename(full).replace(/\.[^.]+$/, '');
  if (!existsSync(dir)) return { missing: true };
  const candidates = readdirSync(dir).filter((f) => f.replace(/\.[^.]+$/, '') === stem);
  if (candidates.length === 1) {
    const newKey = key.split('/').slice(0, -1).concat(candidates[0]).join('/');
    return { fix: `/api/v1/files/${newKey}` };
  }
  return candidates.length ? { ambiguous: candidates } : { missing: true };
};

async function fixColumn(table, col) {
  const { rows } = await client.query(
    `SELECT id, ${col} AS u FROM ${table} WHERE ${col} LIKE '/api/v1/files/%'`);
  for (const r of rows) {
    const res = stemFix(r.u);
    if (res.ok) { report.alreadyOk++; continue; }
    if (res.fix) {
      if (COMMIT) {
        await client.query(
          `UPDATE ${table} SET ${col} = $2, updated_at = now() WHERE id = $1`, [r.id, res.fix]);
      }
      report.extFixed++;
      if (report.extFixed <= 5) console.log(`  ${COMMIT ? 'FIXED' : 'would fix'}: ${table}.${col}  ${r.u}  ->  ${res.fix}`);
    } else if (res.ambiguous) {
      report.ambiguous.push({ table, col, id: r.id, url: r.u, candidates: res.ambiguous });
    } else {
      report.missing.push({ table, col, id: r.id, url: r.u });
    }
  }
}

// drivers.additional_docs is a jsonb array of {id, name, link, valid_till}.
async function fixAdditionalDocs() {
  const { rows } = await client.query(
    `SELECT id, additional_docs FROM drivers
      WHERE additional_docs::text LIKE '%/api/v1/files/%'`);
  for (const r of rows) {
    let changed = false;
    const docs = (r.additional_docs ?? []).map((d) => {
      if (typeof d?.link === 'string' && d.link.startsWith('/api/v1/files/')) {
        const res = stemFix(d.link);
        if (res.ok) { report.alreadyOk++; return d; }
        if (res.fix) { changed = true; report.extFixed++; return { ...d, link: res.fix }; }
        if (res.ambiguous) report.ambiguous.push({ table: 'drivers', col: 'additional_docs', id: r.id, url: d.link, candidates: res.ambiguous });
        else report.missing.push({ table: 'drivers', col: 'additional_docs', id: r.id, url: d.link });
      }
      return d;
    });
    if (changed && COMMIT) {
      await client.query(
        'UPDATE drivers SET additional_docs = $2::jsonb, updated_at = now() WHERE id = $1',
        [r.id, JSON.stringify(docs)]);
    }
  }
}

await client.connect();
console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — UPLOAD_DIR = ${UPLOAD_DIR}`);

await rehostVehicleDocs();
for (const [table, cols] of [
  ['drivers', ['profile_pic_url', 'dl_photo_url', 'hzd_photo_url', 'aadhar_photo_url', 'pan_photo_url', 'bank_photo_url']],
  ['vehicles', ['rc_photo_url', 'insurance_doc_url', 'fitness_doc_url', 'permit_doc_url']],
]) {
  for (const col of cols) await fixColumn(table, col);
}
await fixAdditionalDocs();

console.log('\n──── summary ────');
console.log(`re-hosted vehicle documents : ${report.rehosted}${COMMIT ? '' : ' (dry run)'}`);
console.log(`extension mismatches fixed  : ${report.extFixed}${COMMIT ? '' : ' (dry run)'}`);
console.log(`already correct             : ${report.alreadyOk}`);
console.log(`file genuinely missing      : ${report.missing.length}`);
console.log(`ambiguous (NOT touched)     : ${report.ambiguous.length}`);
if (report.rehostSkipped.length) console.log('skipped re-hosts:', JSON.stringify(report.rehostSkipped, null, 1));
if (report.missing.length) console.log('missing files (need re-upload by staff):', JSON.stringify(report.missing.slice(0, 50), null, 1));
if (report.ambiguous.length) console.log('ambiguous:', JSON.stringify(report.ambiguous, null, 1));

await client.end();
