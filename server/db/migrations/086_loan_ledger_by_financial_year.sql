-- ═══════════════════════════════════════════════════════════════════════════
-- 086_loan_ledger_by_financial_year.sql — the same loan, read a year at a time.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- A 58-row statement shows every instalment and answers no question an
-- accountant actually asks at year end. "What did this truck's finance cost in
-- 2024-25" needs the interest for that year alone, and "what was owed on
-- 31-03-2025" needs the balance at a date the row list never prints.
--
-- The Indian financial year runs 1 April to 31 March, so instalment 8 (due
-- 11-04-2023) opens 2023-24 and instalment 7 (11-03-2023) closes 2022-23. These
-- loans start in September 2022 and mature in June 2027 — six financial years,
-- two of them part-years, and neither the first nor the last is twelve
-- instalments. Deriving the year from the DUE DATE is what makes that come out
-- right; deriving it from the payment date would put a February instalment
-- settled in May into the wrong year, and on these accounts that is the norm
-- rather than the exception.
--
-- ── ONE PAYMENT BOOK, EVERYWHERE ───────────────────────────────────────────
-- v_loan_ledger allocated receipts from loan_receipts alone — the lender's
-- ledger — which is right for a statement that has to reproduce what TATA
-- printed, and useless for the three IndusInd loans that have no lender ledger
-- at all. Their statement showed 4 instalments and no payments against them,
-- when the four EMIs were paid on the day they fell due and sit in emi_payments.
--
-- 079 already settled that question for the dashboard: one book per loan, the
-- lender's where there is one, ours where there is not, and never both.
-- v_loan_ledger now reads the same view, so the statement, the year summary and
-- the dashboard cannot disagree about whether an instalment was paid.
--
-- ── AND THE CONTRACT VALUE THE HEADER PRINTED AS A DASH ────────────────────
-- contract_value and interest_amt are NULL on all 29 loans: 074 added the
-- columns and the import writes them, but the import has not been re-run since.
-- They are not re-read from the PDFs — they are ARITHMETIC on figures already
-- held, and the same arithmetic the amortiser self-test asserts against the
-- printed contract:
--
--     contract value = every instalment the contract will collect
--     interest       = contract value - finance amount
--
-- 30,301 + 5x30,285 + 52x1,12,987 = 60,57,050, which is what TATA prints on
-- page one of 5004384745, and 60,57,050 - 46,00,000 = 14,57,050, its printed
-- Interest Amount. Computed from loan_emi_tiers, which came from the lender's
-- own contract change history.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. the effective payment stream, with an order ─────────────────────────
CREATE OR REPLACE VIEW v_loan_payments_effective AS
SELECT r.loan_id, r.cleared_date AS paid_on, r.amount,
       'LENDER_LEDGER'::text AS source, r.document_no AS reference,
       COALESCE(r.stmt_seq, 0) AS seq, r.id
  FROM loan_receipts r
UNION ALL
SELECT p.loan_id, p.payment_date, p.total_paid, 'OWN_BOOK', p.ref_no,
       COALESCE(p.instalment_no, 0), p.id
  FROM emi_payments p
 WHERE NOT EXISTS (SELECT 1 FROM loan_receipts r WHERE r.loan_id = p.loan_id);

COMMENT ON VIEW v_loan_payments_effective IS
  'One payment stream per loan, lender-first. Anything measuring what is still '
  'payable — the dashboard, the ledger statement, the year summary — must read '
  'this, never loan_receipts or emi_payments directly.';

-- ── 2. the ledger, on that stream ──────────────────────────────────────────
-- Dropped and rebuilt: it gains fy_start in the middle and CREATE OR REPLACE
-- can only append. Nothing in the schema depends on it — the ledger endpoint
-- selects from it at query time, which does not pin the shape.
DROP VIEW IF EXISTS v_loan_ledger_fy;
DROP VIEW IF EXISTS v_loan_ledger;

CREATE VIEW v_loan_ledger AS
WITH inst AS (
  SELECT i.id, i.loan_id, i.instalment_no, i.due_date, i.due_amount,
         i.principal_part, i.interest_part, i.closing_principal,
         i.raised_on, i.lender_running_dues, i.delay_days AS lender_delay_days,
         i.overdue_interest, i.document_no, i.source,
         SUM(i.due_amount) OVER (PARTITION BY i.loan_id ORDER BY i.instalment_no
                                 ROWS UNBOUNDED PRECEDING) AS cum_due
    FROM loan_instalments i
),
recv AS (
  SELECT e.loan_id, e.paid_on AS cleared_date, e.amount, e.reference AS document_no,
         e.seq, e.id,
         SUM(e.amount) OVER (PARTITION BY e.loan_id
                             ORDER BY e.paid_on, e.seq, e.id
                             ROWS UNBOUNDED PRECEDING) AS cum_recv
    FROM v_loan_payments_effective e
)
SELECT
  l.id                                   AS loan_id,
  l.loan_account_no,
  l.vehicle_no,
  l.bank_name                            AS financier,
  l.loan_type,
  l.company_name,
  i.instalment_no,
  i.due_date,
  i.due_amount,
  i.principal_part,
  i.interest_part,
  i.closing_principal,
  i.raised_on,
  i.source,
  c.cleared_date,
  c.document_no                          AS cleared_document_no,
  LEAST(i.due_amount,
        GREATEST(0::numeric, t.recv_total - (i.cum_due - i.due_amount)))::numeric(14,2)
                                         AS cleared_amount,
  CASE WHEN c.cleared_date IS NULL THEN NULL
       ELSE GREATEST(0, c.cleared_date - i.due_date) END
                                         AS delay_days,
  i.lender_delay_days,
  i.overdue_interest,
  i.lender_running_dues,
  (i.cum_due - d.recv_by_due)::numeric(14,2)  AS outstanding_after,
  i.cum_due::numeric(14,2)               AS cumulative_due,
  d.recv_by_due::numeric(14,2)           AS cumulative_received_by_due,
  -- The Indian financial year the instalment falls due in. April opens it.
  (CASE WHEN extract(month FROM i.due_date) >= 4
        THEN extract(year FROM i.due_date) ELSE extract(year FROM i.due_date) - 1 END)::int
                                         AS fy_start,
  CASE
    WHEN c.cleared_date IS NOT NULL AND c.cleared_date <= i.due_date THEN 'PAID'
    WHEN c.cleared_date IS NOT NULL                                  THEN 'PAID_LATE'
    WHEN t.recv_total > i.cum_due - i.due_amount                     THEN 'PART_PAID'
    WHEN i.due_date <= CURRENT_DATE                                  THEN 'OVERDUE'
    ELSE 'UPCOMING'
  END                                    AS status
FROM inst i
JOIN loan_master l ON l.id = i.loan_id
LEFT JOIN LATERAL (
  SELECT r.cleared_date, r.document_no
    FROM recv r
   WHERE r.loan_id = i.loan_id
     AND r.cum_recv >= i.cum_due - 0.005
   ORDER BY r.cleared_date, r.seq, r.id
   LIMIT 1
) c ON true
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(e.amount), 0) AS recv_by_due
    FROM v_loan_payments_effective e
   WHERE e.loan_id = i.loan_id AND e.paid_on <= i.due_date
) d
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(e.amount), 0) AS recv_total
    FROM v_loan_payments_effective e WHERE e.loan_id = i.loan_id
) t;

COMMENT ON VIEW v_loan_ledger IS
  'Every instalment of every loan, start to end, with the payment that cleared '
  'it derived FIFO from v_loan_payments_effective. cleared_amount < due_amount '
  'with no cleared_date means the money ran out inside this instalment.';

-- ── 3. the same loan, one row per financial year ───────────────────────────
CREATE VIEW v_loan_ledger_fy AS
SELECT
  g.loan_id, g.loan_account_no, g.vehicle_no, g.financier, g.loan_type,
  g.fy_start,
  (g.fy_start::text || '-' || right((g.fy_start + 1)::text, 2))  AS fy_label,
  make_date(g.fy_start, 4, 1)                                    AS fy_from,
  make_date(g.fy_start + 1, 3, 31)                               AS fy_to,
  g.instalments,
  g.first_instalment_no,
  g.last_instalment_no,
  g.emi_due,
  g.principal,
  g.interest,
  g.cleared,
  g.overdue_interest,
  (g.emi_due - g.cleared)::numeric(14,2)          AS unpaid_in_year,
  g.paid_on_time,
  g.paid_late,
  g.still_open,
  g.worst_delay_days,
  -- What was still owed when the year ended: everything demanded up to 31 March
  -- less everything received by then. The arrears an auditor reads off the
  -- closing date, not a running total that stops mid-year.
  fy.closing_arrears,
  -- And the principal balance the schedule says is left after the year's last
  -- instalment. NULL where the lender's rows carry no running balance.
  g.closing_principal
FROM (
  SELECT
    v.loan_id, v.loan_account_no, v.vehicle_no, v.financier, v.loan_type, v.fy_start,
    count(*)::int                                           AS instalments,
    min(v.instalment_no)                                    AS first_instalment_no,
    max(v.instalment_no)                                    AS last_instalment_no,
    SUM(v.due_amount)::numeric(14,2)                        AS emi_due,
    SUM(v.principal_part)::numeric(14,2)                    AS principal,
    SUM(v.interest_part)::numeric(14,2)                     AS interest,
    SUM(v.cleared_amount)::numeric(14,2)                    AS cleared,
    SUM(v.overdue_interest)::numeric(14,2)                  AS overdue_interest,
    count(*) FILTER (WHERE v.status = 'PAID')::int          AS paid_on_time,
    count(*) FILTER (WHERE v.status = 'PAID_LATE')::int     AS paid_late,
    count(*) FILTER (WHERE v.status IN ('OVERDUE','PART_PAID','UPCOMING'))::int AS still_open,
    COALESCE(max(v.delay_days), 0)                          AS worst_delay_days,
    (array_agg(v.closing_principal ORDER BY v.instalment_no DESC))[1] AS closing_principal
  FROM v_loan_ledger v
  GROUP BY v.loan_id, v.loan_account_no, v.vehicle_no, v.financier, v.loan_type, v.fy_start
) g
CROSS JOIN LATERAL (
  SELECT (
    COALESCE((SELECT SUM(i.due_amount) FROM loan_instalments i
               WHERE i.loan_id = g.loan_id AND i.due_date <= make_date(g.fy_start + 1, 3, 31)), 0)
  - COALESCE((SELECT SUM(e.amount) FROM v_loan_payments_effective e
               WHERE e.loan_id = g.loan_id AND e.paid_on <= make_date(g.fy_start + 1, 3, 31)), 0)
  )::numeric(14,2) AS closing_arrears
) fy;

COMMENT ON VIEW v_loan_ledger_fy IS
  'One row per loan per Indian financial year (1 Apr - 31 Mar), by DUE date. '
  'closing_arrears is what was owed on 31 March; unpaid_in_year is how much of '
  'that year''s own instalments the money never reached.';

-- ── 4. the contract value the header printed as a dash ─────────────────────
UPDATE loan_master l
   SET contract_value = t.total,
       interest_amt   = (t.total - l.principal_amt),
       updated_at     = now()
  FROM (SELECT loan_id,
               SUM(emi_amount * (to_instalment - from_instalment + 1))::numeric(14,2) AS total
          FROM loan_emi_tiers GROUP BY loan_id) t
 WHERE t.loan_id = l.id
   AND l.contract_value IS NULL
   AND l.principal_amt IS NOT NULL;

-- If the arithmetic does not hold, the tiers were misread and the figure must
-- not be shown as fact. There are none today.
CREATE OR REPLACE VIEW v_loan_contract_check AS
SELECT loan_account_no, vehicle_no, bank_name AS financier,
       principal_amt, interest_amt, contract_value,
       (principal_amt + interest_amt - contract_value)::numeric(14,2) AS mismatch
  FROM loan_master
 WHERE contract_value IS NOT NULL AND interest_amt IS NOT NULL
   AND abs(principal_amt + interest_amt - contract_value) > 1;

COMMIT;
