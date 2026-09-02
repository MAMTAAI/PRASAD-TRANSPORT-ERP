-- 132_partner_documents_ocr.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- DRIVER UPLOADS → OCR → THE "MILAN" AUDIT (owner directive, 2026-09-02).
--
-- partner_documents is the quarantine for everything a driver or partner
-- photographs. Two things change here:
--
--   1. More kinds of paper. The driver app may now send its own KYC papers
--      (DL, AADHAAR, BANK_BOOK) and its loading / unloading quantity reports
--      (LOADING_QTY, UNLOADING_QTY) — all of them staged, none of them touching
--      drivers or trips until the office approves.
--   2. What BHUVANESHWARI read on the paper. The agent runs the scan pipeline
--      (tesseract + patterns + the local model) OFF the request path and writes
--      its proposal here: ocr_data beside the image, so the desk can show the
--      extracted values against the photo for a one-look audit ("milan").
--      OCR is a proposal, never a posting: approve applies the admin's final
--      (possibly corrected) values, and applied_to records what was written.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE partner_documents DROP CONSTRAINT IF EXISTS partner_documents_doc_type_check;
ALTER TABLE partner_documents ADD CONSTRAINT partner_documents_doc_type_check CHECK (doc_type IN
  ('LOADING_INVOICE','CHALLAN','POD',
   'TYRE_BILL','MAINTENANCE_BILL','HSD_BILL','TOLL_BILL','OTHER_BILL',
   'KYC','DL','AADHAAR','BANK_BOOK',
   'LOADING_QTY','UNLOADING_QTY',
   'OTHER_DOC'));

-- A rejection is feedback, not a verdict: the paper goes back to the uploader's
-- own portal as NEEDS_CORRECTION with the office's reason, and a corrected
-- photo comes in as a new row. REJECTED stays valid for the rows already there.
ALTER TABLE partner_documents DROP CONSTRAINT IF EXISTS partner_documents_status_check;
ALTER TABLE partner_documents ADD CONSTRAINT partner_documents_status_check
  CHECK (status IN ('PENDING','APPROVED','REJECTED','NEEDS_CORRECTION'));

ALTER TABLE partner_documents
  ADD COLUMN IF NOT EXISTS qty         numeric(14,3) CHECK (qty IS NULL OR qty >= 0),
  ADD COLUMN IF NOT EXISTS ocr_status  text NOT NULL DEFAULT 'PENDING'
    CHECK (ocr_status IN ('PENDING','RUNNING','DONE','FAILED','SKIPPED')),
  ADD COLUMN IF NOT EXISTS ocr_data    jsonb,
  ADD COLUMN IF NOT EXISTS ocr_text    text,
  ADD COLUMN IF NOT EXISTS ocr_engine  text,
  ADD COLUMN IF NOT EXISTS ocr_at      timestamptz,
  ADD COLUMN IF NOT EXISTS ocr_error   text,
  ADD COLUMN IF NOT EXISTS applied_to  jsonb;

-- The agent's catch-up query: "what is still unread", newest first.
CREATE INDEX IF NOT EXISTS idx_partner_documents_ocr_pending
  ON partner_documents (created_at DESC) WHERE ocr_status = 'PENDING';

COMMIT;
