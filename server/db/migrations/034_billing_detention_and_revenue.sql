-- ═══════════════════════════════════════════════════════════════════════════
-- 034_billing_detention_and_revenue.sql — auto-billing moves to PostgreSQL.
--
-- MonthlyBilling.tsx wrote MONTHLY_INVOICES, which migration 026 already
-- declared superseded by `company_bills`. Two things were missing before it
-- could actually move.
--
-- 1. DETENTION. An oil company pays freight only; a monthly contract client
--    also pays detention — days a truck waited beyond the free allowance,
--    invoiced on its own number. company_bills had nowhere to put any of it,
--    so the figure would have been silently dropped from the bill.
--
-- 2. REVENUE HAD NOWHERE TO GO. Raising a bill in PostgreSQL posts NO voucher
--    today, and the Firestore screen posted its freight income to the
--    FIRESTORE journal — a different ledger entirely. So the revenue from every
--    auto-billed trip has never reached these books: `Freight Income` holds
--    only what the migration seeded. `voucher_id` below lets a bill carry the
--    SALES journal that recognises it (Dr Debtors / Cr Freight + Detention
--    Income), posted through TARA like every other entry.
--
-- ⚠️ THE KHATA MUST NOT DOUBLE-COUNT. The customer statement
-- (/masters/customers/:id/ledger) treats company_bills as the billed side
-- precisely BECAUSE bills did not post. Now that some will, it counts a bill
-- row only when `voucher_id IS NULL` — an unposted bill — and takes every
-- posted one from the ledger instead. Change one without the other and every
-- billed rupee appears twice.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE company_bills
  -- Detention is invoiced separately and often on its own number.
  ADD COLUMN IF NOT EXISTS detention_total   numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detention_rate    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detention_days    integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_days         integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS det_invoice_no    text,
  -- Advances already paid against these trips, netted off what is collectible.
  ADD COLUMN IF NOT EXISTS advance_deduction numeric(14,2) NOT NULL DEFAULT 0,
  -- The SALES journal that recognised this bill's revenue. NULL = not posted,
  -- which is what the khata keys off. See the warning above.
  ADD COLUMN IF NOT EXISTS voucher_id        uuid,
  ADD COLUMN IF NOT EXISTS billing_period    text;

CREATE INDEX IF NOT EXISTS company_bills_unposted_idx
  ON company_bills (bill_date DESC) WHERE voucher_id IS NULL AND status <> 'CANCELLED';

-- A detention invoice number is a real invoice number: unique when present.
CREATE UNIQUE INDEX IF NOT EXISTS company_bills_det_no_uniq
  ON company_bills (det_invoice_no) WHERE det_invoice_no IS NOT NULL AND det_invoice_no <> '';

COMMENT ON COLUMN company_bills.voucher_id IS
  'SALES journal recognising this bill. NULL = unposted; the customer khata counts the bill row only while this is NULL.';

COMMIT;
