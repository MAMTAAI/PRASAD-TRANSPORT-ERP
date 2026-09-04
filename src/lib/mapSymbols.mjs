// src/lib/mapSymbols.mjs
// ─────────────────────────────────────────────────────────────────────────────
// ONE SET OF SYMBOLS FOR EVERY MAP IN THE SYSTEM.
//
// Owner, 4-Sep-2026: "driver, vehical, toll gate ... kaha vehicle and driver run
// kar rahay hay yah map may show honi chahiye — SYMBOL MAY ... har modal par
// and mobil aap par vi."
//
// WHY THIS FILE EXISTS. There were five maps in this app and five different
// visual languages. The dispatch board drew the loading point as a cyan dot and
// the unloading point as an amber dot; the tracking screen drew them as circles
// lettered A and B in green and pink; the trip sheet drew teardrops; the driver
// app drew yet another pair. Amber meant "unloading" on one screen and "toll
// plaza" on another. A dispatcher who moves between two of these screens has to
// re-learn the map each time, and the one thing a map is for is being read at a
// glance.
//
// So the vocabulary is fixed HERE and imported everywhere:
//
//   🟢 green teardrop   loading point       (where the load starts)
//   🔴 pink teardrop    unloading point     (where it is going)
//   🚚 cyan arrow       the lorry, pointing the way it is heading, labelled
//                       with its registration — the answer to "kahan chal rahi hai"
//   🛣️ amber pill       toll gate, with the RATE written inside it
//      green pill       …a gate the lorry has already crossed
//      slate pill "?"   …a gate whose rate is not in the system yet
//   · small dots        raw telemetry pings, coloured by source
//
// PLAIN .mjs AND NO GOOGLE IMPORT. These are icon literals, not SDK calls —
// `path: 0` is SymbolPath.CIRCLE, spelled as the number so this file never has
// to wait for the Maps SDK to load. That also lets the driver app, which mounts
// its map before the SDK settles, import it at module scope.
// ─────────────────────────────────────────────────────────────────────────────

export const INK = {
  loading: '#2fe39b',
  unloading: '#f472b6',
  truck: '#22d3ee',
  gate: '#ffb224',
  gateCrossed: '#2fe39b',
  gateUnknown: '#64748b',
  outline: '#04070f',
  outlineLight: '#0a1024',
};

/** A teardrop whose POINT sits exactly on the coordinate. Google's default red
 *  balloon cannot be recoloured, and loading and unloading have to be tellable
 *  apart from across an office. */
const PIN_PATH = 'M 0 0 C -1.6 -6.4 -8 -9.4 -8 -15.4 A 8 8 0 1 1 8 -15.4 C 8 -9.4 1.6 -6.4 0 0 z';

const pin = (fill, scale = 1.5) => ({
  path: PIN_PATH,
  fillColor: fill,
  fillOpacity: 1,
  strokeColor: INK.outline,
  strokeWeight: 1.6,
  scale,
  anchor: { x: 0, y: 0 },
  labelOrigin: { x: 0, y: -16 },
});

export const loadingPin = (scale) => pin(INK.loading, scale);
export const unloadingPin = (scale) => pin(INK.unloading, scale);

/** The lorry. An arrow and not a dot: the first question anyone asks about a
 *  moving truck is which way it is pointing, and a circle cannot answer it.
 *  `labelOrigin` sits below the arrow so the registration reads as a plate
 *  under the vehicle rather than through it. */
export const truckIcon = (heading = 0, scale = 1.35) => ({
  path: 'M 0 -9 L 6.5 7 L 0 3 L -6.5 7 Z',
  fillColor: INK.truck,
  fillOpacity: 1,
  strokeColor: INK.outline,
  strokeWeight: 1.6,
  scale,
  rotation: Number(heading) || 0,
  anchor: { x: 0, y: 0 },
  labelOrigin: { x: 0, y: 20 },
});

/** The registration, under the lorry. Passed as a Marker `label`. */
export const truckLabel = (vehicleNo) => (vehicleNo
  ? { text: String(vehicleNo), color: '#eaf9ff', fontSize: '10px', fontWeight: '800', className: 'pt-truck-label' }
  : undefined);

/** A TOLL GATE, sized to hold its rate. A 14px square clipped "₹210" to "21",
 *  which is a wrong number rather than a small one — so it is a pill wide
 *  enough for the widest realistic rate. */
export const gateIcon = (crossed, known) => ({
  path: 'M -21 -9 L 21 -9 L 21 9 L -21 9 Z',
  fillColor: crossed ? INK.gateCrossed : (known ? INK.gate : INK.gateUnknown),
  fillOpacity: 1,
  strokeColor: INK.outlineLight,
  strokeWeight: 2,
  scale: 1,
  labelOrigin: { x: 0, y: 0 },
});

export const gateLabel = (rate) => ({
  text: rate === null || rate === undefined || rate === '' ? '?' : inr(Number(rate)),
  color: '#0a1024',
  fontSize: '10px',
  fontWeight: '800',
});

/** A raw telemetry fix. Small, and never confusable with the lorry itself:
 *  a ping is a place the truck WAS, the arrow is where it IS. */
export const pingIcon = (color, best = false) => ({
  path: 0,                                   // SymbolPath.CIRCLE
  scale: best ? 8 : 5.5,
  fillColor: color,
  fillOpacity: 1,
  strokeColor: INK.outlineLight,
  strokeWeight: 2,
});

/** The same normalisation toll_plaza_key() uses in the database, so a crossing
 *  and the gate it happened at are recognised as one place on both sides. */
export const plazaKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '') || null;

export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** One InfoWindow look for the whole system. Rows that are falsy are dropped,
 *  so callers can pass conditionals without building arrays by hand. */
export function infoCard(head, colour, rows) {
  return `
    <div style="font-family:Inter,system-ui,sans-serif;color:#0f172a;min-width:180px;max-width:260px">
      <div style="font-weight:800;font-size:13px;color:${colour}">${head}</div>
      ${(rows || []).filter(Boolean).map((r) => `<div style="font-size:12px;margin-top:2px">${r}</div>`).join('')}
    </div>`;
}
infoCard.esc = esc;

/**
 * FIT THE CAMERA TO WHAT EXISTS — the owner's "kyo zoom karni hogi".
 *
 * Every map in this app had its own version of this and each got a different
 * part of it wrong. The three things that must all be true:
 *
 *   · ONE POINT IS NOT A BOX. fitBounds on a zero-area bounds zooms to the
 *     maximum, which puts a lorry in the middle of a featureless grey square.
 *   · A SHORT LANE MUST NOT ZOOM PAST THE ROAD. A 4 km bounds fits at zoom 15,
 *     which is closer than anyone wants; maxZoom caps it.
 *   · THE BOX MUST INCLUDE THE ROAD, not just its ends. A road that bows out —
 *     Silchar to Agartala goes the long way round the hills — is drawn half
 *     outside a box fitted to the two depots.
 *
 * Returns false when there was nothing to fit, so the caller can leave the
 * camera where it is instead of flying somewhere meaningless.
 */
export function fitTo(map, points, opts = {}) {
  const g = (typeof window !== 'undefined' && window.google) || null;
  if (!map || !g?.maps) return false;
  const pts = (points || []).filter((p) => {
    if (!p) return false;
    const lat = Number(typeof p.lat === 'function' ? p.lat() : p.lat);
    const lng = Number(typeof p.lng === 'function' ? p.lng() : p.lng);
    return Number.isFinite(lat) && Number.isFinite(lng);
  });
  if (!pts.length) return false;

  if (pts.length === 1) {
    const p = pts[0];
    map.setCenter({
      lat: Number(typeof p.lat === 'function' ? p.lat() : p.lat),
      lng: Number(typeof p.lng === 'function' ? p.lng() : p.lng),
    });
    map.setZoom(opts.pointZoom ?? 12);
    return true;
  }

  const b = new g.maps.LatLngBounds();
  for (const p of pts) b.extend(p);
  map.fitBounds(b, opts.padding ?? 56);

  // fitBounds is asynchronous — the zoom it settles on is not readable until
  // the next idle. Capping it there rather than immediately is what makes the
  // cap actually apply.
  const max = opts.maxZoom ?? 14;
  g.maps.event.addListenerOnce(map, 'idle', () => {
    const z = map.getZoom?.();
    if (z && z > max) map.setZoom(max);
  });
  return true;
}

/**
 * RE-FIT WHEN THE BOX CHANGES SIZE.
 *
 * Google keeps the CENTRE and the ZOOM when its container resizes, so a fit
 * computed while a panel was still laying out — or a sheet was still animating
 * open — leaves the camera framed for a box that no longer exists. On the
 * dispatch board that is exactly what "kyo zoom karni hogi" looks like: the
 * route is drawn correctly and the camera is two levels too far out, because
 * it was fitted against a container half the height.
 *
 * Debounced through rAF, because a sheet animation fires this every frame.
 * Returns a disposer.
 */
export function observeAndRefit(el, fit) {
  if (!el || typeof ResizeObserver === 'undefined') return () => {};
  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fit());
  });
  ro.observe(el);
  return () => { cancelAnimationFrame(frame); ro.disconnect(); };
}
