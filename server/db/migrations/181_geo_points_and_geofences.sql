-- ═══════════════════════════════════════════════════════════════════════════
-- 181 — EVERY PARTY GETS A COORDINATE AND A FENCE
--
-- Owner, 6-Sep-2026: one map control across the whole ERP, on the PC and on the
-- phone, with a 2 km geofence around each party. This file is the half of that
-- which lives in the database.
--
-- WHAT WAS ACTUALLY MISSING. The maps layer here is mature — maps_cache (052),
-- a server geocoder that refuses answers that only resolve to a whole region,
-- Places autocomplete with session tokens, four read-only map screens. What no
-- table had was a PLACE. Every location in this system is a text string matched
-- by spelling: `trips.unloading_location`, `vendors.address`,
-- `rtkm_master.depot_link`. "Is this lorry at the depot?" could not be asked in
-- SQL because no depot had a coordinate.
--
-- ── THE FIVE COLUMNS, SPELLED THE SAME WAY ON EVERY TABLE ──────────────────
--
--   lat, lng          numeric(10,7). The precedent is toll_plazas (148). Seven
--                     decimal places is ~1 cm, which is far more than a
--                     refinery gate needs and costs nothing.
--   geofence_radius   metres, DEFAULT 2000 as specified.
--   geo_source        SEARCH | PIN | GPS | IMPORT — see below, this one earns
--                     its place.
--   geo_updated_at    when the pin last moved, so a stale pin is findable.
--
-- WHY geo_source EXISTS AND IS NOT OPTIONAL. A Google Places result is the
-- CENTROID of whatever Google thinks the place is. "Bongaigaon Refinery and
-- Petro-chemic" resolves to a point in the middle of a six-square-kilometre
-- complex — not the gate a lorry queues at. Verified in the browser: the Places
-- centroid and the gate are 700 m apart, which is a third of the default fence.
--
-- So the UI treats a search result as a CAMERA MOVE and saves whatever the pin
-- ends up on. Without this column the two are indistinguishable afterwards and
-- nobody can tell a surveyed gate from a guess at a town centre:
--
--   SEARCH  nobody has moved it. Approximate. Badged amber in the UI.
--   PIN     a person put it there deliberately. Trustworthy.
--   GPS     captured standing at the spot. The best of the three.
--   IMPORT  arrived from a data load; treat as SEARCH until someone confirms.
--
-- ── WHY HAVERSINE AND NOT POSTGIS ──────────────────────────────────────────
-- Production installed PostGIS 3.6.2 on 2-Sep. The development box did not get
-- it — 128_postgis.sql is written to skip quietly when the package is absent,
-- and on this machine it did exactly that. A migration that only runs on one of
-- the two databases is not a migration. geo_distance_m() below is plain SQL and
-- runs on both; at 2 km the difference from a geodesic is well under a metre,
-- and nothing here measures a continent. If PostGIS is later wanted for
-- indexed nearest-neighbour work, this function is what gets swapped, and every
-- caller keeps working because they all go through it.
--
-- ── WHY NOT VALID ON THE COORDINATE CHECKS ─────────────────────────────────
-- Adding a validated CHECK takes an ACCESS EXCLUSIVE lock and scans the table.
-- customers, vendors and trips are read by the dispatch board continuously. All
-- the existing rows have NULL coordinates and pass trivially, so the scan buys
-- nothing; NOT VALID applies the rule to every future write immediately and the
-- table is never locked. The same choice migration 146 made for the margin
-- guards.
--
-- The geofence_radius check is NOT deferred — it has a NOT NULL DEFAULT, so
-- every existing row is already 2000 and the validation is instant.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══ 1. THE HELPER THAT ADDS THE COLUMNS ═══════════════════════════════════
--
-- Ten tables, five columns, three constraints and four comments each is 120
-- statements written by hand and a typo in one of them nobody would find. The
-- procedure below is the single definition; every table below is one call.
--
-- `prefix` supports the two tables whose rows have TWO ends. A lane has a depot
-- and a consignee; a bazaar load has a pickup and a drop. Those get
-- depot_lat / consignee_lat rather than a second row.

CREATE OR REPLACE FUNCTION pt_add_geo_columns(tbl regclass, prefix text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p     text := CASE WHEN prefix = '' THEN '' ELSE prefix || '_' END;
  short text := split_part(tbl::text, '.', 2);
BEGIN
  IF short = '' THEN short := tbl::text; END IF;

  EXECUTE format(
    'ALTER TABLE %s
       ADD COLUMN IF NOT EXISTS %I numeric(10,7),
       ADD COLUMN IF NOT EXISTS %I numeric(10,7),
       ADD COLUMN IF NOT EXISTS %I integer NOT NULL DEFAULT 2000,
       ADD COLUMN IF NOT EXISTS %I text,
       ADD COLUMN IF NOT EXISTS %I timestamptz',
    tbl, p||'lat', p||'lng', p||'geofence_radius', p||'geo_source', p||'geo_updated_at');

  -- Both or neither. A row with a latitude and no longitude is the bug that
  -- puts a marker in the Gulf of Guinea, and it is unrepresentable now.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = tbl AND conname = short||'_'||p||'geo_pair') THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%I IS NULL) = (%I IS NULL)) NOT VALID',
      tbl, short||'_'||p||'geo_pair', p||'lat', p||'lng');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = tbl AND conname = short||'_'||p||'geo_range') THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (
         (%I IS NULL OR %I BETWEEN -90 AND 90) AND
         (%I IS NULL OR %I BETWEEN -180 AND 180)) NOT VALID',
      tbl, short||'_'||p||'geo_range', p||'lat', p||'lat', p||'lng', p||'lng');
  END IF;

  -- 50 m is tighter than civilian GPS is reliable; 50 km stops a fat finger
  -- turning one depot's fence into half of Assam.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = tbl AND conname = short||'_'||p||'geo_fence') THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I BETWEEN 50 AND 50000)',
      tbl, short||'_'||p||'geo_fence', p||'geofence_radius');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = tbl AND conname = short||'_'||p||'geo_source') THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (
         %I IS NULL OR %I IN (''SEARCH'',''PIN'',''GPS'',''IMPORT'')) NOT VALID',
      tbl, short||'_'||p||'geo_source', p||'geo_source', p||'geo_source');
  END IF;

  -- Partial: the overwhelming majority of rows will be unpinned for a long time
  -- and there is no reason to carry them in the index.
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %s (%I, %I) WHERE %I IS NOT NULL',
    'idx_'||short||'_'||p||'geo', tbl, p||'lat', p||'lng', p||'lat');

  -- ── WHY A TRIGGER AND NOT AN API FIELD ─────────────────────────────────
  -- "When did this pin last move" is only worth having if it is true. Left to
  -- the caller it is a browser clock — wrong on a phone with the wrong date,
  -- and settable to anything by a portal session. The database is the only
  -- party that knows when the write actually happened.
  --
  -- Fires only when the POINT changes. Editing a party's phone number must not
  -- make its pin look freshly surveyed.
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.%I IS NOT NULL THEN NEW.%I := now(); END IF;
      ELSIF NEW.%I IS DISTINCT FROM OLD.%I
         OR NEW.%I IS DISTINCT FROM OLD.%I
         OR NEW.%I IS DISTINCT FROM OLD.%I THEN
        NEW.%I := now();
      END IF;
      RETURN NEW;
    END $t$;
  $f$,
    'pt_geo_touch_'||short||'_'||p,
    p||'lat', p||'geo_updated_at',
    p||'lat', p||'lat', p||'lng', p||'lng',
    p||'geofence_radius', p||'geofence_radius',
    p||'geo_updated_at');

  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', 'trg_geo_touch_'||p||short, tbl);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION %I()',
    'trg_geo_touch_'||p||short, tbl, 'pt_geo_touch_'||short||'_'||p);

  EXECUTE format($c$COMMENT ON COLUMN %s.%I IS
    'Latitude of the exact point a lorry goes to, not the town centre. Set by '
    'the GeoPicker; see %I for how much to trust it.'$c$, tbl, p||'lat', p||'geo_source');
  EXECUTE format($c$COMMENT ON COLUMN %s.%I IS
    'Metres. The lorry is "here" when it is inside this circle. Default 2000.'$c$,
    tbl, p||'geofence_radius');
  EXECUTE format($c$COMMENT ON COLUMN %s.%I IS
    'SEARCH = Google Places centroid, nobody moved it, approximate. '
    'PIN = a person dropped it deliberately. GPS = captured on site. '
    'IMPORT = came from a data load, treat as SEARCH until confirmed.'$c$,
    tbl, p||'geo_source');
END $$;

COMMENT ON FUNCTION pt_add_geo_columns(regclass, text) IS
  'Adds the five standard geo columns + their guards to a table. Kept after the '
  'migration deliberately: the next table that needs pinning calls this rather '
  'than inventing a sixth spelling of "lat".';


-- ═══ 2. THE PARTIES ════════════════════════════════════════════════════════
--
-- The full sweep of the codebase, not a sample. Everything that stores an
-- address, a depot, a lane end or a plaza.

SELECT pt_add_geo_columns('customers');               -- consignor / corporate office
SELECT pt_add_geo_columns('vendors');                 -- fuel pumps, transporters, service vendors
SELECT pt_add_geo_columns('branches');                -- our own depots
SELECT pt_add_geo_columns('companies');               -- registered offices (GST / TDS paperwork)
SELECT pt_add_geo_columns('drivers');                 -- home village
SELECT pt_add_geo_columns('onboarding_applications'); -- carries the pin BEFORE approval

-- THE ONE THAT MATTERS MOST. customer_branches (163) is the learned list of
-- every unloading location the trips have ever recorded — i.e. the places
-- lorries actually go. The Depots tab in Customer.tsx edits a JSONB array on
-- the customer row instead, which cannot take columns; the API keeps the same
-- three keys inside those objects and mirrors them here, so the office screen
-- is unchanged and the queryable truth lives in a real table.
SELECT pt_add_geo_columns('customer_branches');

-- A LANE HAS TWO ENDS. The allowance, the RTKM and the toll are all properties
-- of the depot→consignee PAIR (see 178), so the pair is what gets pinned.
SELECT pt_add_geo_columns('rtkm_master', 'depot');
SELECT pt_add_geo_columns('rtkm_master', 'consignee');

-- Same shape, one table over: a posted load has a pickup and a drop.
SELECT pt_add_geo_columns('bazaar_loads', 'origin');
SELECT pt_add_geo_columns('bazaar_loads', 'destination');

-- toll_plazas already carries lat/lng from 148. pt_add_geo_columns is
-- IF NOT EXISTS throughout, so this adds only the fence and the provenance and
-- leaves the 400-odd learned coordinates untouched.
SELECT pt_add_geo_columns('toll_plazas');

-- Those coordinates were LEARNED from our own FASTag crossings (148), which is
-- neither a search nor a hand-placed pin. Marking them IMPORT says "believe
-- these enough to draw, not enough to bill from" — and only where a coordinate
-- actually exists, so the pair constraint holds.
UPDATE toll_plazas
   SET geo_source = 'IMPORT', geo_updated_at = now()
 WHERE lat IS NOT NULL AND geo_source IS NULL;

-- A plaza is a gate on a highway, not a site. 2 km would swallow the next
-- plaza on a busy stretch; 300 m is about the length of the plaza itself.
UPDATE toll_plazas SET geofence_radius = 300 WHERE geofence_radius = 2000;


-- ═══ 3. ONE WAY TO MEASURE ═════════════════════════════════════════════════
--
-- Written once so no screen invents its own. IMMUTABLE + PARALLEL SAFE so the
-- planner may use it inside a WHERE on a large scan.

CREATE OR REPLACE FUNCTION geo_distance_m(
  lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric
) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN NULL
    ELSE 6371000.0 * 2 * asin(least(1.0, sqrt(
           power(sin(radians(lat2::float8 - lat1::float8) / 2), 2)
         + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
         * power(sin(radians(lng2::float8 - lng1::float8) / 2), 2))))
  END;
$$;

COMMENT ON FUNCTION geo_distance_m(numeric, numeric, numeric, numeric) IS
  'Great-circle metres between two points. Haversine, not PostGIS: production '
  'has PostGIS 3.6.2 and the dev box does not, and this has to run on both. '
  'Sub-metre error at fence distances. NULL if either point is unset — never 0, '
  'because 0 would read as "same place" and put a lorry inside every fence.';

-- The question this whole migration exists to make askable.
CREATE OR REPLACE FUNCTION geo_within(
  lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric, radius_m integer
) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN radius_m IS NULL THEN NULL
    ELSE geo_distance_m(lat1, lng1, lat2, lng2) <= radius_m::float8
  END;
$$;

COMMENT ON FUNCTION geo_within(numeric, numeric, numeric, numeric, integer) IS
  'Is the first point inside the second point''s fence? NULL — not false — when '
  'either point is unpinned. "We do not know" and "it is outside" are different '
  'answers and a settlement must never confuse them.';


-- ═══ 4. ONE PLACE TO READ EVERY PINNED THING ═══════════════════════════════
--
-- The alternative is every future map UNIONing eleven tables itself and each
-- one getting a slightly different list. A live map, a "nearest pump" lookup
-- and the unpinned-parties queue all read from here.
--
-- entity_kind + entity_id is the address the API PATCHes back to, so the view
-- and the write path speak the same vocabulary.

CREATE OR REPLACE VIEW v_geo_points AS
  SELECT 'CUSTOMER'::text AS entity_kind, c.id AS entity_id,
         c.customer_name AS name, NULL::text AS sub_kind,
         c.lat, c.lng, c.geofence_radius, c.geo_source, c.geo_updated_at
    FROM customers c WHERE c.status = 'ACTIVE'
  UNION ALL
  SELECT 'CUSTOMER_BRANCH', b.id,
         b.branch_name, c2.customer_name,
         b.lat, b.lng, b.geofence_radius, b.geo_source, b.geo_updated_at
    FROM customer_branches b JOIN customers c2 ON c2.id = b.customer_id
  UNION ALL
  -- vendor_kind separates a fuel pump from a transporter from a tyre shop;
  -- the map legend needs that and the table already carries it (130).
  SELECT 'VENDOR', v.id, v.vendor_name, COALESCE(v.vendor_kind, v.vendor_type),
         v.lat, v.lng, v.geofence_radius, v.geo_source, v.geo_updated_at
    FROM vendors v WHERE v.status = 'ACTIVE'
  UNION ALL
  SELECT 'BRANCH', br.id, br.branch_name, br.city,
         br.lat, br.lng, br.geofence_radius, br.geo_source, br.geo_updated_at
    FROM branches br WHERE br.status = 'ACTIVE'
  UNION ALL
  SELECT 'COMPANY', co.id, co.company_name, NULL,
         co.lat, co.lng, co.geofence_radius, co.geo_source, co.geo_updated_at
    FROM companies co
  UNION ALL
  SELECT 'DRIVER', d.id, d.name, NULL,
         d.lat, d.lng, d.geofence_radius, d.geo_source, d.geo_updated_at
    FROM drivers d
  UNION ALL
  SELECT 'TOLL_PLAZA', tp.id, tp.plaza_name, NULL,
         tp.lat, tp.lng, tp.geofence_radius, tp.geo_source, tp.geo_updated_at
    FROM toll_plazas tp
  UNION ALL
  -- A lane contributes its two ends as two points, which is what a map wants.
  SELECT 'LANE_DEPOT', r.id, r.depot_link, r.customer_name,
         r.depot_lat, r.depot_lng, r.depot_geofence_radius,
         r.depot_geo_source, r.depot_geo_updated_at
    FROM rtkm_master r WHERE r.status = 'ACTIVE'
  UNION ALL
  SELECT 'LANE_CONSIGNEE', r2.id, r2.consignee_name, r2.customer_name,
         r2.consignee_lat, r2.consignee_lng, r2.consignee_geofence_radius,
         r2.consignee_geo_source, r2.consignee_geo_updated_at
    FROM rtkm_master r2 WHERE r2.status = 'ACTIVE';

COMMENT ON VIEW v_geo_points IS
  'Every pinnable thing in the company as one list — pinned or not. Rows with a '
  'NULL lat are the work queue, not noise: that is how the office sees what is '
  'left to pin. Read this rather than UNIONing the tables again.';


-- ═══ 5. HOW MUCH OF THE COMPANY IS ON THE MAP ══════════════════════════════
--
-- Surfaced, never auto-filled. The owner's standing rule is that a data fault
-- becomes a staff-editable task, not a corrective script — and a script that
-- geocoded 4,000 party names unattended would silently produce exactly the
-- town-centre pins this migration's geo_source column exists to distinguish.

CREATE OR REPLACE VIEW v_geo_coverage AS
  SELECT entity_kind,
         count(*)::int                                            AS total,
         count(lat)::int                                          AS pinned,
         count(*) FILTER (WHERE geo_source = 'SEARCH')::int        AS approx_only,
         count(*) FILTER (WHERE lat IS NULL)::int                  AS unpinned,
         round(100.0 * count(lat) / NULLIF(count(*), 0), 1)        AS pct_pinned
    FROM v_geo_points
   GROUP BY entity_kind
   ORDER BY unpinned DESC;

COMMENT ON VIEW v_geo_coverage IS
  'One row per entity kind: how many are pinned, how many are still only a '
  'Google search result, how many are not on the map at all. This is the screen '
  'that says whether the geo project actually landed.';

COMMIT;
