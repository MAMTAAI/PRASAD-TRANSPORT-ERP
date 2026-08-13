-- ═══════════════════════════════════════════════════════════════════════════
-- 021_balance_sheet_fn_fix.sql — f_balance_sheet was out by the 018 amount
--
-- Two faults in 020's version, both found by comparing it against the view it
-- was supposed to mirror (assets 1,18,95,637.44 vs liabilities 1,65,66,671.44).
--
-- 1. It mirrored 017, not 018. 018 had already split equity in two — voucher-era
--    'Profit for the period' plus 'Accumulated result brought forward' for the
--    migrated single-entry history — and 020 carried only the first, so the
--    legacy ₹46,71,034 of P&L legs had balance-sheet legs and no equity line.
--
-- 2. It bounded the profit line by p_from. A balance sheet is cumulative: equity
--    is retained earnings, not one period's trading result. Bounding the profit
--    line while asset and liability groups stayed cumulative meant any p_from
--    later than the first voucher pushed the sheet out of balance by exactly the
--    profit earned before it. So p_from is gone from the signature: the sheet is
--    as-on-a-date, and a period result is what f_profit_and_loss is for.
--
-- Both lines derive from the same ledger as the asset side, so the sheet foots
-- at any p_to. The regression test is the comparison itself — f_balance_sheet()
-- with no date must equal v_balance_sheet, group for group.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS f_balance_sheet(date, date, text);

CREATE OR REPLACE FUNCTION f_balance_sheet(
  p_to date DEFAULT NULL, p_company text DEFAULT NULL)
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
  pl_current AS (   -- voucher era, cumulative to p_to = retained earnings
    SELECT COALESCE(SUM(CASE WHEN account_type = 'INCOME' THEN amount ELSE -amount END), 0)::numeric(14,2) AS profit
      FROM f_profit_and_loss(NULL, p_to, p_company)
  ),
  pl_legacy AS (    -- migrated single-entry history: prior periods
    SELECT COALESCE(SUM(CASE WHEN e.account_type = 'INCOME'
                             THEN CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END
                             ELSE CASE WHEN e.dr_cr = 'DR' THEN -e.amount ELSE e.amount END
                        END), 0)::numeric(14,2) AS profit
      FROM v_ledger_entries_resolved e
      JOIN account_groups g ON g.group_head = e.group_head
     WHERE e.is_legacy AND g.statement = 'PROFIT_AND_LOSS'
       AND (p_to      IS NULL OR e.entry_date <= p_to)
       AND (p_company IS NULL OR company_matches(e.company, p_company))
  )
  SELECT b.group_head, b.account_type, b.sort_order,
         (CASE WHEN b.account_type = 'ASSET' THEN b.dr_net ELSE -b.dr_net END)::numeric(14,2),
         CASE WHEN b.account_type = 'ASSET' THEN 'ASSETS' ELSE 'LIABILITIES_AND_EQUITY' END
    FROM bal b
   WHERE b.dr_net <> 0
  UNION ALL
  SELECT 'Profit for the period', 'EQUITY', 998, profit, 'LIABILITIES_AND_EQUITY'
    FROM pl_current WHERE profit <> 0
  UNION ALL
  SELECT 'Accumulated result brought forward (pre-migration)', 'EQUITY', 999, profit, 'LIABILITIES_AND_EQUITY'
    FROM pl_legacy WHERE profit <> 0
   ORDER BY 5, 3
$fn$;

COMMIT;
