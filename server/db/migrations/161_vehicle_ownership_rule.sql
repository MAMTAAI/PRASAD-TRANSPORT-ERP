-- ═══════════════════════════════════════════════════════════════════════════
-- 161 — OWN vs ATTACHED: one rule, decided on the vehicle master, obeyed everywhere
--
-- Owner, 5-Sep-2026, on the vehicle form (AS19C8666 open): "yahan se own
-- vehicle aur attach vehicle ko final kiya jaye … Operating Company … yahan
-- par attach aur own ka option hoga to system yeh fixed kar payega … rule
-- final karo aur system ko globally manage karo."
--
-- ── WHAT THE AUDIT FOUND ──────────────────────────────────────────────────
--
-- THREE columns decide the same thing, and they disagree:
--
--   vehicles.ownership          what the form writes (OWNED / ATTACHED / LEASED).
--                               Read by vehicle_class() → the 15-day bills,
--                               toll import, unmapped-vehicle desk.
--   vehicles.is_company_owned   derived ONCE in migration 053 from ownership,
--                               never kept in step since. TRUE ON ALL 49 ROWS,
--                               including the 16 ATTACHED lorries. Read by
--                               fleetAccounting, fuel import, fee posting,
--                               compliance, dashboards, drill-downs, trip
--                               import — every accounting decision.
--   vehicles.vehicle_owner_ledger_id  NULL on all 49. The 053 CHECK
--                               (is_company_owned OR ledger IS NOT NULL) only
--                               holds because is_company_owned is true.
--
-- So the settlement side calls SANDEEP's eleven lorries ATTACHED while the
-- accounting side calls them company-owned and every dashboard counts 49 own.
--
-- And the master itself is ambiguous on 12 lorries: OWNED, but owner_name is a
-- person (SANTOSH PRASAD ×8 and GAUTAM PRASAD ×2 under JAISWAL, SANDEEP ×2
-- under PRASAD). One lorry is ATTACHED to its own company. 16 lorries have run
-- trips in a company other than their master's.
--
-- ── THE RULE ──────────────────────────────────────────────────────────────
--
--   OPERATING COMPANY  = whose BOOKS the lorry runs in (vehicles.company_id).
--   OWN                = that company owns the lorry. owner_name IS the
--                        company. Freight and running cost are the company's.
--   ATTACHED           = somebody else owns it — a person or another family
--                        firm. owner_name is required and cannot be the
--                        operating company. The company books the trip's
--                        running cost, keeps its commission, withholds TDS
--                        and pays the owner on the 15-day bill (migration
--                        160). The owner's khata 'Vehicle Owner: <NAME>' is
--                        created and linked here, automatically.
--   is_company_owned   = DERIVED from ownership by trigger. Nobody writes it.
--
--   Running costs (diesel, toll, pump cash, advance, fooding, fixed, doc,
--   other) are ALWAYS booked by the company and recovered from an attached
--   owner ONLY on the 15-day bill — never per slip. That is what the last
--   3,500 fuel and toll postings already did (because is_company_owned was
--   true), so nothing double-charges. Lorry-level papers (fitness, permit,
--   insurance) on an attached lorry still go to the owner's khata directly.
--
-- ── WHAT IS FIXED, AND WHAT IS ONLY SHOWN ─────────────────────────────────
--
--   Fixed here, because it is unambiguous: the 16 ATTACHED rows get their
--   owner ledger and is_company_owned = false; the one OWNED row with a blank
--   owner gets its company as owner.
--   Shown, not fixed, because it is a business decision: the 12 OWNED-but-
--   person-owner rows, the lorry attached to itself, the 16 without a
--   commission rate, the cross-company trips. v_vehicle_rule_audit lists them;
--   the vehicle screen shows the list; the trigger insists on a consistent
--   answer the next time somebody edits that lorry's owner, company or type.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE OWNER'S KHATA, FOUND OR MADE ═════════════════════════════════
-- 'Vehicle Owner: SANDEEP KUMAR PRASAD' under Sundry Creditors (Vehicle
-- Owners) — the same name the 15-day bill credits, so master and bill land in
-- ONE ledger whatever case or spacing the name was typed in.
CREATE OR REPLACE FUNCTION vehicle_owner_ledger_name(p_owner text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_owner IS NULL OR btrim(p_owner) = '' THEN NULL
              ELSE 'Vehicle Owner: ' || upper(btrim(regexp_replace(p_owner, '\s+', ' ', 'g'))) END
$$;

-- The group the khata lives in. Migration 053 made it on production; a box
-- restored from a schema-only dump would not have it, and a ledger insert
-- against a missing group fails with a foreign-key error at the worst moment
-- (the first attached lorry somebody saves). Guaranteed here, idempotently.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Sundry Creditors (Vehicle Owners)',
       COALESCE(g.account_type, 'LIABILITY'), COALESCE(g.statement, 'BALANCE_SHEET'),
       COALESCE(g.normal_side, 'CR'), 485, true
  FROM (SELECT 1) x
  LEFT JOIN account_groups g ON g.group_head = 'Sundry Creditors (Vendors)'
 WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = 'Sundry Creditors (Vehicle Owners)');

CREATE OR REPLACE FUNCTION ensure_vehicle_owner_ledger(p_owner text) RETURNS uuid AS $$
DECLARE v_name text := vehicle_owner_ledger_name(p_owner); v_id uuid;
BEGIN
  IF v_name IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM ledgers WHERE upper(ledger_name) = upper(v_name) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, current_balance, creation_type, status)
    VALUES (v_name, 'Sundry Creditors (Vehicle Owners)', 'CR', 0, 0, 'SYSTEM', 'ACTIVE')
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ═══ 2. THE BACKFILL — before the trigger, so it cannot refuse history ════
-- An own lorry with no owner written: the owner is the company.
UPDATE vehicles v
   SET owner_name = c.company_name
  FROM companies c
 WHERE c.id = v.company_id
   AND v.ownership <> 'ATTACHED'
   AND (v.owner_name IS NULL OR btrim(v.owner_name) = '');

UPDATE vehicles SET is_company_owned = true
 WHERE ownership <> 'ATTACHED' AND is_company_owned = false;

-- The 16 attached lorries: an owner khata each, and the flag the accounting
-- code reads finally says what the master says. Both columns in ONE statement
-- so the 053 CHECK (is_company_owned OR ledger IS NOT NULL) holds row by row.
UPDATE vehicles
   SET vehicle_owner_ledger_id = ensure_vehicle_owner_ledger(owner_name),
       is_company_owned = false
 WHERE ownership = 'ATTACHED'
   AND owner_name IS NOT NULL AND btrim(owner_name) <> ''
   AND (is_company_owned OR vehicle_owner_ledger_id IS NULL);

-- ═══ 3. THE RULE, AT THE DOOR ═════════════════════════════════════════════
--
-- Refuses only what is CONTRADICTORY, and only when the contradiction is being
-- written now (insert, or a change to ownership / company / owner). An old row
-- that already disagrees with itself can still have its tyre count edited —
-- the audit shows it; the desk resolves it when they next touch its identity.
CREATE OR REPLACE FUNCTION vehicles_ownership_rule() RETURNS trigger AS $$
DECLARE
  co      text;
  changed boolean;
BEGIN
  SELECT company_name INTO co FROM companies WHERE id = NEW.company_id;
  changed := TG_OP = 'INSERT'
          OR NEW.ownership  IS DISTINCT FROM OLD.ownership
          OR NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.owner_name IS DISTINCT FROM OLD.owner_name;

  IF NEW.ownership = 'ATTACHED' THEN
    IF NEW.owner_name IS NULL OR btrim(NEW.owner_name) = '' THEN
      RAISE EXCEPTION
        '% : ATTACHED gaadi ka malik (owner name) likhna zaroori hai — 15-din ka bill usi ke naam banta hai',
        NEW.vehicle_no USING ERRCODE = 'P0413';
    END IF;
    IF changed AND co IS NOT NULL
       AND norm_company_name(NEW.owner_name) = norm_company_name(co) THEN
      RAISE EXCEPTION
        '% : malik aur operating company ek hi hain (%) — yeh OWN gaadi hai, Attached nahi',
        NEW.vehicle_no, co USING ERRCODE = 'P0414';
    END IF;
    NEW.is_company_owned := false;
    NEW.vehicle_owner_ledger_id := ensure_vehicle_owner_ledger(NEW.owner_name);
  ELSE
    -- OWNED and LEASED: the company's lorry.
    NEW.is_company_owned := true;
    IF (NEW.owner_name IS NULL OR btrim(NEW.owner_name) = '') AND co IS NOT NULL THEN
      NEW.owner_name := co;
    ELSIF changed AND co IS NOT NULL AND NEW.owner_name IS NOT NULL
          AND norm_company_name(NEW.owner_name) <> norm_company_name(co) THEN
      RAISE EXCEPTION
        '% : OWN gaadi ka malik company hi hota hai (%), "%" nahi — Attached chuniye ya malik company rakhiye',
        NEW.vehicle_no, co, NEW.owner_name USING ERRCODE = 'P0414';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicles_ownership_rule ON vehicles;
CREATE TRIGGER vehicles_ownership_rule
  BEFORE INSERT OR UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_ownership_rule();

COMMENT ON FUNCTION vehicles_ownership_rule() IS
  'The own/attached rule (5-Sep-2026): OWN = the operating company owns it '
  '(owner = company); ATTACHED = someone else does (owner required, not the '
  'company, khata auto-linked). is_company_owned is derived, never written.';

-- ═══ 4. WHAT STILL DISAGREES — for a person to decide ════════════════════
CREATE OR REPLACE VIEW v_vehicle_rule_audit AS
WITH v AS (
  SELECT v.id, v.vehicle_no, v.vehicle_no_norm, v.ownership::text AS ownership,
         v.owner_name, v.company_id, c.company_name, v.status::text AS status
    FROM vehicles v
    LEFT JOIN companies c ON c.id = v.company_id
), tv AS (
  SELECT reg_key(t.vehicle_no) AS k, count(*)::int AS trips,
         COALESCE(sum(t.billed_amount), 0)::numeric(14,2) AS freight
    FROM trips t WHERE t.status = 'COMPLETED' GROUP BY 1
)
-- OWN on paper, but the owner written is not the company.
SELECT v.id AS vehicle_id, v.vehicle_no, v.ownership, v.owner_name, v.company_name,
       'OWN_OWNER_MISMATCH'::text AS finding, 'HIGH'::text AS severity,
       format('OWN likha hai par malik "%s" hai aur books "%s" — Own hai ya Attached? (Attached ho to commission/TDS ka bill banega)',
              v.owner_name, v.company_name) AS detail,
       COALESCE(tv.trips, 0) AS trips, COALESCE(tv.freight, 0) AS freight
  FROM v LEFT JOIN tv ON tv.k = v.vehicle_no_norm
 WHERE v.ownership <> 'ATTACHED' AND v.owner_name IS NOT NULL AND v.company_name IS NOT NULL
   AND norm_company_name(v.owner_name) <> norm_company_name(v.company_name)

UNION ALL
-- ATTACHED to itself.
SELECT v.id, v.vehicle_no, v.ownership, v.owner_name, v.company_name,
       'ATTACHED_TO_SELF', 'HIGH',
       format('ATTACHED likha hai par malik aur books dono "%s" — yeh Own gaadi hai', v.company_name),
       COALESCE(tv.trips, 0), COALESCE(tv.freight, 0)
  FROM v LEFT JOIN tv ON tv.k = v.vehicle_no_norm
 WHERE v.ownership = 'ATTACHED' AND v.owner_name IS NOT NULL AND v.company_name IS NOT NULL
   AND norm_company_name(v.owner_name) = norm_company_name(v.company_name)

UNION ALL
-- ATTACHED with no commission term: its bills cannot be approved.
SELECT v.id, v.vehicle_no, v.ownership, v.owner_name, v.company_name,
       'ATTACHED_NO_RATE', 'MEDIUM',
       'Attached hai par Commission Master me rate nahi — 15-din ka bill approve nahi hoga (rate 1 Apr 2026 se bhariye)',
       COALESCE(tv.trips, 0), COALESCE(tv.freight, 0)
  FROM v LEFT JOIN tv ON tv.k = v.vehicle_no_norm
 WHERE v.ownership = 'ATTACHED'
   AND NOT EXISTS (SELECT 1 FROM vehicle_commission_terms t
                    WHERE t.vehicle_key = v.vehicle_no_norm AND t.effective_to IS NULL)

UNION ALL
-- No operating company at all.
SELECT v.id, v.vehicle_no, v.ownership, v.owner_name, v.company_name,
       'NO_COMPANY', 'HIGH',
       'Operating company darj nahi — kis firm ki books me chalti hai?',
       COALESCE(tv.trips, 0), COALESCE(tv.freight, 0)
  FROM v LEFT JOIN tv ON tv.k = v.vehicle_no_norm
 WHERE v.company_id IS NULL

UNION ALL
-- Ran in another firm's books.
SELECT v.id, v.vehicle_no, v.ownership, v.owner_name, v.company_name,
       'TRIPS_OTHER_COMPANY', 'MEDIUM',
       format('%s trip "%s" ki books me chale (₹%s), master me "%s" — kis company ki gaadi hai?',
              x.n, x.co, to_char(x.freight, 'FM99,99,99,999'), v.company_name),
       x.n, x.freight
  FROM v
  JOIN LATERAL (
    SELECT btrim(t.operating_company) AS co, count(*)::int AS n,
           COALESCE(sum(t.billed_amount), 0)::numeric(14,2) AS freight
      FROM trips t
     WHERE t.status = 'COMPLETED' AND reg_key(t.vehicle_no) = v.vehicle_no_norm
       AND t.operating_company IS NOT NULL
       AND NOT company_matches(t.operating_company, v.company_name)
     GROUP BY 1) x ON true
 WHERE v.company_name IS NOT NULL

UNION ALL
-- A lorry that ran trips and is in no master at all.
SELECT NULL::uuid, min(t.vehicle_no), NULL, NULL, NULL,
       'NO_MASTER', 'HIGH',
       'Is number par trip hain par vehicle master me yeh gaadi nahi — Vehicle master me jodiye',
       count(*)::int, COALESCE(sum(t.billed_amount), 0)::numeric(14,2)
  FROM trips t
 WHERE t.status = 'COMPLETED' AND t.vehicle_no IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.vehicle_no_norm = reg_key(t.vehicle_no))
 GROUP BY reg_key(t.vehicle_no);

COMMENT ON VIEW v_vehicle_rule_audit IS
  'Every lorry whose master disagrees with itself or with its trips: OWN with a '
  'person as owner, ATTACHED to its own company, attached without a rate, no '
  'company, trips in another firm''s books, trips with no master. Nothing here '
  'is corrected automatically — each row is a decision for the desk.';
