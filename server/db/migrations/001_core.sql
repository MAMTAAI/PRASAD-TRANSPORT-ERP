-- ═══════════════════════════════════════════════════════════════════════════
-- 001_core.sql — Prasad Transport ERP · core master data
--
-- Scope: companies · users · vehicles · drivers · vehicle_assignments
-- Dispatch (trips) and the double-entry ledger land in 002 and 003; they FK
-- into these tables, so this migration must run first.
--
-- Two rules this schema enforces that the previous document store could not:
--   1. One spelling per fact. The old data carried `Vehical_No` (typo),
--      `Vehicle_No`, and `vehicle_no` as three separate fields for one truth.
--      Here it is one column, and `vehicle_no_norm` makes duplicate
--      registrations ("AS 19C 8666" vs "AS19C8666") impossible to insert.
--   2. Referential integrity. A driver assignment cannot point at a vehicle
--      that does not exist.
--
-- Every table keeps `legacy_id` — the old document ID — so the data migration
-- is idempotent (re-runnable via ON CONFLICT) and every row stays traceable
-- back to its source record during the parallel-run period.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Extensions ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email / GSTIN
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy driver/vehicle name search

-- ── Shared trigger: keep updated_at honest ─────────────────────────────────
-- Application code forgets to set this; the database never does.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

-- ── Normaliser for registration / licence numbers ──────────────────────────
-- 'as 19c-8666' -> 'AS19C8666'. IMMUTABLE so it can back a generated column.
CREATE OR REPLACE FUNCTION norm_reg(txt text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT upper(regexp_replace(txt, '[^A-Za-z0-9]', '', 'g'));
$fn$;

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE approval_status  AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE record_status    AS ENUM ('ACTIVE', 'INACTIVE', 'BLACKLISTED', 'ARCHIVED');
CREATE TYPE user_role        AS ENUM ('SUPER_ADMIN', 'ADMIN', 'ACCOUNTS', 'DISPATCH', 'DRIVER', 'CUSTOMER', 'VIEWER');
CREATE TYPE vehicle_kind     AS ENUM ('TANKER', 'TRUCK', 'TRAILER', 'TIPPER', 'CONTAINER', 'OTHER');
CREATE TYPE ownership_kind   AS ENUM ('OWNED', 'ATTACHED', 'LEASED');
CREATE TYPE assignment_state AS ENUM ('ACTIVE', 'ENDED');

-- ═══════════════════════════════════════════════════════════════════════════
-- COMPANIES — operating entities. Trips, ledgers and invoices are scoped to
-- one of these; this is the tenant boundary for the whole ERP.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  company_name  text NOT NULL,
  tagline       text,
  gstin         citext,
  pan_no        citext,
  tds_tan       text,
  email         citext,
  phone         text,
  address       text,
  city          text,
  state         text,
  pincode       text,
  bank_name     text,
  account_no    text,
  ifsc_code     text,
  logo_url      text,
  gst_pdf_url   text,
  pan_pdf_url   text,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- 15-char GSTIN validated at the storage layer, so a malformed number can
  -- never reach a printed invoice. NULL stays legal for records mid-onboarding.
  CONSTRAINT companies_gstin_format
    CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}$'),
  CONSTRAINT companies_pan_format
    CHECK (pan_no IS NULL OR pan_no ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);
CREATE UNIQUE INDEX companies_name_uniq  ON companies (lower(company_name));
CREATE UNIQUE INDEX companies_gstin_uniq ON companies (gstin) WHERE gstin IS NOT NULL;
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- USERS — staff logins and RBAC.
--
-- `password_hash` only. The old store carried a `password` field; this table
-- has no column a plaintext secret could legally occupy.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  company_id    uuid REFERENCES companies(id) ON DELETE RESTRICT,
  full_name     text NOT NULL,
  email         citext,
  mobile        text,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'VIEWER',
  -- Per-user grants layered on top of the role. jsonb rather than a join
  -- table because the UI reads the whole grant set at once and never asks
  -- "who holds permission X" — this mirrors how the app already uses it.
  permissions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope         text,
  branch        text,
  city          text,
  state         text,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A login needs at least one identifier to log in with.
  CONSTRAINT users_need_an_identifier CHECK (email IS NOT NULL OR mobile IS NOT NULL),
  CONSTRAINT users_mobile_format CHECK (mobile IS NULL OR mobile ~ '^[0-9]{10}$'),
  CONSTRAINT users_permissions_is_object CHECK (jsonb_typeof(permissions) = 'object')
);
-- Partial uniqueness: an archived user must not block a rehire reusing the
-- same email, but two ACTIVE users can never share one.
CREATE UNIQUE INDEX users_email_active_uniq  ON users (email)  WHERE status = 'ACTIVE' AND email  IS NOT NULL;
CREATE UNIQUE INDEX users_mobile_active_uniq ON users (mobile) WHERE status = 'ACTIVE' AND mobile IS NOT NULL;
CREATE INDEX users_company_idx ON users (company_id, status);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- VEHICLES — the fleet master.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  company_id      uuid REFERENCES companies(id) ON DELETE RESTRICT,

  vehicle_no      text NOT NULL,
  -- Canonical form, maintained by the database. The unique index below is what
  -- finally makes 'AS 19C 8666' and 'AS19C8666' the same vehicle.
  vehicle_no_norm text GENERATED ALWAYS AS (norm_reg(vehicle_no)) STORED,

  vehicle_type    vehicle_kind   NOT NULL DEFAULT 'TANKER',
  ownership       ownership_kind NOT NULL DEFAULT 'OWNED',
  owner_name      text,
  make_model      text,
  chassis_no      text,
  engine_no       text,

  -- Tanker capacity in kilolitres; payload in metric tonnes.
  capacity_kl     numeric(10,3) CHECK (capacity_kl IS NULL OR capacity_kl > 0),
  payload_mt      numeric(10,3) CHECK (payload_mt  IS NULL OR payload_mt  > 0),
  axle_count      smallint CHECK (axle_count IS NULL OR axle_count BETWEEN 2 AND 12),
  tyre_count      smallint CHECK (tyre_count IS NULL OR tyre_count BETWEEN 4 AND 22),

  -- Compliance dates, stored as DATE rather than text so "which vehicles
  -- expire in the next 30 days" is an indexed range scan instead of a
  -- client-side loop over every document — a query the old store could not do.
  registration_date      date,
  insurance_expiry       date,
  fitness_expiry         date,
  permit_expiry          date,
  puc_expiry             date,
  tax_expiry             date,
  national_permit_expiry date,

  rc_photo_url      text,
  insurance_doc_url text,
  fitness_doc_url   text,
  permit_doc_url    text,

  fastag_id       text,
  gps_imei        text,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicles_no_not_blank CHECK (btrim(vehicle_no) <> '')
);
CREATE UNIQUE INDEX vehicles_no_norm_uniq       ON vehicles (vehicle_no_norm);
CREATE INDEX        vehicles_company_status_idx ON vehicles (company_id, status);
CREATE INDEX        vehicles_type_idx           ON vehicles (vehicle_type) WHERE status = 'ACTIVE';
-- Backs the compliance-expiry dashboard: one index scan per document type.
CREATE INDEX vehicles_insurance_expiry_idx ON vehicles (insurance_expiry) WHERE status = 'ACTIVE';
CREATE INDEX vehicles_fitness_expiry_idx   ON vehicles (fitness_expiry)   WHERE status = 'ACTIVE';
CREATE INDEX vehicles_permit_expiry_idx    ON vehicles (permit_expiry)    WHERE status = 'ACTIVE';
CREATE INDEX vehicles_puc_expiry_idx       ON vehicles (puc_expiry)       WHERE status = 'ACTIVE';
CREATE TRIGGER vehicles_touch BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- DRIVERS — driver master with KYC, licence and payout details.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE drivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  company_id      uuid REFERENCES companies(id) ON DELETE RESTRICT,
  -- Set when a driver also gets a portal login.
  user_id         uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,

  name            text NOT NULL,
  mobile          text NOT NULL,
  alt_mobile      text,
  address         text,
  profile_pic_url text,

  license_no      text NOT NULL,
  license_no_norm text GENERATED ALWAYS AS (norm_reg(license_no)) STORED,
  license_expiry  date,
  dl_photo_url    text,

  -- Hazardous-goods endorsement — mandatory before a driver can be dispatched
  -- on a petroleum tanker load. Dispatch validates against these two columns.
  hzd_cert_no     text,
  hzd_expiry      date,
  hzd_photo_url   text,

  aadhar_no        text,
  aadhar_photo_url text,
  pan_no           citext,
  pan_photo_url    text,

  bank_name       text,
  account_no      text,
  ifsc_code       text,
  bank_photo_url  text,

  guarantor_name   text,
  guarantor_mobile text,

  join_date       date,
  approval_status approval_status NOT NULL DEFAULT 'PENDING',
  status          record_status   NOT NULL DEFAULT 'ACTIVE',
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT drivers_mobile_format     CHECK (mobile ~ '^[0-9]{10}$'),
  CONSTRAINT drivers_alt_mobile_format CHECK (alt_mobile IS NULL OR alt_mobile ~ '^[0-9]{10}$'),
  CONSTRAINT drivers_aadhar_format     CHECK (aadhar_no  IS NULL OR aadhar_no  ~ '^[0-9]{12}$'),
  CONSTRAINT drivers_pan_format        CHECK (pan_no     IS NULL OR pan_no     ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  CONSTRAINT drivers_ifsc_format       CHECK (ifsc_code  IS NULL OR ifsc_code  ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  -- A hazardous certificate number without an expiry date is unverifiable.
  CONSTRAINT drivers_hzd_needs_expiry
    CHECK (hzd_cert_no IS NULL OR btrim(hzd_cert_no) = '' OR hzd_expiry IS NOT NULL)
);
CREATE UNIQUE INDEX drivers_license_uniq       ON drivers (license_no_norm) WHERE status <> 'ARCHIVED';
CREATE UNIQUE INDEX drivers_mobile_active_uniq ON drivers (mobile)          WHERE status = 'ACTIVE';
CREATE INDEX drivers_company_status_idx ON drivers (company_id, status);
CREATE INDEX drivers_approval_idx       ON drivers (approval_status) WHERE approval_status = 'PENDING';
CREATE INDEX drivers_license_expiry_idx ON drivers (license_expiry)  WHERE status = 'ACTIVE';
CREATE INDEX drivers_hzd_expiry_idx     ON drivers (hzd_expiry)      WHERE status = 'ACTIVE';
-- Driver-by-name is the most common dispatch search, and the old data is full
-- of near-miss spellings; trigram index makes fuzzy match cheap.
CREATE INDEX drivers_name_trgm_idx ON drivers USING gin (name gin_trgm_ops);
CREATE TRIGGER drivers_touch BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- VEHICLE_ASSIGNMENTS — which driver is on which vehicle, over time.
--
-- A history table rather than a column on `vehicles`, so past custody stays
-- auditable: "who was driving AS19C8666 on 12 Aug" must have an answer.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE vehicle_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id   text UNIQUE,
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  driver_id   uuid NOT NULL REFERENCES drivers(id)  ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  state       assignment_state NOT NULL DEFAULT 'ACTIVE',
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  remarks     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assignment_release_after_assign
    CHECK (released_at IS NULL OR released_at >= assigned_at),
  -- ACTIVE means still held, ENDED means released. The two must agree.
  CONSTRAINT assignment_state_matches_release
    CHECK ((state = 'ACTIVE' AND released_at IS NULL)
        OR (state = 'ENDED'  AND released_at IS NOT NULL))
);
-- One live driver per vehicle, and one live vehicle per driver — enforced by
-- the database rather than by hoping the UI checked first.
CREATE UNIQUE INDEX assignment_one_active_per_vehicle
  ON vehicle_assignments (vehicle_id) WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX assignment_one_active_per_driver
  ON vehicle_assignments (driver_id)  WHERE state = 'ACTIVE';
CREATE INDEX assignment_vehicle_history_idx ON vehicle_assignments (vehicle_id, assigned_at DESC);
CREATE INDEX assignment_driver_history_idx  ON vehicle_assignments (driver_id,  assigned_at DESC);
CREATE TRIGGER vehicle_assignments_touch BEFORE UPDATE ON vehicle_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Convenience view: the fleet as dispatch sees it ────────────────────────
CREATE VIEW v_fleet_current AS
SELECT v.id         AS vehicle_id,
       v.vehicle_no,
       v.vehicle_type,
       v.capacity_kl,
       v.status     AS vehicle_status,
       d.id         AS driver_id,
       d.name       AS driver_name,
       d.mobile     AS driver_mobile,
       d.license_expiry,
       d.hzd_expiry,
       a.assigned_at,
       LEAST(v.insurance_expiry, v.fitness_expiry, v.permit_expiry, v.puc_expiry)
                    AS next_compliance_due
FROM vehicles v
LEFT JOIN vehicle_assignments a ON a.vehicle_id = v.id AND a.state = 'ACTIVE'
LEFT JOIN drivers d             ON d.id = a.driver_id
WHERE v.status = 'ACTIVE';

COMMIT;
