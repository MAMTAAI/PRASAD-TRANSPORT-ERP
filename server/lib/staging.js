// server/lib/staging.js
// ─────────────────────────────────────────────────────────────────────────────
// THE QUARANTINE FENCE (owner directive, 2026-09-02).
//
// "No external user (Driver, Vendor, Customer, Fleet Partner) is allowed to
//  write directly to the core operational or financial database tables."
//
// Route design already put every external write into a staging table with a
// PENDING state (see docs/ACCESS-CONTROL-MATRIX.md §4). This file makes that a
// property of the DATABASE LAYER rather than of every route author's memory:
//
//   1. An AsyncLocalStorage request context is opened in an onRequest hook that
//      runs AFTER apiGuard has authenticated the caller, so it knows the role.
//   2. db/pool.js asks assertExternalWrite(sql) before every statement — plain
//      query() and every statement inside withTransaction() alike.
//   3. If the caller is external (or has no session at all) and the SQL writes a
//      table that is not in STAGING_TABLES, the statement is refused with
//      403 STAGING_ONLY before it reaches PostgreSQL, the transaction rolls back
//      and the refusal is logged with role, path and table.
//
// Staff sessions (ADMIN, DISPATCH, ACCOUNTS…), the SERVICE caller and the agent
// loops that run outside any HTTP request are untouched: the context is absent
// or not external, and the guard returns immediately.
//
// EXTENDING STAGING_TABLES IS A REVIEWED ACT. A table belongs here only if its
// rows WAIT for a staff APPROVE (quarantine) or are telemetry that is not a
// business fact. Never a ledger, a trip table, a master, a voucher.
// ─────────────────────────────────────────────────────────────────────────────
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();

/** The same set apiGuard confines to /portal/*, /files/*, /maps/*. */
export const EXTERNAL_ROLES = new Set(['DRIVER', 'VENDOR', 'CUSTOMER']);

export const STAGING_TABLES = new Set([
  // ── quarantine: every row waits for a staff APPROVE ──────────────────────
  'onboarding_applications',   // public KYC form → KYC Approvals
  'bank_change_requests',      // a live party's new bank account → KYC Approvals (2026-09-03)
  'partner_documents',         // driver / partner app uploads → Pending Expenses desk
  'driver_notices',            // in-app banners; the phone only stamps seen_at (2026-09-03)
  'expense_approvals',         // service-vendor bills → Pending Expenses desk (TARA posts on approve)
  'driver_requests',           // advance / fuel / leave asks → Driver Master
  'market_vehicles',           // partner trucks → PENDING APPROVAL
  'market_drivers',            // partner drivers → PENDING APPROVAL
  // ── market workflow state a party owns; money never moves here ───────────
  'bazaar_loads',              // customer loads land PENDING_REVIEW; awards need the desk
  'bazaar_bids',               // blind bids, PENDING until award review
  'bazaar_settlements',        // confirm / assign truck / POD_SUBMITTED; every rupee is an admin route
  // ── telemetry, caches, the event outbox — not business facts ─────────────
  'trip_gps_pings',
  'maps_cache',
  'agent_events',
  'share_links',               // the open counter on a WhatsApp share link
]);

/** enforce (default) · report (log only) · off. Flip to report to diagnose, never to ship. */
export const guardMode = () => String(process.env.STAGING_GUARD_MODE ?? 'enforce').toLowerCase();

export class StagingViolation extends Error {
  constructor(table, ctx) {
    super(`STAGING_ONLY: a ${ctx.role} session may not write "${table}". External writes land in the `
        + 'quarantine tables only and reach the core through a staff APPROVE in the Admin Control Hub.');
    this.name = 'StagingViolation';
    this.code = 'STAGING_ONLY';
    this.statusCode = 403;
    this.table = table;
    this.role = ctx.role;
    this.path = ctx.path;
  }
}

// One regex finds every write verb and the identifier after it. CTE writes
// (WITH x AS (INSERT INTO …)) are caught because the scan is global, not anchored.
const WRITE_RE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:ONLY\s+)?("?[A-Za-z_]\w*"?(?:\."?[A-Za-z_]\w*"?)?)/gi;

/** The tables a SQL text writes to (lower-case, schema stripped). Pure; unit-tested. */
export function writeTargets(sql) {
  const text = String(sql ?? '')
    .replace(/'(?:[^']|'')*'/g, "''")      // string literals may contain the words UPDATE / INSERT
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = new Set();
  for (const m of text.matchAll(WRITE_RE)) {
    if (m[1].toUpperCase() === 'UPDATE') {
      // SELECT … FOR UPDATE / FOR NO KEY UPDATE, ON CONFLICT DO UPDATE SET,
      // ON UPDATE CASCADE — the word without the verb.
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/\b(FOR|KEY|DO|ON)\s+$/i.test(before)) continue;
    }
    let name = m[2].replace(/"/g, '').toLowerCase();
    if (name.includes('.')) name = name.split('.').pop();
    if (name === 'set') continue;
    out.add(name);
  }
  return [...out];
}

/** Called by db/pool.js before every statement. Throws StagingViolation (403). */
export function assertExternalWrite(sql) {
  const ctx = requestContext.getStore();
  if (!ctx?.external) return;
  const mode = guardMode();
  if (mode === 'off') return;
  const bad = writeTargets(sql).filter((t) => !STAGING_TABLES.has(t));
  if (!bad.length) return;
  console.error(`[staging] ${mode === 'enforce' ? 'REFUSED' : 'REPORT'} ${ctx.role} ${ctx.method} ${ctx.path} → write to ${bad.join(', ')}`);
  if (mode === 'enforce') throw new StagingViolation(bad[0], ctx);
}

/** Fastify onRequest hook. Register it AFTER apiGuard so req.user is known.
 *  Uses the callback form on purpose: als.run(store, done) keeps every later
 *  hook and the handler inside the context (the @fastify/request-context pattern). */
export function stagingContextHook(req, reply, done) {
  const role = String(req.user?.role ?? '').toUpperCase();
  const path = String(req.url ?? '').split('?')[0];
  const external = !req.user || EXTERNAL_ROLES.has(role) || req.user?.scope === 'TRACK_ONLY';
  // Own-credential routes (OTP codes, sessions, own password) are confined by
  // apiGuard's exact-route list and write auth tables by design.
  const exempt = path.startsWith('/api/v1/auth/');
  requestContext.run({
    external: external && !exempt,
    role: role || 'PUBLIC',
    method: req.method,
    path,
    sub: req.user?.sub ?? null,
  }, done);
}

/** Infrastructure writes that happen INSIDE an external request but are the
 *  system's own facts, not the party's — the audit log row for the request,
 *  the session liveness stamp. They run in a SYSTEM context so the fence does
 *  not mistake them for the party writing. Use for exactly that, nothing else:
 *  a route handler that reaches for asSystem() is a route writing the core on
 *  an outsider's behalf, which is the thing this file exists to stop. */
export const asSystem = (fn) => requestContext.run({ external: false, role: 'SYSTEM', method: '-', path: '-', sub: null }, fn);

/** For tests and scripts: run fn as if inside a request of the given role. */
export const runAs = (ctx, fn) => requestContext.run({ external: true, method: 'TEST', path: '/test', ...ctx }, fn);
