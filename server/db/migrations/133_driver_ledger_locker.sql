-- ═════════════════════════════════════════════════════════════════════════════
-- 133 — Driver App v4 + Driver Control drawer (owner approvals, 2026-09-03)
--
-- 1. PAN and the Hazardous certificate become papers the driver app can send
--    (partner_documents.doc_type). Approve applies them to drivers.pan_* and
--    drivers.hzd_* — see queues.routes applyToCore.
-- 2. trip_hsd_issues — every litre the office issues against a trip, with the
--    pump and slip. trips.hsd_issued (which the settlement already reads) is
--    kept as the running total; this table is the audit line under it.
-- 3. driver_notices — the in-app banner the owner asked for beside WhatsApp:
--    a rejected paper, a paper the office is asking for, a ledger issue, an
--    access change. The driver marks one seen; nothing else is written from
--    the phone (see server/lib/staging.js — driver_notices is a staging table
--    for that one column).
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE partner_documents DROP CONSTRAINT IF EXISTS partner_documents_doc_type_check;
ALTER TABLE partner_documents ADD CONSTRAINT partner_documents_doc_type_check CHECK (doc_type IN
  ('LOADING_INVOICE','CHALLAN','POD',
   'TYRE_BILL','MAINTENANCE_BILL','HSD_BILL','TOLL_BILL','OTHER_BILL',
   'KYC','DL','AADHAAR','BANK_BOOK','PAN','HZD',
   'LOADING_QTY','UNLOADING_QTY',
   'OTHER_DOC'));

CREATE TABLE IF NOT EXISTS trip_hsd_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id   uuid REFERENCES drivers(id) ON DELETE SET NULL,
  vehicle_no  text,
  litres      numeric(10,3) NOT NULL CHECK (litres > 0),
  rate        numeric(10,2) CHECK (rate IS NULL OR rate >= 0),
  amount      numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  pump_name   text,
  vendor_id   uuid,
  slip_no     text,
  remarks     text,
  issued_by   text,
  issued_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_hsd_issues_trip   ON trip_hsd_issues (trip_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_trip_hsd_issues_driver ON trip_hsd_issues (driver_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS driver_notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'INFO'
              CHECK (kind IN ('INFO','DOC_REJECTED','DOC_REQUEST','LEDGER','ACCESS')),
  title       text NOT NULL,
  body        text,
  ref_table   text,
  ref_id      uuid,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_driver_notices_unseen ON driver_notices (driver_id, created_at DESC)
  WHERE seen_at IS NULL;

COMMIT;
