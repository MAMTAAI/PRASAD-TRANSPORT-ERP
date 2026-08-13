-- ═══════════════════════════════════════════════════════════════════════════
-- 006_ops_crm_infra.sql — maintenance, CRM, hybrid-AI queue, auto-sync state
--
-- Un-parks DHUMAVATI (tyres, tyre_fitments) and MATANGI (notifications), and
-- adds the two infrastructure tables for this phase:
--   ai_tasks   — durable queue for the hybrid AI router's offline fallback
--   sync_state — resumable cursors for the AWS↔local auto-sync engine
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- TYRES + TYRE_FITMENTS — a tyre is an asset with a serial and a life, not a
-- consumable. (No tyre collection existed in the Firestore snapshot — the UI
-- kept tyres client-side — so these start empty; DHUMAVATI activates on the
-- schema, and TyreMgmt repoints here in the module-by-module cutover.)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE tyres (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id      text UNIQUE,
  serial_no      text NOT NULL,
  serial_no_norm text GENERATED ALWAYS AS (norm_reg(serial_no)) STORED,
  brand          text,
  model          text,
  size           text,
  purchase_date  date,
  purchase_cost  numeric(12,2),
  vendor_name    text,
  status         text NOT NULL DEFAULT 'IN_STOCK'
                 CHECK (status IN ('IN_STOCK','FITTED','RETREADING','SCRAPPED')),
  removal_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tyres_serial_uniq ON tyres (serial_no_norm);
CREATE TRIGGER tyres_touch BEFORE UPDATE ON tyres FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tyre_fitments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  tyre_serial   text NOT NULL,
  tyre_id       uuid REFERENCES tyres(id) ON DELETE SET NULL,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  position      text,                      -- 'FL' | 'RR2-outer' | ...
  fitment_date  date,
  fitment_km    numeric(12,1),
  removal_date  date,
  removal_km    numeric(12,1),
  removal_reason text,
  cost          numeric(12,2),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fitment_km_monotonic CHECK (removal_km IS NULL OR fitment_km IS NULL OR removal_km >= fitment_km)
);
-- DHUMAVATI's guard: one live fitment per serial, one live tyre per position.
CREATE UNIQUE INDEX fitment_live_serial_uniq ON tyre_fitments (tyre_serial) WHERE removal_date IS NULL;
CREATE UNIQUE INDEX fitment_live_position_uniq ON tyre_fitments (vehicle_id, position) WHERE removal_date IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTIFICATIONS — MATANGI's outbound queue. The unique index IS the
-- idempotent-send guard: a replayed event cannot message a customer twice.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  event_id    bigint,                      -- agent_events.id that triggered it
  channel     text NOT NULL DEFAULT 'WHATSAPP' CHECK (channel IN ('WHATSAPP','SMS','EMAIL')),
  recipient   text NOT NULL,               -- E.164 mobile / email
  template    text,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'QUEUED'
              CHECK (status IN ('QUEUED','SENT','FAILED','SUPPRESSED')),
  attempts    smallint NOT NULL DEFAULT 0,
  last_error  text,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE UNIQUE INDEX notifications_idempotent ON notifications (event_id, recipient)
  WHERE event_id IS NOT NULL;
CREATE INDEX notifications_pending_idx ON notifications (queued_at) WHERE status = 'QUEUED';

-- ═══════════════════════════════════════════════════════════════════════════
-- AI_TASKS — durable queue behind server/ai/router.js.
--
-- The offline-fallback guarantee lives here: when the local AI engine is off,
-- a privacy-routed task (OCR, ledger audit) becomes a PENDING row instead of
-- an error, and is drained when the engine returns. Cloud-eligible tasks may
-- be picked up by the fallback engine instead — the `lane` records which.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE ai_tasks (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,               -- 'ocr_extract' | 'ledger_audit' | 'crm_reply' | ...
  lane        text NOT NULL DEFAULT 'local'
              CHECK (lane IN ('local','cloud','either')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority    smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  status      text NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','DEAD')),
  attempts    smallint NOT NULL DEFAULT 0,
  engine_used text,
  result      jsonb,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX ai_tasks_pending_idx ON ai_tasks (priority, created_at) WHERE status IN ('PENDING','FAILED');

-- Claim helper — same SKIP LOCKED discipline as agent_events.
CREATE OR REPLACE FUNCTION claim_ai_tasks(p_lane text, batch integer DEFAULT 1)
RETURNS SETOF ai_tasks
LANGUAGE sql AS $fn$
  UPDATE ai_tasks
     SET status = 'RUNNING', attempts = attempts + 1, started_at = now()
   WHERE id IN (
     SELECT id FROM ai_tasks
      WHERE status IN ('PENDING','FAILED') AND attempts < 5
        AND (lane = p_lane OR lane = 'either')
      ORDER BY priority, created_at
      LIMIT batch
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SYNC_STATE — resumable cursors for the AWS↔local auto-sync engine
-- (BAGALAMUKHI's loop). One row per synced table per direction; the cursor is
-- an updated_at watermark, so an internet drop simply pauses the watermark and
-- the next successful tick resumes from exactly where it stopped.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE sync_state (
  id            text PRIMARY KEY,          -- 'push:vehicles', 'push:trips', ...
  watermark     timestamptz NOT NULL DEFAULT 'epoch',
  rows_synced   bigint NOT NULL DEFAULT 0,
  last_ok_at    timestamptz,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sync_state_touch BEFORE UPDATE ON sync_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
