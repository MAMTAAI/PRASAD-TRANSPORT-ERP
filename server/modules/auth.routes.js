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
import { query, isDegraded } from '../db/pool.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, bearer, hashCode, verifyCode, newOtp, ALGO } from '../lib/auth.js';
import * as otp from '../lib/otpChannel.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OTP_TTL_MIN = Number.parseInt(process.env.OTP_TTL_MINUTES ?? '5', 10);
const OTP_MAX_ATTEMPTS = 5;
const LOCK_AFTER = 5;          // failed password attempts
const LOCK_MINUTES = 15;

// Never let a password field leave the process, whatever the caller asked for.
const SAFE = 'id, legacy_id, full_name, email, mobile, role, permissions, scope, branch, city, state, status, must_change_password, last_login_at, created_at';

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
  const claims = verifyToken(bearer(req));
  if (!claims) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  const { rows } = await query(
    'SELECT s.jti FROM auth_sessions s WHERE s.jti = $1::uuid AND s.expires_at > now()', [claims.jti]);
  if (!rows.length) return reply.code(401).send({ error: 'SESSION_REVOKED' });
  req.user = claims;
}

export async function registerAuthRoutes(app) {
  // ── Health ───────────────────────────────────────────────────────────────
  // Deploy-time question: "can anyone log in?" Answers without a credential.
  app.get('/health', async () => {
    const channel = await otp.available().catch((e) => ({ ok: false, reason: e.message }));
    let secretOk = true;
    try { issueToken({ sub: 'probe', jti: '00000000-0000-0000-0000-000000000000' }); }
    catch { secretOk = false; }
    const pending = isDegraded() ? null
      : (await query('SELECT count(*)::int AS n FROM users WHERE must_change_password')).rows[0].n;
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
      `SELECT id, full_name, email, role, status, password_hash, password_salt,
              must_change_password, failed_logins, locked_until
         FROM users WHERE lower(email::text) = $1`, [email]);
    const u = rows[0];

    const deny = () => reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    if (!u) return deny();
    if (u.status !== 'ACTIVE') return reply.code(403).send({ error: 'ACCOUNT_INACTIVE' });
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      return reply.code(429).send({ error: 'ACCOUNT_LOCKED', detail: `try again after ${new Date(u.locked_until).toLocaleTimeString()}` });
    }
    // The cutover signal. Distinguishable on purpose — see the header.
    if (u.must_change_password) {
      return reply.code(409).send({
        error: 'PASSWORD_RESET_REQUIRED',
        detail: 'This account has no password yet — passwords were not carried over from Firebase. An admin must set one.',
      });
    }
    if (!verifyPassword(password, u.password_salt, u.password_hash)) {
      const n = u.failed_logins + 1;
      // Every parameter is cast explicitly: $2 appears both as an assignment to
      // a smallint column and inside a comparison, and without the casts
      // Postgres cannot deduce one type for both uses ("inconsistent types
      // deduced for parameter $2") — which failed only on the wrong-password
      // path, the one nobody exercises by accident.
      await query(
        `UPDATE users SET failed_logins = $2::smallint,
                          locked_until = CASE WHEN $2::smallint >= $3::smallint
                                              THEN now() + ($4::text || ' minutes')::interval
                                              ELSE locked_until END
          WHERE id = $1::uuid`, [u.id, n, LOCK_AFTER, String(LOCK_MINUTES)]);
      return deny();
    }

    const session = await openSession(u, req);
    await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1::uuid', [u.id]);
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
      await query('UPDATE auth_otp SET consumed_at = now() WHERE mobile = $1 AND consumed_at IS NULL', [mobile]);
      await query(
        `INSERT INTO auth_otp (mobile, code_hash, code_salt, channel, expires_at)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
        [mobile, hashHex, saltHex, otp.CHANNEL_NAME, String(OTP_TTL_MIN)]);
      try { await otp.send(mobile, code); }
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

    const { rows: staff } = await query(
      `SELECT id, full_name, role FROM users WHERE mobile = $1 AND status = 'ACTIVE' LIMIT 1`, [mobile]);
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

  // ── Session ──────────────────────────────────────────────────────────────
  app.post('/logout', async (req, reply) => {
    const claims = verifyToken(bearer(req));
    if (claims?.jti) await query('DELETE FROM auth_sessions WHERE jti = $1::uuid', [claims.jti]);
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(`SELECT ${SAFE} FROM users WHERE id = $1::uuid`, [req.user.sub]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { user: permsOut(rows[0]) };
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

  app.post('/users', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.email || !b.full_name) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'email and full_name are required' });
    // No password at creation: the account is created in the same
    // must_change_password state as the migrated ones, and an admin sets the
    // password through the endpoint below. One code path for "give this person
    // a password", not two.
    try {
      const { rows } = await query(`
        INSERT INTO users (full_name, email, mobile, role, permissions, scope, branch, city, state,
                           status, password_hash, password_salt, must_change_password)
        VALUES ($1,$2,$3,COALESCE($4,'VIEWER')::user_role,$5::jsonb,$6,$7,$8,$9,
                'ACTIVE','MIGRATION-RESET-REQUIRED',NULL,true)
        RETURNING ${SAFE}`,
        [b.full_name, String(b.email).trim().toLowerCase(), b.mobile ? last10(b.mobile) : null,
         b.role ?? null, permsIn(b.permissions),
         b.scope ?? null, b.branch ?? null, b.city ?? null, b.state ?? null]);
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
