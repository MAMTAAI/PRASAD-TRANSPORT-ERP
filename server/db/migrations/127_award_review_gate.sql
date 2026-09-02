-- ═══════════════════════════════════════════════════════════════════════════
-- 127_award_review_gate.sql — the award is the desk's decision
--
-- Owner's rule (2026-09-02): a customer's accept-bid and a vendor's Book-Now
-- are REQUESTS. Nothing from a phone awards a load; the office desk does,
-- with a stamp. Until it does, the load sits in AWARD_REQUESTED — off the
-- vendor feed (which shows OPEN only), bids frozen, the requested offer named
-- on the row. Approve runs the same one-transaction award the staff button
-- always ran (reject the rest, accept the winner, open the settlement);
-- reject reopens the load with a reason the requester reads.
--
-- The 31-Aug maker-checker put a customer-posted load behind PENDING_REVIEW;
-- this puts the award behind the same desk. Same shape, same audit columns.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE bazaar_loads DROP CONSTRAINT IF EXISTS bazaar_loads_status_check;
ALTER TABLE bazaar_loads ADD CONSTRAINT bazaar_loads_status_check
  CHECK (status IN ('PENDING_REVIEW', 'OPEN', 'AWARD_REQUESTED', 'AWARDED', 'CLOSED', 'CANCELLED'));

ALTER TABLE bazaar_loads
  ADD COLUMN IF NOT EXISTS award_requested_bid_id uuid REFERENCES bazaar_bids(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS award_requested_by     text CHECK (award_requested_by IN ('CUSTOMER', 'VENDOR')),
  ADD COLUMN IF NOT EXISTS award_requested_at     timestamptz,
  ADD COLUMN IF NOT EXISTS award_reviewed_by      uuid,
  ADD COLUMN IF NOT EXISTS award_reviewed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS award_reject_reason    text;

CREATE INDEX IF NOT EXISTS idx_bazaar_loads_award_requested
  ON bazaar_loads (award_requested_at) WHERE status = 'AWARD_REQUESTED';

COMMIT;
