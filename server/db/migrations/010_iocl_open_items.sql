-- ═══════════════════════════════════════════════════════════════════════════
-- 010_iocl_open_items.sql — carry-forward register for bills that settle short
--
-- IOCL's shortage penalty can exceed the freight it is charged against. Bill
-- 11024699AS26075 was the first live case: two ATF loads on AS26C9816 worth
-- Rs.19,147.36 of freight, against a Rs.25,117.88 penalty on a 0.195 KL
-- shortage — a net Rs.5,970.52 owed BY us, not to us.
--
-- No receipt voucher is posted for such a bill (you cannot receive negative
-- money) and, by decision, no payment voucher either: the balance stays open
-- and is netted against a later bill's remittance.
--
-- That decision is only safe if the open item is impossible to lose. This view
-- is the register. It derives from iocl_recon_matches rather than storing a
-- copy, so it cannot drift from the reconciliation it describes, and an item
-- disappears from it only when the underlying bill stops settling negative.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_iocl_open_items AS
WITH per_bill AS (
  SELECT m.bill_no,
         m.bill_date,
         count(*)                                    AS loads,
         sum(m.gross_amt)                            AS gross_amt,
         sum(m.penalty_amt)                          AS penalty_amt,
         sum(m.tds_amt)                              AS tds_amt,
         sum(m.gross_amt - m.penalty_amt)            AS net_receivable,
         min(m.trip_date)                            AS first_trip_date,
         max(m.trip_date)                            AS last_trip_date,
         array_agg(DISTINCT m.vehicle_no_raw)        AS vehicles
    FROM iocl_recon_matches m
   WHERE m.match_status = 'MATCHED'
   GROUP BY m.bill_no, m.bill_date
)
SELECT b.bill_no,
       b.bill_date,
       b.loads,
       b.gross_amt,
       b.penalty_amt,
       b.tds_amt,
       b.net_receivable,
       (-b.net_receivable)::numeric(14,2) AS amount_owed_to_customer,
       b.first_trip_date,
       b.last_trip_date,
       b.vehicles,
       -- A receipt against this bill would carry ref_no 'IOCL-<bill_no>';
       -- its absence is what makes the item still open.
       NOT EXISTS (
         SELECT 1 FROM ledger_entries e
          WHERE e.source_type = 'VOUCHER'
            AND e.source_ref = 'IOCL-' || b.bill_no
       ) AS unposted
  FROM per_bill b
 WHERE b.net_receivable < 0
 ORDER BY b.bill_date, b.bill_no;

COMMENT ON VIEW v_iocl_open_items IS
  'Bills where IOCL penalties exceed freight: amount owed BY us, left open to '
  'net against a later remittance. Empty is the healthy state.';

COMMIT;
