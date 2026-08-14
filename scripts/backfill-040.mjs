#!/usr/bin/env node
/**
 * scripts/backfill-040.mjs — move the last Firestore documents into the tables
 * migration 040 created.
 *
 * SOURCE. The Firestore export in backups/, not a live Firestore read: these
 * collections are being switched off, and a file is reproducible while a live
 * read at cutover time is not. Pass --backup to point at a fresher export
 * (scripts/firestore-backup.cjs writes one) before the final switch-off.
 *
 * IDEMPOTENT. Every row carries the Firestore document id in `legacy_id` and
 * every insert is ON CONFLICT (legacy_id) DO UPDATE, so a re-run converges
 * instead of duplicating. The two singletons key on their fixed primary key
 * for the same reason.
 *
 *   node -r dotenv/config scripts/backfill-040.mjs             # report only
 *   node -r dotenv/config scripts/backfill-040.mjs --live      # write
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initDb, query, withTransaction } from '../server/db/pool.js';

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const backupArg = argv[argv.indexOf('--backup') + 1];

// Newest export unless told otherwise — the operator should not have to paste a
// timestamped filename to run the common case.
function newestBackup() {
  const dir = join(process.cwd(), 'backups');
  const files = readdirSync(dir).filter((f) => /^firestore-backup-.*\.json$/.test(f)).sort();
  if (!files.length) throw new Error('no firestore-backup-*.json in backups/');
  return join(dir, files[files.length - 1]);
}

const path = backupArg && !backupArg.startsWith('--') ? backupArg : newestBackup();
const dump = JSON.parse(readFileSync(path, 'utf8'));
const COL = dump.collections ?? {};

/** Firestore export shape is { docId: { __data__, __subcollections__ } }. */
const docs = (name) => Object.entries(COL[name] ?? {}).map(([id, v]) => ({ id, ...(v.__data__ ?? v) }));

// ── Coercions ───────────────────────────────────────────────────────────────
// Firestore held money and distances as free-typed strings ('45,000', '₹45000',
// ''). Strip everything that is not part of a number rather than trusting
// Number() — Number('45,000') is NaN and would silently become 0.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const cleaned = String(v).replace(/[^0-9.-]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};
const money = (v) => num(v) ?? 0;

// JS accepts years up to 275760, so a typed '32026-02-04' parses cleanly and
// only fails at the INSERT. One of the two live bazaar loads has exactly that.
// A date this far out is a typo, never a real loading date — so it is dropped
// with a warning rather than stored, or "fixed" by guessing the intended year.
const PLAUSIBLE = (d) => { const y = d.getUTCFullYear(); return y >= 2000 && y <= 2100; };

/** Timestamps arrive as {_seconds}, as an ISO string, or absent. */
const ts = (v) => {
  if (!v) return null;
  const d = typeof v === 'object' && v._seconds !== undefined ? new Date(v._seconds * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (!PLAUSIBLE(d)) { console.warn(`  ! implausible date ${JSON.stringify(v)} — stored as NULL`); return null; }
  return d.toISOString();
};

/** A date column, but the source is free text. Unparseable → NULL, not epoch. */
const date = (v) => {
  const iso = ts(v);
  if (iso) return iso.slice(0, 10);
  const m = String(v ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return m && PLAUSIBLE(new Date(m[0])) ? m[0] : null;
};

const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));

const report = [];
async function load(label, rows, sql, toParams) {
  if (!rows.length) { report.push([label, 0, 'source empty']); return; }
  if (!LIVE) { report.push([label, rows.length, 'would insert']); return; }
  let n = 0;
  await withTransaction(async (c) => {
    for (const r of rows) { await c.query(sql, toParams(r)); n++; }
  });
  report.push([label, n, 'inserted/updated']);
}

await initDb({ attempts: 2 });

// ── bazaar_loads ────────────────────────────────────────────────────────────
// load_id is NOT NULL UNIQUE; a document without one cannot be referenced by a
// bid, so it is skipped loudly rather than given a synthetic code.
const loads = docs('BAZAAR_LOADS');
const loadsOk = loads.filter((d) => str(d.load_id));
for (const d of loads.filter((d) => !str(d.load_id))) console.warn(`  ! BAZAAR_LOADS/${d.id} has no load_id — skipped`);
await load('bazaar_loads', loadsOk, `
  INSERT INTO bazaar_loads (legacy_id, load_id, customer_name, origin, destination,
    distance_km, toll_plazas, toll_amount, material, weight, target_rate,
    loading_date, vehicle_type, rate_type, status, posted_by, created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,'OPEN'),$16,COALESCE($17,now()))
  ON CONFLICT (legacy_id) DO UPDATE SET
    customer_name=EXCLUDED.customer_name, origin=EXCLUDED.origin,
    destination=EXCLUDED.destination, target_rate=EXCLUDED.target_rate,
    status=EXCLUDED.status, updated_at=now()`,
  (d) => [d.id, str(d.load_id), str(d.customer_name) ?? 'UNKNOWN', str(d.origin) ?? '', str(d.destination) ?? '',
          num(d.distance_km), str(d.toll_plazas), money(d.toll_amount), str(d.material), str(d.weight),
          money(d.target_rate), date(d.loading_date), str(d.vehicle_type), str(d.rate_type),
          // Firestore used free-form words; anything outside the CHECK becomes OPEN.
          ['OPEN','AWARDED','CLOSED','CANCELLED'].includes(String(d.status).toUpperCase()) ? String(d.status).toUpperCase() : 'OPEN',
          str(d.postedBy), ts(d.createdAt)]);

// ── saved_documents ─────────────────────────────────────────────────────────
await load('saved_documents', docs('SAVED_DOCUMENTS'), `
  INSERT INTO saved_documents (legacy_id, title, authority, vehicle_no, content, created_at)
  VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()))
  ON CONFLICT (legacy_id) DO UPDATE SET title=EXCLUDED.title, content=EXCLUDED.content`,
  (d) => [d.id, str(d.title) ?? 'Untitled', str(d.authority), str(d.vehicle_no), str(d.content) ?? '', ts(d.createdAt)]);

// ── activity_logs ───────────────────────────────────────────────────────────
await load('activity_logs', docs('ACTIVITY_LOGS'), `
  INSERT INTO activity_logs (legacy_id, user_name, role, action, target, details, ts)
  VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()))
  ON CONFLICT (legacy_id) DO NOTHING`,
  (d) => [d.id, str(d.user), str(d.role), str(d.action) ?? 'UNKNOWN', str(d.target), str(d.details), ts(d.timestamp)]);

// ── WhatsApp CRM ────────────────────────────────────────────────────────────
await load('wa_contacts', docs('WA_CONTACTS'), `
  INSERT INTO wa_contacts (legacy_id, name, phone, category)
  VALUES ($1,$2,$3,$4)
  ON CONFLICT (legacy_id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category`,
  (d) => [d.id, str(d.name) ?? 'Unknown', String(d.phone ?? '').replace(/\D/g, '').slice(-10), str(d.category)]);

await load('wa_leads', docs('WA_LEADS'), `
  INSERT INTO wa_leads (legacy_id, name, req, status)
  VALUES ($1,$2,$3,COALESCE($4,'NEW'))
  ON CONFLICT (legacy_id) DO UPDATE SET status=EXCLUDED.status, req=EXCLUDED.req`,
  (d) => [d.id, str(d.name) ?? 'Unknown', str(d.req), str(d.status)]);

await load('wa_rules', docs('WA_RULES'), `
  INSERT INTO wa_rules (legacy_id, keyword, reply, action)
  VALUES ($1,$2,$3,$4)
  ON CONFLICT (legacy_id) DO UPDATE SET reply=EXCLUDED.reply, action=EXCLUDED.action`,
  (d) => [d.id, String(d.keyword ?? '').toLowerCase().trim(), str(d.reply) ?? '', str(d.action)]);

await load('wa_schedules', docs('WA_SCHEDULES'), `
  INSERT INTO wa_schedules (legacy_id, phone, message, send_at)
  VALUES ($1,$2,$3,COALESCE($4,now()))
  ON CONFLICT (legacy_id) DO UPDATE SET message=EXCLUDED.message, send_at=EXCLUDED.send_at`,
  (d) => [d.id, String(d.phone ?? '').replace(/\D/g, '').slice(-10), str(d.message) ?? '', ts(d.datetime)]);

await load('wa_logs', docs('WA_LOGS'), `
  INSERT INTO wa_logs (legacy_id, user_name, action, ts)
  VALUES ($1,$2,$3,COALESCE($4,now()))
  ON CONFLICT (legacy_id) DO NOTHING`,
  (d) => [d.id, str(d.user), str(d.action) ?? 'UNKNOWN', ts(d.timestamp)]);

// ── website content ─────────────────────────────────────────────────────────
// Stored whole, as app_settings['website']. 040 gave this a column-per-field
// table; 043 replaced it with one jsonb document because WebSettings writes the
// whole page in whatever shape it currently has (see that migration's header).
// The document goes in verbatim — camelCase, exactly what both screens read.
const web = docs('WEBSITE')[0];
if (web && LIVE) {
  await query(`
    INSERT INTO app_settings (key, value) VALUES ('website', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(web)]);
  report.push(['app_settings[website]', 1, 'upserted']);
} else report.push(['app_settings[website]', web ? 1 : 0, LIVE ? 'source empty' : 'would upsert']);

// ── app_settings ────────────────────────────────────────────────────────────
const settings = docs('SETTINGS')[0];
const email = docs('EMAIL_SETTINGS')[0];
const kv = [];
if (settings?.masterPrompt) kv.push(['master_prompt', JSON.stringify({ prompt: settings.masterPrompt })]);
if (email) kv.push(['email_parser', JSON.stringify({
  poll_minutes: Number(email.poll_minutes ?? 5),
  master_switch: Boolean(email.master_switch),
})]);
await load('app_settings', kv, `
  INSERT INTO app_settings (key, value) VALUES ($1,$2::jsonb)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
  (r) => [r[0], r[1]]);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\nsource: ${path}`);
console.log(`taken:  ${dump.__meta__?.takenAt ?? 'unknown'}`);
console.log(LIVE ? '\nmode:   LIVE\n' : '\nmode:   DRY RUN (pass --live to write)\n');
for (const [label, n, note] of report) console.log(`  ${String(n).padStart(5)}  ${label.padEnd(24)} ${note}`);
console.log();
process.exit(0);
