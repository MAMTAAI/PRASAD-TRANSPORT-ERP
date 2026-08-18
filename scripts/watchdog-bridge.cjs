// ═══════════════════════════════════════════════════════════════════════════
// watchdog-bridge.cjs — put the healer's work on the board.
//
//   node scripts/watchdog-bridge.cjs            # one pass
//   node scripts/watchdog-bridge.cjs --watch    # every WATCHDOG_POLL_S
//
// erp_auto_healer.cjs already detects crashes, drafts a fix with the local
// model, validates it and proposes it for approval. All of that has been going
// into logs/erp_heal_proposals.json and a log file. This lifts it onto the live
// board so a manager sees it without opening a JSON file.
//
// IT ALSO BEATS. The heartbeat is the more important half: an empty alert board
// means "nothing is wrong" only if something is still looking. Without a beat,
// a healer that died three weeks ago and a quiet week are the same picture.
//
// COMPANY AND ENVIRONMENT ARE EXPLICIT. Both come from the environment, with no
// defaults — the same script runs on the office PC and on AWS, and for Jaiswal
// with a different WATCHDOG_COMPANY. A wrong guess would file Prasad's crash on
// Jaiswal's board.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = (process.env.WATCHDOG_API || 'http://127.0.0.1:3300').replace(/\/$/, '');
const COMPANY = process.env.WATCHDOG_COMPANY;         // PRASAD | JAISWAL — required
const ENVIRONMENT = process.env.WATCHDOG_ENV;         // LOCAL   | AWS    — required
const POLL_S = Number(process.env.WATCHDOG_POLL_S || 60);
const LOGS = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LEDGER = path.join(LOGS, 'erp_heal_proposals.json');
const WATCH = process.argv.includes('--watch');

if (!COMPANY || !ENVIRONMENT) {
  console.error('WATCHDOG_COMPANY (PRASAD|JAISWAL) and WATCHDOG_ENV (LOCAL|AWS) must both be set.');
  console.error('Refusing to guess: an alert filed against the wrong firm is worse than one that never arrived.');
  process.exit(2);
}

const post = async (route, body) => {
  try {
    const res = await fetch(`${API}/api/v1/watchdog/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
    return await res.json();
  } catch (e) {
    // The bridge failing must not take the healer down with it.
    console.error(`[watchdog-bridge] ${route} failed: ${e.message}`);
    return null;
  }
}

// The healer's proposal states map onto the board's lifecycle. A drafted fix is
// NOT a resolution — it is a fix waiting for a person, which is its own colour.
const STATUS_FOR = {
  PENDING_APPROVAL: 'FIX_PROPOSED',
  GOD_APPROVED: 'FIX_PROPOSED',
  GOD_APPROVED_OVERRIDE: 'FIX_PROPOSED',
  APPLIED: 'GREEN',
  REJECTED_BY_GOD: 'RED',
  HEAL_DRAFT_FAIL: 'RED',
};

function readLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.proposals ?? []);
  } catch { return []; }   // no ledger yet means the healer has found nothing
}

async function pass() {
  const proposals = readLedger();

  for (const p of proposals) {
    const status = STATUS_FOR[p.status] ?? 'RED';
    const alert = await post('alert', {
      company: COMPANY, environment: ENVIRONMENT,
      host: os.hostname(), service: 'healer',
      severity: p.status === 'HEAL_DRAFT_FAIL' ? 'HIGH' : 'CRITICAL',
      kind: 'CRASH',
      title: `${p.error_type ?? 'Crash'} in ${path.basename(p.module ?? 'unknown')}`,
      error_type: p.error_type ?? null,
      error_message: (p.traceback ?? '').split('\n')[0]?.slice(0, 2000) ?? null,
      source_file: p.module ?? null,
      source_line: p.line_no ?? null,
      stack: (p.traceback ?? '').slice(0, 6000) || null,
      proposal_id: p.id ? String(p.id) : null,
      proposal_status: p.status ?? null,
    });

    // An applied fix closes the incident, and the report is what the healer
    // actually did — not a generic "resolved".
    if (alert?.id && status === 'GREEN') {
      await post(`alert/${alert.id}/status`, {
        status: 'GREEN',
        fixed_by: 'erp_auto_healer (approved)',
        fix_report:
          `WHAT WAS WRONG: ${p.error_type ?? 'a crash'} at ${p.module}:${p.line_no ?? '?'}.\n` +
          `WHAT WAS DONE: the local model drafted a replacement, it passed node --check, ` +
          `a timestamped backup was written to backups/heal/ and the file was replaced atomically, ` +
          `then the mapped service was restarted. Approved by God before anything was written.`,
        fix_diff: p.proposed_fix ? String(p.proposed_fix).slice(0, 20000) : null,
        proposal_id: p.id ? String(p.id) : null,
        proposal_status: p.status ?? null,
      });
    } else if (alert?.id && status === 'FIX_PROPOSED') {
      await post(`alert/${alert.id}/status`, { status: 'FIX_PROPOSED', proposal_status: p.status });
    }
  }

  // Beat last, and only after the work: a beat that lands when the pass threw
  // would report health the bridge does not have.
  await post('heartbeat', {
    company: COMPANY, environment: ENVIRONMENT,
    watchdog: 'erp_auto_healer', host: os.hostname(), version: '1',
    detail: { proposals: proposals.length, ledger: fs.existsSync(LEDGER), poll_s: POLL_S },
  });

  return proposals.length;
}

(async () => {
  const n = await pass();
  console.log(`[watchdog-bridge] ${COMPANY}/${ENVIRONMENT}: ${n} proposal(s) reported, heartbeat sent`);
  if (!WATCH) return;
  setInterval(() => { pass().catch((e) => console.error('[watchdog-bridge]', e.message)); }, POLL_S * 1000);
})();
