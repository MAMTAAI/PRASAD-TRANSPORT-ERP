-- 147_three_tier_books.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THREE-TIER BOOKS: COMPANY → BRANCH → VEHICLE (owner directive, 3-Sep-2026)
--
-- "A transaction for Company A / Branch X must NEVER leak into or mix with
--  Company B / Branch Y."
--
-- WHAT THE AUDIT FOUND, on production (read-only, 3-Sep):
--
--   ✔ NOTHING IS MIXED. 2,936 vouchers; the number whose legs name two
--     different companies is ZERO. The scoped report functions (migration 122)
--     already refuse to count an unplaced entry into every firm.
--   ✖ MOST OF THE BOOK IS INVISIBLE INSTEAD. 5,305 of 6,511 entries (81%)
--     carry no company_id at all, so under a company filter they are simply
--     dropped — a firm's P&L is "clean" because four fifths of the ledger is
--     not in it. TOLL_STATEMENT (2,026), FUEL_BILL (1,100), BILL_RAISED (804),
--     LOAN_EMI (450) and FUEL_PUMP_CASH (378) are 100% untagged.
--   ✖ branch_id is NULL on every one of the 6,511 entries and every trip.
--     There is no branch dimension in any report function.
--   ✖ No report function knows about vehicles. A "vehicle-wise P&L" did not
--     exist.
--   ✖ Nothing at the database level requires a new entry to name a firm.
--
-- WHAT THIS MIGRATION DOES — and, as importantly, what it refuses to do.
--
--   ledger_entries is APPEND-ONLY by trigger (ledger_entries_immutable). The
--   5,305 historical rows are therefore not rewritten here, and would not be
--   even if the trigger were lifted: the owner has ruled that out. Instead the
--   firm is DERIVED AT READ TIME, from evidence that already sits in the
--   database, and every report says which evidence it used:
--
--     text            the entry's own company label      (804 rows, local)
--     voucher_sibling another leg of the same voucher is placed
--     loan_account    LOAN* rows → loan_master by account number (382 rows)
--     vehicle_master  the vehicle's own company_id       (49/49 bound on prod)
--     trip_window     the vehicle's trip that brackets the entry date
--     vehicle_trips   a vehicle that has only ever run for one firm
--     unrouted        nothing above applies → stays out of every firm's books
--
--   Measured locally: 3,912 of 5,317 unplaced rows (74%) become attributable
--   with no rewrite at all. The remainder are LOAN_OPENING, IOCL VOUCHER and
--   ADVICE_SETTLEMENT rows that name no firm anywhere, and those are SURFACED
--   (f_routing_coverage), never guessed.
--
--   Going FORWARD the same derivation runs at insert time, and a voucher-era
--   row that still cannot be placed is REFUSED. That is the "strict SQL
--   constraint": the rule lives where no route or script can walk around it.
--   A voucher may name exactly ONE company — a second leg with a different
--   firm is refused as MIXED_COMPANY_VOUCHER, which closes the door the audit
--   found open even though nothing had yet walked through it.
--
--   BRANCH. Every company has exactly one branch today ("HEAD OFFICE"). A
--   routed entry gets its company's sole branch, so branch-wise reporting is
--   complete from day one and grows real the day a second branch exists.
--
--   VEHICLE. 16 of 49 lorries have run trips for TWO firms. So a vehicle is
--   NOT bound to one company for P&L purposes: vehicle-wise P&L is the
--   entries that carry that vehicle_id, sliced by whatever firm each entry
--   routed to. The vehicle master's company_id is used as evidence, not as a
--   cage. v_vehicle_company_proposal shows what the trips say so a person
--   can bind the 0/49 unbound on a fresh database; nothing here binds them.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── 0 · indexes the derivation leans on ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS trips_vehicle_loading_idx     ON trips (vehicle_id, loading_date);
CREATE INDEX IF NOT EXISTS trips_vehicle_company_idx     ON trips (vehicle_id, company_id);
CREATE INDEX IF NOT EXISTS ledger_entries_voucher_idx    ON ledger_entries (voucher_id);
CREATE INDEX IF NOT EXISTS ledger_entries_vehicle_idx    ON ledger_entries (vehicle_id);
CREATE INDEX IF NOT EXISTS loan_master_account_idx       ON loan_master (loan_account_no);

-- ── 1 · company by name, the way the rest of the schema spells it ───────────
CREATE OR REPLACE FUNCTION company_id_by_name(p_name text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT c.id FROM companies c
   WHERE c.company_name = canonical_company(p_name)
   LIMIT 1
$$;

-- The one branch a company has. NULL if it has none or more than one — a
-- branch is only inferred when the inference cannot be wrong.
CREATE OR REPLACE FUNCTION sole_branch_of(p_company uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  -- (array_agg)[1] because uuid has no min(); with exactly one row it IS the row.
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END FROM branches WHERE company_id = p_company
$$;

-- ── 2 · THE ROUTER ──────────────────────────────────────────────────────────
-- Returns (company_id, how). Order is by strength of evidence; the first hit
-- wins. Every branch is a plain lookup so it can run per row in a view and
-- again per row in the insert trigger.
CREATE OR REPLACE FUNCTION f_route_company(
  p_company_id  uuid,
  p_company     text,
  p_vehicle_id  uuid,
  p_entry_date  date,
  p_source_type text,
  p_source_ref  text,
  p_voucher_id  uuid,
  p_self_id     bigint DEFAULT NULL
) RETURNS TABLE (company_id uuid, how text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cid uuid;
  n   int;
BEGIN
  -- a. already stamped
  IF p_company_id IS NOT NULL THEN
    company_id := p_company_id; how := 'company_id'; RETURN NEXT; RETURN;
  END IF;

  -- b. the entry's own text label
  cid := company_id_by_name(p_company);
  IF cid IS NOT NULL THEN
    company_id := cid; how := 'text'; RETURN NEXT; RETURN;
  END IF;

  -- c. another leg of the same voucher is placed (by id or by text)
  IF p_voucher_id IS NOT NULL THEN
    SELECT COALESCE(e.company_id, company_id_by_name(e.company)) INTO cid
      FROM ledger_entries e
     WHERE e.voucher_id = p_voucher_id
       AND (p_self_id IS NULL OR e.id <> p_self_id)
       AND COALESCE(e.company_id, company_id_by_name(e.company)) IS NOT NULL
     LIMIT 1;
    IF cid IS NOT NULL THEN
      company_id := cid; how := 'voucher_sibling'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  -- d. a loan row names its account number in the ref
  IF p_source_type LIKE 'LOAN%' AND p_source_ref IS NOT NULL THEN
    SELECT l.company_id INTO cid
      FROM loan_master l
     WHERE l.company_id IS NOT NULL
       AND p_source_ref ILIKE '%' || l.loan_account_no || '%'
     LIMIT 1;
    IF cid IS NOT NULL THEN
      company_id := cid; how := 'loan_account'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  IF p_vehicle_id IS NOT NULL THEN
    -- e. the vehicle master's own firm
    SELECT v.company_id INTO cid FROM vehicles v WHERE v.id = p_vehicle_id;
    IF cid IS NOT NULL THEN
      company_id := cid; how := 'vehicle_master'; RETURN NEXT; RETURN;
    END IF;

    -- f. the trip this vehicle was on when the entry was dated
    IF p_entry_date IS NOT NULL THEN
      SELECT t.company_id INTO cid
        FROM trips t
       WHERE t.vehicle_id = p_vehicle_id
         AND t.company_id IS NOT NULL
         AND p_entry_date BETWEEN t.loading_date - INTERVAL '3 days'
                              AND COALESCE(t.unloading_date, t.loading_date + INTERVAL '20 days')
       ORDER BY t.loading_date DESC
       LIMIT 1;
      IF cid IS NOT NULL THEN
        company_id := cid; how := 'trip_window'; RETURN NEXT; RETURN;
      END IF;
    END IF;

    -- g. a vehicle that has only ever run for one firm
    SELECT count(DISTINCT t.company_id), (array_agg(DISTINCT t.company_id))[1] INTO n, cid
      FROM trips t WHERE t.vehicle_id = p_vehicle_id AND t.company_id IS NOT NULL;
    IF n = 1 THEN
      company_id := cid; how := 'vehicle_trips'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  -- h. nothing. Say so.
  company_id := NULL; how := 'unrouted'; RETURN NEXT;
END
$$;

-- ── 3 · THE ROUTED VIEW ─────────────────────────────────────────────────────
-- v_ledger_entries_resolved plus the three dimensions and how each was found.
CREATE OR REPLACE VIEW v_ledger_entries_routed AS
SELECT r.*,
       e.vehicle_id,
       rt.company_id                                   AS company_routed,
       rt.how                                          AS company_route,
       COALESCE(e.branch_id, sole_branch_of(rt.company_id)) AS branch_routed,
       CASE WHEN e.branch_id IS NOT NULL THEN 'branch_id'
            WHEN sole_branch_of(rt.company_id) IS NOT NULL THEN 'sole_branch'
            ELSE 'unrouted' END                        AS branch_route,
       co.company_name                                 AS company_routed_name
  FROM v_ledger_entries_resolved r
  JOIN ledger_entries e ON e.id = r.id
  CROSS JOIN LATERAL f_route_company(e.company_id, e.company, e.vehicle_id, e.entry_date,
                                     e.source_type, e.source_ref, e.voucher_id, e.id) rt
  LEFT JOIN companies co ON co.id = rt.company_id;

COMMENT ON VIEW v_ledger_entries_routed IS
  'Every ledger entry with its company / branch / vehicle as DERIVED from the evidence in the '
  'database, and company_route / branch_route saying which evidence. Rows are never rewritten; '
  'company_route = unrouted means no firm could be established and the row is in no firm''s books.';

-- ── 4 · SCOPE: the one predicate every 3-tier report uses ───────────────────
-- p_company is the same text the old functions took (name, or NULL/ALL).
CREATE OR REPLACE FUNCTION books_scope(
  p_row_company uuid, p_row_branch uuid, p_row_vehicle uuid,
  p_company text, p_branch uuid, p_vehicle uuid, p_unassigned text DEFAULT 'exclude'
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT
    -- vehicle: exact or none asked
    (p_vehicle IS NULL OR p_row_vehicle = p_vehicle)
    AND
    -- branch: exact or none asked
    (p_branch IS NULL OR p_row_branch = p_branch)
    AND
    -- company: none asked → everything; asked → that firm, with the unplaced
    -- handled the way the caller said (exclude | include | only)
    CASE
      WHEN p_company IS NULL OR btrim(p_company) = '' OR upper(btrim(p_company)) = 'ALL' THEN true
      WHEN lower(COALESCE(p_unassigned,'exclude')) = 'only'    THEN p_row_company IS NULL
      WHEN p_row_company IS NULL                                THEN lower(COALESCE(p_unassigned,'exclude')) = 'include'
      ELSE p_row_company = company_id_by_name(p_company)
    END
$$;

-- ── 5 · THE THREE-TIER REPORTS ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION f_trial_balance_3tier(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_company text DEFAULT NULL, p_branch uuid DEFAULT NULL, p_vehicle uuid DEFAULT NULL,
  p_unassigned text DEFAULT 'exclude'
) RETURNS TABLE (group_head text, account_type text, statement text, sort_order int,
                 dr numeric, cr numeric, dr_voucher_era numeric, cr_voucher_era numeric)
LANGUAGE sql STABLE AS $$
  SELECT g.group_head, g.account_type, g.statement, g.sort_order,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR' AND NOT e.is_legacy), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR' AND NOT e.is_legacy), 0)::numeric(14,2)
    FROM account_groups g
    LEFT JOIN v_ledger_entries_routed e
           ON e.group_head = g.group_head
          AND (p_from IS NULL OR e.entry_date >= p_from)
          AND (p_to   IS NULL OR e.entry_date <= p_to)
          AND books_scope(e.company_routed, e.branch_routed, e.vehicle_id, p_company, p_branch, p_vehicle, p_unassigned)
   GROUP BY g.group_head, g.account_type, g.statement, g.sort_order
   ORDER BY g.sort_order
$$;

CREATE OR REPLACE FUNCTION f_profit_and_loss_3tier(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_company text DEFAULT NULL, p_branch uuid DEFAULT NULL, p_vehicle uuid DEFAULT NULL,
  p_unassigned text DEFAULT 'exclude'
) RETURNS TABLE (group_head text, account_type text, sort_order int, amount numeric)
LANGUAGE sql STABLE AS $$
  SELECT g.group_head, g.account_type, g.sort_order,
         CASE WHEN g.account_type = 'INCOME'
              THEN COALESCE(SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END), 0)
              ELSE COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
         END::numeric(14,2)
    FROM account_groups g
    LEFT JOIN v_ledger_entries_routed e
           ON e.group_head = g.group_head AND NOT e.is_legacy
          AND (p_from IS NULL OR e.entry_date >= p_from)
          AND (p_to   IS NULL OR e.entry_date <= p_to)
          AND books_scope(e.company_routed, e.branch_routed, e.vehicle_id, p_company, p_branch, p_vehicle, p_unassigned)
   WHERE g.statement = 'PROFIT_AND_LOSS'
   GROUP BY g.group_head, g.account_type, g.sort_order
   ORDER BY g.sort_order
$$;

CREATE OR REPLACE FUNCTION f_balance_sheet_3tier(
  p_to date DEFAULT NULL,
  p_company text DEFAULT NULL, p_branch uuid DEFAULT NULL, p_vehicle uuid DEFAULT NULL,
  p_unassigned text DEFAULT 'exclude'
) RETURNS TABLE (group_head text, account_type text, sort_order int, amount numeric, side text)
LANGUAGE sql STABLE AS $$
  WITH bal AS (
    SELECT g.group_head, g.account_type, g.sort_order,
           COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2) AS dr_net
      FROM account_groups g
      LEFT JOIN v_ledger_entries_routed e
             ON e.group_head = g.group_head
            AND (p_to IS NULL OR e.entry_date <= p_to)
            AND books_scope(e.company_routed, e.branch_routed, e.vehicle_id, p_company, p_branch, p_vehicle, p_unassigned)
     WHERE g.statement = 'BALANCE_SHEET'
     GROUP BY g.group_head, g.account_type, g.sort_order
  ),
  pl_current AS (
    SELECT COALESCE(SUM(CASE WHEN account_type = 'INCOME' THEN amount ELSE -amount END), 0)::numeric(14,2) AS profit
      FROM f_profit_and_loss_3tier(NULL, p_to, p_company, p_branch, p_vehicle, p_unassigned)
  ),
  pl_legacy AS (
    SELECT COALESCE(SUM(CASE WHEN e.account_type = 'INCOME'
                             THEN CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END
                             ELSE CASE WHEN e.dr_cr = 'DR' THEN -e.amount ELSE e.amount END END), 0)::numeric(14,2) AS profit
      FROM v_ledger_entries_routed e
      JOIN account_groups g ON g.group_head = e.group_head
     WHERE e.is_legacy AND g.statement = 'PROFIT_AND_LOSS'
       AND (p_to IS NULL OR e.entry_date <= p_to)
       AND books_scope(e.company_routed, e.branch_routed, e.vehicle_id, p_company, p_branch, p_vehicle, p_unassigned)
  )
  SELECT b.group_head, b.account_type, b.sort_order,
         (CASE WHEN b.account_type = 'ASSET' THEN b.dr_net ELSE -b.dr_net END)::numeric(14,2),
         CASE WHEN b.account_type = 'ASSET' THEN 'ASSETS' ELSE 'LIABILITIES_AND_EQUITY' END
    FROM bal b WHERE b.dr_net <> 0
  UNION ALL
  SELECT 'Profit for the period', 'EQUITY', 998, profit, 'LIABILITIES_AND_EQUITY' FROM pl_current WHERE profit <> 0
  UNION ALL
  SELECT 'Accumulated result brought forward (pre-migration)', 'EQUITY', 999, profit, 'LIABILITIES_AND_EQUITY'
    FROM pl_legacy WHERE profit <> 0
   ORDER BY 5, 3
$$;

CREATE OR REPLACE FUNCTION f_ledger_balances_3tier(
  p_company text DEFAULT NULL, p_branch uuid DEFAULT NULL, p_vehicle uuid DEFAULT NULL,
  p_unassigned text DEFAULT 'exclude'
) RETURNS TABLE (ledger_name text, group_head text, entries bigint, dr numeric, cr numeric, balance numeric, last_entry date)
LANGUAGE sql STABLE AS $$
  SELECT e.ledger_name, e.group_head, count(*)::bigint,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2),
         COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2),
         max(e.entry_date)
    FROM v_ledger_entries_routed e
   WHERE books_scope(e.company_routed, e.branch_routed, e.vehicle_id, p_company, p_branch, p_vehicle, p_unassigned)
   GROUP BY e.ledger_name, e.group_head
$$;

-- How much of the book is in SOMEBODY's books now, and by what evidence.
-- This is the number the report banner shows instead of "81% missing".
CREATE OR REPLACE FUNCTION f_routing_coverage(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (company_route text, company_routed_name text, entries bigint, dr numeric, cr numeric)
LANGUAGE sql STABLE AS $$
  SELECT e.company_route, COALESCE(e.company_routed_name, '— unrouted —'), count(*)::bigint,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2)
    FROM v_ledger_entries_routed e
   WHERE (p_from IS NULL OR e.entry_date >= p_from)
     AND (p_to   IS NULL OR e.entry_date <= p_to)
   GROUP BY e.company_route, e.company_routed_name
   ORDER BY 3 DESC
$$;

-- ── 6 · THE FORWARD GUARD ───────────────────────────────────────────────────
-- BEFORE INSERT: route the row; fill the branch; refuse a voucher-era row that
-- still names no firm; refuse a second firm on the same voucher.
--
-- Legacy single-entry imports (voucher_id NULL) are exempt, the same boundary
-- assert_voucher_balanced draws. A scripted import that must post rows the
-- router cannot place may say so explicitly for its own transaction:
--     SET LOCAL prasad.ledger_routing = 'lenient';
-- and the row lands with company_id NULL and is surfaced by f_routing_coverage
-- as unrouted. Nothing is ever placed silently.
CREATE OR REPLACE FUNCTION ledger_route_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rt   record;
  other uuid;
  mode text := COALESCE(NULLIF(current_setting('prasad.ledger_routing', true), ''), 'strict');
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT * INTO rt FROM f_route_company(NULL, NEW.company, NEW.vehicle_id, NEW.entry_date,
                                          NEW.source_type, NEW.source_ref, NEW.voucher_id, NULL);
    NEW.company_id := rt.company_id;
  END IF;

  IF NEW.company_id IS NOT NULL THEN
    -- the firm's text label travels with the row, so v_ledger_entries_resolved
    -- and every older reader agree with the new ones
    IF NEW.company IS NULL OR btrim(NEW.company) = '' THEN
      SELECT company_name INTO NEW.company FROM companies WHERE id = NEW.company_id;
    END IF;
    IF NEW.branch_id IS NULL THEN
      NEW.branch_id := sole_branch_of(NEW.company_id);
    END IF;

    -- ONE VOUCHER, ONE FIRM.
    IF NEW.voucher_id IS NOT NULL THEN
      SELECT e.company_id INTO other
        FROM ledger_entries e
       WHERE e.voucher_id = NEW.voucher_id
         AND e.company_id IS NOT NULL
         AND e.company_id <> NEW.company_id
       LIMIT 1;
      IF other IS NOT NULL THEN
        RAISE EXCEPTION 'MIXED_COMPANY_VOUCHER: voucher % already carries company %, this leg names % — one voucher, one firm',
          NEW.voucher_id, other, NEW.company_id USING ERRCODE = 'P0403';
      END IF;
    END IF;
  ELSIF NEW.voucher_id IS NOT NULL AND mode <> 'lenient' THEN
    RAISE EXCEPTION 'UNROUTED_ENTRY: "%" (%/%) names no operating company and none could be derived from its text, voucher, loan, vehicle or trip — set company_id, or SET LOCAL prasad.ledger_routing = ''lenient'' for an explicit legacy import',
      NEW.ledger_name, NEW.source_type, COALESCE(NEW.source_ref, '-') USING ERRCODE = 'P0403';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ledger_entries_route ON ledger_entries;
-- Fires BEFORE the fleet-segment guard by name order ('ledger_entries_fleet_segment'
-- < 'ledger_entries_route'), which is fine: neither depends on the other.
CREATE TRIGGER ledger_entries_route
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_route_guard();

-- ── 7 · ENTITY BINDINGS — what is bound to a firm, what is not ──────────────
CREATE OR REPLACE VIEW v_vehicle_company_proposal AS
SELECT v.id AS vehicle_id, v.vehicle_no, v.company_id AS bound_company_id,
       cb.company_name AS bound_company,
       d.company_id     AS dominant_company_id,
       cd.company_name  AS dominant_company,
       d.trips_for_dominant, s.trips_total, s.companies_seen,
       CASE WHEN v.company_id IS NOT NULL THEN 'bound'
            WHEN s.trips_total = 0 THEN 'no_trips'
            WHEN s.companies_seen = 1 THEN 'single_firm'
            ELSE 'shared' END AS proposal
  FROM vehicles v
  LEFT JOIN companies cb ON cb.id = v.company_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS trips_total, count(DISTINCT t.company_id) AS companies_seen
      FROM trips t WHERE t.vehicle_id = v.id) s ON true
  LEFT JOIN LATERAL (
    SELECT t.company_id, count(*) AS trips_for_dominant
      FROM trips t WHERE t.vehicle_id = v.id AND t.company_id IS NOT NULL
     GROUP BY t.company_id ORDER BY count(*) DESC LIMIT 1) d ON true
  LEFT JOIN companies cd ON cd.id = d.company_id;

CREATE OR REPLACE FUNCTION f_entity_binding_audit()
RETURNS TABLE (entity text, total bigint, bound bigint, unbound bigint, note text)
LANGUAGE sql STABLE AS $$
  SELECT 'vehicles', count(*), count(company_id), count(*)-count(company_id),
         'v_vehicle_company_proposal shows what the trips say; a person binds' FROM vehicles
  UNION ALL
  SELECT 'drivers', count(*), count(company_id), count(*)-count(company_id), NULL FROM drivers
  UNION ALL
  SELECT 'trips', count(*), count(company_id), count(*)-count(company_id), NULL FROM trips
  UNION ALL
  SELECT 'loans', count(*), count(company_id), count(*)-count(company_id), NULL FROM loan_master
  UNION ALL
  SELECT 'market settlements', count(*), count(company_id), count(*)-count(company_id),
         'firm is named per deal; migration 144 refuses money without it' FROM bazaar_settlements
  UNION ALL
  SELECT 'customers', count(*), 0, count(*),
         'no company column by design — a customer (IOCL) is served by more than one firm; the firm lives on the trip and the bill' FROM customers
  UNION ALL
  SELECT 'vendors', count(*), 0, count(*),
         'no company column by design — the firm lives on each bill (migration 140)' FROM vendors
  UNION ALL
  SELECT 'market vehicles', count(*), 0, count(*),
         'partner-owned; the firm lives on the settlement, not the truck' FROM market_vehicles
$$;

COMMIT;
