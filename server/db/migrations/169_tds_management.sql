-- ═══════════════════════════════════════════════════════════════════════════
-- 169 — TDS MANAGEMENT: both directions, per firm, per quarter, from documents.
--
-- Owner, 5-Sep-2026 (GOD COMMAND, mock v2 approved): "IOCL/BPCL/HPCL ne TDS
-- kaata par report nahi; attached vehicle aur baaki payments par TDS system
-- ke hisaab se update ho; government ko submit karne ka report bhi."
--
-- ── WHAT THE AUDIT FOUND ───────────────────────────────────────────────────
--   · The TDS screen was a hand-typed registry (tds_entries: 2 rows).
--   · TDS ON US: IOCL's payment advices carry the TDS line (Q1 ₹2,49,218 on
--     ₹1.25 cr; Q2 ₹1,56,029 so far) — booked on 'TDS Receivable 194C', but
--     never per quarter, never against Form 26AS, no Form 16A. Jaiswal's
--     IOCL bills, and BPCL/HPCL (who pay net of 2% into Jaiswal and Gautam),
--     are recorded nowhere.
--   · TDS BY US: 34 attached-owner bills, all drafts with no commission
--     rate → no commission → no TDS → nothing deposited, nothing filed.
--   · No TAN on any firm; no PAN on any owner; 0 of 18 vendors with PAN.
--
-- ── THE MODEL ─────────────────────────────────────────────────────────────
--   tds_deductees     everyone we pay: PAN, entity, 194C(6) declaration →
--                     the rate that applies (tds_rate_for)
--   tds_liabilities   what we must withhold, one row per approved bill /
--                     payment, month, deposit due date, challan link
--   tds_challans      ITNS 281 deposits (BSR, serial, date), posted to the
--                     ledger, linked to the liabilities they cover
--   tds_returns       26Q per firm per quarter: pack generated, filed, token
--   tds_credits       what customers withheld from us, per customer × quarter,
--                     from advices → AC5 bills → bank credits (estimate)
--   tds_26as_lines    the TRACES Form 26AS / AIS upload, matched to credits
--   Everything derived is REBUILT from the documents (tds_rebuild), never
--   typed. A person types only what only a person knows: PAN, TAN, the
--   declaration, the challan, the return's token.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE FIRMS' TAN ════════════════════════════════════════════════════
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tan text;
COMMENT ON COLUMN companies.tan IS 'Tax Deduction Account Number (10 chars) — needed to deposit and file TDS by us.';

-- ═══ 2. DEDUCTEES ═════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tds_deductees (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deductee_kind      text NOT NULL CHECK (deductee_kind IN ('OWNER','PARTNER','VENDOR','OTHER')),
  name               text NOT NULL,
  pan                text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  entity_type        text CHECK (entity_type IS NULL OR entity_type IN ('INDIVIDUAL','HUF','FIRM','COMPANY','AOP','OTHER')),
  declaration_194c6  boolean NOT NULL DEFAULT false,    -- transporter with ≤10 goods carriages, PAN furnished → nil
  declaration_fy     text,
  carriages          int,
  address            text,
  vendor_id          uuid,
  notes              text,
  updated_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tds_deductees_uq ON tds_deductees (deductee_kind, upper(btrim(name)));

-- The rate the law gives this person today.
CREATE OR REPLACE FUNCTION tds_rate_for(p_pan text, p_entity text, p_decl boolean)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN COALESCE(p_decl, false) AND p_pan IS NOT NULL THEN 0
              WHEN p_pan IS NULL THEN 20
              WHEN p_entity IN ('INDIVIDUAL','HUF') THEN 1
              ELSE 2 END::numeric
$$;

-- Seed: every attached owner on the vehicle master, every vendor, every fleet partner.
INSERT INTO tds_deductees (deductee_kind, name, carriages)
SELECT 'OWNER', btrim(v.owner_name), count(*)::int
  FROM vehicles v
 WHERE v.ownership = 'ATTACHED' AND v.owner_name IS NOT NULL AND btrim(v.owner_name) <> ''
 GROUP BY btrim(v.owner_name)
ON CONFLICT DO NOTHING;
INSERT INTO tds_deductees (deductee_kind, name, pan, entity_type, declaration_194c6, vendor_id)
SELECT CASE WHEN v.vendor_kind = 'FLEET_PARTNER' THEN 'PARTNER' ELSE 'VENDOR' END, btrim(v.vendor_name),
       CASE WHEN v.pan_no ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN v.pan_no END,
       CASE WHEN v.entity_type IN ('INDIVIDUAL','FIRM') THEN v.entity_type END,
       COALESCE(v.tds_declaration_194c, false), v.id
  FROM vendors v WHERE v.vendor_name IS NOT NULL AND btrim(v.vendor_name) <> ''
ON CONFLICT DO NOTHING;
-- A firm is never its own deductee (the vehicle master fault "PRASAD TRANSPORT attached to itself").
-- (an owner who is also a firm — Gautam Prasad — stays: his lorries run under Prasad)
DELETE FROM tds_deductees d WHERE d.deductee_kind = 'OWNER'
   AND NOT EXISTS (SELECT 1 FROM vehicles v LEFT JOIN companies c ON c.id = v.company_id
                    WHERE v.ownership = 'ATTACHED' AND upper(btrim(v.owner_name)) = upper(d.name)
                      AND (c.id IS NULL OR norm_company_name(c.company_name) <> norm_company_name(d.name)));
-- Gautam Prasad is a firm AND an attached owner of Prasad: his PAN is the firm's.
UPDATE tds_deductees d SET pan = c.pan_no, entity_type = COALESCE(d.entity_type, 'INDIVIDUAL')
  FROM companies c
 WHERE d.deductee_kind = 'OWNER' AND d.pan IS NULL AND c.pan_no ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'
   AND upper(regexp_replace(c.company_name, '^M/S\s+', '', 'i')) = upper(d.name);

-- ═══ 3. THE LEDGERS ═══════════════════════════════════════════════════════
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Duties & Taxes', 'LIABILITY', 'BALANCE_SHEET', 'CR', 220, true
 WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = 'Duties & Taxes');
INSERT INTO ledgers (ledger_name, group_head, dr_cr, branch, status, creation_type)
SELECT 'TDS Payable (194C)', 'Duties & Taxes', 'CR', 'ALL', 'ACTIVE', 'SYSTEM'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = 'TDS Payable (194C)');

-- ═══ 4. TDS BY US — liabilities, challans, returns ════════════════════════
CREATE TABLE IF NOT EXISTS tds_challans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  tan            text,
  section        text NOT NULL DEFAULT '194C',
  period_month   date NOT NULL,                       -- first day of the month the TDS belongs to
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  interest       numeric(14,2) NOT NULL DEFAULT 0,
  fee            numeric(14,2) NOT NULL DEFAULT 0,
  bsr_code       text,
  challan_serial text,
  paid_on        date NOT NULL,
  bank_ledger    text,
  voucher_id     uuid,
  bank_line_id   uuid,
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tds_liabilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id),
  company_name   text,
  deductee_id    uuid REFERENCES tds_deductees(id) ON DELETE SET NULL,
  deductee_name  text NOT NULL,
  source_kind    text NOT NULL CHECK (source_kind IN ('OWNER_BILL','MARKET_BILL','VENDOR_PAYMENT','MANUAL')),
  source_id      uuid,
  bill_no        text,
  section        text NOT NULL DEFAULT '194C',
  credit_date    date NOT NULL,                       -- earlier of credit (approval) or payment
  period_month   date NOT NULL,
  base_amount    numeric(14,2) NOT NULL DEFAULT 0,    -- what TDS is computed on (commission / partner freight / contract payment)
  rate_pct       numeric(6,3),
  tds_amount     numeric(14,2) NOT NULL DEFAULT 0,
  deposit_due    date,
  status         text NOT NULL DEFAULT 'DUE' CHECK (status IN ('PROJECTED','BLOCKED','EXEMPT','DUE','DEPOSITED','RETURNED')),
  block_reason   text,
  challan_id     uuid REFERENCES tds_challans(id) ON DELETE SET NULL,
  return_id      uuid,
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS tds_liab_firm_month_idx ON tds_liabilities (company_id, period_month, status);

CREATE TABLE IF NOT EXISTS tds_returns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  fy             text NOT NULL,                       -- '2026-27'
  quarter        text NOT NULL CHECK (quarter IN ('Q1','Q2','Q3','Q4')),
  form           text NOT NULL DEFAULT '26Q',
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PACK_READY','FILED','CORRECTION')),
  pack_generated_at timestamptz,
  filed_on       date,
  token_no       text,
  deductees      int NOT NULL DEFAULT 0,
  amount_paid    numeric(14,2) NOT NULL DEFAULT 0,
  tds_deducted   numeric(14,2) NOT NULL DEFAULT 0,
  tds_deposited  numeric(14,2) NOT NULL DEFAULT 0,
  note           text,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fy, quarter, form)
);

-- The Indian financial year and quarter of a date.
CREATE OR REPLACE FUNCTION fy_of(p date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM p) >= 4 THEN extract(year FROM p)::int || '-' || lpad(((extract(year FROM p)::int + 1) % 100)::text, 2, '0')
              ELSE (extract(year FROM p)::int - 1) || '-' || lpad((extract(year FROM p)::int % 100)::text, 2, '0') END
$$;
CREATE OR REPLACE FUNCTION fq_of(p date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM p) BETWEEN 4 AND 6 THEN 'Q1' WHEN extract(month FROM p) BETWEEN 7 AND 9 THEN 'Q2'
              WHEN extract(month FROM p) BETWEEN 10 AND 12 THEN 'Q3' ELSE 'Q4' END
$$;
-- Deposit is due by the 7th of the next month; March by 30 April.
CREATE OR REPLACE FUNCTION tds_deposit_due(p_month date) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM p_month) = 3 THEN (date_trunc('month', p_month) + interval '1 month' + interval '29 days')::date
              ELSE (date_trunc('month', p_month) + interval '1 month' + interval '6 days')::date END
$$;
-- The 26Q for a quarter is due 31 Jul / 31 Oct / 31 Jan / 31 May.
CREATE OR REPLACE FUNCTION tds_return_due(p_fy text, p_q text) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_q WHEN 'Q1' THEN make_date(split_part(p_fy, '-', 1)::int, 7, 31)
                  WHEN 'Q2' THEN make_date(split_part(p_fy, '-', 1)::int, 10, 31)
                  WHEN 'Q3' THEN make_date(split_part(p_fy, '-', 1)::int + 1, 1, 31)
                  ELSE make_date(split_part(p_fy, '-', 1)::int + 1, 5, 31) END
$$;

-- Rebuild the liabilities from the bills. Approved attached-owner bills carry
-- the commission (the base) and the TDS the approval computed; drafts are
-- PROJECTED (or BLOCKED when the rate is missing) so the desk sees what is
-- coming. A liability already tied to a challan is left alone.
CREATE OR REPLACE FUNCTION tds_liabilities_rebuild() RETURNS int AS $$
DECLARE n int := 0; r record; d record; v_rate numeric; v_tds numeric; v_status text; v_reason text; v_base numeric;
BEGIN
  FOR r IN
    SELECT b.id, b.bill_no, b.owner_name, b.class_key, b.status, b.company_id, b.operating_company, b.period_to, b.approved_at,
           b.commission, b.partner_freight, b.tds_pct, b.tds, b.needs_rate,
           (SELECT company_name FROM companies c WHERE c.id = b.company_id) AS company_name
      FROM vehicle_owner_bills b
     WHERE b.class_key IN ('ATTACHED','MARKET') AND b.status <> 'CANCELLED'
  LOOP
    SELECT * INTO d FROM tds_deductees WHERE deductee_kind = CASE WHEN r.class_key = 'MARKET' THEN 'PARTNER' ELSE 'OWNER' END AND upper(btrim(name)) = upper(btrim(r.owner_name)) LIMIT 1;
    v_base := CASE WHEN r.class_key = 'MARKET' THEN COALESCE(r.partner_freight, 0) ELSE COALESCE(r.commission, 0) END;
    v_rate := COALESCE(r.tds_pct, CASE WHEN d.id IS NOT NULL THEN tds_rate_for(d.pan, d.entity_type, d.declaration_194c6) END);
    v_tds  := COALESCE(r.tds, CASE WHEN v_rate IS NOT NULL THEN round(v_base * v_rate / 100.0, 2) END, 0);
    v_reason := NULL;
    IF r.status IN ('APPROVED','PAID') THEN
      v_status := CASE WHEN v_tds <= 0 AND v_rate = 0 THEN 'EXEMPT' WHEN v_tds <= 0 THEN 'BLOCKED' ELSE 'DUE' END;
      IF v_status = 'BLOCKED' THEN v_reason := CASE WHEN COALESCE(r.needs_rate, 0) > 0 THEN 'commission rate missing' WHEN d.id IS NULL THEN 'deductee not on the master' ELSE 'TDS not computed on the bill' END; END IF;
    ELSE
      v_status := CASE WHEN COALESCE(r.needs_rate, 0) > 0 OR v_base <= 0 THEN 'BLOCKED' ELSE 'PROJECTED' END;
      IF v_status = 'BLOCKED' THEN v_reason := CASE WHEN COALESCE(r.needs_rate, 0) > 0 THEN 'commission rate missing (Commission Master)' ELSE 'no commission on the draft' END; END IF;
    END IF;
    IF d.id IS NOT NULL AND d.pan IS NULL AND v_status IN ('DUE','PROJECTED') THEN v_reason := 'PAN missing — 20% applies until it is on file'; END IF;
    INSERT INTO tds_liabilities (company_id, company_name, deductee_id, deductee_name, source_kind, source_id, bill_no, section, credit_date, period_month,
                                 base_amount, rate_pct, tds_amount, deposit_due, status, block_reason, updated_at)
    VALUES (r.company_id, r.company_name, d.id, r.owner_name, CASE WHEN r.class_key = 'MARKET' THEN 'MARKET_BILL' ELSE 'OWNER_BILL' END, r.id, r.bill_no, '194C',
            COALESCE(r.approved_at::date, r.period_to), date_trunc('month', COALESCE(r.approved_at::date, r.period_to))::date,
            v_base, v_rate, v_tds, tds_deposit_due(date_trunc('month', COALESCE(r.approved_at::date, r.period_to))::date), v_status, v_reason, now())
    ON CONFLICT (source_kind, source_id) DO UPDATE
       SET company_id = EXCLUDED.company_id, company_name = EXCLUDED.company_name, deductee_id = EXCLUDED.deductee_id, deductee_name = EXCLUDED.deductee_name,
           bill_no = EXCLUDED.bill_no, credit_date = EXCLUDED.credit_date, period_month = EXCLUDED.period_month, base_amount = EXCLUDED.base_amount,
           rate_pct = EXCLUDED.rate_pct, tds_amount = EXCLUDED.tds_amount, deposit_due = EXCLUDED.deposit_due,
           status = CASE WHEN tds_liabilities.challan_id IS NOT NULL THEN tds_liabilities.status ELSE EXCLUDED.status END,
           block_reason = EXCLUDED.block_reason, updated_at = now()
     WHERE tds_liabilities.challan_id IS NULL OR tds_liabilities.status NOT IN ('DEPOSITED','RETURNED');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$ LANGUAGE plpgsql;

-- ═══ 5. TDS ON US — credits and Form 26AS ════════════════════════════════
CREATE TABLE IF NOT EXISTS tds_credits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  company_name    text,
  customer_id     uuid,
  customer_name   text NOT NULL,
  deductor_tan    text,
  fy              text NOT NULL,
  quarter         text NOT NULL,
  section         text NOT NULL DEFAULT '194C',
  freight_base    numeric(14,2) NOT NULL DEFAULT 0,
  tds_amount      numeric(14,2) NOT NULL DEFAULT 0,
  source          text NOT NULL CHECK (source IN ('ADVICE','AC5_BILL','BANK_ESTIMATE','MANUAL')),
  documents       int NOT NULL DEFAULT 0,
  amount_26as     numeric(14,2),
  matched_state   text NOT NULL DEFAULT 'AWAITING_26AS' CHECK (matched_state IN ('AWAITING_26AS','MATCHED','SHORT_CREDITED','EXCESS_CREDITED','NOT_IN_26AS','ESTIMATE')),
  form16a_no      text,
  form16a_received_at date,
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_name, customer_name, fy, quarter, source)
);

CREATE TABLE IF NOT EXISTS tds_26as_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id),
  import_file    text,
  deductor_tan   text,
  deductor_name  text,
  section        text,
  fy             text,
  quarter        text,
  txn_date       date,
  amount_paid    numeric(14,2),
  tds_deducted   numeric(14,2),
  tds_deposited  numeric(14,2),
  status_of_booking text,
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  line_uid       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, line_uid)
);

-- Rebuild the credits for one FY from the documents, in this order of truth:
--   1. IOCL payment advices (the TDS line itself)
--   2. AC5 bills matched to trips (2% on the bill) — for firms/customers with no advice
--   3. bank credits from BPCL / HPCL (net of 2%: gross = net ÷ 0.98) — an ESTIMATE
CREATE OR REPLACE FUNCTION tds_credits_rebuild(p_fy text DEFAULT NULL) RETURNS int AS $$
DECLARE n int := 0; v_fy text := COALESCE(p_fy, fy_of(current_date));
BEGIN
  -- 1. advices
  INSERT INTO tds_credits (company_id, company_name, customer_id, customer_name, fy, quarter, freight_base, tds_amount, source, documents, matched_state)
  SELECT (SELECT id FROM companies c WHERE norm_company_name(c.company_name) = norm_company_name(a.operating_company) LIMIT 1),
         a.operating_company, (SELECT id FROM customers WHERE customer_name ILIKE '%INDIAN OIL%' LIMIT 1), 'INDIAN OIL CORPORATION LTD',
         fy_of(a.advice_date), fq_of(a.advice_date),
         COALESCE(sum(l.gross) FILTER (WHERE l.kind = 'FREIGHT_BILL'), 0)::numeric(14,2), COALESCE(-sum(l.tds), 0)::numeric(14,2), 'ADVICE', count(DISTINCT a.advice_id)::int, 'AWAITING_26AS'
    FROM iocl_payment_advices a JOIN iocl_advice_lines l USING (advice_id)
   WHERE a.operating_company IS NOT NULL AND fy_of(a.advice_date) = v_fy
   GROUP BY a.operating_company, fy_of(a.advice_date), fq_of(a.advice_date)
  ON CONFLICT (company_name, customer_name, fy, quarter, source) DO UPDATE
     SET freight_base = EXCLUDED.freight_base, tds_amount = EXCLUDED.tds_amount, documents = EXCLUDED.documents, company_id = EXCLUDED.company_id, updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 2. AC5 bills matched to trips, per firm of the trip, where that firm-quarter has no advice
  INSERT INTO tds_credits (company_id, company_name, customer_id, customer_name, fy, quarter, freight_base, tds_amount, source, documents, matched_state)
  SELECT (SELECT id FROM companies c WHERE norm_company_name(c.company_name) = norm_company_name(t.operating_company) LIMIT 1),
         btrim(t.operating_company), (SELECT id FROM customers WHERE customer_name ILIKE '%INDIAN OIL%' LIMIT 1), 'INDIAN OIL CORPORATION LTD',
         fy_of(m.bill_date), fq_of(m.bill_date), sum(m.gross_amt)::numeric(14,2), sum(m.tds_amt)::numeric(14,2), 'AC5_BILL', count(DISTINCT m.bill_no)::int, 'AWAITING_26AS'
    FROM iocl_recon_matches m JOIN trips t ON t.id = m.trip_id
   WHERE m.match_status = 'MATCHED' AND m.bill_date IS NOT NULL AND fy_of(m.bill_date) = v_fy AND t.operating_company IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tds_credits c WHERE c.source = 'ADVICE' AND c.fy = fy_of(m.bill_date) AND c.quarter = fq_of(m.bill_date)
                        AND norm_company_name(c.company_name) = norm_company_name(t.operating_company))
   GROUP BY t.operating_company, fy_of(m.bill_date), fq_of(m.bill_date)
  ON CONFLICT (company_name, customer_name, fy, quarter, source) DO UPDATE
     SET freight_base = EXCLUDED.freight_base, tds_amount = EXCLUDED.tds_amount, documents = EXCLUDED.documents, company_id = EXCLUDED.company_id, updated_at = now();
  -- 3. BPCL / HPCL bank credits (estimate)
  INSERT INTO tds_credits (company_id, company_name, customer_id, customer_name, fy, quarter, freight_base, tds_amount, source, documents, matched_state)
  SELECT a.company_id, a.company_name,
         (SELECT id FROM customers WHERE customer_name ILIKE CASE WHEN x.cust = 'BPCL' THEN '%BHARAT PETROLEUM%' ELSE '%HINDUSTAN PETROLEUM%' END LIMIT 1),
         CASE WHEN x.cust = 'BPCL' THEN 'BHARAT PETROLEUM CORPORATION LTD' ELSE 'HINDUSTAN PETROLEUM CORPORATION LIMITED' END,
         fy_of(l.txn_date), fq_of(l.txn_date), round(sum(l.credit) / 0.98, 2), round(sum(l.credit) / 0.98 - sum(l.credit), 2), 'BANK_ESTIMATE', count(*)::int, 'ESTIMATE'
    FROM bank_statement_lines l JOIN bank_accounts a ON a.id = l.account_id
    JOIN LATERAL (SELECT CASE WHEN l.counterparty ILIKE '%BHARAT PETRO%' OR l.description ILIKE '%BHARAT PETRO%' OR l.description ILIKE '%BPCL%' THEN 'BPCL'
                              WHEN l.counterparty ILIKE '%HINDUSTAN PETRO%' OR l.description ILIKE '%HINDUSTAN PETRO%' OR l.description ILIKE '%HPCL%' THEN 'HPCL' END AS cust) x ON x.cust IS NOT NULL
   WHERE l.credit > 0 AND fy_of(l.txn_date) = v_fy AND l.status NOT IN ('NOT_OURS','IGNORED')
   GROUP BY a.company_id, a.company_name, x.cust, fy_of(l.txn_date), fq_of(l.txn_date)
  ON CONFLICT (company_name, customer_name, fy, quarter, source) DO UPDATE
     SET freight_base = EXCLUDED.freight_base, tds_amount = EXCLUDED.tds_amount, documents = EXCLUDED.documents, company_id = EXCLUDED.company_id, updated_at = now();
  -- 26AS match, where an upload exists
  UPDATE tds_credits c
     SET amount_26as = s.tds, matched_state = CASE WHEN abs(s.tds - c.tds_amount) <= 2 THEN 'MATCHED' WHEN s.tds < c.tds_amount THEN 'SHORT_CREDITED' ELSE 'EXCESS_CREDITED' END, updated_at = now()
    FROM (SELECT company_id, fy, quarter, upper(regexp_replace(deductor_name, '[^A-Za-z ]', '', 'g')) AS dn, sum(tds_deducted) AS tds
            FROM tds_26as_lines GROUP BY 1, 2, 3, 4) s
   WHERE s.company_id = c.company_id AND s.fy = c.fy AND s.quarter = c.quarter
     AND (s.dn LIKE '%' || split_part(upper(c.customer_name), ' ', 1) || '%' OR upper(c.customer_name) LIKE '%' || split_part(s.dn, ' ', 1) || '%');
  UPDATE tds_credits c SET matched_state = 'NOT_IN_26AS', updated_at = now()
   WHERE c.amount_26as IS NULL AND c.source <> 'BANK_ESTIMATE'
     AND EXISTS (SELECT 1 FROM tds_26as_lines s WHERE s.company_id = c.company_id AND s.fy = c.fy AND s.quarter = c.quarter);
  RETURN n;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tds_rebuild(p_fy text DEFAULT NULL) RETURNS TABLE (liabilities int, credits int) AS $$
BEGIN
  RETURN QUERY SELECT tds_liabilities_rebuild(), tds_credits_rebuild(p_fy);
END $$ LANGUAGE plpgsql;

-- ═══ 6. WHAT THE SCREEN READS ═════════════════════════════════════════════
CREATE OR REPLACE VIEW v_tds_payable_month AS
SELECT company_id, company_name, period_month, fy_of(period_month) AS fy, fq_of(period_month) AS quarter, tds_deposit_due(period_month) AS deposit_due,
       count(*)::int AS lines,
       sum(base_amount) FILTER (WHERE status IN ('DUE','DEPOSITED','RETURNED'))::numeric(14,2) AS base_due,
       sum(tds_amount)  FILTER (WHERE status IN ('DUE','DEPOSITED','RETURNED'))::numeric(14,2) AS tds_due,
       sum(tds_amount)  FILTER (WHERE status IN ('DEPOSITED','RETURNED'))::numeric(14,2) AS tds_deposited,
       sum(tds_amount)  FILTER (WHERE status = 'PROJECTED')::numeric(14,2) AS tds_projected,
       count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked,
       count(*) FILTER (WHERE status = 'EXEMPT')::int AS exempt,
       CASE WHEN sum(tds_amount) FILTER (WHERE status = 'DUE') > 0 AND tds_deposit_due(period_month) < current_date THEN 'OVERDUE'
            WHEN sum(tds_amount) FILTER (WHERE status = 'DUE') > 0 THEN 'DUE'
            WHEN count(*) FILTER (WHERE status = 'BLOCKED') > 0 THEN 'BLOCKED'
            WHEN sum(tds_amount) FILTER (WHERE status IN ('DEPOSITED','RETURNED')) > 0 THEN 'DEPOSITED'
            ELSE 'NOTHING' END AS state
  FROM tds_liabilities GROUP BY company_id, company_name, period_month;

CREATE OR REPLACE VIEW v_tds_overview AS
SELECT c.id AS company_id, c.company_name, c.pan_no, c.tan,
       (SELECT COALESCE(sum(tds_amount), 0)::numeric(14,2) FROM tds_credits x WHERE x.company_id = c.id AND x.fy = fy_of(current_date) AND x.source <> 'BANK_ESTIMATE') AS tds_on_us_documented,
       (SELECT COALESCE(sum(tds_amount), 0)::numeric(14,2) FROM tds_credits x WHERE x.company_id = c.id AND x.fy = fy_of(current_date) AND x.source = 'BANK_ESTIMATE') AS tds_on_us_estimated,
       (SELECT COALESCE(sum(amount_26as), 0)::numeric(14,2) FROM tds_credits x WHERE x.company_id = c.id AND x.fy = fy_of(current_date)) AS tds_on_us_26as,
       (SELECT count(*)::int FROM tds_credits x WHERE x.company_id = c.id AND x.fy = fy_of(current_date) AND x.form16a_no IS NOT NULL) AS form16a_received,
       (SELECT COALESCE(sum(CASE WHEN dr_cr = 'DR' THEN amount ELSE -amount END), 0)::numeric(14,2) FROM ledger_entries e WHERE e.ledger_name = 'TDS Receivable 194C' AND (e.company_id = c.id OR (e.company_id IS NULL AND c.company_name ILIKE '%PRASAD TRANSPORT%'))) AS receivable_ledger,
       (SELECT COALESCE(sum(tds_amount), 0)::numeric(14,2) FROM tds_liabilities x WHERE x.company_id = c.id AND x.status = 'DUE') AS tds_by_us_due,
       (SELECT COALESCE(sum(tds_amount), 0)::numeric(14,2) FROM tds_liabilities x WHERE x.company_id = c.id AND x.status IN ('DEPOSITED','RETURNED')) AS tds_by_us_deposited,
       (SELECT COALESCE(sum(tds_amount), 0)::numeric(14,2) FROM tds_liabilities x WHERE x.company_id = c.id AND x.status = 'PROJECTED') AS tds_by_us_projected,
       (SELECT count(*)::int FROM tds_liabilities x WHERE x.company_id = c.id AND x.status = 'BLOCKED') AS blocked,
       (SELECT count(*)::int FROM tds_liabilities x WHERE x.company_id = c.id AND x.status = 'DUE' AND x.deposit_due < current_date) AS overdue,
       (SELECT count(*)::int FROM tds_deductees d WHERE d.pan IS NULL AND EXISTS (SELECT 1 FROM tds_liabilities x WHERE x.deductee_id = d.id AND x.company_id = c.id)) AS deductees_without_pan
  FROM companies c;

-- The dashboard may name these.
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP','AMOUNT_MISMATCH','LEDGER_DRIFT',
  'MISSING_MASTER','OTHER','SCAN_FAILURE','AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE',
  'REQUEST_FAILURE','BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH',
  'MISSING_FREIGHT','UNMATCHED_CUSTOMER_LINE','CUSTOMER_DISPUTE','MAILBOX_REAUTH',
  'BANK_UNMATCHED','BANK_BOOK_NOT_IN_BANK',
  'TDS_PAN_MISSING','TDS_DEPOSIT_DUE','TDS_RETURN_DUE','TDS_26AS_MISMATCH','TDS_TAN_MISSING']));

-- ═══ 7. FIRST BUILD ═══════════════════════════════════════════════════════
SELECT * FROM tds_rebuild(fy_of(current_date));
