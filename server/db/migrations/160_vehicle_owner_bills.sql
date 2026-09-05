-- ═══════════════════════════════════════════════════════════════════════════
-- 160 — The 15-day VEHICLE BILL, per owner, with the seven expense columns
--
-- Owner, 5-Sep-2026, on the 4-Sep settlement screen: "design galat ho gayi".
-- What was asked for, and what this migration gives the schema to carry:
--
--   LEFT  of the bill   HSD · Toll Tax · Trip Fooding Allowance · Trip Fixed
--                       Allowance · Trip Advance · Doc Exp · Other Exp
--   RIGHT of the bill   the IOCL bill details, then Commission and TDS
--   ONE BILL            per OWNER per fortnight — every lorry of theirs under
--                       it, "Subtotal for Vehicle" per lorry, "Total of All
--                       Bills" at the foot. The shape of the transportation
--                       bill IOCL sends us, because that is what the owner
--                       reads it against.
--   APPROVE             posts to the owner's khata and locks the bill.
--   TRIP START          fooding / fixed / doc / other are entered WITH the
--                       trip id, so no rupee is ever "on the lorry" waiting
--                       for someone to guess the trip.
--
-- ── WHAT THE REGISTERS HOLD TODAY (production, 5-Sep) ─────────────────────
--
--   HSD   fuel_entries         899 trip-linked lines — the column works
--   TOLL  toll_transactions    493 of 3,883 crossings since April carry a
--                              trip_id. The column is honest and SHORT until
--                              the linking job runs. It is not padded.
--   ADVANCE driver_transactions ADVANCE_GIVEN 168 rows, 163 with a trip
--   FOODING / FIXED / DOC      no register exists. expense_approvals holds one
--                              row in the whole system (VEHICLE_COMPLIANCE).
--                              trip_expense_entries below is that register.
--
-- ── THE TWO RULES THAT DECIDE MONEY ───────────────────────────────────────
--
--   1. On an ATTACHED or MARKET lorry the trip advance is money we handed
--      the driver on the OWNER'S behalf, so it comes off the owner's freight
--      beside the diesel. On an OWN lorry it stays what migration 149 says it
--      is — a driver-khata asset, never in the P&L. The bill shows the column
--      on both; only the arithmetic differs, and it differs in ONE place
--      (v_vehicle_fortnight_class.bill_expense / expenses_recovered).
--
--   2. A missing commission rate is still NULL, never 0, and still refuses at
--      the gate (P0410 on the lorry, P0412 on the bill). The bill carries the
--      count of lorries without a rate so the desk sees WHY it will not sign.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE REGISTER FOR THE FOUR TYPED-IN EXPENSES ═══════════════════════
--
-- trip_id is NOT NULL on purpose. The vendor portal's partner_documents carry
-- a lorry and no trip, and that is exactly how a rupee lands on the wrong
-- trip. Here there is no such row to write.
CREATE TABLE IF NOT EXISTS trip_expense_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  vehicle_no    text,
  driver_name   text,
  kind          text NOT NULL
                CHECK (kind IN ('FOODING_ALLOWANCE','FIXED_ALLOWANCE','DOC_EXPENSE','OTHER_EXPENSE')),
  amount        numeric(14,2) NOT NULL CHECK (amount >= 0),
  -- "Other" with no name is a number nobody can audit.
  label         text,
  dated         date NOT NULL DEFAULT current_date,
  -- TRIP_START  keyed when the trip was opened
  -- BILL_DESK   keyed on the 15-day bill by the reviewer (still under the trip)
  source        text NOT NULL DEFAULT 'TRIP_START' CHECK (source IN ('TRIP_START','BILL_DESK')),
  entered_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tee_other_needs_label
    CHECK (kind <> 'OTHER_EXPENSE' OR (label IS NOT NULL AND btrim(label) <> ''))
);
CREATE INDEX IF NOT EXISTS tee_trip_idx ON trip_expense_entries (trip_id);

DROP TRIGGER IF EXISTS tee_touch ON trip_expense_entries;
CREATE TRIGGER tee_touch BEFORE UPDATE ON trip_expense_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The same guard fuel slips and tolls carry (migration 149): an expense whose
-- lorry is not the trip's lorry is refused with P0405.
DROP TRIGGER IF EXISTS trip_expense_entries_vehicle_guard ON trip_expense_entries;
CREATE TRIGGER trip_expense_entries_vehicle_guard
  BEFORE INSERT OR UPDATE OF trip_id, vehicle_no ON trip_expense_entries
  FOR EACH ROW EXECUTE FUNCTION expense_trip_vehicle_guard();

COMMENT ON TABLE trip_expense_entries IS
  'Fooding / fixed allowance / document / other expense keyed against ONE trip '
  '(trip_id NOT NULL). HSD, toll and advances live in their own registers.';

-- ═══ 2. EVERY RUPEE OF A TRIP — the new register joins the line view ═══════
CREATE OR REPLACE VIEW v_trip_expense_lines AS
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
  SELECT f.trip_id, 'ADVANCE', 'PUMP_CASH', 'FUEL_SLIP', f.id, f.entry_date,
         f.vehicle_no, COALESCE(f.cash_given_to_pump, 0)::numeric(14,2),
         COALESCE(f.memo_no, ''), f.vendor_name
    FROM fuel_entries f
   WHERE f.trip_id IS NOT NULL AND COALESCE(f.cash_given_to_pump, 0) <> 0

  UNION ALL
  SELECT tx.trip_id, 'EXPENSE', 'TOLL', 'FASTAG', tx.id,
         COALESCE(tx.txn_date, tx.txn_datetime::date), tx.vehicle_no,
         COALESCE(tx.amount, 0)::numeric(14,2),
         COALESCE(tx.plaza_name, ''), NULL
    FROM toll_transactions tx
   WHERE tx.trip_id IS NOT NULL

  UNION ALL
  SELECT e.trip_id, 'EXPENSE', upper(e.expense_type), 'BILL', e.id,
         COALESCE(e.bill_date, e.created_at::date), e.vehicle_no,
         COALESCE(e.amount, 0)::numeric(14,2),
         COALESCE(e.bill_no, ''), e.vendor_name
    FROM expense_approvals e
   WHERE e.trip_id IS NOT NULL AND e.status = 'APPROVED'

  UNION ALL
  -- The four typed-in kinds. EXPENSE, with the trip's id on the row itself.
  SELECT e.trip_id, 'EXPENSE', e.kind, 'TRIP_ENTRY', e.id, e.dated, e.vehicle_no,
         COALESCE(e.amount, 0)::numeric(14,2),
         COALESCE(e.label, ''), e.entered_by
    FROM trip_expense_entries e

  UNION ALL
  SELECT d.trip_id, 'ADVANCE', 'DRIVER_CASH', 'DRIVER_TXN', d.id, d.txn_date,
         NULL,
         (CASE WHEN d.txn_type = 'SHORTAGE_RECOVERY' THEN -1 ELSE 1 END
          * COALESCE(d.amount, 0))::numeric(14,2),
         COALESCE(d.mode, ''), d.driver_name
    FROM driver_transactions d
   WHERE d.trip_id IS NOT NULL
     AND COALESCE(d.txn_type, '') <> 'FUEL_EXPENSE';

-- ═══ 3. THE TRIP P&L GAINS THE THREE COLUMNS ══════════════════════════════
-- Same columns in the same order as migration 149 (a view can only grow at
-- the end), with `other` narrowed so a fooding entry is not counted twice.
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

       (COALESCE(t.freight_amount, 0)
        - COALESCE(x.expense, 0)
        + COALESCE(t.shortage_penalty, 0))::numeric(14,2) AS profit,

       COALESCE(x.advance, 0)::numeric(14,2)         AS advances,

       COALESCE(x.lines, 0)::int                     AS expense_lines,
       COALESCE(t.total_expense, 0)::numeric(14,2)   AS stored_total_expense,
       (COALESCE(t.total_expense, 0) - COALESCE(x.expense, 0))::numeric(14,2) AS drift,

       -- new, at the end
       COALESCE(x.fooding, 0)::numeric(14,2)         AS fooding,
       COALESCE(x.fixed_allowance, 0)::numeric(14,2) AS fixed_allowance,
       COALESCE(x.doc_expense, 0)::numeric(14,2)     AS doc_expense
  FROM trips t
  LEFT JOIN LATERAL (
    SELECT sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'HSD')               AS hsd,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'TOLL')              AS toll,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'TYRE')              AS tyre,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'MAINTENANCE')       AS maintenance,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'FOODING_ALLOWANCE') AS fooding,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'FIXED_ALLOWANCE')   AS fixed_allowance,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE' AND l.expense_type = 'DOC_EXPENSE')       AS doc_expense,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE'
                                   AND l.expense_type NOT IN ('HSD','TOLL','TYRE','MAINTENANCE',
                                                              'FOODING_ALLOWANCE','FIXED_ALLOWANCE',
                                                              'DOC_EXPENSE'))                        AS other,
           sum(l.amount) FILTER (WHERE l.kind = 'EXPENSE')                                          AS expense,
           sum(l.amount) FILTER (WHERE l.kind = 'ADVANCE')                                          AS advance,
           count(*)      FILTER (WHERE l.kind = 'EXPENSE')                                          AS lines
      FROM v_trip_expense_lines l
     WHERE l.trip_id = t.id) x ON true;

-- ═══ 4. THE LORRY SETTLEMENT GAINS ITS COLUMNS ════════════════════════════
ALTER TABLE vehicle_fortnight_settlements
  ADD COLUMN IF NOT EXISTS fooding          numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_allowance  numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS doc_expense      numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_qty       numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rtkm             numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_penalty numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owner_bill_id    uuid;

-- The lock (158) learns the new columns. Guards on OLD.locked_at; a bare
-- reopen — locked_at cleared and every number the same — is the one edit a
-- locked row accepts.
CREATE OR REPLACE FUNCTION vfs_lock_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;

  IF NEW.locked_at IS NULL
     AND NEW.billed_amount = OLD.billed_amount
     AND NEW.hsd = OLD.hsd AND NEW.toll = OLD.toll
     AND NEW.tyre = OLD.tyre AND NEW.maintenance = OLD.maintenance
     AND NEW.other_expense = OLD.other_expense
     AND NEW.fooding = OLD.fooding AND NEW.fixed_allowance = OLD.fixed_allowance
     AND NEW.doc_expense = OLD.doc_expense AND NEW.advances = OLD.advances
     AND NEW.adjustments = OLD.adjustments
     AND NEW.status IN ('STAFF_REVIEWED', OLD.status) THEN
    RETURN NEW;                                  -- a bare reopen
  END IF;

  RAISE EXCEPTION
    'Settlement % (% , % to %) is approved and locked. Reopen it first.',
    OLD.id, OLD.vehicle_no, OLD.period_from, OLD.period_to
    USING ERRCODE = 'P0409';
END;
$$ LANGUAGE plpgsql;

-- ═══ 5. THE OWNER BILL ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_owner_bills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no         text NOT NULL,
  owner_key       text NOT NULL,
  owner_name      text NOT NULL,
  -- OWN / ATTACHED / MARKET, or NULL for a lorry in no master. class_key is
  -- the same thing as text so the unique index has something non-null.
  fleet_class     fleet_class,
  class_key       text NOT NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  operating_company text,

  period_from     date NOT NULL,
  period_to       date NOT NULL,
  cycle           text,

  status          text NOT NULL DEFAULT 'AI_DRAFT'
                    CHECK (status IN ('AI_DRAFT','STAFF_REVIEWED','APPROVED')),

  -- the foot of the bill, kept in step by vehicle_owner_bill_refresh()
  lorries         int NOT NULL DEFAULT 0,
  trips           int NOT NULL DEFAULT 0,
  loaded_qty      numeric(14,3) NOT NULL DEFAULT 0,
  rtkm            numeric(14,2) NOT NULL DEFAULT 0,
  freight         numeric(14,2) NOT NULL DEFAULT 0,
  received        numeric(14,2) NOT NULL DEFAULT 0,
  penalty         numeric(14,2) NOT NULL DEFAULT 0,
  hsd             numeric(14,2) NOT NULL DEFAULT 0,
  toll            numeric(14,2) NOT NULL DEFAULT 0,
  fooding         numeric(14,2) NOT NULL DEFAULT 0,
  fixed_allowance numeric(14,2) NOT NULL DEFAULT 0,
  advances        numeric(14,2) NOT NULL DEFAULT 0,
  doc_expense     numeric(14,2) NOT NULL DEFAULT 0,
  other_expense   numeric(14,2) NOT NULL DEFAULT 0,   -- tyre + maintenance + other
  expense_total   numeric(14,2) NOT NULL DEFAULT 0,   -- the P&L buckets, no advances
  adj_income      numeric(14,2) NOT NULL DEFAULT 0,
  adj_expense     numeric(14,2) NOT NULL DEFAULT 0,
  -- what comes off the owner's freight: buckets + adjustments, + advances on
  -- an attached/market lorry
  deductions      numeric(14,2) NOT NULL DEFAULT 0,
  commission      numeric(14,2),
  tds             numeric(14,2),
  recovered       numeric(14,2),
  payable         numeric(14,2),
  our_earning     numeric(14,2),
  needs_rate      int NOT NULL DEFAULT 0,

  -- the journal as last posted, so a re-approve after Modify posts only the
  -- DIFFERENCE (the pump-bill rule: the old voucher stays, a delta follows)
  posted_lines    jsonb NOT NULL DEFAULT '[]'::jsonb,
  voucher_id      uuid,
  voucher_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
  post_count      int NOT NULL DEFAULT 0,

  notes           text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  approved_by     text,
  approved_at     timestamptz,
  locked_at       timestamptz,
  locked_by       text,
  reopen_reason   text,
  reopened_by     text,
  reopened_at     timestamptz,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vob_period_sane CHECK (period_to >= period_from),
  CONSTRAINT vob_approved_is_locked CHECK (status <> 'APPROVED' OR locked_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS vob_one_per_owner_cycle
  ON vehicle_owner_bills (owner_key, class_key, period_from);
CREATE UNIQUE INDEX IF NOT EXISTS vob_bill_no ON vehicle_owner_bills (bill_no);
CREATE INDEX IF NOT EXISTS vob_period_idx ON vehicle_owner_bills (period_from DESC, status);

DROP TRIGGER IF EXISTS vob_touch ON vehicle_owner_bills;
CREATE TRIGGER vob_touch BEFORE UPDATE ON vehicle_owner_bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
  ALTER TABLE vehicle_fortnight_settlements
    ADD CONSTRAINT vfs_owner_bill_fk FOREIGN KEY (owner_bill_id)
    REFERENCES vehicle_owner_bills(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS vfs_owner_bill_idx ON vehicle_fortnight_settlements (owner_bill_id);

COMMENT ON TABLE vehicle_owner_bills IS
  'One 15-day bill per vehicle owner: every lorry of theirs for the fortnight, '
  'the seven expense columns, commission, TDS and what they are owed. Approve '
  'posts to the owner khata and locks it.';

-- ── the lock ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vob_lock_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;

  -- The one edit a locked bill accepts: a deliberate reopen with a reason,
  -- leaving every number as it was.
  IF NEW.locked_at IS NULL
     AND NEW.status = 'STAFF_REVIEWED'
     AND NEW.reopen_reason IS NOT NULL AND btrim(NEW.reopen_reason) <> ''
     AND NEW.freight = OLD.freight AND NEW.deductions = OLD.deductions
     AND NEW.commission IS NOT DISTINCT FROM OLD.commission
     AND NEW.tds IS NOT DISTINCT FROM OLD.tds
     AND NEW.payable IS NOT DISTINCT FROM OLD.payable
     AND NEW.adj_income = OLD.adj_income AND NEW.adj_expense = OLD.adj_expense
     AND NEW.posted_lines = OLD.posted_lines THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Bill % (%, % to %) is approved and locked. Use Modify with a reason first.',
    OLD.bill_no, OLD.owner_name, OLD.period_from, OLD.period_to
    USING ERRCODE = 'P0411';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vob_lock ON vehicle_owner_bills;
CREATE TRIGGER vob_lock BEFORE UPDATE ON vehicle_owner_bills
  FOR EACH ROW EXECUTE FUNCTION vob_lock_guard();

-- ── the posting gate ──────────────────────────────────────────────────────
-- Mirrors P0410 on the lorry row: a bill with any attached/market lorry
-- still without a commission rate cannot be approved, by anyone, by any path.
CREATE OR REPLACE FUNCTION vob_rate_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'APPROVED' AND NEW.needs_rate > 0 THEN
    RAISE EXCEPTION
      'Bill % (%): % lorry ka commission rate darj nahi hai — approve nahi ho sakta.',
      NEW.bill_no, NEW.owner_name, NEW.needs_rate
      USING ERRCODE = 'P0412';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vob_rate ON vehicle_owner_bills;
CREATE TRIGGER vob_rate BEFORE INSERT OR UPDATE ON vehicle_owner_bills
  FOR EACH ROW EXECUTE FUNCTION vob_rate_guard();

-- ═══ 6. THE BILL NUMBER ═══════════════════════════════════════════════════
-- VB-SKP-JUN-H2-2026: the owner's initials and the fortnight, the way the
-- pump bills read (AFS-JUL-H2-2026). Own-fleet bills carry -OWN so the same
-- family name can have an attached bill and an own-fleet statement.
CREATE OR REPLACE FUNCTION owner_bill_no(p_owner text, p_class text, p_from date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'VB-'
    || CASE WHEN COALESCE(p_owner, '') LIKE '(%' THEN 'NA'
            ELSE COALESCE(NULLIF(regexp_replace(
              (SELECT string_agg(left(w, 1), '')
                 FROM (SELECT unnest(string_to_array(
                         regexp_replace(
                           regexp_replace(upper(coalesce(p_owner,'')), 'M/S|M\.S\.|MESSRS', '', 'g'),
                           '[^A-Z ]', '', 'g'), ' ')) AS w) q
                WHERE w <> '' LIMIT 3), '[^A-Z]', '', 'g'), ''), 'NA') END
    || CASE p_class WHEN 'OWN' THEN '-OWN' WHEN 'NONE' THEN '-X' ELSE '' END
    || '-' || upper(to_char(p_from, 'MON'))
    || '-' || CASE WHEN extract(day FROM p_from) <= 15 THEN 'H1' ELSE 'H2' END
    || '-' || to_char(p_from, 'YYYY')
$$;

-- ═══ 7. THE VIEWS, REBUILT IN ORDER ═══════════════════════════════════════
-- v_vehicle_fortnight_draft grows columns in the middle of its dependents'
-- SELECT lists (they use d.*), so the chain is dropped and re-created.
DROP VIEW IF EXISTS v_owner_fortnight_statement;
DROP VIEW IF EXISTS v_vehicle_fortnight_class;
DROP VIEW IF EXISTS v_vehicle_fortnight_priced;
DROP VIEW IF EXISTS v_vehicle_settlement;
DROP VIEW IF EXISTS v_vehicle_settlement_cycles;
DROP VIEW IF EXISTS v_vehicle_fortnight_draft;

CREATE VIEW v_vehicle_fortnight_draft AS
SELECT upper(regexp_replace(t.vehicle_no, '[^A-Za-z0-9]', '', 'g'))  AS vehicle_key,
       min(t.vehicle_no)                                             AS vehicle_no,
       max(t.vehicle_id::text)::uuid                                 AS vehicle_id,
       string_agg(DISTINCT t.operating_company, ' + ')               AS operating_company,
       fortnight_from(COALESCE(t.unloading_date, t.loading_date))     AS period_from,
       fortnight_to(COALESCE(t.unloading_date, t.loading_date))       AS period_to,
       fortnight_code(COALESCE(t.unloading_date, t.loading_date))     AS cycle,
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
   AND COALESCE(t.unloading_date, t.loading_date) IS NOT NULL
   AND t.status = 'COMPLETED'
 GROUP BY 1, 5, 6, 7;

CREATE VIEW v_vehicle_fortnight_priced AS
WITH base AS (
  SELECT d.*,
         vehicle_class(d.vehicle_no)                       AS fleet_class,
         (SELECT v.owner_name FROM vehicles v
           WHERE v.vehicle_no_norm = d.vehicle_key LIMIT 1) AS owner_name,
         (SELECT v.company_id FROM vehicles v
           WHERE v.vehicle_no_norm = d.vehicle_key LIMIT 1) AS master_company_id
    FROM v_vehicle_fortnight_draft d
), t AS (
  SELECT b.*, ct.id AS terms_id, ct.basis, ct.rate, ct.tds_pct,
         ct.recover_expenses, ct.owner_ledger_id
    FROM base b
    LEFT JOIN LATERAL commission_term(b.vehicle_key, b.period_to) ct ON true
)
SELECT t.*,
       CASE
         WHEN t.fleet_class = 'OWN' THEN NULL
         WHEN t.basis IS NULL       THEN NULL
         WHEN t.basis = 'PCT'       THEN round(t.billed_amount * t.rate / 100.0, 2)
         WHEN t.basis IN ('PER_TON','PER_KL') THEN round(t.loaded_qty * t.rate, 2)
         WHEN t.basis = 'FLAT_TRIP' THEN round(t.trips_count * t.rate, 2)
       END                                                     AS commission_amount
  FROM t;

-- The arithmetic, said once:
--   OWN        ours = freight - expenses; the advance is the driver's khata
--   ATTACHED   commission by basis; tds on (freight - commission);
--   / MARKET   recovered = expenses + advances (we paid both for the owner);
--              payable = freight - commission - tds - recovered; ours = commission
CREATE VIEW v_vehicle_fortnight_class AS
SELECT p.*,
       (p.fleet_class IN ('ATTACHED','MARKET'))                    AS is_agency,
       CASE WHEN p.fleet_class = 'OWN' THEN NULL
            WHEN p.commission_amount IS NULL THEN NULL
            ELSE round(GREATEST(p.billed_amount - p.commission_amount, 0)
                       * COALESCE(p.tds_pct, 0) / 100.0, 2) END AS tds_amount,
       CASE WHEN p.fleet_class NOT IN ('ATTACHED','MARKET') OR p.fleet_class IS NULL THEN NULL
            WHEN COALESCE(p.recover_expenses, true) THEN (p.expense_total + p.advances)
            ELSE 0 END::numeric(14,2)                           AS expenses_recovered,
       -- "Kul kharch" as the bill prints it
       (p.expense_total
        + CASE WHEN p.fleet_class IN ('ATTACHED','MARKET') THEN p.advances ELSE 0 END)
         ::numeric(14,2)                                         AS bill_expense,
       CASE WHEN p.fleet_class NOT IN ('ATTACHED','MARKET') OR p.fleet_class IS NULL
              OR p.commission_amount IS NULL THEN NULL
            ELSE round(p.billed_amount
                       - p.commission_amount
                       - round(GREATEST(p.billed_amount - p.commission_amount, 0)
                               * COALESCE(p.tds_pct, 0) / 100.0, 2)
                       - CASE WHEN COALESCE(p.recover_expenses, true)
                              THEN p.expense_total + p.advances ELSE 0 END, 2) END AS payable_to_owner,
       CASE WHEN p.fleet_class = 'OWN' THEN p.net
            ELSE p.commission_amount END                        AS our_earning,
       (p.fleet_class IN ('ATTACHED','MARKET') AND p.basis IS NULL) AS needs_rate
  FROM v_vehicle_fortnight_priced p;

CREATE VIEW v_vehicle_settlement AS
SELECT s.*,
       (s.billed_amount + s.other_income
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'INCOME'), 0))::numeric(14,2)   AS gross_income,
       (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense
        + s.fooding + s.fixed_allowance + s.doc_expense)::numeric(14,2) AS bucket_expense,
       (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense
        + s.fooding + s.fixed_allowance + s.doc_expense
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'EXPENSE'), 0))::numeric(14,2)  AS total_expense,
       COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                  WHERE a->>'side' = 'INCOME'), 0)::numeric(14,2)       AS adj_income,
       COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                  WHERE a->>'side' = 'EXPENSE'), 0)::numeric(14,2)      AS adj_expense,
       -- what the bill prints under Kul kharch for this lorry
       (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense
        + s.fooding + s.fixed_allowance + s.doc_expense
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'EXPENSE'), 0)
        + CASE WHEN s.fleet_class IN ('ATTACHED','MARKET') THEN s.advances ELSE 0 END)
         ::numeric(14,2)                                                AS bill_expense,
       (s.locked_at IS NOT NULL)                                        AS locked,
       fortnight_label(s.period_from)                                   AS cycle_label,
       CASE WHEN s.fleet_class = 'OWN' OR s.fleet_class IS NULL
            THEN (s.billed_amount + s.other_income
                  - (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense
                     + s.fooding + s.fixed_allowance + s.doc_expense))
            ELSE s.commission_amount END::numeric(14,2)                 AS our_earning,
       (s.fleet_class IN ('ATTACHED','MARKET')
        AND s.commission_amount IS NULL)                                AS needs_rate,
       co.company_name,
       d.trips_count                                                    AS live_trips,
       d.billed_amount                                                  AS live_billed,
       d.expense_total                                                  AS live_expense
  FROM vehicle_fortnight_settlements s
  LEFT JOIN companies co ON co.id = s.company_id
  LEFT JOIN v_vehicle_fortnight_draft d
    ON d.vehicle_key = s.vehicle_key AND d.period_from = s.period_from;

CREATE VIEW v_vehicle_settlement_cycles AS
SELECT d.cycle,
       fortnight_label(d.period_from)              AS cycle_label,
       d.period_from,
       d.period_to,
       count(*)::int                               AS lorries,
       sum(d.trips_count)::int                     AS trips,
       sum(d.billed_amount)::numeric(14,2)         AS billed,
       sum(d.expense_total)::numeric(14,2)         AS expense,
       sum(d.net)::numeric(14,2)                   AS net,
       count(s.id) FILTER (WHERE s.status = 'AI_DRAFT')::int       AS drafts,
       count(s.id) FILTER (WHERE s.status = 'STAFF_REVIEWED')::int AS reviewed,
       count(s.id) FILTER (WHERE s.status = 'APPROVED')::int       AS approved
  FROM v_vehicle_fortnight_draft d
  LEFT JOIN vehicle_fortnight_settlements s
    ON s.vehicle_key = d.vehicle_key AND s.period_from = d.period_from
 GROUP BY d.cycle, d.period_from, d.period_to
 ORDER BY d.period_from DESC;

CREATE VIEW v_owner_fortnight_statement AS
SELECT COALESCE(c.owner_name, '(owner darj nahi)')      AS owner_name,
       c.fleet_class,
       c.period_from,
       c.period_to,
       c.cycle,
       count(*)::int                                     AS lorries,
       sum(c.trips_count)::int                           AS trips,
       sum(c.loaded_qty)::numeric(14,3)                  AS loaded_qty,
       sum(c.billed_amount)::numeric(14,2)               AS freight,
       sum(c.expense_total)::numeric(14,2)               AS expenses,
       sum(c.commission_amount)::numeric(14,2)           AS commission,
       sum(c.tds_amount)::numeric(14,2)                  AS tds,
       sum(c.expenses_recovered)::numeric(14,2)          AS recovered,
       sum(c.payable_to_owner)::numeric(14,2)            AS payable,
       sum(c.our_earning)::numeric(14,2)                 AS our_earning,
       count(*) FILTER (WHERE c.needs_rate)::int         AS without_rate
  FROM v_vehicle_fortnight_class c
 WHERE c.fleet_class IN ('ATTACHED','MARKET')
 GROUP BY 1, 2, 3, 4, 5;

-- The bill as the list and the drawer read it.
CREATE OR REPLACE VIEW v_vehicle_owner_bill AS
SELECT b.*,
       fortnight_label(b.period_from)                    AS cycle_label,
       (b.locked_at IS NOT NULL)                         AS locked,
       co.company_name,
       (b.freight + b.adj_income - b.deductions)::numeric(14,2) AS net
  FROM vehicle_owner_bills b
  LEFT JOIN companies co ON co.id = b.company_id;

-- ═══ 8. THE TRIP LINES OF ONE LORRY-FORTNIGHT, AS THE BILL PRINTS THEM ═══
CREATE OR REPLACE FUNCTION vehicle_settlement_lines(p_key text, p_from date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'trip_id', p.trip_id, 'trip_code', p.trip_code,
           'iocl_bill_no', t.iocl_bill_no, 'challan_no', t.challan_no,
           'loading_date', p.loading_date, 'unloading_date', p.unloading_date,
           'customer', p.customer_name, 'dest', t.unloading_location,
           'product', t.product_type, 'driver', p.driver_name,
           'billed', t.billed_amount, 'received', t.received_amount,
           'qty', t.loaded_qty, 'shortage_qty', t.shortage_qty,
           'rtkm', t.rtkm, 'rate', t.rate, 'penalty', t.shortage_penalty,
           'hsd', p.hsd, 'toll', p.toll, 'fooding', p.fooding,
           'fixed', p.fixed_allowance, 'advances', p.advances,
           'doc', p.doc_expense, 'other', p.other,
           'tyre', p.tyre, 'maintenance', p.maintenance,
           'expense', p.expense_total)
           ORDER BY COALESCE(p.unloading_date, p.loading_date), p.trip_code), '[]'::jsonb)
    FROM v_trip_pnl p
    JOIN trips t ON t.id = p.trip_id
   WHERE upper(regexp_replace(t.vehicle_no, '[^A-Za-z0-9]', '', 'g')) = p_key
     AND t.status = 'COMPLETED'
     AND fortnight_from(COALESCE(t.unloading_date, t.loading_date)) = p_from
$$;

-- ═══ 9. THE OWNER BILL'S FOOT, RECOMPUTED FROM ITS LORRIES ════════════════
-- Never touches a locked bill: its numbers are what was signed.
CREATE OR REPLACE FUNCTION vehicle_owner_bill_refresh(p_bill uuid) RETURNS void AS $$
BEGIN
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

-- ═══ 10. GROUP THE FORTNIGHT'S LORRIES INTO OWNER BILLS ═══════════════════
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
      -- Two owners with the same initials in one fortnight get -2, -3.
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

    -- Every unlocked lorry of this owner and class joins the bill.
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

  -- A bill whose lorries all moved elsewhere (owner corrected in the master)
  -- is an empty draft; it goes. A locked one stays, whatever it holds.
  DELETE FROM vehicle_owner_bills b
   WHERE b.period_from = v_from AND b.locked_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM vehicle_fortnight_settlements s WHERE s.owner_bill_id = b.id);

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- ═══ 11. BUILD — the lorry drafts, then the owner bills ═══════════════════
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
       -- The whole safety of re-running lives on this line.
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

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- ═══ 12. REFRESH ONE LORRY AFTER THE DESK KEYS AN EXPENSE ═════════════════
-- A reviewer who adds a fooding line on the bill has changed the trip's
-- register; the settlement must follow, whatever its status, as long as it
-- is not locked. Adjustments, notes and status are the reviewer's and stay.
CREATE OR REPLACE FUNCTION vehicle_settlement_refresh(p_id uuid) RETURNS void AS $$
DECLARE v_bill uuid;
BEGIN
  UPDATE vehicle_fortnight_settlements s
     SET trips_count = c.trips_count, billed_amount = c.billed_amount,
         received_amount = c.received_amount,
         hsd = c.hsd, toll = c.toll, tyre = c.tyre, maintenance = c.maintenance,
         other_expense = c.other_expense, advances = c.advances,
         fooding = c.fooding, fixed_allowance = c.fixed_allowance, doc_expense = c.doc_expense,
         loaded_qty = c.loaded_qty, rtkm = c.rtkm, shortage_penalty = c.shortage_penalty,
         fleet_class = c.fleet_class, owner_name = c.owner_name,
         company_id = COALESCE(c.master_company_id, s.company_id),
         terms_id = c.terms_id, commission_basis = c.basis, commission_rate = c.rate,
         commission_amount = c.commission_amount, tds_pct = c.tds_pct, tds_amount = c.tds_amount,
         expenses_recovered = c.expenses_recovered, payable_to_owner = c.payable_to_owner,
         lines = vehicle_settlement_lines(s.vehicle_key, s.period_from),
         updated_at = now()
    FROM v_vehicle_fortnight_class c
   WHERE s.id = p_id AND s.locked_at IS NULL
     AND c.vehicle_key = s.vehicle_key AND c.period_from = s.period_from;

  SELECT owner_bill_id INTO v_bill FROM vehicle_fortnight_settlements WHERE id = p_id;
  IF v_bill IS NOT NULL THEN PERFORM vehicle_owner_bill_refresh(v_bill); END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION vehicle_fortnight_build(date, text) IS
  'Build or refresh AI_DRAFT lorry settlements for the fortnight containing '
  'p_from, then group them into owner bills. Never touches a reviewed, '
  'approved or locked row.';
