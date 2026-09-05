// server/ai/router.js
// ─────────────────────────────────────────────────────────────────────────────
// Hybrid AI Router — one gate for every AI call the ERP makes.
//
// Routing policy (privacy first):
//   LOCAL lane   OCR of business documents, ledger analysis — anything that
//                carries customer money or KYC. Runs on the local engine
//                (Ollama on this PC; model set by LOCAL_AI_MODEL, so DeepSeek
//                or Gemma is a .env change, not a code change).
//                STRICT CONCURRENCY = 1: the RTX 3060 serves one generation at
//                a time; a second concurrent load would page out the model and
//                double every latency. Tasks queue in-process, in order.
//
//   CLOUD lane   Asynchronous, non-document work (CRM drafting) — routed to
//                the cloud engine when configured.
//
// OFFLINE FALLBACK GUARD — the contract this module exists for:
//   The local PC being off must never crash a caller. When the local engine is
//   unreachable, a local-lane task either
//     (a) PARKS: becomes a durable ai_tasks row, drained when the engine
//         returns (the default for privacy tasks — they wait for local), or
//     (b) FALLS BACK to the cloud engine — only when the task was marked
//         lane 'either' AND a cloud key is configured AND
//         AI_ALLOW_CLOUD_FALLBACK=1. Privacy demotion is an explicit opt-in,
//         never an automatic convenience.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
// The old default was gemma4:12b — a model that cannot exist on a 1.9 GB box,
// and one that any stray call would try to PULL (8 GB) onto a disk with 12 GB
// free. The default is now the small model that is actually installed where a
// local engine exists at all; the 12B/14B work goes to HEAVY below.
const LOCAL_MODEL = process.env.LOCAL_AI_MODEL ?? process.env.OCR_VISION_MODEL ?? 'gemma3:270m';
const CLOUD_FALLBACK = process.env.AI_ALLOW_CLOUD_FALLBACK === '1';
const HEALTH_TTL_MS = 10_000;

// ── HEAVY lane — the Local 32 GB PC (deepseek-r1:14b) ───────────────────────
// These four env names existed on the AWS box for weeks and were read by NO
// code (see docs/RND-HYBRID-ARCHITECTURE-2026-09-06.md §0). This is the wiring.
// The PC is reached over HTTPS through the tunnel host; it never touches
// Postgres, which BAGALAMUKHI's db_stays_loopback_or_vpc invariant forbids.
const HEAVY_URL = (process.env.OLLAMA_HEAVY_URL ?? '').replace(/\/$/, '');
const HEAVY_MODEL = process.env.OLLAMA_HEAVY_MODEL ?? 'deepseek-r1:14b';
const HEAVY_TOKEN = process.env.OLLAMA_HEAVY_TOKEN ?? '';
// Below this many characters the work is not worth a round trip to the PC.
const HEAVY_CHAR_THRESHOLD = Number(process.env.OLLAMA_HEAVY_CHAR_THRESHOLD ?? '1500');
const HEAVY_MAX_INFLIGHT = Number(process.env.OLLAMA_HEAVY_MAX_INFLIGHT ?? '2');
const HEAVY_TIMEOUT_MS = Number(process.env.OLLAMA_HEAVY_TIMEOUT_MS ?? '180000');
let heavyInflight = 0;
let heavyProbe = { at: 0, up: false, detail: HEAVY_URL ? 'never probed' : 'OLLAMA_HEAVY_URL not set' };

const heavyHeaders = () => ({ 'content-type': 'application/json', ...(HEAVY_TOKEN ? { authorization: `Bearer ${HEAVY_TOKEN}` } : {}) });

/** Is the 32 GB PC answering right now? Cached, one probe per 10 s. */
export async function heavyEngineUp() {
  if (!HEAVY_URL) return false;
  if (Date.now() - heavyProbe.at < HEALTH_TTL_MS) return heavyProbe.up;
  try {
    const res = await fetch(`${HEAVY_URL}/api/version`, { headers: heavyHeaders(), signal: AbortSignal.timeout(4000) });
    // A tunnel hostname that resolves but has nothing behind it answers 404 —
    // that is DOWN, not up. Only a 2xx with a version counts.
    const body = res.ok ? await res.json().catch(() => ({})) : null;
    heavyProbe = { at: Date.now(), up: !!res.ok, detail: res.ok ? `ollama ${body?.version ?? '?'} @ ${HEAVY_URL}` : `HTTP ${res.status} from ${HEAVY_URL}` };
  } catch (err) {
    heavyProbe = { at: Date.now(), up: false, detail: err.message };
  }
  return heavyProbe.up;
}

async function callHeavy({ prompt, images, format, timeoutMs, model }) {
  const res = await fetch(`${HEAVY_URL}/api/generate`, {
    method: 'POST',
    headers: heavyHeaders(),
    body: JSON.stringify({
      model: model ?? HEAVY_MODEL, prompt, images, format, stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(timeoutMs ?? HEAVY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`heavy ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return { engine: `heavy:${model ?? HEAVY_MODEL}`, tier: 'HEAVY_LOCAL_PC', text: json.response };
}

/** Any engine at all — heavy PC or an on-box one. Callers use this to decide
 *  whether an enrichment pass is worth attempting. */
export async function engineUp() {
  return (await heavyEngineUp()) || (await localEngineUp());
}

// ── Local engine health (cached — one probe per 10s, not per task) ──────────
let lastProbe = { at: 0, up: false, detail: 'never probed' };
export async function localEngineUp() {
  if (Date.now() - lastProbe.at < HEALTH_TTL_MS) return lastProbe.up;
  try {
    const res = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(3000) });
    lastProbe = { at: Date.now(), up: res.ok, detail: res.ok ? `ollama ${(await res.json()).version}` : `HTTP ${res.status}` };
  } catch (err) {
    lastProbe = { at: Date.now(), up: false, detail: err.message };
  }
  return lastProbe.up;
}

// ── The 1-at-a-time local queue ─────────────────────────────────────────────
// A promise chain, not a semaphore library: tail always points at the last
// scheduled task, every new task awaits the previous tail. FIFO, concurrency 1.
let tail = Promise.resolve();
let queueDepth = 0;
let localStats = { done: 0, failed: 0, parked: 0, cloudFallbacks: 0, heavy: 0, heavyFailed: 0 };

function enqueueLocal(fn) {
  queueDepth++;
  const run = tail.then(fn).finally(() => { queueDepth--; });
  // The chain must survive a rejected task — swallow here; callers still get
  // the real rejection from `run`.
  tail = run.catch(() => {});
  return run;
}

// ── Engines ─────────────────────────────────────────────────────────────────
async function callOllama({ prompt, images, format, timeoutMs, model }) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Per-task model: DeepSeek parses OCR text, gemma4 handles vision — both
      // local, both queued 1-at-a-time through the same gate.
      model: model ?? LOCAL_MODEL, prompt, images, format, stream: false,
      options: { temperature: 0.1 },
      // keep_alive default (per PC env) keeps the model warm between tasks
    }),
    signal: AbortSignal.timeout(timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return { engine: `local:${model ?? LOCAL_MODEL}`, text: json.response };
}

// DeepSeek's cloud API is OpenAI-compatible, so it needs no SDK — plain fetch
// keeps the 1.9 GB box free of another dependency. Preferred when its key is
// present; Anthropic remains the second cloud option. Text only: a vision
// prompt (images present) skips this and goes to Anthropic.
async function callDeepSeekCloud({ prompt, timeoutMs }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('no DEEPSEEK_API_KEY');
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, stream: false }),
    signal: AbortSignal.timeout(timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return { engine: `cloud:${model}`, tier: 'CLOUD', text: json.choices?.[0]?.message?.content ?? '' };
}

async function callCloud({ prompt, images, mimeType, timeoutMs }) {
  if (!(images?.length) && process.env.DEEPSEEK_API_KEY) {
    try { return await callDeepSeekCloud({ prompt, timeoutMs }); }
    catch (err) { if (!process.env.ANTHROPIC_API_KEY) throw err; /* else try Anthropic */ }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('sk-ant-your')) throw new Error('cloud engine not configured (no DEEPSEEK_API_KEY or ANTHROPIC_API_KEY)');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key, timeout: timeoutMs ?? 60_000 });
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
  const content = [];
  for (const img of images ?? []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mimeType ?? 'image/png', data: img } });
  }
  content.push({ type: 'text', text: prompt });
  const msg = await client.messages.create({ model, max_tokens: 1500, messages: [{ role: 'user', content }] });
  return { engine: `cloud:${model}`, text: msg.content.find((b) => b.type === 'text')?.text ?? '' };
}

// ── Durable parking (the offline queue) ─────────────────────────────────────
async function parkTask(kind, lane, payload, reason) {
  localStats.parked++;
  if (isDegraded()) {
    // No engine AND no database — the caller gets the honest failure.
    const e = new Error(`local AI offline (${reason}) and database degraded — task cannot be parked`);
    e.code = 'AI_UNAVAILABLE';
    throw e;
  }
  const { rows } = await query(
    `INSERT INTO ai_tasks (kind, lane, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [kind, lane, JSON.stringify(payload)]
  );
  return { parked: true, task_id: rows[0].id, reason: `local engine offline (${reason}) — task queued durably, drains when the engine returns` };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run an AI task.
 *
 * @param {string} kind      'ocr_extract' | 'ledger_audit' | 'crm_reply' | ...
 * @param {object} req       { prompt, images?, format?, mimeType?, timeoutMs? }
 * @param {object} opts      { lane: 'local'|'cloud'|'either', parkable: bool }
 * @returns {engine, text} on execution, or {parked, task_id} when queued offline.
 */
export async function run(kind, req, { lane = 'local', parkable = true } = {}) {
  if (lane === 'cloud') {
    return callCloud(req);
  }

  // ── Tier 1: the 32 GB PC ──────────────────────────────────────────────
  // Preferred for anything substantial. Small prompts stay on-box (a round
  // trip to a home DSL line costs more than a 270m model does locally), and
  // no more than HEAVY_MAX_INFLIGHT run at once so a slow PC cannot pile up
  // requests inside the 1.9 GB API process.
  const bigEnough = (req?.prompt?.length ?? 0) >= HEAVY_CHAR_THRESHOLD || (req?.images?.length ?? 0) > 0;
  if (bigEnough && heavyInflight < HEAVY_MAX_INFLIGHT && await heavyEngineUp()) {
    heavyInflight++;
    try {
      const out = await callHeavy(req);
      localStats.heavy++;
      return out;
    } catch (err) {
      localStats.heavyFailed++;
      heavyProbe = { at: Date.now(), up: false, detail: err.message };
      // fall through to the on-box engine / cloud / parking
    } finally { heavyInflight--; }
  }

  if (await localEngineUp()) {
    // Local engine alive → strict 1-at-a-time queue.
    try {
      const out = await enqueueLocal(() => callOllama(req));
      localStats.done++;
      return out;
    } catch (err) {
      localStats.failed++;
      // A mid-task engine death re-evaluates like an offline start.
      lastProbe = { at: Date.now(), up: false, detail: err.message };
      return handleOffline(kind, req, lane, parkable, err.message);
    }
  }
  return handleOffline(kind, req, lane, parkable, lastProbe.detail);
}

async function handleOffline(kind, req, lane, parkable, reason) {
  // Cloud fallback: explicit lane permission + explicit env opt-in + key.
  if (lane === 'either' && CLOUD_FALLBACK) {
    try {
      const out = await callCloud(req);
      localStats.cloudFallbacks++;
      return out;
    } catch { /* fall through to parking */ }
  }
  if (parkable) {
    // Images can be large; the parked payload keeps everything needed to
    // replay the call verbatim when the engine returns.
    return parkTask(kind, lane, { req }, reason);
  }
  const e = new Error(`local AI engine unreachable: ${reason}`);
  e.code = 'AI_UNAVAILABLE';
  throw e;
}

/**
 * Drain parked tasks — called from BHUVANESHWARI's 20s loop tick. Claims with
 * SKIP LOCKED (multi-instance safe), replays through the same run() gate, and
 * records the result on the row.
 */
export async function drainParked(batch = 3) {
  if (isDegraded() || !(await engineUp())) return 0;
  const { rows } = await query('SELECT * FROM claim_ai_tasks($1, $2)', ['local', batch]);
  let done = 0;
  for (const task of rows) {
    try {
      const req = task.payload?.req ?? {};
      // Replay through the same gate so a parked task drains to whichever tier
      // is alive now — the 32 GB PC first, this box second.
      const out = await run(task.kind ?? 'parked', req, { lane: task.lane ?? 'local', parkable: false });
      await query(
        `UPDATE ai_tasks SET status = 'DONE', engine_used = $2, result = $3::jsonb, finished_at = now() WHERE id = $1`,
        [task.id, out.engine, JSON.stringify({ text: out.text?.slice(0, 100_000) })]
      );
      done++;
    } catch (err) {
      await query(
        `UPDATE ai_tasks SET status = CASE WHEN attempts >= 5 THEN 'DEAD' ELSE 'FAILED' END,
                last_error = $2, finished_at = now() WHERE id = $1`,
        [task.id, String(err.message).slice(0, 1000)]
      );
    }
  }
  return done;
}

/** Telemetry for the fleet dashboard. */
export async function aiStats() {
  let queue = { pending: 0, running: 0, dead: 0 };
  if (!isDegraded()) {
    try {
      const { rows } = await query(
        `SELECT lower(status) s, count(*)::int n FROM ai_tasks GROUP BY 1`
      );
      for (const r of rows) if (r.s in queue) queue[r.s] = r.n;
    } catch { /* table may not exist mid-migration */ }
  }
  return {
    heavy_engine: { configured: !!HEAVY_URL, up: heavyProbe.up, url: HEAVY_URL || null, model: HEAVY_MODEL, inflight: heavyInflight, detail: heavyProbe.detail },
    local_engine: { up: lastProbe.up, model: LOCAL_MODEL, detail: lastProbe.detail },
    cloud: { deepseek: !!process.env.DEEPSEEK_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY, fallback_enabled: CLOUD_FALLBACK },
    in_process_queue_depth: queueDepth,
    counters: localStats,
    durable_queue: queue,
  };
}

export default { run, drainParked, aiStats, localEngineUp, heavyEngineUp, engineUp };
