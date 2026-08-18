-- ═══════════════════════════════════════════════════════════════════════════
-- 093_driver_document_columns.sql — the four driver papers with nowhere to live
--
-- `drivers` already had a column per document for the licence, hazardous
-- endorsement, Aadhaar, PAN, bank passbook and photograph. The 2026-08-18
-- document import surfaced four more the office actually keeps and the schema
-- had no home for: police verification, voter ID, signature specimen and the
-- eye test. They queued fine and could be read, but assigning one returned
-- NO_COLUMN_FOR_TYPE because there was nothing to write to.
--
-- Stored as URLs beside the existing *_photo_url columns rather than in a
-- generic attachments table: every other driver document is addressed this way,
-- and one document type living somewhere different is how a form ends up with a
-- field nobody remembers to fill.
--
-- Only the eye test carries an expiry. A police verification is a point-in-time
-- check and a signature does not lapse, so neither gets a date column it would
-- only ever hold NULL in.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS police_verification_url  text,
  ADD COLUMN IF NOT EXISTS police_verified_on       date,
  ADD COLUMN IF NOT EXISTS voter_id_url             text,
  ADD COLUMN IF NOT EXISTS signature_url            text,
  ADD COLUMN IF NOT EXISTS eye_test_url             text,
  ADD COLUMN IF NOT EXISTS eye_test_expiry          date;

COMMENT ON COLUMN drivers.police_verification_url IS 'Police verification report. police_verified_on is when it was done — it does not expire on its own.';
COMMENT ON COLUMN drivers.eye_test_expiry IS 'Eye tests DO lapse; this feeds the compliance alert feed alongside licence and hazardous expiry.';

-- The eye test is a fitness-to-drive check with a date on it, so it belongs in
-- the same alert feed as the licence. Without this, a driver with a lapsed eye
-- test reads as fully compliant.
CREATE OR REPLACE VIEW v_compliance_alerts AS
WITH doc AS (
  SELECT 'VEHICLE'::text AS subject_kind,
         v.id AS subject_id, v.vehicle_no AS subject, v.ownership::text AS ownership,
         v.owner_name, v.branch,
         upper(d.doc_type) AS doc_type, COALESCE(d.doc_name, d.doc_type) AS doc_name,
         d.next_due_date AS expires_on, d.amount, d.receipt_no, d.voucher_id,
         'vehicle_documents'::text AS source
    FROM vehicle_documents d
    JOIN vehicles v ON v.id = d.vehicle_id
   WHERE d.next_due_date IS NOT NULL
),
col AS (
  SELECT 'VEHICLE'::text, v.id, v.vehicle_no, v.ownership::text, v.owner_name, v.branch,
         x.doc_type, x.doc_type, x.expires_on, NULL::numeric, NULL::text, NULL::uuid,
         'vehicles'::text
    FROM vehicles v
    CROSS JOIN LATERAL (VALUES
        ('INSURANCE',       v.insurance_expiry),
        ('FITNESS',         v.fitness_expiry),
        ('HOME_PERMIT',     v.permit_expiry),
        ('POLLUTION',       v.puc_expiry),
        ('MV_TAX',          v.tax_expiry),
        ('NATIONAL_PERMIT', v.national_permit_expiry)
      ) AS x(doc_type, expires_on)
   WHERE x.expires_on IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vehicle_documents d
                      WHERE d.vehicle_id = v.id
                        AND upper(d.doc_type) = x.doc_type
                        AND d.next_due_date IS NOT NULL)
),
drv AS (
  SELECT 'DRIVER'::text, d.id, d.name, NULL::text, NULL::text, NULL::text,
         y.doc_type, y.doc_type, y.expires_on, NULL::numeric, NULL::text, NULL::uuid,
         'drivers'::text
    FROM drivers d
    CROSS JOIN LATERAL (VALUES
        ('DRIVING_LICENCE',   d.license_expiry),
        ('HAZARDOUS_LICENCE', d.hzd_expiry),
        ('EYE_TEST',          d.eye_test_expiry)
      ) AS y(doc_type, expires_on)
   WHERE y.expires_on IS NOT NULL
)
SELECT subject_kind, subject_id, subject, ownership, owner_name, branch,
       doc_type, doc_name, expires_on, amount, receipt_no, voucher_id, source,
       (expires_on - CURRENT_DATE)::int AS days_left,
       CASE WHEN expires_on <  CURRENT_DATE                                  THEN 'EXPIRED'
            WHEN expires_on <= CURRENT_DATE + compliance_alert_days()        THEN 'EXPIRING'
            ELSE 'VALID' END AS status
  FROM (SELECT * FROM doc UNION ALL SELECT * FROM col UNION ALL SELECT * FROM drv) u;

COMMIT;
