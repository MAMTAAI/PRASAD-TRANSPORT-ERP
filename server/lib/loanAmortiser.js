// server/lib/loanAmortiser.js
// ─────────────────────────────────────────────────────────────────────────────
// Turn a vehicle loan contract into the schedule the lender is actually going to
// collect, and say what is still owed on any given date.
//
// THE INSTALMENT IS NOT FLAT. Every one of these 29 contracts steps up. TATA
// 5004384745 reads 001-001 at 30,301, 002-006 at 30,285, then 007-058 at
// 1,12,987 — a low run while the truck is being bodied and earning nothing, and
// the contractual EMI after that. A model that takes one EMI figure is wrong in
// all 58 months: by 82,702 in each of the six low ones, and by whatever the
// average concealed in the rest. Tiers are the input here, never a single
// amount.
//
// THE RATE IS SOLVED, NOT READ. Every TATA contract prints an "IRR" — 10.5301%
// on the 46-lakh chassis loans — and that number does not reproduce the
// contract's own cash flows. Amortise 46,00,000 at 10.5301% against the
// instalments the same contract prints and the balance ends 62,047 short of
// zero. The rate that closes it is 10.8625%, and only at that rate does the
// model repay exactly 46,00,000 of principal and charge exactly 14,57,050 of
// interest — the two figures the lender itself prints on page one.
//
// So the instalments are taken as fact and the rate is derived from them. That
// is the right way round: the instalment amounts are what the borrower is
// contractually obliged to pay and what will actually leave the bank account,
// while the printed IRR is a disclosure computed on some other convention that
// the statement does not explain.
//
// ── THE MORATORIUM, AND WHY ITS INTEREST IS NOT CAPITALISED ─────────────────
// Disbursal and the first instalment are not in consecutive months. 5004384745
// pays out on 14-07-2022 and first collects on 11-09-2022 — a 59-day lead
// period that the contract prints and that money is plainly outstanding across.
//
// The obvious treatment is to accrue interest over it and start the schedule
// from a larger balance. That treatment is WRONG for these contracts, and it
// was tested rather than assumed. Capitalising the lead period moves the solved
// rate AWAY from the printed one on all three contracts that print both:
//
//     contract       printed     no lead accrual     lead capitalised
//     5004384745     10.5301%       10.8625%             10.1836%
//     5004389919     10.3320%       10.5020%              9.9196%
//     5003502544     13.0194%       13.0005%             12.5268%
//
// On 5003502544 the plain schedule lands within 0.019% of the printed rate and
// closes 3,302 from zero on a 47.6-lakh loan. So TATA does not add the lead
// period to the principal; it discloses it and amortises the raw finance amount
// from the first instalment date. The schedule follows the lender.
//
// The lead period is still reported — `lead_period_days` and the interest it
// would represent — because the alternative is a difference between our rate
// and the printed one that nobody can account for. Disclosed, not buried.
//
// ── DUE DATES SURVIVE SHORT MONTHS ─────────────────────────────────────────
// An instalment due on the 31st cannot fall on the 31st of February. Naive
// month arithmetic rolls it forward instead: from 31-01-2023 the old code
// produced 03-03-2023 for instalment 2 and 01-05-2023 for instalment 4, so the
// schedule silently skipped February and April and every date after it was
// wrong. It never fired on the live loans — they collect on the 2nd, 7th, 11th
// and 24th — which is exactly why it would have stayed hidden until a loan with
// a month-end due date arrived. Dates are clamped to the last day of the month.
//
// MONEY IS INTEGER PAISE. Never floats: 0.1 + 0.2 is not 0.3, and a loan
// schedule compounds that error 58 times before anyone looks at it.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86400000;

/** Contractual instalments expanded one per month, in paise.
 *
 *  Accepts either shape the codebase has used: {from_month,to_month,amount} as
 *  stored in loan_master.emi_slabs, or {from_instalment,to_instalment,
 *  emi_amount} as held in loan_emi_tiers. One reader, so a caller cannot pick
 *  the wrong one and get an empty schedule.
 */
export function expandSlabs(slabs) {
  const norm = [...(slabs ?? [])].map((s) => ({
    from: Number(s.from_month ?? s.from_instalment),
    to: Number(s.to_month ?? s.to_instalment),
    amount: Number(s.amount ?? s.emi_amount),
  }));
  for (const s of norm) {
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from < 1 || s.to < s.from) {
      throw Object.assign(new Error(`instalment tier ${s.from}-${s.to} is not a range`),
        { code: 'BAD_TIER' });
    }
    if (!(s.amount > 0)) {
      throw Object.assign(new Error(`instalment tier ${s.from}-${s.to} has no amount`),
        { code: 'BAD_TIER' });
    }
  }
  norm.sort((a, b) => a.from - b.from);

  // A gap here is the failure that adds up to a plausible number and bills two
  // instalments fewer than the contract. Caught before it becomes a schedule.
  if (norm.length && norm[0].from !== 1) {
    throw Object.assign(new Error(`instalment tiers start at ${norm[0].from}, not 1`),
      { code: 'TIER_GAP' });
  }
  for (let i = 1; i < norm.length; i++) {
    if (norm[i].from !== norm[i - 1].to + 1) {
      throw Object.assign(
        new Error(`instalment tiers ${norm[i - 1].to} and ${norm[i].from} do not meet`),
        { code: 'TIER_GAP' });
    }
  }

  const out = [];
  for (const s of norm) {
    const paise = Math.round(s.amount * 100);
    for (let i = s.from; i <= s.to; i++) out.push(paise);
  }
  return out;
}

/** n months after `d`, clamped to the last day of the target month. */
export function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  // Day 0 of month m+n+1 is the last day of month m+n — how many days it has.
  const lastDay = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + n, Math.min(day, lastDay)));
}

/** Closing balance in paise after running the whole schedule at monthly rate r. */
function closingPaise(principalPaise, r, emis) {
  let bal = principalPaise;
  for (const emi of emis) {
    const interest = Math.round(bal * r);
    bal -= (emi - interest);
  }
  return bal;
}

/**
 * The monthly rate implied by the lender's own instalments.
 *
 * Closing balance rises with the rate — more of each instalment goes to interest
 * and less to principal — so a plain bisection converges. 200 iterations takes
 * the bracket well below a paise; the loop is cheap and the alternative is
 * trusting a printed figure that demonstrably does not fit.
 */
export function solveMonthlyRate(principalPaise, emis) {
  let lo = 0, hi = 0.05;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (closingPaise(principalPaise, mid, emis) > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Build the full schedule.
 *
 *   principal   the finance amount, as the lender states it
 *   slabs       instalment tiers (either field spelling — see expandSlabs)
 *   firstDue    date of instalment 1; instalments run monthly from there
 *   disbursal   optional, and only used to report the moratorium
 *   rate        optional annual %, to override the solved one
 *
 * Returns rows with paise as well as rupees so the caller never has to re-round.
 */
export function buildSchedule({ principal, slabs, tiers, firstDue, disbursal = null, rate = null }) {
  const principalPaise = Math.round(Number(principal) * 100);
  if (!(principalPaise > 0)) {
    throw Object.assign(new Error('principal must be positive'), { code: 'NO_PRINCIPAL' });
  }
  const emis = expandSlabs(tiers ?? slabs);
  if (!emis.length) throw Object.assign(new Error('no instalment slabs'), { code: 'NO_SLABS' });
  if (!firstDue) throw Object.assign(new Error('no first instalment date'), { code: 'NO_FIRST_DUE' });

  const d0 = new Date(`${String(firstDue).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d0.getTime())) {
    throw Object.assign(new Error(`unreadable first instalment date ${firstDue}`),
      { code: 'NO_FIRST_DUE' });
  }

  // The moratorium, measured rather than assumed. A first instalment before the
  // money went out is not a lead period, it is a misread date, and it must not
  // quietly become a negative one.
  let leadDays = null, moratoriumMonths = null;
  if (disbursal) {
    const db = new Date(`${String(disbursal).slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(db.getTime())) {
      if (d0 < db) {
        throw Object.assign(
          new Error(`first instalment ${firstDue} precedes disbursal ${disbursal}`),
          { code: 'FIRST_DUE_BEFORE_DISBURSAL' });
      }
      leadDays = Math.round((d0 - db) / DAY);
      // Instalment months skipped: had there been no moratorium the first
      // instalment would have fallen one month after disbursal.
      moratoriumMonths = Math.max(0,
        (d0.getUTCFullYear() - db.getUTCFullYear()) * 12 + (d0.getUTCMonth() - db.getUTCMonth()) - 1);
    }
  }

  const r = rate != null ? Number(rate) / 1200 : solveMonthlyRate(principalPaise, emis);

  let bal = principalPaise;
  const rows = [];
  for (let n = 0; n < emis.length; n++) {
    const due = addMonths(d0, n);
    const interest = Math.round(bal * r);
    const principalPart = emis[n] - interest;
    bal -= principalPart;
    rows.push({
      month_no: n + 1,
      date: due.toISOString().slice(0, 10),
      emi: (emis[n] / 100).toFixed(2),
      interest: (interest / 100).toFixed(2),
      principal: (principalPart / 100).toFixed(2),
      balance: (bal / 100).toFixed(2),
      emi_paise: emis[n], interest_paise: interest,
      principal_paise: principalPart, balance_paise: bal,
    });
  }

  // Disclosed, not capitalised — see the header. This is what the lead period
  // would have cost at the schedule's own rate, and it is why the solved rate
  // sits above the printed one.
  const leadInterest = leadDays == null ? null
    : Math.round(principalPaise * r * (leadDays / 30)) / 100;

  return {
    annual_rate: Number((r * 1200).toFixed(6)),
    rows,
    instalments: rows.length,
    first_due: rows[0].date,
    last_due: rows[rows.length - 1].date,
    lead_period_days: leadDays,
    moratorium_months: moratoriumMonths,
    moratorium_interest: leadInterest,
    total_emi: (emis.reduce((a, b) => a + b, 0) / 100).toFixed(2),
    total_interest: (rows.reduce((a, x) => a + x.interest_paise, 0) / 100).toFixed(2),
    closing_balance: (bal / 100).toFixed(2),
  };
}

/**
 * What is still owed on a date — the balance after the last instalment that fell
 * due strictly before it.
 *
 * Strictly before, because an instalment due ON the cut-off has not yet been
 * paid at the moment the opening balance is struck. Counting it would understate
 * the liability by a whole instalment's principal.
 */
export function positionAt(schedule, onDate) {
  const past = schedule.rows.filter((x) => x.date < onDate);
  if (!past.length) {
    const first = schedule.rows[0];
    return { emis_completed: 0, principal_outstanding: (first.balance_paise + first.principal_paise) / 100,
             next_due: first.date, next_month_no: 1 };
  }
  const last = past[past.length - 1];
  const next = schedule.rows[past.length] ?? null;
  return {
    emis_completed: past.length,
    principal_outstanding: last.balance_paise / 100,
    interest_charged_to_date: past.reduce((a, x) => a + x.interest_paise, 0) / 100,
    next_due: next?.date ?? null,
    next_month_no: next?.month_no ?? null,
  };
}

/** Instalments falling due within [from, to] inclusive. */
export function dueBetween(schedule, from, to) {
  return schedule.rows.filter((x) => x.date >= from && x.date <= to);
}

/**
 * The instalment amount contracted for a given instalment number.
 *
 * The step-up question asked directly, for a caller that has one instalment and
 * needs its amount without building 58 rows.
 */
export function tierAmountFor(slabs, instalmentNo) {
  for (const s of slabs ?? []) {
    const from = Number(s.from_month ?? s.from_instalment);
    const to = Number(s.to_month ?? s.to_instalment);
    if (instalmentNo >= from && instalmentNo <= to) return Number(s.amount ?? s.emi_amount);
  }
  return null;
}
