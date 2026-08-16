-- 070_master_iocl_rates.sql
-- ============================================================================
-- The freight rate schedule, and the two formulas it drives.
--
-- Both were derived from 1,157 lines parsed off real IOCL transportation bills
-- (iocl_bill_lines), not from a specification. They are not the same formula,
-- and that is the single most important thing in this file:
--
--   POL   HSD / MS / ATF, billed in KL, rate is PER KL PER KM
--         gross = rtkm * rate * qty_kl
--         Verified exactly (within Rs 1) on 615 of 1,061 POL lines.
--
--   LPG   bulk gas, billed in MT, rate is A FLAT PER-MT LANE RATE
--         gross = rate * qty_mt          <- NO distance term
--         Verified on 80 of 80 LPG lines. At rtd 341 the per-MT figure sits on
--         exactly 1442.56 or 1486.70 across loads of differing quantity: two
--         revisions of one lane rate, not a per-km calculation.
--
-- Applying the POL formula to LPG would multiply a 17 MT load by 341 km and
-- bill about a hundred times the real figure. The unit column exists to make
-- that impossible rather than merely unlikely.
--
-- WHY THE RATES ARE SLABBED BY DISTANCE
-- The effective rate is not one number. Measured across billed trips:
--     under 100 km   median 7.07   sd 8.55     <- minimum-charge local work
--     100-400 km     median 3.68   sd 1.01
--     400-1000 km    median 2.93   sd 2.14
--     over 1000 km   median 3.31   sd 0.81
-- A single "active rate" would be wrong at both ends of that range.
--
-- WHY EVERY ROW IS PROVISIONAL
-- 441 POL lines do NOT fit the formula, and the misses are large -- 258 lines
-- average 60,074 below it. Until that is understood, a computed freight is an
-- estimate that must be reconciled against the real bill, never a substitute
-- for it. is_provisional defaults true and the reconciler is what clears it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS master_iocl_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'POL' (KL, per-km) | 'LPG' (MT, flat per lane)
  product_category text NOT NULL CHECK (product_category IN ('POL', 'LPG')),
  unit             text NOT NULL CHECK (unit IN ('KL', 'MT')),
  -- PER_UNIT_KM: multiply by rtkm.  PER_UNIT_FLAT: do not.
  basis            text NOT NULL CHECK (basis IN ('PER_UNIT_KM', 'PER_UNIT_FLAT')),

  -- A rate may be pinned to one lane, or apply across a distance slab.
  ship_to_code     text,
  min_rtkm         numeric(10,2) NOT NULL DEFAULT 0,
  max_rtkm         numeric(10,2),                      -- NULL = no upper bound

  rate             numeric(14,6) NOT NULL CHECK (rate > 0),

  effective_from   date NOT NULL,
  effective_to     date,                               -- NULL = still current

  -- Where this number came from, so a derived figure is never mistaken for a
  -- published one. IOCL_CIRCULAR outranks everything when it exists.
  source           text NOT NULL DEFAULT 'IOCL_BILL_DERIVED'
                     CHECK (source IN ('IOCL_CIRCULAR', 'IOCL_BILL_DERIVED', 'MANUAL')),
  sample_loads     integer NOT NULL DEFAULT 0,         -- evidence behind a derived rate
  material_codes   text[],
  notes            text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rate_period_sane CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT rate_slab_sane   CHECK (max_rtkm IS NULL OR max_rtkm > min_rtkm),
  -- The unit and the basis are not independent: LPG is MT and flat, POL is KL
  -- and per-km. Enforced here so no application code has to remember it.
  CONSTRAINT rate_unit_matches_category CHECK (
    (product_category = 'LPG' AND unit = 'MT' AND basis = 'PER_UNIT_FLAT') OR
    (product_category = 'POL' AND unit = 'KL' AND basis = 'PER_UNIT_KM')
  )
);

CREATE INDEX IF NOT EXISTS idx_iocl_rates_lookup
  ON master_iocl_rates (product_category, effective_from DESC, effective_to)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_iocl_rates_lane
  ON master_iocl_rates (ship_to_code, effective_from DESC) WHERE ship_to_code IS NOT NULL;

-- Material code -> product category. Taken from what the bills actually carry:
-- 89000/94000 are the LPG bulk materials; 32000 is ATF; 16730/50700 are the
-- high-volume POL lines.
CREATE TABLE IF NOT EXISTS iocl_material_map (
  material_code    text PRIMARY KEY,
  product_category text NOT NULL CHECK (product_category IN ('POL', 'LPG')),
  product_name     text,
  unit             text NOT NULL CHECK (unit IN ('KL', 'MT'))
);

INSERT INTO iocl_material_map (material_code, product_category, product_name, unit) VALUES
  ('89000', 'LPG', 'LPG Bulk',        'MT'),
  ('94000', 'LPG', 'LPG Bulk',        'MT'),
  ('32000', 'POL', 'JET A-1 (ATF)',   'KL'),
  ('16730', 'POL', 'HSD / EBMS',      'KL'),
  ('50700', 'POL', 'HSD-BSVI',        'KL'),
  ('50800', 'POL', 'HSD',             'KL'),
  ('40000', 'POL', 'MS',              'KL'),
  ('17295', 'POL', 'POL (mixed)',     'KL')
ON CONFLICT (material_code) DO NOTHING;

-- ── Seed from what IOCL actually billed ─────────────────────────────────────
-- Derived, explicitly marked as such, and only where there is evidence: a lane
-- period needs at least three loads before it becomes a rate. Anything thinner
-- is an anecdote and is better left absent, so the resolver falls back to the
-- slab rather than quoting a number that came from one bill line.

-- POL: per-KL-per-km, by lane and revision period.
INSERT INTO master_iocl_rates
  (product_category, unit, basis, ship_to_code, min_rtkm, max_rtkm, rate,
   effective_from, effective_to, source, sample_loads, material_codes, notes)
SELECT 'POL', 'KL', 'PER_UNIT_KM',
       l.ship_to_code, 0, NULL, l.rate,
       min(l.line_date)::date, max(l.line_date)::date,
       'IOCL_BILL_DERIVED', count(*), array_agg(DISTINCT l.material),
       'seeded from iocl_bill_lines'
  FROM iocl_bill_lines l
  JOIN iocl_material_map m ON m.material_code = l.material
 WHERE m.product_category = 'POL'
   AND l.rate > 0 AND l.rate < 50 AND l.rtd > 0 AND l.quantity_kl > 0
   AND l.ship_to_code IS NOT NULL
 GROUP BY l.ship_to_code, l.rate
HAVING count(*) >= 3
ON CONFLICT DO NOTHING;

-- LPG: flat per-MT lane rate. The rate is gross/qty, because the bill's own
-- rate column does not reproduce the gross for these lines.
INSERT INTO master_iocl_rates
  (product_category, unit, basis, ship_to_code, min_rtkm, max_rtkm, rate,
   effective_from, effective_to, source, sample_loads, material_codes, notes)
SELECT 'LPG', 'MT', 'PER_UNIT_FLAT',
       x.ship_to_code, 0, NULL, x.per_mt,
       min(x.line_date)::date, max(x.line_date)::date,
       'IOCL_BILL_DERIVED', count(*), array_agg(DISTINCT x.material),
       'flat per-MT lane rate; gross = rate * MT, no distance term'
  FROM (
    SELECT l.ship_to_code, l.material, l.line_date,
           round((l.gross_amt / NULLIF(l.quantity_kl, 0))::numeric, 2) AS per_mt
      FROM iocl_bill_lines l
      JOIN iocl_material_map m ON m.material_code = l.material
     WHERE m.product_category = 'LPG'
       AND l.gross_amt > 0 AND l.quantity_kl > 0 AND l.ship_to_code IS NOT NULL
  ) x
 WHERE x.per_mt > 0
 GROUP BY x.ship_to_code, x.per_mt
HAVING count(*) >= 3
ON CONFLICT DO NOTHING;

-- Distance-slab fallbacks, for a lane with no history of its own. Medians of
-- what was actually billed, so an unknown lane gets a defensible number rather
-- than nothing. Deliberately marked with the widest evidence and lowest
-- precedence -- a lane rate always wins over a slab.
INSERT INTO master_iocl_rates
  (product_category, unit, basis, ship_to_code, min_rtkm, max_rtkm, rate,
   effective_from, effective_to, source, sample_loads, notes)
VALUES
  ('POL', 'KL', 'PER_UNIT_KM', NULL,    0,  100, 7.0713, '2026-04-01', NULL, 'IOCL_BILL_DERIVED', 260, 'slab fallback: median of billed trips under 100 km (sd 8.55 -- minimum-charge work, treat with suspicion)'),
  ('POL', 'KL', 'PER_UNIT_KM', NULL,  100,  400, 3.6832, '2026-04-01', NULL, 'IOCL_BILL_DERIVED', 143, 'slab fallback: median 100-400 km (sd 1.01)'),
  ('POL', 'KL', 'PER_UNIT_KM', NULL,  400, 1000, 2.9278, '2026-04-01', NULL, 'IOCL_BILL_DERIVED', 144, 'slab fallback: median 400-1000 km (sd 2.14)'),
  ('POL', 'KL', 'PER_UNIT_KM', NULL, 1000, NULL, 3.3135, '2026-04-01', NULL, 'IOCL_BILL_DERIVED',  44, 'slab fallback: median over 1000 km (sd 0.81)')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE master_iocl_rates IS
  'Freight rate schedule. POL is per-KL-per-km (multiply by rtkm); LPG is a flat per-MT lane rate (do NOT multiply by distance). Derived rows came from iocl_bill_lines and are provisional until reconciled against an actual IOCL bill.';
