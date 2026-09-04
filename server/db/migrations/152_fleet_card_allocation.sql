-- ═══════════════════════════════════════════════════════════════════════════
-- 152 — A card swipe is not always a fill. Allocation, and a clearing account.
--
-- THE BUSINESS RULE THIS ENCODES (owner, 4-Sep-2026):
--
--   "Card swipes are often used to pay off accumulated 15-day pump credit
--    bills, not just individual trip memos."
--
-- That is why 1:1 memo matching found only 83 of 1,086 swipes. A settlement
-- swipe does not correspond to one fill — it discharges a fortnight of them.
-- Forcing it onto the nearest memo would be worse than leaving it alone, and
-- not only because the trip would be wrong:
--
--   THE DIESEL WOULD BE COUNTED TWICE. When the pump gives credit, the expense
--   is already in the books through the memo. The card swipe that later settles
--   that bill is a PAYMENT, not a second purchase. Post both as fuel and the
--   lorry has burnt the diesel twice.
--
-- So a swipe is allocated, never matched: it may pay one trip, or part of a
-- fortnightly pump bill, or several. What is not allocated sits in a clearing
-- account, visibly, until a person says where it belongs. An unallocated swipe
-- is not an error — it is work waiting, and the queue is the work list.
--
-- WHAT THIS DOES NOT DO: post to the ledger. The clearing balance is reported
-- here; the voucher is TARA's, under approval, like every other rupee.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The clearing account ───────────────────────────────────────────────
--
-- NAMED, NOT DERIVED, and one per operating company — the same shape the
-- FASTag wallets already use ('FASTag Wallet: Prasad Transport'). Migration
-- 031 paid for this lesson: a derived name opened a second wallet beside the
-- real one and split the balance across both. 'Suspense A/c' is an existing
-- group head in this chart of accounts, not a new one.
-- THE GROUP FIRST. `ledgers.group_head` is a foreign key into account_groups,
-- so a ledger under a group that does not exist fails the whole migration and
-- crash-loops the deploy. Production already has 'Suspense A/c'; this makes the
-- migration true of any database, and is written to match production's own row
-- exactly rather than inventing a second definition of the same group.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Suspense A/c', 'LIABILITY', 'BALANCE_SHEET', 'CR', 290, true
 WHERE NOT EXISTS (SELECT 1 FROM account_groups g WHERE g.group_head = 'Suspense A/c');

-- dr_cr is DR, not the group's CR, and that is deliberate: the money has
-- already left the card wallet, so the clearing account holds a DEBIT until it
-- is placed against an expense. A suspense group carrying a debit balance is
-- ordinary — the group's normal_side is the usual case, not a rule — but if
-- the office would rather see this on the other side of the balance sheet, it
-- is a one-line change here and nowhere else.
INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, creation_type, status)
SELECT v.nm, 'Suspense A/c', 'DR', 0, 'SYSTEM', 'ACTIVE'
  FROM (VALUES
    ('Unallocated Card Payments: Prasad Transport'),
    ('Unallocated Card Payments: Jaiswal Enterprise')
  ) AS v(nm)
 WHERE NOT EXISTS (SELECT 1 FROM ledgers l WHERE l.ledger_name = v.nm);

-- Which clearing ledger a card's swipes park in. Derived from the account's
-- operating company ONCE, here, so the rest of the system reads a column
-- instead of re-deriving a name it might spell differently.
ALTER TABLE fleet_card_accounts
  ADD COLUMN IF NOT EXISTS clearing_ledger text;

UPDATE fleet_card_accounts SET clearing_ledger =
  CASE
    WHEN operating_company ILIKE '%PRASAD%'  THEN 'Unallocated Card Payments: Prasad Transport'
    WHEN operating_company ILIKE '%JAISWAL%' THEN 'Unallocated Card Payments: Jaiswal Enterprise'
    ELSE NULL
  END
 WHERE clearing_ledger IS NULL;

-- ── 2. Allocation ─────────────────────────────────────────────────────────
--
-- One row = "this much of this swipe belongs to that thing". A swipe may have
-- many rows (a settlement split across a fortnight's bills); a target may be
-- named by many swipes (a bill paid in two goes). Both directions are real,
-- which is why this is a table and not a column on the swipe.
CREATE TABLE IF NOT EXISTS fleet_card_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_id       uuid NOT NULL REFERENCES fleet_card_statement_txns(id) ON DELETE CASCADE,

  -- What the money is being put against.
  --   TRIP         one trip's fuel, when the swipe is a single fill
  --   FUEL_ENTRY   a specific memo already in the fuel register
  --   PUMP_BILL    a 15-day pump_bill_drafts bundle — the settlement case
  --   REVIEW_SLIP  a memo still parked in fuel_import_review
  --   WRITE_OFF    deliberately not ours to allocate (says so, in `note`)
  target_kind  text NOT NULL CHECK (target_kind IN
                 ('TRIP','FUEL_ENTRY','PUMP_BILL','REVIEW_SLIP','WRITE_OFF')),
  -- NULL only for WRITE_OFF, which points at nothing by definition.
  target_id    uuid,

  amount       numeric(14,2) NOT NULL CHECK (amount > 0),

  -- AUTO_EXACT is the only allocation a machine is allowed to make, and only
  -- on the owner's rule: same lorry, date within a day, litres AND amount
  -- exactly equal. Everything else carries a person's name.
  method       text NOT NULL DEFAULT 'MANUAL' CHECK (method IN ('AUTO_EXACT','MANUAL')),
  allocated_by text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fleet_card_alloc_target_ck
    CHECK ((target_kind = 'WRITE_OFF') = (target_id IS NULL))
);

CREATE INDEX IF NOT EXISTS fleet_card_alloc_txn_idx    ON fleet_card_allocations (txn_id);
CREATE INDEX IF NOT EXISTS fleet_card_alloc_target_idx ON fleet_card_allocations (target_kind, target_id);

-- The same swipe must not be put against the same thing twice. Two people
-- working the queue at once is the ordinary way that happens.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_card_alloc_once
  ON fleet_card_allocations (txn_id, target_kind, target_id)
  WHERE target_id IS NOT NULL;

-- ── 3. A swipe cannot pay out more than it was ────────────────────────────
--
-- THE ONE GUARD THAT MATTERS. Without it, allocating a 20,000 swipe across
-- three 15,000 bills discharges 45,000 of pump credit with 20,000 of money,
-- and the books gain 25,000 that never existed. It is enforced in the database
-- because two clerks on the same swipe is exactly the case a UI check misses.
CREATE OR REPLACE FUNCTION fleet_card_allocation_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_txn   numeric(14,2);
  v_alloc numeric(14,2);
BEGIN
  SELECT amount INTO v_txn FROM fleet_card_statement_txns WHERE id = NEW.txn_id;
  IF v_txn IS NULL THEN
    RAISE EXCEPTION 'card transaction % does not exist', NEW.txn_id
      USING ERRCODE = 'P0406';
  END IF;

  SELECT COALESCE(sum(amount), 0) INTO v_alloc
    FROM fleet_card_allocations
   WHERE txn_id = NEW.txn_id AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_alloc + NEW.amount > v_txn + 0.005 THEN
    RAISE EXCEPTION
      'allocation would exceed the swipe: swipe is %, already allocated %, this adds % (over by %)',
      v_txn, v_alloc, NEW.amount, (v_alloc + NEW.amount - v_txn)
      USING ERRCODE = 'P0406',
            HINT = 'Allocate the remainder only, or reduce an existing allocation first.';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS fleet_card_alloc_guard ON fleet_card_allocations;
CREATE TRIGGER fleet_card_alloc_guard
  BEFORE INSERT OR UPDATE ON fleet_card_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_card_allocation_guard();

-- ── 4. The only allocation a machine may make ─────────────────────────────
--
-- The owner's rule, exactly as given: date within one day, litres AND amount
-- EXACTLY equal, same lorry. No tolerance band — a 2% band was what produced
-- 277 "nearly" matches that a person still had to look at, and a machine
-- guessing at 2% is a machine guessing.
--
-- A memo that two swipes could both claim is left for a person, deliberately:
-- being sure which of two identical fills a swipe paid for is not something
-- this function can know, and picking one silently is the worst outcome.
CREATE OR REPLACE FUNCTION fleet_card_auto_allocate(p_account uuid DEFAULT NULL)
RETURNS TABLE (allocated integer, skipped_ambiguous integer) LANGUAGE plpgsql AS $fn$
DECLARE
  v_alloc integer := 0;
  v_amb   integer := 0;
BEGIN
  WITH candidate AS (
    SELECT x.id AS txn_id, f.id AS fuel_id, f.trip_id, x.amount,
           count(*) OVER (PARTITION BY f.id) AS memo_claimed_by,
           count(*) OVER (PARTITION BY x.id) AS memos_for_swipe
      FROM fleet_card_statement_txns x
      JOIN fuel_entries f
        ON reg_key(f.vehicle_no) = reg_key(x.vehicle_no)
       AND f.entry_date BETWEEN x.txn_date - 1 AND x.txn_date + 1
       AND f.liters = x.quantity          -- exact litres
       AND f.amount = x.amount            -- exact rupees
     WHERE x.kind = 'SALE' AND x.unit = 'INR'
       AND x.vehicle_no IS NOT NULL
       AND (p_account IS NULL OR x.account_id = p_account)
       AND NOT EXISTS (SELECT 1 FROM fleet_card_allocations a WHERE a.txn_id = x.id)
  ), clean AS (
    SELECT * FROM candidate WHERE memo_claimed_by = 1 AND memos_for_swipe = 1
  ), ins AS (
    INSERT INTO fleet_card_allocations
      (txn_id, target_kind, target_id, amount, method, allocated_by, note)
    SELECT c.txn_id,
           CASE WHEN c.trip_id IS NOT NULL THEN 'TRIP' ELSE 'FUEL_ENTRY' END,
           COALESCE(c.trip_id, c.fuel_id),
           c.amount, 'AUTO_EXACT', 'AGENT_06 CHHINNAMASTA',
           'exact match: same lorry, date within a day, litres and amount equal'
      FROM clean c
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_alloc FROM ins;

  SELECT count(DISTINCT txn_id) INTO v_amb
    FROM (
      SELECT x.id AS txn_id, count(*) OVER (PARTITION BY f.id) AS claimed
        FROM fleet_card_statement_txns x
        JOIN fuel_entries f
          ON reg_key(f.vehicle_no) = reg_key(x.vehicle_no)
         AND f.entry_date BETWEEN x.txn_date - 1 AND x.txn_date + 1
         AND f.liters = x.quantity AND f.amount = x.amount
       WHERE x.kind = 'SALE' AND x.unit = 'INR' AND x.vehicle_no IS NOT NULL
         AND (p_account IS NULL OR x.account_id = p_account)
         AND NOT EXISTS (SELECT 1 FROM fleet_card_allocations a WHERE a.txn_id = x.id)
    ) q WHERE claimed > 1;

  RETURN QUERY SELECT v_alloc, v_amb;
END $fn$;

-- ── 5. What is still sitting in clearing ──────────────────────────────────
--
-- The Pending Manual Match queue. Every diesel swipe with money still
-- unallocated, and why it did not settle itself — so the desk reads a reason,
-- not a mystery.
CREATE OR REPLACE VIEW v_fleet_card_unallocated AS
SELECT x.id                     AS txn_id,
       x.account_id,
       a.provider,
       a.account_no,
       a.operating_company,
       a.clearing_ledger,
       x.txn_date,
       x.vehicle_raw,
       x.vehicle_no,
       x.merchant_name,
       x.quantity,
       x.rate,
       x.amount,
       COALESCE(al.allocated, 0)::numeric(14,2)              AS allocated,
       (x.amount - COALESCE(al.allocated, 0))::numeric(14,2) AS unallocated,
       -- Why this one is here. Ordered most-specific first.
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
         WHEN EXISTS (SELECT 1 FROM pump_bill_drafts b
                       WHERE x.txn_date BETWEEN b.period_from AND b.period_to + 20)
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
  'and the reason each is waiting. LIKELY_BILL_SETTLEMENT is the owner''s rule '
  '— a swipe that falls in a 15-day pump bill window and pays it, not a fill.';

-- ── 6. The clearing balance, per company ──────────────────────────────────
CREATE OR REPLACE VIEW v_fleet_card_clearing AS
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

-- ── 7. What a swipe was put against, in words ─────────────────────────────
CREATE OR REPLACE VIEW v_fleet_card_allocation_detail AS
SELECT al.id, al.txn_id, al.target_kind, al.target_id, al.amount, al.method,
       al.allocated_by, al.note, al.created_at,
       CASE al.target_kind
         WHEN 'TRIP'        THEN (SELECT 'Trip ' || COALESCE(t.trip_code, '?') || ' · ' ||
                                          COALESCE(t.vehicle_no, '?')
                                    FROM trips t WHERE t.id = al.target_id)
         WHEN 'FUEL_ENTRY'  THEN (SELECT 'Memo ' || COALESCE(f.memo_no, '?') || ' · ' ||
                                          COALESCE(f.vendor_name, '?')
                                    FROM fuel_entries f WHERE f.id = al.target_id)
         WHEN 'PUMP_BILL'   THEN (SELECT COALESCE(b.vendor_name, '?') || ' · ' ||
                                          to_char(b.period_from, 'DD Mon') || '–' ||
                                          to_char(b.period_to, 'DD Mon YYYY')
                                    FROM pump_bill_drafts b WHERE b.id = al.target_id)
         WHEN 'REVIEW_SLIP' THEN (SELECT 'Parked slip ' || COALESCE(r.memo_no, '?') || ' · ' ||
                                          COALESCE(r.pump, '?')
                                    FROM fuel_import_review r WHERE r.id = al.target_id)
         ELSE 'Written off'
       END AS target_label
  FROM fleet_card_allocations al;
