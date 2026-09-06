-- ═══════════════════════════════════════════════════════════════════════════
-- 180 — HISTORICAL TOLL BACKFILL, 01-Apr-2026 → 01-Sep-2026
--
-- Owner, 6-Sep-2026, REVERSING the rule set in migration 179: "I DO want to
-- link the old tolls and update the P&L for closed/settled trips, specifically
-- 01-04-2026 to 01-09-2026."
--
-- 179 deliberately refused to map a crossing into a COMPLETED or SETTLED trip,
-- because a finalised P&L should not be rewritten from behind. That was the
-- right default and it is being overridden knowingly, for one bounded window.
-- This file therefore does the override in a way that can be UNDONE: every row
-- it touches is stamped map_source = 'BACKFILL_180', so the exact set is
-- identifiable and reversible with one UPDATE.
--
-- WHAT WAS CHECKED BEFORE WRITING IT (production, 6-Sep-2026):
--   · 1,479 crossings worth Rs 7,37,850 resolve to EXACTLY ONE trip in the
--     window. Those are mapped.
--   · 209 resolve to more than one. Those are NOT mapped — the owner's earlier
--     instruction stands and is not affected by this override: "Never map
--     blindly." They stay AMBIGUOUS for the desk.
--   · All 84 vehicle_owner_bills are AI_DRAFT. Nothing approved or locked has
--     its basis changed by this; the drafts simply recompute with the toll in.
--
-- WHAT THIS FILE DOES NOT DO — AND MUST NOT
-- It does not post a voucher. The toll was already booked to the ledger when it
-- was imported (Dr Toll & FASTag Expense / Cr the FASTag wallet, see
-- tollImport.routes.js). The TRIP P&L is a VIEW over the same rows
-- (v_trip_pnl, migration 149), so attaching trip_id is the whole update —
-- posting again here would charge the company twice for one crossing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. MAKE THE OVERRIDE IDENTIFIABLE ════════════════════════════════════
-- Without this the backfilled rows are indistinguishable from ones the importer
-- mapped normally, and "undo the 180 backfill" becomes impossible to express.
ALTER TABLE toll_transactions
  ADD COLUMN IF NOT EXISTS map_source text;

COMMENT ON COLUMN toll_transactions.map_source IS
  'How trip_id came to be set: AUTO (importer, at ingestion) · BACKFILL_180 '
  '(the 01-Apr→01-Sep-2026 historical override, reversible as a set) · MANUAL '
  '(a person resolved it on the Unmapped Tolls desk).';

UPDATE toll_transactions
   SET map_source = 'AUTO'
 WHERE trip_id IS NOT NULL AND map_source IS NULL;

-- ═══ 2. THE BACKFILL ══════════════════════════════════════════════════════
-- Bounded three ways, so re-running it can never widen its own reach:
--   · the date window is literal,
--   · only rows that have no trip yet,
--   · only where exactly ONE trip covers the instant (toll_match_trip, mig 179).
-- The trip's status is deliberately NOT tested — that is the override.
WITH m AS (
  SELECT tx.id AS toll_id, r.trip_id, r.candidates
    FROM toll_transactions tx
    CROSS JOIN LATERAL toll_match_trip(tx.vehicle_id, tx.txn_datetime) r
   WHERE tx.trip_id IS NULL
     AND tx.vehicle_id IS NOT NULL
     AND tx.txn_datetime >= TIMESTAMPTZ '2026-04-01 00:00:00+05:30'
     AND tx.txn_datetime <  TIMESTAMPTZ '2026-09-01 00:00:00+05:30'
     AND r.candidates = 1
     AND r.trip_id IS NOT NULL
)
UPDATE toll_transactions tx
   SET trip_id        = m.trip_id,
       map_status     = 'MAPPED',
       map_candidates = 1,
       map_source     = 'BACKFILL_180',
       mapped_at      = now()
  FROM m
 WHERE tx.id = m.toll_id;

-- Anything still unmapped in the window is ambiguous or genuinely orphaned;
-- label it so the desk sees why rather than assuming the backfill missed it.
WITH m AS (
  SELECT tx.id AS toll_id, r.candidates
    FROM toll_transactions tx
    CROSS JOIN LATERAL toll_match_trip(tx.vehicle_id, tx.txn_datetime) r
   WHERE tx.trip_id IS NULL
     AND tx.txn_datetime >= TIMESTAMPTZ '2026-04-01 00:00:00+05:30'
     AND tx.txn_datetime <  TIMESTAMPTZ '2026-09-01 00:00:00+05:30'
)
UPDATE toll_transactions tx
   SET map_status     = CASE WHEN m.candidates > 1 THEN 'AMBIGUOUS' ELSE 'ORPHAN' END,
       map_candidates = m.candidates
  FROM m
 WHERE tx.id = m.toll_id
   AND tx.map_status IS DISTINCT FROM (CASE WHEN m.candidates > 1 THEN 'AMBIGUOUS' ELSE 'ORPHAN' END);

-- ═══ 3. THE UNDO, WRITTEN DOWN ════════════════════════════════════════════
-- Not executed. Recorded here because a backfill that rewrites closed P&L must
-- come with its own reversal, or "put it back" becomes archaeology:
--
--   UPDATE toll_transactions
--      SET trip_id = NULL, map_status = 'ORPHAN', map_source = NULL, mapped_at = now()
--    WHERE map_source = 'BACKFILL_180';
--
-- v_trip_pnl and the owner-bill views read toll `WHERE trip_id IS NOT NULL`, so
-- that single statement returns every affected P&L to its previous figure.

CREATE INDEX IF NOT EXISTS toll_txn_map_source_idx
  ON toll_transactions (map_source) WHERE map_source IS NOT NULL;

-- ═══ 4. WHAT THE DESK STILL OWES ══════════════════════════════════════════
-- DROP then CREATE, not CREATE OR REPLACE: replacing a view can only APPEND
-- columns, and map_source belongs beside map_candidates rather than tacked on
-- the end. PostgreSQL refuses the replace outright ("cannot change name of view
-- column"), so this would have failed on deploy.
DROP VIEW IF EXISTS v_toll_unmapped;
CREATE VIEW v_toll_unmapped AS
SELECT tx.id, tx.map_status, tx.map_candidates, tx.map_source,
       tx.vehicle_no, tx.vehicle_id,
       tx.txn_datetime, tx.txn_date, tx.amount, tx.plaza_name,
       tx.provider, tx.ext_txn_id,
       (tx.vehicle_id IS NULL) AS vehicle_unknown
  FROM toll_transactions tx
 WHERE tx.trip_id IS NULL
 ORDER BY tx.txn_datetime DESC;
