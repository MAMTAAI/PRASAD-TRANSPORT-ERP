-- ═══════════════════════════════════════════════════════════════════════════
-- 095_compliance_gaps.sql — what is MISSING, not just what is expiring
--
-- The alert feed answers "what lapses soon". It is silent about the lorry that
-- has no insurance record at all, because a row that does not exist cannot have
-- a date that passes. Thirteen of forty-nine lorries carry no paperwork
-- whatsoever and the compliance screen reported them as green.
--
-- Absence and expiry are different failures and the office acts on them
-- differently — one is "renew this", the other is "find this" — so they are
-- reported side by side rather than merged into one count.
--
-- WHAT COUNTS AS REQUIRED
-- The six documents `vehicles` already denormalises into its own expiry
-- columns: insurance, fitness, national permit, home permit, pollution, MV tax.
-- That set is the system's existing answer to "which papers must every lorry
-- have", so the gap report uses it rather than inventing a second opinion.
-- Calibration, Rule 18, Rule 43 and CII are specialist and are counted as
-- present-or-not without being called missing.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_vehicle_gaps AS
WITH required(doc_type, label) AS (VALUES
  ('insurance',       'Insurance'),
  ('fitness',         'Fitness'),
  ('national_permit', 'National Permit'),
  ('home_permit',     'Home Permit'),
  ('pollution',       'PUC'),
  ('mv_tax',          'MV Tax')
),
held AS (
  SELECT vehicle_id, doc_type, next_due_date FROM vehicle_documents
)
SELECT v.id AS vehicle_id, v.vehicle_no, v.branch, v.owner_name,
       v.ownership::text AS ownership, v.status,
       (SELECT count(*)::int FROM held h WHERE h.vehicle_id = v.id) AS docs_held,
       -- Missing outright: no row for a required document at all.
       ARRAY(SELECT r.label FROM required r
              WHERE NOT EXISTS (SELECT 1 FROM held h
                                 WHERE h.vehicle_id = v.id AND h.doc_type = r.doc_type)
              ORDER BY r.label) AS missing_docs,
       -- Held but undated: the paper exists, the expiry does not, so nothing
       -- will ever alert on it. Quietly the worst state of the three.
       ARRAY(SELECT COALESCE(d.doc_name, d.doc_type) FROM vehicle_documents d
              WHERE d.vehicle_id = v.id AND d.next_due_date IS NULL
              ORDER BY 1) AS undated_docs,
       (SELECT count(*)::int FROM held h
         WHERE h.next_due_date IS NOT NULL AND h.next_due_date < CURRENT_DATE) AS expired_count,
       (SELECT count(*)::int FROM held h
         WHERE h.next_due_date IS NOT NULL
           AND h.next_due_date >= CURRENT_DATE
           AND h.next_due_date <= CURRENT_DATE + compliance_alert_days()) AS expiring_count
  FROM vehicles v;

CREATE OR REPLACE VIEW v_driver_gaps AS
SELECT d.id AS driver_id, d.name, d.mobile,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN d.license_no IS NULL OR d.license_no = ''  THEN 'Licence number' END,
         CASE WHEN d.license_expiry    IS NULL THEN 'Licence expiry'      END,
         CASE WHEN d.dl_photo_url      IS NULL THEN 'Licence copy'        END,
         CASE WHEN d.hzd_expiry        IS NULL THEN 'Hazardous expiry'    END,
         CASE WHEN d.hzd_photo_url     IS NULL THEN 'Hazardous copy'      END,
         CASE WHEN d.aadhar_photo_url  IS NULL THEN 'Aadhaar'             END,
         CASE WHEN d.pan_photo_url     IS NULL THEN 'PAN'                 END,
         CASE WHEN d.bank_photo_url    IS NULL THEN 'Bank passbook'       END,
         CASE WHEN d.profile_pic_url   IS NULL THEN 'Photograph'          END,
         CASE WHEN d.police_verification_url IS NULL THEN 'Police verification' END,
         CASE WHEN d.voter_id_url      IS NULL THEN 'Voter ID'            END,
         CASE WHEN d.signature_url     IS NULL THEN 'Signature'           END,
         CASE WHEN d.eye_test_url      IS NULL THEN 'Eye test'            END
       ], NULL) AS missing_fields,
       -- An expired licence is not a gap, it is a stop: this driver cannot
       -- legally take a load today.
       (d.license_expiry IS NOT NULL AND d.license_expiry < CURRENT_DATE) AS licence_expired,
       (d.hzd_expiry     IS NOT NULL AND d.hzd_expiry     < CURRENT_DATE) AS hazardous_expired,
       d.license_expiry, d.hzd_expiry, d.eye_test_expiry
  FROM drivers d;

-- One row the widget can read for its headline numbers without pulling every
-- vehicle and driver to the browser to count them.
CREATE OR REPLACE VIEW v_compliance_gap_summary AS
SELECT
  (SELECT count(*)::int FROM vehicles)                                              AS vehicles_total,
  (SELECT count(*)::int FROM v_vehicle_gaps WHERE docs_held = 0)                    AS vehicles_no_docs,
  (SELECT count(*)::int FROM v_vehicle_gaps WHERE cardinality(missing_docs) > 0)    AS vehicles_missing_docs,
  (SELECT count(*)::int FROM v_vehicle_gaps WHERE cardinality(undated_docs) > 0)    AS vehicles_undated_docs,
  (SELECT count(*)::int FROM v_vehicle_gaps WHERE expired_count  > 0)               AS vehicles_expired,
  (SELECT count(*)::int FROM v_vehicle_gaps WHERE expiring_count > 0)               AS vehicles_expiring,
  (SELECT count(*)::int FROM drivers)                                               AS drivers_total,
  (SELECT count(*)::int FROM v_driver_gaps WHERE cardinality(missing_fields) > 0)   AS drivers_missing_data,
  (SELECT count(*)::int FROM v_driver_gaps WHERE licence_expired)                   AS drivers_licence_expired,
  (SELECT count(*)::int FROM v_driver_gaps WHERE hazardous_expired)                 AS drivers_hazardous_expired,
  (SELECT count(*)::int FROM unmapped_documents WHERE status = 'PENDING')           AS queue_pending,
  (SELECT count(*)::int FROM unmapped_documents
    WHERE status = 'PENDING' AND reason = 'DRIVER_DOCUMENT')                        AS queue_driver_pending;

COMMENT ON VIEW v_vehicle_gaps IS
  'Absence, not expiry. A lorry with no insurance row cannot have an expiry date that passes, so the alert feed never mentions it.';

COMMIT;
