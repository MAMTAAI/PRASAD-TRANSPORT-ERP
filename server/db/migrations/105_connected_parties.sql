-- 105_connected_parties.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- "Who is connected to us right now, and what are they doing?"
--
-- The pieces to answer that already existed and had never been joined up:
--   auth_sessions   carries last_seen_at and, by CHECK, exactly one owner —
--                   a user_id OR a driver_id.
--   users           links a portal login to its party: customer_id, vendor_id.
--   drivers         is the party for a DRIVER session; drivers are deliberately
--                   NOT users rows (migration 046).
--   trip_gps_pings  is where the driver app's fixes land.
--
-- v_user_sessions already resolved a NAME. It could not answer WHICH: a session
-- showed "CUSTOMER — INDIAN OIL CORPORATION LTD" only because that user's
-- full_name happened to repeat the company. A VENDOR login shows the person,
-- and nothing said which firm they speak for. On a board whose whole purpose is
-- "who is that", a name without its organisation is the question restated.
--
-- WHAT THIS VIEW ADDS
--   party_kind / party_id / party_name  the real-world identity behind the login
--   app                                 which application they are holding
--   activity                            what they are busy with right now
--   last_lat / last_lng / fix_age_s     where they were when last heard from
--
-- THE APP IS DERIVED FROM THE ROLE, NOT THE USER AGENT. A user agent is a
-- self-reported string; the role is what the server enforces on every request.
-- Reading the app from the UA would let a phone claim to be the dispatch desk.
--
-- POSITION IS ONLY EVER THE DRIVER APP'S. trip_gps_pings is written by the
-- driver device and by nothing else, and gpsEmitter.ts refuses to post the
-- simulated NH-27 fallback. So a coordinate here is a real one. A customer or a
-- partner has no position and must show as blank rather than as the office.
--
-- ONLINE IS A CLAIM WITH A TIMESTAMP, kept identical to v_user_sessions' five
-- minutes so the two boards cannot disagree about who is on.

BEGIN;

CREATE OR REPLACE VIEW v_connected_parties AS
WITH live AS (
  SELECT s.jti, s.user_id, s.driver_id, s.ip, s.user_agent,
         s.issued_at, s.last_seen_at, s.expires_at
    FROM auth_sessions s
   WHERE s.expires_at > now()
),
-- The driver's current load. IN_TRANSIT is the only open state trips reaches in
-- this database; COMPLETED is done and must not read as "busy now".
active_trip AS (
  SELECT DISTINCT ON (t.driver_id)
         t.driver_id, t.id AS trip_id, t.trip_code, t.vehicle_no,
         t.loading_point, t.unloading_location, t.loading_date, t.status
    FROM trips t
   WHERE t.driver_id IS NOT NULL
     AND t.status = 'IN_TRANSIT'
   ORDER BY t.driver_id, t.loading_date DESC NULLS LAST
),
last_fix AS (
  SELECT DISTINCT ON (g.trip_id)
         g.trip_id, g.lat, g.lng, g.speed_kmh, g.recorded_at
    FROM trip_gps_pings g
   ORDER BY g.trip_id, g.recorded_at DESC
)
SELECT
  l.jti,
  l.user_id,
  l.driver_id,

  -- ── identity ────────────────────────────────────────────────────────────
  CASE
    WHEN l.driver_id IS NOT NULL      THEN 'DRIVER'
    WHEN u.customer_id IS NOT NULL    THEN 'CUSTOMER'
    WHEN u.vendor_id  IS NOT NULL     THEN 'PARTNER'
    WHEN u.id IS NOT NULL             THEN 'STAFF'
    ELSE 'UNKNOWN'
  END                                                   AS party_kind,
  COALESCE(d.id::text, c.id::text, v.id::text, u.id::text) AS party_id,
  -- The ORGANISATION where there is one, else the person. This is the column
  -- the old view could not produce.
  COALESCE(c.customer_name, v.vendor_name, d.name, u.full_name, 'unknown')
                                                        AS party_name,
  -- Who actually holds the phone, when that differs from the org.
  COALESCE(u.full_name, d.name)                         AS person_name,
  COALESCE(d.mobile, u.mobile)                          AS mobile,
  COALESCE(u.role::text,
           CASE WHEN l.driver_id IS NOT NULL THEN 'DRIVER' END,
           'UNKNOWN')                                   AS role,

  -- ── which application ───────────────────────────────────────────────────
  CASE
    WHEN l.driver_id IS NOT NULL   THEN 'Driver App'
    WHEN u.role = 'CUSTOMER'       THEN 'Customer App'
    WHEN u.role = 'VENDOR'         THEN 'Fleet Partner App'
    WHEN u.role IS NOT NULL        THEN 'Staff Console'
    ELSE 'Unknown'
  END                                                   AS app,
  CASE WHEN l.user_agent ~* 'Android|iPhone|iPad|Mobile' THEN 'mobile' ELSE 'desktop' END
                                                        AS device,

  -- ── presence ────────────────────────────────────────────────────────────
  l.ip,
  l.issued_at                                           AS signed_in_at,
  l.last_seen_at,
  (l.last_seen_at > now() - interval '5 minutes')        AS is_online,
  EXTRACT(EPOCH FROM (now() - l.last_seen_at))::int      AS idle_seconds,

  -- ── what they are busy with ─────────────────────────────────────────────
  at.trip_id,
  at.trip_code,
  at.vehicle_no,
  at.loading_point,
  at.unloading_location,
  CASE
    WHEN at.trip_code IS NOT NULL
      THEN 'On trip ' || at.trip_code || ' (' || COALESCE(at.vehicle_no, 'no vehicle') || ')'
    WHEN l.driver_id IS NOT NULL THEN 'No open trip'
    ELSE NULL
  END                                                   AS activity,

  -- ── last known position (driver app only) ───────────────────────────────
  f.lat                                                 AS last_lat,
  f.lng                                                 AS last_lng,
  f.speed_kmh                                           AS last_speed_kmh,
  f.recorded_at                                         AS last_fix_at,
  CASE WHEN f.recorded_at IS NOT NULL
       THEN EXTRACT(EPOCH FROM (now() - f.recorded_at))::int END
                                                        AS fix_age_seconds
FROM live l
LEFT JOIN users     u  ON u.id = l.user_id
LEFT JOIN drivers   d  ON d.id = l.driver_id
LEFT JOIN customers c  ON c.id = u.customer_id
LEFT JOIN vendors   v  ON v.id = u.vendor_id
LEFT JOIN active_trip at ON at.driver_id = l.driver_id
LEFT JOIN last_fix    f  ON f.trip_id    = at.trip_id;

COMMENT ON VIEW v_connected_parties IS
  'One row per LIVE session, resolved to the real-world party behind it (driver / customer / partner / staff), which app it is, what it is busy with, and its last real GPS fix. Admin-only: it names people and places them.';

-- ── who COULD connect, and never has ───────────────────────────────────────
-- A presence board that lists only the connected cannot answer the question the
-- owner actually asked, which is who is reachable. 54 drivers can sign in with
-- their mobile and not one ever has, so the driver app reads as "nobody works
-- here" rather than "nobody has been onboarded". That distinction is the whole
-- point of the number.
CREATE OR REPLACE VIEW v_portal_reach AS
SELECT 'DRIVER'::text AS party_kind,
       count(*)::int                                                   AS eligible,
       count(*) FILTER (WHERE d.mobile IS NOT NULL
                          AND btrim(d.mobile) <> '')::int              AS can_sign_in,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM auth_sessions s
                                       WHERE s.driver_id = d.id))::int AS ever_signed_in
  FROM drivers d
UNION ALL
SELECT 'CUSTOMER',
       (SELECT count(*)::int FROM customers),
       (SELECT count(*)::int FROM users WHERE customer_id IS NOT NULL AND status = 'ACTIVE'),
       (SELECT count(*)::int FROM users u
         WHERE u.customer_id IS NOT NULL AND u.last_login_at IS NOT NULL)
UNION ALL
SELECT 'PARTNER',
       (SELECT count(*)::int FROM vendors),
       (SELECT count(*)::int FROM users WHERE vendor_id IS NOT NULL AND status = 'ACTIVE'),
       (SELECT count(*)::int FROM users u
         WHERE u.vendor_id IS NOT NULL AND u.last_login_at IS NOT NULL);

COMMENT ON VIEW v_portal_reach IS
  'Per party kind: how many exist, how many have a working way in, how many ever used it. The gap between the last two is the onboarding backlog.';

COMMIT;
