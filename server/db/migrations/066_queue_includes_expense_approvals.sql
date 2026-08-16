-- ═══════════════════════════════════════════════════════════════════════════
-- 066_queue_includes_expense_approvals.sql — the queue was missing the table
-- the compliance fees actually land in
--
-- v_approval_queue (061) unioned fuel_entries, company_bills, owner_expenses,
-- trips and fuel_import_review — every money table EXCEPT expense_approvals,
-- which is where a document-renewal fee now waits. The effect was quietly bad:
-- the fee was correctly held out of the cashbook, and correctly invisible to the
-- admin who was supposed to release it. A queue that does not show an item is
-- indistinguishable from an item that was never raised.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_approval_queue AS
  SELECT 'fuel_entries'::text AS source_table, f.id AS source_id,
         f.approval_status, f.submitted_at, f.submitted_by,
         COALESCE(f.amount,0)::numeric(16,2) AS amount,
         COALESCE(f.vehicle_no, '') AS subject,
         'Fuel ' || COALESCE(f.liters::text,'?') || ' L' AS detail,
         f.created_at
    FROM fuel_entries f WHERE f.approval_status IN ('DRAFT','PENDING_APPROVAL')
  UNION ALL
  SELECT 'company_bills', b.id, b.approval_status, b.submitted_at, b.submitted_by,
         COALESCE(b.total_gross,0)::numeric(16,2), COALESCE(b.bill_no,''),
         'Company bill', b.created_at
    FROM company_bills b WHERE b.approval_status IN ('DRAFT','PENDING_APPROVAL')
  UNION ALL
  SELECT 'owner_expenses', o.id, o.approval_status, o.submitted_at, o.submitted_by,
         COALESCE(o.amount,0)::numeric(16,2), COALESCE(o.kind,''),
         'Owner expense', o.created_at
    FROM owner_expenses o WHERE o.approval_status IN ('DRAFT','PENDING_APPROVAL')
  UNION ALL
  -- The one that was missing. Document-renewal fees wait here.
  SELECT 'expense_approvals', e.id, e.approval_status, e.submitted_at, e.submitted_by,
         COALESCE(e.amount,0)::numeric(16,2),
         COALESCE(e.vehicle_no, e.vendor_name, e.driver_name, ''),
         COALESCE(e.description, e.expense_type), e.created_at
    FROM expense_approvals e WHERE e.approval_status IN ('DRAFT','PENDING_APPROVAL')
  UNION ALL
  SELECT 'trips', t.id, t.approval_status, t.submitted_at, t.submitted_by,
         COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0)::numeric(16,2),
         COALESCE(t.vehicle_no,''), 'Trip closure ' || COALESCE(t.trip_code,''),
         t.created_at
    FROM trips t WHERE t.approval_status IN ('DRAFT','PENDING_APPROVAL')
  UNION ALL
  SELECT 'fuel_import_review', r.id, r.approval_status, r.submitted_at, r.submitted_by,
         COALESCE(r.amount,0)::numeric(16,2), COALESCE(r.pump,''),
         'Parsed fuel row awaiting review', r.created_at
    FROM fuel_import_review r WHERE r.approval_status IN ('DRAFT','PENDING_APPROVAL');

COMMIT;
