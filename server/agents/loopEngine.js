// server/agents/loopEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// Autonomous background loops for the ten Mahavidya agents.
//
// A loop does NOT call an agent's handler directly — that would bypass the
// outbox and its audit trail. A loop *emits the event* the agent already
// subscribes to (compliance.sweep.requested, ledger.audit.requested, ...), so
// scheduled work and API-triggered work flow through the identical durable
// path: agent_events → claim → dispatch → agent_runs.
//
// Every tick respects three gates, in order:
//   1. database degraded  → tick becomes a no-op (counted, not errored)
//   2. swarm/agent halted → tick skipped (BAGALAMUKHI's halt applies here too)
//   3. otherwise          → emit the scheduled event
// ─────────────────────────────────────────────────────────────────────────────
import { emit } from './bus.js';
import { isDegraded } from '../db/pool.js';
import { activeHalt } from './bagalamukhi.js';
import { stmPush, ltmFlushSpill } from '../memory/okf.js';
import { tick as syncTick } from '../sync/autoSync.js';
import { drainParked } from '../ai/router.js';

// ── Loop specifications ─────────────────────────────────────────────────────
// Intervals follow the directive's cadence (Kali 10s, Tara 30s) with the rest
// scaled to how often their domain actually changes. All overridable via env
// LOOP_<CODENAME>_MS. `homework` is the human-readable duty shown on the
// dashboard card.
const LOOP_SPECS = [
  {
    agentId: 'AGENT_00', codename: 'KAMALA', intervalMs: 15_000,
    homework: 'Refresh dashboard state; flush OKF spill; watch workflow backlog',
    event: 'dashboard.refresh.requested', aggregate: 'dashboard',
    // Kamala's tick also does the swarm's housekeeping.
    extra: async () => { await ltmFlushSpill(); },
  },
  {
    agentId: 'AGENT_01', codename: 'KALI', intervalMs: 10_000,
    homework: 'Check pending loads and stalled in-transit trips every 10s; poll IOCL mailboxes for AC4 daily-loading mail every 10 min → loading register (never a trip)',
    event: 'trip.sweep.requested', aggregate: 'trips',
  },
  {
    agentId: 'AGENT_02', codename: 'TARA', intervalMs: 30_000,
    homework: 'Reconcile ledger (zero-divergence audit) every 30s; post each AC5 freight invoice BHUVANESHWARI parses into the trip ledger (bill book)',
    event: 'ledger.audit.requested', aggregate: 'ledger',
  },
  {
    agentId: 'AGENT_03', codename: 'TRIPURA_SUNDARI', intervalMs: 120_000,
    homework: 'Re-check open bazaar loads and lane margins',
    event: 'bazaar.sweep.requested', aggregate: 'bazaar',
  },
  {
    agentId: 'AGENT_04', codename: 'BHUVANESHWARI', intervalMs: 20_000,
    homework: 'Drain the document upload queue; fetch and parse AC5 freight invoices every 10 min and hand each new one to TARA',
    event: 'document.queue.sweep', aggregate: 'documents',
    // Offline-fallback drain: OCR tasks parked in ai_tasks while the local
    // engine was off are replayed here, strictly one at a time.
    extra: async () => { await drainParked(3); },
  },
  {
    agentId: 'AGENT_05', codename: 'BHAIRAVI', intervalMs: 300_000,
    homework: 'Sweep fleet for expiring licences/permits (30-day window)',
    event: 'compliance.sweep.requested', aggregate: 'fleet',
    payload: { days: 30 },
  },
  {
    agentId: 'AGENT_06', codename: 'CHHINNAMASTA', intervalMs: 60_000,
    homework: 'Audit new fuel slips; reconcile pump advances',
    event: 'fuel.reconciliation.requested', aggregate: 'fuel',
  },
  {
    agentId: 'AGENT_07', codename: 'DHUMAVATI', intervalMs: 300_000,
    homework: 'Check RTKM wear against service intervals',
    event: 'maintenance.due.check', aggregate: 'fleet',
  },
  {
    agentId: 'AGENT_08', codename: 'BAGALAMUKHI', intervalMs: 30_000,
    homework: 'Run the AWS<->local auto-sync tick; verify tunnel + DB health',
    event: 'infra.tunnel.check', aggregate: 'infra',
    // Watermark replication to AWS RDS. tick() never throws: internet down =
    // cursor holds + retry next tick; RDS unconfigured = STANDBY.
    extra: async () => { await syncTick(); },
  },
  {
    agentId: 'AGENT_09', codename: 'MATANGI', intervalMs: 45_000,
    homework: 'Flush queued notifications; poll WhatsApp engine health',
    event: 'notification.queue.sweep', aggregate: 'notifications',
  },
  // ── The IOCL mail cycles, for the loop fallback (AGENT_ENGINE=loop) ─────
  // Under the graph engine these are time-gated nodes in graphEngine.js; here
  // they are second loops on the same agents, keyed so they do not replace
  // the agent's primary loop. `key` is also the env override: LOOP_<KEY>_MS.
  {
    agentId: 'AGENT_01', codename: 'KALI', key: 'KALI_MAIL', intervalMs: 600_000,
    homework: 'Poll IOCL mailboxes for AC4 daily-loading mail → loading register',
    event: 'loading.mail.sweep.requested', aggregate: 'loading',
  },
  {
    agentId: 'AGENT_04', codename: 'BHUVANESHWARI', key: 'BHUVANESHWARI_MAIL', intervalMs: 600_000,
    homework: 'Fetch and parse AC5 freight invoices → TARA',
    event: 'invoice.mail.sweep.requested', aggregate: 'invoices',
  },
];

// ── Runtime state ───────────────────────────────────────────────────────────
const timers = new Map();      // agentId -> interval handle
const stats = new Map();       // agentId -> per-loop counters
let running = false;
let startedAt = null;

// CPU accounting: delta of process.cpuUsage between samples, apportioned to
// whichever loop ticks ran. Coarse, but honest about what it is — this process
// only; the dashboard labels it as such.
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function loopStat(agentId) {
  let s = stats.get(agentId);
  if (!s) {
    s = {
      ticks: 0, emitted: 0, skippedDegraded: 0, skippedHalt: 0, errors: 0,
      lastAction: null, lastAt: null, lastError: null,
      dayKey: new Date().toISOString().slice(0, 10),
      todayTicks: 0, todayErrors: 0,
    };
    stats.set(agentId, s);
  }
  // Roll the daily counters at midnight.
  const today = new Date().toISOString().slice(0, 10);
  if (s.dayKey !== today) {
    s.dayKey = today;
    s.todayTicks = 0;
    s.todayErrors = 0;
  }
  return s;
}

async function tick(spec) {
  const s = loopStat(spec.agentId);
  s.ticks++;
  s.todayTicks++;

  try {
    if (isDegraded()) {
      s.skippedDegraded++;
      s.lastAction = 'no-op (database degraded)';
      s.lastAt = Date.now();
      return;
    }

    const halt = await activeHalt(spec.agentId);
    if (halt && spec.agentId !== 'AGENT_08') {
      s.skippedHalt++;
      s.lastAction = `held (halt: ${halt.reason})`;
      s.lastAt = Date.now();
      return;
    }

    if (spec.extra) await spec.extra();

    await emit(spec.event, {
      aggregate: spec.aggregate,
      payload: { ...(spec.payload ?? {}), scheduled: true },
      emittedBy: spec.agentId,
    });

    s.emitted++;
    s.lastAction = `emitted ${spec.event}`;
    s.lastAt = Date.now();
    stmPush(spec.agentId, 'loop', { event: spec.event });
  } catch (err) {
    s.errors++;
    s.todayErrors++;
    s.lastError = err.message;
    s.lastAt = Date.now();
    // A loop error is logged and counted, never thrown — one agent's bad tick
    // must not take down the interval scheduler for the other nine.
    console.error(`[loop:${spec.codename}] tick failed: ${err.message}`);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function startLoops() {
  if (running) return { running, loops: timers.size };
  running = true;
  startedAt = Date.now();

  for (const spec of LOOP_SPECS) {
    const override = process.env[`LOOP_${spec.key ?? spec.codename}_MS`];
    const interval = override ? Number.parseInt(override, 10) : spec.intervalMs;
    const handle = setInterval(() => tick(spec), interval);
    handle.unref?.(); // loops must never keep a dying process alive
    timers.set(spec.key ?? spec.agentId, handle);
    loopStat(spec.agentId); // materialise counters immediately for telemetry
  }
  console.log(`[loops] ${timers.size} agent loops started (Kali 10s · Tara 30s · Bhuvaneshwari 20s · ...)`);
  return { running, loops: timers.size };
}

export function stopLoops() {
  for (const handle of timers.values()) clearInterval(handle);
  timers.clear();
  running = false;
  console.log('[loops] stopped');
}

/** Pause/resume one agent's loop (the dashboard Stop/Restart buttons). */
export function setLoopEnabled(agentId, enabled) {
  // An agent may hold more than one loop (KALI: trips + mail). Stop starts
  // and stops all of them together — a half-stopped agent is a lie on the card.
  const specs = LOOP_SPECS.filter((l) => l.agentId === agentId);
  if (!specs.length) return { ok: false, error: 'unknown agent' };

  const keys = specs.map((s) => s.key ?? s.agentId);
  const anyRunning = keys.some((k) => timers.has(k));
  if (!enabled && anyRunning) {
    for (const k of keys) {
      const h = timers.get(k);
      if (h) { clearInterval(h); timers.delete(k); }
    }
    loopStat(agentId).lastAction = 'loop stopped by operator';
    return { ok: true, state: 'STOPPED' };
  }
  if (enabled && !anyRunning && running) {
    for (const spec of specs) {
      const handle = setInterval(() => tick(spec), spec.intervalMs);
      handle.unref?.();
      timers.set(spec.key ?? spec.agentId, handle);
    }
    loopStat(agentId).lastAction = 'loop restarted by operator';
    return { ok: true, state: 'RUNNING' };
  }
  return { ok: true, state: anyRunning ? 'RUNNING' : 'STOPPED' };
}

// ── Telemetry ───────────────────────────────────────────────────────────────

/** Process-level CPU/MEM snapshot, shared across cards (one process, ten agents). */
export function processMetrics() {
  const nowCpu = process.cpuUsage();
  const now = Date.now();
  const elapsedUs = Math.max((now - lastCpuAt) * 1000, 1);
  const usedUs = (nowCpu.user - lastCpu.user) + (nowCpu.system - lastCpu.system);
  lastCpu = nowCpu;
  lastCpuAt = now;

  const mem = process.memoryUsage();
  return {
    cpu_pct: Math.min(100, Math.round((usedUs / elapsedUs) * 100)),
    mem_pct: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    rss_mb: Math.round(mem.rss / 1048576),
    uptime_s: startedAt ? Math.round((now - startedAt) / 1000) : 0,
  };
}

export function loopStats() {
  const out = {};
  for (const spec of LOOP_SPECS) {
    if (spec.key) continue;   // a secondary loop shares its agent's card and counters
    const s = stats.get(spec.agentId);
    out[spec.agentId] = {
      running: timers.has(spec.agentId),
      interval_ms: spec.intervalMs,
      homework: spec.homework,
      ticks: s?.ticks ?? 0,
      emitted: s?.emitted ?? 0,
      errors: s?.errors ?? 0,
      today: { ticks: s?.todayTicks ?? 0, errors: s?.todayErrors ?? 0 },
      last_action: s?.lastAction ?? null,
      last_at: s?.lastAt ?? null,
      last_error: s?.lastError ?? null,
    };
  }
  return out;
}

export const LOOPS = LOOP_SPECS.map(({ agentId, codename, intervalMs, homework, event }) =>
  ({ agentId, codename, intervalMs, homework, event }));
