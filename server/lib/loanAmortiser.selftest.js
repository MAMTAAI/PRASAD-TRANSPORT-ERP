// server/lib/loanAmortiser.selftest.js
// ─────────────────────────────────────────────────────────────────────────────
// Boundary self-test for the loan schedule builder. No database.
//
//   node server/lib/loanAmortiser.selftest.js
//
// EVERY CASE HERE IS A BUG THAT SHIPPED OR NEARLY DID. None of them are
// hypothetical, and all of them share a failure mode: they produce a schedule
// that looks entirely reasonable and is wrong.
//
//   · A due date on the 31st rolled into the 3rd of the month after next, so a
//     schedule silently skipped February and every date after it was wrong. The
//     live loans collect on the 2nd, 7th, 11th and 24th, so it never fired —
//     which is exactly why it needed a test rather than a reader.
//   · A gap between instalment tiers means two months are never billed. The
//     total still looks plausible.
//   · A first instalment dated before disbursal produces a negative lead period
//     and, with it, a negative moratorium.
//   · The contract's own printed totals — contract value and interest amount —
//     are the only external check on the whole model, so they are asserted
//     against the real 46-lakh and 10-lakh TATA contracts.
// ─────────────────────────────────────────────────────────────────────────────
import { buildSchedule, expandSlabs, addMonths, tierAmountFor } from './loanAmortiser.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  ok    ${name}`); pass++; }
    else { console.log(`  FAIL  ${name} — ${r}`); fail++; }
  } catch (e) {
    console.log(`  FAIL  ${name} — threw: ${e.message}`); fail++;
  }
}

const iso = (d) => d.toISOString().slice(0, 10);

// The real contracts, as TATA prints them.
const CHASSIS = {
  principal: 4600000, firstDue: '2022-09-11', disbursal: '2022-07-14',
  contract_value: 6057050, interest: 1457050,
  tiers: [{ from_instalment: 1, to_instalment: 1, emi_amount: 30301 },
          { from_instalment: 2, to_instalment: 6, emi_amount: 30285 },
          { from_instalment: 7, to_instalment: 58, emi_amount: 112987 }],
};
const BODY = {
  principal: 1000000, firstDue: '2022-09-02', disbursal: '2022-07-21',
  contract_value: 1244800, interest: 244800,
  tiers: [{ from_instalment: 1, to_instalment: 1, emi_amount: 10372 },
          { from_instalment: 2, to_instalment: 6, emi_amount: 10373 },
          { from_instalment: 7, to_instalment: 47, emi_amount: 28843 }],
};

console.log('\n  loan amortiser\n');

// ── dates ──────────────────────────────────────────────────────────────────
check('a 31st due date lands on the last day of a short month, not the next one', () => {
  const d = new Date('2023-01-31T00:00:00Z');
  const got = [0, 1, 2, 3, 4].map((n) => iso(addMonths(d, n)));
  const want = ['2023-01-31', '2023-02-28', '2023-03-31', '2023-04-30', '2023-05-31'];
  return String(got) === String(want) || `got ${got}`;
});

check('29 February is reached from a 29th, and clamped in a common year', () => {
  const d = new Date('2024-01-29T00:00:00Z');       // 2024 is a leap year
  return iso(addMonths(d, 1)) === '2024-02-29'
    && iso(addMonths(new Date('2023-01-29T00:00:00Z'), 1)) === '2023-02-28'
    || 'February handled wrong';
});

check('the schedule keeps the contractual day of the month across a year', () => {
  const s = buildSchedule(CHASSIS);
  const wrong = s.rows.filter((r) => !r.date.endsWith('-11'));
  return wrong.length === 0 || `${wrong.length} rows moved off the 11th, first ${wrong[0].date}`;
});

// ── the moratorium ─────────────────────────────────────────────────────────
check('the lead period is measured, not assumed', () => {
  const s = buildSchedule(CHASSIS);
  // 14-07-2022 to 11-09-2022, which is what the contract prints as 59 DAYS.
  return (s.lead_period_days === 59 && s.moratorium_months === 1)
    || `lead ${s.lead_period_days}d / ${s.moratorium_months}mo`;
});

check('a first instalment before disbursal is refused, not made negative', () => {
  try {
    buildSchedule({ ...CHASSIS, firstDue: '2022-06-01' });
    return 'accepted a first instalment two months before the money went out';
  } catch (e) {
    return e.code === 'FIRST_DUE_BEFORE_DISBURSAL' || `wrong code ${e.code}`;
  }
});

check('the first instalment falls on the contracted date, not a month after disbursal', () => {
  const s = buildSchedule(CHASSIS);
  return s.first_due === '2022-09-11' || `first instalment ${s.first_due}`;
});

// ── tiers ──────────────────────────────────────────────────────────────────
check('a gap between tiers is refused', () => {
  try {
    expandSlabs([{ from_month: 1, to_month: 6, amount: 100 },
                 { from_month: 8, to_month: 10, amount: 200 }]);
    return 'accepted a schedule that never bills instalments 7';
  } catch (e) { return e.code === 'TIER_GAP' || `wrong code ${e.code}`; }
});

check('tiers that do not start at instalment 1 are refused', () => {
  try {
    expandSlabs([{ from_month: 2, to_month: 6, amount: 100 }]);
    return 'accepted a schedule with no first instalment';
  } catch (e) { return e.code === 'TIER_GAP' || `wrong code ${e.code}`; }
});

check('overlapping tiers are refused', () => {
  try {
    expandSlabs([{ from_month: 1, to_month: 6, amount: 100 },
                 { from_month: 5, to_month: 10, amount: 200 }]);
    return 'accepted a schedule that bills instalments 5 and 6 twice';
  } catch (e) { return e.code === 'TIER_GAP' || `wrong code ${e.code}`; }
});

check('both field spellings expand identically', () => {
  const a = expandSlabs([{ from_month: 1, to_month: 3, amount: 500 }]);
  const b = expandSlabs([{ from_instalment: 1, to_instalment: 3, emi_amount: 500 }]);
  return String(a) === String(b) && a.length === 3 || `${a} vs ${b}`;
});

check('the step-up is applied per instalment, not averaged', () => {
  const s = buildSchedule(CHASSIS);
  return s.rows[0].emi === '30301.00' && s.rows[5].emi === '30285.00'
    && s.rows[6].emi === '112987.00' && s.rows[57].emi === '112987.00'
    || `1:${s.rows[0].emi} 6:${s.rows[5].emi} 7:${s.rows[6].emi}`;
});

check('tierAmountFor answers for a single instalment', () => {
  return tierAmountFor(CHASSIS.tiers, 3) === 30285
    && tierAmountFor(CHASSIS.tiers, 7) === 112987
    && tierAmountFor(CHASSIS.tiers, 99) === null
    || 'wrong tier lookup';
});

// ── the lender's own arithmetic ────────────────────────────────────────────
for (const [name, c] of [['46-lakh chassis', CHASSIS], ['10-lakh body', BODY]]) {
  check(`${name}: the schedule totals the printed contract value`, () => {
    const s = buildSchedule(c);
    return Math.abs(Number(s.total_emi) - c.contract_value) <= 1
      || `${s.total_emi} against ${c.contract_value}`;
  });
  check(`${name}: interest charged matches the printed interest amount`, () => {
    const s = buildSchedule(c);
    return Math.abs(Number(s.total_interest) - c.interest) <= 1
      || `${s.total_interest} against ${c.interest}`;
  });
  check(`${name}: the balance closes at zero`, () => {
    const s = buildSchedule(c);
    return Math.abs(Number(s.closing_balance)) <= 1 || `closes at ${s.closing_balance}`;
  });
  check(`${name}: instalment count matches the tiers`, () => {
    const s = buildSchedule(c);
    const want = c.tiers[c.tiers.length - 1].to_instalment;
    return s.instalments === want || `${s.instalments} rows for ${want} instalments`;
  });
}

// ── the low instalments really do not cover their interest ─────────────────
check('the moratorium instalments are flagged by a negative principal, not hidden', () => {
  const s = buildSchedule(CHASSIS);
  // 30,285 against ~41,600 of interest: the debt grows for six months. That is
  // what the contract says, and the EMI poster refuses to post those months
  // rather than debiting a negative principal.
  const growing = s.rows.filter((r) => Number(r.principal) < 0).length;
  return growing === 6 || `${growing} instalments do not cover their interest, expected 6`;
});

console.log(`\n${'─'.repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'─'.repeat(64)}\n`);
process.exit(fail ? 1 : 0);
