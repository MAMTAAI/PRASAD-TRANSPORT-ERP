-- ═══════════════════════════════════════════════════════════════════════════
-- 148_toll_plaza_master.sql — WHICH GATES, AT WHAT RATE, ON THIS ROUTE
--
-- Owner, 4-Sep-2026:
--   "trip route may toll gate and toll rate ... system may total trip par kitna
--    toll tax lag rahi hay yah map may show karay ... one way and return ...
--    aur jo system may nahi aayi, wo rate/toll add ho to auto add kar le taaki
--    next time Google map par toll gate show ho."
--
-- WHERE THE RATES COME FROM, AND WHY NOT FROM AN API. There is no toll-rate
-- feed in this ERP and buying one would be answering a question we have already
-- paid for: `toll_transactions` holds thousands of REAL crossings — the plaza,
-- its coordinates, and the exact rupees this fleet's own trucks were charged.
-- That is better than any published tariff, because it is this vehicle class,
-- on this corridor, after whatever pass or discount actually applied.
--
-- The FASTag provider sync (GTROPY) and the statement import both write into
-- that table. So the master below LEARNS: every crossing that lands teaches it
-- a plaza it did not know, or confirms a rate it did. That is the owner's
-- "auto add kar le" — nobody has to maintain a list.
--
-- WHAT IT DOES NOT DO: invent. A plaza this fleet has never crossed is not in
-- here, and the route panel says so rather than quietly under-counting the
-- toll. A person can type that rate in once (rate_source = MANUAL) and it is
-- known for ever after — and a MANUAL rate is NEVER overwritten by history,
-- because a human who checked the board at the gate outranks a median.
--
-- ONE CROSSING, ONE RATE. `rate` is what one truck pays passing this gate once.
-- The return leg is the caller's arithmetic, not this table's, because whether
-- a trip returns at all is a property of the TRIP: oil-company work is a round
-- trip (RTKM is round-trip km and the trip closes on return), a market vehicle
-- runs one side. See trips.trip_leg_kind, added below.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── The name key ────────────────────────────────────────────────────────────
-- Plaza names arrive spelled three ways by three producers: "Kamalpur Toll
-- Plaza", "KAMALPUR TOLLPLAZA", "Kamalpur  Toll  Plaza (NH-8)". Matching on the
-- raw text makes one gate look like three, each with a third of the evidence.
--
-- Deliberately NOT stripping the words TOLL or PLAZA: "Barapani Toll Plaza" and
-- "Barapani Plaza" would collapse into "BARAPANI", and so would anything else
-- in Barapani. Case, punctuation and spacing are noise; words are not.
CREATE OR REPLACE FUNCTION toll_plaza_key(p text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT nullif(regexp_replace(upper(p), '[^A-Z0-9]+', '', 'g'), '')
$$;

CREATE TABLE IF NOT EXISTS toll_plazas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The join key. Unique: one gate, one row, however it was spelled.
  name_key      text NOT NULL UNIQUE,
  -- What a person should read. The commonest spelling in our own records.
  plaza_name    text NOT NULL,
  -- Nullable on purpose. A plaza with no coordinates cannot be placed on a
  -- route, and (0,0) is a real place in the Gulf of Guinea — it plots there.
  lat           numeric(10,7),
  lng           numeric(10,7),
  -- What ONE crossing costs one of our trucks. NULL = we do not know yet, and
  -- the screens must say so rather than treat it as zero.
  rate          numeric(12,2),
  rate_source   text NOT NULL DEFAULT 'FASTAG_HISTORY'
                CHECK (rate_source IN ('FASTAG_HISTORY', 'MANUAL')),
  -- The evidence behind the rate, so an operator can judge it. A gate seen
  -- twice is a guess; a gate seen ninety times is a fact.
  observations  integer NOT NULL DEFAULT 0,
  rate_min      numeric(12,2),
  rate_max      numeric(12,2),
  first_seen    date,
  last_seen     date,
  highway       text,
  notes         text,
  verified_by   text,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The route panel asks for "every plaza that has coordinates" on every open.
CREATE INDEX IF NOT EXISTS toll_plazas_located_idx
  ON toll_plazas (lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;

DROP TRIGGER IF EXISTS toll_plazas_touch ON toll_plazas;
CREATE TRIGGER toll_plazas_touch BEFORE UPDATE ON toll_plazas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Makes the per-plaza recompute below an index scan rather than a table scan.
CREATE INDEX IF NOT EXISTS toll_txn_plaza_key_idx
  ON toll_transactions (toll_plaza_key(plaza_name));

-- ── Learning one plaza from what we have actually paid ──────────────────────
--
-- percentile_disc, not percentile_cont: tolls are discrete published amounts,
-- and the median of 65 and 70 is 65 or 70 — never 67.50, which is a number no
-- gate has ever charged. Same reasoning for the coordinates: a real observed
-- fix beats an interpolated point that may sit in the field beside the road.
--
-- A MANUAL rate is left alone. Everything else — coordinates, the evidence
-- counts, the dates — is refreshed either way, because those are facts about
-- the crossings and not about the price somebody verified.
CREATE OR REPLACE FUNCTION toll_plaza_learn(p_key text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  IF p_key IS NULL THEN RETURN; END IF;

  SELECT mode() WITHIN GROUP (ORDER BY t.plaza_name)                       AS disp,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY t.lat)                AS lat,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY t.lng)                AS lng,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY t.amount)
           FILTER (WHERE t.amount > 0)                                     AS rate,
         min(t.amount) FILTER (WHERE t.amount > 0)                         AS rate_min,
         max(t.amount) FILTER (WHERE t.amount > 0)                         AS rate_max,
         count(*) FILTER (WHERE t.amount > 0)                              AS obs,
         min(t.txn_date)                                                   AS first_seen,
         max(t.txn_date)                                                   AS last_seen
    INTO s
    FROM toll_transactions t
   WHERE toll_plaza_key(t.plaza_name) = p_key;

  -- NO CROSSINGS LEFT AT THIS GATE.
  --
  -- It happens when the last crossing is re-spelled onto another plaza — an
  -- operator correcting "No Coords Plaza" to "Barapani Toll Plaza" moves the
  -- evidence, and this key keeps whatever it had. Returning early here left the
  -- old gate showing the count and the rate it no longer has any basis for,
  -- which is worse than showing nothing: a rate with 4 crossings behind it
  -- reads as solid.
  --
  -- The ROW stays. A hand-verified rate and a coordinate are worth keeping even
  -- with no crossings behind them — that is exactly the gate somebody typed in
  -- because the FASTag feed never covered it. What goes is the EVIDENCE, and
  -- with it any rate that was only ever derived from that evidence.
  IF s.disp IS NULL THEN
    UPDATE toll_plazas
       SET observations = 0,
           rate_min     = NULL,
           rate_max     = NULL,
           rate         = CASE WHEN rate_source = 'MANUAL' THEN rate ELSE NULL END
     WHERE name_key = p_key;
    RETURN;
  END IF;

  INSERT INTO toll_plazas (name_key, plaza_name, lat, lng, rate, rate_source,
                           observations, rate_min, rate_max, first_seen, last_seen)
  VALUES (p_key, s.disp, s.lat, s.lng, s.rate, 'FASTAG_HISTORY',
          COALESCE(s.obs, 0), s.rate_min, s.rate_max, s.first_seen, s.last_seen)
  ON CONFLICT (name_key) DO UPDATE SET
    plaza_name   = EXCLUDED.plaza_name,
    -- Never blank a coordinate we already have because the newest rows lack one.
    lat          = COALESCE(EXCLUDED.lat, toll_plazas.lat),
    lng          = COALESCE(EXCLUDED.lng, toll_plazas.lng),
    rate         = CASE WHEN toll_plazas.rate_source = 'MANUAL'
                        THEN toll_plazas.rate            -- the human wins
                        ELSE COALESCE(EXCLUDED.rate, toll_plazas.rate) END,
    observations = EXCLUDED.observations,
    rate_min     = EXCLUDED.rate_min,
    rate_max     = EXCLUDED.rate_max,
    first_seen   = LEAST(COALESCE(toll_plazas.first_seen, EXCLUDED.first_seen), EXCLUDED.first_seen),
    last_seen    = GREATEST(COALESCE(toll_plazas.last_seen, EXCLUDED.last_seen), EXCLUDED.last_seen);
END $$;

-- ── The auto-add itself ─────────────────────────────────────────────────────
-- Every crossing that lands — provider sync, statement import or a manual entry
-- on the toll screen — teaches the master. This is the owner's "auto add kar
-- le": nothing is scheduled, nothing has to be remembered, and a gate is on the
-- map the first time one of our trucks pays at it.
--
-- STATEMENT-LEVEL, WITH TRANSITION TABLES, AND THAT IS NOT A DETAIL. The
-- statement import accepts up to 20,000 rows. A per-row trigger would recompute
-- a plaza's median once per row — twenty thousand index scans to learn maybe
-- forty gates, most of them re-learned four hundred times each. Transition
-- tables let this run ONCE per statement over the DISTINCT plazas that actually
-- moved, which is the same answer for a fraction of the work.
CREATE OR REPLACE FUNCTION toll_txn_learn_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  FOR k IN SELECT DISTINCT toll_plaza_key(plaza_name) FROM newrows
            WHERE toll_plaza_key(plaza_name) IS NOT NULL
  LOOP PERFORM toll_plaza_learn(k); END LOOP;
  RETURN NULL;
END $$;

-- An edit can MOVE a crossing from one gate to another (a corrected spelling is
-- exactly that), so both the gate it left and the gate it joined must relearn —
-- otherwise the old one keeps counting a crossing it no longer has.
--
-- NO `UPDATE OF plaza_name, amount, lat, lng` ON THE TRIGGER, and that is not a
-- preference: PostgreSQL refuses a column list on a trigger that uses transition
-- tables ("transition tables cannot be specified for triggers with column
-- lists"). So the filtering moves in here, where EXCEPT does the same job more
-- precisely — it compares the four columns we care about and yields nothing at
-- all when they did not change.
--
-- THAT MATTERS FOR ONE FLOW IN PARTICULAR. Raising a reimbursement claim bulk-
-- updates `claim_status` across every toll on the claim. Without the EXCEPT
-- below, stamping a 400-toll claim would relearn every gate on it for no reason.
CREATE OR REPLACE FUNCTION toll_txn_learn_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  FOR k IN
    WITH moved AS (
      SELECT plaza_name FROM (
        SELECT plaza_name, amount, lat, lng FROM newrows
        EXCEPT ALL
        SELECT plaza_name, amount, lat, lng FROM oldrows) d
      UNION ALL
      SELECT plaza_name FROM (
        SELECT plaza_name, amount, lat, lng FROM oldrows
        EXCEPT ALL
        SELECT plaza_name, amount, lat, lng FROM newrows) d
    )
    SELECT DISTINCT toll_plaza_key(plaza_name) FROM moved
     WHERE toll_plaza_key(plaza_name) IS NOT NULL
  LOOP PERFORM toll_plaza_learn(k); END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS toll_txn_learn ON toll_transactions;
DROP TRIGGER IF EXISTS toll_txn_learn_ins ON toll_transactions;
DROP TRIGGER IF EXISTS toll_txn_learn_upd ON toll_transactions;

CREATE TRIGGER toll_txn_learn_ins
  AFTER INSERT ON toll_transactions
  REFERENCING NEW TABLE AS newrows
  FOR EACH STATEMENT EXECUTE FUNCTION toll_txn_learn_inserted();

CREATE TRIGGER toll_txn_learn_upd
  AFTER UPDATE ON toll_transactions
  REFERENCING NEW TABLE AS newrows OLD TABLE AS oldrows
  FOR EACH STATEMENT EXECUTE FUNCTION toll_txn_learn_updated();

-- ── Everything we have already paid for, learned in one pass ────────────────
DO $$
DECLARE k text;
BEGIN
  FOR k IN SELECT DISTINCT toll_plaza_key(plaza_name)
             FROM toll_transactions
            WHERE toll_plaza_key(plaza_name) IS NOT NULL
  LOOP
    PERFORM toll_plaza_learn(k);
  END LOOP;
END $$;

-- ── ROUND TRIP OR ONE SIDE ──────────────────────────────────────────────────
--
-- Owner's rule: oil-company work is a ROUND trip — the lorry loads at the
-- depot, delivers, and comes back empty, and the trip is only complete on
-- return. That is already visible in the data: `trips.rtkm` is ROUND-trip km,
-- which is why it is roughly twice the road distance Google returns. A market
-- vehicle runs the owner's side only — one way — and its toll must not be
-- doubled.
--
-- NULL means "work it out from the vehicle", which is right almost always and
-- keeps every one of the 1,000-odd existing trips correct without a backfill.
-- The column exists for the exception: the operator can say so on the trip, and
-- what they say sticks.
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS trip_leg_kind text
    CHECK (trip_leg_kind IS NULL OR trip_leg_kind IN ('ROUND', 'ONE_WAY'));

COMMENT ON COLUMN trips.trip_leg_kind IS
  'ROUND = loaded out and back (oil company; rtkm is round-trip km). ONE_WAY = one side only (market vehicle). NULL = derive from the vehicle.';

COMMIT;
