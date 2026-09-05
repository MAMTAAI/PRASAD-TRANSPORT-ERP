-- ═══════════════════════════════════════════════════════════════════════════
-- 173 — GST ITC register: purchases come from EXPENSE (and fixed-asset)
--       groups only. The monthly diesel figure had matched every ledger whose
--       group name contains "fuel" — including "Sundry Creditors (Fuel
--       Pumps)", whose credit balances netted the diesel to a negative
--       number. GSTR-3B table 5 needs the expense, not the payable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION gst_itc_capture() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; m int; v_from date := DATE '2026-04-01';
BEGIN
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, category, description, amount_total, taxable_value, gst_rate, cgst, sgst, gst_amount, gst_known, eligibility, eligibility_reason)
  SELECT v.company_id, 'TYRE', t.id::text, gst_period_of(t.purchase_date), t.invoice_no, t.purchase_date, t.vendor_name, 'TYRES',
         concat_ws(' ', t.brand, t.size, t.serial_no), coalesce(t.purchase_cost, coalesce(t.base_cost, 0) + coalesce(t.gst_amount, 0)), coalesce(t.base_cost, t.purchase_cost - coalesce(t.gst_amount, 0)), t.gst_percent,
         round(coalesce(t.gst_amount, 0) / 2, 2), coalesce(t.gst_amount, 0) - round(coalesce(t.gst_amount, 0) / 2, 2), coalesce(t.gst_amount, 0), coalesce(t.gst_amount, 0) > 0,
         e.eligibility, e.reason
    FROM tyres t
    LEFT JOIN LATERAL (SELECT ve.company_id FROM tyre_fitments tf JOIN vehicles ve ON ve.id = tf.vehicle_id WHERE tf.tyre_id = t.id ORDER BY tf.fitment_date DESC NULLS LAST LIMIT 1) v ON true
    CROSS JOIN LATERAL gst_itc_eligibility(v.company_id, 'TYRES', NULL, coalesce(t.gst_amount, 0) > 0) e
   WHERE t.purchase_date >= v_from
  ON CONFLICT (source_kind, source_id) DO UPDATE
     SET amount_total = EXCLUDED.amount_total, taxable_value = coalesce(gst_itc_register.taxable_value, EXCLUDED.taxable_value),
         gst_amount = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.gst_amount ELSE gst_itc_register.gst_amount END,
         cgst = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.cgst ELSE gst_itc_register.cgst END,
         sgst = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.sgst ELSE gst_itc_register.sgst END,
         company_id = coalesce(gst_itc_register.company_id, EXCLUDED.company_id), updated_at = now()
   WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, supplier_gstin, category, description, amount_total, taxable_value, gst_rate, cgst, sgst, gst_amount, gst_known, eligibility, eligibility_reason)
  SELECT x.company_id, 'EXPENSE', x.id::text, gst_period_of(coalesce(x.bill_date, x.approved_at::date, x.created_at::date)), coalesce(x.invoice_no, x.bill_no), coalesce(x.bill_date, x.approved_at::date, x.created_at::date), x.vendor_name, x.supplier_gstin,
         gst_itc_category(NULL, x.expense_type, x.vendor_name), x.description, coalesce(x.amount, 0), coalesce(x.taxable_amount, x.amount - coalesce(x.gst_amount, 0)), x.gst_rate,
         round(coalesce(x.gst_amount, 0) / 2, 2), coalesce(x.gst_amount, 0) - round(coalesce(x.gst_amount, 0) / 2, 2), coalesce(x.gst_amount, 0), coalesce(x.gst_amount, 0) > 0,
         e.eligibility, e.reason
    FROM expense_approvals x
    CROSS JOIN LATERAL gst_itc_eligibility(x.company_id, gst_itc_category(NULL, x.expense_type, x.vendor_name), x.supplier_gstin, coalesce(x.gst_amount, 0) > 0) e
   WHERE x.status = 'APPROVED' AND coalesce(x.bill_date, x.approved_at::date, x.created_at::date) >= v_from
  ON CONFLICT (source_kind, source_id) DO UPDATE
     SET amount_total = EXCLUDED.amount_total, company_id = coalesce(gst_itc_register.company_id, EXCLUDED.company_id),
         supplier_gstin = coalesce(gst_itc_register.supplier_gstin, EXCLUDED.supplier_gstin),
         gst_amount = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.gst_amount ELSE gst_itc_register.gst_amount END,
         gst_known = gst_itc_register.gst_known OR EXCLUDED.gst_known, updated_at = now()
   WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- itemised purchase-side debits: expense or fixed-asset groups only
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, category, description, amount_total, gst_known, eligibility, eligibility_reason)
  SELECT e.company_id, 'LEDGER', e.id::text, gst_period_of(e.entry_date), e.source_ref, e.entry_date, NULL, gst_itc_category(l.ledger_name, l.group_head, e.particulars), l.ledger_name || ' — ' || coalesce(e.particulars, ''), e.amount, false, el.eligibility, el.reason
    FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
    CROSS JOIN LATERAL gst_itc_eligibility(e.company_id, gst_itc_category(l.ledger_name, l.group_head, e.particulars), NULL, false) el
   WHERE e.dr_cr = 'DR' AND e.amount > 0 AND e.entry_date >= v_from
     AND (l.group_head ~* 'expense' OR l.group_head ~* 'fixed asset')
     AND (l.group_head ~* 'repairs|tyres|complian|fixed asset|vehicle' OR l.ledger_name ~* 'insur|spare|repair|mainten|tyre|batter|body')
     AND l.group_head !~* 'fuel|toll|wallet|advance|driver|stock|creditor|payable'
     AND l.ledger_name !~* 'stock'
     AND NOT EXISTS (SELECT 1 FROM expense_approvals x WHERE x.voucher_id = e.voucher_id AND e.voucher_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM tyres t WHERE t.purchase_voucher_id = e.voucher_id AND e.voucher_id IS NOT NULL)
  ON CONFLICT (source_kind, source_id) DO UPDATE SET amount_total = EXCLUDED.amount_total, updated_at = now() WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- toll and diesel by month: the expense ledgers, never the pump creditors
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_date, category, description, amount_total, gst_known, eligibility, eligibility_reason)
  SELECT s.company_id, 'LEDGER_MONTH', s.ledger_name || '|' || coalesce(s.company_id::text, 'none') || '|' || s.period, s.period, gst_period_start(s.period), s.cat, s.ledger_name || ' — ' || gst_period_label(s.period), s.amt, false, el.eligibility, el.reason
    FROM (SELECT e.company_id, l.ledger_name, gst_period_of(e.entry_date) AS period, CASE WHEN l.group_head ~* 'fuel' THEN 'FUEL' ELSE 'TOLL' END AS cat,
                 sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END)::numeric(14,2) AS amt
            FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
           WHERE l.group_head ~* 'expense' AND l.group_head ~* 'fuel|toll' AND l.group_head !~* 'wallet|creditor|payable' AND e.entry_date >= v_from
           GROUP BY e.company_id, l.ledger_name, gst_period_of(e.entry_date), CASE WHEN l.group_head ~* 'fuel' THEN 'FUEL' ELSE 'TOLL' END) s
    CROSS JOIN LATERAL gst_itc_eligibility(s.company_id, s.cat, NULL, false) el
   WHERE s.amt <> 0
  ON CONFLICT (source_kind, source_id) DO UPDATE SET amount_total = EXCLUDED.amount_total, updated_at = now();
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  UPDATE gst_itc_register r SET eligibility = e.eligibility, eligibility_reason = e.reason, updated_at = now()
    FROM (SELECT x.id, el.eligibility, el.reason
            FROM gst_itc_register x CROSS JOIN LATERAL gst_itc_eligibility(x.company_id, x.category, x.supplier_gstin, x.gst_known) el
           WHERE x.status NOT IN ('EXCLUDED', 'CLAIMED', 'REVERSED')) e
   WHERE e.id = r.id AND (r.eligibility IS DISTINCT FROM e.eligibility OR r.eligibility_reason IS DISTINCT FROM e.reason);
  RETURN n;
END $$;

-- Rows that came from creditor / non-expense ledgers leave the register.
DELETE FROM gst_itc_register r
 WHERE r.source_kind IN ('LEDGER_MONTH', 'LEDGER') AND r.edited_by IS NULL
   AND NOT EXISTS (SELECT 1 FROM ledgers l
                    WHERE l.ledger_name = CASE WHEN r.source_kind = 'LEDGER_MONTH' THEN split_part(r.source_id, '|', 1)
                                               ELSE (SELECT e.ledger_name FROM ledger_entries e WHERE e.id::text = r.source_id) END
                      AND (l.group_head ~* 'expense' OR l.group_head ~* 'fixed asset')
                      AND l.group_head !~* 'creditor|payable|wallet');

SELECT gst_deep_audit('migration 173');
