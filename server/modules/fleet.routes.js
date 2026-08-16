// server/modules/fleet.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Stage-3 v1 API surface:
//
//   GET  /api/v1/agents/fleet-status        full telemetry for all 10 agents
//   POST /api/v1/agents/:id/loop            {enabled} stop/restart one loop
//   POST /api/v1/agents/:id/homework        book a duty note onto an agent card
//   POST /api/v1/documents/auto-scan-file   multipart OCR scan + auto-file
//   GET  /api/v1/rag/stats · POST /api/v1/rag/query   transport RAG loop
//
// Versioned under /api/v1 so the legacy /api/agents and /api/vehicles surfaces
// stay byte-identical — Stage 5's backward-compatibility requirement.
// ─────────────────────────────────────────────────────────────────────────────
import multipart from '@fastify/multipart';
import { status, AGENTS } from '../agents/registry.js';
import { loopStats, processMetrics, setLoopEnabled, LOOPS } from '../agents/loopEngine.js';
import { graphStatus } from '../agents/graphEngine.js';
import { brainStatus } from '../ai/prasadBrain.js';
import { memoryStats, stmSet, stmGet, stmRecent } from '../memory/okf.js';
import { scanAndFile, resolveReview } from '../services/ocrAutoFiler.js';
import { ocrStats } from '../services/textOcr.js';
import { retrieve, ragStats, ingest } from '../rag/transportRAG.js';
import { emit, drain } from '../agents/bus.js';
import { query, isDegraded } from '../db/pool.js';
import { syncStats, tick as syncTick } from '../sync/autoSync.js';

const AGENT_IDS = AGENTS.map((a) => a.id);

export async function registerFleetRoutes(app) {
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // ── Fleet telemetry ───────────────────────────────────────────────────────
  app.get('/agents/fleet-status', async () => {
    const roster = status();
    const loops = loopStats();
    // The graph is the live engine. Loop stats stay readable so a fallback run
    // (AGENT_ENGINE=loop) still reports something instead of blanking the cards.
    const graph = graphStatus();
    const nodeById = new Map(graph.nodes.map((n) => [n.agentId, n]));
    const memory = await memoryStats(AGENT_IDS);
    const proc = processMetrics();

    // Per-agent run history from the audit trail, when the DB is up.
    let runsByAgent = new Map();
    if (!isDegraded()) {
      try {
        const { rows } = await query(`SELECT * FROM v_agent_health`);
        runsByAgent = new Map(rows.map((r) => [r.agent_id, r]));
      } catch { /* view missing until migration 002 — cards fall back to loop stats */ }
    }

    const agents = roster.agents.map((a) => {
      const loop = loops[a.id] ?? {};
      const runs = runsByAgent.get(a.id);
      const mem = memory[a.id];
      const errorsToday = (loop.today?.errors ?? 0) + Number(runs?.errors ?? 0);
      return {
        agent: a.id,
        name: a.codename,
        role: a.title,
        domain: a.domain,
        // ACTIVE = handling events; OPTIMAL = active with zero errors today;
        // PARKED/HALTED pass through from the registry.
        status: a.state === 'ACTIVE' ? (errorsToday === 0 ? 'OPTIMAL' : 'ACTIVE') : a.state,
        // GRAPH ACTIVE, not LOOP ON. A node has no timer of its own any more;
        // it has an edge, and `gated_by` names the predecessors that open it.
        engine: graph.mode,
        graph_active: graph.active,
        node: nodeById.get(a.id)?.node ?? null,
        gated_by: nodeById.get(a.id)?.gated_by ?? [],
        graph_ticks: nodeById.get(a.id)?.ticks ?? 0,
        graph_skipped: nodeById.get(a.id)?.skipped ?? 0,
        loop_running: graph.active || (loop.running ?? false),
        memory_interface: mem?.interface ?? 'IDLE',
        memory: { stm_pct: mem?.stm.pct ?? 0, ltm_pct: mem?.ltm.pct ?? 0, stm: mem?.stm, ltm: mem?.ltm },
        cpu_pct: proc.cpu_pct,     // process-level: one Node process hosts all ten
        mem_pct: proc.mem_pct,
        live_action: loop.last_action ?? 'standing by',
        live_at: loop.last_at ?? null,
        homework: stmGet(a.id, 'homework') ?? loop.homework ?? null,
        today: {
          ticks: loop.today?.ticks ?? 0,
          runs_ok: Number(runs?.ok ?? 0),
          blocked: Number(runs?.blocked ?? 0),
          errors: errorsToday,
          last_error: loop.last_error ?? null,
        },
        guards: a.guards,
        owns_tables: a.owns_tables,
        missing_tables: a.missing_tables,
      };
    });

    return {
      graph,
      brain: brainStatus(),
      service: 'prasad-erp-agent-fleet',
      domain: 'TRANSPORT_LOGISTICS_ONLY',
      db_degraded: isDegraded(),
      process: proc,
      loops_defined: LOOPS.length,
      agents,
    };
  });

  // ── Loop + homework controls (dashboard buttons) ──────────────────────────
  app.post(
    '/agents/:agentId/loop',
    {
      schema: {
        params: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', enum: AGENT_IDS } } },
        body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (req) => setLoopEnabled(req.params.agentId, req.body.enabled)
  );

  app.post(
    '/agents/:agentId/homework',
    {
      schema: {
        params: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', enum: AGENT_IDS } } },
        body: { type: 'object', required: ['note'], properties: { note: { type: 'string', minLength: 2, maxLength: 300 } } },
      },
    },
    async (req) => {
      // Booked duty lives in STM for the day (it is a working note, not a record).
      stmSet(req.params.agentId, 'homework', req.body.note, 24 * 3600 * 1000);
      return { ok: true, agent: req.params.agentId, homework: req.body.note };
    }
  );

  app.get(
    '/agents/:agentId/stm',
    { schema: { params: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', enum: AGENT_IDS } } } } },
    async (req) => ({ agent: req.params.agentId, recent: stmRecent(req.params.agentId, { limit: 30 }) })
  );

  // ── OCR auto-scan ─────────────────────────────────────────────────────────
  app.post('/documents/auto-scan-file', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'NO_FILE', detail: 'multipart field "file" required' });

    const buffer = await part.toBuffer();
    try {
      const result = await scanAndFile({
        buffer,
        filename: part.filename,
        mimeType: part.mimetype,
        uploadedBy: req.headers['x-user'] ?? null,
      });
      // Auto-filed events should reach their agent now, not on the next poll.
      if (result.filing.auto_filed) await drain().catch(() => {});
      // Post-completion cleanup: the multipart buffer + base64 copies are
      // dead after this response — nudge V8 once the reply has flushed.
      // (global.gc exists only under --expose-gc; harmless no-op otherwise.)
      if (global.gc) setImmediate(() => { try { global.gc(); } catch {} });
      return result;
    } catch (err) {
      if (err.code === 'UNSUPPORTED_TYPE' || err.code === 'EMPTY_FILE') {
        return reply.code(415).send({ error: err.code, detail: err.message });
      }
      if (err.code === 'NO_VISION_ENGINE') {
        // Not a server bug: the scan engine (Ollama) is off. Say exactly that.
        return reply.code(503).send({ error: 'NO_VISION_ENGINE', detail: err.message });
      }
      throw err;
    }
  });

  // ── RAG loop ──────────────────────────────────────────────────────────────
  app.get('/rag/stats', async () => ragStats());

  app.post(
    '/rag/query',
    {
      schema: {
        body: {
          type: 'object', required: ['question'], additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 3, maxLength: 500 },
            namespace: { type: 'string', enum: ['transport', 'regulations', 'rate_cards', 'documents'] },
            k: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await retrieve(req.body.question, { namespace: req.body.namespace ?? 'transport', k: req.body.k ?? 5 });
      } catch (err) {
        return reply.code(503).send({ error: 'RAG_UNAVAILABLE', detail: err.message });
      }
    }
  );

  app.post(
    '/rag/ingest',
    {
      schema: {
        body: {
          type: 'object', required: ['source', 'text'], additionalProperties: false,
          properties: {
            source: { type: 'string', minLength: 2, maxLength: 200 },
            text: { type: 'string', minLength: 10, maxLength: 500_000 },
            namespace: { type: 'string', enum: ['transport', 'regulations', 'rate_cards', 'documents'] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await ingest({ namespace: req.body.namespace ?? 'transport', source: req.body.source, text: req.body.text });
      } catch (err) {
        return reply.code(503).send({ error: 'INGEST_FAILED', detail: err.message });
      }
    }
  );

  // ── AUTO-SYNC observability + manual kick ────────────────────────────────
  app.get('/sync/status', async () => {
    const cursors = isDegraded() ? [] : (await query(
      `SELECT id, watermark, rows_synced, last_ok_at, last_error FROM sync_state ORDER BY id`
    )).rows;
    return { engine: syncStats(), cursors };
  });
  app.post('/sync/tick', async () => syncTick());

  // ── 3-PILLAR UNIFICATION — Operations · Accounts · CRM from live PG ──────
  // One endpoint, three pillars, zero fake data: everything below is aggregated
  // from the migrated production tables at request time.
  app.get('/pillars/summary', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
    const [ops, accounts, crm] = await Promise.all([
      query(`SELECT
               (SELECT count(*) FROM vehicles WHERE status = 'ACTIVE')::int AS active_vehicles,
               (SELECT count(*) FROM drivers  WHERE status = 'ACTIVE')::int AS active_drivers,
               (SELECT count(*) FROM vehicle_assignments WHERE state = 'ACTIVE')::int AS linked_pairs,
               (SELECT count(*) FROM trips WHERE status = 'IN_TRANSIT')::int AS trips_in_transit,
               (SELECT count(*) FROM trips WHERE status = 'COMPLETED')::int AS trips_completed_unsettled,
               (SELECT count(*) FROM trips)::int AS trips_total,
               (SELECT count(*) FROM drivers WHERE status = 'ACTIVE'
                  AND LEAST(license_expiry, hzd_expiry) <= CURRENT_DATE + 30)::int AS drivers_expiring_30d`),
      query(`SELECT
               (SELECT COALESCE(SUM(amount) FILTER (WHERE dr_cr='DR'),0) - COALESCE(SUM(amount) FILTER (WHERE dr_cr='CR'),0)
                  FROM ledger_entries WHERE voucher_id IS NOT NULL) AS voucher_era_divergence,
               (SELECT count(*) FROM ledger_entries)::int AS ledger_entries,
               (SELECT count(*) FROM ledgers)::int AS ledgers,
               (SELECT COALESCE(SUM(current_outstanding),0) FROM customers) AS customer_outstanding,
               (SELECT COALESCE(SUM(freight_amount),0) FROM trips WHERE status = 'COMPLETED') AS unsettled_freight,
               (SELECT count(*) FROM trip_settlements)::int AS settlements_posted`),
      query(`SELECT
               (SELECT count(*) FROM notifications WHERE status = 'QUEUED')::int AS notifications_queued,
               (SELECT count(*) FROM notifications WHERE status = 'SENT')::int AS notifications_sent,
               (SELECT count(*) FROM documents WHERE status = 'REVIEW')::int AS documents_in_review,
               (SELECT count(*) FROM driver_transactions WHERE txn_type = 'ADVANCE_GIVEN')::int AS driver_advances_on_record`),
    ]);
    return {
      as_of: new Date().toISOString(),
      source: 'postgresql:prasad_erp (live, zero fake data)',
      operations: ops.rows[0],   // Master Fleet — KALI · BHAIRAVI · DHUMAVATI
      accounts: accounts.rows[0],// Finance Hub — TARA · CHHINNAMASTA
      crm: crm.rows[0],          // Mamta AI CRM — MATANGI · BHUVANESHWARI
      flow: 'trip.completed (KALI) -> settlement lock+post (KAMALA/TARA, BEGIN..COMMIT+advisory lock) -> POD/invoice WhatsApp (MATANGI)',
    };
  });

  // ── HITL: 1-click review resolution ──────────────────────────────────────
  app.post(
    '/documents/:id/review',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['action', 'reviewer'], additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['approve', 'reject'] },
            reviewer: { type: 'string', minLength: 2, maxLength: 100 },
            corrections: { type: 'object' },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
      try {
        const out = await resolveReview(req.params.id, {
          action: req.body.action, corrections: req.body.corrections ?? {}, reviewer: req.body.reviewer,
        });
        if (out.event) await drain().catch(() => {});
        return out;
      } catch (err) {
        if (err.code === 'NOT_FOUND') return reply.code(404).send({ error: err.code });
        if (err.code === 'NOT_IN_REVIEW' || err.code === 'NO_REVIEWER') return reply.code(409).send({ error: err.code, detail: err.message });
        throw err;
      }
    }
  );

  app.get('/documents/ocr-stats', async () => ocrStats());

  // ── Manual review intake (HITL companion to auto-scan) ───────────────────
  app.get('/documents/review-queue', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });
    const { rows } = await query(
      `SELECT d.id, d.doc_type, d.original_name, d.created_at,
              e.fields, e.confidence, e.validation
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT fields, confidence, validation FROM document_extractions
            WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
         ) e ON true
        WHERE d.status = 'REVIEW'
        ORDER BY d.created_at DESC LIMIT 100`
    );
    return { count: rows.length, data: rows };
  });
}
