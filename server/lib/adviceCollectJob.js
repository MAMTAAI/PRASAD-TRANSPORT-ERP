// server/lib/adviceCollectJob.js
// ─────────────────────────────────────────────────────────────────────────────
// THE DAILY ADVICE RUN — mail → advice rows → settlement voucher → bill flags.
//
// Owner, 5-Sep-2026: "email se bill detail collect kar ke auto reconciliation
// … oil company ka payment me HSD ka 35–40% direct fleet account me, baaki
// bank me." The payment advice is the one document that says how IOCL split
// the money. Until today the chain that reads it — fetch_advices.py,
// load_advices.py, scripts/post-advice-settlements.mjs — was run by hand, and
// the last advice on the books was 11-Aug. This makes it a job.
//
//   BHUVANESHWARI  fetch   Gmail → uploads/iocl_advices/*.pdf → advices.json
//   BHUVANESHWARI  load    advices.json → iocl_payment_advices / iocl_advice_lines
//   TARA           post    one JOURNAL per advice (ADV-<odn>), deterministic
//                          ref so a re-run is a no-op:
//                            Dr SBI (8490)                remitted
//                            Dr IOCL XTRAPOWER Card Wallet CCMS diesel (asset)
//                            Dr Toll · Dr Shortage & Penalty · Dr TDS 194C
//                              Cr Debtors: INDIAN OIL CORPORATION LTD
//   (derived)      refresh customer_bill_refresh() — PAID / SHORT / PENDING
//
// SAFE TO RUN TWICE: every stage is idempotent on its own key (pdf sha, line
// uid, voucher ref). The day-claim in agent_execution_logs makes the scheduled
// run once-a-day; a manual run (force) ignores the claim and still logs.
//
// Each Python stage runs in a child process with a hard timeout, exactly as
// ioclSyncRunner does for the AC4/AC5 documents; a stage that fails is
// reported and the later stages still run on what is already loaded — a stuck
// mailbox must not stop yesterday's advice from being posted.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { query, isDegraded } from '../db/pool.js';
import { startRun, startStep, finishRun } from './agentLog.js';

export const JOB = 'customer_advice_collect';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TOOLS = path.join(REPO, 'tools', 'iocl_recon');
// The parsers need pdfplumber + the Gmail client, which on the box live only
// in <repo>/.venv (PEP 668 refuses system pip). pm2 sets PYTHON_BIN to it; a
// run started any other way (a shell, a one-off script) must not fall back to
// the bare python3 and fail with "pdfplumber is not installed" — 5-Sep-2026.
const VENV_PY = ['.venv/bin/python', '.venv/Scripts/python.exe'].map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p));
const PYTHON = process.env.PYTHON_BIN
  || VENV_PY
  || ['python3', 'python'].find((bin) => {
    try { return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
  })
  || 'python3';
const STAGE_TIMEOUT_MS = Number(process.env.ADVICE_STAGE_TIMEOUT_MS || 10 * 60 * 1000);

function runChild(bin, args, { timeoutMs = STAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: REPO, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    } catch (e) { return resolve({ ok: false, code: null, stdout: '', stderr: String(e.message), seconds: 0 }); }
    const t0 = Date.now();
    let stdout = '', stderr = '';
    const cap = 200_000;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, stdout, stderr: stderr || e.message, seconds: (Date.now() - t0) / 1000 }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, seconds: Math.round((Date.now() - t0) / 100) / 10 });
    });
  });
}

const tail = (s, n = 6) => String(s ?? '').trim().split('\n').filter(Boolean).slice(-n).join('\n');
const grab = (s, re) => { const m = String(s ?? '').match(re); return m ? Number(m[1]) : null; };

/**
 * @param {{trigger?:string, force?:boolean, by?:string, log?:object, noFetch?:boolean}} o
 */
export async function runAdviceCollect({ trigger = 'SCHEDULE', force = false, by = null, log = console, noFetch = false } = {}) {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const run = await startRun(JOB, { trigger, detail: { by, force, noFetch } });
  if (!run.claimed && !force) return { skipped: run.reason ?? 'already ran today' };
  const runId = run.claimed ? run.run_id : null;
  const steps = {};
  const counts = {};
  let failed = 0;

  // ── 1. fetch — BHUVANESHWARI reads the mailbox ───────────────────────────
  {
    const done = await startStep(runId, 'fetch', { agent_code: 'BHUVANESHWARI' });
    const token = path.join(TOOLS, 'gmail_token.json');
    const args = [path.join(TOOLS, 'fetch_advices.py')];
    const hasToken = fs.existsSync(token);
    if (noFetch || !hasToken) args.push('--no-fetch');
    const r = await runChild(PYTHON, args);
    const parsed = grab(r.stdout, /(\d+)\s+advice/i);
    steps.fetch = await done(r.ok ? 'OK' : 'FAILED', {
      counts: { parsed: parsed ?? 0 }, detail: { no_fetch: noFetch || !hasToken, token_present: hasToken, tail: tail(r.ok ? r.stdout : (r.stderr || r.stdout)) },
      reason: !hasToken ? 'gmail_token.json missing beside the tools — parsing what is already on disk' : null,
      error: r.ok ? null : `exit ${r.code}: ${tail(r.stderr || r.stdout, 3)}`,
    });
    if (!r.ok) failed += 1;
  }

  // ── 2. load — the JSON into iocl_payment_advices ─────────────────────────
  {
    const done = await startStep(runId, 'load', { agent_code: 'BHUVANESHWARI' });
    const r = await runChild(PYTHON, [path.join(TOOLS, 'load_advices.py'), '--apply']);
    const { rows: [a] } = await query(`SELECT count(*)::int AS advices, max(advice_date) AS last_advice FROM iocl_payment_advices`).catch(() => ({ rows: [{}] }));
    counts.advices = a?.advices ?? null; counts.last_advice = a?.last_advice ?? null;
    steps.load = await done(r.ok ? 'OK' : 'FAILED', {
      counts: { advices: a?.advices ?? 0 }, detail: { last_advice: a?.last_advice ?? null, tail: tail(r.ok ? r.stdout : (r.stderr || r.stdout)) },
      error: r.ok ? null : `exit ${r.code}: ${tail(r.stderr || r.stdout, 3)}`,
    });
    if (!r.ok) failed += 1;
  }

  // ── 3. post — TARA settles each advice against the debtor ────────────────
  {
    const done = await startStep(runId, 'post', { agent_id: 'AGENT_02', agent_code: 'TARA' });
    const r = await runChild(process.execPath, [path.join(REPO, 'scripts', 'post-advice-settlements.mjs'), '--live']);
    const settled = grab(r.stdout, /advices settled\s*:\s*(\d+)/i);
    const already = grab(r.stdout, /advices settled\s*:\s*\d+\s*\((\d+) already\)/i);
    const postFailed = grab(r.stdout, /failed\s*:\s*(\d+)/i);
    counts.settled = settled ?? 0; counts.already = already ?? 0; counts.post_failed = postFailed ?? 0;
    steps.post = await done(r.ok && !(postFailed > 0) ? 'OK' : 'FAILED', {
      counts: { settled: settled ?? 0, already: already ?? 0, failed: postFailed ?? 0 },
      detail: { tail: tail(r.stdout, 10) },
      error: r.ok ? (postFailed > 0 ? `${postFailed} advice(s) refused by the ledger — see the run log` : null) : `exit ${r.code}: ${tail(r.stderr || r.stdout, 3)}`,
    });
    if (!r.ok || postFailed > 0) failed += 1;
  }

  // ── 4. refresh — the bills re-read their trips ───────────────────────────
  {
    const done = await startStep(runId, 'refresh', { agent_id: 'AGENT_02', agent_code: 'TARA' });
    try {
      const { rows } = await query(`
        SELECT customer_bill_refresh(id) FROM customer_bills
         WHERE status <> 'CANCELLED' AND period_from >= current_date - interval '180 days'`);
      const { rows: [f] } = await query(`
        SELECT COALESCE(sum(missing_count), 0)::int AS missing, COALESCE(sum(short_count), 0)::int AS short,
               COALESCE(sum(pending_count), 0)::int AS pending, COALESCE(sum(balance), 0)::numeric(14,2) AS balance
          FROM customer_bills WHERE status NOT IN ('CANCELLED') AND period_from >= current_date - interval '180 days'`);
      counts.bills_refreshed = rows.length; counts.missing = f.missing; counts.short = f.short; counts.pending = f.pending; counts.balance = f.balance;
      steps.refresh = await done('OK', { counts: { bills: rows.length, missing: f.missing, short: f.short, pending: f.pending } });
    } catch (err) {
      const pre163 = /customer_bill_refresh|customer_bills/.test(err.message);
      steps.refresh = await done(pre163 ? 'SKIPPED' : 'FAILED', { reason: pre163 ? 'migration 163 not applied' : null, error: pre163 ? null : err.message });
      if (!pre163) failed += 1;
    }
  }

  await finishRun(runId, failed ? 'FAILED' : 'OK', { counts, reason: failed ? `${failed} stage(s) failed` : null });
  const summary = { job: JOB, run_id: runId, trigger, failed, counts, steps };
  log.info?.({ job: JOB, ...counts, failed }, `[advices] ${failed ? 'degraded' : 'ok'} — settled ${counts.settled ?? 0} (+${counts.already ?? 0} already), last advice ${counts.last_advice ?? '-'}`);
  return summary;
}
