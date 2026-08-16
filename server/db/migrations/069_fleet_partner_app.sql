-- ═══════════════════════════════════════════════════════════════════════════
-- 069_fleet_partner_app.sql — what the vendor app needs that did not exist
--
-- market_vehicles already models a third-party truck and already defaults to
-- 'PENDING APPROVAL', which is exactly the requirement. Its drivers, though, are
-- two loose text columns on the vehicle row — so a partner with four trucks and
-- one driver has that driver typed four times, and there is nowhere to put his
-- licence, its expiry, or the fact that the office has not approved him yet.
--
-- market_drivers is separate from `drivers` for the same reason market_vehicles
-- is separate from `vehicles`: these are people the firm does not employ and
-- does not run compliance on. Folding them together would put third-party
-- drivers into the company khata, the shortage-recovery list and the licence
-- expiry alerts that stop OUR trucks.
--
-- BLIND BIDDING IS ENFORCED HERE TOO, not only in the route. One PENDING bid per
-- vendor per load: without it a partner can submit five bids and use the
-- responses to triangulate what the others offered, which is the exact thing
-- blind bidding exists to prevent.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS market_drivers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id      uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  mobile         text,
  licence_no     text,
  licence_expiry date,
  -- Same masked-at-rest rule as `drivers` (migration 067). A third party's
  -- national ID is no less sensitive for belonging to somebody else's employee.
  aadhaar_hash   text,
  aadhaar_last4  text,
  photo_url      text,
  licence_photo_url text,

  system_status  text NOT NULL DEFAULT 'PENDING APPROVAL'
                 CHECK (system_status IN ('System Active','PENDING APPROVAL','BLOCKED','REJECTED')),
  reject_reason  text,
  approved_by    uuid,
  approved_at    timestamptz,
  submitted_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_drivers_vendor_idx ON market_drivers (vendor_id, system_status);
CREATE UNIQUE INDEX IF NOT EXISTS market_drivers_mobile_uq
  ON market_drivers (vendor_id, mobile) WHERE mobile IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS market_drivers_aadhaar_uq
  ON market_drivers (aadhaar_hash) WHERE aadhaar_hash IS NOT NULL;

CREATE TRIGGER market_drivers_touch BEFORE UPDATE ON market_drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Never twelve consecutive digits, same backstop as drivers.
ALTER TABLE market_drivers DROP CONSTRAINT IF EXISTS market_drivers_no_plaintext_aadhaar;
ALTER TABLE market_drivers ADD CONSTRAINT market_drivers_no_plaintext_aadhaar CHECK (
  aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'
);

-- ── link a market vehicle to a market driver ───────────────────────────────
ALTER TABLE market_vehicles
  ADD COLUMN IF NOT EXISTS market_driver_id uuid REFERENCES market_drivers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_by     uuid,
  ADD COLUMN IF NOT EXISTS reject_reason    text;

-- ── BLIND BIDDING ──────────────────────────────────────────────────────────
-- One live bid per vendor per load. A vendor revising an offer withdraws the
-- old one first, which is a decision they take rather than a fifth quote in the
-- pile the office has to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bazaar_bid_one_live_per_vendor
  ON bazaar_bids (load_id, vendor_id) WHERE status = 'PENDING' AND vendor_id IS NOT NULL;

-- Where the office wants the load to land. Vendors must not see it — that is
-- what turns a blind auction into a game of "match the number".
COMMENT ON COLUMN bazaar_loads.target_rate IS
  'The office target. NEVER selected on a vendor-facing route (portal_modules vend.bazaar.target).';

-- Who has bid, without saying what they bid. The count is public — knowing a
-- load is contested is fair and useful — while every amount stays private.
CREATE OR REPLACE VIEW v_bazaar_load_feed AS
  SELECT l.id, l.load_id, l.customer_name, l.origin, l.destination, l.distance_km,
         l.material, l.weight, l.vehicle_type, l.rate_type, l.loading_date,
         l.toll_amount, l.status, l.created_at,
         (SELECT count(*) FROM bazaar_bids b
           WHERE b.load_id = l.load_id AND b.status = 'PENDING')::int AS bid_count
    FROM bazaar_loads l;

COMMENT ON VIEW v_bazaar_load_feed IS
  'Vendor-safe load feed: no target_rate, no bid amounts, only how many have bid.';

COMMIT;
