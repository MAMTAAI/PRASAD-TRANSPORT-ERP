-- ═══════════════════════════════════════════════════════════════════════════
-- 027_driver_docs_and_approval.sql — custom driver documents, and the APPROVED step
--
-- Two things 026 got wrong about the Driver Master, both found by reading the
-- screen it has to replace rather than by guessing at the workflow.
--
-- 1. Drivers carry an open-ended set of extra documents beyond the fixed six
--    (licence, hazardous cert, Aadhaar, PAN, bank, photo). The screen lets an
--    operator name a document, attach it and give it its own expiry — police
--    verification, medical certificate, a bond. A column per document type would
--    need a migration every time the paperwork changes, so it is jsonb.
--
-- 2. The request queue has THREE live states, not two: a request is approved
--    first and paid second, often by different people. 026's CHECK allowed only
--    PENDING/PAID/REJECTED, which would have collapsed the approval into the
--    payment and removed the separation of duties the screen exists to enforce.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Shape: [{ id, name, link, valid_till }]. Kept as the screen already writes it
-- so migrated rows load unchanged.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS additional_docs jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN drivers.additional_docs IS
  'Operator-defined documents: [{id, name, link, valid_till}]. The six fixed KYC documents have their own columns.';

-- Approved-but-unpaid is a real state a request sits in, so it gets a value
-- rather than being inferred from a null timestamp.
ALTER TABLE driver_requests DROP CONSTRAINT IF EXISTS driver_requests_status_check;
ALTER TABLE driver_requests ADD CONSTRAINT driver_requests_status_check
  CHECK (status IN ('PENDING','APPROVED','PAID','REJECTED'));

ALTER TABLE driver_requests
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text;

-- Both PENDING and APPROVED are "still open"; the queue shows them together.
DROP INDEX IF EXISTS idx_driver_req_pending;
CREATE INDEX IF NOT EXISTS idx_driver_req_open
  ON driver_requests (requested_at DESC) WHERE status IN ('PENDING','APPROVED');

COMMIT;
