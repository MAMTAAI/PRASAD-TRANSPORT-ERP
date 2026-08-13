#!/usr/bin/env node
/**
 * 🛣️ TOLL/FASTAG AUTO-SYNC — strict once-per-24h scheduler + portal scraper.
 *
 * Controls (TOLL_SETTINGS/auto_sync — managed from the ERP's Toll Portal
 * Settings tab, admin-only):
 *   master_switch     "Daily 24h Auto-Sync" ON/OFF
 *   sync_time         "HH:00" preferred daily time (default 02:00)
 *   portal_url / portal_user / portal_password / txn_page_url  (web automation)
 *   force_sync_requested   set true by the "Force Sync Now" button
 *
 * Strict 24-hour semantics:
 *   - The scheduled run fires ONLY at the preferred time, at most once per
 *     24h window: due = today@sync_time; runs when now ≥ due AND the last
 *     SCHEDULED run was before this due moment. Restart-safe (state lives in
 *     Firestore, not process memory) — a crash/restart can never double-run.
 *   - On every trigger the Master Toggle is re-read from the DB first; when
 *     OFF the run terminates immediately (nothing opens, nothing writes).
 *   - "Force Sync Now" runs on demand (also when the toggle is OFF — explicit
 *     human intent) but goes through the exact same duplicate guardrail.
 *
 * Duplicate guardrail (same as the Statement Sync UI): every toll's Firestore
 * doc id is derived from its transaction ref + amount (tollDocId) — clicking
 * Force Sync ten times can never insert the same toll expense twice, and the
 * journal entry id is (source_type, source_ref)-derived so it overwrites, not
 * duplicates. Trip toll totals bump ONLY for newly created docs.
 *
 * Usage:  node toll-sync.cjs           # scheduler (30s tick)
 *         node toll-sync.cjs --once    # evaluate one tick then exit (cron)
 */
const path = require('path');
// The API's database credentials live in .env.api on the deployed box (pm2
// starts it with --env-file), NOT in .env. This runner talks to the same
// database, so it loads both — .env first for the general config, then
// .env.api which is the authoritative source for PG*. Without this the runner
// starts fine and then fails on its first query with a SASL error, which reads
// like a password problem rather than a missing file.
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.api') });
const fs = require('fs');
const { execSync } = require('child_process');

const axios = require('axios');

// ── PostgreSQL, not Firebase ──────────────────────────────────────────────
// This runner and src/TollFastagMgmt.tsx write the SAME tolls. While this side
// used the Firebase Admin SDK and the screen used Firestore-then-PostgreSQL,
// they wrote to different databases — and a toll present in only one gets
// billed twice or never. Both now write `toll_transactions`.
//
// It connects straight to PostgreSQL rather than through the HTTP API because
// it needs the provider credentials, which the API deliberately masks on every
// read. Loopback, same host, same pool settings as the API.
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'prasad_erp',
  user: process.env.PGUSER || 'prasad_app',
  password: process.env.PGPASSWORD,
  max: 4,
});
const q = (sql, args = []) => pool.query(sql, args);

const ONCE = process.argv.includes('--once');
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Pure toll parsing/mapping — SAME code as the UI (bundled from TS) ──────
// tollParse.ts is browser-free (unit-tested in Node), so the runner detects
// statement rows and maps tolls→trips with identical logic to Statement Sync.
let T = null;
try {
  const OUT = path.join(__dirname, 'node_modules', '.cache', 'tollParse.sync.cjs');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execSync(`npx esbuild src/lib/tollParse.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: __dirname, stdio: 'pipe' });
  T = require(OUT);
} catch (e) {
  console.error('FATAL: tollParse bundle failed —', e.message.slice(0, 200));
  process.exit(1);
}

// Same doc-id scheme as src/lib/tollEngine.ts — THE duplicate-prevention key.
// API providers carry a globally-unique ext_txn_id (preferred); statement/portal
// rows fall back to ref_no(+amount). Keep IN SYNC with tollEngine.tollDocId.
const tollDocId = (txn) =>
  txn.ext_txn_id
    ? `TFX_${String(txn.ext_txn_id).replace(/[^A-Za-z0-9]/g, '_').slice(0, 160)}`
    : `TFS_${String(txn.ref_no).replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}` +
      (/AUTO-/.test(txn.ref_no) ? '' : `_${txn.amount}`);
// Credit (wallet top-up) dedup — its own collection, keyed by ext_txn_id.
const creditDocId = (txn) => `FCR_${String(txn.ext_txn_id || txn.ref_no).replace(/[^A-Za-z0-9]/g, '_').slice(0, 160)}`;
// Same journal doc-id scheme as src/lib/accounting/journal.ts.
const journalDocId = (t, r) => `${t}__${r}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 380);

// Settings live in one jsonb row. `||` merges rather than replaces, so the
// runner clearing force_sync_requested cannot wipe a setting the operator
// changed in the same second.
const readSettings = async () => {
  const { rows } = await q(`SELECT value FROM toll_settings WHERE key = 'auto_sync'`);
  return rows[0]?.value ?? {};
};
const patchSettings = (patch) => q(
  `INSERT INTO toll_settings (key, value) VALUES ('auto_sync', $1::jsonb)
   ON CONFLICT (key) DO UPDATE SET value = toll_settings.value || EXCLUDED.value, updated_at = now()`,
  [JSON.stringify(patch)]);

// ── 🌐 Web automation: login → transactions table → row arrays ─────────────
// Selector defaults suit standard bank/FASTag corporate portals; overridable
// per-portal from the settings doc (sel_user / sel_pass / sel_submit / sel_rows).
async function scrapePortal(s) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
    log(`  🌐 opening portal ${s.portal_url}`);
    await page.goto(s.portal_url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Login
    await page.fill(s.sel_user || 'input[type="text"], input[type="email"], input[name*="user" i]', s.portal_user, { timeout: 20000 });
    await page.fill(s.sel_pass || 'input[type="password"]', s.portal_password, { timeout: 20000 });
    await page.click(s.sel_submit || 'button[type="submit"], input[type="submit"]', { timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    log('  🔐 logged in, opening transactions page…');
    if (s.txn_page_url) {
      await page.goto(s.txn_page_url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    }

    // Pull every table on the page into row-arrays; rowsToTxns() (the same
    // header-detector used for CSV/Excel statements) finds the txn table.
    const tables = await page.$$eval(s.sel_rows || 'table', (els) =>
      els.map(t => Array.from(t.querySelectorAll('tr')).map(tr =>
        Array.from(tr.querySelectorAll('th,td')).map(c => c.innerText.trim())
      ))
    );
    let best = { txns: [], skipped: 0 };
    for (const rows of tables) {
      const parsed = T.rowsToTxns(rows);
      if (parsed.txns.length > best.txns.length) best = parsed;
    }
    log(`  📄 ${best.txns.length} transactions read from portal`);
    return best.txns;
  } finally {
    // Session SAFELY closed no matter what happened above.
    await browser.close().catch(() => {});
    log('  🚪 browser session closed');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 🔌 API-PROVIDER SYNC (GTROPY etc.) — dynamic, credential-driven
// ──────────────────────────────────────────────────────────────────────────
// Loads active FASTAG_PROVIDERS, calls each provider's HTTP API with pagination,
// normalizes via the SAME pure code the UI uses (T.normalizeProviderTxns), then
// runs debits through the trip-mapping/dedup/journal pipeline and credits
// through the wallet-balance ledger. Everything is idempotent (ext_txn_id).
// ══════════════════════════════════════════════════════════════════════════

/** DD-MM-YYYY for GTROPY's start_time / end_time params. */
const fmtDMY = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

/** Sanitize a user-pasted base URL: strip wrapping quotes/whitespace and DROP
 *  any query string the admin copied along (…/account_transactions?start_time=…).
 *  Without this, axios would append a SECOND start_time/end_index → duplicate
 *  query keys → the GTROPY server throws HTTP 500. Returns origin+pathname. */
function cleanEndpoint(rawUrl) {
  const s = String(rawUrl || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!s) throw new Error('base_url not set');
  let u;
  try { u = new URL(s); } catch { throw new Error(`Invalid base_url (paste the plain URL, no quotes): "${s.slice(0, 60)}"`); }
  return `${u.origin}${u.pathname}`;
}

/** Sanitize a pasted token: drop an accidental "Authorization:" / "Bearer "
 *  prefix and surrounding whitespace so the header is exactly what GTROPY wants. */
function cleanToken(rawTok) {
  return String(rawTok || '').trim().replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '').trim();
}

// GTROPY silently returns [] for any date span beyond ~90 days (verified:
// 90d works, 120d empty). We chunk every request into ≤85-day slices so large
// backfills (sync_window_days: 180, 365…) never fall into that trap. Duplicate
// tolls across slice boundaries are harmless — ext_txn_id dedup absorbs them.
const MAX_SPAN_DAYS = 85;

/** Fetch ONE ≤MAX_SPAN date slice, paginating start_index/end_index to the end. */
async function fetchSlice(endpoint, token, start_time, end_time, PAGE) {
  const out = [];
  let start_index = 0;
  for (let guard = 0; guard < 200; guard++) {
    const end_index = start_index + PAGE;
    const res = await axios.get(endpoint, {
      headers: { Authorization: token },   // GTROPY: raw token, no "Bearer"
      params: { start_time, end_time, start_index, end_index },
      timeout: 60000,
    });
    let body = res.data;
    // Some misconfigured endpoints answer 200 with an HTML error page — treat
    // that as a failure instead of silently syncing zero rows.
    if (typeof body === 'string') {
      if (/<html|<!doctype/i.test(body)) throw new Error('server returned an HTML page, not JSON (check URL / token)');
      try { body = JSON.parse(body); } catch { throw new Error('non-JSON response from provider'); }
    }
    const arr = Array.isArray(body) ? body : (body?.data || body?.transactions || body?.result || []);
    if (!arr.length) break;
    out.push(...arr);
    if (arr.length < PAGE) break;
    start_index += arr.length;   // tolerant of inclusive/exclusive end_index
  }
  return out;
}

/** Fetch a provider's raw transactions across the whole sync window, split into
 *  ≤85-day slices (API range cap) each fully paginated. Returns { raw, window }. */
async function fetchProviderTxns(provider) {
  const endpoint = cleanEndpoint(provider.base_url);   // throws on quotes/empty/bad URL
  const token = cleanToken(provider.auth_token);
  if (!token) throw new Error('auth_token not set');
  const days = Number(provider.sync_window_days) > 0 ? Number(provider.sync_window_days) : 2;
  const PAGE = Number(provider.page_size) > 0 ? Number(provider.page_size) : 1000;
  const end = new Date();
  const overallStart = new Date(end.getTime() - days * 86400000);

  const raw = [];
  let sliceStart = new Date(overallStart);
  let slices = 0;
  while (sliceStart <= end) {
    const sliceEnd = new Date(Math.min(sliceStart.getTime() + MAX_SPAN_DAYS * 86400000, end.getTime()));
    raw.push(...await fetchSlice(endpoint, token, fmtDMY(sliceStart), fmtDMY(sliceEnd), PAGE));
    slices++;
    // Advance one day past this slice (API is date-granular → no gap, no overlap).
    sliceStart = new Date(sliceEnd.getTime() + 86400000);
  }
  return { raw, window: `${fmtDMY(overallStart)}→${fmtDMY(end)}${slices > 1 ? ` (${slices} slices)` : ''}` };
}

/** Persist a normalized provider batch. Debits → TOLL_TRANSACTIONS (trip-mapped,
 *  journalled, trip P&L bumped — identical to statement sync). Credits →
 *  FASTAG_CREDITS. Both feed the per-account FASTAG_ACCOUNTS running balance.
 *  Idempotent: only NEW docs move any totals. */
async function saveProviderBatch(debits, credits, company, provider) {
  const { rows: trips } = await q(
    `SELECT id, trip_code, customer_name, challan_no, loading_point, unloading_location,
            loading_date, toll_amt, total_expense
       FROM trips ORDER BY loading_date DESC NULLS LAST LIMIT 5000`);
  const maps = T.mapTollsToTrips(debits, trips);
  const gf = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };

  let saved = 0, duplicates = 0, mapped = 0, unmatched = 0, totalNew = 0;
  let creditsSaved = 0, creditDup = 0, creditTotal = 0;
  const tripTotals = new Map();
  const acct = new Map();
  const bumpAcct = (id, field, amt, txn) => {
    if (!id) return;
    const a = acct.get(id) || { debit: 0, credit: 0, vehicle: '', last: '' };
    a[field] = round2(a[field] + amt);
    if (txn.vehicle_no) a.vehicle = txn.vehicle_no;
    if ((txn.txn_datetime || '') > a.last) a.last = txn.txn_datetime || '';
    acct.set(id, a);
  };

  // ── DEBITS (toll crossings) ──────────────────────────────────────────────
  // The duplicate guard is now the UNIQUE index on ext_txn_id, applied by the
  // database as part of the INSERT. The old code read the doc back first and
  // then wrote — a race this runner could lose against the screen doing the
  // same thing, which is precisely how a toll got written twice.
  for (const mp of maps) {
    const trip = mp.trip;
    const res = await q(
      `INSERT INTO toll_transactions
         (ext_txn_id, vehicle_no, amount, txn_date, txn_datetime, plaza_name, txn_ref,
          tag_id, trip_id, invoice_no, loading_loc, dest_loc, company, claim_status,
          billing_type, is_billable, provider, remarks, lat, lng)
       VALUES ($1,$2,$3,$4::date,$5::timestamptz,$6,$7,$8,$9::uuid,$10,$11,$12,$13,'UNCLAIMED',
               'Reimbursable (Bill to Co.)', true, $14, $15, $16, $17)
       ON CONFLICT (ext_txn_id) WHERE ext_txn_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        tollDocId(mp.txn), mp.txn.vehicle_no, mp.txn.amount,
        mp.txn.txn_date, mp.txn.txn_datetime || null, mp.txn.plaza || null, mp.txn.ref_no || null,
        mp.txn.tag_account || null, trip ? trip.id : null,
        trip ? String(gf(trip, ['challan_no'])) || null : null,
        trip ? String(gf(trip, ['loading_point'])) || null : null,
        trip ? String(gf(trip, ['unloading_location'])) || null : null,
        company || 'PRASAD TRANSPORT',
        `${provider.type || 'api'}_api`,
        `API_${provider.name || provider.type}`,
        Number.isFinite(mp.txn.lat) ? mp.txn.lat : null,
        Number.isFinite(mp.txn.long) ? mp.txn.long : null,
      ]);
    if (!res.rows.length) { duplicates++; continue; }
    saved++; totalNew += mp.txn.amount;
    bumpAcct(mp.txn.account_id, 'debit', mp.txn.amount, mp.txn);
    if (trip) { mapped++; tripTotals.set(trip.id, round2((tripTotals.get(trip.id) || 0) + mp.txn.amount)); }
    else unmatched++;
  }

  // Trip P&L bump — only NEW mapped debits, so a re-run moves nothing.
  for (const [tripId, amt] of tripTotals) {
    await q(
      `UPDATE trips SET toll_amt = COALESCE(toll_amt,0) + $2,
                        total_expense = COALESCE(total_expense,0) + $2
        WHERE id = $1::uuid`, [tripId, round2(amt)]).catch(() => {});
  }

  // ── The journal ──────────────────────────────────────────────────────────
  // NOT posted here any more, and that is deliberate. The old runner wrote its
  // own JOURNAL document with hand-written Dr/Cr lines, bypassing TARA — which
  // is the sole writer of ledger_entries, enforces Dr=Cr at COMMIT and refuses
  // duplicate references. A background job inventing ledger rows is exactly
  // what the one-writer-per-table rule exists to stop.
  //
  // The tolls are recorded and claimable; the expense reaches the books through
  // the same path a statement upload uses. If that path is ever wired to post
  // per-sync, it belongs behind tara.postVoucher, not here.

  // ── CREDITS (wallet top-ups) ─────────────────────────────────────────────
  for (const c of credits) {
    const res = await q(
      `INSERT INTO fastag_credits (ext_credit_id, account_id, vehicle_no, amount,
                                   credit_date, credit_at, provider, remarks)
       VALUES ($1,$2,$3,$4,$5::date,$6::timestamptz,$7,$8)
       ON CONFLICT (ext_credit_id) DO NOTHING RETURNING id`,
      [creditDocId(c), c.account_id || null, c.vehicle_no || null, c.amount,
       c.txn_date || null, c.txn_datetime || null,
       provider.name || provider.type || null, c.ref_no || null]);
    if (!res.rows.length) { creditDup++; continue; }
    creditsSaved++; creditTotal += c.amount;
    // Credits carry payer labels (e.g. "LIVQUIK"), not plates — don't let them
    // overwrite the account's vehicle. Balance still moves.
    bumpAcct(c.account_id, 'credit', c.amount, { ...c, vehicle_no: '' });
  }

  // ── PER-ACCOUNT BALANCE (net delta of NEW rows only) ─────────────────────
  for (const [id, a] of acct) {
    await q(
      `INSERT INTO fastag_accounts (account_id, balance, total_debit, total_credit,
                                    vehicle_number, last_txn_at, provider, provider_type)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8)
       ON CONFLICT (account_id) DO UPDATE SET
         balance      = fastag_accounts.balance      + EXCLUDED.balance,
         total_debit  = fastag_accounts.total_debit  + EXCLUDED.total_debit,
         total_credit = fastag_accounts.total_credit + EXCLUDED.total_credit,
         vehicle_number = COALESCE(NULLIF(EXCLUDED.vehicle_number,''), fastag_accounts.vehicle_number),
         last_txn_at  = GREATEST(fastag_accounts.last_txn_at, EXCLUDED.last_txn_at),
         provider     = EXCLUDED.provider,
         provider_type = EXCLUDED.provider_type,
         updated_at   = now()`,
      [id, round2(a.credit - a.debit), round2(a.debit), round2(a.credit),
       a.vehicle || null, a.last || null, provider.id || null, provider.type || null]
    ).catch((e) => log('  ⚠️ account balance:', e.message));
  }

  return { saved, duplicates, mapped, unmatched, total: round2(totalNew), creditsSaved, creditDup, creditTotal: round2(creditTotal) };
}

/** Iterate every ACTIVE provider and sync it. Returns a one-line-per-provider
 *  summary, or null when there are no active providers. Per-provider failure
 *  is isolated — one bad token never blocks the others. */
async function syncAllProviders(trigger) {
  const { rows: providers } = await q(
    `SELECT id, name, type, base_url, auth_token, username, password, company, sync_window_days
       FROM fastag_providers WHERE active ORDER BY lower(name)`);
  if (!providers.length) { log('  ℹ️ no active API providers configured'); return null; }
  const results = [];
  for (const provider of providers) {
    log(`  🔌 provider "${provider.name}" (${provider.type}) — fetching…`);
    try {
      const { raw, window } = await fetchProviderTxns(provider);
      const norm = T.normalizeProviderTxns(provider.type, raw, provider.id);
      log(`     ${raw.length} raw (${window}) → ${norm.debits.length} debit / ${norm.credits.length} credit / ${norm.skipped} skipped`);
      if (!norm.debits.length && !norm.credits.length && raw.length) {
        log(`     ⚠️ no normalizer output — adapter for "${provider.type}" may be pending`);
      }
      const r = await saveProviderBatch(norm.debits, norm.credits, provider.company || 'PRASAD TRANSPORT', provider);
      const line = `${provider.name}: ${r.saved} tolls ₹${r.total.toLocaleString('en-IN')} (${r.mapped} mapped, ${r.duplicates} dup), ${r.creditsSaved} credits`;
      log(`     ✅ ${line}`);
      results.push(line);
      // UPDATE ... WHERE id (not an upsert) so a provider the admin deleted
      // mid-sync is never resurrected as a phantom row — this no-ops if gone.
      await q(`UPDATE fastag_providers SET last_sync_at = now(), last_sync_result = $2,
                      last_sync_error = '' WHERE id = $1::uuid`, [provider.id, line]).catch(() => {});
    } catch (e) {
      const msg = (e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data || '').slice(0, 120)}` : (e.message || String(e))).slice(0, 300);
      log(`     ❌ ${provider.name} failed: ${msg}`);
      results.push(`${provider.name}: FAILED (${msg})`);
      await q(`UPDATE fastag_providers SET last_sync_at = now(), last_sync_result = 'FAILED',
                      last_sync_error = $2 WHERE id = $1::uuid`, [provider.id, msg]).catch(() => {});
    }
  }
  return results.join(' | ');
}

/** Keep ONLY txns from the last 24 hours. */
function last24h(txns) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return txns.filter(t => {
    const ts = Date.parse(t.txn_datetime || t.txn_date || '');
    return Number.isFinite(ts) ? ts >= cutoff : false;
  });
}

// ── Idempotent save (mirror of tollEngine.saveTollBatch, PostgreSQL) ──────
// The portal-scrape path. Same dedup key and same conflict guard as the API
// path above, because they land in the same table.
async function saveTxns(txns, company, sourceTag) {
  const { rows: trips } = await q(
    `SELECT id, trip_code, customer_name, challan_no, loading_point, unloading_location,
            loading_date FROM trips ORDER BY loading_date DESC NULLS LAST LIMIT 5000`);
  const maps = T.mapTollsToTrips(txns, trips);

  let saved = 0, duplicates = 0, mapped = 0, unmatched = 0, totalNew = 0;
  const tripTotals = new Map();
  const gf = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };

  for (const mp of maps) {
    const trip = mp.trip;
    const res = await q(
      `INSERT INTO toll_transactions
         (ext_txn_id, vehicle_no, amount, txn_date, txn_datetime, plaza_name, txn_ref,
          tag_id, trip_id, invoice_no, loading_loc, dest_loc, company, claim_status,
          billing_type, is_billable, provider, remarks)
       VALUES ($1,$2,$3,$4::date,$5::timestamptz,$6,$7,$8,$9::uuid,$10,$11,$12,$13,'UNCLAIMED',
               'Reimbursable (Bill to Co.)', true, 'portal_scrape', $14)
       ON CONFLICT (ext_txn_id) WHERE ext_txn_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        tollDocId(mp.txn), mp.txn.vehicle_no, mp.txn.amount,
        mp.txn.txn_date, mp.txn.txn_datetime || null, mp.txn.plaza || null, mp.txn.ref_no || null,
        mp.txn.tag_account || null, trip ? trip.id : null,
        trip ? String(gf(trip, ['challan_no'])) || null : null,
        trip ? String(gf(trip, ['loading_point'])) || null : null,
        trip ? String(gf(trip, ['unloading_location'])) || null : null,
        company || 'PRASAD TRANSPORT', sourceTag || null,
      ]);
    if (!res.rows.length) { duplicates++; continue; }
    saved++; totalNew += mp.txn.amount;
    if (trip) { mapped++; tripTotals.set(trip.id, round2((tripTotals.get(trip.id) || 0) + mp.txn.amount)); }
    else unmatched++;
  }

  for (const [tripId, amt] of tripTotals) {
    await q(
      `UPDATE trips SET toll_amt = COALESCE(toll_amt,0) + $2,
                        total_expense = COALESCE(total_expense,0) + $2
        WHERE id = $1::uuid`, [tripId, round2(amt)]).catch(() => {});
  }

  // No journal here either — see the note in saveProviderBatch. TARA is the
  // only writer of ledger_entries and this runner does not go around it.

  return { saved, duplicates, mapped, unmatched, total: round2(totalNew) };
}

// ── One sync run ───────────────────────────────────────────────────────────
let running = false;

async function runSync(trigger) {
  if (running) { log('⏭️ sync already in progress — skipping'); return; }
  running = true;
  try {
    // Master Toggle re-evaluated AT TRIGGER TIME (scheduled runs only —
    // Force Sync is explicit human intent and always allowed to run).
    const s = await readSettings();
    if (trigger === 'scheduled' && !s.master_switch) {
      log('🔴 Daily 24h Auto-Sync is OFF — terminating immediately');
      return;
    }

    log(`🔄 sync started (${trigger})`);
    const parts = [];
    let ranSomething = false;

    // 1) 🔌 API PROVIDERS (GTROPY etc.) — the primary path.
    try {
      const provSummary = await syncAllProviders(trigger);
      if (provSummary) { parts.push(`providers → ${provSummary}`); ranSomething = true; }
    } catch (e) {
      log('  ❌ provider sync error:', e.message);
      parts.push(`providers FAILED: ${(e.message || e).toString().slice(0, 200)}`);
      ranSomething = true;
    }

    // 2) 🌐 LEGACY PORTAL SCRAPE — only when portal credentials are configured.
    if (s.portal_url && s.portal_user && s.portal_password) {
      ranSomething = true;
      const allTxns = await scrapePortal(s);
      const fresh = last24h(allTxns);
      log(`  ⏱️ ${fresh.length}/${allTxns.length} portal txns within the last 24 hours`);
      const res = fresh.length
        ? await saveTxns(fresh, s.company || 'PRASAD TRANSPORT', `AUTOSYNC_${new Date().toISOString().slice(0, 10)}`)
        : { saved: 0, duplicates: 0, mapped: 0, unmatched: 0, total: 0 };
      parts.push(`portal → ${res.saved} new (₹${res.total.toLocaleString('en-IN')}), ${res.mapped} mapped, ${res.duplicates} dup`);
    }

    if (!ranSomething) {
      log('⚠️ Nothing to sync — no active API providers and no portal credentials configured');
      await ref.set({ last_sync_result: 'IDLE: no active providers / portal configured', last_sync_error: 'Add a provider in the API Providers tab, or set portal credentials.' }, { merge: true });
      return;
    }

    const summary = `OK (${trigger}): ${parts.join('  |  ')}`;
    log(`✅ ${summary}`);
    await patchSettings({
      last_sync_at: new Date().toISOString(),
      last_sync_trigger: trigger, last_sync_result: summary.slice(0, 900), last_sync_error: '',
    });
  } catch (e) {
    log('❌ sync failed:', e.message);
    await patchSettings({
      last_sync_at: new Date().toISOString(),
      last_sync_trigger: trigger, last_sync_result: 'FAILED',
      last_sync_error: String(e.message || e).slice(0, 400),
    }).catch(() => {});
  } finally {
    running = false;
  }
}

// ── Strict 24h scheduler tick (30s) ────────────────────────────────────────
async function tick() {
  try {
    const s = await readSettings();

    // 1) Force Sync Now (manual) — clear the flag FIRST so a stuck run can't loop
    if (s.force_sync_requested) {
      await patchSettings({ force_sync_requested: false });
      log('🖱️ Force Sync Now requested from ERP');
      await runSync('manual');
      return;
    }

    // 2) Scheduled: due = today at the preferred time; run once per due moment
    if (!s.master_switch) return; // OFF => completely disabled, nothing to evaluate
    const [hh, mm] = String(s.sync_time || '02:00').split(':').map(Number);
    const now = new Date();
    const due = new Date(now); due.setHours(hh || 2, mm || 0, 0, 0);
    if (now < due) return; // preferred time not reached yet today
    // Stored as an ISO string now, not a Firestore Timestamp — no .toDate().
    const lastSched = s.last_scheduled_sync_at ? new Date(s.last_scheduled_sync_at) : new Date(0);
    if (lastSched >= due) return; // this 24h window already attempted — strict once-a-day
    // Claim the window BEFORE running: pass ho ya fail, aaj ka scheduled slot
    // ek hi baar chalta hai (fail par har 30s retry portal account lock kara sakta hai).
    await patchSettings({ last_scheduled_sync_at: new Date().toISOString() });
    log(`⏰ scheduled window reached (${String(s.sync_time || '02:00')})`);
    await runSync('scheduled');
  } catch (e) {
    log('tick error:', e.message);
  }
}

async function main() {
  log(`🛣️ Toll Auto-Sync runner started (${ONCE ? 'single tick' : 'scheduler, 30s tick'})`);
  await tick();
  if (ONCE) { log('done.'); process.exit(0); }
  setInterval(tick, 30000);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
