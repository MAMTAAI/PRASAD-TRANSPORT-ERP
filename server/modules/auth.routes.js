// server/modules/auth.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/auth — the identity provider that replaces Firebase Auth.
//
//   POST /login                 email + password  → JWT
//   POST /otp/request           mobile            → code over the OTP channel
//   POST /otp/verify            mobile + code     → JWT
//   POST /logout                revoke this session
//   GET  /me                    claims + fresh profile
//   POST /users                 create a staff user (admin)
//   POST /users/:id/password    set/reset a password (admin, or self)
//   GET  /health                is a login even possible right now
//
// WHAT THE OLD FLOW DID, AND WHY THIS IS NOT A LIKE-FOR-LIKE SWAP. Login.tsx
// called Firebase's signInWithEmailAndPassword and, only if that succeeded,
// read the USERS profile for role and permissions. Firebase held the
// credential; PostgreSQL held the authorisation. Now both live here — which is
// why every password has to be set once (all six hashes are the placeholder
// 'MIGRATION-RESET-REQUIRED'; see migration 042).
//
// ENUMERATION. A wrong email and a wrong password return the same 401 with the
// same body. The one exception is a deliberate, documented signal:
// PASSWORD_RESET_REQUIRED, which the cutover needs — otherwise six staff see
// "wrong password" for a password that was never wrong.
// ─────────────────────────────────────────────────────────────────────────────
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { query, isDegraded } from '../db/pool.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, bearer, hashCode, verifyCode, newOtp, ALGO } from '../lib/auth.js';
import * as otp from '../lib/otpChannel.js';
import * as mail from '../lib/mailChannel.js';
import { makeWaLinkGuard } from '../lib/waLinkGuard.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OTP_TTL_MIN = Number.parseInt(process.env.OTP_TTL_MINUTES ?? '5', 10);
const OTP_MAX_ATTEMPTS = 5;
const LOCK_AFTER = 5;          // failed password attempts
const LOCK_MINUTES = 15;

// Never let a password field leave the process, whatever the caller asked for.
const SAFE = 'id, legacy_id, full_name, email, mobile, role, permissions, scope, branch, city, state, status, account_status, approved_at, must_change_password, last_login_at, created_at, customer_id, vendor_id';

// The hash written for accounts that came across from Firebase without a
// credential. It is a sentinel, not a hash — nothing can ever verify against
// it, which is the point.
const MIGRATION_PLACEHOLDER = 'MIGRATION-RESET-REQUIRED';

// ── permissions shape ───────────────────────────────────────────────────────
// The column is jsonb with a CHECK that it is an OBJECT (users_permissions_is_object)
// and the migrated rows store {"grants": [...]}. Every consumer in the SPA —
// rbac, the sidebar, MarketVehicles' approve check — treats `permissions` as a
// flat ARRAY of module grants. Rather than change 40 call sites or drop a
// constraint that is keeping the column well-formed, the two shapes are
// translated here, at the only boundary that sees both.
const permsOut = (row) => (row ? { ...row, permissions: row.permissions?.grants ?? (Array.isArray(row.permissions) ? row.permissions : []) } : row);
const permsIn = (v) => JSON.stringify(Array.isArray(v) ? { grants: v } : (v && typeof v === 'object' ? v : { grants: [] }));

/** Authenticated-route guard. Checks the signature, then that the session has
 *  not been revoked — a JWT alone cannot be withdrawn, which is what
 *  auth_sessions exists for. */
export async function requireAuth(req, reply) {
  // Already established for this request, so do not establish it twice.
  //
  // The global onRequest guard in server/index.js now runs this for every
  // /api/ route, and 69 routes still name it as their own preHandler — as they
  // should, because a route must be safe on its own terms and not because of
  // something registered elsewhere. Without this line each of those pays a
  // second session lookup per request, for an answer it already has.
  if (req.user) return;

  const claims = verifyToken(bearer(req));
  if (!claims) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  // One query answers both questions: is the session still valid, and is the
  // ACCOUNT still allowed to use it. Checking the account only at login would
  // mean a suspension does not take effect until the existing token expires —
  // up to a full session, during which "revoke access" quietly does nothing.
  // The account is re-read on every request so a toggle in the approvals panel
  // bites immediately.
  const { rows } = await query(
    `SELECT u.account_status::text AS account_status
       FROM auth_sessions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.jti = $1::uuid AND s.expires_at > now()`, [claims.jti]);
  if (!rows.length) return reply.code(401).send({ error: 'SESSION_REVOKED' });

  // account_status is NULL for a driver session (drivers are not `users` rows,
  // see migration 046) — they are governed by the drivers master, not by the
  // staff approval workflow.
  const st = rows[0].account_status;
  if (st && st !== 'ACTIVE') return replyForStatus(reply, st);

  req.user = claims;
}

/** One place that turns an account state into a response, so the login path and
 *  the per-request guard can never disagree about what PENDING means. The codes
 *  are distinguishable because the SPA renders a different screen for each:
 *  "awaiting approval" is a wait, "suspended" is a refusal. */
function replyForStatus(reply, status) {
  if (status === 'PENDING') {
    return reply.code(403).send({
      error: 'ACCOUNT_PENDING_APPROVAL',
      detail: 'Account Under Verification. Please contact Prasad Transport Office for approval.',
    });
  }
  return reply.code(403).send({
    error: 'ACCOUNT_SUSPENDED',
    detail: 'This account has been suspended. Please contact Prasad Transport Office.',
  });
}

/** Owner-level guard, reusable outside this module.
 *
 *  Compares against the role the DATABASE stores. The SPA had the same check
 *  written as `role === 'Super Admin'`, which matches no row in `users` — that
 *  spelling drift is exactly what this shared export exists to prevent. */
export async function requireAdminRole(req, reply) {
  const done = await requireAuth(req, reply);
  if (done !== undefined) return done;
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) {
    return reply.code(403).send({ error: 'FORBIDDEN', detail: 'admin role required' });
  }
}

/** Admin token OR a machine caller holding the service secret.
 *
 *  WHY A SECOND DOOR EXISTS AT ALL. POST /finance/vouchers moves real money and
 *  now demands authorisation — but one of its callers is not a person. The IOCL
 *  reconciler runs unattended and posts a RECEIPT per bill; giving it a human's
 *  JWT would mean either a never-expiring staff token in a config file or a
 *  nightly job that fails at 3am when the session lapses. Neither is more secure
 *  than a dedicated secret that can be rotated on its own.
 *
 *  The service path is OFF unless ERP_SERVICE_TOKEN is set, so an install that
 *  never configures one has exactly the admin-only behaviour and no weaker
 *  fallback to discover later. Comparison is timing-safe: a plain === on a
 *  secret leaks its prefix to anyone willing to measure.
 *
 *  A service caller is NOT an admin. It gets req.user.role = 'SERVICE' and no
 *  session, so anything that reads req.user.sub for an actor id records a
 *  machine rather than impersonating a person. */
export async function requireAdminOrService(req, reply) {
  const configured = process.env.ERP_SERVICE_TOKEN;
  const presented = bearer(req);
  if (configured && presented && configured.length >= 24) {
    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      req.user = { sub: null, role: 'SERVICE', name: 'service:' + (req.headers['x-service-name'] ?? 'unnamed') };
      return;
    }
  }
  return requireAdminRole(req, reply);
}

// ── The SUPER_ADMIN lock (2026-09-01) ─────────────────────────────────────
// Nine people now hold admin rights, and requireAdmin ranks ADMIN and
// SUPER_ADMIN equally. That made every ADMIN a master key: /users/:id/password
// resets another account WITHOUT knowing its password — deliberately, that is
// what a reset is for — so any one of the eight could take the owner's account
// and log in as him. Maker-Checker means nothing while that is true.
//
// The rule: a SUPER_ADMIN row is not administrable from below. A SUPER_ADMIN
// still administers themselves and everyone else; nothing changes for them.
//
// ⚠️ LOCKING THE MUTATION ROUTES IS NOT ENOUGH ON ITS OWN, and that is the
// whole design. Two paths would walk straight around it:
//   · PATCH /users/:id carries `role`, so an ADMIN could promote THEMSELVES to
//     SUPER_ADMIN and come back as a peer.
//   · POST /users could mint a NEW SUPER_ADMIN at an address the caller owns,
//     and /password-reset/request would then send them its code.
// So the rank is only grantable by somebody who already holds it. Both gates
// below are load-bearing — removing either one re-opens the takeover.
const isSuper = (req) => req.user?.role === 'SUPER_ADMIN';

/** Refuses when the TARGET outranks the caller. Answers the request itself and
 *  returns true, so callers read `if (await superAdminLocked(...)) return;`. */
async function superAdminLocked(req, reply, targetId) {
  if (isSuper(req)) return false;                                // a peer may act
  if (String(targetId) === String(req.user?.sub)) return false;  // self is never blocked
  const { rows } = await query('SELECT role::text AS role FROM users WHERE id = $1::uuid', [targetId]);
  if (!rows.length) return false;                // NOT_FOUND is the route's own to send
  if (rows[0].role !== 'SUPER_ADMIN') return false;
  reply.code(403).send({
    error: 'SUPER_ADMIN_PROTECTED',
    detail: 'Ye account SUPER_ADMIN ka hai — ise sirf SUPER_ADMIN hi badal sakta hai.',
  });
  return true;
}

export async function registerAuthRoutes(app) {
  // ── Health ───────────────────────────────────────────────────────────────
  // Deploy-time question: "can anyone log in?" Answers without a credential.
  app.get('/health', async () => {
    const channel = await otp.available().catch((e) => ({ ok: false, reason: e.message }));
    let secretOk = true;
    try { issueToken({ sub: 'probe', jti: '00000000-0000-0000-0000-000000000000' }); }
    catch { secretOk = false; }
    // "Can anyone log in?" means accounts with NO usable credential, which is
    // the placeholder hash — not must_change_password, which now also marks
    // provisioned accounts that have a real password and are merely required to
    // rotate it. Counting the flag here reported healthy portal logins as
    // locked-out staff.
    const pending = isDegraded() ? null
      : (await query(
          `SELECT count(*)::int AS n FROM users
            WHERE password_hash = $1 OR password_salt IS NULL`, [MIGRATION_PLACEHOLDER])).rows[0].n;
    return {
      ok: secretOk && !isDegraded(),
      jwt_secret: secretOk ? 'set' : 'MISSING — logins will fail',
      otp_channel: { name: otp.CHANNEL_NAME, ...channel },
      users_pending_password_reset: pending,
    };
  });

  // ── Password login ───────────────────────────────────────────────────────
  app.post('/login', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) return reply.code(400).send({ error: 'MISSING_FIELDS' });

    // `email` is citext but citext here behaves case-SENSITIVELY (see the
    // accounting-architecture note), so it is lowered on both sides.
    const { rows } = await query(
      `SELECT id, full_name, email, role, status, account_status::text AS account_status,
              password_hash, password_salt,
              must_change_password, failed_logins, locked_until
         FROM users WHERE lower(email::text) = $1`, [email]);
    const u = rows[0];

    const deny = () => reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    if (!u) return deny();
    // The approval gate, before the password is even checked. Telling a PENDING
    // user "wrong password" would send them to reset a password that is fine.
    if (u.account_status !== 'ACTIVE') return replyForStatus(reply, u.account_status);
    const lockedUntil = u.locked_until ? new Date(u.locked_until) : null;
    if (lockedUntil && lockedUntil > new Date()) {
      return reply.code(429).send({ error: 'ACCOUNT_LOCKED', detail: `try again after ${lockedUntil.toLocaleTimeString()}` });
    }
    // AN EXPIRED LOCK HAS TO CLEAR THE COUNT IT WAS RAISED FROM.
    //
    // failed_logins was only ever reset by a successful login or by an admin
    // setting a password. Neither can happen while somebody is locked out, so
    // the counter was still sitting at the threshold once the fifteen minutes
    // elapsed — and the next wrong guess was attempt SIX, which is already
    // >= LOCK_AFTER, so it re-locked instantly for another fifteen minutes.
    // Serving the wait bought exactly ONE attempt; getting that one wrong cost
    // another quarter of an hour, with no way out. An account whose owner does
    // not know the password could never climb back out of that on its own —
    // which is precisely the account most likely to be locked in the first
    // place.
    //
    // Serving the wait is the whole of what the lockout asks for. Once it is
    // served the window starts over.
    const priorFailures = lockedUntil ? 0 : u.failed_logins;
    // The cutover signal. Distinguishable on purpose — see the header.
    //
    // Gate on "there is no password to check", NOT on must_change_password.
    // Those were the same thing during the Firebase cutover and are not the
    // same thing any more: an account provisioned with a real one-time password
    // (portal logins, scripts/provision-portal-user.mjs) is flagged
    // must_change_password so it is forced to rotate AFTER logging in. Gating
    // on the flag locked those accounts out of the login they were just given —
    // the rotation flag became a permanent refusal.
    const hasNoPassword = u.password_hash === MIGRATION_PLACEHOLDER || !u.password_salt;
    if (hasNoPassword) {
      return reply.code(409).send({
        error: 'PASSWORD_RESET_REQUIRED',
        detail: 'This account has no password yet — passwords were not carried over from Firebase. An admin must set one.',
      });
    }
    if (!verifyPassword(password, u.password_salt, u.password_hash)) {
      const n = priorFailures + 1;
      // Every parameter is cast explicitly: $2 appears both as an assignment to
      // a smallint column and inside a comparison, and without the casts
      // Postgres cannot deduce one type for both uses ("inconsistent types
      // deduced for parameter $2") — which failed only on the wrong-password
      // path, the one nobody exercises by accident.
      await query(
        `UPDATE users SET failed_logins = $2::smallint,
                          locked_until = CASE WHEN $2::smallint >= $3::smallint
                                              THEN now() + ($4::text || ' minutes')::interval
                                              ELSE NULL END
          WHERE id = $1::uuid`, [u.id, n, LOCK_AFTER, String(LOCK_MINUTES)]);
      // ELSE NULL, not ELSE locked_until. Below the threshold there is no
      // live lock to preserve — this path is only reachable once any previous
      // one has expired, and carrying the stale timestamp forward would make
      // priorFailures above read it as 'just expired' on every subsequent
      // request. The count would reset to zero each time, climb to one, and
      // never reach LOCK_AFTER again: the lockout would quietly stop working
      // altogether, which is a worse failure than the one being fixed.
      return deny();
    }

    // ── THE SECOND FACTOR (2026-08-31 mandate) ──────────────────────────────
    // A correct password no longer mints a session by itself: a LOGIN_2FA code
    // goes to the account's registered mobile and /login/verify finishes the
    // login. Two deliberate degradations, both said out loud in the response
    // and both narrower than they look:
    //   · no lane at all     → password-only login. Enforcing would brick an
    //     account with neither a usable mobile nor a working mail channel.
    //   · every lane down    → password-only login, logged. A dead WhatsApp
    //     engine plus a dead mail credential must degrade to yesterday's
    //     security, not to "nobody can enter the ERP".
    //
    // WHY EMAIL IS A LANE HERE TOO (2026-09-01). This route used to send over
    // the mobile alone, and that produced a real lockout: an account whose
    // `users.mobile` held a number its owner did not physically have could pass
    // the password stage and then never see the code — while
    // /password-reset/request, which has always sent over email AND WhatsApp,
    // reached the same person on the same account fine. One route reachable and
    // the other not is the bug. `users.email` is the login identifier, so it is
    // guaranteed present and already known good; the second factor has no
    // business depending on a handset alone.
    //
    // Both lanes carry the SAME code, so whichever arrives first works and
    // /login/verify — bound to email + code — needs no change.
    const { rows: mrow } = await query(
      'SELECT mobile, email::text AS email FROM users WHERE id = $1::uuid', [u.id]);
    const mobile = mrow[0]?.mobile ?? null;
    const mailTo = mrow[0]?.email ?? null;

    // Probed BEFORE a code is minted: available() answers "could this lane
    // carry one" WITHOUT sending, so an unusable lane never becomes a row in
    // auth_otp that nothing will ever deliver.
    const waLane = mobile ? await otp.available() : { ok: false, reason: 'no mobile on file' };
    const mailLane = mailTo ? await mail.available() : { ok: false, reason: 'no email on file' };

    let otpSkipped = null;
    if (!waLane.ok && !mailLane.ok) {
      otpSkipped = (!mobile && !mailTo) ? 'no_contact_on_file' : 'otp_channel_down';
      req.log.warn({ user: u.id, mobile: waLane.reason, email: mailLane.reason },
        '2FA skipped — no delivery lane available');
    }

    if (!otpSkipped) {
      const code = newOtp();
      const { saltHex, hashHex } = hashCode(code);
      await query(`UPDATE auth_otp SET consumed_at = now()
                    WHERE user_id = $1::uuid AND consumed_at IS NULL AND purpose = 'LOGIN_2FA'`, [u.id]);
      await query(
        `INSERT INTO auth_otp (user_id, mobile, code_hash, code_salt, channel, purpose, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5, 'LOGIN_2FA', now() + ($6 || ' minutes')::interval)`,
        [u.id, mobile, hashHex, saltHex, 'pending', String(OTP_TTL_MIN)]);

      // Sent side by side, failures COLLECTED rather than thrown — the same
      // shape as /password-reset/request, so one dead lane cannot mask a live
      // one and a half-delivery is never reported as a clean send.
      const delivered = [];
      const failed = [];
      await Promise.all([
        waLane.ok
          ? otp.send(mobile, code)
              .then((s) => delivered.push({ channel: s?.channel ?? otp.CHANNEL_NAME, to: maskMobile(mobile) }))
              .catch((e) => { req.log.error({ err: e }, '2fa whatsapp send failed'); failed.push(`mobile: ${e.message}`); })
          : Promise.resolve(failed.push(`mobile: ${waLane.reason}`)),
        mailLane.ok
          ? mail.send(mailTo, 'Prasad Transport ERP — login OTP',
              `${code} — Prasad Transport ERP login OTP.\n\n`
              + `Ye code ${OTP_TTL_MIN} minute me expire ho jayega. Kisi ko na batayein.\n`
              + 'Agar aapne abhi login nahi kiya tha to apna password turant badlein.')
              .then(() => delivered.push({ channel: 'email', to: maskEmail(mailTo) }))
              .catch((e) => { req.log.error({ err: e }, '2fa mail send failed'); failed.push(`email: ${e.message}`); })
          : Promise.resolve(failed.push(`email: ${mailLane.reason}`)),
      ]);

      // Every lane dead AFTER a live probe said otherwise: retire the code
      // rather than leave a valid one nobody was told about, and say so instead
      // of parking somebody on a screen waiting for what is not coming.
      if (!delivered.length) {
        await query(`UPDATE auth_otp SET consumed_at = now()
                      WHERE user_id = $1::uuid AND consumed_at IS NULL AND purpose = 'LOGIN_2FA'`, [u.id]);
        req.log.error({ user: u.id, failed }, '2fa otp send failed on every lane');
        return reply.code(502).send({ error: 'OTP_SEND_FAILED', detail: failed.join('; '), channels: failed });
      }

      // The row records the wires that ACTUALLY carried it, not a mode name.
      await query(`UPDATE auth_otp SET channel = $2
                    WHERE user_id = $1::uuid AND consumed_at IS NULL AND purpose = 'LOGIN_2FA'`,
        [u.id, delivered.map((d) => d.channel).join('+')]);
      // The password stage is done and said so; no token yet. failed_logins
      // clears here — the password was right, and the OTP has its own counter.
      await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1::uuid', [u.id]);
      const viaMobile = delivered.find((d) => d.channel !== 'email');
      const viaEmail = delivered.find((d) => d.channel === 'email');
      return {
        otp_required: true,
        // `mobile` is kept because the SPA reads it directly, but it is now
        // NULL when only the email lane carried the code — the screen must not
        // assume a handset (see the OTP step in src/Login.tsx).
        mobile: viaMobile ? viaMobile.to : null,
        email: viaEmail ? viaEmail.to : null,
        delivered,
        expires_in_minutes: OTP_TTL_MIN,
        detail: 'Password sahi hai — ab aaya hua OTP daaliye.',
      };
    }

    const session = await openSession(u, req);
    await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1::uuid', [u.id]);
    const { rows: profile } = await query(`SELECT ${SAFE} FROM users WHERE id = $1::uuid`, [u.id]);
    return { ...session, user: permsOut(profile[0]), otp_skipped: otpSkipped };
  });

  // ── The second half of a password login ──────────────────────────────────
  // Verifies the LOGIN_2FA code and mints the session the password stage
  // withheld. Bound to the USER (by email → user_id), never to the bare
  // mobile, so a code issued for one account cannot finish a login for
  // another that happens to share a handset.
  app.post('/login/verify', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    if (!email || code.length !== 6) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'email and the 6-digit code are required' });

    const { rows } = await query(
      `SELECT id, full_name, role, account_status::text AS account_status
         FROM users WHERE lower(email::text) = $1`, [email]);
    const u = rows[0];
    if (!u) return reply.code(401).send({ error: 'OTP_INVALID' });
    if (u.account_status !== 'ACTIVE') return replyForStatus(reply, u.account_status);

    const { rows: recs } = await query(
      `SELECT * FROM auth_otp
        WHERE user_id = $1::uuid AND consumed_at IS NULL AND expires_at > now()
          AND purpose = 'LOGIN_2FA'
        ORDER BY created_at DESC LIMIT 1`, [u.id]);
    const rec = recs[0];
    if (!rec) return reply.code(401).send({ error: 'OTP_INVALID', detail: 'code expired ya pehle use ho chuka — dobara login karein' });
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      await query('UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid', [rec.id]);
      return reply.code(429).send({ error: 'OTP_LOCKED', detail: 'bahut galat koshishein — dobara login karein' });
    }
    if (!verifyCode(code, rec.code_salt, rec.code_hash)) {
      await query('UPDATE auth_otp SET attempts = attempts + 1 WHERE id = $1::uuid', [rec.id]);
      return reply.code(401).send({ error: 'OTP_INVALID' });
    }
    const { rowCount } = await query(
      'UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid AND consumed_at IS NULL', [rec.id]);
    if (!rowCount) return reply.code(401).send({ error: 'OTP_ALREADY_USED' });

    const session = await openSession(u, req);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1::uuid', [u.id]);
    const { rows: profile } = await query(`SELECT ${SAFE} FROM users WHERE id = $1::uuid`, [u.id]);
    return { ...session, user: permsOut(profile[0]) };
  });

  async function openSession(u, req) {
    const { rows } = await query('SELECT gen_random_uuid() AS jti');
    const jti = rows[0].jti;
    const { token, expiresAt } = issueToken({ sub: u.id, jti, role: u.role, name: u.full_name });
    await query(
      `INSERT INTO auth_sessions (jti, user_id, expires_at, user_agent, ip)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [jti, u.id, expiresAt, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null]);
    return { token, expires_at: expiresAt };
  }

  // ═══ SELF-SERVICE PASSWORD CHANGE (logged-in, OTP-verified) ═══════════════
  // The Profile Settings flow of the 2026-08-31 mandate: any registered user
  // changes their OWN password after proving they hold the registered mobile.
  // Distinct purpose PASSWORD_CHANGE — a forgot-password code cannot be
  // replayed here and vice versa. Drivers have no password by design (OTP and
  // link-claim logins only), so the route says that instead of guessing.

  app.post('/me/password/otp', { preHandler: requireAuth }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    if (req.user.role === 'DRIVER') {
      return reply.code(400).send({ error: 'NOT_APPLICABLE', detail: 'driver login OTP se hota hai — password hai hi nahi' });
    }
    const { rows } = await query('SELECT id, mobile FROM users WHERE id = $1::uuid', [req.user.sub]);
    const u = rows[0];
    if (!u) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!u.mobile) {
      return reply.code(400).send({
        error: 'NO_MOBILE',
        detail: 'is account par mobile number nahi hai — admin se User Management mein number judwayein, tabhi OTP aa sakta hai',
      });
    }
    const ch = await otp.available();
    if (!ch.ok) return reply.code(503).send({ error: 'OTP_CHANNEL_UNAVAILABLE', detail: ch.reason });

    const code = newOtp();
    const { saltHex, hashHex } = hashCode(code);
    await query(`UPDATE auth_otp SET consumed_at = now()
                  WHERE user_id = $1::uuid AND consumed_at IS NULL AND purpose = 'PASSWORD_CHANGE'`, [u.id]);
    await query(
      `INSERT INTO auth_otp (user_id, mobile, code_hash, code_salt, channel, purpose, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, 'PASSWORD_CHANGE', now() + ($6 || ' minutes')::interval)`,
      [u.id, u.mobile, hashHex, saltHex, otp.CHANNEL_NAME, String(OTP_TTL_MIN)]);
    try { await otp.send(u.mobile, code); }
    catch (e) {
      req.log.error({ err: e }, 'password-change otp send failed');
      return reply.code(502).send({ error: 'OTP_SEND_FAILED', detail: e.message });
    }
    return { sent: true, mobile: `******${String(u.mobile).slice(-4)}`, expires_in_minutes: OTP_TTL_MIN };
  });

  app.post('/me/password', { preHandler: requireAuth }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    if (req.user.role === 'DRIVER') {
      return reply.code(400).send({ error: 'NOT_APPLICABLE', detail: 'driver login OTP se hota hai — password hai hi nahi' });
    }
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    const password = String(req.body?.new_password ?? req.body?.password ?? '');
    if (code.length !== 6) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'the 6-digit OTP is required' });
    if (password.length < 8) return reply.code(400).send({ error: 'WEAK_PASSWORD', detail: 'password must be at least 8 characters' });

    const { rows: recs } = await query(
      `SELECT * FROM auth_otp
        WHERE user_id = $1::uuid AND consumed_at IS NULL AND expires_at > now()
          AND purpose = 'PASSWORD_CHANGE'
        ORDER BY created_at DESC LIMIT 1`, [req.user.sub]);
    const rec = recs[0];
    if (!rec) return reply.code(401).send({ error: 'OTP_INVALID', detail: 'code expired ya use ho chuka — dobara OTP mangwayein' });
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      await query('UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid', [rec.id]);
      return reply.code(429).send({ error: 'OTP_LOCKED', detail: 'bahut galat koshishein — naya OTP mangwayein' });
    }
    if (!verifyCode(code, rec.code_salt, rec.code_hash)) {
      await query('UPDATE auth_otp SET attempts = attempts + 1 WHERE id = $1::uuid', [rec.id]);
      return reply.code(401).send({ error: 'OTP_INVALID' });
    }
    const { rowCount } = await query(
      'UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid AND consumed_at IS NULL', [rec.id]);
    if (!rowCount) return reply.code(401).send({ error: 'OTP_ALREADY_USED' });

    const { saltHex, hashHex } = hashPassword(password);
    await query(
      `UPDATE users SET password_hash = $2, password_salt = $3, password_algo = $4,
              must_change_password = false, failed_logins = 0, locked_until = NULL
        WHERE id = $1::uuid`, [req.user.sub, hashHex, saltHex, ALGO]);
    // Every OTHER session dies; the one that just proved the mobile survives —
    // logging somebody out of the screen they changed the password on reads as
    // a failure, not as security.
    await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid AND jti <> $2::uuid',
      [req.user.sub, req.user.jti]);
    return { ok: true, other_sessions_revoked: true };
  });

  // ── OTP ──────────────────────────────────────────────────────────────────
  app.post('/otp/request', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const mobile = last10(req.body?.mobile);
    if (mobile.length !== 10) return reply.code(400).send({ error: 'BAD_MOBILE' });

    // A number with no account gets the same 200 as one with an account — an
    // OTP endpoint that says "no such user" is a free directory of who works
    // here. Nothing is sent in that case.
    const { rows: who } = await query(
      `SELECT id FROM users WHERE mobile = $1 AND status = 'ACTIVE'
        UNION ALL SELECT id FROM drivers WHERE mobile = $1 LIMIT 1`, [mobile]);

    // One live code per number: re-requesting replaces the previous one so an
    // attacker cannot keep five guessable codes alive at once.
    if (who.length) {
      const channel = await otp.available();
      if (!channel.ok) {
        return reply.code(503).send({ error: 'OTP_CHANNEL_UNAVAILABLE', detail: channel.reason });
      }
      const code = newOtp();
      const { saltHex, hashHex } = hashCode(code);
      await query(`UPDATE auth_otp SET consumed_at = now()
                    WHERE mobile = $1 AND consumed_at IS NULL AND purpose = 'LOGIN'`, [mobile]);
      await query(
        `INSERT INTO auth_otp (mobile, code_hash, code_salt, channel, purpose, expires_at)
         VALUES ($1,$2,$3,$4,'LOGIN', now() + ($5 || ' minutes')::interval)`,
        [mobile, hashHex, saltHex, otp.CHANNEL_NAME, String(OTP_TTL_MIN)]);
      // In 'auto' mode the code may go out over WhatsApp or fall back to SMS —
      // the row records which wire actually carried it, not the mode name.
      try {
        const sent = await otp.send(mobile, code);
        if (sent?.channel && sent.channel !== otp.CHANNEL_NAME) {
          await query(`UPDATE auth_otp SET channel = $2
                        WHERE mobile = $1 AND consumed_at IS NULL AND purpose = 'LOGIN'`,
            [mobile, sent.channel]);
        }
      }
      catch (e) {
        req.log.error({ err: e }, 'otp send failed');
        return reply.code(502).send({ error: 'OTP_SEND_FAILED', detail: e.message });
      }
    }
    return { sent: true, channel: otp.CHANNEL_NAME, expires_in_minutes: OTP_TTL_MIN };
  });

  app.post('/otp/verify', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const mobile = last10(req.body?.mobile);
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    if (mobile.length !== 10 || code.length !== 6) return reply.code(400).send({ error: 'BAD_INPUT' });

    const { rows } = await query(
      `SELECT * FROM auth_otp
        WHERE mobile = $1 AND consumed_at IS NULL AND expires_at > now()
          AND purpose = 'LOGIN'
        ORDER BY created_at DESC LIMIT 1`, [mobile]);
    const rec = rows[0];
    if (!rec) return reply.code(401).send({ error: 'OTP_EXPIRED' });
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      await query('UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid', [rec.id]);
      return reply.code(429).send({ error: 'OTP_ATTEMPTS_EXCEEDED' });
    }
    if (!verifyCode(code, rec.code_salt, rec.code_hash)) {
      await query('UPDATE auth_otp SET attempts = attempts + 1 WHERE id = $1::uuid', [rec.id]);
      return reply.code(401).send({ error: 'OTP_INVALID' });
    }
    // Burn it before issuing the token: a code must be usable exactly once even
    // if two requests arrive together.
    const { rowCount } = await query(
      'UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid AND consumed_at IS NULL', [rec.id]);
    if (!rowCount) return reply.code(401).send({ error: 'OTP_ALREADY_USED' });

    // Match the account regardless of state, then answer with WHY it is
    // refused. Filtering on ACTIVE here instead would drop a PENDING staff
    // member through to the driver lookup below and tell them 'NO_ACCOUNT' —
    // sending someone who is simply waiting for approval to go and create an
    // account they already have.
    const { rows: staff } = await query(
      `SELECT id, full_name, role, account_status::text AS account_status
         FROM users WHERE mobile = $1 LIMIT 1`, [mobile]);
    if (staff.length && staff[0].account_status !== 'ACTIVE') {
      return replyForStatus(reply, staff[0].account_status);
    }
    if (staff.length) {
      const session = await openSession(staff[0], req);
      await query('UPDATE users SET last_login_at = now() WHERE id = $1::uuid', [staff[0].id]);
      const { rows: profile } = await query(`SELECT ${SAFE} FROM users WHERE id = $1::uuid`, [staff[0].id]);
      return { ...session, user: permsOut(profile[0]) };
    }
    // A driver is not a `users` row (see migration 046) but still gets a real,
    // revocable session — the app has to survive being closed and reopened, and
    // the alternative is the portal trusting a driver id out of localStorage.
    // The whole driver record comes back: it is that driver's own data, and the
    // portal renders the duty screen straight from it.
    const { rows: drv } = await query('SELECT * FROM drivers WHERE mobile = $1 LIMIT 1', [mobile]);
    if (!drv.length) return reply.code(401).send({ error: 'NO_ACCOUNT' });

    const { rows: [{ jti }] } = await query('SELECT gen_random_uuid() AS jti');
    const { token, expiresAt } = issueToken({ sub: drv[0].id, jti, role: 'DRIVER', name: drv[0].name });
    await query(
      `INSERT INTO auth_sessions (jti, driver_id, expires_at, user_agent, ip)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [jti, drv[0].id, expiresAt, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null]);
    // No last-login stamp on `drivers`: the column does not exist there, and
    // auth_sessions.issued_at already records every login with more detail.

    return { token, expires_at: expiresAt, driver: drv[0], role: 'DRIVER' };
  });

  // ═══ OTP-LESS DRIVER SIGN-IN ══════════════════════════════════════════════
  //
  // Everything behind driver login already worked on the day this was written:
  // DriverPortal captures GPS, POST /tracking/ping inserts and broadcasts,
  // LiveFleetMap draws it. The board still read "0 / 100 on map" and
  // trip_gps_pings held zero rows — because auth_sessions has never held a
  // single driver_id. 54 drivers with a mobile on file, not one login, ever.
  //
  // The only door was a six-digit code the driver had to read out of a chat and
  // type into an app. Every step of that is a place a driver stops. Two doors
  // replace it, and they are deliberately NOT equally powerful.

  /** Random URL-safe secret; the link is a bearer credential, so it is CSPRNG
   *  and long enough that guessing is not a strategy. */
  const newLinkToken = () => randomBytes(32).toString('base64url');
  const hashLink = (t) => createHash('sha256').update(String(t)).digest('hex');

  // ── DOOR 1: the WhatsApp link — full driver session ──────────────────────
  // Minted by staff (or by the trip-creation path) and sent to the driver's own
  // number. Possession of that handset is the authentication factor, exactly as
  // it was with the OTP; what changes is that the driver taps instead of types.
  app.post('/driver/link', { preHandler: requireAdminOrService }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const mobile = last10(b.mobile);
    const { rows: drv } = await query(
      `SELECT id, name, mobile FROM drivers
        WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
           OR ($2 <> '' AND right(regexp_replace(coalesce(mobile,''), '\\D', '', 'g'), 10) = $2)
        LIMIT 1`,
      [UUID_RE.test(String(b.driver_id ?? '')) ? b.driver_id : null, mobile]);
    if (!drv.length) return reply.code(404).send({ error: 'DRIVER_NOT_FOUND' });

    const token = newLinkToken();
    // Hours, not days. A link minted for today's dispatch is not a standing key
    // to the app, and the driver can always be sent another.
    const hours = Math.min(Math.max(Number(b.valid_hours ?? 72), 1), 168);
    const { rows: [link] } = await query(
      `INSERT INTO driver_login_links (driver_id, trip_id, token_hash, sent_to, created_by, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, now() + ($6 || ' hours')::interval)
       RETURNING id, expires_at`,
      [drv[0].id, UUID_RE.test(String(b.trip_id ?? '')) ? b.trip_id : null,
       hashLink(token), drv[0].mobile ?? null, req.user?.name ?? 'system', String(hours)]);

    // The base has to be the address a DRIVER's phone can open, which is not
    // necessarily the one this request arrived on.
    const base = (process.env.DRIVER_APP_URL || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
    return {
      ok: true,
      link_id: link.id,
      expires_at: link.expires_at,
      driver: { id: drv[0].id, name: drv[0].name, mobile: drv[0].mobile },
      // Returned ONCE and never stored — only its hash is kept.
      url: `${base}/driver?k=${token}`,
      token,
    };
  });

  // ── Claiming it: public, single use ──────────────────────────────────────
  // Public because a driver holding the link has no session yet — that is the
  // entire point. The token IS the credential.
  app.post('/driver/claim', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const token = String(req.body?.token ?? '').trim();
    if (!token) return reply.code(400).send({ error: 'MISSING_TOKEN' });

    // Burned in the same statement that claims it: two taps on one WhatsApp
    // message must not open two sessions, and checking-then-updating leaves a
    // window where they do.
    const { rows: claimed } = await query(
      `UPDATE driver_login_links
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING driver_id, trip_id`, [hashLink(token)]);
    if (!claimed.length) return reply.code(401).send({ error: 'LINK_INVALID_OR_USED' });

    const { rows: drv } = await query('SELECT * FROM drivers WHERE id = $1::uuid', [claimed[0].driver_id]);
    if (!drv.length) return reply.code(401).send({ error: 'NO_ACCOUNT' });

    const { rows: [{ jti }] } = await query('SELECT gen_random_uuid() AS jti');
    const { token: jwt, expiresAt } = issueToken({ sub: drv[0].id, jti, role: 'DRIVER', name: drv[0].name });
    await query(
      `INSERT INTO auth_sessions (jti, driver_id, expires_at, user_agent, ip)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [jti, drv[0].id, expiresAt, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null]);

    return { token: jwt, expires_at: expiresAt, driver: drv[0], role: 'DRIVER', trip_id: claimed[0].trip_id };
  });

  // ── DOOR 2: vehicle or mobile, straight in — BUT TRACKING ONLY ───────────
  //
  // A VEHICLE NUMBER IS PAINTED ON THE SIDE OF THE TRUCK. Anyone who can read
  // one could open this door, so what is behind it is deliberately almost
  // nothing: a session whose scope is TRACK_ONLY, which apiGuard admits to
  // POST /tracking/ping and to no other route in the system. It can say where a
  // truck is. It cannot read a freight rate, a customer, a driver's ledger or
  // another trip.
  //
  // That is the honest trade. The stated requirement was "vehicle number daalte
  // hi GPS tracking start ho jaye", and this does exactly that, without making
  // the fleet's movements readable by anyone who walks past a parked tanker.
  // The full app stays behind the link, which goes to the driver's own phone.
  //
  // The worst a stranger can do here is post a false position for a truck whose
  // number they can see — visible immediately on the dispatch board, and
  // attributable, because every ping records the session that wrote it.
  app.post('/driver/track', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const mobile = last10(b.mobile);
    // Vehicle numbers are written a dozen ways ("AS 26C 9809", "as26c9809").
    // Compared with the spaces stripped, on both sides.
    const vehicle = String(b.vehicle_no ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
    if (!mobile && !vehicle) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'vehicle_no ya mobile chahiye' });

    // The MOVING trip is the whole subject of a tracking session. No moving
    // trip, nothing to track — and saying so is more useful than a session that
    // can post pings nobody wants.
    const { rows: trips } = await query(
      `SELECT t.id, t.trip_code, t.vehicle_no, t.status, t.loading_point, t.unloading_location,
              t.consignee_name, t.driver_name, t.loading_date, d.id AS driver_id
         FROM trips t
         LEFT JOIN drivers d ON d.id = t.driver_id
        WHERE t.status IN ('LOADED','IN_TRANSIT','UNLOADING')
          AND ( ($1 <> '' AND upper(regexp_replace(coalesce(t.vehicle_no,''), '[^0-9a-zA-Z]', '', 'g')) = $1)
             OR ($2 <> '' AND right(regexp_replace(coalesce(d.mobile,''), '\\D', '', 'g'), 10) = $2) )
        ORDER BY t.loading_date DESC NULLS LAST
        LIMIT 1`, [vehicle, mobile]);
    if (!trips.length) {
      return reply.code(404).send({
        error: 'NO_ACTIVE_TRIP',
        detail: 'Is gaadi/number par abhi koi chalu trip nahi hai. Office se poochein.',
      });
    }
    const t = trips[0];

    const { rows: [{ jti }] } = await query('SELECT gen_random_uuid() AS jti');
    const { token, expiresAt } = issueToken({
      sub: t.driver_id ?? t.id, jti, role: 'DRIVER', name: t.driver_name ?? t.vehicle_no,
      scope: 'TRACK_ONLY',
    });
    // Recorded like any other session so it can be listed and revoked. driver_id
    // may be null when the trip has no driver linked — the session is still
    // real and still expires.
    await query(
      `INSERT INTO auth_sessions (jti, driver_id, expires_at, user_agent, ip)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [jti, t.driver_id ?? null, expiresAt, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null]);

    return {
      token, expires_at: expiresAt, role: 'DRIVER', scope: 'TRACK_ONLY',
      trip: {
        id: t.id, trip_code: t.trip_code, vehicle_no: t.vehicle_no, status: t.status,
        from: t.loading_point, to: t.unloading_location || t.consignee_name,
        driver_name: t.driver_name, loading_date: t.loading_date,
      },
    };
  });

  // ── Self-service password set / reset ────────────────────────────────────
  // THE PROBLEM THIS REPLACES. The only way an account got a password was an
  // admin typing one into the User & Role screen and then telling the person
  // what it was. That screen's password box reads "Leave blank to keep current
  // password", so saving a profile without filling it in sets nothing — and
  // still reports "Data Saved Successfully". The staff member is handed a
  // password that was never set, fails five times, and is locked out. The code
  // goes to the PERSON now, and they choose the password themselves; nobody
  // has to speak a password aloud or type it into a chat message.
  //
  // BOTH LANES, EITHER ONE IS ENOUGH. WhatsApp reaches someone whose engine is
  // linked and whose number is on file; email reaches everyone, because
  // users.email IS the login identifier. Sending on both and requiring only one
  // to succeed is what stops a single offline channel from blocking a reset.

  /** Mask a destination so a response can say WHERE a code went without
   *  reprinting the address in full to whoever asked. */
  const maskEmail = (e) => {
    const [name, domain] = String(e).split('@');
    if (!domain) return '***';
    return `${name.slice(0, 2)}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
  };
  const maskMobile = (m) => `******${String(m).slice(-4)}`;

  app.post('/password-reset/request', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'MISSING_FIELDS' });

    const { rows } = await query(
      `SELECT id, full_name, email::text AS email, mobile, account_status::text AS account_status
         FROM users WHERE lower(email::text) = $1`, [email]);
    const u = rows[0];

    // The same 200 whether or not the address belongs to an account — an
    // endpoint that answers "no such user" is a free directory of who works
    // here. This mirrors /otp/request, deliberately.
    const neutral = { sent: true, expires_in_minutes: OTP_TTL_MIN };
    if (!u) return neutral;

    // A held account must not be handed a route back in. Same codes as login,
    // so the SPA renders the same explanation rather than a silent no-op.
    if (u.account_status !== 'ACTIVE') return replyForStatus(reply, u.account_status);

    const code = newOtp();
    const { saltHex, hashHex } = hashCode(code);
    // One live reset code per account: re-requesting retires the previous one,
    // so an attacker cannot keep several guessable codes alive at once.
    await query(
      `UPDATE auth_otp SET consumed_at = now()
        WHERE user_id = $1::uuid AND consumed_at IS NULL AND purpose = 'PASSWORD_RESET'`, [u.id]);
    await query(
      `INSERT INTO auth_otp (user_id, mobile, code_hash, code_salt, channel, purpose, expires_at)
       VALUES ($1::uuid,$2,$3,$4,$5,'PASSWORD_RESET', now() + ($6 || ' minutes')::interval)`,
      [u.id, u.mobile ?? null, hashHex, saltHex, 'email+whatsapp', String(OTP_TTL_MIN)]);

    const body = [
      `${code} — Prasad Transport ERP password code.`,
      '',
      `Namaste ${u.full_name || ''}`.trim() + ',',
      `Is code se aap apna naya password khud set kar sakte hain. Ye code ${OTP_TTL_MIN} minute me expire ho jayega.`,
      'Kisi ko na batayein. Agar aapne ye code nahi manga tha to ise ignore karein aur office ko bata dein.',
    ].join('\n');

    // Sent side by side; one success is enough. Failures are COLLECTED rather
    // than thrown, so a dead channel cannot mask a live one.
    const delivered = [];
    const failed = [];
    await Promise.all([
      mail.send(u.email, 'Prasad Transport ERP — password set karne ka code', body)
        .then(() => delivered.push({ channel: 'email', to: maskEmail(u.email) }))
        .catch((e) => { req.log.error({ err: e }, 'reset mail failed'); failed.push(`email: ${e.message}`); }),
      u.mobile
        ? otp.send(u.mobile, code)
            .then(() => delivered.push({ channel: 'whatsapp', to: maskMobile(u.mobile) }))
            .catch((e) => { req.log.error({ err: e }, 'reset whatsapp failed'); failed.push(`whatsapp: ${e.message}`); })
        : Promise.resolve(failed.push('whatsapp: no mobile on file')),
    ]);

    // Both lanes dead is the one case worth breaking neutrality for. Reporting
    // success here would recreate precisely the failure this feature exists to
    // remove: somebody waiting for a code that was never going to arrive. The
    // unusable code is retired so it cannot be guessed at later.
    if (!delivered.length) {
      await query(`UPDATE auth_otp SET consumed_at = now()
                    WHERE user_id = $1::uuid AND consumed_at IS NULL AND purpose = 'PASSWORD_RESET'`, [u.id]);
      return reply.code(502).send({
        error: 'OTP_SEND_FAILED',
        detail: 'Code kisi bhi channel par nahi bheja ja saka. Office se sampark karein.',
        channels: failed,
      });
    }
    return { ...neutral, delivered };
  });

  app.post('/password-reset/confirm', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    const password = String(req.body?.password ?? '');
    if (!email || code.length !== 6) return reply.code(400).send({ error: 'BAD_INPUT' });
    if (password.length < 8) return reply.code(400).send({ error: 'WEAK_PASSWORD', detail: 'minimum 8 characters' });

    const { rows } = await query(
      `SELECT id, account_status::text AS account_status FROM users WHERE lower(email::text) = $1`, [email]);
    const u = rows[0];
    // A wrong address and a wrong code answer identically: the PAIR is the
    // credential here, and saying which half failed narrows the guess.
    const bad = () => reply.code(401).send({ error: 'OTP_INVALID' });
    if (!u) return bad();
    if (u.account_status !== 'ACTIVE') return replyForStatus(reply, u.account_status);

    const { rows: otps } = await query(
      `SELECT * FROM auth_otp
        WHERE user_id = $1::uuid AND consumed_at IS NULL AND expires_at > now()
          AND purpose = 'PASSWORD_RESET'
        ORDER BY created_at DESC LIMIT 1`, [u.id]);
    const rec = otps[0];
    if (!rec) return reply.code(401).send({ error: 'OTP_EXPIRED' });
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      await query('UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid', [rec.id]);
      return reply.code(429).send({ error: 'OTP_ATTEMPTS_EXCEEDED' });
    }
    if (!verifyCode(code, rec.code_salt, rec.code_hash)) {
      await query('UPDATE auth_otp SET attempts = attempts + 1 WHERE id = $1::uuid', [rec.id]);
      return bad();
    }
    // Burn before writing the password: a code must be usable exactly once even
    // if two requests arrive together.
    const { rowCount } = await query(
      'UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid AND consumed_at IS NULL', [rec.id]);
    if (!rowCount) return bad();

    const { saltHex, hashHex } = hashPassword(password);
    // failed_logins and locked_until are cleared by the same write. Someone
    // resetting a password is very often someone who has just locked
    // themselves out; leaving the lock standing would mean the reset appears to
    // work and the very next login still refuses them.
    await query(
      `UPDATE users SET password_hash = $2, password_salt = $3, password_algo = $4,
                        must_change_password = false, failed_logins = 0, locked_until = NULL,
                        updated_at = now()
        WHERE id = $1::uuid`, [u.id, hashHex, saltHex, ALGO]);
    // Every existing session dies with the change — the point of a reset is
    // that whatever held access before it no longer does.
    await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [u.id]);
    return { ok: true, sessions_revoked: true };
  });

  // ── Session ──────────────────────────────────────────────────────────────
  app.post('/logout', async (req, reply) => {
    const claims = verifyToken(bearer(req));
    if (claims?.jti) await query('DELETE FROM auth_sessions WHERE jti = $1::uuid', [claims.jti]);
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(`SELECT ${SAFE} FROM users WHERE id = $1::uuid`, [req.user.sub]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    // The profile dropdown shows the address this session was opened from, so
    // someone signed in on a machine they do not recognise can see it. It comes
    // from auth_sessions (where the session was ESTABLISHED) rather than req.ip
    // (where this one request came from) — behind a proxy those differ, and the
    // useful question is "where is my session logged in from".
    const { rows: sess } = await query(
      `SELECT ip, user_agent, issued_at, last_seen_at, expires_at
         FROM auth_sessions WHERE jti = $1::uuid`, [req.user.jti]);
    return { user: permsOut(rows[0]), session: sess[0] ?? null };
  });

  // ── My WhatsApp ──────────────────────────────────────────────────────────
  // Staff link their OWN number so dispatch messages leave from the person who
  // sent them instead of everything going out on the company line.
  //
  // THE SESSION ID IS TAKEN FROM THE TOKEN, NEVER FROM THE REQUEST. A QR is a
  // credential: whoever scans it becomes a linked device that can read every
  // chat on that account. A route that accepted an id in the path or the body
  // would let any signed-in user pull a QR for a colleague — or for the company
  // number — and quietly attach their own phone to it. There is deliberately no
  // way to ask for anybody else's, not even for an admin: an admin needing a
  // colleague unlinked can do it from the engine, and that is a rarer and more
  // deliberate act than this endpoint should make routine.
  const mySession = (req) => `u${String(req.user.sub).replace(/-/g, '')}`;

  // Only the wiring. The boundary, the role list and why OTP is deliberately
  // NOT gated the same way all live in server/lib/waLinkGuard.js, beside the
  // selftest that exercises every branch of it.
  const requireInternal = makeWaLinkGuard(requireAuth);

  app.get('/whatsapp/my-session', { preHandler: requireInternal }, async (req) => {
    return { ok: true, ...(await otp.userSessionStatus(mySession(req))) };
  });

  app.post('/whatsapp/my-session/link', { preHandler: requireInternal }, async (req, reply) => {
    try {
      // READ THE NUMBER HERE, FROM THEIR OWN ROW. Same rule as the session id:
      // never from the request. It lets the engine ask WhatsApp for a pairing
      // code — an 8-character code typed into WhatsApp → Link a device → "Link
      // with phone number instead" — rather than a QR, which is unusable on a
      // phone that is displaying it. No mobile on file is not an error: the
      // engine falls back to the QR and the screen still works.
      const { rows: me } = await query('SELECT mobile FROM users WHERE id = $1::uuid', [req.user.sub]);
      return { ok: true, ...(await otp.linkUserSession(mySession(req), me[0]?.mobile || null)) };
    } catch (e) {
      // The cap is not an error the operator can fix by retrying, so it is
      // reported as its own thing rather than a generic failure.
      if (e.code === 'SESSION_LIMIT') return reply.code(429).send({ error: 'SESSION_LIMIT', detail: e.message });
      // Not a failure to link — the engine simply predates the feature. Kept
      // distinct so the screen can name the one action that fixes it.
      if (e.code === 'ENGINE_OUTDATED') return reply.code(503).send({ error: 'ENGINE_OUTDATED', detail: e.message });
      return reply.code(502).send({ error: 'LINK_FAILED', detail: e.message });
    }
  });

  app.post('/whatsapp/my-session/unlink', { preHandler: requireInternal }, async (req, reply) => {
    try {
      await otp.unlinkUserSession(mySession(req), req.user.name);
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: 'UNLINK_FAILED', detail: e.message });
    }
  });

  // ── User administration ──────────────────────────────────────────────────
  const requireAdmin = async (req, reply) => {
    const done = await requireAuth(req, reply);
    if (done !== undefined) return done;                 // requireAuth replied
    if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN', detail: 'admin role required' });
    }
  };

  app.get('/users', { preHandler: requireAdmin }, async () => {
    const { rows } = await query(`SELECT ${SAFE} FROM users ORDER BY created_at DESC`);
    return { users: rows.map(permsOut) };
  });

  // ── Approval workflow ────────────────────────────────────────────────────
  // The approvals panel's list. PENDING first: the queue is the point of the
  // screen, and an account waiting on a human should not be below 40 rows of
  // already-approved ones.
  app.get('/approvals', { preHandler: requireAdmin }, async () => {
    const { rows } = await query(`
      SELECT u.id, u.full_name, u.email::text AS email, u.mobile, u.role::text AS role,
             u.branch, u.account_status::text AS account_status,
             u.created_at, u.last_login_at, u.approved_at,
             a.full_name AS approved_by_name,
             (SELECT count(*) FROM auth_sessions s
               WHERE s.user_id = u.id AND s.expires_at > now()
                 AND s.last_seen_at > now() - interval '5 minutes') > 0 AS online
        FROM users u
        LEFT JOIN users a ON a.id = u.approved_by
       ORDER BY (u.account_status = 'PENDING') DESC, u.created_at DESC`);
    const counts = await query(`
      SELECT account_status::text AS s, count(*)::int AS n FROM users GROUP BY 1`);
    return {
      users: rows,
      totals: Object.fromEntries(counts.rows.map((r) => [r.s, r.n])),
    };
  });

  // The toggle. ACTIVE <-> SUSPENDED, or PENDING -> ACTIVE on approval.
  app.post('/users/:id/account-status', { preHandler: requireAdmin }, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const next = String(req.body?.account_status ?? '').toUpperCase();
    if (!['PENDING', 'ACTIVE', 'SUSPENDED'].includes(next)) {
      return reply.code(400).send({ error: 'BAD_STATUS', detail: 'PENDING | ACTIVE | SUSPENDED' });
    }
    if (await superAdminLocked(req, reply, id)) return;
    // An admin suspending themselves locks the office out of its own approvals
    // screen — and the only way back is a shell on the box. Refuse it here.
    if (id === req.user.sub && next !== 'ACTIVE') {
      return reply.code(409).send({
        error: 'CANNOT_SUSPEND_SELF',
        detail: 'You cannot suspend or unapprove your own account.',
      });
    }
    // Likewise the last usable owner: revoking it leaves nobody who can grant
    // access back.
    if (next !== 'ACTIVE') {
      const { rows: [{ n }] } = await query(`
        SELECT count(*)::int AS n FROM users
         WHERE account_status = 'ACTIVE' AND role IN ('SUPER_ADMIN','ADMIN') AND id <> $1::uuid`, [id]);
      if (n === 0) {
        return reply.code(409).send({
          error: 'LAST_ADMIN',
          detail: 'This is the last active admin — approving nobody else would be possible.',
        });
      }
    }

    const { rows } = await query(`
      UPDATE users
         SET account_status = $2::account_status,
             approved_at = CASE WHEN $2 = 'ACTIVE' THEN now() ELSE approved_at END,
             approved_by = CASE WHEN $2 = 'ACTIVE' THEN $3::uuid ELSE approved_by END,
             updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, full_name, account_status::text AS account_status`,
      [id, next, req.user.sub]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });

    // Revoking access must end the sessions that already exist, or the account
    // keeps working until its token expires. requireAuth also re-checks the
    // account on every request, so this is belt and braces — but the belt is
    // what makes "revoke" mean revoke right now.
    if (next !== 'ACTIVE') {
      await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [id]);
    }
    return { ok: true, user: rows[0] };
  });

  app.post('/users', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.email || !b.full_name) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'email and full_name are required' });
    if (String(b.role ?? '').toUpperCase() === 'SUPER_ADMIN' && !isSuper(req)) {
      return reply.code(403).send({ error: 'SUPER_ADMIN_PROTECTED', detail: 'SUPER_ADMIN account sirf SUPER_ADMIN hi bana sakta hai.' });
    }
    // No password at creation: the account is created in the same
    // must_change_password state as the migrated ones, and an admin sets the
    // password through the endpoint below. One code path for "give this person
    // a password", not two.
    try {
      const { rows } = await query(`
        INSERT INTO users (full_name, email, mobile, role, permissions, scope, branch, city, state,
                           status, password_hash, password_salt, must_change_password)
        VALUES ($1,$2,$3,COALESCE($4,'VIEWER')::user_role,$5::jsonb,$6,$7,$8,$9,
                'ACTIVE',$10,NULL,true)
        RETURNING ${SAFE}`,
        [b.full_name, String(b.email).trim().toLowerCase(), b.mobile ? last10(b.mobile) : null,
         b.role ?? null, permsIn(b.permissions),
         b.scope ?? null, b.branch ?? null, b.city ?? null, b.state ?? null,
         MIGRATION_PLACEHOLDER]);
      return reply.code(201).send({ user: permsOut(rows[0]) });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: 'that email already exists' });
      if (e.code === '22P02') return reply.code(400).send({ error: 'BAD_ENUM', detail: e.message });
      throw e;
    }
  });

  // Profile edits only. `password_hash`, `status` and the lockout counters are
  // NOT in this list: a password is set through the endpoint below, and status
  // has its own route, so a plain profile save can never quietly re-enable a
  // disabled account or clear a lockout.
  const USER_COLS = ['full_name', 'mobile', 'role', 'permissions', 'scope', 'branch', 'city', 'state'];

  app.patch('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {};
    const cols = USER_COLS.filter((c) => b[c] !== undefined);
    if (!cols.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    if (String(b.role ?? '').toUpperCase() === 'SUPER_ADMIN' && !isSuper(req)) {
      return reply.code(403).send({ error: 'SUPER_ADMIN_PROTECTED', detail: 'SUPER_ADMIN role sirf SUPER_ADMIN hi de sakta hai.' });
    }
    if (await superAdminLocked(req, reply, req.params.id)) return;
    if (!UUID_RE.test(String(req.params.id))) return reply.code(400).send({ error: 'BAD_ID' });
    const vals = cols.map((c) => {
      if (c === 'permissions') return permsIn(b.permissions);
      if (c === 'mobile') return b.mobile ? last10(b.mobile) : null;
      return b[c];
    });
    const casts = cols.map((c, i) => `${c} = $${i + 2}${c === 'permissions' ? '::jsonb' : c === 'role' ? '::user_role' : ''}`);
    try {
      const { rows } = await query(
        `UPDATE users SET ${casts.join(', ')}, updated_at = now() WHERE id = $1::uuid RETURNING ${SAFE}`,
        [req.params.id, ...vals]);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { user: permsOut(rows[0]) };
    } catch (e) {
      if (e.code === '22P02') return reply.code(400).send({ error: 'BAD_ENUM', detail: e.message });
      throw e;
    }
  });

  app.post('/users/:id/status', { preHandler: requireAdmin }, async (req, reply) => {
    const status = String(req.body?.status ?? '').toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) return reply.code(400).send({ error: 'BAD_STATUS' });
    if (!UUID_RE.test(String(req.params.id))) return reply.code(400).send({ error: 'BAD_ID' });
    if (req.params.id === req.user.sub && status === 'INACTIVE') {
      return reply.code(409).send({ error: 'CANNOT_DISABLE_SELF' });
    }
    if (await superAdminLocked(req, reply, req.params.id)) return;
    const { rows } = await query(
      `UPDATE users SET status = $2::record_status, updated_at = now() WHERE id = $1::uuid RETURNING ${SAFE}`,
      [req.params.id, status]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Disabling an account must end its sessions; otherwise the person stays
    // logged in until their token expires, which is the whole point of it.
    if (status === 'INACTIVE') await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [req.params.id]);
    return { user: permsOut(rows[0]) };
  });

  app.delete('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    if (!UUID_RE.test(String(req.params.id))) return reply.code(400).send({ error: 'BAD_ID' });
    if (req.params.id === req.user.sub) return reply.code(409).send({ error: 'CANNOT_DELETE_SELF' });
    if (await superAdminLocked(req, reply, req.params.id)) return;
    try {
      const { rowCount } = await query('DELETE FROM users WHERE id = $1::uuid', [req.params.id]);
      if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { deleted: true };
    } catch (e) {
      // A user referenced by trips/vouchers cannot be removed — the honest
      // answer is "disable them", not a cascade that rewrites history.
      if (e.code === '23503') {
        return reply.code(409).send({ error: 'IN_USE', detail: 'this user is referenced by existing records — disable the account instead' });
      }
      throw e;
    }
  });

  app.post('/users/:id/password', { preHandler: requireAuth }, async (req, reply) => {
    const target = req.params.id;
    const isSelf = target === req.user.sub;
    const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role);
    if (!isSelf && !isAdmin) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (!UUID_RE.test(String(target))) return reply.code(400).send({ error: 'BAD_ID' });
    if (await superAdminLocked(req, reply, target)) return;

    const password = String(req.body?.password ?? '');
    if (password.length < 8) return reply.code(400).send({ error: 'WEAK_PASSWORD', detail: 'minimum 8 characters' });

    // Changing your own password requires the current one — otherwise a
    // borrowed unlocked screen is a permanent account takeover. An admin
    // resetting someone else's does not (that is what the reset is for).
    if (isSelf && !req.body?.skip_current) {
      const { rows } = await query('SELECT password_hash, password_salt, must_change_password FROM users WHERE id = $1::uuid', [target]);
      const u = rows[0];
      if (!u) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (!u.must_change_password && !verifyPassword(String(req.body?.current_password ?? ''), u.password_salt, u.password_hash)) {
        return reply.code(401).send({ error: 'CURRENT_PASSWORD_WRONG' });
      }
    }

    const { saltHex, hashHex } = hashPassword(password);
    const { rowCount } = await query(
      `UPDATE users SET password_hash = $2, password_salt = $3, password_algo = $4,
                        must_change_password = false, failed_logins = 0, locked_until = NULL
        WHERE id = $1::uuid`, [target, hashHex, saltHex, ALGO]);
    if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Every existing session for that user dies with the password change.
    await query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [target]);
    return { ok: true, sessions_revoked: true };
  });
}
