-- 119_compliance_renewed_on.sql
-- ---------------------------------------------------------------------------
-- Carry the RENEWAL date beside the expiry date in the alert feed.
--
-- WHY. The watch list could say "expired 139d" but never when the paper was
-- last renewed, and those two facts answer different questions. "Expires in
-- 8 days" on a certificate renewed last week is a clerical follow-up; the same
-- eight days on one renewed three years ago is a document nobody has touched
-- since, and the office treats them differently. Without the issue date the
-- list could not tell them apart, so every row looked equally urgent.
--
-- WHERE IT COMES FROM, and where it honestly does not:
--   vehicle_documents.inspected_on — the real thing, per document row.
--   the denormalised vehicle columns — a bare expiry date with no issue date
--     anywhere, so NULL. Showing the expiry twice would be a lie dressed as
--     data.
--   drivers — the master holds licence EXPIRY only; there is no issue-date
--     column, so NULL again. join_date is employment, not the licence.
--
-- CREATE OR REPLACE VIEW cannot insert a column in the middle: existing columns
-- must keep their position and type, and new ones go at the END. So renewed_on
-- is appended after `status` rather than sitting next to expires_on where it
-- reads better. The view's consumers name their columns, so the position costs
-- nothing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_compliance_alerts AS
WITH doc AS (
  SELECT 'VEHICLE'::text AS subject_kind,
         v.id AS subject_id, v.vehicle_no AS subject, v.ownership::text AS ownership,
         v.owner_name, v.branch,
         upper(d.doc_type) AS doc_type, COALESCE(d.doc_name, d.doc_type) AS doc_name,
         d.next_due_date AS expires_on, d.amount, d.receipt_no, d.voucher_id,
         'vehicle_documents'::text AS source,
         d.inspected_on AS renewed_on
    FROM vehicle_documents d
    JOIN vehicles v ON v.id = d.vehicle_id
   WHERE d.next_due_date IS NOT NULL
),
col AS (
  SELECT 'VEHICLE'::text, v.id, v.vehicle_no, v.ownership::text, v.owner_name, v.branch,
         x.doc_type, x.doc_type, x.expires_on, NULL::numeric, NULL::text, NULL::uuid,
         'vehicles'::text, NULL::date
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
         'drivers'::text, NULL::date
    FROM drivers d
    CROSS JOIN LATERAL (VALUES
        ('DRIVING_LICENCE', d.license_expiry),
        ('HAZARDOUS_LICENCE', d.hzd_expiry)
      ) AS y(doc_type, expires_on)
   WHERE y.expires_on IS NOT NULL
)
SELECT subject_kind, subject_id, subject, ownership, owner_name, branch,
       doc_type, doc_name, expires_on, amount, receipt_no, voucher_id, source,
       (expires_on - CURRENT_DATE) AS days_left,
       CASE
         WHEN expires_on < CURRENT_DATE THEN 'EXPIRED'
         WHEN expires_on <= CURRENT_DATE + compliance_alert_days() THEN 'EXPIRING'
         ELSE 'VALID'
       END AS status,
       renewed_on
  FROM (SELECT * FROM doc UNION ALL SELECT * FROM col UNION ALL SELECT * FROM drv) u;

COMMENT ON VIEW v_compliance_alerts IS
  'Every expiry the fleet has to watch — vehicle documents, the denormalised '
  'vehicle expiry columns, and driver licences — with days_left, a status '
  'judged against compliance_alert_days(), and the renewal date where one is '
  'recorded (NULL for bare expiry columns and for driver licences, which keep '
  'no issue date).';
