-- ═══════════════════════════════════════════════════════════════════════════
-- 109_driver_login_links.sql — one-tap driver sign-in, no OTP to type
--
-- THE PROBLEM IS NOT THE APP, IT IS THE DOOR. Everything behind driver login
-- already works: DriverPortal captures GPS and posts it, POST /tracking/ping
-- inserts and broadcasts, LiveFleetMap draws it. And on 28-08 the fleet board
-- read "0 / 100 on map" with trip_gps_pings holding ZERO rows since the day it
-- was created, because auth_sessions has never held a single driver_id. 54
-- drivers with a mobile on file, not one login, ever.
--
-- The only door was /auth/otp/request: a six-digit code over WhatsApp that the
-- driver then types. Every step of that is a place a driver stops — the code
-- arrives in a chat he has to leave, it expires, he mistypes it, or WhatsApp
-- itself is unlinked (which it was, for a week, this month).
--
-- A LINK IS A CREDENTIAL, SO IT IS STORED LIKE ONE. Only the SHA-256 of the
-- token is kept. A leaked database backup then yields no working links, which
-- is the same reason auth_otp stores a hash and not the code.
--
-- SINGLE USE AND SHORT LIVED. consumed_at is set inside the same UPDATE that
-- claims it, so two taps on the same WhatsApp message cannot both open a
-- session. Expiry is set by the caller — a link minted when a trip is created
-- is useless a week later, and the driver can always ask for another.
--
-- trip_id IS OPTIONAL AND IS NOT AUTHORISATION. It records which dispatch the
-- link was sent for so the app can open on the right duty screen. The session
-- it issues belongs to the DRIVER, not to that trip.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS driver_login_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  trip_id     uuid REFERENCES trips(id) ON DELETE SET NULL,
  token_hash  text NOT NULL UNIQUE,
  sent_to     text,
  created_by  text,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- "Has this driver got a live link already" — asked before minting a second
-- one, so a dispatcher pressing send twice does not paper the driver's chat.
CREATE INDEX IF NOT EXISTS idx_driver_login_links_driver
  ON driver_login_links (driver_id, created_at DESC);

-- The claim path looks up by hash and nothing else.
CREATE INDEX IF NOT EXISTS idx_driver_login_links_live
  ON driver_login_links (token_hash) WHERE consumed_at IS NULL;

COMMIT;
