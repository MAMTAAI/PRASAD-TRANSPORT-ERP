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

const dot = (fill, ring) => ({
  path: 0,                       // SymbolPath.CIRCLE
  fillColor: fill, fillOpacity: 1,
  strokeColor: ring, strokeWeight: 3, scale: 7,
});

const truckIcon = (heading = 0) => ({
  path: 'M -6 -4 L 6 -4 L 8 0 L 6 4 L -6 4 Z',
  fillColor: '#22d3ee', fillOpacity: 1,
  strokeColor: '#0a1024', strokeWeight: 1.5,
  rotation: heading, scale: 1.6, anchor: { x: 0, y: 0 },
});

export default function RouteMap({
  origin,            // { lat, lng, label } | null
  destination,       // { lat, lng, label } | null
  truck,             // { lat, lng, heading, label } | null — omit when no fix
  polyline,          // encoded overview polyline, optional
  height = 260,
  className = '',
  onStatus,          // (state) => void — 'ready' | 'nokey' | 'error'
  light = false,     // the driver app is a light screen (owner, 2026-09-03): plain Google styling, not the ERP's dark theme
}) {
  const box = useRef(null);
  const map = useRef(null);
  const marks = useRef({});
  const line = useRef(null);
  const [state, setState] = useState('loading');
  const [detail, setDetail] = useState('');

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

    put('origin', origin, dot('#2fe39b', '#064e3b'), origin?.label ?? 'Loading point');
    put('dest', destination, dot('#f472b6', '#500724'), destination?.label ?? 'Unloading point');
    put('truck', truck, truckIcon(truck?.heading ?? 0), truck?.label ?? 'Vehicle');

    if (polyline && g.maps.geometry?.encoding?.decodePath) {
      const path = g.maps.geometry.encoding.decodePath(polyline);
      if (path?.length) {
        if (line.current) line.current.setPath(path);
        else line.current = new g.maps.Polyline({
          map: map.current, path, strokeColor: '#22d3ee', strokeOpacity: 0.55, strokeWeight: 4, zIndex: 5,
        });
      }
    } else if (line.current) { line.current.setMap(null); line.current = null; }

    // Fit whatever actually exists. Fitting to a fixed box would zoom past a
    // short lane and cut a long one in half.
    const pts = [origin, destination, truck].filter((p) => p && Number.isFinite(Number(p.lat)));
    if (pts.length === 1) { map.current.setCenter({ lat: Number(pts[0].lat), lng: Number(pts[0].lng) }); map.current.setZoom(11); }
    else if (pts.length > 1) {
      const b = new g.maps.LatLngBounds();
      for (const p of pts) b.extend({ lat: Number(p.lat), lng: Number(p.lng) });
      map.current.fitBounds(b, 48);
    }
  }, [state, origin, destination, truck, polyline]);

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
