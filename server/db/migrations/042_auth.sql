-- ═══════════════════════════════════════════════════════════════════════════
-- 042_auth.sql — authentication moves off Firebase Auth
--
-- Firebase Auth, not Firestore, is what actually verified a login: Login.tsx
-- called signInWithEmailAndPassword and only then read the USERS profile. So
-- removing the `firebase` package removes the identity provider, and this is
-- what replaces it.
--
-- ⚠️ EVERY STAFF PASSWORD MUST BE SET AGAIN. All six `users.password_hash`
-- values are the literal string 'MIGRATION-RESET-REQUIRED' — the 2026-08 import
-- deliberately did not carry passwords across, because Firebase held them. They
-- cannot be recovered from here; Firebase's own scrypt export is the only route
-- that would preserve them and it needs the project's signer key. With six
-- users, a one-time reset is the cheaper and clearer answer. The CHECK below
-- makes the placeholder unusable rather than letting it look like a hash.
--
-- ALGORITHM. PBKDF2-HMAC-SHA256, 100k iterations — the same parameters
-- src/lib/passwords.ts already uses, so nothing new has to be agreed and no
-- native module (bcrypt/argon2) has to build on this Windows box. The salt gets
-- its own column because that is how the existing implementation is shaped.
--
-- OTP. Phone login (drivers, portal customers) was Firebase's SMS. There is no
-- SMS gateway on this host, so the code is delivered through the WhatsApp engine
-- the firm already runs — see server/lib/otpChannel.js for the seam. Codes are
-- stored HASHED with a TTL and an attempt counter: an OTP table in plaintext is
-- a password table in plaintext.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Salt, and a usable-password guard ────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_salt text,
  ADD COLUMN IF NOT EXISTS password_algo text NOT NULL DEFAULT 'PBKDF2-SHA256-100000',
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_logins smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Everyone carrying the placeholder is flagged, so the login route can say
-- "password reset required" instead of "wrong password" — the difference
-- between a supportable cutover and six confused phone calls.
UPDATE users
   SET must_change_password = true
 WHERE password_hash = 'MIGRATION-RESET-REQUIRED';

-- A real hash is 64 hex characters and always has a salt. The placeholder fails
-- both halves, so it can never be mistaken for a credential.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_shape;
ALTER TABLE users ADD CONSTRAINT users_password_shape CHECK (
  must_change_password
  OR (password_hash ~ '^[0-9a-f]{64}$' AND password_salt ~ '^[0-9a-f]{32}$')
);

-- ── 2. Phone OTP ────────────────────────────────────────────────────────────
-- One row per request. The code is stored as a PBKDF2 hash of the digits, so a
-- database read cannot log anyone in.
CREATE TABLE IF NOT EXISTS auth_otp (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile      text NOT NULL,                  -- last 10 digits, normalised
  code_hash   text NOT NULL,
  code_salt   text NOT NULL,
  purpose     text NOT NULL DEFAULT 'LOGIN' CHECK (purpose IN ('LOGIN','VERIFY')),
  channel     text NOT NULL DEFAULT 'whatsapp',
  attempts    smallint NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- The lookup is always "the newest live code for this number".
CREATE INDEX IF NOT EXISTS idx_auth_otp_live
  ON auth_otp (mobile, created_at DESC) WHERE consumed_at IS NULL;

-- ── 3. Sessions ─────────────────────────────────────────────────────────────
-- JWTs are stateless, which means a stolen or a sacked user's token stays valid
-- until it expires. This table is the revocation list: a token carries a `jti`
-- and is only accepted while its row is live. Logout deletes the row.
CREATE TABLE IF NOT EXISTS auth_sessions (
  jti         uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  ip          text
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_exp ON auth_sessions (expires_at);

COMMIT;
