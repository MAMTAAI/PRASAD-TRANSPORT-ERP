// @ts-nocheck
// ============================================================================
// <LiveFleetMap /> — the dispatch board on real Google Maps.
//
// Replaces the decorative SVG of India with the actual Maps SDK: real tiles,
// the live TrafficLayer, one marker per truck that has a position, and the
// route polyline behind it.
//
// THE ONE RULE THIS FILE IS BUILT AROUND: a truck with no GPS fix is NOT drawn.
//
// GET /api/v1/tracking returns every moving trip with its latest ping, and
// `lat`/`lng` are null for any truck that has never reported. It would be easy
// — and it would look far more impressive — to scatter those across Assam at
// plausible coordinates. It would also be fiction that dispatch would act on,
// and there is no way to tell an invented marker from a real one once it is on
// the map. Trucks without a fix are counted in a plain "awaiting first fix"
// line instead, which is the honest and more useful signal: it says the devices
// are not reporting.
//
// SMOOTH MOVEMENT (the Ola/Uber feel) is interpolation between two REAL fixes,
// not motion invented to make a stationary marker look alive. A marker only
// animates when a newer ping actually moves it.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Satellite, AlertTriangle, MapPin, Navigation, Wifi } from 'lucide-react';
import { GlassPanel, PanelHeader, StatusPill } from './shared';
import { loadGoogleMaps } from '../lib/maps';
import { API_BASE } from '../lib/apiBase';
import { getRoute } from '../lib/mapsCache';
import { connectFleetSocket, disconnectFleetSocket } from '../lib/fleetSocket';

// The poll rate follows whether the live push is actually working.
//
// When the socket is up it only has to reconcile the trip LIST (new trips,
// settled trips) because movement arrives instantly — 60s is plenty. When the
// socket is down the poll IS the tracking, so it goes back to 15s.
//
// This is not hypothetical: the production nginx has no /socket.io route, so
// the handshake there returns the SPA's index.html and the socket never
// connects. Hard-coding the slower interval would have quietly halved the
// dispatch board's refresh rate in production while looking correct locally.
const REFRESH_LIVE_MS = 60000;
const REFRESH_FALLBACK_MS = 15000;
// Assam / lower NH-27, where the fleet actually runs.
const HOME = { lat: 26.35, lng: 91.15 };

// Dark tiles so the map sits inside the v5.0 shell instead of glowing white.
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0b1220' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0b1220' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#64748b' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#1e293b' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1e293b' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#334155' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#475569' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050b16' }] },
];

const truckIcon = (heading = 0) => ({
  path: 'M -6,-3 L 4,-3 L 7,0 L 4,3 L -6,3 Z',
  fillColor: '#38bdf8',
  fillOpacity: 1,
  strokeColor: '#0b1220',
  strokeWeight: 1.5,
  scale: 1.6,
  rotation: heading,
});

export default function LiveFleetMap() {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());   // trip_id -> { marker, target, current, raf }
  const [status, setStatus] = useState('loading');  // loading | ready | nokey | error
  const [detail, setDetail] = useState('');
  const [board, setBoard] = useState({ withFix: [], noFix: [], total: 0 });
  const [socketState, setSocketState] = useState('connecting'); // connecting | live | down
  const routesRef = useRef(new Map());   // trip_id -> google.maps.Polyline

  // ── data ──────────────────────────────────────────────────────────────────
  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/tracking`);
      if (!res.ok) return;
      const json = await res.json();
      const trips = json.trips ?? [];
      setBoard({
        withFix: trips.filter((t) => t.lat != null && t.lng != null),
        noFix: trips.filter((t) => t.lat == null || t.lng == null),
        total: trips.length,
      });
    } catch { /* keep the last board rather than blanking it */ }
  }, []);

  useEffect(() => {
    fetchBoard();
    const every = socketState === 'live' ? REFRESH_LIVE_MS : REFRESH_FALLBACK_MS;
    const id = setInterval(() => { if (document.visibilityState === 'visible') fetchBoard(); }, every);
    return () => clearInterval(id);
  }, [fetchBoard, socketState]);

  // ── live push ─────────────────────────────────────────────────────────────
  // A fix arriving on the socket updates that one truck in place. No refetch,
  // no reload: the marker animation effect below sees the changed coordinate
  // and glides the marker to it.
  useEffect(() => {
    const s = connectFleetSocket();
    if (!s) return;
    const onFix = (fix) => {
      setSocketState('live');
      setBoard((b) => {
        const apply = (t) => (t.id === fix.trip_id
          ? { ...t, lat: fix.lat, lng: fix.lng, source: fix.source, recorded_at: fix.recorded_at }
          : t);
        // A truck reporting for the first time moves from noFix to withFix —
        // that transition is the whole point of the "awaiting first fix" count.
        const promoted = b.noFix.find((t) => t.id === fix.trip_id);
        if (promoted) {
          return {
            ...b,
            withFix: [...b.withFix.map(apply), apply(promoted)],
            noFix: b.noFix.filter((t) => t.id !== fix.trip_id),
          };
        }
        return { ...b, withFix: b.withFix.map(apply) };
      });
    };
    s.on('gps:fix', onFix);
    s.on('connect', () => setSocketState('live'));
    s.on('disconnect', () => setSocketState('down'));
    s.on('connect_error', () => setSocketState('down'));
    return () => {
      s.off('gps:fix', onFix);
      disconnectFleetSocket();
    };
  }, []);

  // ── map ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadGoogleMaps();
        if (cancelled || !boxRef.current) return;
        const g = window.google;
        mapRef.current = new g.maps.Map(boxRef.current, {
          center: HOME,
          zoom: 7,
          styles: DARK_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'cooperative',
          backgroundColor: '#0b1220',
        });
        // Live congestion on the corridors the fleet runs.
        new g.maps.TrafficLayer().setMap(mapRef.current);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        const msg = String(e?.message ?? e);
        setStatus(/key missing/i.test(msg) ? 'nokey' : 'error');
        setDetail(msg);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── markers: create, move smoothly, retire ────────────────────────────────
  useEffect(() => {
    if (status !== 'ready' || !mapRef.current) return;
    const g = window.google;
    const map = mapRef.current;
    const live = markersRef.current;
    const seen = new Set();

    for (const t of board.withFix) {
      const pos = { lat: Number(t.lat), lng: Number(t.lng) };
      if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue;
      seen.add(t.id);

      let entry = live.get(t.id);
      if (!entry) {
        const marker = new g.maps.Marker({
          map, position: pos, icon: truckIcon(0), title: `${t.vehicle_no} · ${t.trip_code}`,
          zIndex: 20,
        });
        const info = new g.maps.InfoWindow();
        marker.addListener('click', () => {
          info.setContent(
            `<div style="font-family:Inter,sans-serif;color:#0b1220;font-size:12px;line-height:1.5">
               <b>${t.vehicle_no ?? '—'}</b> · ${t.trip_code ?? ''}<br/>
               ${t.driver_name ?? 'driver not set'}<br/>
               ${t.loading_point ?? '?'} → ${t.destination ?? '?'}<br/>
               <span style="color:#475569">fix: ${t.source ?? 'unknown'} · ${
                 t.recorded_at ? new Date(t.recorded_at).toLocaleString('en-IN') : '—'}</span>
             </div>`);
          info.open({ anchor: marker, map });
        });
        entry = { marker, current: pos, target: pos, raf: null };
        live.set(t.id, entry);
      } else {
        entry.target = pos;
        // Animate only when the truck actually moved.
        if (entry.current.lat !== pos.lat || entry.current.lng !== pos.lng) {
          if (entry.raf) cancelAnimationFrame(entry.raf);
          const from = { ...entry.current };
          const to = pos;
          const heading = (Math.atan2(to.lng - from.lng, to.lat - from.lat) * 180) / Math.PI;
          const startedAt = performance.now();
          const DURATION = 1200;
          const step = (now) => {
            const k = Math.min(1, (now - startedAt) / DURATION);
            // ease-in-out so the marker glides rather than snapping
            const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
            const cur = {
              lat: from.lat + (to.lat - from.lat) * e,
              lng: from.lng + (to.lng - from.lng) * e,
            };
            entry.marker.setPosition(cur);
            entry.current = cur;
            if (k < 1) entry.raf = requestAnimationFrame(step);
            else { entry.raf = null; entry.current = to; }
          };
          entry.marker.setIcon(truckIcon(heading));
          entry.raf = requestAnimationFrame(step);
        }
      }
    }

    // A trip that stopped moving (settled) leaves the board — and the map.
    for (const [id, entry] of live) {
      if (seen.has(id)) continue;
      if (entry.raf) cancelAnimationFrame(entry.raf);
      entry.marker.setMap(null);
      live.delete(id);
    }
  }, [board, status]);

  // ── route polylines ───────────────────────────────────────────────────────
  // One lane per reporting truck, resolved through the shared cache so the
  // same corridor is billed to Google once for the whole company rather than
  // once per viewer per reload. A route that cannot be resolved draws nothing;
  // a straight line between two place names would imply a road that is not
  // there, on a screen used to judge whether a truck is off-route.
  useEffect(() => {
    if (status !== 'ready' || !mapRef.current) return;
    let cancelled = false;
    const g = window.google;
    const map = mapRef.current;
    const lines = routesRef.current;

    (async () => {
      const seen = new Set();
      for (const t of board.withFix) {
        seen.add(t.id);
        if (lines.has(t.id)) continue;
        const r = await getRoute(t.loading_point, t.destination);
        if (cancelled || !r?.polyline) continue;
        const path = g.maps.geometry?.encoding?.decodePath?.(r.polyline);
        if (!path?.length) continue;
        lines.set(t.id, new g.maps.Polyline({
          map, path,
          strokeColor: '#38bdf8', strokeOpacity: 0.35, strokeWeight: 3, zIndex: 5,
        }));
      }
      for (const [id, line] of lines) {
        if (seen.has(id)) continue;
        line.setMap(null);
        lines.delete(id);
      }
    })();

    return () => { cancelled = true; };
  }, [board, status]);

  // Tear every marker and line down on unmount; Maps holds its own references
  // and a detached overlay keeps the whole map alive otherwise.
  useEffect(() => () => {
    for (const [, entry] of markersRef.current) {
      if (entry.raf) cancelAnimationFrame(entry.raf);
      entry.marker.setMap(null);
    }
    markersRef.current.clear();
    for (const [, line] of routesRef.current) line.setMap(null);
    routesRef.current.clear();
  }, []);

  const plotted = board.withFix.length;

  return (
    <GlassPanel className="h-full flex flex-col">
      <PanelHeader
        icon={Satellite}
        title="Live Fleet Tracking"
        accent="text-cyan-400"
        sub="Google Maps · live traffic"
        right={
          <span className="flex items-center gap-1.5">
            {/* Whether the live push is actually connected. Without this, a
                dead socket and a quiet fleet look identical. */}
            <StatusPill tone={socketState === 'live' ? 'emerald' : socketState === 'down' ? 'amber' : 'slate'}
                        pulse={socketState === 'live'}>
              <Wifi size={9} /> {socketState === 'live' ? 'live push' : socketState === 'down' ? 'polling' : '…'}
            </StatusPill>
            <StatusPill tone={plotted > 0 ? 'emerald' : 'amber'}>
              {plotted} / {board.total} on map
            </StatusPill>
          </span>
        }
      />

      <div className="relative flex-1 min-h-[320px] px-3 pb-3">
        <div ref={boxRef} className="absolute inset-x-3 inset-y-0 rounded-xl overflow-hidden border border-slate-800/70 bg-[#0b1220]" />

        {status !== 'ready' && (
          <div className="absolute inset-x-3 inset-y-0 grid place-items-center rounded-xl border border-slate-800/70 bg-[#0b1220]">
            <div className="text-center px-6">
              {status === 'loading' && <p className="text-[11px] text-slate-500">Loading Google Maps…</p>}
              {status === 'nokey' && (
                <>
                  <AlertTriangle size={22} className="mx-auto text-amber-400 mb-2" />
                  <p className="text-[11px] font-bold text-amber-300">Google Maps key not configured</p>
                  <p className="text-[10px] text-slate-500 mt-1">Set VITE_GOOGLE_MAPS_API_KEY and rebuild.</p>
                </>
              )}
              {status === 'error' && (
                <>
                  <AlertTriangle size={22} className="mx-auto text-amber-400 mb-2" />
                  <p className="text-[11px] font-bold text-amber-300">Map unavailable</p>
                  <p className="text-[10px] text-slate-500 mt-1">{detail}</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The honest footer: what is on the map, and what cannot be. */}
      <div className="px-4 pb-3 pt-1 flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <Navigation size={10} className="text-cyan-400" />
          {plotted > 0
            ? `${plotted} truck${plotted === 1 ? '' : 's'} reporting GPS`
            : 'No truck is reporting GPS yet'}
        </span>
        {board.noFix.length > 0 && (
          <span
            className="flex items-center gap-1.5 text-[10px] font-bold text-amber-400/90"
            title="These trips are in transit but no device has ever sent a position for them. They are deliberately not drawn — an invented marker is indistinguishable from a real one."
          >
            <MapPin size={10} />
            {board.noFix.length} awaiting first GPS fix — not plotted
          </span>
        )}
      </div>
    </GlassPanel>
  );
}
