-- ═══════════════════════════════════════════════════════════════════════════
-- 080_loan_emi_due_charge_bound.sql — an undated charge cannot be dragged into
-- the past either.
--
-- loan_emi_due() as written in 079 added every outstanding penal charge to the
-- payable no matter what p_through was asked for. At the default — the end of
-- the current month — that is right, and it is the whole reason the dashboard
-- figure includes 4.17 lakh of LPC the statement leaves out: there is no cut-off
-- in "what do we owe now", so an undated charge is unambiguously owed now.
--
-- Ask it for 01-01-2022 and it still answered 4,17,240.90 against zero
-- instalments — 24 loans reported as owing money two years before most of the
-- charges existed. The bound was applied to the instalments and the payments and
-- silently not to the charges.
--
-- The rule is the one the ledger statement already follows, applied here too:
--
--   dated charge    counted when charge_date <= p_through, like anything else.
--   undated charge  counted ONLY when the question is about now or later. A
--                   figure the lender states without a date cannot be placed on
--                   one side of a cut-off in the past, and guessing is what
--                   produces confident numbers that are wrong.
--
-- TATA states no date for any of them today, so in practice this is the whole
-- 4.17 lakh: in the dashboard's figure, out of any backdated one.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

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
    -- See the header. A dated charge obeys the bound; an undated one is only
    -- counted when the question is about the present.
    SELECT SUM(outstanding) AS penal
      FROM loan_charges c
     WHERE c.loan_id = l.id AND c.is_penal
       AND (
         (c.charge_date IS NOT NULL AND c.charge_date <= b.through)
         OR (c.charge_date IS NULL AND b.through >= CURRENT_DATE)
       )
  ) ch ON true
  WHERE COALESCE(l.payment_status, 'ACTIVE') <> 'CLOSED'
$$;

COMMENT ON FUNCTION loan_emi_due(date) IS
  'What is payable per loan: instalments due on or before p_through (default '
  'the end of the current month) that the money has not reached, plus penal '
  'charges. Payments come from v_loan_payments_effective — the lender''s ledger '
  'where there is one, our own posted EMIs where there is not. Undated penal '
  'charges count only when p_through is today or later; they cannot be placed '
  'before a cut-off in the past.';

COMMIT;
