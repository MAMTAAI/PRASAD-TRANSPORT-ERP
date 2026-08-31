-- ═══════════════════════════════════════════════════════════════════════════
-- 115_load_review_gate.sql — customer-posted loads pass an office review
--
-- The maker-checker mandate (2026-08-31): nothing an external user submits
-- reaches the live system unreviewed. Customer loads were the one bazaar write
-- that went straight to OPEN — vendors could be bidding on a load the office
-- had never seen. New state:
--
--   staff posts a load           → OPEN            (unchanged — staff IS the checker)
--   customer posts a load        → PENDING_REVIEW  (invisible to vendors:
--                                                   the feed and the bid route
--                                                   only serve OPEN)
--   office approves              → OPEN  (+ approved_by/approved_at)
--   office rejects               → CANCELLED (+ reject_reason, told to customer)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE bazaar_loads DROP CONSTRAINT IF EXISTS bazaar_loads_status_check;
ALTER TABLE bazaar_loads ADD CONSTRAINT bazaar_loads_status_check
  CHECK (status IN ('PENDING_REVIEW','OPEN','AWARDED','CLOSED','CANCELLED'));

ALTER TABLE bazaar_loads
  ADD COLUMN IF NOT EXISTS approved_by   uuid,
  ADD COLUMN IF NOT EXISTS approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reject_reason text;

COMMIT;
