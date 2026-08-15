// server/ai_engine/nodes/workers.js
// ─────────────────────────────────────────────────────────────────────────────
// The 8 execution worker nodes. One factory, eight named nodes:
//
//   kali           GPS / trip speed sweeps        (owns trips)
//   tara           ledger & vouchers — THE VAULT  (sole writer of money)
//   tripura        load matching / bazaar         (owns bazaar tables)
//   bhuvaneshwari  documents & geo scope          (owns document queue)
//   bhairavi       compliance / SOS safety        (fleet documents window)
//   chhinnamasta   fuel slips / OCR audit         (owns fuel_entries)
//   dhumavati      wear & loss audit              (maintenance intervals)
//   matangi        WhatsApp / notifications       (owns notification queue)
//
// A worker node does NOT reimplement its agent — it executes the registered
// Mahavidya agent's handle() under the graph's governance, with the same
// readiness (PARKED) and audit (agent_runs) semantics the legacy dispatcher
// had. Table ownership, guards and mustNot boundaries are therefore exactly
// as strong as before; the graph adds the shield and the CEO around them.
// ─────────────────────────────────────────────────────────────────────────────
import { WORKER_NODE_BY_CODENAME } from './kamalaNode.js';

/**
 * deps: {
 *   agentByCodename(codename) -> agent,
 *   readinessFor(agentId)     -> { state, missing[] },
 *   recordRun(eventId, agent, result, ms),
 *   agentEmit(agent)          -> bound emit,
 * }
 */
export function makeWorkerNodes(deps) {
  const nodes = {};
  for (const [codename, nodeName] of Object.entries(WORKER_NODE_BY_CODENAME)) {
    nodes[nodeName] = makeWorkerNode(codename, nodeName, deps);
  }
  return nodes;
}

function makeWorkerNode(codename, nodeName, { agentByCodename, readinessFor, recordRun, agentEmit }) {
  return async function workerNode(state) {
    const agent = agentByCodename(codename);
    const started = Date.now();
    const advance = { ceo_directive: { ...state.ceo_directive, cursor: state.ceo_directive.cursor + 1 } };

    // Should not happen (CEO routes only to registered codenames) — but a
    // missing agent must be a recorded outcome, not an exception mid-graph.
    if (!agent) {
      return {
        ...advance,
        execution_results: [...state.execution_results, {
          node: nodeName, agent_id: '?', outcome: 'ERROR',
          reason: `no agent registered for ${codename}`, duration_ms: 0,
        }],
      };
    }

    const ready = readinessFor(agent.id);
    if (ready?.state === 'PARKED') {
      const result = {
        outcome: 'SKIPPED',
        reason: ready.missing?.length
          ? `parked — missing tables: ${ready.missing.join(', ')}`
          : 'parked — database degraded',
      };
      await recordRun(state.event_id, agent, result, 0);
      return {
        ...advance,
        execution_results: [...state.execution_results, {
          node: nodeName, agent_id: agent.id, ...result, duration_ms: 0,
        }],
      };
    }

    try {
      const event = {
        id: state.event_id, event_type: state.event_type,
        aggregate: state.aggregate, payload: state.payload,   // SANITIZED payload
        emitted_by: state.emitted_by,
      };
      const result = (await agent.handle(event, { emit: agentEmit(agent) })) ?? { outcome: 'OK' };
      const ms = Date.now() - started;
      await recordRun(state.event_id, agent, result, ms);
      return {
        ...advance,
        execution_results: [...state.execution_results, {
          node: nodeName, agent_id: agent.id,
          outcome: result.outcome, reason: result.reason ?? null, duration_ms: ms,
        }],
      };
    } catch (err) {
      const ms = Date.now() - started;
      await recordRun(state.event_id, agent, { outcome: 'ERROR', reason: err.message }, ms);
      return {
        ...advance,
        execution_results: [...state.execution_results, {
          node: nodeName, agent_id: agent.id, outcome: 'ERROR', reason: err.message, duration_ms: ms,
        }],
      };
    }
  };
}
