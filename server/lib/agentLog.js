// server/lib/agentLog.js
// ─────────────────────────────────────────────────────────────────────────────
// The writer for agent_execution_logs.
//
// TWO RULES, AND THEY ARE THE WHOLE FILE:
//
//   1. THE LOG NEVER BREAKS THE JOB. A failure to record that fuel was
//      imported must not stop fuel being imported. Every write here is
//      swallowed and returned as a flag; the caller keeps going.
//   2. THE RUN ROW IS WRITTEN AT THE START. A job that dies at 02:00:03 must
//      leave a mark. Logging on completion only records the runs that
//      completed, which is exactly the set you do not need to be told about.
//
// The day-claim lives in the unique index (migration 151), not in a variable:
// process memory is lost on every deploy, and this system deploys daily.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { query, isDegraded } from '../db/pool.js';

/** The IST calendar date a run belongs to. The box may be on UTC. */
export function istDate(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Claim today for `job` and open its run row.
 *
 * @returns {Promise<{run_id:string|null, claimed:boolean, reason?:string}>}
 *   claimed=false means another run already owns this day — the caller must
 *   stand down. That is the restart guard, and it is a database fact, not a
 *   guess about what this process did earlier.
 */
export async function startRun(job, { trigger = 'SCHEDULE', detail = {}, runDate = null } = {}) {
  const run_id = crypto.randomUUID();
  const correlation_id = crypto.randomUUID();
  if (isDegraded()) return { run_id: null, claimed: false, reason: 'db unavailable' };
  try {
    const { rows } = await query(`
      INSERT INTO agent_execution_logs
        (run_id, job, step, agent_id, agent_code, status, detail, correlation_id, run_date)
      VALUES ($1::uuid, $2, NULL, 'AGENT_00', 'KAMALA', 'RUNNING',
              $3::jsonb, $4::uuid, $5::date)
      ON CONFLICT DO NOTHING
      RETURNING run_id, correlation_id`,
      [run_id, job, JSON.stringify({ trigger, ...detail }), correlation_id,
       runDate ?? istDate()]);
    if (!rows.length) {
      // The partial unique index refused it: this day's scheduled run exists.
      return { run_id: null, claimed: false, reason: 'already run today' };
    }
    return { run_id, correlation_id, claimed: true };
  } catch (err) {
    return { run_id: null, claimed: false, reason: `log write failed: ${err.message}` };
  }
}

/**
 * Record one stage. Returns a `done()` that closes it, so a stage cannot be
 * opened and forgotten — the shape of the API is the reminder.
 */
export async function startStep(run_id, step, { agent_id = null, agent_code = null } = {}) {
  const t0 = Date.now();
  let id = null;
  if (run_id && !isDegraded()) {
    try {
      const { rows } = await query(`
        INSERT INTO agent_execution_logs (run_id, job, step, agent_id, agent_code, status)
        SELECT $1::uuid, r.job, $2, $3, $4, 'RUNNING'
          FROM agent_execution_logs r WHERE r.run_id = $1::uuid AND r.step IS NULL
        RETURNING id`, [run_id, step, agent_id, agent_code]);
      id = rows[0]?.id ?? null;
    } catch { /* rule 1 */ }
  }
  return async function done(status, { counts = {}, detail = {}, reason = null, error = null } = {}) {
    const duration_ms = Date.now() - t0;
    if (id) {
      try {
        await query(`
          UPDATE agent_execution_logs
             SET status = $2, counts = $3::jsonb, detail = $4::jsonb, reason = $5,
                 error = $6, finished_at = now(), duration_ms = $7
           WHERE id = $1`,
          [id, status, JSON.stringify(counts), JSON.stringify(detail), reason,
           error ? String(error).slice(0, 2000) : null, duration_ms]);
      } catch { /* rule 1 */ }
    }
    return { step, status, duration_ms, counts, reason, error: error ? String(error) : null };
  };
}

/** Close the run itself. */
export async function finishRun(run_id, status, { counts = {}, reason = null, error = null } = {}) {
  if (!run_id || isDegraded()) return;
  try {
    await query(`
      UPDATE agent_execution_logs
         SET status = $2, counts = $3::jsonb, reason = $4, error = $5,
             finished_at = now(),
             duration_ms = (EXTRACT(epoch FROM (now() - started_at)) * 1000)::int
       WHERE run_id = $1::uuid AND step IS NULL`,
      [run_id, status, JSON.stringify(counts), reason,
       error ? String(error).slice(0, 2000) : null]);
  } catch { /* rule 1 */ }
}

/**
 * A run left RUNNING by a process that died. Nothing else will ever close it,
 * so it is closed here on the next boot — otherwise the day stays claimed and
 * tonight's job stands down forever behind a run that is not running.
 */
export async function reapStaleRuns(job, { olderThanMinutes = 180 } = {}) {
  if (isDegraded()) return { reaped: 0 };
  try {
    const { rowCount } = await query(`
      UPDATE agent_execution_logs
         SET status = 'FAILED', finished_at = now(),
             error = COALESCE(error, 'process ended before the run finished'),
             duration_ms = (EXTRACT(epoch FROM (now() - started_at)) * 1000)::int
       WHERE job = $1 AND status = 'RUNNING'
         AND started_at < now() - make_interval(mins => $2)`,
      [job, olderThanMinutes]);
    return { reaped: rowCount };
  } catch (err) {
    return { reaped: 0, error: err.message };
  }
}
