-- ═══════════════════════════════════════════════════════════════════════════
-- 090_interest_before_the_books.sql — say WHY the earlier years show no
-- finance cost, before someone posts 2.05 crore of it.
--
-- v_loan_interest_vs_gl as written in 089 reports, for FY 2022-23 to 2025-26,
-- 2,05,74,900.19 of contract interest with nothing posted against it, under a
-- column called `not_yet_posted`. Read at face value that is an instruction to
-- journal two crore of finance cost into four closed years.
--
-- It is not a gap. Those instalments were paid over four years before this
-- system existed, on a lender's paper, and their whole effect — principal and
-- interest both — is inside the opening balance struck at 01-04-2026. Posting
-- them now would charge the P&L twice for interest that has already been borne
-- and would break the balance sheet by the same amount.
--
-- The only year where `not_yet_posted` means what it says is the current one,
-- where instalments are genuinely posted in arrears: 4,09,580.72 of 2026-27
-- interest that the contracts have charged and the EMI vouchers have not
-- reached yet, because those instalments have not been paid.
--
-- So the column is split. A figure that means two different things in two rows
-- of the same view is a figure that will be acted on wrongly in one of them.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- `not_yet_posted` is replaced rather than appended to, because leaving it in
-- place is the whole problem: a column that says "post this" beside one that
-- says "do not" gets read by whoever is in a hurry. CREATE OR REPLACE cannot
-- rename, so the view is dropped and rebuilt.
DROP VIEW IF EXISTS v_loan_interest_vs_gl;

CREATE VIEW v_loan_interest_vs_gl AS
WITH cutoff AS (
  -- The date the books took the loans over. One per fleet in practice; the min
  -- is taken so a loan opened later cannot drag the boundary forward and make
  -- an earlier year look postable.
  SELECT COALESCE(min(opening_as_of), DATE '2026-04-01') AS opened_on FROM loan_master
)
SELECT
  f.fy_label,
  f.fy_from,
  f.fy_to,
  SUM(f.interest_charged)::numeric(14,2)        AS interest_per_schedule,
  COALESCE(gl.posted, 0)::numeric(14,2)         AS interest_posted_to_gl,
  -- Before the cut-off the difference is history, not a liability to journal.
  CASE WHEN f.fy_to < c.opened_on THEN 0::numeric(14,2)
       ELSE (SUM(f.interest_charged) - COALESCE(gl.posted, 0))::numeric(14,2) END
                                                AS postable_gap,
  CASE WHEN f.fy_to < c.opened_on
       THEN (SUM(f.interest_charged) - COALESCE(gl.posted, 0))::numeric(14,2)
       ELSE 0::numeric(14,2) END                AS borne_before_the_books,
  f.fy_to < c.opened_on                         AS before_the_books,
  c.opened_on                                   AS books_opened_on,
  CASE WHEN f.fy_to < c.opened_on
       THEN 'paid before the books existed — inside the opening balance, do not post'
       WHEN SUM(f.interest_charged) - COALESCE(gl.posted, 0) > 1
       THEN 'instalments charged but not yet paid, so not yet posted'
       ELSE 'posted' END                        AS note
FROM v_loan_accounting_fy f
CROSS JOIN cutoff c
LEFT JOIN LATERAL (
  SELECT SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END) AS posted
    FROM v_ledger_entries_resolved e
   WHERE e.ledger_name = 'Interest on Vehicle Loans'
     AND e.entry_date >= f.fy_from AND e.entry_date <= f.fy_to
) gl ON true
GROUP BY f.fy_label, f.fy_from, f.fy_to, gl.posted, c.opened_on;

COMMENT ON VIEW v_loan_interest_vs_gl IS
  'Finance cost the contracts charge in a year against what reached the P&L. '
  'postable_gap is the only figure that may ever be journalled — interest on '
  'instalments already charged and not yet paid. borne_before_the_books is '
  'history absorbed by the opening balance; posting it would charge the P&L '
  'twice and break the balance sheet by the same amount.';

COMMIT;
