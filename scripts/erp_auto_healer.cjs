// scripts/erp_auto_healer.cjs
// PRASAD ERP SAFE AUTO-HEALER — Level-5 self-healing with a hard HITL gate.
// Node twin of tools/mamta-bridge/auto_healer.py: "AI proposes, God disposes."
//
// Pipeline (every ERP_HEAL_POLL_S, default 15s):
//   DETECT   tail Node stderr logs (logs/*.err.log + whatsapp-server logs) for
//            SyntaxError / TypeError / ReferenceError / RangeError stacks and
//            UnhandledPromiseRejection tags. First stack frame inside an
//            ALLOWED ERP root wins (Node stacks are deepest-first).
//   GUARD    target must be an ERP infra file (root *.cjs, scripts/,
//            whatsapp-server/) — NEVER node_modules, NEVER this healer or its
//            logger (circular-repair ban), NEVER React src/ (no runtime
//            stderr there anyway). Rate: max 3 proposals/module/hour; 24h
//            signature cooldown; size cap (full-file LLM rewrite is unsafe on
//            big files). Kill switch: `ERP_HEALER.KILL` at repo root pauses
//            everything.
//   DRAFT    local LLM via MAMTA bridge /ask (deepseek-coder). STRICT
//            validation before anything reaches God: `node --check` MUST pass
//            (temp file beside the target so ESM/CJS semantics match), size
//            band 0.5–1.7x, fix != original, top-level function names
//            preserved. One guided retry, then HEAL_DRAFT_FAIL.
//   PROPOSE  POST {bridge}/propose kind=js, purpose tagged [PRASAD_ERP],
//            leg heal|<file>, source_agent prasad-erp-healer → god_mode
//            Agentic Debate (JS text-lint + risk-guard reviewer + RLGF) →
//            PENDING_APPROVAL in god_approvals.json → God Approval UI.
//            ZERO autonomous overwrites, by construction.
//   EXECUTE  poll god_approvals.json (READ-only — the bridge owns it; the
//            HTTP list truncates code at 3000 chars, the file is the truth):
//            GOD_APPROVED          → sha unchanged since proposal + re-validate
//                                    → timestamped backup in backups/heal/ →
//                                    atomic overwrite → node --check (fail ⇒
//                                    instant rollback) → restart mapped
//                                    service (bridge.cjs → ai-stack relaunch).
//            GOD_APPROVED_OVERRIDE → God's edited code, same guards; refused
//                                    if near the 10k decide() truncation cap.
//            REJECTED_BY_GOD       → proposal discarded (RLGF already learned).
//
// Ledger: logs/erp_heal_proposals.json — {project:'PRASAD_ERP', id, module,
// line_no, traceback, original_sha, original_snippet, proposed_fix, status}.
// Lifecycle → logs/erp_system.log (all events) + MAMTA boot_book.log (summaries).
//
//   node scripts/erp_auto_healer.cjs              # daemon
//   node scripts/erp_auto_healer.cjs --once       # single cycle
//   node scripts/erp_auto_healer.cjs --self-test  # offline parser/guard tests
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { slog, slogBoth, ROOT } = require('./erp_system_log.cjs');

const AGENT = 'prasad-erp-healer';
const PROJECT = 'PRASAD_ERP';

// ── config (env-overridable) ──────────────────────────────────────────────────
const BRIDGE = process.env.MAMTA_BRIDGE_URL || 'http://127.0.0.1:8765';
// NO CROSS-COMPANY DEFAULTS.
//
// These fell back to E:\jaiswal-terminal\... -- the Prasad healer read Jaiswal
// Capital's bridge TOKEN and its approvals file straight out of the trading
// repo. A company boundary crossed by a default value, which survived because
// nobody looked at it. Both paths broke the moment jaiswal-terminal moved to
// H:, which is the only reason it surfaced.
//
// Set the env var or the feature stays off. An unset variable disables the
// integration; it never silently reaches into the other company's files.
const TOKEN_FILE = process.env.MAMTA_BRIDGE_TOKEN_FILE || null;
const APPROVALS = process.env.MAMTA_APPROVALS_PATH || null;
if (!TOKEN_FILE) console.warn('[healer] MAMTA_BRIDGE_TOKEN_FILE unset -- bridge auth disabled (previously defaulted into the Jaiswal tree).');
if (!APPROVALS) console.warn('[healer] MAMTA_APPROVALS_PATH unset -- approvals lane disabled.');
const POLL_S = Number(process.env.ERP_HEAL_POLL_S || 15);
const RATE_MAX = Number(process.env.ERP_HEAL_RATE_MAX || 3);      // per module…
const RATE_WINDOW_MS = 3600 * 1000;                               // …per hour
const SIG_COOLDOWN_MS = Number(process.env.ERP_HEAL_SIG_COOLDOWN_S || 86400) * 1000;
const MAX_FILE_BYTES = Number(process.env.ERP_HEAL_MAX_FILE_BYTES || 20000);
const LLM_TIMEOUT_MS = Number(process.env.ERP_HEAL_LLM_TIMEOUT_S || 300) * 1000;
const HEAL_MODEL = process.env.ERP_HEAL_MODEL || 'deepseek-coder:6.7b';

const STATE_PATH = path.join(ROOT, 'logs', '.erp_healer_state.json');
const LEDGER_PATH = path.join(ROOT, 'logs', 'erp_heal_proposals.json');
const KILL_FILE = path.join(ROOT, 'ERP_HEALER.KILL');
const BACKUP_DIR = path.join(ROOT, 'backups', 'heal');

// stderr sources to tail (glob-free: explicit dirs, *.err.log inside)
const LOG_DIRS = [path.join(ROOT, 'logs'), path.join(ROOT, 'whatsapp-server', 'logs')];

// modules the healer may patch (after God approval)
const ALLOWED_DIRS = [ROOT, path.join(ROOT, 'scripts'), path.join(ROOT, 'whatsapp-server')];
const SELF_BAN = new Set([
  path.join(ROOT, 'scripts', 'erp_auto_healer.cjs').toLowerCase(),
  path.join(ROOT, 'scripts', 'erp_system_log.cjs').toLowerCase(),
]);

// error types worth a fix proposal; anything else *Error is logged, not healed
const HEAL_TYPES = new Set(['SyntaxError', 'TypeError', 'ReferenceError', 'RangeError']);

// module basename → restart recipe after an APPROVED apply (null = one-shot
// script, nothing to restart). bridge.cjs is relaunched via the idempotent
// stack launcher after the stale listener on :3000 is stopped.
const SERVICE_MAP = {
  'bridge.cjs': { port: 3000, script: path.join(ROOT, 'scripts', 'start-ai-stack.ps1') },
};

let TOKEN = process.env.MAMTA_BRIDGE_TOKEN || '';
try { TOKEN = TOKEN || (TOKEN_FILE ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : ''); } catch { /* logged at start */ }

// ── tiny utils ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

function loadJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
function tsStamp() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

function ledgerAppend(entry) {
  const rows = loadJson(LEDGER_PATH, []);
  rows.push(entry);
  saveJson(LEDGER_PATH, rows.slice(-500));
}
function ledgerSetStatus(pid, status, extra) {
  const rows = loadJson(LEDGER_PATH, []);
  for (const r of rows) if (r.id === pid) { r.status = status; Object.assign(r, extra || {}); }
  saveJson(LEDGER_PATH, rows);
}

// ── HTTP (native fetch, Node 18+) ────────────────────────────────────────────
async function post(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mamta-token': TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: res.status, json, text };
}

// ── DETECT ────────────────────────────────────────────────────────────────────
function allowedModule(p) {
  if (!p) return null;
  let abs;
  try { abs = path.resolve(String(p).trim()); } catch { return null; }
  const low = abs.toLowerCase();
  if (!/\.(cjs|mjs|js)$/.test(low)) return null;
  if (low.includes(`${path.sep}node_modules${path.sep}`)) return null;
  if (SELF_BAN.has(low)) return null;
  for (const dir of ALLOWED_DIRS) {
    const d = dir.toLowerCase();
    // root dir: direct children only (root *.cjs like bridge.cjs, toll-sync.cjs)
    if (path.dirname(low) === d || (d !== ROOT.toLowerCase() && low.startsWith(d + path.sep))) {
      return fs.existsSync(abs) ? abs : null;
    }
  }
  return null;
}

const ERR_LINE_RX = /^(?:Uncaught\s+)?([A-Z][A-Za-z]*(?:Error|Exception))(?:\s*\[[^\]]*\])?:\s?(.*)$/;
const FRAME_RX = /^\s+at\s+(?:.*?\()?([A-Za-z]:[^():]+|\/[^():]+):(\d+):\d+\)?\s*$/;
const HEADER_RX = /^([A-Za-z]:[^:*?"<>|\r\n]+\.(?:cjs|mjs|js)):(\d+)\r?$/;
const REJECTION_TAG_RX = /Unhandled(?:Promise)?Rejection/i;

// Parse raw stderr text into findings {excType, msg, file, line, tb}.
// Handles both shapes Node emits:
//   (a) "TypeError: x is not a function" followed by "    at ..." frames
//   (b) SyntaxError banner: "<file>:<line>" header, source echo, caret, then
//       "SyntaxError: msg" (no usable frames — the header carries file:line).
function parseFindings(text) {
  const findings = [];
  const lines = String(text).split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ERR_LINE_RX.exec(lines[i].trim());
    if (!m) continue;
    const excType = m[1];
    const msg = (m[2] || '').trim().slice(0, 300);

    // collect following stack frames
    let file = null, lineNo = null;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      const fm = FRAME_RX.exec(lines[j]);
      if (!fm) { if (/^\s+at\s/.test(lines[j])) { block.push(lines[j]); continue; } break; }
      block.push(lines[j]);
      if (!file) {
        const ok = allowedModule(fm[1]);
        if (ok) { file = ok; lineNo = Number(fm[2]); }
      }
    }
    // SyntaxError banner shape: look back a few lines for "<file>:<line>"
    if (!file) {
      for (let j = Math.max(0, i - 6); j < i; j++) {
        const hm = HEADER_RX.exec(lines[j] || '');
        if (hm) {
          const ok = allowedModule(hm[1]);
          if (ok) { file = ok; lineNo = Number(hm[2]); block.unshift(lines[j]); }
        }
      }
    }
    if (!file) continue; // error in a lib / foreign process — not our patient

    const isRejection = block.some((l) => REJECTION_TAG_RX.test(l))
      || REJECTION_TAG_RX.test(lines[Math.max(0, i - 1)] || '');
    findings.push({
      excType, msg, file, line: lineNo,
      rejection: isRejection,
      tb: block.join('\n').slice(-2000),
    });
  }
  return findings;
}

function detect(state) {
  const findings = [];
  state.offsets = state.offsets || {};
  const firstRun = Object.keys(state.offsets).length === 0;
  for (const dir of LOG_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.filter((n) => n.endsWith('.err.log')).sort()) {
      const file = path.join(dir, name);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      let pos = state.offsets[file];
      if (pos === undefined) {
        if (firstRun) { state.offsets[file] = size; continue; } // old pain is history
        pos = 0;                                                // log born after seeding
      } else if (pos > size) {
        pos = 0;                                                // rotation/truncation
      }
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(size - pos, 512 * 1024)); // bounded read
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        state.offsets[file] = pos + buf.length;
        for (const f of parseFindings(buf.toString('utf8'))) {
          f.source = name;
          findings.push(f);
        }
      }
    }
  }
  return findings;
}

// ── GUARDS + validation ──────────────────────────────────────────────────────
function rateOk(state, module) {
  const now = Date.now();
  state.rate = state.rate || {};
  const hist = (state.rate[module] || []).filter((t) => now - t < RATE_WINDOW_MS);
  state.rate[module] = hist;
  return hist.length < RATE_MAX;
}

// `node --check` beside the target so package.json module semantics match.
function nodeCheck(code, targetPath) {
  const tmp = path.join(path.dirname(targetPath),
    `.healcheck-${crypto.randomBytes(4).toString('hex')}${path.extname(targetPath)}`);
  try {
    fs.writeFileSync(tmp, code, 'utf8');
    return new Promise((resolve) => {
      execFile(process.execPath, ['--check', tmp], { timeout: 20000 },
        (err, _out, stderr) => resolve({ ok: !err, err: String(stderr || err || '').slice(0, 400) }));
    }).finally(() => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
    return Promise.resolve({ ok: false, err: String(e).slice(0, 400) });
  }
}

const FN_NAME_RX = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
function topFunctionNames(code) {
  const out = new Set();
  for (const m of String(code).matchAll(FN_NAME_RX)) out.add(m[1]);
  return out;
}

// Pre-HITL and pre-apply structure gate → {ok, why}. Syntax via nodeCheck.
async function validateFix(original, fix, targetPath) {
  if (!fix || !fix.trim()) return { ok: false, why: 'empty fix' };
  if (fix.trim() === original.trim()) return { ok: false, why: 'fix identical to original' };
  if (original.trim()) {
    if (fix.length > Math.max(original.length * 1.7, original.length + 600)) {
      return { ok: false, why: `fix too large (${fix.length} vs ${original.length} chars — LLM bloat?)` };
    }
    if (fix.length < original.length * 0.5) {
      return { ok: false, why: `fix too small (${fix.length} vs ${original.length} chars — truncation?)` };
    }
  }
  const chk = await nodeCheck(fix, targetPath);
  if (!chk.ok) return { ok: false, why: `node --check failed: ${chk.err}` };
  const lost = [...topFunctionNames(original)].filter((n) => !topFunctionNames(fix).has(n));
  if (lost.length) return { ok: false, why: `top-level functions lost: ${lost.slice(0, 5).join(', ')}` };
  return { ok: true, why: 'ok' };
}

// ── DRAFT ─────────────────────────────────────────────────────────────────────
const CODEBLOCK_RX = /```(?:javascript|js|cjs)?\s*\n([\s\S]*?)```/;
function extractCode(answer) {
  const m = CODEBLOCK_RX.exec(answer || '');
  return m ? m[1] : (answer || '');
}

async function draftFix(module, finding, original) {
  const basePrompt =
    'You are the auto-repair engineer for a Node.js (CommonJS) transport-ERP ' +
    'infrastructure script. A runtime error occurred. Fix ONLY the bug; keep ' +
    'every other line, name, comment and behavior EXACTLY as-is. This is INFRA ' +
    'code: handle the bad input correctly and FAIL LOUD on genuinely invalid ' +
    'data (throw with a clear message) — NEVER silently return a default, and ' +
    'NEVER add eval/new Function or destructive shell commands. Reply with the ' +
    'COMPLETE corrected file in ONE ```js code block. No explanations.\n\n' +
    `ERROR (${finding.excType} at line ${finding.line}):\n${finding.tb.slice(-1200)}\n\n` +
    `FULL CURRENT FILE (${path.basename(module)}):\n\`\`\`js\n${original}\n\`\`\``;
  let feedback = '';
  for (const attempt of [1, 2]) {
    let r;
    try {
      r = await post(`${BRIDGE}/ask`,
        { prompt: basePrompt + feedback, model: HEAL_MODEL, token: TOKEN }, LLM_TIMEOUT_MS);
    } catch (e) {
      slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_LLM_UNREACHABLE'],
        extra: { module: path.basename(module), err: String(e).slice(0, 200) } });
      return { fix: null, attempts: attempt };
    }
    if (r.status !== 200 || !r.json) {
      slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_LLM_HTTP'],
        extra: { module: path.basename(module), status: r.status } });
      return { fix: null, attempts: attempt };
    }
    const fix = extractCode(r.json.answer || '');
    const v = await validateFix(original, fix, module);
    if (v.ok) return { fix, attempts: attempt };
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_DRAFT_INVALID'],
      extra: { module: path.basename(module), attempt, why: v.why.slice(0, 200) } });
    feedback = `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${v.why}. ` +
               'Return the COMPLETE corrected file again.';
  }
  return { fix: null, attempts: 2 };
}

// ── PROPOSE ───────────────────────────────────────────────────────────────────
async function propose(state, finding) {
  const module = finding.file;
  const rel = path.relative(ROOT, module);
  const sig = sha1(`${rel}|${finding.excType}|${finding.line}|${finding.msg.slice(0, 120)}`);
  state.sigs = state.sigs || {};
  const prev = state.sigs[sig];
  if (prev && Date.now() - (prev.ts || 0) < SIG_COOLDOWN_MS) return; // loop prevention

  if (!HEAL_TYPES.has(finding.excType)) {
    slog(AGENT, 'MEASURE', { cycle: 'heal',
      extra: { event_detail: 'HEAL_OBSERVED_ONLY', module: rel, exc: finding.excType,
               note: 'outside SyntaxError/TypeError/ReferenceError/RangeError heal scope' } });
    state.sigs[sig] = { ts: Date.now(), status: 'OBSERVED_ONLY' };
    return;
  }
  if (!rateOk(state, rel)) {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_RATE_LIMITED'],
      extra: { module: rel, limit: `${RATE_MAX}/h` } });
    state.sigs[sig] = { ts: Date.now(), status: 'RATE_LIMITED' };
    return;
  }
  let original;
  try { original = fs.readFileSync(module, 'utf8'); } catch (e) {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_READ_FAIL'],
      extra: { module: rel, err: String(e).slice(0, 150) } });
    return;
  }
  if (Buffer.byteLength(original) > MAX_FILE_BYTES) {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_SKIP_TOOLARGE'],
      extra: { module: rel, bytes: Buffer.byteLength(original), cap: MAX_FILE_BYTES,
               note: 'full-file LLM rewrite unsafe at this size — manual/God review needed' } });
    state.sigs[sig] = { ts: Date.now(), status: 'TOO_LARGE' };
    return;
  }

  state.rate[rel].push(Date.now());
  slog(AGENT, 'MEASURE', { cycle: 'heal',
    extra: { event_detail: 'HEAL_DETECTED', module: rel, exc: finding.excType,
             line: finding.line, rejection: !!finding.rejection, src: finding.source } });

  const { fix, attempts } = await draftFix(module, finding, original);
  if (!fix) {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_DRAFT_FAIL'],
      extra: { module: rel, attempts } });
    state.sigs[sig] = { ts: Date.now(), status: 'DRAFT_FAIL' };
    return;
  }

  const purpose = `[${PROJECT}] AUTO-HEAL [infra module, not a strategy] ${rel}: ` +
                  `${finding.excType} line ${finding.line} — ${finding.msg.slice(0, 120)}`;
  let res = { status: 0, json: null };
  try {
    res = await post(`${BRIDGE}/propose`, {
      kind: 'js', code: fix, purpose: purpose.slice(0, 500),
      leg: `heal|${path.basename(module)}`.slice(0, 40),
      source_agent: AGENT, token: TOKEN,
    }, LLM_TIMEOUT_MS);
  } catch (e) {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_PROPOSE_FAIL'],
      extra: { module: rel, err: String(e).slice(0, 200) } });
    return; // sig NOT stamped — retried next cycle when the bridge is back
  }
  const body = res.json || {};
  const pid = body.id || '';
  const status = body.status || `http ${res.status}`;
  state.sigs[sig] = { ts: Date.now(), pid, status };

  const linesArr = original.split('\n');
  const lo = Math.max(0, (finding.line || 1) - 11);
  ledgerAppend({
    project: PROJECT, id: pid, module: rel, line_no: finding.line,
    traceback: finding.tb, original_sha: sha1(original),
    original_snippet: linesArr.slice(lo, (finding.line || 1) + 10).join('\n'),
    proposed_fix: fix, status,
    ts: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('Z', '+05:30'),
  });

  if (status === 'PENDING_APPROVAL') {
    state.tracked = state.tracked || {};
    state.tracked[pid] = { module: rel, orig_sha: sha1(original), sig };
    slogBoth(AGENT, 'PROPOSE', { cycle: 'heal', rule_refs: ['#13', '#15'],
      leg: `heal|${path.basename(module)}`,
      extra: { event_detail: 'HEAL_PROPOSED', proposal_id: pid, project: PROJECT,
               module: rel, line: finding.line, exc: finding.excType,
               llm_attempts: attempts, approval: 'PENDING' } });
  } else {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_DEBATE_REJECTED'],
      extra: { proposal_id: pid, module: rel, status } });
  }
}

// ── EXECUTE (God decision handler) ───────────────────────────────────────────
function restartService(basename) {
  const svc = SERVICE_MAP[basename];
  if (!svc) return Promise.resolve({ restarted: false, msg: 'no mapped daemon' });
  const ps =
    `$c = Get-NetTCPConnection -State Listen -LocalPort ${svc.port} -ErrorAction SilentlyContinue; ` +
    'if ($c) { Stop-Process -Id $c[0].OwningProcess -Force }; ' +
    `& '${svc.script}'`;
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 90000 },
      (err, out, stderr) => resolve({
        restarted: !err,
        msg: String(err ? (stderr || err) : (out || 'ok')).slice(0, 200),
      }));
  });
}

async function applyApproved(state) {
  const tracked = state.tracked || {};
  if (!Object.keys(tracked).length) return;
  const approvals = loadJson(APPROVALS, {});
  for (const pid of Object.keys(tracked)) {
    const info = tracked[pid];
    const p = approvals[pid];
    if (!p) continue;
    const status = p.status || '';
    if (status === 'PENDING_APPROVAL') continue;
    if (status === 'REJECTED_BY_GOD') {
      ledgerSetStatus(pid, 'DISCARDED', { rejection_reason: p.rejection_reason || '' });
      slogBoth(AGENT, 'VERIFY', { cycle: 'heal',
        extra: { event_detail: 'HEAL_DISCARDED', proposal_id: pid,
                 module: info.module, approval: 'REJECTED' } });
      delete tracked[pid];
      continue;
    }
    if (status !== 'GOD_APPROVED' && status !== 'GOD_APPROVED_OVERRIDE') continue;

    let code = p.code || '';
    if (status === 'GOD_APPROVED_OVERRIDE') {
      code = (p.override || {}).code || '';
      if (code.length >= 9990) { // decide() truncates override.code at 10k
        ledgerSetStatus(pid, 'OVERRIDE_TRUNCATED');
        slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_OVERRIDE_TRUNCATED'],
          extra: { proposal_id: pid, module: info.module } });
        delete tracked[pid];
        continue;
      }
    }
    const module = path.join(ROOT, info.module);
    let current;
    try { current = fs.readFileSync(module, 'utf8'); } catch { delete tracked[pid]; continue; }
    if (sha1(current) !== info.orig_sha) {
      ledgerSetStatus(pid, 'STALE_SKIPPED');
      slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_STALE_SKIP'],
        extra: { proposal_id: pid, module: info.module,
                 why: 'file changed since proposal — refusing apply' } });
      delete tracked[pid];
      continue;
    }
    const v = await validateFix(current, code, module);
    if (!v.ok) {
      ledgerSetStatus(pid, 'APPLY_GUARD_FAIL', { why: v.why });
      slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_APPLY_GUARD_FAIL'],
        extra: { proposal_id: pid, module: info.module, why: v.why.slice(0, 200) } });
      delete tracked[pid];
      continue;
    }

    // timestamped backup → atomic overwrite → node --check → rollback on fail
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, `${path.basename(module)}.bak-${tsStamp()}`);
    fs.copyFileSync(module, bak);
    const tmp = module + '.healtmp';
    fs.writeFileSync(tmp, code, 'utf8');
    fs.renameSync(tmp, module);
    const applied = await nodeCheck(fs.readFileSync(module, 'utf8'), module);
    if (!applied.ok) {
      fs.copyFileSync(bak, module); // instant rollback
      ledgerSetStatus(pid, 'ROLLED_BACK', { why: applied.err });
      slogBoth(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_ROLLBACK'],
        extra: { proposal_id: pid, module: info.module,
                 bak: path.basename(bak), err: applied.err } });
      delete tracked[pid];
      continue;
    }

    const r = await restartService(path.basename(module));
    ledgerSetStatus(pid, 'APPLIED',
      { bak: path.basename(bak), restarted: r.restarted, restart_msg: r.msg });
    slogBoth(AGENT, 'VERIFY', { cycle: 'heal', rule_refs: ['#13', '#15'],
      extra: { event_detail: 'HEAL_APPLIED', proposal_id: pid, project: PROJECT,
               module: info.module, bak: path.basename(bak),
               restarted: r.restarted, restart_msg: r.msg, approval: status } });
    delete tracked[pid];
  }
}

// ── main loop ─────────────────────────────────────────────────────────────────
async function cycle(state) {
  if (fs.existsSync(KILL_FILE)) {
    if (!state.killLogged) {
      state.killLogged = true;
      slogBoth(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEALER_KILL_SWITCH'],
        extra: { event_detail: 'HEALER_PAUSED', kill_file: KILL_FILE } });
    }
    return;
  }
  if (state.killLogged) {
    state.killLogged = false;
    slog(AGENT, 'GATE_PASS', { cycle: 'heal', extra: { event_detail: 'HEALER_RESUMED' } });
  }
  for (const finding of detect(state)) await propose(state, finding);
  await applyApproved(state);
}

async function main() {
  const once = process.argv.includes('--once');
  const state = loadJson(STATE_PATH, {});
  slogBoth(AGENT, 'MEASURE', { cycle: 'heal',
    extra: { event_detail: 'HEALER_START', project: PROJECT, poll_s: POLL_S,
             rate: `${RATE_MAX}/module/h`, mode: 'HITL-only', bridge: BRIDGE,
             token_loaded: !!TOKEN, model: HEAL_MODEL,
             law: 'AI proposes, God disposes' } });
  if (!TOKEN) {
    slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEAL_NO_TOKEN'],
      extra: { note: `bridge token missing — set MAMTA_BRIDGE_TOKEN or ${TOKEN_FILE}` } });
  }
  for (;;) {
    try {
      await cycle(state);
    } catch (e) { // healer must survive its own bad cycle
      slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEALER_CYCLE_ERROR'],
        extra: { err: `${e && e.name}: ${String(e && e.message).slice(0, 200)}` } });
    }
    saveJson(STATE_PATH, state);
    if (once) return;
    await sleep(POLL_S * 1000);
  }
}

process.on('unhandledRejection', (e) => {
  slog(AGENT, 'GATE_FAIL', { cycle: 'heal', fail_codes: ['HEALER_UNHANDLED'],
    extra: { err: String(e).slice(0, 200) } });
});

// ── self-test (offline: parser + guards, no bridge, no writes to real files) ──
async function selfTest() {
  const assert = require('assert');
  const target = path.join(ROOT, 'scripts', 'erp_api_shield.cjs'); // real, allowed

  // 1. stack-trace parsing → allowed frame wins
  const tb = [
    'TypeError: Cannot read properties of undefined (reading \'rows\')',
    `    at doSync (${target}:42:15)`,
    `    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`,
  ].join('\n');
  const f1 = parseFindings(tb);
  assert.strictEqual(f1.length, 1);
  assert.strictEqual(f1[0].excType, 'TypeError');
  assert.strictEqual(f1[0].file.toLowerCase(), target.toLowerCase());
  assert.strictEqual(f1[0].line, 42);
  console.log('[1/6] stack-frame parse           PASS');

  // 2. SyntaxError banner shape (file:line header, no frames)
  const tb2 = `${target}:7\nconst x = {;\n          ^\n\nSyntaxError: Unexpected token ';'\n`;
  const f2 = parseFindings(tb2);
  assert.strictEqual(f2.length, 1);
  assert.strictEqual(f2[0].excType, 'SyntaxError');
  assert.strictEqual(f2[0].line, 7);
  console.log('[2/6] syntax-banner parse         PASS');

  // 3. node_modules / foreign / self frames are ignored
  const junk = [
    'ReferenceError: x is not defined',
    `    at foo (${path.join(ROOT, 'node_modules', 'axios', 'lib', 'core.js')}:10:1)`,
    'TypeError: nope',
    `    at bar (${path.join(ROOT, 'scripts', 'erp_auto_healer.cjs')}:5:1)`,
  ].join('\n');
  assert.strictEqual(parseFindings(junk).length, 0);
  console.log('[3/6] guard-banned frames         PASS');

  // 4. validateFix: node --check catches broken fix
  const orig = 'function a() { return 1; }\nmodule.exports = { a };\n';
  const bad = await validateFix(orig, 'function a( { return 1; }\n' + '/* pad */'.repeat(3), target);
  assert.strictEqual(bad.ok, false);
  console.log('[4/6] validate: syntax gate       PASS', '—', bad.why.slice(0, 60));

  // 5. validateFix: lost function rejected
  const lost = await validateFix(orig, 'const b = 2;\nmodule.exports = { b };\n', target);
  assert.strictEqual(lost.ok, false);
  assert.match(lost.why, /lost/);
  console.log('[5/6] validate: anti-truncation   PASS');

  // 6. validateFix: honest fix passes
  const good = await validateFix(orig, 'function a() { return 2; }\nmodule.exports = { a };\n', target);
  assert.strictEqual(good.ok, true, good.why);
  console.log('[6/6] validate: good fix          PASS');

  console.log('ERP AUTO-HEALER self-test: ALL PASS');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    selfTest().catch((e) => { console.error('SELF-TEST FAIL:', e); process.exit(1); });
  } else {
    main().catch((e) => { console.error('HEALER FATAL:', e); process.exit(1); });
  }
}

module.exports = { parseFindings, allowedModule, validateFix };
