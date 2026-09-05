-- ═══════════════════════════════════════════════════════════════════════════
-- 174 — HR & PAYROLL: driver pay models with instant trip settlement
--       ("korki" = what the trip already cost the driver: advances, shortage,
--       challans), monthly runs for salaried drivers, office staff and
--       partners, one disbursal queue for the Cash & Bank Book.
--
-- Owner, 5-Sep-2026 (GOD COMMAND). What the audit found:
--   · 57 drivers, none with a pay model; 1,014 trips completed this FY and
--     not one credited to a driver — the khata only knows what they TOOK
--     (₹5.15 L advances, ₹4.82 L payments, ₹86 K shortage recoveries; dead
--     since 20-Jul); driver_settlements (the multi-trip bhatta reconciler of
--     migration 024) has never been used.
--   · trips.fixed_cash (the route master's bhatta) exists on 152 of 1,014
--     trips — a pay basis per driver is needed, the route table is one option.
--   · 163 of 168 advances carry the trip they were issued for, so "korki" per
--     trip is knowable; IOCL shortage penalties already flow to the khata.
--   · the ledger holds 'Driver Advance (Pump Cash)' ₹4.39 L pooled plus 60+
--     per-driver advance ledgers under two naming styles — the audit reports
--     khata-vs-ledger differences, it never moves money.
-- Design: the DB computes (earning, korki, net) and stores DRAFT / BLOCKED
-- rows the moment a trip completes; a person's "Approve & Post" posts the
-- liability (Dr wages / Cr payable) through TARA; "Pay" posts the PAYMENT
-- from a cash or bank ledger. Nothing auto-posts money.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. LEDGER GROUPS ═════════════════════════════════════════════════════
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
VALUES ('Salaries & Wages Payable', 'LIABILITY', 'BALANCE_SHEET', 'CR', 216, true),
       ('Capital Account', 'EQUITY', 'BALANCE_SHEET', 'CR', 200, true),
       ('Loans & Advances (Asset)', 'ASSET', 'BALANCE_SHEET', 'DR', 140, true),
       ('Current Assets - Driver Advances', 'ASSET', 'BALANCE_SHEET', 'DR', 150, true),
       ('Direct Expenses - Driver & Trip', 'EXPENSE', 'PROFIT_AND_LOSS', 'DR', 420, true),
       ('Shortage & Penalty', 'EXPENSE', 'PROFIT_AND_LOSS', 'DR', 430, true),
       ('Indirect Expenses', 'EXPENSE', 'PROFIT_AND_LOSS', 'DR', 480, true)
ON CONFLICT (group_head) DO NOTHING;

-- ═══ 2. THE DRIVER'S PAY MODEL ════════════════════════════════════════════
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS pay_model            text CHECK (pay_model IS NULL OR pay_model IN ('TRIP','MONTHLY')),
  ADD COLUMN IF NOT EXISTS trip_rate_mode       text NOT NULL DEFAULT 'ROUTE' CHECK (trip_rate_mode IN ('ROUTE','PER_TRIP','PCT_FREIGHT','PER_KM')),
  ADD COLUMN IF NOT EXISTS trip_rate            numeric(12,2),
  ADD COLUMN IF NOT EXISTS monthly_salary       numeric(12,2),
  ADD COLUMN IF NOT EXISTS shortage_recovery_pct numeric(5,2) NOT NULL DEFAULT 100 CHECK (shortage_recovery_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS pay_company_id       uuid REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pay_notes            text,
  ADD COLUMN IF NOT EXISTS pay_configured_by    text,
  ADD COLUMN IF NOT EXISTS pay_configured_at    timestamptz;
COMMENT ON COLUMN drivers.pay_model IS 'TRIP = instant settlement per completed trip (earning − korki → payable now); MONTHLY = flat salary, deductions accumulate to month end';
COMMENT ON COLUMN drivers.trip_rate_mode IS 'ROUTE = the route master bhatta on the trip (trips.fixed_cash); PER_TRIP = trip_rate per trip; PCT_FREIGHT = trip_rate % of the trip freight; PER_KM = trip_rate × RTKM';

-- ═══ 3. OFFICE STAFF AND PARTNERS ═════════════════════════════════════════
CREATE TABLE IF NOT EXISTS staff_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  kind           text NOT NULL CHECK (kind IN ('STAFF','PARTNER')),
  name           text NOT NULL,
  role_title     text,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  mobile         text,
  pan_no         text,
  bank_name      text,
  account_no     text,
  ifsc_code      text,
  monthly_amount numeric(12,2) NOT NULL DEFAULT 0,     -- salary (STAFF) or remuneration (PARTNER)
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LEFT')),
  join_date      date,
  left_date      date,
  notes          text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS staff_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  txn_date    date NOT NULL DEFAULT current_date,
  txn_type    text NOT NULL CHECK (txn_type IN ('ADVANCE_GIVEN','DRAWING','SALARY_CREDIT','PAYMENT_GIVEN','OTHER_DEDUCTION')),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  mode        text,
  remarks     text,
  voucher_id  uuid,
  ref         text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_transactions_staff_idx ON staff_transactions (staff_id, txn_date);

-- ═══ 4. INSTANT TRIP SETTLEMENTS ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS driver_trip_settlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_no      text UNIQUE,
  trip_id            uuid NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  trip_code          text,
  driver_id          uuid REFERENCES drivers(id) ON DELETE SET NULL,
  driver_name        text NOT NULL,
  company_id         uuid REFERENCES companies(id) ON DELETE SET NULL,
  vehicle_no         text,
  completed_at       timestamptz,
  basis              text,
  rate               numeric(12,2),
  freight            numeric(14,2),
  rtkm               numeric(10,3),
  earning            numeric(14,2) NOT NULL DEFAULT 0,
  korki_advances     numeric(14,2) NOT NULL DEFAULT 0,   -- due
  korki_shortage     numeric(14,2) NOT NULL DEFAULT 0,
  korki_challans     numeric(14,2) NOT NULL DEFAULT 0,
  korki_other        numeric(14,2) NOT NULL DEFAULT 0,
  korki_total        numeric(14,2) NOT NULL DEFAULT 0,
  applied_shortage   numeric(14,2) NOT NULL DEFAULT 0,   -- what this trip's earning actually absorbed
  applied_challans   numeric(14,2) NOT NULL DEFAULT 0,
  applied_advances   numeric(14,2) NOT NULL DEFAULT 0,
  applied_other      numeric(14,2) NOT NULL DEFAULT 0,
  net_payable        numeric(14,2) NOT NULL DEFAULT 0,
  carry_forward      numeric(14,2) NOT NULL DEFAULT 0,   -- korki the earning could not cover; stays in the khata
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('BLOCKED','DRAFT','POSTED','PAID','CANCELLED')),
  block_reason       text,
  lines              jsonb NOT NULL DEFAULT '[]'::jsonb,
  journal_voucher_id uuid,
  payment_voucher_id uuid,
  paid_via           text,
  paid_on            date,
  paid_by            text,
  posted_at          timestamptz,
  posted_by          text,
  note               text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_trip_settlements_driver_idx ON driver_trip_settlements (driver_name, status);
CREATE SEQUENCE IF NOT EXISTS driver_trip_settlement_seq;

CREATE OR REPLACE FUNCTION norm_person_name(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(regexp_replace(upper(btrim(coalesce(t, ''))), '\s+', ' ', 'g'), '') $$;

-- Which driver a trip belongs to: the id when it is there, the name otherwise.
CREATE OR REPLACE FUNCTION driver_of_trip(p_trip uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(t.driver_id, (SELECT d.id FROM drivers d WHERE norm_person_name(d.name) = norm_person_name(t.driver_name) ORDER BY d.approval_status = 'APPROVED' DESC, d.created_at LIMIT 1))
    FROM trips t WHERE t.id = p_trip $$;

-- The trip's pay under the driver's basis. Never guesses: no basis → BLOCKED.
CREATE OR REPLACE FUNCTION driver_trip_pay(p_trip uuid)
RETURNS TABLE (driver_id uuid, driver_name text, pay_model text, basis text, rate numeric, earning numeric, freight numeric, rtkm numeric, reason text) LANGUAGE plpgsql STABLE AS $$
DECLARE t record; d record;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip;
  IF t.id IS NULL THEN RETURN; END IF;
  SELECT * INTO d FROM drivers WHERE id = driver_of_trip(p_trip);
  driver_id := d.id; driver_name := coalesce(d.name, t.driver_name); pay_model := d.pay_model;
  freight := coalesce(t.billed_amount, t.freight_amount); rtkm := t.rtkm;
  basis := coalesce(d.trip_rate_mode, 'ROUTE'); rate := d.trip_rate; earning := 0; reason := NULL;
  IF d.id IS NULL THEN reason := 'driver not on the master'; basis := NULL;
  ELSIF d.pay_model IS NULL THEN reason := 'no compensation model configured (Driver Master → Configure)';
  ELSIF d.pay_model = 'MONTHLY' THEN reason := 'fixed salary — settles in the monthly run';
  ELSIF basis = 'ROUTE' THEN
    IF coalesce(t.fixed_cash, 0) > 0 THEN earning := t.fixed_cash; rate := t.fixed_cash;
    ELSE reason := 'no route allowance on this trip (Route & RTKM master fixed cash) — set a per-trip rate or fix the route'; END IF;
  ELSIF basis = 'PER_TRIP' THEN
    IF coalesce(d.trip_rate, 0) > 0 THEN earning := d.trip_rate; ELSE reason := 'per-trip rate not set'; END IF;
  ELSIF basis = 'PCT_FREIGHT' THEN
    IF coalesce(d.trip_rate, 0) <= 0 THEN reason := 'freight percentage not set';
    ELSIF coalesce(freight, 0) <= 0 THEN reason := 'trip has no freight yet — price it in Bill Management';
    ELSE earning := round(freight * d.trip_rate / 100.0, 2); END IF;
  ELSIF basis = 'PER_KM' THEN
    IF coalesce(d.trip_rate, 0) <= 0 THEN reason := 'per-km rate not set';
    ELSIF coalesce(t.rtkm, 0) <= 0 THEN reason := 'trip has no RTKM';
    ELSE earning := round(t.rtkm * d.trip_rate, 2); END IF;
  END IF;
  RETURN NEXT;
END $$;

-- Korki: what this trip already cost the driver, and what was already recovered.
CREATE OR REPLACE FUNCTION driver_trip_korki(p_trip uuid, p_pct numeric DEFAULT 100)
RETURNS TABLE (advances numeric, shortage numeric, challans numeric, lines jsonb) LANGUAGE plpgsql STABLE AS $$
DECLARE t record; v_adv numeric; v_short numeric; v_rec numeric; v_chal numeric; v_lines jsonb;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip;
  SELECT coalesce(sum(amount), 0) INTO v_adv FROM driver_transactions
   WHERE trip_id = p_trip AND txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN') AND coalesce(approval_status, 'APPROVED') <> 'REJECTED';
  SELECT coalesce(sum(amount), 0) INTO v_rec FROM driver_transactions WHERE trip_id = p_trip AND txn_type = 'SHORTAGE_RECOVERY';
  v_short := greatest(round(coalesce(t.shortage_penalty, 0) * coalesce(p_pct, 100) / 100.0, 2) - v_rec, 0);
  SELECT coalesce(sum(amount), 0) INTO v_chal FROM trip_expense_entries WHERE trip_id = p_trip AND kind ~* 'challan|penal|fine';
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'ref', x.ref, 'date', x.dated, 'amount', x.amount, 'note', x.note) ORDER BY x.dated), '[]'::jsonb) INTO v_lines
    FROM (SELECT 'ADVANCE' AS kind, dt.id::text AS ref, dt.txn_date AS dated, dt.amount, dt.remarks AS note FROM driver_transactions dt WHERE dt.trip_id = p_trip AND dt.txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN') AND coalesce(dt.approval_status, 'APPROVED') <> 'REJECTED'
          UNION ALL SELECT 'SHORTAGE', t.trip_code, t.unloading_date, v_short, format('%s KL short × %s%% recovery', t.shortage_qty, coalesce(p_pct, 100)) WHERE v_short > 0
          UNION ALL SELECT 'CHALLAN', e.id::text, e.dated, e.amount, e.label FROM trip_expense_entries e WHERE e.trip_id = p_trip AND e.kind ~* 'challan|penal|fine') x;
  advances := v_adv; shortage := v_short; challans := v_chal; lines := v_lines;
  RETURN NEXT;
END $$;

-- Compute (or recompute) the settlement of one completed trip. Idempotent
-- while DRAFT/BLOCKED; a POSTED/PAID row is never touched.
CREATE OR REPLACE FUNCTION driver_trip_settle(p_trip uuid, p_by text DEFAULT 'system') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t record; p record; k record; d record; v_id uuid; v_status text; v_no text;
        rem numeric; a_short numeric; a_chal numeric; a_adv numeric; v_net numeric; v_carry numeric; v_total numeric;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip;
  IF t.id IS NULL OR t.status NOT IN ('COMPLETED','SETTLED') THEN RETURN NULL; END IF;
  SELECT id, status INTO v_id, v_status FROM driver_trip_settlements WHERE trip_id = p_trip;
  IF v_status IN ('POSTED','PAID','CANCELLED') THEN RETURN v_id; END IF;
  SELECT * INTO p FROM driver_trip_pay(p_trip);
  IF p.driver_name IS NULL THEN RETURN NULL; END IF;
  IF p.pay_model = 'MONTHLY' THEN
    -- a salaried driver's trip never becomes an instant settlement
    DELETE FROM driver_trip_settlements WHERE trip_id = p_trip AND status IN ('DRAFT','BLOCKED');
    RETURN NULL;
  END IF;
  SELECT * INTO d FROM drivers WHERE id = p.driver_id;
  SELECT * INTO k FROM driver_trip_korki(p_trip, coalesce(d.shortage_recovery_pct, 100));
  v_total := coalesce(k.advances, 0) + coalesce(k.shortage, 0) + coalesce(k.challans, 0);
  -- priority: shortage, then challans, then advances — losses first, the asset waits
  rem := coalesce(p.earning, 0);
  a_short := least(rem, coalesce(k.shortage, 0)); rem := rem - a_short;
  a_chal := least(rem, coalesce(k.challans, 0)); rem := rem - a_chal;
  a_adv := least(rem, coalesce(k.advances, 0)); rem := rem - a_adv;
  v_net := rem; v_carry := v_total - (a_short + a_chal + a_adv);
  v_status := CASE WHEN p.reason IS NOT NULL THEN 'BLOCKED' ELSE 'DRAFT' END;
  IF v_id IS NULL THEN
    v_no := 'DTS-' || lpad(nextval('driver_trip_settlement_seq')::text, 6, '0');
    INSERT INTO driver_trip_settlements (settlement_no, trip_id, trip_code, driver_id, driver_name, company_id, vehicle_no, completed_at, basis, rate, freight, rtkm, earning,
                                         korki_advances, korki_shortage, korki_challans, korki_total, applied_shortage, applied_challans, applied_advances, net_payable, carry_forward, status, block_reason, lines, created_by)
    VALUES (v_no, p_trip, t.trip_code, p.driver_id, p.driver_name, coalesce(d.pay_company_id, t.company_id), t.vehicle_no, coalesce(t.completed_at, t.unloading_date::timestamptz, now()), p.basis, p.rate, p.freight, p.rtkm, coalesce(p.earning, 0),
            k.advances, k.shortage, k.challans, v_total, a_short, a_chal, a_adv, v_net, v_carry, v_status, p.reason, k.lines, p_by)
    RETURNING id INTO v_id;
  ELSE
    UPDATE driver_trip_settlements
       SET driver_id = p.driver_id, driver_name = p.driver_name, company_id = coalesce(d.pay_company_id, t.company_id), vehicle_no = t.vehicle_no, trip_code = t.trip_code,
           completed_at = coalesce(t.completed_at, t.unloading_date::timestamptz, completed_at), basis = p.basis, rate = p.rate, freight = p.freight, rtkm = p.rtkm, earning = coalesce(p.earning, 0),
           korki_advances = k.advances, korki_shortage = k.shortage, korki_challans = k.challans, korki_total = v_total,
           applied_shortage = a_short, applied_challans = a_chal, applied_advances = a_adv, net_payable = v_net, carry_forward = v_carry,
           status = v_status, block_reason = p.reason, lines = k.lines, updated_at = now()
     WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

-- The moment a trip completes, its settlement exists. Never fails the trip.
CREATE OR REPLACE FUNCTION trips_instant_settlement() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM driver_trip_settle(NEW.id, 'trip completed');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'instant settlement for trip % skipped: %', NEW.trip_code, SQLERRM;
  END;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trips_instant_settlement ON trips;
CREATE TRIGGER trips_instant_settlement AFTER UPDATE OF status, shortage_penalty, fixed_cash, freight_amount, billed_amount ON trips
  FOR EACH ROW WHEN (NEW.status IN ('COMPLETED','SETTLED')) EXECUTE FUNCTION trips_instant_settlement();

-- Re-settle every open draft of a driver (after a pay change or a new advance).
CREATE OR REPLACE FUNCTION driver_resettle_open(p_driver uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT t.id FROM trips t WHERE t.status IN ('COMPLETED','SETTLED') AND driver_of_trip(t.id) = p_driver
             AND NOT EXISTS (SELECT 1 FROM driver_trip_settlements s WHERE s.trip_id = t.id AND s.status IN ('POSTED','PAID','CANCELLED'))
             AND t.loading_date >= DATE '2026-04-01'
  LOOP PERFORM driver_trip_settle(r.id, 'resettle'); n := n + 1; END LOOP;
  RETURN n;
END $$;

-- ═══ 5. MONTHLY PAYROLL RUNS ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payroll_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no             text UNIQUE,
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  period             text NOT NULL,                       -- YYYY-MM
  kind               text NOT NULL CHECK (kind IN ('DRIVER','STAFF')),
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','PAID','CANCELLED')),
  persons            int NOT NULL DEFAULT 0,
  gross_total        numeric(14,2) NOT NULL DEFAULT 0,
  deductions_total   numeric(14,2) NOT NULL DEFAULT 0,
  net_total          numeric(14,2) NOT NULL DEFAULT 0,
  built_at           timestamptz,
  posted_at          timestamptz,
  posted_by          text,
  journal_voucher_id uuid,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period, kind)
);
CREATE TABLE IF NOT EXISTS payroll_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  person_kind        text NOT NULL CHECK (person_kind IN ('DRIVER','STAFF','PARTNER')),
  person_id          uuid NOT NULL,
  person_name        text NOT NULL,
  gross              numeric(14,2) NOT NULL DEFAULT 0,
  deduct_advances    numeric(14,2) NOT NULL DEFAULT 0,
  deduct_shortage    numeric(14,2) NOT NULL DEFAULT 0,
  deduct_challans    numeric(14,2) NOT NULL DEFAULT 0,
  deduct_other       numeric(14,2) NOT NULL DEFAULT 0,
  deductions_total   numeric(14,2) NOT NULL DEFAULT 0,
  net_payable        numeric(14,2) NOT NULL DEFAULT 0,
  carry_forward      numeric(14,2) NOT NULL DEFAULT 0,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','PAID','SKIPPED')),
  note               text,
  payment_voucher_id uuid,
  paid_via           text,
  paid_on            date,
  paid_by            text,
  edited_by          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, person_kind, person_id)
);

-- The driver's running account (positive = the driver owes us, negative = we
-- owe the driver): cash given, shortage charged and pay handed over are
-- debits; what the driver earned is the credit.
CREATE OR REPLACE FUNCTION driver_khata_balance(p_driver uuid, p_name text, p_asof date DEFAULT current_date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(CASE WHEN txn_type = 'SALARY_CREDIT' THEN -amount ELSE amount END), 0)
    FROM driver_transactions
   WHERE (driver_id = p_driver OR (driver_id IS NULL AND norm_person_name(driver_name) = norm_person_name(p_name)))
     AND txn_date <= p_asof AND coalesce(approval_status, 'APPROVED') <> 'REJECTED' $$;

CREATE OR REPLACE FUNCTION payroll_run_build(p_company uuid, p_period text, p_kind text, p_by text DEFAULT 'system') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; v_status text; r record; p_from date; p_to date; v_no text; v_prefix text;
        g numeric; adv numeric; sh numeric; ch numeric; rem numeric; a_adv numeric; a_sh numeric; a_ch numeric; v_net numeric; v_carry numeric; v_detail jsonb;
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'period must be YYYY-MM'; END IF;
  p_from := to_date(p_period || '-01', 'YYYY-MM-DD'); p_to := (p_from + interval '1 month' - interval '1 day')::date;
  SELECT id, status INTO v_run, v_status FROM payroll_runs WHERE company_id = p_company AND period = p_period AND kind = p_kind;
  IF v_status IN ('POSTED','PAID') THEN RETURN v_run; END IF;
  IF v_run IS NULL THEN
    SELECT coalesce(gst_invoice_prefix, gst_firm_code(company_name)) INTO v_prefix FROM companies WHERE id = p_company;
    v_no := 'PR-' || replace(p_period, '-', '') || '-' || coalesce(v_prefix, 'FIRM') || '-' || left(p_kind, 1);
    INSERT INTO payroll_runs (run_no, company_id, period, kind, status, built_at) VALUES (v_no, p_company, p_period, p_kind, 'DRAFT', now()) RETURNING id INTO v_run;
  END IF;
  -- lines a person has not edited are rebuilt; edited ones keep their numbers
  DELETE FROM payroll_lines WHERE run_id = v_run AND edited_by IS NULL AND status = 'DRAFT';
  IF p_kind = 'DRIVER' THEN
    FOR r IN SELECT d.* FROM drivers d
              WHERE d.pay_model = 'MONTHLY' AND d.status::text = 'ACTIVE'
                AND coalesce(d.pay_company_id, (SELECT v.company_id FROM vehicle_assignments va JOIN vehicles v ON v.id = va.vehicle_id WHERE va.driver_id = d.id AND va.released_at IS NULL ORDER BY va.assigned_at DESC LIMIT 1)) = p_company
                AND NOT EXISTS (SELECT 1 FROM payroll_lines l WHERE l.run_id = v_run AND l.person_kind = 'DRIVER' AND l.person_id = d.id)
    LOOP
      g := coalesce(r.monthly_salary, 0);
      adv := greatest(driver_khata_balance(r.id, r.name, p_to), 0);
      SELECT coalesce(sum(greatest(round(coalesce(t.shortage_penalty, 0) * coalesce(r.shortage_recovery_pct, 100) / 100.0, 2) - coalesce((SELECT sum(x.amount) FROM driver_transactions x WHERE x.trip_id = t.id AND x.txn_type = 'SHORTAGE_RECOVERY'), 0), 0)), 0)
        INTO sh FROM trips t WHERE driver_of_trip(t.id) = r.id AND t.unloading_date BETWEEN p_from AND p_to AND t.status IN ('COMPLETED','SETTLED');
      SELECT coalesce(sum(e.amount), 0) INTO ch FROM trip_expense_entries e JOIN trips t ON t.id = e.trip_id WHERE driver_of_trip(t.id) = r.id AND e.dated BETWEEN p_from AND p_to AND e.kind ~* 'challan|penal|fine';
      rem := g; a_sh := least(rem, sh); rem := rem - a_sh; a_ch := least(rem, ch); rem := rem - a_ch; a_adv := least(rem, adv); rem := rem - a_adv;
      v_net := rem; v_carry := (adv + sh + ch) - (a_sh + a_ch + a_adv);
      v_detail := jsonb_build_object('salary', g, 'khata_balance', adv, 'shortage_due', sh, 'challans_due', ch, 'basis', 'monthly salary');
      INSERT INTO payroll_lines (run_id, person_kind, person_id, person_name, gross, deduct_advances, deduct_shortage, deduct_challans, deductions_total, net_payable, carry_forward, detail, note)
      VALUES (v_run, 'DRIVER', r.id, r.name, g, a_adv, a_sh, a_ch, a_adv + a_sh + a_ch, v_net, v_carry, v_detail, CASE WHEN g <= 0 THEN 'monthly salary not set' END);
    END LOOP;
  ELSE
    FOR r IN SELECT s.* FROM staff_members s WHERE s.company_id = p_company AND s.status = 'ACTIVE'
                AND NOT EXISTS (SELECT 1 FROM payroll_lines l WHERE l.run_id = v_run AND l.person_kind = s.kind AND l.person_id = s.id)
    LOOP
      g := coalesce(r.monthly_amount, 0);
      -- advances still outstanding: cash given (advance or pay) less what the person earned
      SELECT coalesce(sum(CASE WHEN txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN') THEN amount WHEN txn_type = 'SALARY_CREDIT' THEN -amount ELSE 0 END), 0)
        INTO adv FROM staff_transactions WHERE staff_id = r.id AND txn_date <= p_to;
      adv := greatest(adv, 0);
      SELECT coalesce(sum(amount), 0) INTO ch FROM staff_transactions WHERE staff_id = r.id AND txn_type = 'OTHER_DEDUCTION' AND txn_date BETWEEN p_from AND p_to;
      rem := g; a_ch := least(rem, ch); rem := rem - a_ch; a_adv := least(rem, adv); rem := rem - a_adv;
      v_net := rem; v_carry := (adv + ch) - (a_adv + a_ch);
      v_detail := jsonb_build_object(CASE WHEN r.kind = 'PARTNER' THEN 'remuneration' ELSE 'salary' END, g, 'advances_outstanding', adv, 'other_deductions', ch, 'role', r.role_title);
      INSERT INTO payroll_lines (run_id, person_kind, person_id, person_name, gross, deduct_advances, deduct_other, deductions_total, net_payable, carry_forward, detail, note)
      VALUES (v_run, r.kind, r.id, r.name, g, a_adv, a_ch, a_adv + a_ch, v_net, v_carry, v_detail, CASE WHEN g <= 0 THEN 'amount not set' END);
    END LOOP;
  END IF;
  UPDATE payroll_runs pr SET persons = x.n, gross_total = x.g, deductions_total = x.d, net_total = x.nt, built_at = now(), updated_at = now()
    FROM (SELECT count(*) AS n, coalesce(sum(gross), 0) AS g, coalesce(sum(deductions_total), 0) AS d, coalesce(sum(net_payable), 0) AS nt FROM payroll_lines WHERE run_id = v_run AND status <> 'SKIPPED') x
   WHERE pr.id = v_run;
  RETURN v_run;
END $$;

-- ═══ 6. WHAT IS READY FOR THE CASHIER ═════════════════════════════════════
CREATE OR REPLACE VIEW v_payables_for_disbursal AS
SELECT 'TRIP'::text AS source, s.id AS ref_id, s.settlement_no AS ref_no, s.company_id, 'DRIVER'::text AS person_kind, s.driver_id AS person_id, s.driver_name AS person_name,
       'Driver Payable: ' || s.driver_name AS payable_ledger, s.net_payable AS amount, s.posted_at, s.trip_code AS about, s.vehicle_no
  FROM driver_trip_settlements s WHERE s.status = 'POSTED' AND s.net_payable > 0
UNION ALL
SELECT 'MONTHLY', l.id, r.run_no || '/' || l.person_name, r.company_id, l.person_kind, l.person_id, l.person_name,
       CASE l.person_kind WHEN 'DRIVER' THEN 'Driver Payable: ' WHEN 'PARTNER' THEN 'Remuneration Payable: ' ELSE 'Salary Payable: ' END || l.person_name, l.net_payable, r.posted_at, r.period, NULL
  FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.status = 'POSTED' AND l.net_payable > 0;

CREATE OR REPLACE VIEW v_payroll_overview AS
SELECT c.id AS company_id, c.company_name,
       (SELECT count(*)::int FROM drivers d WHERE d.pay_model = 'TRIP') AS drivers_trip,
       (SELECT count(*)::int FROM drivers d WHERE d.pay_model = 'MONTHLY') AS drivers_monthly,
       (SELECT count(*)::int FROM drivers d WHERE d.pay_model IS NULL AND d.status::text = 'ACTIVE') AS drivers_unconfigured,
       (SELECT count(*)::int FROM driver_trip_settlements s WHERE s.company_id = c.id AND s.status = 'BLOCKED') AS trip_blocked,
       (SELECT count(*)::int FROM driver_trip_settlements s WHERE s.company_id = c.id AND s.status = 'DRAFT') AS trip_drafts,
       (SELECT coalesce(sum(net_payable), 0)::numeric(14,2) FROM driver_trip_settlements s WHERE s.company_id = c.id AND s.status = 'DRAFT') AS trip_draft_net,
       (SELECT coalesce(sum(net_payable), 0)::numeric(14,2) FROM driver_trip_settlements s WHERE s.company_id = c.id AND s.status = 'POSTED') AS trip_posted_unpaid,
       (SELECT coalesce(sum(net_payable), 0)::numeric(14,2) FROM driver_trip_settlements s WHERE s.company_id = c.id AND s.status = 'PAID' AND s.paid_on >= date_trunc('month', current_date)) AS trip_paid_this_month,
       (SELECT coalesce(sum(amount), 0)::numeric(14,2) FROM v_payables_for_disbursal p WHERE p.company_id = c.id) AS ready_for_disbursal,
       (SELECT count(*)::int FROM v_payables_for_disbursal p WHERE p.company_id = c.id) AS ready_count,
       (SELECT count(*)::int FROM staff_members s WHERE s.company_id = c.id AND s.status = 'ACTIVE' AND s.kind = 'STAFF') AS staff_active,
       (SELECT count(*)::int FROM staff_members s WHERE s.company_id = c.id AND s.status = 'ACTIVE' AND s.kind = 'PARTNER') AS partners_active,
       (SELECT coalesce(sum(monthly_amount), 0)::numeric(14,2) FROM staff_members s WHERE s.company_id = c.id AND s.status = 'ACTIVE') AS staff_monthly_total
  FROM companies c;

-- ═══ 7. EXCEPTIONS + DEEP AUDIT ═══════════════════════════════════════════
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH',
  'BANK_UNMATCHED','BANK_BOOK_NOT_IN_BANK',
  'TDS_PAN_MISSING','TDS_DEPOSIT_DUE','TDS_RETURN_DUE','TDS_26AS_MISMATCH','TDS_TAN_MISSING',
  'GST_GSTIN_MISSING','GST_CUSTOMER_GSTIN_MISSING','GST_RETURN_DUE','GST_ITC_INVOICE_MISSING','GST_DOC_ATTENTION','GST_BOOKS_MISMATCH',
  'PAYROLL_UNCONFIGURED','PAYROLL_BLOCKED','PAYROLL_KHATA_MISMATCH','PAYROLL_RUN_DUE']));

CREATE TABLE IF NOT EXISTS payroll_audit_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ran_at timestamptz NOT NULL DEFAULT now(), ran_by text, summary jsonb NOT NULL);

-- Links what the khata says to what the ledger holds, per driver; settles
-- every open completed trip under its driver's model; reports, never moves.
CREATE OR REPLACE FUNCTION payroll_deep_audit(p_by text DEFAULT 'system') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb; v_settled int := 0; r record; v_khata jsonb; v_drivers jsonb; v_pool numeric; v_open jsonb; v_dups jsonb;
BEGIN
  FOR r IN SELECT t.id FROM trips t WHERE t.status IN ('COMPLETED','SETTLED') AND t.loading_date >= DATE '2026-04-01'
             AND NOT EXISTS (SELECT 1 FROM driver_trip_settlements s WHERE s.trip_id = t.id AND s.status IN ('POSTED','PAID','CANCELLED'))
  LOOP PERFORM driver_trip_settle(r.id, p_by); v_settled := v_settled + 1; END LOOP;
  SELECT jsonb_build_object('total', count(*), 'trip', count(*) FILTER (WHERE pay_model = 'TRIP'), 'monthly', count(*) FILTER (WHERE pay_model = 'MONTHLY'),
                            'unconfigured', count(*) FILTER (WHERE pay_model IS NULL),
                            'unconfigured_with_trips', count(*) FILTER (WHERE pay_model IS NULL AND EXISTS (SELECT 1 FROM trips t WHERE driver_of_trip(t.id) = d.id AND t.status IN ('COMPLETED','SETTLED') AND t.loading_date >= DATE '2026-04-01')))
    INTO v_drivers FROM drivers d;
  SELECT coalesce(jsonb_agg(jsonb_build_object('driver', x.name, 'khata', x.khata, 'ledger', x.ledger, 'ledgers', x.ledgers, 'diff', x.diff) ORDER BY abs(x.diff) DESC), '[]'::jsonb) INTO v_khata
    FROM (SELECT d.name, driver_khata_balance(d.id, d.name) AS khata,
                 coalesce((SELECT sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END) FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
                            WHERE l.group_head = 'Current Assets - Driver Advances' AND norm_person_name(regexp_replace(l.ledger_name, '^Driver Advance:\s*', '')) = norm_person_name(d.name)), 0) AS ledger,
                 (SELECT array_agg(DISTINCT l.ledger_name) FROM ledgers l WHERE l.group_head = 'Current Assets - Driver Advances' AND norm_person_name(regexp_replace(l.ledger_name, '^Driver Advance:\s*', '')) = norm_person_name(d.name)) AS ledgers,
                 driver_khata_balance(d.id, d.name) - coalesce((SELECT sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END) FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
                            WHERE l.group_head = 'Current Assets - Driver Advances' AND norm_person_name(regexp_replace(l.ledger_name, '^Driver Advance:\s*', '')) = norm_person_name(d.name)), 0) AS diff
            FROM drivers d) x
   WHERE abs(x.diff) > 1;
  SELECT coalesce(sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0) INTO v_pool FROM ledger_entries e WHERE e.ledger_name = 'Driver Advance (Pump Cash)';
  SELECT jsonb_build_object('blocked', count(*) FILTER (WHERE status = 'BLOCKED'), 'drafts', count(*) FILTER (WHERE status = 'DRAFT'), 'draft_net', coalesce(sum(net_payable) FILTER (WHERE status = 'DRAFT'), 0),
                            'posted_unpaid', coalesce(sum(net_payable) FILTER (WHERE status = 'POSTED'), 0),
                            'block_reasons', (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT block_reason AS k, count(*) AS n FROM driver_trip_settlements WHERE status = 'BLOCKED' GROUP BY 1) b))
    INTO v_open FROM driver_trip_settlements;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', n, 'ledgers', ls) ORDER BY n), '[]'::jsonb) INTO v_dups
    FROM (SELECT norm_person_name(regexp_replace(l.ledger_name, '^Driver Advance:\s*', '')) AS n, array_agg(l.ledger_name) AS ls FROM ledgers l WHERE l.group_head = 'Current Assets - Driver Advances' GROUP BY 1 HAVING count(*) > 1) q;
  v := jsonb_build_object('ran_at', now(), 'drivers', v_drivers, 'trips_settled_now', v_settled, 'open', v_open, 'khata_vs_ledger', v_khata,
                          'pooled_pump_cash_unattributed', v_pool, 'duplicate_advance_ledgers', v_dups);
  INSERT INTO payroll_audit_runs (ran_by, summary) VALUES (p_by, v);
  RETURN v;
END $$;

-- ═══ 8. FIRST DEEP AUDIT (no driver has a model yet → everything BLOCKED, visibly) ═══
SELECT payroll_deep_audit('migration 174');
