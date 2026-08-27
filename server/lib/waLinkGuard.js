// server/lib/waLinkGuard.js
// ─────────────────────────────────────────────────────────────────────────────
// WHO MAY LINK A WHATSAPP SESSION — the boundary, its reasoning, and nothing
// else. server/modules/auth.routes.js holds only the wiring, the same split
// apiGuard.js uses, so the rule can be exercised by waLinkGuard.selftest.js
// without standing up a database or a Fastify instance.
//
// WHY A SEPARATE GATE AT ALL. requireAuth is satisfied by any valid token, and
// drivers hold real ones — /otp/verify issues them against the `drivers` table.
// Before this, a driver could POST /whatsapp/my-session/link and attach their
// own handset as a linked device on a session the dispatch desk reads. Nothing
// in the route stopped it; nothing in the UI offered it either, which is how a
// hole like that stays open and unnoticed.
//
// THERE IS NO 'STAFF' ROLE IN THIS SYSTEM. Migration 001's user_role enum is
// SUPER_ADMIN, ADMIN, ACCOUNTS, DISPATCH, DRIVER, CUSTOMER, VIEWER (+ VENDOR,
// migration 047). The only 'STAFF' string in the repo is a display fallback in
// ProfileMenu.tsx for a user with no role at all. A gate written literally as
// "ADMIN and STAFF" would therefore have locked out ACCOUNTS, DISPATCH and
// SUPER_ADMIN — the owner's own account, and the very desk that runs Live
// Dispatch. "Staff and Admin" means the internal set below.
//
// OTP IS DELIBERATELY NOT GATED THIS WAY. It is the door drivers come in
// through and the only one they have: they are not `users` rows (migration 046)
// and have no password path, so restricting /otp/* to internal roles would lock
// all 54 of them out permanently. Sending somebody an OTP and attaching
// somebody's account as a readable device are different acts with different
// blast radii. Only the second belongs to the office.
// ─────────────────────────────────────────────────────────────────────────────

/** The internal set: every role that works for the company rather than with it. */
export const INTERNAL_ROLES = Object.freeze(['SUPER_ADMIN', 'ADMIN', 'ACCOUNTS', 'DISPATCH']);

/** Verbatim, because the operator reads it and support quotes it back. */
export const STAFF_ONLY_MESSAGE = 'WhatsApp auto-link is strictly reserved for Staff and Admin.';

/**
 * May this role link, unlink or inspect its own WhatsApp session?
 *
 * Case-insensitive and null-safe on purpose: a token that somehow carries no
 * role, or carries one in the wrong case, must land on DENY rather than throw
 * — an exception here would surface as a 500 and read as "the engine is down".
 */
export function mayLinkWhatsapp(role) {
  return INTERNAL_ROLES.includes(String(role ?? '').trim().toUpperCase());
}

/**
 * The Fastify preHandler itself, built around whatever requireAuth the route
 * module already uses. A factory rather than a bare function so the selftest
 * exercises the SAME code the routes run, instead of a copy of it that can
 * drift — the failure mode being a gate that passes its test and not its
 * traffic.
 *
 * Contract matches requireAuth's: return a value to mean "I have replied,
 * stop", return undefined to mean "carry on".
 */
export function makeWaLinkGuard(requireAuth) {
  return async function requireInternal(req, reply) {
    const done = await requireAuth(req, reply);
    if (done !== undefined) return done;                 // requireAuth replied
    if (!mayLinkWhatsapp(req.user?.role)) {
      return reply.code(403).send({ error: 'STAFF_ONLY', detail: STAFF_ONLY_MESSAGE });
    }
    return undefined;
  };
}
