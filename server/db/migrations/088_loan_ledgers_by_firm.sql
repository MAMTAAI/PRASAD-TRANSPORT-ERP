-- ═══════════════════════════════════════════════════════════════════════════
-- 088_loan_ledgers_by_firm.sql — the balance sheet carries the FINANCE COMPANY;
-- the truck stays in the system.
--
-- ── WHAT THE BALANCE SHEET SHOWED ──────────────────────────────────────────
-- Secured Loans resolved to sixteen ledgers named after registration plates —
-- "Loan: TATA CAPITAL LIMITED (AS 26C 9802)". That is a fleet register, not a
-- balance sheet. A balance sheet answers "what do we owe, and to whom", and the
-- answer is two lenders, not thirteen lorries.
--
-- Worse, the sixteen do not even line up with the twenty-nine contracts: each
-- truck's ledger holds BOTH its loans, the 46-lakh chassis facility and the
-- 10-lakh body one, netted together under a plate number. So the account is
-- neither per lender nor per contract — it is per asset, which is the one thing
-- a liability is not.
--
-- ── WHAT REPLACES IT ───────────────────────────────────────────────────────
-- One ledger per finance company, and the vehicle and contract detail stays in
-- the loan module where v_loan_ledger_fy, v_loan_ledger and the statement
-- screen already carry it truck by truck and instalment by instalment.
--
-- ── AND NOT ONE ROW OF HISTORY IS REWRITTEN ────────────────────────────────
-- ledger_entries is append-only by trigger and TARA is its only writer, so the
-- 500-odd loan postings keep the names they were posted under. What moves is
-- the ALIAS: v_ledger_entries_resolved already maps every posted name through
-- ledger_aliases to a canonical ledger, and that is the mechanism the party
-- dedup in 034 used for exactly this. Repointing the alias re-groups past AND
-- future postings in one step, and `posted_as` still shows the plate the entry
-- was written under.
--
-- Future EMI vouchers need no change either. loan_master.financier_ledger keeps
-- its per-vehicle name, TARA finds that ledger by name as it always did, and
-- the alias lands the entry on the firm. The loan module keeps knowing which
-- truck; the balance sheet stops caring.
--
-- ── THE ID IS DERIVED FROM THE NAME ────────────────────────────────────────
-- md5('prasad-erp/ledger/' || lower(btrim(name)))::uuid — the same formula
-- getOrCreateLedger uses. Minting a fresh uuid here would give this database a
-- different primary key for the same account than the replica computes, and
-- autoSync upserts by id: the account would arrive twice and its balance split
-- across the copies. Migrations 037, 038 and 039 were that bug.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. one ledger per finance company ──────────────────────────────────────
INSERT INTO ledgers (id, ledger_name, group_head, creation_type, status)
SELECT md5('prasad-erp/ledger/' || lower(btrim('Vehicle Loans - ' || bank_name)))::uuid,
       'Vehicle Loans - ' || bank_name,
       'Secured Loans',
       'AUTO_VOUCHER',
       'ACTIVE'
  FROM (SELECT DISTINCT bank_name FROM loan_master WHERE bank_name IS NOT NULL) f
ON CONFLICT (id) DO UPDATE SET group_head = EXCLUDED.group_head,
                               status = 'ACTIVE';

-- Every ledger needs an alias pointing at itself, or nothing resolves to it.
INSERT INTO ledger_aliases (alias_name, canonical_id, reason)
SELECT l.ledger_name::citext, l.id, 'firm-level vehicle loan account (088)'
  FROM ledgers l
 WHERE l.ledger_name LIKE 'Vehicle Loans - %'
ON CONFLICT (alias_name) DO NOTHING;

-- ── 2. point every per-vehicle loan name at its lender's ledger ────────────
UPDATE ledger_aliases a
   SET canonical_id = firm.id,
       reason = 'per-vehicle loan account rolled up to the finance company for the '
                || 'balance sheet (088); vehicle and contract detail lives in the loan module'
  FROM ledgers old
  JOIN LATERAL (
    SELECT f.id
      FROM ledgers f
      JOIN (SELECT DISTINCT bank_name FROM loan_master WHERE bank_name IS NOT NULL) b
        ON f.ledger_name = 'Vehicle Loans - ' || b.bank_name
     -- The per-vehicle name is 'Loan: <financier> (<plate>)', so the lender it
     -- belongs to is the one whose name the account name contains.
     WHERE old.ledger_name LIKE 'Loan: ' || b.bank_name || ' (%'
     LIMIT 1
  ) firm ON true
 WHERE a.alias_name = old.ledger_name::citext
   AND old.ledger_name LIKE 'Loan: %'
   AND a.canonical_id = old.id;

-- ── 3. retire the plate-numbered accounts from the chart ───────────────────
-- INACTIVE, not deleted: v_ledger_balances shows ACTIVE only, so they leave the
-- chart of accounts while every entry ever posted under their names survives
-- and still resolves. TARA finds a ledger by name and does not consult status,
-- so a future EMI voucher naming one still posts — and still lands on the firm.
UPDATE ledgers
   SET status = 'INACTIVE', updated_at = now()
 WHERE ledger_name LIKE 'Loan: %'
   AND group_head = 'Secured Loans'
   AND status = 'ACTIVE';

-- ── 4. the vehicle-wise view the system keeps ──────────────────────────────
-- The detail the balance sheet no longer carries, straight off the GL, so a
-- question about one truck can still be answered from the books rather than
-- only from the loan module.
CREATE OR REPLACE VIEW v_loan_gl_by_vehicle AS
SELECT
  e.posted_as                                    AS vehicle_loan_account,
  e.ledger_name                                  AS balance_sheet_account,
  lm.vehicle_no,
  lm.bank_name                                   AS financier,
  count(DISTINCT lm.loan_account_no)::int        AS contracts,
  string_agg(DISTINCT lm.loan_account_no || ' (' || COALESCE(lm.loan_type, 'Loan') || ')', ', ')
                                                 AS contract_list,
  SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE 0 END)::numeric(14,2)  AS credited,
  SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE 0 END)::numeric(14,2)  AS debited,
  SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END)::numeric(14,2) AS outstanding
FROM v_ledger_entries_resolved e
LEFT JOIN loan_master lm ON lm.financier_ledger = e.posted_as
WHERE e.posted_as LIKE 'Loan: %'
GROUP BY e.posted_as, e.ledger_name, lm.vehicle_no, lm.bank_name;

COMMENT ON VIEW v_loan_gl_by_vehicle IS
  'The vehicle-wise breakdown behind each firm-level Secured Loans account. The '
  'balance sheet shows the finance company; this is how the system still shows '
  'the truck.';

COMMIT;
