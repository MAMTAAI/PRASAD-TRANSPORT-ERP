-- ═══════════════════════════════════════════════════════════════════════════
-- 015_payment_advices.sql — the third document in the settlement chain
--
--   Transportation Bill  what was EARNED   → iocl_bill_lines / iocl_recon_matches
--   Payment Advice       what was PAID     → here
--   Bank statement       what ARRIVED      → still outside the system
--
-- IOCL does not remit the bill. It nets deductions first, and on the advices
-- parsed for Apr–Aug 2026 those came to 20.5% of gross freight:
--
--     freight gross      1,08,15,517.50
--     TDS 194C @2%
--     CCMS RECOV          -35,87,335.05   HSD drawn on IOCL's fuel card
--     TOLL EXPENSE-SBIN      -29,617.50   FASTag paid on our behalf
--     misc recovery          -46,038.06
--     rental / other income  +12,69,269.42
--     = remitted            85,99,262.96
--
-- Recording the whole net as a bank receipt — which is what the reconciler did
-- before these tables existed — overstates the bank and leaves fuel and toll
-- entirely unbooked. A CCMS recovery is not lost revenue: the freight was
-- earned in full and part of it was taken as diesel, so it belongs in the books
-- as an expense settled against the receivable.
--
-- advice_lines.kind drives that accounting, so it is constrained rather than
-- free text: an unrecognised kind must fail loudly, not land in a residual
-- bucket that quietly absorbs money.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS iocl_payment_advices (
  advice_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  odn           text UNIQUE,                 -- IOCL's advice number
  bank_ref      text,                        -- RTGS/NEFT UTR
  advice_date   date,
  remitted      numeric(14,2) NOT NULL,
  computed_net  numeric(14,2) NOT NULL,
  ties          boolean NOT NULL,            -- lines add up to the remittance
  mode          text,
  bank_name     text,
  account_tail  text,
  pdf_name      text NOT NULL,
  pdf_sha256    char(64) NOT NULL,
  tool_version  text,
  warnings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advice_ties_chk CHECK (NOT ties OR abs(computed_net - remitted) <= 1.00)
);
CREATE INDEX IF NOT EXISTS advice_date_idx ON iocl_payment_advices (advice_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS advice_sha_uniq ON iocl_payment_advices (pdf_sha256);

CREATE TABLE IF NOT EXISTS iocl_advice_lines (
  line_uid      char(40) PRIMARY KEY,
  advice_id     uuid NOT NULL REFERENCES iocl_payment_advices(advice_id) ON DELETE CASCADE,
  voucher_no    text NOT NULL,
  item          text,
  reference     text NOT NULL,
  bill_no       text,                        -- links to iocl_recon_matches.bill_no
  plant         text,
  material_text text,
  kind          text NOT NULL,
  gross         numeric(14,2) NOT NULL DEFAULT 0,
  tds           numeric(14,2) NOT NULL DEFAULT 0,
  deduction     numeric(14,2) NOT NULL DEFAULT 0,
  net           numeric(14,2) NOT NULL DEFAULT 0,
  gst_tax       numeric(14,2) NOT NULL DEFAULT 0,
  page_no       integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advice_kind_chk CHECK (kind IN (
    'FREIGHT_BILL','FUEL_CCMS_RECOVERY','TOLL_RECOVERY','MISC_RECOVERY',
    'RENTAL_INCOME','OTHER_BILLED_INCOME','OTHER'))
);
CREATE INDEX IF NOT EXISTS advice_line_bill_idx ON iocl_advice_lines (bill_no) WHERE bill_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS advice_line_kind_idx ON iocl_advice_lines (kind);

-- ═══════════════════════════════════════════════════════════════════════════
-- V_BILL_SETTLEMENT — bill ↔ advice, the answer to "did this bill get paid".
-- Deductions are advice-level (one CCMS recovery covers a whole plant, not one
-- bill), so they are NOT apportioned here. Splitting shared recoveries across
-- bills would invent a precision the document does not contain.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_bill_settlement AS
WITH billed AS (
  SELECT bill_no,
         MAX(bill_date)                    AS bill_date,
         count(*)                          AS loads,
         count(*) FILTER (WHERE match_status='MATCHED') AS loads_matched,
         SUM(gross_amt)::numeric(14,2)     AS billed_gross,
         SUM(tds_amt)::numeric(14,2)       AS our_tds
    FROM iocl_recon_matches GROUP BY bill_no
), paid AS (
  SELECT l.bill_no,
         MIN(a.odn)                        AS odn,
         MIN(a.advice_date)                AS paid_on,
         MIN(a.bank_ref)                   AS bank_ref,
         SUM(l.gross)::numeric(14,2)       AS advice_gross,
         SUM(l.tds)::numeric(14,2)         AS advice_tds,
         SUM(l.net)::numeric(14,2)         AS advice_net
    FROM iocl_advice_lines l
    JOIN iocl_payment_advices a USING (advice_id)
   WHERE l.kind = 'FREIGHT_BILL' AND l.bill_no IS NOT NULL
   GROUP BY l.bill_no
)
SELECT b.bill_no, b.bill_date, b.loads, b.loads_matched, b.billed_gross, b.our_tds,
       p.odn, p.paid_on, p.bank_ref, p.advice_gross, p.advice_tds, p.advice_net,
       CASE WHEN p.bill_no IS NULL THEN 'UNPAID' ELSE 'PAID' END AS payment_state,
       -- IOCL rounds to whole rupees on the advice; anything past ±1 is real.
       (COALESCE(p.advice_gross,0) - b.billed_gross)::numeric(14,2) AS gross_variance
  FROM billed b
  LEFT JOIN paid p ON p.bill_no = b.bill_no
 ORDER BY b.bill_date, b.bill_no;

-- ═══════════════════════════════════════════════════════════════════════════
-- V_TRIP_PAYMENT_STATUS — the operator's question: which trip is still unpaid?
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_trip_payment_status AS
SELECT t.id AS trip_id, t.trip_code, t.vehicle_no, t.loading_date,
       t.consignee_name, t.driver_name,
       t.billed_amount, t.tds_amount, t.penalty_amount,
       m.bill_no, s.bill_date, s.odn, s.paid_on, s.bank_ref,
       COALESCE(s.payment_state, 'NOT_BILLED') AS payment_state
  FROM trips t
  LEFT JOIN iocl_recon_matches m ON m.trip_id = t.id
  LEFT JOIN v_bill_settlement  s ON s.bill_no = m.bill_no
 WHERE t.iocl_bill_no IS NOT NULL OR m.trip_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- V_SETTLEMENT_SUMMARY — where the freight actually went.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_settlement_summary AS
SELECT kind,
       count(*)                    AS lines,
       SUM(net)::numeric(14,2)     AS net_amount,
       SUM(tds)::numeric(14,2)     AS tds
  FROM iocl_advice_lines
 GROUP BY kind
 ORDER BY SUM(net);

COMMIT;
