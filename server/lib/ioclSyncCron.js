// server/lib/ioclSyncCron.js
// ─────────────────────────────────────────────────────────────────────────────
// Every 15 minutes, 09:00-21:59 local:  */15 9-21 * * *
//
// Pulls IOCL AC5 dispatch invoices from both mailboxes and files them as loading
// entries. Runs unattended, writes to logs/cron_sync.log, and touches no UI.
//
// WHY THE PDFs DO NOT GO THROUGH DEEPSEEK
//
// The AC5 is a DIGITAL pdf: pdfplumber pulls "T.T.No. AS26C9804", "Qty 40.000
// KL" and "SAP Doc.No.193680283" out of it as exact text, with coordinates. An
// LLM adds nothing to that and takes several things away -- it is
// non-deterministic on a task with one right answer, it is orders of magnitude
// slower per document, and every hallucinated digit becomes a wrong quantity or
// a wrong invoice number in the register.
//
// DeepSeek earns its place on the OTHER path: the Smart Inbox file scanner,
// where an operator photographs a paper slip and there is no text layer to read.
// That is a genuinely hard problem and a model is the right tool. This one is
// not, and running it every fifteen minutes would make the register worse and
// slower at the same time.
//
// It also happens to be why this scheduler still works today while Ollama is
// down: the ingestion path has no model in it at all.
//
// AN OVERRUN IS SKIPPED, NOT QUEUED. A 15-minute cadence against a job that can
// take minutes will eventually overlap. The runner's lock refuses the second
// caller, and the tick logs "skipped" and moves on -- two concurrent imports
// would each build a deduplication index blind to the other's uncommitted rows.
import cron from 'node-cron';
import { runIoclSync, SyncBusyError, logLine } from './ioclSyncRunner.js';

const SCHEDULE = process.env.IOCL_SYNC_CRON || '*/15 9-21 * * *';
const ENABLED = String(process.env.IOCL_SYNC_CRON_ENABLED ?? '1') !== '0';

let task = null;

export function startIoclSyncCron(app) {
  if (!ENABLED) {
    app?.log?.info('iocl sync cron disabled (IOCL_SYNC_CRON_ENABLED=0)');
    return null;
  }
  if (!cron.validate(SCHEDULE)) {
    app?.log?.error({ SCHEDULE }, 'iocl sync cron: invalid schedule, not started');
    logLine({ event: 'cron_invalid', schedule: SCHEDULE });
    return null;
  }

  task = cron.schedule(SCHEDULE, async () => {
    try {
      const res = await runIoclSync({ trigger: 'cron' });
      // Quiet on the common case: most ticks import nothing because the window
      // was already swept. Only a real import is worth a server log line; every
      // tick is in cron_sync.log regardless.
      if (res.inserted > 0) {
        app?.log?.info({ inserted: res.inserted, kl: res.kl_imported }, 'iocl sync cron imported invoices');
      }
    } catch (e) {
      if (e instanceof SyncBusyError) {
        logLine({ event: 'skipped', trigger: 'cron', reason: 'previous run still in flight' });
        return;
      }
      app?.log?.error({ err: e.message }, 'iocl sync cron failed');
      // runIoclSync already logged the detail to cron_sync.log.
    }
  }, { scheduled: true });

  app?.log?.info({ schedule: SCHEDULE }, 'iocl sync cron started');
  logLine({ event: 'cron_started', schedule: SCHEDULE });
  return task;
}

export function stopIoclSyncCron() {
  if (task) { task.stop(); task = null; logLine({ event: 'cron_stopped' }); }
}

export function cronInfo() {
  return { enabled: ENABLED, schedule: SCHEDULE, active: !!task };
}
