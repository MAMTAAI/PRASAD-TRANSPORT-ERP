-- 134_customer_kyc_onboarding.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- CUSTOMER KYC & ONBOARDING (owner directive, 2026-09-03)
--
--   "Public Registration ... KYC form collects Company Details, GSTIN, PAN and
--    Bank Details ... new customers go into a PENDING_KYC state ... admin
--    verifies and manually Approves & Activates ... they cannot use the app
--    until activated ... active customers may update Bank Details from the
--    Customer App profile."
--
-- Most of that workflow already exists and is NOT rebuilt here:
-- onboarding_applications (migration 041) already carries a CUSTOMER-typed
-- application, POST /api/v1/bazaar/onboarding is already public, KycApprovals
-- already runs the GSTIN/PAN checks and its approve already opens
-- customers.is_approved_for_portal and creates the OTP login. This migration
-- closes the three real gaps: bank details, the owner's state name, and a
-- quarantined way for a live customer to change their bank account.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── 1. BANK DETAILS ON THE APPLICATION ───────────────────────────────────────
-- Same column names the drivers table already uses (bank_name / account_no /
-- ifsc_code), so one reader shape works for every party we hold an account for.
-- The account number is NOT unique here: a proprietor may apply twice, and the
-- desk — not a constraint — decides whether that is the same firm.
ALTER TABLE onboarding_applications
  ADD COLUMN IF NOT EXISTS email      text,
  ADD COLUMN IF NOT EXISTS bank_name  text,
  ADD COLUMN IF NOT EXISTS account_no text,
  ADD COLUMN IF NOT EXISTS ifsc_code  text;

-- ── 2. 'PENDING_KYC' IS THE STATE'S NAME ─────────────────────────────────────
-- The queue counts, the sidebar badge and the Approval Desk have all called
-- this "pending_kyc" since 31-Aug while the column said 'SUBMITTED'. The owner
-- named it PENDING_KYC on 3-Sep, so the column now says what everything else
-- already said. Existing rows are carried over — one name, not two.
DO $$
DECLARE cn text;
BEGIN
  SELECT conname INTO cn
    FROM pg_constraint
   WHERE conrelid = 'onboarding_applications'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE onboarding_applications DROP CONSTRAINT %I', cn);
  END IF;
END $$;

UPDATE onboarding_applications SET status = 'PENDING_KYC' WHERE status = 'SUBMITTED';

ALTER TABLE onboarding_applications
  ADD CONSTRAINT onboarding_applications_status_check
  CHECK (status IN ('PENDING_KYC', 'APPROVED', 'REJECTED'));

ALTER TABLE onboarding_applications ALTER COLUMN status SET DEFAULT 'PENDING_KYC';

-- The desk opens this queue by state, and the duplicate check on a new
-- application looks the firm up by GSTIN and by mobile.
CREATE INDEX IF NOT EXISTS idx_onboarding_status_type
  ON onboarding_applications (status, type, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_gst    ON onboarding_applications (gst_no)    WHERE gst_no    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_mobile ON onboarding_applications (mobile_no) WHERE mobile_no IS NOT NULL;

-- ── 3. BANK DETAILS ON THE CUSTOMER MASTER ───────────────────────────────────
-- Where an approved application's account lands, and what the Customer App
-- shows the customer about themselves.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS bank_name  text,
  ADD COLUMN IF NOT EXISTS account_no text,
  ADD COLUMN IF NOT EXISTS ifsc_code  text;

-- ── 4. A CUSTOMER CHANGING ITS OWN BANK ACCOUNT IS A REQUEST, NOT AN EDIT ────
-- customers is a master, and the 2-Sep quarantine fence (server/lib/staging.js)
-- refuses a CUSTOMER session any write to it — correctly: a bank account is the
-- single most attractive field in this database to a stranger holding a stolen
-- handset. So the phone writes here, the row WAITS, and the office moves it
-- onto the master. The previous values ride along so the desk sees the change
-- as a diff and can put it back.
CREATE TABLE IF NOT EXISTS bank_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type      text NOT NULL CHECK (party_type IN ('CUSTOMER', 'VENDOR')),
  party_id        uuid NOT NULL,
  bank_name       text,
  account_no      text,
  ifsc_code       text,
  prev_bank_name  text,
  prev_account_no text,
  prev_ifsc_code  text,
  note            text,
  requested_by    uuid,
  requested_name  text,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reject_reason   text,
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One open request per party: a second submission edits the first rather than
-- leaving the desk two accounts and no way to tell which one is meant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_change_open
  ON bank_change_requests (party_type, party_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_bank_change_queue
  ON bank_change_requests (status, created_at DESC);

COMMIT;
