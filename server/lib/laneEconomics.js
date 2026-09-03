// server/lib/laneEconomics.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A LANE COSTS — distance, and the toll we will actually pay.
//
// The toll rule (owner directive, 3-Sep-2026, after the R&D):
//
//   1. If we have run this lane before, the toll is the AVERAGE OF WHAT WE
//      ACTUALLY PAID. toll_transactions holds 3,883 real FASTag rows joined to
//      trips; averaged per lane that is a measurement, not a guess, and it beats
//      any API on the lanes this firm actually runs.
//   2. Otherwise, Google's Routes API estimate.
//   3. Neither → null. Never a plausible-looking number.
//
// EVERY ANSWER CARRIES ITS SOURCE, and the desk shows it. A margin decision made
// on a measured ₹5,911 is a different decision from one made on an estimate that
// happens to print the same way, and a screen that renders them identically is
// how an estimate becomes a fact by Tuesday.
//
// Lane matching is deliberately loose — depot names arrive as
// "LPG  BP  NORTH  GUWAHATI  (7B03)" with doubled spaces and codes — so both
// sides are squashed to letters and digits before comparison. Loose matching
// risks pairing two different depots in the same town; that is why the answer
// says how many trips it is based on, and one trip is not enough to qualify.
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '../db/pool.js';
import { getRoute } from './googleMaps.js';

/** Squash a depot name to something two spellings of it can share. */
export const laneKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const MIN_TRIPS_TO_TRUST = 2;

/** Our own toll history for a lane, or null when we have not run it enough. */
export async function tollFromHistory(origin, destination) {
  const o = laneKey(origin), d = laneKey(destination);
  if (!o || !d) return null;
  const { rows } = await query(`
    WITH per_trip AS (
      SELECT tt.trip_id, sum(tt.amount)::numeric AS toll, count(*)::int AS plazas
        FROM toll_transactions tt
       WHERE tt.trip_id IS NOT NULL AND tt.amount > 0
       GROUP BY tt.trip_id)
    SELECT count(*)::int                     AS trips,
           round(avg(p.toll))::int           AS avg_toll,
           round(avg(p.plazas), 1)::float    AS avg_plazas,
           round(avg(NULLIF(t.rtkm, 0)))::int AS avg_km
      FROM per_trip p
      JOIN trips t ON t.id = p.trip_id
     WHERE regexp_replace(upper(COALESCE(t.loading_point, '')),      '[^A-Z0-9]', '', 'g') = $1
       AND regexp_replace(upper(COALESCE(t.unloading_location, '')), '[^A-Z0-9]', '', 'g') = $2`,
    [o, d]);
  const r = rows[0];
  if (!r || r.trips < MIN_TRIPS_TO_TRUST) return null;
  return {
    toll: r.avg_toll, plazas: r.avg_plazas, km: r.avg_km,
    source: 'OUR_TRIPS', trips: r.trips,
    label: `from ${r.trips} past runs on this lane`,
  };
}

/** Distance from Google (cached per lane in maps_cache), and the toll from
 *  whichever source can answer. Never throws: a lane we cannot price is a fact
 *  the desk should see, not a 500. */
export async function laneEconomics(origin, destination) {
  const out = { origin, destination, km: null, duration_s: null, toll: null, toll_source: null, toll_label: null, notes: [] };

  const hist = await tollFromHistory(origin, destination).catch(() => null);
  if (hist) {
    out.toll = hist.toll;
    out.toll_source = hist.source;
    out.toll_label = hist.label;
    out.km = hist.km || null;
  }

  const route = await getRoute(origin, destination).catch(() => null);
  if (route?.ok) {
    // Google's distance wins over our trip average: rtkm on a trip row is the
    // billed distance, which is not always the road distance.
    if (Number.isFinite(route.distance_m)) out.km = Math.round(route.distance_m / 1000);
    out.duration_s = route.duration_s ?? null;
    out.polyline = route.polyline ?? null;
  } else if (route && !route.ok) {
    out.notes.push(`route: ${route.reason ?? 'unavailable'}`);
  }

  if (out.toll == null) {
    // Google's toll estimate would go here (Routes API v2 computeRoutes with
    // extraComputations TOLLS). Until that key/quota is enabled, saying "we do
    // not know" is the honest answer and the desk types the toll it expects.
    out.toll_label = 'no past run on this lane — enter the expected toll';
  }
  return out;
}
