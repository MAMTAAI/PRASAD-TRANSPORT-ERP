-- ═══════════════════════════════════════════════════════════════════════════
-- 023_driver_txn_trip_link.sql — attribute a driver's money to a trip
--
-- driver_transactions had no trip reference at all: 303 rows recording advances
-- and recoveries with no way to ask "what did this trip cost in driver cash".
-- Trip Management and Master Trip Settlement both need exactly that, and the
-- Firestore original faked it by writing the trip's business code into a string
-- field, so the link existed but could not be joined on.
--
-- The backfill is not a guess. 290 of the 303 rows carry the code verbatim in
-- their remarks ('Trip: PT00508 - IOCL shortage penalty ...'), written there by
-- the loaders and the IOCL reconciler. Only codes that resolve to exactly one
-- trip are linked; an ambiguous or unknown code is left NULL rather than
-- attached to the wrong trip. The 13 rows with no code stay NULL — they are
-- genuinely unattributed, and pretending otherwise would misstate a trip's cost.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE driver_transactions
  ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id);

CREATE INDEX IF NOT EXISTS idx_driver_txn_trip ON driver_transactions (trip_id)
  WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_txn_driver_date
  ON driver_transactions (driver_id, txn_date DESC);

-- Backfill: pull the trip code out of the remarks, keep only unambiguous hits.
WITH extracted AS (
  SELECT d.id AS txn_id,
         (regexp_match(d.remarks, '\y((?:PT|JE|GP)[0-9]{4,6})\y'))[1] AS code
    FROM driver_transactions d
   WHERE d.trip_id IS NULL AND d.remarks IS NOT NULL
),
resolved AS (
  SELECT e.txn_id, (array_agg(t.id))[1] AS trip_id, count(*) AS matches
    FROM extracted e
    JOIN trips t ON t.trip_code = e.code
   WHERE e.code IS NOT NULL
   GROUP BY e.txn_id
  HAVING count(*) = 1          -- one code, one trip, or leave it alone
                               -- (min(uuid) does not exist; array_agg picks the single hit)
)
UPDATE driver_transactions d
   SET trip_id = r.trip_id
  FROM resolved r
 WHERE d.id = r.txn_id;

COMMIT;
