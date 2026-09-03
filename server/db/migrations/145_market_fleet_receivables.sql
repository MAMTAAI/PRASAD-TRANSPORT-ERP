-- 145_market_fleet_receivables.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CUSTOMER LEG GETS AN ACCOUNT (owner directive, 3-Sep-2026)
--
-- The owner's mapping, in their words:
--     Debit Customer (Sundry Debtors) / Credit Market Freight Income
--     Debit Market Freight Expense   / Credit Transporter (Sundry Creditors)
--
-- The second line already posts (BZLOCK: Dr Market Fleet Freight Cost /
-- Cr Market Partner: <name>). The first line could not, and the reason is the
-- dual-fleet rule the books already enforce: ledger_fleet_segment_guard()
-- refuses any BAZAAR_* voucher that touches a ledger outside 'Market Fleet %'
-- (bank and cash excepted). Posting the market customer into the SAME
-- 'Sundry Debtors' book as the own-fleet contract customers would mix the two
-- businesses the owner deliberately split on 2-Sep — and the trigger would
-- reject it anyway, so the income leg simply had nowhere to land.
--
-- So the receivable is created as the MARKET SEGMENT'S Sundry Debtors. It is
-- the same accounting line — an asset, on the balance sheet, normally debit —
-- sub-classified by segment, which is what every other market money group here
-- already does:
--
--     Market Fleet Receivables (Customers)   ← this migration (Sundry Debtors)
--     Market Fleet Income                    ← exists (Market Freight Income)
--     Market Fleet Expenses                  ← exists (Market Freight Expense)
--     Market Fleet Payables (Partners)       ← exists (Sundry Creditors)
--
-- With all four in place the brokerage posts as a closed square:
--
--     at award (BZLOCK)   Dr Market Fleet Freight Cost      39,000
--                           Cr Market Partner: BORAH                39,000
--     at delivery (BZINC) Dr Market Debtors: <customer>     45,000
--                           Cr Market Fleet Freight Income          45,000
--
--   → Receivable 45,000 − Payable 39,000 = 6,000, and the market segment's
--     P&L (Income − Expenses) is 6,000. The margin is the difference between
--     two postings, so it needs no third entry: inventing one would count the
--     spread twice and overstate income. v_market_margin_audit (migration 144)
--     proves that difference against the stored margin_amount per settlement,
--     which is what makes "0% leak" a query rather than an assurance.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES
  ('Market Fleet Receivables (Customers)', 'ASSET', 'BALANCE_SHEET', 'DR', 145, true)
ON CONFLICT (group_head) DO NOTHING;

COMMIT;
