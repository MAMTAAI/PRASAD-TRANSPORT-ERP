-- ═══════════════════════════════════════════════════════════════════════════
-- 032_prepaid_card_group.sql — fleet cards and wallets stop being debtors.
--
-- The three physical fleet-card ledgers were migrated in under
-- 'Sundry Debtors (Customers)':
--
--     IOCL XtraPower Fleet Card 1001964874
--     HPCL Drivetrack plus Fleet Card 4002184134
--     BPCL Hello Fleet Card FA2004812523
--
-- A prepaid fuel card is not a customer receivable. It is our money, already
-- paid to an oil company, that we draw down by swiping. Sitting in debtors it
-- overstates what customers owe us — the one figure on the balance sheet an
-- owner reads first.
--
-- SAFE TO MOVE NOW, and this was checked before writing it: all three ledgers
-- hold ZERO entries and a zero opening balance, so re-grouping moves no money
-- on any statement. The classification is being corrected before the accounts
-- carry anything, which is the cheapest moment it will ever be.
--
-- 'Loans & Advances (Asset)' would have been defensible, but it already holds
-- TDS Receivable 194C — a genuine claim on a third party — and mixing "money
-- the tax office owes us" with "fuel we have prepaid for" in one line makes
-- both harder to read. A prepaid group is one line an owner can act on: it is
-- the float sitting on cards and tags.
--
-- WHAT STAYS PUT: TDS Receivable 194C. It is an advance to the tax authority,
-- not a prepaid card, and CLAUDE.md documents it under Loans & Advances.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
VALUES ('Prepaid Cards & Wallets (Asset)', 'ASSET', 'BALANCE_SHEET', 'DR', 145, true)
ON CONFLICT (group_head) DO NOTHING;

-- The three physical cards, by exact name so nothing else is swept along.
UPDATE ledgers
   SET group_head = 'Prepaid Cards & Wallets (Asset)'
 WHERE ledger_name IN (
   'IOCL XtraPower Fleet Card 1001964874',
   'HPCL Drivetrack plus Fleet Card 4002184134',
   'BPCL Hello Fleet Card FA2004812523'
 );

-- The wallet accounts TARA opens for tags and cards belong with them. Matched
-- by shape rather than by name because the set grows as providers are added.
UPDATE ledgers
   SET group_head = 'Prepaid Cards & Wallets (Asset)'
 WHERE group_head = 'Loans & Advances (Asset)'
   AND (ledger_name ILIKE '%wallet%' OR ledger_name ILIKE '%fleet card%')
   AND ledger_name <> 'TDS Receivable 194C';

-- Point each seeded card at its real chart account (031 added the column), so
-- a settlement posts to the account that already exists instead of opening a
-- second one under a derived name.
UPDATE fleet_cards SET wallet_ledger = 'IOCL XtraPower Fleet Card 1001964874'       WHERE provider = 'IOCL' AND wallet_ledger IS NULL;
UPDATE fleet_cards SET wallet_ledger = 'HPCL Drivetrack plus Fleet Card 4002184134' WHERE provider = 'HPCL' AND wallet_ledger IS NULL;
UPDATE fleet_cards SET wallet_ledger = 'BPCL Hello Fleet Card FA2004812523'         WHERE provider = 'BPCL' AND wallet_ledger IS NULL;

COMMIT;
