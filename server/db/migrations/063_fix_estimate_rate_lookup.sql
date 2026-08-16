-- ═══════════════════════════════════════════════════════════════════════════
-- 063_fix_estimate_rate_lookup.sql — estimate_trip_freight named columns that
-- rate_master does not have
--
-- The lane columns are `source`/`destination`, not `from_location`/`to_location`.
-- PL/pgSQL resolves table names when the function RUNS, not when it is created,
-- so 062 applied cleanly and then failed on the first real trip. Fixed here
-- rather than by editing 062, whose checksum is already recorded as applied.
--
-- While correcting it, the lookup got a second and better source. rate_master
-- holds 4 rows; rtkm_master holds 205, keyed by customer and consignee, and is
-- already the table the ERP uses for per-lane distances. Preference order is
-- now: the trip's own amount, then rate_master by lane, then rtkm_master by
-- consignee, then the vehicle's own realised rupees-per-RTKM. Every branch
-- still records which one it used, because an estimate whose derivation is
-- unrecorded cannot be argued with when the invoice disagrees.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION estimate_trip_freight(p_trip_id uuid)
  RETURNS TABLE (amount numeric, basis text, detail jsonb)
  LANGUAGE plpgsql STABLE AS $$
DECLARE t record; v_rate numeric; v_avg numeric; v_dist numeric;
BEGIN
  SELECT tr.id, tr.vehicle_no, tr.rtkm, tr.loaded_qty, tr.billed_amount,
         tr.freight_amount, tr.loading_point, tr.consignee_name, tr.customer_name,
         COALESCE(tr.unloading_location, tr.consignee_name) AS dest
    INTO t FROM trips tr WHERE tr.id = p_trip_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::numeric, 'NO_TRIP', NULL::jsonb; RETURN;
  END IF;

  -- 1. Someone already entered the real figure.
  IF COALESCE(NULLIF(t.billed_amount, 0), t.freight_amount, 0) > 0 THEN
    RETURN QUERY SELECT COALESCE(NULLIF(t.billed_amount,0), t.freight_amount)::numeric,
                        'ACTUAL_ON_TRIP',
                        jsonb_build_object('billed_amount', t.billed_amount,
                                           'freight_amount', t.freight_amount);
    RETURN;
  END IF;

  -- 2. An active lane rate.
  SELECT rm.rate INTO v_rate
    FROM rate_master rm
   WHERE COALESCE(rm.status,'ACTIVE') = 'ACTIVE'
     AND lower(btrim(COALESCE(rm.source,''))) = lower(btrim(COALESCE(t.loading_point,'')))
     AND lower(btrim(COALESCE(rm.destination,''))) = lower(btrim(COALESCE(t.dest,'')))
     AND (rm.valid_from IS NULL OR rm.valid_from <= CURRENT_DATE)
     AND (rm.valid_to   IS NULL OR rm.valid_to   >= CURRENT_DATE)
   ORDER BY rm.updated_at DESC NULLS LAST LIMIT 1;

  IF v_rate IS NOT NULL AND COALESCE(t.loaded_qty,0) > 0 THEN
    RETURN QUERY SELECT round(v_rate * t.loaded_qty, 2), 'RATE_MASTER_X_QTY',
                        jsonb_build_object('rate', v_rate, 'qty', t.loaded_qty,
                          'lane', COALESCE(t.loading_point,'?') || ' -> ' || COALESCE(t.dest,'?'));
    RETURN;
  END IF;

  -- 3. rtkm_master: 205 lanes keyed by consignee. Gives a distance, which the
  --    vehicle's realised rate-per-km can then price.
  SELECT km.rtkm_distance INTO v_dist
    FROM rtkm_master km
   WHERE COALESCE(km.status,'ACTIVE') = 'ACTIVE'
     AND lower(btrim(COALESCE(km.consignee_name,''))) = lower(btrim(COALESCE(t.consignee_name,'')))
     AND (t.customer_name IS NULL
          OR lower(btrim(COALESCE(km.customer_name,''))) = lower(btrim(t.customer_name)))
   ORDER BY km.updated_at DESC NULLS LAST LIMIT 1;

  SELECT sum(COALESCE(NULLIF(x.billed_amount,0), x.freight_amount, 0)) / NULLIF(sum(x.rtkm), 0)
    INTO v_avg
    FROM trips x
   WHERE x.vehicle_no = t.vehicle_no AND x.rtkm > 0
     AND COALESCE(NULLIF(x.billed_amount,0), x.freight_amount, 0) > 0;

  -- Fleet-wide average as the last resort before giving up. Weaker than the
  -- vehicle's own history, so it is labelled differently and never silently
  -- substituted for it.
  IF v_avg IS NULL THEN
    SELECT sum(COALESCE(NULLIF(x.billed_amount,0), x.freight_amount, 0)) / NULLIF(sum(x.rtkm), 0)
      INTO v_avg FROM trips x
     WHERE x.rtkm > 0 AND COALESCE(NULLIF(x.billed_amount,0), x.freight_amount, 0) > 0;

    IF v_avg IS NOT NULL AND COALESCE(v_dist, t.rtkm, 0) > 0 THEN
      RETURN QUERY SELECT round(v_avg * COALESCE(v_dist, t.rtkm), 2), 'FLEET_AVG_PER_RTKM',
                          jsonb_build_object('avg_per_rtkm', round(v_avg,4),
                            'km', COALESCE(v_dist, t.rtkm),
                            'km_source', CASE WHEN v_dist IS NOT NULL THEN 'rtkm_master' ELSE 'trip.rtkm' END,
                            'caveat', 'fleet-wide average; this vehicle has no billed history');
      RETURN;
    END IF;
  ELSIF COALESCE(v_dist, t.rtkm, 0) > 0 THEN
    RETURN QUERY SELECT round(v_avg * COALESCE(v_dist, t.rtkm), 2), 'VEHICLE_AVG_PER_RTKM',
                        jsonb_build_object('avg_per_rtkm', round(v_avg,4),
                          'km', COALESCE(v_dist, t.rtkm),
                          'km_source', CASE WHEN v_dist IS NOT NULL THEN 'rtkm_master' ELSE 'trip.rtkm' END,
                          'vehicle', t.vehicle_no);
    RETURN;
  END IF;

  RETURN QUERY SELECT 0::numeric, 'NO_BASIS',
                      jsonb_build_object('reason',
                        'no billed amount, no active lane rate, no rtkm_master lane, and no '
                        'billed history to average a rate from');
END $$;

COMMIT;
