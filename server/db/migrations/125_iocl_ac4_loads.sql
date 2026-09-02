-- ═══════════════════════════════════════════════════════════════════════════
-- 125_iocl_ac4_loads.sql — the daily loading register, separate from trips
--
-- IOCL mails the transporter two documents for a road delivery and the owner
-- has ruled (2026-09-02) that they are two different things:
--
--     AC4  "AC4 Inv.- 7010447890"   IOCL's tax invoice to the consignee. It is
--          the record that a tank truck LOADED — truck, time, product, KL,
--          customer — and arrives within the hour of the truck leaving the bay.
--          Daily dispatch operations.
--     AC5  "AC5 Invoice"             The freight invoice on the transporter's
--          contract, on a fortnightly billing rhythm. The unit of billing, and
--          the only thing that becomes a trips row.
--
-- The two are NOT merged. An AC4 is never a trip and carries no freight; an
-- AC5 is never looked up against this table. This table is what "Today's
-- Loading Activity" reads to answer "what loaded today", which trips alone
-- could not answer: 77 AC4 mails to 32 AC5 mails between 15-Aug and 2-Sep.
--
-- One row per AC4 document, keyed on its SAP entry number, so the importer
-- can re-read the same mail every ten minutes and write nothing twice.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS iocl_ac4_loads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sap_no             text NOT NULL UNIQUE,          -- "SAP Entry no." on the document
  loading_date       date NOT NULL,
  loading_time       text,                          -- "11:16" as printed
  vehicle_no         text NOT NULL,                 -- register spelling, "AS 26AC 0403"
  transporter        text,                          -- as printed, "PRASAD TRANSPORT"
  contractor_code    text,                          -- IOCL contractor code, 11024699
  operating_company  text,                          -- resolved to the register's string
  loading_point      text,                          -- "Bongaigaon RC Office (7R01)"
  loading_point_code text,
  consignee_code     text,
  consignee          text,
  products           text,                          -- register vocabulary, "MS + HSD (Part Load)"
  items              jsonb NOT NULL DEFAULT '[]'::jsonb,  -- per-product lines as printed
  qty_kl             numeric(12,3) NOT NULL,
  mailbox            text,                          -- which inbox it came from
  pdf_name           text,
  received_on        date,                          -- the mail's received date
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iocl_ac4_loads_day
  ON iocl_ac4_loads (loading_date DESC, loading_time DESC);
CREATE INDEX IF NOT EXISTS idx_iocl_ac4_loads_vehicle
  ON iocl_ac4_loads (vehicle_no, loading_date DESC);

COMMIT;
