-- ═══════════════════════════════════════════════════════════════════════════
-- 037_stock_ledger_dedupe.sql — remove the duplicated stock accounts 036 left
-- on the replica, and make that insert genuinely idempotent.
--
-- WHAT HAPPENED. 036 inserted the four stock/consumption ledgers with
-- ON CONFLICT DO NOTHING and looked idempotent. It was not: `ledgers` carries
-- unique indexes on `id` and `legacy_id` ONLY — nothing on `ledger_name` — so
-- there was no conflict to detect and the clause never fired.
--
-- 036 ran locally at 07:20, autoSync replicated those four rows to AWS with
-- their local ids, and then 036 ran on AWS at 07:29 and inserted four MORE with
-- fresh ids. The replica ended up witheach account twice. A duplicate ledger is
-- not cosmetic — postings resolve by name, so the balance splits across two
-- rows and neither one is the truth. v_accounting_health caught it as
-- duplicate_parties_remaining = 4 on AWS against 0 locally.
--
-- Safe to repair now only because it was caught before the first posting: all
-- eight rows carry a zero balance and zero ledger_entries. The DELETE below
-- asserts exactly that rather than trusting it, and aborts the migration if a
-- duplicate has ever been posted to — at that point the entries have to be
-- reassigned by hand, and silently dropping a ledger row would destroy them.
--
-- WHY NOT A UNIQUE INDEX ON ledger_name. Seven party ledgers legitimately share
-- a name on both databases today (AGARWAL TRADING, RAJESH KUMAR, …), and
-- creation_type does not separate them — those are 'AUTO_SYSTEM' as well. A
-- global or creation_type-scoped unique index would fail to build. The index
-- below is therefore scoped to exactly the four names this system owns, which
-- is narrow enough to be true and wide enough to make 036's ON CONFLICT work.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Refuse rather than guess: if any copy has been posted to, stop.
DO $$
DECLARE posted integer;
BEGIN
  SELECT count(*) INTO posted
    FROM ledger_entries e
    JOIN ledgers l ON l.id = e.ledger_id
   WHERE l.ledger_name IN ('Tyre Stock', 'Battery Stock',
                           'Tyre Consumption Expenses', 'Battery Consumption Expenses');
  IF posted > 0 THEN
    RAISE EXCEPTION
      'stock ledgers already carry % ledger_entries — dedupe by hand so no posting is orphaned', posted;
  END IF;
END $$;

-- Keep the oldest row per name. On the replica that is the autoSync-replicated
-- one, so its id stays identical to the local row's and the two databases agree
-- on the primary key — which is what keeps autoSync an upsert rather than a
-- second insert next time.
DELETE FROM ledgers l
 WHERE l.ledger_name IN ('Tyre Stock', 'Battery Stock',
                         'Tyre Consumption Expenses', 'Battery Consumption Expenses')
   AND l.id <> (SELECT k.id FROM ledgers k
                 WHERE k.ledger_name = l.ledger_name
                 ORDER BY k.created_at, k.id LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS ledgers_stock_accounts_uniq
    ON ledgers (ledger_name)
 WHERE ledger_name IN ('Tyre Stock', 'Battery Stock',
                       'Tyre Consumption Expenses', 'Battery Consumption Expenses');

COMMIT;
