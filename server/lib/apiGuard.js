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
  // OTP-LESS DRIVER SIGN-IN. Both are doors, so neither can require a session.
  // /claim spends a link that was sent to the driver's own handset — the token
  // is the credential. /track takes a vehicle or mobile number and answers with
  // a session that can do nothing but report GPS (see TRACK_ONLY_API below).
  'POST /api/v1/auth/driver/claim',
  'POST /api/v1/auth/driver/track',
]);

/** The entire reach of a TRACK_ONLY session.
 *
 *  Kept as a set of its own rather than a flag on each route, so that a route
 *  written next year is closed to these sessions by not appearing here. That
 *  inversion is the whole point of this file, applied one level in.
 *
 *  ONE ENTRY, AND IT SHOULD STAY THAT WAY. This session is handed out on the
 *  strength of a number painted on a truck. Every addition widens what a
 *  stranger in a lorry park can reach. */
export const TRACK_ONLY_API = new Set([
  'POST /api/v1/tracking/ping',
]);

// ── EXTERNAL ROLES MAY ONLY REACH THEIR OWN CORNER OF THE API ────────────────
//
// A TRACK_ONLY session is confined above. But a FULL driver session (from
// POST /auth/driver/claim), and every vendor and customer portal login, carry
// role='DRIVER'|'VENDOR'|'CUSTOMER' with NO scope claim — so nothing above
// touches them, and until now they passed the same session check as staff and
// reached every route that did not name its own preHandler. The audit found the
// consequence: a driver token could read the whole finance and masters book and
// PATCH any trip; a vendor token could read any other vendor's ledger; a
// customer token could read any other customer's bills. The JWT carries no
// company or party id, so role is the only control available at this choke
// point — and it was not applied.
//
// The fix is the same inversion the rest of this file is built on, one level in:
// an external session is CLOSED to everything except the prefixes its own app
// actually calls. A route added next year is closed to these sessions because it
// was not added here. Staff roles (SUPER_ADMIN, ADMIN, anything not listed as
// external) are unaffected — the office ERP and the IOCL service caller see no
// change whatsoever.
//
// WHY PREFIXES AND NOT EXACT ROUTES. The portal and driver apps are small but
// their route lists move; pinning exact methods here would turn every portal
// tweak into a silent 403. The prefixes below are the surfaces those apps own,
// verified against src/portal and src/modules/mobile. Row-level ownership WITHIN
// these prefixes (a driver seeing only their own trips, a vendor only their own
// bills) is enforced by the routes themselves — portal.routes already derives
// the party from the session and never trusts a param; the driver /ops scoping
// is a route-level job this boundary deliberately does not pretend to do.
export const EXTERNAL_ROLES = new Set(['DRIVER', 'VENDOR', 'CUSTOMER']);

// Prefixes any external session may reach: getting in, its own portal, its own
// documents, map tiles, and the one tracking door. `/auth/users` is NOT here —
// creating accounts is staff work — so it is reached by the specific-route list
// below, never by a blanket `/auth/` prefix.
const EXTERNAL_COMMON_PREFIXES = [
  '/api/v1/portal/',   // customer + vendor portals — party derived server-side
  '/api/v1/files',     // own uploads/downloads; per-object ownership in files.routes
  '/api/v1/maps/',     // Directions/Geocode cache — no party data
];
const EXTERNAL_COMMON_ROUTES = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/logout',
  'POST /api/v1/tracking/ping',
]);
// Per-role extras: the duty screen a driver needs, the credit-bill door a vendor
// needs. A customer has neither — its whole world is /portal/customer.
const EXTERNAL_ROLE_PREFIXES = {
  DRIVER: ['/api/v1/ops/', '/api/v1/approvals'],
  VENDOR: ['/api/v1/vendor/'],
  CUSTOMER: [],
};

function externalMayReach(role, method, path, route) {
  if (EXTERNAL_COMMON_ROUTES.has(route)) return true;
  // /auth/otp/*, /auth/password-reset/* and /auth/driver/* are already PUBLIC_API
  // (handled before this runs); an authenticated external session needs nothing
  // else under /auth except the two common routes above.
  for (const p of EXTERNAL_COMMON_PREFIXES) if (path.startsWith(p)) return true;
  for (const p of (EXTERNAL_ROLE_PREFIXES[role] ?? [])) if (path.startsWith(p)) return true;
  return false;
}

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
  // The AC5 importer, filing IOCL dispatch invoices as loading entries. It runs
  // unattended from cron via ioclSyncRunner and has no session to carry.
  //
  // The register stopped advancing on 21-08 because every insert it attempted
  // answered 401, and the importer counted that into a local list which never
  // reached RESULT_JSON — so the tick logged "ok, inserted 0", which reads
  // exactly like a quiet day. The dead Gmail token arrived on top of it three
  // days later and got the blame for both. Re-authorising alone would have
  // turned the dashboard green and left the register frozen at 21-08.
  //
  // THIS IS A MASS-INSERT ROUTE AND OPENING IT IS A REAL WIDENING. It is the
  // narrowest door that works: the secret exists only in .env.api on the box,
  // it is the same door the unattended IOCL reconciler already uses for
  // POST /finance/vouchers, and the alternative — minting a human session for a
  // cron job — leaves a standing admin credential on disk instead.
  'POST /api/v1/ops/trips',
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
    const denied = await requireAuth(req, reply);
    // requireAuth sets req.user on success and replies on failure. Testing the
    // populated claims rather than reply.sent keeps this correct across Fastify
    // versions, where that flag has been renamed more than once.
    if (!req.user) return denied;

    // ── A TRACK_ONLY SESSION MAY DO EXACTLY ONE THING ───────────────────────
    //
    // POST /auth/driver/track hands a session to anyone who can name a vehicle
    // and its live trip — and a vehicle number is painted on the side of the
    // truck. That door exists because drivers could not get through the OTP one
    // and the fleet board had sat at "0 / 100 on map" since the day it was
    // built. It is only defensible while what lies behind it is this small.
    //
    // So the scope is enforced HERE, at the one place every /api/ request
    // passes, and not by remembering to check it on each route. A route added
    // next year is closed to these sessions because it was not added to this
    // set — the same inversion the whole file is built on.
    //
    // The worst such a session can do is post a false position for a truck
    // whose number a stranger could read. That shows up on the dispatch board
    // immediately and is attributable: the ping carries the jti that wrote it.
    // Reading a freight rate, a customer, a ledger or another trip is not on
    // the list, and cannot be reached from here.
    if (req.user?.scope === 'TRACK_ONLY' && !TRACK_ONLY_API.has(route)) {
      return reply.code(403).send({
        error: 'TRACK_ONLY_SESSION',
        detail: 'This session may only report GPS. Open the app from your WhatsApp link for the full driver screen.',
      });
    }

    // ── AN EXTERNAL SESSION MAY ONLY REACH ITS OWN CORNER ───────────────────
    // See EXTERNAL_ROLES above. Staff and SERVICE fall straight through. This is
    // the closed-by-default inversion applied to role, so an outsider holding a
    // valid portal or driver token cannot read another party's ledger or the
    // firm's books simply because a route forgot its own preHandler.
    const role = req.user?.role;
    if (EXTERNAL_ROLES.has(role) && !externalMayReach(role, req.method, path, route)) {
      return reply.code(403).send({
        error: 'OUTSIDE_ROLE_SCOPE',
        detail: 'This account may only use its own portal. If you reached this by mistake, sign in with a staff account.',
      });
    }
    return denied;
  };
}

export default makeApiGuard;
