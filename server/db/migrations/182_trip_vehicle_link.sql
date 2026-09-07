-- ═══════════════════════════════════════════════════════════════════════════
-- 182 — A TRIP MUST KNOW ITS LORRY
--
-- Owner, 7-Sep-2026, after a deep audit of the Command Center. The visible
-- symptom was "ACTIVE TRIPS 0" on a morning when sixteen lorries were out.
--
-- WHAT THE AUDIT FOUND ON PRODUCTION
--   16 trips are IN_TRANSIT. NINE of them carry vehicle_id NULL — including
--   PT00747/48/49 loaded on 5-Sep and JE00115/116 still running from 28-Aug.
--   Every one of the nine names a real registration in the vehicle_no column,
--   and every one of those registrations IS in the fleet master:
--     AS 26C 5102 · AS 26C 5106 · AS 26C 5104 · AS 26C 9813 · AS 26C 5107
--     AS 26C 9804 · AS 26C 9802 · AS 19C 8668 · NL 01AD 0828
--   Across the whole register 46 trips are in that state and exactly ONE has a
--   registration the master does not hold (PT00100, "9803" — a truncated entry
--   that already has its own desk in unmappedVehicles.routes.js).
--
-- WHY IT SHOWED UP AS A ZERO, AND ONLY SOMETIMES
--   Every filtered figure on the dashboard joins the lorry to reach its owner
--   and its own/attached class:
--       FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
--       ... AND ($3::text IS NULL OR v.owner_name = $3::text)
--   With no owner filter the LEFT JOIN keeps the row and the count is right.
--   The moment anybody picks an owner — or the fleet type — the nine rows fall
--   out, because NULL = anything is never true. Two of the nine (PT00739,
--   PT00743) belong to owner PRASAD TRANSPORT, so the tile that answered "0"
--   on 7-Sep should have answered "2". The dashboard was not lying about the
--   trips it could see; it could not see these.
--
--   The same NULL costs more elsewhere. The Vehicle 15-Day Settlement bills
--   by lorry, the fleet map plots by lorry, and the productivity board counts
--   RTKM by lorry: a trip with no lorry is missing from all three.
--
-- WHAT THIS FILE CHANGES
--   1. LINKS the 46, and only where the match is exact and single. reg_key()
--      is the database's own canonical form — reg_key('AS26C5102') =
--      reg_key('AS 26C 5102') — and vehicles.vehicle_no_norm is UNIQUE, so a
--      match is one row or none. This is IDENTIFICATION, not money: nothing
--      here writes an amount, a rate or a status. It is the same operation
--      migration 179 performed on 2,870 toll rows for the same reason.
--   2. STOPS IT RECURRING, at the table rather than in one caller. The AC5
--      importer, the Loading Register, the driver app and every agent all
--      insert trips; a fix in any one of them leaves the other three. A BEFORE
--      INSERT OR UPDATE trigger fills vehicle_id from the registration the row
--      already carries whenever it was left blank.
--   3. LEAVES THE UNMATCHABLE ALONE. A registration the master does not hold
--      is a person's decision — it may be a typo, or a lorry nobody has
--      entered yet — and rewriting it from a guess would put the register and
--      the paperwork out of step with nothing to show which to believe. Those
--      rows stay NULL and keep going to the unmapped-vehicles desk.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. THE LINK, AS A FUNCTION ──────────────────────────────────────────────
-- Written once and used by both the trigger and the backfill, so the rule
-- cannot drift between "what we fixed" and "what we prevent". Returns NULL
-- when the registration is blank or matches nothing, which is the caller's
-- signal to leave the column alone.
CREATE OR REPLACE FUNCTION trip_vehicle_for_reg(p_reg text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT v.id
    FROM vehicles v
   WHERE NULLIF(btrim(COALESCE(p_reg, '')), '') IS NOT NULL
     AND v.vehicle_no_norm = reg_key(p_reg)
   LIMIT 1;
$$;

COMMENT ON FUNCTION trip_vehicle_for_reg(text) IS
  'The fleet row a registration names, in the canonical reg_key() form. NULL when blank or unknown — never a guess.';

-- ── 2. THE DOOR ─────────────────────────────────────────────────────────────
-- BEFORE, so the row is corrected on its way in and no second write is needed.
-- Only ever FILLS a blank: a caller that supplied a vehicle_id meant it, and a
-- trigger that overrode it would make the dropdown on the Loading Register a
-- suggestion rather than a choice.
CREATE OR REPLACE FUNCTION trips_link_vehicle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.vehicle_id IS NULL AND NEW.vehicle_no IS NOT NULL THEN
    NEW.vehicle_id := trip_vehicle_for_reg(NEW.vehicle_no);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trips_link_vehicle ON trips;
CREATE TRIGGER trips_link_vehicle
  BEFORE INSERT OR UPDATE OF vehicle_no, vehicle_id ON trips
  FOR EACH ROW EXECUTE FUNCTION trips_link_vehicle();

-- ── 3. THE 46 ───────────────────────────────────────────────────────────────
-- Idempotent by construction: it only touches rows that are still NULL, so a
-- re-run is a no-op. RAISE NOTICE rather than a silent UPDATE, because a
-- migration that repairs data should say how much it repaired.
DO $$
DECLARE
  fixed int;
  left_over int;
BEGIN
  UPDATE trips t
     SET vehicle_id = trip_vehicle_for_reg(t.vehicle_no)
   WHERE t.vehicle_id IS NULL
     AND trip_vehicle_for_reg(t.vehicle_no) IS NOT NULL;
  GET DIAGNOSTICS fixed = ROW_COUNT;

  SELECT count(*) INTO left_over FROM trips WHERE vehicle_id IS NULL;

  RAISE NOTICE '[182] linked % trip(s) to their lorry; % still unlinked (registration not in the master — unmapped-vehicles desk)',
    fixed, left_over;
END $$;

-- ── 4. WHAT A PERSON STILL HAS TO DECIDE ────────────────────────────────────
-- Not a fix: a list. A trip whose registration reaches no master row cannot be
-- linked by any rule, and this is where the desk finds them.
CREATE OR REPLACE VIEW v_trips_without_vehicle AS
  SELECT t.id, t.trip_code, t.vehicle_no, reg_key(t.vehicle_no) AS reg_key,
         t.operating_company, t.loading_date, t.status
    FROM trips t
   WHERE t.vehicle_id IS NULL
   ORDER BY t.loading_date DESC NULLS LAST;

COMMENT ON VIEW v_trips_without_vehicle IS
  'Trips whose registration matches no fleet row. Every linkable one is already linked by trigger trips_link_vehicle; what is left needs a person.';

COMMIT;
