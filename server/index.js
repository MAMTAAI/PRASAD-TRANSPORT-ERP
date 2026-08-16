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
// Storage isolation MUST run before any module that captures UPLOAD_DIR /
// OCR_UPLOAD_DIR / LOG_DIR at load time (storage.js, ocrAutoFiler.js).
import './config/init_drives.js';
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
import { registerFileRoutes } from './modules/files.routes.js';
import { registerTollRoutes } from './modules/toll.routes.js';
import { registerTollImportRoutes } from './modules/tollImport.routes.js';
import { registerIoclSyncRoutes } from './modules/ioclSync.routes.js';
import { registerFortnightBillingRoutes } from './modules/fortnightBilling.routes.js';
import { registerPumpBillingRoutes } from './modules/pumpBilling.routes.js';
import { startIoclSyncCron, stopIoclSyncCron } from './lib/ioclSyncCron.js';
import { registerLoanImportRoutes } from './modules/loanImport.routes.js';
import { registerComplianceRoutes } from './modules/compliance.routes.js';
import { registerAssetRoutes } from './modules/assets.routes.js';
import { registerBazaarRoutes } from './modules/bazaar.routes.js';
import { registerCrmRoutes } from './modules/crm.routes.js';
import { registerAuthRoutes } from './modules/auth.routes.js';
import { registerQueueRoutes } from './modules/queues.routes.js';
import { registerDashboardRoutes } from './modules/dashboard.routes.js';
import { registerDrilldownRoutes } from './modules/drilldown.routes.js';
import { registerPortalRoutes } from './modules/portal.routes.js';
import { registerAuditLogger } from './lib/auditLogger.js';
import { registerMapsRoutes } from './modules/maps.routes.js';
import { registerOwnerRoutes } from './modules/owners.routes.js';
import { registerGovernanceRoutes } from './modules/governance.routes.js';
import { registerVendorPortalRoutes } from './modules/vendorPortal.routes.js';
import { startScheduler } from './lib/scheduler.js';
import { registerOwnerExpenseRoutes } from './modules/ownerExpense.routes.js';
import { registerTripImportRoutes } from './modules/tripImport.routes.js';
import { registerFuelImportRoutes } from './modules/fuelImport.routes.js';
import { initRealtime } from './lib/realtime.js';
import { startLoops, stopLoops } from './agents/loopEngine.js';
import { startGraph, stopGraph } from './agents/graphEngine.js';

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
  // @fastify/cors defaults to GET,HEAD,POST — so every PATCH and DELETE this
  // API exposes failed its preflight from the dev server, and the browser
  // reported it as a bare "Failed to fetch" with no status to explain it.
  // Production never saw this (the SPA and the API share an origin behind
  // nginx, so no preflight is sent), which is exactly why it survived: the
  // masters screens edit and retire records, and none of that worked in dev.
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
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

// ── Audit trail ────────────────────────────────────────────────────────────
// MUST be registered before the route modules below: a Fastify hook applies to
// the routes registered after it in the same context, so moving this line down
// silently stops auditing everything above it — the failure mode being an audit
// log that looks healthy while covering none of the ERP.
registerAuditLogger(app);

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
// Fortnightly auto-billing: groups trips by unloading fortnight, operating
// company, customer and depot, prices each line through the rate engine, and
// delegates creation to POST /billing/bills so revenue reaches the ledger by
// exactly one path.
await app.register(registerFortnightBillingRoutes, { prefix: '/api/v1/billing' });
// Fortnightly petrol-pump bills: group unbilled slips by pump and period, price
// them (465 of 479 slips carry litres but no money, so the rate is derived and
// labelled), and show the variance against the physical bill BEFORE
// /queues/fuel-reconcile posts it to the vendor ledger.
await app.register(registerPumpBillingRoutes, { prefix: '/api/v1/fuel' });
// Trips advice -> loading -> unloading -> settlement (KALI's modules).
await app.register(registerOpsRoutes,      { prefix: '/api/v1/ops' });
// Fleet & party masters: vehicles, drivers, customers, vendors, lanes, rates.
await app.register(registerMastersRoutes,  { prefix: '/api/v1/masters' });
// Document storage — the replacement for Firebase Storage. Its own scope so it
// can register @fastify/multipart without disturbing fleet.routes'.
await app.register(registerFileRoutes,     { prefix: '/api/v1' });
// Cluster 3 — tolls, claims, wallet recharges, fleet cards, GST/TDS registers.
await app.register(registerTollRoutes,     { prefix: '/api/v1/toll' });
// Bank FASTag statements. Separate from the routes above because it must not be
// possible to reach the ledger through the plain /transactions endpoints — this
// is the only path that de-duplicates against what the GTROPY API already
// fetched before anything is posted.
await app.register(registerTollImportRoutes, { prefix: '/api/v1/toll' });
// IOCL AC5 dispatch invoices -> loading entries, pulled from both mailboxes.
// Admin-guarded: it inserts trips, and a sync button anyone can press is a
// mass-insert button. Exclusive per run -- two concurrent syncs would each
// build a deduplication index blind to the other's uncommitted inserts.
await app.register(registerIoclSyncRoutes, { prefix: '/api/v1/iocl' });
// Vehicle loans: contract import, the opening liability at a cut-off, and EMIs
// split into principal and interest. Kept apart from the loan CRUD screens for
// the same reason as the toll importer — this is the only path that recognises
// a loan in the ledger, and it must not be reachable by accident.
await app.register(registerLoanImportRoutes, { prefix: '/api/v1/loans' });
// Expiry alerts across lorries and drivers, and the backfill for compliance
// fees that were filed without an accounting entry.
await app.register(registerComplianceRoutes, { prefix: '/api/v1/compliance' });
// Loans/EMI, tyres, batteries and the service log.
await app.register(registerAssetRoutes,    { prefix: '/api/v1/assets' });
// Cluster 5 — load bazaar, the vendor hiring pool and portal KYC intake.
await app.register(registerBazaarRoutes,   { prefix: '/api/v1/bazaar' });
// Cluster 6 — WhatsApp CRM, letterpad documents, audit trail, site content and
// the settings singletons. The last collections Firestore still owned.
await app.register(registerCrmRoutes,      { prefix: '/api/v1/crm' });
// Identity. Replaces Firebase Auth — password login, WhatsApp OTP, sessions.
await app.register(registerAuthRoutes,     { prefix: '/api/v1/auth' });
// Review queues — retroactive expenses, the bill-parser mailboxes and what it
// extracted, plus the sidebar's pending counts.
await app.register(registerQueueRoutes,    { prefix: '/api/v1/queues' });
// Customer and vendor portals. External parties, scoped server-side to their
// own party row — the only routes here an outsider can reach.
await app.register(registerPortalRoutes,   { prefix: '/api/v1' });
// Shared cache in front of Google's BILLED endpoints (Directions/Geocode/
// Distance Matrix). Map loads and marker movement are not billed per request.
await app.register(registerMapsRoutes,     { prefix: '/api/v1' });
// Vehicle-owner statements and the vehicle-wise profitability matrix. Split by
// operating entity, because one owner's trucks earn inside several books.
await app.register(registerOwnerRoutes,    { prefix: '/api/v1' });
// Costs the company pays on an owner's behalf. Debits the owner khata only —
// never a company P&L expense group (TARA refuses that for attached vehicles).
await app.register(registerOwnerExpenseRoutes, { prefix: '/api/v1' });
// Bulk trip entry (validates by default, writes only on commit:true) and the
// freight posting that picks owned-vs-attached entry shape from the vehicle.
await app.register(registerTripImportRoutes,  { prefix: '/api/v1' });
// Pump-bill import: dual accounting by ownership, and a review queue for every
// row that must NOT reach a ledger.
await app.register(registerFuelImportRoutes,  { prefix: '/api/v1' });
await app.register(registerDashboardRoutes, { prefix: '/api/v1' });
// Drill-down reads the dashboard's own payload through app.inject() for its
// self-check, so it must register AFTER the routes it verifies.
await app.register(registerDrilldownRoutes, { prefix: '/api/v1' });
// MDM + maker-checker + provisional accrual (migrations 059-063).
await app.register(registerGovernanceRoutes, { prefix: '/api/v1' });
// Fleet Partner app: blind-bid load board, own fleet, earnings.
await app.register(registerVendorPortalRoutes, { prefix: '/api/v1' });

// Calendar jobs: the 15th/EOM accrual sweep and the daily <=10-day compliance
// check. Both gate themselves on the date, so the quarter-hourly tick is a
// heartbeat rather than the schedule.
startScheduler(app.log);


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
  // GRAPH, not loops. Ten independent timers could not carry a finding from
  // one agent to the next; a traversal threads one State through the nodes and
  // routes on what earlier nodes actually found. AGENT_ENGINE=loop falls back
  // to the old timers, which stay in the tree until the graph has run a while.
  if (process.env.AGENT_LOOPS !== '0') {
    if (process.env.AGENT_ENGINE === 'loop') startLoops();
    else startGraph();
  }

  await app.listen({ port: PORT, host: HOST });
  // Socket.io shares Fastify's HTTP server, so it needs no second port and no
  // second firewall rule. Attached AFTER listen(), when app.server exists.
  initRealtime(app.server, app.log);
  app.log.info(
    `prasad-erp-api listening on http://${HOST}:${PORT} · db=${conn.degraded ? 'DEGRADED' : conn.target}`
  );
  if (conn.degraded) {
    app.log.warn('running WITHOUT a database — all data routes will return 503 until one is reachable');
  }

  // Background IOCL invoice sync: every 15 minutes, 09:00-21:59 local.
  // Started only with a working database -- the importer's first act is to read
  // every trip to build its deduplication index, and against a degraded pool it
  // would fail every quarter hour and fill the log with it.
  if (!conn.degraded) startIoclSyncCron(app);
  else app.log.warn('iocl sync cron NOT started — database is degraded');
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
      // Stop the scheduler before the pool closes, or a tick that fires mid
      // shutdown spawns an importer whose database vanishes under it.
      stopIoclSyncCron();
      stopGraph();
      stopLoops();
      await stopBus();
      await closePool();
    } finally {
      process.exit(0);
    }
  });
}
