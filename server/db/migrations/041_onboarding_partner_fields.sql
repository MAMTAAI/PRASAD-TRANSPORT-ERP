-- ═══════════════════════════════════════════════════════════════════════════
-- 041_onboarding_partner_fields.sql — the fleet-partner side of onboarding
--
-- 040 modelled onboarding_applications on the CUSTOMER application, which is
-- the one that had a documented shape. FLEET_PARTNER applications
-- (FleetPartnerPortal) carry two extra fields, and one of them is PII:
--
--   aadhaar_last4   The portal deliberately stores only the last four digits —
--                   the reviewer does not need the full number and the old
--                   Firestore collection was broadly readable. Kept as its own
--                   column, not folded into `documents` jsonb, so that a PII
--                   field stays greppable and can be dropped on request.
--
-- agency_name / owner_name are NOT added: an agency name is the applicant's
-- name and an owner is its contact person, so they map onto corporate_name and
-- contact_person. A second pair of name columns would mean every reader had to
-- know which of the two to check for a given `type`.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE onboarding_applications
  ADD COLUMN IF NOT EXISTS aadhaar_last4 text
    CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$');

COMMENT ON COLUMN onboarding_applications.aadhaar_last4 IS
  'PII (minimised): last 4 digits only, as submitted by the fleet-partner portal.';

COMMIT;
