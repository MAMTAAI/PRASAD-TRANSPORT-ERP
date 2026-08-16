// server/modules/ioclSync.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// "Sync Gmail Invoices" — the button behind tools/iocl_recon/iocl_ac5_loading.py.
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
// WHY THIS SPAWNS A SCRIPT RATHER THAN REIMPLEMENTING IT
// The parser reads PDFs with pdfplumber and knows things that were learned the
// hard way — that the AC5's header "Qty:" is the tank batch and not the truck's
// load, that the date is printed two different ways by different depots, that
// vehicle numbers need normalising to the ERP's spelling before they can be
// compared. Porting that to JS would mean relearning all of it.
//
// A RUN IS EXCLUSIVE. Two concurrent syncs would each read the trips table,
// build the same deduplication index, and then both insert the same invoice —
// the index cannot see a row the other process has not committed yet. So a
// second request while one is running is refused with 409, not queued.
import { spawn } from 'node:child_process';
import { requireAdminOrService } from './auth.routes.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'tools', 'iocl_recon', 'iocl_ac5_loading.py');
const PYTHON = process.env.PYTHON_BIN || 'python';

// Gmail fetch + pdfplumber over a hundred-odd PDFs is minutes, not seconds.
const RUN_TIMEOUT_MS = Number(process.env.IOCL_SYNC_TIMEOUT_MS || 15 * 60 * 1000);

let running = null;   // { startedAt, window } while a sync is in flight

function isoDay(d) { return d.toISOString().slice(0, 10); }

export async function registerIoclSyncRoutes(app, opts = {}) {
  // This endpoint inserts trips. It is guarded, unlike the read-only report
  // routes -- a sync button that anyone can press is a mass-insert button.
  const guard = opts.requireAdmin || requireAdminOrService;

  // GET /iocl/sync-status — cheap poll so the UI can show progress honestly.
  app.get('/sync-status', async () => ({
    running: !!running,
    started_at: running?.startedAt ?? null,
    window: running?.window ?? null,
  }));

  app.post('/sync-gmail', { preHandler: guard }, async (req, reply) => {
    if (running) {
      return reply.code(409).send({
        error: 'SYNC_IN_PROGRESS',
        detail: `a sync started at ${running.startedAt} is still running`,
        started_at: running.startedAt,
      });
    }

    // Default window: the last 60 days, which comfortably covers IOCL's billing
    // rhythm without re-reading the whole mailbox on every click. Overridable.
    const now = new Date();
    const to = req.body?.window_to || isoDay(now);
    const from = req.body?.window_from
      || isoDay(new Date(now.getTime() - 60 * 24 * 3600 * 1000));
    // Dry run unless explicitly told to write. The UI sends apply:true.
    const apply = req.body?.apply !== false;

    const args = [SCRIPT, '--window-from', from, '--window-to', to];
    if (apply) args.push('--apply');
    if (req.body?.no_fetch) args.push('--no-fetch');

    running = { startedAt: new Date().toISOString(), window: [from, to] };
    req.log?.info({ from, to, apply }, 'iocl ac5 sync starting');

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(PYTHON, args, {
          cwd: REPO,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
        });

        let out = '', err = '';
        const cap = 400_000;   // a runaway log must not become a memory problem
        child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString(); });
        child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString(); });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`sync exceeded ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes and was killed`));
        }, RUN_TIMEOUT_MS);

        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            // The script's own last words are far more useful than "exit 1".
            const tail = (err || out).trim().split('\n').slice(-6).join('\n');
            return reject(new Error(`exit ${code}: ${tail}`));
          }
          resolve(out);
        });
      });

      // The script prints RESULT_JSON <json> as its final line.
      const m = result.match(/^RESULT_JSON (\{.*\})$/m);
      if (!m) {
        return reply.code(502).send({
          error: 'NO_RESULT',
          detail: 'the sync ran but produced no RESULT_JSON line',
          tail: result.trim().split('\n').slice(-8).join('\n'),
        });
      }
      const summary = JSON.parse(m[1]);
      req.log?.info(summary, 'iocl ac5 sync finished');

      return {
        ok: true,
        ...summary,
        mailboxes: ['prasadtransport699@gmail.com', 'jaiswalenterprise2016@gmail.com'],
        // Phrased for a toast. "0 new" is a real, healthy answer here: it means
        // everything in the window was already imported, which is what a second
        // click on the same day should say.
        message: summary.inserted > 0
          ? `Synced ${summary.inserted} new IOCL invoice${summary.inserted === 1 ? '' : 's'} from Gmail`
          : `No new invoices — ${summary.duplicates} already imported`,
      };
    } catch (e) {
      req.log?.error({ err: e.message }, 'iocl ac5 sync failed');
      return reply.code(500).send({ error: 'SYNC_FAILED', detail: String(e.message).slice(0, 600) });
    } finally {
      running = null;
    }
  });
}
