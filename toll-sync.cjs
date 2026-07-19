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
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const admin = require(path.join(__dirname, 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

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
const tollDocId = (txn) =>
  `TFS_${String(txn.ref_no).replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}` +
  (/AUTO-/.test(txn.ref_no) ? '' : `_${txn.amount}`);
// Same journal doc-id scheme as src/lib/accounting/journal.ts.
const journalDocId = (t, r) => `${t}__${r}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 380);

const SETTINGS_REF = () => db.collection('TOLL_SETTINGS').doc('auto_sync');

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

/** Keep ONLY txns from the last 24 hours. */
function last24h(txns) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return txns.filter(t => {
    const ts = Date.parse(t.txn_datetime || t.txn_date || '');
    return Number.isFinite(ts) ? ts >= cutoff : false;
  });
}

// ── Idempotent save (mirror of tollEngine.saveTollBatch, Admin SDK) ────────
async function saveTxns(txns, company, sourceTag) {
  const tripsSnap = await db.collection('TRIPS').get();
  const trips = tripsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const maps = T.mapTollsToTrips(txns, trips);

  let saved = 0, duplicates = 0, mapped = 0, unmatched = 0, totalNew = 0;
  const tripTotals = new Map();
  const gf = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };

  for (const mp of maps) {
    const id = tollDocId(mp.txn);
    const ref = db.collection('TOLL_TRANSACTIONS').doc(id);
    if ((await ref.get()).exists) { duplicates++; continue; }   // 🛡️ guardrail
    const trip = mp.trip;
    await ref.set({
      Vehicle_No: mp.txn.vehicle_no, Amount: mp.txn.amount,
      Txn_Date: mp.txn.txn_date, txn_datetime: mp.txn.txn_datetime,
      Toll_Plaza_Name: mp.txn.plaza, lane_id: mp.txn.lane,
      Transaction_Ref: mp.txn.ref_no, tag_account: mp.txn.tag_account || '',
      linked_trip_id: trip ? String(gf(trip, ['trip_id', 'Trip_ID']) || trip.id) : 'UNMAPPED',
      trip_db_id: trip?.id || '',
      linked_customer: trip ? String(gf(trip, ['customer_name', 'Customer', 'Registered_Assessee'])) : '',
      invoice_no: trip ? String(gf(trip, ['challan_no', 'Challan_No', 'invoice_no'])) : '',
      loading_loc: trip ? String(gf(trip, ['loading_point', 'Loading_Point'])) : '',
      dest_loc: trip ? String(gf(trip, ['consignee_name', 'Consignee_Name', 'unloading_point'])) : '',
      company: company || 'PRASAD TRANSPORT',
      map_status: mp.confidence, claim_status: 'UNCLAIMED',
      billing_type: 'Reimbursable (Bill to Co.)', is_billable: true,
      source: 'auto_sync', source_file: sourceTag,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    saved++; totalNew += mp.txn.amount;
    if (trip) { mapped++; tripTotals.set(trip.id, (tripTotals.get(trip.id) || 0) + mp.txn.amount); }
    else unmatched++;
  }
  // Trip P&L bump — only for NEW docs (duplicates never touch totals)
  for (const [tripId, amt] of tripTotals) {
    await db.collection('TRIPS').doc(tripId).update({
      toll_amt: admin.firestore.FieldValue.increment(round2(amt)),
      total_expense: admin.firestore.FieldValue.increment(round2(amt)),
    }).catch(() => {});
  }
  // Journal — doc id from (source_type, source_ref) => re-runs overwrite
  if (totalNew > 0) {
    const srcRef = `${company || 'FLEET'}__${sourceTag}`.slice(0, 200);
    await db.collection('JOURNAL').doc(journalDocId('TOLL_STATEMENT', srcRef)).set({
      source_type: 'TOLL_STATEMENT', source_ref: srcRef,
      date: new Date().toISOString().slice(0, 10),
      narration: `FASTag auto-sync ${sourceTag} — ${saved} tolls (${company || 'fleet'})`,
      company: company || '',
      lines: [
        { ledger: 'Toll & Fastag Expense', dr_cr: 'Dr', amount: round2(totalNew) },
        { ledger: 'Fastag Wallet / Bank', dr_cr: 'Cr', amount: round2(totalNew) },
      ],
      total: round2(totalNew), posted_at: admin.firestore.FieldValue.serverTimestamp(), posted_by: 'toll_auto_sync',
    });
  }
  return { saved, duplicates, mapped, unmatched, total: round2(totalNew) };
}

// ── One sync run ───────────────────────────────────────────────────────────
let running = false;
async function runSync(trigger) {
  if (running) { log('⏭️ sync already in progress — skipping'); return; }
  running = true;
  const ref = SETTINGS_REF();
  try {
    // Master Toggle re-evaluated AT TRIGGER TIME (scheduled runs only —
    // Force Sync is explicit human intent and always allowed to run).
    const s = (await ref.get()).data() || {};
    if (trigger === 'scheduled' && !s.master_switch) {
      log('🔴 Daily 24h Auto-Sync is OFF — terminating immediately');
      return;
    }
    if (!s.portal_url || !s.portal_user || !s.portal_password) {
      log('⚠️ Portal credentials incomplete in Toll Portal Settings — cannot sync');
      await ref.set({ last_sync_result: 'FAILED: portal credentials missing', last_sync_error: 'Set Portal URL/User/Password in Toll Portal Settings' }, { merge: true });
      return;
    }

    log(`🔄 sync started (${trigger})`);
    const allTxns = await scrapePortal(s);
    const fresh = last24h(allTxns);
    log(`  ⏱️ ${fresh.length}/${allTxns.length} txns within the last 24 hours`);
    const res = fresh.length
      ? await saveTxns(fresh, s.company || 'PRASAD TRANSPORT', `AUTOSYNC_${new Date().toISOString().slice(0, 10)}`)
      : { saved: 0, duplicates: 0, mapped: 0, unmatched: 0, total: 0 };

    const summary = `OK (${trigger}): ${res.saved} new (₹${res.total.toLocaleString('en-IN')}), ${res.mapped} trip-mapped, ${res.duplicates} duplicates skipped`;
    log(`✅ ${summary}`);
    await ref.set({
      last_sync_at: admin.firestore.FieldValue.serverTimestamp(),
      last_sync_trigger: trigger, last_sync_result: summary, last_sync_error: '',
    }, { merge: true });
  } catch (e) {
    log('❌ sync failed:', e.message);
    await ref.set({
      last_sync_at: admin.firestore.FieldValue.serverTimestamp(),
      last_sync_trigger: trigger, last_sync_result: 'FAILED',
      last_sync_error: String(e.message || e).slice(0, 400),
    }, { merge: true }).catch(() => {});
  } finally {
    running = false;
  }
}

// ── Strict 24h scheduler tick (30s) ────────────────────────────────────────
async function tick() {
  try {
    const snap = await SETTINGS_REF().get();
    const s = snap.data() || {};

    // 1) Force Sync Now (manual) — clear the flag FIRST so a stuck run can't loop
    if (s.force_sync_requested) {
      await SETTINGS_REF().set({ force_sync_requested: false }, { merge: true });
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
    const lastSched = s.last_scheduled_sync_at?.toDate?.() || new Date(0);
    if (lastSched >= due) return; // this 24h window already attempted — strict once-a-day
    // Claim the window BEFORE running: pass ho ya fail, aaj ka scheduled slot
    // ek hi baar chalta hai (fail par har 30s retry portal account lock kara sakta hai).
    await SETTINGS_REF().set({ last_scheduled_sync_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
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
