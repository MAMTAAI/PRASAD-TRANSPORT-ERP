-- 135_registration_otp_gate.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE REGISTRATION FORM MOVES BEHIND AN OTP WALL (owner, 2026-09-03)
--
--   "Put the Registration Form strictly behind an OTP verification wall. We
--    don't want spam entries in our CRM. A user must verify their mobile
--    number before they can even see the KYC form."
--
-- Login OTPs (purpose 'LOGIN') are only ever sent to a number already on a
-- master — the login door must not become a directory of who works here. A
-- registration OTP is the opposite case by definition: the number is on no
-- master yet, and sending to it is the whole point. So it is its own purpose,
-- and it can never satisfy a login check.
--
-- The proof that survives the OTP is a TICKET, not a JWT. A signed token minted
-- here would be a structurally valid session token — the bearer check would
-- accept it, with no role — so the proof is instead a random secret this server
-- stores hashed, scoped to one mobile, single-use, and dead in 30 minutes.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

DO $$
DECLARE cn text;
BEGIN
  SELECT conname INTO cn
    FROM pg_constraint
   WHERE conrelid = 'auth_otp'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%purpose%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE auth_otp DROP CONSTRAINT %I', cn);
  END IF;
END $$;

ALTER TABLE auth_otp
  ADD CONSTRAINT auth_otp_purpose_check
  CHECK (purpose IN ('LOGIN', 'VERIFY', 'PASSWORD_RESET', 'LOGIN_2FA', 'PASSWORD_CHANGE', 'REGISTER'));

-- The rate limit reads "how many REGISTER codes went to this number in the last
-- hour", which is this index's whole job.
CREATE INDEX IF NOT EXISTS idx_auth_otp_register_recent
  ON auth_otp (mobile, created_at DESC) WHERE purpose = 'REGISTER';

-- ── THE TICKET ───────────────────────────────────────────────────────────────
-- Handed out when a code verifies, spent when the application is filed. Stored
-- as a hash so a leaked backup does not hand anyone a live ticket, and pinned
-- to the mobile it was issued for so it cannot be spent on a different number.
CREATE TABLE IF NOT EXISTS registration_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile       text NOT NULL,
  ticket_hash  text NOT NULL,
  ticket_salt  text NOT NULL,
  issued_ip    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  application_id uuid REFERENCES onboarding_applications(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_registration_tickets_live
  ON registration_tickets (mobile, created_at DESC) WHERE consumed_at IS NULL;

COMMIT;
