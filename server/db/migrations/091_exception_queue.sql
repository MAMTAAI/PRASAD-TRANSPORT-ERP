-- ═══════════════════════════════════════════════════════════════════════════
-- 091_exception_queue.sql — the things the system refused to guess at, in one
-- place, with the evidence a person needs to decide.
--
-- ── WHY THIS TABLE EXISTS ──────────────────────────────────────────────────
-- The ERP is careful about refusing rather than guessing, and that care has
-- been going nowhere. The AC5 loader rejects a file and writes a COUNT to a log.
-- The IOCL matcher parks an AMBIGUOUS row in a view nobody opens. The loan
-- statement importer skips a contract and returns it in an HTTP response that
-- was read once. Every one of those is a real decision waiting for a human, and
-- every one of them is invisible until somebody goes looking.
--
-- Two of this week's findings are exactly that shape and neither was raised by
-- anything:
--
--   * an LPG unit missing from one regex rejected every LPG invoice for three
--     weeks. Ten loads never reached the register. The log said "rejected: 116"
--     every fifteen minutes.
--   * one LR, 193660536, is on bill INV-IND-7B03-0012 TWICE — 1,28,664.29
--     charged to Indian Oil for a single load, with two different drivers
--     against it. It has been sitting there since 16-08.
--
-- Neither is a bug to fix in code. Both need somebody to look at a piece of
-- paper. This is where they wait.
--
-- ── WHAT MAKES IT DIFFERENT FROM A LOG ─────────────────────────────────────
-- 1. DEDUPLICATED. `dedupe_key` is unique, so a detector that runs every
--    fifteen minutes raises an exception once and then updates it, rather than
--    printing the same line ninety-six times a day until it is noise.
-- 2. IT CARRIES THE EVIDENCE. `evidence` holds the facts — both trip codes,
--    both drivers, the bill, the amount — so the reviewer does not have to
--    reconstruct the query that found it.
-- 3. IT NAMES THE MONEY. `amount_at_risk` is what sorts this queue. An
--    exception worth 1.28 lakh outranks a misparsed vehicle number.
-- 4. IT OFFERS SPECIFIC CHOICES. `options` is what the resolve button renders.
--    A queue that says "something is wrong" and leaves the operator to invent
--    the fix is a log with a nicer font.
--
-- ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
-- Not an approval queue. `expense_approvals` and `v_approval_queue` (061) are
-- maker-checker: a person proposed something and another must agree. This is
-- the opposite — the SYSTEM found something it will not decide, and needs a
-- person to. Keeping them apart matters because their inboxes are different
-- people on different days.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What kind of problem. Deliberately a text with a CHECK rather than an enum:
  -- a new detector should be one INSERT and one line here, not a type migration
  -- that locks the table.
  kind          text NOT NULL CHECK (kind IN (
                  'DUPLICATE_BILLING',     -- one consignment billed twice
                  'DRIVER_MISMATCH',       -- same load, two drivers on record
                  'PARSER_REJECT',         -- a document the parser could not read
                  'UNMATCHED_TRIP',        -- lender/customer doc with no trip
                  'AMOUNT_MISMATCH',       -- two sources disagree about money
                  'LEDGER_DRIFT',          -- a book and its control total differ
                  'MISSING_MASTER',        -- a vehicle/party the masters lack
                  'OTHER')),

  severity      text NOT NULL DEFAULT 'MEDIUM'
                CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),

  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED')),

  title         text NOT NULL,
  detail        text,

  -- What it is about, loosely typed on purpose: an exception may concern a
  -- trip, a bill, a loan or a PDF that is not a row anywhere yet.
  subject_type  text,
  subject_id    text,
  company       text,

  -- The facts, so the reviewer does not have to re-run the query that found it.
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- What the resolve button offers. Each entry is
  --   { "action": "...", "label": "...", "params": {...}, "destructive": bool }
  options       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Sorts the queue. Nothing else can: an exception is not urgent because it is
  -- old, it is urgent because of what it costs.
  amount_at_risk numeric(14,2),

  -- Raise once, update thereafter. A detector on a fifteen-minute cron would
  -- otherwise fill this table faster than anyone could read it.
  dedupe_key    text NOT NULL,

  detected_by   text NOT NULL DEFAULT 'system',
  detected_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seen_count    integer NOT NULL DEFAULT 1,

  resolution        text,
  resolution_note   text,
  resolved_by       text,
  resolved_at       timestamptz,
  -- What the resolution actually did, for the audit trail: voucher ids, rows
  -- removed, amounts moved.
  resolution_result jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT resolved_has_who CHECK (
    status NOT IN ('RESOLVED', 'DISMISSED')
    OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS exceptions_dedupe_uniq ON exceptions (dedupe_key);
CREATE INDEX IF NOT EXISTS exceptions_open_idx
  ON exceptions (status, severity, amount_at_risk DESC NULLS LAST)
  WHERE status IN ('OPEN', 'IN_REVIEW');
CREATE INDEX IF NOT EXISTS exceptions_subject_idx ON exceptions (subject_type, subject_id);

DROP TRIGGER IF EXISTS exceptions_touch ON exceptions;
CREATE TRIGGER exceptions_touch BEFORE UPDATE ON exceptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE exceptions IS
  'Things the system found and will not decide. Raised once per dedupe_key and '
  'updated thereafter; carries the evidence and the specific choices a reviewer '
  'has, so resolving one does not start with reconstructing it.';
COMMENT ON COLUMN exceptions.amount_at_risk IS
  'What is wrong in rupees. This sorts the queue — an exception is urgent '
  'because of what it costs, not because of how old it is.';
COMMENT ON COLUMN exceptions.options IS
  'What the resolve button renders. A queue that says "something is wrong" and '
  'leaves the operator to invent the fix is a log with a nicer font.';

-- ── the queue, ready to render ─────────────────────────────────────────────
CREATE OR REPLACE VIEW v_exception_queue AS
SELECT e.*,
       (now() - e.detected_at)                                   AS age,
       EXTRACT(DAY FROM (now() - e.detected_at))::int            AS age_days,
       CASE e.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
                       WHEN 'MEDIUM' THEN 3 ELSE 4 END           AS severity_rank
  FROM exceptions e
 WHERE e.status IN ('OPEN', 'IN_REVIEW');

CREATE OR REPLACE VIEW v_exception_summary AS
SELECT kind, status, severity,
       count(*)::int                                    AS n,
       COALESCE(SUM(amount_at_risk), 0)::numeric(14,2)  AS amount_at_risk,
       min(detected_at)                                 AS oldest
  FROM exceptions
 GROUP BY kind, status, severity;

-- ── detector: one consignment billed twice ─────────────────────────────────
-- An LR number is one consignment. Two lines on one bill carrying the same LR
-- is the customer being charged twice for a single load, and it is worth
-- exactly the smaller of the two lines.
--
-- A VIEW, not a scheduled job that writes rows: the truth is derivable at any
-- moment, and a detector that stores its own copy has to be kept in step with
-- the thing it watches. The raise step below reads this.
CREATE OR REPLACE VIEW v_duplicate_billing_candidates AS
SELECT
  b.id                                          AS bill_id,
  b.bill_no,
  b.bill_date,
  b.customer_name,
  b.company,
  b.status                                      AS bill_status,
  b.approval_status,
  b.is_locked,
  COALESCE(b.received_amount, 0)                AS received_amount,
  cbt.lr_no,
  count(*)::int                                 AS lines,
  SUM(cbt.net_payable)::numeric(14,2)           AS billed_net,
  -- One load should have been billed once. Everything past the first line is
  -- the overcharge.
  (SUM(cbt.net_payable) - MAX(cbt.net_payable))::numeric(14,2) AS overcharge,
  jsonb_agg(jsonb_build_object(
    'bill_line_id',  cbt.id,
    'trip_id',       cbt.trip_id,
    'trip_code',     cbt.trip_code,
    'driver_name',   cbt.driver_name,
    'vehicle_no',    cbt.vehicle_no,
    'loading_date',  cbt.loading_date,
    'qty',           cbt.qty,
    'gross_freight', cbt.gross_freight,
    'net_payable',   cbt.net_payable
  ) ORDER BY cbt.id)                            AS lines_detail
FROM company_bill_trips cbt
JOIN company_bills b ON b.id = cbt.bill_id
WHERE cbt.lr_no IS NOT NULL AND cbt.lr_no <> ''
GROUP BY b.id, b.bill_no, b.bill_date, b.customer_name, b.company, b.status,
         b.approval_status, b.is_locked, b.received_amount, cbt.lr_no
HAVING count(*) > 1;

COMMENT ON VIEW v_duplicate_billing_candidates IS
  'One LR on more than one line of the same bill: a consignment charged twice. '
  'overcharge is everything past the first line.';

COMMIT;
