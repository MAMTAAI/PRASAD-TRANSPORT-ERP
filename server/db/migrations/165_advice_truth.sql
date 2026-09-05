-- ═══════════════════════════════════════════════════════════════════════════
-- 165 — "Paid" means the payment advice says so. Nothing else.
--
-- Owner, 5-Sep-2026 (after 163 went live): "aap galti kar rahe hain — IOCL ka
-- clean bill aur payment detail email me aati hai, Jaiswal aur Prasad dono ka.
-- Dono email theek se check karo, audit karo, error fix karo, entry pass karo."
--
-- ── WHAT THE AUDIT FOUND ───────────────────────────────────────────────────
--   · trips.received_amount was written by iocl_reconcile.py in its default
--     "paid" mode the moment a trip MATCHED an AC5 bill line — i.e. it says
--     "IOCL billed this", not "IOCL paid this". 593 trips carry Rs1.795 cr of
--     such assumed receipts; 163's PAID flag read them and showed 477 trips
--     paid. v_bill_settlement (015) knows better: 53 bills PAID (Rs1.743 cr)
--     against an advice, 37 UNPAID (Rs86 L).
--   · All 33 payment advices are Prasad Transport's (SBI *8490) — the advice
--     fetcher only ever opened the Prasad mailbox. Jaiswal Enterprise's IOCL
--     bills (vendor 0011043022, AS26… series) were parsed and matched from the
--     Jaiswal mailbox, but no Jaiswal advice was ever fetched, so every
--     Jaiswal receipt on file is assumed.
--   · Both mailboxes' OAuth tokens are revoked (Testing-mode 7-day expiry):
--     nothing has been read since mid-August. That is the owner's to re-grant;
--     this migration makes the books right for what has been read.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
--   A trip is PAID when the AC5 bill it sits on appears as a FREIGHT_BILL line
--   of a payment advice. Its received amount is the bill's advice gross spread
--   over the bill's trips (gross − penalty basis, as the bill nets it).
--   SHORT when the advice paid less than the bill; PENDING when the bill
--   exists and no advice names it; MISSING / UNPRICED as before.
--   trips.received_amount is left exactly as it was (surface, never rewrite);
--   the reconciliation simply stops reading it.
--
--   Each advice now records whose books it belongs to: the bank account it
--   was remitted to names the firm (SBI *8490 → Prasad, *8548 → Jaiswal,
--   *1934 → Gautam). The settlement script posts into that firm's books.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. WHOSE ADVICE ═══════════════════════════════════════════════════════
ALTER TABLE iocl_payment_advices ADD COLUMN IF NOT EXISTS operating_company text;
COMMENT ON COLUMN iocl_payment_advices.operating_company IS
  'The firm whose books this remittance belongs to — from the mailbox it arrived in, else the bank account it was paid into (advice_company_of).';

-- The bank ledger names carry the account tail in brackets: "SBI (8490)".
CREATE OR REPLACE FUNCTION advice_company_of(p_account_tail text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT btrim(l.company)
    FROM ledgers l
   WHERE l.group_head = 'Bank Accounts' AND l.status = 'ACTIVE'
     AND l.company IS NOT NULL AND btrim(l.company) <> ''
     AND length(right(regexp_replace(coalesce(p_account_tail, ''), '[^0-9]', '', 'g'), 4)) = 4
     AND l.ledger_name LIKE '%(' || right(regexp_replace(p_account_tail, '[^0-9]', '', 'g'), 4) || ')%'
   ORDER BY l.ledger_name LIMIT 1
$$;

UPDATE iocl_payment_advices
   SET operating_company = advice_company_of(account_tail)
 WHERE operating_company IS NULL AND advice_company_of(account_tail) IS NOT NULL;

-- An advice whose bank is unknown but whose bills carry Prasad's vendor code.
UPDATE iocl_payment_advices a
   SET operating_company = 'M/S PRASAD TRANSPORT'
 WHERE a.operating_company IS NULL
   AND EXISTS (SELECT 1 FROM iocl_advice_lines l
                WHERE l.advice_id = a.advice_id AND l.kind = 'FREIGHT_BILL' AND l.bill_no LIKE '%11024699%');

-- ═══ 2. THE BILL'S SETTLEMENT, FROM THE ADVICE ════════════════════════════
-- One row per AC5 bill number: what the document billed, what an advice paid.
CREATE OR REPLACE VIEW v_iocl_bill_paid AS
WITH billed AS (
  SELECT bill_no,
         sum(gross_amt)::numeric(14,2)   AS billed_gross,
         sum(penalty_amt)::numeric(14,2) AS billed_penalty,
         count(*)::int                   AS billed_lines
    FROM iocl_bill_lines GROUP BY bill_no
), paid AS (
  SELECT regexp_replace(l.bill_no, '^T', '') AS bill_no,
         min(a.odn)                       AS odn,
         min(a.advice_date)               AS paid_on,
         min(a.operating_company)         AS operating_company,
         sum(l.gross)::numeric(14,2)      AS advice_gross,
         sum(l.tds)::numeric(14,2)        AS advice_tds,
         sum(l.net)::numeric(14,2)        AS advice_net
    FROM iocl_advice_lines l JOIN iocl_payment_advices a USING (advice_id)
   WHERE l.kind = 'FREIGHT_BILL' AND l.bill_no IS NOT NULL
   GROUP BY 1
)
SELECT COALESCE(b.bill_no, p.bill_no) AS bill_no,
       b.billed_gross, b.billed_penalty, b.billed_lines,
       p.odn, p.paid_on, p.operating_company, p.advice_gross, p.advice_tds, p.advice_net,
       CASE WHEN p.bill_no IS NULL THEN 'UNPAID'
            WHEN b.billed_gross IS NULL THEN 'PAID'
            WHEN p.advice_gross + 2 < b.billed_gross - COALESCE(b.billed_penalty, 0) THEN 'SHORT'
            ELSE 'PAID' END AS payment_state,
       CASE WHEN p.bill_no IS NULL THEN 0
            WHEN COALESCE(b.billed_gross, 0) - COALESCE(b.billed_penalty, 0) <= 0 THEN 1   -- paid, document not on file: whole
            ELSE LEAST(1, p.advice_gross / (b.billed_gross - COALESCE(b.billed_penalty, 0))) END AS paid_ratio
  FROM billed b FULL JOIN paid p ON p.bill_no = b.bill_no;

COMMENT ON VIEW v_iocl_bill_paid IS
  'Per AC5 bill number: the document''s gross and penalty (iocl_bill_lines) against the payment advice that names it. paid_ratio spreads a short payment over the bill''s trips.';

-- ═══ 3. THE TRIP'S FLAG, READ FROM THE ADVICE ═════════════════════════════
-- Same columns, same order as 163/164; only received and flag change source.
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
       g.gross,
       COALESCE(t.shortage_penalty, 0)::numeric(14,2)              AS penalty,
       COALESCE(t.tds_amount, 0)::numeric(14,2)                    AS tds,
       CASE WHEN s.payment_state IN ('PAID', 'SHORT')
            THEN round((g.gross - COALESCE(t.shortage_penalty, 0)) * s.paid_ratio, 2)
            ELSE 0 END::numeric(14,2)                              AS received,
       t.linked_bill_id, t.billing_status, t.customer_bill_id,
       m.match_status, m.bill_no                                   AS their_bill_no,
       CASE
         WHEN g.gross <= 0 THEN 'UNPRICED'
         WHEN s.payment_state = 'PAID' THEN 'PAID'
         WHEN s.payment_state = 'SHORT' THEN 'SHORT'
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
  LEFT JOIN v_iocl_bill_paid s ON s.bill_no = COALESCE(m.bill_no, t.iocl_bill_no)
 WHERE t.status = 'COMPLETED';

COMMENT ON VIEW v_customer_trip_recon IS
  'Every completed trip against what the customer PAID for it (165): PAID / SHORT when the AC5 bill '
  'it sits on is named by a payment advice (v_iocl_bill_paid), PENDING when billed and unpaid, MISSING '
  'when IOCL billed the fortnight without it, UNPRICED when no amount. received = advice-paid share of '
  'gross − penalty. trips.received_amount is no longer read.';

-- ═══ 4. THE DASHBOARD MAY NAME THESE ══════════════════════════════════════
-- 163's detector raised MISSING_FREIGHT / UNMATCHED_CUSTOMER_LINE /
-- CUSTOMER_DISPUTE, but exceptions.kind is an enumerated CHECK that never
-- admitted them — every scheduler tick failed quietly. Admit them, and the
-- dead-mailbox kind the owner asked to see ("email check karo").
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH']));

-- ═══ 5. EVERY BILL RE-READS ITS TRIPS ═════════════════════════════════════
SELECT customer_bill_refresh(id) FROM customer_bills WHERE status <> 'CANCELLED';
