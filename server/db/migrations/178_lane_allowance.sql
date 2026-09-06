-- ═══════════════════════════════════════════════════════════════════════════
-- 178 — THE LANE ALLOWANCE, RESOLVED ONCE AND STORED ON THE TRIP
--
-- Owner, 6-Sep-2026: "Trip Management par auto fixed HSD and cash show nahi ho
-- rahi hai." The audit found three layers under that one symptom.
--
-- 1. TRIP CREATION NEVER STORED THE TARGET. ops.routes.js inserts only the
--    fields the browser sent; nothing ever derived fixed_hsd / fixed_cash from
--    rtkm_master. 458 of 1,042 trips carry them, and ZERO of the six currently
--    open trips do.
--
-- 2. THE SCREEN PAPERED OVER IT WITH A CLIENT-SIDE GUESS. TripManagment.tsx
--    called findRoute(consignee_name) and fuzzy-matched the FIRST master row
--    with a similar consignee. That is not a lane. A consignee is served from
--    several depots, and the allowance is a property of the DEPOT→CONSIGNEE
--    pair, not of the consignee:
--
--      LPG BP NORTH GUWAHATI (7B03)   6 lanes, 6 depots,  30 L .. 690 L,
--                                                    Rs 2,000 .. Rs 10,000
--      LPG BP SARPARA (7B02)          5 lanes, 5 depots, 100 L .. 700 L
--
--    Picking the first match could authorise 690 L on a lane entitled to 30 L.
--    Eight consignees are ambiguous this way today.
--
-- 3. THE SERVER AND THE SCREEN DISAGREED. driverLedger.js — which feeds the
--    driver app and the settlement — reads trips.fixed_hsd with NO fallback.
--    So the office saw 280 L from the client-side guess while the settlement
--    saw NULL for the same trip. Two answers for one number.
--
-- THE RULE THIS FILE ESTABLISHES: the allowance is resolved from the FULL lane
-- key, ONCE, at trip creation, and STORED on the trip. Every consumer then
-- reads the same number. Where the lane is ambiguous or absent the function
-- returns NOTHING and the target stays NULL — a blank the desk can fill, never
-- a guess. That is the same contract lrPdf.js follows: a plausible invented
-- figure is worse than an obvious blank.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE LANE KEY ══════════════════════════════════════════════════════
-- Master strings carry doubled spaces, leading spaces and depot codes in
-- brackets ("LPG  BP  NORTH  GUWAHATI  (7B03)"), so a raw = comparison finds
-- nothing. This normaliser is what makes the join land at all.
CREATE OR REPLACE FUNCTION lane_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]+', '', 'g'), '');
$$;

COMMENT ON FUNCTION lane_norm(text) IS
  'Lane-key normaliser: upper-case, strip everything but A-Z0-9. The route '
  'master stores "LPG  BP  NORTH  GUWAHATI  (7B03)" with doubled spaces, so an '
  'equality join on the raw text matches nothing.';

-- ═══ 2. RESOLVE ONE LANE, OR NONE ═════════════════════════════════════════
-- Returns a row ONLY when the lane is unambiguous. Two candidates that disagree
-- on the allowance means we do not know the answer, and saying so is the whole
-- point — see the 30 L / 690 L consignee above.
CREATE OR REPLACE FUNCTION lane_allowance(
  p_customer  text,
  p_consignee text,
  p_depot     text DEFAULT NULL,
  p_capacity  text DEFAULT NULL,
  p_item      text DEFAULT NULL
) RETURNS TABLE (
  rtkm_distance  numeric,
  fixed_hsd_qty  numeric,
  fixed_cash_amt numeric,
  toll_amt       numeric,
  lane_id        uuid,
  candidates     int
) LANGUAGE sql STABLE AS $$
  -- Narrow to the lane: consignee is mandatory, and every other key the caller
  -- actually knows narrows it further. A key the caller does NOT have (NULL)
  -- must not exclude rows, or a trip with no depot recorded would match nothing.
  WITH hits AS (
    SELECT r.id, r.rtkm_distance, r.fixed_hsd_qty, r.fixed_cash_amt, r.toll_amt
      FROM rtkm_master r
     WHERE COALESCE(r.status, 'ACTIVE') = 'ACTIVE'
       AND lane_norm(r.consignee_name) = lane_norm(p_consignee)
       AND (lane_norm(p_customer) IS NULL OR lane_norm(r.customer_name)    = lane_norm(p_customer))
       AND (lane_norm(p_depot)    IS NULL OR lane_norm(r.depot_link)       = lane_norm(p_depot))
       AND (lane_norm(p_capacity) IS NULL OR lane_norm(r.vehicle_capacity) = lane_norm(p_capacity))
       AND (lane_norm(p_item)     IS NULL OR lane_norm(r.item_type)        = lane_norm(p_item))
  ), agg AS (
    SELECT count(*)::int AS n,
           count(DISTINCT (fixed_hsd_qty, fixed_cash_amt, rtkm_distance)) AS variants
      FROM hits
  )
  -- One lane, or several that agree on the numbers: answer. Several that
  -- disagree: return nothing and let the desk decide. `candidates` is reported
  -- so a caller can say WHY it got no answer.
  SELECT h.rtkm_distance, h.fixed_hsd_qty, h.fixed_cash_amt, h.toll_amt, h.id, a.n
    FROM hits h CROSS JOIN agg a
   WHERE a.n = 1 OR a.variants = 1
   LIMIT 1;
$$;

COMMENT ON FUNCTION lane_allowance(text, text, text, text, text) IS
  'The HSD/cash allowance for a DEPOT->CONSIGNEE lane. Returns no row when the '
  'lane is unknown OR when several lanes disagree - a blank the desk can fill '
  'beats a guessed allowance, because the same consignee runs 30 L and 690 L '
  'lanes from different depots.';

-- ═══ 3. WHICH LANES CANNOT BE RESOLVED ════════════════════════════════════
-- The desk needs to see these rather than discover them one trip at a time.
CREATE OR REPLACE VIEW v_ambiguous_lanes AS
SELECT consignee_name,
       count(*)                         AS lanes,
       count(DISTINCT depot_link)       AS depots,
       min(fixed_hsd_qty)               AS min_hsd,
       max(fixed_hsd_qty)               AS max_hsd,
       min(fixed_cash_amt)              AS min_cash,
       max(fixed_cash_amt)              AS max_cash
  FROM rtkm_master
 WHERE COALESCE(status, 'ACTIVE') = 'ACTIVE'
 GROUP BY consignee_name
HAVING count(*) > 1
   AND (max(fixed_hsd_qty)  IS DISTINCT FROM min(fixed_hsd_qty)
     OR max(fixed_cash_amt) IS DISTINCT FROM min(fixed_cash_amt));

COMMENT ON VIEW v_ambiguous_lanes IS
  'Consignees served by more than one lane whose allowances disagree. A trip to '
  'one of these cannot have its target derived automatically - the depot must '
  'be recorded on the trip, or the desk sets the target by hand.';

-- ═══ 4. HELP THE JOIN ═════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS rtkm_master_lane_idx
  ON rtkm_master (lane_norm(consignee_name), lane_norm(customer_name));

-- ═══ 5. THE SLIP NO LONGER NEEDS A RATE AT ISSUE TIME ═════════════════════
-- Owner, 6-Sep-2026: "hamesha HSD ka rate change hoti hai aur system ko rate us
-- time pata nahi hoti - amount ko hata dijiye; jab pump ka bill aaye to rate
-- auto update hogi."
--
-- That second half ALREADY WORKS: queues.routes.js sets rate and amount when a
-- slip reaches BILLED_VERIFIED against the pump's bill. What was wrong is that
-- the slip refused to be created without a rate in the first place, so the desk
-- typed a guess and the guessed amount became the expense until the bill
-- arrived. NULL is the honest value for a price nobody knows yet.
COMMENT ON COLUMN fuel_entries.rate IS
  'Rs/litre. NULL until the pump bill arrives - the rate is not known when the '
  'slip is issued. queues.routes.js fills it on BILLED_VERIFIED.';
COMMENT ON COLUMN fuel_entries.amount IS
  'Rs value of the fuel. NULL while rate is NULL: an amount computed from a '
  'guessed rate is a wrong expense sitting in the books until the bill lands.';
