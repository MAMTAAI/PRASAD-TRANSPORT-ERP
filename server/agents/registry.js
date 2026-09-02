// server/agents/registry.js
// ─────────────────────────────────────────────────────────────────────────────
// The swarm registry: loads the ten agents, validates that their declared roles
// do not overlap, and dispatches events to whoever subscribed.
//
// The validation is the point. Ten agents sharing one database will drift into
// ten agents that all write `trips` unless something refuses to start when they
// do. Two rules are enforced at boot:
//
//   1. No two agents own the same table.       (single-writer per table)
//   2. Every subscribed event is emitted by someone, and every emitted event
//      has at least one subscriber — otherwise it is a typo or dead code.
//
// Rule 2 is a warning rather than a hard failure, because an event may
// legitimately be emitted for the audit log alone.
// ─────────────────────────────────────────────────────────────────────────────
import { READY } from './base.js';
import { bus, emit, setDispatcher, markDone, markFailed } from './bus.js';
import { query, queryOne, isDegraded } from '../db/pool.js';
import { activeHalt } from './bagalamukhi.js';

import kamala from './kamala.js';
import kali from './kali.js';
import tara from './tara.js';
import tripura from './tripura.js';
import bhuvaneshwari from './bhuvaneshwari.js';
import bhairavi from './bhairavi.js';
import chhinnamasta from './chhinnamasta.js';
import dhumavati from './dhumavati.js';
import bagalamukhi from './bagalamukhi.js';
import matangi from './matangi.js';

/** Fixed roster, in agent-id order. */
export const AGENTS = Object.freeze([
  kamala, kali, tara, tripura, bhuvaneshwari,
  bhairavi, chhinnamasta, dhumavati, bagalamukhi, matangi,
]);

const byId = new Map(AGENTS.map((a) => [a.id, a]));
const subscribers = new Map();  // event_type -> [agent]
const readiness = new Map();    // agent_id -> { state, missing[] }

// ── Boot-time validation ────────────────────────────────────────────────────

function validateRoster() {
  const errors = [];
  const warnings = [];

  if (AGENTS.length !== 10) errors.push(`expected 10 agents, found ${AGENTS.length}`);

  const ids = AGENTS.map((a) => a.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) errors.push(`duplicate agent ids: ${[...new Set(dupIds)].join(', ')}`);

  // Rule 1 — single writer per table.
  const tableOwner = new Map();
  for (const agent of AGENTS) {
    for (const table of agent.owns.tables) {
      const existing = tableOwner.get(table);
      if (existing) {
        errors.push(`table '${table}' is owned by both ${existing} and ${agent.id} — exactly one writer allowed`);
      } else {
        tableOwner.set(table, agent.id);
      }
    }
  }

  // Rule 2 — the event vocabulary must close.
  const allEmitted = new Set(AGENTS.flatMap((a) => a.emits));
  const allSubscribed = new Set(AGENTS.flatMap((a) => a.subscribes));
  // Events the API raises directly rather than an agent emitting them.
  const externalOrigins = new Set([
    'document.uploaded', 'email.attachment.received', 'fuel.slip.submitted',
    'trip.loading.recorded', 'trip.unloading.recorded', 'trip.gps.ping',
    'load.posted', 'bid.submitted', 'rate.quote.requested', 'market.vehicle.registered',
    'tyre.fitted', 'tyre.removed', 'maintenance.bill.received', 'battery.replaced',
    'whatsapp.message.received', 'driver.advance.requested', 'driver.advance.approved',
    'customer.payment.received', 'vendor.payment.made', 'pump.statement.received',
    'invoice.generated', 'document.reparse.requested', 'ledger.audit.requested',
    'compliance.sweep.requested', 'maintenance.due.check', 'infra.tunnel.check',
    'security.intrusion.suspected', 'agent.resume.requested', 'dashboard.refresh.requested',
    'trip.settlement.requested', 'invoice.generation.requested', 'loan.emi.due',
    'fuel.reconciliation.requested', 'infra.db.failover.detected',
    'vehicle.document.updated', 'driver.document.updated', 'fuel.price.changed',
    // The IOCL mail cycles are raised by the graph engine's time-gated nodes
    // (KALI: AC4 loading, BHUVANESHWARI: AC5 billing), not by an agent.
    'loading.mail.sweep.requested', 'invoice.mail.sweep.requested',
  ]);

  // A subscription with no producer is a genuine defect: the agent will wait
  // forever for an event that nothing sends.
  for (const evt of allSubscribed) {
    if (!allEmitted.has(evt) && !externalOrigins.has(evt)) {
      warnings.push(`'${evt}' is subscribed but never emitted — typo or missing producer?`);
    }
  }

  // The reverse is NOT a defect. Most emitted events are terminal by design —
  // 'notification.sent', 'ledger.posted', 'tyre.lifecycle.recorded' exist for
  // the audit trail and the dashboard, not for another agent to consume.
  // Warning per-event here produced 38 lines on a correct roster, which is how
  // a warning becomes something people learn to scroll past. Reported as one
  // counted line instead.
  const terminal = [...allEmitted].filter((e) => !allSubscribed.has(e));

  return { errors, warnings, tableOwner, terminal };
}

// ── Readiness ───────────────────────────────────────────────────────────────

/**
 * An agent is ACTIVE only if every table it requires actually exists. This is
 * what keeps the swarm honest while migrations 003+ are still unwritten: agents
 * report PARKED rather than throwing "relation does not exist" on every event.
 */
async function assessReadiness() {
  let existing = new Set();
  if (!isDegraded()) {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    existing = new Set(rows.map((r) => r.table_name));
  }

  for (const agent of AGENTS) {
    const missing = agent.requires.filter((t) => !existing.has(t));
    readiness.set(agent.id, {
      state: isDegraded() ? READY.PARKED : missing.length ? READY.PARKED : READY.ACTIVE,
      missing,
    });
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function recordRun(eventId, agent, result, durationMs) {
  try {
    await query(
      `INSERT INTO agent_runs (event_id, agent_id, agent_code, outcome, reason, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [eventId, agent.id, agent.codename, result.outcome, result.reason ?? null, durationMs]
    );
  } catch (err) {
    console.error(`[registry] could not record run for ${agent.id}: ${err.message}`);
  }
}

async function dispatch(event) {
  const targets = subscribers.get(event.event_type) ?? [];

  // A global halt stops everything except Bagalamukhi, which must stay able to
  // process the resume that lifts the halt.
  const halt = await activeHalt(null).catch(() => null);

  if (!targets.length) {
    await markDone(event.id);
    return;
  }

  let anyError = null;
  for (const agent of targets) {
    const ready = readiness.get(agent.id);

    if (halt && agent.id !== 'AGENT_08') {
      await recordRun(event.id, agent, { outcome: 'BLOCKED', reason: `swarm halted: ${halt.reason}` }, 0);
      continue;
    }
    if (ready?.state === READY.PARKED) {
      await recordRun(event.id, agent, {
        outcome: 'SKIPPED',
        reason: ready.missing.length ? `parked — missing tables: ${ready.missing.join(', ')}` : 'parked — database degraded',
      }, 0);
      continue;
    }

    const startedAt = process.hrtime.bigint();
    try {
      const result = (await agent.handle(event, { emit: agentEmit(agent) })) ?? { outcome: 'OK' };
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      await recordRun(event.id, agent, result, Math.round(ms));

      // Mirror onto the in-process emitter for anything watching live (SSE
      // dashboards, tests) without going through the database.
      bus.emit('agent:run', { agent: agent.id, event: event.event_type, ...result });
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      await recordRun(event.id, agent, { outcome: 'ERROR', reason: err.message }, Math.round(ms));
      console.error(`[${agent.id}:${agent.codename}] ${event.event_type} threw: ${err.message}`);
      anyError = err;
    }
  }

  // One agent failing must not mark the event DONE for the others, so the event
  // is retried as a whole. agent_runs' unique index on successful runs makes
  // that safe: an agent that already succeeded is not re-run.
  if (anyError) await markFailed(event.id, anyError.message);
  else await markDone(event.id);
}

/** Bind emit() to the emitting agent so every event is attributable. */
function agentEmit(agent) {
  return (eventType, opts = {}) => {
    if (!agent.emits.includes(eventType)) {
      // Declared roles are enforced at runtime, not just documented. An agent
      // emitting outside its declaration is a boundary violation.
      throw new Error(`${agent.id} (${agent.codename}) may not emit '${eventType}' — not in its declared emits`);
    }
    return emit(eventType, { ...opts, emittedBy: agent.id });
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function initSwarm({ strict = true } = {}) {
  const { errors, warnings, tableOwner, terminal } = validateRoster();

  for (const w of warnings) console.warn(`[registry] ! ${w}`);
  if (terminal.length && process.env.AGENT_VERBOSE === '1') {
    console.log(`[registry] ${terminal.length} terminal events (audit/dashboard only): ${terminal.join(', ')}`);
  }
  if (errors.length) {
    const msg = `Agent roster invalid:\n  - ${errors.join('\n  - ')}`;
    if (strict) throw new Error(msg);
    console.error(`[registry] ${msg}`);
  }

  subscribers.clear();
  for (const agent of AGENTS) {
    for (const evt of agent.subscribes) {
      if (!subscribers.has(evt)) subscribers.set(evt, []);
      subscribers.get(evt).push(agent);
    }
  }

  await assessReadiness();

  // ── Dispatcher selection ──────────────────────────────────────────────────
  // Default: the CEO-governed StateGraph (server/ai_engine) — every event
  // passes BAGALAMUKHI's shield and KAMALA's routing before any worker runs.
  // AI_ENGINE=loops falls back to the flat legacy dispatch below (kept as the
  // rollback path, not deleted). Dynamic import: no module cycle.
  const engine = (process.env.AI_ENGINE ?? 'graph').toLowerCase();
  if (engine === 'graph') {
    const { createTransportApp } = await import('../ai_engine/transport_graph.js');
    const transportApp = createTransportApp({
      agents: AGENTS,
      subscribersFor: (t) => subscribers.get(t) ?? [],
      readinessFor: (id) => readiness.get(id),
      activeHalt,
      recordRun,
      agentEmit,
      markDone,
      markFailed,
    });
    setDispatcher(transportApp.dispatch);
    console.log('[registry] dispatcher = ai_engine transport graph (shield → CEO → workers)');
  } else {
    setDispatcher(dispatch);
    console.log('[registry] dispatcher = legacy flat dispatch (AI_ENGINE=loops)');
  }

  const active = [...readiness.values()].filter((r) => r.state === READY.ACTIVE).length;
  console.log(
    `[registry] ${AGENTS.length} agents loaded · ${active} ACTIVE · ${AGENTS.length - active} PARKED · ` +
    `${subscribers.size} event types · ${tableOwner.size} owned tables`
  );
  return status();
}

export function status() {
  return {
    count: AGENTS.length,
    agents: AGENTS.map((a) => ({
      id: a.id,
      codename: a.codename,
      title: a.title,
      domain: a.domain,
      state: readiness.get(a.id)?.state ?? READY.PARKED,
      missing_tables: readiness.get(a.id)?.missing ?? [],
      subscribes: a.subscribes.length,
      emits: a.emits.length,
      owns_tables: a.owns.tables,
      guards: a.guards.map((g) => g.name),
    })),
  };
}

/** Full role card for one agent — the fixed contract, queryable at runtime. */
export function describe(agentId) {
  const a = byId.get(agentId);
  if (!a) return null;
  return {
    ...a,
    handle: undefined,
    state: readiness.get(a.id)?.state,
    missing_tables: readiness.get(a.id)?.missing ?? [],
  };
}

/** Re-check table availability, e.g. right after running migrations. */
export const refreshReadiness = assessReadiness;

export { bus, emit };
