-- ═══════════════════════════════════════════════════════════════════════════
-- 075_loan_ledger_views.sql — the start-to-end ledger, and the opening balance.
--
-- ── HOW A PAYMENT FINDS ITS INSTALMENT ─────────────────────────────────────
-- It does not, and this is the fact the whole file is built around: TATA does
-- not allocate receipts to instalments. It raises demands, it banks money, and
-- it runs ONE balance. Contract 5004384745 has 47 demands against 39 receipts —
-- there is no pairing to read off the page, because the lender never made one.
--
-- So the pairing is DERIVED, first-in-first-out, and the rule is stated here
-- because every figure in the "cleared" columns depends on it:
--
--     instalment n is settled by the receipt that first takes cumulative
--     receipts past cumulative dues through instalment n.
--
-- FIFO is not a convenience. It is what the contract says — earlier arrears are
-- discharged before later ones — and it is the only allocation that reproduces
-- the lender's own running balance. Pairing by amount instead would look neater
-- and would be fiction: these accounts are settled two and three months in
-- arrears, in instalments that are frequently 15 or 200 rupees off, and a
-- payment of 1,12,987 in May 2026 is not "the May instalment", it is the
-- February one arriving late.
--
-- An instalment only counts as CLEARED when the cumulative money covers it in
-- full. A part-covered instalment reports what reached it and stays open, which
-- is why `cleared_amount` can be less than `due_amount` with no cleared date.
--
-- ── WHAT THE RUNNING BALANCE MEANS ─────────────────────────────────────────
-- `outstanding_after` is what was owed AT THE MOMENT THIS INSTALMENT FELL DUE,
-- including it: cumulative dues to instalment n, less every receipt cleared on
-- or before its due date. That is the arrears curve an auditor reads down, and
-- it is the same quantity the lender prints in its "Net Dues" column — which is
-- carried alongside as `lender_running_dues` so the two can be compared rather
-- than trusted. They will differ by timing, because TATA raises an instalment
-- at month end for a due date on the 11th.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Every instalment of every loan, start to end ────────────────────────
CREATE OR REPLACE VIEW v_loan_ledger AS
WITH inst AS (
  SELECT i.id, i.loan_id, i.instalment_no, i.due_date, i.due_amount,
         i.principal_part, i.interest_part, i.closing_principal,
         i.raised_on, i.lender_running_dues, i.delay_days AS lender_delay_days,
         i.overdue_interest, i.document_no, i.source,
         SUM(i.due_amount) OVER (PARTITION BY i.loan_id ORDER BY i.instalment_no
                                 ROWS UNBOUNDED PRECEDING) AS cum_due
    FROM loan_instalments i
),
recv AS (
  SELECT r.loan_id, r.cleared_date, r.amount, r.document_no, r.stmt_seq, r.id,
         SUM(r.amount) OVER (PARTITION BY r.loan_id
                             ORDER BY r.cleared_date, COALESCE(r.stmt_seq, 0), r.id
                             ROWS UNBOUNDED PRECEDING) AS cum_recv
    FROM loan_receipts r
)
SELECT
  l.id                                   AS loan_id,
  l.loan_account_no,
  l.vehicle_no,
  l.bank_name                            AS financier,
  l.loan_type,
  l.company_name,
  i.instalment_no,
  i.due_date,
  i.due_amount,
  i.principal_part,
  i.interest_part,
  i.closing_principal,
  i.raised_on,
  i.source,
  -- Settled in full, and by which receipt.
  c.cleared_date,
  c.document_no                          AS cleared_document_no,
  -- What has actually reached this instalment. Full for a cleared one; the
  -- remainder of the money for the one the payments stopped in the middle of.
  LEAST(i.due_amount,
        GREATEST(0::numeric, t.recv_total - (i.cum_due - i.due_amount)))::numeric(14,2)
                                         AS cleared_amount,
  CASE WHEN c.cleared_date IS NULL THEN NULL
       ELSE GREATEST(0, c.cleared_date - i.due_date) END
                                         AS delay_days,
  i.lender_delay_days,
  i.overdue_interest,
  i.lender_running_dues,
  (i.cum_due - d.recv_by_due)::numeric(14,2)  AS outstanding_after,
  i.cum_due::numeric(14,2)               AS cumulative_due,
  d.recv_by_due::numeric(14,2)           AS cumulative_received_by_due,
  CASE
    WHEN c.cleared_date IS NOT NULL AND c.cleared_date <= i.due_date THEN 'PAID'
    WHEN c.cleared_date IS NOT NULL                                  THEN 'PAID_LATE'
    WHEN t.recv_total > i.cum_due - i.due_amount                     THEN 'PART_PAID'
    WHEN i.due_date <= CURRENT_DATE                                  THEN 'OVERDUE'
    ELSE 'UPCOMING'
  END                                    AS status
FROM inst i
JOIN loan_master l ON l.id = i.loan_id
LEFT JOIN LATERAL (
  -- The receipt that first covers this instalment in full. The 0.005 is the
  -- rounding tolerance the lender's own paise already imply — several of these
  -- instalments were settled 15 rupees short and then topped up.
  SELECT r.cleared_date, r.document_no
    FROM recv r
   WHERE r.loan_id = i.loan_id
     AND r.cum_recv >= i.cum_due - 0.005
   ORDER BY r.cleared_date, COALESCE(r.stmt_seq, 0), r.id
   LIMIT 1
) c ON true
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(r.amount), 0) AS recv_by_due
    FROM loan_receipts r
   WHERE r.loan_id = i.loan_id AND r.cleared_date <= i.due_date
) d
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(r.amount), 0) AS recv_total
    FROM loan_receipts r WHERE r.loan_id = i.loan_id
) t;

COMMENT ON VIEW v_loan_ledger IS
  'Every instalment of every loan, start to end, with the receipt that cleared '
  'it derived FIFO. cleared_amount < due_amount with no cleared_date means the '
  'money ran out inside this instalment.';

-- ── 2. The opening balance at a cut-off ────────────────────────────────────
-- A FUNCTION, not a view with the date written into it. 01-04-2026 is this
-- year's cut-off and it is the default, but a statement for the year before it
-- has to be strikeable without editing a migration — the same reason the IOCL
-- pipeline takes its window as an argument.
--
-- STRICTLY BEFORE, on both sides. An instalment due ON 01-04-2026 has not
-- fallen due when the balance is struck, and a payment cleared ON that date has
-- not been received. Including either would net an EMI against itself and
-- report an account as square that is a month in arrears.
CREATE OR REPLACE FUNCTION loan_opening_balance(p_as_of date DEFAULT DATE '2026-04-01')
RETURNS TABLE (
  loan_id                   uuid,
  loan_account_no           text,
  vehicle_no                text,
  financier                 text,
  as_of                     date,
  emis_due_count            integer,
  emis_due_before           numeric(14,2),
  payments_count            integer,
  payments_before           numeric(14,2),
  penal_charges_before      numeric(14,2),
  opening_balance           numeric(14,2),
  undated_penal_outstanding numeric(14,2),
  accrued_overdue_interest  numeric(14,2),
  last_instalment_before    integer,
  next_due_date             date
)
LANGUAGE sql STABLE AS $$
  SELECT
    l.id, l.loan_account_no, l.vehicle_no, l.bank_name, p_as_of,
    COALESCE(i.n, 0)::integer,
    COALESCE(i.due, 0)::numeric(14,2),
    COALESCE(r.n, 0)::integer,
    COALESCE(r.paid, 0)::numeric(14,2),
    COALESCE(ch.dated_penal, 0)::numeric(14,2),
    -- The whole formula, in one place:
    --   what fell due  -  what was paid  +  what the delays cost
    (COALESCE(i.due, 0) - COALESCE(r.paid, 0) + COALESCE(ch.dated_penal, 0))::numeric(14,2),
    -- Charges the lender states a balance for and no date. They cannot be put
    -- on either side of a cut-off honestly, so they are reported beside it and
    -- never folded into it.
    COALESCE(ch.undated_penal, 0)::numeric(14,2),
    -- Memo. The lender's per-instalment overdue interest is an accrual it
    -- prints, NOT a sum it has debited — 1.65 lakh of it against 13 rupees
    -- actually charged as LPC on one contract. Adding it to the opening balance
    -- would invent arrears; leaving it out silently would hide the exposure.
    COALESCE(i.odc, 0)::numeric(14,2),
    i.last_no,
    nx.due_date
  FROM loan_master l
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, SUM(due_amount) AS due, SUM(overdue_interest) AS odc,
           max(instalment_no) AS last_no
      FROM loan_instalments
     WHERE loan_id = l.id AND due_date < p_as_of
  ) i ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, SUM(amount) AS paid
      FROM loan_receipts
     WHERE loan_id = l.id AND cleared_date < p_as_of
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT SUM(charged) FILTER (WHERE is_penal AND charge_date IS NOT NULL
                                  AND charge_date < p_as_of) AS dated_penal,
           SUM(outstanding) FILTER (WHERE is_penal AND charge_date IS NULL) AS undated_penal
      FROM loan_charges WHERE loan_id = l.id
  ) ch ON true
  LEFT JOIN LATERAL (
    SELECT due_date FROM loan_instalments
     WHERE loan_id = l.id AND due_date >= p_as_of
     ORDER BY due_date LIMIT 1
  ) nx ON true
  WHERE EXISTS (SELECT 1 FROM loan_instalments WHERE loan_id = l.id)
$$;

COMMENT ON FUNCTION loan_opening_balance(date) IS
  'Arrears at a cut-off: instalments due STRICTLY before it, less payments '
  'cleared strictly before it, plus penal charges raised before it. Undated '
  'charges and accrued (uncharged) overdue interest are reported separately, '
  'never folded in.';

-- The default cut-off, for the screens and for anything that just wants "now".
CREATE OR REPLACE VIEW v_loan_opening_balance AS
  SELECT * FROM loan_opening_balance(DATE '2026-04-01');

-- ── 3. Statement header — the contract facts, in one row ───────────────────
CREATE OR REPLACE VIEW v_loan_statement_header AS
SELECT
  l.id AS loan_id, l.loan_account_no, l.vehicle_no, l.bank_name AS financier,
  l.loan_type, l.company_name, l.owner_name,
  l.disbursal_date, l.first_emi_date, l.lead_period_days, l.moratorium_months,
  l.principal_amt, l.interest_amt, l.contract_value, l.tenure_months,
  l.rate_of_interest, l.printed_irr, l.statement_as_of, l.payment_status,
  (SELECT max(due_date) FROM loan_instalments WHERE loan_id = l.id) AS maturity_date,
  (SELECT count(*)::int FROM loan_emi_tiers WHERE loan_id = l.id)   AS emi_tiers,
  (SELECT jsonb_agg(jsonb_build_object(
            'from_instalment', from_instalment, 'to_instalment', to_instalment,
            'emi_amount', emi_amount) ORDER BY from_instalment)
     FROM loan_emi_tiers WHERE loan_id = l.id)                      AS tiers,
  (SELECT count(*)::int FROM loan_instalments WHERE loan_id = l.id) AS instalments_raised,
  (SELECT COALESCE(SUM(due_amount), 0)::numeric(14,2) FROM loan_instalments WHERE loan_id = l.id)
                                                                    AS total_demanded,
  (SELECT count(*)::int FROM loan_receipts WHERE loan_id = l.id)    AS receipts,
  (SELECT COALESCE(SUM(amount), 0)::numeric(14,2) FROM loan_receipts WHERE loan_id = l.id)
                                                                    AS total_received,
  (SELECT COALESCE(SUM(outstanding), 0)::numeric(14,2) FROM loan_charges
    WHERE loan_id = l.id AND is_penal)                              AS penal_outstanding,
  (SELECT bool_or(source = 'LENDER_STATEMENT') FROM loan_instalments WHERE loan_id = l.id)
                                                                    AS from_lender_statement
FROM loan_master l;

-- ── 4. Does the ledger reproduce the lender's own closing balance? ─────────
-- The check that survives being wrong quietly. If the demands and receipts we
-- hold do not walk to the balance the statement prints against its last row,
-- something was misread, and it must be visible without anyone going looking.
CREATE OR REPLACE VIEW v_loan_ledger_health AS
SELECT h.loan_id, h.loan_account_no, h.vehicle_no, h.financier,
       h.total_demanded, h.total_received,
       (h.total_demanded - h.total_received)::numeric(14,2) AS walked_balance,
       tail.lender_running_dues                             AS lender_closing_balance,
       (h.total_demanded - h.total_received - COALESCE(tail.lender_running_dues, 0))::numeric(14,2)
                                                            AS drift,
       h.instalments_raised, h.tenure_months,
       h.instalments_raised > COALESCE(h.tenure_months, h.instalments_raised) AS over_term
  FROM v_loan_statement_header h
  LEFT JOIN LATERAL (
    SELECT lender_running_dues FROM loan_instalments
     WHERE loan_id = h.loan_id AND lender_running_dues IS NOT NULL
     ORDER BY instalment_no DESC LIMIT 1) tail ON true
 WHERE h.instalments_raised > 0;

COMMENT ON VIEW v_loan_ledger_health IS
  'drift <> 0 means the instalments and receipts held here do not add up to the '
  'closing balance the lender printed. Investigate the import; do not adjust '
  'either side to make it agree.';

COMMIT;
