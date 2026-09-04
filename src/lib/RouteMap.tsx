// @ts-nocheck
// ============================================================================
// <RouteMap /> — one dark map, used by the driver app, the customer portal and
// the load bazaar.
//
// ONE COMPONENT, NOT THREE. The alternative was a map per portal, which is how
// three subtly different dark themes and three different ideas of "where is the
// truck" end up in one product. The differences between the callers are props.
//
// A TRUCK WITH NO FIX IS NOT DRAWN. Same rule the dispatch board already
// follows: `truck` is only rendered when it carries real coordinates. Dropping
// a marker at the origin "for now" produces a map that says the lorry is
// sitting at the refinery when nobody knows where it is — and once it is on the
// screen there is no way to tell it from a real position.
//
// MAPS IS BILLED PER MAP LOAD, so this mounts one map and mutates it. Remounting
// on every prop change would bill a fresh load each time a truck moved.
// ============================================================================
import React, { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from './maps';
import {
  loadingPin, unloadingPin, truckIcon, truckLabel,
  gateIcon, plazaKey, inr, infoCard, fitTo, observeAndRefit,
} from './mapSymbols.mjs';
import { loadTollPlazas } from './tollPlazaMaster';
import { plazasOnRoute, tollTotals } from './tollRoute.mjs';

// Minimal night styling. Roads and water only — a dispatch map is read at a
// glance, and POI pins, transit lines and business labels are noise competing
// with the one thing that matters.
const DARK = [
  { elementType: 'geometry', stylers: [{ color: '#0a1024' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a1024' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5d7196' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#18244a' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#18244a' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#27395f' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#3d548a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050b16' }] },
];

// The symbols are shared with every other map in the system now — a driver
// looking at his phone and a dispatcher looking at the board see the same green
// teardrop for the same loading point. See ./mapSymbols.mjs.

export default function RouteMap({
  origin,            // { lat, lng, label } | null
  destination,       // { lat, lng, label } | null
  truck,             // { lat, lng, heading, label } | null — omit when no fix
  polyline,          // encoded overview polyline, optional
  height = 260,
  className = '',
  onStatus,          // (state) => void — 'ready' | 'nokey' | 'error'
  light = false,     // the driver app is a light screen (owner, 2026-09-03): plain Google styling, not the ERP's dark theme
  vehicleNo,         // drawn as a plate under the lorry — "kaha vehicle chal rahi hai"
  crossedTolls = [], // [{ plaza_name }] the gates FASTag says are already behind
  roundTrip = true,  // oil company work returns and pays twice; a market vehicle does not
  showTolls = true,  // the bazaar's lane-preview map has no trip, so no gates
  onToll,            // (totals) => void — the phone shows the figure in its own strip
}) {
  const box = useRef(null);
  const map = useRef(null);
  const marks = useRef({});
  const line = useRef(null);
  const [state, setState] = useState('loading');
  const [detail, setDetail] = useState('');
  const gateMarks = useRef([]);
  const info = useRef(null);
  const refit = useRef(null);
  const [plazas, setPlazas] = useState([]);

  // ── WHY EVERY DEPENDENCY BELOW IS A STRING ───────────────────────────────
  //
  // `origin`, `destination`, `truck` and `crossedTolls` are object and array
  // literals built fresh by the parent on every render — `origin={geo?.origin}`
  // is stable, but `truck={{ lat, lng }}` and `crossedTolls={geo?.tolls ?? []}`
  // are not. With those identities in the dependency list the marker effect
  // re-ran on every parent render, which was survivable until `onToll` was
  // added: the effect then called back into the parent, the parent set state,
  // and React re-rendered into the same effect. "Maximum update depth
  // exceeded", several hundred times a second, on the DRIVER'S PHONE.
  //
  // Caught in the browser before release. Keying on the CONTENT means the
  // effect runs when a coordinate actually changes, which is the only time it
  // has anything to do.
  const ptKey = (p) => (p && Number.isFinite(Number(p.lat)) ? `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}` : '-');
  const originKey = ptKey(origin);
  const destKey = ptKey(destination);
  // Rounded to 3°: the lorry's icon is an SVG rebuilt per heading, and a truck
  // on a straight highway reports a heading that wanders by a degree at a time.
  const truckKey = `${ptKey(truck)}@${Math.round((Number(truck?.heading) || 0) / 3) * 3}`;
  const crossedKey = (crossedTolls || [])
    .map((t) => plazaKey(t?.plaza_name ?? t?.plaza ?? t)).join('|');
  const tollSent = useRef('');

  // One fetch per page, shared with every other map on it. A driver's phone on
  // a weak connection must not pay for this twice.
  useEffect(() => {
    if (!showTolls) return;
    let dead = false;
    loadTollPlazas().then((list) => { if (!dead) setPlazas(list); });
    return () => { dead = true; };
  }, [showTolls]);

  useEffect(() => {
    let dead = false;
    loadGoogleMaps()
      .then(() => {
        if (dead || !box.current) return;
        const g = window.google;
        map.current = new g.maps.Map(box.current, {
          center: { lat: 26.35, lng: 91.15 },      // lower NH-27, where the fleet runs
          zoom: 7,
          styles: light ? [] : DARK,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'greedy',   // a phone map inside a scrolling page
          backgroundColor: light ? '#e8efe3' : '#0a1024',
        });
        setState('ready'); onStatus?.('ready');
      })
      .catch((e) => {
        if (dead) return;
        const nokey = /key/i.test(e.message);
        setState(nokey ? 'nokey' : 'error');
        setDetail(e.message);
        onStatus?.(nokey ? 'nokey' : 'error');
      });
    return () => {
      dead = true;
      for (const m of Object.values(marks.current)) m?.setMap?.(null);
      marks.current = {};
      gateMarks.current.forEach((m) => m?.setMap?.(null));
      gateMarks.current = [];
      info.current?.close?.();
      info.current = null;
      line.current?.setMap?.(null);
      line.current = null;
      map.current = null;
    };
  }, [onStatus]);

  // Markers are moved, never recreated — a new Marker per render is a leak and
  // makes the truck flicker every time a ping lands.
  useEffect(() => {
    if (state !== 'ready' || !map.current) return;
    const g = window.google;
    const put = (key, pt, icon, title) => {
      if (!pt || !Number.isFinite(Number(pt.lat)) || !Number.isFinite(Number(pt.lng))) {
        marks.current[key]?.setMap(null);
        delete marks.current[key];
        return;
      }
      const pos = { lat: Number(pt.lat), lng: Number(pt.lng) };
      if (marks.current[key]) {
        marks.current[key].setPosition(pos);
        marks.current[key].setIcon(icon);
      } else {
        marks.current[key] = new g.maps.Marker({ map: map.current, position: pos, icon, title, zIndex: key === 'truck' ? 30 : 10 });
      }
    };

    put('origin', origin, loadingPin(), origin?.label ?? 'Loading point');
    put('dest', destination, unloadingPin(), destination?.label ?? 'Unloading point');
    put('truck', truck, truckIcon(truck?.heading ?? 0), truck?.label ?? 'Vehicle');
    // The registration under the arrow. On the driver's own phone it confirms
    // he is looking at HIS lorry; on a partner's phone, which of his.
    marks.current.truck?.setLabel?.(truckLabel(vehicleNo ?? truck?.label) ?? null);

    let path = null;
    if (polyline && g.maps.geometry?.encoding?.decodePath) {
      path = g.maps.geometry.encoding.decodePath(polyline);
      if (path?.length) {
        if (line.current) line.current.setPath(path);
        else line.current = new g.maps.Polyline({
          map: map.current, path, strokeColor: '#22d3ee', strokeOpacity: 0.55, strokeWeight: 4, zIndex: 5,
        });
      }
    } else if (line.current) { line.current.setMap(null); line.current = null; }

    // Fit whatever actually exists. Fitting to a fixed box would zoom past a
    // short lane and cut a long one in half.
    //
    // THE ROAD IS PART OF "WHAT EXISTS". Fitting to the three points alone
    // frames the straight line between the depots, and a road that bows out —
    // Silchar to Agartala goes the long way round the hills — is then drawn
    // half outside the viewport. Extending along the decoded path costs one
    // pass over points we have already decoded.
    // ── TOLL GATES, ON THE PHONE TOO ───────────────────────────────────────
    //
    // Owner, 4-Sep: "har modal par and mobil aap par vi". A driver who can see
    // which plaza is next and what it costs does not have to ring the office to
    // ask, and a customer looking at his consignment can see what the lane
    // actually carries. Same pills, same rates, same green-once-crossed rule as
    // the dispatch board — the rates are what OUR trucks have really paid.
    //
    // Matched against the ROAD, not the two endpoints, so a plaza on the
    // parallel highway is never billed to this lane.
    const asPts = (path ?? []).map((pt) => ({ lat: pt.lat(), lng: pt.lng() }));
    const gates = (showTolls && asPts.length > 1) ? plazasOnRoute(asPts, plazas) : [];
    const crossed = new Set((crossedTolls || []).map((t) => plazaKey(t?.plaza_name ?? t?.plaza ?? t)));

    gateMarks.current.forEach((m) => m.setMap(null));
    gateMarks.current = gates.map((gate) => {
      const known = gate.rate !== null && gate.rate !== undefined && gate.rate !== '';
      const done = crossed.has(gate.name_key);
      const m = new g.maps.Marker({
        map: map.current,
        position: { lat: Number(gate.lat), lng: Number(gate.lng) },
        icon: gateIcon(done, known, gate.rate),
        title: gate.plaza_name,
        zIndex: 25,
      });
      m.addListener('click', () => {
        if (!info.current) info.current = new g.maps.InfoWindow();
        info.current.setContent(infoCard(`🛣️ ${infoCard.esc(gate.plaza_name)}`, '#b45309', [
          known ? `Ek baar ka rate: <b>${inr(gate.rate)}</b>` : '<b style="color:#b45309">Rate abhi pata nahi</b>',
          done ? '✅ Cross ho chuka' : '⏳ Aage padega',
        ]));
        info.current.open(map.current, m);
      });
      return m;
    });
    // Emitted only when the numbers move. A callback that fires on every render
    // is a loop waiting for a parent that stores what it receives.
    const totals = tollTotals(gates, { roundTrip });
    const sig = JSON.stringify(totals);
    if (sig !== tollSent.current) { tollSent.current = sig; onToll?.(totals); }

    // Fit whatever actually exists. Fitting to a fixed box would zoom past a
    // short lane and cut a long one in half.
    //
    // THE ROAD IS PART OF "WHAT EXISTS". Fitting to the three points alone
    // frames the straight line between the depots, and a road that bows out —
    // Silchar to Agartala goes the long way round the hills — is then drawn
    // half outside the viewport. The gates go in too: a plaza just past the
    // destination belongs inside the frame that is meant to explain it.
    const pts = [origin, destination, truck].filter((p) => p && Number.isFinite(Number(p.lat)))
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    for (const gate of gates) pts.push({ lat: Number(gate.lat), lng: Number(gate.lng) });

    // Kept callable: a phone map lives inside a scrolling sheet that settles
    // after the first paint, and Google holds centre and zoom when its box
    // changes size. Fitting once is how a correct route ends up framed for a
    // container that no longer exists.
    refit.current = () => fitTo(map.current, [...asPts, ...pts], { padding: 48, maxZoom: 13 });
    refit.current();
    // `crossedTolls` and `plazas` are arrays the parent rebuilds each render, so
    // they are keyed on content — an array identity in this list would rebuild
    // every marker on every parent render and make the lorry flicker.
  }, [state, originKey, destKey, truckKey, polyline, vehicleNo, roundTrip, showTolls,
      plazas, crossedKey]);

  // Re-fit when the box changes size — a rotation, a sheet opening, a keyboard
  // appearing under a phone map.
  useEffect(() => {
    if (state !== 'ready') return;
    return observeAndRefit(box.current, () => refit.current?.());
  }, [state]);

  return (
    <div className={`relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0a1024] ${className}`}
         style={{ height }}>
      <div ref={box} className="absolute inset-0" />

      {state !== 'ready' && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          {state === 'loading' && (
            // Skeleton in the map's own shape rather than a spinner.
            <div className="w-full">
              <div className="h-full w-full animate-pulse rounded-2xl bg-white/[0.03]" style={{ height: height - 32 }} />
            </div>
          )}
          {state === 'nokey' && (
            <div>
              <p className="text-[12.5px] font-bold text-amber-300">Map key not configured</p>
              <p className="mt-1 text-[11px] leading-relaxed text-white/35">
                Set VITE_GOOGLE_MAPS_API_KEY and rebuild. Everything else on this screen still works.
              </p>
            </div>
          )}
          {state === 'error' && (
            <div>
              <p className="text-[12.5px] font-bold text-amber-300">Map unavailable</p>
              <p className="mt-1 text-[11px] text-white/35">{detail}</p>
            </div>
          )}
        </div>
      )}

      {state === 'ready' && !truck && (
        // Said out loud, because an origin and a destination with nothing
        // between them looks like a truck that has not moved.
        <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl border border-amber-400/25
                        bg-[#0a1024]/90 px-3 py-2 backdrop-blur-sm">
          <p className="text-[10.5px] leading-snug text-amber-200/80">
            No GPS fix for this vehicle yet — the lane is drawn, the truck is not placed.
          </p>
        </div>
      )}
    </div>
  );
}
