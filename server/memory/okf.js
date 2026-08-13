// server/memory/okf.js
// ─────────────────────────────────────────────────────────────────────────────
// OKF Dual-Memory Engine — Operational Knowledge Fabric for the Mahavidya swarm.
//
//   STM (short-term)  in-process, per-agent ring buffers + TTL key-values.
//                     Live trip context, scan-in-progress state, active alerts,
//                     the last N decisions. Fast, bounded, lost on restart —
//                     by design: STM is working memory, not a record.
//
//   LTM (long-term)   PostgreSQL (`okf_ltm`, migration 003). Audit summaries,
//                     freight trends, scan metadata, keyed facts. Survives
//                     restarts, queryable by agent/kind/recency.
//
// The boundary rule: anything an auditor might ask about goes to LTM; anything
// only the *next few seconds* of processing needs stays in STM. When the
// database is degraded, LTM writes queue into a bounded spill buffer and flush
// on reconnect — memory degrades, it does not silently vanish.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded, DbUnavailableError } from '../db/pool.js';

const STM_RING_CAP = Number.parseInt(process.env.OKF_STM_RING ?? '200', 10);
const STM_KV_CAP = Number.parseInt(process.env.OKF_STM_KV ?? '500', 10);
const LTM_SPILL_CAP = Number.parseInt(process.env.OKF_LTM_SPILL ?? '1000', 10);

// ── STM ─────────────────────────────────────────────────────────────────────

/** One STM bank per agent, created lazily. */
const banks = new Map();

function bank(agentId) {
  let b = banks.get(agentId);
  if (!b) {
    b = {
      ring: [],            // [{at, kind, data}] — newest last, capped
      kv: new Map(),       // key -> {value, expiresAt|null}
      reads: 0,
      writes: 0,
    };
    banks.set(agentId, b);
  }
  return b;
}

/** Record a transient observation (decision, alert, scan step). */
export function stmPush(agentId, kind, data) {
  const b = bank(agentId);
  b.writes++;
  b.ring.push({ at: Date.now(), kind, data });
  if (b.ring.length > STM_RING_CAP) b.ring.splice(0, b.ring.length - STM_RING_CAP);
}

/** Read recent observations, newest first. */
export function stmRecent(agentId, { kind, limit = 20 } = {}) {
  const b = bank(agentId);
  b.reads++;
  const items = kind ? b.ring.filter((r) => r.kind === kind) : b.ring;
  return items.slice(-limit).reverse();
}

/** Set a working-memory value with optional TTL (ms). */
export function stmSet(agentId, key, value, ttlMs = null) {
  const b = bank(agentId);
  b.writes++;
  // Evict expired first; then oldest-inserted if still over cap. Map iteration
  // order is insertion order, which makes FIFO eviction one line.
  if (b.kv.size >= STM_KV_CAP) {
    const now = Date.now();
    for (const [k, v] of b.kv) {
      if (v.expiresAt && v.expiresAt < now) b.kv.delete(k);
    }
    while (b.kv.size >= STM_KV_CAP) b.kv.delete(b.kv.keys().next().value);
  }
  b.kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
}

export function stmGet(agentId, key) {
  const b = bank(agentId);
  b.reads++;
  const hit = b.kv.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt && hit.expiresAt < Date.now()) {
    b.kv.delete(key);
    return undefined;
  }
  return hit.value;
}

// ── LTM ─────────────────────────────────────────────────────────────────────

// Bounded spill buffer for degraded mode. Oldest entries drop first once the
// cap is hit — with a loud one-time warning, because dropping memory silently
// is exactly what OKF exists to prevent.
const spill = [];
let spillWarned = false;

/**
 * Remember durably. `memKey` makes the fact upsertable (one live value per
 * agent+key, prior value expired rather than deleted).
 */
export async function ltmRemember(agentId, kind, payload, { memKey = null, importance = 5, ttlDays = null } = {}) {
  const row = { agentId, kind, payload, memKey, importance, ttlDays };
  if (isDegraded()) return spillPush(row);
  try {
    await ltmWrite(row);
    return { stored: true, spilled: false };
  } catch (err) {
    if (err instanceof DbUnavailableError) return spillPush(row);
    throw err;
  }
}

async function ltmWrite({ agentId, kind, payload, memKey, importance, ttlDays }) {
  if (memKey) {
    // Expire the previous keyed value in the same statement batch as the new
    // insert so recall never sees two live values for one key.
    await query(
      `UPDATE okf_ltm SET expires_at = now()
        WHERE agent_id = $1 AND mem_key = $2 AND expires_at IS NULL`,
      [agentId, memKey]
    );
  }
  await query(
    `INSERT INTO okf_ltm (agent_id, kind, mem_key, payload, importance, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5,
             CASE WHEN $6::int IS NULL THEN NULL
                  ELSE now() + make_interval(days => $6::int) END)`,
    [agentId, kind, memKey, JSON.stringify(payload), importance, ttlDays]
  );
}

function spillPush(row) {
  if (spill.length >= LTM_SPILL_CAP) {
    spill.shift();
    if (!spillWarned) {
      spillWarned = true;
      console.warn(`[okf] LTM spill buffer full (${LTM_SPILL_CAP}) — oldest unflushed memories are being dropped`);
    }
  }
  spill.push(row);
  return { stored: false, spilled: true, backlog: spill.length };
}

/** Flush spilled memories once the database is back. Called by the loop engine. */
export async function ltmFlushSpill() {
  if (!spill.length || isDegraded()) return 0;
  let flushed = 0;
  while (spill.length) {
    const row = spill[0];
    try {
      await ltmWrite(row);
      spill.shift();
      flushed++;
    } catch {
      break; // still unhealthy; retry next tick
    }
  }
  if (flushed) {
    spillWarned = false;
    console.log(`[okf] flushed ${flushed} spilled memories to LTM`);
  }
  return flushed;
}

/** Recall recent durable memories for an agent. */
export async function ltmRecall(agentId, { kind = null, limit = 20 } = {}) {
  if (isDegraded()) return [];
  const { rows } = await query(
    `SELECT kind, mem_key, payload, importance, created_at
       FROM okf_ltm
      WHERE agent_id = $1
        AND ($2::text IS NULL OR kind = $2)
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT $3`,
    [agentId, kind, limit]
  );
  return rows;
}

/** Read one keyed fact. */
export async function ltmFact(agentId, memKey) {
  if (isDegraded()) return null;
  const { rows } = await query(
    `SELECT payload, created_at FROM okf_ltm
      WHERE agent_id = $1 AND mem_key = $2 AND expires_at IS NULL
      LIMIT 1`,
    [agentId, memKey]
  );
  return rows[0] ?? null;
}

// ── Telemetry ───────────────────────────────────────────────────────────────

let ltmCounts = new Map();   // agent_id -> row count (refreshed lazily)
let ltmCountsAt = 0;

async function refreshLtmCounts() {
  if (isDegraded()) return;
  try {
    const { rows } = await query(
      `SELECT agent_id, count(*)::int AS n FROM okf_ltm
        WHERE expires_at IS NULL OR expires_at > now()
        GROUP BY agent_id`
    );
    ltmCounts = new Map(rows.map((r) => [r.agent_id, r.n]));
    ltmCountsAt = Date.now();
  } catch { /* keep last known counts */ }
}

/**
 * Per-agent memory stats for the fleet-status endpoint. Usage percentages are
 * against the configured caps (STM) and a soft display ceiling (LTM) — they
 * exist to show *pressure*, not to enforce anything.
 */
export async function memoryStats(agentIds) {
  if (Date.now() - ltmCountsAt > 30_000) await refreshLtmCounts();
  const LTM_SOFT_CEILING = 10_000; // display scale only

  const out = {};
  for (const id of agentIds) {
    const b = banks.get(id);
    const stmUsed = b ? b.ring.length + b.kv.size : 0;
    const ltmRows = ltmCounts.get(id) ?? 0;
    out[id] = {
      stm: {
        used: stmUsed,
        capacity: STM_RING_CAP + STM_KV_CAP,
        pct: Math.min(100, Math.round((stmUsed / (STM_RING_CAP + STM_KV_CAP)) * 100)),
        reads: b?.reads ?? 0,
        writes: b?.writes ?? 0,
      },
      ltm: {
        rows: ltmRows,
        pct: Math.min(100, Math.round((ltmRows / LTM_SOFT_CEILING) * 100)),
        spill_backlog: 0, // filled globally below; per-agent spill isn't tracked
      },
      interface: (b?.writes ?? 0) > 0 ? 'READ/WRITE' : (b?.reads ?? 0) > 0 ? 'READ' : 'IDLE',
    };
  }
  if (spill.length && out[agentIds[0]]) {
    // Spill is a shared buffer; surface it once on the orchestrator's card.
    out['AGENT_00'] && (out['AGENT_00'].ltm.spill_backlog = spill.length);
  }
  return out;
}

export default { stmPush, stmRecent, stmSet, stmGet, ltmRemember, ltmRecall, ltmFact, ltmFlushSpill, memoryStats };
