// server/ai_engine/selftest.js
// ─────────────────────────────────────────────────────────────────────────────
// Smoke test for the transport graph — NO database, NO network. Mock agents
// stand in for the roster so this runs anywhere (CI, the box, a laptop).
//
//   node server/ai_engine/selftest.js
//
// Asserts, per invoke:
//   • the graph reaches END (verdict != RUNNING)
//   • zero recursive loops: no node appears twice in __path
//     (exception: none — even kamala route and finalize are distinct nodes)
//   • hostile payloads are QUARANTINED and workers never run
//   • financial events with healed money fields are CEO-held
//   • unknown events terminate DONE as audit-only (no dead-ends)
//   • GraphRecursionError actually fires on a deliberately cyclic graph
// ─────────────────────────────────────────────────────────────────────────────
import { createTransportApp } from './transport_graph.js';
import { StateGraph, END, GraphRecursionError } from './stateGraph.js';

const CODENAMES = ['KAMALA', 'KALI', 'TARA', 'TRIPURA_SUNDARI', 'BHUVANESHWARI',
  'BHAIRAVI', 'CHHINNAMASTA', 'DHUMAVATI', 'BAGALAMUKHI', 'MATANGI'];

const SUBS = {
  KAMALA: ['dashboard.refresh.requested'],
  KALI: ['trip.gps.ping', 'trip.sweep.requested'],
  TARA: ['ledger.audit.requested', 'customer.payment.received'],
  TRIPURA_SUNDARI: ['load.posted'],
  BHUVANESHWARI: ['document.uploaded'],
  BHAIRAVI: ['compliance.sweep.requested'],
  CHHINNAMASTA: ['fuel.slip.submitted'],
  DHUMAVATI: ['maintenance.due.check'],
  BAGALAMUKHI: ['infra.tunnel.check'],
  MATANGI: ['notification.queue.sweep', 'customer.payment.received'],
};

const handled = [];
const agents = CODENAMES.map((codename, i) => ({
  id: `AGENT_${String(i).padStart(2, '0')}`,
  codename,
  subscribes: SUBS[codename],
  emits: [],
  handle: async (event) => { handled.push(`${codename}:${event.event_type}`); return { outcome: 'OK', reason: 'mock' }; },
}));

const subscribersFor = (t) => agents.filter((a) => a.subscribes.includes(t));

const runsRecorded = [];
const completed = [];
const { dispatch } = createTransportApp({
  agents,
  subscribersFor,
  readinessFor: () => ({ state: 'ACTIVE', missing: [] }),
  activeHalt: async () => null,
  recordRun: async (eventId, agent, result) => { runsRecorded.push(`${agent.codename}:${result.outcome}`); },
  agentEmit: () => async () => {},
  markDone: async (id) => completed.push(['DONE', id]),
  markFailed: async (id, reason) => completed.push(['FAILED', id, reason]),
});

let pass = 0, fail = 0;
const assert = (cond, label) => {
  if (cond) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.error(`  ✖ ${label}`); }
};

const noLoops = (state) => new Set(state.__path).size === state.__path.length;

// ── 1. one clean event per worker route ─────────────────────────────────────
console.log('\n[1] clean routing — every worker reachable, zero repeat visits');
const routeCases = [
  ['trip.gps.ping', 'trips', 'kali'],
  ['ledger.audit.requested', 'ledger', 'tara'],
  ['load.posted', 'bazaar', 'tripura'],
  ['document.uploaded', 'documents', 'bhuvaneshwari'],
  ['compliance.sweep.requested', 'fleet', 'bhairavi'],
  ['fuel.slip.submitted', 'fuel', 'chhinnamasta'],
  ['maintenance.due.check', 'fleet', 'dhumavati'],
  ['notification.queue.sweep', 'notifications', 'matangi'],
];
for (const [event_type, aggregate, expectNode] of routeCases) {
  const state = await dispatch({ id: null, event_type, aggregate, payload: { note: 'ok' }, emitted_by: 'selftest' });
  assert(state.verdict === 'DONE', `${event_type} → DONE`);
  assert(state.__path.includes(expectNode), `${event_type} visited '${expectNode}'`);
  assert(noLoops(state), `${event_type} path has no repeated node (${state.__path.join('→')})`);
}

// ── 2. multi-subscriber event runs BOTH workers, still no loop ──────────────
console.log('\n[2] multi-subscriber (TARA + MATANGI) sequencing');
{
  const state = await dispatch({ id: null, event_type: 'customer.payment.received', aggregate: 'ledger', payload: { amount: '15000.00' }, emitted_by: 'selftest' });
  assert(state.__path.includes('tara') && state.__path.includes('matangi'), 'both tara and matangi ran');
  assert(noLoops(state), 'no repeated node in multi-worker path');
  assert(state.verdict === 'DONE', 'multi-worker event → DONE');
}

// ── 3. hostile payload is quarantined before any worker ─────────────────────
console.log('\n[3] shield quarantine — workers must never see an attack');
{
  handled.length = 0;
  const state = await dispatch({
    id: 'evt-hostile', event_type: 'trip.gps.ping', aggregate: 'trips',
    payload: { note: '<script>fetch("http://evil")</script>', __proto__foo: 1, ['__proto__']: { admin: true } },
    emitted_by: 'selftest',
  });
  assert(state.verdict === 'QUARANTINED', 'hostile payload → QUARANTINED');
  assert(!state.__path.includes('kali'), 'worker kali never ran on hostile payload');
  assert(handled.length === 0, 'no agent handler executed');
  assert(completed.some(([v, id]) => v === 'FAILED' && id === 'evt-hostile'), 'outbox marked FAILED (no retry of attacks)');
}

// ── 4. CEO financial vault hold ─────────────────────────────────────────────
console.log('\n[4] KAMALA vault hold — healed money on a ledger event stops workers');
{
  handled.length = 0;
  // A control character inside a money field forces a heal — and healed money
  // on a ledger event is exactly what the CEO must refuse to let through.
  const dirtyAmount = '1500' + String.fromCharCode(7) + '0.00';
  const state = await dispatch({
    id: null, event_type: 'ledger.audit.requested', aggregate: 'ledger',
    payload: { amount: dirtyAmount },
    emitted_by: 'selftest',
  });
  assert(state.ceo_directive.financial_hold === true, 'financial_hold raised');
  assert(state.verdict === 'QUARANTINED', 'held event → QUARANTINED verdict');
  assert(handled.length === 0, 'TARA never ran under CEO hold');
}

// ── 5. unknown event terminates cleanly (audit-only) ────────────────────────
console.log('\n[5] unknown event — audit-only, terminates DONE');
{
  const state = await dispatch({ id: null, event_type: 'totally.unknown.event', aggregate: 'general', payload: {}, emitted_by: 'selftest' });
  assert(state.verdict === 'DONE', 'unknown event → DONE');
  assert(state.ceo_directive.route_plan.length === 0, 'empty route plan');
  assert(noLoops(state), 'no loops on empty plan');
}

// ── 6. the recursion guard itself works ─────────────────────────────────────
console.log('\n[6] recursion guard — a cyclic graph must throw, never spin');
{
  const g = new StateGraph();
  g.addNode('a', async () => ({}));
  g.addNode('b', async () => ({}));
  g.addEdge('a', 'b');
  g.addEdge('b', 'a'); // deliberate cycle
  g.setEntryPoint('a');
  const cyclic = g.compile({ recursionLimit: 10 });
  let threw = false;
  try { await cyclic.invoke({}); } catch (e) { threw = e instanceof GraphRecursionError; }
  assert(threw, 'GraphRecursionError thrown at the limit');
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
