-- ═══════════════════════════════════════════════════════════════════════════
-- 159 — Own / Attached / Market: three ways a lorry earns, three sets of books
--
-- ── WHAT THE SETTLEMENT WAS GETTING WRONG ─────────────────────────────────
--
-- Migration 158 counts every lorry the same way: freight in, expenses out, the
-- difference is ours. That is right for a lorry we own and WRONG for the other
-- 16, and it is not a rounding error.
--
--   49 lorries in the master: 33 OWNED, 16 ATTACHED.
--   The attached ones belong to the family — SANDEEP KUMAR PRASAD (11),
--   GAUTAM PRASAD (3), SANTOSH PRASAD (1), PRASAD TRANSPORT (1).
--   In 16–30 June they carried Rs18,66,187 of Rs41,08,389 billed. 45%.
--
-- On an attached lorry the freight is the OWNER'S money. We earn a commission
-- out of it, we deduct TDS on what we pay them, and we recover the diesel and
-- tolls we advanced. Only the commission belongs in our profit. Counting the
-- whole freight overstated one fortnight's income by about Rs18.7 lakh.
--
-- ── THE RATE IS NOT IN THE SYSTEM, AND IS NOT GUESSED HERE ────────────────
--
-- vehicles.commission_pct and .commission_flat exist and are NULL on all 49
-- rows. vehicle_owner_ledger_id is NULL on all 49. So nothing records what we
-- charge or whom we pay.
--
-- This migration builds the place to record it and REFUSES TO INVENT A NUMBER.
-- An attached or market lorry with no term settles to "rate not set" and its
-- commission is NULL, not 0 — because 0 is a claim that we earned nothing, and
-- that claim would post to the books.
--
-- The terms are dated. A fortnight settled in June must keep June's rate when
-- someone renegotiates in September, and vehicles.commission_pct is a single
-- current value with no history and no per-ton basis — which the market
-- vehicles need.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── how a lorry earns ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE fleet_class AS ENUM ('OWN', 'ATTACHED', 'MARKET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ATTACHED and MARKET are paid the same way and differ in who the counterparty
-- is: family/partner against the vehicle master, an outside fleet partner
-- against market_vehicles. Both are resolved here so the settlement never has
-- to ask two tables.
CREATE OR REPLACE FUNCTION vehicle_class(p_vehicle_no text)
RETURNS fleet_class AS $$
DECLARE k text := upper(regexp_replace(COALESCE(p_vehicle_no,''), '[^A-Za-z0-9]', '', 'g'));
        o text;
BEGIN
  IF k = '' THEN RETURN NULL; END IF;
  SELECT ownership::text INTO o FROM vehicles WHERE vehicle_no_norm = k LIMIT 1;
  IF o = 'ATTACHED' THEN RETURN 'ATTACHED'; END IF;
  -- LEASED sits with OWN: we carry its running cost and keep its margin.
  IF o IN ('OWNED', 'LEASED') THEN RETURN 'OWN'; END IF;
  IF EXISTS (SELECT 1 FROM market_vehicles
              WHERE upper(regexp_replace(COALESCE(registration_no,''), '[^A-Za-z0-9]', '', 'g')) = k)
  THEN RETURN 'MARKET'; END IF;
  RETURN NULL;                       -- not in any master: the desk must say
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION vehicle_class(text) IS
  'OWN / ATTACHED / MARKET for a registration in any spelling. NULL means the '
  'lorry is in no master — a settlement must not guess which side it is on.';

-- ── what we charge, and what we withhold ──────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_commission_terms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_key   text NOT NULL,
  vehicle_no    text,
  -- PCT        commission is basis_pct % of the freight
  -- PER_TON    commission is rate_per_unit x tonnes carried
  -- PER_KL     the oil trade measures in kilolitres, and loaded_qty is KL
  -- FLAT_TRIP  a fixed rupee amount per trip
  basis         text NOT NULL CHECK (basis IN ('PCT','PER_TON','PER_KL','FLAT_TRIP')),
  rate          numeric(12,4) NOT NULL CHECK (rate >= 0),
  -- Section 194C: 1% where the owner is an individual/HUF, 2% otherwise, and
  -- NIL against a valid transporter declaration. Stored per lorry because it
  -- follows the owner, not the trip.
  tds_pct       numeric(6,3) NOT NULL DEFAULT 0 CHECK (tds_pct >= 0 AND tds_pct <= 100),
  tds_section   text DEFAULT '194C',
  -- Whether the diesel and tolls we advanced come back out of the owner's
  -- payment. On a family lorry they normally do; on a market hire they may not.
  recover_expenses boolean NOT NULL DEFAULT true,
  owner_name    text,
  owner_ledger_id uuid,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vct_dates_sane CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- One live term per lorry at a time. Two overlapping open terms would make the
-- commission depend on which row the planner happened to reach first.
CREATE UNIQUE INDEX IF NOT EXISTS vct_one_open_per_vehicle
  ON vehicle_commission_terms (vehicle_key) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS vct_vehicle_idx
  ON vehicle_commission_terms (vehicle_key, effective_from DESC);

DROP TRIGGER IF EXISTS vct_touch ON vehicle_commission_terms;
CREATE TRIGGER vct_touch BEFORE UPDATE ON vehicle_commission_terms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE vehicle_commission_terms IS
  'What we charge an attached or market lorry and what we withhold. Dated, so '
  'a fortnight keeps the rate that applied when it ran.';

/** The term in force for a lorry on a date, or nothing. */
CREATE OR REPLACE FUNCTION commission_term(p_vehicle_key text, p_on date)
RETURNS vehicle_commission_terms AS $$
  SELECT * FROM vehicle_commission_terms
   WHERE vehicle_key = p_vehicle_key
     AND effective_from <= p_on
     AND (effective_to IS NULL OR effective_to >= p_on)
   ORDER BY effective_from DESC LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ── the settlement gains its class and its commission ─────────────────────
ALTER TABLE vehicle_fortnight_settlements
  ADD COLUMN IF NOT EXISTS fleet_class    fleet_class,
  ADD COLUMN IF NOT EXISTS owner_name     text,
  ADD COLUMN IF NOT EXISTS company_id     uuid REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_basis text,
  ADD COLUMN IF NOT EXISTS commission_rate  numeric(12,4),
  -- NULL, never 0, when no term exists. Zero is a claim; NULL is the absence
  -- of one, and only NULL can be refused at the posting gate.
  ADD COLUMN IF NOT EXISTS commission_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS tds_pct        numeric(6,3),
  ADD COLUMN IF NOT EXISTS tds_amount     numeric(14,2),
  ADD COLUMN IF NOT EXISTS expenses_recovered numeric(14,2),
  ADD COLUMN IF NOT EXISTS payable_to_owner   numeric(14,2),
  ADD COLUMN IF NOT EXISTS terms_id       uuid REFERENCES vehicle_commission_terms(id) ON DELETE SET NULL;

COMMENT ON COLUMN vehicle_fortnight_settlements.commission_amount IS
  'What WE earned on this lorry. For OWN it is NULL and the whole margin is '
  'ours; for ATTACHED/MARKET it is the only figure that reaches our profit. '
  'NULL on an attached lorry means no rate is on file — not that it is zero.';

-- ── one row per lorry per fortnight, priced by its class ──────────────────
--
-- The arithmetic, said once, here, so the screen and the ledger cannot drift:
--
--   OWN        income  = freight
--              expense = what we spent
--              ours    = income - expense
--
--   ATTACHED   the freight is the OWNER'S. Out of it we keep the commission,
--   / MARKET   withhold TDS on what we pay them, and take back the diesel and
--              tolls we advanced.
--                commission = by basis
--                tds        = tds_pct % of (freight - commission)
--                payable    = freight - commission - tds - expenses recovered
--                ours       = commission          ← the only thing in profit
CREATE OR REPLACE VIEW v_vehicle_fortnight_priced AS
WITH base AS (
  SELECT d.*,
         vehicle_class(d.vehicle_no)                       AS fleet_class,
         (SELECT v.owner_name FROM vehicles v
           WHERE v.vehicle_no_norm = d.vehicle_key LIMIT 1) AS owner_name,
         (SELECT v.company_id FROM vehicles v
           WHERE v.vehicle_no_norm = d.vehicle_key LIMIT 1) AS master_company_id
    FROM v_vehicle_fortnight_draft d
), t AS (
  SELECT b.*, ct.id AS terms_id, ct.basis, ct.rate, ct.tds_pct,
         ct.recover_expenses, ct.owner_ledger_id
    FROM base b
    LEFT JOIN LATERAL commission_term(b.vehicle_key, b.period_to) ct ON true
)
SELECT t.*,
       CASE
         WHEN t.fleet_class = 'OWN' THEN NULL
         WHEN t.basis IS NULL       THEN NULL          -- no rate on file
         WHEN t.basis = 'PCT'       THEN round(t.billed_amount * t.rate / 100.0, 2)
         -- loaded_qty is kilolitres. A tonne rate is applied to the same
         -- quantity only because that is what the trade quotes on; PER_KL is
         -- the honest name for the oil work and PER_TON is kept for hires
         -- quoted that way.
         WHEN t.basis IN ('PER_TON','PER_KL') THEN round(t.loaded_qty * t.rate, 2)
         WHEN t.basis = 'FLAT_TRIP' THEN round(t.trips_count * t.rate, 2)
       END                                                     AS commission_amount
  FROM t;

CREATE OR REPLACE VIEW v_vehicle_fortnight_class AS
SELECT p.*,
       CASE WHEN p.fleet_class = 'OWN' THEN NULL
            WHEN p.commission_amount IS NULL THEN NULL
            ELSE round(GREATEST(p.billed_amount - p.commission_amount, 0)
                       * COALESCE(p.tds_pct, 0) / 100.0, 2) END AS tds_amount,
       CASE WHEN p.fleet_class = 'OWN' THEN NULL
            WHEN COALESCE(p.recover_expenses, true) THEN p.expense_total
            ELSE 0 END::numeric(14,2)                           AS expenses_recovered,
       -- What we owe the lorry's owner once everything is taken out.
       CASE WHEN p.fleet_class = 'OWN' OR p.commission_amount IS NULL THEN NULL
            ELSE round(p.billed_amount
                       - p.commission_amount
                       - round(GREATEST(p.billed_amount - p.commission_amount, 0)
                               * COALESCE(p.tds_pct, 0) / 100.0, 2)
                       - CASE WHEN COALESCE(p.recover_expenses, true)
                              THEN p.expense_total ELSE 0 END, 2) END AS payable_to_owner,
       -- THE NUMBER THAT REACHES OUR PROFIT.
       CASE WHEN p.fleet_class = 'OWN' THEN p.net
            ELSE p.commission_amount END                        AS our_earning,
       (p.fleet_class IN ('ATTACHED','MARKET') AND p.basis IS NULL) AS needs_rate
  FROM v_vehicle_fortnight_priced p;

COMMENT ON VIEW v_vehicle_fortnight_class IS
  'Every lorry-fortnight priced by its class. our_earning is the only figure '
  'that belongs in our profit: the whole margin on an own lorry, the '
  'commission alone on an attached or market one. needs_rate marks the ones '
  'that cannot be settled until somebody records a rate.';

-- ── an owner's whole fleet on one statement ───────────────────────────────
--
-- "Agar kisi vehicle ka owner ka attached/market ka max vehicle ho to ek
-- report me har vehicle ka report aa jaye" — grouped the way IOCL groups
-- theirs, by counterparty then by lorry.
CREATE OR REPLACE VIEW v_owner_fortnight_statement AS
SELECT COALESCE(c.owner_name, '(owner darj nahi)')      AS owner_name,
       c.fleet_class,
       c.period_from,
       c.period_to,
       c.cycle,
       count(*)::int                                     AS lorries,
       sum(c.trips_count)::int                           AS trips,
       sum(c.loaded_qty)::numeric(14,3)                  AS loaded_qty,
       sum(c.billed_amount)::numeric(14,2)               AS freight,
       sum(c.expense_total)::numeric(14,2)               AS expenses,
       sum(c.commission_amount)::numeric(14,2)           AS commission,
       sum(c.tds_amount)::numeric(14,2)                  AS tds,
       sum(c.expenses_recovered)::numeric(14,2)          AS recovered,
       sum(c.payable_to_owner)::numeric(14,2)            AS payable,
       sum(c.our_earning)::numeric(14,2)                 AS our_earning,
       count(*) FILTER (WHERE c.needs_rate)::int         AS without_rate
  FROM v_vehicle_fortnight_class c
 WHERE c.fleet_class IN ('ATTACHED','MARKET')
 GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW v_owner_fortnight_statement IS
  'One statement per vehicle owner per fortnight: every lorry they run for us, '
  'what it carried, our commission, the TDS withheld and what they are owed.';

-- ── the posting gate ──────────────────────────────────────────────────────
--
-- An attached or market settlement may not be approved while its commission is
-- unknown. Guarding in the route alone is not enough: a script, a fix-up SQL
-- or a later screen would walk straight around it, and the row that results
-- claims money moved.
CREATE OR REPLACE FUNCTION vfs_class_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'APPROVED'
     AND NEW.fleet_class IN ('ATTACHED','MARKET')
     AND NEW.commission_amount IS NULL THEN
    RAISE EXCEPTION
      'Settlement % (%): % lorry ka commission rate darj nahi hai — approve nahi ho sakta.',
      NEW.id, NEW.vehicle_no, NEW.fleet_class
      USING ERRCODE = 'P0410';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vfs_class ON vehicle_fortnight_settlements;
CREATE TRIGGER vfs_class BEFORE INSERT OR UPDATE ON vehicle_fortnight_settlements
  FOR EACH ROW EXECUTE FUNCTION vfs_class_guard();

-- ── build, now class-aware ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vehicle_fortnight_build(p_from date, p_by text DEFAULT 'system')
RETURNS TABLE (created int, refreshed int, skipped int) AS $$
DECLARE
  v_from date := fortnight_from(p_from);
  v_created int := 0; v_refreshed int := 0; v_skipped int := 0;
BEGIN
  WITH src AS (
    SELECT * FROM v_vehicle_fortnight_class WHERE period_from = v_from
  ), ins AS (
    INSERT INTO vehicle_fortnight_settlements
      (vehicle_id, vehicle_no, vehicle_key, operating_company,
       period_from, period_to, cycle, status,
       trips_count, billed_amount, received_amount,
       hsd, toll, tyre, maintenance, other_expense, advances,
       fleet_class, owner_name, company_id, terms_id,
       commission_basis, commission_rate, commission_amount,
       tds_pct, tds_amount, expenses_recovered, payable_to_owner,
       lines, created_by)
    SELECT s.vehicle_id, s.vehicle_no, s.vehicle_key, s.operating_company,
           s.period_from, s.period_to, s.cycle, 'AI_DRAFT',
           s.trips_count, s.billed_amount, s.received_amount,
           s.hsd, s.toll, s.tyre, s.maintenance, s.other_expense, s.advances,
           s.fleet_class, s.owner_name, s.master_company_id, s.terms_id,
           s.basis, s.rate, s.commission_amount,
           s.tds_pct, s.tds_amount, s.expenses_recovered, s.payable_to_owner,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'trip_id', p.trip_id, 'trip_code', p.trip_code,
                      'loading_date', p.loading_date, 'unloading_date', p.unloading_date,
                      'customer', p.customer_name, 'driver', p.driver_name,
                      'billed', t2.billed_amount, 'received', t2.received_amount,
                      'qty', t2.loaded_qty, 'rtkm', t2.rtkm,
                      'hsd', p.hsd, 'toll', p.toll, 'tyre', p.tyre,
                      'maintenance', p.maintenance, 'other', p.other,
                      'expense', p.expense_total, 'advances', p.advances)
                      ORDER BY p.loading_date)
               FROM v_trip_pnl p
               JOIN trips t2 ON t2.id = p.trip_id
              WHERE upper(regexp_replace(t2.vehicle_no,'[^A-Za-z0-9]','','g')) = s.vehicle_key
                AND t2.status = 'COMPLETED'
                AND fortnight_from(COALESCE(t2.unloading_date, t2.loading_date)) = s.period_from
           ), '[]'::jsonb),
           p_by
      FROM src s
    ON CONFLICT (vehicle_key, period_from, period_to) DO UPDATE
       SET trips_count     = EXCLUDED.trips_count,
           billed_amount   = EXCLUDED.billed_amount,
           received_amount = EXCLUDED.received_amount,
           hsd             = EXCLUDED.hsd,
           toll            = EXCLUDED.toll,
           tyre            = EXCLUDED.tyre,
           maintenance     = EXCLUDED.maintenance,
           other_expense   = EXCLUDED.other_expense,
           advances        = EXCLUDED.advances,
           operating_company = EXCLUDED.operating_company,
           fleet_class     = EXCLUDED.fleet_class,
           owner_name      = EXCLUDED.owner_name,
           company_id      = EXCLUDED.company_id,
           terms_id        = EXCLUDED.terms_id,
           commission_basis = EXCLUDED.commission_basis,
           commission_rate  = EXCLUDED.commission_rate,
           commission_amount = EXCLUDED.commission_amount,
           tds_pct         = EXCLUDED.tds_pct,
           tds_amount      = EXCLUDED.tds_amount,
           expenses_recovered = EXCLUDED.expenses_recovered,
           payable_to_owner = EXCLUDED.payable_to_owner,
           lines           = EXCLUDED.lines,
           updated_at      = now()
       WHERE vehicle_fortnight_settlements.status = 'AI_DRAFT'
         AND vehicle_fortnight_settlements.locked_at IS NULL
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT count(*) FILTER (WHERE was_insert),
         count(*) FILTER (WHERE NOT was_insert)
    INTO v_created, v_refreshed FROM ins;

  SELECT count(*) INTO v_skipped
    FROM vehicle_fortnight_settlements
   WHERE period_from = v_from AND status <> 'AI_DRAFT';

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- ── the desk view gains the class columns ─────────────────────────────────
DROP VIEW IF EXISTS v_vehicle_settlement;
CREATE VIEW v_vehicle_settlement AS
SELECT s.*,
       (s.billed_amount + s.other_income
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'INCOME'), 0))::numeric(14,2)   AS gross_income,
       (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'EXPENSE'), 0))::numeric(14,2)  AS total_expense,
       COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                  WHERE a->>'side' = 'INCOME'), 0)::numeric(14,2)       AS adj_income,
       COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                  WHERE a->>'side' = 'EXPENSE'), 0)::numeric(14,2)      AS adj_expense,
       (s.locked_at IS NOT NULL)                                        AS locked,
       fortnight_label(s.period_from)                                   AS cycle_label,
       -- Only this reaches the firm's profit.
       CASE WHEN s.fleet_class = 'OWN' OR s.fleet_class IS NULL
            THEN (s.billed_amount + s.other_income
                  - (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense))
            ELSE s.commission_amount END::numeric(14,2)                 AS our_earning,
       (s.fleet_class IN ('ATTACHED','MARKET')
        AND s.commission_amount IS NULL)                                AS needs_rate,
       co.company_name,
       d.trips_count                                                    AS live_trips,
       d.billed_amount                                                  AS live_billed,
       d.expense_total                                                  AS live_expense
  FROM vehicle_fortnight_settlements s
  LEFT JOIN companies co ON co.id = s.company_id
  LEFT JOIN v_vehicle_fortnight_draft d
    ON d.vehicle_key = s.vehicle_key AND d.period_from = s.period_from;

-- ── which lorries are still missing a rate ────────────────────────────────
CREATE OR REPLACE VIEW v_commission_rate_missing AS
SELECT v.vehicle_no,
       v.vehicle_no_norm                                    AS vehicle_key,
       v.ownership::text                                    AS ownership,
       v.owner_name,
       (SELECT count(*)::int FROM trips t
         WHERE upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')) = v.vehicle_no_norm
           AND t.status = 'COMPLETED')                       AS trips_ever,
       (SELECT COALESCE(sum(t.billed_amount),0)::numeric(14,2) FROM trips t
         WHERE upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')) = v.vehicle_no_norm
           AND t.status = 'COMPLETED')                       AS freight_ever
  FROM vehicles v
 WHERE v.ownership = 'ATTACHED'
   AND NOT EXISTS (SELECT 1 FROM vehicle_commission_terms c
                    WHERE c.vehicle_key = v.vehicle_no_norm AND c.effective_to IS NULL)
 ORDER BY 6 DESC;

COMMENT ON VIEW v_commission_rate_missing IS
  'Attached lorries with no commission term on file, heaviest earner first. '
  'Every one of these settles to "rate not set" and cannot be approved.';
