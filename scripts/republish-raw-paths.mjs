// ═══════════════════════════════════════════════════════════════════════════
// republish-raw-paths.mjs — make already-filed documents openable.
//
//   node scripts/republish-raw-paths.mjs            # dry run
//   node scripts/republish-raw-paths.mjs --apply
//
// The 66 driver documents filed from the queue were stored as raw vault paths
// (F:\Prasad_Transport_Data\...). The column was set and the queue emptied, so
// every count said the work was done — but nothing on that record opens, because
// the app serves documents through /api/v1/files/<key> and a drive letter means
// nothing to a browser.
//
// This walks every driver document slot, finds the values that are not servable,
// publishes those bytes into app storage and rewrites the column to the URL. The
// vault copy is left alone.
// ═══════════════════════════════════════════════════════════════════════════
import pg from 'pg';
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileIntoStorage, driverDocKey, isServable } from '../server/services/fileIntoStorage.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
dotenv.config({ path: join(ROOT, '.env') });
const APPLY = process.argv.includes('--apply');

const SLOTS = ['dl_photo_url', 'hzd_photo_url', 'aadhar_photo_url', 'pan_photo_url',
               'bank_photo_url', 'profile_pic_url', 'police_verification_url',
               'voter_id_url', 'signature_url', 'eye_test_url'];

const c = new pg.Client({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
await c.connect();

const { rows } = await c.query(`SELECT id, name, ${SLOTS.join(', ')} FROM drivers`);

const todo = [], missing = [];
for (const d of rows) {
  for (const slot of SLOTS) {
    const v = d[slot];
    if (!v || isServable(v)) continue;
    if (!existsSync(v)) { missing.push({ name: d.name, slot, path: v }); continue; }
    todo.push({ id: d.id, name: d.name, slot, path: v });
  }
}

console.log(`=== REPUBLISH RAW PATHS (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`drivers                      : ${rows.length}`);
console.log(`slots holding an unopenable path : ${todo.length}`);
console.log(`...whose file is also gone       : ${missing.length}`);

const bySlot = todo.reduce((m, t) => (m[t.slot] = (m[t.slot] ?? 0) + 1, m), {});
console.log('\n--- by slot ---');
for (const [s, n] of Object.entries(bySlot).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${s}`);
if (missing.length) {
  console.log('\n--- file no longer on disk (left as-is, needs a human) ---');
  missing.slice(0, 10).forEach((m) => console.log(`   ${m.name} · ${m.slot}\n        ${m.path}`));
}

if (!APPLY) { console.log('\nDRY RUN — nothing written.\n'); await c.end(); process.exit(0); }

let done = 0, failed = 0;
for (const t of todo) {
  try {
    const url = await fileIntoStorage(t.path, driverDocKey(t.id, t.slot));
    await c.query(`UPDATE drivers SET ${t.slot} = $2 WHERE id = $1`, [t.id, url]);
    done++;
  } catch (e) {
    failed++;
    console.log(`   FAILED ${t.name} · ${t.slot}: ${e.message}`);
  }
}
console.log(`\nAPPLIED: ${done} documents republished and now openable, ${failed} failed.\n`);
await c.end();
