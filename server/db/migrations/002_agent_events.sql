-- ═══════════════════════════════════════════════════════════════════════════
-- 002_agent_events.sql — event backbone for the 10-agent Mahavidya swarm
--
-- Transactional outbox pattern. An agent never emits an event by calling
-- another agent; it INSERTs a row here inside the same transaction as its
-- business write. Either both land or neither does.
--
-- Why an outbox and not a bare NOTIFY:
--   • NOTIFY alone is fire-and-forget. If no listener is connected at that
--     instant the event is gone — unacceptable when the event is "trip
--     settled, post the freight to the ledger".
--   • The payload cap on NOTIFY is 8000 bytes. We notify with the event id
--     only and let the agent read the row, so payload size stops mattering.
--   • A durable row gives retries, an audit trail, and a dead-letter queue.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TYPE agent_event_state AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD');

-- ═══════════════════════════════════════════════════════════════════════════
-- AGENT_EVENTS — the outbox / event log
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE agent_events (
  id            bigserial PRIMARY KEY,
  -- Dotted namespace, e.g. 'trip.completed', 'fuel.slip.recorded'.
  event_type    text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'),
  -- What the event is about: ('trip', <uuid>). Lets an agent load the row
  -- without the emitter having to inline it.
  aggregate     text NOT NULL,
  aggregate_id  uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Agent id that produced this, e.g. 'AGENT_01'. NULL = external/API origin.
  emitted_by    text,
  -- Correlation id threads one business action across every agent that reacts
  -- to it, so a settlement can be traced end to end in one query.
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  state         agent_event_state NOT NULL DEFAULT 'PENDING',
  attempts      smallint NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,

  CONSTRAINT agent_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT agent_events_done_has_timestamp
    CHECK (state <> 'DONE' OR processed_at IS NOT NULL)
);

-- The claim query: oldest pending first. Partial index keeps it small — a
-- million DONE rows do not slow down finding the next PENDING one.
CREATE INDEX agent_events_pending_idx ON agent_events (created_at)
  WHERE state IN ('PENDING', 'FAILED');
CREATE INDEX agent_events_type_idx        ON agent_events (event_type, created_at DESC);
CREATE INDEX agent_events_aggregate_idx   ON agent_events (aggregate, aggregate_id);
CREATE INDEX agent_events_correlation_idx ON agent_events (correlation_id);
-- Dead letters must be trivially findable; there should never be many.
CREATE INDEX agent_events_dead_idx ON agent_events (created_at DESC) WHERE state = 'DEAD';

-- ── NOTIFY on insert ───────────────────────────────────────────────────────
-- Payload is id + type only, well under the 8000-byte cap regardless of how
-- large the business payload is.
CREATE OR REPLACE FUNCTION notify_agent_event() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify(
    'prasad_agent_events',
    json_build_object('id', NEW.id, 'event_type', NEW.event_type)::text
  );
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER agent_events_notify
  AFTER INSERT ON agent_events
  FOR EACH ROW EXECUTE FUNCTION notify_agent_event();

-- ═══════════════════════════════════════════════════════════════════════════
-- AGENT_RUNS — one row per (event, agent) handling attempt.
--
-- This is the swarm's audit trail: which agent did what, when, and how long it
-- took. Without it, "why did this trip get settled twice" is unanswerable.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE agent_runs (
  id           bigserial PRIMARY KEY,
  event_id     bigint NOT NULL REFERENCES agent_events(id) ON DELETE CASCADE,
  agent_id     text NOT NULL,
  agent_code   text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('OK', 'SKIPPED', 'BLOCKED', 'ERROR')),
  -- BLOCKED carries the guard that refused, e.g. 'driver_licence_expired'.
  reason       text,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- One handling record per agent per event: makes replay idempotent, because a
-- redelivered event cannot double-post if the agent already succeeded.
CREATE UNIQUE INDEX agent_runs_event_agent_uniq ON agent_runs (event_id, agent_id)
  WHERE outcome = 'OK';
CREATE INDEX agent_runs_agent_idx   ON agent_runs (agent_id, created_at DESC);
CREATE INDEX agent_runs_failure_idx ON agent_runs (created_at DESC)
  WHERE outcome IN ('BLOCKED', 'ERROR');

-- ═══════════════════════════════════════════════════════════════════════════
-- AGENT_HALTS — Bagalamukhi's kill switch, and every guard-level halt.
--
-- A halt is a row, not a process flag, so it survives a restart. An agent that
-- has been halted must not resume just because someone bounced PM2.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE agent_halts (
  id          bigserial PRIMARY KEY,
  -- NULL scope = global halt (the whole swarm stops).
  agent_id    text,
  reason      text NOT NULL,
  halted_by   text NOT NULL,
  halted_at   timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  cleared_by  text
);
-- At most one live halt per scope, so "is the swarm halted" is a single lookup.
CREATE UNIQUE INDEX agent_halts_active_global_uniq ON agent_halts ((agent_id IS NULL))
  WHERE cleared_at IS NULL AND agent_id IS NULL;
CREATE UNIQUE INDEX agent_halts_active_agent_uniq ON agent_halts (agent_id)
  WHERE cleared_at IS NULL AND agent_id IS NOT NULL;

-- ── Helper: claim the next event for processing ─────────────────────────────
-- SKIP LOCKED lets several API instances drain the same queue without ever
-- handing the same event to two workers. FOR UPDATE alone would serialise them.
CREATE OR REPLACE FUNCTION claim_agent_events(batch_size integer DEFAULT 10)
RETURNS SETOF agent_events
LANGUAGE sql AS $fn$
  UPDATE agent_events
     SET state = 'PROCESSING', attempts = attempts + 1
   WHERE id IN (
     SELECT id FROM agent_events
      WHERE state IN ('PENDING', 'FAILED')
        AND attempts < 5
      ORDER BY created_at
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
$fn$;

-- ── Observability view ─────────────────────────────────────────────────────
CREATE VIEW v_agent_health AS
SELECT r.agent_id,
       r.agent_code,
       count(*)                                         AS runs,
       count(*) FILTER (WHERE r.outcome = 'OK')         AS ok,
       count(*) FILTER (WHERE r.outcome = 'BLOCKED')    AS blocked,
       count(*) FILTER (WHERE r.outcome = 'ERROR')      AS errors,
       round(avg(r.duration_ms))                        AS avg_ms,
       max(r.created_at)                                AS last_run_at
FROM agent_runs r
GROUP BY r.agent_id, r.agent_code;

COMMIT;
