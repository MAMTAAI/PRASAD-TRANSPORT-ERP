-- ═══════════════════════════════════════════════════════════════════════════
-- 164 — A contract customer's trips are priced by the contract, not by a
--       number someone typed on each trip.
--
-- Found on production the hour 163 went live: Aadhar Green's 65 trips
-- (Apr–Aug, 2,600 KL) drafted as five bills of ₹0 — every trip UNPRICED,
-- because trips.billed_amount is what the oil company's AC5 bill puts there,
-- and a contract customer never sends one. The signed contract says
-- ₹1,500/KL (memory: aadhar-green-bill-rules), which is what MonthlyBilling
-- has always multiplied by hand.
--
-- So: customers.contract_rate_per_kl, and the reconciliation view prices a
-- trip as COALESCE(the amount on the trip, loaded KL × the contract rate).
-- An oil-company customer has no contract rate, so its unbilled trips stay
-- UNPRICED until the AC5 arrives — nothing is guessed for them.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS contract_rate_per_kl numeric(12,2)
    CHECK (contract_rate_per_kl IS NULL OR contract_rate_per_kl > 0);

COMMENT ON COLUMN customers.contract_rate_per_kl IS
  'Contract customers only: ₹ per KL applied to loaded_qty when the trip carries no billed amount (Aadhar Green ₹1,500/KL). NULL for oil companies — their AC5 prices the trip.';

UPDATE customers SET contract_rate_per_kl = 1500
 WHERE contract_rate_per_kl IS NULL AND customer_type = 'CONTRACT' AND customer_name ILIKE '%AADHAR%';

-- Same columns, same order as 163 (CREATE OR REPLACE VIEW keeps dependents);
-- only gross, and the flag that reads it, change.
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
       t.product_type, t.loaded_qty, t.shortage_qty, t.rtkm,
       COALESCE(t.rate, CASE WHEN COALESCE(t.billed_amount, 0) <= 0 THEN c.contract_rate_per_kl END)::numeric(12,4) AS rate,
       t.iocl_bill_no, t.challan_no,
       COALESCE(NULLIF(t.billed_amount, 0),
                CASE WHEN c.contract_rate_per_kl IS NOT NULL AND COALESCE(t.loaded_qty, 0) > 0
                     THEN round(t.loaded_qty * c.contract_rate_per_kl, 2) END,
                0)::numeric(14,2)                                  AS gross,
       COALESCE(t.shortage_penalty, 0)::numeric(14,2)              AS penalty,
       COALESCE(t.tds_amount, 0)::numeric(14,2)                    AS tds,
       COALESCE(t.received_amount, 0)::numeric(14,2)               AS received,
       t.linked_bill_id, t.billing_status, t.customer_bill_id,
       m.match_status, m.bill_no                                   AS their_bill_no,
       CASE
         WHEN g.gross <= 0 THEN 'UNPRICED'
         WHEN COALESCE(t.received_amount, 0) >= g.gross - COALESCE(t.shortage_penalty, 0) - 2 THEN 'PAID'
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
    SELECT COALESCE(NULLIF(t.billed_amount, 0),
                    CASE WHEN c.contract_rate_per_kl IS NOT NULL AND COALESCE(t.loaded_qty, 0) > 0
                         THEN round(t.loaded_qty * c.contract_rate_per_kl, 2) END,
                    0)::numeric(14,2) AS gross) g ON true
  LEFT JOIN LATERAL (
    SELECT m.trip_id, m.bill_no, m.match_status FROM iocl_recon_matches m
     WHERE m.trip_id = t.id ORDER BY m.created_at DESC LIMIT 1) m ON true
 WHERE t.status = 'COMPLETED';

COMMENT ON VIEW v_customer_trip_recon IS
  'Every completed trip against what the customer paid for it, one flag each: '
  'UNPRICED / PAID / SHORT / PENDING / MISSING. gross = the amount on the trip, else loaded KL × the '
  'customer''s contract rate (164). Derived from trips.received_amount, iocl_bill_no and iocl_recon_matches — nothing typed.';

-- Re-foot every open draft so the contract customer's ₹0 bills price themselves.
SELECT customer_bill_refresh(id) FROM customer_bills WHERE locked_at IS NULL AND status <> 'CANCELLED';
