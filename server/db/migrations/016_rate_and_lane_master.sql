-- ═══════════════════════════════════════════════════════════════════════════
-- 016_rate_and_lane_master.sql — rate card and lane distances, from real bills
--
-- The ERP could never reproduce IOCL's freight because it was missing both
-- halves of the formula:
--
--     IOCL:  gross = rate x RTD x quantity        (verified on 1,276 lines)
--     ERP :  gross = rate x quantity              (RTD absent → 500-700x short)
--
-- and because rtkm_master's distances disagree with what IOCL actually bills
-- (242.400 stored vs 262.8 billed; 618.300 vs 532.3). Fixing the formula alone
-- would have produced confidently wrong numbers.
--
-- Both inputs are already present in the bills, so they are DERIVED rather than
-- typed: iocl_bill_lines now carries rtd and rate, and the views below reduce
-- them to a usable rate card. Deriving beats a hand-maintained master here —
-- IOCL revises rates quarterly on average fuel price, and a table someone has
-- to remember to update is a table that will be stale by the next revision.
--
-- Rate varies by product AND lane, not by date alone: 18 distinct rates appear
-- across Apr–Jul 2026, with Apr–May sharing one set and Jun–Jul another. So the
-- grain is (ship-to, material, effective period) — never date alone.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE iocl_bill_lines
  ADD COLUMN IF NOT EXISTS rtd  numeric(10,3),   -- round-trip distance, km
  ADD COLUMN IF NOT EXISTS rate numeric(14,6);   -- Rs per unit per km

CREATE INDEX IF NOT EXISTS iocl_lines_lane_idx
  ON iocl_bill_lines (ship_to_code, material, line_date DESC)
  WHERE rate IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- V_IOCL_LANE_RATE — the working rate card.
--
-- One row per lane × product, carrying the CURRENT rate and distance plus the
-- evidence behind them. `loads` and `rate_changes` are there so a user can see
-- whether a row rests on 40 bills or on one, before trusting it to price a trip.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_iocl_lane_rate AS
WITH ranked AS (
  SELECT ship_to_code, ship_to_name, material, rate, rtd, line_date,
         row_number() OVER (PARTITION BY ship_to_code, material
                            ORDER BY line_date DESC, line_uid DESC) AS rn
    FROM iocl_bill_lines
   WHERE rate IS NOT NULL AND rtd IS NOT NULL AND rate < 50   -- >50 = layout misread
)
SELECT r.ship_to_code,
       max(r.ship_to_name)                                     AS ship_to_name,
       r.material,
       max(r.rate)    FILTER (WHERE r.rn = 1)                  AS current_rate,
       max(r.rtd)     FILTER (WHERE r.rn = 1)                  AS current_rtd,
       max(r.line_date) FILTER (WHERE r.rn = 1)                AS rate_as_of,
       min(r.line_date)                                        AS first_billed,
       max(r.line_date)                                        AS last_billed,
       count(*)                                                AS loads,
       count(DISTINCT r.rate)                                  AS rate_changes,
       count(DISTINCT r.rtd)                                   AS distinct_rtd,
       round(avg(r.rtd), 3)                                    AS avg_rtd
  FROM ranked r
 GROUP BY r.ship_to_code, r.material;

-- ═══════════════════════════════════════════════════════════════════════════
-- V_IOCL_RATE_HISTORY — when the rate moved, and by how much.
-- Quarterly revision is the stated policy; this is where it can be checked.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_iocl_rate_history AS
SELECT material,
       rate,
       min(line_date)          AS effective_from,
       max(line_date)          AS effective_to,
       count(*)                AS loads,
       count(DISTINCT ship_to_code) AS lanes,
       to_char(min(line_date), 'YYYY') || '-Q' ||
         to_char(EXTRACT(quarter FROM min(line_date)), 'FM9') AS quarter
  FROM iocl_bill_lines
 WHERE rate IS NOT NULL AND rate < 50
 GROUP BY material, rate
 ORDER BY material, min(line_date);

-- ═══════════════════════════════════════════════════════════════════════════
-- V_RTKM_MASTER_VARIANCE — where the ERP's stored distance disagrees with the
-- distance IOCL actually billed. This is the work list for correcting the lane
-- master, ordered by how much money each error moves.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_rtkm_master_variance AS
SELECT t.consignee_name,
       t.rtkm                                   AS erp_rtkm,
       l.current_rtd                            AS iocl_rtd,
       (l.current_rtd - t.rtkm)::numeric(10,3)  AS variance_km,
       l.current_rate,
       count(*)                                 AS trips,
       -- What the difference is worth on the volume already run through it.
       (abs(l.current_rtd - t.rtkm) * l.current_rate * COALESCE(avg(t.loaded_qty), 0)
        * count(*))::numeric(14,2)              AS freight_impact
  FROM trips t
  JOIN v_iocl_lane_rate l
    ON l.ship_to_code = substring(t.consignee_name from '^[0-9]{4,8}')
 WHERE t.rtkm IS NOT NULL AND t.rtkm > 0
   AND abs(l.current_rtd - t.rtkm) > 1
 GROUP BY t.consignee_name, t.rtkm, l.current_rtd, l.current_rate
 ORDER BY 7 DESC;

COMMIT;
