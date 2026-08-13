-- ═══════════════════════════════════════════════════════════════════════════
-- 017_balance_sheet.sql — balance sheet, derived from the same ledger as the P&L
--
-- 011 gave every account group a type and a statement, so the balance sheet is
-- a projection of data that already exists rather than a second set of numbers
-- to keep in step. Nothing here is entered by hand; if the trial balance foots,
-- this foots.
--
-- Current-year profit is carried in as a computed line rather than stored. A
-- balance sheet whose retained earnings can drift from the P&L that produced it
-- is the classic way these two reports stop agreeing.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_balance_sheet AS
WITH bal AS (
  SELECT g.group_head, g.account_type, g.sort_order,
         COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2) AS dr_net
    FROM account_groups g
    LEFT JOIN v_ledger_entries_resolved e ON e.group_head = g.group_head
   WHERE g.statement = 'BALANCE_SHEET'
   GROUP BY g.group_head, g.account_type, g.sort_order
),
pl AS (
  SELECT COALESCE(SUM(CASE WHEN account_type = 'INCOME' THEN amount ELSE -amount END), 0)::numeric(14,2) AS profit
    FROM v_profit_and_loss
)
SELECT b.group_head,
       b.account_type,
       b.sort_order,
       -- Assets sit naturally on the debit side, liabilities and equity on the
       -- credit side; both are reported positive so the two columns can simply
       -- be summed and compared.
       CASE WHEN b.account_type = 'ASSET' THEN b.dr_net ELSE -b.dr_net END::numeric(14,2) AS amount,
       CASE WHEN b.account_type = 'ASSET' THEN 'ASSETS' ELSE 'LIABILITIES_AND_EQUITY' END AS side
  FROM bal b
 WHERE b.dr_net <> 0
UNION ALL
SELECT 'Profit for the period', 'EQUITY', 999, pl.profit, 'LIABILITIES_AND_EQUITY'
  FROM pl WHERE pl.profit <> 0
 ORDER BY 5, 3;

-- One row: does it balance, and by how much if not.
CREATE OR REPLACE VIEW v_balance_sheet_check AS
SELECT
  COALESCE(SUM(amount) FILTER (WHERE side = 'ASSETS'), 0)::numeric(14,2)                 AS total_assets,
  COALESCE(SUM(amount) FILTER (WHERE side = 'LIABILITIES_AND_EQUITY'), 0)::numeric(14,2) AS total_liabilities_equity,
  (COALESCE(SUM(amount) FILTER (WHERE side = 'ASSETS'), 0)
   - COALESCE(SUM(amount) FILTER (WHERE side = 'LIABILITIES_AND_EQUITY'), 0))::numeric(14,2) AS difference
  FROM v_balance_sheet;

COMMIT;
