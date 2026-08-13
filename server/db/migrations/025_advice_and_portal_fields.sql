-- ═══════════════════════════════════════════════════════════════════════════
-- 025_advice_and_portal_fields.sql — loading advice, and the customer-portal flag
--
-- A loading advice is not a separate document: it is a trip that exists before it
-- is loaded, carrying a reserved LR number so advances issued against it never
-- have to be re-linked when the loading entry is finally made. That design is
-- worth keeping — it is why a pump cash advance given three days early still
-- lands on the right trip — so the advice's own identifiers become trip columns
-- rather than a parallel table.
--
-- sync_to_customer_portal is the flag Loading Details raises when a trip becomes
-- visible to the customer. Kept as stored state, not derived from status: the
-- office decides when a customer sees a trip, and that decision is not a
-- function of the trip's stage.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS advice_no               text,
  ADD COLUMN IF NOT EXISTS advice_date             date,
  ADD COLUMN IF NOT EXISTS advice_valid_till       date,
  ADD COLUMN IF NOT EXISTS sync_to_customer_portal boolean NOT NULL DEFAULT false;

-- One live advice per number. Partial, because the overwhelming majority of
-- trips have no advice number at all and NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_advice_no
  ON trips (advice_no) WHERE advice_no IS NOT NULL;

-- The advice register lists PENDING trips newest first.
CREATE INDEX IF NOT EXISTS idx_trips_advice_open
  ON trips (advice_date DESC) WHERE advice_no IS NOT NULL;

COMMIT;
