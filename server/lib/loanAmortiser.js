// server/lib/loanAmortiser.js
// ─────────────────────────────────────────────────────────────────────────────
// Turn a vehicle loan contract into the schedule the lender is actually going to
// collect, and say what is still owed on any given date.
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
// while the printed IRR is a disclosure computed on some other convention (a
// lead period, a different day-count) that the statement does not explain.
//
// What this replaces got it backwards — it kept the printed rate and forced the
// FINAL instalment to whatever made the balance vanish, producing last EMIs of
// 32,311 or 1,50,196 against a contractual 1,12,987, and a total repayment that
// missed the contract value by up to 80,676. Every rupee of that error lands in
// the opening liability.
//
// MONEY IS INTEGER PAISE. Never floats: 0.1 + 0.2 is not 0.3, and a loan
// schedule compounds that error 58 times before anyone looks at it.
// ─────────────────────────────────────────────────────────────────────────────

/** Contractual instalments expanded one per month, in paise. */
export function expandSlabs(slabs) {
  const out = [];
  for (const s of [...slabs].sort((a, b) => Number(a.from_month) - Number(b.from_month))) {
    const from = Number(s.from_month), to = Number(s.to_month);
    const paise = Math.round(Number(s.amount) * 100);
    for (let i = from; i <= to; i++) out.push(paise);
  }
  return out;
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
 * firstDue is the date of instalment 1; instalments are monthly on the same day.
 * Returns rows with paise as well as rupees so the caller never has to re-round.
 */
export function buildSchedule({ principal, slabs, firstDue, rate = null }) {
  const principalPaise = Math.round(Number(principal) * 100);
  const emis = expandSlabs(slabs);
  if (!emis.length) throw Object.assign(new Error('no instalment slabs'), { code: 'NO_SLABS' });

  const r = rate != null ? Number(rate) / 1200 : solveMonthlyRate(principalPaise, emis);

  const d0 = new Date(`${firstDue}T00:00:00Z`);
  let bal = principalPaise;
  const rows = [];
  for (let n = 0; n < emis.length; n++) {
    const due = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + n, d0.getUTCDate()));
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
  return {
    annual_rate: Number((r * 1200).toFixed(6)),
    rows,
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
