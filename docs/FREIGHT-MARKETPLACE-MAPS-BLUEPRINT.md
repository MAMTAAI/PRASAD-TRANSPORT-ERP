# B2B Freight Marketplace + Driver App — Maps, Geofencing and Schema Blueprint

Prasad Transport ERP · R&D · 2 Sep 2026 · repo @ 429ff14 · no UI code in this document

This is the architecture the owner asked for before functional coding: how the
marketplace, the driver app and the office desk fit together today, what the
Google Maps Platform can and cannot do for a tanker fleet in Assam in 2026, the
PostGIS schema for `market_vehicles`, `live_bids` and `geofence_logs`, and the
API surface the mobile apps use securely. Everything in section 1 is read from
the code; everything in section 2 is checked against Google's documentation as
of today; section 3 is the proposal.

---

## 1. The ecosystem as it stands, and where the Approval Desk barrier is

### 1.1 Three roles, three doors, one rule

Every external role (DRIVER, VENDOR, CUSTOMER) is confined by `server/lib/apiGuard.js`
to `/api/v1/portal/*`, `/api/v1/files/*`, `/api/v1/maps/*`, `GET /auth/me`,
`POST /auth/logout`, `POST /tracking/ping` and `POST /files`. Everything else
answers `403 OUTSIDE_ROLE_SCOPE`. The rule set on 31 Aug: **an external write
never lands live; it lands PENDING and a staff action promotes it.**

| Role | App | Login | What it writes today | Where it lands | Who promotes |
|---|---|---|---|---|---|
| Vendor (fleet partner) | `src/portal/FleetPartnerApp.tsx` | OTP (WhatsApp) after KYC approval mints a `users` row | bid, withdraw, Book-Now, confirm, assign vehicle+driver, POD, documents, add truck, add driver | `bazaar_bids` PENDING · `bazaar_settlements` state · `partner_documents` PENDING · `market_vehicles` / `market_drivers` `'PENDING APPROVAL'` | Bazaar Admin desk (`/bazaar/market-vehicles/:id/approve`, `/market-drivers/:id/approve|reject`), PendingExpenses "App Uploads" |
| Customer | `src/portal/CustomerApp.tsx` | same | post load, accept bid | `bazaar_loads` `PENDING_REVIEW` · **accept-bid awards in the same transaction** | `POST /bazaar/loads/:id/review` for the load; **nothing for the award** |
| Driver | `src/DriverPortal.tsx` | OTP, one-time link (`driver_login_links`), or vehicle-track (`TRACK_ONLY` scope) | GPS pings, documents, advance/fuel/expense/leave requests, "TRIP UPDATE" requests | `trip_gps_pings` (direct, append-only) · `partner_documents` PENDING · `driver_requests` PENDING | queues desk; trip updates are applied by the office, drivers no longer PATCH `trips` |
| Public | website | none | vendor/customer KYC application | `onboarding_applications` `SUBMITTED` | `/bazaar/onboarding/:id/approve` → party master + portal flag + `users` row in one transaction |

### 1.2 The agents in the loop

| Agent | Declared for this domain | What the handler does today | Gap for this blueprint |
|---|---|---|---|
| 04 BHUVANESHWARI (OCR vault) | subscribes `document.uploaded`, `email.attachment.received`; owns `documents`, `document_extractions`, `email_parsed_bills` | every `POST /files` emits `document.uploaded`; the handler only checks `confidence < 0.85` → `document.review.required`, else `ok`. No extraction is written for KYC. | KYC OCR (RC, DL, Aadhaar last-4, PAN, GST) must produce a `document_extractions` proposal that the desk compares with what the applicant typed. |
| 03 TRIPURA SUNDARI (bazaar + rates) | subscribes `load.posted`, `bid.submitted`, `rate.quote.requested`, `market.vehicle.registered`; owns `rtkm_master`, `rate_master`, `bazaar_loads`, **`bids`**, `market_vehicles` | only `rate.quote.requested` (cost floor from `rtkm_master` + pump HSD + toll, 8 % margin rule) and `fuel.price.changed` are handled; `load.posted` / `bid.submitted` / `market.vehicle.registered` fall to `skipped`. | `owns.tables` names `bids`, a table that does not exist (`bazaar_bids` is real). Bid-time work (rate band, ETA to origin, margin) is unimplemented. |
| 02 TARA (ledger) | `trip.settlement.authorised`, `trip.completed`, …, `invoice.parsed` | settlement posts Debtors/Freight Income in one transaction; bazaar money goes through `postVoucher` with refs `BZDEP-*`, `BZDEPREF-*`, `BZADV-*`, `BZBAL-*`; balance is refused before `POD_VERIFIED` (`bazaarSettlement.routes.js:292`). | Nothing structural. The money barrier already exists and is the model for the rest. |
| 01 KALI (dispatch) | subscribes `trip.gps.ping`; owns `trips`, `trip_gps_pings` | `case 'trip.gps.ping': return ok('gps ping recorded')` — the ping was already inserted by `integrations.routes.js:104` before the event. No geofence, no status change. | The geofence engine lives here. |
| 05 BHAIRAVI (compliance) | `compliance.clearance.requested` | one CROSS JOIN over `vehicles` × `drivers` × `vehicle_assignments`; denies on expired papers, missing hazmat, overload vs `capacity_kl`. | Reads `vehicles` only. A bazaar load assigned to a `market_vehicles` row never gets a clearance check. |

### 1.3 Tracking and maps as they stand

- `trip_gps_pings` (`008`): `trip_id`, `source ∈ DRIVER_APP|GPRS|FASTAG`, `lat`, `lng`, `speed_kmh`, `accuracy_m`, `recorded_at`. **Zero rows ever** — no driver has logged in (WhatsApp OTP was the single channel; SMS fallback is a stub). The whole live map is a proven pipe with nothing in it.
- No PostGIS anywhere; distances are JS haversine or Google Directions.
- Google usage is the **legacy** `maps/api` endpoints (`server/lib/googleMaps.js`: directions, distance matrix, geocode) cached in `maps_cache` (30 days). The **Routes API v2 is not used.** Browser key `VITE_GOOGLE_MAPS_API_KEY` loads Maps JS with `geometry,places`.
- Realtime is **Socket.io** (`server/lib/realtime.js`), one room `fleet`, event `gps:fix`, handshake re-checks `auth_sessions.jti`. Not raw WebSocket, not SSE. `useLiveTracking.ts` has a raw `WebSocket` lane gated on `VITE_TRACKING_WS_URL`, otherwise a mock.
- `/api/v1/maps/*` is reachable by every external role with **no route guard** and a distance-matrix cap of 100 billed pairs per call: an external token can spend Google money.
- FASTag: `fastag_providers` (gtropy), `fastag_accounts`, `toll_transactions` exist. The plaza feed is the fastest way to a populated map, and the statements are ground truth for toll calibration.

### 1.4 Defects found while mapping (fix before anything below)

1. `POST /bazaar/market-vehicles/:id/approve` writes `approved_by`, `approved_at` — **neither column exists on `market_vehicles`** in any migration. The route raises `42703`. `market_drivers` has both.
2. `market_vehicles.system_status` CHECK lacks `'REJECTED'` (drivers have it) and there is no reject route for vehicles.
3. TRIPURA's `owns.tables` lists `bids`; the table is `bazaar_bids`.
4. Customer `accept-bid` and vendor `Book-Now` award the load and open the settlement in the same request. Under the 31-Aug rule that is an external write landing live. Money is still gated (deposit/advance/balance are staff vouchers), but the award itself is not.
5. `/api/v1/maps/*` and `/tracking/ping` carry no `preHandler`; only the global guard.

### 1.5 The barrier, made explicit

Every path from a phone to a business row goes through one of these, and the
blueprint adds no exception:

```
phone ──► /portal/<role>/…  ──► PENDING row (own scope, own file tree up/<role>/<sub>/)
                                     │
                                     ▼
                     Approval Desk  (staff session, 2FA)  ── stamps who/when/reason
                                     │
                                     ▼
                     live row / trips / award / TARA voucher
```

Telemetry is the one lane that is append-only rather than pending: a GPS fix is
evidence, not a decision. It is validated, rate-limited, scoped to the session's
own trip, and can move a trip only through the two safe transitions in §3.4.

---

## 2. Google Maps Platform — what is real for this fleet in 2026

Checked today against Google's own pages.

| Capability | Status | What it means here |
|---|---|---|
| **Routes API `computeRoutes`** (v2) | GA | Replaces the legacy Directions calls. `travelMode: DRIVE`, `routingPreference: TRAFFIC_AWARE_OPTIMAL` (Pro SKU), alternatives, encoded polyline, field masks. |
| **Toll prices** (`extraComputations: ["TOLLS"]`) | GA, billed at a higher rate | Estimated price per route and per leg. `routeModifiers.tollPasses` accepts **`IN_FASTAG`** and `IN_LOCAL_HP_PLATE_EXEMPT`; `vehicleInfo.emissionType: DIESEL`. Toll passes work with `DRIVE` and `TWO_WHEELER` only. Prices are estimates — we calibrate against our own FASTag statements. |
| **Large Vehicle Routing** (`travelMode: TRUCK`, `vehicleInfo.totalHeightMm / totalLengthMm / totalWeightKg`, axles, hazmat) | **Contiguous US only (GA), Japan (experimental), limited-customer access** | **Not available in India.** Truck restrictions must be ours, on PostGIS (§3.2), applied to Google's alternatives. The provider interface keeps the LVR request shape ready so it switches on the day Google opens India. Third-party truck routers with India coverage (HERE, Mappls, NextBillion) plug into the same interface as fallback providers. |
| **Route Matrix** (`computeRouteMatrix`) | GA | Nearest-available-truck ETAs for a posted load: vendor truck positions × load origin. |
| **Roads API `snapToRoads`** | GA | Server-side smoothing of driver pings for the trail (100 points per call). |
| **Maps JavaScript API** — vector map (`mapId`), `AdvancedMarkerElement`, `WebGLOverlayView` | GA | The Fleet Radar. Smooth "Uber-like" motion is a client concern: interpolate between fixes, not more API calls. |
| **Navigation SDK / Driver SDK / Fleet Engine** | GA products; India availability not confirmed in the docs read today | Optional for the driver app's turn-by-turn. Not required for tracking or geofencing. Needs its own Android key restricted by package + SHA-1. |
| **Pricing tiers** | Essentials $5 / Pro $10 per 1,000 (list); free monthly events 10k / 5k / 1k; tolls and two-wheeler/LVR are higher tiers | Order of magnitude for this fleet is in §3.7. India list prices must be read from the console at signup. |

Sources: Routes API LVR overview, Calculate toll fees, RouteModifiers reference
(TollPass enum), Routes API usage and billing, Navigation SDK overview — all
developers.google.com/maps, read 2 Sep 2026.

**Design consequence.** Google gives us: the best road network and live
traffic, an ETA model, toll estimates with FASTag, alternatives, and a smooth
map. Google does not give us, in India: truck legality of a route. So RTKM and
route choice are computed as *Google alternatives filtered by our own
restriction layer*, and every plan records whether it was fully compliant.

---

## 3. The blueprint

### 3.1 PostGIS foundation

Production is PostgreSQL 18.6 on the EC2 box. PostGIS is installed as a
package (`postgresql-18-postgis-3`) and enabled once:

```sql
-- 126_postgis.sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

All positions are `geography(Point, 4326)` so `ST_DWithin` and `ST_Distance`
are in metres without projection games. Time-series tables are range-partitioned
by month and BRIN-indexed on time; GiST on the geography.

### 3.2 Schema

#### `market_vehicles` — extend the existing table (do not replace it)

```sql
-- 127_market_vehicles_routing.sql
ALTER TABLE market_vehicles
  -- 1.4 (1): the approve route writes these; they never existed
  ADD COLUMN IF NOT EXISTS approved_by        uuid,
  ADD COLUMN IF NOT EXISTS approved_at        timestamptz,
  -- routing profile (mirrors vehicles: capacity_kl, payload_mt, axle_count, tyre_config,
  -- gross_weight, unladen_weight — which the own-fleet table already has)
  ADD COLUMN IF NOT EXISTS capacity_kl        numeric(10,3) CHECK (capacity_kl > 0),
  ADD COLUMN IF NOT EXISTS payload_mt         numeric(10,3) CHECK (payload_mt > 0),
  ADD COLUMN IF NOT EXISTS gross_weight_kg    integer CHECK (gross_weight_kg BETWEEN 1000 AND 80000),
  ADD COLUMN IF NOT EXISTS unladen_weight_kg  integer CHECK (unladen_weight_kg BETWEEN 500 AND 40000),
  ADD COLUMN IF NOT EXISTS length_mm          integer,
  ADD COLUMN IF NOT EXISTS width_mm           integer,
  ADD COLUMN IF NOT EXISTS height_mm          integer,
  ADD COLUMN IF NOT EXISTS axle_count         smallint CHECK (axle_count BETWEEN 2 AND 12),
  ADD COLUMN IF NOT EXISTS tyre_config        text,                       -- '10+1', '12+1'
  ADD COLUMN IF NOT EXISTS body_type          text CHECK (body_type IN ('TANKER','BULKER','OPEN','CONTAINER','TRAILER','TIPPER','OTHER')),
  ADD COLUMN IF NOT EXISTS hazmat_class       text,                       -- 'PETROLEUM_A','PETROLEUM_B','LPG', NULL
  ADD COLUMN IF NOT EXISTS fastag_id          text,
  ADD COLUMN IF NOT EXISTS gps_imei           text,
  -- where it lives and where it is
  ADD COLUMN IF NOT EXISTS home_base          geography(Point,4326),
  ADD COLUMN IF NOT EXISTS home_base_label    text,
  ADD COLUMN IF NOT EXISTS availability       text NOT NULL DEFAULT 'UNKNOWN'
        CHECK (availability IN ('AVAILABLE','ON_TRIP','MAINTENANCE','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS last_position      geography(Point,4326),
  ADD COLUMN IF NOT EXISTS last_position_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_position_src  text,
  -- the Routes API vehicleInfo body, kept verbatim so LVR needs no schema change
  ADD COLUMN IF NOT EXISTS truck_profile      jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 1.4 (2): vehicles can be rejected like drivers
ALTER TABLE market_vehicles DROP CONSTRAINT IF EXISTS market_vehicles_system_status_check;
ALTER TABLE market_vehicles ADD CONSTRAINT market_vehicles_system_status_check
  CHECK (system_status IN ('System Active','PENDING APPROVAL','BLOCKED','REJECTED'));

CREATE INDEX IF NOT EXISTS idx_market_vehicles_last_position ON market_vehicles USING GIST (last_position);
CREATE INDEX IF NOT EXISTS idx_market_vehicles_available
  ON market_vehicles (availability) WHERE system_status = 'System Active';
```

The `capacity text` and `vehicle_class text` columns stay for display; the
numeric columns are what routing and BHAIRAVI read.

#### `vehicle_positions` — one position table for own and market trucks

`trip_gps_pings` is kept for reads (a compatibility view) and stops being the
write target; a fix without a trip (a market truck between loads, a FASTag
plaza read) had nowhere to go in it.

```sql
-- 128_vehicle_positions.sql
CREATE TABLE vehicle_positions (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  recorded_at       timestamptz NOT NULL,                 -- device time
  received_at       timestamptz NOT NULL DEFAULT now(),   -- server time
  vehicle_kind      text NOT NULL CHECK (vehicle_kind IN ('OWN','MARKET')),
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  market_vehicle_id uuid REFERENCES market_vehicles(id) ON DELETE SET NULL,
  trip_id           uuid REFERENCES trips(id) ON DELETE SET NULL,
  source            text NOT NULL CHECK (source IN ('DRIVER_APP','GPRS','FASTAG','VENDOR_TELEMATICS','MANUAL')),
  geog              geography(Point,4326) NOT NULL,
  speed_kmh         numeric(6,2) CHECK (speed_kmh BETWEEN 0 AND 200),
  heading_deg       smallint CHECK (heading_deg BETWEEN 0 AND 359),
  accuracy_m        numeric(8,1),
  altitude_m        numeric(8,1),
  battery_pct       smallint,
  session_jti       text,                                 -- auth_sessions.jti that sent it
  device_id         text,
  snapped_geog      geography(Point,4326),                -- Roads API snapToRoads, filled async
  PRIMARY KEY (recorded_at, id),
  CHECK ((vehicle_kind = 'OWN'    AND vehicle_id IS NOT NULL) OR
         (vehicle_kind = 'MARKET' AND market_vehicle_id IS NOT NULL))
) PARTITION BY RANGE (recorded_at);

CREATE INDEX ON vehicle_positions USING GIST (geog);
CREATE INDEX ON vehicle_positions (vehicle_id, recorded_at DESC)        WHERE vehicle_id IS NOT NULL;
CREATE INDEX ON vehicle_positions (market_vehicle_id, recorded_at DESC) WHERE market_vehicle_id IS NOT NULL;
CREATE INDEX ON vehicle_positions (trip_id, recorded_at DESC)           WHERE trip_id IS NOT NULL;
CREATE INDEX ON vehicle_positions USING BRIN (recorded_at);
-- monthly partitions created by a KALI housekeeping tick (or pg_partman)
CREATE TABLE vehicle_positions_2026_09 PARTITION OF vehicle_positions
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- latest fix per vehicle, the radar's read
CREATE VIEW v_vehicle_latest_position AS
SELECT DISTINCT ON (COALESCE(vehicle_id, market_vehicle_id))
       vehicle_kind, vehicle_id, market_vehicle_id, trip_id, source,
       geog, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng,
       speed_kmh, heading_deg, accuracy_m, recorded_at, received_at
  FROM vehicle_positions
 WHERE recorded_at > now() - interval '24 hours'
 ORDER BY COALESCE(vehicle_id, market_vehicle_id), recorded_at DESC;

-- compatibility for the three readers of trip_gps_pings
ALTER TABLE trip_gps_pings RENAME TO trip_gps_pings_legacy;
CREATE VIEW trip_gps_pings AS
SELECT id, trip_id, source, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng,
       speed_kmh, accuracy_m, NULL::text AS checkpoint, recorded_at, received_at AS created_at
  FROM vehicle_positions WHERE trip_id IS NOT NULL
UNION ALL
SELECT id, trip_id, source, lat, lng, speed_kmh, accuracy_m, checkpoint, recorded_at, created_at
  FROM trip_gps_pings_legacy;
```

#### `geofences`, `trip_geofence_state`, `geofence_logs` — the spatial engine

```sql
-- 129_geofences.sql
CREATE TABLE geofences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('LOADING_POINT','CONSIGNEE','TOLL_PLAZA','YARD','CHECKPOST','NO_GO','CUSTOM')),
  name            text NOT NULL,
  ref_table       text,                                   -- 'rtkm_master' | 'customers' | 'loading_points'
  ref_id          text,                                   -- consignee_id, customers.id, IOCL plant code '7R01'
  company_id      uuid REFERENCES companies(id),
  centre          geography(Point,4326) NOT NULL,
  radius_m        integer NOT NULL DEFAULT 1000 CHECK (radius_m BETWEEN 50 AND 20000),
  polygon         geography(Polygon,4326),                -- when present it wins over the circle
  exit_buffer_m   integer NOT NULL DEFAULT 300,           -- hysteresis: EXIT only beyond radius + buffer
  min_dwell_s     integer NOT NULL DEFAULT 180,           -- ARRIVED needs 3 min inside
  min_pings       smallint NOT NULL DEFAULT 2,            -- and 2 consecutive fixes inside
  max_accuracy_m  integer NOT NULL DEFAULT 150,           -- worse fixes are logged, never acted on
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by      uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON geofences USING GIST (centre);
CREATE INDEX ON geofences USING GIST (polygon) WHERE polygon IS NOT NULL;
CREATE UNIQUE INDEX geofences_ref_uq ON geofences (kind, ref_table, ref_id) WHERE ref_id IS NOT NULL;

-- which fences a trip is watching, and the debounced state per fence
CREATE TABLE trip_geofence_state (
  trip_id              uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  geofence_id          uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  role                 text NOT NULL CHECK (role IN ('ORIGIN','DESTINATION','WAYPOINT','WATCH')),
  inside               boolean NOT NULL DEFAULT false,
  inside_since         timestamptz,
  consecutive_inside   smallint NOT NULL DEFAULT 0,
  consecutive_outside  smallint NOT NULL DEFAULT 0,
  arrived_logged       boolean NOT NULL DEFAULT false,
  last_eval_at         timestamptz,
  last_position_id     bigint,
  PRIMARY KEY (trip_id, geofence_id)
);

CREATE TABLE geofence_logs (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at       timestamptz NOT NULL,
  trip_id           uuid REFERENCES trips(id) ON DELETE SET NULL,
  vehicle_kind      text NOT NULL,
  vehicle_id        uuid, market_vehicle_id uuid,
  geofence_id       uuid NOT NULL REFERENCES geofences(id),
  event             text NOT NULL CHECK (event IN ('ENTER','EXIT','DWELL','ARRIVED','DEPARTED')),
  position_geog     geography(Point,4326) NOT NULL,
  distance_m        numeric(9,1) NOT NULL,                -- ST_Distance(position, centre)
  dwell_s           integer,                              -- on EXIT / DEPARTED
  source            text NOT NULL, accuracy_m numeric(8,1),
  position_id       bigint,                               -- vehicle_positions.id
  applied_status    text,                                 -- 'IN_TRANSIT' | 'UNLOADING' when KALI moved the trip
  applied_by        text,                                 -- 'AGENT_01'
  agent_event_id    uuid,                                 -- agent_events.id, the audit chain
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ON geofence_logs (trip_id, occurred_at DESC);
CREATE INDEX ON geofence_logs (geofence_id, occurred_at DESC);
CREATE INDEX ON geofence_logs USING GIST (position_geog);
CREATE TABLE geofence_logs_2026_09 PARTITION OF geofence_logs FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- the arrival stamps the office needs, on the trip itself
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS departed_origin_at   timestamptz,
  ADD COLUMN IF NOT EXISTS arrived_destination_at timestamptz;
-- trips.plant_reported_at already exists: the consignee ENTER is its candidate value, confirmed by staff
```

The evaluation query, run inside the ping transaction (one round trip, all
fences of the trip):

```sql
SELECT s.geofence_id, s.role, s.inside, s.consecutive_inside, s.consecutive_outside, s.inside_since,
       g.radius_m, g.exit_buffer_m, g.min_dwell_s, g.min_pings, g.max_accuracy_m,
       ST_Distance($pos::geography, g.centre) AS distance_m,
       CASE WHEN g.polygon IS NOT NULL THEN ST_Covers(g.polygon, $pos::geography)
            ELSE ST_DWithin($pos::geography, g.centre, g.radius_m) END                          AS now_inside,
       CASE WHEN g.polygon IS NOT NULL THEN NOT ST_Covers(ST_Buffer(g.polygon, g.exit_buffer_m), $pos::geography)
            ELSE NOT ST_DWithin($pos::geography, g.centre, g.radius_m + g.exit_buffer_m) END    AS now_clear
  FROM trip_geofence_state s JOIN geofences g ON g.id = s.geofence_id
 WHERE s.trip_id = $trip AND g.status = 'ACTIVE';
```

#### `live_bids` — the bid stream, with `bazaar_bids` as its projection

`bazaar_bids` keeps the current state (one live PENDING per vendor per load is
already a partial unique index). `live_bids` is the append-only event stream
behind the live board, the realtime feed, and the desk's award review.

```sql
-- 130_live_bids.sql
CREATE TABLE live_bids (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  load_id              text NOT NULL REFERENCES bazaar_loads(load_id) ON UPDATE CASCADE,
  bid_id               uuid REFERENCES bazaar_bids(id),
  vendor_id            uuid NOT NULL REFERENCES vendors(id),
  market_vehicle_id    uuid REFERENCES market_vehicles(id),
  event                text NOT NULL CHECK (event IN ('PLACED','REVISED','WITHDRAWN','COUNTERED','BOOK_NOW',
                                                      'AWARD_REQUESTED','AWARDED','REJECTED','EXPIRED')),
  amount               numeric(14,2) CHECK (amount >= 0),
  -- what the market looked like at that instant
  eta_to_origin_s      integer,                          -- computeRouteMatrix, truck → load origin
  distance_to_origin_m integer,
  vehicle_position     geography(Point,4326),
  rate_band_low        numeric(14,2), rate_band_high numeric(14,2),   -- shown to the bidder (TRIPURA)
  l_rank               smallint,                          -- rank at the moment of the event
  margin_pct           numeric(6,2),                      -- TRIPURA's margin against the customer rate
  -- who did it
  actor_role           text NOT NULL CHECK (actor_role IN ('VENDOR','CUSTOMER','STAFF','AGENT')),
  actor_id             uuid, actor_name text,
  -- the approval desk barrier: awards from a phone wait here
  review_status        text NOT NULL DEFAULT 'NONE' CHECK (review_status IN ('NONE','PENDING','APPROVED','REJECTED')),
  reviewed_by          uuid, reviewed_at timestamptz, review_note text,
  client_seq           bigint, device_id text, ip inet,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON live_bids (load_id, created_at DESC);
CREATE INDEX ON live_bids (vendor_id, created_at DESC);
CREATE INDEX ON live_bids (review_status, created_at) WHERE review_status = 'PENDING';
CREATE INDEX ON live_bids USING GIST (vehicle_position) WHERE vehicle_position IS NOT NULL;

-- one row per open load for the board; L1 amount is staff-only in the route layer
CREATE VIEW v_live_bid_board AS
SELECT l.load_id, l.status, l.origin, l.destination, l.loading_date, l.bid_close_at, l.book_now_rate,
       count(b.id) FILTER (WHERE b.status = 'PENDING')                 AS live_bids,
       min(b.bid_amount) FILTER (WHERE b.status = 'PENDING')           AS l1_amount,
       (SELECT event FROM live_bids e WHERE e.load_id = l.load_id ORDER BY e.created_at DESC LIMIT 1) AS last_event,
       (SELECT created_at FROM live_bids e WHERE e.load_id = l.load_id ORDER BY e.created_at DESC LIMIT 1) AS last_event_at,
       (SELECT count(*) FROM live_bids e WHERE e.load_id = l.load_id AND e.review_status = 'PENDING') AS awaiting_desk
  FROM bazaar_loads l LEFT JOIN bazaar_bids b ON b.load_id = l.load_id
 GROUP BY l.load_id;

-- 1.4 (4): the award itself becomes a desk decision
ALTER TABLE bazaar_loads DROP CONSTRAINT IF EXISTS bazaar_loads_status_check;
ALTER TABLE bazaar_loads ADD CONSTRAINT bazaar_loads_status_check
  CHECK (status IN ('PENDING_REVIEW','OPEN','AWARD_REQUESTED','AWARDED','CLOSED','CANCELLED'));
```

Event semantics: `PLACED`, `REVISED`, `WITHDRAWN` from a vendor are
`review_status = 'NONE'` (blind bids need no gate, they are offers).
`AWARD_REQUESTED` (customer accept-bid, vendor Book-Now) is `PENDING`; the desk
turns it into `AWARDED` and only then does `openSettlementInTx` run — the
existing money chain is untouched, it starts one step later.

#### `route_plans`, `road_restrictions`, `lane_toll_calibration`, `maps_usage_ledger`

```sql
-- 131_routing.sql
CREATE TABLE road_restrictions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('NO_ENTRY_TIME','WEIGHT_LIMIT','HEIGHT_LIMIT','WIDTH_LIMIT','LENGTH_LIMIT',
                                                'NO_HAZMAT','BRIDGE','CITY_BAN','CLOSURE','PREFERRED')),
  geom            geography NOT NULL,                  -- Polygon or LineString
  max_weight_kg   integer, max_height_mm integer, max_width_mm integer, max_length_mm integer, max_axles smallint,
  applies_hazmat  boolean NOT NULL DEFAULT false,
  time_windows    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"days":[1,2,3,4,5,6,7],"from":"07:00","to":"22:00"}]
  valid_from      date, valid_to date,
  source          text NOT NULL DEFAULT 'OFFICE' CHECK (source IN ('OFFICE','NHAI','STATE_RTO','DRIVER_REPORT','INCIDENT')),
  evidence_file   text,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by      uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON road_restrictions USING GIST (geom);

CREATE TABLE route_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose                text NOT NULL CHECK (purpose IN ('RTKM','TRIP','BAZAAR_LOAD','BID_ETA','NAVIGATION')),
  trip_id                uuid REFERENCES trips(id),
  load_id                text REFERENCES bazaar_loads(load_id) ON UPDATE CASCADE,
  lane_id                uuid REFERENCES rtkm_master(id),
  direction              text NOT NULL DEFAULT 'OUT' CHECK (direction IN ('OUT','BACK')),
  origin                 geography(Point,4326) NOT NULL,
  destination            geography(Point,4326) NOT NULL,
  waypoints              jsonb NOT NULL DEFAULT '[]'::jsonb,
  vehicle_profile        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the truck_profile used
  profile_hash           text NOT NULL,
  provider               text NOT NULL CHECK (provider IN ('GOOGLE_ROUTES','GOOGLE_LVR','HERE_TRUCK','MAPPLS','MANUAL')),
  travel_mode            text NOT NULL, routing_preference text,
  distance_m             integer NOT NULL, duration_s integer NOT NULL, static_duration_s integer,
  polyline               text NOT NULL,                        -- encoded, as returned
  geom                   geography(LineString,4326),           -- decoded, for ST_Intersects
  toll_estimate          numeric(12,2), toll_currency text NOT NULL DEFAULT 'INR',
  toll_pass              text, toll_detail jsonb,
  restrictions_checked   boolean NOT NULL DEFAULT false,
  restrictions_violated  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{restriction_id, kind, name}]
  restrictions_partially_ignored boolean,                       -- LVR's own flag, when it exists
  alternatives           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the other routes considered, scored
  request_hash           text NOT NULL,
  billed_sku             text,
  computed_at            timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz
);
CREATE INDEX ON route_plans (request_hash, computed_at DESC);
CREATE INDEX ON route_plans (lane_id, direction, computed_at DESC) WHERE lane_id IS NOT NULL;
CREATE INDEX ON route_plans USING GIST (geom);

-- RTKM = OUT + BACK, beside the office's own figure
ALTER TABLE rtkm_master
  ADD COLUMN IF NOT EXISTS rtkm_google        numeric(10,3),
  ADD COLUMN IF NOT EXISTS toll_google        numeric(12,2),
  ADD COLUMN IF NOT EXISTS route_plan_out_id  uuid REFERENCES route_plans(id),
  ADD COLUMN IF NOT EXISTS route_plan_back_id uuid REFERENCES route_plans(id),
  ADD COLUMN IF NOT EXISTS origin_geog        geography(Point,4326),
  ADD COLUMN IF NOT EXISTS destination_geog   geography(Point,4326),
  ADD COLUMN IF NOT EXISTS rtkm_synced_at     timestamptz;

CREATE TABLE lane_toll_calibration (
  lane_id            uuid NOT NULL REFERENCES rtkm_master(id),
  vehicle_class      text NOT NULL,                     -- NHAI class: '3AX','4TO6AX','7PLUSAX'
  direction          text NOT NULL CHECK (direction IN ('OUT','BACK','ROUND')),
  toll_estimate      numeric(12,2) NOT NULL,            -- Google, IN_FASTAG
  toll_actual_median numeric(12,2),                     -- from toll_transactions on trips of this lane
  samples            integer NOT NULL DEFAULT 0,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lane_id, vehicle_class, direction)
);

CREATE TABLE maps_usage_ledger (
  day           date NOT NULL,
  sku           text NOT NULL,                          -- 'ROUTES_PRO','ROUTES_TOLLS','ROUTE_MATRIX','ROADS_SNAP','MAPS_JS_LOAD'
  requests      integer NOT NULL DEFAULT 0,
  elements      integer NOT NULL DEFAULT 0,
  est_cost_usd  numeric(10,4) NOT NULL DEFAULT 0,
  cap_hits      integer NOT NULL DEFAULT 0,             -- calls refused by the daily cap
  PRIMARY KEY (day, sku)
);
```

Ownership on the agent registry (single writer per table): `vehicle_positions`,
`geofences`, `trip_geofence_state`, `geofence_logs`, `route_plans` → KALI;
`live_bids`, `road_restrictions`, `lane_toll_calibration` → TRIPURA SUNDARI
(fix its `owns.tables` to `bazaar_bids` at the same time); `document_extractions`
already BHUVANESHWARI; `maps_usage_ledger` → BAGALAMUKHI (infra).

### 3.3 Routing: RTKM, restrictions, tolls

**Provider interface** (`server/lib/routing/index.js`):

```
computeRoute({ origin, destination, waypoints, profile, purpose, departAt })
  → { provider, distance_m, duration_s, polyline, toll: {estimate, currency, pass, detail},
      alternatives[], restrictions: {checked, violated[], partially_ignored} }
```

Implementations, in order of preference per profile and region:

1. `google-routes` — Routes API v2 `computeRoutes`, `travelMode: DRIVE`,
   `routingPreference: TRAFFIC_AWARE_OPTIMAL`, `computeAlternativeRoutes: true`,
   `extraComputations: ["TOLLS"]`, `routeModifiers: { tollPasses: ["IN_FASTAG"],
   vehicleInfo: { emissionType: "DIESEL" }, avoidFerries: true }`, field mask
   `routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,
   routes.travelAdvisory.tollInfo,routes.legs.travelAdvisory.tollInfo,routes.routeLabels`.
2. `google-lvr` — same call with `travelMode: TRUCK` and `vehicleInfo.totalHeightMm /
   totalLengthMm / totalWeightKg` from `truck_profile`. Registered but disabled until
   Google lists India; the request shape is built today so the switch is a flag.
3. `here-truck` / `mappls` — adapters for a truck-attribute router with India
   coverage, used only when a plan comes back with violations Google's alternatives
   cannot avoid.

**Restriction pass** (ours, on every plan): decode each alternative to a
`LineString`, run one query against `road_restrictions` active for the
departure time and the profile:

```sql
SELECT r.id, r.kind, r.name
  FROM road_restrictions r
 WHERE r.status = 'ACTIVE'
   AND (r.valid_from IS NULL OR r.valid_from <= $depart::date)
   AND (r.valid_to   IS NULL OR r.valid_to   >= $depart::date)
   AND ST_Intersects(r.geom, $route_geom::geography)
   AND (r.max_weight_kg IS NULL OR r.max_weight_kg < $gross_kg)
   AND (r.max_height_mm IS NULL OR r.max_height_mm < $height_mm)
   AND (r.max_axles     IS NULL OR r.max_axles     < $axles)
   AND (NOT r.applies_hazmat OR $hazmat)
   AND fn_time_window_hit(r.time_windows, $depart, $duration_s);
```

Pick the shortest compliant alternative; if none is compliant, keep Google's
primary, mark `restrictions_violated`, and surface it on the dispatch board as
an exception for a person. `PREFERRED` restrictions score a bonus rather than a
veto (the lanes the office knows work).

**RTKM** for a lane = `OUT` plan + `BACK` plan (the return is computed
separately; empty-return routes differ from loaded ones once restrictions
apply). Stored on `rtkm_master.rtkm_google` beside the office's
`rtkm_distance`; the existing `v_rtkm_master_variance` gains a third column.
The `LocationRtkmMaster` screen shows both and the delta; the office figure
stays authoritative until a person adopts the Google one, per the
surface-don't-autofix rule.

**Tolls**: `toll_estimate` with `IN_FASTAG` per direction. Calibration is a
weekly TRIPURA tick: for each lane, median of `toll_transactions` on trips of
that lane and vehicle class → `lane_toll_calibration.toll_actual_median`. The
bazaar shows the calibrated figure; the raw Google figure is kept for audit.

**Caching**: `maps_cache` grows a `kind = 'ROUTES_V2'` entry keyed on
`request_hash = sha256(origin|destination|waypoints|profile_hash|preference)`;
distance and polyline are reused for 30 days, tolls for 7 days, traffic-aware
durations never beyond 5 minutes. Every call increments `maps_usage_ledger`; a
daily cap per SKU (env) refuses further billed calls and counts `cap_hits`.

### 3.4 Geofencing engine (KALI)

Fences are minted from what the office already has: one `LOADING_POINT` per
IOCL plant code in `rtkm_master.depot_link` / loading points (Bongaigaon 7R01,
Lumding 7T04, …), one `CONSIGNEE` per `rtkm_master.consignee_id` (AFS, retail
outlets, NTPC), plazas from `toll_transactions`. Radius 1 km by default, a
polygon where a depot is oddly shaped. Geocoding happens once, through the
existing `/maps/geocode`, and a person confirms the pin.

When a trip is created (any door: AC5 import, TARA, office, bazaar award),
KALI's `trip.created` handler attaches `trip_geofence_state` rows: `ORIGIN`
(loading point), `DESTINATION` (consignee), `WATCH` (plazas on the plan).

Per position (inside the ping transaction, one query from §3.2):

| Observation | Debounce | Log | Trip change (KALI, `TRIP_FLOW`-legal only) |
|---|---|---|---|
| fix inside a fence, previously outside | `consecutive_inside ≥ min_pings`, `accuracy ≤ max_accuracy_m` | `ENTER` | none |
| inside for `≥ min_dwell_s` | once | `ARRIVED` | `DESTINATION` + status `IN_TRANSIT` → **`UNLOADING`**, `arrived_destination_at`, candidate `plant_reported_at`; `ORIGIN` → nothing (loading is the office's AC4/AC5 record) |
| fix beyond `radius + exit_buffer_m`, previously inside | `consecutive_outside ≥ min_pings` | `EXIT` (+ `dwell_s`) | `ORIGIN` + status `LOADED` → **`IN_TRANSIT`**, `departed_origin_at` |
| inside again after EXIT | | `ENTER` | none (a second visit is logged, never re-transitions) |

Everything else is evidence only. The engine never marks `COMPLETED`,
`SETTLED`, or `CANCELLED`; the office records the unloading and TARA settles.
A trip that has been `UNLOADING` by geofence for more than N hours with no
unloading entry raises an exception on the Action Required panel ("gaadi
plant par pahunch gayi, unloading entry nahi hui").

The `ARRIVED` stamp at a consignee is the plant-reporting evidence the
Aadhar Green detention rule needs; it fills `plant_reported_at` only when a
person confirms it from the desk.

Fences are served to the driver app with the trip (`GET
/portal/driver/trips/:id/geofences`) so the phone can pre-evaluate offline and
raise its cadence near a fence; the server remains the only judge.

### 3.5 Fleet Radar and live movement

- Transport: the existing Socket.io server. Rooms: `fleet:<company_id>` for
  staff (the Command Deck filter is already per company), `trip:<trip_code>` for
  the customer and the vendor of that settlement, joined only after the server
  resolves the party the way `customerPortal.routes.js` does for tracking.
- Server fan-out: `gps:fix` coalesced to at most one message per vehicle per
  second, and one `fleet:snapshot` on join from `v_vehicle_latest_position`.
- Client: Maps JavaScript API vector map (`mapId`) with `AdvancedMarkerElement`
  per vehicle. Motion is interpolated on the client between the last two fixes
  over the expected ping interval with `requestAnimationFrame`; heading from the
  bearing between fixes, or `heading_deg` when the device sends it; a marker
  freezes (and greys) when no fix has arrived for twice the interval. No extra
  Google call is made to animate.
- Trail: `snapped_geog` from Roads API `snapToRoads` (batched server-side,
  100 points per call, only for trips a person opens) drawn as a polyline;
  raw fixes otherwise.
- First data source: the FASTag plaza feed (`fastag_providers`, gtropy) as
  `source = 'FASTAG'` positions — the map is populated the week PostGIS lands,
  before a single driver logs in. Driver-app GPS and vendor telematics add on.

### 3.6 API architecture for the mobile apps

The guard stays closed by default; every new external route is under
`/api/v1/portal/<role>/` and is added to the guard's allow-list with a selftest
assertion. Nothing external ever holds a Google key: routes, tolls and
geocoding are proxied and quota'd by the API.

**Driver app**

| Route | Guard | Behaviour |
|---|---|---|
| `POST /portal/driver/positions` | DRIVER session (or `TRACK_ONLY`), rate-limit 1 batch / 5 s, ≤ 200 fixes, `trip_id` must belong to the driver's active trip | inserts `vehicle_positions`, runs the geofence query, emits `trip.gps.ping` with the transitions; replaces `POST /tracking/ping` for new clients |
| `GET /portal/driver/trips/:id/geofences` | DRIVER, own trip | fences + radii for offline pre-check |
| `GET /portal/driver/trips/:id/route` | DRIVER, own trip | the trip's `route_plans` (polyline, tolls, restrictions) — the map on the phone |
| existing `/portal/driver/{trips,khata,requests,documents}` | unchanged | |

**Vendor app**

| Route | Guard | Behaviour |
|---|---|---|
| `POST /portal/vendor/vehicles/:id/position` | VENDOR, own `market_vehicles` row | vendor telematics / driver phone of a market truck → `vehicle_positions(MARKET)`, updates `last_position` |
| `GET /portal/vendor/loads?near=1` | `needsModule('vend.bazaar')` | the feed with `eta_to_origin_s` per own truck (Route Matrix, cached per truck-load pair for 15 min) |
| `POST /portal/vendor/loads/:loadId/bid` | unchanged | now also appends `live_bids(PLACED)` with the truck's position and the rate band shown |
| `POST /portal/vendor/loads/:loadId/book-now` | unchanged | becomes `live_bids(BOOK_NOW, review_status=PENDING)` + load `AWARD_REQUESTED`; the settlement opens on desk approval |

**Customer app**

| Route | Guard | Behaviour |
|---|---|---|
| `POST /portal/customer/loads` | unchanged | `PENDING_REVIEW`, plus a `route_plans(BAZAAR_LOAD)` for distance and toll shown back to the customer |
| `POST /portal/customer/loads/:loadId/accept-bid` | unchanged | `live_bids(AWARD_REQUESTED, PENDING)` + load `AWARD_REQUESTED` — the award waits for the desk |
| `GET /portal/customer/trips/:code/tracking` | unchanged | reads `v_vehicle_latest_position` + geofence timeline (ENTER/ARRIVED/EXIT) as the shipment stepper |
| socket `join trip:<code>` | party resolved server-side | live marker for that trip only |

**Office (staff, 2FA)**

| Route | Purpose |
|---|---|
| `GET /approvals/desk` | one queue: `onboarding SUBMITTED`, `market_vehicles/market_drivers PENDING APPROVAL`, `bazaar_loads PENDING_REVIEW`, `live_bids review PENDING`, `partner_documents PENDING`, `driver_requests PENDING`, geofence exceptions; each item carries the BHUVANESHWARI extraction beside the typed values |
| `POST /bazaar/loads/:id/award-review {action, note}` | promotes `AWARD_REQUESTED` → `AWARDED` (runs `openSettlementInTx`) or back to `OPEN` |
| `POST /bazaar/market-vehicles/:id/reject {reason}` | the missing counterpart |
| `POST /routing/plan`, `POST /routing/matrix` | proxied Routes API with profile, quota and cache; staff and agents only |
| `GET/POST /geofences`, `GET /geofence-logs?trip=` | fence CRUD and the timeline |
| `GET/POST /road-restrictions` | the truck layer, with evidence file |
| `POST /rtkm/:laneId/sync-google` | computes OUT + BACK plans, writes `rtkm_google`, never overwrites `rtkm_distance` |
| `GET /maps/usage` | the ledger and caps |

**Keys and quotas**

- Browser key: Maps JavaScript API only, HTTP-referrer restricted to the ERP
  origins. Never Routes, never Geocoding.
- Server key: Routes API, Route Matrix, Roads API, Geocoding; IP-restricted to
  the box. Read from `.env.api`, never shipped.
- Android key (if Navigation SDK is adopted): package name + SHA-1 restricted.
- `/api/v1/maps/*` gets a `preHandler`: external roles may call `geocode`
  (own address entry) and `trip/:id/route` for their own trip only; `route`,
  `distance-matrix`, `lane-analysis` become staff/agent routes.
- Per-role daily quotas in `maps_usage_ledger`, hard cap per SKU.

**Agent wiring**

| Event | Emitter | Handler | Result |
|---|---|---|---|
| `trip.gps.ping` (payload now carries `transitions[]`) | positions route | KALI | applies §3.4 transitions, writes `geofence_logs.applied_*`, emits `trip.status.changed` |
| `trip.created` | ops route / TARA | KALI | attaches `trip_geofence_state`, requests a `route_plans(TRIP)` |
| `load.posted` | customer/staff route | TRIPURA | rate band from lane history, Route Matrix ETAs for available trucks, margin check |
| `bid.submitted` | vendor route | TRIPURA | L-rank, margin vs customer rate, `margin.alert.raised` |
| `document.uploaded` (doc_type KYC/RC/DL) | files route | BHUVANESHWARI | OCR → `document_extractions` proposal (`vehicle_must_resolve`, confidence gate) → desk |
| `compliance.clearance.requested` | KALI on award | BHAIRAVI | extended to read `market_vehicles` + `market_drivers` for bazaar assignments |
| `trip.settlement.authorised` / bazaar vouchers | desk | TARA | unchanged |

### 3.7 Phasing, cost, risks

| Phase | Scope | Depends on |
|---|---|---|
| 0 | Fix §1.4 defects; PostGIS package + `126`; Google Cloud project (the Gmail OAuth project exists) with Routes, Route Matrix, Roads, Maps JS enabled, budget alerts, restricted keys; `maps_usage_ledger` + caps; `/maps/*` guard | owner's Google billing account |
| 1 | `route_plans`, `road_restrictions`, provider interface, RTKM sync per lane (OUT+BACK), tolls with `IN_FASTAG`, calibration tick, variance on the RTKM screen | 0 |
| 2 | `vehicle_positions`, FASTag feed as first source, driver batch positions, Fleet Radar on vector map with interpolated motion, per-company rooms | 0; driver login needs the SMS OTP fallback or nothing arrives from phones |
| 3 | `geofences` minted from lanes, KALI engine, arrival stamps, detention evidence, exceptions | 2 |
| 4 | `live_bids`, award review on the desk, nearest-truck ETAs, TRIPURA bid handlers, BHUVANESHWARI KYC extraction on the desk, BHAIRAVI on market trucks | 1, 2 |
| 5 | Navigation SDK in the driver app; `google-lvr` when India is listed; HERE/Mappls adapter if truck legality keeps failing on specific lanes | 3 |

**Cost at list prices** (India prices to be read at signup; most volumes sit
inside the free monthly events):

| SKU | Assumed volume / month | List | Order of cost |
|---|---|---|---|
| Compute Routes Pro (traffic-aware, alternatives) | ~1,000 trips × 2 directions + lane syncs ≈ 3,000 | $10 / 1,000 | ~$30 |
| Tolls extra computation | same calls, higher tier | verify | ~$30 |
| Route Matrix (bid ETAs) | 100 loads × 50 trucks = 5,000 elements | Pro | ~$50 |
| Roads snapToRoads | ~2,000 calls | ~$10 / 1,000 | ~$20 |
| Maps JS dynamic loads | ~3,000 office/app sessions | ~$7 / 1,000 | ~$21 |

Roughly ₹12–15k a month at list before free tiers; the cap in
`maps_usage_ledger` is what keeps it there.

**Risks that decide the outcome, in order**

1. Driver login. Zero pings have ever arrived because WhatsApp OTP is the only
   channel. The SMS fallback gateway key (already designed for `OTP_CHANNEL=auto`)
   is the precondition for every phone-side feature here.
2. Truck legality is ours to maintain. `road_restrictions` is only as good as the
   office and the drivers keep it; the `DRIVER_REPORT` source and the evidence file
   exist so a driver's photo of a "no heavy vehicle 7–22 h" board becomes a fence.
3. GPS accuracy at depots. A 1 km circle around a depot inside a town will
   include the highway; polygons for the three IOCL locations should be drawn by a
   person in week one.
4. Spend. External roles can reach `/maps/*` today; the guard change in phase 0
   precedes any Routes API key.
5. Data ownership on the registry. New tables need a single owning agent or the
   swarm refuses to boot; the assignment in §3.2 is part of the migration PR.
