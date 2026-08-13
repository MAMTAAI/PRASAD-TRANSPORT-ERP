-- ═══════════════════════════════════════════════════════════════════════════
-- 024_ops_cluster_fields.sql — driver-app submissions, and driver settlements
--
-- Two additions the trip screens need before they can leave Firestore.
--
-- 1. DRIVER-APP SUBMISSION COLUMNS on trips. The driver app posts the quantity
--    it measured and the office approves it; until then the two figures must
--    coexist. Firestore held driver_loaded_qty / driver_unloaded_qty alongside
--    the approved loaded_qty / unloaded_qty, and Unloading Details' whole
--    "pending approval" queue is the difference between them. Collapsing them
--    into one column would destroy the approval step.
--
-- 2. DRIVER_SETTLEMENTS — a genuinely different thing from trip_settlements,
--    which happens to have had the same name in Firestore.
--
--      trip_settlements   TARA's freight settlement: one trip, one voucher,
--                         written only when the ledger balances.
--      driver_settlements this table: a period reconciliation with ONE DRIVER
--                         across MANY trips — bhatta earned, cash advanced,
--                         HSD, extra expenses, and a net balance that may be
--                         carried forward to the next settlement.
--
--    Conflating them would have put a multi-trip driver reconciliation into a
--    table whose voucher_id is NOT NULL and whose grain is a single trip.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Driver-app submissions awaiting office approval ──────────────────────
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS driver_loaded_qty       numeric(14,3),
  ADD COLUMN IF NOT EXISTS driver_unloaded_qty     numeric(14,3),
  ADD COLUMN IF NOT EXISTS driver_loading_photo    text,
  ADD COLUMN IF NOT EXISTS driver_unloading_photo  text,
  -- Provenance of the freight figure: 'billing_inline', 'ai_company_pdf',
  -- 'lane_rate'… Worth keeping, because a rate someone typed and a rate derived
  -- from a paid bill do not deserve equal trust.
  ADD COLUMN IF NOT EXISTS freight_set_by          text,
  ADD COLUMN IF NOT EXISTS settlement_status       text,
  ADD COLUMN IF NOT EXISTS settlement_no           text,
  ADD COLUMN IF NOT EXISTS settled_at              timestamptz;

CREATE INDEX IF NOT EXISTS idx_trips_driver_pending
  ON trips (office_approved_unloading)
  WHERE driver_unloaded_qty IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trips_settlement_no
  ON trips (settlement_no) WHERE settlement_no IS NOT NULL;

-- ── 2. Driver settlements (bhatta / cash reconciliation) ────────────────────
CREATE TABLE IF NOT EXISTS driver_settlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  settlement_no text NOT NULL UNIQUE,
  -- POSTED puts the earned side into the driver's account now. CARRY_FORWARD
  -- posts nothing and leaves the balance to roll into the next settlement, which
  -- is why status and mode are separate: an OPEN carry-forward is still live.
  mode          text NOT NULL CHECK (mode IN ('POSTED','CARRY_FORWARD')),
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','CLOSED','CONSUMED')),
  consumed_by   text,                       -- settlement_no that absorbed this one
  driver_id     uuid REFERENCES drivers(id),
  driver_name   text NOT NULL,
  vehicle_no    text,
  from_date     date,
  to_date       date,
  trip_count    int NOT NULL DEFAULT 0,
  total_cash      numeric(14,2) NOT NULL DEFAULT 0,
  total_hsd_amt   numeric(14,2) NOT NULL DEFAULT 0,
  total_hsd_ltr   numeric(14,3) NOT NULL DEFAULT 0,
  total_allowance numeric(14,2) NOT NULL DEFAULT 0,
  total_extra     numeric(14,2) NOT NULL DEFAULT 0,
  total_freight   numeric(14,2) NOT NULL DEFAULT 0,
  earned_total    numeric(14,2) NOT NULL DEFAULT 0,
  -- Positive = payable to the driver, negative = recoverable from them. Signed
  -- deliberately: an unsigned magnitude plus a direction flag is how these get
  -- posted the wrong way round.
  net_balance     numeric(14,2) NOT NULL DEFAULT 0,
  include_hsd_in_recovery boolean NOT NULL DEFAULT false,
  extra_expenses  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The JOURNAL voucher TARA posts for the earned side, when mode = POSTED.
  voucher_id    uuid,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_stl_driver ON driver_settlements (driver_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_stl_open   ON driver_settlements (driver_name) WHERE status = 'OPEN';

-- Which trips a settlement covered. A link table rather than a uuid[] so
-- "is this trip already settled" is an index lookup, not an array scan.
CREATE TABLE IF NOT EXISTS driver_settlement_trips (
  settlement_id uuid NOT NULL REFERENCES driver_settlements(id) ON DELETE CASCADE,
  trip_id       uuid NOT NULL REFERENCES trips(id),
  PRIMARY KEY (settlement_id, trip_id)
);
CREATE INDEX IF NOT EXISTS idx_driver_stl_trips_trip ON driver_settlement_trips (trip_id);

-- ── 3. SALARY_CREDIT is a real driver transaction type ──────────────────────
-- The settlement credits the driver the bhatta they earned. The existing data
-- carries ADVANCE_GIVEN / PAYMENT_GIVEN / FINAL_PAYMENT / SHORTAGE_RECOVERY /
-- FUEL_EXPENSE; there is no CHECK constraint on the column, so this is a comment
-- rather than an alteration — recorded here so the vocabulary stays documented
-- in one place.
COMMENT ON COLUMN driver_transactions.txn_type IS
  'ADVANCE_GIVEN | PAYMENT_GIVEN | FINAL_PAYMENT | SHORTAGE_RECOVERY | FUEL_EXPENSE | SALARY_CREDIT';

COMMIT;
