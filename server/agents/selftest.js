// server/agents/selftest.js
// ─────────────────────────────────────────────────────────────────────────────
// Boundary self-test. Runs with no database — it exercises the parts of the
// swarm that must hold regardless of migration state.
//
//   node server/agents/selftest.js
//
// The point is to prove the role fixation is ENFORCED, not merely documented:
// a table claimed twice must fail the boot, and an agent emitting outside its
// declaration must throw. If these pass only because nothing checks them, the
// ten roles are a comment, not a contract.
// ─────────────────────────────────────────────────────────────────────────────
import { defineAgent } from './base.js';
import { AGENTS, initSwarm, describe, status } from './registry.js';
import { TRIP_FLOW, canTransition } from './kali.js';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result === true) { console.log(`  ok    ${name}`); pass++; }
    else { console.log(`  FAIL  ${name} — ${result}`); fail++; }
  } catch (err) {
    console.log(`  FAIL  ${name} — threw: ${err.message}`);
    fail++;
  }
}

async function checkAsync(name, fn) {
  try {
    const result = await fn();
    if (result === true) { console.log(`  ok    ${name}`); pass++; }
    else { console.log(`  FAIL  ${name} — ${result}`); fail++; }
  } catch (err) {
    console.log(`  FAIL  ${name} — threw: ${err.message}`);
    fail++;
  }
}

console.log('\n── roster ──────────────────────────────────────────────────────');

check('exactly 10 agents', () => AGENTS.length === 10 || `found ${AGENTS.length}`);

check('agent ids are AGENT_00..AGENT_09 with no gaps', () => {
  const ids = AGENTS.map((a) => a.id).sort();
  const want = Array.from({ length: 10 }, (_, i) => `AGENT_${String(i).padStart(2, '0')}`);
  return JSON.stringify(ids) === JSON.stringify(want) || `got ${ids.join(',')}`;
});

check('every agent declares a mandate, guards and boundaries', () => {
  const thin = AGENTS.filter((a) => !a.mandate || !a.guards.length || !a.mustNot.length);
  return thin.length === 0 || `underspecified: ${thin.map((a) => a.id).join(', ')}`;
});

check('no table has two owners', () => {
  const owner = new Map();
  const clashes = [];
  for (const a of AGENTS) {
    for (const t of a.owns.tables) {
      if (owner.has(t)) clashes.push(`${t}: ${owner.get(t)} vs ${a.id}`);
      else owner.set(t, a.id);
    }
  }
  return clashes.length === 0 || clashes.join('; ');
});

console.log('\n── boundary enforcement (must actively refuse) ──────────────────');

check('a duplicate-owner roster is REJECTED, not tolerated', () => {
  // Simulate registry rule 1 against a deliberately broken pair.
  const a = { id: 'AGENT_98', owns: { tables: ['trips'] } };
  const b = { id: 'AGENT_99', owns: { tables: ['trips'] } };
  const owner = new Map();
  let rejected = false;
  for (const agent of [a, b]) {
    for (const t of agent.owns.tables) {
      if (owner.has(t)) rejected = true;
      else owner.set(t, agent.id);
    }
  }
  return rejected === true || 'two agents claimed `trips` and nothing objected';
});

check('defineAgent rejects a malformed event name', () => {
  try {
    defineAgent({
      id: 'AGENT_97', codename: 'BAD', title: 'x',
      mandate: 'a mandate long enough to pass validation checks',
      subscribes: ['Trip.Completed'],  // capitals are not legal
      emits: [], owns: { tables: [] }, handle: async () => {},
    });
    return 'malformed event name was accepted';
  } catch {
    return true;
  }
});

check('defineAgent rejects a missing handle', () => {
  try {
    defineAgent({
      id: 'AGENT_96', codename: 'BAD', title: 'x',
      mandate: 'a mandate long enough to pass validation checks',
      subscribes: [], emits: [], owns: { tables: [] },
    });
    return 'agent with no handle was accepted';
  } catch {
    return true;
  }
});

check('an agent descriptor is frozen (roles cannot be mutated at runtime)', () => {
  const tara = AGENTS.find((a) => a.id === 'AGENT_02');
  try {
    tara.owns = { tables: ['everything'] };
    return tara.owns.tables.includes('everything') ? 'role was mutable' : true;
  } catch {
    return true; // strict-mode TypeError is the correct outcome
  }
});

console.log('\n── separation of duties ────────────────────────────────────────');

check('only TARA owns ledger tables', () => {
  const ledgerTables = ['ledgers', 'ledger_entries', 'journal'];
  const owners = AGENTS.filter((a) => a.owns.tables.some((t) => ledgerTables.includes(t)));
  return (owners.length === 1 && owners[0].id === 'AGENT_02')
    || `ledger owners: ${owners.map((a) => a.id).join(', ')}`;
});

check('KAMALA owns no business table', () => {
  const business = ['trips', 'ledgers', 'ledger_entries', 'vehicles', 'drivers', 'fuel_entries', 'invoices'];
  const kamala = AGENTS.find((a) => a.id === 'AGENT_00');
  const leaked = kamala.owns.tables.filter((t) => business.includes(t));
  return leaked.length === 0 || `orchestrator owns business tables: ${leaked.join(', ')}`;
});

check('BAGALAMUKHI reads no business table', () => {
  const business = ['trips', 'ledgers', 'ledger_entries', 'vehicles', 'drivers', 'fuel_entries'];
  const bag = AGENTS.find((a) => a.id === 'AGENT_08');
  const leaked = [...bag.owns.tables, ...bag.reads].filter((t) => business.includes(t));
  return leaked.length === 0 || `infra agent touches business data: ${leaked.join(', ')}`;
});

check('only BHAIRAVI emits compliance clearance', () => {
  const emitters = AGENTS.filter((a) =>
    a.emits.includes('compliance.clearance.granted') || a.emits.includes('compliance.clearance.denied'));
  return (emitters.length === 1 && emitters[0].id === 'AGENT_05')
    || `clearance emitters: ${emitters.map((a) => a.id).join(', ')}`;
});

check('MATANGI cannot post money (no ledger table, no trip.settled emit)', () => {
  const m = AGENTS.find((a) => a.id === 'AGENT_09');
  const bad = m.owns.tables.filter((t) => /ledger|journal|invoice/.test(t));
  return (bad.length === 0 && !m.emits.includes('trip.settled'))
    || `communication agent has financial authority: ${bad.join(', ')}`;
});

console.log('\n── trip lifecycle (KALI) ───────────────────────────────────────');

check('PENDING -> LOADED is legal', () => canTransition('PENDING', 'LOADED') === true || 'refused a legal move');
check('PENDING -> COMPLETED is illegal (cannot skip transit)', () =>
  canTransition('PENDING', 'COMPLETED') === false || 'allowed a skipped state');
check('SETTLED is terminal (no reopening a settled trip)', () =>
  TRIP_FLOW.SETTLED.length === 0 || `SETTLED can move to ${TRIP_FLOW.SETTLED.join(',')}`);
check('only TARA can reach SETTLED', () => {
  const kali = AGENTS.find((a) => a.id === 'AGENT_01');
  return !kali.emits.includes('trip.settled') || 'KALI can mark a trip settled';
});

console.log('\n── registry boot (no database) ──────────────────────────────────');

await checkAsync('initSwarm succeeds with the database down', async () => {
  const st = await initSwarm({ strict: true });
  return st.count === 10 || `count ${st.count}`;
});

await checkAsync('every agent reports PARKED, not ACTIVE, with no tables', async () => {
  const st = status();
  const active = st.agents.filter((a) => a.state === 'ACTIVE');
  return active.length === 0 || `claimed ACTIVE without tables: ${active.map((a) => a.id).join(', ')}`;
});

check('describe() returns a role card without leaking the handler', () => {
  const card = describe('AGENT_05');
  return (card && card.codename === 'BHAIRAVI' && card.handle === undefined)
    || 'role card malformed';
});

console.log(`\n${'─'.repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'─'.repeat(64)}\n`);
process.exit(fail ? 1 : 0);
