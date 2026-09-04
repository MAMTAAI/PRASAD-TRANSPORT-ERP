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
import {
  detectDuplicateBilling, detectBlankCustomer,
  detectCompanyMasterGaps, detectEntityMismatch,
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

export function startScheduler(log = console) {
  if (state.timer) return state.timer;
  state.log = log;
  const tick = async () => {
    for (const [name, fn] of [['compliance', runComplianceCheck], ['cycle', runCycleSweep], ['exceptions', runExceptionScan], ['nightly_fuel', runNightlyFuel]]) {
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
  return state.timer;
}

export function stopScheduler() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.fuelCron) { state.fuelCron.stop(); state.fuelCron = null; }
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
  };
}
