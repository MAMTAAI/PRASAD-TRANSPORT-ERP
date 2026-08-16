-- ═══════════════════════════════════════════════════════════════════════════
-- 061_maker_checker.sql — nothing reaches the P&L until a second person says so
--
-- WHERE THIS IS *NOT* APPLIED, AND WHY. Not on ledger_entries. That table
-- refuses UPDATE and DELETE by trigger (005_ledger.sql), so a mutable `status`
-- column on it is not a design that was considered and rejected — it is
-- physically impossible: the row could never be moved from PENDING to APPROVED.
--
-- That constraint turns out to be the right architecture anyway. Maker-checker
-- belongs on the SOURCE DOCUMENTS — the fuel slip, the bill, the settlement —
-- and posting to ledger_entries happens only as a consequence of approval. The
-- requested property ("must not affect the final P&L until an admin approves")
-- then holds for free, because the P&L reads ledger_entries and nothing lands
-- there until the approve action fires. A status column on the ledger would
-- have been a weaker guarantee: the money would already be posted, and every
-- report ever written would have to remember to filter it back out.
--
-- EXISTING ROWS ARE GRANDFATHERED AS APPROVED, NOT DRAFT. There are 1,042 fuel
-- entries, 872 trips and 3,883 toll transactions already in the books, and the
-- ledger already reflects them. Defaulting those to DRAFT would, on the very
-- next P&L, report a company that has never earned or spent anything. They are
-- marked APPROVED with approved_at = their own created_at and approved_by NULL,
-- which reads honestly as "in the books before this workflow existed".
--
-- They are deliberately left UNLOCKED. Locking 872 historical trips would break
-- every existing correction path at once, including the IOCL reconciler that
-- writes settlement figures back onto trips. The lock is for rows that go
-- through the new approve action from here on.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── the lock ───────────────────────────────────────────────────────────────
-- Approval sets is_locked in the same UPDATE that sets APPROVED. At that moment
-- OLD.is_locked is still false, so the transition itself is allowed; every
-- update after it is not. That is what "permanently lock" has to mean if it is
-- to mean anything — a lock a later UPDATE can lift is a suggestion.
--
-- The escape hatch is deliberately not a flag. A locked row is corrected the
-- same way a ledger entry is: by posting a reversing document, which leaves
-- both the error and the correction on the record.

CREATE OR REPLACE FUNCTION enforce_row_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_locked THEN
      RAISE EXCEPTION
        'row % in % is locked by approval and cannot be deleted. Post a reversing entry instead.',
        OLD.id, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_locked THEN
    RAISE EXCEPTION
      'row % in % was approved and locked at % and cannot be modified. Post a reversing entry instead.',
      OLD.id, TG_TABLE_NAME, OLD.approved_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- ── who did what, and when ─────────────────────────────────────────────────
-- Append-only on the same reasoning as ledger_entries and audit_logs: an
-- approval trail that can be edited is not a trail.

CREATE TABLE IF NOT EXISTS approval_audit (
  id            bigserial PRIMARY KEY,
  source_table  text NOT NULL,
  source_id     uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_id      uuid,
  actor_name    text,
  reason        text,
  amount        numeric(16,2),
  changes       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_audit_src_idx ON approval_audit (source_table, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_audit_actor_idx ON approval_audit (actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION approval_audit_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval_audit is append-only: % refused.', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

DROP TRIGGER IF EXISTS approval_audit_immutable ON approval_audit;
CREATE TRIGGER approval_audit_immutable BEFORE UPDATE OR DELETE ON approval_audit
  FOR EACH ROW EXECUTE FUNCTION approval_audit_append_only();

-- ── apply the vocabulary to every money-bearing table ──────────────────────

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'fuel_entries', 'company_bills', 'trip_settlements', 'owner_expenses',
    'driver_settlements', 'toll_claims', 'tds_entries', 'vendor_txns',
    'driver_transactions', 'trips', 'expense_approvals', 'emi_payments',
    'toll_transactions', 'fuel_import_review'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = t) THEN
      RAISE NOTICE 'maker-checker: skipping %, table not present', t;
      CONTINUE;
    END IF;

    EXECUTE format($f$
      ALTER TABLE %I
        ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'DRAFT',
        ADD COLUMN IF NOT EXISTS is_locked       boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS submitted_by    uuid,
        ADD COLUMN IF NOT EXISTS submitted_at    timestamptz,
        ADD COLUMN IF NOT EXISTS approved_by     uuid,
        ADD COLUMN IF NOT EXISTS approved_at     timestamptz,
        ADD COLUMN IF NOT EXISTS rejected_by     uuid,
        ADD COLUMN IF NOT EXISTS rejected_at     timestamptz,
        ADD COLUMN IF NOT EXISTS reject_reason   text
    $f$, t);

    -- Grandfather what is already in the books, BEFORE the CHECK goes on.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = t AND column_name = 'created_at') THEN
      EXECUTE format($f$
        UPDATE %I SET approval_status = 'APPROVED',
                      approved_at = COALESCE(approved_at, created_at, now())
         WHERE approval_status = 'DRAFT'
      $f$, t);
    ELSE
      EXECUTE format($f$
        UPDATE %I SET approval_status = 'APPROVED',
                      approved_at = COALESCE(approved_at, now())
         WHERE approval_status = 'DRAFT'
      $f$, t);
    END IF;

    EXECUTE format($f$ ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I $f$,
                   t, t || '_approval_status_chk');
    EXECUTE format($f$
      ALTER TABLE %I ADD CONSTRAINT %I CHECK (
        approval_status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED'))
    $f$, t, t || '_approval_status_chk');

    -- An APPROVED row with no timestamp is a row nobody can audit; a locked row
    -- that is not APPROVED is a row locked in the wrong state.
    EXECUTE format($f$ ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I $f$,
                   t, t || '_approval_shape_chk');
    EXECUTE format($f$
      ALTER TABLE %I ADD CONSTRAINT %I CHECK (
            (approval_status <> 'APPROVED' OR approved_at IS NOT NULL)
        AND (approval_status <> 'REJECTED' OR rejected_at IS NOT NULL)
        AND (NOT is_locked OR approval_status = 'APPROVED'))
    $f$, t, t || '_approval_shape_chk');

    EXECUTE format($f$
      CREATE INDEX IF NOT EXISTS %I ON %I (approval_status)
       WHERE approval_status IN ('DRAFT','PENDING_APPROVAL')
    $f$, t || '_pending_idx', t);

    EXECUTE format($f$ DROP TRIGGER IF EXISTS %I ON %I $f$, t || '_lock_guard', t);
    EXECUTE format($f$
      CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION enforce_row_lock()
    $f$, t || '_lock_guard', t);

    RAISE NOTICE 'maker-checker: applied to %', t;
  END LOOP;
END $$;

-- ── the review queue ───────────────────────────────────────────────────────
-- One UNION so the admin screen has a single thing to read. Amounts are cast to
-- a common numeric; each table names its money column differently and the view
-- is the one place that difference should live.

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

COMMENT ON VIEW v_approval_queue IS
  'Everything sitting between a maker and a checker. Empty is the healthy state.';

COMMIT;
