-- ═══════════════════════════════════════════════════════════════════════════
-- 151 — agent_execution_logs, and where a nightly statement comes from
--
-- THIS IS NOT agent_runs. Migration 002 already records one row per
-- (event, agent): "AGENT_06 handled fuel.slip.submitted #4471". That answers
-- "did this event get handled?". It cannot answer "did last night's 02:00 job
-- run, how long did each stage take, and how many rows did it bring in?" —
-- because a scheduled job is not an event, and a job that never started emits
-- nothing to point at. A job that silently stops is the failure this table
-- exists to make visible, so the row is written when the run STARTS, not when
-- it finishes. An 02:00 run with no row is a job that did not fire; a row still
-- RUNNING at 09:00 is a job that hung. Both are readable at a glance.
--
-- NOTHING HERE POSTS MONEY. The nightly chain imports evidence and emits
-- events; TARA posts, under the same approval discipline as every other
-- ledger entry in this system.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id            bigserial PRIMARY KEY,
  -- One run of one job. Every stage of a night shares this, so the whole
  -- chain — KAMALA woke, BHUVANESHWARI collected, CHHINNAMASTA imported,
  -- TARA was notified — reads as one story in one query.
  run_id        uuid NOT NULL,
  job           text NOT NULL,               -- 'nightly_fuel_sync'
  -- NULL step = the run itself. A named step = one stage inside it.
  step          text,
  agent_id      text,                        -- 'AGENT_00' … NULL = the scheduler
  agent_code    text,                        -- 'KAMALA'
  status        text NOT NULL DEFAULT 'RUNNING'
                CHECK (status IN ('RUNNING','OK','SKIPPED','BLOCKED','FAILED')),
  -- Why a stage did nothing. A SKIPPED with no reason is useless at 09:00.
  reason        text,
  -- Countable facts: { files: 3, rows_read: 812, rows_new: 44, matched: 39 }.
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  -- Threads this run into agent_events, so a ledger entry can be traced back
  -- to the night and the file that produced it.
  correlation_id uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  -- The service day the run belongs to (IST). The 02:00 run of the 5th covers
  -- the 4th; this column holds the 5th, so "has tonight run?" is one lookup.
  run_date      date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
);

CREATE INDEX IF NOT EXISTS agent_exec_recent_idx ON agent_execution_logs (started_at DESC);
CREATE INDEX IF NOT EXISTS agent_exec_run_idx    ON agent_execution_logs (run_id, id);
CREATE INDEX IF NOT EXISTS agent_exec_agent_idx  ON agent_execution_logs (agent_id, started_at DESC);

-- ONE AUTOMATIC RUN PER JOB PER DAY. This is the whole restart-safety story:
-- the job claims the day by inserting its run row, and a second attempt — a
-- pm2 restart at 02:04, the catch-up tick at 02:15 — collides here and steps
-- aside.
--
-- THE PREDICATE IS "NOT MANUAL", NOT "IS SCHEDULE", and that distinction is the
-- bug this index was first written with. Two different automatic paths reach
-- this job: the 02:00 cron (SCHEDULE) and the quarter-hourly catch-up that
-- covers a box which was down at 02:00 (CATCHUP). An index keyed on SCHEDULE
-- alone does not see the catch-up at all, so on any night the cron DID fire the
-- tick would have claimed the day a second time and re-imported the fortnight
-- fifteen minutes later. Caught by the selftest, not by production.
--
-- A person forcing a run (MANUAL) is deliberately outside the index: they have
-- said they want it, and they get it.
CREATE UNIQUE INDEX IF NOT EXISTS agent_exec_one_scheduled_run_per_day
  ON agent_execution_logs (job, run_date)
  WHERE step IS NULL AND COALESCE(detail->>'trigger', 'SCHEDULE') <> 'MANUAL';

COMMENT ON TABLE agent_execution_logs IS
  'One row per scheduled agent job run, plus one per stage inside it. Written '
  'at start, so a job that never fired is visible as a missing row rather than '
  'as silence. Distinct from agent_runs, which records event dispatch.';

-- ── Where tonight's statement comes from ──────────────────────────────────
--
-- WHY THIS IS A TABLE AND NOT THREE STORED PASSWORDS.
--
-- The ask was "log into IOCL, HPCL and BPCL with stored credentials". That is
-- not buildable honestly here, for two separate reasons, and this table is the
-- part that IS buildable:
--
--   1. HPCL DriveTrack asks for a captcha on every login. A captcha is a
--      deliberate "a person must do this". Automating past it is off-limits.
--   2. Keeping the live passwords to three fuel-credit accounts in this
--      database — accounts that hold real money, and that anyone with a read
--      of one table could then drain — is a bigger risk than the manual
--      download it saves. This system already carries that debt in two other
--      places (033, 045) and it should not grow a third.
--
-- So the statement is made to ARRIVE instead of being fetched. Both providers
-- can post it themselves: BPCL's own download dialog offers "Send Excel(.csv)
-- via Email", and any export saved to a watched folder is picked up the same
-- night. The job is fully unattended either way — nobody logs in at 02:00 —
-- and no portal password lives in this database.
CREATE TABLE IF NOT EXISTS fleet_card_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid REFERENCES fleet_card_accounts(id) ON DELETE CASCADE,
  -- FOLDER: a directory the statement is dropped into (portal download,
  --         shared drive, anything that writes a file).
  -- EMAIL:  a mailbox the provider mails the export to, read via the IMAP
  --         accounts this system already keeps.
  kind        text NOT NULL CHECK (kind IN ('FOLDER','EMAIL')),
  -- FOLDER → absolute path. EMAIL → the email_accounts row's address.
  locator     text NOT NULL,
  -- Only files matching this are considered. Keeps a shared Downloads folder
  -- from feeding the importer every unrelated spreadsheet on the box.
  file_glob   text NOT NULL DEFAULT '*.csv',
  -- The export usually does not name its account (BPCL sales, for one).
  -- Whoever configures the source says which account this folder belongs to,
  -- once, rather than the importer guessing every night.
  account_no  text,
  active      boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_card_sources_active_idx
  ON fleet_card_sources (active, kind);

COMMENT ON TABLE fleet_card_sources IS
  'Where the nightly job looks for a fleet-card statement. Statements arrive '
  '(dropped in a folder, or mailed by the provider) — the job never logs into '
  'a portal, and no portal password is stored anywhere in this database.';

-- ── A file is imported once ───────────────────────────────────────────────
-- The same download sitting in the folder for a week must not be re-read every
-- night. Content hash, not filename: the portal names every export the same.
ALTER TABLE fleet_card_import_batches
  ADD COLUMN IF NOT EXISTS content_sha  text,
  ADD COLUMN IF NOT EXISTS source_id    uuid REFERENCES fleet_card_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS run_id       uuid;

CREATE UNIQUE INDEX IF NOT EXISTS fleet_card_batch_content_uq
  ON fleet_card_import_batches (account_id, content_sha)
  WHERE content_sha IS NOT NULL;

-- ── Last night, in one row ────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_agent_job_health AS
SELECT r.job,
       r.run_id,
       r.run_date,
       r.status,
       r.started_at,
       r.duration_ms,
       r.detail->>'trigger'                        AS trigger,
       r.counts,
       r.error,
       (SELECT count(*) FROM agent_execution_logs s
         WHERE s.run_id = r.run_id AND s.step IS NOT NULL)                         AS steps,
       (SELECT count(*) FROM agent_execution_logs s
         WHERE s.run_id = r.run_id AND s.step IS NOT NULL AND s.status = 'FAILED') AS steps_failed,
       (SELECT string_agg(s.step || '=' || s.status, ', ' ORDER BY s.id)
          FROM agent_execution_logs s
         WHERE s.run_id = r.run_id AND s.step IS NOT NULL)                         AS trail
  FROM agent_execution_logs r
 WHERE r.step IS NULL;

COMMENT ON VIEW v_agent_job_health IS
  'One row per job run with its stage trail. `trail` reads as the night''s '
  'story: collect=OK, import=OK, reconcile=OK, handoff=SKIPPED.';
