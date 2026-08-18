-- ═══════════════════════════════════════════════════════════════════════════
-- 085_closed_means_the_lender_says_so.sql — a loan is not closed because the
-- MODEL ran out of principal.
--
-- ── THE MISTAKE 083 MADE ───────────────────────────────────────────────────
-- 083 moved the counters and, following the rule /loans/:id/emi already used,
-- closed any loan whose remaining principal reached zero. Nine did. All nine
-- were wrong, and the effect was to hide money:
--
--     5004396017  AS 26C 9815   model: principal repaid, CLOSED
--                               TATA:  57,686.00 still outstanding
--     5004389915  AS 26C 9808   model: principal repaid, CLOSED
--                               TATA:  28,843.00 outstanding + 27,741.80 penal
--
-- 4,32,645.00 of instalments the lender is still demanding, and 83,367.00 of
-- penal charges, dropped straight out of the dashboard's payable — because
-- loan_emi_due excludes CLOSED loans, and closing them was the last step.
--
-- ── WHY THE TWO DISAGREE, AND WHO WINS ─────────────────────────────────────
-- opening_remaining_principal is MODELLED — the amortiser's principal balance
-- at the cut-off. Reaching zero means the modelled principal has been repaid.
-- It says nothing about the interest in the final instalments, nothing about
-- arrears, and nothing about penal charges. These body loans are at instalment
-- 47 of 47 with two instalments unpaid: principal exhausted, money still owed.
--
-- The lender wins, as everywhere else in this subsystem. A loan is CLOSED when
-- the party that will repossess the truck says there is nothing left to pay.
--
--   with a lender ledger   raised - received <= 10 AND no penal outstanding
--                          AND every contracted instalment has been raised
--   without one            fall back to the modelled principal, because it is
--                          the only evidence there is (the three IndusInd NPAs)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── put back what 083 closed in error ──────────────────────────────────────
UPDATE loan_master l
   SET payment_status = 'ACTIVE', updated_at = now()
  FROM v_loan_statement_header h
 WHERE h.loan_id = l.id
   AND l.payment_status = 'CLOSED'
   AND (h.raised_demanded - h.total_received > 10 OR h.penal_outstanding > 10);

-- ── and close only what the evidence closes ────────────────────────────────
UPDATE loan_master l
   SET payment_status = 'CLOSED', updated_at = now()
  FROM v_loan_statement_header h
 WHERE h.loan_id = l.id
   AND l.payment_status <> 'CLOSED'
   AND h.instalments_raised > 0
   AND h.raised_demanded - h.total_received <= 10
   AND COALESCE(h.penal_outstanding, 0) <= 10
   AND h.instalments_raised >= COALESCE(h.instalment_count, h.instalments_raised);

-- Loans with no lender ledger keep the modelled test — it is all they have.
UPDATE loan_master l
   SET payment_status = 'CLOSED', updated_at = now()
 WHERE l.payment_status <> 'CLOSED'
   AND COALESCE(l.remaining_principal, 0) <= 10
   AND NOT EXISTS (SELECT 1 FROM loan_receipts r WHERE r.loan_id = l.id);

-- ── the dashboard's secondary figure follows the moved counter ─────────────
-- loan_emi_due reported opening_remaining_principal, because when it was
-- written that was the only principal figure anyone could trust — the live
-- counter had never been moved. 083 moved it and v_loan_reconciliation now
-- shows zero drift on all 29, so the live figure is the one to show. The
-- opening is 2.81 crore and stopped being true in April.
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
    l.remaining_principal
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
       AND (
         (c.charge_date IS NOT NULL AND c.charge_date <= b.through)
         OR (c.charge_date IS NULL AND b.through >= CURRENT_DATE)
       )
  ) ch ON true
  WHERE COALESCE(l.payment_status, 'ACTIVE') <> 'CLOSED'
$$;

-- What a closed loan is closed on, so the decision can be audited rather than
-- taken on trust.
CREATE OR REPLACE VIEW v_loan_closure_check AS
SELECT l.loan_account_no, l.vehicle_no, l.bank_name AS financier, l.payment_status,
       l.remaining_principal,
       h.raised_demanded, h.total_received,
       (h.raised_demanded - h.total_received)::numeric(14,2) AS lender_outstanding,
       h.penal_outstanding, h.instalments_raised, h.instalment_count,
       CASE
         WHEN h.instalments_raised = 0 THEN 'no lender ledger — modelled principal is the only evidence'
         WHEN h.raised_demanded - h.total_received > 10 THEN 'lender still demands payment'
         WHEN COALESCE(h.penal_outstanding, 0) > 10 THEN 'penal charges outstanding'
         WHEN h.instalments_raised < COALESCE(h.instalment_count, h.instalments_raised)
           THEN 'instalments still to be raised'
         ELSE 'settled'
       END AS closure_basis
  FROM loan_master l
  JOIN v_loan_statement_header h ON h.loan_id = l.id;

COMMENT ON VIEW v_loan_closure_check IS
  'A loan marked CLOSED whose closure_basis is not "settled" is wrong: the '
  'lender is still owed. Modelled principal reaching zero does not close a '
  'loan — it means the amortiser ran out, not that the debt did.';

COMMIT;
