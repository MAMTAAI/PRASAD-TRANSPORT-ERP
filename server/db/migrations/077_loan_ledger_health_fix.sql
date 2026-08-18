-- ═══════════════════════════════════════════════════════════════════════════
-- 077_loan_ledger_health_fix.sql — compare like with like.
--
-- v_loan_ledger_health as written in 075 reported 16 of 29 loans drifting by a
-- total of 1.78 crore, and every rupee of it was the view's own fault: it took
-- `total_demanded` — which counts ALL instalments, including the eleven the
-- lender has not raised yet — and subtracted receipts, then compared the result
-- to the lender's closing balance. The lender's balance only knows about
-- instalments it has actually billed. Eleven future EMIs of 1,12,987 come to
-- 12.4 lakh of "drift" on a loan that reconciles perfectly.
--
-- A health check that cries wolf on more than half the fleet is worse than none:
-- it trains everyone to ignore the one loan that is genuinely wrong. So the
-- comparison is now restricted to instalments the lender has raised, which is
-- the only set its closing balance describes.
--
-- The header view gains `raised_demanded` alongside `total_demanded` so the two
-- quantities can never be confused again by the next caller either. One is what
-- the contract will eventually collect; the other is what has been billed.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- CREATE OR REPLACE cannot insert a column in the middle of a view's output —
-- it can only append. Both views are dropped and rebuilt; nothing persists them
-- and no other object depends on them, so there is nothing to lose.
DROP VIEW IF EXISTS v_loan_ledger_health;
DROP VIEW IF EXISTS v_loan_statement_header;

CREATE VIEW v_loan_statement_header AS
SELECT
  l.id AS loan_id, l.loan_account_no, l.vehicle_no, l.bank_name AS financier,
  l.loan_type, l.company_name, l.owner_name,
  l.disbursal_date, l.first_emi_date, l.lead_period_days, l.moratorium_months,
  l.principal_amt, l.interest_amt, l.contract_value, l.tenure_months,
  l.instalment_count, l.rate_of_interest, l.printed_irr, l.statement_as_of,
  l.payment_status, l.financier_ledger,
  (SELECT max(due_date) FROM loan_instalments WHERE loan_id = l.id) AS maturity_date,
  (SELECT count(*)::int FROM loan_emi_tiers WHERE loan_id = l.id)   AS emi_tiers,
  (SELECT jsonb_agg(jsonb_build_object(
            'from_instalment', from_instalment, 'to_instalment', to_instalment,
            'emi_amount', emi_amount) ORDER BY from_instalment)
     FROM loan_emi_tiers WHERE loan_id = l.id)                      AS tiers,
  -- Every instalment of the contract, raised or not.
  (SELECT count(*)::int FROM loan_instalments WHERE loan_id = l.id) AS instalments_total,
  (SELECT COALESCE(SUM(due_amount), 0)::numeric(14,2) FROM loan_instalments WHERE loan_id = l.id)
                                                                    AS total_demanded,
  -- Only what the lender has actually billed. This is the figure its own
  -- closing balance is built from, and the only one it can be checked against.
  (SELECT count(*)::int FROM loan_instalments
    WHERE loan_id = l.id AND source = 'LENDER_STATEMENT')           AS instalments_raised,
  (SELECT COALESCE(SUM(due_amount), 0)::numeric(14,2) FROM loan_instalments
    WHERE loan_id = l.id AND source = 'LENDER_STATEMENT')           AS raised_demanded,
  (SELECT count(*)::int FROM loan_receipts WHERE loan_id = l.id)    AS receipts,
  (SELECT COALESCE(SUM(amount), 0)::numeric(14,2) FROM loan_receipts WHERE loan_id = l.id)
                                                                    AS total_received,
  (SELECT COALESCE(SUM(outstanding), 0)::numeric(14,2) FROM loan_charges
    WHERE loan_id = l.id AND is_penal)                              AS penal_outstanding,
  (SELECT COALESCE(SUM(overdue_interest), 0)::numeric(14,2) FROM loan_instalments
    WHERE loan_id = l.id)                                           AS overdue_interest_accrued,
  (SELECT bool_or(source = 'LENDER_STATEMENT') FROM loan_instalments WHERE loan_id = l.id)
                                                                    AS from_lender_statement
FROM loan_master l;

CREATE VIEW v_loan_ledger_health AS
SELECT h.loan_id, h.loan_account_no, h.vehicle_no, h.financier,
       h.raised_demanded, h.total_received,
       (h.raised_demanded - h.total_received)::numeric(14,2) AS walked_balance,
       tail.lender_running_dues                              AS lender_closing_balance,
       (h.raised_demanded - h.total_received - tail.lender_running_dues)::numeric(14,2)
                                                             AS drift,
       h.instalments_raised, h.instalments_total, h.instalment_count,
       h.instalments_total > COALESCE(h.instalment_count, h.instalments_total) AS over_term
  FROM v_loan_statement_header h
  LEFT JOIN LATERAL (
    SELECT lender_running_dues FROM loan_instalments
     WHERE loan_id = h.loan_id AND lender_running_dues IS NOT NULL
     ORDER BY instalment_no DESC LIMIT 1) tail ON true
 -- A loan with no statement loaded has nothing to check against, and reporting
 -- it as healthy would be as misleading as reporting it as broken.
 WHERE h.instalments_raised > 0 AND tail.lender_running_dues IS NOT NULL;

COMMENT ON VIEW v_loan_ledger_health IS
  'drift <> 0 means the instalments the lender has RAISED, less the receipts it '
  'banked, do not come to the closing balance it printed. Future modelled '
  'instalments are excluded — they are not in the lender''s balance either.';

COMMIT;
