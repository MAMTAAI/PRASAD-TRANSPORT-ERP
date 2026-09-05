-- ═══════════════════════════════════════════════════════════════════════════
-- 162 — The MARKET (fleet partner) 15-day bill, in the same cycle and screen
--
-- Owner, 5-Sep-2026: "market vehicle (fleet partner) ka bhi auto-generate ho
-- 15 days par bill … ek jagah ho sake … par yeh alag model hai … naya column
-- banega." Design v1 approved the same morning.
--
-- ── WHY IT IS A DIFFERENT MODEL ───────────────────────────────────────────
--
-- An own or attached lorry runs OUR trips; we book its diesel, toll and
-- advances and (for attached) take them back on the bill. A fleet partner
-- runs HIS truck on a load we sold: he bears diesel, toll and driver; we owe
-- him the awarded freight, we bill the customer ours, and the spread is the
-- margin — which is never a third ledger entry (migration 144). So his bill
-- has no expense columns. It has, per load: what the customer pays us, what
-- we owe him, the advance already given at loading, TDS 194C, and the balance.
--
-- ── WHAT THE AUDIT FOUND (production, 5-Sep) ──────────────────────────────
--
--   · 2 loads, 0 bids, 0 settlements, 0 market trucks, 0 fleet partners, 0
--     market vouchers. The model has never carried a rupee.
--   · No TDS anywhere in the bazaar flow: BZADV and BZBAL post gross.
--     server/lib/taxEngine.js knows 194C; nothing calls it.
--   · A TDS leg could not be posted at all: migration 129's segment guard
--     lets a BAZAAR_* voucher touch only 'Market Fleet %' groups or bank /
--     cash, and TDS Payable lives under Duties & Taxes → FLEET_CROSSOVER.
--   · vendors has pan_no but no entity type and no 194C(6) declaration, so
--     the rate (1% / 2% / 20% / NIL) cannot be known per partner.
--
-- ── THE RULES THIS MIGRATION FIXES ────────────────────────────────────────
--
--   1. One bill per FLEET_PARTNER per fortnight; a load belongs to the
--      fortnight its POD was VERIFIED in (delivery proven), never award.
--   2. TDS is on the WHOLE partner freight, once, on the bill (the advance
--      went out gross). Rate from the partner master; unknown = NULL, never
--      0, and the bill cannot be approved (P0412, same as a missing
--      commission rate).
--   3. The TDS journal lives inside the market segment: a new group 'Market
--      Fleet Duties & Taxes' and ledger 'Market Fleet TDS Payable 194C'.
--   4. Approve = TDS journal + lock. Payment is a SEPARATE act: one PAYMENT
--      voucher for the bill's balance, which marks every load SETTLED.
--   5. Same table (vehicle_owner_bills, class_key MARKET), same list, same
--      1st/16th build — TARA drafts all three kinds in one pass.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. A HOME FOR TDS INSIDE THE MARKET SEGMENT ══════════════════════════
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Market Fleet Duties & Taxes', 'LIABILITY', 'BALANCE_SHEET', 'CR', 486, true
 WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = 'Market Fleet Duties & Taxes');

INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, current_balance, creation_type, status)
SELECT 'Market Fleet TDS Payable 194C', 'Market Fleet Duties & Taxes', 'CR', 0, 0, 'SYSTEM', 'ACTIVE'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = 'Market Fleet TDS Payable 194C');

-- ═══ 2. WHO THE PARTNER IS, FOR TDS ═══════════════════════════════════════
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS entity_type text
    CHECK (entity_type IS NULL OR entity_type IN ('INDIVIDUAL', 'FIRM')),
  ADD COLUMN IF NOT EXISTS tds_declaration_194c boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN vendors.entity_type IS
  'INDIVIDUAL (1% u/s 194C) or FIRM (2%). NULL = not recorded — the partner bill then shows "rate nahi" and cannot be approved.';
COMMENT ON COLUMN vendors.tds_declaration_194c IS
  '194C(6): transporter owning ≤10 carriages with PAN who furnished the declaration — NO TDS.';

-- The rate, from the master, exactly as server/lib/taxEngine.js states it.
-- NULL when the master cannot say; 0 is a claim only the declaration makes.
CREATE OR REPLACE FUNCTION vendor_tds_pct(p_vendor uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN v.id IS NULL THEN NULL
           WHEN v.tds_declaration_194c THEN 0
           WHEN v.pan_no IS NULL OR btrim(v.pan_no) = '' THEN 20
           WHEN v.entity_type = 'INDIVIDUAL' THEN 1
           WHEN v.entity_type = 'FIRM' THEN 2
           ELSE NULL END::numeric
    FROM vendors v WHERE v.id = p_vendor
$$;

-- ═══ 3. THE BILL TABLE GROWS THE MARKET COLUMNS ═══════════════════════════
ALTER TABLE vehicle_owner_bills
  ADD COLUMN IF NOT EXISTS vendor_id        uuid REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS loads            int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trucks           int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS partner_freight  numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS margin           numeric(14,2),
  ADD COLUMN IF NOT EXISTS advances_paid    numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tds_pct          numeric(6,3),
  ADD COLUMN IF NOT EXISTS lines            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS adjustments      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pay_voucher_id   uuid,
  ADD COLUMN IF NOT EXISTS paid_amount      numeric(14,2),
  ADD COLUMN IF NOT EXISTS paid_at          timestamptz,
  ADD COLUMN IF NOT EXISTS paid_by          text;

CREATE INDEX IF NOT EXISTS vob_vendor_idx ON vehicle_owner_bills (vendor_id, period_from DESC)
  WHERE vendor_id IS NOT NULL;

-- b.* grew in the middle of the view's column list, so it is re-created.
DROP VIEW IF EXISTS v_vehicle_owner_bill;
CREATE VIEW v_vehicle_owner_bill AS
SELECT b.*,
       fortnight_label(b.period_from)                    AS cycle_label,
       (b.locked_at IS NOT NULL)                         AS locked,
       co.company_name,
       CASE WHEN b.class_key = 'MARKET'
            THEN b.margin
            ELSE (b.freight + b.adj_income - b.deductions) END::numeric(14,2) AS net
  FROM vehicle_owner_bills b
  LEFT JOIN companies co ON co.id = b.company_id;

-- ── the lock learns the one thing a locked bill may still record: payment ─
CREATE OR REPLACE FUNCTION vob_lock_guard() RETURNS trigger AS $$
DECLARE money_same boolean;
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;

  money_same := NEW.freight = OLD.freight AND NEW.deductions = OLD.deductions
     AND NEW.commission IS NOT DISTINCT FROM OLD.commission
     AND NEW.tds IS NOT DISTINCT FROM OLD.tds
     AND NEW.payable IS NOT DISTINCT FROM OLD.payable
     AND NEW.adj_income = OLD.adj_income AND NEW.adj_expense = OLD.adj_expense
     AND NEW.posted_lines = OLD.posted_lines
     AND NEW.partner_freight = OLD.partner_freight
     AND NEW.advances_paid = OLD.advances_paid
     AND NEW.lines = OLD.lines;

  -- A reasoned reopen.
  IF NEW.locked_at IS NULL AND NEW.status = 'STAFF_REVIEWED'
     AND NEW.reopen_reason IS NOT NULL AND btrim(NEW.reopen_reason) <> ''
     AND money_same THEN
    RETURN NEW;
  END IF;
  -- The balance paid on an approved bill (pay_* columns, a note): the
  -- numbers signed stay exactly what they were.
  IF NEW.locked_at IS NOT NULL AND NEW.status = OLD.status AND money_same THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Bill % (%, % to %) is approved and locked. Use Modify with a reason first.',
    OLD.bill_no, OLD.owner_name, OLD.period_from, OLD.period_to
    USING ERRCODE = 'P0411';
END;
$$ LANGUAGE plpgsql;

-- The gate now speaks for both kinds of missing rate.
CREATE OR REPLACE FUNCTION vob_rate_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'APPROVED' AND NEW.needs_rate > 0 THEN
    RAISE EXCEPTION
      'Bill % (%): rate darj nahi hai (%s) — approve nahi ho sakta.',
      NEW.bill_no, NEW.owner_name,
      CASE WHEN NEW.class_key = 'MARKET' THEN 'partner ka TDS: individual/firm ya 194C(6)'
           ELSE NEW.needs_rate || ' lorry ka commission' END
      USING ERRCODE = 'P0412';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══ 4. A PARTNER'S FORTNIGHT — loads whose POD was verified in it ═════════
CREATE OR REPLACE VIEW v_market_partner_fortnight AS
SELECT s.vendor_id,
       COALESCE(v.vendor_name, b.vendor_name)                 AS vendor_name,
       fortnight_from(s.pod_verified_at::date)                AS period_from,
       fortnight_to(s.pod_verified_at::date)                  AS period_to,
       fortnight_code(s.pod_verified_at::date)                AS cycle,
       max(s.company_id::text)::uuid                          AS company_id,
       count(*)::int                                          AS loads,
       count(DISTINCT s.market_vehicle_id)::int               AS trucks,
       COALESCE(sum(s.customer_rate), 0)::numeric(14,2)       AS customer_freight,
       COALESCE(sum(s.awarded_amount), 0)::numeric(14,2)      AS partner_freight,
       -- The margin is known only when every load has a customer rate; a
       -- partial sum would be a number that looks whole.
       CASE WHEN bool_and(s.customer_rate IS NOT NULL)
            THEN sum(s.customer_rate - s.awarded_amount) END::numeric(14,2) AS margin,
       COALESCE(sum(s.advance_amount), 0)::numeric(14,2)      AS advances_paid
  FROM bazaar_settlements s
  JOIN bazaar_bids b ON b.id = s.bid_id
  LEFT JOIN vendors v ON v.id = s.vendor_id
 WHERE s.vendor_id IS NOT NULL
   AND s.pod_verified_at IS NOT NULL
   AND s.status IN ('POD_VERIFIED', 'SETTLED')
 GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW v_market_partner_fortnight IS
  'One row per fleet partner per fortnight over the loads whose POD was '
  'verified in it: what the customer pays, what we owe the partner, the '
  'margin, and the advances already out.';

-- ═══ 5. THE LOADS, AS THE BILL PRINTS THEM — under their truck ════════════
CREATE OR REPLACE FUNCTION market_partner_bill_lines(p_vendor uuid, p_from date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'settlement_id', s.id, 'load_id', s.load_id, 'status', s.status,
           'pod_date', s.pod_verified_at::date,
           'origin', l.origin, 'destination', l.destination, 'distance_km', l.distance_km,
           'customer', l.customer_name, 'material', l.material, 'weight', l.weight,
           'load_kind', l.load_kind,
           'truck', mv.registration_no, 'driver', COALESCE(md.name, mv.driver_name),
           'customer_rate', s.customer_rate, 'partner_rate', s.awarded_amount,
           'margin', s.customer_rate - s.awarded_amount,
           'advance', COALESCE(s.advance_amount, 0),
           'advance_date', (SELECT min(e.entry_date) FROM ledger_entries e WHERE e.voucher_id = s.advance_voucher_id),
           'lock_posted', s.lock_voucher_id IS NOT NULL,
           'income_posted', s.income_voucher_id IS NOT NULL,
           'balance_voucher_id', s.balance_voucher_id, 'balance_amount', s.balance_amount)
           ORDER BY mv.registration_no NULLS LAST, s.pod_verified_at), '[]'::jsonb)
    FROM bazaar_settlements s
    JOIN bazaar_loads l ON l.load_id = s.load_id
    LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
    LEFT JOIN market_drivers md ON md.id = s.market_driver_id
   WHERE s.vendor_id = p_vendor
     AND s.pod_verified_at IS NOT NULL
     AND s.status IN ('POD_VERIFIED', 'SETTLED')
     AND fortnight_from(s.pod_verified_at::date) = p_from
$$;

-- ═══ 6. THE PARTNER BILL'S FOOT ═══════════════════════════════════════════
--
--   partner freight − advances already paid − TDS ± manual = balance to pay
--   our earning = margin (customer − partner), never posted again
CREATE OR REPLACE FUNCTION market_partner_bill_refresh(p_bill uuid) RETURNS void AS $$
DECLARE
  b       record;
  f       record;
  v_pct   numeric;
  v_tds   numeric;
  adj_in  numeric;
  adj_ex  numeric;
BEGIN
  SELECT * INTO b FROM vehicle_owner_bills
   WHERE id = p_bill AND class_key = 'MARKET' AND locked_at IS NULL;
  IF b.id IS NULL THEN RETURN; END IF;

  SELECT * INTO f FROM v_market_partner_fortnight
   WHERE vendor_id = b.vendor_id AND period_from = b.period_from;

  v_pct  := vendor_tds_pct(b.vendor_id);
  adj_in := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a
                       WHERE a->>'side' = 'INCOME'), 0);
  adj_ex := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a
                       WHERE a->>'side' = 'EXPENSE'), 0);
  v_tds  := CASE WHEN v_pct IS NULL THEN NULL
                 ELSE round(COALESCE(f.partner_freight, 0) * v_pct / 100.0, 2) END;

  UPDATE vehicle_owner_bills
     SET owner_name      = COALESCE(f.vendor_name, owner_name),
         company_id      = COALESCE(f.company_id, company_id),
         loads           = COALESCE(f.loads, 0),
         trucks          = COALESCE(f.trucks, 0),
         lorries         = COALESCE(f.trucks, 0),
         trips           = COALESCE(f.loads, 0),
         freight         = COALESCE(f.customer_freight, 0),
         partner_freight = COALESCE(f.partner_freight, 0),
         margin          = f.margin,
         advances_paid   = COALESCE(f.advances_paid, 0),
         tds_pct         = v_pct,
         tds             = v_tds,
         commission      = NULL,
         recovered       = NULL,
         adj_income      = adj_in,
         adj_expense     = adj_ex,
         deductions      = COALESCE(f.advances_paid, 0) + COALESCE(v_tds, 0) + adj_ex,
         needs_rate      = CASE WHEN v_pct IS NULL THEN 1 ELSE 0 END,
         payable         = CASE WHEN v_pct IS NULL THEN NULL
                                ELSE round(COALESCE(f.partner_freight, 0) - COALESCE(f.advances_paid, 0)
                                           - v_tds + adj_in - adj_ex, 2) END,
         our_earning     = f.margin,
         lines           = market_partner_bill_lines(b.vendor_id, b.period_from),
         updated_at      = now()
   WHERE id = p_bill;
END;
$$ LANGUAGE plpgsql;

-- ═══ 7. ONE REFRESH ENTRY POINT — routes by kind ══════════════════════════
CREATE OR REPLACE FUNCTION vehicle_owner_bill_refresh(p_bill uuid) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM vehicle_owner_bills WHERE id = p_bill AND class_key = 'MARKET') THEN
    PERFORM market_partner_bill_refresh(p_bill);
    RETURN;
  END IF;

  UPDATE vehicle_owner_bills b
     SET lorries = x.lorries, trips = x.trips, loaded_qty = x.loaded_qty, rtkm = x.rtkm,
         freight = x.freight, received = x.received, penalty = x.penalty,
         hsd = x.hsd, toll = x.toll, fooding = x.fooding, fixed_allowance = x.fixed_allowance,
         advances = x.advances, doc_expense = x.doc_expense, other_expense = x.other_expense,
         expense_total = x.expense_total, adj_income = x.adj_income, adj_expense = x.adj_expense,
         deductions = x.deductions,
         commission = x.commission, tds = x.tds, recovered = x.recovered,
         needs_rate = x.needs_rate,
         payable = CASE WHEN b.class_key IN ('ATTACHED','MARKET') AND x.needs_rate = 0
                        THEN round(x.freight + x.adj_income - COALESCE(x.commission, 0)
                                   - COALESCE(x.tds, 0) - COALESCE(x.recovered, 0) - x.adj_expense, 2)
                        ELSE NULL END,
         our_earning = CASE WHEN b.class_key IN ('ATTACHED','MARKET')
                            THEN CASE WHEN x.needs_rate = 0 THEN x.commission ELSE NULL END
                            ELSE round(x.freight + x.adj_income - x.expense_total - x.adj_expense, 2) END,
         updated_at = now()
    FROM (
      SELECT count(*)::int                                  AS lorries,
             COALESCE(sum(v.trips_count), 0)::int           AS trips,
             COALESCE(sum(v.loaded_qty), 0)::numeric(14,3)  AS loaded_qty,
             COALESCE(sum(v.rtkm), 0)::numeric(14,2)        AS rtkm,
             COALESCE(sum(v.billed_amount), 0)::numeric(14,2)   AS freight,
             COALESCE(sum(v.received_amount), 0)::numeric(14,2) AS received,
             COALESCE(sum(v.shortage_penalty), 0)::numeric(14,2) AS penalty,
             COALESCE(sum(v.hsd), 0)::numeric(14,2)         AS hsd,
             COALESCE(sum(v.toll), 0)::numeric(14,2)        AS toll,
             COALESCE(sum(v.fooding), 0)::numeric(14,2)     AS fooding,
             COALESCE(sum(v.fixed_allowance), 0)::numeric(14,2) AS fixed_allowance,
             COALESCE(sum(v.advances), 0)::numeric(14,2)    AS advances,
             COALESCE(sum(v.doc_expense), 0)::numeric(14,2) AS doc_expense,
             COALESCE(sum(v.tyre + v.maintenance + v.other_expense), 0)::numeric(14,2) AS other_expense,
             COALESCE(sum(v.bucket_expense), 0)::numeric(14,2) AS expense_total,
             COALESCE(sum(v.adj_income), 0)::numeric(14,2)  AS adj_income,
             COALESCE(sum(v.adj_expense), 0)::numeric(14,2) AS adj_expense,
             COALESCE(sum(v.bill_expense), 0)::numeric(14,2) AS deductions,
             sum(v.commission_amount)::numeric(14,2)        AS commission,
             sum(v.tds_amount)::numeric(14,2)               AS tds,
             sum(v.expenses_recovered)::numeric(14,2)       AS recovered,
             count(*) FILTER (WHERE v.needs_rate)::int      AS needs_rate
        FROM v_vehicle_settlement v
       WHERE v.owner_bill_id = p_bill
    ) x
   WHERE b.id = p_bill AND b.locked_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ═══ 8. BUILD THE PARTNER BILLS FOR A FORTNIGHT ═══════════════════════════
CREATE OR REPLACE FUNCTION market_bill_no(p_vendor text, p_from date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  -- MB-AR-JUN-H2-2026: the same shape as the lorry bills, M for market.
  SELECT 'MB-' || substr(owner_bill_no(p_vendor, 'ATTACHED', p_from), 4)
$$;

CREATE OR REPLACE FUNCTION market_partner_bills_build(p_from date, p_by text DEFAULT 'system')
RETURNS TABLE (created int, refreshed int, skipped int) AS $$
DECLARE
  v_from date := fortnight_from(p_from);
  v_to   date := fortnight_to(p_from);
  g      record;
  v_id   uuid; v_locked timestamptz; v_no text; v_base text; n int;
  v_created int := 0; v_refreshed int := 0; v_skipped int := 0;
BEGIN
  FOR g IN SELECT * FROM v_market_partner_fortnight WHERE period_from = v_from LOOP
    SELECT b.id, b.locked_at INTO v_id, v_locked
      FROM vehicle_owner_bills b
     WHERE b.class_key = 'MARKET' AND b.vendor_id = g.vendor_id AND b.period_from = v_from;

    IF v_id IS NULL THEN
      v_base := market_bill_no(g.vendor_name, v_from);
      v_no := v_base; n := 1;
      WHILE EXISTS (SELECT 1 FROM vehicle_owner_bills WHERE bill_no = v_no) LOOP
        n := n + 1; v_no := v_base || '-' || n;
      END LOOP;
      INSERT INTO vehicle_owner_bills
        (bill_no, owner_key, owner_name, fleet_class, class_key, vendor_id, company_id,
         period_from, period_to, cycle, status, created_by)
      VALUES (v_no, 'V:' || g.vendor_id::text, g.vendor_name, 'MARKET', 'MARKET', g.vendor_id,
              g.company_id, v_from, v_to, fortnight_code(v_from), 'AI_DRAFT', p_by)
      RETURNING id INTO v_id;
      v_created := v_created + 1;
    ELSIF v_locked IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    ELSE
      v_refreshed := v_refreshed + 1;
    END IF;
    PERFORM market_partner_bill_refresh(v_id);
  END LOOP;

  -- A partner whose loads all left this fortnight (POD date corrected): the
  -- empty draft goes. A locked bill stays.
  DELETE FROM vehicle_owner_bills b
   WHERE b.class_key = 'MARKET' AND b.period_from = v_from AND b.locked_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM v_market_partner_fortnight f
                      WHERE f.vendor_id = b.vendor_id AND f.period_from = v_from);

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- ═══ 9. THE LORRY-BILL BUILDER MUST NOT SWEEP MARKET BILLS AWAY ═══════════
-- Migration 160's clean-up deleted any unlocked bill with no lorry settlement
-- under it — which is every market bill. Re-stated with the kind respected.
CREATE OR REPLACE FUNCTION vehicle_owner_bills_build(p_from date, p_by text DEFAULT 'system')
RETURNS TABLE (created int, refreshed int, skipped int) AS $$
DECLARE
  v_from date := fortnight_from(p_from);
  v_to   date := fortnight_to(p_from);
  g      record;
  v_id   uuid; v_locked timestamptz; v_no text; v_base text; n int;
  v_created int := 0; v_refreshed int := 0; v_skipped int := 0;
BEGIN
  FOR g IN
    SELECT upper(regexp_replace(COALESCE(NULLIF(btrim(s.owner_name), ''), '(owner darj nahi)'),
                                '[^A-Za-z0-9]', '', 'g'))                  AS owner_key,
           COALESCE(s.fleet_class::text, 'NONE')                             AS class_key,
           min(COALESCE(NULLIF(btrim(s.owner_name), ''), '(owner darj nahi)')) AS owner_name,
           s.fleet_class,
           max(s.company_id::text)::uuid                                     AS company_id,
           string_agg(DISTINCT s.operating_company, ' + ')                   AS operating_company
      FROM vehicle_fortnight_settlements s
     WHERE s.period_from = v_from
     GROUP BY 1, 2, 4
  LOOP
    SELECT b.id, b.locked_at INTO v_id, v_locked
      FROM vehicle_owner_bills b
     WHERE b.owner_key = g.owner_key AND b.class_key = g.class_key AND b.period_from = v_from;

    IF v_id IS NULL THEN
      v_base := owner_bill_no(g.owner_name, g.class_key, v_from);
      v_no := v_base; n := 1;
      WHILE EXISTS (SELECT 1 FROM vehicle_owner_bills WHERE bill_no = v_no) LOOP
        n := n + 1; v_no := v_base || '-' || n;
      END LOOP;
      INSERT INTO vehicle_owner_bills
        (bill_no, owner_key, owner_name, fleet_class, class_key, company_id, operating_company,
         period_from, period_to, cycle, status, created_by)
      VALUES (v_no, g.owner_key, g.owner_name, g.fleet_class, g.class_key, g.company_id,
              g.operating_company, v_from, v_to, fortnight_code(v_from), 'AI_DRAFT', p_by)
      RETURNING id INTO v_id;
      v_created := v_created + 1;
    ELSIF v_locked IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    ELSE
      v_refreshed := v_refreshed + 1;
      UPDATE vehicle_owner_bills
         SET company_id = COALESCE(g.company_id, company_id),
             operating_company = COALESCE(g.operating_company, operating_company)
       WHERE id = v_id;
    END IF;

    UPDATE vehicle_fortnight_settlements s
       SET owner_bill_id = v_id
     WHERE s.period_from = v_from
       AND s.locked_at IS NULL
       AND upper(regexp_replace(COALESCE(NULLIF(btrim(s.owner_name), ''), '(owner darj nahi)'),
                                '[^A-Za-z0-9]', '', 'g')) = g.owner_key
       AND COALESCE(s.fleet_class::text, 'NONE') = g.class_key
       AND s.owner_bill_id IS DISTINCT FROM v_id;

    PERFORM vehicle_owner_bill_refresh(v_id);
  END LOOP;

  DELETE FROM vehicle_owner_bills b
   WHERE b.period_from = v_from AND b.locked_at IS NULL
     AND b.class_key <> 'MARKET'
     AND NOT EXISTS (SELECT 1 FROM vehicle_fortnight_settlements s WHERE s.owner_bill_id = b.id);

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- ═══ 10. ONE CYCLE, THREE KINDS — the 1st/16th build drafts them all ═══════
CREATE OR REPLACE FUNCTION vehicle_fortnight_build(p_from date, p_by text DEFAULT 'system')
RETURNS TABLE (created int, refreshed int, skipped int) AS $$
DECLARE
  v_from date := fortnight_from(p_from);
  v_created int := 0; v_refreshed int := 0; v_skipped int := 0;
BEGIN
  WITH src AS (
    SELECT * FROM v_vehicle_fortnight_class WHERE period_from = v_from
  ), ins AS (
    INSERT INTO vehicle_fortnight_settlements
      (vehicle_id, vehicle_no, vehicle_key, operating_company,
       period_from, period_to, cycle, status,
       trips_count, billed_amount, received_amount,
       hsd, toll, tyre, maintenance, other_expense, advances,
       fooding, fixed_allowance, doc_expense, loaded_qty, rtkm, shortage_penalty,
       fleet_class, owner_name, company_id, terms_id,
       commission_basis, commission_rate, commission_amount,
       tds_pct, tds_amount, expenses_recovered, payable_to_owner,
       lines, created_by)
    SELECT s.vehicle_id, s.vehicle_no, s.vehicle_key, s.operating_company,
           s.period_from, s.period_to, s.cycle, 'AI_DRAFT',
           s.trips_count, s.billed_amount, s.received_amount,
           s.hsd, s.toll, s.tyre, s.maintenance, s.other_expense, s.advances,
           s.fooding, s.fixed_allowance, s.doc_expense, s.loaded_qty, s.rtkm, s.shortage_penalty,
           s.fleet_class, s.owner_name, s.master_company_id, s.terms_id,
           s.basis, s.rate, s.commission_amount,
           s.tds_pct, s.tds_amount, s.expenses_recovered, s.payable_to_owner,
           vehicle_settlement_lines(s.vehicle_key, s.period_from),
           p_by
      FROM src s
    ON CONFLICT (vehicle_key, period_from, period_to) DO UPDATE
       SET trips_count     = EXCLUDED.trips_count,
           billed_amount   = EXCLUDED.billed_amount,
           received_amount = EXCLUDED.received_amount,
           hsd             = EXCLUDED.hsd,
           toll            = EXCLUDED.toll,
           tyre            = EXCLUDED.tyre,
           maintenance     = EXCLUDED.maintenance,
           other_expense   = EXCLUDED.other_expense,
           advances        = EXCLUDED.advances,
           fooding         = EXCLUDED.fooding,
           fixed_allowance = EXCLUDED.fixed_allowance,
           doc_expense     = EXCLUDED.doc_expense,
           loaded_qty      = EXCLUDED.loaded_qty,
           rtkm            = EXCLUDED.rtkm,
           shortage_penalty = EXCLUDED.shortage_penalty,
           operating_company = EXCLUDED.operating_company,
           fleet_class     = EXCLUDED.fleet_class,
           owner_name      = EXCLUDED.owner_name,
           company_id      = EXCLUDED.company_id,
           terms_id        = EXCLUDED.terms_id,
           commission_basis = EXCLUDED.commission_basis,
           commission_rate  = EXCLUDED.commission_rate,
           commission_amount = EXCLUDED.commission_amount,
           tds_pct         = EXCLUDED.tds_pct,
           tds_amount      = EXCLUDED.tds_amount,
           expenses_recovered = EXCLUDED.expenses_recovered,
           payable_to_owner = EXCLUDED.payable_to_owner,
           lines           = EXCLUDED.lines,
           updated_at      = now()
       WHERE vehicle_fortnight_settlements.status = 'AI_DRAFT'
         AND vehicle_fortnight_settlements.locked_at IS NULL
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT count(*) FILTER (WHERE was_insert),
         count(*) FILTER (WHERE NOT was_insert)
    INTO v_created, v_refreshed FROM ins;

  SELECT count(*) INTO v_skipped
    FROM vehicle_fortnight_settlements
   WHERE period_from = v_from AND status <> 'AI_DRAFT';

  PERFORM vehicle_owner_bills_build(v_from, p_by);
  PERFORM market_partner_bills_build(v_from, p_by);

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;
