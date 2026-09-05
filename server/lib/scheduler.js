// ═══════════════════════════════════════════════════════════════════════════
// scheduler.js — the background checks that have to happen without being asked
//
// A CLOCK TICK IS NOT A CALENDAR. Every job here runs on a plain interval and
// then decides for itself whether today is a day it should act. That is
// deliberate: a process that restarts at 00:05 must not miss the 1st, and one
// that runs for three weeks must not fire twice on the 15th because the
// interval drifted. Each job records the date it last ran and refuses to repeat
// it, so "did this fire?" is answered by state, not by hoping the timer landed.
// The fuel sync additionally has a cron at a stated hour, because "some time
// today" is not good enough for it — but it still gates itself the same way,
// and its gate is a unique index rather than a variable, so a deploy that
// restarts the process cannot make it run twice.
//
// NO JOB HERE POSTS MONEY. The cycle sweep writes provisional estimates, which
// are not ledger entries; the compliance check writes notifications; the 02:00
// fuel sync imports what the oil company says happened and emits an event.
// Anything that moves money goes through an approval and TARA.
// ═══════════════════════════════════════════════════════════════════════════
import cron from 'node-cron';
import { query, isDegraded } from '../db/pool.js';
import { runNightlyFuelSync } from './nightlyFuelSync.js';
import { runVehicleBillAgent, istToday } from './vehicleBillAgent.js';
import { runAdviceCollect } from './adviceCollectJob.js';
import { emit as busEmit, drain as busDrain } from '../agents/bus.js';
import {
  detectDuplicateBilling, detectBlankCustomer,
  detectCompanyMasterGaps, detectEntityMismatch, detectCustomerRecon, detectMailboxDead, detectBankUnmatched, detectTds, detectGst,
} from '../modules/exceptions.routes.js';

const TICK_MS = 15 * 60 * 1000;          // quarter-hourly; the jobs gate themselves
const state = {
  lastCycleRun: null, lastComplianceRun: null, lastExceptionScan: null,
  timer: null, fuelCron: null, fuelCronError: null, log: null,
};

const today = () => new Date().toISOString().slice(0, 10);

/** Is today a cycle boundary? The 15th, and the last day of the month —
 *  "31st" is wrong for February and for every 30-day month, so it is computed
 *  rather than hard-coded. */
function cycleBoundary(d = new Date()) {
  const day = d.getDate();
  const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (day === 15) return 'H1';
  if (day === lastOfMonth) return 'H2';
  return null;
}

/** The cycle code the boundary CLOSES — on the 15th that is this month's H1. */
function cycleCodeFor(d = new Date()) {
  const half = cycleBoundary(d);
  if (!half) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${half}`;
}

// ── 1. accrue everything that unloaded in the closing cycle ────────────────
export async function runCycleSweep({ force = false, code = null } = {}) {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const cycleCode = code ?? cycleCodeFor();
  if (!cycleCode) return { skipped: 'not a cycle boundary' };
  if (!force && state.lastCycleRun === `${cycleCode}@${today()}`) {
    return { skipped: 'already run today' };
  }

  const { rows: cyc } = await query(
    `SELECT id, cycle_code, period_from, period_to FROM billing_cycles WHERE cycle_code = $1`,
    [cycleCode]);
  if (!cyc[0]) return { skipped: `no such cycle ${cycleCode}` };

  // accrue_trip is idempotent — a trip that already has an open accrual gets
  // its existing row back — so a trip accrued at unload is not accrued again
  // here. That is what makes running this twice harmless.
  const { rows: made } = await query(`
    SELECT accrue_trip(t.id, 'CYCLE_END') AS id
      FROM trips t
     WHERE COALESCE(t.unloading_date, t.loading_date) BETWEEN $1::date AND $2::date
       AND NOT EXISTS (SELECT 1 FROM provisional_trips_ledger p
                        WHERE p.trip_id = t.id
                          AND p.status IN ('PROVISIONAL','BUNDLED','RECONCILED'))`,
    [cyc[0].period_from, cyc[0].period_to]);

  await query(`UPDATE billing_cycles SET status='CLOSED', closed_at=now()
                WHERE id=$1::uuid AND status='OPEN'`, [cyc[0].id]);

  state.lastCycleRun = `${cycleCode}@${today()}`;
  const { rows: sum } = await query(`
    SELECT count(*)::int accruals, COALESCE(sum(est_freight),0)::numeric(16,2) est_freight,
           count(*) FILTER (WHERE basis='NO_BASIS')::int no_basis
      FROM provisional_trips_ledger WHERE cycle_id = $1::uuid`, [cyc[0].id]);
  return { cycle: cycleCode, newly_accrued: made.length, ...sum[0] };
}

// ── 2. what expires within 10 days ─────────────────────────────────────────
// The threshold lives in the database (compliance_alert_days(), migration 058)
// so this job and the dashboard read the same number. Ten working days is what
// an insurance renewal or a fitness slot takes in Bongaigaon — the operator's
// figure, not a default.
export async function runComplianceCheck({ force = false } = {}) {
  if (isDegraded()) return { skipped: 'db unavailable' };
  if (!force && state.lastComplianceRun === today()) return { skipped: 'already run today' };

  const { rows } = await query(`
    SELECT subject_kind, subject, doc_type, doc_name, expires_on,
           (expires_on - CURRENT_DATE)::int AS days
      FROM v_compliance_alerts
     WHERE expires_on - CURRENT_DATE <= compliance_alert_days()
     ORDER BY expires_on ASC`);

  const expired = rows.filter((r) => r.days < 0);
  const expiring = rows.filter((r) => r.days >= 0);

  // Record that the sweep ran. An empty alert list is only good news if this
  // table says today — otherwise it is indistinguishable from a job that died.
  await query(`
    INSERT INTO compliance_alert_runs (ran_on, threshold_days, checked, expired, expiring, detail)
    VALUES (CURRENT_DATE, compliance_alert_days(), $1, $2, $3, $4::jsonb)
    ON CONFLICT (ran_on) DO UPDATE
      SET checked = EXCLUDED.checked, expired = EXCLUDED.expired,
          expiring = EXCLUDED.expiring, detail = EXCLUDED.detail, created_at = now()`,
    [rows.length, expired.length, expiring.length,
     JSON.stringify(rows.slice(0, 50))]);

  state.lastComplianceRun = today();
  return { checked: rows.length, expired: expired.length, expiring: expiring.length };
}

// ── 3. keep the Action Required board current ─────────────────────────────
/**
 * Run every exception detector.
 *
 * WHY THIS IS ON THE CLOCK AND NOT ON A BUTTON. The Action Required board is
 * only worth reading if it is current, and until now the detectors ran only
 * when somebody opened the screen and pressed Re-scan. That is how the ten
 * duplicate-billing exceptions sat undetected from May to 18-08-2026: nothing
 * was broken, nothing had asked. A queue that fills only when observed is the
 * log it was built to replace.
 *
 * Every detector is idempotent by dedupe_key, so running it quarter-hourly
 * costs four inserts-that-become-no-ops and never re-opens anything a person
 * has already resolved or dismissed.
 */
async function runExceptionScan() {
  if (isDegraded()) return { skipped: true };
  let found = 0; let fresh = 0;
  for (const [name, fn] of [
    ['duplicate_billing', detectDuplicateBilling],
    ['blank_customer', detectBlankCustomer],
    ['company_master_gaps', detectCompanyMasterGaps],
    ['entity_mismatch', detectEntityMismatch],
    ['customer_recon', detectCustomerRecon],
    ['mailboxes', detectMailboxDead],
    ['bank', detectBankUnmatched],
    ['tds', detectTds],
    ['gst', detectGst],
  ]) {
    try {
      const r = await fn();
      found += r.length;
      fresh += r.filter((x) => x.was_new).length;
    } catch (err) {
      // One broken detector must not silence the other three.
      state.lastExceptionError = `${name}: ${err.message}`;
    }
  }
  state.lastExceptionScan = new Date().toISOString();
  // Quiet unless something is actually new — otherwise this logs 96 times a day
  // to say nothing changed.
  return fresh ? { open: found, new: fresh } : { skipped: true };
}

// ── 4. KAMALA's 02:00 IST fuel sync ───────────────────────────────────────
//
// Cron fires it at 02:00 Asia/Kolkata, and the quarter-hourly tick catches it
// up. BOTH, deliberately, and they cannot double-run: the job claims the day by
// inserting its row in agent_execution_logs behind a unique index, so the
// second attempt collides in the database and stands down. Cron alone would
// miss the night entirely if the box happened to be restarting at 02:00 — the
// exact minute a nightly deploy is most likely to be touching it — and the tick
// alone would drift the fuel import into office hours.
//
// The catch-up does not fire before 02:00: a run started at 00:15 would import
// a folder the portal has not been exported into yet and then hold the day's
// claim against the real 02:00 run.
async function runNightlyFuel({ force = false } = {}) {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const istHour = Number(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 13));
  if (!force && istHour < 2) return { skipped: 'before 02:00 IST' };
  return runNightlyFuelSync({ trigger: force ? 'SCHEDULE' : 'CATCHUP', log: state.log ?? console });
}

// ── 5. TARA's 15-day vehicle bills — the 1st and the 16th, 03:00 IST ──────
//
// The scheduler does not build the bills. It RAISES the event and TARA
// (AGENT_02, the bill expert since 5-Sep-2026) builds them through the
// durable agent path — agent_events → dispatch → agent_runs — so the run is
// hers on the dashboard and in the audit trail. The cron fires it at 03:00;
// the quarter-hourly tick catches up after a restart, once per day per
// process, and the day-claim in agent_execution_logs stops a second build.
// If the bus itself is down the fortnight is not missed: the job runs
// directly, and says so.
export async function requestVehicleBills({ force = false, trigger = 'SCHEDULE' } = {}) {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const today = istToday();
  const day = Number(today.slice(8, 10));
  const istHour = Number(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 13));
  if (!force && !((day === 1 || day === 16) && istHour >= 3)) {
    return { skipped: 'not a bill day (1st/16th, after 03:00 IST)' };
  }
  if (!force && state.lastVehicleBillAsk === today) return { skipped: 'already asked today' };
  state.lastVehicleBillAsk = today;
  try {
    await busEmit('vehicle.bill.cycle.requested', {
      aggregate: 'vehicle_bills',
      payload: { trigger, today, force },
      emittedBy: 'AGENT_00',
    });
    busDrain().catch(() => {});
    return { asked: 'TARA (AGENT_02)', today, trigger };
  } catch (err) {
    const r = await runVehicleBillAgent({ force, log: state.log ?? console });
    return { fallback: `bus: ${err.message}`, ...r };
  }
}

// ── 6. keep the customer bills' reconciliation current ────────────────────
//
// The advice pipeline writes receipts onto trips whenever a mail lands; the
// customer bill (migration 163) DERIVES its flags from those trips, so it only
// has to be re-read. Half-hourly over the last four months — cheap, and it is
// what turns "advice aaya" into "bill PAID" without anyone pressing anything.
async function refreshCustomerBills() {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const now = Date.now();
  if (state.lastCustomerRefresh && now - state.lastCustomerRefresh < 30 * 60_000) return { skipped: 'recent' };
  state.lastCustomerRefresh = now;
  try {
    const { rows } = await query(`
      SELECT customer_bill_refresh(id) FROM customer_bills
       WHERE status <> 'CANCELLED' AND period_from >= current_date - interval '120 days'`);
    return { refreshed: rows.length };
  } catch (err) {
    // Before 163 lands the function does not exist; say so quietly once.
    if (/customer_bill_refresh|customer_bills/.test(err.message)) return { skipped: 'migration 163 not applied' };
    throw err;
  }
}

// ── 7. collect the customer's payment advices, post them, reconcile ───────
//
// The oil company's payment advice is the only document that says what was
// remitted and what was kept back (CCMS diesel → our card, toll, TDS).
// BHUVANESHWARI brings it in from the mailbox (fetch + load), TARA posts the
// settlement against the SAME debtor ledger the bill was raised on, and the
// customer bills re-read their trips. Once a day after 04:30 IST; the day-claim
// in agent_execution_logs stops a second run after a restart.
async function collectAdvices() {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const hourIst = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
  if (hourIst < 4) return { skipped: 'before 04:00 IST' };
  if (state.lastAdviceDay === istToday()) return { skipped: 'ran today' };
  state.lastAdviceDay = istToday();
  return runAdviceCollect({ trigger: 'SCHEDULE', log: state.log ?? console });
}

// ── 8. re-tally the bank lines still waiting ──────────────────────────────
// Rules are learned on the desk all day; an advice posted this morning links
// a UTR the desk saw yesterday. Twice a day TARA re-reads what is waiting.
async function retallyBank() {
  if (isDegraded()) return { skipped: 'db unavailable' };
  const now = Date.now();
  if (state.lastBankTally && now - state.lastBankTally < 12 * 3600_000) return { skipped: 'recent' };
  state.lastBankTally = now;
  try {
    const { tallyAccount } = await import('./bankTally.js');
    return await tallyAccount({ statuses: ['NEW', 'REVIEW'], by: 'agent:TARA', log: state.log ?? console });
  } catch (err) {
    if (/bank_statement_lines|bank_accounts/.test(err.message)) return { skipped: 'migration 167 not applied' };
    throw err;
  }
}

// ── 9. TDS from the documents, once a day ─────────────────────────────────
// Liabilities from the approved owner / partner bills, credits from the
// advices, AC5 bills and bank credits; the desk and the government pack read
// these. Nothing is typed by the job.
async function rebuildTds() {
  if (isDegraded()) return { skipped: 'db unavailable' };
  if (state.lastTdsDay === istToday()) return { skipped: 'ran today' };
  state.lastTdsDay = istToday();
  try {
    const { rows: [r] } = await query('SELECT * FROM tds_rebuild(fy_of(current_date))');
    return r;
  } catch (err) {
    if (/tds_rebuild|tds_liabilities/.test(err.message)) return { skipped: 'migration 169 not applied' };
    throw err;
  }
}

// GST (171): once a day the deep audit re-reads the documents — customers a
// person has not decided for get the statutory treatment, every bill carries
// its GST lines, purchase entries land in the ITC register, filings sync.
async function rebuildGst() {
  if (isDegraded()) return { skipped: 'db unavailable' };
  if (state.lastGstDay === istToday()) return { skipped: 'ran today' };
  state.lastGstDay = istToday();
  try {
    const { rows: [r] } = await query("SELECT gst_deep_audit('scheduler') AS s");
    return { documents: r.s?.documents ?? null, itc_rows: r.s?.itc_rows ?? null, bills: r.s?.bills_backfilled ?? null };
  } catch (err) {
    if (/gst_deep_audit|gst_itc_register/.test(err.message)) return { skipped: 'migration 171 not applied' };
    throw err;
  }
}

export function startScheduler(log = console) {
  if (state.timer) return state.timer;
  state.log = log;
  const tick = async () => {
    for (const [name, fn] of [['compliance', runComplianceCheck], ['cycle', runCycleSweep], ['customer_bills', refreshCustomerBills], ['exceptions', runExceptionScan], ['nightly_fuel', runNightlyFuel], ['vehicle_bills', requestVehicleBills], ['advices', collectAdvices], ['bank', retallyBank], ['tds', rebuildTds], ['gst', rebuildGst]]) {
      try {
        const r = await fn();
        if (!r.skipped) log.info?.({ job: name, ...r }, `[scheduler] ${name} ran`);
      } catch (err) {
        // A failed background job must never take the API down with it.
        log.warn?.({ job: name, err: err.message }, `[scheduler] ${name} failed`);
      }
    }
  };
  // First pass shortly after boot, so a restart on the 15th still closes it.
  setTimeout(tick, 30_000).unref?.();
  state.timer = setInterval(tick, TICK_MS);
  state.timer.unref?.();

  // The scheduled trigger itself. `timezone` is not optional here — the box
  // runs UTC, and '0 2 * * *' without it is 07:30 IST.
  try {
    state.fuelCron = cron.schedule('0 2 * * *', async () => {
      try {
        const r = await runNightlyFuel({ force: true });
        log.info?.({ job: 'nightly_fuel', ...r }, '[scheduler] 02:00 IST fuel sync');
      } catch (err) {
        log.warn?.({ job: 'nightly_fuel', err: err.message }, '[scheduler] fuel sync failed');
      }
    }, { timezone: 'Asia/Kolkata' });
  } catch (err) {
    // A scheduler that will not schedule must say so at boot. The tick still
    // covers the job, several hours late — which is worth knowing about.
    state.fuelCronError = err.message;
    log.warn?.({ err: err.message }, '[scheduler] could not register the 02:00 fuel cron');
  }

  // ── the 15-day vehicle bills ────────────────────────────────────────────
  //
  // 03:00 on the 1st and the 16th, closing the fortnight that just ended. It
  // runs AFTER the 02:00 fuel sync on purpose: the diesel for the last days of
  // the fortnight has to be in before a lorry's costs are totalled, or the
  // draft understates them and the desk reviews the wrong number.
  //
  // It only builds drafts. Approval stays a person's signature.
  try {
    state.vehicleBillCron = cron.schedule('0 3 1,16 * *', async () => {
      try {
        const r = await requestVehicleBills({ force: true, trigger: 'CRON' });
        log.info?.({ job: 'vehicle_bills', ...r }, '[scheduler] 15-day vehicle bills → TARA');
      } catch (err) {
        log.warn?.({ job: 'vehicle_bills', err: err.message }, '[scheduler] vehicle bills failed');
      }
    }, { timezone: 'Asia/Kolkata' });
  } catch (err) {
    state.vehicleBillCronError = err.message;
    log.warn?.({ err: err.message }, '[scheduler] could not register the vehicle bill cron');
  }
  return state.timer;
}

export function stopScheduler() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.fuelCron) { state.fuelCron.stop(); state.fuelCron = null; }
  if (state.vehicleBillCron) { state.vehicleBillCron.stop(); state.vehicleBillCron = null; }
}

export function schedulerState() {
  return {
    running: !!state.timer,
    tick_minutes: TICK_MS / 60000,
    last_cycle_run: state.lastCycleRun,
    last_compliance_run: state.lastComplianceRun,
    last_exception_scan: state.lastExceptionScan,
    last_exception_error: state.lastExceptionError ?? null,
    today_is_boundary: cycleBoundary(),
    next_cycle_code: cycleCodeFor(),
    nightly_fuel_cron: state.fuelCron ? '02:00 Asia/Kolkata' : null,
    nightly_fuel_cron_error: state.fuelCronError,
    vehicle_bill_cron: state.vehicleBillCron ? '03:00 on the 1st & 16th, Asia/Kolkata → TARA (AGENT_02)' : null,
    vehicle_bill_last_ask: state.lastVehicleBillAsk ?? null,
    vehicle_bill_cron_error: state.vehicleBillCronError,
  };
}
