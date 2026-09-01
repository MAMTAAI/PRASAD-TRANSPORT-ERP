#!/usr/bin/env node
/**
 * scripts/restore-driver-kyc.mjs — re-attach the driver KYC scans the Firebase
 * cutover left behind.
 *
 * WHAT WAS ACTUALLY WRONG. The hourly audit reports, of 54 drivers: 0 with no
 * licence NUMBER, but 25 with no DL scan and 26 with no photo. So the data was
 * never lost — the FILES were. The Driver Master screen shows a licence number
 * with an "Upload DL" button beside it and reads as "nothing saved", which is
 * what sent us looking for a broken save that does not exist. Uploads work; the
 * Aadhaar "View File" buttons on those same rows prove it.
 *
 * WHERE THEY STILL ARE. firestore-backup-2026-08-13T09-49-05-841Z.json holds 47
 * driver rows with ~110 document URLs, and — verified 2026-09-01 — the Firebase
 * Storage links STILL RESOLVE (HTTP 206, image/*). They were never deleted; only
 * the pointers were dropped in the Postgres migration.
 *
 * WHY THE FILE IS COPIED AND NOT JUST LINKED. Writing the firebasestorage URL
 * straight into dl_photo_url would "fix" every screen in one query, and would be
 * the same mistake a second time: the whole KYC set would again depend on a
 * project being decommissioned, and the next time it goes the links die with it
 * and there is no backup left to recover FROM. So each file is downloaded and
 * re-uploaded through storage.put() into the ERP's own vault, and the column
 * points at our copy.
 *
 * SAFETY RULES, because this writes to 54 live driver records:
 *   · dry run unless --apply. The report is the point; read it first.
 *   · matched on 10-digit MOBILE, never on name. Two drivers share a name far
 *     more often than a number, and attaching one man's licence to another is
 *     worse than leaving the field empty.
 *   · it only ever fills a NULL. An existing document is never replaced, so a
 *     re-run cannot undo staff work done in the meantime.
 *   · Google Drive links (8 of them) are REPORTED, not fetched: drive.google.com
 *     answers a viewer page, not the file, and the API needs a Workspace scope
 *     the owner has not granted. Silently writing an HTML page as somebody's
 *     licence is the failure this refuses to commit.
 *
 *   node -r dotenv/config scripts/restore-driver-kyc.mjs            # dry run
 *   node -r dotenv/config scripts/restore-driver-kyc.mjs --apply
 *   node -r dotenv/config scripts/restore-driver-kyc.mjs --backup <path.json>
 *
 * RUN THIS ON THE BOX — the drivers live in the AWS database, and the vault it
 * writes into is the one nginx serves.
 */
import { readFileSync } from 'node:fs';
import { initDb, query, isDegraded, DB_TARGET } from '../server/db/pool.js';
import { put, publicUrl } from '../server/lib/storage.js';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d); };

const APPLY = has('apply');
const BACKUP = val('backup', '/home/ubuntu/erp-work/firestore-backup-2026-08-13T09-49-05-841Z.json');

// backup field -> drivers column. license_expiry is data, not a file, and is
// handled separately below because 22 rows are missing it too.
const DOC_MAP = {
  profile_pic: 'profile_pic_url',
  dl_photo: 'dl_photo_url',
  aadhar_photo: 'aadhar_photo_url',
  pan_photo: 'pan_photo_url',
  bank_photo: 'bank_photo_url',
  hzd_photo: 'hzd_photo_url',
};

const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const pad = (s, n) => String(s).padEnd(n);
const isUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v.trim());
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

await initDb({ attempts: 2 });
if (isDegraded()) { console.error('\n  no database reachable\n'); process.exit(1); }

let backup;
try { backup = JSON.parse(readFileSync(BACKUP, 'utf8')); }
catch (e) { console.error(`\n  cannot read backup at ${BACKUP}: ${e.message}\n  pass --backup <path>\n`); process.exit(1); }

const bRows = Object.values(backup?.collections?.DRIVERS ?? {}).map((r) => r.__data__ ?? {});
const byMobile = new Map();
for (const r of bRows) { const m = last10(r.mobile); if (m.length === 10) byMobile.set(m, r); }

const { rows: live } = await query(
  `SELECT id, name, mobile, license_expiry,
          ${Object.values(DOC_MAP).join(', ')}
     FROM drivers ORDER BY name`);

console.log(`\n  database : ${DB_TARGET}`);
console.log(`  backup   : ${BACKUP}`);
console.log(`  drivers  : ${live.length} live, ${bRows.length} in backup, ${byMobile.size} matchable by mobile`);
console.log(`\n  ${APPLY ? 'APPLYING' : 'DRY RUN — nothing is written; pass --apply to commit'}\n`);

const plan = [];
let noMatch = 0;
for (const d of live) {
  const b = byMobile.get(last10(d.mobile));
  if (!b) { noMatch++; continue; }
  for (const [bField, col] of Object.entries(DOC_MAP)) {
    if (d[col]) continue;                       // never replace an existing document
    const url = b[bField];
    if (!isUrl(url)) continue;
    const drive = url.includes('drive.google.com');
    plan.push({ id: d.id, name: d.name, col, url, drive });
  }
}

const fetchable = plan.filter((p) => !p.drive);
const driveOnly = plan.filter((p) => p.drive);
const expiryFix = live.filter((d) => !d.license_expiry && byMobile.get(last10(d.mobile))?.license_expiry);

console.log(`  recoverable now      : ${fetchable.length} files`);
console.log(`  blocked (Drive)      : ${driveOnly.length} files — need the Workspace scope`);
console.log(`  licence expiry dates : ${expiryFix.length} fillable`);
console.log(`  live drivers with no backup row: ${noMatch}\n`);

const byCol = {};
for (const p of fetchable) byCol[p.col] = (byCol[p.col] ?? 0) + 1;
for (const [c, n] of Object.entries(byCol)) console.log(`    ${pad(c, 18)} ${n}`);
if (driveOnly.length) {
  console.log('\n  Drive-hosted, NOT fetched (would need drive.readonly on the erp-robot service account):');
  for (const p of driveOnly) console.log(`    ${pad(p.name, 22)} ${p.col}`);
}

if (!APPLY) {
  console.log('\n  re-run with --apply to download these into the vault and fill the columns.\n');
  process.exit(0);
}

let ok = 0; let failed = 0;
for (const p of fetchable) {
  try {
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`source returned ${res.status}`);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    // An HTML body means a viewer page or a login wall, never a document. It
    // would otherwise be stored and shown as somebody's licence.
    if (!EXT[ct]) throw new Error(`unexpected content-type ${ct || '(none)'}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) throw new Error(`suspiciously small (${buf.length} bytes)`);
    const key = `driver-docs/${p.id}/${p.col.replace(/_url$/, '')}_${Date.now()}.${EXT[ct]}`;
    await put(key, buf, ct);
    const { rowCount } = await query(
      `UPDATE drivers SET ${p.col} = $2 WHERE id = $1::uuid AND ${p.col} IS NULL`, [p.id, publicUrl(key)]);
    if (!rowCount) throw new Error('column filled by someone else mid-run — left alone');
    console.log(`  OK    ${pad(p.name, 22)} ${pad(p.col, 18)} ${(buf.length / 1024).toFixed(0)}kb`);
    ok++;
  } catch (e) {
    console.log(`  FAIL  ${pad(p.name, 22)} ${pad(p.col, 18)} ${e.message}`);
    failed++;
  }
}

for (const d of expiryFix) {
  const v = byMobile.get(last10(d.mobile)).license_expiry;
  try {
    await query('UPDATE drivers SET license_expiry = $2 WHERE id = $1::uuid AND license_expiry IS NULL', [d.id, v]);
  } catch (e) { console.log(`  FAIL  ${pad(d.name, 22)} license_expiry      ${e.message}`); }
}

console.log(`\n  ${ok} files restored, ${failed} failed, ${expiryFix.length} expiry dates filled.`);
console.log('  Re-run the audit to confirm: /home/ubuntu/erp-work/erp_audit.sh\n');
process.exit(0);
