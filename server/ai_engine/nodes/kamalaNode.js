// server/ai_engine/nodes/kamalaNode.js
// ─────────────────────────────────────────────────────────────────────────────
// KAMALA — Central CEO node & financial vault supervisor.
// Two graph steps live here:
//
//   kamalaRoute    decides WHO works and in WHAT order. The route plan is
//                  derived from the agents' own declared subscriptions — the
//                  registry's single-writer/subscription contract stays the
//                  one source of truth, so the CEO can never route an event
//                  to an agent that never claimed it.
//   kamalaFinalize aggregates worker outcomes into the final verdict, runs
//                  KAMALA's own housekeeping duty (AGENT_00 subscriptions),
//                  and closes the run.
//
// FINANCIAL VAULT RULE. TARA remains the only writer of ledger_entries — the
// CEO does not post money, it GOVERNS money: any event that touches the
// ledger/financial domain while the shield recorded even one heal on a money
// field is held (financial_hold) and the workers never run. Suspicion plus
// money equals stop; everything else equals proceed.
// ─────────────────────────────────────────────────────────────────────────────

// Codename → graph worker node name (the 8 execution workers).
export const WORKER_NODE_BY_CODENAME = Object.freeze({
  KALI: 'kali', TARA: 'tara', TRIPURA_SUNDARI: 'tripura',
  BHUVANESHWARI: 'bhuvaneshwari', BHAIRAVI: 'bhairavi',
  CHHINNAMASTA: 'chhinnamasta', DHUMAVATI: 'dhumavati', MATANGI: 'matangi',
});

const FINANCIAL_AGGREGATES = new Set(['ledger', 'billing', 'payments']);

const PRIORITY_BY_AGGREGATE = {
  ledger: 'CRITICAL', security: 'CRITICAL', infra: 'HIGH', trips: 'HIGH',
  fuel: 'NORMAL', fleet: 'NORMAL', documents: 'NORMAL', bazaar: 'NORMAL',
  notifications: 'LOW', dashboard: 'LOW',
};

/** deps: { subscribersFor } */
export function makeKamalaRouteNode({ subscribersFor }) {
  return async function kamalaRoute(state) {
    const subscribed = subscribersFor(state.event_type) ?? [];

    // The 8 execution workers get graph nodes; KAMALA's and BAGALAMUKHI's own
    // subscriptions run inside their governing steps, not as plan entries.
    const route_plan = subscribed
      .map((a) => WORKER_NODE_BY_CODENAME[a.codename])
      .filter(Boolean);

    const priority = PRIORITY_BY_AGGREGATE[state.aggregate] ?? 'NORMAL';

    // Vault supervision: healed money on a financial event is not "probably
    // fine" — it is a payload nobody wrote the way it arrived.
    const moneyHealed = state.security_audit.healed.some((h) => /amount|freight|money|rate|payment/i.test(h));
    const financial_hold = FINANCIAL_AGGREGATES.has(state.aggregate) && moneyHealed;

    const reason = financial_hold
      ? `CEO HOLD — financial event with healed money fields (${state.security_audit.healed.length} heal(s)); manual review`
      : route_plan.length
        ? `routed to ${route_plan.join(' → ')} @ ${priority}`
        : 'no execution workers subscribed — audit-only event';

    return {
      ceo_directive: {
        route_plan: financial_hold ? [] : route_plan,
        cursor: 0, priority, financial_hold, reason,
      },
    };
  };
}

/** Router used after kamalaRoute AND after every worker: next plan entry or finalize. */
export function planRouter(state) {
  const { route_plan, cursor } = state.ceo_directive;
  return cursor < route_plan.length ? route_plan[cursor] : 'finalize';
}

/** deps: { runAgentDuty } */
export function makeKamalaFinalizeNode({ runAgentDuty }) {
  return async function kamalaFinalize(state) {
    const results = [...state.execution_results];

    // KAMALA's own duty (dashboard refresh etc.) — only on clean runs.
    if (state.security_audit.status === 'PASS' && !state.ceo_directive.financial_hold && runAgentDuty) {
      const duty = await runAgentDuty('AGENT_00', state);
      if (duty) results.push(duty);
    }

    const errors = results.filter((r) => r.outcome === 'ERROR').map((r) => `${r.node}: ${r.reason}`);
    const verdict =
      state.security_audit.status === 'QUARANTINED' ? 'QUARANTINED'
        : state.ceo_directive.financial_hold ? 'QUARANTINED'
          : errors.length ? 'FAILED'
            : 'DONE';

    return { execution_results: results, errors: [...state.errors, ...errors], verdict };
  };
}
