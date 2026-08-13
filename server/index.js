// server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Prasad Transport ERP — API server (Fastify + PostgreSQL).
//
//   node server/index.js
//
// Binds to loopback by default; Nginx terminates TLS and proxies to it, same
// shape as the existing bridge.cjs deployment. The database is verified before
// the socket opens, so a bad DB config fails at boot rather than on the first
// user request.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthCheck, initDb, closePool, isDegraded, DB_TARGET } from './db/pool.js';
import { registerVehicleRoutes } from './modules/vehicles.routes.js';
import { registerAgentRoutes } from './modules/agents.routes.js';
import { initSwarm } from './agents/registry.js';
import { startBus, stopBus } from './agents/bus.js';
import { registerFleetRoutes } from './modules/fleet.routes.js';
import { registerFinanceRoutes } from './modules/finance.routes.js';
import { registerIntegrationRoutes } from './modules/integrations.routes.js';
import { registerCashbookRoutes } from './modules/cashbook.routes.js';
import { registerBillRoutes } from './modules/bills.routes.js';
import { registerOpsRoutes } from './modules/ops.routes.js';
import { registerMastersRoutes } from './modules/masters.routes.js';
import { startLoops, stopLoops } from './agents/loopEngine.js';

const PORT = Number.parseInt(process.env.API_PORT ?? '3300', 10);
const HOST = process.env.API_HOST ?? '127.0.0.1';
const IS_PROD = process.env.NODE_ENV === 'production';

const app = Fastify({
  logger: IS_PROD
    ? { level: 'info' }
    : { level: 'info', transport: undefined }, // pino-pretty is optional; plain JSON otherwise
  // Trust the Nginx X-Forwarded-For so rate limiting and audit logs record the
  // real client IP rather than 127.0.0.1 for every request.
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(cors, {
  origin: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  credentials: true,
});

// ── Health ─────────────────────────────────────────────────────────────────
// Liveness: the process is up. Kept dependency-free so a database outage does
// not make the load balancer kill an otherwise healthy process.
app.get('/healthz', async () => ({ ok: true, service: 'prasad-erp-api', target: DB_TARGET, db_degraded: isDegraded() }));

// Readiness: the process can actually serve traffic, database included.
app.get('/readyz', async (req, reply) => {
  try {
    return { ok: true, db: await healthCheck() };
  } catch (err) {
    reply.code(503);
    return { ok: false, error: err.message };
  }
});

// ── Error shaping ──────────────────────────────────────────────────────────
// Postgres integrity errors are the schema doing its job; translate them into
// something the UI can display instead of a generic 500.
app.setErrorHandler((err, req, reply) => {
  const pgCode = err.code;
  if (pgCode === 'DB_UNAVAILABLE') {
    // Degraded mode: infrastructure state, not a server bug — 503 tells the
    // client (and any load balancer) to retry later rather than report a crash.
    return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'no PostgreSQL target reachable — see /readyz' });
  }
  if (pgCode === '23505') {
    // unique_violation — e.g. this vehicle number already exists
    return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  }
  if (pgCode === '23503') {
    // foreign_key_violation — referenced company/driver does not exist
    return reply.code(422).send({ error: 'INVALID_REFERENCE', detail: err.detail ?? err.message });
  }
  if (pgCode === '23514') {
    // check_violation — failed a format/business rule in the schema
    return reply.code(422).send({ error: 'VALIDATION_FAILED', detail: err.constraint ?? err.message });
  }
  req.log.error({ err }, 'unhandled request error');
  return reply.code(err.statusCode ?? 500).send({
    error: 'INTERNAL',
    // Never leak internals in production; keep them in dev where they help.
    detail: IS_PROD ? 'Internal server error' : err.message,
  });
});

// ── Modules ────────────────────────────────────────────────────────────────
await app.register(registerVehicleRoutes, { prefix: '/api/vehicles' });
await app.register(registerAgentRoutes,   { prefix: '/api/agents' });
// Stage-3 v1 surface (fleet telemetry, OCR auto-scan, RAG) — additive only;
// the legacy /api/* routes above are untouched.
await app.register(registerFleetRoutes,   { prefix: '/api/v1' });
await app.register(registerFinanceRoutes, { prefix: '/api/v1/finance' });
await app.register(registerIntegrationRoutes, { prefix: '/api/v1' });
// Cash & Bank Book, bank master and voucher reversal share the finance prefix.
await app.register(registerCashbookRoutes, { prefix: '/api/v1/finance' });
await app.register(registerBillRoutes,     { prefix: '/api/v1/billing' });
// Trips advice -> loading -> unloading -> settlement (KALI's modules).
await app.register(registerOpsRoutes,      { prefix: '/api/v1/ops' });
// Fleet & party masters: vehicles, drivers, customers, vendors, lanes, rates.
await app.register(registerMastersRoutes,  { prefix: '/api/v1/masters' });


// ── Boot ───────────────────────────────────────────────────────────────────
try {
  // Resolve a database (local -> RDS). Degraded is a valid outcome: the API
  // still serves /healthz and the agent roster so an operator can see WHY the
  // system is not working, instead of facing a crash-looping process.
  const conn = await initDb();

  // The swarm loads regardless. Agents whose tables are missing report PARKED,
  // which is exactly the signal an operator needs mid-migration.
  await initSwarm({ strict: true });
  await startBus();
  // Autonomous agent loops (Kali 10s, Tara 30s, ...). AGENT_LOOPS=0 disables.
  if (process.env.AGENT_LOOPS !== '0') startLoops();

  await app.listen({ port: PORT, host: HOST });
  app.log.info(
    `prasad-erp-api listening on http://${HOST}:${PORT} · db=${conn.degraded ? 'DEGRADED' : conn.target}`
  );
  if (conn.degraded) {
    app.log.warn('running WITHOUT a database — all data routes will return 503 until one is reachable');
  }
} catch (err) {
  // A failure here is a code/roster defect, not an infrastructure one — those
  // are already handled above — so exiting is correct.
  app.log.error({ err }, 'boot failed');
  await stopBus().catch(() => {});
  await closePool().catch(() => {});
  process.exit(1);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
// PM2 sends SIGINT on reload; draining first lets in-flight transactions
// commit instead of being severed mid-write.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info(`${signal} received — draining`);
    try {
      await app.close();
      stopLoops();
      await stopBus();
      await closePool();
    } finally {
      process.exit(0);
    }
  });
}
