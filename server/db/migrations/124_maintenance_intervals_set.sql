-- ═══════════════════════════════════════════════════════════════════════════
-- 124_maintenance_intervals_set.sql — the firm's own service intervals
--
-- Migration 123 seeded two groups with intervals nobody had confirmed, flagged
-- `is_default = true` so the panel could say so. The owner has now given the
-- real ones (2026-09-02), and they are THREE services, not two:
--
--     Engine Oil & Filter        every 40,000 km
--     Greasing & Checkup         every 10,000 km
--     Tyre Rotation & Alignment  every 15,000 km
--
-- Two consequences worth spelling out, because they change what the widget
-- says rather than just what it stores.
--
-- 1. GREASING IS ITS OWN CADENCE AND SO IT IS ITS OWN GROUP. 123's
--    maintenance_group() folded 'greasing' into ENGINE_OIL — reasonable when
--    both were one bucket, wrong now: at 10,000 km it comes round four times
--    per oil change, and sharing a bucket would let one greasing log reset the
--    oil clock. The keyword moves out of ENGINE_OIL in the same statement that
--    creates GREASING, so there is never a moment where it matches both.
--
-- 2. THE SEEDED NUMBERS WERE BOTH WRONG, IN OPPOSITE DIRECTIONS. Oil was
--    guessed at 20,000 (half the real figure) and tyres at 60,000 (four times
--    it, because 123 read "Tyres/Spares" as replacement rather than rotation).
--    Any lorry that had been baselined under those guesses would have been
--    called due at the wrong distance in both directions. Nothing was baselined
--    yet — all 49 read NO_BASELINE — so no state is being corrected here, but
--    that is luck rather than design, and it is why `is_default` exists.
--
-- is_default goes false on all three: these are the firm's numbers now, and the
-- "we picked this" warning must disappear from the panel.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Room for the new group ───────────────────────────────────────────────
ALTER TABLE maintenance_plans DROP CONSTRAINT IF EXISTS maintenance_plans_service_group_check;
ALTER TABLE maintenance_plans ADD CONSTRAINT maintenance_plans_service_group_check
  CHECK (service_group IN ('ENGINE_OIL', 'GREASING', 'TYRES_SPARES', 'OTHER'));

-- ── 2. Greasing leaves the engine bucket ────────────────────────────────────
-- Order matters inside the CASE: GREASING is tested BEFORE ENGINE_OIL, because
-- a log reading "engine greasing" belongs to the 10,000 km clock, and the
-- engine pattern would otherwise claim it on the word "engine".
CREATE OR REPLACE FUNCTION maintenance_group(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN p_type IS NULL OR btrim(p_type) = '' THEN 'OTHER'
    WHEN lower(p_type) ~ '(greas|check ?up|checkup|washing|general service)'
      THEN 'GREASING'
    WHEN lower(p_type) ~ '(engine|oil|lube|lubric|filter|coolant|clutch|gear ?box|transmission|servic)'
      THEN 'ENGINE_OIL'
    WHEN lower(p_type) ~ '(tyre|tire|wheel|rotat|align|spare|part|brake|suspension|spring|axle|body|electric|battery|alternator|starter)'
      THEN 'TYRES_SPARES'
    ELSE 'OTHER'
  END
$fn$;

COMMENT ON FUNCTION maintenance_group(text) IS
  'Buckets a free-text service_type into the Fleet Maintenance Hub tabs. '
  'GREASING is tested first: it runs on a 10,000 km clock of its own and the '
  'engine pattern would otherwise claim "engine greasing". Unrecognised text is '
  'OTHER and is shown, never silently reassigned.';

-- ── 3. The intervals the owner gave ─────────────────────────────────────────
INSERT INTO maintenance_plans (service_group, label, interval_km, interval_days, is_default, updated_by)
VALUES ('GREASING', 'Greasing & Checkup', 10000, NULL, false, 'owner directive 2026-09-02')
ON CONFLICT (service_group) DO UPDATE
  SET label = EXCLUDED.label, interval_km = EXCLUDED.interval_km,
      is_default = false, updated_by = EXCLUDED.updated_by, updated_at = now();

UPDATE maintenance_plans
   SET label = 'Engine Oil & Filter', interval_km = 40000, is_default = false,
       updated_by = 'owner directive 2026-09-02', updated_at = now()
 WHERE service_group = 'ENGINE_OIL';

UPDATE maintenance_plans
   SET label = 'Tyre Rotation & Alignment', interval_km = 15000, is_default = false,
       updated_by = 'owner directive 2026-09-02', updated_at = now()
 WHERE service_group = 'TYRES_SPARES';

-- OTHER keeps no interval on purpose: it is the bucket for work that does not
-- recur on a distance, and giving it one would invent a schedule for repairs.
-- It stays is_default = true so nothing claims the firm chose it.

COMMIT;
