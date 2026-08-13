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
const LOCAL_MODEL = process.env.LOCAL_AI_MODEL ?? process.env.OCR_VISION_MODEL ?? 'gemma4:12b';
const CLOUD_FALLBACK = process.env.AI_ALLOW_CLOUD_FALLBACK === '1';
const HEALTH_TTL_MS = 10_000;

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
let localStats = { done: 0, failed: 0, parked: 0, cloudFallbacks: 0 };

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

async function callCloud({ prompt, images, mimeType, timeoutMs }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('sk-ant-your')) throw new Error('cloud engine not configured (no ANTHROPIC_API_KEY)');
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
  if (isDegraded() || !(await localEngineUp())) return 0;
  const { rows } = await query('SELECT * FROM claim_ai_tasks($1, $2)', ['local', batch]);
  let done = 0;
  for (const task of rows) {
    try {
      const req = task.payload?.req ?? {};
      const out = await enqueueLocal(() => callOllama(req));
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
    local_engine: { up: lastProbe.up, model: LOCAL_MODEL, detail: lastProbe.detail },
    cloud_fallback_enabled: CLOUD_FALLBACK,
    in_process_queue_depth: queueDepth,
    counters: localStats,
    durable_queue: queue,
  };
}

export default { run, drainParked, aiStats, localEngineUp };
