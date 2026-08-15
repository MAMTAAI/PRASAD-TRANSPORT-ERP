-- ═══════════════════════════════════════════════════════════════════════════
-- 050_account_approval_gate.sql — every account is approved by a human first
--
-- Adds users.account_status and makes it the single authority for "may this
-- account be used". Self-service registrations land as PENDING and cannot log
-- in until someone in the office flips them to ACTIVE.
--
-- THE DEFAULT IS THE WHOLE POINT, AND IT IS ALSO THE TRAP. New rows default to
-- PENDING, which is correct for a registration and WRONG for the six accounts
-- that already exist — defaulting those to PENDING would lock the entire
-- company out of its own ERP at deploy time, including the only accounts that
-- could approve anyone. Existing rows are therefore backfilled from their
-- current record_status BEFORE the default applies to anything.
--
-- KEEPING THE TWO COLUMNS HONEST. users.status (record_status) still exists and
-- is still read by older code paths. Two columns answering the same question
-- drift, and the drift is silent: an account shown ACTIVE in the approvals
-- panel that the login still refuses. A trigger mirrors whichever side was
-- written, so neither can be stale:
--
--     account_status  ACTIVE     <-> status  ACTIVE
--     account_status  PENDING    ->  status  INACTIVE
--     account_status  SUSPENDED  ->  status  INACTIVE
--
-- Going the other way, INACTIVE/BLACKLISTED/ARCHIVED means SUSPENDED rather
-- than PENDING: an account that was switched off is not one awaiting review,
-- and mapping it to PENDING would quietly resurrect disabled accounts into the
-- approval queue.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status account_status;

-- Backfill BEFORE the NOT NULL/DEFAULT below, so nobody is locked out by the
-- migration itself.
UPDATE users
   SET account_status = CASE WHEN status = 'ACTIVE' THEN 'ACTIVE'::account_status
                             ELSE 'SUSPENDED'::account_status END
 WHERE account_status IS NULL;

ALTER TABLE users
  ALTER COLUMN account_status SET DEFAULT 'PENDING'::account_status,
  ALTER COLUMN account_status SET NOT NULL;

-- Who approved it and when — an approval with no author is not an audit trail.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE users SET approved_at = COALESCE(approved_at, created_at)
 WHERE account_status = 'ACTIVE' AND approved_at IS NULL;

-- The approvals panel opens on "who is waiting", which is this index.
CREATE INDEX IF NOT EXISTS idx_users_account_status ON users (account_status);

-- ── mirror ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION users_sync_status() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An explicit status on insert (legacy callers) decides; otherwise the
    -- account_status default does.
    IF NEW.account_status IS NULL THEN
      NEW.account_status := CASE WHEN NEW.status = 'ACTIVE' THEN 'ACTIVE'::account_status
                                 ELSE 'SUSPENDED'::account_status END;
    END IF;
    NEW.status := CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE'::record_status
                       ELSE 'INACTIVE'::record_status END;
    RETURN NEW;
  END IF;

  -- UPDATE: follow whichever column the caller actually touched.
  IF NEW.account_status IS DISTINCT FROM OLD.account_status THEN
    NEW.status := CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE'::record_status
                       ELSE 'INACTIVE'::record_status END;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.account_status := CASE WHEN NEW.status = 'ACTIVE' THEN 'ACTIVE'::account_status
                               ELSE 'SUSPENDED'::account_status END;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS users_status_mirror ON users;
CREATE TRIGGER users_status_mirror
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_sync_status();

COMMIT;
