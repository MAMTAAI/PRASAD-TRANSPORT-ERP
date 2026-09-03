-- 137_fleet_partner_onboarding_vehicles.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- FLEET PARTNER ONBOARDING: PAN, BANK AND TRUCKS WITH THEIR RCs
-- (owner directive, 2026-09-03)
--
--   "A new Fleet Partner MUST submit their PAN Card and Bank Details. During
--    registration (and later in their app) they must be able to add multiple
--    vehicles by uploading their respective RCs. These details must go to the
--    Admin Command Center for verification. Add an Active/Deactivate switch for
--    both the partner account and their individual vehicles."
--
-- The bank columns already exist on onboarding_applications (migration 134) —
-- what changes there is that a FLEET_PARTNER application now REQUIRES them,
-- which is a route rule, not a schema one. What the schema was missing is the
-- trucks: an applicant with five lorries had nowhere to put them until the
-- office had already created the party, so the RCs arrived by WhatsApp and
-- somebody keyed them in twice.
--
-- Vehicles ride on the APPLICATION, not on market_vehicles, until it is
-- approved. A row in market_vehicles is a truck the system may dispatch; a row
-- here is a claim on a form nobody has read yet. Keeping them apart is why the
-- fleet cannot be polluted by an application that is later rejected.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES onboarding_applications(id) ON DELETE CASCADE,
  registration_no  text NOT NULL,
  vehicle_class    text,
  capacity         numeric(10,2),
  -- The RC scan the applicant uploaded with the form. It lands under
  -- up/onboarding/<ticket>/… — a namespace no signed-in party can reach and no
  -- applicant can aim outside of (see /auth/register/upload).
  rc_file_key      text,
  rc_expiry        date,
  -- Set when the office approves: the market_vehicles row this claim became.
  market_vehicle_id uuid REFERENCES market_vehicles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One plate per application. A partner listing the same lorry twice is a
  -- typo, and two rows would become two trucks at approval.
  UNIQUE (application_id, registration_no)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_vehicles_app
  ON onboarding_vehicles (application_id);

-- ── THE VEHICLE ON/OFF SWITCH ────────────────────────────────────────────────
-- market_vehicles.system_status already allows BLOCKED, and every path that
-- dispatches a truck checks for 'System Active' — so the switch itself needs no
-- new column. What was missing is the audit trail the Access Hub keeps for
-- every other party it can turn off: who blocked this truck, when, and why.
ALTER TABLE market_vehicles
  ADD COLUMN IF NOT EXISTS blocked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by     uuid,
  ADD COLUMN IF NOT EXISTS deactivated_reason text;

COMMIT;
