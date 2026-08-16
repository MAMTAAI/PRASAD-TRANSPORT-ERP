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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'tools', 'iocl_recon', 'iocl_ac5_loading.py');
const PYTHON = process.env.PYTHON_BIN || 'python';
const LOG_DIR = path.join(REPO, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'cron_sync.log');

const RUN_TIMEOUT_MS = Number(process.env.IOCL_SYNC_TIMEOUT_MS || 15 * 60 * 1000);

let running = null;   // { startedAt, window, trigger }

export function syncState() {
  return {
    running: !!running,
    started_at: running?.startedAt ?? null,
    window: running?.window ?? null,
    trigger: running?.trigger ?? null,
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
export async function runIoclSync({ from, to, apply = true, noFetch = false, trigger = 'manual' } = {}) {
  if (running) throw new SyncBusyError(syncState());

  const now = new Date();
  const windowTo = to || isoDay(now);
  // 60 days back by default: comfortably wider than IOCL's billing rhythm, and
  // re-reading a settled period is free -- every row in it is already a
  // duplicate and gets skipped.
  const windowFrom = from || isoDay(new Date(now.getTime() - 60 * 24 * 3600 * 1000));

  const args = [SCRIPT, '--window-from', windowFrom, '--window-to', windowTo];
  if (apply) args.push('--apply');
  if (noFetch) args.push('--no-fetch');

  running = { startedAt: new Date().toISOString(), window: [windowFrom, windowTo], trigger };
  const t0 = Date.now();
  logLine({ event: 'start', trigger, window: [windowFrom, windowTo], apply });

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
    try {
      const report = JSON.parse(fs.readFileSync(
        path.join(REPO, 'reports', 'iocl_recon', 'ac5_loading.json'), 'utf8'));
      kl = (report.new || []).reduce((a, r) => a + Number(r.qty_kl || 0), 0);
    } catch { /* the summary is still useful without it */ }

    logLine({
      event: 'ok', trigger, seconds: secs,
      inserted: summary.inserted, duplicates: summary.duplicates,
      held_for_review: summary.held_for_review, parsed: summary.parsed,
      rejected: summary.rejected, kl_imported: kl,
      window: summary.window,
    });
    return { ...summary, seconds: secs, kl_imported: kl };
  } catch (e) {
    logLine({ event: 'error', trigger, detail: String(e.message).slice(0, 600) });
    throw e;
  } finally {
    running = null;
  }
}
