-- ═══════════════════════════════════════════════════════════════════════════
-- 052_maps_cache.sql — stop paying Google twice for the same answer
--
-- WHAT ACTUALLY COSTS MONEY. Maps JS is billed per map load; moving a marker
-- costs nothing. Directions, Geocoding and Distance Matrix are billed PER
-- REQUEST. So the dispatch board's expense is not the live markers — it is
-- asking, every reload and for every viewer, how to drive from Bongaigaon
-- Refinery to Guwahati. That answer is the same for everyone and changes only
-- when the road network does.
--
-- This table is that answer, shared across users and across reloads. A route
-- resolved once by whoever opened the board first is free for everybody after.
--
-- KEYED BY A DIGEST, NOT BY FREE TEXT. Origin/destination arrive as typed
-- location names ("IOC CELL PETRONAS , KASBERIA , HALDIA") with inconsistent
-- spacing and case; keying on the raw strings would miss the cache constantly
-- and re-bill each near-identical spelling. The key is a normalised digest and
-- the raw values are kept alongside for debugging.
--
-- Rows carry fetched_at so a stale route can be re-resolved on a schedule
-- rather than living forever — road geometry does change, just not hourly.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS maps_cache (
  cache_key   text PRIMARY KEY,          -- sha256(kind|normalised origin|normalised destination)
  kind        text NOT NULL,             -- DIRECTIONS | GEOCODE | DISTANCE_MATRIX
  origin      text,
  destination text,
  -- The payload the client would otherwise have paid Google for: an encoded
  -- polyline for DIRECTIONS, a lat/lng for GEOCODE, metres+seconds for both.
  payload     jsonb NOT NULL,
  distance_m  integer,
  duration_s  integer,
  hits        integer NOT NULL DEFAULT 0,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maps_cache_kind ON maps_cache (kind, last_used DESC);
CREATE INDEX IF NOT EXISTS idx_maps_cache_age  ON maps_cache (fetched_at);

COMMENT ON TABLE maps_cache IS
  'Shared cache for BILLED Google Maps calls (Directions/Geocoding/Distance Matrix). Maps JS map loads and marker movement are not billed per request and are not cached here.';

COMMIT;
