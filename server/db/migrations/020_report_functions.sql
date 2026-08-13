-- ═══════════════════════════════════════════════════════════════════════════
-- 020_report_functions.sql — date- and company-bounded reports
--
-- v_trial_balance / v_profit_and_loss / v_balance_sheet answer "all of time,
-- all companies". Every reporting screen asks a narrower question: this
-- fortnight, this operating company. Filtering the views in the API would mean
-- reimplementing their aggregation in a route, and two definitions of profit
-- drift apart — so the bounded forms live here, next to the views they mirror.
--
-- The company filter cannot be an equality test. The same firm is spelled five
-- ways in the imported data ('PRASAD TRANSPORT', 'M/S PRASAD TRANSPORT', …) and
-- 616 of 910 ledger entries carry no company at all. An `=` filter silently
-- drops all of them, which is how a report comes back looking empty rather than
-- looking wrong. norm_company/company_matches port the rules already used by
-- the front end (src/lib/company.ts) into SQL, so both sides agree: unspelled
-- or 'ALL' rows are never hidden.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Company-name normalizer (mirror of src/lib/company.ts normCompany) ──────
-- Step order matters and matches the TypeScript: punctuation is stripped first,
-- so 'PVT. LTD.' has already become 'PVT LTD' by the time that rule applies.
CREATE OR REPLACE FUNCTION norm_company(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  WITH s1 AS (SELECT regexp_replace(upper(COALESCE(v, '')), '[.,()]', ' ', 'g') AS t),
       s2 AS (SELECT regexp_replace(t, '\yM\s*/\s*S\y',        ' ', 'g') AS t FROM s1),
       s3 AS (SELECT regexp_replace(t, '\yPVT\.?\s*LTD\.?\y',  ' ', 'g') AS t FROM s2),
       s4 AS (SELECT regexp_replace(t, '\yPRIVATE\s+LIMITED\y',' ', 'g') AS t FROM s3)
  SELECT btrim(regexp_replace(t, '\s+', ' ', 'g')) FROM s4
$fn$;

COMMENT ON FUNCTION norm_company(text) IS
  'Normalizes an operating-company name for cross-module matching. Keep in step with src/lib/company.ts.';

-- Filter semantics: a blank/ALL selector matches everything, and a row with no
-- company (or 'ALL') is shown under every selector rather than dropped.
CREATE OR REPLACE FUNCTION company_matches(record_val text, filter_val text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
           WHEN norm_company(filter_val) IN ('', 'ALL') THEN true
           WHEN norm_company(record_val) IN ('', 'ALL') THEN true
           ELSE norm_company(record_val) = norm_company(filter_val)
         END
$fn$;

-- ── Trial balance ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION f_trial_balance(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_company text DEFAULT NULL)
RETURNS TABLE (group_head text, account_type text, statement text, sort_order int,
               dr numeric, cr numeric, dr_voucher_era numeric, cr_voucher_era numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT g.group_head, g.account_type, g.statement, g.sort_order,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR' AND NOT e.is_legacy), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR' AND NOT e.is_legacy), 0)::numeric(14,2)
    FROM account_groups g
    LEFT JOIN v_ledger_entries_resolved e
           ON e.group_head = g.group_head
          AND (p_from    IS NULL OR e.entry_date >= p_from)
          AND (p_to      IS NULL OR e.entry_date <= p_to)
          AND (p_company IS NULL OR company_matches(e.company, p_company))
   GROUP BY g.group_head, g.account_type, g.statement, g.sort_order
   ORDER BY g.sort_order
$fn$;

-- ── Profit & loss (period) ──────────────────────────────────────────────────
-- Voucher era only, exactly as v_profit_and_loss: legacy opening entries have
-- no voucher and would double-count against the imported balances.
CREATE OR REPLACE FUNCTION f_profit_and_loss(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_company text DEFAULT NULL)
RETURNS TABLE (group_head text, account_type text, sort_order int, amount numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT g.group_head, g.account_type, g.sort_order,
         CASE WHEN g.account_type = 'INCOME'
              THEN COALESCE(SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END), 0)
              ELSE COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
         END::numeric(14,2)
    FROM account_groups g
    LEFT JOIN v_ledger_entries_resolved e
           ON e.group_head = g.group_head AND NOT e.is_legacy
          AND (p_from    IS NULL OR e.entry_date >= p_from)
          AND (p_to      IS NULL OR e.entry_date <= p_to)
          AND (p_company IS NULL OR company_matches(e.company, p_company))
   WHERE g.statement = 'PROFIT_AND_LOSS'
   GROUP BY g.group_head, g.account_type, g.sort_order
   ORDER BY g.sort_order
$fn$;

-- ── Balance sheet (as on p_to) ──────────────────────────────────────────────
-- A balance sheet is cumulative: asset and liability groups take everything up
-- to p_to and ignore p_from. p_from bounds only the profit line, so a caller
-- asking for "July" gets July's profit on top of balances carried to 31 July —
-- which is what makes the two statements agree instead of merely coexisting.
CREATE OR REPLACE FUNCTION f_balance_sheet(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_company text DEFAULT NULL)
RETURNS TABLE (group_head text, account_type text, sort_order int,
               amount numeric, side text)
LANGUAGE sql STABLE AS $fn$
  WITH bal AS (
    SELECT g.group_head, g.account_type, g.sort_order,
           COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2) AS dr_net
      FROM account_groups g
      LEFT JOIN v_ledger_entries_resolved e
             ON e.group_head = g.group_head
            AND (p_to      IS NULL OR e.entry_date <= p_to)
            AND (p_company IS NULL OR company_matches(e.company, p_company))
     WHERE g.statement = 'BALANCE_SHEET'
     GROUP BY g.group_head, g.account_type, g.sort_order
  ),
  pl AS (
    SELECT COALESCE(SUM(CASE WHEN account_type = 'INCOME' THEN amount ELSE -amount END), 0)::numeric(14,2) AS profit
      FROM f_profit_and_loss(p_from, p_to, p_company)
  )
  SELECT b.group_head, b.account_type, b.sort_order,
         (CASE WHEN b.account_type = 'ASSET' THEN b.dr_net ELSE -b.dr_net END)::numeric(14,2),
         CASE WHEN b.account_type = 'ASSET' THEN 'ASSETS' ELSE 'LIABILITIES_AND_EQUITY' END
    FROM bal b
   WHERE b.dr_net <> 0
  UNION ALL
  SELECT 'Profit for the period', 'EQUITY', 999, pl.profit, 'LIABILITIES_AND_EQUITY'
    FROM pl WHERE pl.profit <> 0
   ORDER BY 5, 3
$fn$;

COMMIT;
