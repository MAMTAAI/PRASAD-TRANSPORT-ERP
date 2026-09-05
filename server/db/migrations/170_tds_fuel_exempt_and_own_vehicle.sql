-- ═══════════════════════════════════════════════════════════════════════════
-- 170 — Fuel pumps are not deductees; the firm's own lorry is not attached.
--
-- Owner, 5-Sep-2026 (GOD COMMAND): (1) Section 194C does not apply to the
-- purchase of goods — diesel bought at a pump is goods, not a works
-- contract. The deductee list showed 12 fuel pumps at 20%. (2) AS26C5108
-- sits on the vehicle master as ATTACHED to "PRASAD TRANSPORT" — the firm
-- itself — so six 15-day "owner" bills and their TDS lines were drafted
-- against our own company.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. WHO TDS APPLIES TO ═══════════════════════════════════════════════
ALTER TABLE tds_deductees ADD COLUMN IF NOT EXISTS is_tds_applicable boolean NOT NULL DEFAULT true;
ALTER TABLE tds_deductees ADD COLUMN IF NOT EXISTS exemption_reason text;
COMMENT ON COLUMN tds_deductees.is_tds_applicable IS
  'false = Section 194C does not apply to what we buy from this party (goods: fuel, tyres, spares). They never appear on the TDS desk or in Form 26Q.';

-- The vendor master already names the trade ("Fuel Pump"); the name says the rest.
CREATE OR REPLACE FUNCTION vendor_is_goods_supplier(p_name text, p_type text, p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_type, '') ~* 'fuel|pump|petrol|diesel|hsd|spare|parts|tyre|tire|lubric|oil'
      OR COALESCE(p_name, '') ~* 'fuel|filling|petrol|petrolum|petroleum|diesel|\mhsd\M|service station|service centre|energy station|hp lotus|automobile|spares|tyre|tire|retread|trading'
$$;

UPDATE tds_deductees d
   SET is_tds_applicable = false,
       exemption_reason = 'Purchase of goods (fuel / HSD / spares) — Section 194C does not apply; 194Q only above the ₹50 L threshold',
       updated_at = now()
  FROM vendors v
 WHERE d.deductee_kind = 'VENDOR' AND d.is_tds_applicable
   AND (d.vendor_id = v.id OR upper(btrim(v.vendor_name)) = upper(btrim(d.name)))
   AND vendor_is_goods_supplier(v.vendor_name, v.vendor_type, v.vendor_kind);
UPDATE tds_deductees d
   SET is_tds_applicable = false,
       exemption_reason = 'Purchase of goods (fuel / HSD / spares) — Section 194C does not apply',
       updated_at = now()
 WHERE d.deductee_kind = 'VENDOR' AND d.is_tds_applicable
   AND vendor_is_goods_supplier(d.name, NULL, NULL);

-- New vendors seeded later inherit the same test.
CREATE OR REPLACE FUNCTION tds_deductees_seed_vendor() RETURNS trigger AS $$
BEGIN
  IF NEW.deductee_kind = 'VENDOR' AND NEW.is_tds_applicable AND vendor_is_goods_supplier(NEW.name, NULL, NULL) THEN
    NEW.is_tds_applicable := false;
    NEW.exemption_reason := COALESCE(NEW.exemption_reason, 'Purchase of goods (fuel / HSD / spares) — Section 194C does not apply');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tds_deductees_goods ON tds_deductees;
CREATE TRIGGER tds_deductees_goods BEFORE INSERT ON tds_deductees FOR EACH ROW EXECUTE FUNCTION tds_deductees_seed_vendor();

-- ═══ 2. THE FIRM'S OWN LORRY IS OWN ═══════════════════════════════════════
UPDATE vehicles v
   SET ownership = 'OWNED', updated_at = now()
  FROM companies c
 WHERE c.id = v.company_id AND v.ownership = 'ATTACHED'
   AND norm_company_name(v.owner_name) = norm_company_name(c.company_name);

-- The "owner" bills drafted against the firm itself go (drafts only, no
-- voucher was ever posted; settlement lines keep their rows, ON DELETE SET NULL).
DELETE FROM tds_liabilities l
 WHERE l.source_kind = 'OWNER_BILL'
   AND EXISTS (SELECT 1 FROM vehicle_owner_bills b JOIN companies c ON c.id = b.company_id
                WHERE b.id = l.source_id AND b.status <> 'APPROVED' AND norm_company_name(b.owner_name) = norm_company_name(c.company_name));
DELETE FROM vehicle_owner_bills b
 WHERE b.class_key = 'ATTACHED' AND b.status <> 'APPROVED' AND b.locked_at IS NULL
   AND EXISTS (SELECT 1 FROM companies c WHERE c.id = b.company_id AND norm_company_name(b.owner_name) = norm_company_name(c.company_name));
DELETE FROM tds_deductees d
 WHERE d.deductee_kind = 'OWNER'
   AND EXISTS (SELECT 1 FROM companies c WHERE norm_company_name(c.company_name) = norm_company_name(d.name))
   AND NOT EXISTS (SELECT 1 FROM vehicles v LEFT JOIN companies c ON c.id = v.company_id
                    WHERE v.ownership = 'ATTACHED' AND upper(btrim(v.owner_name)) = upper(d.name)
                      AND (c.id IS NULL OR norm_company_name(c.company_name) <> norm_company_name(d.name)));

-- ═══ 3. THE REBUILD SKIPS WHAT DOES NOT APPLY ═════════════════════════════
CREATE OR REPLACE FUNCTION tds_liabilities_rebuild() RETURNS int AS $$
DECLARE n int := 0; r record; d record; v_rate numeric; v_tds numeric; v_status text; v_reason text; v_base numeric;
BEGIN
  FOR r IN
    SELECT b.id, b.bill_no, b.owner_name, b.class_key, b.status, b.company_id, b.operating_company, b.period_to, b.approved_at,
           b.commission, b.partner_freight, b.tds_pct, b.tds, b.needs_rate,
           (SELECT company_name FROM companies c WHERE c.id = b.company_id) AS company_name
      FROM vehicle_owner_bills b
     WHERE b.class_key IN ('ATTACHED','MARKET') AND b.status <> 'CANCELLED'
       AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = b.company_id AND norm_company_name(c.company_name) = norm_company_name(b.owner_name))   -- a firm never pays itself; another firm (Gautam under Prasad) is a real deductee
  LOOP
    SELECT * INTO d FROM tds_deductees WHERE deductee_kind = CASE WHEN r.class_key = 'MARKET' THEN 'PARTNER' ELSE 'OWNER' END AND upper(btrim(name)) = upper(btrim(r.owner_name)) LIMIT 1;
    IF d.id IS NOT NULL AND NOT d.is_tds_applicable THEN
      DELETE FROM tds_liabilities WHERE source_kind = CASE WHEN r.class_key = 'MARKET' THEN 'MARKET_BILL' ELSE 'OWNER_BILL' END AND source_id = r.id AND challan_id IS NULL;
      CONTINUE;
    END IF;
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
  -- a draft line whose bill is gone, or whose party is our own firm, goes with it
  DELETE FROM tds_liabilities l
   WHERE l.status IN ('PROJECTED','BLOCKED') AND l.challan_id IS NULL
     AND (NOT EXISTS (SELECT 1 FROM vehicle_owner_bills b WHERE b.id = l.source_id)
          OR EXISTS (SELECT 1 FROM companies c WHERE c.id = l.company_id AND norm_company_name(c.company_name) = norm_company_name(l.deductee_name)));
  RETURN n;
END $$ LANGUAGE plpgsql;

-- The overview counts only deductees TDS applies to.
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
       (SELECT count(*)::int FROM tds_deductees d WHERE d.pan IS NULL AND d.is_tds_applicable AND EXISTS (SELECT 1 FROM tds_liabilities x WHERE x.deductee_id = d.id AND x.company_id = c.id)) AS deductees_without_pan
  FROM companies c;

-- ═══ 4. REBUILD ═══════════════════════════════════════════════════════════
SELECT * FROM tds_rebuild(fy_of(current_date));
