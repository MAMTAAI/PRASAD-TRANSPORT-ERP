-- 139_vendor_kyc_category.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SERVICE VENDOR KYC (owner directive, 2026-09-03)
--
--   "Vendors must register using an OTP-gated form. They must submit their PAN,
--    Bank Details, and specify their Vendor Category (Fuel Pump, Mechanic,
--    Spare Parts). New Vendors go into a PENDING_KYC queue for verification
--    before their account is activated."
--
-- MOST OF THIS ALREADY EXISTS AND IS NOT REBUILT. onboarding_applications has
-- taken type='VENDOR' since migration 041; the OTP wall (135) and the PENDING_KYC
-- queue (134) are the same doors the customers and fleet partners walk through;
-- bank columns landed with 134. Bill submission and its posting are live since
-- the Vendor app shipped this morning: a portal bill lands in expense_approvals
-- with source='VENDOR_PORTAL', and /queues/expenses/:id/approve posts it through
-- TARA as Dr <expense ledger> / Cr Creditors: <vendor> — accounts payable.
--
-- The one thing the application could not carry is WHAT KIND of vendor is
-- applying. `vendors.vendor_type` holds that on the master ('Fuel Pump',
-- 'Spare Parts'), but the form had nowhere to put it, so the office had to ask
-- afterwards — and a vendor approved without it lands as an untyped row that no
-- category filter finds.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE onboarding_applications
  ADD COLUMN IF NOT EXISTS vendor_category text;

COMMENT ON COLUMN onboarding_applications.vendor_category IS
  'For type=VENDOR: the trade this applicant is in — becomes vendors.vendor_type on approval.';

-- The desk opens this queue by kind as often as by state.
CREATE INDEX IF NOT EXISTS idx_onboarding_vendor_category
  ON onboarding_applications (vendor_category)
  WHERE vendor_category IS NOT NULL;

COMMIT;
