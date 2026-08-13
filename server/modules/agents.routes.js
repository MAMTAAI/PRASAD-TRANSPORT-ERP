// server/modules/agents.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Control surface for the Mahavidya swarm: inspect fixed roles, watch health,
// inject events, and operate the halt switch.
// ─────────────────────────────────────────────────────────────────────────────
import { status, describe, refreshReadiness, AGENTS } from '../agents/registry.js';
import { emit, drain } from '../agents/bus.js';
import { query, isDegraded } from '../db/pool.js';

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
}
