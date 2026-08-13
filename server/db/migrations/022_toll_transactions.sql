-- ═══════════════════════════════════════════════════════════════════════════
-- 022_toll_transactions.sql — FASTag / toll crossings
--
-- Trip Management shows the last toll crossing per trip (and maps it when the
-- plaza has coordinates), so this table is needed before that screen can leave
-- Firestore. It is shaped for all three producers that already exist rather
-- than just the one being wired now:
--
--   • manual trip-wise entry           (TollFastagMgmt)
--   • FASTag provider API sync         (src/lib/fastagProviders.ts, GTROPY)
--   • bank/portal statement import     (src/lib/tollEngine.ts)
--
-- Idempotency is the provider's own transaction id. tollEngine already treats
-- ext_txn_id as THE key and falls back to a synthetic one for statement rows
-- that have none; the partial unique index below enforces what that code
-- assumes, so a re-sync cannot double-charge a toll.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS toll_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,                 -- Firestore doc id on import
  ext_txn_id      text,                        -- provider's txn id; the dedup key
  txn_ref         text,                        -- Transaction_Ref (manual entry)
  vehicle_id      uuid REFERENCES vehicles(id),
  vehicle_no      text NOT NULL,
  trip_id         uuid REFERENCES trips(id),   -- was trip_db_id in Firestore
  txn_datetime    timestamptz,                 -- reader time; NULL when only a date is known
  txn_date        date,
  amount          numeric(12,2) NOT NULL DEFAULT 0,
  plaza_name      text,
  -- Coordinates are optional and frequently absent. The map only draws a marker
  -- when both are present and sane, so they stay nullable rather than 0/0 —
  -- (0,0) is a real place in the Gulf of Guinea and it plots there.
  lat             numeric(10,7),
  lng             numeric(10,7),
  provider        text,                        -- GTROPY, bank statement, MANUAL…
  invoice_no      text,
  invoice_date    date,
  loading_loc     text,
  dest_loc        text,
  billing_type    text,
  -- Reimbursable tolls are re-billed to the customer; own-account tolls are our
  -- expense. Kept as a stored flag because the billing decision is made by a
  -- human at entry time and must not be re-derived later.
  is_billable     boolean NOT NULL DEFAULT false,
  claim_status    text NOT NULL DEFAULT 'UNCLAIMED'
                  CHECK (claim_status IN ('UNCLAIMED','CLAIMED','SETTLED','REJECTED')),
  remarks         text,
  company         text,
  branch          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One provider transaction lands once, ever. Partial so manual rows (no
-- ext_txn_id) are not forced to invent one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_toll_ext_txn
  ON toll_transactions (ext_txn_id) WHERE ext_txn_id IS NOT NULL;

-- Trip Management asks "latest toll for this trip" per active trip; this index
-- serves that directly instead of scanning and sorting in the client.
CREATE INDEX IF NOT EXISTS idx_toll_trip_time
  ON toll_transactions (trip_id, txn_datetime DESC NULLS LAST) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_toll_vehicle_date
  ON toll_transactions (vehicle_no, txn_date DESC);

COMMIT;
