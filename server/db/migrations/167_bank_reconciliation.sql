-- ═══════════════════════════════════════════════════════════════════════════
-- 167 — BANK STATEMENT RECONCILIATION: the statement is the spine.
--
-- Owner, 5-Sep-2026 (GOD COMMAND + four answers): upload the bank
-- statements; TARA tallies every line against what the ERP expects; an
-- exact match posts itself and clears the due; anything ambiguous waits on
-- the Staff Action desk; (1) SBI 5913 joins Prasad Transport's books;
-- (2) transfers between our firms are CAPITAL movements; (3) Gautam's
-- savings account defaults to "not ours" for what no rule claims;
-- (4) book entries with no bank line are FLAGGED, never reversed.
--
-- ── WHAT THE AUDIT FOUND (production, 5-Sep) ──────────────────────────────
--   · 4 SBI accounts on paper, 1 in the ERP with entries. SBI (8490) closes at
--     ₹34,11,680 in the book against ₹22,620 at the bank (31-Aug).
--   · 379 of 482 ERP bank entries have no statement line (schedule-posted
--     EMIs, assumed receipts and their reversals, historical FASTag loads).
--   · Every IOCL credit carries the advice UTR — 33/33 tie to the rupee.
--   · Aadhar Green pays ₹36.7 L into SBI 5913, an account the ERP never had.
--   · 127 transfers between Prasad, Jaiswal and Gautam with no ledger for them.
--   · 1,400+ UPI payees (drivers, pumps, owners) not in the masters as typed.
--
-- ── THE MODEL ─────────────────────────────────────────────────────────────
--   bank_accounts          account number ↔ ledger ↔ firm
--   bank_statement_imports one row per uploaded file (hash-deduped)
--   bank_statement_lines   one row per statement line (uid-deduped), with the
--                          category / confidence TARA gave it, what it was
--                          linked to (voucher, book entry, bill, trip), by whom
--   bank_party_rules       what staff taught TARA: this counterparty / this
--                          pattern → this party / this ledger, auto or review
--   v_bank_book_unmatched  book entries on a bank ledger with no statement
--                          line — decision (4): flagged, listed, never touched
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE ACCOUNTS ══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bank_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no    text NOT NULL UNIQUE,
  account_tail  text NOT NULL,
  bank_name     text NOT NULL DEFAULT 'STATE BANK OF INDIA',
  ifsc          text,
  ledger_name   text NOT NULL,
  company_id    uuid REFERENCES companies(id),
  company_name  text,
  account_kind  text NOT NULL DEFAULT 'CURRENT' CHECK (account_kind IN ('CURRENT','SAVINGS','OD','CC')),
  -- decision (3): a personal savings account — a line no rule claims is
  -- "not ours" by default, still listed, reversible by a click
  personal_default_not_ours boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The ledger a new account needs (decision 1: SBI 5913 → Prasad Transport).
CREATE OR REPLACE FUNCTION ensure_bank_ledger(p_name text, p_group text, p_company text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
  SELECT p_group, 'ASSET', 'BALANCE_SHEET', 'DR', 100, false
   WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = p_group);
  INSERT INTO ledgers (ledger_name, group_head, company, dr_cr, branch, status, creation_type)
  SELECT p_name, p_group, p_company, 'DR', 'ALL', 'ACTIVE', 'SYSTEM'
   WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = p_name);
  RETURN p_name;
END $$;

SELECT ensure_bank_ledger('SBI (5913)', 'Bank Accounts', 'M/S PRASAD TRANSPORT');

INSERT INTO bank_accounts (account_no, account_tail, ifsc, ledger_name, company_id, company_name, account_kind, personal_default_not_ours)
SELECT v.account_no, v.tail, v.ifsc, v.ledger, c.id, c.company_name, v.kind, v.personal
  FROM (VALUES
    ('30178368490', '8490', 'SBIN0007171', 'SBI (8490)', 'PRASAD TRANSPORT', 'CURRENT', false),
    ('41365145913', '5913', 'SBIN0007171', 'SBI (5913)', 'PRASAD TRANSPORT', 'CURRENT', false),
    ('36242108548', '8548', 'SBIN0001684', 'SBI (8548)', 'JAISWAL ENTERPRISE', 'CURRENT', false),
    ('30297031934', '1934', 'SBIN0007171', 'SBI (1934)', 'GAUTAM PRASAD', 'SAVINGS', true)
  ) AS v(account_no, tail, ifsc, ledger, firm, kind, personal)
  LEFT JOIN companies c ON upper(c.company_name) LIKE '%' || v.firm || '%'
ON CONFLICT (account_no) DO NOTHING;

-- ═══ 2. THE STATEMENT, LINE BY LINE ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES bank_accounts(id),
  source_file     text,
  source_format   text NOT NULL DEFAULT 'PDF' CHECK (source_format IN ('PDF','CSV','XLSX','JSON')),
  period_from     date,
  period_to       date,
  opening_balance numeric(14,2),
  closing_balance numeric(14,2),
  rows_read       int NOT NULL DEFAULT 0,
  rows_new        int NOT NULL DEFAULT 0,
  rows_seen       int NOT NULL DEFAULT 0,
  content_sha     text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES bank_accounts(id),
  import_id     uuid REFERENCES bank_statement_imports(id) ON DELETE SET NULL,
  line_uid      text NOT NULL,
  txn_date      date NOT NULL,
  value_date    date,
  description   text NOT NULL DEFAULT '',
  ref_no        text,
  utr           text,
  branch_code   text,
  debit         numeric(14,2) NOT NULL DEFAULT 0,
  credit        numeric(14,2) NOT NULL DEFAULT 0,
  balance       numeric(14,2),
  counterparty  text,
  channel       text,
  -- what TARA decided, and what a person decided after
  status        text NOT NULL DEFAULT 'NEW'
                CHECK (status IN ('NEW','AUTO_POSTED','LINKED','REVIEW','PARKED','NOT_OURS','IGNORED')),
  category      text,
  confidence    text CHECK (confidence IS NULL OR confidence IN ('AUTO','REVIEW','UNMATCHED')),
  why           text,
  target_kind   text,
  target_id     uuid,
  target_label  text,
  voucher_id    uuid,
  book_entry_id bigint,
  trip_id       uuid REFERENCES trips(id) ON DELETE SET NULL,
  rule_id       uuid,
  linked_by     text,
  linked_at     timestamptz,
  note          text,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, line_uid),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))
);
CREATE INDEX IF NOT EXISTS bank_lines_status_idx ON bank_statement_lines (account_id, status, txn_date);
CREATE INDEX IF NOT EXISTS bank_lines_utr_idx ON bank_statement_lines (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_lines_book_idx ON bank_statement_lines (book_entry_id) WHERE book_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_lines_voucher_idx ON bank_statement_lines (voucher_id) WHERE voucher_id IS NOT NULL;

-- A line's identity: the account, the day, the two amounts, the running
-- balance and the head of the reference. Two months re-uploaded converge.
CREATE OR REPLACE FUNCTION bank_line_uid(p_account text, p_date date, p_debit numeric, p_credit numeric, p_balance numeric, p_ref text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(coalesce(p_account, '') || '|' || coalesce(p_date::text, '') || '|' || coalesce(round(p_debit, 2)::text, '') || '|'
             || coalesce(round(p_credit, 2)::text, '') || '|' || coalesce(round(p_balance, 2)::text, '') || '|' || left(coalesce(p_ref, ''), 24))
$$;

-- ═══ 3. WHAT STAFF TEACH TARA ═════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bank_party_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid REFERENCES bank_accounts(id) ON DELETE CASCADE,   -- NULL = every account
  match_kind   text NOT NULL CHECK (match_kind IN ('COUNTERPARTY','PATTERN','UTR_PREFIX')),
  match_text   text NOT NULL,
  direction    text NOT NULL DEFAULT 'ANY' CHECK (direction IN ('CR','DR','ANY')),
  category     text NOT NULL,
  party_kind   text NOT NULL DEFAULT 'NONE'
               CHECK (party_kind IN ('CUSTOMER','OWNER','VENDOR','DRIVER','LOAN','FIRM','LEDGER','NONE')),
  party_id     uuid,
  party_name   text,
  ledger_name  text,
  auto         boolean NOT NULL DEFAULT false,      -- true: post without a person
  learned_from uuid,                                 -- the line a person decided
  created_by   text,
  hits         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_party_rules_uq
  ON bank_party_rules (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), match_kind, upper(match_text), direction);

-- ═══ 4. THE LEDGERS THE ENGINE POSTS TO ═══════════════════════════════════
-- Decision (2): money between our own firms is a capital movement. Each firm
-- keeps one capital ledger per counter-firm under Capital Account.
CREATE OR REPLACE FUNCTION interfirm_capital_ledger(p_firm text, p_other text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_name text;
BEGIN
  v_name := 'Capital: Inter-firm — ' || upper(btrim(regexp_replace(p_other, '^M/S\s+', '', 'i')));
  INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
  SELECT 'Capital Account', 'EQUITY', 'BALANCE_SHEET', 'CR', 10, true
   WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = 'Capital Account');
  INSERT INTO ledgers (ledger_name, group_head, company, dr_cr, branch, status, creation_type)
  SELECT v_name, 'Capital Account', p_firm, 'CR', 'ALL', 'ACTIVE', 'SYSTEM'
   WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = v_name);
  RETURN v_name;
END $$;

INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Other Income', 'INCOME', 'PROFIT_AND_LOSS', 'CR', 500, false
 WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = 'Other Income');
INSERT INTO ledgers (ledger_name, group_head, dr_cr, branch, status, creation_type)
SELECT 'Bank Charges', 'Indirect Expenses', 'DR', 'ALL', 'ACTIVE', 'SYSTEM'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = 'Bank Charges');
INSERT INTO ledgers (ledger_name, group_head, dr_cr, branch, status, creation_type)
SELECT 'Bank Interest Income', 'Other Income', 'CR', 'ALL', 'ACTIVE', 'SYSTEM'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = 'Bank Interest Income');

-- ═══ 5. WHAT THE DESK AND THE DASHBOARD READ ══════════════════════════════
-- Decision (4): a book entry on a bank ledger that no statement line
-- accounts for is flagged here — assumed receipts, schedule-posted EMIs,
-- historical loads. Nothing reverses it; a person decides.
CREATE OR REPLACE VIEW v_bank_book_unmatched AS
SELECT a.id AS account_id, a.ledger_name, a.company_name,
       e.id AS entry_id, e.voucher_id, e.entry_date, e.dr_cr, e.amount, e.source_type, e.source_ref, e.particulars,
       CASE WHEN e.dr_cr = 'DR' THEN 'money in (book)' ELSE 'money out (book)' END AS side
  FROM bank_accounts a
  JOIN ledger_entries e ON e.ledger_name = a.ledger_name
 WHERE e.entry_date >= '2026-04-01'
   AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.book_entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.voucher_id IS NOT NULL AND l.voucher_id = e.voucher_id)
   AND EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.account_id = a.id);   -- only once a statement has been imported

CREATE OR REPLACE VIEW v_bank_account_summary AS
SELECT a.id, a.account_no, a.account_tail, a.bank_name, a.ledger_name, a.company_id, a.company_name, a.account_kind, a.personal_default_not_ours, a.active,
       (SELECT count(*)::int FROM bank_statement_lines l WHERE l.account_id = a.id) AS lines,
       (SELECT count(*)::int FROM bank_statement_lines l WHERE l.account_id = a.id AND l.status = 'AUTO_POSTED') AS auto_posted,
       (SELECT count(*)::int FROM bank_statement_lines l WHERE l.account_id = a.id AND l.status = 'LINKED') AS linked,
       (SELECT count(*)::int FROM bank_statement_lines l WHERE l.account_id = a.id AND l.status IN ('NEW','REVIEW')) AS waiting,
       (SELECT count(*)::int FROM bank_statement_lines l WHERE l.account_id = a.id AND l.status = 'PARKED') AS parked,
       (SELECT count(*)::int FROM bank_statement_lines l WHERE l.account_id = a.id AND l.status IN ('NOT_OURS','IGNORED')) AS not_ours,
       (SELECT min(txn_date) FROM bank_statement_lines l WHERE l.account_id = a.id) AS first_txn,
       (SELECT max(txn_date) FROM bank_statement_lines l WHERE l.account_id = a.id) AS last_txn,
       (SELECT l.balance FROM bank_statement_lines l WHERE l.account_id = a.id ORDER BY l.txn_date DESC, l.created_at DESC LIMIT 1) AS bank_closing,
       (SELECT COALESCE(sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2) FROM ledger_entries e WHERE e.ledger_name = a.ledger_name) AS book_balance,
       (SELECT count(*)::int FROM v_bank_book_unmatched u WHERE u.account_id = a.id) AS book_not_in_bank,
       (SELECT COALESCE(sum(credit), 0)::numeric(14,2) FROM bank_statement_lines l WHERE l.account_id = a.id) AS credits,
       (SELECT COALESCE(sum(debit), 0)::numeric(14,2) FROM bank_statement_lines l WHERE l.account_id = a.id) AS debits
  FROM bank_accounts a;

-- The dashboard may name these.
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH',
  'BANK_UNMATCHED','BANK_BOOK_NOT_IN_BANK']));

COMMENT ON TABLE bank_statement_lines IS
  'One row per bank statement line (167). status: NEW → AUTO_POSTED (TARA posted, exact) / LINKED (already in the book, or a person linked it) / REVIEW (desk) / PARKED / NOT_OURS / IGNORED. Vouchers posted from here carry ref BANK-<tail>-<uid>.';
COMMENT ON TABLE bank_party_rules IS
  'What staff taught TARA on the desk: this counterparty or pattern is this party / ledger. auto=true posts without a person next time.';
