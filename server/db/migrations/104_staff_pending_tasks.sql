-- 104_staff_pending_tasks.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Three data faults that the 20-08-2026 loading import surfaced, routed to the
-- staff who can actually fix them instead of being fixed automatically.
--
-- The owner's instruction was explicit: do NOT auto-fix these. Each one needs a
-- person who knows the business to say what the right value is, so each becomes
-- an exception with an EDIT action rather than a migration that rewrites rows.
--
--   BLANK_CUSTOMER   81 trips carry no customer_name. customer is a grouping
--                    key for every invoice, so these loads cannot be billed at
--                    all -- they are invisible to fortnightly and monthly
--                    billing alike. 44 of them do carry an IOCL invoice number,
--                    which strongly implies IOCL, but "implies" is not "is" and
--                    a wrong customer bills the wrong company.
--
--   MASTER_DATA_GAP  companies.gstin is BLANK for all three firms while the
--                    owner's own signed Aadhar Green invoice prints
--                    18AAKFP2339R2ZG. The bill template prints from this table,
--                    so every auto-generated invoice would go out with no GSTIN
--                    -- an invoice the customer's GST return cannot accept.
--                    The same invoice prints A/c 41365145913 for Prasad
--                    Transport where the master holds 30178368490.
--
--   ENTITY_MISMATCH  64 HPCL/BPCL trips sit under PRASAD TRANSPORT or GAUTAM
--                    PRASAD. The owner confirmed on 20-08-2026 that HPCL
--                    (service agent 27050901) and BPCL (vendor 0000226709) are
--                    both JAISWAL ENTERPRISE. operating_company decides GSTIN,
--                    letterhead, bank account and invoice series, so this is the
--                    wrong legal entity billing -- not a cosmetic label.
--
-- WHY THE CUSTOMER->ENTITY RULE BECOMES A TABLE, NOT AN `IF` IN A DETECTOR
-- It is a business fact that changes when a contract moves between the firms,
-- and it was only knowable by asking the owner. A hardcoded regex in JavaScript
-- makes it invisible and un-editable; a row makes it something staff can see,
-- correct and date. The detector reads the table and holds no opinion.

BEGIN;

-- ── the three new exception kinds ──────────────────────────────────────────
ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_kind_check;
ALTER TABLE exceptions ADD  CONSTRAINT exceptions_kind_check CHECK (kind = ANY (ARRAY[
  'DUPLICATE_BILLING','DRIVER_MISMATCH','PARSER_REJECT','UNMATCHED_TRIP',
  'AMOUNT_MISMATCH','LEDGER_DRIFT','MISSING_MASTER','OTHER','SCAN_FAILURE',
  'AI_FAILURE','AUTO_UPDATE_FAILURE','INTEGRATION_FAILURE','REQUEST_FAILURE',
  'BLANK_CUSTOMER','MASTER_DATA_GAP','ENTITY_MISMATCH'
]));

-- Routing. A blank customer is the operations desk's row to fill; a missing
-- GSTIN and a trip booked to the wrong legal entity are both accounting's,
-- because both decide what a tax invoice says.
CREATE OR REPLACE FUNCTION exception_department(p_kind text, p_subject_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN p_kind IN ('DUPLICATE_BILLING','AMOUNT_MISMATCH','LEDGER_DRIFT')      THEN 'ACCOUNTING'
    WHEN p_kind IN ('MASTER_DATA_GAP','ENTITY_MISMATCH')                       THEN 'ACCOUNTING'
    WHEN p_kind IN ('DRIVER_MISMATCH','UNMATCHED_TRIP','BLANK_CUSTOMER')       THEN 'OPERATIONS'
    WHEN p_kind IN ('PARSER_REJECT','SCAN_FAILURE')                            THEN
      CASE WHEN p_subject_type IN ('vehicle','driver','vehicle_document') THEN 'COMPLIANCE'
           ELSE 'OPERATIONS' END
    WHEN p_kind = 'MISSING_MASTER'                                             THEN 'OPERATIONS'
    WHEN p_kind IN ('AI_FAILURE','REQUEST_FAILURE','INTEGRATION_FAILURE')      THEN 'IT'
    WHEN p_kind = 'AUTO_UPDATE_FAILURE'                                        THEN
      CASE WHEN p_subject_type IN ('vehicle','driver','vehicle_document') THEN 'COMPLIANCE'
           ELSE 'IT' END
    ELSE 'OPERATIONS'
  END;
$fn$;

-- ── which firm bills which customer ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_billing_entity (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_pattern  text NOT NULL,          -- POSIX regex, matched case-insensitively
  customer_label    text NOT NULL,
  expected_company  text NOT NULL,
  vendor_code       text,                   -- the oil company's code for us, when known
  source            text NOT NULL,
  confirmed_by      text,
  confirmed_at      timestamptz,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_billing_entity_pattern_key
  ON customer_billing_entity (lower(customer_pattern)) WHERE active;

COMMENT ON TABLE customer_billing_entity IS
  'Which operating company bills which customer. Read by the ENTITY_MISMATCH detector; edited by staff, never inferred from trips (trips is what it checks).';

INSERT INTO customer_billing_entity (customer_pattern, customer_label, expected_company, vendor_code, source, confirmed_by, confirmed_at)
SELECT v.pat, v.label, v.co, v.vc, v.src, 'owner', now()
  FROM (VALUES
    ('HPCL|HINDUSTAN PETROLEUM|HINDUATAN', 'HPCL',         'M/S JAISWAL ENTERPRISE', '27050901',
     'Owner confirmed 20-08-2026. Every TransporterBill CSV Apr-Jul 2026 carries service agent 27050901.'),
    ('BHARAT PETROLEUM|BPCL',              'BPCL',         'M/S JAISWAL ENTERPRISE', '0000226709',
     'Owner confirmed 20-08-2026. Every AP210 Transportation Bill Apr-Aug 2026 is "for Vendor 0000226709".'),
    ('AADHAR',                             'Aadhar Green', 'M/S PRASAD TRANSPORT',   NULL,
     'All 65 Aadhar Green trips in the ERP are PRASAD TRANSPORT; signed invoices are on Prasad letterhead.')
  ) AS v(pat, label, co, vc, src)
 WHERE NOT EXISTS (SELECT 1 FROM customer_billing_entity c WHERE lower(c.customer_pattern) = lower(v.pat));

COMMIT;
