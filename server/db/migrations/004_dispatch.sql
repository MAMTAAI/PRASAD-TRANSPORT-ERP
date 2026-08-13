-- ═══════════════════════════════════════════════════════════════════════════
-- 004_dispatch.sql — dispatch domain: customers, vendors, lanes, trips, fuel
--
-- Un-parks KALI (trips), TRIPURA SUNDARI (rtkm_master, rate_master, customers)
-- and CHHINNAMASTA (fuel_entries, vendors).
--
-- Column names deliberately match what the agents already query (tripura.js
-- reads rtkm_master.fixed_hsd_qty, chhinnamasta.js reads fuel_entries.liters,
-- tara.js reads trips.freight_amount) — the agents were written first and are
-- the contract; the schema serves them.
--
-- Every table keeps legacy_id so the Firestore loader is idempotent
-- (ON CONFLICT (legacy_id) DO UPDATE) and every row traces to its source doc.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMERS — freight customers (IOCL etc.). consignees/locations stay jsonb:
-- the UI reads them whole and per-consignee lanes live in rtkm_master.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE customers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  customer_code   text,
  customer_name   text NOT NULL,
  address         text,
  state           text,
  pincode         text,
  gst_no          citext,
  pan_no          citext,
  contact_person  text,
  mobile_no       text,
  email           citext,
  payment_terms   text,
  opening_balance     numeric(14,2) DEFAULT 0,
  current_outstanding numeric(14,2) DEFAULT 0,
  total_freight   numeric(14,2) DEFAULT 0,
  total_received  numeric(14,2) DEFAULT 0,
  total_shortage  numeric(14,2) DEFAULT 0,
  total_tds       numeric(14,2) DEFAULT 0,
  consignees      jsonb NOT NULL DEFAULT '[]'::jsonb,
  locations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  portal_features jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_name_uniq ON customers (lower(customer_name)) WHERE status = 'ACTIVE';
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- VENDORS — fuel pumps, spares suppliers, mechanics.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  vendor_name     text NOT NULL,
  vendor_type     text,                    -- 'Fuel Pump' | 'Spares' | ...
  contact_person  text,
  mobile_no       text,
  address         text,
  gst_no          citext,
  bank_account    text,
  ifsc_code       text,
  opening_balance numeric(14,2) DEFAULT 0,
  current_balance numeric(14,2) DEFAULT 0,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_type_idx ON vendors (vendor_type) WHERE status = 'ACTIVE';
CREATE TRIGGER vendors_touch BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- RTKM_MASTER — the commercial model of a lane (one row = one depot→consignee
-- route with its fixed HSD/cash/toll terms). TRIPURA SUNDARI's cost floor and
-- CHHINNAMASTA's mileage band both derive from this table.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE rtkm_master (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id           text UNIQUE,
  customer_name       text NOT NULL,
  registered_assessee text,
  depot_link          text,
  consignee_id        text,
  consignee_name      text NOT NULL,
  vehicle_capacity    text,                -- '40 KL (18 Wheeler)' — matched verbatim by the rate engine
  item_type           text,                -- 'ATF (Aviation)' | 'HSD' | ...
  rtkm_distance       numeric(10,3),
  fixed_hsd_qty       numeric(10,3),
  fixed_cash_amt      numeric(12,2),
  toll_amt            numeric(12,2),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rtkm_lane_idx ON rtkm_master (customer_name, consignee_name) WHERE status = 'ACTIVE';
CREATE TRIGGER rtkm_touch BEFORE UPDATE ON rtkm_master FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RATE_MASTER — per-customer rate cards (module exists in the UI; collection
-- was empty in the snapshot, so the table starts empty but must exist for
-- TRIPURA SUNDARI to go ACTIVE).
CREATE TABLE rate_master (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  customer_name text NOT NULL,
  route         text,
  rate_type     text,
  rate          numeric(12,2),
  unit          text,
  valid_from    date,
  valid_to      date,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rate_master_touch BEFORE UPDATE ON rate_master FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIPS — the dispatch ledger. One row per load, cradle to settlement.
--
-- The Firestore data carried the same fact under three spellings
-- (Vehical_No / Vehicle_No / vehicle_no); the loader coalesces them and this
-- table is the single spelling from here on.
--
-- vehicle_id/driver_id/customer_id are nullable FKs: market (hired) vehicles
-- and one-off customers legitimately have no master row. The raw text names
-- are kept alongside so no information is lost when resolution fails.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE trips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  trip_code       text,                    -- 'PT00263' style human id
  operating_company text,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','LOADED','IN_TRANSIT','UNLOADING','COMPLETED','SETTLED','CANCELLED')),

  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   text,
  registered_assessee text,
  consignee_name  text,

  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_no      text,
  driver_id       uuid REFERENCES drivers(id) ON DELETE SET NULL,
  driver_name     text,
  driver_mobile   text,

  loading_date    date,
  loading_point   text,
  challan_no      text,
  product_type    text,
  loaded_qty      numeric(12,3),
  rtkm            numeric(10,3),
  rate            numeric(12,4),
  freight_amount  numeric(14,2),           -- as billed; TARA settles from this

  unloading_date  date,
  unloading_location text,
  unloaded_qty    numeric(12,3),
  shortage_qty    numeric(12,3),
  shortage_penalty numeric(12,2),
  unloading_remarks text,

  fixed_cash      numeric(12,2),
  fixed_hsd       numeric(10,3),
  hsd_issued      numeric(10,3),
  pump_cash_advance numeric(12,2),
  office_cash_paid  numeric(12,2),
  bank_paid       numeric(12,2),
  total_expense   numeric(14,2),
  final_balance   numeric(14,2),

  office_approved_loading   boolean,
  office_approved_unloading boolean,
  invoice_url     text,
  remarks         text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trips_status_idx   ON trips (status);
CREATE INDEX trips_vehicle_idx  ON trips (vehicle_no, loading_date DESC);
CREATE INDEX trips_customer_idx ON trips (customer_name, loading_date DESC);
CREATE INDEX trips_loading_date_idx ON trips (loading_date DESC);
CREATE UNIQUE INDEX trips_code_uniq ON trips (trip_code) WHERE trip_code IS NOT NULL;
CREATE TRIGGER trips_touch BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- FUEL_ENTRIES — HSD issues per vehicle/trip (CHHINNAMASTA's domain).
-- (vendor_id, memo_no) duplicate protection is the agent's guard rather than a
-- unique index: the legacy data may already carry duplicates, and refusing to
-- load history would be worse than policing new entries at the gate.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE fuel_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  entry_date    date,
  vehicle_id    uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_no    text,
  trip_id       uuid REFERENCES trips(id) ON DELETE SET NULL,
  trip_legacy_id text,
  route_name    text,
  driver_name   text,
  vendor_id     uuid REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name   text,
  memo_no       text,
  fuel_type     text,
  liters        numeric(10,3),
  rate          numeric(10,4),
  amount        numeric(14,2),
  cash_given_to_pump numeric(12,2),
  pump_mobile   text,
  bill_status   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_vehicle_idx ON fuel_entries (vehicle_no, entry_date DESC);
CREATE INDEX fuel_trip_idx    ON fuel_entries (trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX fuel_vendor_memo_idx ON fuel_entries (vendor_id, memo_no);
CREATE INDEX fuel_rate_latest_idx ON fuel_entries (entry_date DESC) WHERE rate > 0;
CREATE TRIGGER fuel_touch BEFORE UPDATE ON fuel_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- DRIVER_TRANSACTIONS — advances and recoveries per driver.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE driver_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id    text UNIQUE,
  driver_id    uuid REFERENCES drivers(id) ON DELETE SET NULL,
  driver_name  text NOT NULL,
  txn_date     date,
  txn_type     text,                       -- 'ADVANCE_GIVEN' | 'RECOVERY' | ...
  amount       numeric(12,2),
  mode         text,
  remarks      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_txn_idx ON driver_transactions (driver_name, txn_date DESC);

COMMIT;
