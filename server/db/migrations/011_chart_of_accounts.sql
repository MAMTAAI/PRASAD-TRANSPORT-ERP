-- ═══════════════════════════════════════════════════════════════════════════
-- 011_chart_of_accounts.sql — a real chart of accounts, and one name per party
--
-- The audit that prompted this found three structural faults, not bugs:
--
--   1. NO INCOME OR TAX HEADS. The book had Sundry Debtors, Creditors, Banks
--      and Expenses but nothing to credit revenue to. Freight earned could
--      therefore never be posted, which is why ₹1.42 Cr of reconciled bills
--      produced receipts with no matching income and a P&L that reads zero.
--
--   2. GROUPS WERE FREE TEXT. 'Sundry Debtors' and 'Sundry Debtors (Customers)'
--      both existed; a ledger auto-created by a voucher landed in whichever
--      string the caller happened to pass, so reports that filtered on one
--      silently omitted the other.
--
--   3. ONE PARTY, MANY LEDGERS. HPCL had three, IOCL two, several drivers two.
--      ledger_entries is append-only, so those postings can never be rewritten.
--
-- Fix for (1) and (2): account_groups becomes a real typed table and
-- ledgers.group_head is constrained to it by FK. Every group carries its
-- statement (P&L or BALANCE_SHEET) and its normal balance, so a trial balance,
-- P&L and balance sheet can be derived rather than hand-assembled.
--
-- Fix for (3) works WITH the append-only rule instead of against it: a
-- ledger_aliases table maps every variant spelling onto one canonical ledger,
-- and reporting resolves through it. Historic entries keep the exact name they
-- were posted under — the audit trail stays honest — while every report sees
-- one party. Renaming or deleting the losing ledgers would have destroyed that
-- trail; aliasing preserves it.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- ACCOUNT_GROUPS — the chart itself.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS account_groups (
  group_head    text PRIMARY KEY,
  account_type  text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  statement     text NOT NULL CHECK (statement IN ('BALANCE_SHEET','PROFIT_AND_LOSS')),
  normal_side   text NOT NULL CHECK (normal_side IN ('DR','CR')),
  parent        text REFERENCES account_groups(group_head),
  sort_order    integer NOT NULL DEFAULT 500,
  is_system     boolean NOT NULL DEFAULT false,   -- created here; do not delete
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Standard heads for a road-transport / GTA business. Existing free-text groups
-- are inserted alongside so the FK added later cannot orphan live data.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES
  -- ── Assets ──────────────────────────────────────────────────────────────
  ('Fixed Assets',                              'ASSET',    'BALANCE_SHEET',   'DR', 100, true),
  ('Bank Accounts',                             'ASSET',    'BALANCE_SHEET',   'DR', 110, true),
  ('Cash-in-Hand',                              'ASSET',    'BALANCE_SHEET',   'DR', 120, true),
  ('Sundry Debtors (Customers)',                'ASSET',    'BALANCE_SHEET',   'DR', 130, true),
  ('Loans & Advances (Asset)',                  'ASSET',    'BALANCE_SHEET',   'DR', 140, true),
  ('Current Assets - Driver Advances',          'ASSET',    'BALANCE_SHEET',   'DR', 150, true),
  ('Deposits (Asset)',                          'ASSET',    'BALANCE_SHEET',   'DR', 160, true),
  -- ── Liabilities & equity ────────────────────────────────────────────────
  ('Capital Account',                           'EQUITY',   'BALANCE_SHEET',   'CR', 200, true),
  ('Sundry Creditors (Vendors)',                'LIABILITY','BALANCE_SHEET',   'CR', 210, true),
  ('Duties & Taxes',                            'LIABILITY','BALANCE_SHEET',   'CR', 220, true),
  ('Secured Loans',                             'LIABILITY','BALANCE_SHEET',   'CR', 230, true),
  ('Provisions',                                'LIABILITY','BALANCE_SHEET',   'CR', 240, true),
  ('Suspense A/c',                              'LIABILITY','BALANCE_SHEET',   'CR', 290, true),
  -- ── Income ──────────────────────────────────────────────────────────────
  ('Freight Income',                            'INCOME',   'PROFIT_AND_LOSS', 'CR', 300, true),
  ('Other Income',                              'INCOME',   'PROFIT_AND_LOSS', 'CR', 320, true),
  -- ── Expenses ────────────────────────────────────────────────────────────
  ('Direct Expenses - Fuel & HSD',              'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 400, true),
  ('Direct Expenses - Toll & FASTag',           'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 410, true),
  ('Direct Expenses - Driver & Trip',           'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 420, true),
  ('Direct Expenses - Repairs & Tyres',         'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 430, true),
  ('Direct Expenses (Vehicle Compliance & Docs)','EXPENSE', 'PROFIT_AND_LOSS', 'DR', 440, true),
  ('Shortage & Penalty',                        'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 450, true),
  ('Indirect Expenses',                         'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 460, true),
  ('Finance Costs',                             'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 470, true),
  ('Depreciation',                              'EXPENSE',  'PROFIT_AND_LOSS', 'DR', 480, true)
ON CONFLICT (group_head) DO NOTHING;

-- Legacy free-text groups still attached to live ledgers. Typed correctly so
-- reports work today; ledgers are migrated off them below.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES
  ('Sundry Debtors',            'ASSET',    'BALANCE_SHEET',   'DR', 131, false),
  ('Sundry Creditors',          'LIABILITY','BALANCE_SHEET',   'CR', 211, false),
  ('Sundry Creditors (Fuel Pumps)','LIABILITY','BALANCE_SHEET','CR', 212, false)
ON CONFLICT (group_head) DO NOTHING;

-- Any other group string present in ledgers but not yet listed: adopt it rather
-- than fail the FK. Typed as a balance-sheet liability only so it is visible and
-- obviously wrong, never silently folded into income.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT DISTINCT l.group_head, 'LIABILITY', 'BALANCE_SHEET', 'CR', 900, false
  FROM ledgers l
 WHERE l.group_head IS NOT NULL
   AND btrim(l.group_head) <> ''
   AND NOT EXISTS (SELECT 1 FROM account_groups g WHERE g.group_head = l.group_head)
ON CONFLICT (group_head) DO NOTHING;

-- Ungrouped ledgers must land somewhere explicit.
UPDATE ledgers SET group_head = 'Suspense A/c'
 WHERE group_head IS NULL OR btrim(group_head) = '';

-- Fold the free-text duplicates onto the canonical heads.
UPDATE ledgers SET group_head = 'Sundry Debtors (Customers)'   WHERE group_head = 'Sundry Debtors';
UPDATE ledgers SET group_head = 'Sundry Creditors (Vendors)'   WHERE group_head IN ('Sundry Creditors','Sundry Creditors (Fuel Pumps)');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledgers_group_fk') THEN
    ALTER TABLE ledgers ADD CONSTRAINT ledgers_group_fk
      FOREIGN KEY (group_head) REFERENCES account_groups(group_head)
      ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER_ALIASES — many spellings, one party.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ledger_aliases (
  alias_name   citext PRIMARY KEY,
  canonical_id uuid NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_alias_canon_idx ON ledger_aliases (canonical_id);

-- Normalisation used to decide "same party": case, punctuation and the
-- corporate-suffix noise that produced 'LTD' vs 'Limited' in the first place.
CREATE OR REPLACE FUNCTION party_key(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             regexp_replace(upper(coalesce(t,'')), '[^A-Z0-9 ]', ' ', 'g'),
             '\y(LIMITED|LTD|PVT|PRIVATE|COMPANY|CORPORATION|CORP|AND|THE)\y', ' ', 'g'),
           '\s+', ' ', 'g'));
$$;

-- Canonical choice, in order:
--   1. the spelling that matches a master record (customer / vendor / driver) —
--      keeps ledger and master in step, which is what reports join on;
--   2. failing that, the ledger carrying the most postings;
--   3. failing that, the oldest.
-- Everything else in the group becomes an alias and is marked INACTIVE so it
-- cannot be picked again by getOrCreateLedger.
WITH scored AS (
  SELECT l.id, l.ledger_name, party_key(l.ledger_name) AS k,
         (SELECT count(*) FROM ledger_entries e WHERE lower(e.ledger_name) = lower(l.ledger_name)) AS postings,
         EXISTS (SELECT 1 FROM customers c WHERE party_key(c.customer_name) = party_key(l.ledger_name)
                                             AND c.customer_name = l.ledger_name)
      OR EXISTS (SELECT 1 FROM vendors v  WHERE v.vendor_name = l.ledger_name)
      OR EXISTS (SELECT 1 FROM drivers d  WHERE d.name = l.ledger_name) AS is_master,
         l.created_at
    FROM ledgers l
   WHERE l.status = 'ACTIVE'
), ranked AS (
  SELECT *, row_number() OVER (
             PARTITION BY k
             ORDER BY is_master DESC, postings DESC, created_at ASC, id ASC) AS rn,
         count(*) OVER (PARTITION BY k) AS variants
    FROM scored
   WHERE k <> ''
)
INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT loser.ledger_name,
       winner.id,
       format('duplicate of "%s" (key=%s, %s postings kept on canonical)',
              winner.ledger_name, loser.k, winner.postings)
  FROM ranked loser
  JOIN ranked winner ON winner.k = loser.k AND winner.rn = 1
 WHERE loser.variants > 1 AND loser.rn > 1
ON CONFLICT (alias_name) DO NOTHING;

-- Retire the losing ledgers. Their POSTINGS are untouched — resolution happens
-- at read time through ledger_aliases.
UPDATE ledgers SET status = 'INACTIVE'
 WHERE ledger_name IN (SELECT alias_name::text FROM ledger_aliases)
   AND status = 'ACTIVE';

-- Every canonical ledger is its own alias, so one join resolves any name.
INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT l.ledger_name, l.id, 'canonical'
  FROM ledgers l WHERE l.status = 'ACTIVE'
ON CONFLICT (alias_name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- REPORTING VIEWS — derived, never hand-assembled.
-- ═══════════════════════════════════════════════════════════════════════════

-- Every posting resolved to its canonical ledger and typed group.
CREATE OR REPLACE VIEW v_ledger_entries_resolved AS
SELECT e.id, e.voucher_id, e.entry_date, e.dr_cr, e.amount,
       e.particulars, e.source_type, e.source_ref, e.company, e.branch,
       e.ledger_name                         AS posted_as,
       COALESCE(c.ledger_name, e.ledger_name) AS ledger_name,
       COALESCE(c.group_head, 'Suspense A/c') AS group_head,
       g.account_type, g.statement, g.normal_side,
       (e.voucher_id IS NULL)                AS is_legacy
  FROM ledger_entries e
  LEFT JOIN ledger_aliases a ON a.alias_name = e.ledger_name
  LEFT JOIN ledgers        c ON c.id = a.canonical_id
  LEFT JOIN account_groups g ON g.group_head = COALESCE(c.group_head, 'Suspense A/c');

-- Balance per canonical ledger, signed to its normal side.
CREATE OR REPLACE VIEW v_ledger_balances AS
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
  LEFT JOIN v_ledger_entries_resolved e ON e.ledger_name = l.ledger_name
 WHERE l.status = 'ACTIVE'
 GROUP BY l.id, l.ledger_name, l.group_head, g.account_type, g.statement, g.normal_side, l.opening_balance;

-- Trial balance by group, with the legacy era separable — the migrated
-- single-entry rows do not balance and must never be mistaken for a fault in
-- the voucher era.
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT g.group_head, g.account_type, g.statement, g.sort_order,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2) AS dr,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2) AS cr,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR' AND NOT e.is_legacy), 0)::numeric(14,2) AS dr_voucher_era,
       COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR' AND NOT e.is_legacy), 0)::numeric(14,2) AS cr_voucher_era
  FROM account_groups g
  LEFT JOIN v_ledger_entries_resolved e ON e.group_head = g.group_head
 GROUP BY g.group_head, g.account_type, g.statement, g.sort_order
 ORDER BY g.sort_order;

-- Profit & loss, voucher era only.
CREATE OR REPLACE VIEW v_profit_and_loss AS
SELECT g.group_head, g.account_type, g.sort_order,
       CASE WHEN g.account_type = 'INCOME'
            THEN COALESCE(SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END), 0)
            ELSE COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
       END::numeric(14,2) AS amount
  FROM account_groups g
  LEFT JOIN v_ledger_entries_resolved e
         ON e.group_head = g.group_head AND NOT e.is_legacy
 WHERE g.statement = 'PROFIT_AND_LOSS'
 GROUP BY g.group_head, g.account_type, g.sort_order
 ORDER BY g.sort_order;

-- One-row health check. Every number here should be zero except legacy_*.
CREATE OR REPLACE VIEW v_accounting_health AS
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
  (SELECT count(*) FROM ledger_entries e
    WHERE NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = e.ledger_name)
  ) AS unresolvable_entries,
  (SELECT count(*) FROM ledgers WHERE status='ACTIVE'
      AND group_head NOT IN (SELECT group_head FROM account_groups)) AS ledgers_off_chart,
  (SELECT count(*) FROM ledger_aliases WHERE reason <> 'canonical') AS merged_aliases;

COMMIT;
