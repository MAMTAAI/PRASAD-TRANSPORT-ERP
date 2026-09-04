-- ═══════════════════════════════════════════════════════════════════════════
-- 149_trip_expense_truth.sql — ONE TRIP, ITS OWN EXPENSES, BY TYPE
--
-- Owner, 4-Sep-2026: "type wise expense management ho — HSD / toll tax / trip
-- expenses — trip ke saath map kiya jaye taaki us trip ka profit-loss pata lag
-- sake aur account mein bhi clean rahe ... koi trip ka expense dusray trip may
-- na jaye ... deep audit karke system ko globally fix karay."
--
-- ── WHAT THE AUDIT FOUND ────────────────────────────────────────────────────
--
-- `trips.total_expense` is an ACCUMULATOR. Four places do
-- `total_expense = COALESCE(total_expense,0) + x` and nothing ever subtracts:
--
--   1. ops.routes  POST /trips/:id/driver-txn   adds the DRIVER ADVANCE.
--      tripMath.getTripExpense() says in its own comment that it "NEVER
--      includes recoverable cash advances — those are driver-khata assets, not
--      expenses". The write and the read disagree, and the write wins.
--   2. ops.routes  POST /trips/:id/fuel-slip    adds `amount + cash`, where
--      `cash` is the pump cash handed to the driver — which the same statement
--      also inserts into driver_transactions as an ADVANCE. The one rupee is an
--      expense AND a recoverable advance at the same time.
--   3. queues      fuel-bill verification       adds the delta. Correct, but it
--      is the only one of the four that ever moves the number down.
--   4. queues      expense approval             adds an approved bill.
--
--   · PATCH /fuel-entries/:id may correct an UNBILLED slip's `amount` and does
--     NOT adjust the trip. A slip fixed from 50,000 to 5,000 leaves 45,000 of
--     expense on that trip for ever.
--   · TOLL NEVER ENTERS AT ALL. getTripExpense() returns the stored number when
--     it is > 0 and only falls back to fuel+toll when it is 0 — and after any
--     advance or slip it is > 0. So on a live trip the tolls are silently
--     dropped from the P&L.
--   · A VENDOR'S BILL ARRIVES WITH NO TRIP. vendorPortal's insert into
--     partner_documents carries a vehicle and no trip_id at all, so a pump or
--     tyre bill is attached to a LORRY and a human decides the trip. The
--     dispatch board already shows lorries with "2 OPEN" trips. That is exactly
--     "koi trip ka expense dusray trip may chala jaye".
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
--
-- DERIVES, RATHER THAN ACCUMULATES. A trip's expenses are the rows that carry
-- its trip_id: fuel slips, toll crossings, approved bills. A view over those
-- cannot drift, cannot double-count an edit, and cannot forget a delete —
-- because there is nothing to keep in step. queues.routes already wrote the
-- reasoning down in a comment: "the per-fuel breakdown is derivable from
-- fuel_entries.trip_id, which is a better answer than a denormalised counter
-- that can drift from it." This is that answer, for every type.
--
-- `trips.total_expense` IS LEFT ALONE. It is written by four routes and read by
-- three dashboards; ripping it out in the same change that introduces the truth
-- would mean two risky things at once. It becomes what it always was — a cache
-- — and v_trip_expense_drift measures how far it has wandered, per trip, in
-- rupees. The screens move to the view; the column is retired after the drift
-- report has been looked at with real numbers in it.
--
-- AN ADVANCE IS NOT AN EXPENSE. Cash to the driver and cash at the pump are
-- money we are owed back. They are reported here, in their own column, never
-- inside the expense total. That is the single rule the old accumulator broke.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── Vehicle registrations are typed by four different people ────────────────
-- "AS 26C 9804", "AS26C9804", "as 26c 9804" are one lorry. Every comparison
-- below goes through this, so a mismatch flagged by the audit is a real
-- mismatch and not a spacing difference.
CREATE OR REPLACE FUNCTION reg_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT nullif(regexp_replace(upper(COALESCE(p, '')), '[^A-Z0-9]', '', 'g'), '') $$;

-- ═══ 1. EVERY RUPEE THAT BELONGS TO A TRIP, ONE ROW EACH ═══════════════════
--
-- `kind` separates the two things the old column confused:
--   EXPENSE  — money gone. It is in the trip's P&L.
--   ADVANCE  — money handed over that is owed back. It is in the driver's
--              khata, and it is NOT in the P&L.
--
-- `source` says which register the row came from, so a figure on screen can
-- always be opened and looked at.
CREATE OR REPLACE VIEW v_trip_expense_lines AS
  -- Diesel, from the fuel register. `amount` is the diesel value; the cash the
  -- pump handed the driver rides on the same slip and is an ADVANCE, below.
  SELECT f.trip_id,
         'EXPENSE'::text        AS kind,
         'HSD'::text            AS expense_type,
         'FUEL_SLIP'::text      AS source,
         f.id                   AS source_id,
         f.entry_date           AS dated,
         f.vehicle_no,
         COALESCE(f.amount, 0)::numeric(14,2) AS amount,
         COALESCE(f.memo_no, '') AS ref,
         f.vendor_name          AS party
    FROM fuel_entries f
   WHERE f.trip_id IS NOT NULL

  UNION ALL
  -- The pump cash. Recoverable, so it is an ADVANCE and never an expense.
  SELECT f.trip_id, 'ADVANCE', 'PUMP_CASH', 'FUEL_SLIP', f.id, f.entry_date,
         f.vehicle_no, COALESCE(f.cash_given_to_pump, 0)::numeric(14,2),
         COALESCE(f.memo_no, ''), f.vendor_name
    FROM fuel_entries f
   WHERE f.trip_id IS NOT NULL AND COALESCE(f.cash_given_to_pump, 0) <> 0

  UNION ALL
  -- Toll, from the FASTag register. The old P&L dropped these entirely.
  SELECT tx.trip_id, 'EXPENSE', 'TOLL', 'FASTAG', tx.id,
         COALESCE(tx.txn_date, tx.txn_datetime::date), tx.vehicle_no,
         COALESCE(tx.amount, 0)::numeric(14,2),
         COALESCE(tx.plaza_name, ''), NULL
    FROM toll_transactions tx
   WHERE tx.trip_id IS NOT NULL

  UNION ALL
  -- Approved bills: tyres, repairs, and anything else that arrived on paper.
  -- PENDING and REJECTED are deliberately absent — an expense enters the P&L
  -- when somebody approves it, not when it is photographed.
  SELECT e.trip_id, 'EXPENSE', upper(e.expense_type), 'BILL', e.id,
         COALESCE(e.bill_date, e.created_at::date), e.vehicle_no,
         COALESCE(e.amount, 0)::numeric(14,2),
         COALESCE(e.bill_no, ''), e.vendor_name
    FROM expense_approvals e
   WHERE e.trip_id IS NOT NULL AND e.status = 'APPROVED'

  UNION ALL
  -- Cash and bank paid to the driver against this trip. Owed back, so ADVANCE.
  -- SHORTAGE_RECOVERY comes back the other way and is netted here rather than
  -- being shown as a negative advance nobody can read.
  SELECT d.trip_id, 'ADVANCE', 'DRIVER_CASH', 'DRIVER_TXN', d.id, d.txn_date,
         NULL,
         (CASE WHEN d.txn_type = 'SHORTAGE_RECOVERY' THEN -1 ELSE 1 END
          * COALESCE(d.amount, 0))::numeric(14,2),
         COALESCE(d.mode, ''), d.driver_name
    FROM driver_transactions d
   WHERE d.trip_id IS NOT NULL
     AND COALESCE(d.txn_type, '') <> 'FUEL_EXPENSE';   -- diesel is in the fuel register already

COMMENT ON VIEW v_trip_expense_lines IS
  'Every rupee that carries a trip_id, one row each, split EXPENSE vs ADVANCE. '
  'Derived — it cannot drift from the registers the way trips.total_expense does.';

-- ═══ 2. THE TRIP'S PROFIT AND LOSS, BY TYPE ════════════════════════════════
--
-- Revenue is freight_amount: what the customer is billed. Expenses are the
-- lines above, pivoted by type so the answer to "kis cheez mein gaya" is on the
-- same row as the total. Advances sit beside the profit, never inside it.
CREATE OR REPLACE VIEW v_trip_pnl AS
SELECT t.id                                  AS trip_id,
       t.trip_code,
       t.vehicle_no,
       t.driver_name,
       t.operating_company,
       t.status,
       t.loading_date,
       t.unloading_date,
       t.customer_name,
       COALESCE(t.freight_amount, 0)::numeric(14,2)  AS freight,

       COALESCE(x.hsd, 0)::numeric(14,2)             AS hsd,
       COALESCE(x.toll, 0)::numeric(14,2)            AS toll,
       COALESCE(x.tyre, 0)::numeric(14,2)            AS tyre,
       COALESCE(x.maintenance, 0)::numeric(14,2)     AS maintenance,
       COALESCE(x.other, 0)::numeric(14,2)           AS other,
       COALESCE(x.expense, 0)::numeric(14,2)         AS expense_total,

       COALESCE(t.shortage_penalty, 0)::numeric(14,2) AS shortage_penalty,

       -- What the trip actually earned. Penalty is a recovery from the driver
       -- and reduces what the trip cost us, so it is subtracted from expense
       -- rather than added to revenue — the two are not the same story.
       (COALESCE(t.freight_amount, 0)
        - COALESCE(x.expense, 0)
        + COALESCE(t.shortage_penalty, 0))::numeric(14,2) AS profit,

       -- Money out that is owed back. Beside the profit, never inside it.
       COALESCE(x.advance, 0)::numeric(14,2)         AS advances,

       COALESCE(x.lines, 0)::int                     AS expense_lines,
       -- The cache, and how far it has wandered. Positive = the stored number
       -- claims more expense than the registers can account for.
       COALESCE(t.total_expense, 0)::numeric(14,2)   AS stored_total_expense,
       (COALESCE(t.total_expense, 0) - COALESCE(x.expense, 0))::numeric(14,2) AS drift
  FROM trips t
  LEFT JOIN LATERAL (
    SELECT sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'HSD')          AS hsd,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'TOLL')         AS toll,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'TYRE')         AS tyre,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'MAINTENANCE')  AS maintenance,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE'
                                   AND l.expense_type NOT IN ('HSD','TOLL','TYRE','MAINTENANCE')) AS other,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE')                                     AS expense,
           sum(l.amount) FILTER (WHERE l.kind = 'ADVANCE')                                     AS advance,
           count(*)      FILTER (WHERE l.kind = 'EXPENSE')                                     AS lines
      FROM v_trip_expense_lines l
     WHERE l.trip_id = t.id) x ON true;

COMMENT ON VIEW v_trip_pnl IS
  'Per-trip P&L, type-wise, derived from the registers. Advances are reported '
  'separately because they are recoverable and are not expenses.';

-- ═══ 3. THE AUDIT — WHERE A RUPEE IS ON THE WRONG TRIP, OR ON NONE ═════════
--
-- This is the "deep audit" made permanent rather than run once. Every finding
-- is a row a person can act on; nothing here is corrected automatically, which
-- is the standing rule for data faults in this system.
CREATE OR REPLACE VIEW v_trip_expense_audit AS
-- A bill nobody attached to a trip. It is in the books and in no trip's P&L.
SELECT 'ORPHAN_BILL'::text        AS finding,
       'BILL'::text               AS source,
       e.id                       AS source_id,
       NULL::uuid                 AS trip_id,
       NULL::text                 AS trip_code,
       e.vehicle_no,
       e.expense_type,
       COALESCE(e.amount, 0)::numeric(14,2) AS amount,
       COALESCE(e.bill_date, e.created_at::date) AS dated,
       ('approved bill with no trip — it is in the ledger and in no trip P&L'
        || COALESCE(' · ' || e.trip_ref, ''))::text AS detail
  FROM expense_approvals e
 WHERE e.status = 'APPROVED' AND e.trip_id IS NULL

UNION ALL
-- A diesel slip with no trip: the fuel is in the vehicle's history and nowhere
-- in any P&L.
SELECT 'ORPHAN_FUEL', 'FUEL_SLIP', f.id, NULL, NULL, f.vehicle_no, 'HSD',
       COALESCE(f.amount, 0), f.entry_date,
       'fuel slip with no trip — this diesel is in no trip P&L'
  FROM fuel_entries f
 WHERE f.trip_id IS NULL AND COALESCE(f.amount, 0) > 0

UNION ALL
-- A toll crossing with no trip.
SELECT 'ORPHAN_TOLL', 'FASTAG', tx.id, NULL, NULL, tx.vehicle_no, 'TOLL',
       COALESCE(tx.amount, 0), COALESCE(tx.txn_date, tx.txn_datetime::date),
       'toll crossing not linked to a trip'
  FROM toll_transactions tx
 WHERE tx.trip_id IS NULL AND COALESCE(tx.amount, 0) > 0

UNION ALL
-- THE ONE THE OWNER NAMED: an expense sitting on a trip that belongs to a
-- DIFFERENT LORRY. This is a wrong-trip attachment, not a spelling difference —
-- both registrations are normalised before they are compared.
SELECT 'WRONG_VEHICLE', l.source, l.source_id, l.trip_id, t.trip_code,
       l.vehicle_no, l.expense_type, l.amount, l.dated,
       format('this %s is on trip %s, which ran %s', lower(l.expense_type),
              t.trip_code, t.vehicle_no)
  FROM v_trip_expense_lines l
  JOIN trips t ON t.id = l.trip_id
 WHERE l.kind = 'EXPENSE'
   AND reg_key(l.vehicle_no) IS NOT NULL
   AND reg_key(t.vehicle_no) IS NOT NULL
   AND reg_key(l.vehicle_no) <> reg_key(t.vehicle_no)

UNION ALL
-- A bill dated outside the trip it is attached to. Not automatically wrong —
-- paper arrives late — but on a lorry with two open trips it is the shape a
-- misfiled expense takes, so it is put in front of a person.
SELECT 'DATE_OUTSIDE_TRIP', l.source, l.source_id, l.trip_id, t.trip_code,
       l.vehicle_no, l.expense_type, l.amount, l.dated,
       format('dated %s; trip ran %s to %s', l.dated, t.loading_date,
              COALESCE(t.unloading_date::text, 'open'))
  FROM v_trip_expense_lines l
  JOIN trips t ON t.id = l.trip_id
 WHERE l.kind = 'EXPENSE'
   AND l.dated IS NOT NULL
   AND t.loading_date IS NOT NULL
   AND (l.dated < t.loading_date - interval '2 days'
        OR (t.unloading_date IS NOT NULL AND l.dated > t.unloading_date + interval '10 days'))

UNION ALL
-- The same diesel entered twice: once as a fuel slip and once as an approved
-- HSD bill. Both are real registers, and a trip that has both is very likely
-- carrying the fuel twice.
SELECT 'FUEL_TWICE', 'BILL', e.id, e.trip_id, t.trip_code, e.vehicle_no, 'HSD',
       COALESCE(e.amount, 0), COALESCE(e.bill_date, e.created_at::date),
       'an approved FUEL bill on a trip that also has fuel slips — check for a double count'
  FROM expense_approvals e
  JOIN trips t ON t.id = e.trip_id
 WHERE e.status = 'APPROVED'
   AND upper(e.expense_type) IN ('FUEL', 'HSD')
   AND EXISTS (SELECT 1 FROM fuel_entries f WHERE f.trip_id = e.trip_id AND COALESCE(f.amount,0) > 0)

UNION ALL
-- The cache against the registers. Where these disagree, one of the screens
-- reading the cache is showing a number nothing can explain.
SELECT 'STORED_DRIFT', 'TRIP', p.trip_id, p.trip_id, p.trip_code, p.vehicle_no,
       'TOTAL', p.drift, p.loading_date,
       format('trips.total_expense says %s, the registers add to %s',
              p.stored_total_expense, p.expense_total)
  FROM v_trip_pnl p
 WHERE abs(p.drift) > 1;

COMMENT ON VIEW v_trip_expense_audit IS
  'Every rupee that is on the wrong trip, on no trip, or on a trip twice. '
  'Nothing here is auto-corrected — each row is a task for a person.';

-- ═══ 4. THE GUARD — AN EXPENSE MAY NOT BE FILED ON ANOTHER LORRY'S TRIP ════
--
-- The audit above finds what already went wrong. This stops the next one.
--
-- REFUSED ONLY WHEN IT IS UNAMBIGUOUS: both registrations present, both
-- normalise to something, and they differ. A bill with no vehicle on it is
-- allowed through — the desk may know something the paper does not say — and
-- lands in the audit instead. Refusing on absent data would block the queue
-- rather than protect it.
CREATE OR REPLACE FUNCTION expense_trip_vehicle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE trip_reg text; trip_code text;
BEGIN
  IF NEW.trip_id IS NULL OR reg_key(NEW.vehicle_no) IS NULL THEN RETURN NEW; END IF;

  SELECT reg_key(t.vehicle_no), t.trip_code INTO trip_reg, trip_code
    FROM trips t WHERE t.id = NEW.trip_id;

  IF trip_reg IS NOT NULL AND trip_reg <> reg_key(NEW.vehicle_no) THEN
    RAISE EXCEPTION
      'TRIP_VEHICLE_MISMATCH: this expense is for % but trip % ran a different lorry',
      NEW.vehicle_no, COALESCE(trip_code, NEW.trip_id::text)
      USING ERRCODE = 'P0405';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS expense_approvals_vehicle_guard ON expense_approvals;
CREATE TRIGGER expense_approvals_vehicle_guard
  BEFORE INSERT OR UPDATE OF trip_id, vehicle_no ON expense_approvals
  FOR EACH ROW EXECUTE FUNCTION expense_trip_vehicle_guard();

DROP TRIGGER IF EXISTS fuel_entries_vehicle_guard ON fuel_entries;
CREATE TRIGGER fuel_entries_vehicle_guard
  BEFORE INSERT OR UPDATE OF trip_id, vehicle_no ON fuel_entries
  FOR EACH ROW EXECUTE FUNCTION expense_trip_vehicle_guard();

DROP TRIGGER IF EXISTS toll_transactions_vehicle_guard ON toll_transactions;
CREATE TRIGGER toll_transactions_vehicle_guard
  BEFORE INSERT OR UPDATE OF trip_id, vehicle_no ON toll_transactions
  FOR EACH ROW EXECUTE FUNCTION expense_trip_vehicle_guard();

-- The joins the three views lean on.
CREATE INDEX IF NOT EXISTS fuel_entries_trip_idx        ON fuel_entries (trip_id)        WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS driver_txn_trip_idx          ON driver_transactions (trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS toll_txn_trip_idx            ON toll_transactions (trip_id)   WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expense_approvals_trip_idx2  ON expense_approvals (trip_id)   WHERE trip_id IS NOT NULL;

COMMIT;
