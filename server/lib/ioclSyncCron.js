// server/lib/ioclSyncCron.js
// ─────────────────────────────────────────────────────────────────────────────
// Every 10 minutes, round the clock:  */10 * * * *
//
// Pulls IOCL AC5 dispatch invoices from both mailboxes and files them as loading
// entries. Runs unattended, writes to logs/cron_sync.log, and touches no UI.
//
// THIS SCHEDULER IS THE AUTO-SCAN, AND IT LIVES ON THE SERVER.
//
// It is node-cron inside the ERP API process on the AWS box, started at boot by
// index.js and kept alive by pm2 (whose startup unit is enabled, so it survives
// a reboot). It has no connection whatsoever to the office PC: that machine can
// be off, asleep or in a power cut and every tick still runs. Worth stating
// plainly because the obvious way to "make it run on the server" — an entry in
// the ubuntu crontab calling iocl_ac5_loading.py directly — is a TRAP:
//
//   • it would bypass the in-process lock, and the note below is not
//     hypothetical — two concurrent imports each build a deduplication index
//     blind to the other's uncommitted rows and both insert the same invoice;
//   • it would skip the enrichment pass the runner does after a successful
//     insert;
//   • it would never update syncState(), so the dashboard's sync panel — the
//     thing that finally made the dead mailboxes visible — would go blind again.
//
// The only crontab entry on that box is ci-deploy, and it should stay the only
// one. Change the cadence HERE, or with IOCL_SYNC_CRON.
//
// WHY ROUND THE CLOCK NOW. This was '*/15 9-21 * * *' — business hours in IST,
// which is the process timezone. That was a reasonable guess about when IOCL
// sends, and it is wrong often enough to matter: the window is swept by date,
// so an invoice mailed at 23:40 sat unread until 09:00 the next day, and
// anything arriving over a weekend night waited longer. A tick that finds
// nothing costs one Gmail list call, which is cheaper than the register being
// eleven hours stale every night.
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
// AN OVERRUN IS SKIPPED, NOT QUEUED. A 10-minute cadence against a job that can
// take minutes will eventually overlap -- and it is closer than it was: the
// catch-up run on 28-08 took 160 seconds against 115 downloaded PDFs, so a
// backlog run uses a quarter of the interval and a bad one could exceed it. The
// runner's lock refuses the second caller, and the tick logs "skipped" and moves
// on -- two concurrent imports would each build a deduplication index blind to
// the other's uncommitted rows and both would insert the same invoice. Skipping
// is free here because the window is swept by date, not by a cursor: whatever a
// skipped tick would have seen, the next one sees too.
import cron from 'node-cron';
import { runIoclSync, SyncBusyError, logLine } from './ioclSyncRunner.js';

const SCHEDULE = process.env.IOCL_SYNC_CRON || '*/10 * * * *';
// OFF BY DEFAULT SINCE 2-SEP-2026. The schedule moved to the Mahavidya agents:
// KALI's `loading_mail` graph node runs the AC4 daily-loading sweep every
// 10 min and BHUVANESHWARI's `invoice_mail` node the AC5 parse, with TARA
// posting each parsed invoice into the trip ledger (server/agents/*.js,
// server/agents/graphEngine.js). Every run still goes through
// ioclSyncRunner's one lock and one log, so nothing about the diagnosis path
// changed — only who asks. This generic cron is the emergency fallback:
// IOCL_SYNC_CRON_ENABLED=1 brings it back, and it must then NOT run beside
// the agents, because two callers is two importers.
const ENABLED = String(process.env.IOCL_SYNC_CRON_ENABLED ?? '0') !== '0';

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
