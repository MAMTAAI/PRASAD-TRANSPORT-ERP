// server/ai_engine/types/TransportState.js
// ─────────────────────────────────────────────────────────────────────────────
// The central state that flows through the 10-Mahavidya transport graph.
//
// Written as JSDoc-typed ESM, not .ts: the AWS box runs Node 20, which cannot
// execute TypeScript, and this server is deliberately build-step-free. The
// contract below is exactly as explicit as an interface — and it is enforced
// at runtime by createInitialState(), which is the only sanctioned way to
// construct a state.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SecurityAudit
 * @property {'PENDING'|'PASS'|'QUARANTINED'} status
 * @property {string[]} threats    what the shield found (empty = clean)
 * @property {string[]} healed     auto-repairs applied to the payload
 * @property {boolean}  sanitized  payload has been through the shield
 *
 * @typedef {Object} CeoDirective
 * @property {string[]} route_plan  ordered worker node names to execute
 * @property {number}   cursor      index of the next worker in route_plan
 * @property {'CRITICAL'|'HIGH'|'NORMAL'|'LOW'} priority
 * @property {boolean}  financial_hold  CEO blocked money movement this run
 * @property {string}   reason      why the CEO routed/held as it did
 *
 * @typedef {Object} ExecutionResult
 * @property {string} node       graph node that ran
 * @property {string} agent_id   AGENT_NN that handled it ('' for shield/CEO)
 * @property {'OK'|'SKIPPED'|'BLOCKED'|'ERROR'} outcome
 * @property {string|null} reason
 * @property {number} duration_ms
 *
 * @typedef {Object} TransportState
 * @property {string} event_id      agent_events row id (null in selftest)
 * @property {string} event_type    e.g. 'trip.gps.ping'
 * @property {string} aggregate     e.g. 'trips'
 * @property {Object} payload       sanitized by the shield before any worker
 * @property {string} emitted_by    AGENT_NN or 'api'
 * @property {SecurityAudit} security_audit
 * @property {CeoDirective}  ceo_directive
 * @property {ExecutionResult[]} execution_results
 * @property {string[]} errors
 * @property {'RUNNING'|'DONE'|'QUARANTINED'|'FAILED'} verdict
 * @property {string[]} __path      node visit audit trail (set by the engine)
 */

/** @returns {TransportState} */
export function createInitialState(event) {
  if (!event || typeof event.event_type !== 'string' || !event.event_type) {
    throw new Error('TransportState requires an event with a string event_type');
  }
  return {
    event_id: event.id ?? null,
    event_type: event.event_type,
    aggregate: event.aggregate ?? 'general',
    payload: event.payload ?? {},
    emitted_by: event.emitted_by ?? 'api',
    security_audit: { status: 'PENDING', threats: [], healed: [], sanitized: false },
    ceo_directive: { route_plan: [], cursor: 0, priority: 'NORMAL', financial_hold: false, reason: '' },
    execution_results: [],
    errors: [],
    verdict: 'RUNNING',
    __path: [],
  };
}
