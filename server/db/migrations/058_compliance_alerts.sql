-- 058_compliance_alerts.sql
-- ---------------------------------------------------------------------------
-- One place to ask "what expires soon", across every kind of paper the fleet
-- has to keep current.
--
-- WHY THE OLD VIEW ANSWERED NOTHING. v_vehicle_compliance reads
-- vehicle_documents, and that table is empty — not one row for 49 lorries. So
-- the compliance screen has been truthfully reporting an empty database while
-- 33 driver licences and 18 hazardous-goods endorsements sit in `drivers` with
-- real expiry dates, unwatched. A licence that lapses stops a truck just as
-- surely as a lapsed fitness certificate, so both belong in the same alert.
--
-- WHY VEHICLES ARE READ TWICE. Expiry lives in two places by design: the
-- per-document row in vehicle_documents (with its fee, receipt and voucher),
-- and a denormalised column on vehicles that masters.routes.js keeps in step
-- inside the same transaction. Either can exist without the other — a date can
-- be typed onto the vehicle without a document, which is exactly the state 49
-- lorries would be in if someone filled the columns in tomorrow. Both are
-- surfaced, and the document row wins where they overlap so a fee and receipt
-- are never hidden behind a bare date.
--
-- THE THRESHOLD IS 10 DAYS, not the 15 the old view used. Ten working days is
-- what it takes to get an insurance renewal or a fitness slot in Bongaigaon;
-- the number is the operator's, not a default.
-- ---------------------------------------------------------------------------

-- The alert window, in one place, so the view and any caller agree.
CREATE OR REPLACE FUNCTION compliance_alert_days() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 10 $fn$;

-- Keep the existing per-document view, but at the same threshold as the alerts
-- so two screens can never disagree about whether a document is "expiring".
CREATE OR REPLACE VIEW v_vehicle_compliance AS
  SELECT d.id, d.vehicle_id, v.vehicle_no, v.owner_name, v.branch,
         v.ownership::text AS ownership,
         d.doc_type, COALESCE(d.doc_name, d.doc_type) AS doc_name,
         d.application_no, d.receipt_no, d.inspected_on, d.next_due_date,
         d.amount, d.payment_mode, d.document_url, d.voucher_id,
         d.next_due_date - CURRENT_DATE AS days_to_expiry,
         CASE
           WHEN d.next_due_date IS NULL THEN 'UNKNOWN'
           WHEN d.next_due_date < CURRENT_DATE THEN 'EXPIRED'
           WHEN d.next_due_date <= CURRENT_DATE + compliance_alert_days() THEN 'EXPIRING'
           ELSE 'VALID'
         END AS compliance_state
    FROM vehicle_documents d
    JOIN vehicles v ON v.id = d.vehicle_id;

-- ── the unified alert feed ────────────────────────────────────────────────
-- subject_kind tells the caller whether it is looking at a lorry or a person,
-- because the action differs: a vehicle document is renewed, a driver licence
-- means that driver stops driving.
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
-- The denormalised columns, unpivoted. Excluded where a document row already
-- covers that vehicle and type, so the fee-bearing row is the one that shows.
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
       END AS status
  FROM (SELECT * FROM doc UNION ALL SELECT * FROM col UNION ALL SELECT * FROM drv) u;

COMMENT ON VIEW v_compliance_alerts IS
  'Every expiry the fleet has to watch — vehicle documents, the denormalised '
  'vehicle expiry columns, and driver licences — with days_left and a status '
  'judged against compliance_alert_days().';
