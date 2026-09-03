-- 136_partner_vehicle_documents.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- FLEET PARTNER VEHICLE MANAGEMENT (owner directive, 2026-09-03)
--
--   "Fleet partner ko vehicle management ke liye subidha ho — doc renewal and
--    vehicle details management."
--
-- The office has had this since the Master Document Vault: a truck, its papers,
-- each with a number, an expiry and the original scan. A market partner had
-- none of it — market_vehicles carries five expiry DATES and nothing that
-- proves them, and partner_documents (the driver/partner upload pipe) had no
-- doc_type for a vehicle paper at all. So a partner whose insurance renewed had
-- exactly one way to tell us: ring the office.
--
-- After this migration a renewal is the same shape as every other external
-- write in this system: the partner uploads the paper with the new expiry, it
-- lands PENDING in partner_documents, and the office's APPROVE is what moves
-- the date onto market_vehicles (queues.routes applyToCore). A date on this
-- fleet therefore always has a document behind it, which is the property the
-- old free-typed expiry columns never had.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── 1. VEHICLE PAPERS ARE DOCUMENT TYPES ─────────────────────────────────────
-- The five market_vehicles already tracks, named after the columns they land
-- on, so the mapping in applyToCore is obvious rather than a lookup table.
DO $$
DECLARE cn text;
BEGIN
  SELECT conname INTO cn
    FROM pg_constraint
   WHERE conrelid = 'partner_documents'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%doc_type%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE partner_documents DROP CONSTRAINT %I', cn);
  END IF;
END $$;

ALTER TABLE partner_documents
  ADD CONSTRAINT partner_documents_doc_type_check
  CHECK (doc_type IN (
    'LOADING_INVOICE', 'CHALLAN', 'POD', 'TYRE_BILL', 'MAINTENANCE_BILL',
    'HSD_BILL', 'TOLL_BILL', 'OTHER_BILL', 'KYC', 'DL', 'AADHAAR',
    'BANK_BOOK', 'PAN', 'HZD', 'LOADING_QTY', 'UNLOADING_QTY', 'OTHER_DOC',
    -- migration 136 — a market truck's papers
    'RC', 'INSURANCE', 'FITNESS', 'PERMIT', 'PUC'
  ));

-- ── 2. WHAT A RENEWAL CARRIES ────────────────────────────────────────────────
-- vehicle_no is free text on this table and always has been; a renewal must
-- name the truck by id, or two partners with lookalike plates become one truck
-- at approval time. expiry_date is the date the paper claims — it is NOT
-- written to market_vehicles until the office approves.
ALTER TABLE partner_documents
  ADD COLUMN IF NOT EXISTS market_vehicle_id uuid REFERENCES market_vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expiry_date       date,
  ADD COLUMN IF NOT EXISTS doc_no            text;

CREATE INDEX IF NOT EXISTS idx_partner_docs_vehicle
  ON partner_documents (market_vehicle_id, created_at DESC)
  WHERE market_vehicle_id IS NOT NULL;

COMMIT;
