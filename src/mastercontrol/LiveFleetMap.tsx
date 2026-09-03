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
import { Satellite, AlertTriangle, MapPin, Navigation, Wifi, Search } from 'lucide-react';
import { GlassPanel, PanelHeader, StatusPill, HoverCard, HoverTitle, HoverKv, HoverNote } from './shared';
import { loadGoogleMaps } from '../lib/maps';
import { API_BASE } from '../lib/apiBase';
import { getRoute } from '../lib/mapsCache';
import { connectFleetSocket, disconnectFleetSocket } from '../lib/fleetSocket';
import { openDriverControl } from '../components/DriverControlDrawer';

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
  // ONE InfoWindow for the whole map, not one per marker. It opens on hover
  // now, and per-marker windows would let a fast sweep across the fleet leave
  // a trail of them open behind the pointer.
  const infoRef = useRef(null);
  const pinnedRef = useRef(null);        // trip_id whose window was clicked open

  // ── The map must be told when its box changes ─────────────────────────────
  // Maps measures its container ONCE, at construction. Put it in a flex child
  // whose width is decided after that — which is exactly what the split layout
  // did — and it keeps the size it was born with: the tiles never paint and you
  // get a large empty rectangle that looks like a dead map rather than a
  // mis-measured one. A ResizeObserver tells it, and re-centres, because a
  // resize alone shifts the viewport off whatever was being looked at.
  useEffect(() => {
    if (status !== 'ready' || !boxRef.current || typeof ResizeObserver === 'undefined') return;
    const g = window.google;
    if (!g?.maps) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!mapRef.current) return;
        const keep = mapRef.current.getCenter();
        g.maps.event.trigger(mapRef.current, 'resize');
        if (keep) mapRef.current.setCenter(keep);
      });
    });
    ro.observe(boxRef.current);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [status]);

  // ── Focus one trip ────────────────────────────────────────────────────────
  const [focusId, setFocusId] = useState(null);
  const [focusNote, setFocusNote] = useState('');
  const [q, setQ] = useState('');
  const focusRef = useRef({ line: null, marks: [] });

  // NEWEST LOAD FIRST, not fixes first. An earlier draft put the reporting
  // trucks at the top, which sounds right and is not: zero of forty report, so
  // it only shuffled the list away from the order the yard thinks in — what
  // went out today, then yesterday. The API already sorts this way; sorting
  // again here means the order survives the withFix/noFix split.
  const visibleTrips = useMemo(() => {
    const all = [...board.withFix, ...board.noFix].sort((a, b) => {
      const at = a.loading_date ? new Date(a.loading_date).getTime() : 0;
      const bt = b.loading_date ? new Date(b.loading_date).getTime() : 0;
      return bt - at;
    });
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((t) => [t.vehicle_no, t.trip_code, t.loading_point, t.destination, t.driver_name]
      .some((f) => String(f ?? '').toLowerCase().includes(needle)));
  }, [board, q]);

  // TEN PER PAGE, because the list was setting the widget's height. Forty cards
  // at three lines each ran to roughly 1,700px and the panel simply grew to
  // hold them — which is why the map beside it became a tall empty rectangle.
  // A fixed page count gives the panel a predictable height instead.
  const PAGE = 10;
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(visibleTrips.length / PAGE));
  // Searching or a refreshed board can shrink the list under you; page 9 of 3
  // shows an empty column and reads as "no trips".
  useEffect(() => { if (page > pages) setPage(pages); }, [pages, page]);
  const pageTrips = visibleTrips.slice((page - 1) * PAGE, (page - 1) * PAGE + PAGE);
  useEffect(() => { setPage(1); }, [q]);

  // NOTHING IN THE DATABASE HAS COORDINATES — trips, rtkm_master and locations
  // all keep the loading and unloading points as NAMES ("Lumding Terminal
  // (7T04)"). So the route is resolved from the names through getRoute(), the
  // same helper the fleet view already uses, which returns a real road overview
  // polyline and — the part that matters — reads and writes a SERVER-side cache
  // at /api/v1/maps/cache.
  //
  // A local geocoder would have worked and would have been the wrong tool: it
  // draws a straight line through the hills instead of the road, and it caches
  // per browser, so the same twenty depots would be billed again for every
  // member of staff. This way the second person to open a trip pays nothing.

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
        // Tapping bare map releases a pinned truck card, so a pinned window is
        // never something you have to hunt for the close button on.
        mapRef.current.addListener('click', () => {
          pinnedRef.current = null;
          infoRef.current?.close();
        });
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
        // HOVER OPENS IT. This used to be click-only, which meant the detail
        // behind a truck cost a deliberate click to see and a stray click on
        // the map to dismiss — on a dispatch board where the whole point is
        // sweeping the fleet. Hover shows it, moving off hides it again, and a
        // click PINS it so the window survives while you read or copy from it.
        // On touch, Maps synthesises the click, so the first tap still pins.
        if (!infoRef.current) infoRef.current = new g.maps.InfoWindow();
        const content = () =>
          `<div style="font-family:Inter,sans-serif;color:#0b1220;font-size:12px;line-height:1.5">
             <b>${t.vehicle_no ?? '—'}</b> · ${t.trip_code ?? ''}<br/>
             ${t.driver_name ?? 'driver not set'}<br/>
             ${t.loading_point ?? '?'} → ${t.destination ?? '?'}<br/>
             <span style="color:#475569">fix: ${t.source ?? 'unknown'} · ${
               t.recorded_at ? new Date(t.recorded_at).toLocaleString('en-IN') : '—'}</span>
           </div>`;
        const show = () => {
          const info = infoRef.current;
          info.setContent(content());
          info.open({ anchor: marker, map });
        };
        marker.addListener('mouseover', show);
        marker.addListener('mouseout', () => {
          if (pinnedRef.current === t.id) return;   // clicked open — leave it
          infoRef.current?.close();
        });
        marker.addListener('click', () => {
          pinnedRef.current = pinnedRef.current === t.id ? null : t.id;
          if (pinnedRef.current) show(); else infoRef.current?.close();
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
  // and a detached overlay keeps the whole map alive otherwise. The shared
  // InfoWindow goes with them, or it holds a reference to a dead anchor.
  useEffect(() => () => {
    for (const [, entry] of markersRef.current) {
      if (entry.raf) cancelAnimationFrame(entry.raf);
      entry.marker.setMap(null);
    }
    markersRef.current.clear();
    for (const [, line] of routesRef.current) line.setMap(null);
    routesRef.current.clear();
    infoRef.current?.close();
    infoRef.current = null;
    pinnedRef.current = null;
  }, []);

  const plotted = board.withFix.length;

  // Draw (or clear) the focused trip: origin, destination, the line between
  // them, and the truck if it has a fix. Runs on selection only — the fleet
  // view is untouched, so clearing puts everything back as it was.
  useEffect(() => {
    let dead = false;
    const clear = () => {
      focusRef.current.line?.setMap(null);
      focusRef.current.marks.forEach((m) => m.setMap(null));
      focusRef.current = { line: null, marks: [] };
    };
    clear();
    if (!focusId || status !== 'ready' || !mapRef.current) { setFocusNote(''); return; }

    const trip = [...board.withFix, ...board.noFix].find((t) => t.id === focusId);
    if (!trip) return;
    setFocusNote('Route dekha ja raha hai…');

    (async () => {
      const g = await loadGoogleMaps();
      const r = await getRoute(trip.loading_point, trip.destination);
      if (dead) return;

      const path = r?.polyline ? g.maps.geometry.encoding.decodePath(r.polyline) : null;
      const pts = [];
      const mk = (pos, color, title) => new g.maps.Marker({
        map: mapRef.current, position: pos, title,
        icon: { path: 0, fillColor: color, fillOpacity: 1, strokeColor: '#0b1220', strokeWeight: 2, scale: 7 },
        zIndex: 40,
      });

      if (path?.length) {
        focusRef.current.line = new g.maps.Polyline({
          map: mapRef.current, path, strokeColor: '#22d3ee', strokeOpacity: 0.75, strokeWeight: 4,
        });
        focusRef.current.marks.push(mk(path[0], '#22d3ee', `Loading: ${trip.loading_point}`));
        focusRef.current.marks.push(mk(path[path.length - 1], '#f59e0b', `Unloading: ${trip.destination}`));
        pts.push(...path);
      }

      // A truck is drawn ONLY with a real fix — the same rule the fleet view
      // follows. A pin at the origin "for now" reads as "the lorry is still at
      // the refinery", which is a statement nobody has the data to make.
      if (trip.lat != null && trip.lng != null) {
        const at = { lat: Number(trip.lat), lng: Number(trip.lng) };
        focusRef.current.marks.push(mk(at, '#34d399', `${trip.vehicle_no} — ${trip.source ?? 'fix'}`));
        pts.push(at);
      }

      if (!pts.length) {
        setFocusNote(`${trip.vehicle_no}: "${trip.loading_point ?? '?'}" se "${trip.destination ?? '?'}" ka rasta nahi mila — naam se jagah nahi pehchani gayi.`);
        return;
      }

      const b = new g.maps.LatLngBounds();
      pts.forEach((p) => b.extend(p));
      // One point cannot make a box; without this the map zooms to maximum.
      if (pts.length === 1) { mapRef.current.setCenter(pts[0]); mapRef.current.setZoom(11); }
      else mapRef.current.fitBounds(b, 56);

      const km = r?.distance_m ? ` · ${Math.round(r.distance_m / 1000)} km` : '';
      setFocusNote(
        `${trip.vehicle_no} · ${trip.loading_point ?? '?'} → ${trip.destination ?? '?'}${km}`
        + (trip.lat == null ? ' · abhi koi GPS fix nahi, sirf route dikhaya hai' : ` · fix ${trip.source ?? ''}`));

      // ── STEP B — telematics ON TOP of the route, never instead of it ───────
      // Deliberately after the camera has settled: the route is what makes the
      // map worth looking at and it resolves from names alone, so it must not
      // wait on a fix that in most cases will never come. The overlay then adds
      // whatever tracking exists.
      //
      // Priority is GPRS > driver phone > FASTag, and it is NOT re-implemented
      // here — GET /tracking/:id already elects the best fix (freshest wins,
      // with a source-quality tiebreak inside five minutes) and the board's
      // lat/lng is that election's answer. A second opinion in the browser is
      // how two screens start disagreeing about where a lorry is.
      //
      // FASTag is a TRAIL, not a position. A plaza crossing says where the
      // lorry was at that moment, so the crossings are drawn as small waypoints
      // along the road rather than as another truck marker competing with the
      // live one.
      try {
        const det = await fetch(`${API_BASE}/api/v1/ops/trips/${trip.id}`).then((x) => x.json());
        if (dead) return;
        const tolls = (det?.tolls ?? []).filter((t) => t.lat != null && t.lng != null);
        tolls.forEach((t) => {
          focusRef.current.marks.push(new g.maps.Marker({
            map: mapRef.current,
            position: { lat: Number(t.lat), lng: Number(t.lng) },
            title: `FASTag: ${t.plaza_name ?? 'toll'}${t.txn_datetime ? ` · ${new Date(t.txn_datetime).toLocaleString('en-IN')}` : ''}`,
            icon: { path: 0, fillColor: '#a78bfa', fillOpacity: 0.9, strokeColor: '#0b1220', strokeWeight: 1.5, scale: 4.5 },
            zIndex: 20,
          }));
        });
        if (tolls.length) setFocusNote((n) => `${n} · ${tolls.length} FASTag toll`);
      } catch { /* the route is already drawn; tolls are a bonus layer */ }
    })().catch((e) => { if (!dead) setFocusNote(`Route nahi bana: ${e.message}`); });

    return () => { dead = true; clear(); };
  }, [focusId, status, board]);

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
                dead socket and a quiet fleet look identical. The pill has room
                for one word; the card behind it says what that word costs. */}
            <HoverCard
              width={290}
              content={
                <>
                  <HoverTitle sub={socketState === 'live' ? 'Positions are pushed as they arrive' : socketState === 'down' ? 'Falling back to timed refreshes' : 'Handshake in progress'}>
                    {socketState === 'live' ? 'Live push · connected' : socketState === 'down' ? 'Polling · socket down' : 'Connecting'}
                  </HoverTitle>
                  <HoverKv k="Refresh interval"
                           v={socketState === 'live' ? `${REFRESH_LIVE_MS / 1000}s` : `${REFRESH_FALLBACK_MS / 1000}s`} />
                  <HoverKv k="Trips being tracked" v={board.total} />
                  <HoverKv k="Drawn on the map" v={plotted}
                           tone={plotted > 0 ? 'text-emerald-300' : 'text-amber-300'} />
                  <HoverKv k="No fix yet" v={board.noFix.length}
                           tone={board.noFix.length > 0 ? 'text-amber-300' : 'text-slate-400'} />
                  {socketState === 'down' && (
                    <HoverNote tone="text-amber-300/90">
                      The socket is not connected, so the poll IS the tracking and
                      it runs faster to compensate. Production nginx has no
                      /socket.io route, which is the usual reason this reads
                      &ldquo;polling&rdquo; there and &ldquo;live push&rdquo; locally.
                    </HoverNote>
                  )}
                </>
              }
            >
              <StatusPill tone={socketState === 'live' ? 'emerald' : socketState === 'down' ? 'amber' : 'slate'}
                          pulse={socketState === 'live'}>
                <Wifi size={9} /> {socketState === 'live' ? 'live push' : socketState === 'down' ? 'polling' : '…'}
              </StatusPill>
            </HoverCard>
            <StatusPill tone={plotted > 0 ? 'emerald' : 'amber'}>
              {plotted} / {board.total} on map
            </StatusPill>
          </span>
        }
      />

      {/* ── Split: the list on the left, the map on the right ──────────────
          The selector used to sit ON the map as a dropdown, which meant the
          fleet was a thing you opened rather than a thing you could see. A
          hundred trips is a list, so it gets a column of its own and the map
          keeps its whole canvas: choosing is scanning now, not remembering a
          plate number well enough to find it in a menu. */}
      {/* A FIXED HEIGHT, not min-height. With min-h the list decided how tall
          the widget was — forty cards ran to about 1,700px and the map beside
          them became a tall empty rectangle. Ten per page plus a fixed 460px
          means the panel is the same size whatever the fleet is doing. */}
      <div className="h-[460px] flex gap-2 px-3 pb-3">

        <div className="w-1/4 min-w-[190px] max-w-[300px] flex flex-col rounded-xl border border-slate-800/70 bg-[#0b1220]/60 overflow-hidden">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-800/70 shrink-0">
            <Search size={11} className="shrink-0 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="gaadi ya route…"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-200 placeholder-slate-600 outline-none" />
            {focusId && (
              <button onClick={() => setFocusId(null)} title="poora fleet"
                className="shrink-0 rounded border border-slate-700/60 px-1.5 py-0.5 text-[8.5px] font-black text-slate-400 hover:text-slate-200">
                SAB
              </button>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar p-1.5 flex flex-col gap-1">
            {pageTrips.length === 0 ? (
              <p className="px-1 py-3 text-[10.5px] leading-relaxed text-slate-500">
                {board.total === 0 ? 'Koi chalu trip nahi.' : 'Is naam se koi trip nahi mila.'}
              </p>
            ) : pageTrips.map((t) => {
              const on = t.id === focusId;
              return (
                <button key={t.id} type="button" onClick={() => setFocusId(on ? null : t.id)}
                  className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${on
                    ? 'border-cyan-500/60 bg-cyan-500/10'
                    : 'border-transparent hover:border-slate-700/60 hover:bg-white/5'}`}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${t.lat != null ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    <span className="truncate text-[11px] font-bold text-slate-200">{t.vehicle_no}</span>
                    {t.trip_code && <span className="shrink-0 text-[8.5px] text-slate-600">{t.trip_code}</span>}
                    {/* The driver behind this lorry → Driver Control Dashboard
                        (owner, 2026-09-03). The feed carries driver_id since today. */}
                    {t.driver_id && (
                      <span role="button" title={`${t.driver_name ?? 'Driver'} — Driver Control Dashboard`} data-driver-link
                        onClick={(e) => { e.stopPropagation(); openDriverControl(t.driver_id, t.driver_name); }}
                        className="ml-auto shrink-0 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 text-[9px] font-black text-cyan-300 hover:bg-cyan-500/20">👤</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[9px] text-slate-500">
                    {t.loading_point ?? '?'} → {t.destination ?? '?'}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[8.5px] font-bold uppercase tracking-wider">
                    <span className={t.lat != null ? 'text-emerald-400' : 'text-slate-600'}>
                      {t.lat != null ? (t.source ?? 'fix') : 'no fix'}
                    </span>
                    {t.status && <span className="text-slate-600">{t.status}</span>}
                    {/* A LOAD THAT HAS BEEN "IN TRANSIT" SINCE APRIL IS NOT
                        LIVE, it is a trip nobody closed — 59 of them are over
                        sixty days old. The board shows the newest load per
                        lorry, so these are not hidden; they are dated, because
                        a stale row that looks current is how the whole screen
                        stops being believed. */}
                    {(() => {
                      if (!t.loading_date) return null;
                      const d = Math.round((Date.now() - new Date(t.loading_date).getTime()) / 86400000);
                      if (!Number.isFinite(d) || d < 0) return null;
                      return (
                        <span className={d > 60 ? 'text-red-400' : d > 14 ? 'text-amber-400' : 'text-slate-600'}>
                          {d}d
                        </span>
                      );
                    })()}
                    {t.open_trips > 1 && (
                      <span className="text-amber-400/80" title={`${t.open_trips} trips khuli hain — purani band nahi ki gayi`}>
                        {t.open_trips} open
                      </span>
                    )}
                  </p>
                </button>
              );
            })}
          </div>

          {focusNote && (
            <p className="shrink-0 border-t border-slate-800/70 px-2 py-1.5 text-[9px] leading-snug text-slate-400">
              {focusNote}
            </p>
          )}

          {/* Always rendered, even on a single page: a footer that appears and
              disappears makes the column jump by its own height every time a
              search narrows the list. */}
          <div className="shrink-0 flex items-center justify-between gap-1 border-t border-slate-800/70 px-2 py-1.5">
            <button
              onClick={() => setPage((n) => Math.max(1, n - 1))}
              disabled={page <= 1}
              className="rounded border border-slate-700/60 px-1.5 py-0.5 text-[9px] font-black text-slate-400
                         transition-colors hover:text-slate-200 disabled:opacity-30 disabled:hover:text-slate-400"
            >
              ‹ PICHHLA
            </button>
            <span className="text-[9px] font-semibold tabular-nums text-slate-500">
              {visibleTrips.length === 0 ? '0' : `${(page - 1) * PAGE + 1}–${Math.min(page * PAGE, visibleTrips.length)}`}
              {' / '}{visibleTrips.length}
            </span>
            <button
              onClick={() => setPage((n) => Math.min(pages, n + 1))}
              disabled={page >= pages}
              className="rounded border border-slate-700/60 px-1.5 py-0.5 text-[9px] font-black text-slate-400
                         transition-colors hover:text-slate-200 disabled:opacity-30 disabled:hover:text-slate-400"
            >
              AGLA ›
            </button>
          </div>
        </div>

        <div className="relative flex-1 min-w-0">
          <div ref={boxRef} className="absolute inset-0 rounded-xl overflow-hidden border border-slate-800/70 bg-[#0b1220]" />

          {status !== 'ready' && (
            <div className="absolute inset-0 grid place-items-center rounded-xl border border-slate-800/70 bg-[#0b1220]">
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
          <HoverCard
            placement="top"
            width={300}
            className="flex items-center gap-1.5 text-[10px] font-bold text-amber-400/90"
            content={
              <>
                <HoverTitle sub="In transit, deliberately not drawn">
                  {board.noFix.length} truck{board.noFix.length === 1 ? '' : 's'} awaiting a first fix
                </HoverTitle>
                <div className="max-h-40 overflow-y-auto pr-1">
                  {board.noFix.slice(0, 12).map((t) => (
                    <HoverKv key={t.id}
                             k={t.loading_point && t.destination ? `${t.loading_point} → ${t.destination}` : (t.trip_code || 'trip')}
                             v={t.vehicle_no || '—'} />
                  ))}
                </div>
                {board.noFix.length > 12 && (
                  <p className="mt-1 text-[9px] text-slate-600">…and {board.noFix.length - 12} more.</p>
                )}
                <HoverNote>
                  No device has ever sent a position for these. They are left off
                  the map on purpose — once an invented marker is drawn there is
                  no way to tell it from a real one, and this is the screen
                  people use to judge whether a truck is off-route.
                </HoverNote>
              </>
            }
          >
            <MapPin size={10} />
            {board.noFix.length} awaiting first GPS fix — not plotted
          </HoverCard>
        )}
      </div>
    </GlassPanel>
  );
}
