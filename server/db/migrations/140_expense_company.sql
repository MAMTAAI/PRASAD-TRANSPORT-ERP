-- 140_expense_company.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- WHICH COMPANY IS THIS BILL AGAINST? (owner directive, 2026-09-03)
--
--   "When a Vendor submits a bill (or when Admin verifies it), include a
--    dropdown to select which specific Group Entity / Operating Company the
--    bill belongs to. Ensure approved bills automatically credit the vendor and
--    debit the expenses under that specific company's ledger."
--
-- The ledger half already works: ledger_entries carries company / company_id /
-- branch / branch_id on every leg, and TARA's postVoucher stamps them from the
-- voucher it is handed. What was missing is the question being ASKED — an
-- expense bill had nowhere to record which of the three operating firms it
-- belonged to, so every approval posted with company NULL and all three sets of
-- books shared one pile of diesel.
--
-- NOT entity_id. That column points at entity_master, a different and unused
-- table (0 of 8 rows populated); companies is what the ledger, the dashboards
-- and the P&L actually group by.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE expense_approvals
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL;

COMMENT ON COLUMN expense_approvals.company_id IS
  'The operating company this expense belongs to. Chosen by the vendor on the '
  'bill, changeable by the office at approval, and stamped onto both ledger legs.';

-- The desk filters the queue by company as often as by state.
CREATE INDEX IF NOT EXISTS idx_expense_approvals_company
  ON expense_approvals (company_id, status, created_at DESC);

COMMIT;
