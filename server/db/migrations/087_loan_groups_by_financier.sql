-- ═══════════════════════════════════════════════════════════════════════════
-- 087_loan_groups_by_financier.sql — the fleet's debt, one lender at a time.
--
-- ── WHY A GROUP IS A REAL THING HERE ───────────────────────────────────────
-- Twenty-six of these loans are TATA Capital's and three are IndusInd's, and
-- almost every decision is taken against the LENDER, not the truck: one RTGS
-- settles thirteen trucks at once, one statement arrives covering twenty-seven
-- contracts, one relationship manager asks why last month was late. A screen
-- that can only show one contract at a time makes the operator add up thirteen
-- of them by hand to answer a question the lender asked about all of them.
--
-- ── AND THE TWO GROUPS ARE NOT THE SAME KIND OF DEBT ───────────────────────
-- That is the other reason to keep them apart rather than showing one fleet
-- total. TATA's twenty-six run to a contractual schedule and its own statement
-- reconciles to the rupee. IndusInd's three were restructured in January 2024,
-- are classified NPA, and arrive as photographs — no instalment ledger, no
-- reconcilable arrears, and the only figure anyone can stand behind is the book
-- position. Averaged into a single number those three quietly poison it.
--
-- So every rollup here carries `loans_with_ledger` beside its totals, and a
-- group where that is short of `loans` is telling you which part of its own
-- figure is modelled rather than read off a lender's paper.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. the group, as it stands today ───────────────────────────────────────
CREATE OR REPLACE VIEW v_loan_financier_summary AS
SELECT
  h.financier,
  count(*)::int                                             AS loans,
  count(*) FILTER (WHERE l.payment_status <> 'CLOSED')::int  AS active_loans,
  count(*) FILTER (WHERE h.instalments_raised > 0)::int      AS loans_with_ledger,
  count(DISTINCT h.vehicle_no)::int                          AS vehicles,
  SUM(h.principal_amt)::numeric(14,2)                        AS financed,
  SUM(h.interest_amt)::numeric(14,2)                         AS contracted_interest,
  SUM(h.contract_value)::numeric(14,2)                       AS contract_value,
  SUM(l.remaining_principal)::numeric(14,2)                  AS principal_outstanding,
  SUM(h.total_demanded)::numeric(14,2)                       AS total_demanded,
  SUM(h.raised_demanded)::numeric(14,2)                      AS raised_demanded,
  SUM(h.total_received)::numeric(14,2)                       AS total_received,
  SUM(h.penal_outstanding)::numeric(14,2)                    AS penal_outstanding,
  SUM(h.overdue_interest_accrued)::numeric(14,2)             AS overdue_interest_accrued,
  min(h.disbursal_date)                                      AS first_disbursal,
  max(h.maturity_date)                                       AS last_maturity,
  -- What the group is payable RIGHT NOW, from the same function the dashboard
  -- reads. Recomputed here rather than re-derived, so a group total and the
  -- headline card cannot drift apart.
  COALESCE(SUM(dd.total_payable), 0)::numeric(14,2)          AS payable_now,
  COALESCE(SUM(dd.emi_unpaid), 0)::numeric(14,2)             AS emi_unpaid_now,
  COALESCE(SUM(dd.instalments_unpaid), 0)::int               AS instalments_unpaid_now,
  max(dd.days_overdue)                                       AS worst_days_overdue
FROM v_loan_statement_header h
JOIN loan_master l ON l.id = h.loan_id
LEFT JOIN loan_emi_due(NULL) dd ON dd.loan_id = h.loan_id
GROUP BY h.financier;

COMMENT ON VIEW v_loan_financier_summary IS
  'One row per finance company. loans_with_ledger short of loans means part of '
  'this group''s figure is modelled, not read from a lender statement — the '
  'three IndusInd NPAs, which arrive as photographs.';

-- ── 2. the group, year by year ─────────────────────────────────────────────
CREATE OR REPLACE VIEW v_loan_fy_by_financier AS
SELECT
  fy.financier,
  fy.fy_start,
  fy.fy_label,
  fy.fy_from,
  fy.fy_to,
  count(DISTINCT fy.loan_id)::int          AS loans,
  SUM(fy.instalments)::int                 AS instalments,
  SUM(fy.emi_due)::numeric(14,2)           AS emi_due,
  SUM(fy.principal)::numeric(14,2)         AS principal,
  SUM(fy.interest)::numeric(14,2)          AS interest,
  SUM(fy.cleared)::numeric(14,2)           AS cleared,
  SUM(fy.unpaid_in_year)::numeric(14,2)    AS unpaid_in_year,
  SUM(fy.overdue_interest)::numeric(14,2)  AS overdue_interest,
  SUM(fy.closing_arrears)::numeric(14,2)   AS closing_arrears,
  SUM(fy.closing_principal)::numeric(14,2) AS closing_principal,
  SUM(fy.paid_on_time)::int                AS paid_on_time,
  SUM(fy.paid_late)::int                   AS paid_late,
  SUM(fy.still_open)::int                  AS still_open,
  max(fy.worst_delay_days)                 AS worst_delay_days
FROM v_loan_ledger_fy fy
GROUP BY fy.financier, fy.fy_start, fy.fy_label, fy.fy_from, fy.fy_to;

COMMENT ON VIEW v_loan_fy_by_financier IS
  'A finance company''s whole book, one Indian financial year per row. Interest '
  'here is the group''s finance cost for that year; closing_arrears is what it '
  'was owed on 31 March.';

-- ── 3. the whole fleet, year by year ───────────────────────────────────────
-- Both lenders together, for the year in which someone wants one number. Kept
-- as its own view rather than a "TOTAL" row inside the one above, so nothing
-- can sum a total row into a total by accident.
CREATE OR REPLACE VIEW v_loan_fy_all AS
SELECT
  fy.fy_start, fy.fy_label, fy.fy_from, fy.fy_to,
  count(DISTINCT fy.financier)::int        AS financiers,
  count(DISTINCT fy.loan_id)::int          AS loans,
  SUM(fy.instalments)::int                 AS instalments,
  SUM(fy.emi_due)::numeric(14,2)           AS emi_due,
  SUM(fy.principal)::numeric(14,2)         AS principal,
  SUM(fy.interest)::numeric(14,2)          AS interest,
  SUM(fy.cleared)::numeric(14,2)           AS cleared,
  SUM(fy.unpaid_in_year)::numeric(14,2)    AS unpaid_in_year,
  SUM(fy.overdue_interest)::numeric(14,2)  AS overdue_interest,
  SUM(fy.closing_arrears)::numeric(14,2)   AS closing_arrears,
  SUM(fy.closing_principal)::numeric(14,2) AS closing_principal
FROM v_loan_ledger_fy fy
GROUP BY fy.fy_start, fy.fy_label, fy.fy_from, fy.fy_to;

COMMIT;
