-- ═══════════════════════════════════════════════════════════════════════════
-- 028_vehicle_master_and_documents.sql — fleet master fields, and compliance docs
--
-- Two additions the fleet screens need.
--
-- 1. FLEET MASTER FIELDS. `vehicles` carried the identity and the six statutory
--    expiry dates but not the commercial detail the fleet master maintains:
--    which plant a truck is attached to, its contract reference, gross/unladen
--    weight, who it is hypothecated to, its book value. Several of the form's
--    fields DID have homes and are mapped rather than duplicated —
--    veh_class -> vehicle_type, modal_no -> make_model, own_attach -> ownership,
--    no_of_tyres -> tyre_count.
--
-- 2. VEHICLE_DOCUMENTS. The compliance screen keeps eleven statutory documents
--    per vehicle (fitness, insurance, explosive licence, calibration, Rule 18
--    hydro test, Rule 43, CII, national/home permit, PUC, MV tax) plus custom
--    ones, each with its own application number, receipt, fee, inspection date
--    and next due date. Firestore nested that under vehicle.documents.<type>;
--    a nested map cannot be indexed, joined or asked "what expires next month",
--    which is the whole question a compliance register exists to answer.
--
--    next_due_date here is the SOURCE OF TRUTH for every document type. The six
--    expiry columns on `vehicles` stay as a denormalised cache because other
--    screens already read them — but they are written by the same endpoint that
--    writes this table, so the two cannot drift. Do not update them elsewhere.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Fleet master fields ──────────────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS branch            text,
  ADD COLUMN IF NOT EXISTS vehicle_category  text,
  ADD COLUMN IF NOT EXISTS plant_attached    text,
  ADD COLUMN IF NOT EXISTS contract_ref      text,
  ADD COLUMN IF NOT EXISTS contract_validity date,
  ADD COLUMN IF NOT EXISTS fuel_type         text,
  ADD COLUMN IF NOT EXISTS gross_weight      numeric(12,3),
  ADD COLUMN IF NOT EXISTS unladen_weight    numeric(12,3),
  ADD COLUMN IF NOT EXISTS hypothecated_to   text,
  ADD COLUMN IF NOT EXISTS vehicle_value     numeric(14,2),
  ADD COLUMN IF NOT EXISTS mfg_date          date,
  -- An attached truck is approved before it may be dispatched. Own vehicles are
  -- approved by definition, which the default states rather than leaving NULL.
  ADD COLUMN IF NOT EXISTS approval_status   text NOT NULL DEFAULT 'APPROVED'
    CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
  -- The tyre COUNT is a number; the form offers layouts like '10+1'. Both are
  -- worth keeping: tyre_count for arithmetic, tyre_config for what was ordered.
  ADD COLUMN IF NOT EXISTS tyre_config       text;

CREATE INDEX IF NOT EXISTS idx_vehicles_branch   ON vehicles (branch) WHERE branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicles_approval ON vehicles (approval_status)
  WHERE approval_status <> 'APPROVED';

-- ── 2. Compliance documents ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id      text UNIQUE,
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  -- 'fitness', 'insurance', … or 'custom_<slug>' for an operator-defined one.
  doc_type       text NOT NULL,
  doc_name       text,                        -- display name, needed for custom types
  application_no text,
  receipt_no     text,
  inspected_on   date,
  next_due_date  date,
  amount         numeric(14,2),
  payment_mode   text,
  document_url   text,
  -- The PAYMENT voucher this fee was posted under, when a fee was paid. NULL
  -- means the document is recorded but no money was posted for it.
  voucher_id     uuid,
  remarks        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per document type per vehicle: saving the fitness tab twice updates,
-- it does not accumulate. This replaces the nested-map key in Firestore.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_doc_type
  ON vehicle_documents (vehicle_id, doc_type);

-- "What expires in the next 30 days, across the fleet" — the question a nested
-- map could not answer at all.
CREATE INDEX IF NOT EXISTS idx_vehicle_docs_due
  ON vehicle_documents (next_due_date) WHERE next_due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_docs_vehicle
  ON vehicle_documents (vehicle_id);

-- ── 3. Fleet compliance register ────────────────────────────────────────────
-- One row per vehicle document with its days-to-expiry, so the register and the
-- expiring-soon alerts are a query rather than a client-side scan.
CREATE OR REPLACE VIEW v_vehicle_compliance AS
SELECT d.id, d.vehicle_id, v.vehicle_no, v.owner_name, v.branch, v.ownership::text AS ownership,
       d.doc_type, COALESCE(d.doc_name, d.doc_type) AS doc_name,
       d.application_no, d.receipt_no, d.inspected_on, d.next_due_date,
       d.amount, d.payment_mode, d.document_url, d.voucher_id,
       (d.next_due_date - CURRENT_DATE) AS days_to_expiry,
       CASE WHEN d.next_due_date IS NULL                          THEN 'UNKNOWN'
            WHEN d.next_due_date <  CURRENT_DATE                  THEN 'EXPIRED'
            WHEN d.next_due_date <= CURRENT_DATE + INTERVAL '15 days' THEN 'EXPIRING'
            ELSE 'VALID' END AS compliance_state
  FROM vehicle_documents d
  JOIN vehicles v ON v.id = d.vehicle_id;

COMMIT;
