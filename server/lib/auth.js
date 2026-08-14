// server/lib/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Password hashing and session tokens — what replaces Firebase Auth.
//
// NO NEW DEPENDENCY, DELIBERATELY. bcrypt and argon2 are native modules that
// have to compile, and this repo is developed on Windows and deployed to a
// t3.large with no build toolchain guarantee; jsonwebtoken is 400 lines of
// parsing we would still have to audit. node:crypto has PBKDF2 and HMAC, and a
// JWT is base64url segments with an HMAC over them. Both are written out here.
//
// PBKDF2-HMAC-SHA256 @ 100k iterations is not chosen for strength but for
// COMPATIBILITY: src/lib/passwords.ts already implements exactly these
// parameters in the browser and scripts/migrate-passwords.cjs mirrors them, so
// a hash made anywhere in this project verifies everywhere in it.
// ─────────────────────────────────────────────────────────────────────────────
import { pbkdf2Sync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export const ITERATIONS = 100_000;
export const ALGO = 'PBKDF2-SHA256-100000';

const JWT_TTL_SECONDS = (() => {
  const raw = String(process.env.JWT_TTL ?? '12h').trim();
  const m = raw.match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return 12 * 3600;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 'h').toLowerCase()];
  return Number(m[1]) * mult;
})();

// A missing secret must stop the process, not default to something guessable —
// a predictable signing key means anyone can mint an admin token. Read lazily
// so importing this module (tests, scripts) does not require the env.
function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32 || s === 'generate-a-long-random-value') {
    throw Object.assign(
      new Error('JWT_SECRET is missing or too short — set a 48-byte random value (see .env.example)'),
      { code: 'NO_JWT_SECRET' });
  }
  return s;
}

// ── Passwords ───────────────────────────────────────────────────────────────
export const derive = (password, saltHex) =>
  pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), ITERATIONS, 32, 'sha256').toString('hex');

export function hashPassword(password) {
  const saltHex = randomBytes(16).toString('hex');
  return { saltHex, hashHex: derive(password, saltHex), algo: ALGO };
}

/** Constant-time compare. A plain === leaks the length of the matching prefix
 *  through timing, which is exactly the signal an attacker needs. */
export function verifyPassword(password, saltHex, hashHex) {
  if (!password || !saltHex || !hashHex) return false;
  let a, b;
  try {
    a = Buffer.from(derive(password, saltHex), 'hex');
    b = Buffer.from(hashHex, 'hex');
  } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}

// Same primitive for OTP codes: a stored OTP is a short-lived password.
export const hashCode = (code) => {
  const saltHex = randomBytes(16).toString('hex');
  return { saltHex, hashHex: derive(code, saltHex) };
};
export const verifyCode = verifyPassword;

/** 6 digits from rejection-free random bytes. Math.random() is not a CSPRNG and
 *  an OTP is a credential. */
export const newOtp = () => String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');

// ── JWT (HS256) ─────────────────────────────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');

export function issueToken({ sub, jti, role, name, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub, jti, role, name, scope, iat: now, exp: now + JWT_TTL_SECONDS,
  }));
  const body = `${header}.${payload}`;
  return { token: `${body}.${sign(body)}`, expiresAt: new Date((now + JWT_TTL_SECONDS) * 1000) };
}

/** Verify signature AND expiry. Returns the claims, or null — never throws, so
 *  a malformed Authorization header is a 401 rather than a 500. */
export function verifyToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [header, payload, mac] = parts;
  const expected = sign(`${header}.${payload}`);
  // Compare as bytes of equal length; a length mismatch is already a failure.
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!claims?.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  // alg is pinned above and never read back from the header — accepting the
  // token's own algorithm claim is the classic "alg: none" JWT forgery.
  return claims;
}

export const bearer = (req) => {
  const h = req.headers?.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};
