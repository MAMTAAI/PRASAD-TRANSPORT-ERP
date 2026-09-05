-- ═══════════════════════════════════════════════════════════════════════════
-- 171 — GST for a Goods Transport Agency, 360°: output (RCM / forward
--       charge), input tax credit register, net payable, GSTR-1 / GSTR-3B
--       packs, and the deep audit that classifies what already exists.
--
-- Owner, 5-Sep-2026 (GOD COMMAND). What the audit found before this file:
--   · no firm had a GSTIN on the master, yet every IOCL AC5 bill prints
--     18AAKFP2339R2ZG as the vendor GSTIN (PAN AAKFP2339R = Prasad Transport);
--   · every customer bill already carries GST 5% as an RCM memo that is NOT
--     in net_receivable (163) — this file adds the CGST/SGST/IGST split, the
--     place of supply, the GST period and a 16-character invoice number;
--   · the IOCL AC5 documents ARE the invoices the recipient holds (they show
--     "reverse charge: yes", CGST/SGST for Assam plants and IGST for the
--     inter-state ones) — GSTR-1 for IOCL is built from those documents, not
--     from our 15-day packing of them;
--   · nothing on the purchase side records GST (except tyres.gst_amount) —
--     the ITC register captures every purchase-side entry, marks what GST
--     it knows, and asks staff for the invoice where it does not;
--   · a GTA under reverse charge (or 5% forward charge) cannot avail ITC
--     (Sec 17(3) + Notification 11/2017 condition) — the register still
--     keeps the credit visible, labelled BLOCKED_SCHEME, so the day the firm
--     opts for 12% forward charge (Annexure V) the numbers are already there.
-- Rules encoded: Notification 13/2017-CT(R) (RCM on GTA to a factory /
-- society / registered person / body corporate / partnership firm),
-- Notification 12/2017 entry 21A (GTA to an unregistered person: exempt),
-- Notification 11/2017 (5% no ITC / 12% with ITC), Sec 17(5) (goods
-- carriages are NOT blocked credit), toll = exempt, diesel = outside GST,
-- GSTR-1 due 11th (monthly) / 13th (QRMP), GSTR-3B 20th / 22nd–24th, GTA is
-- exempt from e-invoicing (Notification 13/2020).
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. HELPERS ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gst_states (code text PRIMARY KEY, name text NOT NULL, qrmp_3b_day int NOT NULL DEFAULT 24);
INSERT INTO gst_states (code, name, qrmp_3b_day) VALUES
 ('01','Jammu and Kashmir',24),('02','Himachal Pradesh',24),('03','Punjab',24),('04','Chandigarh',24),('05','Uttarakhand',24),('06','Haryana',24),('07','Delhi',24),('08','Rajasthan',24),('09','Uttar Pradesh',24),('10','Bihar',24),('11','Sikkim',24),('12','Arunachal Pradesh',24),('13','Nagaland',24),('14','Manipur',24),('15','Mizoram',24),('16','Tripura',24),('17','Meghalaya',24),('18','Assam',24),('19','West Bengal',24),('20','Jharkhand',24),('21','Odisha',24),('22','Chhattisgarh',22),('23','Madhya Pradesh',22),('24','Gujarat',22),('25','Daman and Diu',22),('26','Dadra and Nagar Haveli and Daman and Diu',22),('27','Maharashtra',22),('29','Karnataka',22),('30','Goa',22),('31','Lakshadweep',22),('32','Kerala',22),('33','Tamil Nadu',22),('34','Puducherry',22),('35','Andaman and Nicobar Islands',22),('36','Telangana',22),('37','Andhra Pradesh',22),('38','Ladakh',24),('97','Other Territory',24)
ON CONFLICT (code) DO NOTHING;

-- Format + the mod-36 check digit (verified against the firm's and its customers' real GSTINs).
CREATE OR REPLACE FUNCTION gstin_valid(g text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text := upper(btrim(coalesce(g, ''))); alpha text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; i int; v int; p int; tot int := 0;
BEGIN
  IF s !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN RETURN false; END IF;
  FOR i IN 1..14 LOOP
    v := position(substr(s, i, 1) IN alpha) - 1;
    p := v * (CASE WHEN i % 2 = 0 THEN 2 ELSE 1 END);
    tot := tot + (p / 36) + (p % 36);
  END LOOP;
  RETURN substr(alpha, ((36 - (tot % 36)) % 36) + 1, 1) = substr(s, 15, 1);
END $$;
CREATE OR REPLACE FUNCTION gstin_state(g text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN gstin_valid(g) THEN substr(upper(btrim(g)), 1, 2) END $$;
CREATE OR REPLACE FUNCTION gstin_pan(g text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN gstin_valid(g) THEN substr(upper(btrim(g)), 3, 10) END $$;
CREATE OR REPLACE FUNCTION gst_period_of(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(d, 'MMYYYY') $$;
CREATE OR REPLACE FUNCTION gst_period_start(p text) RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT to_date(p, 'MMYYYY') $$;
CREATE OR REPLACE FUNCTION gst_period_label(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(to_date(p, 'MMYYYY'), 'Mon YYYY') $$;
CREATE OR REPLACE FUNCTION gst_quarter_end(p text) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (date_trunc('quarter', gst_period_start(p)) + interval '3 months' - interval '1 day')::date $$;
-- Due dates: GSTR-1 11th of the next month (QRMP: 13th after the quarter);
-- GSTR-3B 20th (QRMP: 22nd / 24th after the quarter, by state).
CREATE OR REPLACE FUNCTION gst_due(p_form text, p_period text, p_filing text, p_state text DEFAULT '18') RETURNS date LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_form = 'GSTR1'  AND coalesce(p_filing, 'MONTHLY') = 'MONTHLY' THEN (gst_period_start(p_period) + interval '1 month' + interval '10 days')::date
    WHEN p_form = 'GSTR1'  THEN (gst_quarter_end(p_period) + interval '13 days')::date
    WHEN p_form = 'GSTR3B' AND coalesce(p_filing, 'MONTHLY') = 'MONTHLY' THEN (gst_period_start(p_period) + interval '1 month' + interval '19 days')::date
    ELSE (gst_quarter_end(p_period) + make_interval(days => coalesce((SELECT qrmp_3b_day FROM gst_states WHERE code = p_state), 24)))::date END $$;
CREATE OR REPLACE FUNCTION gst_firm_code(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(nullif(string_agg(left(w, 1), '' ORDER BY ord), ''), 'FIRM')
    FROM regexp_split_to_table(upper(coalesce(norm_company_name(p_name), '')), '\s+') WITH ORDINALITY AS t(w, ord) WHERE w <> '' $$;
CREATE OR REPLACE FUNCTION gst_fy_short(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM d) >= 4 THEN to_char(d, 'YY') || to_char(d + interval '1 year', 'YY') ELSE to_char(d - interval '1 year', 'YY') || to_char(d, 'YY') END $$;

-- ═══ 2. THE FIRM'S GST PROFILE ════════════════════════════════════════════
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS gst_scheme         text NOT NULL DEFAULT 'RCM' CHECK (gst_scheme IN ('RCM','FCM_5','FCM_12','UNREGISTERED')),
  ADD COLUMN IF NOT EXISTS gst_filing         text NOT NULL DEFAULT 'MONTHLY' CHECK (gst_filing IN ('MONTHLY','QRMP')),
  ADD COLUMN IF NOT EXISTS gst_state_code     text,
  ADD COLUMN IF NOT EXISTS gst_sac            text NOT NULL DEFAULT '996791',
  ADD COLUMN IF NOT EXISTS gst_invoice_prefix text,
  ADD COLUMN IF NOT EXISTS gst_scheme_note    text,
  ADD COLUMN IF NOT EXISTS gstin_source       text;
COMMENT ON COLUMN companies.gst_scheme IS 'RCM = recipient pays 5% (no ITC for us); FCM_5 = we charge 5%, no ITC; FCM_12 = we charge 12% with full ITC (Annexure V by 15 Mar of the previous FY); UNREGISTERED = no GSTIN';

-- The old format check on companies.gstin admitted 14 characters — a real
-- GSTIN has 15 — so no firm could ever hold one. Replaced by the check digit.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_gstin_format;
ALTER TABLE companies ADD CONSTRAINT companies_gstin_format CHECK (gstin IS NULL OR gstin::text = '' OR gstin_valid(gstin::text));

-- The IOCL documents print the firm's GSTIN; the PAN inside it must be the firm's PAN.
UPDATE companies c
   SET gstin = r.g, gstin_source = 'IOCL AC5 bills (vendor GSTIN), PAN matched', updated_at = now()
  FROM (SELECT DISTINCT upper(btrim(vendor_gstin)) AS g FROM iocl_bill_runs WHERE gstin_valid(vendor_gstin)) r
 WHERE coalesce(c.gstin::text, '') = '' AND gstin_pan(r.g) = upper(btrim(c.pan_no));
UPDATE companies SET gst_state_code = coalesce(gstin_state(gstin::text), CASE WHEN state ILIKE 'assam%' THEN '18' END) WHERE gst_state_code IS NULL;
UPDATE companies SET gst_invoice_prefix = gst_firm_code(company_name) WHERE gst_invoice_prefix IS NULL;

-- Which firm an IOCL vendor code bills under: the GSTIN on the document
-- first, then the books the linked trips sit in.
CREATE TABLE IF NOT EXISTS gst_ac5_vendor_map (
  vendor_code text PRIMARY KEY,
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  gstin       text,
  how         text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION gst_ac5_vendor_map_sync() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0;
BEGIN
  INSERT INTO gst_ac5_vendor_map (vendor_code, company_id, gstin, how)
  SELECT DISTINCT ON (r.vendor_code) r.vendor_code, c.id, upper(btrim(r.vendor_gstin)), 'vendor GSTIN on the AC5 bill (PAN = firm PAN)'
    FROM iocl_bill_runs r JOIN companies c ON gstin_pan(r.vendor_gstin) = upper(btrim(c.pan_no))
   WHERE r.vendor_code IS NOT NULL
   ORDER BY r.vendor_code, r.parsed_at DESC
  ON CONFLICT (vendor_code) DO UPDATE SET company_id = EXCLUDED.company_id, gstin = EXCLUDED.gstin, how = EXCLUDED.how, updated_at = now()
   WHERE gst_ac5_vendor_map.how IS DISTINCT FROM 'manual';
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO gst_ac5_vendor_map (vendor_code, company_id, gstin, how)
  SELECT x.vendor_code, x.company_id, NULL, 'books of the linked trips (no GSTIN printed on the bill)'
    FROM (SELECT r.vendor_code, b.company_id, count(*) AS n, row_number() OVER (PARTITION BY r.vendor_code ORDER BY count(*) DESC) AS rn
            FROM iocl_bill_runs r JOIN iocl_bill_lines l ON l.run_id = r.run_id
            JOIN trips t ON t.iocl_bill_no = l.bill_no JOIN customer_bills b ON b.id = t.customer_bill_id
           WHERE r.vendor_code IS NOT NULL AND b.company_id IS NOT NULL
           GROUP BY r.vendor_code, b.company_id) x
   WHERE x.rn = 1
  ON CONFLICT (vendor_code) DO NOTHING;
  RETURN n;
END $$;

-- ═══ 3. THE CUSTOMER'S GST TREATMENT ══════════════════════════════════════
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS gst_state_code    text,
  ADD COLUMN IF NOT EXISTS gst_registered    boolean,
  ADD COLUMN IF NOT EXISTS is_body_corporate boolean,
  ADD COLUMN IF NOT EXISTS gst_note          text,
  ADD COLUMN IF NOT EXISTS gst_mode_locked   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gst_audited_at    timestamptz;
COMMENT ON COLUMN customers.gst_mode IS 'RCM = recipient pays (Notification 13/2017); FORWARD = we charge gst_pct (5 or 12) on the invoice; EXEMPT = unregistered person (Notification 12/2017 entry 21A)';
COMMENT ON COLUMN customers.gst_mode_locked IS 'true once a person chose the treatment — the deep audit never overrides it';

CREATE OR REPLACE FUNCTION gst_customer_looks_corporate(p_name text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_name, '') ~* '\m(ltd|limited|pvt|private|corporation|corpn|llp|industries|company|co\.|enterprise|enterprises|mills|refinery|refineries|factory|cement|steel|petroleum|oil|gas|power|society|co-?operative|trust|foundation|university|hospital|authority|board|nigam|udyog|traders|agencies)\M' $$;

-- Applies the statutory default to every customer a person has not decided
-- for; returns what changed and why, for the audit report.
CREATE OR REPLACE FUNCTION gst_customer_audit() RETURNS TABLE (customer_id uuid, customer_name text, before_mode text, after_mode text, reason text) LANGUAGE plpgsql AS $$
DECLARE c record; v_mode text; v_reason text; v_reg boolean; v_corp boolean;
BEGIN
  FOR c IN SELECT * FROM customers ORDER BY customers.customer_name LOOP
    v_corp := gst_customer_looks_corporate(c.customer_name) OR coalesce(c.is_body_corporate, false);
    v_reg := gstin_valid(c.gst_no::text);
    IF v_reg THEN
      v_mode := CASE WHEN c.gst_mode = 'FORWARD' THEN 'FORWARD' ELSE 'RCM' END;
      v_reason := 'registered recipient (GSTIN ' || upper(btrim(c.gst_no::text)) || ') — tax payable by the recipient under reverse charge';
    ELSIF v_corp THEN
      v_mode := CASE WHEN c.gst_mode = 'FORWARD' THEN 'FORWARD' ELSE 'RCM' END;
      v_reason := 'body corporate / firm — reverse charge applies even without a GSTIN on file; GSTIN needed to report the B2B invoice';
    ELSE
      v_mode := CASE WHEN c.gst_mode = 'FORWARD' THEN 'FORWARD' ELSE 'EXEMPT' END;
      v_reason := 'unregistered person — GTA service exempt (Notification 12/2017 entry 21A)';
    END IF;
    customer_id := c.id; customer_name := c.customer_name; before_mode := c.gst_mode;
    after_mode := CASE WHEN c.gst_mode_locked THEN c.gst_mode ELSE v_mode END;
    reason := CASE WHEN c.gst_mode_locked THEN 'kept — chosen by a person' ELSE v_reason END;
    UPDATE customers SET gst_mode = after_mode, gst_registered = v_reg, is_body_corporate = coalesce(is_body_corporate, v_corp),
           gst_state_code = coalesce(gstin_state(gst_no::text), gst_state_code), gst_note = reason, gst_audited_at = now(), updated_at = now()
     WHERE id = c.id;
    RETURN NEXT;
  END LOOP;
END $$;

-- ═══ 4. THE BILL AS A TAX INVOICE ═════════════════════════════════════════
ALTER TABLE customer_bills
  ADD COLUMN IF NOT EXISTS gst_treatment   text,
  ADD COLUMN IF NOT EXISTS place_of_supply text,
  ADD COLUMN IF NOT EXISTS supply_type     text,
  ADD COLUMN IF NOT EXISTS taxable_value   numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst            numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst            numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst            numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_amount      numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_payable_by  text,
  ADD COLUMN IF NOT EXISTS invoice_value   numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoice_date    date,
  ADD COLUMN IF NOT EXISTS gst_invoice_no  text,
  ADD COLUMN IF NOT EXISTS gst_period      text,
  ADD COLUMN IF NOT EXISTS hsn_sac         text,
  ADD COLUMN IF NOT EXISTS gst_doc_source  text;
COMMENT ON COLUMN customer_bills.gst_doc_source IS 'AC5_DOCS = the recipient holds IOCL AC5 bills for these trips, GSTR-1 uses those documents; BILL = this bill is the tax invoice (gst_invoice_no)';
COMMENT ON COLUMN customer_bills.gst_amount IS 'RCM: shown on the invoice, payable by the recipient, NOT in net_receivable. FORWARD: added to invoice_value and net_receivable.';
CREATE UNIQUE INDEX IF NOT EXISTS customer_bills_gst_invoice_no_uq ON customer_bills (company_id, gst_invoice_no) WHERE gst_invoice_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS gst_invoice_seq (company_id uuid NOT NULL, fy text NOT NULL, last_no int NOT NULL DEFAULT 0, PRIMARY KEY (company_id, fy));
CREATE OR REPLACE FUNCTION gst_next_invoice_no(p_company uuid, p_date date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_fy text := gst_fy_short(p_date); v_n int; v_prefix text;
BEGIN
  SELECT coalesce(gst_invoice_prefix, gst_firm_code(company_name)) INTO v_prefix FROM companies WHERE id = p_company;
  INSERT INTO gst_invoice_seq (company_id, fy, last_no) VALUES (p_company, v_fy, 1)
  ON CONFLICT (company_id, fy) DO UPDATE SET last_no = gst_invoice_seq.last_no + 1
  RETURNING last_no INTO v_n;
  RETURN left(coalesce(v_prefix, 'FIRM'), 4) || '/' || v_fy || '/' || lpad(v_n::text, 5, '0');   -- ≤ 16 characters, as GSTR-1 requires
END $$;

-- The GST lines of one bill from its gross, the customer's treatment and
-- the two states (intra-state → CGST + SGST halves, inter-state → IGST).
CREATE OR REPLACE FUNCTION gst_split(p_gross numeric, p_mode text, p_pct numeric, p_firm_state text, p_pos text)
RETURNS TABLE (supply_type text, gst_amount numeric, cgst numeric, sgst numeric, igst numeric, payable_by text) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_gst numeric; v_inter boolean;
BEGIN
  v_inter := p_pos IS NOT NULL AND p_firm_state IS NOT NULL AND p_pos <> p_firm_state;
  v_gst := CASE WHEN p_mode IN ('RCM','FORWARD') THEN round(coalesce(p_gross, 0) * coalesce(p_pct, 0) / 100.0, 2) ELSE 0 END;
  supply_type := CASE WHEN v_inter THEN 'INTER' ELSE 'INTRA' END;
  gst_amount := v_gst;
  igst := CASE WHEN v_inter THEN v_gst ELSE 0 END;
  cgst := CASE WHEN v_inter THEN 0 ELSE round(v_gst / 2, 2) END;
  sgst := CASE WHEN v_inter THEN 0 ELSE v_gst - round(v_gst / 2, 2) END;
  payable_by := CASE p_mode WHEN 'RCM' THEN 'RECIPIENT' WHEN 'FORWARD' THEN 'SUPPLIER' ELSE 'NONE' END;
  RETURN NEXT;
END $$;

-- customer_bill_refresh (166) + the tax invoice fields. FORWARD adds the GST
-- to net_receivable and balance; RCM and EXEMPT leave the money as it was.
CREATE OR REPLACE FUNCTION customer_bill_refresh(p_bill uuid) RETURNS void AS $$
DECLARE
  b record; x record; c record; f record; g record;
  adj_in numeric; adj_ex numeric; v_tds numeric; v_status text; v_gst_add numeric; v_pos text; v_inv_date date; v_src text;
BEGIN
  SELECT * INTO b FROM customer_bills WHERE id = p_bill;
  IF b.id IS NULL OR b.status = 'CANCELLED' THEN RETURN; END IF;
  SELECT * INTO c FROM customers WHERE id = b.customer_id;
  SELECT * INTO f FROM companies WHERE id = b.company_id;

  SELECT count(*)::int AS trips,
         count(DISTINCT COALESCE(r.branch_key, '(BRANCH NOT RECORDED)'))::int AS branches,
         COALESCE(sum(r.loaded_qty), 0)::numeric(14,3) AS qty,
         COALESCE(sum(r.rtkm), 0)::numeric(14,2) AS rtkm,
         COALESCE(sum(r.gross), 0)::numeric(14,2) AS gross,
         COALESCE(sum(r.penalty), 0)::numeric(14,2) AS penalty,
         COALESCE(sum(r.tds), 0)::numeric(14,2) AS tds_actual,
         COALESCE(sum(r.received), 0)::numeric(14,2) AS received,
         count(*) FILTER (WHERE r.flag = 'PAID')::int AS paid_count,
         count(*) FILTER (WHERE r.flag = 'SHORT')::int AS short_count,
         count(*) FILTER (WHERE r.flag = 'MISSING')::int AS missing_count,
         count(*) FILTER (WHERE r.flag = 'PENDING')::int AS pending_count,
         count(*) FILTER (WHERE r.flag = 'UNPRICED')::int AS unpriced_count,
         COALESCE(sum(r.gross - r.penalty - r.received) FILTER (WHERE r.flag = 'SHORT'), 0)::numeric(14,2) AS short_amount,
         COALESCE(sum(r.gross) FILTER (WHERE r.flag = 'MISSING'), 0)::numeric(14,2) AS missing_amount,
         COALESCE(sum(r.gross) FILTER (WHERE r.flag = 'PENDING'), 0)::numeric(14,2) AS pending_amount,
         COALESCE(sum(r.gross) FILTER (WHERE r.linked_bill_id IS NOT NULL), 0)::numeric(14,2) AS legacy_posted,
         COALESCE(sum(r.gross) FILTER (WHERE r.linked_bill_id IS NULL), 0)::numeric(14,2) AS to_post,
         max(r.operating_company) AS operating_company,
         count(*) FILTER (WHERE r.iocl_bill_no IS NOT NULL AND EXISTS (SELECT 1 FROM iocl_bill_lines l WHERE l.bill_no = r.iocl_bill_no))::int AS ac5_trips
    INTO x
    FROM v_customer_trip_recon r
   WHERE r.customer_bill_id = p_bill;

  adj_in := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a WHERE a->>'side' = 'INCOME'), 0);
  adj_ex := COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(b.adjustments) a WHERE a->>'side' = 'EXPENSE'), 0);
  v_tds := CASE WHEN x.tds_actual > 0 THEN x.tds_actual
                ELSE round(x.gross * COALESCE(c.tds_pct_deducted, 0) / 100.0, 2) END;

  -- place of supply = the recipient's state (registered) else the firm's own
  v_pos := coalesce(c.gst_state_code, gstin_state(c.gst_no::text), f.gst_state_code, '18');
  SELECT * INTO g FROM gst_split(x.gross, c.gst_mode, c.gst_pct, coalesce(f.gst_state_code, '18'), v_pos);
  v_gst_add := CASE WHEN c.gst_mode = 'FORWARD' THEN g.gst_amount ELSE 0 END;
  v_inv_date := coalesce(b.raised_at::date, b.period_to);
  v_src := CASE WHEN x.ac5_trips > 0 THEN 'AC5_DOCS' ELSE 'BILL' END;

  v_status := b.status;
  IF b.locked_at IS NOT NULL AND b.status IN ('RAISED','PART_PAID','PAID') THEN
    v_status := CASE WHEN b.gross > 0 AND b.gross + adj_in - adj_ex - b.shortage_penalty + coalesce(b.gst_amount, 0) * (CASE WHEN b.gst_payable_by = 'SUPPLIER' THEN 1 ELSE 0 END) - x.received <= 2 AND x.missing_count = 0 THEN 'PAID'
                     WHEN x.received > 0 THEN 'PART_PAID'
                     ELSE 'RAISED' END;
  END IF;

  IF b.locked_at IS NULL THEN
    UPDATE customer_bills
       SET customer_name = COALESCE(c.customer_name, customer_name),
           customer_type = c.customer_type, print_format = c.print_format,
           operating_company = COALESCE(x.operating_company, operating_company),
           trips = x.trips, branches = x.branches, loaded_qty = x.qty, rtkm = x.rtkm,
           gross = x.gross, shortage_penalty = x.penalty,
           tds_pct = c.tds_pct_deducted, tds = v_tds,
           gst_pct = c.gst_pct, gst_mode = c.gst_mode,
           gst_memo = CASE WHEN c.gst_mode = 'RCM' THEN g.gst_amount ELSE 0 END,
           gst_treatment = c.gst_mode, place_of_supply = v_pos, supply_type = g.supply_type,
           taxable_value = x.gross, cgst = g.cgst, sgst = g.sgst, igst = g.igst, gst_amount = g.gst_amount, gst_payable_by = g.payable_by,
           invoice_value = round(x.gross + v_gst_add, 2), invoice_date = v_inv_date, gst_period = gst_period_of(v_inv_date),
           hsn_sac = coalesce(hsn_sac, f.gst_sac, '996791'), gst_doc_source = v_src,
           net_receivable = round(x.gross + adj_in - adj_ex - x.penalty - v_tds + v_gst_add, 2),
           received = x.received,
           balance = round(x.gross + adj_in - adj_ex - x.penalty + v_gst_add - x.received, 2),
           paid_count = x.paid_count, short_count = x.short_count, missing_count = x.missing_count,
           pending_count = x.pending_count, unpriced_count = x.unpriced_count, unpriced_trips = x.unpriced_count,
           short_amount = x.short_amount, missing_amount = x.missing_amount, pending_amount = x.pending_amount,
           revenue_posted_legacy = x.legacy_posted, revenue_to_post = x.to_post,
           lines = customer_bill_lines(p_bill),
           updated_at = now()
     WHERE id = p_bill;
  ELSE
    UPDATE customer_bills
       SET received = x.received,
           balance = round(gross + adj_income_of(adjustments) - adj_expense_of(adjustments) - shortage_penalty + (CASE WHEN gst_payable_by = 'SUPPLIER' THEN gst_amount ELSE 0 END) - x.received, 2),
           paid_count = x.paid_count, short_count = x.short_count, missing_count = x.missing_count,
           pending_count = x.pending_count,
           short_amount = x.short_amount, missing_amount = x.missing_amount, pending_amount = x.pending_amount,
           lines = customer_bill_lines(p_bill),
           gst_doc_source = coalesce(gst_doc_source, v_src),
           status = CASE WHEN status = 'DISPUTED' THEN 'DISPUTED' ELSE v_status END,
           updated_at = now()
     WHERE id = p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- A raised bill that is the tax invoice gets its serial the moment it is raised.
CREATE OR REPLACE FUNCTION cb_gst_invoice_no() RETURNS trigger AS $$
BEGIN
  IF NEW.locked_at IS NOT NULL AND NEW.gst_invoice_no IS NULL AND coalesce(NEW.gst_doc_source, 'BILL') = 'BILL' AND NEW.company_id IS NOT NULL AND NEW.status <> 'CANCELLED' THEN
    NEW.invoice_date := coalesce(NEW.raised_at::date, NEW.invoice_date, NEW.period_to);   -- the day it was raised is the invoice date
    NEW.gst_period := gst_period_of(NEW.invoice_date);
    NEW.gst_invoice_no := gst_next_invoice_no(NEW.company_id, NEW.invoice_date);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cb_gst_invoice_no ON customer_bills;
CREATE TRIGGER cb_gst_invoice_no BEFORE UPDATE ON customer_bills FOR EACH ROW EXECUTE FUNCTION cb_gst_invoice_no();

-- Backfill: every existing bill gets its GST lines from its own signed gross
-- (locked bills keep their money — RCM/EXEMPT add nothing to it).
CREATE OR REPLACE FUNCTION gst_bills_backfill() RETURNS int LANGUAGE plpgsql AS $$
DECLARE b record; g record; f record; c record; v_pos text; v_inv date; n int := 0;
BEGIN
  FOR b IN SELECT cb.* FROM customer_bills cb WHERE cb.status <> 'CANCELLED' ORDER BY cb.company_id, coalesce(cb.raised_at::date, cb.period_to), cb.bill_no LOOP
    SELECT * INTO c FROM customers WHERE id = b.customer_id;
    SELECT * INTO f FROM companies WHERE id = b.company_id;
    v_pos := coalesce(c.gst_state_code, gstin_state(c.gst_no::text), f.gst_state_code, '18');
    SELECT * INTO g FROM gst_split(b.gross, coalesce(b.gst_mode, c.gst_mode, 'RCM'), coalesce(b.gst_pct, c.gst_pct, 5), coalesce(f.gst_state_code, '18'), v_pos);
    v_inv := coalesce(b.invoice_date, b.raised_at::date, b.period_to);
    UPDATE customer_bills
       SET gst_treatment = coalesce(b.gst_mode, c.gst_mode, 'RCM'), place_of_supply = v_pos, supply_type = g.supply_type,
           taxable_value = b.gross, cgst = g.cgst, sgst = g.sgst, igst = g.igst, gst_amount = g.gst_amount, gst_payable_by = g.payable_by,
           invoice_value = round(b.gross + (CASE WHEN g.payable_by = 'SUPPLIER' THEN g.gst_amount ELSE 0 END), 2),
           invoice_date = v_inv, gst_period = gst_period_of(v_inv), hsn_sac = coalesce(hsn_sac, f.gst_sac, '996791'),
           gst_doc_source = CASE WHEN EXISTS (SELECT 1 FROM trips t JOIN iocl_bill_lines l ON l.bill_no = t.iocl_bill_no WHERE t.customer_bill_id = b.id) THEN 'AC5_DOCS' ELSE 'BILL' END
     WHERE id = b.id;
    n := n + 1;
  END LOOP;
  -- serials for the raised bills that are themselves the invoice, in date order
  FOR b IN SELECT cb.id, cb.company_id, cb.invoice_date FROM customer_bills cb
            WHERE cb.locked_at IS NOT NULL AND cb.gst_invoice_no IS NULL AND cb.gst_doc_source = 'BILL' AND cb.company_id IS NOT NULL AND cb.status <> 'CANCELLED'
            ORDER BY cb.company_id, cb.invoice_date, cb.bill_no LOOP
    UPDATE customer_bills SET gst_invoice_no = gst_next_invoice_no(b.company_id, b.invoice_date) WHERE id = b.id;
  END LOOP;
  RETURN n;
END $$;

-- Recipient GSTIN / place of supply a person supplies for one document
-- (an inter-state AC5 bill names an IOCL plant in another state — its
-- state GSTIN is not printed on our copy).
CREATE TABLE IF NOT EXISTS gst_doc_overrides (
  doc_kind        text NOT NULL,
  doc_no          text NOT NULL,
  recipient_gstin text,
  place_of_supply text,
  note            text,
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_kind, doc_no)
);

-- ═══ 5. THE OUTPUT REGISTER — what the recipients hold ════════════════════
-- One row per invoice the government will see: IOCL's AC5 bills as documents
-- (deduplicated across the PDFs that carried them), and our own bills
-- wherever no AC5 document exists.
CREATE OR REPLACE VIEW v_gst_output_docs AS
WITH pick AS (
  SELECT DISTINCT ON (l.bill_no) l.bill_no, l.run_id, r.vendor_code
    FROM iocl_bill_lines l JOIN iocl_bill_runs r ON r.run_id = l.run_id
   ORDER BY l.bill_no, r.parsed_at DESC
), ac5 AS (
  SELECT l.bill_no, min(l.bill_date) AS bill_date, bool_or(l.reverse_charge) AS rcm, count(*) AS lines,
         sum(l.gross_amt)::numeric(14,2) AS taxable, sum(l.cgst_amt)::numeric(14,2) AS cgst, sum(l.sgst_amt)::numeric(14,2) AS sgst, sum(l.igst_amt)::numeric(14,2) AS igst,
         p.vendor_code
    FROM iocl_bill_lines l JOIN pick p ON p.bill_no = l.bill_no AND p.run_id = l.run_id
   GROUP BY l.bill_no, p.vendor_code
), iocl AS (SELECT id, customer_name, gst_no, gst_state_code FROM customers WHERE customer_name ILIKE 'INDIAN OIL%' ORDER BY (gst_no IS NOT NULL) DESC LIMIT 1)
SELECT 'AC5'::text AS doc_kind, a.bill_no AS doc_no, a.bill_date AS doc_date, gst_period_of(a.bill_date) AS period,
       m.company_id, i.id AS customer_id, i.customer_name,
       coalesce(o.recipient_gstin, CASE WHEN a.igst > 0 THEN NULL ELSE i.gst_no::text END) AS recipient_gstin,
       coalesce(o.place_of_supply, CASE WHEN a.igst > 0 THEN NULL ELSE coalesce(i.gst_state_code, gstin_state(i.gst_no::text), '18') END) AS place_of_supply,
       CASE WHEN a.igst > 0 THEN 'INTER' ELSE 'INTRA' END AS supply_type,
       CASE WHEN a.rcm THEN 'RCM' ELSE 'FORWARD' END AS treatment,
       5::numeric AS rate, a.taxable, a.cgst, a.sgst, a.igst, (a.cgst + a.sgst + a.igst)::numeric(14,2) AS gst_amount,
       CASE WHEN a.rcm THEN 'RECIPIENT' ELSE 'SUPPLIER' END AS payable_by,
       (a.taxable + CASE WHEN a.rcm THEN 0 ELSE a.cgst + a.sgst + a.igst END)::numeric(14,2) AS invoice_value,
       'ISSUED'::text AS doc_status, a.lines::int AS lines,
       (SELECT t.customer_bill_id FROM trips t WHERE t.iocl_bill_no = a.bill_no AND t.customer_bill_id IS NOT NULL LIMIT 1) AS customer_bill_id,
       CASE WHEN m.company_id IS NULL THEN 'firm for IOCL vendor code ' || coalesce(a.vendor_code, '?') || ' unknown'
            WHEN a.igst > 0 AND o.recipient_gstin IS NULL THEN 'inter-state: recipient state GSTIN + place of supply needed'
            WHEN i.gst_no IS NULL AND o.recipient_gstin IS NULL THEN 'recipient GSTIN missing' END AS needs
  FROM ac5 a
  LEFT JOIN gst_ac5_vendor_map m ON m.vendor_code = a.vendor_code
  LEFT JOIN iocl i ON true
  LEFT JOIN gst_doc_overrides o ON o.doc_kind = 'AC5' AND o.doc_no = a.bill_no
UNION ALL
SELECT 'BILL', coalesce(b.gst_invoice_no, b.bill_no), b.invoice_date, b.gst_period,
       b.company_id, b.customer_id, b.customer_name,
       coalesce(o.recipient_gstin, c.gst_no::text), coalesce(o.place_of_supply, b.place_of_supply),
       b.supply_type, b.gst_treatment, b.gst_pct, b.taxable_value, b.cgst, b.sgst, b.igst, b.gst_amount, b.gst_payable_by, b.invoice_value,
       CASE WHEN b.locked_at IS NOT NULL THEN 'ISSUED' ELSE 'DRAFT' END, b.trips, b.id,
       CASE WHEN b.gst_treatment IN ('RCM','FORWARD') AND coalesce(o.recipient_gstin, c.gst_no::text) IS NULL THEN 'recipient GSTIN missing'
            WHEN b.locked_at IS NULL THEN 'draft — not yet an invoice' END
  FROM customer_bills b
  LEFT JOIN customers c ON c.id = b.customer_id
  LEFT JOIN gst_doc_overrides o ON o.doc_kind = 'BILL' AND o.doc_no = coalesce(b.gst_invoice_no, b.bill_no)
 WHERE b.status <> 'CANCELLED' AND coalesce(b.gst_doc_source, 'BILL') = 'BILL';

CREATE OR REPLACE VIEW v_gst_output_month AS
SELECT company_id, period,
       count(*) FILTER (WHERE doc_status = 'ISSUED')::int AS docs,
       count(*) FILTER (WHERE doc_status = 'DRAFT')::int AS draft_docs,
       count(*) FILTER (WHERE doc_status = 'ISSUED' AND needs IS NOT NULL)::int AS docs_needing_attention,
       coalesce(sum(taxable) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'RCM'), 0)::numeric(14,2) AS rcm_taxable,
       coalesce(sum(gst_amount) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'RCM'), 0)::numeric(14,2) AS rcm_tax,
       coalesce(sum(taxable) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'FORWARD'), 0)::numeric(14,2) AS fcm_taxable,
       coalesce(sum(cgst) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'FORWARD'), 0)::numeric(14,2) AS fcm_cgst,
       coalesce(sum(sgst) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'FORWARD'), 0)::numeric(14,2) AS fcm_sgst,
       coalesce(sum(igst) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'FORWARD'), 0)::numeric(14,2) AS fcm_igst,
       coalesce(sum(taxable) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'EXEMPT'), 0)::numeric(14,2) AS exempt_taxable,
       coalesce(sum(taxable) FILTER (WHERE doc_status = 'DRAFT'), 0)::numeric(14,2) AS draft_taxable
  FROM v_gst_output_docs
 WHERE company_id IS NOT NULL AND period IS NOT NULL
 GROUP BY company_id, period;

-- ═══ 6. INPUT TAX CREDIT REGISTER ═════════════════════════════════════════
ALTER TABLE expense_approvals
  ADD COLUMN IF NOT EXISTS gst_amount     numeric(14,2),
  ADD COLUMN IF NOT EXISTS gst_rate       numeric(6,2),
  ADD COLUMN IF NOT EXISTS taxable_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS supplier_gstin text,
  ADD COLUMN IF NOT EXISTS invoice_no     text;

CREATE TABLE IF NOT EXISTS gst_itc_register (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  source_kind     text NOT NULL,          -- EXPENSE | TYRE | BATTERY | LEDGER | LEDGER_MONTH | MANUAL
  source_id       text NOT NULL,
  period          text,                   -- MMYYYY of the invoice / entry
  invoice_no      text,
  invoice_date    date,
  supplier_name   text,
  supplier_gstin  text,
  category        text NOT NULL,          -- SPARES TYRES BATTERY INSURANCE REPAIRS VEHICLE_PURCHASE TOLL FUEL COMPLIANCE OTHER
  description     text,
  amount_total    numeric(14,2) NOT NULL DEFAULT 0,
  taxable_value   numeric(14,2),
  gst_rate        numeric(6,2),
  cgst            numeric(14,2) NOT NULL DEFAULT 0,
  sgst            numeric(14,2) NOT NULL DEFAULT 0,
  igst            numeric(14,2) NOT NULL DEFAULT 0,
  gst_amount      numeric(14,2) NOT NULL DEFAULT 0,
  gst_known       boolean NOT NULL DEFAULT false,
  eligibility     text NOT NULL DEFAULT 'NEEDS_INVOICE',   -- ELIGIBLE BLOCKED_SCHEME EXEMPT_SUPPLY NON_GST NO_GSTIN NEEDS_INVOICE NOT_GST_ITEM
  eligibility_reason text,
  status          text NOT NULL DEFAULT 'CAPTURED',        -- CAPTURED MATCHED_2B NOT_IN_2B CLAIMED REVERSED EXCLUDED
  gstr2b_ref      text,
  edited_by       text,
  edited_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS gst_itc_register_period_idx ON gst_itc_register (company_id, period);

CREATE OR REPLACE FUNCTION gst_itc_category(p_ledger text, p_type text, p_vendor text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t ~ 'toll|fastag' THEN 'TOLL'
    WHEN t ~ 'fuel|hsd|diesel|petrol|filling' THEN 'FUEL'
    WHEN t ~ 'tyre|tire|retread' THEN 'TYRES'
    WHEN t ~ 'batter' THEN 'BATTERY'
    WHEN t ~ 'insur' THEN 'INSURANCE'
    WHEN t ~ 'complian|permit|fitness|puc|rto|road tax|docs|registration|pollution' THEN 'COMPLIANCE'
    WHEN t ~ 'vehicle purchase|fixed asset|chassis|tanker|new truck|new lorry' THEN 'VEHICLE_PURCHASE'
    WHEN t ~ 'spare|parts|automobile' THEN 'SPARES'
    WHEN t ~ 'repair|mainten|service|garage|workshop|body' THEN 'REPAIRS'
    ELSE 'OTHER' END
  FROM (SELECT lower(concat_ws(' ', p_ledger, p_type, p_vendor)) AS t) s $$;

-- What the credit is worth under the firm's scheme.
CREATE OR REPLACE FUNCTION gst_itc_eligibility(p_company uuid, p_category text, p_gstin text, p_known boolean)
RETURNS TABLE (eligibility text, reason text) LANGUAGE plpgsql STABLE AS $$
DECLARE v_scheme text;
BEGIN
  SELECT gst_scheme INTO v_scheme FROM companies WHERE id = p_company;
  IF p_category = 'TOLL' THEN eligibility := 'EXEMPT_SUPPLY'; reason := 'Toll charges are exempt from GST (Notification 12/2017 entry 23) — nothing to credit; reported as exempt inward supply in GSTR-3B table 5'; RETURN NEXT; RETURN; END IF;
  IF p_category = 'FUEL' THEN eligibility := 'NON_GST'; reason := 'Diesel is outside GST (VAT) — no credit; reported as non-GST inward supply in GSTR-3B table 5'; RETURN NEXT; RETURN; END IF;
  IF p_category = 'COMPLIANCE' THEN eligibility := 'NOT_GST_ITEM'; reason := 'Government fees (permit, fitness, road tax) carry no GST'; RETURN NEXT; RETURN; END IF;
  IF p_company IS NULL THEN eligibility := 'NEEDS_INVOICE'; reason := 'Which firm bought this is not recorded — assign the firm'; RETURN NEXT; RETURN; END IF;
  IF v_scheme = 'UNREGISTERED' THEN eligibility := 'BLOCKED_SCHEME'; reason := 'The firm has no GST registration — no return, no credit'; RETURN NEXT; RETURN; END IF;
  IF v_scheme IN ('RCM', 'FCM_5') THEN eligibility := 'BLOCKED_SCHEME'; reason := CASE WHEN v_scheme = 'RCM' THEN 'GTA under reverse charge: the supply counts as exempt for credit (Sec 17(3)) — ITC cannot be availed; kept on record for the 12% option' ELSE 'GTA paying 5% forward charge: credit barred by the Notification 11/2017 condition — kept on record for the 12% option' END; RETURN NEXT; RETURN; END IF;
  IF NOT p_known THEN eligibility := 'NEEDS_INVOICE'; reason := 'Tax invoice not recorded — enter the supplier GSTIN, invoice number, taxable value and GST to claim'; RETURN NEXT; RETURN; END IF;
  IF NOT gstin_valid(p_gstin) THEN eligibility := 'NO_GSTIN'; reason := 'Supplier GSTIN missing or invalid — credit needs a valid B2B invoice in GSTR-2B'; RETURN NEXT; RETURN; END IF;
  eligibility := 'ELIGIBLE'; reason := CASE WHEN p_category = 'VEHICLE_PURCHASE' THEN 'Goods carriage — not a blocked credit under Sec 17(5) (only passenger vehicles ≤13 seats are)' ELSE 'Used for taxable outward supply under the 12% option' END;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION gst_itc_capture() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; m int;
BEGIN
  -- (1) tyres: the master knows the GST
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, category, description, amount_total, taxable_value, gst_rate, cgst, sgst, gst_amount, gst_known, eligibility, eligibility_reason)
  SELECT v.company_id, 'TYRE', t.id::text, gst_period_of(t.purchase_date), t.invoice_no, t.purchase_date, t.vendor_name, 'TYRES',
         concat_ws(' ', t.brand, t.size, t.serial_no), coalesce(t.purchase_cost, coalesce(t.base_cost, 0) + coalesce(t.gst_amount, 0)), coalesce(t.base_cost, t.purchase_cost - coalesce(t.gst_amount, 0)), t.gst_percent,
         round(coalesce(t.gst_amount, 0) / 2, 2), coalesce(t.gst_amount, 0) - round(coalesce(t.gst_amount, 0) / 2, 2), coalesce(t.gst_amount, 0), coalesce(t.gst_amount, 0) > 0,
         e.eligibility, e.reason
    FROM tyres t
    LEFT JOIN LATERAL (SELECT ve.company_id FROM tyre_fitments tf JOIN vehicles ve ON ve.id = tf.vehicle_id WHERE tf.tyre_id = t.id ORDER BY tf.fitment_date DESC NULLS LAST LIMIT 1) v ON true
    CROSS JOIN LATERAL gst_itc_eligibility(v.company_id, 'TYRES', NULL, coalesce(t.gst_amount, 0) > 0) e
   WHERE t.purchase_date IS NOT NULL
  ON CONFLICT (source_kind, source_id) DO UPDATE
     SET amount_total = EXCLUDED.amount_total, taxable_value = coalesce(gst_itc_register.taxable_value, EXCLUDED.taxable_value),
         gst_amount = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.gst_amount ELSE gst_itc_register.gst_amount END,
         cgst = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.cgst ELSE gst_itc_register.cgst END,
         sgst = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.sgst ELSE gst_itc_register.sgst END,
         company_id = coalesce(gst_itc_register.company_id, EXCLUDED.company_id), updated_at = now()
   WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- (2) approved expenses from the Pending Expenses desk
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, supplier_gstin, category, description, amount_total, taxable_value, gst_rate, cgst, sgst, gst_amount, gst_known, eligibility, eligibility_reason)
  SELECT x.company_id, 'EXPENSE', x.id::text, gst_period_of(coalesce(x.bill_date, x.approved_at::date, x.created_at::date)), coalesce(x.invoice_no, x.bill_no), coalesce(x.bill_date, x.approved_at::date, x.created_at::date), x.vendor_name, x.supplier_gstin,
         gst_itc_category(NULL, x.expense_type, x.vendor_name), x.description, coalesce(x.amount, 0), coalesce(x.taxable_amount, x.amount - coalesce(x.gst_amount, 0)), x.gst_rate,
         round(coalesce(x.gst_amount, 0) / 2, 2), coalesce(x.gst_amount, 0) - round(coalesce(x.gst_amount, 0) / 2, 2), coalesce(x.gst_amount, 0), coalesce(x.gst_amount, 0) > 0,
         e.eligibility, e.reason
    FROM expense_approvals x
    CROSS JOIN LATERAL gst_itc_eligibility(x.company_id, gst_itc_category(NULL, x.expense_type, x.vendor_name), x.supplier_gstin, coalesce(x.gst_amount, 0) > 0) e
   WHERE x.status = 'APPROVED'
  ON CONFLICT (source_kind, source_id) DO UPDATE
     SET amount_total = EXCLUDED.amount_total, company_id = coalesce(gst_itc_register.company_id, EXCLUDED.company_id),
         supplier_gstin = coalesce(gst_itc_register.supplier_gstin, EXCLUDED.supplier_gstin),
         gst_amount = CASE WHEN gst_itc_register.edited_by IS NULL THEN EXCLUDED.gst_amount ELSE gst_itc_register.gst_amount END,
         gst_known = gst_itc_register.gst_known OR EXCLUDED.gst_known, updated_at = now()
   WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- (3) itemised ledger debits on the purchase side (insurance, repairs,
  --     spares, assets) that no expense row or master already carries
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, category, description, amount_total, gst_known, eligibility, eligibility_reason)
  SELECT e.company_id, 'LEDGER', e.id::text, gst_period_of(e.entry_date), e.source_ref, e.entry_date, NULL, gst_itc_category(l.ledger_name, l.group_head, e.particulars), l.ledger_name || ' — ' || coalesce(e.particulars, ''), e.amount, false, el.eligibility, el.reason
    FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
    CROSS JOIN LATERAL gst_itc_eligibility(e.company_id, gst_itc_category(l.ledger_name, l.group_head, e.particulars), NULL, false) el
   WHERE e.dr_cr = 'DR' AND e.amount > 0
     AND (l.group_head ~* 'repairs|tyres|complian|fixed asset|vehicle' OR l.ledger_name ~* 'insur|spare|repair|mainten|tyre|batter|body')
     AND l.group_head !~* 'fuel|toll|wallet|advance|driver|stock'
     AND l.ledger_name !~* 'stock'
     AND NOT EXISTS (SELECT 1 FROM expense_approvals x WHERE x.voucher_id = e.voucher_id AND e.voucher_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM tyres t WHERE t.purchase_voucher_id = e.voucher_id AND e.voucher_id IS NOT NULL)
  ON CONFLICT (source_kind, source_id) DO UPDATE SET amount_total = EXCLUDED.amount_total, updated_at = now() WHERE gst_itc_register.status NOT IN ('EXCLUDED');
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- (4) toll and diesel by month — exempt / non-GST inward supplies for GSTR-3B table 5
  INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_date, category, description, amount_total, gst_known, eligibility, eligibility_reason)
  SELECT s.company_id, 'LEDGER_MONTH', s.ledger_name || '|' || coalesce(s.company_id::text, 'none') || '|' || s.period, s.period, gst_period_start(s.period), s.cat, s.ledger_name || ' — ' || gst_period_label(s.period), s.amt, false, el.eligibility, el.reason
    FROM (SELECT e.company_id, l.ledger_name, gst_period_of(e.entry_date) AS period, CASE WHEN l.group_head ~* 'fuel' THEN 'FUEL' ELSE 'TOLL' END AS cat,
                 sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END)::numeric(14,2) AS amt
            FROM ledger_entries e JOIN ledgers l ON l.ledger_name = e.ledger_name
           WHERE l.group_head ~* 'fuel|toll' AND l.group_head !~* 'wallet'
           GROUP BY e.company_id, l.ledger_name, gst_period_of(e.entry_date), CASE WHEN l.group_head ~* 'fuel' THEN 'FUEL' ELSE 'TOLL' END) s
    CROSS JOIN LATERAL gst_itc_eligibility(s.company_id, s.cat, NULL, false) el
   WHERE s.amt <> 0
  ON CONFLICT (source_kind, source_id) DO UPDATE SET amount_total = EXCLUDED.amount_total, updated_at = now();
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- eligibility follows the firm's scheme of the day
  UPDATE gst_itc_register r SET eligibility = e.eligibility, eligibility_reason = e.reason, updated_at = now()
    FROM (SELECT x.id, el.eligibility, el.reason
            FROM gst_itc_register x CROSS JOIN LATERAL gst_itc_eligibility(x.company_id, x.category, x.supplier_gstin, x.gst_known) el
           WHERE x.status NOT IN ('EXCLUDED', 'CLAIMED', 'REVERSED')) e
   WHERE e.id = r.id AND (r.eligibility IS DISTINCT FROM e.eligibility OR r.eligibility_reason IS DISTINCT FROM e.reason);
  RETURN n;
END $$;

CREATE OR REPLACE VIEW v_gst_itc_month AS
SELECT company_id, period,
       count(*)::int AS entries,
       count(*) FILTER (WHERE eligibility = 'NEEDS_INVOICE')::int AS needs_invoice,
       count(*) FILTER (WHERE eligibility = 'NO_GSTIN')::int AS no_gstin,
       coalesce(sum(cgst) FILTER (WHERE eligibility = 'ELIGIBLE' AND status <> 'EXCLUDED'), 0)::numeric(14,2) AS itc_cgst,
       coalesce(sum(sgst) FILTER (WHERE eligibility = 'ELIGIBLE' AND status <> 'EXCLUDED'), 0)::numeric(14,2) AS itc_sgst,
       coalesce(sum(igst) FILTER (WHERE eligibility = 'ELIGIBLE' AND status <> 'EXCLUDED'), 0)::numeric(14,2) AS itc_igst,
       coalesce(sum(gst_amount) FILTER (WHERE eligibility = 'ELIGIBLE' AND status <> 'EXCLUDED'), 0)::numeric(14,2) AS itc_eligible,
       coalesce(sum(gst_amount) FILTER (WHERE eligibility IN ('BLOCKED_SCHEME','NO_GSTIN') AND status <> 'EXCLUDED'), 0)::numeric(14,2) AS itc_blocked,
       coalesce(sum(amount_total) FILTER (WHERE eligibility = 'EXEMPT_SUPPLY'), 0)::numeric(14,2) AS exempt_inward,
       coalesce(sum(amount_total) FILTER (WHERE eligibility = 'NON_GST'), 0)::numeric(14,2) AS non_gst_inward,
       coalesce(sum(amount_total) FILTER (WHERE eligibility NOT IN ('EXEMPT_SUPPLY','NON_GST','NOT_GST_ITEM')), 0)::numeric(14,2) AS gst_purchases
  FROM gst_itc_register
 WHERE period IS NOT NULL
 GROUP BY company_id, period;

-- Set-off order (Rule 88A): IGST credit first against IGST, then CGST, then
-- SGST; CGST credit against CGST then IGST; SGST credit against SGST then IGST.
CREATE OR REPLACE FUNCTION gst_setoff(o_igst numeric, o_cgst numeric, o_sgst numeric, c_igst numeric, c_cgst numeric, c_sgst numeric)
RETURNS TABLE (pay_igst numeric, pay_cgst numeric, pay_sgst numeric, used_igst numeric, used_cgst numeric, used_sgst numeric, carry_igst numeric, carry_cgst numeric, carry_sgst numeric) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i numeric := coalesce(c_igst, 0); c numeric := coalesce(c_cgst, 0); s numeric := coalesce(c_sgst, 0); oi numeric := coalesce(o_igst, 0); oc numeric := coalesce(o_cgst, 0); os numeric := coalesce(o_sgst, 0); u numeric;
BEGIN
  u := least(i, oi); oi := oi - u; i := i - u;
  u := least(i, oc); oc := oc - u; i := i - u;
  u := least(i, os); os := os - u; i := i - u;
  u := least(c, oc); oc := oc - u; c := c - u;
  u := least(c, oi); oi := oi - u; c := c - u;
  u := least(s, os); os := os - u; s := s - u;
  u := least(s, oi); oi := oi - u; s := s - u;
  pay_igst := oi; pay_cgst := oc; pay_sgst := os;
  used_igst := coalesce(c_igst, 0) - i; used_cgst := coalesce(c_cgst, 0) - c; used_sgst := coalesce(c_sgst, 0) - s;
  carry_igst := i; carry_cgst := c; carry_sgst := s;
  RETURN NEXT;
END $$;

CREATE OR REPLACE VIEW v_gst_net_month AS
SELECT coalesce(o.company_id, i.company_id) AS company_id, coalesce(o.period, i.period) AS period,
       coalesce(o.docs, 0) AS docs, coalesce(o.draft_docs, 0) AS draft_docs, coalesce(o.docs_needing_attention, 0) AS docs_needing_attention,
       coalesce(o.rcm_taxable, 0) AS rcm_taxable, coalesce(o.rcm_tax, 0) AS rcm_tax,
       coalesce(o.fcm_taxable, 0) AS fcm_taxable, coalesce(o.fcm_cgst, 0) AS fcm_cgst, coalesce(o.fcm_sgst, 0) AS fcm_sgst, coalesce(o.fcm_igst, 0) AS fcm_igst,
       (coalesce(o.fcm_cgst, 0) + coalesce(o.fcm_sgst, 0) + coalesce(o.fcm_igst, 0))::numeric(14,2) AS output_tax,
       coalesce(o.exempt_taxable, 0) AS exempt_taxable, coalesce(o.draft_taxable, 0) AS draft_taxable,
       coalesce(i.itc_cgst, 0) AS itc_cgst, coalesce(i.itc_sgst, 0) AS itc_sgst, coalesce(i.itc_igst, 0) AS itc_igst, coalesce(i.itc_eligible, 0) AS itc_eligible, coalesce(i.itc_blocked, 0) AS itc_blocked,
       coalesce(i.exempt_inward, 0) AS exempt_inward, coalesce(i.non_gst_inward, 0) AS non_gst_inward, coalesce(i.gst_purchases, 0) AS gst_purchases,
       coalesce(i.needs_invoice, 0) AS needs_invoice, coalesce(i.no_gstin, 0) AS no_gstin,
       s.pay_igst, s.pay_cgst, s.pay_sgst, (s.pay_igst + s.pay_cgst + s.pay_sgst)::numeric(14,2) AS net_payable,
       s.carry_igst, s.carry_cgst, s.carry_sgst
  FROM v_gst_output_month o
  FULL OUTER JOIN v_gst_itc_month i ON i.company_id = o.company_id AND i.period = o.period
  CROSS JOIN LATERAL gst_setoff(coalesce(o.fcm_igst, 0), coalesce(o.fcm_cgst, 0), coalesce(o.fcm_sgst, 0), coalesce(i.itc_igst, 0), coalesce(i.itc_cgst, 0), coalesce(i.itc_sgst, 0)) s;

-- ═══ 7. FILINGS ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gst_filings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period       text NOT NULL,
  form         text NOT NULL CHECK (form IN ('GSTR1','GSTR3B')),
  due_date     date,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','EXPORTED','FILED','NIL')),
  arn          text,
  filed_at     date,
  exported_at  timestamptz,
  pack         jsonb,
  note         text,
  updated_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period, form)
);
CREATE OR REPLACE FUNCTION gst_filings_sync() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO gst_filings (company_id, period, form, due_date)
  SELECT p.company_id, p.period, f.form, gst_due(f.form, p.period, c.gst_filing, c.gst_state_code)
    FROM (SELECT company_id, period FROM v_gst_output_month UNION SELECT company_id, period FROM v_gst_itc_month) p
    JOIN companies c ON c.id = p.company_id
    CROSS JOIN (VALUES ('GSTR1'), ('GSTR3B')) f(form)
   WHERE p.period IS NOT NULL AND c.gst_scheme <> 'UNREGISTERED' AND gst_period_start(p.period) >= '2026-04-01'
  ON CONFLICT (company_id, period, form) DO UPDATE SET due_date = EXCLUDED.due_date WHERE gst_filings.status = 'DRAFT';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ═══ 8. GSTR-2B LINES (uploaded) ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gst_2b_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  period         text NOT NULL,
  supplier_gstin text NOT NULL,
  supplier_name  text,
  invoice_no     text NOT NULL,
  invoice_date   date,
  invoice_value  numeric(14,2),
  taxable_value  numeric(14,2),
  igst           numeric(14,2) NOT NULL DEFAULT 0,
  cgst           numeric(14,2) NOT NULL DEFAULT 0,
  sgst           numeric(14,2) NOT NULL DEFAULT 0,
  itc_available  boolean,
  matched_itc_id uuid REFERENCES gst_itc_register(id) ON DELETE SET NULL,
  match_state    text NOT NULL DEFAULT 'UNMATCHED',   -- MATCHED | AMOUNT_DIFF | UNMATCHED
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period, supplier_gstin, invoice_no)
);

-- ═══ 9. OVERVIEW + DEEP AUDIT ═════════════════════════════════════════════
CREATE OR REPLACE VIEW v_gst_overview AS
SELECT c.id AS company_id, c.company_name, c.pan_no, c.gstin::text AS gstin, gstin_valid(c.gstin::text) AS gstin_valid, c.gstin_source, c.gst_scheme, c.gst_filing, c.gst_state_code, c.gst_sac, c.gst_invoice_prefix,
       (SELECT name FROM gst_states s WHERE s.code = c.gst_state_code) AS state_name,
       (SELECT coalesce(sum(rcm_taxable), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_rcm_taxable,
       (SELECT coalesce(sum(rcm_tax), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_rcm_tax,
       (SELECT coalesce(sum(fcm_taxable), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_fcm_taxable,
       (SELECT coalesce(sum(output_tax), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_output_tax,
       (SELECT coalesce(sum(itc_eligible), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_itc_eligible,
       (SELECT coalesce(sum(itc_blocked), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_itc_blocked,
       (SELECT coalesce(sum(net_payable), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::numeric(14,2) AS fy_net_payable,
       (SELECT coalesce(sum(docs), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::int AS fy_docs,
       (SELECT coalesce(sum(docs_needing_attention), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::int AS docs_needing_attention,
       (SELECT coalesce(sum(needs_invoice + no_gstin), 0) FROM v_gst_net_month m WHERE m.company_id = c.id AND gst_period_start(m.period) >= '2026-04-01')::int AS itc_needing_invoice,
       (SELECT count(*) FROM gst_filings f WHERE f.company_id = c.id AND f.status IN ('DRAFT','EXPORTED') AND f.due_date < current_date)::int AS filings_overdue,
       (SELECT count(*) FROM gst_filings f WHERE f.company_id = c.id AND f.status = 'FILED')::int AS filings_filed,
       (SELECT count(DISTINCT cu.id) FROM customers cu JOIN customer_bills b ON b.customer_id = cu.id AND b.company_id = c.id WHERE cu.gst_mode IN ('RCM','FORWARD') AND NOT gstin_valid(cu.gst_no::text))::int AS customers_without_gstin
  FROM companies c;

CREATE TABLE IF NOT EXISTS gst_audit_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ran_at timestamptz NOT NULL DEFAULT now(), ran_by text, summary jsonb NOT NULL);

CREATE OR REPLACE FUNCTION gst_deep_audit(p_by text DEFAULT 'system') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb; v_cust jsonb; v_bills int; v_itc int; v_fil int; v_map int; v_docs jsonb; v_books jsonb; v_vendors jsonb; v_firms jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('customer', customer_name, 'before', before_mode, 'after', after_mode, 'reason', reason) ORDER BY customer_name), '[]'::jsonb) INTO v_cust FROM gst_customer_audit();
  v_map := gst_ac5_vendor_map_sync();
  v_bills := gst_bills_backfill();
  v_itc := gst_itc_capture();
  v_fil := gst_filings_sync();
  SELECT coalesce(jsonb_agg(jsonb_build_object('firm', company_name, 'gstin', gstin, 'valid', gstin_valid, 'source', gstin_source, 'scheme', gst_scheme) ORDER BY company_name), '[]'::jsonb) INTO v_firms FROM v_gst_overview;
  SELECT jsonb_build_object('issued', count(*) FILTER (WHERE doc_status = 'ISSUED'), 'drafts', count(*) FILTER (WHERE doc_status = 'DRAFT'),
                            'needing_attention', count(*) FILTER (WHERE doc_status = 'ISSUED' AND needs IS NOT NULL),
                            'rcm_taxable', coalesce(sum(taxable) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'RCM'), 0),
                            'rcm_tax', coalesce(sum(gst_amount) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'RCM'), 0),
                            'fcm_tax', coalesce(sum(gst_amount) FILTER (WHERE doc_status = 'ISSUED' AND treatment = 'FORWARD'), 0))
    INTO v_docs FROM v_gst_output_docs;
  -- GSTIN on the document vs the books the freight sits in
  SELECT coalesce(jsonb_agg(jsonb_build_object('gstin_firm', gf.company_name, 'books_firm', bf.company_name, 'docs', x.docs, 'taxable', x.taxable) ORDER BY x.taxable DESC), '[]'::jsonb) INTO v_books
    FROM (SELECT d.company_id AS gstin_company, b.company_id AS books_company, count(*) AS docs, sum(d.taxable) AS taxable
            FROM v_gst_output_docs d JOIN customer_bills b ON b.id = d.customer_bill_id
           WHERE d.doc_kind = 'AC5' AND d.company_id IS DISTINCT FROM b.company_id GROUP BY 1, 2) x
    LEFT JOIN companies gf ON gf.id = x.gstin_company LEFT JOIN companies bf ON bf.id = x.books_company;
  SELECT coalesce(jsonb_agg(jsonb_build_object('vendor', vendor_name, 'gstin', gst_no) ORDER BY vendor_name), '[]'::jsonb) INTO v_vendors
    FROM vendors WHERE coalesce(gst_no::text, '') <> '' AND NOT gstin_valid(gst_no::text);
  v := jsonb_build_object('ran_at', now(), 'firms', v_firms, 'customers', v_cust, 'ac5_vendor_codes_mapped', v_map, 'bills_backfilled', v_bills, 'itc_rows', v_itc, 'filings_synced', v_fil,
                          'documents', v_docs, 'gstin_vs_books', v_books, 'invalid_vendor_gstins', v_vendors);
  INSERT INTO gst_audit_runs (ran_by, summary) VALUES (p_by, v);
  RETURN v;
END $$;

-- ═══ 10. EXCEPTIONS THE DESK SEES ═════════════════════════════════════════
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH',
  'BANK_UNMATCHED','BANK_BOOK_NOT_IN_BANK',
  'TDS_PAN_MISSING','TDS_DEPOSIT_DUE','TDS_RETURN_DUE','TDS_26AS_MISMATCH','TDS_TAN_MISSING',
  'GST_GSTIN_MISSING','GST_CUSTOMER_GSTIN_MISSING','GST_RETURN_DUE','GST_ITC_INVOICE_MISSING','GST_DOC_ATTENTION','GST_BOOKS_MISMATCH']));

-- ═══ 11. FIRST DEEP AUDIT ═════════════════════════════════════════════════
SELECT gst_deep_audit('migration 171');
