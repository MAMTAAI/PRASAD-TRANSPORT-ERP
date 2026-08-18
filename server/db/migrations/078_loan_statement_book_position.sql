-- ═══════════════════════════════════════════════════════════════════════════
-- 078_loan_statement_book_position.sql — do not print zero at a loan that owes
-- twenty lakh.
--
-- ── THE HOLE ───────────────────────────────────────────────────────────────
-- The opening balance in 075 is an ARREARS figure: instalments due before the
-- cut-off, less what was paid. On the 26 TATA loans that is exactly right, and
-- it reproduces the lender's own printed "Overdue Installment" to the rupee.
--
-- On the three IndusInd loans it produces 0.00, and 0.00 is a lie. Those three
-- were restructured in January 2024 and are classified NPA; IndusInd stopped
-- running them as a schedule of instalments and now bills a monthly interest
-- demand against a balance. Its statements arrive as PHOTOGRAPHS — the three
-- scanned files in the loan folder carry no machine-readable text at all — so
-- there is no per-instalment ledger to load and nothing falls due before the
-- cut-off. Arrears of zero, on 61.4 lakh of live debt.
--
-- ── WHAT THIS FIXES, AND WHAT IT DOES NOT ──────────────────────────────────
-- It does NOT invent instalments. The right answer to "we have no instalment
-- history for this loan" is to say so, not to model one and let it look like
-- evidence.
--
-- What it does is carry the BOOK position alongside the arrears position, so a
-- statement can print both and label them: `book_principal_outstanding` is the
-- opening liability struck into the general ledger by /loans/opening-balance
-- (from IndusInd's own stated POS for these three), and `has_ledger_history`
-- says plainly whether the arrears figure rests on any transactions at all.
--
-- Two different quantities, both true, neither one standing in for the other:
-- arrears are what is overdue, principal outstanding is what is owed.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

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
  -- What the books say is owed, as opposed to what is overdue.
  l.opening_remaining_principal AS book_principal_outstanding,
  l.opening_as_of               AS book_position_as_of,
  (SELECT max(due_date) FROM loan_instalments WHERE loan_id = l.id) AS maturity_date,
  (SELECT count(*)::int FROM loan_emi_tiers WHERE loan_id = l.id)   AS emi_tiers,
  (SELECT jsonb_agg(jsonb_build_object(
            'from_instalment', from_instalment, 'to_instalment', to_instalment,
            'emi_amount', emi_amount) ORDER BY from_instalment)
     FROM loan_emi_tiers WHERE loan_id = l.id)                      AS tiers,
  (SELECT count(*)::int FROM loan_instalments WHERE loan_id = l.id) AS instalments_total,
  (SELECT COALESCE(SUM(due_amount), 0)::numeric(14,2) FROM loan_instalments WHERE loan_id = l.id)
                                                                    AS total_demanded,
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
                                                                    AS from_lender_statement,
  -- Is there ANY transaction history behind this loan? Where there is not, an
  -- arrears figure of zero means "nothing recorded", not "nothing owed", and
  -- the statement has to say which.
  EXISTS (SELECT 1 FROM loan_receipts WHERE loan_id = l.id)         AS has_ledger_history
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
 WHERE h.instalments_raised > 0 AND tail.lender_running_dues IS NOT NULL;

COMMENT ON VIEW v_loan_ledger_health IS
  'drift <> 0 means the instalments the lender has RAISED, less the receipts it '
  'banked, do not come to the closing balance it printed. Future modelled '
  'instalments are excluded — they are not in the lender''s balance either.';

-- Which loans cannot support a ledger statement, and why. Three today: the
-- IndusInd NPAs, whose statements are photographs.
CREATE OR REPLACE VIEW v_loan_statement_coverage AS
SELECT loan_account_no, vehicle_no, financier, instalments_raised, receipts,
       book_principal_outstanding,
       CASE WHEN has_ledger_history THEN 'lender statement loaded'
            WHEN book_principal_outstanding > 0
              THEN 'no transaction history — arrears cannot be struck; use the book position'
            ELSE 'no transaction history and no book liability' END AS coverage
  FROM v_loan_statement_header;

COMMIT;
