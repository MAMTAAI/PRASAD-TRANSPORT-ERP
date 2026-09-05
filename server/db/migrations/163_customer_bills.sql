-- ═══════════════════════════════════════════════════════════════════════════
-- 163 — The CUSTOMER 15-day bill, and trip-wise reconciliation of what they pay
--
-- Owner, 5-Sep-2026 (design v1 approved the same day): "1-04-2026 to
-- 1-09-2026 tak ka bill ready … email se bill collection kar ke reconciliation
-- trip-wise … oil company ka payment: HSD ka 35–40% direct fleet account me,
-- baaki bank me … agent auto bill banaye, staff approve kare, missing trip
-- dashboard par, GST/TDS auto, 0% error."
--
-- ── WHAT THE AUDIT FOUND (production, 5-Sep) ──────────────────────────────
--
--   · 417 company_bills, ALL PENDING_PAYMENT (Rs2.96 cr), zero ever settled —
--     while Rs1.795 cr is recorded RECEIVED on 593 trips by the IOCL advice
--     pipeline. The screen's "outstanding" is the whole of history.
--   · Revenue was debited to 'Debtors: INDIAN OIL CORPORATION LTD'
--     (BILL_RAISED, Rs2.98 cr); receipts were credited to a DIFFERENT ledger,
--     'INDIAN OIL CORPORATION LTD' (ADVICE_SETTLEMENT, Rs2.02 cr). Two
--     ledgers, one customer: the debtor can never clear.
--   · IOCL's CCMS diesel recovery (Rs62.6 L, 31% of freight) was debited to
--     'Direct Expenses - Fuel & HSD'. The diesel had already been drawn on
--     the IOCL XtraPower fleet card, whose sales the fleet-card module holds —
--     so the same litres can be expensed twice. The owner's rule says what the
--     recovery IS: money IOCL keeps to recharge OUR fleet card. It belongs on
--     the card's asset ledger, not in expense.
--   · One bill per ship-to (417 of them); customer names free text (11
--     spellings for 4 customers); 100 COMPLETED trips with NO customer.
--   · customers: no type, no cycle that matches reality, no parent→branch.
--
-- ── THE MODEL ─────────────────────────────────────────────────────────────
--
--   ONE BILL = customer (parent) × the firm whose books × cycle. Oil
--   companies fortnightly, contract customers monthly. Inside it, one block
--   per BRANCH (ship-to), every trip under its branch, "Subtotal for Branch",
--   "Total of All Branches". That core is the same for every customer; only
--   the PRINT differs (customer_type → print_format).
--
--   RECONCILIATION IS PER TRIP, DERIVED, NEVER TYPED: v_customer_trip_recon
--   reads what the advice pipeline wrote on the trip (received_amount,
--   tds_amount, iocl_bill_no) and the match table, and names the state —
--   PAID · SHORT · PENDING · MISSING · UNPRICED. The bill's status follows
--   its trips. Nothing here posts money; raising a bill posts revenue for the
--   trips no legacy bill already posted, and the advice pipeline posts the
--   cash — into the SAME debtor ledger from now on.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. WHO THE CUSTOMER IS, FOR BILLING ══════════════════════════════════
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_type    text
    CHECK (customer_type IS NULL OR customer_type IN ('OIL_COMPANY','CONTRACT','MARKET')),
  ADD COLUMN IF NOT EXISTS bill_cycle       text NOT NULL DEFAULT 'FORTNIGHT'
    CHECK (bill_cycle IN ('FORTNIGHT','MONTH','PER_LOAD')),
  ADD COLUMN IF NOT EXISTS print_format     text NOT NULL DEFAULT 'OIL_CO'
    CHECK (print_format IN ('OIL_CO','CONTRACT_RCM','MARKET_LR')),
  ADD COLUMN IF NOT EXISTS tds_pct_deducted numeric(6,3) NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS gst_pct          numeric(6,3) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS gst_mode         text NOT NULL DEFAULT 'RCM'
    CHECK (gst_mode IN ('RCM','FORWARD','EXEMPT')),
  ADD COLUMN IF NOT EXISTS parent_id        uuid REFERENCES customers(id) ON DELETE SET NULL;

-- What the signed documents already say (memory: Aadhar monthly, Rs1,500/KL,
-- 5% RCM; the oil companies fortnightly, TDS 2% u/s 194C).
UPDATE customers
   SET customer_type = 'OIL_COMPANY', bill_cycle = 'FORTNIGHT', print_format = 'OIL_CO', tds_pct_deducted = 2
 WHERE customer_type IS NULL
   AND (customer_name ILIKE '%INDIAN OIL%' OR customer_name ILIKE '%BHARAT PETROLEUM%'
        OR customer_name ILIKE '%HINDUSTAN PETROLEUM%');
UPDATE customers
   SET customer_type = 'CONTRACT', bill_cycle = 'MONTH', print_format = 'CONTRACT_RCM', tds_pct_deducted = 0
 WHERE customer_type IS NULL AND customer_name ILIKE '%AADHAR%';

-- ═══ 2. ONE NAME, HOWEVER IT WAS TYPED ════════════════════════════════════
CREATE TABLE IF NOT EXISTS customer_name_aliases (
  alias_norm   text PRIMARY KEY,
  alias        text NOT NULL,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source       text NOT NULL DEFAULT 'LEARNED',
  confirmed_by text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION customer_of(p_name text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT c.id FROM customers c
      WHERE c.status = 'ACTIVE' AND norm_company(c.customer_name) = norm_company(p_name) LIMIT 1),
    (SELECT a.customer_id FROM customer_name_aliases a WHERE a.alias_norm = norm_company(p_name)),
    (SELECT c.id FROM customers c
      WHERE c.customer_code IS NOT NULL AND upper(btrim(p_name)) = upper(btrim(c.customer_code)) LIMIT 1))
$$;

-- The spellings the register already holds, mapped once, by pattern.
INSERT INTO customer_name_aliases (alias_norm, alias, customer_id, source)
SELECT norm_company(t.customer_name), min(btrim(t.customer_name)), c.id, 'BACKFILL'
  FROM trips t
  JOIN customers c ON (
        (t.customer_name ~* '(indian oil|^\s*iocl\s*$)' AND c.customer_name ILIKE '%INDIAN OIL%')
     OR (t.customer_name ~* '(hindu.{0,3}tan petroleum|^\s*hpcl\s*$)' AND c.customer_name ILIKE '%HINDUSTAN PETROLEUM%')
     OR (t.customer_name ~* '(bharat petroleum|^\s*bpcl\s*$)' AND c.customer_name ILIKE '%BHARAT PETROLEUM%')
     OR (t.customer_name ~* 'aadhar' AND c.customer_name ILIKE '%AADHAR%'))
 WHERE t.customer_name IS NOT NULL AND btrim(t.customer_name) <> ''
   AND c.status = 'ACTIVE'
   AND norm_company(t.customer_name) <> norm_company(c.customer_name)
 GROUP BY norm_company(t.customer_name), c.id
ON CONFLICT (alias_norm) DO NOTHING;

-- ═══ 3. PARENT → BRANCH (ship-to), learned from the trips ═════════════════
CREATE OR REPLACE FUNCTION branch_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(regexp_replace(upper(coalesce(p, '')), '\s+', ' ', 'g')), '')
$$;

-- The oil company's code for the place: "ZC7A01 - Agartala AFS" → ZC7A01,
-- "347559 NENGSKIM FUEL STATION" → 347559, "LPG BP NORTH GUWAHATI (7B03)" → 7B03.
CREATE OR REPLACE FUNCTION branch_code_of(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (regexp_match(upper(coalesce(p, '')), '^\s*([A-Z0-9]{4,8})\s*[-–—]'))[1],
    (regexp_match(upper(coalesce(p, '')), '^\s*([0-9]{4,8})\s+'))[1],
    (regexp_match(upper(coalesce(p, '')), '\(([A-Z0-9]{3,8})\)\s*$'))[1])
$$;

CREATE TABLE IF NOT EXISTS customer_branches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  branch_key   text NOT NULL,
  branch_code  text,
  branch_name  text NOT NULL,
  source       text NOT NULL DEFAULT 'LEARNED' CHECK (source IN ('LEARNED','CONFIRMED')),
  confirmed_by text,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, branch_key)
);
DROP TRIGGER IF EXISTS customer_branches_touch ON customer_branches;
CREATE TRIGGER customer_branches_touch BEFORE UPDATE ON customer_branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO customer_branches (customer_id, branch_key, branch_code, branch_name, source)
SELECT customer_of(t.customer_name), branch_key(t.unloading_location),
       branch_code_of(t.unloading_location), min(btrim(t.unloading_location)), 'LEARNED'
  FROM trips t
 WHERE t.unloading_location IS NOT NULL AND btrim(t.unloading_location) <> ''
   AND customer_of(t.customer_name) IS NOT NULL
 GROUP BY 1, 2, 3
ON CONFLICT (customer_id, branch_key) DO NOTHING;

-- ═══ 4. THE BILL ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS customer_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no           text NOT NULL,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  customer_name     text NOT NULL,
  customer_type     text,
  print_format      text,
  -- whose books: a customer can run in two firms' books (IOCL runs in Prasad
  -- and Gautam Prasad). books_key is norm_company(operating_company), '' if none.
  company_id        uuid REFERENCES companies(id) ON DELETE SET NULL,
  operating_company text,
  books_key         text NOT NULL DEFAULT '',
  cycle_kind        text NOT NULL CHECK (cycle_kind IN ('FORTNIGHT','MONTH')),
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  cycle             text,

  -- AI_DRAFT → STAFF_REVIEWED → RAISED (revenue posted, locked) → PART_PAID /
  -- PAID (from the trips' receipts) / DISPUTED (a person raised one) / CANCELLED
  status            text NOT NULL DEFAULT 'AI_DRAFT'
    CHECK (status IN ('AI_DRAFT','STAFF_REVIEWED','RAISED','PART_PAID','PAID','DISPUTED','CANCELLED')),

  trips             int NOT NULL DEFAULT 0,
  branches          int NOT NULL DEFAULT 0,
  loaded_qty        numeric(14,3) NOT NULL DEFAULT 0,
  rtkm              numeric(14,2) NOT NULL DEFAULT 0,
  gross             numeric(14,2) NOT NULL DEFAULT 0,
  shortage_penalty  numeric(14,2) NOT NULL DEFAULT 0,
  tds_pct           numeric(6,3),
  tds               numeric(14,2) NOT NULL DEFAULT 0,
  gst_pct           numeric(6,3),
  gst_mode          text,
  gst_memo          numeric(14,2) NOT NULL DEFAULT 0,
  net_receivable    numeric(14,2) NOT NULL DEFAULT 0,   -- gross − penalty − tds
  received          numeric(14,2) NOT NULL DEFAULT 0,   -- as the pipeline records it (gross basis)
  balance           numeric(14,2) NOT NULL DEFAULT 0,   -- gross − penalty − received

  paid_count        int NOT NULL DEFAULT 0,
  short_count       int NOT NULL DEFAULT 0,
  missing_count     int NOT NULL DEFAULT 0,
  pending_count     int NOT NULL DEFAULT 0,
  unpriced_count    int NOT NULL DEFAULT 0,
  short_amount      numeric(14,2) NOT NULL DEFAULT 0,
  missing_amount    numeric(14,2) NOT NULL DEFAULT 0,
  pending_amount    numeric(14,2) NOT NULL DEFAULT 0,
  unpriced_trips    int NOT NULL DEFAULT 0,
  -- their lines with no trip of ours, in this period (IOCL pipeline)
  unmatched_count   int NOT NULL DEFAULT 0,
  unmatched_amount  numeric(14,2) NOT NULL DEFAULT 0,

  -- revenue already posted by a legacy company_bill (BILL_RAISED) vs what
  -- raising THIS bill still has to post — never both for one trip
  revenue_posted_legacy numeric(14,2) NOT NULL DEFAULT 0,
  revenue_to_post       numeric(14,2) NOT NULL DEFAULT 0,

  lines             jsonb NOT NULL DEFAULT '[]'::jsonb,   -- branch blocks
  adjustments       jsonb NOT NULL DEFAULT '[]'::jsonb,
  disputes          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{trip_id, kind, amount, note, by, at}]
  notes             text,

  voucher_id        uuid,
  voucher_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
  posted_lines      jsonb NOT NULL DEFAULT '[]'::jsonb,
  post_count        int NOT NULL DEFAULT 0,

  reviewed_by       text,
  reviewed_at       timestamptz,
  raised_by         text,
  raised_at         timestamptz,
  locked_at         timestamptz,
  locked_by         text,
  reopen_reason     text,
  reopened_by       text,
  reopened_at       timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cb_period_sane CHECK (period_to >= period_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS cb_one_per_customer_books_cycle
  ON customer_bills (customer_id, books_key, period_from);
CREATE UNIQUE INDEX IF NOT EXISTS cb_bill_no ON customer_bills (bill_no);
CREATE INDEX IF NOT EXISTS cb_period_idx ON customer_bills (period_from DESC, status);

DROP TRIGGER IF EXISTS cb_touch ON customer_bills;
CREATE TRIGGER cb_touch BEFORE UPDATE ON customer_bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE trips ADD COLUMN IF NOT EXISTS customer_bill_id uuid;
DO $$ BEGIN
  ALTER TABLE trips ADD CONSTRAINT trips_customer_bill_fk
    FOREIGN KEY (customer_bill_id) REFERENCES customer_bills(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS trips_customer_bill_idx ON trips (customer_bill_id) WHERE customer_bill_id IS NOT NULL;

-- ── the lock: numbers freeze on RAISE; reopen needs a reason; the trips'
--    receipts may still move the received/balance/status and the counts ─────
CREATE OR REPLACE FUNCTION cb_lock_guard() RETURNS trigger AS $$
DECLARE money_same boolean;
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;
  money_same := NEW.gross = OLD.gross AND NEW.shortage_penalty = OLD.shortage_penalty
     AND NEW.tds = OLD.tds AND NEW.net_receivable = OLD.net_receivable
     AND NEW.lines = OLD.lines AND NEW.adjustments = OLD.adjustments
     AND NEW.posted_lines = OLD.posted_lines
     AND NEW.revenue_to_post = OLD.revenue_to_post;
  -- a reasoned reopen
  IF NEW.locked_at IS NULL AND NEW.status = 'STAFF_REVIEWED'
     AND NEW.reopen_reason IS NOT NULL AND btrim(NEW.reopen_reason) <> ''
     AND money_same THEN RETURN NEW; END IF;
  -- receipts, disputes, notes, status among the paid states — on a locked bill
  IF NEW.locked_at IS NOT NULL AND money_same
     AND NEW.status IN ('RAISED','PART_PAID','PAID','DISPUTED','CANCELLED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION
    'Bill % (%, % to %) is raised and locked. Use Modify with a reason first.',
    OLD.bill_no, OLD.customer_name, OLD.period_from, OLD.period_to
    USING ERRCODE = 'P0415';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cb_lock ON customer_bills;
CREATE TRIGGER cb_lock BEFORE UPDATE ON customer_bills
  FOR EACH ROW EXECUTE FUNCTION cb_lock_guard();

-- A bill with an unpriced trip cannot be raised: it would post revenue that
-- is not a number yet.
CREATE OR REPLACE FUNCTION cb_raise_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('RAISED','PART_PAID','PAID') AND OLD.status IN ('AI_DRAFT','STAFF_REVIEWED')
     AND NEW.unpriced_count > 0 THEN
    RAISE EXCEPTION
      'Bill % (%): % trip ka rate/qty nahi — pehle price kijiye, tab raise hoga.',
      NEW.bill_no, NEW.customer_name, NEW.unpriced_count USING ERRCODE = 'P0416';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cb_raise ON customer_bills;
CREATE TRIGGER cb_raise BEFORE UPDATE ON customer_bills
  FOR EACH ROW EXECUTE FUNCTION cb_raise_guard();

-- ═══ 5. EVERY TRIP, RECONCILED — derived from what the pipeline wrote ═════
--
--   UNPRICED  no billed amount yet
--   PAID      received ≥ gross − penalty (within Rs2; receipts are gross-basis)
--   SHORT     something received, less than that (penalty / shortage)
--   PENDING   in the customer's bill (IOCL bill no / matched) or the customer
--             has no bill pipeline — money not yet come
--   MISSING   IOCL has issued bills for this fortnight and this trip is in
--             none of them — the freight IOCL did not bill
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
       COALESCE(t.unloading_date, t.loading_date)                  AS bill_date,
       fortnight_from(COALESCE(t.unloading_date, t.loading_date))  AS period_from,
       date_trunc('month', COALESCE(t.unloading_date, t.loading_date))::date AS month_from,
       t.product_type, t.loaded_qty, t.shortage_qty, t.rtkm, t.rate,
       t.iocl_bill_no, t.challan_no,
       COALESCE(t.billed_amount, 0)::numeric(14,2)                 AS gross,
       COALESCE(t.shortage_penalty, 0)::numeric(14,2)              AS penalty,
       COALESCE(t.tds_amount, 0)::numeric(14,2)                    AS tds,
       COALESCE(t.received_amount, 0)::numeric(14,2)               AS received,
       t.linked_bill_id, t.billing_status, t.customer_bill_id,
       m.match_status, m.bill_no                                   AS their_bill_no,
       CASE
         WHEN COALESCE(t.billed_amount, 0) <= 0 THEN 'UNPRICED'
         WHEN COALESCE(t.received_amount, 0) >= COALESCE(t.billed_amount, 0) - COALESCE(t.shortage_penalty, 0) - 2 THEN 'PAID'
         WHEN COALESCE(t.received_amount, 0) > 0 THEN 'SHORT'
         WHEN t.iocl_bill_no IS NOT NULL OR m.trip_id IS NOT NULL THEN 'PENDING'
         WHEN c.customer_code = '11024699'
              AND EXISTS (SELECT 1 FROM iocl_bill_lines l
                           WHERE l.line_date BETWEEN fortnight_from(COALESCE(t.unloading_date, t.loading_date))
                                                 AND fortnight_to(COALESCE(t.unloading_date, t.loading_date)))
              THEN 'MISSING'
         ELSE 'PENDING'
       END                                                         AS flag
  FROM trips t
  LEFT JOIN customers c ON c.id = customer_of(t.customer_name)
  LEFT JOIN LATERAL (
    SELECT m.trip_id, m.bill_no, m.match_status FROM iocl_recon_matches m
     WHERE m.trip_id = t.id ORDER BY m.created_at DESC LIMIT 1) m ON true
 WHERE t.status = 'COMPLETED';

COMMENT ON VIEW v_customer_trip_recon IS
  'Every completed trip against what the customer paid for it, one flag each: '
  'UNPRICED / PAID / SHORT / PENDING / MISSING. Derived from trips.received_amount, '
  'iocl_bill_no and iocl_recon_matches — nothing typed.';

-- ═══ 6. THE BRANCH BLOCKS, AS THE BILL PRINTS THEM ════════════════════════
CREATE OR REPLACE FUNCTION customer_bill_lines(p_customer uuid, p_books text, p_from date, p_to date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH rows AS (
    SELECT r.*, (SELECT cb.source = 'CONFIRMED' FROM customer_branches cb
                  WHERE cb.customer_id = r.customer_id AND cb.branch_key = r.branch_key) AS branch_confirmed
      FROM v_customer_trip_recon r
     WHERE r.customer_id = p_customer
       AND COALESCE(norm_company(r.operating_company), '') = p_books
       AND r.bill_date BETWEEN p_from AND p_to
  ), blocks AS (
    SELECT COALESCE(branch_key, '(BRANCH DARJ NAHI)') AS branch_key,
           max(branch_code) AS branch_code,
           COALESCE(min(branch_name), '(branch darj nahi)') AS branch_name,
           bool_or(COALESCE(branch_confirmed, false)) AS confirmed,
           count(*)::int AS trips,
           min(bill_date) AS first_date,               -- blocks in the order the work happened
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
             'flag', flag, 'legacy_bill', linked_bill_id IS NOT NULL)
             ORDER BY bill_date, trip_code) AS trips_json
      FROM rows
     GROUP BY COALESCE(branch_key, '(BRANCH DARJ NAHI)')
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'branch_key', branch_key, 'branch_code', branch_code, 'branch_name', branch_name,
           'confirmed', confirmed, 'trips', trips_json,
           'subtotal', jsonb_build_object('trips', trips, 'qty', qty, 'rtkm', rtkm, 'gross', gross,
                                          'penalty', penalty, 'tds', tds, 'received', received))
           ORDER BY first_date, branch_name), '[]'::jsonb)
    FROM blocks
$$;

-- ═══ 7. THE BILL'S FOOT, FROM ITS TRIPS ═══════════════════════════════════
CREATE OR REPLACE FUNCTION adj_income_of(a jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((x->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(a, '[]'::jsonb)) x WHERE x->>'side' = 'INCOME'
$$;
CREATE OR REPLACE FUNCTION adj_expense_of(a jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((x->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(a, '[]'::jsonb)) x WHERE x->>'side' = 'EXPENSE'
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
         count(DISTINCT COALESCE(r.branch_key, '(BRANCH DARJ NAHI)'))::int AS branches,
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
   WHERE r.customer_id = b.customer_id
     AND r.books_key = b.books_key
     AND r.bill_date BETWEEN b.period_from AND b.period_to;

  adj_in := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a WHERE a->>'side' = 'INCOME'), 0);
  adj_ex := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a WHERE a->>'side' = 'EXPENSE'), 0);
  -- TDS as IOCL actually deducted where the pipeline knows it; the customer's
  -- rate on the rest.
  v_tds := CASE WHEN x.tds_actual > 0 THEN x.tds_actual
                ELSE round(x.gross * COALESCE(c.tds_pct_deducted, 0) / 100.0, 2) END;

  v_status := b.status;
  IF b.locked_at IS NOT NULL AND b.status IN ('RAISED','PART_PAID','PAID') THEN
    v_status := CASE WHEN x.gross > 0 AND x.gross - x.penalty - x.received <= 2 AND x.missing_count = 0 THEN 'PAID'
                     WHEN x.received > 0 THEN 'PART_PAID'
                     ELSE 'RAISED' END;
  END IF;

  IF b.locked_at IS NULL THEN
    -- Everything is still open: the register decides the whole foot.
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
           lines = customer_bill_lines(b.customer_id, b.books_key, b.period_from, b.period_to),
           updated_at = now()
     WHERE id = p_bill;
  ELSE
    -- Raised: the bill's numbers are what was signed; only the money that
    -- arrived and the reconciliation counts move.
    UPDATE customer_bills
       SET received = x.received,
           balance = round(gross + adj_income_of(adjustments) - adj_expense_of(adjustments) - shortage_penalty - x.received, 2),
           paid_count = x.paid_count, short_count = x.short_count, missing_count = x.missing_count,
           pending_count = x.pending_count,
           short_amount = x.short_amount, missing_amount = x.missing_amount, pending_amount = x.pending_amount,
           status = CASE WHEN status = 'DISPUTED' THEN 'DISPUTED' ELSE v_status END,
           updated_at = now()
     WHERE id = p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION adj_income_of(a jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((x->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(a, '[]'::jsonb)) x WHERE x->>'side' = 'INCOME'
$$;
CREATE OR REPLACE FUNCTION adj_expense_of(a jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((x->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(a, '[]'::jsonb)) x WHERE x->>'side' = 'EXPENSE'
$$;

-- ═══ 8. BILL NUMBERS ══════════════════════════════════════════════════════
-- CB-IOC-JUN-H2-2026 for a fortnight, CB-AGI-JUN-2026 for a month.
CREATE OR REPLACE FUNCTION customer_bill_no(p_customer text, p_kind text, p_from date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_kind = 'MONTH'
              THEN 'CB-' || split_part(substr(owner_bill_no(p_customer, 'ATTACHED', p_from), 4), '-', 1)
                   || '-' || upper(to_char(p_from, 'MON')) || '-' || to_char(p_from, 'YYYY')
              ELSE 'CB-' || substr(owner_bill_no(p_customer, 'ATTACHED', p_from), 4) END
$$;

-- ═══ 9. BUILD — every customer's bill for the cycle that contains p_from ═══
-- Fortnight customers get the fortnight; month customers get the month. Both
-- run from the same 1st/16th pass. Raised bills are refreshed for money only.
CREATE OR REPLACE FUNCTION customer_bills_build(p_from date, p_by text DEFAULT 'system')
RETURNS TABLE (created int, refreshed int, skipped int) AS $$
DECLARE
  g record; v_id uuid; v_locked timestamptz; v_no text; v_base text; n int;
  v_created int := 0; v_refreshed int := 0; v_skipped int := 0;
  f_from date := fortnight_from(p_from); f_to date := fortnight_to(p_from);
  m_from date := date_trunc('month', p_from)::date;
  m_to   date := (date_trunc('month', p_from) + interval '1 month - 1 day')::date;
BEGIN
  FOR g IN
    SELECT r.customer_id, r.books_key, max(r.operating_company) AS operating_company,
           c.customer_name, c.bill_cycle,
           CASE WHEN c.bill_cycle = 'MONTH' THEN m_from ELSE f_from END AS p_from,
           CASE WHEN c.bill_cycle = 'MONTH' THEN m_to   ELSE f_to   END AS p_to,
           (SELECT id FROM companies co WHERE norm_company_name(co.company_name) = norm_company_name(max(r.operating_company)) LIMIT 1) AS company_id
      FROM v_customer_trip_recon r
      JOIN customers c ON c.id = r.customer_id
     WHERE c.bill_cycle IN ('FORTNIGHT','MONTH')
       AND r.bill_date BETWEEN CASE WHEN c.bill_cycle = 'MONTH' THEN m_from ELSE f_from END
                           AND CASE WHEN c.bill_cycle = 'MONTH' THEN m_to   ELSE f_to   END
     GROUP BY r.customer_id, r.books_key, c.customer_name, c.bill_cycle
     ORDER BY r.customer_id, r.books_key      -- deterministic: the tail goes to the later books
  LOOP
    SELECT b.id, b.locked_at INTO v_id, v_locked
      FROM customer_bills b
     WHERE b.customer_id = g.customer_id AND b.books_key = g.books_key AND b.period_from = g.p_from;

    IF v_id IS NULL THEN
      v_base := customer_bill_no(g.customer_name, g.bill_cycle, g.p_from);
      -- Two firms' books for one customer in one cycle: -PT / -JE style tail.
      IF EXISTS (SELECT 1 FROM customer_bills WHERE bill_no = v_base) AND g.company_id IS NOT NULL THEN
        v_base := v_base || '-' || split_part(substr(owner_bill_no(g.operating_company, 'ATTACHED', g.p_from), 4), '-', 1);
      END IF;
      v_no := v_base; n := 1;
      WHILE EXISTS (SELECT 1 FROM customer_bills WHERE bill_no = v_no) LOOP
        n := n + 1; v_no := v_base || '-' || n;
      END LOOP;
      INSERT INTO customer_bills
        (bill_no, customer_id, customer_name, company_id, operating_company, books_key,
         cycle_kind, period_from, period_to, cycle, status, created_by)
      VALUES (v_no, g.customer_id, g.customer_name, g.company_id, g.operating_company, g.books_key,
              g.bill_cycle, g.p_from, g.p_to,
              CASE WHEN g.bill_cycle = 'MONTH' THEN to_char(g.p_from, 'YYYY-MM') ELSE fortnight_code(g.p_from) END,
              'AI_DRAFT', p_by)
      RETURNING id INTO v_id;
      v_created := v_created + 1;
    ELSIF v_locked IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      PERFORM customer_bill_refresh(v_id);     -- money moves on a raised bill
      CONTINUE;
    ELSE
      v_refreshed := v_refreshed + 1;
    END IF;

    -- The trips of an open bill follow it; a raised bill keeps its trips.
    UPDATE trips t
       SET customer_bill_id = v_id
      FROM v_customer_trip_recon r
     WHERE r.trip_id = t.id
       AND r.customer_id = g.customer_id AND r.books_key = g.books_key
       AND r.bill_date BETWEEN g.p_from AND g.p_to
       AND (t.customer_bill_id IS NULL
            OR t.customer_bill_id IN (SELECT id FROM customer_bills WHERE locked_at IS NULL));

    PERFORM customer_bill_refresh(v_id);
  END LOOP;

  -- An open draft whose trips all moved away (customer corrected) goes.
  DELETE FROM customer_bills b
   WHERE b.locked_at IS NULL AND b.status IN ('AI_DRAFT','STAFF_REVIEWED')
     AND b.period_from IN (f_from, m_from)
     AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.customer_bill_id = b.id);

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- ═══ 10. WHAT THE LIST READS ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_customer_bill AS
SELECT b.*,
       CASE WHEN b.cycle_kind = 'MONTH' THEN to_char(b.period_from, 'Mon YYYY') || ' · 1–' || to_char(b.period_to, 'DD')
            ELSE fortnight_label(b.period_from) END                      AS cycle_label,
       (b.locked_at IS NOT NULL)                                          AS locked,
       co.company_name,
       c.customer_code, c.gst_no, c.pan_no,
       -- their lines with no trip of ours in this period (IOCL pipeline only)
       (SELECT count(*)::int FROM iocl_recon_matches m
         WHERE c.customer_code = '11024699' AND m.match_status <> 'MATCHED'
           AND m.trip_date BETWEEN b.period_from AND b.period_to)         AS their_unmatched,
       (SELECT COALESCE(sum(m.gross_amt), 0)::numeric(14,2) FROM iocl_recon_matches m
         WHERE c.customer_code = '11024699' AND m.match_status <> 'MATCHED'
           AND m.trip_date BETWEEN b.period_from AND b.period_to)         AS their_unmatched_amount
  FROM customer_bills b
  LEFT JOIN companies co ON co.id = b.company_id
  LEFT JOIN customers c ON c.id = b.customer_id;

-- ═══ 11. THE MAPPING DESK — what a person must decide ═════════════════════
CREATE OR REPLACE VIEW v_customer_mapping_audit AS
-- trips with no customer
SELECT 'NO_CUSTOMER'::text AS finding, 'HIGH'::text AS severity,
       COALESCE(btrim(t.operating_company), '(no company)') AS subject,
       count(*)::int AS trips, COALESCE(sum(t.billed_amount), 0)::numeric(14,2) AS amount,
       format('%s trip par customer nahi (%s se %s) — bill nahi ban sakta', count(*), min(t.loading_date), max(t.loading_date)) AS detail
  FROM trips t WHERE t.status = 'COMPLETED' AND (t.customer_name IS NULL OR btrim(t.customer_name) = '')
 GROUP BY 3
UNION ALL
-- a spelling nobody has mapped
SELECT 'UNKNOWN_NAME', 'HIGH', btrim(t.customer_name), count(*)::int, COALESCE(sum(t.billed_amount), 0)::numeric(14,2),
       format('"%s" kisi customer se juda nahi — %s trip', btrim(t.customer_name), count(*))
  FROM trips t WHERE t.status = 'COMPLETED' AND t.customer_name IS NOT NULL AND btrim(t.customer_name) <> ''
   AND customer_of(t.customer_name) IS NULL
 GROUP BY 3
UNION ALL
-- a learned branch nobody has confirmed
SELECT 'BRANCH_UNCONFIRMED', 'LOW', c.customer_name || ' · ' || cb.branch_name,
       (SELECT count(*)::int FROM trips t WHERE customer_of(t.customer_name) = cb.customer_id AND branch_key(t.unloading_location) = cb.branch_key),
       0::numeric(14,2),
       format('branch "%s" trip se seekhi — confirm kijiye', cb.branch_name)
  FROM customer_branches cb JOIN customers c ON c.id = cb.customer_id
 WHERE cb.source = 'LEARNED'
UNION ALL
-- a customer's trip with no branch
SELECT 'NO_BRANCH', 'MEDIUM', c.customer_name, count(*)::int, COALESCE(sum(t.billed_amount), 0)::numeric(14,2),
       format('%s trip par unloading location khaali — bill me "(branch darj nahi)" me jaayenge', count(*))
  FROM trips t JOIN customers c ON c.id = customer_of(t.customer_name)
 WHERE t.status = 'COMPLETED' AND (t.unloading_location IS NULL OR btrim(t.unloading_location) = '')
 GROUP BY 3
UNION ALL
-- unpriced
SELECT 'UNPRICED', 'HIGH', c.customer_name, count(*)::int, 0::numeric(14,2),
       format('%s trip bina rate/amount ke — bill raise nahi hoga', count(*))
  FROM trips t JOIN customers c ON c.id = customer_of(t.customer_name)
 WHERE t.status = 'COMPLETED' AND COALESCE(t.billed_amount, 0) <= 0
 GROUP BY 3
UNION ALL
-- customer type not set
SELECT 'NO_TYPE', 'MEDIUM', c.customer_name, 0, 0::numeric(14,2),
       'customer ka prakaar (Oil Company / Contract / Market) tay nahi'
  FROM customers c WHERE c.status = 'ACTIVE' AND c.customer_type IS NULL;

COMMENT ON VIEW v_customer_mapping_audit IS
  'What stops a customer bill from being right: trips with no customer, spellings '
  'mapped to nobody, unconfirmed branches, blank branches, unpriced trips, untyped '
  'customers. Surfaced for the desk; nothing is corrected automatically.';
