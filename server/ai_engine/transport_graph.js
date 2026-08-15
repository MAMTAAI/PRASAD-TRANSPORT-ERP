// server/ai_engine/transport_graph.js
// ─────────────────────────────────────────────────────────────────────────────
// The CEO-governed 10-Mahavidya transport graph.
//
//                       ┌──────────────┐
//   agent_events ─────▶ │ BAGALAMUKHI  │  shield: sanitize · heal · judge
//   (durable outbox)    └──────┬───────┘
//                       pass │   │ quarantine
//                            ▼   └───────────────────────┐
//                       ┌──────────────┐                 │
//                       │ KAMALA route │  CEO: plan + vault hold
//                       └──────┬───────┘                 │
//              plan[cursor++]  │  (conditional, per worker)
//        ┌─────┬─────┬─────┬──┴──┬─────┬─────┬─────┐     │
//        ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     │
//      kali  tara tripura bhuv bhairavi chh dhum matangi │
//        └─────┴─────┴─────┴──┬──┴─────┴─────┴─────┘     │
//                             ▼                          │
//                       ┌──────────────┐ ◀───────────────┘
//                       │ KAMALA final │  verdict · CEO duty · journal
//                       └──────┬───────┘
//                              ▼
//                             END
//
// Replaces the registry's flat dispatch(): scheduled loop events and
// API-raised events now flow through the identical governed pipeline. The
// durable outbox (agent_events → claim → agent_runs) is untouched — the graph
// is the processing engine BEHIND it, not a bypass of it.
// ─────────────────────────────────────────────────────────────────────────────
import { StateGraph, END, GraphRecursionError } from './stateGraph.js';
import { createInitialState } from './types/TransportState.js';
import { makeBagalamukhiNode, shieldRouter } from './nodes/bagalamukhiNode.js';
import { makeKamalaRouteNode, makeKamalaFinalizeNode, planRouter, WORKER_NODE_BY_CODENAME } from './nodes/kamalaNode.js';
import { makeWorkerNodes } from './nodes/workers.js';
import { journal } from './journal.js';

const WORKER_NODES = Object.values(WORKER_NODE_BY_CODENAME);

/**
 * Build and compile the transport graph.
 *
 * deps (all injected — no import cycle with the registry):
 *   agents            the frozen 10-agent roster
 *   subscribersFor    (eventType) -> agent[]
 *   readinessFor      (agentId)   -> { state, missing[] }
 *   activeHalt        (agentId|null) -> halt row | null
 *   recordRun         (eventId, agent, result, ms) -> Promise
 *   agentEmit         (agent) -> bound, declaration-enforcing emit
 *   markDone/markFailed  outbox completion (omit in selftest)
 */
export function createTransportApp(deps) {
  const byCodename = new Map(deps.agents.map((a) => [a.codename, a]));

  // An agent's OWN scheduled duty (KAMALA's dashboard tick, BAGALAMUKHI's
  // infra check) runs inside its governing node rather than as a plan entry.
  async function runAgentDuty(agentId, state) {
    const agent = deps.agents.find((a) => a.id === agentId);
    if (!agent || !agent.subscribes.includes(state.event_type)) return null;
    const ready = deps.readinessFor(agent.id);
    if (ready?.state === 'PARKED') return null;
    const started = Date.now();
    try {
      const event = {
        id: state.event_id, event_type: state.event_type,
        aggregate: state.aggregate, payload: state.payload, emitted_by: state.emitted_by,
      };
      const result = (await agent.handle(event, { emit: deps.agentEmit(agent) })) ?? { outcome: 'OK' };
      const ms = Date.now() - started;
      await deps.recordRun(state.event_id, agent, result, ms);
      return { node: `${agent.codename.toLowerCase()}.duty`, agent_id: agent.id, outcome: result.outcome, reason: result.reason ?? null, duration_ms: ms };
    } catch (err) {
      const ms = Date.now() - started;
      await deps.recordRun(state.event_id, agent, { outcome: 'ERROR', reason: err.message }, ms);
      return { node: `${agent.codename.toLowerCase()}.duty`, agent_id: agent.id, outcome: 'ERROR', reason: err.message, duration_ms: ms };
    }
  }

  const graph = new StateGraph();

  graph.addNode('bagalamukhi', makeBagalamukhiNode({ activeHalt: deps.activeHalt, runAgentDuty }));
  graph.addNode('kamala', makeKamalaRouteNode({ subscribersFor: deps.subscribersFor }));
  graph.addNode('finalize', makeKamalaFinalizeNode({ runAgentDuty }));

  const workers = makeWorkerNodes({
    agentByCodename: (c) => byCodename.get(c),
    readinessFor: deps.readinessFor,
    recordRun: deps.recordRun,
    agentEmit: deps.agentEmit,
  });
  for (const [name, fn] of Object.entries(workers)) graph.addNode(name, fn);

  // Entry → shield → (quarantine? finalize : CEO)
  graph.setEntryPoint('bagalamukhi');
  graph.addConditionalEdges('bagalamukhi', shieldRouter, { quarantine: 'finalize', pass: 'kamala' });

  // CEO → first plan entry (or straight to finalize); every worker → next
  // plan entry (or finalize). planRouter is shared, cursor-driven — a worker
  // can appear in a plan at most once, so no cycle is expressible.
  const planMapping = { finalize: 'finalize' };
  for (const w of WORKER_NODES) planMapping[w] = w;
  graph.addConditionalEdges('kamala', planRouter, planMapping);
  for (const w of WORKER_NODES) graph.addConditionalEdges(w, planRouter, planMapping);

  graph.addEdge('finalize', END);

  // Worst honest path: shield + kamala + 8 workers + finalize = 11 steps.
  const app = graph.compile({ recursionLimit: 16 });

  /** Outbox-facing dispatcher — what setDispatcher() receives. */
  async function dispatch(event) {
    const startedAt = Date.now();
    let state;
    try {
      state = await app.invoke(createInitialState(event));
    } catch (err) {
      // GraphRecursionError or a node crash: the event is FAILED with the
      // real reason and will retry through the outbox like any error.
      const reason = err instanceof GraphRecursionError ? err.message : `graph crashed: ${err.message}`;
      console.error(`[ai_engine] ${event.event_type}: ${reason}`);
      if (deps.markFailed && event.id) await deps.markFailed(event.id, reason);
      return;
    }

    journal({
      at: new Date().toISOString(),
      event_id: state.event_id, event_type: state.event_type, aggregate: state.aggregate,
      verdict: state.verdict, priority: state.ceo_directive.priority,
      financial_hold: state.ceo_directive.financial_hold,
      threats: state.security_audit.threats, healed: state.security_audit.healed,
      path: state.__path, ms: Date.now() - startedAt,
      results: state.execution_results.map((r) => `${r.node}:${r.outcome}`),
    });

    if (!event.id) return state; // selftest / direct invoke

    if (state.verdict === 'DONE') {
      await deps.markDone(event.id);
    } else if (state.verdict === 'QUARANTINED') {
      // A quarantine is a VERDICT, not a malfunction — the event must not
      // retry (replaying an attack is not a feature). Failed with a clear tag.
      await deps.markFailed(event.id, `QUARANTINED: ${state.security_audit.threats.join('; ') || state.ceo_directive.reason}`);
    } else {
      await deps.markFailed(event.id, state.errors.join('; ') || 'worker error');
    }
    return state;
  }

  return { app, dispatch };
}
