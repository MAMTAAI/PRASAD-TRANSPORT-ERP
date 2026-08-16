-- ═══════════════════════════════════════════════════════════════════════════
-- 062_provisional_billing.sql — accrue the cost when the trip runs, not when
-- the invoice turns up six weeks later
--
-- THE PROBLEM THIS SOLVES IS VISIBLE IN THE CURRENT BOOKS. Santosh Prasad read
-- as a 5.33 lakh liability for months, not because the trips were unprofitable
-- but because the freight had not been billed — the trips existed, the revenue
-- did not, and the P&L showed costs against nothing. The IOCL bills for those
-- trips arrived weeks later. An accrual closes that window: when the truck
-- unloads, an ESTIMATE goes on the provisional ledger, and when the real
-- invoice lands the estimate is cleared and the variance recorded.
--
-- PROVISIONAL ENTRIES ARE NOT LEDGER ENTRIES. They live here, in their own
-- table, and never touch ledger_entries. Two reasons: ledger_entries is
-- append-only, so an estimate posted there could never be corrected when the
-- real figure arrives, only reversed — and an estimate is not a fact, so it has
-- no business in a book that is meant to hold only facts. The P&L reads
-- ledger_entries; a report that wants the accrued view reads v_pnl_with_accrual
-- and says so on its face.
--
-- THE BUNDLE IS THE UNIT OF RECONCILIATION. IOCL bills one truck-load as
-- several product lines, and bills a fortnight at a time. Matching invoice line
-- to trip one-for-one therefore fails on both axes. A bundle groups the trips
-- of one party for one cycle; the incoming invoice is matched to the BUNDLE,
-- and the variance is computed once at that level rather than smeared across
-- lines that were never meant to balance individually.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── cycles ─────────────────────────────────────────────────────────────────
-- Fortnights, because that is how IOCL bills: 1-15 and 16-EOM. Generated as
-- rows rather than computed on the fly so a bundle can point at one.

CREATE TABLE IF NOT EXISTS billing_cycles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_code   text NOT NULL UNIQUE,          -- 2026-07-H1, 2026-07-H2
  period_from  date NOT NULL,
  period_to    date NOT NULL,
  status       text NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','CLOSED','RECONCILED')),
  closed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_cycle_range CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS billing_cycles_range_idx ON billing_cycles (period_from, period_to);

CREATE OR REPLACE FUNCTION cycle_for(d date) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT to_char(d, 'YYYY-MM') || CASE WHEN extract(day FROM d) <= 15 THEN '-H1' ELSE '-H2' END
  $$;

-- Materialise the cycles the existing trips actually fall in, plus the current
-- one, so nothing has to be created by hand before the first accrual runs.
INSERT INTO billing_cycles (cycle_code, period_from, period_to)
SELECT c, f, l FROM (
  SELECT DISTINCT
         cycle_for(d) AS c,
         CASE WHEN extract(day FROM d) <= 15
              THEN date_trunc('month', d)::date
              ELSE (date_trunc('month', d) + interval '15 days')::date END AS f,
         CASE WHEN extract(day FROM d) <= 15
              THEN (date_trunc('month', d) + interval '14 days')::date
              ELSE (date_trunc('month', d) + interval '1 month - 1 day')::date END AS l
    FROM (
      SELECT loading_date AS d FROM trips WHERE loading_date IS NOT NULL
      UNION SELECT CURRENT_DATE
    ) s
) x
ON CONFLICT (cycle_code) DO NOTHING;

-- ── bundles ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trip_bundles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_code   text NOT NULL UNIQUE,
  cycle_id      uuid NOT NULL REFERENCES billing_cycles(id) ON DELETE RESTRICT,
  entity_id     uuid REFERENCES entity_master(id) ON DELETE RESTRICT,
  party_name    text,                       -- kept for bundles whose party has no entity yet
  vendor_code   text,                       -- IOCL's code for us, e.g. 0011043022
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','SEALED','INVOICED','RECONCILED','CLOSED')),
  trip_count    integer NOT NULL DEFAULT 0,
  est_freight   numeric(16,2) NOT NULL DEFAULT 0,
  est_fuel      numeric(16,2) NOT NULL DEFAULT 0,
  est_toll      numeric(16,2) NOT NULL DEFAULT 0,
  actual_freight numeric(16,2),
  variance      numeric(16,2),
  invoice_ref   text,
  reconciled_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_bundles_cycle_idx ON trip_bundles (cycle_id, status);
CREATE INDEX IF NOT EXISTS trip_bundles_entity_idx ON trip_bundles (entity_id);
CREATE TRIGGER trip_bundles_touch BEFORE UPDATE ON trip_bundles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Trip_Bundle_Mapping. A trip belongs to at most ONE bundle — the PK on trip_id
-- is what makes that true, and it is the same guarantee the IOCL reconciler
-- already relies on ("one trip can be settled by one bill group only").
CREATE TABLE IF NOT EXISTS trip_bundle_mapping (
  trip_id     uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  bundle_id   uuid NOT NULL REFERENCES trip_bundles(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  added_by    uuid
);
CREATE INDEX IF NOT EXISTS trip_bundle_mapping_bundle_idx ON trip_bundle_mapping (bundle_id);

-- ── the provisional ledger ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS provisional_trips_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  bundle_id      uuid REFERENCES trip_bundles(id) ON DELETE SET NULL,
  cycle_id       uuid REFERENCES billing_cycles(id) ON DELETE RESTRICT,

  accrued_on     date NOT NULL DEFAULT CURRENT_DATE,
  trigger_event  text NOT NULL DEFAULT 'UNLOAD'
                 CHECK (trigger_event IN ('UNLOAD','CYCLE_END','MANUAL')),

  -- What we think it is worth, and how we arrived at that. `basis` is not
  -- decoration: an estimate whose derivation is unrecorded cannot be argued
  -- with when the real invoice disagrees.
  est_freight    numeric(16,2) NOT NULL DEFAULT 0,
  est_fuel       numeric(16,2) NOT NULL DEFAULT 0,
  est_toll       numeric(16,2) NOT NULL DEFAULT 0,
  basis          text NOT NULL,
  basis_detail   jsonb,

  -- What it turned out to be.
  actual_freight numeric(16,2),
  actual_fuel    numeric(16,2),
  actual_toll    numeric(16,2),
  variance       numeric(16,2)
                 GENERATED ALWAYS AS (COALESCE(actual_freight,0) - est_freight) STORED,

  status         text NOT NULL DEFAULT 'PROVISIONAL'
                 CHECK (status IN ('PROVISIONAL','BUNDLED','RECONCILED','CLEARED','WRITTEN_OFF')),
  cleared_at     timestamptz,
  cleared_by     uuid,
  -- The voucher that carried the FINAL figure into the real ledger. NULL until
  -- reconciliation posts it, and the only link between the two worlds.
  final_voucher_id uuid,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provisional_cleared_shape CHECK (
    (status <> 'CLEARED') OR (cleared_at IS NOT NULL AND actual_freight IS NOT NULL)
  )
);

-- ONE OPEN ACCRUAL PER TRIP. Without this the cycle-end sweep would accrue a
-- second estimate for a trip that already had one at unload, and the accrued
-- P&L would double-count every load that straddled a fortnight boundary.
CREATE UNIQUE INDEX IF NOT EXISTS provisional_one_open_per_trip
  ON provisional_trips_ledger (trip_id)
  WHERE status IN ('PROVISIONAL','BUNDLED','RECONCILED');

CREATE INDEX IF NOT EXISTS provisional_status_idx ON provisional_trips_ledger (status, accrued_on DESC);
CREATE INDEX IF NOT EXISTS provisional_bundle_idx ON provisional_trips_ledger (bundle_id);
CREATE TRIGGER provisional_touch BEFORE UPDATE ON provisional_trips_ledger
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── how an estimate is arrived at ──────────────────────────────────────────
-- Preference order, best evidence first:
--   1. the trip's own billed/freight amount, if someone already entered one
--   2. rate_master for this lane, x quantity
--   3. this vehicle's own realised average rupees-per-RTKM, x this trip's RTKM
-- Anything with no basis at all returns 0 and says so, rather than inventing a
-- number that would look identical to a real one on the accrued P&L.

CREATE OR REPLACE FUNCTION estimate_trip_freight(p_trip_id uuid)
  RETURNS TABLE (amount numeric, basis text, detail jsonb)
  LANGUAGE plpgsql STABLE AS $$
DECLARE t record; v_rate numeric; v_avg numeric;
BEGIN
  SELECT tr.id, tr.vehicle_no, tr.rtkm, tr.loaded_qty, tr.billed_amount,
         tr.freight_amount, tr.loading_point, tr.consignee_name
    INTO t FROM trips tr WHERE tr.id = p_trip_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::numeric, 'NO_TRIP', NULL::jsonb; RETURN;
  END IF;

  IF COALESCE(NULLIF(t.billed_amount, 0), t.freight_amount, 0) > 0 THEN
    RETURN QUERY SELECT COALESCE(NULLIF(t.billed_amount,0), t.freight_amount)::numeric,
                        'ACTUAL_ON_TRIP',
                        jsonb_build_object('billed_amount', t.billed_amount,
                                           'freight_amount', t.freight_amount);
    RETURN;
  END IF;

  SELECT rm.rate INTO v_rate
    FROM rate_master rm
   WHERE rm.status = 'ACTIVE'
     AND lower(btrim(COALESCE(rm.from_location,''))) = lower(btrim(COALESCE(t.loading_point,'')))
     AND lower(btrim(COALESCE(rm.to_location,'')))   = lower(btrim(COALESCE(t.consignee_name,'')))
   ORDER BY rm.updated_at DESC NULLS LAST LIMIT 1;

  IF v_rate IS NOT NULL AND COALESCE(t.loaded_qty,0) > 0 THEN
    RETURN QUERY SELECT round(v_rate * t.loaded_qty, 2), 'RATE_MASTER_X_QTY',
                        jsonb_build_object('rate', v_rate, 'qty', t.loaded_qty,
                                           'lane', COALESCE(t.loading_point,'?') || ' -> ' || COALESCE(t.consignee_name,'?'));
    RETURN;
  END IF;

  SELECT sum(COALESCE(NULLIF(x.billed_amount,0), x.freight_amount, 0)) / NULLIF(sum(x.rtkm), 0)
    INTO v_avg
    FROM trips x
   WHERE x.vehicle_no = t.vehicle_no AND x.rtkm > 0
     AND COALESCE(NULLIF(x.billed_amount,0), x.freight_amount, 0) > 0;

  IF v_avg IS NOT NULL AND COALESCE(t.rtkm,0) > 0 THEN
    RETURN QUERY SELECT round(v_avg * t.rtkm, 2), 'VEHICLE_AVG_PER_RTKM',
                        jsonb_build_object('avg_per_rtkm', round(v_avg,4), 'rtkm', t.rtkm,
                                           'vehicle', t.vehicle_no);
    RETURN;
  END IF;

  RETURN QUERY SELECT 0::numeric, 'NO_BASIS',
                      jsonb_build_object('reason',
                        'no billed amount, no active lane rate, and this vehicle has never '
                        'carried a billed trip with RTKM to average from');
END $$;

-- ── accrue ─────────────────────────────────────────────────────────────────
-- Idempotent: the partial unique index means a second call for a trip that
-- already has an open accrual does nothing rather than doubling it.

CREATE OR REPLACE FUNCTION accrue_trip(p_trip_id uuid, p_event text DEFAULT 'UNLOAD')
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid; e record; v_cycle uuid; v_fuel numeric; v_toll numeric; d date;
BEGIN
  IF EXISTS (SELECT 1 FROM provisional_trips_ledger
              WHERE trip_id = p_trip_id AND status IN ('PROVISIONAL','BUNDLED','RECONCILED')) THEN
    SELECT id INTO v_id FROM provisional_trips_ledger
      WHERE trip_id = p_trip_id AND status IN ('PROVISIONAL','BUNDLED','RECONCILED') LIMIT 1;
    RETURN v_id;
  END IF;

  SELECT * INTO e FROM estimate_trip_freight(p_trip_id);

  SELECT COALESCE(unloading_date, loading_date, CURRENT_DATE) INTO d FROM trips WHERE id = p_trip_id;
  SELECT id INTO v_cycle FROM billing_cycles WHERE cycle_code = cycle_for(d);

  SELECT COALESCE(sum(f.amount), 0) INTO v_fuel FROM fuel_entries f WHERE f.trip_id = p_trip_id;
  SELECT COALESCE(sum(x.amount), 0) INTO v_toll FROM toll_transactions x WHERE x.trip_id = p_trip_id;

  INSERT INTO provisional_trips_ledger
    (trip_id, cycle_id, accrued_on, trigger_event, est_freight, est_fuel, est_toll, basis, basis_detail)
  VALUES (p_trip_id, v_cycle, COALESCE(d, CURRENT_DATE), p_event,
          COALESCE(e.amount,0), v_fuel, v_toll, e.basis, e.detail)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── the accrued view, clearly labelled ─────────────────────────────────────

CREATE OR REPLACE VIEW v_provisional_summary AS
  SELECT p.status,
         count(*)::int                            AS trips,
         sum(p.est_freight)::numeric(16,2)        AS est_freight,
         sum(p.est_fuel)::numeric(16,2)           AS est_fuel,
         sum(p.est_toll)::numeric(16,2)           AS est_toll,
         sum(COALESCE(p.actual_freight,0))::numeric(16,2) AS actual_freight,
         sum(p.variance)::numeric(16,2)           AS variance,
         count(*) FILTER (WHERE p.basis = 'NO_BASIS')::int AS with_no_basis
    FROM provisional_trips_ledger p
   GROUP BY p.status;

COMMENT ON VIEW v_provisional_summary IS
  'Accrued estimates, NOT posted money. The real P&L reads ledger_entries.';

COMMIT;
