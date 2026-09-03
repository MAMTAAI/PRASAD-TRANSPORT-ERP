-- 138_access_hub_market_vehicle.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- A TRUCK IS A PARTY THE OFFICE CAN TURN OFF (owner, 2026-09-03)
--
--   "Add a clear Active / Deactivate switch in the Admin Dashboard for both the
--    Fleet Partner account and their individual vehicles. A partner/vehicle
--    cannot be used in the system if marked deactivated."
--
-- The partner half already existed — FLEET_PARTNER is an Access Hub kind. The
-- vehicle half is added in access.routes as MARKET_VEHICLE, mapping onto
-- market_vehicles.system_status, which every dispatch path already checks for
-- 'System Active'. The audit table's own CHECK did not know the new kind, so
-- the first switch flip failed the transaction it was recording: the truck kept
-- its state and the office got a 500. One name added, and the trail works.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE access_hub_audit DROP CONSTRAINT IF EXISTS access_hub_audit_kind_check;
ALTER TABLE access_hub_audit
  ADD CONSTRAINT access_hub_audit_kind_check
  CHECK (kind IN ('CUSTOMER', 'FLEET_PARTNER', 'SERVICE_VENDOR', 'DRIVER',
                  'MARKET_DRIVER', 'MARKET_VEHICLE'));

COMMIT;
