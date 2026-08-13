-- ═══════════════════════════════════════════════════════════════════════════
-- 036_stock_in_hand.sql — a home for tyre and battery stock.
--
-- The Firestore tyre/battery screens accounted for a component TWICE, and
-- neither posting was a valid double entry:
--
--   at PURCHASE  a BANK_TRANSACTIONS row took the cost straight out as cash,
--                as though a tyre in the store were already an expense;
--   at SCRAP     a ONE-SIDED Dr to 'Tyre Consumption Expenses' with no credit
--                leg at all — which PostgreSQL cannot even store, because
--                ledger_entries carries a deferred ΣDr = ΣCr constraint per
--                voucher (this is the same defect VehicleDocs had in 028).
--
-- The real shape is inventory:
--
--   purchase     Dr Tyre/Battery Stock      Cr bank (cash) or the vendor
--   fitting      nothing — still our asset, just mounted on a truck
--   consumption  Dr Tyre Consumption Expense  Cr Tyre/Battery Stock
--
-- so the cost lands in the P&L exactly once, on the day the component is worn
-- out or scrapped, and until then it is visible on the balance sheet as stock.
-- `/assets/tyres` already reports stock_value; this gives that number a home in
-- the chart of accounts.
--
-- WHY A NEW GROUP. account_groups is a closed list behind a foreign key and had
-- no inventory group at all — the nearest were 'Fixed Assets' (a tyre is a
-- consumable, not a fixed asset) and 'Loans & Advances (Asset)' (not a claim on
-- anyone). Putting stock in either would misstate the balance sheet.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
VALUES ('Stock-in-Hand (Asset)', 'ASSET', 'BALANCE_SHEET', 'DR', 125, true)
ON CONFLICT (group_head) DO NOTHING;

-- The two stock accounts and the expense they are consumed into. Created here
-- rather than lazily by TARA so the chart reads sensibly before the first
-- purchase, and so the expense group is stated once rather than guessed per
-- posting.
INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, current_balance, creation_type)
VALUES
  ('Tyre Stock',                'Stock-in-Hand (Asset)',             'DR', 0, 0, 'AUTO_SYSTEM'),
  ('Battery Stock',             'Stock-in-Hand (Asset)',             'DR', 0, 0, 'AUTO_SYSTEM'),
  ('Tyre Consumption Expenses', 'Direct Expenses - Repairs & Tyres', 'DR', 0, 0, 'AUTO_SYSTEM'),
  ('Battery Consumption Expenses', 'Direct Expenses - Repairs & Tyres', 'DR', 0, 0, 'AUTO_SYSTEM')
ON CONFLICT DO NOTHING;

-- Which voucher wrote a component into stock, and which took it out. Without
-- these a re-run of a purchase would post the stock leg again — the component
-- rows themselves are protected by the serial-number unique index, but the
-- ledger needs its own guard.
ALTER TABLE tyres
  ADD COLUMN IF NOT EXISTS purchase_voucher_id    uuid,
  ADD COLUMN IF NOT EXISTS consumption_voucher_id uuid;
ALTER TABLE batteries
  ADD COLUMN IF NOT EXISTS purchase_voucher_id    uuid,
  ADD COLUMN IF NOT EXISTS consumption_voucher_id uuid;

COMMIT;
