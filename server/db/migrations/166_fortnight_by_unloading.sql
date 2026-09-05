-- ═══════════════════════════════════════════════════════════════════════════
-- 166 — Every customer on the 15-day cycle, a trip joins the cycle it was
--       UNLOADED in, a bill keeps the trips it was raised with, the desk sees
--       only what needs a decision, and the books speak English.
--
-- Owner, 5-Sep-2026 (screenshot of the customer bill list):
--   "bill customer-wise 15 days par bane, IOCL ke style me grouping, ek bill
--    me pack; reconciliation ke baad approve ho to missing trip dashboard par;
--    unloading complete hone par hi us period ke bill cycle me — warna agle
--    cycle me; Hindi/Hinglish headings → professional English (UI, PDF, SQL);
--    jo match ho jaye usko update karo, staff ko sirf problem wale dikhao."
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--   1. customers.bill_cycle = FORTNIGHT for everyone (Aadhar Green was
--      monthly; its five raised monthly bills stay as they are — history is
--      not rewritten — and from now it drafts fortnightly like the rest).
--   2. The cycle a trip belongs to is the fortnight of its UNLOADING date.
--      A completed trip with no unloading date is not billable yet; it is
--      listed on the mapping desk (NOT_UNLOADED) and joins the cycle in which
--      it is unloaded. Same rule for the vehicle 15-day bill's source view.
--   3. A bill's trips are the trips assigned to it (trips.customer_bill_id),
--      not "whatever now falls in its date range". Raised bills are immutable
--      in membership; open drafts are re-assigned by the build. 170 trips on
--      production unload in a different fortnight from their loading — under
--      the old range rule a raised bill could silently lose or gain them.
--   4. Labels and messages inside functions and views read in English.
--   5. v_customer_bills_autoraise: the drafts that are clean (period over,
--      every trip priced, on the customer's document, nothing missing, short
--      or unmatched). The agent raises those; the desk gets the rest.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. ONE CYCLE FOR ALL ═════════════════════════════════════════════════
UPDATE customers SET bill_cycle = 'FORTNIGHT' WHERE bill_cycle <> 'FORTNIGHT';

-- ═══ 1b. WHAT A PERSON SETTLES BY HAND, TRIP BY TRIP ═════════════════════
-- Owner, 5-Sep: "staff bhi data ko trip-wise update kar sake". A payment the
-- advice pipeline cannot see (a cheque, a customer with no advice format, a
-- line the parser missed) is recorded here against the trip, with who and
-- why. It overrides the advice-derived figure for that trip and nothing else;
-- deleting the row puts the advice back in charge.
CREATE TABLE IF NOT EXISTS customer_trip_settlements (
  trip_id      uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  received     numeric(14,2) NOT NULL CHECK (received >= 0),
  settled_on   date,
  reference    text,                       -- ODN / UTR / cheque no / advice ref
  note         text,
  updated_by   text NOT NULL DEFAULT 'desk',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customer_trip_settlements IS
  'Manual trip-wise receipt recorded by staff (166). Overrides the advice-derived received/flag for that trip; the audit trail is who/when/reference.';

-- ═══ 2. THE CYCLE IS THE UNLOADING FORTNIGHT ══════════════════════════════
CREATE OR REPLACE VIEW v_customer_trip_recon AS
SELECT t.id                                                        AS trip_id,
       t.trip_code,
       customer_of(t.customer_name)                                AS customer_id,
       c.customer_name                                             AS customer_master_name,
       t.customer_name,
       c.customer_type, c.customer_code, c.bill_cycle,
       btrim(t.operating_company)                                  AS operating_company,
       COALESCE(norm_company(t.operating_company), '')             AS books_key,
       branch_key(t.unloading_location)                            AS branch_key,
       branch_code_of(t.unloading_location)                        AS branch_code,
       btrim(t.unloading_location)                                 AS branch_name,
       t.vehicle_no, t.driver_name, t.loading_date, t.unloading_date,
       t.unloading_date                                            AS bill_date,
       fortnight_from(t.unloading_date)                            AS period_from,
       date_trunc('month', t.unloading_date)::date                 AS month_from,
       t.product_type, t.loaded_qty, t.shortage_qty, t.rtkm,
       COALESCE(t.rate, CASE WHEN COALESCE(t.billed_amount, 0) <= 0 THEN c.contract_rate_per_kl END)::numeric(12,4) AS rate,
       t.iocl_bill_no, t.challan_no,
       g.gross,
       COALESCE(t.shortage_penalty, 0)::numeric(14,2)              AS penalty,
       COALESCE(t.tds_amount, 0)::numeric(14,2)                    AS tds,
       CASE WHEN ms.trip_id IS NOT NULL THEN ms.received
            WHEN s.payment_state IN ('PAID', 'SHORT')
            THEN round((g.gross - COALESCE(t.shortage_penalty, 0)) * s.paid_ratio, 2)
            ELSE 0 END::numeric(14,2)                              AS received,
       t.linked_bill_id, t.billing_status, t.customer_bill_id,
       m.match_status, m.bill_no                                   AS their_bill_no,
       CASE
         WHEN g.gross <= 0 THEN 'UNPRICED'
         WHEN ms.trip_id IS NOT NULL THEN
              CASE WHEN ms.received >= g.gross - COALESCE(t.shortage_penalty, 0) - 2 THEN 'PAID'
                   WHEN ms.received > 0 THEN 'SHORT'
                   ELSE 'PENDING' END
         WHEN s.payment_state = 'PAID' THEN 'PAID'
         WHEN s.payment_state = 'SHORT' THEN 'SHORT'
         WHEN t.iocl_bill_no IS NOT NULL OR m.trip_id IS NOT NULL THEN 'PENDING'
         WHEN c.customer_code = '11024699'
              AND EXISTS (SELECT 1 FROM iocl_bill_lines l
                           WHERE l.line_date BETWEEN fortnight_from(t.unloading_date) AND fortnight_to(t.unloading_date))
              THEN 'MISSING'
         ELSE 'PENDING'
       END                                                         AS flag,
       ms.reference                                                AS manual_ref
  FROM trips t
  LEFT JOIN customers c ON c.id = customer_of(t.customer_name)
  LEFT JOIN LATERAL (
    SELECT COALESCE(NULLIF(t.billed_amount, 0),
                    CASE WHEN c.contract_rate_per_kl IS NOT NULL AND COALESCE(t.loaded_qty, 0) > 0
                         THEN round(t.loaded_qty * c.contract_rate_per_kl, 2) END,
                    0)::numeric(14,2) AS gross) g ON true
  LEFT JOIN LATERAL (
    SELECT m.trip_id, m.bill_no, m.match_status FROM iocl_recon_matches m
     WHERE m.trip_id = t.id ORDER BY m.created_at DESC LIMIT 1) m ON true
  LEFT JOIN v_iocl_bill_paid s ON s.bill_no = COALESCE(m.bill_no, t.iocl_bill_no)
  LEFT JOIN customer_trip_settlements ms ON ms.trip_id = t.id
 WHERE t.status = 'COMPLETED' AND t.unloading_date IS NOT NULL;

COMMENT ON VIEW v_customer_trip_recon IS
  'Every completed AND unloaded trip against what the customer paid for it (165/166). The cycle is the '
  'fortnight of the unloading date; a trip without one is not billable yet. PAID / SHORT come from the '
  'payment advice (v_iocl_bill_paid), PENDING = billed and unpaid, MISSING = the customer billed the '
  'fortnight without this trip, UNPRICED = no amount and no contract rate.';

-- The vehicle 15-day bill follows the same rule: the lorry is settled for the
-- fortnight its trips were UNLOADED in. Same columns as 160/162.
CREATE OR REPLACE VIEW v_vehicle_fortnight_draft AS
SELECT upper(regexp_replace(t.vehicle_no, '[^A-Za-z0-9]', '', 'g'))  AS vehicle_key,
       min(t.vehicle_no)                                             AS vehicle_no,
       max(t.vehicle_id::text)::uuid                                 AS vehicle_id,
       string_agg(DISTINCT t.operating_company, ' + ')               AS operating_company,
       fortnight_from(t.unloading_date)                               AS period_from,
       fortnight_to(t.unloading_date)                                 AS period_to,
       fortnight_code(t.unloading_date)                               AS cycle,
       count(*)::int                                                  AS trips_count,
       COALESCE(sum(t.billed_amount), 0)::numeric(14,2)               AS billed_amount,
       COALESCE(sum(t.received_amount), 0)::numeric(14,2)             AS received_amount,
       COALESCE(sum(p.hsd), 0)::numeric(14,2)                         AS hsd,
       COALESCE(sum(p.toll), 0)::numeric(14,2)                        AS toll,
       COALESCE(sum(p.tyre), 0)::numeric(14,2)                        AS tyre,
       COALESCE(sum(p.maintenance), 0)::numeric(14,2)                 AS maintenance,
       COALESCE(sum(p.other), 0)::numeric(14,2)                       AS other_expense,
       COALESCE(sum(p.advances), 0)::numeric(14,2)                    AS advances,
       COALESCE(sum(p.expense_total), 0)::numeric(14,2)               AS expense_total,
       (COALESCE(sum(t.billed_amount), 0)
        - COALESCE(sum(p.expense_total), 0))::numeric(14,2)           AS net,
       COALESCE(sum(t.loaded_qty), 0)::numeric(14,3)                  AS loaded_qty,
       COALESCE(sum(t.rtkm), 0)::numeric(14,2)                        AS rtkm,
       COALESCE(sum(p.fooding), 0)::numeric(14,2)                     AS fooding,
       COALESCE(sum(p.fixed_allowance), 0)::numeric(14,2)             AS fixed_allowance,
       COALESCE(sum(p.doc_expense), 0)::numeric(14,2)                 AS doc_expense,
       COALESCE(sum(t.shortage_penalty), 0)::numeric(14,2)            AS shortage_penalty
  FROM trips t
  LEFT JOIN v_trip_pnl p ON p.trip_id = t.id
 WHERE t.vehicle_no IS NOT NULL
   AND t.unloading_date IS NOT NULL
   AND t.status = 'COMPLETED'
 GROUP BY 1, 5, 6, 7;

-- ═══ 3. A BILL OWNS ITS TRIPS ═════════════════════════════════════════════
CREATE OR REPLACE FUNCTION customer_bill_lines(p_bill uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH rows AS (
    SELECT r.*, (SELECT cb.source = 'CONFIRMED' FROM customer_branches cb
                  WHERE cb.customer_id = r.customer_id AND cb.branch_key = r.branch_key) AS branch_confirmed
      FROM v_customer_trip_recon r
     WHERE r.customer_bill_id = p_bill
  ), blocks AS (
    SELECT COALESCE(branch_key, '(BRANCH NOT RECORDED)') AS branch_key,
           max(branch_code) AS branch_code,
           COALESCE(min(branch_name), '(Branch not recorded)') AS branch_name,
           bool_or(COALESCE(branch_confirmed, false)) AS confirmed,
           count(*)::int AS trips,
           min(bill_date) AS first_date,
           COALESCE(sum(loaded_qty), 0)::numeric(14,3) AS qty,
           COALESCE(sum(rtkm), 0)::numeric(14,2) AS rtkm,
           sum(gross)::numeric(14,2) AS gross,
           sum(penalty)::numeric(14,2) AS penalty,
           sum(tds)::numeric(14,2) AS tds,
           sum(received)::numeric(14,2) AS received,
           jsonb_agg(jsonb_build_object(
             'trip_id', trip_id, 'trip_code', trip_code, 'iocl_bill_no', iocl_bill_no, 'challan_no', challan_no,
             'their_bill_no', their_bill_no, 'match_status', match_status,
             'vehicle_no', vehicle_no, 'driver', driver_name,
             'loading_date', loading_date, 'unloading_date', unloading_date,
             'product', product_type, 'qty', loaded_qty, 'shortage_qty', shortage_qty, 'rtkm', rtkm, 'rate', rate,
             'gross', gross, 'penalty', penalty, 'tds', tds, 'received', received,
             'flag', flag, 'legacy_bill', linked_bill_id IS NOT NULL, 'manual_ref', manual_ref)
             ORDER BY bill_date, trip_code) AS trips_json
      FROM rows
     GROUP BY COALESCE(branch_key, '(BRANCH NOT RECORDED)')
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'branch_key', branch_key, 'branch_code', branch_code, 'branch_name', branch_name,
           'confirmed', confirmed, 'trips', trips_json,
           'subtotal', jsonb_build_object('trips', trips, 'qty', qty, 'rtkm', rtkm, 'gross', gross,
                                          'penalty', penalty, 'tds', tds, 'received', received))
           ORDER BY first_date, branch_name), '[]'::jsonb)
    FROM blocks
$$;

CREATE OR REPLACE FUNCTION customer_bill_refresh(p_bill uuid) RETURNS void AS $$
DECLARE
  b record; x record; c record;
  adj_in numeric; adj_ex numeric; v_tds numeric; v_status text;
BEGIN
  SELECT * INTO b FROM customer_bills WHERE id = p_bill;
  IF b.id IS NULL OR b.status = 'CANCELLED' THEN RETURN; END IF;
  SELECT * INTO c FROM customers WHERE id = b.customer_id;

  SELECT count(*)::int AS trips,
         count(DISTINCT COALESCE(r.branch_key, '(BRANCH NOT RECORDED)'))::int AS branches,
         COALESCE(sum(r.loaded_qty), 0)::numeric(14,3) AS qty,
         COALESCE(sum(r.rtkm), 0)::numeric(14,2) AS rtkm,
         COALESCE(sum(r.gross), 0)::numeric(14,2) AS gross,
         COALESCE(sum(r.penalty), 0)::numeric(14,2) AS penalty,
         COALESCE(sum(r.tds), 0)::numeric(14,2) AS tds_actual,
         COALESCE(sum(r.received), 0)::numeric(14,2) AS received,
         count(*) FILTER (WHERE r.flag = 'PAID')::int AS paid_count,
         count(*) FILTER (WHERE r.flag = 'SHORT')::int AS short_count,
         count(*) FILTER (WHERE r.flag = 'MISSING')::int AS missing_count,
         count(*) FILTER (WHERE r.flag = 'PENDING')::int AS pending_count,
         count(*) FILTER (WHERE r.flag = 'UNPRICED')::int AS unpriced_count,
         COALESCE(sum(r.gross - r.penalty - r.received) FILTER (WHERE r.flag = 'SHORT'), 0)::numeric(14,2) AS short_amount,
         COALESCE(sum(r.gross) FILTER (WHERE r.flag = 'MISSING'), 0)::numeric(14,2) AS missing_amount,
         COALESCE(sum(r.gross) FILTER (WHERE r.flag = 'PENDING'), 0)::numeric(14,2) AS pending_amount,
         COALESCE(sum(r.gross) FILTER (WHERE r.linked_bill_id IS NOT NULL), 0)::numeric(14,2) AS legacy_posted,
         COALESCE(sum(r.gross) FILTER (WHERE r.linked_bill_id IS NULL), 0)::numeric(14,2) AS to_post,
         max(r.operating_company) AS operating_company
    INTO x
    FROM v_customer_trip_recon r
   WHERE r.customer_bill_id = p_bill;

  adj_in := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a WHERE a->>'side' = 'INCOME'), 0);
  adj_ex := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a WHERE a->>'side' = 'EXPENSE'), 0);
  v_tds := CASE WHEN x.tds_actual > 0 THEN x.tds_actual
                ELSE round(x.gross * COALESCE(c.tds_pct_deducted, 0) / 100.0, 2) END;

  v_status := b.status;
  IF b.locked_at IS NOT NULL AND b.status IN ('RAISED','PART_PAID','PAID') THEN
    v_status := CASE WHEN b.gross > 0 AND b.gross + adj_in - adj_ex - b.shortage_penalty - x.received <= 2 AND x.missing_count = 0 THEN 'PAID'
                     WHEN x.received > 0 THEN 'PART_PAID'
                     ELSE 'RAISED' END;
  END IF;

  IF b.locked_at IS NULL THEN
    UPDATE customer_bills
       SET customer_name = COALESCE(c.customer_name, customer_name),
           customer_type = c.customer_type, print_format = c.print_format,
           operating_company = COALESCE(x.operating_company, operating_company),
           trips = x.trips, branches = x.branches, loaded_qty = x.qty, rtkm = x.rtkm,
           gross = x.gross, shortage_penalty = x.penalty,
           tds_pct = c.tds_pct_deducted, tds = v_tds,
           gst_pct = c.gst_pct, gst_mode = c.gst_mode,
           gst_memo = round(x.gross * COALESCE(c.gst_pct, 0) / 100.0, 2),
           net_receivable = round(x.gross + adj_in - adj_ex - x.penalty - v_tds, 2),
           received = x.received,
           balance = round(x.gross + adj_in - adj_ex - x.penalty - x.received, 2),
           paid_count = x.paid_count, short_count = x.short_count, missing_count = x.missing_count,
           pending_count = x.pending_count, unpriced_count = x.unpriced_count, unpriced_trips = x.unpriced_count,
           short_amount = x.short_amount, missing_amount = x.missing_amount, pending_amount = x.pending_amount,
           revenue_posted_legacy = x.legacy_posted, revenue_to_post = x.to_post,
           lines = customer_bill_lines(p_bill),
           updated_at = now()
     WHERE id = p_bill;
  ELSE
    -- Raised: the bill's numbers are what was signed; only the money that
    -- arrived and the reconciliation counts move. The trips are its own.
    UPDATE customer_bills
       SET received = x.received,
           balance = round(gross + adj_income_of(adjustments) - adj_expense_of(adjustments) - shortage_penalty - x.received, 2),
           paid_count = x.paid_count, short_count = x.short_count, missing_count = x.missing_count,
           pending_count = x.pending_count,
           short_amount = x.short_amount, missing_amount = x.missing_amount, pending_amount = x.pending_amount,
           lines = customer_bill_lines(p_bill),
           status = CASE WHEN status = 'DISPUTED' THEN 'DISPUTED' ELSE v_status END,
           updated_at = now()
     WHERE id = p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The lock keeps the SIGNED numbers (gross, penalty, TDS, net, adjustments,
-- posted lines, revenue to post). The trip lines are derived — their flags
-- and received amounts move with the advices — so they are no longer frozen.
CREATE OR REPLACE FUNCTION cb_lock_guard() RETURNS trigger AS $$
DECLARE money_same boolean;
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;
  money_same := NEW.gross = OLD.gross AND NEW.shortage_penalty = OLD.shortage_penalty
     AND NEW.tds = OLD.tds AND NEW.net_receivable = OLD.net_receivable
     AND NEW.adjustments = OLD.adjustments
     AND NEW.posted_lines = OLD.posted_lines
     AND NEW.revenue_to_post = OLD.revenue_to_post;
  IF NEW.locked_at IS NULL AND NEW.status = 'STAFF_REVIEWED'
     AND NEW.reopen_reason IS NOT NULL AND btrim(NEW.reopen_reason) <> ''
     AND money_same THEN RETURN NEW; END IF;
  IF NEW.locked_at IS NOT NULL AND money_same
     AND NEW.status IN ('RAISED','PART_PAID','PAID','DISPUTED','CANCELLED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION
    'Bill % (%, % to %) is raised and locked. Use Modify with a reason first.',
    OLD.bill_no, OLD.customer_name, OLD.period_from, OLD.period_to
    USING ERRCODE = 'P0415';
END;
$$ LANGUAGE plpgsql;

-- ═══ 4. THE BOOKS SPEAK ENGLISH ═══════════════════════════════════════════
-- Labels and messages were written into function bodies and view texts by
-- 160–163. Rewrite those objects in place: same names, same columns, only
-- the words change (every '%' placeholder is kept, count for count).
DO $$
DECLARE
  pairs text[][] := ARRAY[
    ['Bill % (%): % lorry ka commission rate darj nahi hai — approve nahi ho sakta.',
     'Bill % (%): commission rate not recorded for % lorry — cannot approve.'],
    ['Bill % (%): rate darj nahi hai (%s) — approve nahi ho sakta.',
     'Bill % (%): rate not recorded (%s) — cannot approve.'],
    ['Bill % (%): % trip ka rate/qty nahi — pehle price kijiye, tab raise hoga.',
     'Bill % (%): % trip(s) have no rate or quantity — price them first, then raise.'],
    ['(owner darj nahi)', '(owner not recorded)'],
    ['(branch darj nahi)', '(Branch not recorded)'],
    ['(BRANCH DARJ NAHI)', '(BRANCH NOT RECORDED)'],
    ['% : ATTACHED gaadi ka malik (owner name) likhna zaroori hai — 15-din ka bill usi ke naam banta hai',
     '% : an ATTACHED vehicle needs an owner name — its 15-day bill is raised in that name'],
    ['% : malik aur operating company ek hi hain (%) — yeh OWN gaadi hai, Attached nahi',
     '% : owner and operating company are the same (%) — this is an OWN vehicle, not Attached'],
    ['% : OWN gaadi ka malik company hi hota hai (%), "%" nahi — Attached chuniye ya malik company rakhiye',
     '% : an OWN vehicle is owned by the company itself (%), not "%" — choose Attached or set the owner to the company'],
    ['OWN likha hai par malik "%s" hai aur books "%s" — Own hai ya Attached? (Attached ho to commission/TDS ka bill banega)',
     'Marked OWN but the owner is "%s" and the books are "%s" — Own or Attached? (Attached means a commission/TDS bill)'],
    ['ATTACHED likha hai par malik aur books dono "%s" — yeh Own gaadi hai',
     'Marked ATTACHED but owner and books are both "%s" — this is an Own vehicle'],
    ['Attached hai par Commission Master me rate nahi — 15-din ka bill approve nahi hoga (rate 1 Apr 2026 se bhariye)',
     'Attached but no rate in the Commission Master — the 15-day bill cannot be approved (enter a rate effective 1 Apr 2026)'],
    ['Operating company darj nahi — kis firm ki books me chalti hai?',
     'Operating company not recorded — which firm are its books in?'],
    ['%s trip "%s" ki books me chale (₹%s), master me "%s" — kis company ki gaadi hai?',
     '%s trip(s) ran in the books of "%s" (₹%s) while the master says "%s" — which company owns this vehicle?'],
    ['Is number par trip hain par vehicle master me yeh gaadi nahi — Vehicle master me jodiye',
     'Trips exist for this number but the vehicle is not in the Vehicle master — add it there'],
    ['%s trip par customer nahi (%s se %s) — bill nahi ban sakta',
     '%s trip(s) have no customer (%s to %s) — no bill can be drafted'],
    ['"%s" kisi customer se juda nahi — %s trip',
     '"%s" is not linked to any customer — %s trip(s)'],
    ['branch "%s" trip se seekhi — confirm kijiye',
     'branch "%s" was learned from trips — please confirm'],
    ['%s trip par unloading location khaali — bill me "(branch darj nahi)" me jaayenge',
     '%s trip(s) have a blank unloading location — they fall under "(Branch not recorded)" on the bill'],
    ['%s trip bina rate/amount ke — bill raise nahi hoga',
     '%s trip(s) without a rate or amount — the bill cannot be raised'],
    ['customer ka prakaar (Oil Company / Contract / Market) tay nahi',
     'customer type (Oil Company / Contract / Market) not set'],
    [' · mahina', ' · Monthly']
  ];
  r record; def text; i int; changed boolean;
BEGIN
  -- functions (incl. trigger functions)
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND (p.prosrc LIKE '%darj nahi%' OR p.prosrc LIKE '%nahi ho sakta%' OR p.prosrc LIKE '%kijiye%'
            OR p.prosrc LIKE '%chuniye%' OR p.prosrc LIKE '%jodiye%' OR p.prosrc LIKE '%gaadi%' OR p.prosrc LIKE '%malik%'
            OR p.prosrc LIKE '%DARJ NAHI%')
  LOOP
    def := pg_get_functiondef(r.oid); changed := false;
    FOR i IN 1..array_length(pairs, 1) LOOP
      IF position(pairs[i][1] IN def) > 0 THEN def := replace(def, pairs[i][1], pairs[i][2]); changed := true; END IF;
    END LOOP;
    IF changed THEN EXECUTE def; RAISE NOTICE '166: % now reads in English', r.proname; END IF;
  END LOOP;
  -- views
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND (pg_get_viewdef(c.oid) LIKE '%darj nahi%' OR pg_get_viewdef(c.oid) LIKE '%kijiye%' OR pg_get_viewdef(c.oid) LIKE '%chuniye%'
            OR pg_get_viewdef(c.oid) LIKE '%jodiye%' OR pg_get_viewdef(c.oid) LIKE '%gaadi%' OR pg_get_viewdef(c.oid) LIKE '%malik%'
            OR pg_get_viewdef(c.oid) LIKE '%mahina%' OR pg_get_viewdef(c.oid) LIKE '%nahi%' OR pg_get_viewdef(c.oid) LIKE '%DARJ NAHI%')
  LOOP
    def := pg_get_viewdef(r.oid); changed := false;
    FOR i IN 1..array_length(pairs, 1) LOOP
      IF position(pairs[i][1] IN def) > 0 THEN def := replace(def, pairs[i][1], pairs[i][2]); changed := true; END IF;
    END LOOP;
    IF changed THEN EXECUTE 'CREATE OR REPLACE VIEW public.' || quote_ident(r.relname) || ' AS ' || def; RAISE NOTICE '166: view % now reads in English', r.relname; END IF;
  END LOOP;
END $$;

-- ═══ 5. THE MAPPING DESK ALSO LISTS THE TRIP THAT IS NOT UNLOADED YET ═════
CREATE OR REPLACE VIEW v_customer_mapping_audit AS
SELECT 'NO_CUSTOMER'::text AS finding, 'HIGH'::text AS severity,
       COALESCE(btrim(t.operating_company), '(no company)') AS subject,
       count(*)::int AS trips, COALESCE(sum(t.billed_amount), 0)::numeric(14,2) AS amount,
       format('%s trip(s) have no customer (%s to %s) — no bill can be drafted', count(*), min(t.loading_date), max(t.loading_date)) AS detail
  FROM trips t WHERE t.status = 'COMPLETED' AND (t.customer_name IS NULL OR btrim(t.customer_name) = '')
 GROUP BY 3
UNION ALL
SELECT 'UNKNOWN_NAME', 'HIGH', btrim(t.customer_name), count(*)::int, COALESCE(sum(t.billed_amount), 0)::numeric(14,2),
       format('"%s" is not linked to any customer — %s trip(s)', btrim(t.customer_name), count(*))
  FROM trips t WHERE t.status = 'COMPLETED' AND t.customer_name IS NOT NULL AND btrim(t.customer_name) <> ''
   AND customer_of(t.customer_name) IS NULL
 GROUP BY 3
UNION ALL
SELECT 'BRANCH_UNCONFIRMED', 'LOW', c.customer_name || ' · ' || cb.branch_name,
       (SELECT count(*)::int FROM trips t WHERE customer_of(t.customer_name) = cb.customer_id AND branch_key(t.unloading_location) = cb.branch_key),
       0::numeric(14,2),
       format('branch "%s" was learned from trips — please confirm', cb.branch_name)
  FROM customer_branches cb JOIN customers c ON c.id = cb.customer_id
 WHERE cb.source = 'LEARNED'
UNION ALL
SELECT 'NO_BRANCH', 'MEDIUM', c.customer_name, count(*)::int, COALESCE(sum(t.billed_amount), 0)::numeric(14,2),
       format('%s trip(s) have a blank unloading location — they fall under "(Branch not recorded)" on the bill', count(*))
  FROM trips t JOIN customers c ON c.id = customer_of(t.customer_name)
 WHERE t.status = 'COMPLETED' AND (t.unloading_location IS NULL OR btrim(t.unloading_location) = '')
 GROUP BY 3
UNION ALL
SELECT 'UNPRICED', 'HIGH', c.customer_name, count(*)::int, 0::numeric(14,2),
       format('%s trip(s) without a rate or amount — the bill cannot be raised', count(*))
  FROM trips t JOIN customers c ON c.id = customer_of(t.customer_name)
 WHERE t.status = 'COMPLETED' AND COALESCE(t.billed_amount, 0) <= 0
   AND NOT (c.contract_rate_per_kl IS NOT NULL AND COALESCE(t.loaded_qty, 0) > 0)
 GROUP BY 3
UNION ALL
SELECT 'NOT_UNLOADED', 'MEDIUM', COALESCE(c.customer_name, '(no customer)'), count(*)::int, COALESCE(sum(t.billed_amount), 0)::numeric(14,2),
       format('%s completed trip(s) have no unloading date — they join the 15-day cycle they are unloaded in', count(*))
  FROM trips t LEFT JOIN customers c ON c.id = customer_of(t.customer_name)
 WHERE t.status = 'COMPLETED' AND t.unloading_date IS NULL
 GROUP BY 3
UNION ALL
SELECT 'NO_TYPE', 'MEDIUM', c.customer_name, 0, 0::numeric(14,2),
       'customer type (Oil Company / Contract / Market) not set'
  FROM customers c WHERE c.status = 'ACTIVE' AND c.customer_type IS NULL;

-- ═══ 6. WHAT THE AGENT MAY RAISE ON ITS OWN ═══════════════════════════════
-- A draft is clean when the period is over, every trip is priced and on the
-- customer's own document (for an oil company), nothing is missing, short or
-- unmatched, and no dispute is open. The agent raises these; every other
-- draft waits for a person — that is the desk's whole list.
CREATE OR REPLACE VIEW v_customer_bills_autoraise AS
SELECT b.id, b.bill_no, b.customer_name, b.company_name, b.cycle_label, b.trips, b.gross, b.revenue_to_post
  FROM v_customer_bill b
 WHERE b.locked_at IS NULL
   AND b.status IN ('AI_DRAFT', 'STAFF_REVIEWED')
   AND b.period_to < current_date
   AND b.company_id IS NOT NULL
   AND b.trips > 0
   AND b.unpriced_count = 0 AND b.missing_count = 0 AND b.short_count = 0
   AND COALESCE(b.their_unmatched, 0) = 0
   AND (b.customer_type <> 'OIL_COMPANY'
        OR NOT EXISTS (SELECT 1 FROM v_customer_trip_recon r
                        WHERE r.customer_bill_id = b.id AND r.iocl_bill_no IS NULL AND r.match_status IS DISTINCT FROM 'MATCHED'));

COMMENT ON VIEW v_customer_bills_autoraise IS
  'Drafts with nothing left for a person to decide: period over, all trips priced and on the customer''s document, no missing/short/unmatched lines. TARA raises these; the rest is the desk''s list.';

-- ═══ 7. EVERY BILL RE-READS ITS OWN TRIPS ═════════════════════════════════
-- Open drafts: re-assign under the unloading rule, then foot.
UPDATE trips t
   SET customer_bill_id = NULL
  FROM customer_bills b
 WHERE t.customer_bill_id = b.id AND b.locked_at IS NULL;
SELECT customer_bill_refresh(id) FROM customer_bills WHERE status <> 'CANCELLED';
