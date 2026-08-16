// ═══════════════════════════════════════════════════════════════════════════
// scheduler.js — the two background checks that have to happen on a calendar
//
// A CLOCK TICK IS NOT A CALENDAR. Both jobs run on a plain interval and then
// decide for themselves whether today is a day they should act. That is
// deliberate: a process that restarts at 00:05 must not miss the 1st, and one
// that runs for three weeks must not fire twice on the 15th because the
// interval drifted. Each job records the date it last ran and refuses to repeat
// it, so "did this fire?" is answered by state, not by hoping the timer landed.
//
// NEITHER JOB POSTS MONEY. The cycle sweep writes provisional estimates, which
// are not ledger entries; the compliance check writes notifications. Anything
// that moves money goes through an approval and TARA.
// ═══════════════════════════════════════════════════════════════════════════
import { query, isDegraded } from '../db/pool.js';

const TICK_MS = 15 * 60 * 1000;          // quarter-hourly; the jobs gate themselves
const state = { lastCycleRun: null, lastComplianceRun: null, timer: null };

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

export function startScheduler(log = console) {
  if (state.timer) return state.timer;
  const tick = async () => {
    for (const [name, fn] of [['compliance', runComplianceCheck], ['cycle', runCycleSweep]]) {
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
  return state.timer;
}

export function schedulerState() {
  return {
    running: !!state.timer,
    tick_minutes: TICK_MS / 60000,
    last_cycle_run: state.lastCycleRun,
    last_compliance_run: state.lastComplianceRun,
    today_is_boundary: cycleBoundary(),
    next_cycle_code: cycleCodeFor(),
  };
}
