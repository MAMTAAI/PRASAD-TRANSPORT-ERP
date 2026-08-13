-- ═══════════════════════════════════════════════════════════════════════════
-- 009_iocl_recon.sql — IOCL Transportation Bill ingestion + reconciliation
--
-- Three concerns, deliberately separated:
--
--   iocl_bill_runs     one row per PDF parsed. Immutable audit of WHAT was
--                      read, from which file (sha256), under which date window,
--                      and whether the printed subtotals reconciled.
--
--   iocl_bill_lines    one row per PDF line item, verbatim. The PDF groups
--                      several item codes (50700 MS / 16730 HSD) under one
--                      invoice+date+vehicle, so a line is NOT a trip — it is a
--                      compartment. Stored raw so a mis-parse can be re-derived
--                      without re-reading the PDF.
--
--   iocl_recon_matches one row per COMPOSITE GROUP (vehicle+date+ship-to), the
--                      level at which a PDF fact actually corresponds to an ERP
--                      trip. Holds the match verdict, the money, and the trip it
--                      was applied to.
--
-- Why staging tables rather than writing straight onto trips: a bill that fails
-- to reconcile must leave evidence, not silence. The parser is allowed to be
-- wrong; it is not allowed to be wrong invisibly.
--
-- Money on trips is stored as ABSOLUTE values, never increments, so re-running
-- the same bill converges instead of double-counting.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIPS — billing / settlement columns fed by the reconciler.
--
-- Separate from trips.status: status is the OPERATIONAL lifecycle (KALI's
-- domain, PENDING→COMPLETED), payment_status is the COMMERCIAL one. A trip can
-- be COMPLETED and unpaid for ninety days; conflating the two loses that.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS billed_amount    numeric(14,2),
  ADD COLUMN IF NOT EXISTS received_amount  numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tds_amount       numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount      numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_amount      numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount      numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty_amount   numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iocl_bill_no     text,
  ADD COLUMN IF NOT EXISTS iocl_invoice_no  text,
  ADD COLUMN IF NOT EXISTS gst_reverse_charge boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_status   text NOT NULL DEFAULT 'UNBILLED',
  ADD COLUMN IF NOT EXISTS reconciled_at    timestamptz;

-- ADD CONSTRAINT has no IF NOT EXISTS in PG 16 — guard it so the migration is
-- safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_payment_status_chk') THEN
    ALTER TABLE trips ADD CONSTRAINT trips_payment_status_chk
      CHECK (payment_status IN ('UNBILLED','BILLED','PART_PAID','PAID','DISPUTED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS trips_payment_status_idx ON trips (payment_status, loading_date DESC);
CREATE INDEX IF NOT EXISTS trips_iocl_bill_idx      ON trips (iocl_bill_no) WHERE iocl_bill_no IS NOT NULL;

-- Match acceleration for the reconciler: the composite key it actually probes.
-- The expression mirrors norm_vehicle() in the Python tool EXACTLY — if one
-- changes, the other must.
CREATE INDEX IF NOT EXISTS trips_vehnorm_date_idx
  ON trips (regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g'), loading_date);

-- ═══════════════════════════════════════════════════════════════════════════
-- IOCL_BILL_RUNS — one row per parse. pdf_sha256 makes a re-parse of the same
-- file recognisable, so "did we already ingest this?" is a lookup, not a guess.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS iocl_bill_runs (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pdf_path          text NOT NULL,
  pdf_name          text NOT NULL,
  pdf_sha256        char(64) NOT NULL,
  tool_version      text NOT NULL,
  vendor_code       text,
  vendor_gstin      text,
  rc_office         text,
  bill_period_from  date,
  bill_period_to    date,
  window_from       date NOT NULL,
  window_to         date NOT NULL,
  pages             integer NOT NULL DEFAULT 0,
  lines_parsed      integer NOT NULL DEFAULT 0,
  lines_in_window   integer NOT NULL DEFAULT 0,
  lines_out_window  integer NOT NULL DEFAULT 0,
  checksum_ok       boolean,                 -- printed subtotals vs our sums
  checksum_detail   jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_warnings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iocl_runs_sha_idx ON iocl_bill_runs (pdf_sha256, parsed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- IOCL_BILL_LINES — verbatim PDF line items.
--
-- line_uid is a deterministic digest of the natural key, so re-parsing the same
-- PDF UPSERTs the same rows instead of duplicating them. Idempotency lives in
-- the key, not in the caller's discipline.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS iocl_bill_lines (
  line_uid        char(40) PRIMARY KEY,      -- sha1(bill|invoice|item|date|vehicle|material)
  run_id          uuid NOT NULL REFERENCES iocl_bill_runs(run_id) ON DELETE CASCADE,
  group_uid       char(40) NOT NULL,         -- FK-by-convention to iocl_recon_matches
  bill_no         text NOT NULL,
  bill_date       date,
  reverse_charge  boolean NOT NULL DEFAULT false,
  s_no            integer,
  invoice_no      text NOT NULL,
  item_code       text,
  line_date       date NOT NULL,
  vehicle_no_raw  text NOT NULL,
  vehicle_norm    text NOT NULL,
  ship_to_raw     text,
  ship_to_code    text,
  ship_to_name    text,
  material        text,
  quantity_kl     numeric(12,3),
  shortage        numeric(12,3),
  gross_amt       numeric(14,2) NOT NULL DEFAULT 0,
  penalty_amt     numeric(14,2) NOT NULL DEFAULT 0,
  igst_amt        numeric(14,2) NOT NULL DEFAULT 0,
  cgst_amt        numeric(14,2) NOT NULL DEFAULT 0,
  sgst_amt        numeric(14,2) NOT NULL DEFAULT 0,
  page_no         integer,
  source_line     text,                      -- raw reconstructed text, for triage
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iocl_lines_group_idx   ON iocl_bill_lines (group_uid);
CREATE INDEX IF NOT EXISTS iocl_lines_vehdate_idx ON iocl_bill_lines (vehicle_norm, line_date);
CREATE INDEX IF NOT EXISTS iocl_lines_bill_idx    ON iocl_bill_lines (bill_no);
CREATE INDEX IF NOT EXISTS iocl_lines_invoice_idx ON iocl_bill_lines (invoice_no);

-- ═══════════════════════════════════════════════════════════════════════════
-- IOCL_RECON_MATCHES — the composite group and its verdict.
--
-- One row per (vehicle + trip date + ship-to), which is the grain at which the
-- PDF and the ERP actually agree. gross_amt here is the SUM of member lines.
--
-- match_status vocabulary:
--   MATCHED              exactly one ERP trip, above confidence threshold
--   AMBIGUOUS            2+ trips indistinguishable — refused, needs a human
--   UNMATCHED_NO_TRIP    nothing in ERP on that vehicle+date
--   UNMATCHED_LOCATION   trip(s) on that vehicle+date, none whose ship-to agrees
--   TRIP_ALREADY_CLAIMED another group won this trip on a higher score
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS iocl_recon_matches (
  group_uid       char(40) PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES iocl_bill_runs(run_id) ON DELETE CASCADE,

  bill_no         text NOT NULL,
  bill_date       date,
  invoice_nos     text[] NOT NULL DEFAULT '{}',
  line_count      integer NOT NULL DEFAULT 0,

  vehicle_no_raw  text NOT NULL,
  vehicle_norm    text NOT NULL,
  trip_date       date NOT NULL,
  ship_to_code    text,
  ship_to_name    text,

  gross_amt       numeric(14,2) NOT NULL DEFAULT 0,
  penalty_amt     numeric(14,2) NOT NULL DEFAULT 0,
  igst_amt        numeric(14,2) NOT NULL DEFAULT 0,
  cgst_amt        numeric(14,2) NOT NULL DEFAULT 0,
  sgst_amt        numeric(14,2) NOT NULL DEFAULT 0,
  tds_section     text,
  tds_pct         numeric(6,3),
  tds_amt         numeric(14,2) NOT NULL DEFAULT 0,
  net_receivable  numeric(14,2) NOT NULL DEFAULT 0,   -- gross - penalty - tds

  match_status    text NOT NULL,
  match_method    text,                      -- CODE | NAME | VEHICLE_DATE_ONLY
  confidence      numeric(5,4),
  date_delta_days integer NOT NULL DEFAULT 0,
  trip_id         uuid REFERENCES trips(id) ON DELETE SET NULL,
  candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- rejected near-misses

  applied         boolean NOT NULL DEFAULT false,
  applied_at      timestamptz,
  voucher_id      uuid,
  settlement_basis text,                     -- 'billed' | 'paid'
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT iocl_match_status_chk CHECK (match_status IN
    ('MATCHED','AMBIGUOUS','UNMATCHED_NO_TRIP','UNMATCHED_LOCATION','TRIP_ALREADY_CLAIMED')),
  -- Only a MATCHED group may carry a trip, and only a group with a trip may be
  -- applied. Keeps "we paid something we never matched" out of the data model.
  CONSTRAINT iocl_match_trip_chk CHECK (trip_id IS NULL OR match_status = 'MATCHED'),
  CONSTRAINT iocl_match_applied_chk CHECK (NOT applied OR trip_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS iocl_match_status_idx ON iocl_recon_matches (match_status, trip_date DESC);
CREATE INDEX IF NOT EXISTS iocl_match_trip_idx   ON iocl_recon_matches (trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS iocl_match_run_idx    ON iocl_recon_matches (run_id);

-- One trip can be settled by ONE bill group. This is the database-level answer
-- to double-payment: a second group trying to claim the same trip violates a
-- unique index rather than quietly overwriting the first.
CREATE UNIQUE INDEX IF NOT EXISTS iocl_match_trip_once
  ON iocl_recon_matches (trip_id) WHERE trip_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'iocl_match_touch') THEN
    CREATE TRIGGER iocl_match_touch BEFORE UPDATE ON iocl_recon_matches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- V_IOCL_RECON_EXCEPTIONS — the desk the accounts clerk actually works from.
-- Everything the machine refused to decide, newest first.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_iocl_recon_exceptions AS
SELECT m.match_status,
       m.bill_no,
       m.trip_date,
       m.vehicle_no_raw,
       m.ship_to_code,
       m.ship_to_name,
       m.gross_amt,
       m.line_count,
       m.invoice_nos,
       m.confidence,
       m.candidates,
       r.pdf_name,
       m.created_at
  FROM iocl_recon_matches m
  JOIN iocl_bill_runs r USING (run_id)
 WHERE m.match_status <> 'MATCHED'
 ORDER BY m.trip_date DESC, m.vehicle_no_raw;

-- ═══════════════════════════════════════════════════════════════════════════
-- V_IOCL_BILL_SUMMARY — per-bill money and match rate, for the dashboard tile.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_iocl_bill_summary AS
SELECT m.bill_no,
       m.bill_date,
       count(*)                                             AS groups,
       count(*) FILTER (WHERE m.match_status = 'MATCHED')    AS matched,
       count(*) FILTER (WHERE m.applied)                     AS applied,
       sum(m.gross_amt)                                      AS gross_amt,
       sum(m.igst_amt + m.cgst_amt + m.sgst_amt)             AS gst_total,
       sum(m.tds_amt)                                        AS tds_total,
       sum(m.net_receivable)                                 AS net_receivable,
       sum(m.gross_amt) FILTER (WHERE m.match_status <> 'MATCHED') AS gross_unmatched
  FROM iocl_recon_matches m
 GROUP BY m.bill_no, m.bill_date;

COMMIT;
