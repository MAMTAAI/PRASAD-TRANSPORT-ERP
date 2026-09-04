// src/lib/tollRoute.mjs
// ─────────────────────────────────────────────────────────────────────────────
// WHICH TOLL GATES THIS ROUTE PASSES, AND WHAT THE TRIP WILL PAY.
//
// Owner, 4-Sep-2026: "trip route may toll gate and toll rate ... total trip par
// kitna toll tax lag rahi hay yah map may show karay ... one way and return."
//
// PLAIN ESM AND NO GOOGLE IMPORT, for two reasons. It is money arithmetic, so
// it gets a selftest that runs in node without a browser or a billed API call
// (`node src/lib/tollRoute.selftest.mjs`). And the driver's phone gets its route
// from the server, so when the same numbers are needed there, the server can
// import this file exactly as it imports tripPlaces.core.mjs.
//
// ── THE MATCH IS GEOMETRIC, NOT BY NAME ─────────────────────────────────────
// A plaza is "on this route" when it sits within a tolerance of the road
// polyline Google returned. Matching by name would need a lane→gates table
// somebody maintains; matching by geometry needs nothing maintained at all, and
// it keeps working the day a route changes because of a bypass.
//
// The default tolerance is 1.2 km. It is not a guess about GPS accuracy — the
// COORDINATES ARE THE LOOSE PART. They come off FASTag readers and land
// anywhere from the gantry itself to the middle of the plaza complex, and the
// polyline is a simplified overview with vertices a few hundred metres apart.
// Tighter than about a kilometre starts dropping gates the lorry demonstrably
// paid at. Much looser starts catching the plaza on the parallel highway.
//
// ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
// It will not invent a rate. A gate with `rate == null` is counted as a GATE
// but not as RUPEES, and the caller is told how many of those there are, so the
// screen can say "6 gates, 4 priced, ₹2,340 + 2 unknown" instead of quietly
// under-billing by two plazas. Same principle as the depot names: an honest
// gap beats a confident wrong number.
// ─────────────────────────────────────────────────────────────────────────────

const R = 6371008.8;                      // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle metres between two {lat,lng}. */
export function haversineM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// `Number(null)` is 0 and `Number('')` is 0, and THAT is the bug this guard
// exists for: a plaza whose rate we do not know would have been added to the
// trip's toll as zero rupees, so a route with two unknown gates would have
// reported a total that looked complete and was short by two plazas. Caught by
// the selftest ("a missing rate is not a zero") before it ever reached a
// screen. Nothing empty is a number.
const numOr = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A plaza we can actually place. */
const placed = (p) => p && numOr(p.lat) !== null && numOr(p.lng) !== null;

/**
 * The gates on a route, in the order the lorry meets them.
 *
 * @param path    [{lat,lng}] — Google's overview_path for the chosen route.
 * @param plazas  the toll_plazas master (needs lat/lng; rate may be null).
 * @param opts.toleranceM  how close counts as "on the road". Default 1200.
 * @returns [{ ...plaza, distance_m, at }] ordered along the route.
 *          `distance_m` is how far off the line the gate sits — shown so an
 *          operator can dismiss a gate that is obviously on the other highway.
 *          `at` is the index of the nearest vertex, i.e. the ordering key.
 */
export function plazasOnRoute(path, plazas, opts = {}) {
  const tol = Number(opts.toleranceM ?? 1200);
  const pts = (path || []).map((p) => ({ lat: numOr(p.lat), lng: numOr(p.lng) }))
    .filter((p) => p.lat !== null && p.lng !== null);
  if (pts.length < 2) return [];

  // A bounding box first. Without it every plaza in the country is measured
  // against every vertex of every route; with it, a lane in Assam never
  // considers a gate in Gujarat. One degree of latitude is ~111 km, and
  // longitude shrinks with the cosine — using latitude's figure for both is
  // deliberately generous, which is the safe direction for a pre-filter.
  const pad = tol / 111_000 + 0.02;
  let n = -90, s = 90, e = -180, w = 180;
  for (const p of pts) {
    if (p.lat > n) n = p.lat;
    if (p.lat < s) s = p.lat;
    if (p.lng > e) e = p.lng;
    if (p.lng < w) w = p.lng;
  }

  const best = new Map();                 // name_key -> the nearest approach
  for (const plaza of plazas || []) {
    if (!placed(plaza)) continue;
    const q = { lat: numOr(plaza.lat), lng: numOr(plaza.lng) };
    if (q.lat > n + pad || q.lat < s - pad || q.lng > e + pad || q.lng < w - pad) continue;

    let min = Infinity;
    let at = -1;
    for (let i = 0; i < pts.length; i += 1) {
      const d = haversineM(q, pts[i]);
      if (d < min) { min = d; at = i; }
      // Nothing gets closer than zero, and a gate the line runs through is
      // decided; stop measuring the other 1,200 vertices.
      if (min < 60) break;
    }
    if (min > tol) continue;

    // A route can meet the same gate twice — an out-and-back stub, or a loop
    // through a town. It is ONE gate on the map; the round-trip doubling below
    // is what accounts for paying twice.
    const key = plaza.name_key || plaza.plaza_name || String(at);
    const prev = best.get(key);
    if (!prev || min < prev.distance_m) {
      best.set(key, { ...plaza, distance_m: Math.round(min), at });
    }
  }

  return [...best.values()].sort((a, b) => a.at - b.at);
}

/**
 * What the trip pays.
 *
 * ROUND TRIP IS TIMES TWO, AND THE SCREEN MUST SAY SO. It assumes the lorry
 * comes back the same road and is charged the same rate. Plazas do publish a
 * cheaper same-day return, and some of these lanes have one-way stretches — so
 * this is an ESTIMATE and is labelled one everywhere it appears. What it is
 * NOT is a guess: every rupee in it is a rate one of our own trucks has
 * actually been charged at that gate.
 */
export function tollTotals(gates, opts = {}) {
  const roundTrip = !!opts.roundTrip;
  const list = gates || [];
  const priced = list.filter((g) => numOr(g.rate) !== null);
  const oneWay = priced.reduce((sum, g) => sum + Number(g.rate), 0);
  return {
    gates: list.length,
    priced: priced.length,
    unknown: list.length - priced.length,
    one_way: Math.round(oneWay),
    total: Math.round(roundTrip ? oneWay * 2 : oneWay),
    round_trip: roundTrip,
    // True when the number on screen is smaller than the number the driver will
    // actually spend. The UI leans on this rather than re-deriving it.
    incomplete: list.length > priced.length,
  };
}

/**
 * Round trip or one side.
 *
 * Owner's rule (4-Sep): oil-company work is a ROUND trip — load at the depot,
 * deliver, come back empty, and the trip only closes on return; `trips.rtkm` is
 * round-trip km, which is why it runs to roughly twice the road distance. A
 * MARKET vehicle runs the owner's side only.
 *
 * What the operator saved on the trip wins over any of that. Dispatch knows
 * about the run that went out loaded and came back loaded for somebody else,
 * and the derivation never will.
 */
export function legKindOf(trip) {
  const saved = String(trip?.trip_leg_kind ?? '').toUpperCase();
  if (saved === 'ROUND' || saved === 'ONE_WAY') return { kind: saved, source: 'SAVED' };
  if (trip?.is_market_vehicle) return { kind: 'ONE_WAY', source: 'MARKET_VEHICLE' };
  return { kind: 'ROUND', source: 'OIL_COMPANY_DEFAULT' };
}
