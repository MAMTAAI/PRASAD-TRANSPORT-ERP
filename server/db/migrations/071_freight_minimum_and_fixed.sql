-- 071_freight_minimum_and_fixed.sql
-- ============================================================================
-- CORRECTS 070. LPG carries the distance term after all.
--
-- Migration 070 concluded that LPG was billed on a FLAT per-MT lane rate with no
-- distance in it, and wrote a CHECK constraint forcing basis='PER_UNIT_FLAT' for
-- every LPG row. That was wrong, and the way it was wrong is worth recording.
--
-- The evidence for "flat" came from two lanes -- 86 km and 341 km -- where the
-- per-MT figure was identical across loads of different quantity. But rtd is
-- CONSTANT WITHIN A LANE, so per-MT is necessarily constant there whatever the
-- formula. A fixed-distance artefact was read as a fixed-rate rule.
--
-- Across the full range of LPG lanes, 1075 km to 2864 km, the picture is plain:
--
--     >= 400 km   n=61   rate 3.0067 .. 3.4325   median 3.3135   sd 0.094
--     <  400 km   n=19   rate 3.5040 .. 10.6487  median 4.2304   sd 1.490
--
-- An sd of 0.094 over a 2.7x spread of distances is a distance-proportional
-- rate. So LPG uses the same shape as POL:
--
--     billed = rtkm * rate * qty        (MT for LPG, KL for POL)
--
-- and the wide short-haul band is not a different formula, it is the minimum
-- guarantee / fixed freight regime this migration adds fields for.
--
-- WHAT THE SHORT LANES IMPLY
-- Solving each short lane for the RTKM the long-haul rate would need:
--     86 km  -> 276 km      341 km -> 435 km
--     344 km -> 364 km      391 km -> 483 km
-- Every one bills as though it ran further than it did. The ratios are not a
-- single number, so these are per-lane contract minimums, not one global floor.
-- The fields are seeded where derivable and left NULL where they are not; a
-- guessed minimum is worse than an absent one, because it silently changes a
-- freight figure that would otherwise be obviously missing.
-- ============================================================================

ALTER TABLE master_iocl_rates
  ADD COLUMN IF NOT EXISTS is_fixed_freight   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_rtkm_guarantee numeric(10,2),
  ADD COLUMN IF NOT EXISTS fixed_trip_rate    numeric(14,2);

COMMENT ON COLUMN master_iocl_rates.is_fixed_freight IS
  'true = ignore rate and distance, bill fixed_trip_rate as a flat amount for the trip';
COMMENT ON COLUMN master_iocl_rates.min_rtkm_guarantee IS
  'contract floor: bill on GREATEST(actual_rtkm, this). NULL = no floor.';
COMMENT ON COLUMN master_iocl_rates.fixed_trip_rate IS
  'flat freight for the trip when is_fixed_freight; ignored otherwise';

-- A fixed-freight row must actually carry the amount it promises.
ALTER TABLE master_iocl_rates
  DROP CONSTRAINT IF EXISTS rate_fixed_needs_amount;
ALTER TABLE master_iocl_rates
  ADD CONSTRAINT rate_fixed_needs_amount CHECK (
    NOT is_fixed_freight OR (fixed_trip_rate IS NOT NULL AND fixed_trip_rate > 0)
  );

-- ── Replace the constraint that encoded the mistake ─────────────────────────
-- The unit rule survives and is the one that matters: LPG is MT, POL is KL, and
-- mixing them is how a 17 MT load gets billed as 17 KL. The BASIS rule goes:
-- both products are per-unit-per-km.
ALTER TABLE master_iocl_rates DROP CONSTRAINT IF EXISTS rate_unit_matches_category;
ALTER TABLE master_iocl_rates
  ADD CONSTRAINT rate_unit_matches_category CHECK (
    (product_category = 'LPG' AND unit = 'MT') OR
    (product_category = 'POL' AND unit = 'KL')
  );

-- Existing LPG rows were seeded as flat per-MT lane totals. They are not rates;
-- they are amounts. Retire them rather than convert them, and re-derive.
UPDATE master_iocl_rates
   SET status = 'SUPERSEDED',
       notes  = coalesce(notes, '') || ' | superseded by 071: seeded as a flat per-MT total, which was a misreading of fixed-distance lanes'
 WHERE product_category = 'LPG' AND basis = 'PER_UNIT_FLAT';

-- ── Re-seed LPG as per-MT-per-km, from the long-haul band only ──────────────
-- Only lanes at or beyond 400 km, because that is where the rate is clean
-- (sd 0.094). Short lanes are governed by their minimum guarantee and would
-- otherwise contribute an inflated rate to the average.
INSERT INTO master_iocl_rates
  (product_category, unit, basis, ship_to_code, min_rtkm, max_rtkm, rate,
   effective_from, effective_to, source, sample_loads, material_codes, notes)
SELECT 'LPG', 'MT', 'PER_UNIT_KM',
       l.ship_to_code, 0, NULL,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.gross_amt / (l.rtd * l.quantity_kl))::numeric, 6),
       min(l.line_date)::date, NULL,
       'IOCL_BILL_DERIVED', count(*), array_agg(DISTINCT l.material),
       'per-MT-per-km, median of long-haul (>=400 km) lines on this lane'
  FROM iocl_bill_lines l
  JOIN iocl_material_map m ON m.material_code = l.material
 WHERE m.product_category = 'LPG'
   AND l.gross_amt > 0 AND l.quantity_kl > 0 AND l.rtd >= 400
   AND l.ship_to_code IS NOT NULL
 GROUP BY l.ship_to_code
HAVING count(*) >= 3
ON CONFLICT DO NOTHING;

-- Fleet-wide LPG fallback for a lane with no long-haul history of its own.
INSERT INTO master_iocl_rates
  (product_category, unit, basis, ship_to_code, min_rtkm, max_rtkm, rate,
   effective_from, effective_to, source, sample_loads, notes)
VALUES
  ('LPG', 'MT', 'PER_UNIT_KM', NULL, 400, NULL, 3.3135, '2026-04-01', NULL,
   'IOCL_BILL_DERIVED', 61, 'slab fallback: median of all LPG lines >=400 km (sd 0.094)')
ON CONFLICT DO NOTHING;

-- ── Minimum guarantees on the short LPG lanes, where the data implies one ───
-- Derived as (median Rs/MT) / (long-haul rate), i.e. the distance the lane
-- actually bills at. Marked in notes as derived so a real contract figure can
-- replace it without ambiguity.
UPDATE master_iocl_rates r
   SET min_rtkm_guarantee = d.implied_min_rtkm,
       -- PostgreSQL format() takes %s/%I/%L only; %.0f is a C-ism and is a
       -- hard error here, not a silently odd string.
       notes = coalesce(r.notes, '') || ' | min-km ' || round(d.implied_min_rtkm)::text ||
               ' derived from billed Rs/MT vs long-haul rate; replace with the contract figure'
  FROM (
    SELECT l.ship_to_code,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY l.gross_amt / NULLIF(l.quantity_kl, 0)) / 3.3135)::numeric, 2) AS implied_min_rtkm
      FROM iocl_bill_lines l
      JOIN iocl_material_map m ON m.material_code = l.material
     WHERE m.product_category = 'LPG'
       AND l.gross_amt > 0 AND l.quantity_kl > 0 AND l.rtd > 0 AND l.rtd < 400
       AND l.ship_to_code IS NOT NULL
     GROUP BY l.ship_to_code
    HAVING count(*) >= 3
  ) d
 WHERE r.ship_to_code = d.ship_to_code
   AND r.product_category = 'LPG'
   AND r.status = 'ACTIVE'
   AND d.implied_min_rtkm > 0;

COMMENT ON TABLE master_iocl_rates IS
  'Freight rate schedule. BOTH products bill as rtkm * rate * qty -- LPG in MT, POL in KL. Short hauls may carry a min_rtkm_guarantee (bill on GREATEST(actual, floor)) or is_fixed_freight (flat fixed_trip_rate). Derived rows came from iocl_bill_lines and are provisional until reconciled against an actual IOCL bill.';
