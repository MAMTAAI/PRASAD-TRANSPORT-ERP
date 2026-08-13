// server/agents/base.js
// ─────────────────────────────────────────────────────────────────────────────
// The agent contract. Every Mahavidya agent is declared through defineAgent(),
// which validates the declaration at load time — a malformed agent fails on
// boot, not on the first event it was supposed to handle.
//
// Roles are FIXED here in code, not in prose. `owns`, `subscribes`, `emits` and
// `mustNot` are executable: the registry refuses to start if two agents claim
// the same table, and dispatch refuses to deliver an event nobody declared.
// That is what stops a 10-agent swarm from drifting into 10 agents that all
// quietly write to `trips`.
// ─────────────────────────────────────────────────────────────────────────────

/** Readiness states — an agent whose tables do not exist yet is PARKED, not broken. */
export const READY = {
  ACTIVE: 'ACTIVE',   // dependencies present, handling events
  PARKED: 'PARKED',   // declared and validated, waiting on a migration
  HALTED: 'HALTED',   // stopped by Bagalamukhi or an operator
};

const EVENT_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
const AGENT_ID_RE = /^AGENT_\d{2}$/;

/**
 * Declare an agent. Returns a frozen descriptor.
 *
 * @param {object} spec
 * @param {string}   spec.id          'AGENT_02'
 * @param {string}   spec.codename    'TARA'
 * @param {string}   spec.title       human-readable role
 * @param {string}   spec.mandate     one-paragraph statement of what it is for
 * @param {string[]} spec.subscribes  event types it reacts to
 * @param {string[]} spec.emits       event types it may produce
 * @param {object}   spec.owns        { tables: [], modules: [] } — exclusive write scope
 * @param {string[]} spec.reads       tables it may read but never write
 * @param {string[]} spec.mustNot     explicit prohibitions (boundary, enforced in review + tests)
 * @param {object[]} spec.guards      [{ name, description }] hard rules it enforces
 * @param {string[]} spec.requires    tables that must exist before it can go ACTIVE
 * @param {function} spec.handle      async (event, ctx) => { outcome, reason? }
 */
export function defineAgent(spec) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };

  need(AGENT_ID_RE.test(spec.id ?? ''), `id must match AGENT_NN (got ${spec.id})`);
  need(typeof spec.codename === 'string' && spec.codename === spec.codename?.toUpperCase(),
    `codename must be UPPERCASE (got ${spec.codename})`);
  need(typeof spec.title === 'string' && spec.title.length > 0, 'title is required');
  need(typeof spec.mandate === 'string' && spec.mandate.length > 20, 'mandate must be a real sentence');
  need(Array.isArray(spec.subscribes), 'subscribes must be an array');
  need(Array.isArray(spec.emits), 'emits must be an array');
  need(spec.owns && Array.isArray(spec.owns.tables), 'owns.tables must be an array');
  need(typeof spec.handle === 'function', 'handle must be a function');

  // Event names are a shared vocabulary; a typo here means an event that is
  // emitted and never received, which is the hardest kind of bug to see.
  for (const e of spec.subscribes ?? []) {
    need(EVENT_RE.test(e), `${spec.id} subscribes to malformed event name '${e}'`);
  }
  for (const e of spec.emits ?? []) {
    need(EVENT_RE.test(e), `${spec.id} emits malformed event name '${e}'`);
  }

  if (errs.length) {
    throw new Error(`Invalid agent declaration ${spec.id ?? '<no id>'}:\n  - ${errs.join('\n  - ')}`);
  }

  return Object.freeze({
    id: spec.id,
    codename: spec.codename,
    title: spec.title,
    mandate: spec.mandate,
    domain: spec.domain ?? 'general',
    subscribes: Object.freeze([...spec.subscribes]),
    emits: Object.freeze([...spec.emits]),
    owns: Object.freeze({
      tables: Object.freeze([...(spec.owns.tables ?? [])]),
      modules: Object.freeze([...(spec.owns.modules ?? [])]),
    }),
    reads: Object.freeze([...(spec.reads ?? [])]),
    mustNot: Object.freeze([...(spec.mustNot ?? [])]),
    guards: Object.freeze([...(spec.guards ?? [])]),
    requires: Object.freeze([...(spec.requires ?? [])]),
    handle: spec.handle,
  });
}

/** Outcome helpers — the four values agent_runs.outcome accepts. */
export const ok = (reason) => ({ outcome: 'OK', reason });
/** Event was not for this agent after all (e.g. wrong company scope). */
export const skipped = (reason) => ({ outcome: 'SKIPPED', reason });
/** A guard refused. This is a *success* for the guard — the swarm did its job. */
export const blocked = (reason) => ({ outcome: 'BLOCKED', reason });
/** Something genuinely broke. Retried up to attempts < 5, then DEAD. */
export const failed = (reason) => ({ outcome: 'ERROR', reason });
