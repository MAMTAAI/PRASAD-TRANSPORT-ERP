-- ═══════════════════════════════════════════════════════════════════════════
-- 018_balance_sheet_legacy_fix.sql — make the balance sheet foot, honestly
--
-- 017's balance sheet was out by exactly ₹46,71,034 and it was tempting to read
-- that as missing data. It was not: the books balance perfectly.
--
--     PROFIT_AND_LOSS   dr_net  -43,13,941.99
--     BALANCE_SHEET     dr_net  +43,13,941.99
--
-- The fault was in the view. Its equity line came from v_profit_and_loss, which
-- deliberately reports the VOUCHER ERA only — but the asset and liability side
-- of the same view included EVERYTHING, legacy rows included. So the migrated
-- Firestore expenses (₹46,71,034, sitting in Direct Expenses) contributed their
-- balance-sheet legs while their P&L legs were filtered out. One side of a
-- one-sided history.
--
-- Adding a plug to force a tally would have been the wrong repair — and would
-- have hidden a real reporting rule. Prior-period results do not belong in
-- profit for the current period; they belong in retained earnings. So the
-- legacy P&L net gets its own equity line, labelled for what it is:
--
--     Profit for the period                voucher era, matches v_profit_and_loss
--     Accumulated result brought forward   legacy era, pre-double-entry
--
-- Both are computed from the ledger, so neither can drift from it.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DROP VIEW IF EXISTS v_balance_sheet_check;
DROP VIEW IF EXISTS v_balance_sheet;

CREATE VIEW v_balance_sheet AS
WITH bal AS (
  SELECT g.group_head, g.account_type, g.sort_order,
         COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2) AS dr_net
    FROM account_groups g
    LEFT JOIN v_ledger_entries_resolved e ON e.group_head = g.group_head
   WHERE g.statement = 'BALANCE_SHEET'
   GROUP BY g.group_head, g.account_type, g.sort_order
),
pl_current AS (   -- voucher era: this period's trading result
  SELECT COALESCE(SUM(CASE WHEN account_type = 'INCOME' THEN amount ELSE -amount END), 0)::numeric(14,2) AS profit
    FROM v_profit_and_loss
),
pl_legacy AS (    -- migrated single-entry history: prior periods
  SELECT COALESCE(SUM(CASE WHEN e.account_type = 'INCOME'
                           THEN CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END
                           ELSE CASE WHEN e.dr_cr = 'DR' THEN -e.amount ELSE e.amount END
                      END), 0)::numeric(14,2) AS profit
    FROM v_ledger_entries_resolved e
    JOIN account_groups g ON g.group_head = e.group_head
   WHERE e.is_legacy AND g.statement = 'PROFIT_AND_LOSS'
)
SELECT b.group_head, b.account_type, b.sort_order,
       CASE WHEN b.account_type = 'ASSET' THEN b.dr_net ELSE -b.dr_net END::numeric(14,2) AS amount,
       CASE WHEN b.account_type = 'ASSET' THEN 'ASSETS' ELSE 'LIABILITIES_AND_EQUITY' END AS side
  FROM bal b
 WHERE b.dr_net <> 0
UNION ALL
SELECT 'Profit for the period', 'EQUITY', 998, profit, 'LIABILITIES_AND_EQUITY'
  FROM pl_current WHERE profit <> 0
UNION ALL
SELECT 'Accumulated result brought forward (pre-migration)', 'EQUITY', 999, profit, 'LIABILITIES_AND_EQUITY'
  FROM pl_legacy WHERE profit <> 0
 ORDER BY 5, 3;

CREATE VIEW v_balance_sheet_check AS
SELECT
  COALESCE(SUM(amount) FILTER (WHERE side = 'ASSETS'), 0)::numeric(14,2)                 AS total_assets,
  COALESCE(SUM(amount) FILTER (WHERE side = 'LIABILITIES_AND_EQUITY'), 0)::numeric(14,2) AS total_liabilities_equity,
  (COALESCE(SUM(amount) FILTER (WHERE side = 'ASSETS'), 0)
   - COALESCE(SUM(amount) FILTER (WHERE side = 'LIABILITIES_AND_EQUITY'), 0))::numeric(14,2) AS difference,
  (abs(COALESCE(SUM(amount) FILTER (WHERE side = 'ASSETS'), 0)
       - COALESCE(SUM(amount) FILTER (WHERE side = 'LIABILITIES_AND_EQUITY'), 0)) < 0.01)  AS balanced
  FROM v_balance_sheet;

COMMIT;
