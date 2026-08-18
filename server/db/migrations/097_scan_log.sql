-- ═══════════════════════════════════════════════════════════════════════════
-- 097_scan_log.sql — evidence that a scan happened, and which engine served it
--
-- The mobile scanner is meant to work at 2am with the office PC off. That means
-- two different engines can produce the record: the local LLM enriching the
-- deterministic pass, or the deterministic pass alone. Both are valid; they
-- differ in completeness, not correctness.
--
-- Without this table those two are indistinguishable afterwards, and so is a
-- third case that matters more: nobody scanned anything at all. "No entry for
-- that challan" reads identically whether the driver never photographed it or
-- the scan ran and found nothing — and the office chases the wrong person.
--
-- Keyed by content hash: photographing the same page twice updates one row
-- rather than logging a second scan of the same paper.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS scan_log (
  id          bigserial PRIMARY KEY,
  file_hash   text NOT NULL UNIQUE,
  filename    text,
  -- Which door it came through: the mobile app, the vault screen, the bulk
  -- importer. Tells you where to look when one route starts failing.
  source      text NOT NULL DEFAULT 'api',
  uploaded_by text,

  kind        text,          -- COMPLIANCE | DRIVER | INVOICE | LOADING_CHALLAN | BILTY | UNKNOWN
  -- 'local+patterns' or 'patterns-only'. The whole point of the hybrid setup is
  -- that both are acceptable; this says which one answered.
  engine      text NOT NULL,
  text_chars  integer NOT NULL DEFAULT 0,
  vehicle_id  uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  -- The deterministic pass's own verdict. Never raised because an LLM agreed.
  confident   boolean NOT NULL DEFAULT false,
  result      jsonb,
  took_ms     integer,
  scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_log_recent ON scan_log (scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_log_needs_human ON scan_log (scanned_at DESC) WHERE NOT confident;
CREATE INDEX IF NOT EXISTS idx_scan_log_vehicle ON scan_log (vehicle_id) WHERE vehicle_id IS NOT NULL;

-- Is the hybrid actually holding up? If patterns_only climbs, the local engine
-- has been down and the office is getting thinner records than it thinks.
CREATE OR REPLACE VIEW v_scan_health AS
SELECT date_trunc('day', scanned_at)::date AS day,
       count(*)::int                                            AS scans,
       count(*) FILTER (WHERE engine = 'local+patterns')::int    AS with_local_ai,
       count(*) FILTER (WHERE engine = 'patterns-only')::int     AS patterns_only,
       count(*) FILTER (WHERE confident)::int                    AS confident,
       count(*) FILTER (WHERE NOT confident)::int                AS needs_human,
       round(avg(took_ms))::int                                  AS avg_ms
  FROM scan_log
 GROUP BY 1
 ORDER BY 1 DESC;

COMMENT ON TABLE scan_log IS
  'Every scan, and which engine served it. An empty result is only meaningful next to proof the scan ran.';

COMMIT;
