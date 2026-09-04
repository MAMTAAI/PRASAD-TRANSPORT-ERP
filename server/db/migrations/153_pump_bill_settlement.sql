-- ═══════════════════════════════════════════════════════════════════════════
-- 153 — Settling a pump's 15-day credit bill with card swipes
--
-- "HAR BIL KA SYKEL 15 DAY KA HAY SIR" — owner, 4-Sep-2026.
--
-- WHAT THE DATA SAYS ABOUT THE SHAPE OF THIS, and it is not what an exact-match
-- rule assumes: outstanding pump credit is 54,38,253 across 49 bills — about
-- 1.1 lakh a fortnight per pump — while a single card swipe is 7,776 or 14,386.
-- Checked against every unallocated swipe on 4-Sep-2026, exactly ZERO equal a
-- bill's outstanding, and only 2 come within 2%.
--
-- So the relationship is MANY SWIPES TO ONE BILL, not one to one. A fortnight
-- of diesel is drawn a lorry at a time and settled as one bill. The exact-match
-- rule below is still built, because a bill paid off by a single swipe is a
-- real case and will happen — but the work that clears the backlog is
-- fleet_card_settle_cycle(), which applies every pending swipe at one pump in
-- one fortnight against that pump's bill, oldest first, and stops at the
-- bill's outstanding.
--
-- NOTHING HERE POSTS TO A LEDGER. TARA posts, under approval.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. One pump, two spellings ────────────────────────────────────────────
--
-- The card says "BN FILLING STATION BHARAT PETROLEUM DEALERS"; the bill says
-- "B N FILLING STATION". Same pump, and no join will ever meet on the raw
-- text. This is reg_key() for pumps: strip the oil company's dealer tag,
-- normalise the obvious abbreviation, and collapse to letters and digits.
--
-- It resolves 8 of the 9 pumps that bill this firm. The ninth is a genuine
-- spelling difference — the card writes BHAGWAN, the bill writes BHAGAWAN —
-- and no normaliser should paper over that: a person links it, or the vendor
-- master is corrected. Guessing across a real difference in a name is how a
-- payment lands at the wrong pump.
CREATE OR REPLACE FUNCTION pump_key(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(upper(coalesce(t, '')),
               '(BHARAT PETROLEUM DEALERS|BPCL DEALERS|INDIAN OIL|IOCL|HPCL|PVT LTD|PRIVATE LIMITED)',
               ' ', 'g'),
             '\mSTN\M', 'STATION', 'g'),
         '[^A-Z0-9]', '', 'g')
$$;

COMMENT ON FUNCTION pump_key(text) IS
  'Normalises a petrol pump name so the card statement and the pump bill meet. '
  'Same idea as reg_key() for lorries. Does NOT bridge real spelling '
  'differences — those are for a person to link.';

CREATE INDEX IF NOT EXISTS pump_bill_vendor_key_idx ON pump_bill_drafts (pump_key(vendor_name));
CREATE INDEX IF NOT EXISTS fleet_card_merchant_key_idx ON fleet_card_statement_txns (pump_key(merchant_name));

-- ── 2. The fortnight ──────────────────────────────────────────────────────
--
-- 1st–15th and 16th–end. "31st" is wrong for February and every 30-day month,
-- so the close is computed, exactly as scheduler.js already does it.
CREATE OR REPLACE FUNCTION fortnight_code(d date) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(d, 'YYYY-MM') || CASE WHEN extract(day FROM d) <= 15 THEN '-H1' ELSE '-H2' END
$$;

CREATE OR REPLACE FUNCTION fortnight_from(d date) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN extract(day FROM d) <= 15
              THEN date_trunc('month', d)::date
              ELSE (date_trunc('month', d) + interval '15 days')::date END
$$;

CREATE OR REPLACE FUNCTION fortnight_to(d date) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN extract(day FROM d) <= 15
              THEN (date_trunc('month', d) + interval '14 days')::date
              ELSE (date_trunc('month', d) + interval '1 month - 1 day')::date END
$$;

CREATE OR REPLACE FUNCTION fortnight_label(d date) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(d, 'Mon YYYY') || ' · '
       || CASE WHEN extract(day FROM d) <= 15
               THEN '1–15'
               ELSE '16–' || to_char(fortnight_to(d), 'DD') END
$$;

-- ── 3. What a pump is still owed ──────────────────────────────────────────
CREATE OR REPLACE VIEW v_pump_bill_outstanding AS
SELECT b.id,
       b.vendor_id,
       b.vendor_name,
       pump_key(b.vendor_name)                                   AS vendor_key,
       b.ref_no,
       b.period_from,
       b.period_to,
       b.half,
       b.status,
       fortnight_code(b.period_from)                             AS cycle,
       fortnight_label(b.period_from)                            AS cycle_label,
       b.slip_count,
       b.system_amount,
       b.physical_amount,
       COALESCE(b.physical_amount, b.system_amount)::numeric(16,2)          AS billed,
       COALESCE(p.paid, 0)::numeric(16,2)                                   AS paid,
       (COALESCE(b.physical_amount, b.system_amount) - COALESCE(p.paid, 0))::numeric(16,2)
                                                                            AS due
  FROM pump_bill_drafts b
  LEFT JOIN LATERAL (
    SELECT sum(a.amount) AS paid FROM fleet_card_allocations a
     WHERE a.target_kind = 'PUMP_BILL' AND a.target_id = b.id) p ON true;

COMMENT ON VIEW v_pump_bill_outstanding IS
  'Every 15-day pump bill with what card swipes have already settled against '
  'it and what is still due.';

-- ── 4. A bill paid off by exactly one swipe ───────────────────────────────
--
-- Built as the owner specified. It will place nothing today — no swipe in the
-- current data equals a bill's outstanding — and that is worth saying out loud
-- rather than letting a silent zero look like a broken function.
--
-- Strict on purpose: the pump must resolve to the same key, the swipe must
-- equal the outstanding to the paisa, the swipe must fall in the bill's window
-- (or the 25 days after it, since a bill is settled after its period closes),
-- and exactly one bill must qualify. A second candidate means a person decides.
CREATE OR REPLACE FUNCTION fleet_card_auto_settle_bills()
RETURNS TABLE (settled integer, skipped_ambiguous integer) LANGUAGE plpgsql AS $fn$
DECLARE
  v_settled integer := 0;
  v_amb     integer := 0;
BEGIN
  WITH pair AS (
    SELECT u.txn_id, b.id AS bill_id, u.unallocated AS amount,
           count(*) OVER (PARTITION BY u.txn_id) AS bills_for_swipe,
           count(*) OVER (PARTITION BY b.id)     AS swipes_for_bill
      FROM v_fleet_card_unallocated u
      JOIN v_pump_bill_outstanding b
        ON b.vendor_key = pump_key(u.merchant_name)
       AND b.due > 0
       AND b.due = u.unallocated
       AND u.txn_date BETWEEN b.period_from AND b.period_to + 25
  ), clean AS (
    SELECT * FROM pair WHERE bills_for_swipe = 1 AND swipes_for_bill = 1
  ), ins AS (
    INSERT INTO fleet_card_allocations
      (txn_id, target_kind, target_id, amount, method, allocated_by, note)
    SELECT c.txn_id, 'PUMP_BILL', c.bill_id, c.amount, 'AUTO_EXACT',
           'AGENT_06 CHHINNAMASTA',
           'swipe equals this pump bill''s outstanding exactly'
      FROM clean c
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_settled FROM ins;

  SELECT count(DISTINCT txn_id) INTO v_amb FROM (
    SELECT u.txn_id, count(*) OVER (PARTITION BY u.txn_id) AS n
      FROM v_fleet_card_unallocated u
      JOIN v_pump_bill_outstanding b
        ON b.vendor_key = pump_key(u.merchant_name)
       AND b.due > 0 AND b.due = u.unallocated
       AND u.txn_date BETWEEN b.period_from AND b.period_to + 25) q
   WHERE q.n > 1;

  RETURN QUERY SELECT v_settled, v_amb;
END $fn$;

-- ── 5. The one that actually clears the backlog ───────────────────────────
--
-- Settle a pump's fortnight: take every swipe still waiting at that pump in
-- that cycle, oldest first, and apply it to the bill until the bill is paid.
--
-- OLDEST FIRST, and only up to the outstanding. The last swipe is allocated in
-- PART if it would overshoot, so the bill closes at exactly its amount and the
-- remainder of that swipe stays in clearing for the next fortnight — which is
-- what actually happens when a pump is paid a round figure.
--
-- p_dry_run is the default. This function moves real money against a real
-- creditor, so the caller has to ask for it twice: once to see what it would
-- do, once to do it. Every row it writes carries who asked.
CREATE OR REPLACE FUNCTION fleet_card_settle_cycle(
  p_bill_id  uuid,
  p_by       text DEFAULT 'desk',
  p_dry_run  boolean DEFAULT true,
  p_max      integer DEFAULT 500
)
RETURNS TABLE (
  txn_id uuid, txn_date date, vehicle text, amount numeric, applied numeric, running numeric
) LANGUAGE plpgsql AS $fn$
DECLARE
  v_key  text;
  v_from date;
  v_to   date;
  v_due  numeric(16,2);
  r      record;
  v_take numeric(16,2);
  v_left numeric(16,2);
BEGIN
  SELECT b.vendor_key, b.period_from, b.period_to, b.due
    INTO v_key, v_from, v_to, v_due
    FROM v_pump_bill_outstanding b WHERE b.id = p_bill_id;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'no such pump bill %', p_bill_id USING ERRCODE = 'P0407';
  END IF;
  IF v_due <= 0 THEN
    RAISE EXCEPTION 'this bill is already settled' USING ERRCODE = 'P0407';
  END IF;

  v_left := v_due;

  FOR r IN
    SELECT u.txn_id, u.txn_date, COALESCE(u.vehicle_no, u.vehicle_raw) AS veh,
           u.unallocated
      FROM v_fleet_card_unallocated u
     WHERE pump_key(u.merchant_name) = v_key
       AND u.txn_date BETWEEN v_from AND v_to + 25
     ORDER BY u.txn_date, u.txn_id
     LIMIT p_max
  LOOP
    EXIT WHEN v_left <= 0.005;
    v_take := LEAST(r.unallocated, v_left);
    IF v_take <= 0.005 THEN CONTINUE; END IF;

    IF NOT p_dry_run THEN
      INSERT INTO fleet_card_allocations
        (txn_id, target_kind, target_id, amount, method, allocated_by, note)
      VALUES (r.txn_id, 'PUMP_BILL', p_bill_id, v_take, 'MANUAL', p_by,
              'cycle settlement: ' || to_char(v_from, 'DD Mon') || '–'
              || to_char(v_to, 'DD Mon YYYY'))
      ON CONFLICT DO NOTHING;
    END IF;

    v_left := v_left - v_take;

    txn_id  := r.txn_id;
    txn_date := r.txn_date;
    vehicle := r.veh;
    amount  := r.unallocated;
    applied := v_take;
    running := v_due - v_left;
    RETURN NEXT;
  END LOOP;
END $fn$;

COMMENT ON FUNCTION fleet_card_settle_cycle(uuid, text, boolean, integer) IS
  'Applies every pending swipe at one pump in one fortnight against that '
  'pump''s bill, oldest first, stopping at the outstanding. Dry run by '
  'default — the caller asks once to preview and once to commit.';

-- ── 6. The queue, now carrying its cycle ──────────────────────────────────
--
-- DROPPED AND REBUILT, not CREATE OR REPLACE. Replace can only APPEND columns
-- to a view; the four cycle columns belong beside txn_date, in the middle, and
-- PostgreSQL refuses that outright ("cannot change name of view column
-- vehicle_raw to cycle"). Caught by the selftest — on production it would have
-- failed the migration and crash-looped the deploy.
--
-- The dependants go first and come back after, in dependency order. Dropping
-- with CASCADE instead would take them with it and leave them uncreated.
DROP VIEW IF EXISTS v_fleet_card_cycles;
DROP VIEW IF EXISTS v_fleet_card_clearing;
DROP VIEW IF EXISTS v_fleet_card_unallocated;

CREATE VIEW v_fleet_card_unallocated AS
SELECT x.id                     AS txn_id,
       x.account_id,
       a.provider,
       a.account_no,
       a.operating_company,
       a.clearing_ledger,
       x.txn_date,
       fortnight_code(x.txn_date)                            AS cycle,
       fortnight_label(x.txn_date)                           AS cycle_label,
       fortnight_from(x.txn_date)                            AS cycle_from,
       fortnight_to(x.txn_date)                              AS cycle_to,
       x.vehicle_raw,
       x.vehicle_no,
       x.merchant_name,
       pump_key(x.merchant_name)                             AS merchant_key,
       x.quantity,
       x.rate,
       x.amount,
       COALESCE(al.allocated, 0)::numeric(14,2)              AS allocated,
       (x.amount - COALESCE(al.allocated, 0))::numeric(14,2) AS unallocated,
       CASE
         WHEN x.vehicle_no IS NULL THEN 'NO_VEHICLE'
         WHEN EXISTS (SELECT 1 FROM fuel_entries f
                       WHERE reg_key(f.vehicle_no) = reg_key(x.vehicle_no)
                         AND f.entry_date BETWEEN x.txn_date - 1 AND x.txn_date + 1
                         AND f.liters = x.quantity AND f.amount = x.amount)
              THEN 'EXACT_BUT_CONTESTED'
         WHEN EXISTS (SELECT 1 FROM fuel_entries f
                       WHERE reg_key(f.vehicle_no) = reg_key(x.vehicle_no)
                         AND f.entry_date BETWEEN x.txn_date - 3 AND x.txn_date + 3)
              THEN 'MEMO_NEARBY_NOT_EXACT'
         -- Now says something sharper than "a bill exists somewhere": there is
         -- an OUTSTANDING bill at THIS pump covering this date.
         WHEN EXISTS (SELECT 1 FROM v_pump_bill_outstanding b
                       WHERE b.vendor_key = pump_key(x.merchant_name)
                         AND b.due > 0
                         AND x.txn_date BETWEEN b.period_from AND b.period_to + 25)
              THEN 'LIKELY_BILL_SETTLEMENT'
         ELSE 'NO_MEMO'
       END AS reason
  FROM fleet_card_statement_txns x
  JOIN fleet_card_accounts a ON a.id = x.account_id
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS allocated FROM fleet_card_allocations al2 WHERE al2.txn_id = x.id
  ) al ON true
 WHERE x.kind = 'SALE' AND x.unit = 'INR'
   AND x.amount - COALESCE(al.allocated, 0) > 0.005;

COMMENT ON VIEW v_fleet_card_unallocated IS
  'The Pending Manual Match queue: diesel swipes with money not yet placed, '
  'the 15-day cycle each falls in, and the reason each is waiting. '
  'LIKELY_BILL_SETTLEMENT now means an OUTSTANDING bill exists at that pump '
  'covering that date — not merely that some bill exists somewhere.';

-- ── 6b. Clearing, rebuilt on the new queue ────────────────────────────────
-- Same definition as migration 152; it only comes back here because it had to
-- be dropped to let the queue view change shape.
CREATE VIEW v_fleet_card_clearing AS
SELECT a.operating_company,
       a.clearing_ledger,
       count(*)                                                    AS swipes_waiting,
       sum(u.unallocated)::numeric(16,2)                           AS unallocated_amount,
       min(u.txn_date)                                             AS oldest,
       max(u.txn_date)                                             AS newest,
       count(*) FILTER (WHERE u.reason = 'LIKELY_BILL_SETTLEMENT') AS likely_settlements,
       count(*) FILTER (WHERE u.reason = 'NO_VEHICLE')             AS no_vehicle,
       count(*) FILTER (WHERE u.reason = 'MEMO_NEARBY_NOT_EXACT')  AS near_misses,
       count(*) FILTER (WHERE u.reason = 'NO_MEMO')                AS no_memo
  FROM v_fleet_card_unallocated u
  JOIN fleet_card_accounts a ON a.id = u.account_id
 GROUP BY 1, 2;

-- ── 7. The cycles, for the filter ─────────────────────────────────────────
CREATE VIEW v_fleet_card_cycles AS
SELECT u.cycle,
       u.cycle_label,
       u.cycle_from,
       u.cycle_to,
       count(*)::int                       AS swipes,
       sum(u.unallocated)::numeric(16,2)   AS unallocated,
       count(DISTINCT u.merchant_key)::int AS pumps,
       (SELECT count(*)::int FROM v_pump_bill_outstanding b
         WHERE b.cycle = u.cycle AND b.due > 0)             AS open_bills,
       (SELECT COALESCE(sum(b.due), 0)::numeric(16,2) FROM v_pump_bill_outstanding b
         WHERE b.cycle = u.cycle AND b.due > 0)             AS bill_due
  FROM v_fleet_card_unallocated u
 GROUP BY u.cycle, u.cycle_label, u.cycle_from, u.cycle_to;

COMMENT ON VIEW v_fleet_card_cycles IS
  'One row per 15-day billing cycle that still has unplaced card money, with '
  'what the pumps are still owed for the same cycle beside it.';
