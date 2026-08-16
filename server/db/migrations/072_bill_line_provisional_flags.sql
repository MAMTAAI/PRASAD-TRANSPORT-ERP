-- 072_bill_line_provisional_flags.sql
-- ============================================================================
-- Carry the lines that could not be priced, instead of dropping them.
--
-- Of 879 trips in the 01-04 .. 16-08 window, 52 cannot be priced: 33 carry
-- product_type 'Other' so no rate family applies, and 18 have no RTKM so the
-- per-km formula has nothing to multiply. Dropping them would silently shrink
-- the bill and leave 52 delivered loads invisible -- the customer would never
-- be invoiced for work that was done, and nobody would notice, because a
-- missing line looks exactly like a line that was never meant to be there.
--
-- So they go on the invoice at zero, flagged, and the flag is what makes them
-- findable. A zero line that says WHY it is zero is an action item. A zero line
-- with no explanation is a rounding error somebody will eventually delete.
-- ============================================================================

ALTER TABLE company_bill_trips
  ADD COLUMN IF NOT EXISTS provisional           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_rate_required  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pricing_note          text;

COMMENT ON COLUMN company_bill_trips.provisional IS
  'freight on this line is an estimate from the rate engine, not an agreed figure; reconcile against the IOCL bill';
COMMENT ON COLUMN company_bill_trips.manual_rate_required IS
  'the rate engine could not price this line at all -- it is on the invoice at zero and needs a human rate';
COMMENT ON COLUMN company_bill_trips.pricing_note IS
  'why: which rule applied, or which input was missing';

-- Finding the lines that still need a human is the whole point of the flags,
-- so make it cheap.
CREATE INDEX IF NOT EXISTS idx_bill_trips_need_rate
  ON company_bill_trips (bill_id) WHERE manual_rate_required;

-- A line that needs a manual rate must not be silently carrying a number: if
-- somebody prices it, they clear the flag in the same statement.
ALTER TABLE company_bill_trips DROP CONSTRAINT IF EXISTS bill_trip_manual_rate_is_zero;
ALTER TABLE company_bill_trips
  ADD CONSTRAINT bill_trip_manual_rate_is_zero CHECK (
    NOT manual_rate_required OR coalesce(gross_freight, 0) = 0
  );
