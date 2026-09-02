-- ═══════════════════════════════════════════════════════════════════════════
-- 123_maintenance_auto_odometer.sql — servicing, without a manual odometer
--
-- THE FLEET HAS NO ODOMETER ANYWHERE. Checked before writing this:
--   · `vehicles` has no odometer column at all — not one;
--   · `maintenance_logs` holds ZERO rows. All 49 lorries, no service history.
-- So nothing in this database knows how far any truck has run, and the only
-- reason a maintenance screen can exist at all is that the TRIPS know: 825 of
-- 998 trips carry rtkm, 3,63,892 km of it.
--
-- THE CALCULATION, AND ITS ONE HONEST LIMIT.
--
--     effective odometer = odometer at last service + Σ rtkm of every trip
--                          that lorry has loaded SINCE that service date
--
-- The first term comes from a service log a person recorded. There are none
-- yet, so today every lorry answers NO_BASELINE — and that is the correct
-- answer, not a bug to paper over. A screen that invented a starting odometer
-- would put a servicing schedule for a 49-truck fleet on top of a number
-- nobody measured. The widget therefore opens as a WORKLIST: record one
-- reading per lorry, and that lorry starts tracking itself for ever after.
--
-- 173 TRIPS HAVE NO RTKM. Their distance is genuinely not recorded, so a sum
-- over a window containing them is a FLOOR, not a total. Every row carries
-- trips_missing_rtkm so the screen can say "at least this far" rather than
-- quietly under-reporting a truck towards its service.
--
-- WHY NOT A MATERIALISED VIEW: rtkm changes whenever a trip is edited, and a
-- stale service warning is worse than a slow one. 49 lorries × ~1,000 trips is
-- nothing to aggregate live.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Which kind of job a service log is ───────────────────────────────────
-- maintenance_logs.service_type is free text and the table is empty, so there
-- is no vocabulary to read off the data — these keywords are the vocabulary
-- being established. Anything unrecognised is OTHER and stays visible rather
-- than being forced into whichever tab is nearest.
CREATE OR REPLACE FUNCTION maintenance_group(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN p_type IS NULL OR btrim(p_type) = '' THEN 'OTHER'
    WHEN lower(p_type) ~ '(engine|oil|lube|lubric|filter|greas|servic|coolant|clutch|gear ?box|transmission)'
      THEN 'ENGINE_OIL'
    WHEN lower(p_type) ~ '(tyre|tire|wheel|spare|part|brake|suspension|spring|axle|body|electric|battery|alternator|starter)'
      THEN 'TYRES_SPARES'
    ELSE 'OTHER'
  END
$fn$;

COMMENT ON FUNCTION maintenance_group(text) IS
  'Buckets a free-text service_type into the Fleet Maintenance Hub tabs. '
  'Unrecognised text is OTHER and is shown, never silently reassigned.';

-- ── 2. The intervals, and the fact that they are OURS and not the firm's ────
-- Nobody has told this system how often a lorry is serviced. `is_default` is
-- true on every seeded row and the screen shows a badge while it is: a
-- servicing threshold presented as company policy, when it was picked by
-- whoever wrote the migration, is exactly the kind of confident wrong number
-- this codebase keeps having to remove. Editing a row clears the flag.
--
-- A LOG'S OWN next_due_km ALWAYS WINS over these. That column already exists
-- and is the garage's actual instruction for that specific service; the
-- interval below is only the fallback for a log that did not record one.
CREATE TABLE IF NOT EXISTS maintenance_plans (
  service_group text PRIMARY KEY
                CHECK (service_group IN ('ENGINE_OIL', 'TYRES_SPARES', 'OTHER')),
  label         text NOT NULL,
  interval_km   numeric(10,0),
  interval_days integer,
  -- How close to the limit counts as "due soon". The brief said 5–10%; 10 is
  -- the safer end of it for a fleet that runs 600 km round trips — 10% of
  -- 20,000 km is two trips of warning.
  due_soon_pct  numeric(5,2) NOT NULL DEFAULT 10 CHECK (due_soon_pct > 0 AND due_soon_pct < 100),
  is_default    boolean NOT NULL DEFAULT true,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO maintenance_plans (service_group, label, interval_km, interval_days) VALUES
  ('ENGINE_OIL',   'Engine / Oil',   20000, 180),
  ('TYRES_SPARES', 'Tyres / Spares', 60000, 365),
  ('OTHER',        'Other work',      NULL, NULL)
ON CONFLICT (service_group) DO NOTHING;

COMMENT ON TABLE maintenance_plans IS
  'Service intervals per group. Seeded with DEFAULTS (is_default = true) that '
  'nobody at the firm has confirmed — the UI says so until a row is edited. A '
  'log''s own next_due_km overrides these entirely.';

-- ── 3. The engine ───────────────────────────────────────────────────────────
-- One row per vehicle for one service group.
--
-- p_company_id scopes by WHO OPERATES THE LORRY TODAY, through company_at()
-- from migration 120 — not vehicles.company_id, which is a single current
-- value that would hand a transferred truck's whole past to its new firm.
-- Maintenance is a question about the lorry now, so "today" is the right date
-- to ask company_at() about.
CREATE OR REPLACE FUNCTION f_fleet_maintenance(
  p_group text DEFAULT 'ENGINE_OIL', p_company_id uuid DEFAULT NULL)
RETURNS TABLE (
  vehicle_id          uuid,
  vehicle_no          text,
  owner_name          text,
  last_service_date   date,
  last_service_type   text,
  last_garage         text,
  last_odometer_km    numeric,
  rtkm_since          numeric,
  trips_since         integer,
  trips_missing_rtkm  integer,
  effective_odo_km    numeric,
  limit_km            numeric,
  km_remaining        numeric,
  pct_of_interval     numeric,
  next_due_date       date,
  days_to_due         integer,
  limit_source        text,
  state               text
) LANGUAGE sql STABLE AS $fn$
  WITH plan AS (
    SELECT * FROM maintenance_plans WHERE service_group = p_group
  ),
  last AS (
    SELECT DISTINCT ON (m.vehicle_id)
           m.vehicle_id, m.service_date, m.service_type, m.garage_name,
           m.odometer_km, m.next_due_km, m.next_due_date
      FROM maintenance_logs m
     WHERE m.vehicle_id IS NOT NULL
       AND maintenance_group(m.service_type) = p_group
     ORDER BY m.vehicle_id, m.service_date DESC, m.created_at DESC
  ),
  run AS (
    SELECT v.id AS vehicle_id, v.vehicle_no, v.owner_name,
           l.service_date, l.service_type, l.garage_name,
           l.odometer_km, l.next_due_km, l.next_due_date,
           -- Trips are counted from the DAY AFTER the service: a lorry serviced
           -- on the 4th and loaded on the 4th was serviced first (the garage is
           -- a morning job here), and counting that trip would start every
           -- lorry one round trip into its own interval.
           COALESCE(SUM(t.rtkm) FILTER (
             WHERE l.service_date IS NULL OR t.loading_date > l.service_date), 0)::numeric(12,2) AS rtkm_since,
           count(t.id) FILTER (
             WHERE l.service_date IS NULL OR t.loading_date > l.service_date)::int AS trips_since,
           count(t.id) FILTER (
             WHERE (l.service_date IS NULL OR t.loading_date > l.service_date)
               AND (t.rtkm IS NULL OR t.rtkm = 0))::int AS trips_missing_rtkm
      FROM vehicles v
      LEFT JOIN last l ON l.vehicle_id = v.id
      LEFT JOIN trips t ON t.vehicle_id = v.id AND t.status <> 'CANCELLED'
     WHERE v.status = 'ACTIVE'
       AND (p_company_id IS NULL OR company_at(v.id, CURRENT_DATE) = p_company_id)
     GROUP BY v.id, v.vehicle_no, v.owner_name, l.service_date, l.service_type,
              l.garage_name, l.odometer_km, l.next_due_km, l.next_due_date
  ),
  calc AS (
    SELECT r.*,
           p.interval_km, p.due_soon_pct, p.interval_days,
           (r.odometer_km + r.rtkm_since)::numeric(12,2) AS effective_odo,
           -- The garage's own instruction first, our fallback interval second.
           COALESCE(r.next_due_km, r.odometer_km + p.interval_km)::numeric(12,2) AS lim,
           CASE WHEN r.next_due_km IS NOT NULL THEN 'log'
                WHEN p.interval_km IS NOT NULL THEN 'plan_default'
                ELSE 'none' END AS lim_source,
           COALESCE(r.next_due_date,
                    CASE WHEN r.service_date IS NOT NULL AND p.interval_days IS NOT NULL
                         THEN r.service_date + p.interval_days END) AS due_date
      FROM run r CROSS JOIN plan p
  )
  SELECT c.vehicle_id, c.vehicle_no, c.owner_name,
         c.service_date, c.service_type, c.garage_name, c.odometer_km,
         c.rtkm_since, c.trips_since, c.trips_missing_rtkm,
         c.effective_odo,
         c.lim,
         (c.lim - c.effective_odo)::numeric(12,2) AS km_remaining,
         CASE WHEN c.lim IS NULL OR c.lim <= c.odometer_km THEN NULL
              ELSE round((c.rtkm_since / (c.lim - c.odometer_km)) * 100, 1)
         END AS pct_of_interval,
         c.due_date,
         CASE WHEN c.due_date IS NULL THEN NULL
              ELSE (c.due_date - CURRENT_DATE) END AS days_to_due,
         c.lim_source,
         -- Worst of the two clocks wins: a lorry can be inside its km interval
         -- and six months past its date, and the date is still a service due.
         CASE
           WHEN c.service_date IS NULL                       THEN 'NO_BASELINE'
           WHEN c.odometer_km IS NULL                        THEN 'NO_ODOMETER'
           WHEN c.lim IS NULL                                THEN 'NO_INTERVAL'
           WHEN c.effective_odo >= c.lim                     THEN 'CRITICAL'
           WHEN c.due_date IS NOT NULL AND c.due_date <= CURRENT_DATE THEN 'CRITICAL'
           WHEN c.lim > c.odometer_km
            AND (c.rtkm_since / (c.lim - c.odometer_km)) * 100 >= (100 - c.due_soon_pct)
                                                             THEN 'DUE_SOON'
           WHEN c.due_date IS NOT NULL
            AND c.due_date <= CURRENT_DATE + 15              THEN 'DUE_SOON'
           ELSE 'HEALTHY'
         END AS state
    FROM calc c
$fn$;

COMMENT ON FUNCTION f_fleet_maintenance(text, uuid) IS
  'Fleet Maintenance Hub, one row per active lorry. The odometer is COMPUTED: '
  'last recorded service reading + the rtkm of every trip loaded since that '
  'date. NO_BASELINE means no service has ever been logged for that lorry in '
  'that group — the honest state, and the worklist the screen opens on.';

COMMIT;
