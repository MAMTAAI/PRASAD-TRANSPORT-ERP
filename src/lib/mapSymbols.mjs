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
//   🏭 green hub pin    loading point — a refinery/terminal glyph inside the pin
//   🏬 pink hub pin     unloading point — a warehouse/AFS glyph
//   🚛 tanker, top-down the lorry, rotated to its heading, wearing its
//                       registration plate — "kahan chal rahi hai"
//   🧍 violet person    a fix reported by the DRIVER'S PHONE, which is a
//                       different kind of fact from a device fix and must not
//                       look like one
//   🛣️ toll booth       a booth with a barrier arm and the rate on a plate:
//                       amber + arm DOWN  — not through it yet
//                       green + arm UP    — FASTag says the lorry is past it
//                       slate + "?"       — we do not know the rate
//   · small dots        raw telemetry pings, coloured by source
//
// PLAIN .mjs AND NO GOOGLE AT IMPORT TIME. Screens mount their map before the
// SDK settles, so nothing here may touch `google` until a builder is actually
// called — see size()/point() below, which is the only place it is read.
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

// ── HOW THESE ARE DRAWN ─────────────────────────────────────────────────────
//
// Every icon below is a real multi-colour SVG, inlined as a data: URI and handed
// to a classic google.maps.Marker as an `Icon`. Two roads were open and this is
// the one that works here:
//
//   · google.maps.Symbol takes ONE path and ONE fill. That is what these used to
//     be, and it is why a lorry could only ever be a triangle.
//   · AdvancedMarkerElement takes arbitrary HTML, but it needs the `marker`
//     library through importLibrary AND a mapId, which means `loading=async`.
//     lib/maps.ts refuses that on purpose (every caller constructs a Map
//     synchronously on the script's onload, and async defers the libraries past
//     that point — the whole dispatch board died the last time it was tried).
//   · An Icon with a data: URI takes a full SVG. Multi-colour, gradients, drop
//     shadows, text — and it works on the SDK this app already loads.
//
// ROTATION IS BAKED IN, NOT SET AS A PROPERTY. `rotation` belongs to Symbol, not
// to Icon, so the lorry's heading is applied as a transform inside the SVG and
// the data URI is rebuilt when the heading changes. Headings are rounded to 3°
// upstream, so a truck crawling down a straight highway does not rebuild its
// icon on every ping.

/** google.maps.Size / Point when the SDK is up, plain literals before it is.
 *  This module is imported at module scope by screens that mount before Maps
 *  has loaded, so it must never touch `google` at import time — only inside a
 *  builder, which is always called from an effect that already has the SDK. */
const size = (w, h) => {
  const g = globalThis.google;
  return g?.maps?.Size ? new g.maps.Size(w, h) : { width: w, height: h };
};
const point = (x, y) => {
  const g = globalThis.google;
  return g?.maps?.Point ? new g.maps.Point(x, y) : { x, y };
};

const svgUrl = (svg) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s{2,}/g, ' ').trim())}`;

/** The soft ground shadow every marker sits on. What separates a premium map
 *  pin from a sticker: the icon has to look like it is ABOVE the road. */
const SHADOW = (cx, cy, rx = 7, ry = 2.6) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#04070f" opacity=".35"/>`;

// ── THE PLACE HUB ───────────────────────────────────────────────────────────
// A depot is not a dot. These are the two ends of every trip in the company and
// they carry a glyph that says WHICH KIND of place: a refinery/terminal where
// the load starts, a warehouse/AFS where it is handed over. The pin's point
// still sits exactly on the coordinate — that has to survive any amount of
// prettiness, because it is the only thing that makes the marker true.
const hub = (fill, dark, glyph) => {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="42" height="54" viewBox="0 0 42 54">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${fill}"/>
      <stop offset="1" stop-color="${dark}"/>
    </linearGradient>
    <filter id="s" x="-40%" y="-30%" width="180%" height="180%">
      <feDropShadow dx="0" dy="1.4" stdDeviation="1.6" flood-color="#04070f" flood-opacity=".55"/>
    </filter>
  </defs>
  ${SHADOW(21, 50, 6.5, 2.4)}
  <path filter="url(#s)" fill="url(#g)" stroke="#04070f" stroke-width="1.4"
        d="M21 48.5 C 17 40 6.5 34.5 6.5 22.5 A 14.5 14.5 0 1 1 35.5 22.5 C 35.5 34.5 25 40 21 48.5 Z"/>
  <circle cx="21" cy="21.5" r="10.4" fill="#0a1024" opacity=".92"/>
  <g fill="${fill}" transform="translate(21,21.5)">${glyph}</g>
</svg>`;
  return { url: svgUrl(svg), scaledSize: size(42, 54), anchor: point(21, 49), labelOrigin: point(21, 21) };
};

// A rail-fed POL terminal. THE FIRST DRAFT WAS THREE RECTANGLES OF DIFFERENT
// HEIGHTS AND READ AS A BAR CHART — verified on screen before release. What
// makes it a factory instead is the sawtooth roof and the smoking chimney;
// those two shapes are read as industry before anything else is.
const REFINERY_GLYPH = `
  <rect x="3.4" y="-8.6" width="2.6" height="6.4" rx="1"/>
  <circle cx="4.7" cy="-9.8" r="1.5" opacity=".55"/>
  <circle cx="7" cy="-11.6" r="1.1" opacity=".35"/>
  <path d="M -8.6 5.6 L -8.6 -1.6 L -4.4 1.4 L -4.4 -1.6 L -0.2 1.4 L -0.2 -1.6
           L 4 1.4 L 4 -2.2 L 8 -2.2 L 8 5.6 Z"/>
  <rect x="-9.6" y="6" width="18.6" height="2.1" rx="1.05"/>`;

// The delivery end: a shed roof, a shutter, and the ground it stands on.
const WAREHOUSE_GLYPH = `
  <path d="M -8.4 -1.2 L 0 -6.6 L 8.4 -1.2 L 8.4 0.4 L -8.4 0.4 Z"/>
  <rect x="-6.6" y="0.9" width="13.2" height="5.4" rx="0.8"/>
  <rect x="-2.2" y="2.4" width="4.4" height="3.9" rx="0.5" fill="#0a1024"/>
  <rect x="-8.8" y="6.6" width="17.6" height="1.8" rx="0.9"/>`;

export const loadingPin = () => hub(INK.loading, '#0f9d6b', REFINERY_GLYPH);
export const unloadingPin = () => hub(INK.unloading, '#b03a72', WAREHOUSE_GLYPH);

// ── THE LORRY ───────────────────────────────────────────────────────────────
// Drawn from ABOVE, because that is the only view that can carry a heading. A
// tanker, not a generic box: this fleet hauls petroleum, and the silhouette an
// operator recognises from the yard is a cab with a cylinder behind it.
//
// Nose points north at heading 0 and the whole body rotates; the plate does NOT
// rotate, because upside-down text is unreadable and the registration is the
// point of it.
export const truckIcon = (heading = 0, scale = 1) => {
  const w = Math.round(52 * scale);
  const h = Math.round(58 * scale);
  const deg = ((Number(heading) || 0) % 360 + 360) % 360;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="52" height="58" viewBox="0 0 52 58">
  <defs>
    <linearGradient id="tank" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0a4f63"/>
      <stop offset=".26" stop-color="#7ff0ff"/>
      <stop offset=".54" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#073d4f"/>
    </linearGradient>
    <linearGradient id="cab" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#101f57"/>
      <stop offset=".3" stop-color="#6a92ff"/>
      <stop offset="1" stop-color="#0d1d54"/>
    </linearGradient>
    <filter id="td" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="1.6" stdDeviation="1.7" flood-color="#04070f" flood-opacity=".6"/>
    </filter>
  </defs>
  ${SHADOW(26, 51, 7.5, 2.6)}
  <g transform="rotate(${deg} 26 26)" filter="url(#td)">
    <!-- WHEELS, CLEARLY OUTSIDE THE HULL.
         Two drafts were rejected on screen before this one. The first put them
         inside the body, the second flush against it — both times the outline
         swallowed them and the lorry read as a drum seen from above. A vehicle
         is recognised by the bumps on its sides long before any paint on it
         registers, so they have to break the silhouette. -->
    <g fill="#0b0f1c">
      <rect x="12.6" y="12.5" width="4.6" height="7" rx="2"/>
      <rect x="34.8" y="12.5" width="4.6" height="7" rx="2"/>
      <rect x="12.6" y="30"   width="4.6" height="7.4" rx="2"/>
      <rect x="34.8" y="30"   width="4.6" height="7.4" rx="2"/>
      <rect x="12.6" y="38.6" width="4.6" height="7.4" rx="2"/>
      <rect x="34.8" y="38.6" width="4.6" height="7.4" rx="2"/>
    </g>

    <!-- THE TANK — 18 wide, 27 long. Half again as long as it is wide, which is
         what stops it reading as a barrel. -->
    <rect x="17" y="21.5" width="18" height="27" rx="7" fill="url(#tank)" stroke="#04070f" stroke-width="1.35"/>
    <rect x="19.8" y="24" width="2.6" height="22" rx="1.3" fill="#f2fdff" opacity=".55"/>
    <line x1="17.4" y1="30" x2="34.6" y2="30" stroke="#04070f" stroke-width=".9" opacity=".45"/>
    <line x1="17.4" y1="40" x2="34.6" y2="40" stroke="#04070f" stroke-width=".9" opacity=".45"/>

    <!-- the fifth wheel: a tractor AND a trailer, not one lump -->
    <rect x="22.6" y="18.6" width="6.8" height="3.6" rx="1.4" fill="#0b0f1c"/>

    <!-- THE CAB, tapered at the front. The taper is the direction cue — a real
         cab is narrower at the nose, and that reads at 40 px where an added
         arrow just looked like a piece breaking off. -->
    <path d="M17.4 19.4 L17.4 11.2 Q17.4 6.4 22.4 5.4 L29.6 5.4 Q34.6 6.4 34.6 11.2 L34.6 19.4 Z"
          fill="url(#cab)" stroke="#04070f" stroke-width="1.35"/>
    <path d="M19.6 10.6 Q26 8.4 32.4 10.6 L32.4 13.6 L19.6 13.6 Z" fill="#d5ecff" opacity=".95"/>
    <!-- wing mirrors: the last thing that says "lorry" rather than "car" -->
    <rect x="14.6" y="10.4" width="3.4" height="1.8" rx=".9" fill="#0b0f1c"/>
    <rect x="34"   y="10.4" width="3.4" height="1.8" rx=".9" fill="#0b0f1c"/>
    <circle cx="21.4" cy="7.2" r="1.5" fill="#fff3c4"/>
    <circle cx="30.6" cy="7.2" r="1.5" fill="#fff3c4"/>
  </g>
</svg>`;
  return { url: svgUrl(svg), scaledSize: size(w, h), anchor: point(w / 2, h * (26 / 58)), labelOrigin: point(w / 2, h * 0.87) };
};

/** The registration, under the lorry. Passed as a Marker `label`. */
export const truckLabel = (vehicleNo) => (vehicleNo
  ? { text: String(vehicleNo), color: '#eaf9ff', fontSize: '10px', fontWeight: '800', className: 'pt-truck-label' }
  : undefined);

// ── THE DRIVER ──────────────────────────────────────────────────────────────
// A position reported by a man's PHONE is not the same fact as a position
// reported by the lorry's device, and it should not look like one. Violet, the
// same hue the app already uses for a human-in-the-loop surface.
export const driverIcon = (best = false) => {
  const k = best ? 1.15 : 1;
  const w = Math.round(38 * k);
  const h = Math.round(46 * k);
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="38" height="46" viewBox="0 0 38 46">
  <defs>
    <linearGradient id="dg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#7c5cf0"/>
    </linearGradient>
    <filter id="ds" x="-40%" y="-30%" width="180%" height="180%">
      <feDropShadow dx="0" dy="1.2" stdDeviation="1.4" flood-color="#04070f" flood-opacity=".55"/>
    </filter>
  </defs>
  ${SHADOW(19, 42, 5.6, 2.1)}
  <path filter="url(#ds)" fill="url(#dg)" stroke="#04070f" stroke-width="1.3"
        d="M19 41 C 15.6 34 4.5 30 4.5 19 A 14.5 14.5 0 1 1 33.5 19 C 33.5 30 22.4 34 19 41 Z"/>
  <circle cx="19" cy="18" r="9" fill="#1a1035" opacity=".9"/>
  <circle cx="19" cy="14.6" r="3.5" fill="#ede9fe"/>
  <path d="M11.9 24.4 a7.6 7.6 0 0 1 14.2 0 z" fill="#ede9fe"/>
</svg>`;
  return { url: svgUrl(svg), scaledSize: size(w, h), anchor: point(w / 2, h * (41 / 46)), labelOrigin: point(w / 2, h * 0.4) };
};

// ── THE TOLL GATE ───────────────────────────────────────────────────────────
// A booth with a barrier arm, and the rate ON A TAG beside it — drawn INSIDE the
// SVG rather than as a Marker label, because a label is bare text with no plate
// behind it and "₹210" floating over a highway is unreadable at a glance.
//
// The barrier says the state without needing a legend: DOWN and amber when the
// lorry has not been through, UP and green once FASTag says it has, DOWN and
// slate when we do not even know the rate.
export const gateIcon = (crossed, known, rate) => {
  const body = crossed ? INK.gateCrossed : (known ? INK.gate : INK.gateUnknown);
  const deep = crossed ? '#0f9d6b' : (known ? '#c67c08' : '#475569');
  const text = known && rate !== null && rate !== undefined && rate !== ''
    ? inr(rate) : '?';
  const tagW = Math.max(26, 8 + text.length * 6.4);
  const w = 30 + tagW;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="46" viewBox="0 0 ${w} 46">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${body}"/><stop offset="1" stop-color="${deep}"/>
    </linearGradient>
    <filter id="gs" x="-30%" y="-30%" width="170%" height="170%">
      <feDropShadow dx="0" dy="1.2" stdDeviation="1.3" flood-color="#04070f" flood-opacity=".55"/>
    </filter>
  </defs>
  ${SHADOW(15, 41, 8, 2.4)}
  <g filter="url(#gs)">
    <!-- the barrier arm: down across the road, or lifted once crossed -->
    <g transform="rotate(${crossed ? -62 : 0} 20 22)">
      <circle cx="20" cy="22" r="2.4" fill="#cbd5e1" stroke="#04070f" stroke-width="1"/>
      <rect x="19" y="19.8" width="${w - 22}" height="4.4" rx="2.2" fill="#f1f5f9" stroke="#04070f" stroke-width="1"/>
      <rect x="24" y="20.3" width="5" height="3.4" fill="#ef4444"/>
      <rect x="33.5" y="20.3" width="5" height="3.4" fill="#ef4444"/>
    </g>
    <!-- the booth -->
    <path d="M7 16 L15 10 L23 16 L23 17.5 L7 17.5 Z" fill="${body}" stroke="#04070f" stroke-width="1.1"/>
    <rect x="8.2" y="17" width="13.6" height="21" rx="2" fill="url(#bg)" stroke="#04070f" stroke-width="1.2"/>
    <rect x="10.4" y="20" width="9.2" height="7" rx="1.2" fill="#0a1024" opacity=".85"/>
    <rect x="9" y="38" width="12" height="2.4" rx="1.2" fill="#04070f" opacity=".6"/>
  </g>
  <!-- the rate, on its own plate -->
  <g filter="url(#gs)">
    <rect x="26" y="27" width="${tagW}" height="15" rx="4" fill="#0a1024" stroke="${body}" stroke-width="1.4"/>
    <text x="${26 + tagW / 2}" y="37.6" text-anchor="middle"
          font-family="Inter,Segoe UI,system-ui,sans-serif" font-size="10.5" font-weight="800"
          fill="${body}">${infoCard.esc(text)}</text>
  </g>
</svg>`;
  return { url: svgUrl(svg), scaledSize: size(w, 46), anchor: point(15, 41), labelOrigin: point(15, 41) };
};

/** @deprecated The rate is drawn inside gateIcon() now — a Marker label is bare
 *  text with nothing behind it. Kept so an older caller does not crash. */
export const gateLabel = () => undefined;

/** A raw telemetry fix. Deliberately still a small dot: a ping is a place the
 *  lorry WAS, and it must never compete with the vehicle marker for attention. */
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
