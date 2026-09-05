-- ═══════════════════════════════════════════════════════════════════════════
-- 175 — MONTH-END SETTLEMENT + ATTACHED-LORRY PAYMENT ROUTING
--
-- Owner, 5-Sep-2026 (GOD COMMAND): (1) whenever a driver is paid (advance,
-- bhatta, settlement) on an ATTACHED lorry, the money is the owner's cost —
-- debit the owner's ledger so the 15-day Lorry Hire Statement recovers it;
-- (2) one button runs the month: fixed-salary drivers netted of advances,
-- shortages and challans; trip-basis drivers get a zero-balance monthly
-- slip; liabilities posted for disbursal; (3) an advance floating without a
-- driver blocks the closing until a person deals with it. Backfill
-- April–August 2026 month by month.
--
-- What the audit found: the 15-day owner bill (160) ALREADY deducts the
-- driver advances of an attached lorry ("advances" column, inside
-- "recovered") — but only at bill time, while the ledger kept the advance on
-- the driver ('Driver Advance: NAME') or in the pooled 'Driver Advance (Pump
-- Cash)' (₹4.39 L, 189 pump-cash slips with no driver). 320 of this FY's
-- trips ran on attached lorries with ₹2.28 L of driver cash on them.
-- Routing rule: at payment time the asset moves from the driver (or the
-- pump-cash pool) to the owner: Dr 'Vehicle Owner: NAME' / Cr source.
-- The bill then subtracts what is already on the owner's ledger from its
-- "recovered" leg, so nothing is charged twice. A khata entry with no cash
-- voucher behind it cannot be routed — it is flagged, never invented.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. WHO OWNS THE LORRY OF A TRIP ══════════════════════════════════════
CREATE OR REPLACE FUNCTION trip_owner(p_trip uuid)
RETURNS TABLE (ownership text, owner_name text, owner_ledger text, vehicle_no text) LANGUAGE sql STABLE AS $$
  SELECT v.ownership::text, v.owner_name,
         CASE WHEN v.ownership::text = 'ATTACHED' THEN vehicle_owner_ledger_name(v.owner_name) END,
         t.vehicle_no
    FROM trips t
    LEFT JOIN vehicles v ON v.vehicle_no_norm = regexp_replace(upper(coalesce(t.vehicle_no, '')), '[^A-Z0-9]', '', 'g')
   WHERE t.id = p_trip
   LIMIT 1 $$;

ALTER TABLE driver_trip_settlements
  ADD COLUMN IF NOT EXISTS vehicle_ownership text,
  ADD COLUMN IF NOT EXISTS owner_name        text,
  ADD COLUMN IF NOT EXISTS owner_ledger      text;
CREATE OR REPLACE FUNCTION dts_owner_fill() RETURNS trigger AS $$
DECLARE o record;
BEGIN
  SELECT * INTO o FROM trip_owner(NEW.trip_id);
  NEW.vehicle_ownership := o.ownership; NEW.owner_name := o.owner_name; NEW.owner_ledger := o.owner_ledger;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS dts_owner_fill ON driver_trip_settlements;
CREATE TRIGGER dts_owner_fill BEFORE INSERT OR UPDATE OF trip_id, earning ON driver_trip_settlements FOR EACH ROW EXECUTE FUNCTION dts_owner_fill();
UPDATE driver_trip_settlements s SET vehicle_ownership = o.ownership, owner_name = o.owner_name, owner_ledger = o.owner_ledger
  FROM (SELECT x.id, t.ownership, t.owner_name, t.owner_ledger FROM driver_trip_settlements x CROSS JOIN LATERAL trip_owner(x.trip_id) t WHERE x.vehicle_ownership IS NULL) o
 WHERE o.id = s.id;

-- A manager may dock a trip by hand (a korki the registers do not know) or
-- explain a correction; the settlement keeps it through every recompute.
ALTER TABLE driver_trip_settlements
  ADD COLUMN IF NOT EXISTS manual_korki numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_note  text,
  ADD COLUMN IF NOT EXISTS applied_manual numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edited_by    text,
  ADD COLUMN IF NOT EXISTS edited_at    timestamptz;

CREATE OR REPLACE FUNCTION driver_trip_settle(p_trip uuid, p_by text DEFAULT 'system') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t record; p record; k record; d record; v_id uuid; v_status text; v_no text; v_manual numeric := 0;
        rem numeric; a_short numeric; a_chal numeric; a_man numeric; a_adv numeric; v_net numeric; v_carry numeric; v_total numeric;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip;
  IF t.id IS NULL OR t.status NOT IN ('COMPLETED','SETTLED') THEN RETURN NULL; END IF;
  SELECT id, status, manual_korki INTO v_id, v_status, v_manual FROM driver_trip_settlements WHERE trip_id = p_trip;
  IF v_status IN ('POSTED','PAID','CANCELLED') THEN RETURN v_id; END IF;
  SELECT * INTO p FROM driver_trip_pay(p_trip);
  IF p.driver_name IS NULL THEN RETURN NULL; END IF;
  IF p.pay_model = 'MONTHLY' THEN
    DELETE FROM driver_trip_settlements WHERE trip_id = p_trip AND status IN ('DRAFT','BLOCKED');
    RETURN NULL;
  END IF;
  SELECT * INTO d FROM drivers WHERE id = p.driver_id;
  SELECT * INTO k FROM driver_trip_korki(p_trip, coalesce(d.shortage_recovery_pct, 100));
  v_manual := coalesce(v_manual, 0);
  v_total := coalesce(k.advances, 0) + coalesce(k.shortage, 0) + coalesce(k.challans, 0) + v_manual;
  -- priority: shortage, challans, the manager's dock, then advances — losses first, the asset waits
  rem := coalesce(p.earning, 0);
  a_short := least(rem, coalesce(k.shortage, 0)); rem := rem - a_short;
  a_chal := least(rem, coalesce(k.challans, 0)); rem := rem - a_chal;
  a_man := least(rem, v_manual); rem := rem - a_man;
  a_adv := least(rem, coalesce(k.advances, 0)); rem := rem - a_adv;
  v_net := rem; v_carry := v_total - (a_short + a_chal + a_man + a_adv);
  v_status := CASE WHEN p.reason IS NOT NULL THEN 'BLOCKED' ELSE 'DRAFT' END;
  IF v_id IS NULL THEN
    v_no := 'DTS-' || lpad(nextval('driver_trip_settlement_seq')::text, 6, '0');
    INSERT INTO driver_trip_settlements (settlement_no, trip_id, trip_code, driver_id, driver_name, company_id, vehicle_no, completed_at, basis, rate, freight, rtkm, earning,
                                         korki_advances, korki_shortage, korki_challans, korki_other, korki_total, applied_shortage, applied_challans, applied_manual, applied_advances, net_payable, carry_forward, status, block_reason, lines, created_by)
    VALUES (v_no, p_trip, t.trip_code, p.driver_id, p.driver_name, coalesce(d.pay_company_id, t.company_id), t.vehicle_no, coalesce(t.completed_at, t.unloading_date::timestamptz, now()), p.basis, p.rate, p.freight, p.rtkm, coalesce(p.earning, 0),
            k.advances, k.shortage, k.challans, v_manual, v_total, a_short, a_chal, a_man, a_adv, v_net, v_carry, v_status, p.reason, k.lines, p_by)
    RETURNING id INTO v_id;
  ELSE
    UPDATE driver_trip_settlements
       SET driver_id = p.driver_id, driver_name = p.driver_name, company_id = coalesce(d.pay_company_id, t.company_id), vehicle_no = t.vehicle_no, trip_code = t.trip_code,
           completed_at = coalesce(t.completed_at, t.unloading_date::timestamptz, completed_at), basis = p.basis, rate = p.rate, freight = p.freight, rtkm = p.rtkm, earning = coalesce(p.earning, 0),
           korki_advances = k.advances, korki_shortage = k.shortage, korki_challans = k.challans, korki_other = v_manual, korki_total = v_total,
           applied_shortage = a_short, applied_challans = a_chal, applied_manual = a_man, applied_advances = a_adv, net_payable = v_net, carry_forward = v_carry,
           status = v_status, block_reason = p.reason, lines = k.lines, updated_at = now()
     WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

-- ═══ 2. ROUTING OF DRIVER PAYMENTS ON ATTACHED LORRIES ════════════════════
CREATE TABLE IF NOT EXISTS driver_payment_routing (
  txn_id        uuid PRIMARY KEY REFERENCES driver_transactions(id) ON DELETE CASCADE,
  trip_id       uuid,
  vehicle_no    text,
  driver_name   text,
  owner_name    text,
  owner_ledger  text,
  source_ledger text,
  amount        numeric(14,2) NOT NULL,
  status        text NOT NULL CHECK (status IN ('ROUTED','NEEDS_VOUCHER','NOT_APPLICABLE','FAILED')),
  voucher_id    uuid,
  note          text,
  routed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Where the cash leg of a khata entry sits in the ledger: pump cash is on
-- the pooled pump-cash head; office cash / bank shows as a debit on the
-- driver's own advance head when it was vouchered; otherwise nowhere.
CREATE OR REPLACE FUNCTION driver_txn_source_ledger(p_txn uuid) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE t record; v_name text;
BEGIN
  SELECT * INTO t FROM driver_transactions WHERE id = p_txn;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  IF coalesce(t.mode, '') ILIKE '%pump%' OR coalesce(t.remarks, '') ~* 'cash from|pump' THEN RETURN 'Driver Advance (Pump Cash)'; END IF;
  SELECT l.ledger_name INTO v_name
    FROM ledgers l JOIN ledger_entries e ON e.ledger_name = l.ledger_name
   WHERE l.group_head = 'Current Assets - Driver Advances'
     AND norm_person_name(regexp_replace(l.ledger_name, '^Driver Advance:\s*', '')) = norm_person_name(t.driver_name)
     AND e.dr_cr = 'DR' AND e.amount = t.amount AND e.entry_date BETWEEN t.txn_date - 3 AND t.txn_date + 3
   ORDER BY abs(e.entry_date - t.txn_date) LIMIT 1;
  RETURN v_name;
END $$;

-- Payments to a driver of an attached lorry not yet routed to the owner.
CREATE OR REPLACE FUNCTION driver_txn_routing_candidates(p_limit int DEFAULT 500)
RETURNS TABLE (txn_id uuid, trip_id uuid, trip_code text, vehicle_no text, driver_name text, txn_type text, txn_date date, amount numeric, mode text, remarks text, owner_name text, owner_ledger text, source_ledger text, company_id uuid) LANGUAGE sql STABLE AS $$
  SELECT dt.id, dt.trip_id, t.trip_code, t.vehicle_no, dt.driver_name, dt.txn_type, dt.txn_date, dt.amount, dt.mode, dt.remarks,
         o.owner_name, o.owner_ledger, driver_txn_source_ledger(dt.id), t.company_id
    FROM driver_transactions dt
    JOIN trips t ON t.id = dt.trip_id
    CROSS JOIN LATERAL trip_owner(t.id) o
   WHERE dt.txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN','FUEL_EXPENSE')
     AND coalesce(dt.approval_status, 'APPROVED') <> 'REJECTED'
     AND o.ownership = 'ATTACHED' AND o.owner_ledger IS NOT NULL
     AND dt.txn_date >= DATE '2026-04-01'
     AND NOT EXISTS (SELECT 1 FROM driver_payment_routing r WHERE r.txn_id = dt.id AND r.status IN ('ROUTED','NOT_APPLICABLE'))
   ORDER BY dt.txn_date, dt.created_at
   LIMIT p_limit $$;

-- What the owner's ledger already carries for the lorries and fortnights of a bill.
CREATE OR REPLACE FUNCTION owner_bill_routed_advances(p_bill uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(r.amount), 0)::numeric(14,2)
    FROM driver_payment_routing r
    JOIN trips t ON t.id = r.trip_id
    JOIN vehicle_fortnight_settlements v ON v.owner_bill_id = p_bill
         AND v.vehicle_key = regexp_replace(upper(coalesce(t.vehicle_no, '')), '[^A-Z0-9]', '', 'g')
         AND coalesce(t.unloading_date, t.loading_date) BETWEEN v.period_from AND v.period_to
   WHERE r.status = 'ROUTED' $$;

-- ═══ 3. MONTH-END: GATE, PREPARE, SLIPS ═══════════════════════════════════
CREATE TABLE IF NOT EXISTS month_end_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period        text NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','BLOCKED','CLOSED')),
  gate          jsonb NOT NULL DEFAULT '[]'::jsonb,
  forced        boolean NOT NULL DEFAULT false,
  force_reason  text,
  driver_run_id uuid,
  staff_run_id  uuid,
  settlements_posted int NOT NULL DEFAULT 0,
  routed        int NOT NULL DEFAULT 0,
  slips         int NOT NULL DEFAULT 0,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  closed_at     timestamptz,
  closed_by     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period)
);
CREATE TABLE IF NOT EXISTS payroll_slips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid REFERENCES companies(id) ON DELETE CASCADE,
  period        text NOT NULL,
  person_kind   text NOT NULL,
  person_id     uuid,
  person_name   text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('TRIP','MONTHLY','STAFF')),
  opening       numeric(14,2) NOT NULL DEFAULT 0,
  earned        numeric(14,2) NOT NULL DEFAULT 0,
  korki         numeric(14,2) NOT NULL DEFAULT 0,
  advances      numeric(14,2) NOT NULL DEFAULT 0,
  paid          numeric(14,2) NOT NULL DEFAULT 0,
  closing       numeric(14,2) NOT NULL DEFAULT 0,
  trips         int NOT NULL DEFAULT 0,
  lines         jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_key      text,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period, person_kind, person_id)
);

-- The slip is the approval-queue item: the agent drafts it on the 1st, a
-- manager edits / prints / sends it, then Approve & Post locks it and posts
-- the person's settlements. Nothing reaches the ledger before that click.
ALTER TABLE payroll_slips
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','POSTED','BLOCKED')),
  ADD COLUMN IF NOT EXISTS adjustments  jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS note         text,
  ADD COLUMN IF NOT EXISTS edited_by    text,
  ADD COLUMN IF NOT EXISTS edited_at    timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by  text,
  ADD COLUMN IF NOT EXISTS approved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS posted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS wa_sent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS wa_result    text,
  ADD COLUMN IF NOT EXISTS mobile       text;
ALTER TABLE month_end_runs
  ADD COLUMN IF NOT EXISTS prepared_at  timestamptz,
  ADD COLUMN IF NOT EXISTS prepared_by  text;

-- The blockers a person must clear (or knowingly override) before a month closes.
CREATE OR REPLACE FUNCTION month_end_gate(p_company uuid, p_period text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p_from date := to_date(p_period || '-01', 'YYYY-MM-DD'); p_to date; out jsonb := '[]'::jsonb; v numeric; n int; names text;
BEGIN
  p_to := (p_from + interval '1 month' - interval '1 day')::date;
  -- 1. the pooled pump-cash advance: cash given with no driver on it
  SELECT coalesce(sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0) INTO v FROM ledger_entries e WHERE e.ledger_name = 'Driver Advance (Pump Cash)';
  IF v > 0 THEN out := out || jsonb_build_object('kind', 'FLOATING_ADVANCE', 'severity', 'HIGH', 'amount', v, 'title', format('₹%s of pump-cash advances sit on the pooled ledger with no driver attached', to_char(v, 'FM99,99,99,990')), 'fix', 'Attribute each pump-cash slip to its driver (Fleet Card & Settlement → pump cash) or route the attached-lorry ones to their owners; the rest is an Exception Desk decision'); END IF;
  -- 2. khata entries with no cash voucher on an attached lorry
  SELECT count(*), coalesce(sum(amount), 0) INTO n, v FROM driver_payment_routing WHERE status = 'NEEDS_VOUCHER';
  IF n > 0 THEN out := out || jsonb_build_object('kind', 'UNVOUCHERED_ADVANCE', 'severity', 'HIGH', 'count', n, 'amount', v, 'title', format('%s driver payments on attached lorries (₹%s) have no cash voucher behind them', n, to_char(v, 'FM99,99,99,990')), 'fix', 'Post the cash / bank voucher for each (Cash & Bank Book), then route again'); END IF;
  -- 3. advances whose driver is not on the master
  SELECT count(*), coalesce(sum(amount), 0), string_agg(DISTINCT driver_name, ', ') INTO n, v, names FROM driver_transactions dt
   WHERE dt.txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN','FUEL_EXPENSE') AND dt.driver_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM drivers d WHERE norm_person_name(d.name) = norm_person_name(dt.driver_name));
  IF n > 0 THEN out := out || jsonb_build_object('kind', 'ADVANCE_NO_DRIVER', 'severity', 'HIGH', 'count', n, 'amount', v, 'title', format('%s advances (₹%s) name a driver who is not on the master: %s', n, to_char(v, 'FM99,99,99,990'), left(names, 120)), 'fix', 'Register the driver or correct the name on the entry'); END IF;
  -- 4. trips of the month with no driver, or a driver not on the master
  SELECT count(*), string_agg(DISTINCT coalesce(t.driver_name, '(no driver)'), ', ') INTO n, names FROM trips t
   WHERE t.company_id = p_company AND t.status IN ('COMPLETED','SETTLED') AND coalesce(t.unloading_date, t.loading_date) BETWEEN p_from AND p_to AND driver_of_trip(t.id) IS NULL;
  IF n > 0 THEN out := out || jsonb_build_object('kind', 'TRIP_NO_DRIVER', 'severity', 'MEDIUM', 'count', n, 'title', format('%s completed trips this month have no driver on the master: %s', n, left(names, 120)), 'fix', 'Set the driver on the trip (Trip Management) or register the driver'); END IF;
  -- 5. drivers with trips this month and no compensation model
  SELECT count(DISTINCT d.id), string_agg(DISTINCT d.name, ', ') INTO n, names FROM trips t JOIN drivers d ON d.id = driver_of_trip(t.id)
   WHERE t.company_id = p_company AND t.status IN ('COMPLETED','SETTLED') AND coalesce(t.unloading_date, t.loading_date) BETWEEN p_from AND p_to AND d.pay_model IS NULL;
  IF n > 0 THEN out := out || jsonb_build_object('kind', 'NO_PAY_MODEL', 'severity', 'HIGH', 'count', n, 'title', format('%s drivers drove this month and have no compensation model: %s', n, left(names, 160)), 'fix', 'Driver Master → Configure → Compensation Model'); END IF;
  -- 6. settlements blocked on a rate
  SELECT count(*) INTO n FROM driver_trip_settlements s WHERE s.company_id = p_company AND s.status = 'BLOCKED' AND s.block_reason NOT LIKE 'no compensation model%' AND s.block_reason <> 'driver not on the master' AND to_char(s.completed_at, 'YYYY-MM') = p_period;
  IF n > 0 THEN out := out || jsonb_build_object('kind', 'RATE_BLOCKED', 'severity', 'MEDIUM', 'count', n, 'title', format('%s trip settlements this month cannot be priced (missing rate / freight / RTKM)', n), 'fix', 'Set the rate under Configure or price the trip, then recompute'); END IF;
  RETURN out;
END $$;

-- Everything the month needs, computed and stored; nothing posted (the API posts through TARA).
CREATE OR REPLACE FUNCTION month_end_prepare(p_company uuid, p_period text, p_by text DEFAULT 'system') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p_from date := to_date(p_period || '-01', 'YYYY-MM-DD'); p_to date; v_id uuid; v_status text; v_gate jsonb; v_drv uuid; v_stf uuid; r record; n_slips int := 0; v_lines jsonb;
        v_open numeric; v_earned numeric; v_korki numeric; v_adv numeric; v_paid numeric; v_close numeric; v_trips int; v_kind text;
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'period must be YYYY-MM'; END IF;
  p_to := (p_from + interval '1 month' - interval '1 day')::date;
  SELECT id, status INTO v_id, v_status FROM month_end_runs WHERE company_id = p_company AND period = p_period;
  IF v_status = 'CLOSED' THEN RETURN v_id; END IF;
  -- every completed trip of the month has its settlement row
  FOR r IN SELECT t.id FROM trips t WHERE t.company_id = p_company AND t.status IN ('COMPLETED','SETTLED') AND coalesce(t.unloading_date, t.loading_date) BETWEEN p_from AND p_to
             AND NOT EXISTS (SELECT 1 FROM driver_trip_settlements s WHERE s.trip_id = t.id AND s.status IN ('POSTED','PAID','CANCELLED'))
  LOOP PERFORM driver_trip_settle(r.id, p_by); END LOOP;
  v_gate := month_end_gate(p_company, p_period);
  v_drv := payroll_run_build(p_company, p_period, 'DRIVER', p_by);
  v_stf := payroll_run_build(p_company, p_period, 'STAFF', p_by);
  IF v_id IS NULL THEN
    INSERT INTO month_end_runs (company_id, period, status, gate, driver_run_id, staff_run_id) VALUES (p_company, p_period, CASE WHEN jsonb_array_length(v_gate) > 0 THEN 'BLOCKED' ELSE 'DRAFT' END, v_gate, v_drv, v_stf) RETURNING id INTO v_id;
  ELSE
    UPDATE month_end_runs SET gate = v_gate, status = CASE WHEN jsonb_array_length(v_gate) > 0 THEN 'BLOCKED' ELSE 'DRAFT' END, driver_run_id = v_drv, staff_run_id = v_stf, updated_at = now() WHERE id = v_id;
  END IF;
  -- slips: every driver with activity in the month (trip basis: the zero-balance ledger; monthly: the run line)
  FOR r IN SELECT d.* FROM drivers d
            WHERE EXISTS (SELECT 1 FROM driver_trip_settlements s WHERE (s.driver_id = d.id) AND s.company_id = p_company AND to_char(s.completed_at, 'YYYY-MM') = p_period AND s.status <> 'CANCELLED')
               OR EXISTS (SELECT 1 FROM payroll_lines l JOIN payroll_runs pr ON pr.id = l.run_id WHERE l.person_kind = 'DRIVER' AND l.person_id = d.id AND pr.company_id = p_company AND pr.period = p_period)
               OR EXISTS (SELECT 1 FROM driver_transactions dt WHERE (dt.driver_id = d.id OR (dt.driver_id IS NULL AND norm_person_name(dt.driver_name) = norm_person_name(d.name))) AND dt.txn_date BETWEEN p_from AND p_to
                            AND EXISTS (SELECT 1 FROM trips t WHERE t.id = dt.trip_id AND t.company_id = p_company))
  LOOP
    v_kind := CASE WHEN r.pay_model = 'MONTHLY' THEN 'MONTHLY' ELSE 'TRIP' END;
    v_open := driver_khata_balance(r.id, r.name, p_from - 1);
    SELECT coalesce(sum(CASE WHEN txn_type = 'SALARY_CREDIT' THEN amount ELSE 0 END), 0), coalesce(sum(CASE WHEN txn_type IN ('SHORTAGE_RECOVERY') THEN amount ELSE 0 END), 0),
           coalesce(sum(CASE WHEN txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN','FUEL_EXPENSE') THEN amount ELSE 0 END), 0), coalesce(sum(CASE WHEN txn_type = 'FINAL_PAYMENT' THEN amount ELSE 0 END), 0)
      INTO v_earned, v_korki, v_adv, v_paid
      FROM driver_transactions WHERE (driver_id = r.id OR (driver_id IS NULL AND norm_person_name(driver_name) = norm_person_name(r.name))) AND txn_date BETWEEN p_from AND p_to AND coalesce(approval_status, 'APPROVED') <> 'REJECTED';
    v_close := driver_khata_balance(r.id, r.name, p_to);
    SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('trip', s.trip_code, 'vehicle', s.vehicle_no, 'ownership', s.vehicle_ownership, 'owner', s.owner_name, 'completed', s.completed_at::date, 'basis', s.basis, 'earning', s.earning,
                                          'advances', s.applied_advances, 'shortage', s.applied_shortage, 'challans', s.applied_challans, 'manual', s.applied_manual, 'net', s.net_payable, 'status', s.status, 'block', s.block_reason, 'paid_on', s.paid_on, 'no', s.settlement_no, 'id', s.id) ORDER BY s.completed_at), '[]'::jsonb),
           coalesce(sum(s.earning), 0), coalesce(sum(s.applied_shortage + s.applied_challans + s.applied_manual), 0)
      INTO v_trips, v_lines, v_earned, v_korki
      FROM driver_trip_settlements s WHERE s.driver_id = r.id AND s.company_id = p_company AND to_char(s.completed_at, 'YYYY-MM') = p_period AND s.status <> 'CANCELLED';
    -- a trip-basis slip shows what the month's trips propose (posted or not); a salaried driver's shows the credits
    IF v_kind = 'MONTHLY' THEN
      SELECT coalesce(sum(CASE WHEN txn_type = 'SALARY_CREDIT' THEN amount ELSE 0 END), 0), coalesce(sum(CASE WHEN txn_type = 'SHORTAGE_RECOVERY' THEN amount ELSE 0 END), 0) INTO v_earned, v_korki
        FROM driver_transactions WHERE (driver_id = r.id OR (driver_id IS NULL AND norm_person_name(driver_name) = norm_person_name(r.name))) AND txn_date BETWEEN p_from AND p_to AND coalesce(approval_status, 'APPROVED') <> 'REJECTED';
    END IF;
    INSERT INTO payroll_slips (company_id, period, person_kind, person_id, person_name, kind, opening, earned, korki, advances, paid, closing, trips, lines, mobile, generated_at)
    VALUES (p_company, p_period, 'DRIVER', r.id, r.name, v_kind, v_open, v_earned, v_korki, v_adv, v_paid, v_close, v_trips, v_lines, r.mobile, now())
    ON CONFLICT (company_id, period, person_kind, person_id) DO UPDATE SET kind = EXCLUDED.kind, opening = EXCLUDED.opening, earned = EXCLUDED.earned, korki = EXCLUDED.korki, advances = EXCLUDED.advances, paid = EXCLUDED.paid, closing = EXCLUDED.closing, trips = EXCLUDED.trips, lines = EXCLUDED.lines, mobile = coalesce(payroll_slips.mobile, EXCLUDED.mobile), generated_at = now()
     WHERE payroll_slips.status IN ('DRAFT','BLOCKED');
    n_slips := n_slips + 1;
  END LOOP;
  FOR r IN SELECT l.*, s.kind AS skind FROM payroll_lines l JOIN payroll_runs pr ON pr.id = l.run_id JOIN staff_members s ON s.id = l.person_id WHERE pr.id = v_stf LOOP
    INSERT INTO payroll_slips (company_id, period, person_kind, person_id, person_name, kind, opening, earned, korki, advances, paid, closing, trips, lines, mobile, generated_at)
    VALUES (p_company, p_period, r.person_kind, r.person_id, r.person_name, 'STAFF', 0, r.gross, r.deductions_total, r.deduct_advances, CASE WHEN r.status = 'PAID' THEN r.net_payable ELSE 0 END, CASE WHEN r.status = 'PAID' THEN 0 ELSE r.net_payable END, 0,
            jsonb_build_array(jsonb_build_object('gross', r.gross, 'advances', r.deduct_advances, 'other', r.deduct_other, 'net', r.net_payable, 'status', r.status, 'paid_on', r.paid_on, 'line_id', r.id)), (SELECT mobile FROM staff_members sm WHERE sm.id = r.person_id), now())
    ON CONFLICT (company_id, period, person_kind, person_id) DO UPDATE SET earned = EXCLUDED.earned, korki = EXCLUDED.korki, advances = EXCLUDED.advances, paid = EXCLUDED.paid, closing = EXCLUDED.closing, lines = EXCLUDED.lines, mobile = coalesce(payroll_slips.mobile, EXCLUDED.mobile), generated_at = now()
     WHERE payroll_slips.status IN ('DRAFT','BLOCKED');
    n_slips := n_slips + 1;
  END LOOP;
  UPDATE month_end_runs SET slips = n_slips, updated_at = now() WHERE id = v_id;
  RETURN v_id;
END $$;

-- ═══ 4. EXCEPTIONS ════════════════════════════════════════════════════════
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH',
  'BANK_UNMATCHED','BANK_BOOK_NOT_IN_BANK',
  'TDS_PAN_MISSING','TDS_DEPOSIT_DUE','TDS_RETURN_DUE','TDS_26AS_MISMATCH','TDS_TAN_MISSING',
  'GST_GSTIN_MISSING','GST_CUSTOMER_GSTIN_MISSING','GST_RETURN_DUE','GST_ITC_INVOICE_MISSING','GST_DOC_ATTENTION','GST_BOOKS_MISMATCH',
  'PAYROLL_UNCONFIGURED','PAYROLL_BLOCKED','PAYROLL_KHATA_MISMATCH','PAYROLL_RUN_DUE','PAYROLL_FLOATING_ADVANCE','PAYROLL_MONTH_END_BLOCKED']));
