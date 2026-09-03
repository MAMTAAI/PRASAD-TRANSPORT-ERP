-- 143_load_pins_and_toll.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PIN-POINT LOADING / UNLOADING, AND THE TOLL WE EXPECT (owner, 3-Sep-2026)
--
--   "Use Google Maps API for exact Pin-Point selection for Loading and
--    Unloading locations. Automatically calculate and show the estimated Route
--    Toll Tax alongside distance."
--
-- WHY COORDINATES AND TEXT BOTH. The text stays authoritative: half these lanes
-- are depot names Google has never heard of ("BONGAIGAON RC OFFICE (7R01)"),
-- and PlaceInput accepts free text on purpose. The pin is an ACCELERATOR — when
-- the customer picks a real place we keep the point so the route, the map and
-- the driver's navigation all agree. A load with no pin is normal, not broken.
--
-- WHY THE ESTIMATE IS STORED. distance_km and toll_amount already existed but
-- were whatever somebody typed. These record what the engine computed AT
-- POSTING TIME and, crucially, WHERE IT CAME FROM — our own FASTag history or
-- an API guess. A month later "why did we quote this?" has an answer.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE bazaar_loads
  ADD COLUMN IF NOT EXISTS origin_lat       numeric(10,6),
  ADD COLUMN IF NOT EXISTS origin_lng       numeric(10,6),
  ADD COLUMN IF NOT EXISTS origin_place_id  text,
  ADD COLUMN IF NOT EXISTS dest_lat         numeric(10,6),
  ADD COLUMN IF NOT EXISTS dest_lng         numeric(10,6),
  ADD COLUMN IF NOT EXISTS dest_place_id    text,
  -- What the engine said when the load was posted, and on whose authority.
  ADD COLUMN IF NOT EXISTS est_toll         numeric(12,2),
  ADD COLUMN IF NOT EXISTS est_toll_source  text,     -- OUR_TRIPS | GOOGLE | MANUAL
  ADD COLUMN IF NOT EXISTS est_distance_km  integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bazaar_loads_toll_source_check') THEN
    ALTER TABLE bazaar_loads ADD CONSTRAINT bazaar_loads_toll_source_check
      CHECK (est_toll_source IS NULL OR est_toll_source IN ('OUR_TRIPS', 'GOOGLE', 'MANUAL'));
  END IF;
END $$;

-- A lane priced once is priced for everybody: the lookup below is by lane, and
-- these two indexes are what keep the desk's per-load call cheap.
CREATE INDEX IF NOT EXISTS idx_bazaar_loads_lane
  ON bazaar_loads (origin, destination);

COMMIT;
