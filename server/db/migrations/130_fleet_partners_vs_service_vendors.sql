-- ═══════════════════════════════════════════════════════════════════════════
-- 130_fleet_partners_vs_service_vendors.sql — two kinds of "vendor"
--
-- Owner's rule (2026-09-02): a FLEET PARTNER supplies market trucks and lives
-- in the Load Bazaar, market vehicles and market-fleet payables; a SERVICE
-- VENDOR supplies goods and services to the own fleet — fuel pumps, tyre
-- shops, spares, repairs — and lives in operational expenses. One `vendors`
-- table has carried both under one word. Today every one of the 18 rows is a
-- service vendor (11 fuel pumps, 2 spare-parts, 5 untyped service centres);
-- no fleet partner exists yet.
--
--   vendor_kind          SERVICE | FLEET_PARTNER, derived from vendor_type
--                        when that says "fleet partner" (the Market Vehicle
--                        screen has always written 'FLEET PARTNER' there),
--                        stamped by the bazaar KYC approval, never downgraded
--                        by a later edit of vendor_type.
--   expense_approvals    gains vendor_id (the party, not just its name) and
--                        file_key, so a bill a service vendor uploads from
--                        its own portal lands STRAIGHT in the Expenses queue
--                        with its PDF attached — no second queue in between.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS vendor_kind text NOT NULL DEFAULT 'SERVICE'
    CHECK (vendor_kind IN ('SERVICE', 'FLEET_PARTNER'));

UPDATE vendors
   SET vendor_kind = 'FLEET_PARTNER'
 WHERE vendor_kind <> 'FLEET_PARTNER'
   AND (vendor_type ~* 'fleet\s*_?partner|transporter'
        OR id IN (SELECT vendor_id FROM market_vehicles WHERE vendor_id IS NOT NULL)
        OR id IN (SELECT vendor_id FROM bazaar_bids WHERE vendor_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_vendors_kind ON vendors (vendor_kind);

CREATE OR REPLACE FUNCTION vendors_kind_from_type() RETURNS trigger AS $$
BEGIN
  IF NEW.vendor_type ~* 'fleet\s*_?partner|transporter' THEN
    NEW.vendor_kind := 'FLEET_PARTNER';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendors_kind_from_type ON vendors;
CREATE TRIGGER vendors_kind_from_type
  BEFORE INSERT OR UPDATE OF vendor_type ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendors_kind_from_type();

ALTER TABLE expense_approvals
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_key  text;

CREATE INDEX IF NOT EXISTS idx_expense_approvals_vendor
  ON expense_approvals (vendor_id, created_at DESC) WHERE vendor_id IS NOT NULL;

COMMIT;
