// server/lib/auditLogger.js
// ─────────────────────────────────────────────────────────────────────────────
// auditLogger() — every state-changing request, recorded with who did it and
// what it changed.
//
// WHAT "BEFORE/AFTER" HONESTLY MEANS HERE. A generic hook sees an HTTP request,
// not a table. It cannot know that PATCH /api/v1/masters/customers/:id touches
// `customers` unless someone tells it — so ENTITY_TABLES below is that telling.
// For a mapped route the before-image is the real row read inside preHandler
// and the after-image is the real row re-read once the handler has finished:
// genuine row state on both sides, not an echo of the request body.
//
// For an UNMAPPED route there is no table to read, so `before` stays null and
// `after` holds the (redacted) request payload. That is a weaker record and it
// is marked as such — `action` carries the method and path either way, so the
// trail never implies it captured a row diff when it only captured an intent.
// The alternative — pretending the request body is the new row state — produces
// an audit log that reads authoritative and is quietly wrong.
//
// FAILURE IS NEVER THE CALLER'S PROBLEM. Auditing runs in try/catch throughout
// and the insert happens in onResponse, after the reply has been sent. A broken
// audit table must not turn a working trip save into a 500 — the trail exists
// to observe the system, not to gate it.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { query, isDegraded } from '../db/pool.js';
import { verifyToken, bearer } from './auth.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// URL segment -> table whose row is the subject of the change. Only tables with
// a uuid `id` belong here; the before/after read is `WHERE id = $1::uuid`.
const ENTITY_TABLES = {
  trips: 'trips',
  vehicles: 'vehicles',
  drivers: 'drivers',
  customers: 'customers',
  vendors: 'vendors',
  users: 'users',
  'market-vehicles': 'market_vehicles',
  market_vehicles: 'market_vehicles',
  bills: 'company_bills',
  'company-bills': 'company_bills',
  tyres: 'tyres',
  batteries: 'batteries',
  loans: 'loans',
  // Load Bazaar (2026-08-31 audit): portal-facing rows were logged intent-only
  // (redacted body, before=null). All have uuid ids, so full images apply.
  settlements: 'bazaar_settlements',
  'market-drivers': 'market_drivers',
  market_drivers: 'market_drivers',
  onboarding: 'onboarding_applications',
  'driver-requests': 'driver_requests',
  driver_requests: 'driver_requests',
};

// Never store these, at any depth. Passwords and tokens in an append-only table
// cannot be redacted later — the row is immutable by design, so anything that
// lands here lands permanently.
const SECRET_KEYS = /^(password|new_password|old_password|pw|token|secret|otp|code|authorization|api_?key|password_hash|password_salt)$/i;

function redact(value, depth = 0) {
  if (value == null || depth > 6) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  // A single oversized field (a base64 photo, an OCR dump) should not make the
  // audit row bigger than the record it describes.
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`;
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Work out what this request is about from its path.
 *  /api/v1/masters/customers/<uuid>/ledger -> { entity: 'customers', id: <uuid> } */
function classify(req) {
  const segments = String(req.url || '').split('?')[0].split('/').filter(Boolean);
  let entity = null;
  let table = null;
  let entityId = req.params?.id ?? null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (ENTITY_TABLES[seg]) {
      entity = seg;
      table = ENTITY_TABLES[seg];
      // The id is normally the segment right after the entity name.
      const next = segments[i + 1];
      if (!entityId && next && UUID_RE.test(next)) entityId = next;
    }
  }
  if (!entityId) {
    const last = segments[segments.length - 1];
    if (last && UUID_RE.test(last)) entityId = last;
  }
  return { entity, table, entityId: entityId ?? null };
}

/** Read one row as jsonb-able plain object; null if it is not there. */
async function snapshot(table, id) {
  if (!table || !id || !UUID_RE.test(id)) return null;
  try {
    const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1::uuid`, [id]);
    return rows[0] ? redact(rows[0]) : null;
  } catch {
    return null;   // unknown column shape / missing table — record nothing
  }
}

/** Identify the caller without requiring the route to be authenticated. */
function actorOf(req) {
  // requireAuth already ran on guarded routes; fall back to reading the bearer
  // ourselves so unguarded mutations are still attributed.
  const claims = req.user ?? verifyToken(bearer(req));
  if (!claims) return { userId: null, driverId: null, name: 'anonymous', role: 'ANONYMOUS' };
  const isDriver = claims.role === 'DRIVER';
  return {
    userId: isDriver ? null : (claims.sub ?? null),
    driverId: isDriver ? (claims.sub ?? null) : null,
    name: claims.name || 'unknown',
    role: claims.role || 'UNKNOWN',
  };
}

export function registerAuditLogger(app) {
  // ── before-image ──────────────────────────────────────────────────────────
  app.addHook('preHandler', async (req) => {
    if (!WRITE_METHODS.has(req.method)) return;
    try {
      req.auditCtx = { id: randomUUID(), startedAt: Date.now(), ...classify(req) };
      // Only UPDATE/DELETE have a meaningful prior state; POST creates.
      if (req.method !== 'POST' && !isDegraded()) {
        req.auditCtx.before = await snapshot(req.auditCtx.table, req.auditCtx.entityId);
      }
    } catch { /* auditing must never block the request */ }
  });

  // ── after-image + write ───────────────────────────────────────────────────
  app.addHook('onResponse', async (req, reply) => {
    if (!WRITE_METHODS.has(req.method) || !req.auditCtx) return;
    if (isDegraded()) return;

    const ctx = req.auditCtx;
    const status = reply.statusCode;
    try {
      let after = null;
      if (status < 400) {
        // A DELETE that succeeded has no after-row; that null IS the record.
        after = req.method === 'DELETE'
          ? null
          : await snapshot(ctx.table, ctx.entityId);
      }
      // No mapped table (or the row could not be re-read): fall back to the
      // request payload, which is an intent rather than a row state.
      const payloadFallback = after == null && req.method !== 'DELETE'
        ? redact(req.body ?? null)
        : null;

      const actor = actorOf(req);
      const action = `${req.method} ${ctx.entity ?? 'request'}`;

      await query(
        `INSERT INTO audit_logs
           (request_id, actor_user_id, actor_driver_id, actor_name, actor_role,
            ip, user_agent, method, path, route, action, entity, entity_id,
            before, after, status_code, duration_ms)
         VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 $14::jsonb,$15::jsonb,$16,$17)`,
        [
          ctx.id,
          actor.userId, actor.driverId, actor.name, actor.role,
          req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 300),
          req.method, String(req.url).split('?')[0].slice(0, 500),
          req.routeOptions?.url ?? null,
          action, ctx.entity, ctx.entityId,
          ctx.before ? JSON.stringify(ctx.before) : null,
          after ? JSON.stringify(after) : (payloadFallback ? JSON.stringify(payloadFallback) : null),
          status, Date.now() - ctx.startedAt,
        ]);
    } catch (err) {
      // Log where an operator will see it; never re-throw into the response
      // cycle, which has already completed.
      req.log?.warn({ err: err.message }, 'audit write failed');
    }
  });

  // ── session liveness ──────────────────────────────────────────────────────
  // The staff tracker's "online now" comes from auth_sessions.last_seen_at, and
  // the cheapest honest place to stamp it is any authenticated request. Done on
  // onResponse so it never sits in front of the handler.
  app.addHook('onResponse', async (req) => {
    try {
      const claims = req.user ?? verifyToken(bearer(req));
      if (!claims?.jti || isDegraded()) return;
      await query(
        'UPDATE auth_sessions SET last_seen_at = now() WHERE jti = $1::uuid', [claims.jti]);
    } catch { /* liveness is best-effort */ }
  });
}
