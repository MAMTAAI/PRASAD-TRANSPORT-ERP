// server/modules/agents.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Control surface for the Mahavidya swarm: inspect fixed roles, watch health,
// inject events, and operate the halt switch.
// ─────────────────────────────────────────────────────────────────────────────
import { status, describe, refreshReadiness, AGENTS } from '../agents/registry.js';
import { emit, drain } from '../agents/bus.js';
import { query, isDegraded } from '../db/pool.js';
import { runNightlyFuelSync, JOB as FUEL_JOB } from '../lib/nightlyFuelSync.js';

const AGENT_IDS = AGENTS.map((a) => a.id);

export async function registerAgentRoutes(app) {
  // ── Roster and fixed roles ───────────────────────────────────────────────
  app.get('/', async () => ({ db_degraded: isDegraded(), ...status() }));

  app.get(
    '/:agentId',
    { schema: { params: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', enum: AGENT_IDS } } } } },
    async (req, reply) => {
      const card = describe(req.params.agentId);
      if (!card) return reply.code(404).send({ error: 'NOT_FOUND' });
      return card;
    }
  );

  // ── Health, from the audit trail rather than in-memory counters ──────────
  app.get('/ops/health', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE', db_degraded: true });
    const { rows } = await query('SELECT * FROM v_agent_health ORDER BY agent_id');
    const backlog = await query(
      `SELECT state, count(*)::int AS n FROM agent_events GROUP BY state ORDER BY state`
    );
    return { agents: rows, queue: backlog.rows };
  });

  // Dead letters need to be visible without a psql session — a DEAD event is a
  // business action that silently did not happen.
  app.get(
    '/ops/dead-letters',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } } },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      const { rows } = await query(
        `SELECT id, event_type, aggregate, aggregate_id, attempts, last_error, created_at
           FROM agent_events WHERE state = 'DEAD' ORDER BY created_at DESC LIMIT $1`,
        [req.query.limit]
      );
      return { count: rows.length, data: rows };
    }
  );

  // ── Event injection ──────────────────────────────────────────────────────
  // The API is a legitimate event origin (a clerk saving an unloading record is
  // not an agent), so this is a real entry point, not just a test hook.
  app.post(
    '/events',
    {
      schema: {
        body: {
          type: 'object',
          required: ['event_type', 'aggregate'],
          additionalProperties: false,
          properties: {
            event_type: { type: 'string', pattern: '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*)+$' },
            aggregate: { type: 'string', minLength: 2, maxLength: 40 },
            aggregate_id: { type: ['string', 'null'], format: 'uuid' },
            payload: { type: 'object' },
            correlation_id: { type: ['string', 'null'], format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'events cannot be durably queued' });
      const row = await emit(req.body.event_type, {
        aggregate: req.body.aggregate,
        aggregateId: req.body.aggregate_id ?? null,
        payload: req.body.payload ?? {},
        correlationId: req.body.correlation_id ?? null,
        emittedBy: null, // API origin
      });
      reply.code(202);
      return { queued: row };
    }
  );

  // Force a drain instead of waiting for the poll — useful in tests and after
  // a manual backlog fix.
  app.post('/ops/drain', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
    return { handled: await drain() };
  });

  // Re-check which tables exist, e.g. immediately after running migrations, so
  // agents flip PARKED -> ACTIVE without a restart.
  app.post('/ops/refresh-readiness', async () => {
    await refreshReadiness();
    return status();
  });

  // ── Halt switch (BAGALAMUKHI) ────────────────────────────────────────────
  app.get('/ops/halts', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
    const { rows } = await query(
      `SELECT id, agent_id, reason, halted_by, halted_at, cleared_at, cleared_by
         FROM agent_halts ORDER BY halted_at DESC LIMIT 50`
    );
    return { active: rows.filter((r) => !r.cleared_at), history: rows };
  });

  app.post(
    '/ops/halt',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason', 'requested_by'],
          additionalProperties: false,
          properties: {
            // null scope = halt the entire swarm.
            scope: { type: ['string', 'null'], enum: [...AGENT_IDS, null] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
            requested_by: { type: 'string', minLength: 2, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      const row = await emit('agent.halt.requested', {
        aggregate: 'swarm',
        payload: { scope: req.body.scope ?? null, reason: req.body.reason, requested_by: req.body.requested_by },
      });
      // Halting must take effect now, not on the next poll tick.
      await drain();
      reply.code(202);
      return { queued: row };
    }
  );

  app.post(
    '/ops/resume',
    {
      schema: {
        body: {
          type: 'object',
          required: ['cleared_by'],
          additionalProperties: false,
          properties: {
            scope: { type: ['string', 'null'], enum: [...AGENT_IDS, null] },
            cleared_by: { type: 'string', minLength: 2, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      const row = await emit('agent.resume.requested', {
        aggregate: 'swarm',
        payload: { scope: req.body.scope ?? null, cleared_by: req.body.cleared_by },
      });
      await drain();
      reply.code(202);
      return { queued: row };
    }
  );

  // ── Scheduled jobs: did the night run? ──────────────────────────────────
  //
  // The question this answers is "is the 02:00 chain alive?", and the honest
  // answer to that is sometimes "there is no row" — a job that never fired
  // writes nothing. So the response says when the last run was and how long ago
  // in words, rather than returning an empty list and letting the screen read
  // it as fine.
  app.get(
    '/jobs',
    { schema: { querystring: { type: 'object', properties: {
      job: { type: ['string', 'null'], maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      const { rows } = await query(`
        SELECT * FROM v_agent_job_health
         WHERE ($1::text IS NULL OR job = $1)
         ORDER BY started_at DESC
         LIMIT $2`, [req.query.job ?? null, req.query.limit ?? 30]);

      const last = rows.find(r => r.job === FUEL_JOB) ?? null;
      const hoursSince = last
        ? (Date.now() - new Date(last.started_at).getTime()) / 3_600_000
        : null;
      return {
        runs: rows,
        nightly_fuel: {
          last_run: last?.started_at ?? null,
          last_status: last?.status ?? null,
          // 26 hours covers a run that slipped and a clock that did not.
          overdue: last ? hoursSince > 26 : true,
          note: last
            ? null
            : 'this job has never run on this database — check that the API '
            + 'process is up and that a fleet-card source is configured',
        },
      };
    }
  );

  /** Every stage of one run, in order — the night as one story. */
  app.get(
    '/jobs/:runId',
    { schema: { params: { type: 'object', required: ['runId'],
      properties: { runId: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      const { rows } = await query(
        `SELECT * FROM agent_execution_logs WHERE run_id = $1::uuid ORDER BY id`,
        [req.params.runId]);
      if (!rows.length) return reply.code(404).send({ error: 'NO_SUCH_RUN' });
      return { run: rows.find(r => r.step === null) ?? null,
               steps: rows.filter(r => r.step !== null) };
    }
  );

  /**
   * Run the fuel chain now.
   *
   * Not force-by-default. Tonight's scheduled run has already claimed the day,
   * and a person pressing this at 10:00 wants to see the result — not to
   * silently create a second import of the same statements. `force: true` says
   * they meant it, and the run is recorded as MANUAL so the trail stays honest
   * about which rows a machine brought in and which a person asked for.
   */
  app.post(
    '/jobs/nightly-fuel/run',
    { schema: { body: { type: ['object', 'null'], properties: {
      force: { type: 'boolean', default: false },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      const r = await runNightlyFuelSync({
        trigger: 'MANUAL', force: req.body?.force ?? false, log: app.log,
      });
      if (r.skipped) {
        return reply.code(409).send({
          error: 'NOT_RUN', detail: r.skipped,
          hint: r.skipped === 'already run today'
            ? 'tonight is already recorded — pass force: true to run it again'
            : undefined,
        });
      }
      return r;
    }
  );
}
