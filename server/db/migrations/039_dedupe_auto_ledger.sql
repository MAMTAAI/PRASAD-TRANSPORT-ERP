-- ===========================================================================
-- 039_dedupe_auto_ledger.sql - the auto-created ledger duplicate, and the
-- reason it keeps happening.
--
-- THIRD OCCURRENCE OF ONE SHAPE. 036 duplicated four stock ledgers; 037 cleaned
-- them up; now 'FASTag Wallet: Jaiswal Enterprise' exists twice on the replica,
-- created ten seconds apart. The cause is always the same: TARA creates a
-- missing ledger with a server-generated uuid, so when the same voucher run
-- touches two databases each mints its OWN id for the same account, and
-- autoSync - which upserts by id - treats them as different rows.
--
-- The lasting fix is in tara.js, which now derives the id from the ledger name
-- (md5 of a namespaced, lower-cased name, cast to uuid). The same name is the
-- same primary key on every database, so autoSync converges instead of
-- duplicating. This migration only clears the row that already exists.
--
-- ORDER MATTERS, and 038 is why. ledger_aliases keys on alias_name with a
-- canonical_id pointing at the ledger; on the replica that alias points at the
-- NATIVE copy, and the 157 entries on this account carry no ledger_id - they
-- resolve BY NAME through that alias. Deleting the ledger first would cascade
-- the alias away and orphan every one of them. So: repoint the alias to the
-- surviving row, THEN delete.
-- ===========================================================================

BEGIN;

-- Refuse if anything actually references a copy by foreign key.
DO $$
DECLARE bound integer;
BEGIN
  SELECT count(*) INTO bound
    FROM ledger_entries e
    JOIN ledgers l ON l.id = e.ledger_id
   WHERE l.ledger_name = 'FASTag Wallet: Jaiswal Enterprise';
  IF bound > 0 THEN
    RAISE EXCEPTION 'ledger_entries reference this ledger by id (%); dedupe by hand', bound;
  END IF;
END $$;

-- 1. alias first, onto the OLDEST row (the one both databases already share).
UPDATE ledger_aliases a
   SET canonical_id = (SELECT k.id FROM ledgers k
                        WHERE k.ledger_name = 'FASTag Wallet: Jaiswal Enterprise'
                        ORDER BY k.created_at, k.id LIMIT 1)
 WHERE a.alias_name::text = 'FASTag Wallet: Jaiswal Enterprise';

-- 2. then the surplus copies.
DELETE FROM ledgers l
 WHERE l.ledger_name = 'FASTag Wallet: Jaiswal Enterprise'
   AND l.id <> (SELECT k.id FROM ledgers k
                 WHERE k.ledger_name = 'FASTag Wallet: Jaiswal Enterprise'
                 ORDER BY k.created_at, k.id LIMIT 1);

-- 3. and make this account unable to double again, the same way 037 guarded the
--    stock accounts. A global unique index on ledger_name still cannot be
--    built: seven party ledgers legitimately share a name.
CREATE UNIQUE INDEX IF NOT EXISTS ledgers_wallet_accounts_uniq
    ON ledgers (ledger_name)
 WHERE ledger_name LIKE 'FASTag Wallet%';

COMMIT;
