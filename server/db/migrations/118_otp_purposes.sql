-- ═══════════════════════════════════════════════════════════════════════════
-- 118_otp_purposes.sql — two new reasons a one-time code exists
--
-- The registered-user OTP mandate (2026-08-31):
--
--   LOGIN_2FA        the code sent AFTER a correct password. A password login
--                    no longer mints a session by itself; this purpose is the
--                    second factor, bound to the user id so a code requested
--                    for one account can never finish a login for another.
--   PASSWORD_CHANGE  the code a LOGGED-IN user verifies to change their own
--                    password from Profile Settings. Separate from
--                    PASSWORD_RESET (the logged-out forgot-password flow) so
--                    neither code can be replayed into the other flow.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE auth_otp DROP CONSTRAINT IF EXISTS auth_otp_purpose_check;
ALTER TABLE auth_otp ADD CONSTRAINT auth_otp_purpose_check
  CHECK (purpose IN ('LOGIN','VERIFY','PASSWORD_RESET','LOGIN_2FA','PASSWORD_CHANGE'));

COMMIT;
