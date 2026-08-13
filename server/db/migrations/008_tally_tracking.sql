-- ═══════════════════════════════════════════════════════════════════════════
-- 008_tally_tracking.sql — Tally Prime sync registry · triangulated GPS pings
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── TALLY_SYNC ──────────────────────────────────────────────────────────────
-- One row per pushable artefact (voucher or freight invoice). A SEPARATE table
-- rather than columns on ledger_entries, because ledger_entries is append-only
-- by trigger — sync state is mutable metadata and must not touch the book.
--
-- Idempotency is double-walled:
--   1. the UNIQUE source key here means our side never pushes twice;
--   2. tally_guid goes into the XML as REMOTEID, so even a replayed push is
--      deduplicated by Tally itself.
CREATE TABLE tally_sync (
  source        text PRIMARY KEY,          -- 'VOUCHER:<voucher_id>' | 'TRIP:<trip_id>'
  tally_guid    uuid NOT NULL DEFAULT gen_random_uuid(),
  voucher_type  text NOT NULL,             -- 'Receipt' | 'Payment' | 'Contra' | 'Sales'
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','SYNCED','FAILED')),
  attempts      smallint NOT NULL DEFAULT 0,
  tally_synced_at timestamptz,
  last_error    text,
  request_xml   text,                      -- exact XML sent — the audit artefact
  response_xml  text,                      -- exact Tally reply
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tally_synced_has_timestamp CHECK (status <> 'SYNCED' OR tally_synced_at IS NOT NULL)
);
CREATE INDEX tally_sync_pending_idx ON tally_sync (created_at) WHERE status IN ('PENDING','FAILED');
CREATE TRIGGER tally_sync_touch BEFORE UPDATE ON tally_sync FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── TRIP_GPS_PINGS ──────────────────────────────────────────────────────────
-- KALI's declared table (owns: trips, trip_legs, trip_gps_pings), now real.
-- Three telemetry sources, one table — triangulation picks per-source latest.
CREATE TABLE trip_gps_pings (
  id          bigserial PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('DRIVER_APP','GPRS','FASTAG')),
  lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  speed_kmh   numeric(6,2),
  accuracy_m  numeric(8,1),
  checkpoint  text,                        -- FASTAG: plaza name; GPRS: device id
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gps_trip_latest_idx ON trip_gps_pings (trip_id, source, recorded_at DESC);

COMMIT;
