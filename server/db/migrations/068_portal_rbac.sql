-- ═══════════════════════════════════════════════════════════════════════════
-- 068_portal_rbac.sql — one gate, and a matrix the admin actually controls
--
-- WHAT ALREADY EXISTED, AND IS REUSED RATHER THAN DUPLICATED.
--   customers.portal_enabled / vendors.portal_access — per-party on/off
--   customers.portal_features / vendors.portal_features (jsonb) — per-party
--     feature map, already populated on live rows
--   users.role + customer_id/vendor_id — the scoping the portal routes enforce
--
-- What was missing is the ROLE layer: a way for an admin to say "no VENDOR sees
-- ledgers", once, instead of editing every vendor's json. So visibility is now
-- three things ANDed together, and the order matters:
--
--   1. is_approved_for_portal   the gate. Off by default. Nothing loads.
--   2. portal_role_access       the admin's role-wide matrix.
--   3. portal_features          the per-party exception, when one is needed.
--
-- ANDed, never ORed. A per-party feature flag cannot re-open something the role
-- matrix closed — otherwise "no VENDOR sees ledgers" would be a suggestion that
-- any stale json on one vendor row quietly overrides.
--
-- WHY A NEW FLAG WHEN TWO ALREADY EXIST. customers.portal_enabled and
-- vendors.portal_access mean the same thing under different names, on different
-- tables, and drivers have neither. Gating has to be answerable in ONE place or
-- it is not enforceable. The new column is authoritative; the old ones are kept
-- in step by trigger, in both directions, so no existing screen silently
-- disagrees with the gate and nobody has to remember which one to write.
--
-- DEFAULT DENY. is_approved_for_portal defaults FALSE, and the backfill turns it
-- on only where the old flag was already on. A party that was never enabled
-- stays dark.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. THE GATE ────────────────────────────────────────────────────────────

ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_approved_for_portal boolean NOT NULL DEFAULT false;
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS is_approved_for_portal boolean NOT NULL DEFAULT false;
ALTER TABLE drivers   ADD COLUMN IF NOT EXISTS is_approved_for_portal boolean NOT NULL DEFAULT false;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_approved_by uuid;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_approved_at timestamptz;
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS portal_approved_by uuid;
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS portal_approved_at timestamptz;
ALTER TABLE drivers   ADD COLUMN IF NOT EXISTS portal_approved_by uuid;
ALTER TABLE drivers   ADD COLUMN IF NOT EXISTS portal_approved_at timestamptz;

UPDATE customers SET is_approved_for_portal = true,
                     portal_approved_at = COALESCE(portal_approved_at, now())
 WHERE portal_enabled AND NOT is_approved_for_portal;
UPDATE vendors   SET is_approved_for_portal = true,
                     portal_approved_at = COALESCE(portal_approved_at, now())
 WHERE portal_access AND NOT is_approved_for_portal;
-- Drivers had no flag at all, so none are opened here. An approved KYC is not
-- the same decision as "may read live dispatch data from a phone".

-- Keep the legacy names in step so a screen still writing portal_enabled does
-- not silently diverge from the gate the API reads.
CREATE OR REPLACE FUNCTION sync_portal_flag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legacy_col text;
BEGIN
  legacy_col := CASE TG_TABLE_NAME WHEN 'customers' THEN 'portal_enabled'
                                   WHEN 'vendors'   THEN 'portal_access' END;
  IF legacy_col IS NULL THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'customers' THEN
    IF NEW.is_approved_for_portal IS DISTINCT FROM OLD.is_approved_for_portal THEN
      NEW.portal_enabled := NEW.is_approved_for_portal;
    ELSIF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
      NEW.is_approved_for_portal := NEW.portal_enabled;
    END IF;
  ELSE
    IF NEW.is_approved_for_portal IS DISTINCT FROM OLD.is_approved_for_portal THEN
      NEW.portal_access := NEW.is_approved_for_portal;
    ELSIF NEW.portal_access IS DISTINCT FROM OLD.portal_access THEN
      NEW.is_approved_for_portal := NEW.portal_access;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS customers_portal_flag_sync ON customers;
CREATE TRIGGER customers_portal_flag_sync BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION sync_portal_flag();
DROP TRIGGER IF EXISTS vendors_portal_flag_sync ON vendors;
CREATE TRIGGER vendors_portal_flag_sync BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION sync_portal_flag();

-- ── 2. THE CATALOGUE ───────────────────────────────────────────────────────
-- Modules are DATA, not an enum. Adding a page to the driver app should not
-- need a migration, and an admin screen has to be able to list what exists.

CREATE TABLE IF NOT EXISTS portal_modules (
  module_key   text PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('CUSTOMER','VENDOR','DRIVER')),
  label        text NOT NULL,
  description  text,
  -- NULL parent = a page. A non-null parent makes this a FIELD within a page,
  -- which is what "toggle visibility for specific data fields" needs.
  parent_key   text REFERENCES portal_modules(module_key) ON DELETE CASCADE,
  sensitive    boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_modules_role_idx ON portal_modules (role, sort_order);

INSERT INTO portal_modules (module_key, role, label, description, parent_key, sensitive, sort_order) VALUES
  -- CUSTOMER
  ('cust.dashboard',    'CUSTOMER','Dashboard',            'Summary cards and counts',            NULL, false, 10),
  ('cust.shipments',    'CUSTOMER','Shipments',            'Live and past consignments',          NULL, false, 20),
  ('cust.tracking',     'CUSTOMER','Live GPS Tracking',    'Map with vehicle positions',          NULL, false, 30),
  ('cust.pods',         'CUSTOMER','Proof of Delivery',    'Download signed PODs',                NULL, false, 40),
  ('cust.ledger',       'CUSTOMER','Ledger & Invoices',    'Outstanding, bills, payments',        NULL, true,  50),
  ('cust.place_order',  'CUSTOMER','Place New Order',      'Raise a booking request',             NULL, false, 60),
  ('cust.shipments.freight','CUSTOMER','  Freight amount', 'Per-trip freight value on shipments', 'cust.shipments', true, 21),
  ('cust.shipments.driver', 'CUSTOMER','  Driver name & phone','Driver contact on the shipment card','cust.shipments', true, 22),
  ('cust.ledger.balance',   'CUSTOMER','  Outstanding balance','Running balance figure',          'cust.ledger',    true, 51),
  -- VENDOR
  ('vend.dashboard',    'VENDOR','Dashboard',              'Summary cards and counts',            NULL, false, 10),
  ('vend.vehicles',     'VENDOR','My Vehicles',            'Market vehicles offered to the fleet',NULL, false, 20),
  ('vend.bills',        'VENDOR','Bills & Payments',       'Submitted bills and their status',    NULL, true,  30),
  ('vend.submit_bill',  'VENDOR','Submit Bill',            'Raise a new bill for approval',       NULL, false, 40),
  ('vend.credit_bill',  'VENDOR','15-Day Credit Bill',     'Fortnightly consolidated credit bill',NULL, false, 50),
  ('vend.bazaar',       'VENDOR','Load Bazaar',            'See broadcast loads and bid',         NULL, false, 60),
  ('vend.bills.rate',   'VENDOR','  Rate breakdown',       'Per-unit rate on a bill line',        'vend.bills',  true, 31),
  ('vend.bazaar.target','VENDOR','  Target price',         'The rate the office is aiming for',   'vend.bazaar', true, 61),
  -- DRIVER
  ('drv.dashboard',     'DRIVER','Dashboard',              'Today at a glance',                   NULL, false, 10),
  ('drv.trips',         'DRIVER','My Trips',               'Assigned and running trips',          NULL, false, 20),
  ('drv.route',         'DRIVER','Route Map',              'Loading to unloading navigation',     NULL, false, 30),
  ('drv.upload_pod',    'DRIVER','Upload POD',             'Photograph the signed POD',           NULL, false, 40),
  ('drv.upload_toll',   'DRIVER','Upload Toll Slip',       'Photograph a toll receipt',           NULL, false, 50),
  ('drv.upload_fuel',   'DRIVER','Upload Fuel Slip',       'Photograph a fuel memo',              NULL, false, 60),
  ('drv.khata',         'DRIVER','My Khata',               'Advances, recoveries, balance',       NULL, true,  70),
  ('drv.trips.freight', 'DRIVER','  Trip freight value',   'What the load bills for',             'drv.trips', true, 21),
  ('drv.khata.balance', 'DRIVER','  Running balance',      'Net owed to or by the driver',        'drv.khata', true, 71)
ON CONFLICT (module_key) DO NOTHING;

-- ── 3. THE MATRIX ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS portal_role_access (
  role         text NOT NULL CHECK (role IN ('CUSTOMER','VENDOR','DRIVER')),
  module_key   text NOT NULL REFERENCES portal_modules(module_key) ON DELETE CASCADE,
  is_visible   boolean NOT NULL DEFAULT false,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, module_key)
);

-- Seeded CLOSED for anything marked sensitive and open for the rest, so the
-- starting position is a working portal that shows no money. An admin opening
-- a ledger is then a decision somebody made, with their id against it.
INSERT INTO portal_role_access (role, module_key, is_visible)
SELECT m.role, m.module_key, NOT m.sensitive FROM portal_modules m
ON CONFLICT (role, module_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS portal_access_audit (
  id          bigserial PRIMARY KEY,
  role        text NOT NULL,
  module_key  text NOT NULL,
  was_visible boolean,
  now_visible boolean NOT NULL,
  actor_id    uuid,
  actor_name  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_access_audit_idx ON portal_access_audit (role, created_at DESC);

-- ── 4. THE ANSWER, IN ONE PLACE ────────────────────────────────────────────
-- Every portal route asks this rather than re-deriving the rule. A view means
-- the admin screen and the enforcement cannot drift.

CREATE OR REPLACE VIEW v_portal_role_matrix AS
  SELECT m.role, m.module_key, m.label, m.description, m.parent_key,
         m.sensitive, m.sort_order,
         COALESCE(a.is_visible, false) AS is_visible,
         a.updated_at, a.updated_by
    FROM portal_modules m
    LEFT JOIN portal_role_access a ON a.role = m.role AND a.module_key = m.module_key;

COMMENT ON VIEW v_portal_role_matrix IS
  'Role-level portal visibility. ANDed with the party gate and portal_features at request time.';

COMMIT;
