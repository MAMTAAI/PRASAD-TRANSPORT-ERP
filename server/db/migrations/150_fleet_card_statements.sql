-- ═══════════════════════════════════════════════════════════════════════════
-- 150_fleet_card_statements.sql — THE THREE FLEET CARDS, AS THE OIL COMPANY
-- KEEPS THEM
--
-- Owner, 4-Sep-2026: "PC par IOCL BPCL HPCL ka fleet card khuli hui hai ... data
-- download kar ke system ka reconciliation kar sake, account mila sake aur
-- settlement ho sake ... company wise — Prasad Transport, Jaiswal Enterprise,
-- Gautam Prasad, owned, other ... 1.4.2026 to 4.9.2026 tak ka full update."
--
-- ── WHAT THE PORTALS ACTUALLY HOLD (measured, 4-Sep-2026) ───────────────────
--
--   IOCL XtraPower · customer 1001774381 · PRASAD TRANSPORT
--     996 transactions, 1-Apr to 4-Sep-2026. CCMS Recharge 96,34,338 ·
--     CCMS Sale Auth 96,72,599 · Sale Completion 82,90,290 · Loyalty Award
--     36,60,116 · Loyalty Redeem 10,66,012. 34 vehicles, 49 merchants.
--     Live CCMS balance 4,93,805.37.
--
--   BPCL SmartFleet · account FA2004812523 · JAISWAL ENTERPRISE
--     324 sales worth 38,16,850 over 40,437 litres, 11 vehicles, 23 pumps;
--     16 CMS recharges — ten of them PCVO, six Net Banking.
--
--   HPCL DriveTrack · JAISWAL ENTERPRISE · CCMS balance 56,343.97
--
-- THE ERP SHOWED ZERO FOR ALL THREE. Every figure above is money that has moved
-- through this business in five months with no row anywhere in these books.
--
-- ── THE TWO THINGS THIS SCHEMA IS BUILT AROUND ─────────────────────────────
--
-- 1. A RECHARGE IS NOT A CARD EVENT, IT IS AN ACCOUNT EVENT. BPCL's PCVO
--    recharges land on the 8th–9th and the 22nd–23rd of each month — the exact
--    rhythm of the fortnightly pump bill, because they ARE the oil company's
--    freight deduction for that fortnight. They belong to the ACCOUNT, not to
--    any one card, and the existing `card_transactions` has no account to hang
--    them on.
--
-- 2. THE STATEMENT IS EVIDENCE, NOT AN OPINION. Every row is stored as the
--    portal printed it — including the columns this ERP has no use for — under
--    the provider's own transaction id. Re-importing the same statement
--    converges instead of duplicating, which matters because these exports are
--    re-pulled by hand whenever somebody wants a fresher number.
--
-- `card_transactions` (migration 030) IS LEFT ALONE. It records what an operator
-- typed. This records what the oil company says happened. Those are different
-- facts and the difference between them is the reconciliation.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. The card ACCOUNT — one per provider per operating company ────────────
--
-- The three accounts are not one fleet. IOCL's customer 1001774381 is PRASAD
-- TRANSPORT; BPCL's FA2004812523 and HPCL's account are JAISWAL ENTERPRISE. A
-- swipe on the wrong company's card is a swipe on the wrong company's P&L, so
-- the company lives on the ACCOUNT and every imported row inherits it.
CREATE TABLE IF NOT EXISTS fleet_card_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL CHECK (provider IN ('IOCL', 'BPCL', 'HPCL')),
  -- The number the portal calls the account: IOCL customer id, BPCL FA number,
  -- HPCL customer id. Unique per provider.
  account_no        text NOT NULL,
  account_name      text NOT NULL,
  operating_company text,
  -- The chart account this card draws on. Named, never derived — migration 031
  -- paid for that lesson: a derived name opened a SECOND wallet beside the real
  -- one and split the balance across both.
  wallet_ledger     text,
  pan               text,
  -- What the portal said the balance was, and when we last looked. NOT the
  -- source of truth for the books — it is the figure our own sum is checked
  -- against, and a gap between them is a finding.
  portal_balance    numeric(14,2),
  portal_balance_at timestamptz,
  active            boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_card_accounts_uq
  ON fleet_card_accounts (provider, account_no);

DROP TRIGGER IF EXISTS fleet_card_accounts_touch ON fleet_card_accounts;
CREATE TRIGGER fleet_card_accounts_touch BEFORE UPDATE ON fleet_card_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. The statement ───────────────────────────────────────────────────────
--
-- One row per line the portal printed. `kind` is this ERP's word for what
-- happened; `provider_txn_type` keeps theirs, because the two vocabularies do
-- not map cleanly and throwing theirs away makes a disputed row unanswerable.
CREATE TABLE IF NOT EXISTS fleet_card_statement_txns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES fleet_card_accounts(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  -- The provider's own id. THE dedup key: re-importing a statement converges.
  provider_txn_id   text NOT NULL,

  txn_at            timestamptz,
  txn_date          date NOT NULL,
  settlement_date   date,

  kind              text NOT NULL CHECK (kind IN
                      ('SALE', 'RECHARGE', 'LOYALTY_AWARD', 'LOYALTY_REDEEM',
                       'FEE', 'REVERSAL', 'OTHER')),
  provider_txn_type text,
  -- Which way the card wallet moved. A sale drains it, a recharge fills it.
  direction         text NOT NULL CHECK (direction IN ('DR', 'CR')),

  -- WHOSE CARD, WHICH LORRY. card_pan is the physical/virtual card number;
  -- vehicle_raw is what the portal printed and vehicle_no is what it resolves
  -- to in our fleet. Both are kept: an unresolvable registration is a finding,
  -- not something to overwrite with a guess.
  card_pan          text,
  vehicle_raw       text,
  vehicle_no        text,
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE SET NULL,

  -- WHERE. The merchant is the pump, and it is how a card swipe is matched to
  -- the pump's own fortnightly bill.
  merchant_name     text,
  merchant_code     text,
  location          text,

  product           text,
  quantity          numeric(14,3),
  rate              numeric(12,3),
  amount            numeric(14,2) NOT NULL,
  -- ⚠ NOT EVERY "AMOUNT" IS RUPEES. On a Loyalty row IOCL puts XTRA POINTS in
  -- the amount column, and the rupee value arrives as a separate CCMS Recharge
  -- leg sharing the same Txn ID: 398,406 points out, 3,984.06 in. Summing the
  -- points column as money reports 36,60,116 of "loyalty earnings" that are
  -- 36.6 lakh points, worth about 36,601. Every money figure in this system
  -- filters on unit = 'INR'.
  unit              text NOT NULL DEFAULT 'INR' CHECK (unit IN ('INR', 'POINTS')),
  balance_after     numeric(14,2),

  status            text,
  -- The oil company's own document number on a recharge row. On IOCL this is
  -- the freight invoice the deduction was made against, which is the only
  -- thread tying a card top-up back to the bill it came out of.
  source_doc_no     text,

  -- Exactly as exported, so a column this ERP ignores today is still there the
  -- day somebody needs it.
  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,

  import_batch_id   uuid,
  source_file       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ONE PROVIDER TRANSACTION LANDS ONCE — AND A TRANSACTION CAN HAVE TWO LEGS.
--
-- IOCL reuses a Txn ID across the two halves of a redemption: the points going
-- out and the rupees coming in are one transaction to them, two rows to us.
-- Keying on the id alone silently dropped the rupee leg of every redemption —
-- 6,972.11 of real wallet credit across five months, and the kind of loss that
-- shows up as an unexplained balance months later. `kind` completes the key.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_card_txn_uq
  ON fleet_card_statement_txns (account_id, provider_txn_id, kind);
CREATE INDEX IF NOT EXISTS fleet_card_txn_date_idx
  ON fleet_card_statement_txns (account_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS fleet_card_txn_vehicle_idx
  ON fleet_card_statement_txns (vehicle_no, txn_date)
  WHERE vehicle_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_card_txn_merchant_idx
  ON fleet_card_statement_txns (merchant_name, txn_date);

CREATE TABLE IF NOT EXISTS fleet_card_import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid REFERENCES fleet_card_accounts(id),
  provider      text NOT NULL,
  source_file   text,
  period_from   date,
  period_to     date,
  rows_read     integer NOT NULL DEFAULT 0,
  rows_new      integer NOT NULL DEFAULT 0,
  rows_seen     integer NOT NULL DEFAULT 0,   -- already had them; converged
  rows_parked   integer NOT NULL DEFAULT 0,
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Which lorry a card belongs to ───────────────────────────────────────
-- fleet_cards (030) already maps a card to a vehicle. It gains the account it
-- draws on and the full card number, so a statement row can find its card
-- without guessing from the last four digits.
ALTER TABLE fleet_cards
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES fleet_card_accounts(id),
  ADD COLUMN IF NOT EXISTS card_pan   text,
  ADD COLUMN IF NOT EXISTS portal_balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS portal_status  text;
CREATE INDEX IF NOT EXISTS fleet_cards_pan_idx ON fleet_cards (card_pan) WHERE card_pan IS NOT NULL;

-- ── 4. WHAT THE CARDS SAY, COMPANY BY COMPANY ──────────────────────────────
--
-- The owner's "company wise". Loyalty is reported apart from money: XTRA points
-- awarded and redeemed are not rupees in a bank and must never be added to a
-- balance that somebody plans a payment from.
CREATE OR REPLACE VIEW v_fleet_card_position AS
SELECT a.id                                   AS account_id,
       a.provider,
       a.account_no,
       a.account_name,
       a.operating_company,
       a.wallet_ledger,
       a.portal_balance,
       a.portal_balance_at,
       COALESCE(t.recharged, 0)::numeric(16,2)      AS recharged,
       COALESCE(t.spent, 0)::numeric(16,2)          AS spent,
       COALESCE(t.loyalty_award, 0)::numeric(16,2)  AS loyalty_points_award,
       COALESCE(t.loyalty_redeem, 0)::numeric(16,2) AS loyalty_points_redeem,
       (COALESCE(t.recharged, 0) - COALESCE(t.spent, 0))::numeric(16,2) AS net_movement,
       COALESCE(t.txns, 0)::int                     AS txns,
       t.first_txn,
       t.last_txn,
       -- The portal's own balance minus what our imported rows account for.
       -- Non-zero means the import is short a statement, not that the card is
       -- wrong — which is the useful direction for that alarm to point.
       (a.portal_balance - (COALESCE(t.recharged, 0) - COALESCE(t.spent, 0)))::numeric(16,2)
         AS unexplained
  FROM fleet_card_accounts a
  LEFT JOIN LATERAL (
    SELECT sum(x.amount) FILTER (WHERE x.kind = 'RECHARGE' AND x.unit = 'INR')  AS recharged,
           sum(x.amount) FILTER (WHERE x.kind = 'SALE' AND x.unit = 'INR')      AS spent,
           -- POINTS, not rupees. Named so nobody adds them to a balance.
           sum(x.amount) FILTER (WHERE x.kind = 'LOYALTY_AWARD')  AS loyalty_award,
           sum(x.amount) FILTER (WHERE x.kind = 'LOYALTY_REDEEM') AS loyalty_redeem,
           count(*)                                               AS txns,
           min(x.txn_date)                                        AS first_txn,
           max(x.txn_date)                                        AS last_txn
      FROM fleet_card_statement_txns x
     WHERE x.account_id = a.id) t ON true;

COMMENT ON VIEW v_fleet_card_position IS
  'Per card account: what the portal says, what our imported statement adds to, '
  'and the gap. Loyalty is reported apart from rupees.';

-- ── 5. THE MILAN — A SWIPE AGAINST THE DIESEL WE RECORDED ──────────────────
--
-- A card swipe at a pump and a fuel memo for the same lorry on the same day are
-- the same diesel seen from two sides. Matching them is what turns the card
-- statement from a bank statement into an audit of the fuel register.
--
-- Matched on vehicle + date (±1 day, because a night fill is dated by the
-- portal's clock and by the clerk's morning) and litres within 2%. Deliberately
-- a VIEW and not a stored link: the answer changes as memos are corrected, and
-- a stale stored match is worse than none.
CREATE OR REPLACE VIEW v_fleet_card_fuel_match AS
WITH m AS (
  SELECT x.id, x.account_id, x.provider, x.txn_date, x.vehicle_no, x.merchant_name,
         x.quantity, x.amount,
         f.id AS fuel_entry_id, f.trip_id, f.liters AS memo_liters, f.amount AS memo_amount
    FROM fleet_card_statement_txns x
    LEFT JOIN LATERAL (
      SELECT fe.id, fe.trip_id, fe.liters, fe.amount
        FROM fuel_entries fe
       WHERE fe.vehicle_no IS NOT NULL
         AND reg_key(fe.vehicle_no) = reg_key(x.vehicle_no)
         AND fe.entry_date BETWEEN x.txn_date - 1 AND x.txn_date + 1
         AND x.quantity IS NOT NULL AND fe.liters IS NOT NULL
         AND abs(fe.liters - x.quantity) <= GREATEST(x.quantity * 0.02, 1)
       ORDER BY abs(fe.liters - x.quantity), abs(fe.entry_date - x.txn_date)
       LIMIT 1) f ON true
   WHERE x.kind = 'SALE'
)
SELECT m.id            AS txn_id,
       m.account_id,
       m.provider,
       m.txn_date,
       m.vehicle_no,
       m.merchant_name,
       m.quantity,
       m.amount,
       m.fuel_entry_id,
       m.trip_id,
       m.memo_liters,
       m.memo_amount,
       -- ONE MEMO CANNOT ACCOUNT FOR TWO FILLS.
       --
       -- The lookup above runs per swipe, so two swipes of the same litres on
       -- the same lorry and day both find the same memo and both would read
       -- MATCHED — and the office would believe two fills were accounted for
       -- when the register holds one. Caught in the selftest against the real
       -- IOCL export, where exactly that pair exists.
       --
       -- A memo claimed more than once is AMBIGUOUS, not matched. A machine
       -- must not pick which fill it belongs to; the desk does.
       CASE
         WHEN m.fuel_entry_id IS NOT NULL
              AND count(*) OVER (PARTITION BY m.fuel_entry_id) > 1 THEN 'AMBIGUOUS'
         WHEN m.fuel_entry_id IS NOT NULL                          THEN 'MATCHED'
         WHEN m.vehicle_no IS NULL                                 THEN 'NO_VEHICLE'
         ELSE                                                           'NO_MEMO'
       END AS milan,
       CASE WHEN m.fuel_entry_id IS NULL THEN NULL
            ELSE count(*) OVER (PARTITION BY m.fuel_entry_id) END AS memo_claimed_by
  FROM m;

COMMENT ON VIEW v_fleet_card_fuel_match IS
  'Each card swipe beside the fuel memo it matches. NO_MEMO means diesel was '
  'drawn on the card with nothing in the fuel register to account for it; '
  'AMBIGUOUS means one memo was claimed by more than one swipe and a person '
  'must say which fill it was.';

COMMIT;
