-- ═══════════════════════════════════════════════════════════════════════════
-- 116_partner_documents.sql — the document inbox for driver & vendor apps
--
-- The owner's mandate (2026-08-31): a driver photographs EVERY paper from the
-- cab — the loading invoice, the challan, a tyre bill, a maintenance bill, an
-- HSD slip — and a vendor uploads their own bills, all from the phone. None
-- of it touches the live system until office staff open the photo, check it,
-- and approve.
--
-- This table is that inbox. It is WORKFLOW STATE, never a ledger:
--   * the money path on approval is an expense_approvals row (045), which
--     itself waits in the Pending Expenses queue for the money approval that
--     posts the TARA voucher. Two eyes on the photo, two eyes on the rupees —
--     and the GL still has exactly one writer.
--   * the file itself lives in the uploader's own vault namespace
--     (up/<role>/<id>/…, files.routes), referenced here by key.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS partner_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  uploader_role  text NOT NULL CHECK (uploader_role IN ('DRIVER','VENDOR')),
  driver_id      uuid REFERENCES drivers(id),
  vendor_id      uuid REFERENCES vendors(id),
  uploader_name  text NOT NULL,
  CONSTRAINT partner_documents_uploader CHECK (
    (uploader_role = 'DRIVER' AND driver_id IS NOT NULL) OR
    (uploader_role = 'VENDOR' AND vendor_id IS NOT NULL)
  ),

  -- What the uploader says this is. A bounded list so the review screen can
  -- group and the auto-filing knows an expense from a document.
  doc_type       text NOT NULL CHECK (doc_type IN
                   ('LOADING_INVOICE','CHALLAN','POD',
                    'TYRE_BILL','MAINTENANCE_BILL','HSD_BILL','TOLL_BILL','OTHER_BILL',
                    'KYC','OTHER_DOC')),
  file_key       text NOT NULL,          -- storage key in the uploader's vault tree
  trip_id        uuid REFERENCES trips(id),
  vehicle_no     text,
  amount         numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  bill_no        text,
  bill_date      date,
  remarks        text,

  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by    text,
  reviewed_at    timestamptz,
  reject_reason  text,
  -- When approval auto-filed the bill into the money queue, the link lives
  -- here — one photo can never become two expenses.
  expense_approval_id uuid REFERENCES expense_approvals(id),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_documents_status
  ON partner_documents (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_documents_driver
  ON partner_documents (driver_id, created_at DESC) WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_documents_vendor
  ON partner_documents (vendor_id, created_at DESC) WHERE vendor_id IS NOT NULL;

COMMIT;
