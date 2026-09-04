// @ts-nocheck
// ============================================================================
// <TripRouteMap /> — the trip lane on a REAL Google map.
//
// WHAT WAS WRONG (owner, 4-Sep-2026: "google map par show nahi ho rahi hay,
// yaha world ka map show ho rahi hay, zoom nahi ho rahi and clean route show
// nahi kar rahi hay").
//
// Route Tracking was an <iframe> pointing at
//
//     maps.google.com/maps?saddr=…&daddr=…&output=embed
//
// which is Google's LEGACY directions frame. It still loads — that is what made
// this so hard to see — and it renders the two search boxes with the right
// names already typed into them. It just does not compute the route. What is
// left on screen is a world map with a directions panel on top of it, no road,
// no zoom, no distance.
//
// The names were never the problem. Verified 4-Sep against the Directions API
// with the exact strings the old frame was showing:
//
//     Moinarband Depot, India → Agartala AFS 7A01, India
//     OK · 280 km · 8 h 4 min · via NH 208
//
// So the road exists and Google will hand it over the moment something asks
// properly. This component asks properly: DirectionsService through the Maps JS
// SDK, the road drawn as a polyline, and the camera fitted to the route's own
// bounds — which is the whole of "zoom nahi ho rahi", because an iframe that
// resolved nothing had nothing to fit to.
//
// ONE COMPONENT FOR ALL FOUR TABS. Full Route Plan, Live GPS, Driver Mobile and
// FASTag were three iframes and one real map, each with its own idea of where
// the lorry is. They are now one map with different pins switched on: the lane
// is always drawn, the truck appears when there is a real fix, the toll plazas
// appear when FASTag has seen the vehicle. Flipping a tab no longer throws the
// road away and starts again.
//
// NOTHING IS INVENTED. A truck with no fix is not drawn — not at the origin,
// not interpolated from "left at 9am". A marker that looks like a position IS a
// position to whoever is reading the screen, and dispatch decides whether a
// lorry is off route from this map.
//
// MAPS IS BILLED PER MAP LOAD, so the map is created once and mutated. The
// route itself is billed per request, so it is asked for once per lane and only
// re-asked when the lane changes — not when a GPS ping lands.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from './maps';
import { placeOf, routeAppUrl } from './tripPlaces';
import { plazasOnRoute, tollTotals } from './tollRoute.mjs';
import {
  loadingPin, unloadingPin, truckIcon, truckLabel,
  gateIcon, gateLabel, pingIcon, plazaKey, inr, infoCard, fitTo, observeAndRefit,
} from './mapSymbols.mjs';

// Night styling, matched to the ERP shell. Roads and water only: a dispatch map
// is read at a glance and POI pins, transit lines and business labels are noise
// competing with the one line that matters.
const DARK = [
  { elementType: 'geometry', stylers: [{ color: '#0a1024' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a1024' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6b80a8' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#1d2b52' }] },
  { featureType: 'administrative.country', elementType: 'labels.text.fill', stylers: [{ color: '#8ea3cc' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#101a35' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1b2748' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#233258' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c3f6d' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#4a628f' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050b16' }] },
];

// THE SYMBOLS ARE NOT DEFINED HERE ANY MORE.
//
// They were, and so were four other slightly different sets across the app —
// the dispatch board drew the loading point as a cyan dot, the tracking screen
// as a circle lettered "A", this file as a green teardrop, and amber meant
// "unloading" on one screen and "toll plaza" on another. A dispatcher who moves
// between two of these screens should not have to re-learn the map.
//
// One vocabulary now, in ./mapSymbols.mjs, imported by every map in the system
// including the driver's phone. Change a colour there and it changes everywhere.

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isPt = (p: any) => p && num(p.lat) !== null && num(p.lng) !== null;
const esc = infoCard.esc;

const kmText = (m: number | null) => (m == null ? null : `${Math.round(m / 1000)} km`);
const hmText = (s: number | null) => {
  if (s == null) return null;
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60);
  return h ? `${h} घं ${mins % 60} मि` : `${mins} मि`;
};
const etaText = (s: number | null) => {
  if (s == null) return null;
  const at = new Date(Date.now() + s * 1000);
  return at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
};

export default function TripRouteMap({
  origin,               // raw stored loading_point — "7D18", "MOINARBAND DEPOT (7D18)"
  destination,          // raw stored consignee / unloading_location
  truck = null,         // { lat, lng, heading?, at?, speed_kmh? } — REAL fixes only, else null
  trail = [],           // [{ lat, lng }] breadcrumbs from the driver app
  tolls = [],           // [{ lat, lng, plaza, datetime, amount }] FASTag crossings
  trip = null,          // { vehicle_no, driver_name, trip_code } — for the info windows
  height = '100%',
  focus = 'ROUTE',      // 'ROUTE' | 'TRUCK' — which one the camera opens on
  onRoute,              // (info) => void; parent gets km / duration once resolved
  plazaMaster = [],     // toll_plazas — every gate we know, with its rate
  roundTrip = true,     // oil company work returns; a market vehicle runs one side
  onGates,              // (gates, totals) => void — the parent draws the editable list
}) {
  const box = useRef(null);
  const map = useRef(null);
  const marks = useRef({});
  const tollMarks = useRef([]);
  const lines = useRef({ casing: null, main: null, trail: null });
  const info = useRef(null);
  const dash = useRef(null);

  const [phase, setPhase] = useState('loading');   // loading | ready | nokey | error
  const [detail, setDetail] = useState('');
  const [route, setRoute] = useState(null);        // { bounds, distance_m, duration_s, summary, start, end }
  const [routeErr, setRouteErr] = useState('');
  const [gates, setGates] = useState([]);         // toll gates this road passes
  const gateMarks = useRef([]);

  const a = placeOf(origin);
  const b = placeOf(destination);
  const appUrl = routeAppUrl(origin, destination);

  // WHY THESE TWO STRINGS EXIST. `tolls` and `trail` arrive as fresh array
  // literals on every render of the parent — `tolls={hasToll ? [toll] : []}` is
  // a new array each time even when the toll has not changed. Put an array in a
  // dependency list and the effect fires on EVERY parent render: the toll
  // markers were destroyed and rebuilt, and worse, the camera re-fitted. An
  // operator who panned across to look at a plaza had the map snap back under
  // them the next time any unrelated state in the trip screen ticked. Keying on
  // the coordinates instead means the effects fire when the POSITIONS change,
  // which is the only time they have anything to do.
  const tollKey = (tolls || []).map((t: any) => `${t?.lat},${t?.lng}`).join('|');
  const trailKey = `${(trail || []).length}:${(trail || []).at?.(-1)?.lat},${(trail || []).at?.(-1)?.lng}`;

  // ── the map itself: created once ──────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    loadGoogleMaps()
      .then((g) => {
        if (dead || !box.current) return;
        map.current = new g.maps.Map(box.current, {
          // Lower NH-27, where this fleet actually runs. A first frame has to be
          // somewhere; it should be somewhere the answer is likely to be, so the
          // fit that follows is a small move rather than a flight across a globe.
          center: { lat: 25.6, lng: 91.9 },
          zoom: 6,
          styles: DARK,
          backgroundColor: '#0a1024',
          disableDefaultUI: true,
          zoomControl: true,
          fullscreenControl: true,
          gestureHandling: 'greedy',   // a map inside a scrolling sheet
          clickableIcons: false,
        });
        info.current = new g.maps.InfoWindow();
        setPhase('ready');
      })
      .catch((e) => {
        if (dead) return;
        setPhase(/key/i.test(e?.message || '') ? 'nokey' : 'error');
        setDetail(e?.message || 'Map failed to load');
      });

    return () => {
      dead = true;
      clearInterval(dash.current);
      for (const m of Object.values(marks.current)) m?.setMap?.(null);
      marks.current = {};
      tollMarks.current.forEach((m) => m.setMap(null));
      tollMarks.current = [];
      gateMarks.current.forEach((m) => m.setMap(null));
      gateMarks.current = [];
      Object.values(lines.current).forEach((l) => l?.setMap?.(null));
      lines.current = { casing: null, main: null, trail: null };
      info.current?.close?.();
      map.current = null;
    };
  }, []);

  // ── the road ──────────────────────────────────────────────────────────────
  //
  // Asked for once per LANE. The old screen re-asked on every render and every
  // tab flip; Directions is billed per request and the road from Silchar to
  // Agartala is the same road it was ten seconds ago.
  useEffect(() => {
    if (phase !== 'ready' || !map.current) return;
    if (!a.query || !b.query) { setRoute(null); return; }
    let dead = false;
    const g = (window as any).google;
    const svc = new g.maps.DirectionsService();

    // Candidates, best first. The cleaned name is what usually works; the raw
    // stored string is the fallback for a place we have no rule for yet, and it
    // occasionally wins where the cleaning was too aggressive.
    const cand = (p: any, raw: unknown) => {
      const out = [p.query];
      const raws = String(raw ?? '').trim();
      if (raws && !out.includes(`${raws}, India`)) out.push(`${raws}, India`);
      return out;
    };
    const A = cand(a, origin);
    const B = cand(b, destination);

    const ask = (from: string, to: string) => new Promise((resolve) => {
      svc.route(
        {
          origin: from,
          destination: to,
          travelMode: g.maps.TravelMode.DRIVING,
          // WITHOUT THIS THE MAP LANDS IN SIBERIA. Depot names here are short,
          // abbreviated and locally unique — "Lumding", "Chabua", "NRL" — which
          // is exactly the shape that also matches something unrelated on the
          // other side of the planet. `region` biases the search to India.
          region: 'in',
          // Freight reality: these trucks are not routed onto ferries.
          avoidFerries: true,
        },
        (res: any, status: string) => resolve(status === 'OK' && res ? res : null),
      );
    });

    (async () => {
      let res = null;
      for (const from of A) {
        for (const to of B) {
          res = await ask(from, to);
          if (res || dead) break;
        }
        if (res || dead) break;
      }
      if (dead || !map.current) return;

      if (!res) {
        setRoute(null);
        setRouteErr('Google is unable to find a road route between these two names.');
        onRoute?.(null);
        return;
      }
      setRouteErr('');

      const r = res.routes[0];
      const leg = r.legs?.[0] ?? {};
      const path = r.overview_path || [];

      // Casing under the line. One flat stroke on a dark basemap disappears
      // wherever it crosses a highway drawn in a similar blue; the darker,
      // wider stroke beneath is what makes the lane readable at every zoom.
      const draw = (key: string, opts: any) => {
        if (lines.current[key]) lines.current[key].setOptions(opts);
        else lines.current[key] = new g.maps.Polyline({ map: map.current, ...opts });
      };
      draw('casing', { path, strokeColor: '#083344', strokeOpacity: 1, strokeWeight: 11, zIndex: 3 });
      draw('main', { path, strokeColor: '#22d3ee', strokeOpacity: 1, strokeWeight: 5, zIndex: 4 });

      // The direction of travel, said without words: white chevrons crawling
      // from the loading end towards the unloading end.
      clearInterval(dash.current);
      const arrow = {
        // SymbolPath.FORWARD_CLOSED_ARROW. Filled, not outlined: an unfilled
        // arrow on a navy basemap reads as a smudge on the line rather than as
        // a direction.
        icon: { path: 1, scale: 2.8, fillColor: '#eaf9ff', fillOpacity: 1, strokeColor: '#083344', strokeWeight: 1 },
        offset: '0%',
        repeat: '110px',
      };
      lines.current.main.setOptions({ icons: [arrow] });
      let off = 0;
      dash.current = setInterval(() => {
        if (!lines.current.main) return;
        off = (off + 2) % 100;
        const ic = lines.current.main.get('icons');
        if (!ic?.[0]) return;
        ic[0].offset = `${off}%`;
        lines.current.main.set('icons', ic);
      }, 90);

      const summary = {
        bounds: r.bounds,
        // Kept so the toll match runs against the ROAD, not a straight line
        // between the depots. Plain {lat,lng} rather than Google's LatLng, so
        // tollRoute.mjs stays free of the Maps SDK and testable in node.
        path: path.map((pt: any) => ({ lat: pt.lat(), lng: pt.lng() })),
        distance_m: leg.distance?.value ?? null,
        duration_s: leg.duration?.value ?? null,
        via: r.summary || null,
        start: leg.start_address || null,
        end: leg.end_address || null,
        start_loc: leg.start_location ? { lat: leg.start_location.lat(), lng: leg.start_location.lng() } : null,
        end_loc: leg.end_location ? { lat: leg.end_location.lat(), lng: leg.end_location.lng() } : null,
      };
      setRoute(summary);
      onRoute?.(summary);
    })();

    return () => { dead = true; };
    // Deliberately NOT keyed on truck/tolls: a ping must not re-bill the road.
  }, [phase, origin, destination]);

  // ── pins ──────────────────────────────────────────────────────────────────
  // Moved, never recreated. A new Marker per render leaks and makes the lorry
  // flicker every time a fix lands.
  useEffect(() => {
    if (phase !== 'ready' || !map.current) return;
    const g = (window as any).google;

    const put = (key: string, pt: any, icon: any, title: string, html: string, z: number) => {
      if (!isPt(pt)) { marks.current[key]?.setMap(null); delete marks.current[key]; return; }
      const pos = { lat: num(pt.lat), lng: num(pt.lng) };
      let m = marks.current[key];
      if (m) { m.setPosition(pos); m.setIcon(icon); }
      else {
        m = new g.maps.Marker({ map: map.current, position: pos, icon, title, zIndex: z });
        marks.current[key] = m;
      }
      g.maps.event.clearInstanceListeners(m);
      m.addListener('click', () => { info.current.setContent(html); info.current.open(map.current, m); });
      return m;
    };
    const putLabelled = (key: string, pt: any, icon: any, label: any, title: string, html: string, z: number) => {
      const m = put(key, pt, icon, title, html, z);
      m?.setLabel?.(label ?? null);
    };

    const card = infoCard;

    put('origin', route?.start_loc, loadingPin(), `Loading: ${a.label}`,
      card('🟢 Loading Point', '#047857', [
        `<b>${esc(a.label)}</b>`,
        route?.start ? `<span style="color:#475569">${esc(route.start)}</span>` : '',
      ]), 20);

    put('dest', route?.end_loc, unloadingPin(), `Unloading: ${b.label}`,
      card('🔴 Unloading Point', '#be185d', [
        `<b>${esc(b.label)}</b>`,
        route?.end ? `<span style="color:#475569">${esc(route.end)}</span>` : '',
      ]), 20);

    // THE LORRY WEARS ITS NUMBER. "kaha vehicle and driver run kar rahay hay" is
    // not answerable by an unlabelled arrow on a board with eighteen trucks.
    putLabelled('truck', truck, truckIcon(truck?.heading), truckLabel(trip?.vehicle_no),
      `${trip?.vehicle_no || 'Vehicle'}`,
      card('🚚 ' + esc(trip?.vehicle_no || 'Vehicle'), '#0e7490', [
        trip?.driver_name ? `Driver: <b>${esc(trip.driver_name)}</b>` : '',
        trip?.trip_code ? `Trip: ${esc(trip.trip_code)}` : '',
        truck?.speed_kmh != null ? `Speed: <b>${Math.round(Number(truck.speed_kmh))} km/h</b>` : '',
        truck?.at ? `<span style="color:#475569">Last fix: ${esc(new Date(truck.at).toLocaleString('en-IN'))}</span>` : '',
      ]), 40);

    // FASTag crossings. Amber, numbered in the order they were crossed, so the
    // map shows how far along the lane the lorry actually got when nothing else
    // is reporting.
    //
    // A CROSSING AT A GATE WE ALREADY DREW IS NOT DRAWN TWICE. The gate turns
    // green and says "cross ho chuka" — stacking a second marker on the same
    // point just hides the rate underneath it, which is the one thing the gate
    // was put there to show.
    const drawnGates = new Set(gates.map((x: any) => x.name_key || plazaKey(x.plaza_name)));
    tollMarks.current.forEach((m) => m.setMap(null));
    tollMarks.current = (tolls || [])
      .filter((t: any) => isPt(t) && !drawnGates.has(plazaKey(t.plaza)))
      .map((t: any, i: number) => {
      const m = new g.maps.Marker({
        map: map.current,
        position: { lat: num(t.lat), lng: num(t.lng) },
        icon: pingIcon('#ffb224'),
        label: { text: String(i + 1), color: '#3b2606', fontSize: '10px', fontWeight: '800' },
        title: `Toll: ${t.plaza || 'Plaza'}`,
        zIndex: 30,
      });
      m.addListener('click', () => {
        info.current.setContent(card('🛣️ ' + esc(t.plaza || 'Toll Plaza'), '#b45309', [
          t.datetime ? `Crossed <b>${esc(new Date(t.datetime).toLocaleString('en-IN'))}</b>` : '',
          t.amount ? `Toll ₹${esc(t.amount)}` : '',
          t.vehicle ? `<span style="color:#475569">${esc(t.vehicle)}</span>` : '',
        ]));
        info.current.open(map.current, m);
      });
      return m;
    });

    // Where the lorry has actually been, as reported. Dotted, so nobody reads
    // a straight hop between two distant pings as a road.
    const pts = (trail || []).filter(isPt).map((p: any) => ({ lat: num(p.lat), lng: num(p.lng) }));
    if (pts.length > 1) {
      const opts = {
        path: pts, strokeOpacity: 0, zIndex: 6,
        icons: [{ icon: { path: 0, scale: 2.2, fillColor: '#2fe39b', fillOpacity: 0.9, strokeWeight: 0 }, offset: '0', repeat: '14px' }],
      };
      if (lines.current.trail) lines.current.trail.setOptions(opts);
      else lines.current.trail = new g.maps.Polyline({ map: map.current, ...opts });
    } else if (lines.current.trail) { lines.current.trail.setMap(null); lines.current.trail = null; }
  }, [phase, route, truck?.lat, truck?.lng, truck?.heading, truck?.speed_kmh, truck?.at,
      tollKey, trailKey, trip?.vehicle_no, trip?.driver_name, trip?.trip_code, a.label, b.label,
      gates]);
  // The lists themselves are deliberately absent from that array — see tollKey
  // / trailKey above. exhaustive-deps wants `tolls`, `trail` and `truck`; adding
  // them is what re-created every marker on every parent render.


  // ── TOLL GATES ────────────────────────────────────────────────────────────
  //
  // Owner, 4-Sep: "trip route may toll gate and toll rate ... total trip par
  // kitna toll tax lag rahi hay yah map may show karay."
  //
  // The gates come from toll_plazas, which the database learns from this
  // fleet's own FASTag crossings — so every rate drawn here is one our trucks
  // have actually been charged at that gate, not a published tariff. A gate we
  // have never paid at is not on the map, and the strip below says how many
  // are unpriced rather than quietly leaving them out of the total.
  const tollKeys = (tolls || []).map((t: any) => plazaKey(t?.plaza)).filter(Boolean);

  useEffect(() => {
    if (phase !== 'ready' || !map.current) return;
    const g = (window as any).google;

    const found = route?.path ? plazasOnRoute(route.path, plazaMaster || []) : [];
    // Which of them this lorry has already been through, per FASTag.
    const crossed = new Set(tollKeys);
    const marked = found.map((x: any) => ({
      ...x,
      crossed: crossed.has(x.name_key || plazaKey(x.plaza_name)),
    }));

    gateMarks.current.forEach((m: any) => m.setMap(null));
    gateMarks.current = marked.map((gate: any, i: number) => {
      const known = gate.rate !== null && gate.rate !== undefined && gate.rate !== '';
      const m = new g.maps.Marker({
        map: map.current,
        position: { lat: Number(gate.lat), lng: Number(gate.lng) },
        icon: gateIcon(gate.crossed, known),
        // The rate ON the gate. This is the whole ask: an operator should read
        // the toll off the map without opening anything.
        label: gateLabel(gate.rate),
        title: `${i + 1}. ${gate.plaza_name}`,
        zIndex: 25,
      });
      m.addListener('click', () => {
        info.current.setContent(`
          <div style="font-family:Inter,system-ui,sans-serif;color:#0f172a;min-width:190px;max-width:260px">
            <div style="font-weight:800;font-size:13px;color:#b45309">🛣️ ${esc(gate.plaza_name)}</div>
            <div style="font-size:12px;margin-top:2px">
              ${known ? `Ek baar ka rate: <b>${inr(Number(gate.rate))}</b>` : '<b style="color:#b45309">Rate system mein nahi hai</b>'}
            </div>
            ${known ? `<div style="font-size:11px;color:#475569">${
              gate.rate_source === 'MANUAL'
                ? 'Haath se bhara gaya rate'
                : `Apni FASTag history se · ${gate.observations || 0} baar${
                    gate.rate_min != null && gate.rate_max != null && Number(gate.rate_min) !== Number(gate.rate_max)
                      ? ` · ${inr(Number(gate.rate_min))}–${inr(Number(gate.rate_max))}` : ''}`
            }</div>` : ''}
            <div style="font-size:11px;color:${gate.crossed ? '#047857' : '#475569'};margin-top:3px">
              ${gate.crossed ? '✅ Is trip par cross ho chuka' : '⏳ Abhi cross nahi hua'}
            </div>
            <div style="font-size:10px;color:#94a3b8;margin-top:3px">Road se ${gate.distance_m} m</div>
          </div>`);
        info.current.open(map.current, m);
      });
      return m;
    });

    setGates(marked);
    onGates?.(marked, tollTotals(marked, { roundTrip }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, route, plazaMaster, roundTrip, tollKeys.join('|')]);

  // ── the camera ────────────────────────────────────────────────────────────
  // THIS IS "zoom nahi ho rahi". The old frame never resolved anything, so
  // there was nothing to fit to and it sat on the world. Fit whatever actually
  // exists: the whole lane, or — when the point is the lorry — the lorry.
  const fit = useCallback(() => {
    if (!map.current) return;
    const g = (window as any).google;

    if (focus === 'TRUCK' && isPt(truck)) {
      map.current.setCenter({ lat: num(truck.lat), lng: num(truck.lng) });
      map.current.setZoom(12);
      return;
    }
    // The road itself, not just its ends — a lane that bows out is drawn half
    // outside a box fitted to the two depots.
    const pts = [...(route?.path ?? [])];
    for (const p of [truck, ...(tolls || [])]) if (isPt(p)) pts.push({ lat: num(p.lat), lng: num(p.lng) });
    if (!pts.length && route?.bounds) {
      const b = new g.maps.LatLngBounds();
      b.union(route.bounds);
      map.current.fitBounds(b, 56);
      return;
    }
    fitTo(map.current, pts, { padding: 56, maxZoom: 13 });
  }, [focus, route, truck?.lat, truck?.lng, tollKey]);

  useEffect(() => { if (phase === 'ready') fit(); }, [phase, fit]);

  // AND AGAIN WHEN THE BOX CHANGES SIZE. This map opens inside a BottomSheet
  // that animates from nothing to full height, and on a phone it survives a
  // rotation. Google keeps the CENTRE and the ZOOM when its container resizes,
  // so a fit computed against a 40px-tall sheet mid-animation leaves the lane
  // framed for a box that no longer exists — the route ends up half off screen,
  // or a hair's width in the middle of a continent. Re-fitting on resize is the
  // difference between "it works" and "it works after you tap the button".
  //
  // Debounced through rAF: a sheet animation fires this on every frame.
  useEffect(() => {
    if (phase !== 'ready') return;
    return observeAndRefit(box.current, fit);
  }, [phase, fit]);

  // ── the surface ───────────────────────────────────────────────────────────
  const dist = kmText(route?.distance_m ?? null);
  const dur = hmText(route?.duration_s ?? null);
  const eta = etaText(route?.duration_s ?? null);
  const unplaceable = !a.query || !b.query;
  const toll = tollTotals(gates, { roundTrip });

  return (
    <div style={{ position: 'relative', width: '100%', height, background: '#0a1024', overflow: 'hidden' }}>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />

      {/* THE HEADER STRIP — the three numbers an operator asks for before they
          look at the road at all. Uber puts them here for the same reason. */}
      {phase === 'ready' && route && (
        <div style={{
          position: 'absolute', top: 10, left: 10, right: 10, zIndex: 5, pointerEvents: 'none',
          display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap',
        }}>
          <div style={{
            background: 'rgba(10,16,36,0.92)', border: '1px solid rgba(34,211,238,0.35)', borderRadius: 12,
            padding: '8px 12px', backdropFilter: 'blur(6px)', boxShadow: '0 6px 22px rgba(0,0,0,0.45)', maxWidth: '100%',
          }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              {dist && <b style={{ color: '#22d3ee', fontSize: 17, letterSpacing: '.2px' }}>{dist}</b>}
              {dur && <span style={{ color: '#dde5f4', fontSize: 13, fontWeight: 700 }}>{dur}</span>}
              {eta && <span style={{ color: '#9aadd4', fontSize: 12 }}>पहुँच ~{eta}</span>}
              {route.via && <span style={{ color: '#5d7196', fontSize: 12 }}>via {route.via}</span>}
            </div>
            <div style={{ color: '#8ea3cc', fontSize: 11.5, marginTop: 3, lineHeight: 1.45 }}>
              <span style={{ color: '#2fe39b' }}>●</span> {a.label}
              <span style={{ color: '#3d548a' }}> → </span>
              <span style={{ color: '#f472b6' }}>●</span> {b.label}
            </div>

            {/* THE TOLL, ON THE MAP. One way and the return are shown SEPARATELY
                and both are labelled, because the difference between them is the
                owner's whole point: an oil-company lorry comes back and pays
                again, a market vehicle does not. The estimate says out loud when
                it is short — a gate with no known rate is counted as a gate and
                not as zero rupees. */}
            {toll.gates > 0 && (
              <div style={{
                marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)',
                display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12,
              }}>
                <span style={{ color: '#ffb224', fontWeight: 800 }}>🛣️ {toll.gates} गेट</span>
                <span style={{ color: '#dde5f4' }}>एक तरफ़ <b style={{ color: '#ffb224' }}>{inr(toll.one_way)}</b></span>
                {roundTrip && (
                  <span style={{ color: '#dde5f4' }}>
                    आना-जाना <b style={{ color: '#ffb224', fontSize: 13 }}>{inr(toll.total)}</b>
                  </span>
                )}
                <span style={{
                  color: roundTrip ? '#2fe39b' : '#a78bfa', fontSize: 10.5, fontWeight: 700,
                  border: `1px solid ${roundTrip ? 'rgba(47,227,155,.4)' : 'rgba(167,139,250,.4)'}`,
                  borderRadius: 6, padding: '1px 6px',
                }}>{roundTrip ? 'ROUND TRIP' : 'ONE WAY'}</span>
                {toll.incomplete && (
                  <span style={{ color: '#ff9b9b', fontSize: 11 }}>
                    · {toll.unknown} गेट का rate system में नहीं — असली toll इससे ज़्यादा है
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls. Re-fit is here because a person who has panned away to look
          at a toll plaza needs one tap back to the whole lane. */}
      {phase === 'ready' && (
        <div style={{ position: 'absolute', bottom: 12, left: 10, zIndex: 5, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={fit} style={{
            background: 'rgba(10,16,36,0.92)', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.4)',
            borderRadius: 10, padding: '8px 12px', fontWeight: 800, fontSize: 12, cursor: 'pointer', backdropFilter: 'blur(6px)',
          }}>🎯 पूरा रूट</button>
          {isPt(truck) && (
            <button onClick={() => { map.current?.setCenter({ lat: num(truck.lat), lng: num(truck.lng) }); map.current?.setZoom(13); }} style={{
              background: 'rgba(10,16,36,0.92)', color: '#2fe39b', border: '1px solid rgba(47,227,155,0.4)',
              borderRadius: 10, padding: '8px 12px', fontWeight: 800, fontSize: 12, cursor: 'pointer', backdropFilter: 'blur(6px)',
            }}>🚚 गाड़ी पर</button>
          )}
          {appUrl && (
            <a href={appUrl} target="_blank" rel="noopener noreferrer" style={{
              background: '#2563eb', color: 'white', border: 'none', textDecoration: 'none',
              borderRadius: 10, padding: '8px 12px', fontWeight: 800, fontSize: 12,
            }}>🗺️ Google Maps</a>
          )}
        </div>
      )}

      {/* Said out loud. A lane with both ends pinned and nothing moving on it
          looks exactly like a lorry that has not left the depot. */}
      {phase === 'ready' && route && !isPt(truck) && (
        <div style={{
          position: 'absolute', right: 10, bottom: 12, zIndex: 5, maxWidth: 230, pointerEvents: 'none',
          background: 'rgba(10,16,36,0.92)', border: '1px solid rgba(255,178,36,0.3)', borderRadius: 10,
          padding: '7px 10px', color: '#ffd79a', fontSize: 11, lineHeight: 1.45, backdropFilter: 'blur(6px)',
        }}>
          रास्ता बन गया — गाड़ी की live location अभी नहीं आ रही, इसलिए truck का pin नहीं लगाया.
        </div>
      )}

      {phase === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#22d3ee', fontWeight: 700, fontSize: 13 }}>
          🗺️ नक्शा खुल रहा है…
        </div>
      )}

      {(phase === 'nokey' || phase === 'error') && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <div>
            <div style={{ fontSize: 32 }}>🗺️</div>
            <div style={{ color: '#ffb224', fontWeight: 800, fontSize: 14, marginTop: 6 }}>
              {phase === 'nokey' ? 'Map key set nahi hai' : 'Map load nahi hua'}
            </div>
            <div style={{ color: '#9aadd4', fontSize: 12, marginTop: 4 }}>{detail}</div>
          </div>
        </div>
      )}

      {/* The two honest failures, kept apart on purpose: a name we refuse to
          guess at, and a pair Google itself cannot join by road. They need
          different things done about them. */}
      {phase === 'ready' && (unplaceable || (routeErr && !route)) && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24,
          textAlign: 'center', background: 'rgba(10,16,36,0.9)',
        }}>
          <div style={{ maxWidth: 430 }}>
            <div style={{ fontSize: 32 }}>🗺️</div>
            <div style={{ color: '#ffb224', fontWeight: 800, fontSize: 15, margin: '8px 0' }}>
              Is trip ka route map par nahi dikha sakte
            </div>
            <div style={{ color: '#9aadd4', fontSize: 13, lineHeight: 1.65 }}>
              {a.unresolved && <>Loading point <b style={{ color: '#dde5f4' }}>{a.label}</b> ek IOCL code hai jiska naam system mein kahin nahi hai.<br /></>}
              {b.unresolved && <>Destination <b style={{ color: '#dde5f4' }}>{b.label}</b> ka naam system mein nahi hai.<br /></>}
              {!a.query && !a.unresolved && <>Is trip par loading ki jagah bhari hi nahi gayi.<br /></>}
              {!b.query && !b.unresolved && <>Is trip par unloading ki jagah bhari hi nahi gayi.<br /></>}
              {!unplaceable && <>{a.label} <span style={{ color: '#22d3ee' }}>→</span> {b.label}<br />{routeErr}<br /></>}
              Galat jagah ka pin dikhane se behtar hai ki kuch na dikhayein — naam theek karte hi map apne aap aa jayega.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
