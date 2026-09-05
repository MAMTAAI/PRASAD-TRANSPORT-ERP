// server/lib/vehicleBillAgent.js
// ─────────────────────────────────────────────────────────────────────────────
// THE 15-DAY VEHICLE BILL AGENT
//
// "Agent har 15 din par auto vehicle bill ready karega, aur staff check karke
// approve karega." So this builds the DRAFTS and stops. It never approves, and
// it never posts — approval is a person's signature and requireAdminRole holds
// it. An agent that could approve its own work would make maker-checker a
// decoration.
//
// It runs on the 1st and the 16th, closing the fortnight that just ENDED — not
// the one starting today, which has no trips in it yet. A run on the 16th of
// July therefore settles 1–15 July.
//
// SAFE TO RUN TWICE, AND IT WILL BE. vehicle_fortnight_build() refreshes
// untouched AI drafts and steps around anything a person has reviewed or
// approved, so a catch-up run after the box was down cannot undo a reviewer's
// corrections. The row in agent_execution_logs is written at the START, so a
// run that never happened is a missing row rather than an absence of evidence.
import { query } from '../db/pool.js';
import { startRun, startStep, finishRun } from './agentLog.js';
import { autoRaiseCustomerBills } from './customerBillRaise.js';

export const JOB = 'vehicle_fortnight_bills';

/** The IST wall-clock date, as a LOCAL date object. */
export function istToday(d = new Date()) {
  // Rebuilt from parts rather than shifted by +5.5h: on a box already running
  // IST a shift double-counts and lands the fortnight boundary a day out.
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

/** The fortnight that ENDED before `onDate`. */
export function closingFortnight(onDate) {
  const [y, m, d] = onDate.split('-').map(Number);
  if (d >= 16) return `${y}-${String(m).padStart(2, '0')}-01`;      // close 1–15
  // On or before the 15th, the fortnight that ended is the previous month's
  // second half — and its start is the 16th of that month.
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}-16`;
}

/**
 * Build the drafts for one fortnight and report what happened.
 *
 * @param {object}  o
 * @param {string} [o.periodFrom]  which fortnight; defaults to the one that just closed
 * @param {boolean}[o.force]       run even on a day that is not a boundary
 */
export async function runVehicleBillAgent({ periodFrom, force = false, log = console, agent = 'AGENT_02' } = {}) {
  const today = istToday();
  const day = Number(today.slice(8, 10));
  const boundary = day === 1 || day === 16;
  if (!periodFrom && !boundary && !force) {
    return { ran: false, reason: 'NOT_A_BOUNDARY', today };
  }
  const from = periodFrom ?? closingFortnight(today);

  const run = await startRun(JOB, {
    trigger: force ? 'MANUAL' : 'SCHEDULE',
    detail: { period_from: from, today },
  });
  // The day-claim: a scheduled run that did not claim the day is a duplicate —
  // a restart, or a catch-up firing beside the cron. Building again would be
  // harmless but the log would show two runs where one happened.
  if (run.claimed === false && !force) {
    return { ran: false, reason: run.reason ?? 'ALREADY_RAN_TODAY', period_from: from };
  }

  try {
    // TARA (AGENT_02) is the bill expert since 5-Sep-2026: the step is hers.
    await startStep(run.run_id, 'build', { agent_code: agent });
    const { rows: [built] } = await query(
      'SELECT * FROM vehicle_fortnight_build($1::date, $2)', [from, 'agent:TARA']);

    // What the desk now has to do. Reported rather than acted on: a lorry with
    // no commission rate is a decision, and the agent does not take it.
    const { rows: [state] } = await query(`
      SELECT count(*)::int drafts,
             count(*) FILTER (WHERE fleet_class IN ('ATTACHED','MARKET')
                              AND commission_amount IS NULL)::int without_rate,
             count(*) FILTER (WHERE fleet_class = 'OWN')::int own,
             count(*) FILTER (WHERE fleet_class = 'ATTACHED')::int attached,
             count(*) FILTER (WHERE fleet_class = 'MARKET')::int market,
             count(*) FILTER (WHERE fleet_class IS NULL)::int unclassified,
             COALESCE(sum(billed_amount),0)::numeric(14,2) freight,
             COALESCE(sum(commission_amount),0)::numeric(14,2) commission
        FROM vehicle_fortnight_settlements
       WHERE period_from = $1::date AND status = 'AI_DRAFT'`, [from]);

    // THE CUSTOMER SIDE (migration 163, owner 5-Sep-2026): the same pass drafts
    // every customer's bill for the fortnight that closed — and, for a monthly
    // (contract) customer, the month it falls in. Raised bills are touched only
    // for the money that arrived; a person raises, TARA never does.
    let customerBills = { created: 0, refreshed: 0, skipped: 0 };
    let autoRaised = { candidates: 0, raised: 0, posted: 0, failed: 0, amount: 0 };
    try {
      await startStep(run.run_id, 'customer_bills', { agent_code: agent });
      const { rows: [cb] } = await query('SELECT * FROM customer_bills_build($1::date, $2)', [from, 'agent:TARA']);
      customerBills = cb ?? customerBills;
      // 166: a draft with nothing left to decide is raised by TARA (revenue
      // posted, locked); the desk's list is only the bills with a problem.
      autoRaised = await autoRaiseCustomerBills({ by: 'agent:TARA', log });
    } catch (e) {
      // Before 163 lands, or on a fault — the lorry bills must still go out.
      log.warn?.({ job: JOB, err: e.message }, '[agent] customer bills build failed');
    }
    const { rows: [custState] } = await query(`
      SELECT count(*)::int AS customer_bills,
             COALESCE(sum(gross), 0)::numeric(14,2) AS customer_gross,
             COALESCE(sum(missing_count), 0)::int AS customer_missing,
             COALESCE(sum(unpriced_count), 0)::int AS customer_unpriced
        FROM customer_bills WHERE period_from = $1::date OR (cycle_kind = 'MONTH' AND $1::date BETWEEN period_from AND period_to)`, [from])
      .catch(() => ({ rows: [{ customer_bills: 0, customer_gross: 0, customer_missing: 0, customer_unpriced: 0 }] }));

    // The owner bills the lorries were grouped into (migration 160) — what the
    // desk actually opens on the 1st and the 16th.
    const { rows: [bills] } = await query(`
      SELECT count(*)::int AS bills,
             count(*) FILTER (WHERE status = 'AI_DRAFT')::int AS bills_draft,
             count(*) FILTER (WHERE class_key IN ('ATTACHED','MARKET'))::int AS owner_bills,
             COALESCE(sum(needs_rate), 0)::int AS bills_without_rate,
             COALESCE(sum(payable), 0)::numeric(14,2) AS payable
        FROM vehicle_owner_bills WHERE period_from = $1::date`, [from]);

    const counts = { ...built, ...state, ...bills, ...custState,
                     customer_created: customerBills.created, customer_refreshed: customerBills.refreshed,
                     customer_skipped: customerBills.skipped, customer_autoraised: autoRaised.raised,
                     customer_autoraise_posted: autoRaised.amount, period_from: from };
    await finishRun(run.run_id, 'OK', { counts });
    log.info?.({ job: JOB, ...counts }, '[agent] vehicle fortnight bills ready for the desk');
    return { ran: true, period_from: from, ...counts };
  } catch (err) {
    await finishRun(run.run_id, 'FAILED', { error: err.message });
    log.warn?.({ job: JOB, err: err.message }, '[agent] vehicle bill build failed');
    return { ran: true, period_from: from, error: err.message };
  }
}
