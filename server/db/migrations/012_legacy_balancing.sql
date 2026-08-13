-- ═══════════════════════════════════════════════════════════════════════════
-- 012_legacy_balancing.sql — make the legacy era balance, without lying about it
--
-- The Firestore book was effectively single-entry: 294 migrated rows carry
-- ₹46,71,034 of debits against ₹7,15,528 of credits, a ₹39,55,506 excess. The
-- voucher era is clean (0 unbalanced vouchers) and 005_ledger.sql deliberately
-- exempts legacy rows from the balance constraint, but a trial balance that
-- does not add up is unusable regardless of whose fault the history is.
--
-- Standard treatment when single-entry history is brought onto a double-entry
-- book: the difference is parked in an equity suspense account until it is
-- analysed. It is NOT spread across accounts to make things look tidy — that
-- would fabricate balances nobody can defend. One line, clearly labelled, in
-- the legacy era where it belongs.
--
-- Two repairs here, both of the kind 005's header anticipated: "a genuine
-- repair is a migration with an audit trail, not a quiet UPDATE".
--
--   1. 'MIGRATION: unresolved ledger' — 6 entries were posted to a ledger name
--      that has no master row, so they resolve to nothing and fall out of every
--      report. The ledger is created, under Suspense, where it is visible.
--
--   2. The ₹39,55,506 difference is credited to 'Opening Balance Difference'.
--
-- After this, v_accounting_health.legacy_imbalance reads 0.00 and the trial
-- balance foots. The number does not disappear — it sits in one named account
-- an accountant can work down.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Give the orphaned postings a home ────────────────────────────────────
INSERT INTO ledgers (ledger_name, group_head, creation_type, status)
SELECT 'MIGRATION: unresolved ledger', 'Suspense A/c', 'MIGRATION_REPAIR', 'ACTIVE'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE lower(ledger_name) = lower('MIGRATION: unresolved ledger'));

INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT 'MIGRATION: unresolved ledger', id, 'canonical'
  FROM ledgers WHERE lower(ledger_name) = lower('MIGRATION: unresolved ledger')
ON CONFLICT (alias_name) DO NOTHING;

-- ── 2. Park the single-entry difference ─────────────────────────────────────
INSERT INTO ledgers (ledger_name, group_head, creation_type, status)
SELECT 'Opening Balance Difference', 'Capital Account', 'MIGRATION_REPAIR', 'ACTIVE'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE lower(ledger_name) = lower('Opening Balance Difference'));

INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT 'Opening Balance Difference', id, 'canonical'
  FROM ledgers WHERE lower(ledger_name) = lower('Opening Balance Difference')
ON CONFLICT (alias_name) DO NOTHING;

-- voucher_id stays NULL: this belongs to the legacy era it corrects, and a
-- one-line voucher could not satisfy the balanced-voucher trigger anyway.
-- legacy_id makes the insert idempotent — re-running the migration cannot
-- double the correction.
INSERT INTO ledger_entries
  (legacy_id, ledger_name, voucher_id, entry_date, particulars, dr_cr, amount, source_type, source_ref)
SELECT
  'LEGACY-BALANCING-001',
  'Opening Balance Difference',
  NULL,
  (SELECT COALESCE(MIN(entry_date), CURRENT_DATE) FROM ledger_entries WHERE voucher_id IS NULL),
  'Opening difference on migration from single-entry Firestore book — to be analysed',
  CASE WHEN diff >= 0 THEN 'CR' ELSE 'DR' END,
  abs(diff),
  'LEGACY_BALANCING',
  'migration/012'
FROM (
  SELECT COALESCE(SUM(CASE WHEN dr_cr = 'DR' THEN amount ELSE -amount END), 0)::numeric(14,2) AS diff
    FROM ledger_entries WHERE voucher_id IS NULL
) d
WHERE diff <> 0
ON CONFLICT (legacy_id) DO NOTHING;

COMMIT;
