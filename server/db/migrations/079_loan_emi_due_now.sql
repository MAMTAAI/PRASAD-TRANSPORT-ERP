-- ═══════════════════════════════════════════════════════════════════════════
-- 079_loan_emi_due_now.sql — what is payable right now, as opposed to what is
-- owed altogether.
--
-- ── THE TWO QUESTIONS ARE NOT THE SAME QUESTION ────────────────────────────
-- The dashboard led with TOTAL BANK LIABILITY (ACTIVE PRINCIPAL) — 2.81 crore.
-- That number is true and useless on a Tuesday morning: nobody can act on it,
-- and it does not move when an EMI is paid or missed. What an operator needs at
-- the top of the screen is the payable: instalments already due and not yet
-- settled, plus the penal charges standing against them.
--
-- ── WHICH BOOK SAYS AN INSTALMENT WAS PAID ─────────────────────────────────
-- There are two, they do not agree, and getting this wrong invents or erases
-- lakhs:
--
--   loan_receipts   the LENDER's record — what TATA banked, on its dates.
--                   1,068 rows across 26 loans.
--   emi_payments    OUR record — what we posted to the GL, with a voucher.
--                   150 rows.
--
-- Summing both double-counts every TATA instalment, which is recorded in each.
-- Using only loan_receipts reports 16 lakh of arrears on the three IndusInd
-- loans, whose four instalments each were paid on the day they fell due and are
-- sitting in emi_payments — IndusInd sends photographs, so there is no lender
-- ledger for them and never will be.
--
-- So: ONE BOOK PER LOAN, and the lender's wins where it exists. That is the same
-- precedence the opening-balance import already follows — where a lender states
-- its own position, that figure is used and the model is not consulted.
-- v_loan_payments_effective is where that rule lives, once, so no caller can
-- pick the wrong one.
--
-- ── AND THE PENAL CHARGES GO IN ────────────────────────────────────────────
-- Unlike the ledger STATEMENT, this figure includes penal charges the lender
-- states without a date (4.17 lakh across the fleet). The statement excludes
-- them because a cut-off in the past cannot be applied to an undated figure.
-- Here there is no cut-off — the question is "what do we owe now" — and the
-- charge is unambiguously outstanding now. Same data, different question,
-- different answer, and both are stated rather than assumed.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Which book is authoritative for each loan ───────────────────────────
CREATE OR REPLACE VIEW v_loan_payment_source AS
SELECT l.id AS loan_id, l.loan_account_no,
       CASE
         WHEN EXISTS (SELECT 1 FROM loan_receipts r WHERE r.loan_id = l.id)
           THEN 'LENDER_LEDGER'
         WHEN EXISTS (SELECT 1 FROM emi_payments p WHERE p.loan_id = l.id)
           THEN 'OWN_BOOK'
         ELSE 'NONE'
       END AS evidence
  FROM loan_master l;

COMMENT ON VIEW v_loan_payment_source IS
  'Which record of payment counts for a loan. The lender''s ledger where there '
  'is one; our own posted EMIs where there is not. Never both — that double-'
  'counts every instalment recorded in each.';

-- ── 2. Every payment, from the book that counts ────────────────────────────
CREATE OR REPLACE VIEW v_loan_payments_effective AS
SELECT r.loan_id, r.cleared_date AS paid_on, r.amount,
       'LENDER_LEDGER'::text AS source, r.document_no AS reference
  FROM loan_receipts r
UNION ALL
SELECT p.loan_id, p.payment_date, p.total_paid, 'OWN_BOOK', p.ref_no
  FROM emi_payments p
 WHERE NOT EXISTS (SELECT 1 FROM loan_receipts r WHERE r.loan_id = p.loan_id);

COMMENT ON VIEW v_loan_payments_effective IS
  'One payment stream per loan, lender-first. Anything measuring what is still '
  'payable must read this, not loan_receipts or emi_payments directly.';

-- ── 3. What is payable, per loan ───────────────────────────────────────────
-- p_through defaults to the END of the current month, because "current and
-- overdue" includes the instalment that falls due later this month — an EMI due
-- on the 24th is this month's problem on the 3rd, not next month's.
CREATE OR REPLACE FUNCTION loan_emi_due(p_through date DEFAULT NULL)
RETURNS TABLE (
  loan_id                uuid,
  loan_account_no        text,
  vehicle_no             text,
  financier              text,
  loan_type              text,
  payment_status         text,
  through_date           date,
  instalments_due        integer,
  instalments_unpaid     integer,
  emi_due                numeric(14,2),
  emi_paid               numeric(14,2),
  emi_unpaid             numeric(14,2),
  penal_unpaid           numeric(14,2),
  total_payable          numeric(14,2),
  oldest_unpaid_due_date date,
  days_overdue           integer,
  evidence               text,
  principal_outstanding  numeric(14,2)
)
LANGUAGE sql STABLE AS $$
  WITH bound AS (
    SELECT COALESCE(p_through,
                    (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date
           ) AS through
  )
  SELECT
    l.id, l.loan_account_no, l.vehicle_no, l.bank_name, l.loan_type, l.payment_status,
    b.through,
    COALESCE(d.n, 0)::integer,
    -- How many of them the money has not reached. Cumulative, in due order:
    -- an instalment is unpaid until everything before it has been covered too,
    -- which is the same first-in-first-out rule the ledger statement applies.
    COALESCE(d.n, 0)::integer - COALESCE(cov.covered, 0)::integer,
    COALESCE(d.due, 0)::numeric(14,2),
    LEAST(COALESCE(p.paid, 0), COALESCE(d.due, 0))::numeric(14,2),
    GREATEST(0, COALESCE(d.due, 0) - COALESCE(p.paid, 0))::numeric(14,2),
    COALESCE(ch.penal, 0)::numeric(14,2),
    (GREATEST(0, COALESCE(d.due, 0) - COALESCE(p.paid, 0)) + COALESCE(ch.penal, 0))::numeric(14,2),
    cov.oldest_unpaid,
    CASE WHEN cov.oldest_unpaid IS NULL THEN NULL
         ELSE GREATEST(0, (CURRENT_DATE - cov.oldest_unpaid))::integer END,
    src.evidence,
    l.opening_remaining_principal
  FROM loan_master l
  CROSS JOIN bound b
  JOIN v_loan_payment_source src ON src.loan_id = l.id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, SUM(due_amount) AS due
      FROM loan_instalments i
     WHERE i.loan_id = l.id AND i.due_date <= b.through
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT SUM(amount) AS paid
      FROM v_loan_payments_effective e
     WHERE e.loan_id = l.id AND e.paid_on <= b.through
  ) p ON true
  LEFT JOIN LATERAL (
    -- Walk the instalments in due order and find the first one the cumulative
    -- money does not reach. Everything from there on is unpaid.
    SELECT count(*) FILTER (WHERE cum_due <= COALESCE(p.paid, 0))::int AS covered,
           min(due_date) FILTER (WHERE cum_due > COALESCE(p.paid, 0))  AS oldest_unpaid
      FROM (
        SELECT i.due_date,
               SUM(i.due_amount) OVER (ORDER BY i.instalment_no
                                       ROWS UNBOUNDED PRECEDING) AS cum_due
          FROM loan_instalments i
         WHERE i.loan_id = l.id AND i.due_date <= b.through
      ) w
  ) cov ON true
  LEFT JOIN LATERAL (
    SELECT SUM(outstanding) AS penal
      FROM loan_charges c
     WHERE c.loan_id = l.id AND c.is_penal
  ) ch ON true
  WHERE COALESCE(l.payment_status, 'ACTIVE') <> 'CLOSED'
$$;

COMMENT ON FUNCTION loan_emi_due(date) IS
  'What is payable per loan: instalments due on or before p_through (default '
  'the end of the current month) that the money has not reached, plus penal '
  'charges outstanding. Payments come from v_loan_payments_effective — the '
  'lender''s ledger where there is one, our own posted EMIs where there is not.';

-- The dashboard's figure. A view so the screen does not have to know the
-- default, and a function underneath so a different month can still be asked for.
CREATE OR REPLACE VIEW v_loan_emi_due AS SELECT * FROM loan_emi_due(NULL);

CREATE OR REPLACE VIEW v_loan_emi_due_summary AS
SELECT
  max(through_date)                                    AS through_date,
  count(*)::int                                        AS active_loans,
  count(*) FILTER (WHERE total_payable > 0)::int       AS loans_with_dues,
  SUM(instalments_unpaid)::int                         AS instalments_unpaid,
  SUM(emi_unpaid)::numeric(14,2)                       AS emi_unpaid,
  SUM(penal_unpaid)::numeric(14,2)                     AS penal_unpaid,
  SUM(total_payable)::numeric(14,2)                    AS total_payable,
  max(days_overdue)                                    AS worst_days_overdue,
  min(oldest_unpaid_due_date)                          AS oldest_unpaid_due_date,
  SUM(principal_outstanding)::numeric(14,2)            AS principal_outstanding,
  count(*) FILTER (WHERE evidence = 'NONE')::int       AS loans_without_payment_history
  FROM v_loan_emi_due;

COMMENT ON VIEW v_loan_emi_due_summary IS
  'Fleet total for the dashboard: what is payable now. principal_outstanding is '
  'carried alongside as the secondary figure — it is what is owed, not what is '
  'due, and the two must never be shown as the same thing.';

COMMIT;
