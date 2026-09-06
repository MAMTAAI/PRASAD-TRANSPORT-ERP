-- ═══════════════════════════════════════════════════════════════════════════
-- 179 — TOLL: LINK THE LORRY, MATCH THE TRIP HONESTLY, SHOW THE REST
--
-- Owner, 6-Sep-2026, after a deep audit. The visible symptom was "IOCL/BPCL →
-- Unknown" on every toll row and "No tolls crossed yet" on every trip. The
-- cause was NOT the trip matcher.
--
-- WHAT THE AUDIT FOUND ON PRODUCTION
--   3,883 toll rows · every one has txn_datetime · only 1,013 have vehicle_id
--   · 493 have trip_id.
--
--   ROOT CAUSE: 2,870 rows (Rs 14,55,900) carry vehicle_id NULL, and ALL 2,870
--   have a registration that IS in the fleet master once normalised —
--   reg_key('AS26C5107') = reg_key('AS 26C 5107'). They were written unspaced
--   and never linked. With no lorry there can be no trip, so trip matching was
--   never the first problem. Only 21 distinct registrations are involved.
--
--   The dedup lock the owner asked for ALREADY EXISTED — twice. toll_txn_ext_uniq
--   and uq_toll_ext_txn are the same UNIQUE (ext_txn_id) WHERE ext_txn_id IS NOT
--   NULL. 3,883 rows, 3,883 distinct, zero duplicates. One is dropped below;
--   two identical indexes cost every write twice and disagree the day someone
--   edits one of them.
--
-- WHAT THIS FILE CHANGES
--   1. Links the 2,870 orphaned rows to their lorry. This is IDENTIFICATION,
--      not money: vehicle_owner_bills reads toll only `WHERE trip_id IS NOT
--      NULL`, so linking a vehicle cannot move a rupee on a bill.
--   2. Replaces the coin-flip matcher. The old one matched on DATE, let an OPEN
--      trip claim `loading_date + 15`, and took `ORDER BY loading_date DESC
--      LIMIT 1` — silently picking the newest when two trips overlapped.
--      74 rows currently match more than one trip that way.
--   3. Maps trip_id ONLY for OPEN trips (owner's rule): a COMPLETED or SETTLED
--      trip has a finalised P&L and a toll appearing in it later would rewrite
--      a closed account.
--   4. Anything the matcher cannot resolve becomes AMBIGUOUS or ORPHAN and goes
--      to the desk. Never a guess — the owner's words: "Never map blindly."
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE REDUNDANT LOCK ════════════════════════════════════════════════
-- Keep toll_txn_ext_uniq (named for what it does); drop the twin.
DROP INDEX IF EXISTS uq_toll_ext_txn;

-- ═══ 2. WHAT THE DESK NEEDS TO SEE ════════════════════════════════════════
-- A row that could not be mapped must say WHY, and how many trips it could
-- have belonged to, or the desk is guessing too.
ALTER TABLE toll_transactions
  ADD COLUMN IF NOT EXISTS map_status text NOT NULL DEFAULT 'UNMAPPED'
    CHECK (map_status IN ('MAPPED','AMBIGUOUS','ORPHAN','UNMAPPED','MANUAL')),
  ADD COLUMN IF NOT EXISTS map_candidates int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mapped_at timestamptz;

COMMENT ON COLUMN toll_transactions.map_status IS
  'MAPPED = matched exactly one trip · AMBIGUOUS = several trips could claim it, '
  'desk decides · ORPHAN = no trip covered that moment (idle movement) · '
  'MANUAL = a person mapped it · UNMAPPED = not yet examined.';

-- ═══ 3. LINK THE LORRY ════════════════════════════════════════════════════
-- reg_key() is the same normaliser migration 149's expense guard uses, so a
-- toll and a trip agree on what "AS 26C 5107" means.
UPDATE toll_transactions tx
   SET vehicle_id = v.id
  FROM vehicles v
 WHERE tx.vehicle_id IS NULL
   AND reg_key(v.vehicle_no) = reg_key(tx.vehicle_no);

-- ═══ 4. THE HONEST MATCHER ════════════════════════════════════════════════
-- Returns the trip ONLY when exactly one covers that instant. Two candidates
-- means we do not know, and saying so is the point.
--
-- The window is a real interval, not a date:
--   from  loading_date 00:00
--   to    unloading_date + 1 day (exclusive) for a closed trip,
--         now() for a trip still running.
-- The old `loading_date + 15` let a trip nobody had closed swallow a fortnight
-- of another lorry's crossings.
CREATE OR REPLACE FUNCTION toll_match_trip(p_vehicle_id uuid, p_when timestamptz)
RETURNS TABLE (trip_id uuid, candidates int)
LANGUAGE sql STABLE AS $$
  WITH hits AS (
    SELECT t.id
      FROM trips t
     WHERE t.vehicle_id = p_vehicle_id
       AND t.status <> 'CANCELLED'
       AND p_when >= t.loading_date::timestamptz
       AND p_when <  CASE WHEN t.unloading_date IS NOT NULL
                          THEN (t.unloading_date + 1)::timestamptz
                          ELSE now() END
  ), agg AS (SELECT count(*)::int AS n FROM hits)
  SELECT (SELECT id FROM hits LIMIT 1), a.n
    FROM agg a
   WHERE a.n = 1
  UNION ALL
  SELECT NULL::uuid, a.n FROM agg a WHERE a.n <> 1;
$$;

COMMENT ON FUNCTION toll_match_trip(uuid, timestamptz) IS
  'The trip a crossing belongs to, by exact timestamp. Returns a trip_id ONLY '
  'when exactly one trip covers that instant; otherwise trip_id is NULL and '
  '`candidates` says how many could have claimed it. Never guesses.';

-- ═══ 5. MAP WHAT IS SAFE TO MAP ═══════════════════════════════════════════
-- Owner's rule, 6-Sep-2026: OPEN trips only. A COMPLETED or SETTLED trip has a
-- finalised P&L; a toll appearing in it now would rewrite a closed account.
-- Everything else is classified so the desk can see it, but not mapped.
WITH m AS (
  SELECT tx.id AS toll_id, r.trip_id, r.candidates
    FROM toll_transactions tx
    CROSS JOIN LATERAL toll_match_trip(tx.vehicle_id, tx.txn_datetime) r
   WHERE tx.trip_id IS NULL
     AND tx.vehicle_id IS NOT NULL
     AND tx.txn_datetime IS NOT NULL
)
UPDATE toll_transactions tx
   SET trip_id = CASE
         WHEN m.candidates = 1
          AND EXISTS (SELECT 1 FROM trips t
                       WHERE t.id = m.trip_id
                         AND t.status NOT IN ('COMPLETED','SETTLED','CANCELLED'))
         THEN m.trip_id ELSE NULL END,
       map_candidates = m.candidates,
       map_status = CASE
         WHEN m.candidates > 1 THEN 'AMBIGUOUS'
         WHEN m.candidates = 0 THEN 'ORPHAN'
         WHEN EXISTS (SELECT 1 FROM trips t
                       WHERE t.id = m.trip_id
                         AND t.status NOT IN ('COMPLETED','SETTLED','CANCELLED'))
           THEN 'MAPPED'
         -- Exactly one trip, but it is closed. Deliberately left unmapped and
         -- labelled, so the desk can see it was a decision and not a miss.
         ELSE 'ORPHAN' END,
       mapped_at = now()
  FROM m
 WHERE tx.id = m.toll_id;

-- Rows already carrying a trip were mapped before this migration; say so rather
-- than leaving them looking unexamined.
UPDATE toll_transactions
   SET map_status = 'MAPPED', map_candidates = 1
 WHERE trip_id IS NOT NULL AND map_status = 'UNMAPPED';

-- ═══ 6. THE DESK'S VIEW ═══════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_toll_unmapped AS
SELECT tx.id, tx.map_status, tx.map_candidates,
       tx.vehicle_no, tx.vehicle_id,
       tx.txn_datetime, tx.txn_date, tx.amount, tx.plaza_name,
       tx.provider, tx.ext_txn_id,
       (tx.vehicle_id IS NULL) AS vehicle_unknown
  FROM toll_transactions tx
 WHERE tx.trip_id IS NULL
 ORDER BY tx.txn_datetime DESC;

COMMENT ON VIEW v_toll_unmapped IS
  'Every toll not attached to a trip, with the reason. AMBIGUOUS rows matched '
  'several trips and are the desk''s to decide; ORPHAN means no open trip '
  'covered that moment (idle movement, or the only match is a closed trip).';

CREATE INDEX IF NOT EXISTS toll_txn_map_status_idx
  ON toll_transactions (map_status) WHERE trip_id IS NULL;
CREATE INDEX IF NOT EXISTS toll_txn_vehicle_time_idx
  ON toll_transactions (vehicle_id, txn_datetime) WHERE vehicle_id IS NOT NULL;
