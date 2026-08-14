-- ═══════════════════════════════════════════════════════════════════════════
-- 044_fleet_partner_vendor_fields.sql — fleet partners become ordinary vendors
--
-- MarketVehicles.tsx carried a documented refusal to move its vendor CRUD to
-- PostgreSQL: a fleet partner has an agency name, a subscription plan, a
-- vehicle limit and portal feature flags, and `vendors` had a column for none
-- of them. The refusal came with a stated expiry — "safe only while PostgreSQL
-- `vendors` contains ZERO agency rows" — and it was still true when checked
-- (11 Fuel Pump, 2 Spare Parts, 5 untyped, no FLEET PARTNER).
--
-- It was about to stop being true. KycApprovals already creates approved fleet
-- partners through /masters/vendors with vendor_type 'FLEET PARTNER', so the
-- first approval would have produced a partner in `vendors` while
-- MarketVehicles kept editing its own Firestore copy — two records for one
-- agency, diverging silently. Removing Firestore forces the question, and the
-- answer is the one 026 already chose for the customer side: a portal party is
-- the same party with extra provenance, so it gets columns here rather than a
-- twin table with its own ledger and its own dedup problem.
--
-- `agency_name` is deliberately NOT added — an agency's name is its vendor_name.
-- A second name column is how two screens end up disagreeing about what a
-- party is called.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS owner_name        text,
  ADD COLUMN IF NOT EXISTS email             text,
  ADD COLUMN IF NOT EXISTS pan_no            text,
  ADD COLUMN IF NOT EXISTS payment_terms     text,
  ADD COLUMN IF NOT EXISTS portal_access     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_plan text NOT NULL DEFAULT 'FREE'
    CHECK (subscription_plan IN ('FREE','SILVER','GOLD','PLATINUM')),
  -- 0 means "no ceiling"; the screen's plans map to 2 / 10 / 50 / 0.
  ADD COLUMN IF NOT EXISTS max_vehicle_limit smallint NOT NULL DEFAULT 2
    CHECK (max_vehicle_limit >= 0),
  -- Same shape and same reasoning as customers.portal_features (026): a flag
  -- set is configuration, and adding a feature toggle should not need DDL.
  ADD COLUMN IF NOT EXISTS portal_features   jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The market_vehicles → vendors link can now be made by name for the rows the
-- screen creates, so a partner's trucks and its ledger reach the same party.
CREATE INDEX IF NOT EXISTS idx_vendors_type ON vendors (vendor_type);

COMMIT;
