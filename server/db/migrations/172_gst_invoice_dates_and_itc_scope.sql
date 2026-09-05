-- ═══════════════════════════════════════════════════════════════════════════
-- 172 — GST follow-up to 171, from the first production run:
--   (1) a bill raised long after its period (the April–July backlog TARA
--       raised on 5-Sep) was dated the day it was raised, so April freight
--       became a September invoice and the serials ran alphabetically by
--       bill number. Rule now: invoice date = the day raised when that is
--       within 30 days of the period end, else the period end; serials run
--       in invoice-date order. Nothing has been filed, so the numbers are
--       reissued once here.
--   (2) the ITC register had swept in every ledger year (year-end closing
--       credits made diesel months negative). GST reporting starts with FY
--       2026-27 — the register is scoped to entries from 1-Apr-2026.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION gst_invoice_date_of(p_raised timestamptz, p_period_to date) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_raised IS NULL THEN p_period_to
              WHEN p_raised::date - p_period_to > 30 THEN p_period_to
              ELSE p_raised::date END $$;

CREATE OR REPLACE FUNCTION cb_gst_invoice_no() RETURNS trigger AS $$
BEGIN
  IF NEW.locked_at IS NOT NULL AND NEW.gst_invoice_no IS NULL AND coalesce(NEW.gst_doc_source, 'BILL') = 'BILL' AND NEW.company_id IS NOT NULL AND NEW.status <> 'CANCELLED' THEN
    NEW.invoice_date := gst_invoice_date_of(NEW.raised_at, NEW.period_to);
    NEW.gst_period := gst_period_of(NEW.invoice_date);
    NEW.gst_invoice_no := gst_next_invoice_no(NEW.company_id, NEW.invoice_date);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gst_bills_backfill() RETURNS int LANGUAGE plpgsql AS $$
DECLARE b record; g record; f record; c record; v_pos text; v_inv date; n int := 0;
BEGIN
  FOR b IN SELECT cb.* FROM customer_bills cb WHERE cb.status <> 'CANCELLED' ORDER BY cb.company_id, cb.period_from, cb.bill_no LOOP
    SELECT * INTO c FROM customers WHERE id = b.customer_id;
    SELECT * INTO f FROM companies WHERE id = b.company_id;
    v_pos := coalesce(c.gst_state_code, gstin_state(c.gst_no::text), f.gst_state_code, '18');
    SELECT * INTO g FROM gst_split(b.gross, coalesce(b.gst_mode, c.gst_mode, 'RCM'), coalesce(b.gst_pct, c.gst_pct, 5), coalesce(f.gst_state_code, '18'), v_pos);
    -- a numbered invoice keeps its date; an unnumbered raised bill follows the rule; a draft projects its period end
    v_inv := CASE WHEN b.gst_invoice_no IS NOT NULL THEN coalesce(b.invoice_date, b.period_to)
                  WHEN b.locked_at IS NOT NULL THEN gst_invoice_date_of(b.raised_at, b.period_to)
                  ELSE b.period_to END;
    UPDATE customer_bills
       SET gst_treatment = coalesce(b.gst_mode, c.gst_mode, 'RCM'), place_of_supply = v_pos, supply_type = g.supply_type,
           taxable_value = b.gross, cgst = g.cgst, sgst = g.sgst, igst = g.igst, gst_amount = g.gst_amount, gst_payable_by = g.payable_by,
           invoice_value = round(b.gross + (CASE WHEN g.payable_by = 'SUPPLIER' THEN g.gst_amount ELSE 0 END), 2),
           invoice_date = v_inv, gst_period = gst_period_of(v_inv), hsn_sac = coalesce(hsn_sac, f.gst_sac, '996791'),
           gst_doc_source = CASE WHEN EXISTS (SELECT 1 FROM trips t JOIN iocl_bill_lines l ON l.bill_no = t.iocl_bill_no WHERE t.customer_bill_id = b.id) THEN 'AC5_DOCS' ELSE 'BILL' END
     WHERE id = b.id;
    n := n + 1;
  END LOOP;
  FOR b IN SELECT cb.id, cb.company_id, cb.invoice_date FROM customer_bills cb
            WHERE cb.locked_at IS NOT NULL AND cb.gst_invoice_no IS NULL AND cb.gst_doc_source = 'BILL' AND cb.company_id IS NOT NULL AND cb.status <> 'CANCELLED'
            ORDER BY cb.company_id, cb.invoice_date, cb.period_from, cb.bill_no LOOP
    UPDATE customer_bills SET gst_invoice_no = gst_next_invoice_no(b.company_id, b.invoice_date) WHERE id = b.id;
  END LOOP;
  RETURN n;
END $$;

-- One-time reissue of the serials handed out on 5-Sep — only while no period is filed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gst_filings WHERE status IN ('FILED', 'NIL') AND form = 'GSTR1') THEN
    DROP TRIGGER IF EXISTS cb_gst_invoice_no ON customer_bills;
    UPDATE customer_bills SET gst_invoice_no = NULL, invoice_date = NULL WHERE gst_invoice_no IS NOT NULL;
    DELETE FROM gst_invoice_seq;
    CREATE TRIGGER cb_gst_invoice_no BEFORE UPDATE ON customer_bills FOR EACH ROW EXECUTE FUNCTION cb_gst_invoice_no();
  END IF;
END $$;

-- ITC register: FY 2026-27 onward.
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

  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, category, description, amount_total, gst_known, eligibility, eligibility_reason)
  SELECT e.company_id, 'LEDGER', e.id::text, gst_period_of(e.entry_date), e.source_ref, e.entry_date, NULL, gst_itc_category(l.ledger_name, l.group_head, e.particulars), l.ledger_name || ' — ' || coalesce(e.particulars, ''), e.amount, false, el.eligibility, el.reason
    FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
    CROSS JOIN LATERAL gst_itc_eligibility(e.company_id, gst_itc_category(l.ledger_name, l.group_head, e.particulars), NULL, false) el
   WHERE e.dr_cr = 'DR' AND e.amount > 0 AND e.entry_date >= v_from
     AND (l.group_head ~* 'repairs|tyres|complian|fixed asset|vehicle' OR l.ledger_name ~* 'insur|spare|repair|mainten|tyre|batter|body')
     AND l.group_head !~* 'fuel|toll|wallet|advance|driver|stock'
     AND l.ledger_name !~* 'stock'
     AND NOT EXISTS (SELECT 1 FROM expense_approvals x WHERE x.voucher_id = e.voucher_id AND e.voucher_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM tyres t WHERE t.purchase_voucher_id = e.voucher_id AND e.voucher_id IS NOT NULL)
  ON CONFLICT (source_kind, source_id) DO UPDATE SET amount_total = EXCLUDED.amount_total, updated_at = now() WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_date, category, description, amount_total, gst_known, eligibility, eligibility_reason)
  SELECT s.company_id, 'LEDGER_MONTH', s.ledger_name || '|' || coalesce(s.company_id::text, 'none') || '|' || s.period, s.period, gst_period_start(s.period), s.cat, s.ledger_name || ' — ' || gst_period_label(s.period), s.amt, false, el.eligibility, el.reason
    FROM (SELECT e.company_id, l.ledger_name, gst_period_of(e.entry_date) AS period, CASE WHEN l.group_head ~* 'fuel' THEN 'FUEL' ELSE 'TOLL' END AS cat,
                 sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END)::numeric(14,2) AS amt
            FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
           WHERE l.group_head ~* 'fuel|toll' AND l.group_head !~* 'wallet' AND e.entry_date >= v_from
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

-- Earlier years leave the register (nothing a person entered is touched).
DELETE FROM gst_itc_register WHERE period IS NOT NULL AND gst_period_start(period) < DATE '2026-04-01' AND source_kind IN ('LEDGER', 'LEDGER_MONTH', 'TYRE', 'EXPENSE') AND edited_by IS NULL;

SELECT gst_deep_audit('migration 172');
