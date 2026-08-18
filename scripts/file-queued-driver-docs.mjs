// ═══════════════════════════════════════════════════════════════════════════
// file-queued-driver-docs.mjs — file what is safe, and say why the rest waits.
//
//   node scripts/file-queued-driver-docs.mjs            # dry run
//   node scripts/file-queued-driver-docs.mjs --apply
//
// The queue holds 115 driver documents, each already carrying a suggested
// driver taken from vehicle_assignments. Filing all of them would be quick and
// wrong, for two reasons the data itself shows:
//
//   42 of them would land on a column that ALREADY HOLDS A FILE. `drivers` has
//   one slot per document, so writing means destroying whatever is there — and
//   the thing being destroyed may well be the better copy.
//
//   Some drivers have THREE Aadhaars or THREE licences queued from one lorry's
//   folder. Only one can be the current one. Which, is a question about paper
//   nobody in this process has seen.
//
// So the rule is: file only where the slot is empty AND exactly one candidate
// exists. Everything else stays pending with a reason precise enough to act on,
// which is what the dashboard shows the clerk. Nothing is overwritten and
// nothing is guessed.
// ═══════════════════════════════════════════════════════════════════════════
import pg from 'pg';
import dotenv from 'dotenv';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
dotenv.config({ path: join(ROOT, '.env') });
const APPLY = process.argv.includes('--apply');

// Which column each document type lives in, and the date column when it has one.
const SLOT = {
  driver_dl:        ['dl_photo_url',             'license_expiry'],
  driver_hzd:       ['hzd_photo_url',            'hzd_expiry'],
  driver_aadhar:    ['aadhar_photo_url',         null],
  driver_pan:       ['pan_photo_url',            null],
  driver_bank:      ['bank_photo_url',           null],
  driver_photo:     ['profile_pic_url',          null],
  driver_police:    ['police_verification_url',  'police_verified_on'],
  driver_voter:     ['voter_id_url',             null],
  driver_signature: ['signature_url',            null],
  driver_eye_test:  ['eye_test_url',             'eye_test_expiry'],
};

const c = new pg.Client({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
await c.connect();

const { rows } = await c.query(`
  SELECT u.id, u.source_path, u.stored_path, u.suggested_doc_type AS doc_type,
         u.suggested_doc_name AS doc_name, u.suggested_expiry, u.suggested_driver_id,
         d.name AS driver_name, v.vehicle_no,
         d.dl_photo_url, d.hzd_photo_url, d.aadhar_photo_url, d.pan_photo_url,
         d.bank_photo_url, d.profile_pic_url, d.police_verification_url,
         d.voter_id_url, d.signature_url, d.eye_test_url
    FROM unmapped_documents u
    LEFT JOIN drivers d ON d.id = u.suggested_driver_id
    LEFT JOIN vehicles v ON v.id = u.suggested_vehicle_id
   WHERE u.status = 'PENDING' AND u.reason = 'DRIVER_DOCUMENT'
   ORDER BY d.name, u.suggested_doc_type, u.source_path`);

// How many candidates exist per (driver, doc_type) — three Aadhaars is a choice,
// not an import.
const candidates = new Map();
for (const r of rows) {
  const k = `${r.suggested_driver_id}|${r.doc_type}`;
  candidates.set(k, (candidates.get(k) ?? 0) + 1);
}

const willFile = [], blocked = [];
for (const r of rows) {
  const slot = SLOT[r.doc_type];
  if (!r.suggested_driver_id) { blocked.push({ ...r, why: 'NO_DRIVER', detail: 'no driver suggested for this lorry' }); continue; }
  if (!slot) { blocked.push({ ...r, why: 'NO_COLUMN', detail: `drivers has no slot for '${r.doc_type}'` }); continue; }
  const [col, dateCol] = slot;
  const n = candidates.get(`${r.suggested_driver_id}|${r.doc_type}`);
  if (n > 1) { blocked.push({ ...r, why: 'MULTIPLE_CANDIDATES', detail: `${n} files of this type queued for ${r.driver_name} — one has to be chosen` }); continue; }
  if (r[col]) { blocked.push({ ...r, why: 'WOULD_OVERWRITE', detail: `${r.driver_name} already has a ${r.doc_name} on file` }); continue; }
  willFile.push({ ...r, col, dateCol });
}

const group = (list) => list.reduce((m, r) => (m[r.why] = (m[r.why] ?? 0) + 1, m), {});
console.log(`=== FILE QUEUED DRIVER DOCUMENTS (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`queued driver documents : ${rows.length}`);
console.log(`  safe to file now      : ${willFile.length}   (empty slot, single candidate)`);
console.log(`  held for a person     : ${blocked.length}`);
for (const [w, n] of Object.entries(group(blocked)).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(n).padStart(3)}  ${w}`);
}

const byType = willFile.reduce((m, r) => (m[r.doc_name] = (m[r.doc_name] ?? 0) + 1, m), {});
console.log('\n--- would file, by document ---');
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${t}`);

console.log('\n--- held, with the reason the clerk will see ---');
for (const b of blocked.slice(0, 14)) {
  console.log(`   [${b.why}] ${(b.vehicle_no ?? '?').padEnd(13)} ${String(b.doc_name).padEnd(20)} ${b.driver_name ?? '(none)'}`);
  console.log(`        ${b.detail}`);
}
if (blocked.length > 14) console.log(`   ... and ${blocked.length - 14} more`);

if (!APPLY) { console.log('\nDRY RUN — nothing written.\n'); await c.end(); process.exit(0); }

let filed = 0;
for (const r of willFile) {
  await c.query(`UPDATE drivers SET ${r.col} = $2 WHERE id = $1`, [r.suggested_driver_id, r.stored_path]);
  if (r.dateCol && r.suggested_expiry) {
    // Only fills a blank date, never replaces one: same rule as the vehicle side.
    await c.query(`UPDATE drivers SET ${r.dateCol} = COALESCE(${r.dateCol}, $2::date) WHERE id = $1`,
                  [r.suggested_driver_id, r.suggested_expiry]);
  }
  await c.query(
    `UPDATE unmapped_documents SET status='ASSIGNED', resolved_kind='DRIVER', resolved_ref=$2,
            resolved_by='auto: empty slot, single candidate', resolved_at=now(), updated_at=now()
      WHERE id=$1`, [r.id, r.suggested_driver_id]);
  filed++;
}

// The reason goes onto the row so the dashboard can show it without recomputing.
for (const b of blocked) {
  await c.query(
    `UPDATE unmapped_documents
        SET hold_reason = $2, hold_detail = $3, updated_at = now()
      WHERE id = $1 AND status = 'PENDING'`, [b.id, b.why, b.detail]);
}

console.log(`\nAPPLIED: ${filed} filed onto driver records, ${blocked.length} held with a stated reason.\n`);
await c.end();
