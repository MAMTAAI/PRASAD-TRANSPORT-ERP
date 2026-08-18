-- ═══════════════════════════════════════════════════════════════════════════
-- 089_loan_accounting_by_year.sql — the four numbers an accountant posts.
--
-- v_loan_ledger_fy answers an operator's question: how many instalments, how
-- much cleared, what was still overdue at year end. An accountant needs a
-- narrower and stricter set, and needs it to tie to two places at once:
--
--     opening liability     what the balance sheet carried at 1 April
--   - principal repaid      the only part that moves the liability
--   = closing liability     what the balance sheet carries at 31 March
--     interest charged      NOT a repayment — a finance cost, into the P&L
--
-- ── PRINCIPAL AND INTEREST ARE DIFFERENT ACCOUNTS ──────────────────────────
-- That split is the whole point, and it is the thing the Firestore screens got
-- wrong for years: they wrote one bank row for the EMI total, so the books
-- could not tell a repayment from an expense and finance costs never appeared
-- in the P&L at all. On the 46-lakh chassis loans the difference is not
-- academic — FY 2022-23 is 2,94,713 of instalments of which 2,93,668 is
-- INTEREST, because the six moratorium EMIs barely cover their own interest.
-- Booked as principal, that year's profit is overstated by 2.9 lakh a truck.
--
-- ── THE LIABILITY IS THE SCHEDULE'S, NOT A RUNNING SUBTRACTION ─────────────
-- closing_liability comes from the instalment schedule's own closing balance
-- after that year's last instalment, not from opening minus principal repaid.
-- The two agree when everything is paid and they diverge when it is not, and it
-- is the schedule that says what the loan will owe — a missed instalment does
-- not reduce a liability, it just means it was not paid.
--
-- Where the two DO disagree, `unpaid_in_year` is the difference and it is
-- printed beside them rather than reconciled away.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_loan_accounting_fy AS
SELECT
  fy.loan_id,
  fy.loan_account_no,
  fy.vehicle_no,
  fy.financier,
  fy.loan_type,
  -- The account the balance sheet actually carries this under. The vehicle
  -- above is the system's detail; this is the line an auditor will find (088).
  'Vehicle Loans - ' || fy.financier              AS balance_sheet_account,
  'Interest on Vehicle Loans'                     AS finance_cost_account,
  fy.fy_start,
  fy.fy_label,
  fy.fy_from,
  fy.fy_to,
  fy.instalments,
  -- Opening = the previous year's closing. For the first year of a contract
  -- there is no previous year, so it is the amount financed.
  COALESCE(
    lag(fy.closing_principal) OVER (PARTITION BY fy.loan_id ORDER BY fy.fy_start),
    lm.principal_amt
  )::numeric(14,2)                                AS opening_liability,
  fy.principal                                    AS principal_repaid,
  fy.interest                                     AS interest_charged,
  fy.closing_principal                            AS closing_liability,
  fy.emi_due                                      AS emi_due,
  fy.cleared                                      AS emi_cleared,
  fy.unpaid_in_year,
  fy.overdue_interest                             AS penal_interest_accrued,
  fy.closing_arrears
FROM v_loan_ledger_fy fy
JOIN loan_master lm ON lm.id = fy.loan_id;

COMMENT ON VIEW v_loan_accounting_fy IS
  'Per loan per financial year: opening liability, principal repaid, interest '
  'charged and closing liability — the balance sheet movement and the P&L '
  'charge. Principal reduces the liability; interest is a finance cost and '
  'never touches it.';

-- The same thing summed for the firm, which is the level the balance sheet
-- carries it at.
CREATE OR REPLACE VIEW v_loan_accounting_fy_by_firm AS
SELECT
  financier,
  'Vehicle Loans - ' || financier                 AS balance_sheet_account,
  fy_start, fy_label, fy_from, fy_to,
  count(DISTINCT loan_id)::int                    AS loans,
  SUM(instalments)::int                           AS instalments,
  SUM(opening_liability)::numeric(14,2)           AS opening_liability,
  SUM(principal_repaid)::numeric(14,2)            AS principal_repaid,
  SUM(interest_charged)::numeric(14,2)            AS interest_charged,
  SUM(closing_liability)::numeric(14,2)           AS closing_liability,
  SUM(emi_due)::numeric(14,2)                     AS emi_due,
  SUM(emi_cleared)::numeric(14,2)                 AS emi_cleared,
  SUM(unpaid_in_year)::numeric(14,2)              AS unpaid_in_year,
  SUM(penal_interest_accrued)::numeric(14,2)      AS penal_interest_accrued,
  SUM(closing_arrears)::numeric(14,2)             AS closing_arrears
FROM v_loan_accounting_fy
GROUP BY financier, fy_start, fy_label, fy_from, fy_to;

-- Does the interest the schedule charges in a year match what was posted to
-- Interest on Vehicle Loans in the same year? They will not agree while EMIs
-- are posted in arrears — the point is that the gap is VISIBLE and dated,
-- rather than a P&L nobody can tie back to a contract.
CREATE OR REPLACE VIEW v_loan_interest_vs_gl AS
SELECT
  f.fy_label,
  f.fy_from,
  f.fy_to,
  SUM(f.interest_charged)::numeric(14,2)                       AS interest_per_schedule,
  COALESCE(gl.posted, 0)::numeric(14,2)                        AS interest_posted_to_gl,
  (SUM(f.interest_charged) - COALESCE(gl.posted, 0))::numeric(14,2) AS not_yet_posted
FROM v_loan_accounting_fy f
LEFT JOIN LATERAL (
  SELECT SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END) AS posted
    FROM v_ledger_entries_resolved e
   WHERE e.ledger_name = 'Interest on Vehicle Loans'
     AND e.entry_date >= f.fy_from AND e.entry_date <= f.fy_to
) gl ON true
GROUP BY f.fy_label, f.fy_from, f.fy_to, gl.posted;

COMMENT ON VIEW v_loan_interest_vs_gl IS
  'Finance cost the contracts charge in a year against what reached the P&L in '
  'the same year. A gap is expected while instalments are posted in arrears; it '
  'being visible and dated is the point.';

COMMIT;
