-- ═══════════════════════════════════════════════════════════════════════════
-- 100_zero_gap_routing.sql — nothing fails silently, and every failure has an
-- owner and a next step.
--
-- `exceptions` (091) already refuses to let a DETECTED problem die in a log. But
-- it only ever fills up from detectors somebody remembered to write. A scan that
-- throws, an embedding call that times out, an auto-update that half-finishes —
-- none of those reach it. They land in a console the office does not read, and
-- the difference between "the system did nothing" and "the system tried and
-- failed" disappears. That difference is the whole job.
--
-- Three things are missing and this adds them.
--
-- 1. AN OWNER. An exception with no department is everyone's and therefore
--    nobody's. Routing is derived from the kind and the subject, so a new
--    detector cannot forget to set it.
--
-- 2. THE THREE QUESTIONS, NAMED. `detail` was carrying all of them at once and
--    so answered none reliably. A person picking up a failure needs, in this
--    order: why did it stop, how did it get here, and what am I meant to do.
--    Separate columns because a reviewer reads them at different moments and a
--    paragraph that blends them gets skimmed.
--
-- 3. FAILURE KINDS. The existing kinds are all business anomalies. A process
--    that crashed is a different animal and needs to be filterable as one.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── new kinds for process failure ──────────────────────────────────────────
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN (
  'DUPLICATE_BILLING', 'DRIVER_MISMATCH', 'PARSER_REJECT', 'UNMATCHED_TRIP',
  'AMOUNT_MISMATCH', 'LEDGER_DRIFT', 'MISSING_MASTER', 'OTHER',
  -- Added 2026-08-18: things that BROKE, as opposed to things that look wrong.
  'SCAN_FAILURE',        -- OCR or the document parser could not finish
  'AI_FAILURE',          -- a model or embedding call failed or timed out
  'AUTO_UPDATE_FAILURE', -- a background update did not complete
  'INTEGRATION_FAILURE', -- an outbound call (AWS, Drive, WhatsApp) failed
  'REQUEST_FAILURE'      -- an API request died before it answered
));

ALTER TABLE exceptions
  -- Who owns it. Derived, never typed by hand at the call site.
  ADD COLUMN IF NOT EXISTS department text
    CHECK (department IN ('OPERATIONS','ACCOUNTING','CRM','COMPLIANCE','IT')),
  -- How it got here: the process, the input, the run. Not the error text.
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the person should DO. A sentence, in the imperative. An exception that
  -- says only what broke leaves the reviewer to invent the fix, which is how a
  -- queue becomes a graveyard.
  ADD COLUMN IF NOT EXISTS resolution_action text;

CREATE INDEX IF NOT EXISTS idx_exceptions_department
  ON exceptions (department, severity, detected_at DESC) WHERE status IN ('OPEN','IN_REVIEW');

-- ── routing ────────────────────────────────────────────────────────────────
-- One function, so every raiser routes the same way and a new caller cannot
-- invent its own answer. Kind decides first; the subject breaks ties.
CREATE OR REPLACE FUNCTION exception_department(p_kind text, p_subject_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN p_kind IN ('DUPLICATE_BILLING','AMOUNT_MISMATCH','LEDGER_DRIFT')      THEN 'ACCOUNTING'
    WHEN p_kind IN ('DRIVER_MISMATCH','UNMATCHED_TRIP')                        THEN 'OPERATIONS'
    WHEN p_kind IN ('PARSER_REJECT','SCAN_FAILURE')                            THEN
      CASE WHEN p_subject_type IN ('vehicle','driver','vehicle_document') THEN 'COMPLIANCE'
           ELSE 'OPERATIONS' END
    WHEN p_kind = 'MISSING_MASTER'                                             THEN 'OPERATIONS'
    -- A model or a crashed request is nobody's business problem: it is IT's,
    -- until IT decides otherwise. Routing it to Operations would put a stack
    -- trace in front of someone who cannot act on it.
    WHEN p_kind IN ('AI_FAILURE','REQUEST_FAILURE','INTEGRATION_FAILURE')      THEN 'IT'
    WHEN p_kind = 'AUTO_UPDATE_FAILURE'                                        THEN
      CASE WHEN p_subject_type IN ('vehicle','driver','vehicle_document') THEN 'COMPLIANCE'
           ELSE 'IT' END
    ELSE 'OPERATIONS'
  END;
$fn$;

-- Backfill the rows that predate routing.
UPDATE exceptions SET department = exception_department(kind, subject_type)
 WHERE department IS NULL;

-- ── the department inbox ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_department_queue AS
SELECT COALESCE(e.department, exception_department(e.kind, e.subject_type)) AS department,
       e.id, e.kind, e.severity, e.status, e.title,
       e.detail            AS why_it_stopped,
       e.context           AS how_it_got_here,
       e.resolution_action AS what_to_do,
       e.options, e.evidence, e.amount_at_risk, e.subject_type, e.subject_id,
       e.detected_by, e.detected_at, e.last_seen_at, e.seen_count
  FROM exceptions e
 WHERE e.status IN ('OPEN', 'IN_REVIEW');

-- The badge on each department's tab, and the number a manager is measured by.
CREATE OR REPLACE VIEW v_department_queue_summary AS
SELECT COALESCE(department, exception_department(kind, subject_type)) AS department,
       count(*) FILTER (WHERE status IN ('OPEN','IN_REVIEW'))::int      AS open_items,
       count(*) FILTER (WHERE severity = 'CRITICAL' AND status IN ('OPEN','IN_REVIEW'))::int AS critical,
       count(*) FILTER (WHERE severity = 'HIGH' AND status IN ('OPEN','IN_REVIEW'))::int     AS high,
       COALESCE(sum(amount_at_risk) FILTER (WHERE status IN ('OPEN','IN_REVIEW')), 0)::numeric(14,2) AS amount_at_risk,
       max(last_seen_at) FILTER (WHERE status IN ('OPEN','IN_REVIEW'))  AS latest,
       -- An item nobody has touched for a week is the queue failing, not the
       -- system. Surfaced so it cannot be quietly tolerated.
       count(*) FILTER (WHERE status IN ('OPEN','IN_REVIEW')
                          AND detected_at < now() - interval '7 days')::int AS stale_over_7d
  FROM exceptions
 GROUP BY 1;

COMMENT ON COLUMN exceptions.resolution_action IS
  'What the reviewer should do, in the imperative. An exception without this is a log line with a UUID.';

COMMIT;
