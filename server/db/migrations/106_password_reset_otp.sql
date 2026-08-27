-- ═══════════════════════════════════════════════════════════════════════════
-- 106_password_reset_otp.sql — staff set their own password, over OTP
--
-- WHY THIS EXISTS. Until now the only way an account got a password was an
-- admin typing one into the User & Role screen and then telling the person
-- what it was. That failed quietly and repeatedly: the password box carries
-- the placeholder "Leave blank to keep current password", so saving a profile
-- without filling it in changes nothing — while still reporting "Data Saved
-- Successfully". The staff member is then handed a password that was never
-- set, fails five times, and is locked out.
--
-- So the code goes to the PERSON instead, on the two channels the firm already
-- runs, and they choose their own password. No password is ever spoken aloud,
-- typed by a third party, or written into a chat message.
--
-- THE PURPOSE COLUMN IS A SECURITY BOUNDARY, NOT BOOKKEEPING. auth_otp already
-- backs the portal LOGIN flow, where a verified code is exchanged for a full
-- session (POST /otp/verify). If a password-reset code were stored in the same
-- table with the same purpose, anyone holding one could present it to that
-- endpoint and receive a session instead of a password prompt — a reset code
-- would silently be a login. Both flows are therefore pinned to their own
-- purpose, in the query as well as in this constraint.
--
-- ADDRESSED TO AN ACCOUNT, NOT A NUMBER. A login OTP is sent to whoever holds
-- a phone number. A reset belongs to a known account: it is looked up by email
-- and may go out by email alone, because not every staff row has a mobile on
-- file. `mobile` therefore becomes optional and `user_id` carries the address,
-- with a constraint so a row can never be anonymous in both directions.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The inline CHECK from 042 was auto-named by Postgres. Find it rather than
-- guessing the name, so this runs on a database restored from any dump.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'auth_otp'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%purpose%'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE auth_otp DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE auth_otp
  ADD CONSTRAINT auth_otp_purpose_check
  CHECK (purpose IN ('LOGIN', 'VERIFY', 'PASSWORD_RESET'));

ALTER TABLE auth_otp
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE auth_otp ALTER COLUMN mobile DROP NOT NULL;

-- A code with neither a number nor an account behind it can never be matched
-- to anybody, so it is a row that only takes up space and confuses an audit.
ALTER TABLE auth_otp DROP CONSTRAINT IF EXISTS auth_otp_addressed;
ALTER TABLE auth_otp
  ADD CONSTRAINT auth_otp_addressed
  CHECK (mobile IS NOT NULL OR user_id IS NOT NULL);

-- The reset lookup is always "the newest live reset code for this account",
-- which is the mirror of idx_auth_otp_live for the login flow.
CREATE INDEX IF NOT EXISTS idx_auth_otp_reset
  ON auth_otp (user_id, created_at DESC)
  WHERE consumed_at IS NULL AND purpose = 'PASSWORD_RESET';

COMMIT;
