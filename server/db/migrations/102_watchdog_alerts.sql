-- ═══════════════════════════════════════════════════════════════════════════
-- 102_watchdog_alerts.sql — the live board: what is broken RIGHT NOW, and what
-- was done about it.
--
-- The self-healer (scripts/erp_auto_healer.cjs) already detects crashes, drafts
-- a fix with the local model, validates it with `node --check`, and proposes it
-- for approval. It has done that for months into a JSON file and a log. From a
-- desk, a running healer and a dead one look the same, and so do "no crashes
-- today" and "the detector stopped reading the logs three weeks ago".
--
-- This is where that work becomes visible: one row per incident, moving
--   RED (open)  →  DIAGNOSING  →  FIX_PROPOSED  →  GREEN (resolved)
-- with the fix report attached at the end.
--
-- TWO COMPANIES, ONE SCHEMA, NO MIXING.
-- Prasad Transport and Jaiswal Capital run separate books, separate drives and
-- separate boxes. `company` is NOT NULL with no default: a writer must say who
-- it belongs to, because an alert that defaults to the wrong firm is worse than
-- one that is rejected. Every read path filters on it.
--
-- TWO ENVIRONMENTS, BOTH REPORTING HERE.
-- `environment` separates LOCAL from AWS. The same crash on both is two
-- incidents, not one: fixing the office PC does not fix the box in Mumbai.
--
-- WHY THE HEARTBEAT TABLE.
-- An empty alert board is only good news if the watchdog is alive to fill it.
-- Silence is the failure mode of every monitor ever written, so the watchdogs
-- check in and the board goes amber when one stops.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS watchdog_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  company       text NOT NULL CHECK (company IN ('PRASAD', 'JAISWAL')),
  environment   text NOT NULL CHECK (environment IN ('LOCAL', 'AWS')),
  host          text,
  service       text,                    -- api | whatsapp-engine | healer | rudra | ...

  severity      text NOT NULL DEFAULT 'HIGH'
                CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  -- RED and GREEN are the two the board renders as colours; the middle states
  -- exist so "someone is on it" is visible and a stuck diagnosis is obvious.
  status        text NOT NULL DEFAULT 'RED'
                CHECK (status IN ('RED','DIAGNOSING','FIX_PROPOSED','GREEN','MUTED')),

  kind          text NOT NULL,           -- CRASH | LEAK | BUG | UNRESPONSIVE | INTEGRATION
  title         text NOT NULL,
  error_type    text,                    -- TypeError, ReferenceError, ...
  error_message text,
  source_file   text,
  source_line   integer,
  stack         text,

  -- The healer's own identifiers, so a row here and its proposal there are the
  -- same incident rather than two versions of it.
  proposal_id   text,
  proposal_status text,

  -- Filled when the incident closes. `fix_report` is what a person reads:
  -- what was wrong and what was done, not a diff.
  fix_report    text,
  fix_diff      text,
  fixed_by      text,
  fixed_at      timestamptz,

  -- Same discipline as the exception queue: one incident that recurs is one row
  -- counting up, not a thousand rows nobody can scan.
  dedupe_key    text NOT NULL,
  occurrences   integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  acknowledged_by text,
  acknowledged_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT watchdog_dedupe_unique UNIQUE (company, environment, dedupe_key),
  -- A green row without a report is a status change nobody can audit.
  CONSTRAINT green_has_a_report CHECK (status <> 'GREEN' OR fix_report IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_watchdog_live
  ON watchdog_alerts (company, environment, severity, last_seen_at DESC)
  WHERE status IN ('RED','DIAGNOSING','FIX_PROPOSED');

-- ── heartbeats ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchdog_heartbeats (
  company     text NOT NULL CHECK (company IN ('PRASAD','JAISWAL')),
  environment text NOT NULL CHECK (environment IN ('LOCAL','AWS')),
  watchdog    text NOT NULL,
  host        text,
  version     text,
  beat_at     timestamptz NOT NULL DEFAULT now(),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company, environment, watchdog)
);

-- ── the board ──────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_watchdog_board AS
SELECT company, environment, id, host, service, severity, status, kind, title,
       error_type, error_message, source_file, source_line,
       proposal_id, proposal_status, fix_report, fixed_by, fixed_at,
       occurrences, first_seen_at, last_seen_at, acknowledged_by,
       (EXTRACT(epoch FROM now() - last_seen_at) / 60)::int AS minutes_since_seen
  FROM watchdog_alerts
 WHERE status <> 'MUTED';

CREATE OR REPLACE VIEW v_watchdog_summary AS
WITH beats AS (
  SELECT company, environment,
         count(*)::int AS watchdogs,
         count(*) FILTER (WHERE beat_at > now() - interval '5 minutes')::int AS alive,
         max(beat_at) AS last_beat
    FROM watchdog_heartbeats GROUP BY 1, 2
)
SELECT COALESCE(a.company, b.company)         AS company,
       COALESCE(a.environment, b.environment) AS environment,
       COALESCE(count(a.id) FILTER (WHERE a.status = 'RED'), 0)::int          AS red,
       COALESCE(count(a.id) FILTER (WHERE a.status = 'DIAGNOSING'), 0)::int   AS diagnosing,
       COALESCE(count(a.id) FILTER (WHERE a.status = 'FIX_PROPOSED'), 0)::int AS fix_proposed,
       COALESCE(count(a.id) FILTER (WHERE a.status = 'GREEN'
                                      AND a.fixed_at > now() - interval '24 hours'), 0)::int AS resolved_24h,
       COALESCE(count(a.id) FILTER (WHERE a.status IN ('RED','DIAGNOSING','FIX_PROPOSED')
                                      AND a.severity = 'CRITICAL'), 0)::int   AS critical,
       COALESCE(max(b.watchdogs), 0)          AS watchdogs,
       COALESCE(max(b.alive), 0)              AS watchdogs_alive,
       max(b.last_beat)                       AS last_heartbeat
  FROM watchdog_alerts a
  FULL OUTER JOIN beats b
    ON b.company = a.company AND b.environment = a.environment
 GROUP BY 1, 2;

COMMENT ON TABLE watchdog_alerts IS
  'Live incidents per company per environment. GREEN requires a fix report — a status change nobody can audit is not a resolution.';
COMMENT ON TABLE watchdog_heartbeats IS
  'Proof each watchdog is alive. An empty alert board only means good news if this table is fresh.';

COMMIT;
