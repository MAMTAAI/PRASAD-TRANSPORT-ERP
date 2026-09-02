// server/lib/ioclSyncRunner.js
// ─────────────────────────────────────────────────────────────────────────────
// One runner, one lock, two callers: the "Sync Gmail Invoices" button and the
// 15-minute scheduler.
//
// THE LOCK IS THE WHOLE REASON THIS IS A SHARED MODULE. If the route and the
// cron each kept their own flag, a click landing during a scheduled run would
// start a second process. Both would read the trips table, both would build a
// deduplication index that cannot see the other's uncommitted inserts, and both
// would insert the same invoice. The dedup is careful precisely so that cannot
// happen; giving it two blind copies of itself would undo that.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { enrichTrips } from './tripEnrich.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'tools', 'iocl_recon', 'iocl_ac5_loading.py');
// `python` does not exist on Ubuntu 24.04+ — only `python3`. Defaulting to
// `python` meant the AWS box spawned ENOENT on every tick: eight consecutive
// cron runs logged an error, the loading register never moved, and the API went
// on reporting itself healthy because the failure was in a child process nobody
// was reading. Resolve it instead of assuming, and prefer an explicit
// PYTHON_BIN (the deploy points it at a venv, since PEP 668 makes system pip
// installs refuse on this release).
const PYTHON = process.env.PYTHON_BIN
  || ['python3', 'python'].find((bin) => {
    try {
      return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
    } catch { return false; }
  })
  || 'python3';
// Honour LOG_DIR. server/config/init_drives.js fills it in from
// LOCAL_STORAGE_PATH at boot (F:/Prasad_Transport_Data/logs on the office PC),
// so hardcoding <repo>/logs here meant the cron log was the one file still
// being written to the code drive after the 15-08 move to F:. Unset falls back
// to the repo, which is the AWS layout.
const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(REPO, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'cron_sync.log');

const RUN_TIMEOUT_MS = Number(process.env.IOCL_SYNC_TIMEOUT_MS || 15 * 60 * 1000);

let running = null;   // { startedAt, window, trigger }
// The last COMPLETED run, kept in memory so /sync-status can answer "is the
// mailbox actually being read" and not only "is something running right now".
// The second question is the one that went unasked for a week.
let lastRun = null;

export function syncState() {
  return {
    running: !!running,
    started_at: running?.startedAt ?? null,
    window: running?.window ?? null,
    trigger: running?.trigger ?? null,
    last_run: lastRun,
  };
}

const isoDay = (d) => d.toISOString().slice(0, 10);

/** Append one line to cron_sync.log. Never throws: logging must not break a run. */
export function logLine(obj) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
  } catch { /* a full disk should not take the sync down with it */ }
}

export class SyncBusyError extends Error {
  constructor(state) {
    super(`a sync started at ${state.started_at} (${state.trigger}) is still running`);
    this.name = 'SyncBusyError';
    this.state = state;
  }
}

/**
 * Run the AC5 importer once. Returns the script's RESULT_JSON summary.
 * Throws SyncBusyError if one is already in flight.
 */
// `stage` is which half of the mail pipeline runs:
//   'ac4'  KALI's daily loading cycle — AC4 mail → iocl_ac4_loads. Seconds.
//   'ac5'  BHUVANESHWARI's billing parse — AC5 mail → parsed + deduplicated;
//          with apply=false the NEW invoices come back in `new_loads` for
//          TARA to post, and nothing is inserted here.
//   'all'  both, with the Python importer inserting itself — the manual
//          "Sync Gmail Invoices" button and the emergency cron.
export async function runIoclSync({ from, to, apply = true, noFetch = false, trigger = 'manual', stage = 'all', ac4Days = null } = {}) {
  if (running) throw new SyncBusyError(syncState());

  const now = new Date();
  const windowTo = to || isoDay(now);
  // 60 days back by default: comfortably wider than IOCL's billing rhythm, and
  // re-reading a settled period is free -- every row in it is already a
  // duplicate and gets skipped.
  const windowFrom = from || isoDay(new Date(now.getTime() - 60 * 24 * 3600 * 1000));

  const args = [SCRIPT, '--window-from', windowFrom, '--window-to', windowTo, '--stage', stage];
  if (apply) args.push('--apply');
  if (noFetch) args.push('--no-fetch');
  if (ac4Days) args.push('--ac4-days', String(ac4Days));

  running = { startedAt: new Date().toISOString(), window: [windowFrom, windowTo], trigger, stage };
  const t0 = Date.now();
  logLine({ event: 'start', trigger, stage, window: [windowFrom, windowTo], apply });

  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(PYTHON, args, {
        cwd: REPO,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      const cap = 400_000;
      child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
      child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`sync exceeded ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes and was killed`));
      }, RUN_TIMEOUT_MS);

      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const tail = (stderr || stdout).trim().split('\n').slice(-6).join('\n');
          return reject(new Error(`exit ${code}: ${tail}`));
        }
        resolve(stdout);
      });
    });

    const m = out.match(/^RESULT_JSON (\{.*\})$/m);
    if (!m) {
      const tail = out.trim().split('\n').slice(-8).join('\n');
      logLine({ event: 'no_result', trigger, tail });
      throw new Error(`the sync ran but produced no RESULT_JSON line. Tail:\n${tail}`);
    }
    const summary = JSON.parse(m[1]);
    const secs = Math.round((Date.now() - t0) / 1000);

    // The quantity actually imported, which is the number an operator cares
    // about at the end of a day of these running unattended.
    let kl = null;
    // The parse stage (no apply) hands its NEW invoices back whole, so the
    // caller — BHUVANESHWARI — can pass each one to TARA as a proposal.
    let newLoads = null;
    let held = null;
    if (summary.stage !== 'ac4') {
      try {
        const report = JSON.parse(fs.readFileSync(
          path.join(REPO, 'reports', 'iocl_recon', 'ac5_loading.json'), 'utf8'));
        if (summary.applied) kl = (report.new || []).reduce((a, r) => a + Number(r.qty_kl || 0), 0);
        else { newLoads = report.new || []; held = report.dup_shape || []; }
      } catch { /* the summary is still useful without it */ }
    }

    // An imported trip arrives with no driver, no destination and no distance,
    // because the AC5 does not carry them. Filling those from the vehicle's own
    // history is what turns a row in the register into a trip somebody can
    // actually dispatch against. Failures here must not fail the import: the
    // invoices are already in, and an un-enriched trip is merely incomplete.
    let enrich = null;
    if (summary.inserted > 0) {
      try {
        const e = await enrichTrips({ sinceHours: 1 });
        enrich = { updated: e.updated, held_back: e.skipped.length };
        logLine({ event: 'enriched', trigger, ...enrich });
      } catch (err) {
        enrich = { error: String(err.message).slice(0, 200) };
        logLine({ event: 'enrich_failed', trigger, detail: enrich.error });
      }
    }

    // A DEAD MAILBOX IS NOT AN "ok" RUN, AND CALLING IT ONE COST A WEEK.
    //
    // Both Gmail OAuth tokens expired on or before 21-08. Every tick after that
    // read zero mail and logged event:"ok" with inserted:0 — which is exactly
    // what a genuinely quiet day looks like. The register stood still for seven
    // days, the API reported itself healthy throughout, and the failure was
    // visible only in stdout nobody was reading.
    //
    // The importer now carries each mailbox's status out in RESULT_JSON, so the
    // run is named for what it was. `degraded` is still a completed run — the
    // invoices already on disk were parsed and filed — but it is a completed
    // run over a mailbox that answered nothing, and it says so.
    const failed = summary.mailboxes_failed || [];
    if (failed.length) {
      logLine({
        event: 'mailbox_unavailable', trigger, mailboxes: failed,
        detail: Object.fromEntries(failed.map((k) => [k, (summary.mailboxes || {})[k]?.reason || (summary.mailboxes || {})[k]?.status])),
      });
    }

    // AND NEITHER IS AN INSERT THAT WAS REFUSED.
    //
    // The lesson above cost a week at the READ end; the same shape was waiting
    // at the WRITE end and cost the same week. From 21-08 every insert answered
    // 401 UNAUTHENTICATED — the importer sent no service token to an API that
    // had just been closed by default — and reported inserted:0, which this
    // runner faithfully logged as "ok". Two independent faults, one indistinguishable
    // log line, and the newer one (the dead mailbox) took the blame for both.
    //
    // A refused insert is a parsed, wanted, real load that did not get written.
    // It is louder than a dead mailbox, not quieter.
    const insertFailed = Number(summary.insert_failed || 0);
    if (insertFailed) {
      logLine({
        event: 'insert_refused', trigger, count: insertFailed,
        detail: (summary.insert_errors || []).slice(0, 5),
      });
    }
    // AC4 delivery invoices seen in the last two days, per mailbox. Loading
    // EVIDENCE the panel shows next to the AC5-fed register — see
    // tools/iocl_recon/iocl_ac4_seen.py for why they are never inserted.
    const ac4 = summary.ac4 || {};
    const ac4Seen = Object.values(ac4).reduce((n, v) => n + ((v?.loads || []).filter((l) => l?.ok).length), 0);

    // TWO STAGES, ONE last_run. KALI's AC4 pass and BHUVANESHWARI's AC5 pass
    // run as separate ticks now, and each must only overwrite the half of
    // this object it actually measured — an AC4 tick that reset
    // held_for_review to zero would clear the held banner without anyone
    // having looked at the invoices. Mailbox health is written by both,
    // because both read the mailboxes.
    const ranStage = summary.stage ?? stage;
    const prev = lastRun ?? {};
    const ac5Part = ranStage === 'ac4' ? {} : {
      ac5_at: new Date().toISOString(),
      inserted: summary.inserted, downloaded: summary.downloaded ?? null,
      insert_failed: insertFailed,
      insert_errors: summary.insert_errors || [],
      // Was written to the LOG line below but never to this object, so the
      // dashboard's held-for-review banner (which reads last_run) rendered
      // zero from the day it shipped while six invoices waited.
      held_for_review: Number(summary.held_for_review || 0),
      // AC5s inserted as their own trip although another AC5 already sat on
      // the same truck-day (two deliveries, or two runs). Worth a glance.
      second_invoice: Number(summary.second_invoice || 0),
      // The parse stage's hand-off to TARA, for /sync-status.
      new_for_tara: newLoads ? newLoads.length : null,
    };
    const ac4Part = ranStage === 'ac5' ? {} : {
      ac4_at: new Date().toISOString(),
      ac4,
      ac4_error: summary.ac4_error || null,
      // The daily loading cycle's own tally: AC4 documents written into
      // iocl_ac4_loads this tick, seen before, and refused. Never trips.
      ac4_new: Number(summary.ac4_new || 0),
      ac4_already: Number(summary.ac4_already || 0),
      ac4_failed: Number(summary.ac4_failed || 0),
    };
    lastRun = {
      inserted: 0, downloaded: null, insert_failed: 0, insert_errors: [], held_for_review: 0,
      second_invoice: 0, ac4: {}, ac4_error: null, ac4_new: 0, ac4_already: 0, ac4_failed: 0,
      ...prev,
      at: new Date().toISOString(), trigger, stage: ranStage, seconds: secs,
      mailboxes_failed: failed,
      mailboxes: summary.mailboxes || {},
      ...ac5Part,
      ...ac4Part,
    };

    logLine({
      event: (failed.length || insertFailed) ? 'degraded' : 'ok', trigger, stage: ranStage, seconds: secs, enrich,
      inserted: summary.inserted, duplicates: summary.duplicates,
      held_for_review: summary.held_for_review, parsed: summary.parsed,
      rejected: summary.rejected, kl_imported: kl,
      downloaded: summary.downloaded ?? null,
      mailboxes_failed: failed,
      insert_failed: insertFailed,
      ac4_seen: ac4Seen,
      ac4_new: Number(summary.ac4_new || 0),
      ac4_failed: Number(summary.ac4_failed || 0),
      ac4_error: summary.ac4_error || null,
      second_invoice: Number(summary.second_invoice || 0),
      window: summary.window,
    });
    return { ...summary, seconds: secs, kl_imported: kl, enrich, new_loads: newLoads, held };
  } catch (e) {
    logLine({ event: 'error', trigger, detail: String(e.message).slice(0, 600) });
    throw e;
  } finally {
    running = null;
  }
}
