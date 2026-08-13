-- ═══════════════════════════════════════════════════════════════════════════
-- 013_alias_autofill.sql — keep alias resolution complete, forever
--
-- 011 backfilled ledger_aliases once, as a migration step. That was correct for
-- the ledgers existing at the time and wrong as a permanent design: the moment
-- postVoucher's getOrCreateLedger created 'Freight Income', the alias table had
-- no row for it, so v_ledger_entries_resolved could not resolve its postings and
-- v_accounting_health.unresolvable_entries jumped from 6 to 78.
--
-- A backfill fixes a snapshot; a trigger fixes the invariant. Every active
-- ledger is now guaranteed to be its own canonical alias from the instant it
-- exists, whoever creates it and by whatever code path — which is exactly the
-- kind of rule that belongs in the database rather than in every caller.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Catch up anything created since 011 (the income, penalty and driver ledgers).
INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT l.ledger_name, l.id, 'canonical'
  FROM ledgers l
 WHERE l.status = 'ACTIVE'
ON CONFLICT (alias_name) DO NOTHING;

-- From here on it maintains itself.
CREATE OR REPLACE FUNCTION ledger_self_alias() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
    VALUES (NEW.ledger_name, NEW.id, 'canonical')
    ON CONFLICT (alias_name) DO NOTHING;   -- a merged alias keeps its target
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS ledgers_self_alias ON ledgers;
CREATE TRIGGER ledgers_self_alias
  AFTER INSERT OR UPDATE OF ledger_name, status ON ledgers
  FOR EACH ROW EXECUTE FUNCTION ledger_self_alias();

-- Health check gains a stricter question: not "do postings resolve" but "does
-- every active ledger have an alias at all". A zero here means the invariant
-- holds; anything else means the trigger was bypassed.
--
-- Dropped rather than replaced: CREATE OR REPLACE VIEW can add trailing columns
-- but cannot rename or reorder existing ones, and this revision inserts
-- total_imbalance ahead of them.
DROP VIEW IF EXISTS v_accounting_health;
CREATE VIEW v_accounting_health AS
SELECT
  (SELECT count(*) FROM (
     SELECT voucher_id FROM ledger_entries WHERE voucher_id IS NOT NULL
      GROUP BY voucher_id
     HAVING SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END) <> 0) x
  ) AS unbalanced_vouchers,
  (SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2)
     FROM ledger_entries WHERE voucher_id IS NOT NULL) AS voucher_era_imbalance,
  (SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2)
     FROM ledger_entries WHERE voucher_id IS NULL) AS legacy_imbalance,
  (SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2)
     FROM ledger_entries) AS total_imbalance,
  (SELECT count(*) FROM ledger_entries e
    WHERE NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = e.ledger_name)
  ) AS unresolvable_entries,
  (SELECT count(*) FROM ledgers l WHERE l.status='ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = l.ledger_name)
  ) AS ledgers_without_alias,
  (SELECT count(*) FROM ledgers WHERE status='ACTIVE'
      AND group_head NOT IN (SELECT group_head FROM account_groups)) AS ledgers_off_chart,
  (SELECT count(*) FROM ledger_aliases WHERE reason <> 'canonical') AS merged_aliases;

COMMIT;
