#!/usr/bin/env node
/**
 * scripts/migrate-storage.cjs — re-host every Firebase Storage object that a
 * PostgreSQL row still points at, then rewrite the row to the new URL.
 *
 * WHY THIS EXISTS. Switching the app's uploads to /api/v1/files stops NEW
 * objects going to Firebase, but it does nothing about the ones already there.
 * Those URLs are absolute links into firebasestorage.googleapis.com, so the day
 * the Firebase project is switched off, every document written before the
 * cutover 404s — driver licences, hazard certificates, RC books. "Disconnect
 * Firebase" is not true until this reports zero remaining.
 *
 * HOW. Firebase download URLs carry their own access token and are plain HTTP,
 * so nothing here needs the Firebase SDK or a credential: the API fetches the
 * bytes server-side (POST /files/import, which only accepts Firebase hosts) and
 * hands back the new key. This script then UPDATEs the column.
 *
 * SAFE TO RE-RUN. It only selects rows whose URL still points at Firebase, so a
 * second run finds nothing. A row that fails is left ALONE and reported — a
 * half-migrated row pointing at a missing object would be worse than one still
 * pointing at Firebase.
 *
 *   node scripts/migrate-storage.cjs            # report only, changes nothing
 *   node scripts/migrate-storage.cjs --live     # fetch, re-host and rewrite
 *   node scripts/migrate-storage.cjs --live --target aws
 */
const { Client } = require('pg');

const LIVE = process.argv.includes('--live');
const TARGET = (process.argv[process.argv.indexOf('--target') + 1] || process.env.DB_TARGET || 'local');
const API = process.env.AGENT_API_URL || 'http://127.0.0.1:3300';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const conn = TARGET === 'aws'
  ? { host: process.env.RDS_PGHOST, port: process.env.RDS_PGPORT, database: process.env.RDS_PGDATABASE,
      user: process.env.RDS_PGUSER, password: process.env.RDS_PGPASSWORD }
  : { host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
      user: process.env.PGUSER, password: process.env.PGPASSWORD };

// Every column that can hold an uploaded document, with the key prefix its
// objects should land under. `id` identifies the row to rewrite.
const COLUMNS = [
  ['drivers', 'profile_pic_url', 'drivers'],
  ['drivers', 'dl_photo_url', 'drivers'],
  ['drivers', 'hzd_photo_url', 'drivers'],
  ['drivers', 'aadhar_photo_url', 'drivers'],
  ['drivers', 'pan_photo_url', 'drivers'],
  ['drivers', 'bank_photo_url', 'drivers'],
  ['vehicles', 'rc_photo_url', 'vehicles'],
  ['vehicles', 'insurance_doc_url', 'vehicles'],
  ['vehicles', 'fitness_doc_url', 'vehicles'],
  ['vehicles', 'permit_doc_url', 'vehicles'],
  ['vehicle_documents', 'document_url', 'vehicle_docs'],
  ['driver_requests', 'photo_url', 'driver_requests'],
  ['trips', 'driver_loading_photo', 'trips'],
  ['trips', 'driver_unloading_photo', 'trips'],
  ['trips', 'invoice_url', 'trips'],
  ['companies', 'logo_url', 'company_docs'],
  ['companies', 'gst_pdf_url', 'company_docs'],
  ['companies', 'pan_pdf_url', 'company_docs'],
];

const FIREBASE = "url ~ '(firebasestorage|storage)\\.googleapis\\.com|firebasestorage\\.app'";

(async () => {
  const db = new Client(conn);
  await db.connect();
  console.log(`[storage-migrate] target=${TARGET} api=${API} mode=${LIVE ? 'LIVE' : 'DRY RUN'}\n`);

  let found = 0, moved = 0, failed = 0;
  const failures = [];

  for (const [table, column, prefix] of COLUMNS) {
    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT id, ${column} AS url FROM ${table}
          WHERE ${column} IS NOT NULL AND ${FIREBASE.replace('url', column)}`));
    } catch (e) {
      // A column that does not exist on this database is not an error worth
      // stopping for — the list is deliberately wider than any one schema.
      if (e.code === '42P01' || e.code === '42703') continue;
      throw e;
    }
    if (!rows.length) continue;
    console.log(`${table}.${column}: ${rows.length} object(s)`);
    found += rows.length;

    for (const r of rows) {
      const key = `${prefix}/${r.id}/${column.replace(/_url$/, '')}`;
      if (!LIVE) { console.log(`   would import ${r.url.slice(0, 72)}… → ${key}`); continue; }
      try {
        const res = await fetch(`${API}/api/v1/files/import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: r.url, path: key }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
        await db.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [body.url, r.id]);
        console.log(`   ✔ ${key} (${body.bytes} bytes)`);
        moved++;
      } catch (e) {
        // Left pointing at Firebase on purpose: a row rewritten to an object
        // that was never stored is a broken link we created ourselves.
        console.log(`   ✖ ${key} — ${e.message} (row left unchanged)`);
        failures.push({ table, column, id: r.id, error: e.message });
        failed++;
      }
    }
  }

  console.log(`\n[storage-migrate] ${found} Firebase object(s) referenced · ${moved} re-hosted · ${failed} failed`);
  if (!LIVE && found) console.log('[storage-migrate] dry run — nothing was changed. Re-run with --live.');
  if (failed) {
    console.log('\nFailures (these rows still point at Firebase — do NOT switch the project off yet):');
    for (const f of failures) console.log(`  ${f.table}.${f.column} ${f.id}: ${f.error}`);
  }
  if (LIVE && !failed && found === moved) {
    console.log('\n✅ Nothing in this database references Firebase Storage any more.');
  }
  await db.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('[storage-migrate] fatal:', e.message); process.exit(1); });
