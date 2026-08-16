-- ═══════════════════════════════════════════════════════════════════════════
-- 064_pending_expense_account.sql — a queued expense has to remember which
-- account it will be paid from
--
-- A compliance fee now waits for approval instead of posting on save, which
-- means the bank or cash account the operator chose has to survive the wait.
-- The alternative considered and rejected was writing it into `description` and
-- parsing it back out at approval time: a free-text field that a reviewer may
-- legitimately edit is not somewhere to keep a value the posting depends on.
--
-- expense_approvals also gains the entity link, so a queued expense can name
-- the party it belongs to in the new master rather than only a vehicle number.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE expense_approvals
  ADD COLUMN IF NOT EXISTS pay_account text,
  ADD COLUMN IF NOT EXISTS entity_id   uuid REFERENCES entity_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_id  uuid REFERENCES vehicles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS expense_approvals_entity_idx
  ON expense_approvals (entity_id) WHERE entity_id IS NOT NULL;

COMMENT ON COLUMN expense_approvals.pay_account IS
  'Bank/cash account the fee is paid from. Read at APPROVAL time to post the voucher.';

-- An expense awaiting approval must not already carry a voucher: that pairing
-- means money moved before anyone approved it, which is the exact failure this
-- workflow exists to prevent. Cheap to state, and it fails loudly if some other
-- code path ever posts first and queues afterwards.
ALTER TABLE expense_approvals DROP CONSTRAINT IF EXISTS expense_approvals_unposted_while_pending;
ALTER TABLE expense_approvals ADD CONSTRAINT expense_approvals_unposted_while_pending CHECK (
  approval_status <> 'PENDING_APPROVAL' OR voucher_id IS NULL
);

COMMIT;
