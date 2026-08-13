-- ═══════════════════════════════════════════════════════════════════════════
-- 031_fleet_card_wallet_ledger.sql — name the chart account a card draws on.
--
-- 030 let the API derive a card's wallet ledger from its provider
-- ('<provider> Card Wallet'). That was wrong in a way that only shows up once
-- real money moves: the chart ALREADY carries an account per physical card —
--
--     IOCL XtraPower Fleet Card 1001964874
--     HPCL Drivetrack plus Fleet Card 4002184134
--     BPCL Hello Fleet Card FA2004812523
--
-- — so a derived name would have opened a SECOND wallet account beside the real
-- one and split every card's balance across the two. That is precisely the
-- duplicate-party problem migration 013 was written to clean up.
--
-- The card now names its own account. NULL keeps the derived fallback, so
-- nothing changes for a card nobody has mapped yet — but the mapping is now
-- something an operator can see and set, rather than a string in a route file.
--
-- ⚠️ NOT FIXED HERE, ON PURPOSE: those three card ledgers are grouped under
-- 'Sundry Debtors (Customers)', which is a legacy mis-grouping — a prepaid
-- fleet card is our asset with the oil company, not a customer receivable, and
-- it inflates debtors on the balance sheet. Re-grouping them moves real figures
-- on a live balance sheet, so it is the owner's call, not a migration's.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE fleet_cards
  ADD COLUMN IF NOT EXISTS wallet_ledger text;

COMMENT ON COLUMN fleet_cards.wallet_ledger IS
  'Chart account this card draws down. NULL = derive "<provider> Card Wallet".';

COMMIT;
