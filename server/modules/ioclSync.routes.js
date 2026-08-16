// server/modules/ioclSync.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// "Sync Gmail Invoices" — the HTTP face of tools/iocl_recon/iocl_ac5_loading.py.
//
// Pulls IOCL AC5 dispatch invoices from BOTH mailboxes and turns them into
// loading entries:
//
//   prasadtransport699@gmail.com     gmail_token.json    -> PT##### trips
//   jaiswalenterprise2016@gmail.com  jaiswal_token.json  -> JE##### trips
//
// The LR series is minted server-side from operating_company inside the insert
// transaction, so the two mailboxes cannot collide on a number.
//
// The run itself lives in ../lib/ioclSyncRunner.js, shared with the 15-minute
// scheduler, because the two MUST contend for the same lock. Two concurrent
// imports would each build a deduplication index blind to the other's
// uncommitted inserts and both would insert the same invoice.
import { requireAdminOrService } from './auth.routes.js';
import { runIoclSync, syncState, SyncBusyError } from '../lib/ioclSyncRunner.js';
import { cronInfo } from '../lib/ioclSyncCron.js';

export async function registerIoclSyncRoutes(app, opts = {}) {
  // This endpoint inserts trips. It is guarded, unlike the read-only status
  // route -- a sync button anyone can press is a mass-insert button.
  const guard = opts.requireAdmin || requireAdminOrService;

  // Cheap poll so the UI can show progress, and so an operator can see whether
  // the background scheduler is actually on.
  app.get('/sync-status', async () => ({ ...syncState(), cron: cronInfo() }));

  app.post('/sync-gmail', { preHandler: guard }, async (req, reply) => {
    try {
      const summary = await runIoclSync({
        from: req.body?.window_from,
        to: req.body?.window_to,
        apply: req.body?.apply !== false,   // dry run only if explicitly asked
        noFetch: !!req.body?.no_fetch,
        trigger: 'manual',
      });
      return {
        ok: true,
        ...summary,
        mailboxes: ['prasadtransport699@gmail.com', 'jaiswalenterprise2016@gmail.com'],
        // Phrased for a toast. "0 new" is a real, healthy answer: it means the
        // window was already swept, which is what a second click should say.
        message: summary.inserted > 0
          ? `Synced ${summary.inserted} new IOCL invoice${summary.inserted === 1 ? '' : 's'} from Gmail`
          : `No new invoices — ${summary.duplicates} already imported`,
      };
    } catch (e) {
      if (e instanceof SyncBusyError) {
        return reply.code(409).send({ error: 'SYNC_IN_PROGRESS', detail: e.message, ...e.state });
      }
      req.log?.error({ err: e.message }, 'iocl ac5 sync failed');
      return reply.code(500).send({ error: 'SYNC_FAILED', detail: String(e.message).slice(0, 600) });
    }
  });
}
