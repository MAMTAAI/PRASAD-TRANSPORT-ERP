-- ===========================================================================
-- 038_restore_stock_ledger_aliases.sql — put back the canonical aliases that
-- 037's DELETE took with it.
--
-- 037 removed the duplicate stock ledgers the replica had accumulated. Correct,
-- but incomplete: ledger_aliases keys on alias_name with a canonical_id
-- pointing at the ledger row, so deleting the duplicate took the alias for that
-- NAME away with it. The surviving ledger was then left with no alias at all.
--
-- That matters because ledger_entries do not all carry a ledger_id. The
-- fourteen entries on these accounts (the previous session's AWS smoke tests
-- and their reversals) resolve BY NAME through ledger_aliases, and with the
-- alias gone they resolved to nothing: v_accounting_health went from
-- unresolvable_entries = 0 to 14 and ledgers_without_alias = 0 to 4.
--
-- 037's own guard did not catch this because it counted entries joined on
-- ledger_id, and these have ledger_id IS NULL. Name resolution is the real
-- linkage in this schema; a check that only follows the foreign key sees an
-- empty result and reports all-clear. Worth remembering for the next dedupe.
--
-- No money moves here and no entry is rewritten — ledger_entries stays
-- append-only. This restores the lookup row that lets the existing entries find
-- their ledger again. Idempotent, and a no-op where the alias survived.
-- ===========================================================================

BEGIN;

INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT l.ledger_name::citext, l.id, 'canonical'
  FROM ledgers l
 WHERE l.ledger_name IN ('Tyre Stock', 'Battery Stock',
                         'Tyre Consumption Expenses', 'Battery Consumption Expenses')
   AND l.status = 'ACTIVE'
   AND NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = l.ledger_name::citext);

-- Assert the repair rather than hope for it: every one of these names must now
-- resolve, or this migration has not done its job and should not be recorded.
DO $$
DECLARE orphans integer;
BEGIN
  SELECT count(*) INTO orphans
    FROM ledger_entries e
   WHERE e.ledger_name IN ('Tyre Stock', 'Battery Stock',
                           'Tyre Consumption Expenses', 'Battery Consumption Expenses')
     AND NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = e.ledger_name::citext);
  IF orphans > 0 THEN
    RAISE EXCEPTION 'still % unresolvable entries on the stock accounts after restoring aliases', orphans;
  END IF;
END $$;

COMMIT;
