-- ═══════════════════════════════════════════════════════════════════════════
-- 046_driver_sessions.sql — a driver is not a `users` row, but still logs in
--
-- 042 keyed auth_sessions on users(id), which is right for staff and leaves the
-- driver app with nowhere to hang a session. A driver genuinely is not a user:
-- no email, no role, no permissions, and DRIVERS is its own master with its own
-- lifecycle. Creating shadow `users` rows for 47 drivers would give every one of
-- them a login to the office ERP as a side effect.
--
-- So the session gets two possible owners and a constraint that exactly one is
-- set. The alternative — a nullable, unconstrained pair — is how you end up
-- with a session that belongs to nobody, or to two people.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE auth_sessions
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES drivers(id) ON DELETE CASCADE;

ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_one_owner;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_one_owner CHECK (
  (user_id IS NOT NULL AND driver_id IS NULL) OR
  (user_id IS NULL AND driver_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_driver ON auth_sessions (driver_id)
  WHERE driver_id IS NOT NULL;

COMMIT;
