-- ═══════════════════════════════════════════════════════════════════════════
-- 054_trip_entity_partition.sql — the entity a trip was billed under
--
-- WHY THE PARTITION KEY IS THE TRIP, NOT THE VEHICLE.
--
-- The obvious design is vehicles.company_id: each truck belongs to one firm,
-- filter by it, done. The data says otherwise — 15 of 49 vehicles run loads
-- under MORE THAN ONE operating company. AS 26AC 0405 alone has 43 trips split
-- between M/S GAUTAM PRASAD and M/S PRASAD TRANSPORT.
--
-- Stamping one company onto those trucks would silently misattribute every trip
-- they ran for the other firm — which is precisely the "ledger bleed between
-- entities" this work exists to prevent, introduced by the fix meant to stop it.
--
-- So the entity lives on the TRIP, where it is actually a fact, and a vehicle is
-- free to work for whoever hired it. This is also why an owner's statement has
-- to be broken down per entity and then totalled: one owner's trucks genuinely
-- earn money inside three different books.
--
-- trips.operating_company already holds this as text. This migration resolves it
-- to a real foreign key so joins and filters cannot drift on spelling — the same
-- text carried "M/S JAISWAL ENTERPRISE  " with trailing spaces.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS branch_id  uuid REFERENCES branches(id)  ON DELETE RESTRICT;

UPDATE trips t
   SET company_id = c.id
  FROM companies c
 WHERE t.company_id IS NULL
   AND norm_company_name(t.operating_company) = norm_company_name(c.company_name);

-- Every P&L and statement query filters on (entity, date); the vehicle index
-- serves the profitability matrix.
CREATE INDEX IF NOT EXISTS idx_trips_company_date ON trips (company_id, loading_date);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_date ON trips (vehicle_id, loading_date);

-- An owner's statement groups by owner. Until owners are mapped to ledgers the
-- grouping falls back to vehicles.owner_name, so it needs to be searchable.
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_name ON vehicles (lower(owner_name));

COMMIT;
