-- ═══════════════════════════════════════════════════════════════════════════
-- 183 — ONE PARTY, ONE ID (per company, which is the owner's rule)
--
-- Owner, 7-Sep-2026: "ek naam ka naam double nahi honi chahiye … Sandeep Kr
-- Prasad alag alag company may attach vehical laga saktay hay." Asked whether
-- the id should be global or per company, he chose PER COMPANY — and he is
-- right, for a reason worth writing down: a vehicle owner's khata is a payable
-- of ONE firm. Sandeep's account with Prasad Transport is not Sandeep's account
-- with Jaiswal Enterprise, and a single global id would have merged two firms'
-- money into one balance. The person is the same; the account is not.
--
-- So: identity is (company_id, party_key(name)). Inside a firm a name resolves
-- to exactly one party, always. Across firms the same person holds one row per
-- firm, deliberately, and grouping on party_key alone still answers "where else
-- does this man run".
--
-- WHAT THE AUDIT FOUND ON PRODUCTION (7-Sep-2026)
--   · vehicles.owner_name is FREE TEXT with no master and no id. Six spellings
--     across 49 lorries; "GAUTAM PRASAD" and "M/S GAUTAM PRASAD" are one man.
--   · party_key() — which already exists, migration 011 — strips LTD/PVT/AND
--     but NOT "M/S", and does not know KR is KUMAR. Both of the owner's own
--     examples therefore slip through it:
--        party_key('M/S GAUTAM PRASAD')    = 'M S GAUTAM PRASAD'
--        party_key('GAUTAM PRASAD')        = 'GAUTAM PRASAD'
--        party_key('SANDEEP KR PRASAD')    = 'SANDEEP KR PRASAD'
--        party_key('SANDEEP KUMAR PRASAD') = 'SANDEEP KUMAR PRASAD'
--     It is used by NO index and by two migrations that ran months ago, so it
--     is safe to correct.
--   · 29 of 49 lorries have no owner khata at all; "Jaiswal Enterprise" (5
--     lorries) has none of any kind.
--   · vendors: NIRMALA PETROLUM has THREE ids (all zero balance, zero txns)
--     and JOHN N WELL SERVICE STATION has TWO — one holding Rs 1,858 over 7
--     entries, the other 4 entries.
--   · customers and companies are clean. Three drivers share the name RAJESH
--     KUMAR but hold three different mobiles, so they are probably three men.
--
-- WHAT THIS FILE DOES, AND WHAT IT REFUSES TO DO
--   It closes the door and it links what can be linked with certainty. It does
--   NOT merge anything carrying money: JOHN N WELL and the three RAJESH KUMARs
--   go to a list a person decides on. Merging two ledgers is a transfer, and a
--   migration is the wrong place to move somebody's balance.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. THE NAME RULE, CORRECTED ─────────────────────────────────────────────
-- Two additions to the existing function, both from the owner's own examples:
--   · a leading M/S · M/S. · MS · MESSRS is a form of address, not a name
--   · KR / KUM / KUMR is how KUMAR is written when someone is in a hurry
-- Everything the old version did is kept, so the two migrations that used it
-- would still produce the same grouping for the names they saw.
CREATE OR REPLACE FUNCTION party_key(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(upper(coalesce(t,'')), '^[[:space:]]*(M/S\.?|MS\.|MESSRS\.?)[[:space:]]*', ''),
                 '[^A-Z0-9 ]', ' ', 'g'),
               '\y(LIMITED|LTD|PVT|PRIVATE|COMPANY|CORPORATION|CORP|AND|THE)\y', ' ', 'g'),
             '\y(KR|KUM|KUMR)\y', 'KUMAR', 'g'),
           '\s+', ' ', 'g'));
$$;

COMMENT ON FUNCTION party_key(text) IS
  'Canonical name key. Strips M/S and company suffixes, expands KR to KUMAR. Two names with the same key are the same party.';

-- ── 2. THE VEHICLE OWNER MASTER ─────────────────────────────────────────────
-- The one party master the system never had. Everything else — customers,
-- vendors, drivers, companies — has a table and an id; a lorry's owner had a
-- string, so the dashboard's owner dropdown, the 15-day settlement and the
-- owner statement each grouped on whatever was typed.
CREATE TABLE IF NOT EXISTS vehicle_owners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  -- What a person sees and what the office typed. The key is what the system
  -- matches on; the display name is what it prints.
  display_name  text NOT NULL,
  owner_key     text GENERATED ALWAYS AS (party_key(display_name)) STORED,
  pan           text,
  phone         text,
  -- The khata. One per (owner, company) — that is the whole reason this table
  -- is scoped by company rather than global.
  ledger_id     uuid REFERENCES ledgers(id),
  status        text NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_owners_name_not_blank CHECK (btrim(display_name) <> '')
);

-- THE DOOR. Inside one firm a name resolves to exactly one owner, for ever.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_owners_company_key_uniq
  ON vehicle_owners (company_id, owner_key) WHERE status = 'ACTIVE';

-- "Where else does this man run" — answered without merging any money.
CREATE INDEX IF NOT EXISTS vehicle_owners_key_idx ON vehicle_owners (owner_key);

COMMENT ON TABLE vehicle_owners IS
  'A lorry owner, per operating company. The same person in two firms is two rows and two khatas on purpose — one firm''s payable is not the other''s. Group on owner_key to see the person across firms.';

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES vehicle_owners(id);
CREATE INDEX IF NOT EXISTS vehicles_owner_id_idx ON vehicles (owner_id);

COMMENT ON COLUMN vehicles.owner_name IS
  'What the office typed. KEPT for display and for history; identity is owner_id. Never group a report on this column.';

-- ── 3. RESOLVE OR CREATE, AT THE TABLE ──────────────────────────────────────
-- Four different things write a vehicle row (the Fleet master, the onboarding
-- flow, the importer, agents). A rule enforced in one of them is a rule three
-- of them break, so it lives here.
CREATE OR REPLACE FUNCTION vehicle_owner_resolve(p_company uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text := party_key(p_name);
  v_id  uuid;
BEGIN
  IF p_company IS NULL OR v_key = '' THEN RETURN NULL; END IF;

  SELECT id INTO v_id FROM vehicle_owners
   WHERE company_id = p_company AND owner_key = v_key AND status = 'ACTIVE';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO vehicle_owners (company_id, display_name)
  VALUES (p_company, btrim(p_name))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  -- ON CONFLICT DO NOTHING returns no row when another session won the race.
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM vehicle_owners
     WHERE company_id = p_company AND owner_key = v_key AND status = 'ACTIVE';
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicles_link_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A supplied owner_id is a choice and is never overridden. A blank one is
  -- filled from the name — which is how a typo lands on the party that already
  -- exists instead of minting a second one.
  IF NEW.owner_id IS NULL THEN
    NEW.owner_id := vehicle_owner_resolve(NEW.company_id, NEW.owner_name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicles_link_owner ON vehicles;
CREATE TRIGGER vehicles_link_owner
  BEFORE INSERT OR UPDATE OF owner_name, company_id, owner_id ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_link_owner();

-- ── 4. THE BACKFILL ─────────────────────────────────────────────────────────
-- One owner row per (company, key). The display name chosen is the spelling
-- that appears on the most lorries — the office's own most common way of
-- writing it, not this file's opinion. The khata already on those lorries is
-- carried onto the owner row; where there is none, none is invented (opening a
-- ledger account is a bookkeeping act and belongs to the desk).
DO $$
DECLARE
  made int;
  linked int;
  no_khata int;
BEGIN
  INSERT INTO vehicle_owners (company_id, display_name, ledger_id)
  SELECT s.company_id, s.display_name, s.ledger_id
    FROM (
      SELECT DISTINCT ON (v.company_id, party_key(v.owner_name))
             v.company_id,
             v.owner_name AS display_name,
             (SELECT x.vehicle_owner_ledger_id FROM vehicles x
               WHERE x.company_id = v.company_id
                 AND party_key(x.owner_name) = party_key(v.owner_name)
                 AND x.vehicle_owner_ledger_id IS NOT NULL
               LIMIT 1) AS ledger_id,
             count(*) OVER (PARTITION BY v.company_id, party_key(v.owner_name), v.owner_name) AS spelling_uses
        FROM vehicles v
       WHERE v.company_id IS NOT NULL
         AND party_key(v.owner_name) <> ''
       ORDER BY v.company_id, party_key(v.owner_name), spelling_uses DESC, v.owner_name
    ) s
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS made = ROW_COUNT;

  UPDATE vehicles v
     SET owner_id = o.id
    FROM vehicle_owners o
   WHERE v.owner_id IS NULL
     AND o.company_id = v.company_id
     AND o.owner_key = party_key(v.owner_name);
  GET DIAGNOSTICS linked = ROW_COUNT;

  SELECT count(*) INTO no_khata FROM vehicle_owners WHERE ledger_id IS NULL;

  RAISE NOTICE '[183] % owner(s) created, % lorries linked, % owner(s) still have no khata (desk to open)',
    made, linked, no_khata;
END $$;

-- ── 5. THE SAME DOOR ON THE OTHER MASTERS ───────────────────────────────────
-- customers and companies are already clean, so the index goes on as-is and
-- simply makes the current state permanent. Partial on ACTIVE, the pattern
-- migration 011 used for ledgers: a duplicate can be retired without deleting
-- history, and a retired row never blocks the live one.
CREATE UNIQUE INDEX IF NOT EXISTS customers_party_key_uniq
  ON customers (party_key(customer_name)) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS companies_party_key_uniq
  ON companies (party_key(company_name));

-- Vendors need the two duplicate SETS dealt with before the index can exist.
-- NIRMALA PETROLUM: three ids, all zero balance, zero transactions, referenced
-- by nothing. There is no money and no history to weigh, so the extras are
-- retired — not deleted, because fifteen tables carry a vendor_id and a row
-- that vanishes takes an audit trail with it.
DO $$
DECLARE
  retired int;
BEGIN
  WITH ranked AS (
    SELECT v.id,
           row_number() OVER (
             PARTITION BY party_key(v.vendor_name)
             ORDER BY (SELECT count(*) FROM vendor_txns t WHERE t.vendor_id = v.id) DESC,
                      v.created_at ASC) AS rn,
           (SELECT count(*) FROM vendor_txns t WHERE t.vendor_id = v.id) AS txns,
           COALESCE(v.current_balance, 0) AS bal
      FROM vendors v
     WHERE v.status = 'ACTIVE'
  ),
  -- Only a group where EVERY duplicate is empty may be retired automatically.
  -- One rupee anywhere in the group and the whole group is left for a person.
  clean_groups AS (
    SELECT party_key(v.vendor_name) AS k
      FROM vendors v WHERE v.status = 'ACTIVE'
     GROUP BY 1
    HAVING count(*) > 1
       AND sum(COALESCE(v.current_balance,0)) = 0
       AND sum((SELECT count(*) FROM vendor_txns t WHERE t.vendor_id = v.id)) = 0
  )
  UPDATE vendors v SET status = 'INACTIVE'
   WHERE v.id IN (SELECT r.id FROM ranked r
                    JOIN vendors vv ON vv.id = r.id
                   WHERE r.rn > 1 AND party_key(vv.vendor_name) IN (SELECT k FROM clean_groups));
  GET DIAGNOSTICS retired = ROW_COUNT;
  RAISE NOTICE '[183] retired % empty duplicate vendor row(s)', retired;
END $$;

-- The index is created only if nothing active still collides — JOHN N WELL has
-- money on both ids and must not be forced. A migration that fails here would
-- block the deploy over a decision that is not its to make.
DO $$
DECLARE
  clashes int;
BEGIN
  SELECT count(*) INTO clashes FROM (
    SELECT 1 FROM vendors WHERE status = 'ACTIVE'
     GROUP BY party_key(vendor_name) HAVING count(*) > 1) x;

  IF clashes = 0 THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS vendors_party_key_uniq
               ON vendors (party_key(vendor_name)) WHERE status = ''ACTIVE''';
    RAISE NOTICE '[183] vendor duplicate door closed';
  ELSE
    RAISE NOTICE '[183] vendor door LEFT OPEN — % name(s) still duplicated with money on more than one id; see v_party_duplicates', clashes;
  END IF;
END $$;

-- ── 6. WHAT A PERSON STILL HAS TO DECIDE ────────────────────────────────────
-- Not a fix: a list. Everything money touches ends up here rather than being
-- merged by this file.
CREATE OR REPLACE VIEW v_party_duplicates AS
  SELECT 'VENDOR'::text                      AS party_type,
         party_key(v.vendor_name)            AS party_key,
         count(*)::int                       AS ids,
         array_agg(v.vendor_name ORDER BY v.vendor_name) AS spellings,
         array_agg(v.id ORDER BY v.vendor_name)          AS party_ids,
         sum(COALESCE(v.current_balance,0))::numeric(14,2) AS money,
         sum((SELECT count(*) FROM vendor_txns t WHERE t.vendor_id = v.id))::int AS entries,
         'Merge karein ya alag rehne dein — dono taraf paisa hai'::text AS decision
    FROM vendors v WHERE v.status = 'ACTIVE'
   GROUP BY 1,2 HAVING count(*) > 1

  UNION ALL

  -- Same name, different mobile: probably different people, which is exactly
  -- why this is a question and not a merge.
  SELECT 'DRIVER', party_key(d.name), count(*)::int,
         array_agg(d.name ORDER BY d.name),
         array_agg(d.id ORDER BY d.name),
         0::numeric(14,2),
         0::int,
         'Mobile alag hain — ek hi aadmi hai ya alag? Aap batayein'
    FROM drivers d WHERE d.status = 'ACTIVE'
   GROUP BY 1,2 HAVING count(*) > 1

  UNION ALL

  SELECT 'VEHICLE_OWNER', o.owner_key, count(*)::int,
         array_agg(o.display_name ORDER BY o.display_name),
         array_agg(o.id ORDER BY o.display_name),
         0::numeric(14,2), 0::int,
         'Ek hi aadmi, kai firm mein — yeh sahi hai, sirf jaankari ke liye'
    FROM vehicle_owners o WHERE o.status = 'ACTIVE'
   GROUP BY 1,2 HAVING count(*) > 1;

COMMENT ON VIEW v_party_duplicates IS
  'Duplicate party identities that a person must resolve. VEHICLE_OWNER rows are informational — the same man in two firms is the design, not a fault.';

COMMIT;
