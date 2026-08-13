-- ═══════════════════════════════════════════════════════════════════════════
-- 014_alias_citext_fix.sql — make alias resolution actually case-insensitive
--
-- ledger_aliases.alias_name is citext, which was supposed to make
-- 'INDIAN OIL CORPORATION LTD' and 'Indian Oil Corporation Ltd' the same key.
-- It does — but only when the other side is a literal.
--
--     SELECT 'A'::citext = 'a'::text      -- false
--     SELECT 'A'::citext = 'a'            -- true
--
-- With a text COLUMN on the right, PostgreSQL picks the text = text operator
-- and compares case-sensitively. Every join in 011 and 013 was written
-- `a.alias_name = e.ledger_name`, i.e. citext = text, so resolution has been
-- case-sensitive all along. It looked healthy only because the posted spellings
-- happened to match a row exactly — the first voucher posted with different
-- casing would have fallen out of every report, silently.
--
-- Casting the text side to citext restores the intent. The health view also
-- gains a same-name-different-case check so this class of fault cannot hide again.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DROP VIEW IF EXISTS v_profit_and_loss;
DROP VIEW IF EXISTS v_trial_balance;
DROP VIEW IF EXISTS v_ledger_balances;
DROP VIEW IF EXISTS v_ledger_entries_resolved;

CREATE VIEW v_ledger_entries_resolved AS
SELECT e.id, e.voucher_id, e.entry_date, e.dr_cr, e.amount,
       e.particulars, e.source_type, e.source_ref, e.company, e.branch,
       e.ledger_name                          AS posted_as,
       COALESCE(c.ledger_name, e.ledger_name) AS ledger_name,
       COALESCE(c.group_head, 'Suspense A/c') AS group_head,
       g.account_type, g.statement, g.normal_side,
       (e.voucher_id IS NULL)                 AS is_legacy
  FROM ledger_entries e
  LEFT JOIN ledger_aliases a ON a.alias_name = e.ledger_name::citext   -- ← the fix
  LEFT JOIN ledgers        c ON c.id = a.canonical_id
  LEFT JOIN account_groups g ON g.group_head = COALESCE(c.group_head, 'Suspense A/c');

CREATE VIEW v_ledger_balances AS
SELECT l.id, l.ledger_name, l.group_head, g.account_type, g.statement, g.normal_side,
       l.opening_balance,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2) AS total_dr,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2) AS total_cr,
       (l.opening_balance
        + COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
       )::numeric(14,2) AS balance_dr,
       CASE WHEN g.normal_side = 'CR' THEN -1 ELSE 1 END
        * (l.opening_balance
           + COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
          )::numeric(14,2) AS balance_natural
  FROM ledgers l
  JOIN account_groups g ON g.group_head = l.group_head
  LEFT JOIN v_ledger_entries_resolved e ON e.ledger_name::citext = l.ledger_name::citext
 WHERE l.status = 'ACTIVE'
 GROUP BY l.id, l.ledger_name, l.group_head, g.account_type, g.statement, g.normal_side, l.opening_balance;

CREATE VIEW v_trial_balance AS
SELECT g.group_head, g.account_type, g.statement, g.sort_order,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2) AS dr,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2) AS cr,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR' AND NOT e.is_legacy), 0)::numeric(14,2) AS dr_voucher_era,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR' AND NOT e.is_legacy), 0)::numeric(14,2) AS cr_voucher_era
  FROM account_groups g
  LEFT JOIN v_ledger_entries_resolved e ON e.group_head = g.group_head
 GROUP BY g.group_head, g.account_type, g.statement, g.sort_order;

CREATE VIEW v_profit_and_loss AS
SELECT g.group_head, g.account_type, g.sort_order,
       CASE WHEN g.account_type = 'INCOME'
            THEN COALESCE(SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END), 0)
            ELSE COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
       END::numeric(14,2) AS amount
  FROM account_groups g
  LEFT JOIN v_ledger_entries_resolved e
         ON e.group_head = g.group_head AND NOT e.is_legacy
 WHERE g.statement = 'PROFIT_AND_LOSS'
 GROUP BY g.group_head, g.account_type, g.sort_order;

-- The self-alias trigger compared the same way; rebuild it citext-safe.
CREATE OR REPLACE FUNCTION ledger_self_alias() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = NEW.ledger_name::citext) THEN
    INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
    VALUES (NEW.ledger_name, NEW.id, 'canonical')
    ON CONFLICT (alias_name) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$fn$;

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
    WHERE NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = e.ledger_name::citext)
  ) AS unresolvable_entries,
  (SELECT count(*) FROM ledgers l WHERE l.status='ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = l.ledger_name::citext)
  ) AS ledgers_without_alias,
  -- Two ACTIVE ledgers whose names differ only by case or spacing are the same
  -- party wearing two hats; 011 should have merged them.
  (SELECT count(*) FROM (
     SELECT party_key(ledger_name) k FROM ledgers WHERE status='ACTIVE' AND party_key(ledger_name) <> ''
      GROUP BY 1 HAVING count(*) > 1) d
  ) AS duplicate_parties_remaining,
  (SELECT count(*) FROM ledgers WHERE status='ACTIVE'
      AND group_head NOT IN (SELECT group_head FROM account_groups)) AS ledgers_off_chart,
  (SELECT count(*) FROM ledger_aliases WHERE reason <> 'canonical') AS merged_aliases;

COMMIT;
