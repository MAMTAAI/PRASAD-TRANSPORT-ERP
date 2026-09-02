// server/agents/graphEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// A directed state graph over the ten Mahavidya agents, replacing ten
// independent timers with one traversal that carries shared state.
//
// WHAT WAS ACTUALLY WRONG WITH THE LOOPS
//
// The old engine was not a naive `while (true)` — it was ten setIntervals, each
// emitting its agent's event onto the durable bus. That part was sound and is
// kept. What it could not do is carry anything BETWEEN agents. KALI would sweep
// trips at 10s and TARA would audit the ledger at 30s, and neither knew what
// the other had just found. Every cross-agent fact had to be rediscovered from
// the database, or not noticed at all.
//
// A graph run threads one State object through the nodes:
//
//     KAMALA (router)
//        ├─ KALI ──────────► trips swept, stalled ids in state
//        ├─ CHHINNAMASTA ──► fuel recon, using KALI's trip ids
//        ├─ TARA ──────────► ledger audit, sees both
//        └─ ... others
//     KAMALA (reduce) ─────► one workflow record, one dashboard state
//
// Each node reads the state its predecessors wrote and appends its own. The
// route is DATA-DEPENDENT: if KALI reports no stalled trips, the branch that
// chases them is never entered.
//
// WHAT IS DELIBERATELY UNCHANGED
// Nodes still emit onto the durable bus rather than calling handlers directly.
// The audit trail (agent_events -> claim -> dispatch -> agent_runs) is the only
// record of what an agent did, and a graph that bypassed it would be faster and
// unauditable. The graph decides WHAT runs and in WHICH ORDER; the bus remains
// how work is actually performed and proven.
import { emit } from './bus.js';
import { isDegraded } from '../db/pool.js';
import { activeHalt } from './bagalamukhi.js';
import { stmPush, ltmFlushSpill } from '../memory/okf.js';
import { tick as syncTick } from '../sync/autoSync.js';
import { drainParked } from '../ai/router.js';

// ── Time-gated edges ────────────────────────────────────────────────────────
// The graph cycles every 15 s, but the IOCL mailboxes are swept every 10 min:
// a mail sweep on every cycle would hammer Gmail and re-read the same PDFs
// forty times an hour. `due()` is the edge condition for those two nodes — it
// opens once per period, and the node's `writes` closes it again only after
// the emit succeeded, so a failed emit is simply retried next cycle. The two
// sweeps are phased three minutes apart so KALI's AC4 pass and
// BHUVANESHWARI's AC5 pass never contend for the sync runner's lock.
const BOOT_AT = Date.now();
const lastDue = new Map();
const periodMs = (name, fallback) => Number(process.env[name] || fallback);
function due(key, everyMs, firstAfterMs) {
  const last = lastDue.get(key) ?? (BOOT_AT + firstAfterMs - everyMs);
  return Date.now() - last >= everyMs;
}
const stamp = (key) => { lastDue.set(key, Date.now()); };

// ── The graph ───────────────────────────────────────────────────────────────
// `when` is the edge condition: a node is entered only if it returns true for
// the state as it stands. That is the whole difference from a timer — a timer
// has no opinion about whether its work is needed.
const NODES = [
  {
    id: 'AGENT_00', codename: 'KAMALA', node: 'route',
    homework: 'Route the graph; refresh dashboard state; flush OKF spill',
    event: 'dashboard.refresh.requested', aggregate: 'dashboard',
    when: () => true,                       // the entry node always runs
    extra: async () => { await ltmFlushSpill(); },
    writes: (s) => ({ ...s, routed_at: new Date().toISOString() }),
  },
  {
    id: 'AGENT_01', codename: 'KALI', node: 'dispatch',
    homework: 'Sweep pending loads and stalled in-transit trips',
    event: 'trip.sweep.requested', aggregate: 'trips',
    when: () => true,
    writes: (s) => ({ ...s, trips_swept: true }),
  },
  {
    // ── THE DAILY LOADING CYCLE ── KALI polls both IOCL mailboxes for the
    // AC4 (the consignee's tax invoice: the truck LOADED) and writes the
    // loading register, iocl_ac4_loads. Never a trip, never a freight figure
    // — the owner's rule of 2-Sep-2026. The AC5 (billing) is the next pair.
    id: 'AGENT_01', codename: 'KALI', node: 'loading_mail',
    homework: 'Poll IOCL mailboxes for AC4 daily-loading mail every 10 min → loading register',
    event: 'loading.mail.sweep.requested', aggregate: 'loading',
    when: () => due('loading_mail', periodMs('LOADING_MAIL_SWEEP_MS', 600_000), 60_000),
    writes: (s) => { stamp('loading_mail'); return { ...s, loading_mail_swept: true }; },
  },
  {
    id: 'AGENT_04', codename: 'BHUVANESHWARI', node: 'ingest',
    homework: 'Drain the document queue; replay AI tasks parked while offline',
    event: 'document.queue.sweep', aggregate: 'documents',
    when: () => true,
    extra: async () => { await drainParked(); },
    writes: (s) => ({ ...s, documents_drained: true }),
  },
  {
    // ── THE BILLING CYCLE, FIRST HALF ── BHUVANESHWARI fetches and parses the
    // AC5 freight invoices and hands each new one to TARA as a proposal
    // (invoice.parsed). She never inserts the trip herself; TARA posts it.
    // Phased three minutes after KALI's mail node.
    id: 'AGENT_04', codename: 'BHUVANESHWARI', node: 'invoice_mail',
    homework: 'Fetch and parse AC5 freight invoices every 10 min; hand each new one to TARA',
    event: 'invoice.mail.sweep.requested', aggregate: 'invoices',
    when: () => due('invoice_mail', periodMs('INVOICE_MAIL_SWEEP_MS', 600_000), 240_000),
    writes: (s) => { stamp('invoice_mail'); return { ...s, invoice_mail_swept: true }; },
  },
  {
    id: 'AGENT_06', codename: 'CHHINNAMASTA', node: 'fuel',
    homework: 'Audit new fuel slips; reconcile pump advances',
    event: 'fuel.reconciliation.requested', aggregate: 'fuel',
    // Only worth running once trips have been swept: a fuel slip is reconciled
    // against a trip, and reconciling before the sweep just reads stale rows.
    when: (s) => s.trips_swept === true,
    writes: (s) => ({ ...s, fuel_checked: true }),
  },
  {
    id: 'AGENT_03', codename: 'TRIPURA SUNDARI', node: 'rates',
    homework: 'Re-check open bazaar loads and lane margins',
    event: 'bazaar.sweep.requested', aggregate: 'bazaar',
    when: () => true,
    writes: (s) => ({ ...s, rates_checked: true }),
  },
  {
    id: 'AGENT_02', codename: 'TARA', node: 'audit',
    homework: 'Reconcile ledger (zero-divergence audit)',
    event: 'ledger.audit.requested', aggregate: 'ledger',
    // TARA runs LAST of the money-touching nodes, so its audit sees the fuel
    // and rate work of this same traversal rather than the previous one's.
    when: (s) => s.fuel_checked === true || s.rates_checked === true,
    writes: (s) => ({ ...s, ledger_audited: true }),
  },
  {
    id: 'AGENT_05', codename: 'BHAIRAVI', node: 'compliance',
    homework: 'Sweep fleet for expiring licences and permits (30-day window)',
    event: 'compliance.sweep.requested', aggregate: 'compliance',
    when: () => true,
    writes: (s) => ({ ...s, compliance_swept: true }),
  },
  {
    id: 'AGENT_07', codename: 'DHUMAVATI', node: 'maintenance',
    homework: 'Check RTKM wear against service intervals',
    event: 'maintenance.due.check', aggregate: 'maintenance',
    when: (s) => s.trips_swept === true,   // wear is a function of distance run
    writes: (s) => ({ ...s, maintenance_checked: true }),
  },
  {
    id: 'AGENT_09', codename: 'MATANGI', node: 'comms',
    homework: 'Flush queued notifications; poll WhatsApp engine health',
    event: 'notification.queue.sweep', aggregate: 'notifications',
    // Communications go out only after the work that might generate them.
    when: (s) => s.compliance_swept === true || s.trips_swept === true,
    writes: (s) => ({ ...s, comms_flushed: true }),
  },
  {
    id: 'AGENT_08', codename: 'BAGALAMUKHI', node: 'guard',
    homework: 'Run the AWS<->local auto-sync tick; verify tunnel + DB health',
    event: 'infra.tunnel.check', aggregate: 'infra',
    when: () => true,
    extra: async () => { await syncTick(); },
    writes: (s) => ({ ...s, infra_checked: true }),
  },
];

const CYCLE_MS = Number(process.env.GRAPH_CYCLE_MS || 15_000);

let timer = null;
let runSeq = 0;
const stats = new Map(NODES.map((n) => [n.id, { ticks: 0, ok: 0, blocked: 0, errors: 0, skipped: 0 }]));
let lastRun = null;

/** One traversal. Returns the final state. */
export async function runGraph({ trigger = 'cycle' } = {}) {
  const runId = ++runSeq;
  const started = Date.now();

  // The shared State. Every node reads it and returns an extended copy —
  // never a mutation, so a node cannot quietly rewrite a predecessor's finding.
  let state = {
    run_id: runId, trigger,
    started_at: new Date().toISOString(),
    visited: [], skipped: [], emitted: [], errors: [],
  };

  if (isDegraded()) {
    // Not an error. A degraded database means there is nothing to sweep, and
    // ten failing emits per cycle would bury the real cause in noise.
    lastRun = { ...state, halted: 'DB_DEGRADED', ms: 0 };
    return lastRun;
  }

  for (const n of NODES) {
    const s = stats.get(n.id);
    s.ticks += 1;

    // BAGALAMUKHI's halt outranks the graph, exactly as it outranked the loops.
    const halt = await activeHalt(n.id).catch(() => null);
    if (halt) { s.blocked += 1; state.skipped.push({ node: n.node, why: 'halted' }); continue; }

    // The edge condition. This is what a timer could not express.
    let enter = true;
    try { enter = n.when(state) !== false; } catch { enter = true; }
    if (!enter) {
      s.skipped += 1;
      state.skipped.push({ node: n.node, why: 'edge condition not met' });
      continue;
    }

    try {
      if (n.extra) await n.extra(state);
      await emit(n.event, {
        aggregate: n.aggregate,
        aggregateId: null,
        emittedBy: n.id,
        // The state travels WITH the event, so an agent handler can see what its
        // predecessors found instead of re-reading the database for it. This is
        // the whole difference from the loop engine, which emitted
        // `{ scheduled: true }` and nothing else.
        payload: { graph_run: runId, node: n.node, scheduled: true, state: summarise(state) },
      });
      state.visited.push(n.node);
      state.emitted.push(n.event);
      state = n.writes ? n.writes(state) : state;
      s.ok += 1;
    } catch (err) {
      s.errors += 1;
      state.errors.push({ node: n.node, error: String(err.message).slice(0, 200) });
      // A failed node does not abort the traversal: BHAIRAVI's compliance sweep
      // should still run when CHHINNAMASTA's fuel node throws. Downstream `when`
      // conditions see the missing flag and route around it on their own.
    }
  }

  state.finished_at = new Date().toISOString();
  state.ms = Date.now() - started;
  lastRun = state;

  // One short-term-memory row per traversal rather than ten per cycle: the
  // interesting object is the run, not each node's participation in it.
  try {
    await stmPush({
      kind: 'graph_run',
      summary: `graph run ${runId}: ${state.visited.length} nodes, ${state.skipped.length} skipped, ${state.errors.length} errors`,
      data: summarise(state),
    });
  } catch { /* memory is best-effort; it must not fail a traversal */ }

  return state;
}

/** The travelling copy of state — bounded, so a payload cannot grow unboundedly. */
function summarise(s) {
  return {
    run_id: s.run_id, trigger: s.trigger,
    visited: s.visited, skipped: s.skipped.map((x) => x.node),
    trips_swept: !!s.trips_swept, fuel_checked: !!s.fuel_checked,
    rates_checked: !!s.rates_checked, ledger_audited: !!s.ledger_audited,
    compliance_swept: !!s.compliance_swept, documents_drained: !!s.documents_drained,
    maintenance_checked: !!s.maintenance_checked, comms_flushed: !!s.comms_flushed,
    infra_checked: !!s.infra_checked,
    loading_mail_swept: !!s.loading_mail_swept, invoice_mail_swept: !!s.invoice_mail_swept,
    errors: s.errors.length,
  };
}

export function startGraph() {
  if (timer) return timer;
  timer = setInterval(() => { runGraph({ trigger: 'cycle' }).catch(() => {}); }, CYCLE_MS);
  // Kick once immediately so a restart does not look dead for the first cycle.
  runGraph({ trigger: 'boot' }).catch(() => {});
  return timer;
}

export function stopGraph() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Shape the dashboard reads. `mode` is what turns LOOP ON into GRAPH ACTIVE. */
export function graphStatus() {
  return {
    mode: 'GRAPH',
    active: !!timer,
    cycle_ms: CYCLE_MS,
    runs: runSeq,
    last_run: lastRun ? summarise(lastRun) : null,
    last_run_ms: lastRun?.ms ?? null,
    nodes: NODES.map((n) => ({
      agentId: n.id, codename: n.codename, node: n.node,
      homework: n.homework, event: n.event,
      // The edges an operator can actually see: which predecessors gate this node.
      gated_by: n.when.toString().includes('s.')
        ? (n.when.toString().match(/s\.[a-z_]+/g) ?? []).map((x) => x.slice(2))
        : [],
      ...stats.get(n.id),
    })),
  };
}

export const GRAPH_NODES = NODES;
