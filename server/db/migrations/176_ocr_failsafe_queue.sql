-- ═══════════════════════════════════════════════════════════════════════════
-- 176 — 24/7 OCR FAIL-SAFE QUEUE
--
-- Owner, 6-Sep-2026: a phone must be able to send a document at 2 a.m. with
-- the 32 GB PC switched off and the 1.9 GB AWS box under memory pressure, and
-- NEVER see a failure. The file and its record are saved first, always; the
-- reading of it is a separate, retryable job.
--
-- What the audit found (docs/RND-HYBRID-ARCHITECTURE-2026-09-06.md):
--   · POST /api/v1/scan — "the endpoint the phone talks to" — read the bytes
--     and never stored them. A failed scan lost the document.
--   · POST /api/v1/kyc/scan answered 503 OCR_LOW_MEMORY / 429 OCR_BUSY when
--     the box was busy. Correct for the box, a broken scanner for the driver.
--   · OLLAMA_HEAVY_URL (the 32 GB PC, deepseek-r1:14b) was set in .env and
--     read by no code at all.
--
-- The ladder this table serves, in order, per job:
--   1. HEAVY_LOCAL_PC  the 32 GB PC claims the job over HTTPS (pull, outbound
--                      only — the PC never holds a Postgres connection, which
--                      BAGALAMUKHI's db_stays_loopback_or_vpc forbids).
--   2. CLOUD           DeepSeek / Anthropic, when the PC has not claimed
--                      within the grace window.
--   3. AWS_PATTERNS    tesseract + docPatterns on the box itself, memory-gated.
--   4. QUEUED          none of the above available → the job WAITS. It does
--                      not fail, and the document is already safe on disk.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ocr_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL DEFAULT 'MOBILE_SCAN'
                  CHECK (source IN ('MOBILE_SCAN','KYC','PARTNER_DOC','BILL','MANUAL','RETRY')),
  doc_type        text,                       -- DL | AADHAAR | PAN | BANK | HZD | AC5 | PUMP_BILL | AUTO
  -- the document itself, saved BEFORE anything is attempted
  file_key        text NOT NULL,
  file_url        text,
  filename        text,
  mime            text,
  bytes           int,
  sha256          text,
  -- who and what it belongs to
  source_ref      text,
  subject_kind    text,                       -- driver | vendor | trip | vehicle | customer_bill
  subject_id      text,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  requested_by    text,
  -- the work
  status          text NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED','CANCELLED')),
  tier            text CHECK (tier IS NULL OR tier IN ('HEAVY_LOCAL_PC','CLOUD','AWS_PATTERNS')),
  engine          text,
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  leased_by       text,
  -- the answer (a PROPOSAL — a person or an existing approve path applies it)
  fields          jsonb,
  confidence      jsonb,
  text_excerpt    text,
  notes           text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE INDEX IF NOT EXISTS ocr_jobs_pick_idx ON ocr_jobs (status, next_attempt_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS ocr_jobs_lease_idx ON ocr_jobs (status, lease_until) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS ocr_jobs_subject_idx ON ocr_jobs (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS ocr_jobs_created_idx ON ocr_jobs (created_at DESC);

COMMENT ON TABLE ocr_jobs IS
  'Fail-safe OCR queue (176). The file is stored and this row written BEFORE any '
  'reading is attempted, so a scan can never lose a document. Consumers: the 32 GB '
  'PC worker (pull, outbound HTTPS only) and the AWS dispatcher (delayed fallback).';
COMMENT ON COLUMN ocr_jobs.fields IS 'Extracted fields — a proposal. Nothing here is applied to a master record without a person or an existing approve path.';

DROP TRIGGER IF EXISTS ocr_jobs_touch ON ocr_jobs;
CREATE TRIGGER ocr_jobs_touch BEFORE UPDATE ON ocr_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══ CLAIM (lease) ════════════════════════════════════════════════════════
-- A worker leases jobs rather than locking them: if the PC is switched off
-- mid-job the lease expires and the work returns to the queue by itself.
-- p_min_age_seconds lets the AWS dispatcher give the PC a head start.
CREATE OR REPLACE FUNCTION ocr_claim(
  p_worker  text,
  p_limit   int  DEFAULT 1,
  p_lease   int  DEFAULT 180,
  p_min_age int  DEFAULT 0
) RETURNS SETOF ocr_jobs LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM ocr_jobs j
     WHERE j.status = 'QUEUED'
       AND j.next_attempt_at <= now()
       AND j.attempts < j.max_attempts
       AND j.created_at <= now() - make_interval(secs => greatest(p_min_age, 0))
     ORDER BY j.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT greatest(p_limit, 1)
  )
  UPDATE ocr_jobs j
     SET status = 'RUNNING', leased_by = p_worker,
         lease_until = now() + make_interval(secs => greatest(p_lease, 30)),
         attempts = j.attempts + 1, updated_at = now()
    FROM picked WHERE j.id = picked.id
  RETURNING j.*;
END $$;

-- A lease that ran out goes back with exponential backoff (1, 2, 4, 8, 16 min).
CREATE OR REPLACE FUNCTION ocr_reclaim_stale() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE ocr_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
         error = coalesce(error, 'worker lease expired — the machine that claimed it went away'),
         next_attempt_at = now() + make_interval(mins => least(power(2, greatest(attempts - 1, 0))::int, 16)),
         lease_until = NULL, leased_by = NULL, updated_at = now()
   WHERE status = 'RUNNING' AND lease_until IS NOT NULL AND lease_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION ocr_complete(p_id uuid, p_tier text, p_engine text, p_fields jsonb, p_confidence jsonb, p_text text, p_notes text DEFAULT NULL)
RETURNS ocr_jobs LANGUAGE plpgsql AS $$
DECLARE j ocr_jobs;
BEGIN
  UPDATE ocr_jobs
     SET status = 'DONE', tier = p_tier, engine = p_engine,
         fields = coalesce(p_fields, '{}'::jsonb), confidence = p_confidence,
         text_excerpt = left(coalesce(p_text, ''), 4000), notes = p_notes,
         error = NULL, lease_until = NULL, leased_by = NULL,
         done_at = now(), updated_at = now()
   WHERE id = p_id RETURNING * INTO j;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION ocr_fail(p_id uuid, p_error text) RETURNS ocr_jobs LANGUAGE plpgsql AS $$
DECLARE j ocr_jobs;
BEGIN
  UPDATE ocr_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
         error = left(coalesce(p_error, 'unknown'), 500),
         next_attempt_at = now() + make_interval(mins => least(power(2, greatest(attempts - 1, 0))::int, 16)),
         lease_until = NULL, leased_by = NULL, updated_at = now()
   WHERE id = p_id RETURNING * INTO j;
  RETURN j;
END $$;

-- ═══ HEALTH ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_ocr_health AS
SELECT count(*) FILTER (WHERE status = 'QUEUED')::int    AS queued,
       count(*) FILTER (WHERE status = 'RUNNING')::int   AS running,
       count(*) FILTER (WHERE status = 'DONE')::int      AS done,
       count(*) FILTER (WHERE status = 'FAILED')::int    AS failed,
       count(*) FILTER (WHERE status = 'DONE' AND done_at > now() - interval '24 hours')::int AS done_24h,
       coalesce(round(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'QUEUED')) / 60.0)::int, 0) AS oldest_queued_minutes,
       coalesce(sum(bytes) FILTER (WHERE status IN ('QUEUED','RUNNING')), 0)::bigint AS pending_bytes,
       (SELECT coalesce(jsonb_object_agg(t, n), '{}'::jsonb)
          FROM (SELECT coalesce(tier, 'none') AS t, count(*)::int AS n FROM ocr_jobs
                 WHERE status = 'DONE' AND done_at > now() - interval '24 hours' GROUP BY 1) x) AS tiers_24h
  FROM ocr_jobs;

-- ═══ EXCEPTIONS ═══════════════════════════════════════════════════════════
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH',
  'BANK_UNMATCHED','BANK_BOOK_NOT_IN_BANK',
  'TDS_PAN_MISSING','TDS_DEPOSIT_DUE','TDS_RETURN_DUE','TDS_26AS_MISMATCH','TDS_TAN_MISSING',
  'GST_GSTIN_MISSING','GST_CUSTOMER_GSTIN_MISSING','GST_RETURN_DUE','GST_ITC_INVOICE_MISSING','GST_DOC_ATTENTION','GST_BOOKS_MISMATCH',
  'PAYROLL_UNCONFIGURED','PAYROLL_BLOCKED','PAYROLL_KHATA_MISMATCH','PAYROLL_RUN_DUE','PAYROLL_FLOATING_ADVANCE','PAYROLL_MONTH_END_BLOCKED',
  'OCR_BACKLOG','OCR_JOB_FAILED']));
