// server/lib/apiGuard.js
// ─────────────────────────────────────────────────────────────────────────────
// THE API IS CLOSED BY DEFAULT. This file is the list of exceptions.
//
// It was open by default until 27-08-2026: 357 routes registered under /api/,
// 69 of them carrying a preHandler, so the driver master, the ledgers, the
// billing rows and the whole v5 dashboard answered 200 to anyone on the
// internet holding the URL. Verified from a shell with no cookie, no token and
// no session — 54 driver records, 100 ledger rows, every customer.
//
// WHY A HOOK AND NOT 288 preHandlers. A guard per route is 288 chances to miss
// one, and the one missed is invisible: it looks exactly like a route that
// works. It is also a standing tax on every route added afterwards, paid by
// whoever forgets. Inverting it makes the dangerous case the one somebody has
// to type out — a new route is protected because it exists, and opening it
// means adding a line to a list that reads as a security boundary.
//
// WHY ITS OWN MODULE. Inline in index.js this is a paragraph in a 400-line boot
// file. Here it can be read on its own and, more to the point, tested: see
// apiGuard.selftest.js, which exercises every branch below without a database
// or a network.
//
// SAFE TO ENFORCE BECAUSE THE FRONT END ALREADY SENDS THE TOKEN.
// src/lib/authFetch.ts wraps window.fetch and attaches the session bearer to
// every call to this API's own origin, installed from main.tsx before render.
// The SPA, both portals and the driver app were already authenticating; the
// server simply was not checking.
// ─────────────────────────────────────────────────────────────────────────────
import { timingSafeEqual } from 'node:crypto';

/** Reachable with no credential at all. Every entry needs a reason. */
export const PUBLIC_API = new Set([
  // Getting in. None of these can require a session — they are how you get one.
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/otp/request',
  'POST /api/v1/auth/otp/verify',
  'POST /api/v1/auth/password-reset/request',
  'POST /api/v1/auth/password-reset/confirm',
  // Logout already tolerates a missing or dead token, and refusing it would
  // strand somebody holding an expired one on a session they cannot end.
  'POST /api/v1/auth/logout',
  // "Can anyone log in right now" — answered without a credential on purpose,
  // and it names no person and no record.
  'GET /api/v1/auth/health',
  // The marketing site renders before anybody has logged in.
  'GET /api/v1/crm/website',
  // A fleet partner applying has no account yet; this IS the application.
  'POST /api/v1/bazaar/onboarding',
]);

// THIS LIST MAY ONLY DESCRIBE, NEVER WIDEN.
//
// Every entry above was verified against the running server to be reachable
// today without a credential, because an allowlist written from reading the
// front end will confidently open routes that were already shut. The load board
// is the case that proves it: the pre-login FleetPartnerPortal calls
// GET /bazaar/loads, so it looked like an obvious entry — and the route has
// carried requireAdminRole all along and answers 401 in production. Listing it
// would not have preserved behaviour, it would have published the load book.
// Same for GET and POST /bazaar/bids, which the same screen calls and which are
// likewise already admin-only. Those calls have simply never worked from that
// screen; that is a separate bug, and not one to fix by removing a lock.

/** Machine callers. Not people, no session — they carry the service secret. */
export const SERVICE_API = new Set([
  'POST /api/v1/crm/chats',
  'POST /api/v1/crm/logs',
]);

const bearerOf = (req) => {
  const h = req.headers?.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

const usableSecret = (t) => typeof t === 'string' && t.length >= 24;

/**
 * Build the onRequest hook.
 *
 * @param requireAuth  the session guard from auth.routes.js
 * @param serviceToken ERP_SERVICE_TOKEN, or undefined when not configured
 */
export function makeApiGuard({ requireAuth, serviceToken }) {
  const serviceEnforced = usableSecret(serviceToken);

  return async function apiGuard(req, reply) {
    // Only this API. The SPA is served by a different process, and /healthz and
    // /readyz sit outside /api/ deliberately: a load balancer cannot present a
    // bearer token, and killing a healthy process because its probe got a 401
    // is a worse outage than the one it prevents.
    const path = (req.raw?.url ?? req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/')) return;

    // A CORS preflight carries no credentials by definition; refusing it turns
    // every cross-origin call into a failure that looks like a network fault.
    if (req.method === 'OPTIONS') return;

    const route = `${req.method} ${path}`;
    if (PUBLIC_API.has(route)) return;

    if (SERVICE_API.has(route)) {
      // WRONG-LOUD RATHER THAN WRONG-QUIET, the call apiBase.ts also makes.
      // With no secret configured the engine cannot present one, and enforcing
      // it would silently stop WhatsApp messages being recorded — data loss
      // nobody notices for days. Left open in that case, and index.js says so
      // at every boot until somebody sets the variable.
      if (!serviceEnforced) return;
      const presented = bearerOf(req);
      if (presented) {
        // Timing-safe: a plain === on a secret leaks its prefix to anyone
        // willing to measure. Same reasoning as requireAdminOrService.
        const a = Buffer.from(presented);
        const b = Buffer.from(serviceToken);
        if (a.length === b.length && timingSafeEqual(a, b)) return;
      }
      // A machine that got the token wrong is not a person who can log in, so
      // it is refused here rather than falling through to a session check.
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }

    // Everything else: a real, unrevoked session. requireAuth re-reads the
    // account too, so a suspension bites immediately rather than at expiry.
    return requireAuth(req, reply);
  };
}

export default makeApiGuard;
