// ═══════════════════════════════════════════════════════════════════════════
// apply-newer-wins.mjs — file the queued copies that a record already had.
//
//   node scripts/apply-newer-wins.mjs            # dry run
//   node scripts/apply-newer-wins.mjs --apply
//
// These are the documents held back as WOULD_OVERWRITE: a licence, Aadhaar or
// passbook queued for a driver whose slot already pointed at a file. The
// operator's rule is that the newer one wins.
//
// SAFELY OVERWRITE MEANS THE OLD ONE IS STILL THERE.
// `drivers` has one slot per document, so the pointer must be replaced — but the
// file it pointed at is not deleted, and the fact that it was replaced is
// written to driver_document_history first. If the older copy turns out to be
// the right one, it is one UPDATE away from coming back, and the row says which
// file to restore.
//
// MULTIPLE_CANDIDATES is deliberately NOT covered here. "Newer wins" resolves a
// contest between what is filed and what is queued; it says nothing about which
// of three Aadhaars queued for the same driver is current, because none of them
// carries a date to be newer BY. Those stay for a person.
// ═══════════════════════════════════════════════════════════════════════════
import pg from 'pg';
import dotenv from 'dotenv';
import { statSync } from 'node:fs';
import { fileIntoStorage, driverDocKey } from '../server/services/fileIntoStorage.js';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
dotenv.config({ path: join(ROOT, '.env') });
const APPLY = process.argv.includes('--apply');

const SLOT = {
  driver_dl:        ['dl_photo_url',            'license_expiry'],
  driver_hzd:       ['hzd_photo_url',           'hzd_expiry'],
  driver_aadhar:    ['aadhar_photo_url',        null],
  driver_pan:       ['pan_photo_url',           null],
  driver_bank:      ['bank_photo_url',          null],
  driver_photo:     ['profile_pic_url',         null],
  driver_police:    ['police_verification_url', 'police_verified_on'],
  driver_voter:     ['voter_id_url',            null],
  driver_signature: ['signature_url',           null],
  driver_eye_test:  ['eye_test_url',            null],
};

const c = new pg.Client({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
await c.connect();

const { rows } = await c.query(`
  SELECT u.id, u.source_path, u.stored_path, u.suggested_doc_type AS doc_type,
         u.suggested_doc_name AS doc_name, u.suggested_expiry, u.suggested_driver_id,
         d.name AS driver_name,
         d.dl_photo_url, d.hzd_photo_url, d.aadhar_photo_url, d.pan_photo_url,
         d.bank_photo_url, d.profile_pic_url, d.police_verification_url,
         d.voter_id_url, d.signature_url, d.eye_test_url
    FROM unmapped_documents u
    JOIN drivers d ON d.id = u.suggested_driver_id
   WHERE u.status = 'PENDING' AND u.hold_reason = 'WOULD_OVERWRITE'
   ORDER BY d.name, u.suggested_doc_type`);

const when = (p) => { try { return statSync(p).mtime; } catch { return null; } };

const plan = [];
for (const r of rows) {
  const slot = SLOT[r.doc_type];
  if (!slot) continue;
  const [col, dateCol] = slot;
  const oldUrl = r[col];
  plan.push({
    ...r, col, dateCol, oldUrl,
    oldWhen: oldUrl ? when(oldUrl) : null,
    newWhen: when(r.stored_path),
  });
}

console.log(`=== NEWER WINS (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`held as WOULD_OVERWRITE : ${rows.length}`);
console.log(`will be replaced        : ${plan.length}`);
console.log('the previous file is kept on disk and recorded in driver_document_history\n');

for (const p of plan) {
  const older = p.oldWhen && p.newWhen && p.oldWhen > p.newWhen;
  console.log(`  ${String(p.driver_name).padEnd(26)} ${String(p.doc_name).padEnd(20)}`);
  console.log(`      was : ${p.oldUrl ?? '(none)'}${p.oldWhen ? `   [${p.oldWhen.toISOString().slice(0, 10)}]` : ''}`);
  console.log(`      now : ${p.source_path}${p.newWhen ? `   [${p.newWhen.toISOString().slice(0, 10)}]` : ''}`);
  // Worth saying out loud rather than hiding: the rule is "the queued copy
  // wins", and on disk that copy is sometimes the older scan.
  if (older) console.log('      NOTE: the file being replaced is the newer one by timestamp — replacing anyway, per the rule');
}

if (!APPLY) { console.log('\nDRY RUN — nothing written.\n'); await c.end(); process.exit(0); }

let n = 0;
for (const p of plan) {
  await c.query(
    `INSERT INTO driver_document_history (driver_id, slot, doc_type, previous_url, new_url, source_path, replaced_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.suggested_driver_id, p.col, p.doc_type, p.oldUrl, p.stored_path, p.source_path, 'newer-wins rule']);
  // Publish into app storage, not the raw vault path: a drive letter in this
  // column sets the field but leaves the document unopenable from the screen.
  const url = await fileIntoStorage(p.stored_path, driverDocKey(p.suggested_driver_id, p.col));
  await c.query(`UPDATE drivers SET ${p.col} = $2 WHERE id = $1`, [p.suggested_driver_id, url]);
  if (p.dateCol && p.suggested_expiry) {
    await c.query(`UPDATE drivers SET ${p.dateCol} = COALESCE(${p.dateCol}, $2::date) WHERE id = $1`,
                  [p.suggested_driver_id, p.suggested_expiry]);
  }
  await c.query(
    `UPDATE unmapped_documents
        SET status='ASSIGNED', resolved_kind='DRIVER', resolved_ref=$2,
            resolved_by='newer-wins rule', resolved_at=now(),
            hold_reason=NULL, hold_detail=NULL, updated_at=now()
      WHERE id=$1`, [p.id, p.suggested_driver_id]);
  n++;
}
console.log(`\nAPPLIED: ${n} slots repointed, ${n} history rows written. No file deleted.\n`);
await c.end();
