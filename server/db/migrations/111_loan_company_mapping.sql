-- ═══════════════════════════════════════════════════════════════════════════
-- 111_loan_company_mapping.sql — the firm behind a financier is now a fact
--
-- 05b89f9 deliberately left the loan-EMI postings NULL-scoped because "the
-- firm behind a financier is a decision, and stamping the wrong one is worse
-- than NULL." On 2026-08-31 the owner made that decision:
--
--     HDFC and SBI loans belong to M/S JAISWAL ENTERPRISE;
--     every other loan belongs to M/S PRASAD TRANSPORT.
--
-- WHY THE RULE IS APPLIED WHOLESALE. loan_master.company_name is the same kind
-- of free text that put eight spellings on three companies (053) — that is WHY
-- this needed an owner decision instead of a backfill. The owner's rule
-- replaces it as the source of truth for the company dimension; the text
-- column is left untouched as a historical record.
--
-- This migration maps the LOANS only. It does not touch ledger_entries:
-- postings made from here on carry company_id at the write path (tara.js /
-- loanImport / assets), and the pre-existing NULL-scoped postings stay visible
-- on v_accounting_health until a separately-reviewed backfill clears them.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE loan_master
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE RESTRICT;

-- Owner decision, 2026-08-31: HDFC/SBI → Jaiswal Enterprise.
UPDATE loan_master l
   SET company_id = c.id
  FROM companies c
 WHERE l.company_id IS NULL
   AND COALESCE(l.bank_name, '') ~* 'HDFC|SBI|STATE BANK'
   AND norm_company_name(c.company_name) = norm_company_name('JAISWAL ENTERPRISE');

-- …and every other financier → Prasad Transport.
UPDATE loan_master l
   SET company_id = c.id
  FROM companies c
 WHERE l.company_id IS NULL
   AND COALESCE(l.bank_name, '') !~* 'HDFC|SBI|STATE BANK'
   AND norm_company_name(c.company_name) = norm_company_name('PRASAD TRANSPORT');

CREATE INDEX IF NOT EXISTS idx_loan_master_company ON loan_master (company_id);

COMMIT;
