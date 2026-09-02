-- ═══════════════════════════════════════════════════════════════════════════
-- 128_postgis.sql — PostGIS, phase 0 of the marketplace + maps blueprint
--
-- On production the extension was created by the postgres superuser on
-- 2026-09-02 (postgresql-18-postgis-3, PostGIS 3.6.2) — prasad_app is not a
-- superuser and CREATE EXTENSION postgis is not a trusted extension, so the
-- migration cannot do that part itself. What it CAN do is make every other
-- environment honest: create it where the package is present and the role is
-- allowed, and say so plainly where it is not, without failing the deploy.
-- A later migration that needs geography(...) will fail loudly on its own if
-- this one only managed a NOTICE.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE NOTICE 'postgis already installed';
  ELSIF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    BEGIN
      CREATE EXTENSION postgis;
      RAISE NOTICE 'postgis created';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'postgis is available but this role may not create it — run as a superuser: CREATE EXTENSION postgis;';
    END;
  ELSE
    RAISE NOTICE 'postgis package not installed on this host (apt install postgresql-18-postgis-3)';
  END IF;
END
$$;

COMMIT;
