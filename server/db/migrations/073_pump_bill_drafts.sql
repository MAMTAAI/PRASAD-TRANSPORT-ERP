-- 073_pump_bill_drafts.sql
-- ============================================================================
-- Draft petrol-pump bills, and a duplicate guard that actually guards.
--
-- THE EXISTING REFERENCE DOES NOT PREVENT WHAT IT LOOKS LIKE IT PREVENTS.
-- /queues/fuel-reconcile posts under
--     FUELBILL_<vendor_id>_<sorted slip ids, truncated to 40 chars>
-- which is keyed on the SLIP SET. Post fourteen slips for a pump, then add a
-- fifteenth and post again: different set, different reference, and TARA
-- accepts a SECOND voucher for the same pump and the same fortnight. The
-- truncation breaks it in the other direction too -- two genuinely different
-- sets sharing a 40-character prefix collide and one is refused for no reason.
--
-- The period is what must be unique, so the period is what the key is made of:
--     PUMPBILL_<vendor_id>_<YYYYMM>_H1|H2
-- One pump, one fortnight, one bill, enforced by a partial unique index rather
-- than by a string convention that only holds while everyone remembers it.
--
-- AND NOTHING REACHES THE LEDGER UNTIL SOMEONE APPROVES IT.
-- A draft holds the whole comparison -- system litres and value, the physical
-- bill, the variance, any hand-entered rates -- and writes to no other table.
-- Approval is the single moment anything is posted or any slip is locked.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pump_bill_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       uuid NOT NULL REFERENCES vendors(id),
  vendor_name     text NOT NULL,

  period_from     date NOT NULL,
  period_to       date NOT NULL,
  half            text NOT NULL CHECK (half IN ('FIRST', 'SECOND')),

  -- The deterministic key. Period-based, so a second attempt at the same
  -- fortnight collides no matter which slips it carries.
  ref_no          text NOT NULL,

  status          text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'APPROVED', 'CANCELLED')),

  slip_ids        uuid[] NOT NULL DEFAULT '{}',
  slip_count      integer NOT NULL DEFAULT 0,

  system_liters   numeric(14,3) NOT NULL DEFAULT 0,
  system_amount   numeric(14,2) NOT NULL DEFAULT 0,
  derived_pct     integer NOT NULL DEFAULT 0,   -- how much of the value is a guessed rate

  physical_amount numeric(14,2),
  physical_liters numeric(14,3),

  -- { "<slip_id>": 96.50 } -- rates typed by a human, which beat every derived
  -- rate. Kept on the draft rather than written onto the slips, so an
  -- abandoned draft leaves no trace on the fuel records.
  rate_overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,

  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the reviewed comparison
  notes           text,

  voucher_id      uuid,
  created_by      text,
  approved_by     text,
  approved_at     timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pump_draft_period_sane CHECK (period_to >= period_from),
  -- An approved draft must show what it posted. A draft must not.
  CONSTRAINT pump_draft_approved_has_voucher CHECK (
    status <> 'APPROVED' OR (voucher_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT pump_draft_unapproved_has_no_voucher CHECK (
    status = 'APPROVED' OR voucher_id IS NULL
  )
);

-- THE GUARD. One APPROVED bill per pump per fortnight, whatever slips it holds.
-- Drafts and cancelled rows are deliberately outside it: you may re-draft a
-- fortnight as often as you like, and only once may you post it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_bill_approved_period
  ON pump_bill_drafts (vendor_id, period_from, period_to)
  WHERE status = 'APPROVED';

-- The reference is unique among approved bills for the same reason, and is the
-- value handed to TARA, so the database and the ledger agree on what "already
-- posted" means.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_bill_approved_ref
  ON pump_bill_drafts (ref_no) WHERE status = 'APPROVED';

-- Only one live draft per pump per fortnight, so two people cannot each build a
-- different version of the same bill and race to approve.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_bill_one_open_draft
  ON pump_bill_drafts (vendor_id, period_from, period_to)
  WHERE status = 'DRAFT';

CREATE INDEX IF NOT EXISTS idx_pump_bill_drafts_status
  ON pump_bill_drafts (status, period_from DESC);

COMMENT ON TABLE pump_bill_drafts IS
  'Draft fortnightly pump bills. Nothing here touches fuel_entries or the ledger until status becomes APPROVED. One APPROVED bill per pump per fortnight, enforced by partial unique index -- the previous slip-set-derived ref_no allowed a second posting whenever the slip list changed.';
COMMENT ON COLUMN pump_bill_drafts.ref_no IS
  'PUMPBILL_<vendor_id>_<YYYYMM>_H1|H2 -- period-derived, so adding a slip cannot mint a fresh reference';
COMMENT ON COLUMN pump_bill_drafts.rate_overrides IS
  'slip_id -> rate typed by a human; outranks every derived rate and never touches the slip until approval';
