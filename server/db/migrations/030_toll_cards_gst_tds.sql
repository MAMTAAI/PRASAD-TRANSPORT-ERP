-- ═══════════════════════════════════════════════════════════════════════════
-- 030_toll_cards_gst_tds.sql — cluster 3: toll claims and recharges, fleet
-- cards, and the GST/TDS registers.
--
-- `toll_transactions` already exists (022) and stays as it is. What was
-- missing is everything AROUND it: the claim a toll is billed on, the wallet
-- recharge that funded it, the fleet card it may have been swiped against, and
-- the two tax registers.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   A tax LEDGER.  gst_returns and tds_entries below are REGISTERS — what was
--                  charged or withheld on a document, for filing. They are not
--                  the accounting entry. GST and TDS already reach the books
--                  through TARA (postVoucher's tds leg, and the IOCL pipeline's
--                  GST memo), and a second set of numbers that has to agree
--                  with the ledger is the exact failure this whole migration
--                  has been unwinding. Nothing here posts.
--
--   toll_claim_lines as a child table.  A claim's groups are read whole,
--                  written once and never aggregated across claims — the same
--                  test rate_history passed in 029. The claimed TOLLS are
--                  linked properly though (toll_transactions.claim_id), because
--                  "has this toll already been billed?" is a question asked of
--                  one toll, constantly, and it must never be answered by
--                  scanning jsonb.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Toll claims ─────────────────────────────────────────────────────────
-- One fortnightly claim filed against an oil company for reimbursable tolls.
CREATE TABLE IF NOT EXISTS toll_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  claim_no      text NOT NULL UNIQUE,
  claim_date    date NOT NULL DEFAULT CURRENT_DATE,
  vendor_name   text NOT NULL,
  vendor_code   text,
  plant_name    text,
  plant_code    text,
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  fortnight_label text,
  -- The printed claim's trip groupings, exactly as rendered. Read whole,
  -- written once; the authoritative toll links live on toll_transactions.
  groups        jsonb NOT NULL DEFAULT '[]'::jsonb,
  txn_count     integer NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'SUBMITTED'
                CHECK (status IN ('DRAFT','SUBMITTED','ACCEPTED','PAID','REJECTED')),
  company       text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT toll_claims_period CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS toll_claims_date_idx ON toll_claims (claim_date DESC);

-- ── 2. A toll knows which claim billed it ──────────────────────────────────
-- 022 gave toll_transactions a `claim_status` text but nothing to point at, so
-- "already claimed" was a word rather than a link and a re-run could double-bill.
ALTER TABLE toll_transactions
  ADD COLUMN IF NOT EXISTS claim_id uuid REFERENCES toll_claims(id),
  ADD COLUMN IF NOT EXISTS claim_no text,
  ADD COLUMN IF NOT EXISTS tag_id   text;

CREATE INDEX IF NOT EXISTS toll_txn_claim_idx ON toll_transactions (claim_id) WHERE claim_id IS NOT NULL;
-- The claimable set, which is the query the Claims tab runs every time.
CREATE INDEX IF NOT EXISTS toll_txn_billable_idx
  ON toll_transactions (txn_date) WHERE is_billable AND claim_id IS NULL;

-- One toll can only ever be on one claim. `claim_status` used to be the only
-- guard and it lived in the browser.
ALTER TABLE toll_transactions
  DROP CONSTRAINT IF EXISTS toll_txn_claim_consistent;
ALTER TABLE toll_transactions
  ADD CONSTRAINT toll_txn_claim_consistent
  CHECK (claim_id IS NULL OR claim_status = 'CLAIMED');

-- The FASTag provider's own transaction id is the natural key for a statement
-- import; without this a re-uploaded statement duplicated every row.
CREATE UNIQUE INDEX IF NOT EXISTS toll_txn_ext_uniq
  ON toll_transactions (ext_txn_id) WHERE ext_txn_id IS NOT NULL;

-- ── 3. FASTag wallet recharges ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS toll_recharges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id      text UNIQUE,
  recharge_date  date NOT NULL DEFAULT CURRENT_DATE,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_source text,
  transaction_id text,
  vehicle_group  text,
  provider       text,
  -- Set when the recharge was posted to the books as a PAYMENT voucher. NULL
  -- means subsidiary-only, which the screen states rather than hides.
  voucher_id     uuid,
  remarks        text,
  company        text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toll_recharges_date_idx ON toll_recharges (recharge_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS toll_recharges_txn_uniq
  ON toll_recharges (transaction_id) WHERE transaction_id IS NOT NULL AND transaction_id <> '';

-- ── 4. Fleet cards ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  name            text NOT NULL,
  provider        text NOT NULL,
  card_no_last4   text,
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_no      text,
  -- The wallet balance IS derived from card_transactions (the lesson 029 paid
  -- for on vendors). `opening_balance` is the anchor the sum is measured from.
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','CLOSED')),
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id   text UNIQUE,
  card_id     uuid NOT NULL REFERENCES fleet_cards(id) ON DELETE CASCADE,
  provider    text,
  txn_type    text NOT NULL CHECK (txn_type IN ('LOAD','SETTLEMENT','FEE','REFUND','ADJUSTMENT')),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  txn_date    date NOT NULL DEFAULT CURRENT_DATE,
  party       text,
  vendor_id   uuid REFERENCES vendors(id) ON DELETE SET NULL,
  narration   text,
  ref         text,
  voucher_id  uuid,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_txn_card_idx ON card_transactions (card_id, txn_date DESC);
-- A provider reference posts once. Card settlements are replayed by operators
-- more than any other screen in this app.
CREATE UNIQUE INDEX IF NOT EXISTS card_txn_ref_uniq
  ON card_transactions (card_id, ref) WHERE ref IS NOT NULL AND ref <> '';

-- ── 5. GST register ────────────────────────────────────────────────────────
-- What was charged on an invoice, for filing. NOT the accounting entry.
CREATE TABLE IF NOT EXISTS gst_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  entry_date    date NOT NULL DEFAULT CURRENT_DATE,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  invoice_no    text,
  gst_type      text NOT NULL DEFAULT 'CGST+SGST' CHECK (gst_type IN ('CGST+SGST','IGST','EXEMPT','RCM')),
  taxable_amt   numeric(14,2) NOT NULL DEFAULT 0,
  gst_rate      numeric(5,2)  NOT NULL DEFAULT 0,
  total_gst     numeric(14,2) NOT NULL DEFAULT 0,
  -- Transport freight is largely reverse charge — the customer discharges it.
  -- Recorded so the register can be reconciled, never posted as output tax.
  reverse_charge boolean NOT NULL DEFAULT false,
  is_submitted  boolean NOT NULL DEFAULT false,
  return_period text,
  company       text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gst_returns_period_idx ON gst_returns (entry_date DESC);
CREATE INDEX IF NOT EXISTS gst_returns_pending_idx ON gst_returns (entry_date) WHERE NOT is_submitted;
-- One invoice is declared once.
CREATE UNIQUE INDEX IF NOT EXISTS gst_returns_invoice_uniq
  ON gst_returns (lower(customer_name), invoice_no) WHERE invoice_no IS NOT NULL AND invoice_no <> '';

-- ── 6. TDS register ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tds_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id      text UNIQUE,
  entry_date     date NOT NULL DEFAULT CURRENT_DATE,
  consignee_name text NOT NULL,
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  section        text NOT NULL DEFAULT '194C',
  gross_freight  numeric(14,2) NOT NULL DEFAULT 0,
  tds_rate       numeric(5,2)  NOT NULL DEFAULT 0,
  tds_deducted   numeric(14,2) NOT NULL DEFAULT 0,
  certificate_no text,
  quarter        text,
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FILED','RECONCILED')),
  company        text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tds_entries_date_idx ON tds_entries (entry_date DESC);
CREATE INDEX IF NOT EXISTS tds_entries_pending_idx ON tds_entries (entry_date) WHERE status = 'PENDING';

-- ── 7. updated_at triggers, matching every other table here ────────────────
DROP TRIGGER IF EXISTS toll_claims_touch ON toll_claims;
CREATE TRIGGER toll_claims_touch BEFORE UPDATE ON toll_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS fleet_cards_touch ON fleet_cards;
CREATE TRIGGER fleet_cards_touch BEFORE UPDATE ON fleet_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS gst_returns_touch ON gst_returns;
CREATE TRIGGER gst_returns_touch BEFORE UPDATE ON gst_returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS tds_entries_touch ON tds_entries;
CREATE TRIGGER tds_entries_touch BEFORE UPDATE ON tds_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 8. The card wallet balance, derived ────────────────────────────────────
CREATE OR REPLACE VIEW v_fleet_card_balance AS
SELECT c.id, c.name, c.provider, c.card_no_last4, c.vehicle_no, c.status,
       c.opening_balance,
       COALESCE(t.loaded, 0)::numeric(14,2)  AS loaded,
       COALESCE(t.spent, 0)::numeric(14,2)   AS spent,
       (c.opening_balance + COALESCE(t.loaded, 0) - COALESCE(t.spent, 0))::numeric(14,2) AS current_balance,
       COALESCE(t.txns, 0)::int AS txn_count,
       t.last_txn
  FROM fleet_cards c
  LEFT JOIN LATERAL (
    SELECT count(*) AS txns,
           SUM(amount) FILTER (WHERE txn_type IN ('LOAD','REFUND'))                 AS loaded,
           SUM(amount) FILTER (WHERE txn_type IN ('SETTLEMENT','FEE','ADJUSTMENT')) AS spent,
           max(txn_date) AS last_txn
      FROM card_transactions WHERE card_id = c.id) t ON true;

COMMIT;
