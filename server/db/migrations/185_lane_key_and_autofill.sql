-- ═══════════════════════════════════════════════════════════════════════════
-- 185 — THE LANE TARGET THAT NEVER ARRIVED
--
-- Owner, 7-Sep-2026: the RTKM master holds the fixed HSD and cash for every
-- lane, per vehicle capacity and item type — and the Trip Command Center says
-- "0 L issued · no lane target" on trip after trip. The numbers exist; they do
-- not reach the trip.
--
-- WHY. Migration 178 already resolves a lane on every POST /trips. It matches
-- through lane_norm(), which upper-cases and strips everything that is not a
-- letter or a digit. That is not enough, because THE SAME PLACE IS WRITTEN TWO
-- WAYS in the two tables it has to join:
--
--   depot      trip:   'Rail fed POL Storage Depot (7D18)'  -> RAILFEDPOLSTORAGEDEPOT7D18
--              master: 'MOINARBAND DEPOT (7D18)'            -> MOINARBANDDEPOT7D18
--   consignee  trip:   'Agartala AFS 7A01'                  -> AGARTALAAFS7A01
--              master: 'ZC7A01 -Agartala AFS 7A01'          -> ZC7A01AGARTALAAFS7A01
--   consignee  trip:   '347560  SALMA FUEL STATION'         -> 347560SALMAFUELSTATION
--              master: 'SALMA FUEL STATION'                 -> SALMAFUELSTATION
--
-- Three different ways of saying the same thing, and none of the three joins.
-- 598 of 1,072 trips carry no HSD target at all as a result — which is also why
-- the driver settlement has nothing to settle against on those trips.
--
-- placeOf() in the front end has known all three of these since it was written
-- (src/lib/tripPlaces.core.mjs: the depot-code table, the ZC prefix, and — added
-- earlier today — the numeric SAP prefix). lane_norm() did not. This teaches it
-- the same three rules, in the database, where the join happens.
--
-- WHAT THIS FILE WILL NOT DO
-- It fills BLANKS only. 48 trips carry a target that disagrees with the master;
-- those were set by a person or by an older rule and this file does not touch
-- one of them — an allowance somebody typed is a decision, and overwriting it
-- from a table is how a settlement quietly changes after it was agreed.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. THE LANE KEY, TAUGHT THE THREE SPELLINGS ─────────────────────────────
-- THE CODE OUTRANKS THE PROSE. Where a name carries an IOCL location code —
-- 7D18, (7R01), 7A01, 7B03 — that code IS the place, and the words around it
-- are whatever the person typing had to hand. Keying on the code makes
-- 'Rail fed POL Storage Depot (7D18)' and 'MOINARBAND DEPOT (7D18)' one lane,
-- which is what they are.
--
-- Written with [[:space:]] and regexp_match rather than \s and back-references
-- on purpose: this text passes through a migration file, a driver and a server,
-- and the escaping of \s is exactly what broke the first attempt at this fix.
CREATE OR REPLACE FUNCTION lane_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  WITH s AS (SELECT upper(btrim(coalesce(p, ''))) AS t),
  code AS (
    SELECT (regexp_match(t, '(^|[^A-Z0-9])([0-9][A-Z][0-9]{2})([^A-Z0-9]|$)'))[2] AS c
      FROM s
  )
  SELECT COALESCE(
    -- an IOCL location code anywhere in the name wins
    (SELECT 'CODE' || c FROM code WHERE c IS NOT NULL),
    -- otherwise: drop the SAP consignee code (ZC7A01 -) and the SAP customer
    -- code (347560 ), then strip to letters and digits as before
    NULLIF(
      regexp_replace(
        regexp_replace(
          regexp_replace((SELECT t FROM s), '^ZC[0-9A-Z]{4}[[:space:]]*-?[[:space:]]*', ''),
          '^[0-9]{5,8}[[:space:]]+', ''),
        '[^A-Z0-9]+', '', 'g'),
      '')
  );
$fn$;

COMMENT ON FUNCTION lane_norm(text) IS
  'Lane key. An IOCL location code in the name (7D18, 7A01) IS the key — the same depot is "MOINARBAND DEPOT (7D18)" in the master and "Rail fed POL Storage Depot (7D18)" on an AC5 invoice. Otherwise the SAP prefixes (ZC7A01 -, 347560 ) are dropped and the rest reduced to letters and digits.';

-- ── 1b. REBUILD EVERY INDEX BUILT ON THE OLD KEY ────────────────────────────
-- THIS IS THE STEP WITHOUT WHICH THE WHOLE FILE IS WORSE THAN USELESS.
--
-- lane_norm() is IMMUTABLE, and rtkm_master carries
--   CREATE INDEX rtkm_master_lane_idx ON rtkm_master (lane_norm(consignee_name), lane_norm(customer_name))
-- Postgres trusts IMMUTABLE absolutely: it does not re-derive an index when the
-- function under it changes, so after the redefinition above that index still
-- holds ZC7A01AGARTALAAFS7A01 while every fresh call computes CODE7A01. Any
-- lookup the planner chooses to serve from the index then finds NOTHING, and a
-- lookup it happens to serve by a sequential scan finds the row — the same
-- query giving two answers depending on the plan.
--
-- That is precisely what happened while this file was being written: a
-- hand-written query matched the Agartala lane, lane_allowance() did not, and
-- the backfill left the very trips the owner photographed still blank.
--
-- Written as a loop over pg_indexes rather than one hard-coded REINDEX so an
-- index somebody adds on lane_norm later is rebuilt too.
DO $$
DECLARE ix record; n int := 0;
BEGIN
  FOR ix IN SELECT schemaname, indexname FROM pg_indexes WHERE indexdef ILIKE '%lane_norm%'
  LOOP
    EXECUTE format('REINDEX INDEX %I.%I', ix.schemaname, ix.indexname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '[185] rebuilt % index(es) that were built on the old lane key', n;
END $$;

-- lane_allowance() is a plain SQL function and Postgres inlines and caches its
-- plan per session. Replacing lane_norm() underneath it does NOT invalidate
-- that plan, so a session that had already used the old key kept using it —
-- which is exactly why the first dry run of this file still left PT00758 blank
-- while a hand-written query against the same two rows matched. Re-declaring
-- the function with an unchanged body forces the plan to be rebuilt.
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
) LANGUAGE sql STABLE AS $la$
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
  SELECT h.rtkm_distance, h.fixed_hsd_qty, h.fixed_cash_amt, h.toll_amt, h.id, a.n
    FROM hits h CROSS JOIN agg a
   WHERE a.n = 1 OR a.variants = 1
   LIMIT 1;
$la$;

-- ── 2. FILL THE BLANK TARGETS ───────────────────────────────────────────────
-- Only where the target is missing, and only where the lane resolves to exactly
-- one answer — lane_allowance() already refuses to answer an ambiguous lane,
-- which is the behaviour that keeps a 30 L lane from being paid 690 L.
-- Postgres will not let the UPDATE target appear in a LATERAL in its own FROM
-- clause, so the lane is resolved in a subquery first and joined back by id.
DO $$
DECLARE
  hsd_filled int; cash_filled int; km_filled int; still_blank int;
BEGIN
  UPDATE trips t SET fixed_hsd = s.v
    FROM (SELECT x.id, la.fixed_hsd_qty AS v
            FROM trips x
            CROSS JOIN LATERAL lane_allowance(x.customer_name, x.consignee_name, x.loading_point, NULL, NULL) la
           WHERE x.fixed_hsd IS NULL) s
   WHERE s.id = t.id AND s.v IS NOT NULL;
  GET DIAGNOSTICS hsd_filled = ROW_COUNT;

  UPDATE trips t SET fixed_cash = s.v
    FROM (SELECT x.id, la.fixed_cash_amt AS v
            FROM trips x
            CROSS JOIN LATERAL lane_allowance(x.customer_name, x.consignee_name, x.loading_point, NULL, NULL) la
           WHERE x.fixed_cash IS NULL) s
   WHERE s.id = t.id AND s.v IS NOT NULL;
  GET DIAGNOSTICS cash_filled = ROW_COUNT;

  UPDATE trips t SET rtkm = s.v
    FROM (SELECT x.id, la.rtkm_distance AS v
            FROM trips x
            CROSS JOIN LATERAL lane_allowance(x.customer_name, x.consignee_name, x.loading_point, NULL, NULL) la
           WHERE x.rtkm IS NULL) s
   WHERE s.id = t.id AND s.v IS NOT NULL;
  GET DIAGNOSTICS km_filled = ROW_COUNT;

  SELECT count(*) INTO still_blank FROM trips WHERE fixed_hsd IS NULL;

  RAISE NOTICE '[185] lane target filled - % HSD, % cash, % rtkm; % trip(s) still blank (see v_trips_without_lane_target)',
    hsd_filled, cash_filled, km_filled, still_blank;
END $$;

-- ── 3. AND FROM NOW ON, AT THE TABLE ────────────────────────────────────────
-- POST /trips already asks lane_allowance on create. This covers the rest: the
-- AC5 importer writing through another path, and — the case that matters most
-- day to day — a desk correcting a consignee or a depot AFTER the trip was
-- saved. Today that correction changes nothing; the target stays blank because
-- nothing re-asks. Never overwrites a target that is already set.
CREATE OR REPLACE FUNCTION trips_fill_lane_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE la record;
BEGIN
  IF NEW.fixed_hsd IS NOT NULL AND NEW.fixed_cash IS NOT NULL AND NEW.rtkm IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO la FROM lane_allowance(NEW.customer_name, NEW.consignee_name, NEW.loading_point, NULL, NULL);
  IF FOUND THEN
    IF NEW.fixed_hsd  IS NULL THEN NEW.fixed_hsd  := la.fixed_hsd_qty;  END IF;
    IF NEW.fixed_cash IS NULL THEN NEW.fixed_cash := la.fixed_cash_amt; END IF;
    IF NEW.rtkm       IS NULL THEN NEW.rtkm       := la.rtkm_distance;  END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trips_fill_lane_target ON trips;
CREATE TRIGGER trips_fill_lane_target
  BEFORE INSERT OR UPDATE OF consignee_name, loading_point, customer_name ON trips
  FOR EACH ROW EXECUTE FUNCTION trips_fill_lane_target();

-- ── 4. WHAT IS STILL BLANK, AND WHY ─────────────────────────────────────────
-- The Trip Command Center says "no lane target — set it on Fuel". This is the
-- list behind that sentence, with the reason on each row, so the desk can fix
-- the cause rather than typing the same number trip after trip.
CREATE OR REPLACE VIEW v_trips_without_lane_target AS
  SELECT t.id, t.trip_code, t.vehicle_no, t.loading_date, t.status,
         t.loading_point, t.consignee_name, t.customer_name,
         lane_norm(t.consignee_name) AS consignee_key,
         CASE
           WHEN t.consignee_name IS NULL THEN 'trip par consignee likha hi nahi hai'
           WHEN NOT EXISTS (SELECT 1 FROM rtkm_master r
                             WHERE COALESCE(r.status,'ACTIVE') = 'ACTIVE'
                               AND lane_norm(r.consignee_name) = lane_norm(t.consignee_name))
             THEN 'yeh consignee RTKM master mein hai hi nahi — pehle lane add karein'
           ELSE 'lane mili par ek se zyada, ya us par HSD blank hai — desk tay kare'
         END AS reason
    FROM trips t
   WHERE t.fixed_hsd IS NULL
   ORDER BY t.loading_date DESC NULLS LAST;

COMMENT ON VIEW v_trips_without_lane_target IS
  'Trips the RTKM master could not answer for, with the reason. Fix the cause here rather than typing the allowance on each trip.';

COMMIT;
