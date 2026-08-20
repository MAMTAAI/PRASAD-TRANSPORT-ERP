-- 103_trip_plant_reported_at.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The column the detention bill has always been asking for.
--
-- src/MonthlyBilling.tsx computes the AADHAR GREEN detention charge as
--     detention start = plant_reported_at + free_days      (default 4)
--     days            = unloading_date - start, INCLUSIVE of both ends
-- and reads it as `t.plant_reported_at`. That column has never existed on
-- trips, so every render silently took the fallback branch, `loading_date + 1`.
--
-- Loading date + 1 is not a reporting time; it is a guess with travel time
-- folded into it, and it bills as detention. Measured against the owner's four
-- signed AADHAR bills it overstates badly -- June 2026 is the clean test, all
-- 13 loads carry an unloading date, and the fallback yields Rs 1,20,000 against
-- a signed Rs 45,000. April yields Rs 80,000 against Rs 67,500.
--
-- So the column is added and left NULL. NULL means "the driver's plant stamp
-- was never captured", which is the truth for every historical trip, and the
-- billing screen must show that rather than invent a number -- an invented
-- detention day is an invoice line the customer will reject and an entry TARA
-- cannot reverse cleanly.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS plant_reported_at timestamptz;

COMMENT ON COLUMN trips.plant_reported_at IS
  'Gate-in / reporting stamp at the loading plant. Detention accrues from this + free_days, not from loading_date. NULL = not captured; detention must not be computed for the trip.';

-- Partial: the detention run only ever asks for the rows that HAVE a stamp.
CREATE INDEX IF NOT EXISTS trips_plant_reported_at_idx
    ON trips (plant_reported_at) WHERE plant_reported_at IS NOT NULL;
