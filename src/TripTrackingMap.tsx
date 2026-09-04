// 🛰️ LIVE TRIP TRACKING — triangulated telemetry on Google Maps (KALI's view)
//
// Viewport rule: NEVER a world-map zoom-out. Every render computes
// LatLngBounds over (geocoded origin) ∪ (geocoded destination) ∪ (all ping
// positions) and calls map.fitBounds() — Haldia→Guwahati fills the screen.
//
// Triangulation: per-source latest fix from /api/v1/tracking/:tripId; the
// elected best fix carries the "Tracking via: …" badge (GPRS > Driver App >
// FASTag inside a 5-minute freshness window, else freshest wins).
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from './lib/maps';
import {
  loadingPin, unloadingPin, truckIcon, truckLabel,
  gateIcon, driverIcon, pingIcon, plazaKey, inr, observeAndRefit,
} from './lib/mapSymbols.mjs';
import { loadTollPlazas } from './lib/tollPlazaMaster';
import { plazasOnRoute, tollTotals } from './lib/tollRoute.mjs';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const C = {
  bg: '#121c38', card: 'rgba(24, 36, 74,0.72)', line: '#27395f', dim: '#9aadd4',
  text: '#dde5f4', ok: '#2fe39b', warn: '#ffb224', bad: '#ff6b81', purple: '#a78bfa', blue: '#22d3ee',
};
const SOURCE_STYLE: Record<string, { color: string; label: string; icon: string }> = {
  DRIVER_APP: { color: '#22d3ee', label: 'Driver App', icon: '📱' },
  GPRS: { color: '#2fe39b', label: 'GPRS', icon: '📡' },
  FASTAG: { color: '#ffb224', label: 'FASTag', icon: '🛂' },
};

export default function TripTrackingMap() {
  const [trips, setTrips] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const overlays = useRef<any[]>([]);
  // Road geometry + geocoded endpoints for the selected trip.
  const [geo, setGeo] = useState<any>(null);
  // Every gate we can place, fetched once per page and shared with every other
  // map on it. See lib/tollPlazaMaster.ts.
  const [plazas, setPlazas] = useState<any[]>([]);
  const [toll, setToll] = useState<any>(null);
  const refitRef = useRef<null | (() => void)>(null);

  useEffect(() => { loadTollPlazas().then(setPlazas); }, []);

  // live board
  const loadBoard = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/v1/tracking`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setTrips(j.trips); setErr(null);
      if (!selected && j.trips[0]) setSelected(j.trips[0].id);
    } catch (e: any) { setErr(`Tracking API unreachable (${e.message})`); }
  }, [selected]);
  useEffect(() => { loadBoard(); const t = setInterval(loadBoard, 20000); return () => clearInterval(t); }, [loadBoard]);

  // selected trip detail (10s refresh)
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const pull = async () => {
      try {
        const res = await fetch(`${API}/api/v1/tracking/${selected}`);
        if (res.ok && live) setDetail(await res.json());
      } catch { /* board banner already reports outage */ }
    };
    pull();
    const t = setInterval(pull, 10000);
    return () => { live = false; clearInterval(t); };
  }, [selected]);

  // ── THE ROAD ──────────────────────────────────────────────────────────────
  // Fetched ONCE per trip, not on the 10s telemetry tick: the lane between two
  // depots does not change while the lorry drives down it, and re-fetching it
  // every ten seconds would bill a Directions call six times a minute per
  // viewer. The server serves it from maps_cache after the first request, so
  // one lane is billed once for the whole company.
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setGeo(null);
    fetch(`${API}/api/v1/maps/trip/${selected}/route`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setGeo(j); })
      .catch(() => { /* the map still draws whatever telemetry exists */ });
    return () => { live = false; };
  }, [selected]);

  // map init
  useEffect(() => {
    loadGoogleMaps().then(() => {
      if (!mapDiv.current || mapRef.current) return;
      const g = (window as any).google;
      mapRef.current = new g.maps.Map(mapDiv.current, {
        center: { lat: 26.2, lng: 92.9 },        // Assam fallback until bounds land
        zoom: 7,
        mapTypeControl: false, streetViewControl: false,
        styles: [{ elementType: 'geometry', stylers: [{ color: '#18244a' }] },
                 { elementType: 'labels.text.fill', stylers: [{ color: '#9aadd4' }] },
                 { featureType: 'water', stylers: [{ color: '#121c38' }] },
                 { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#27395f' }] }],
      });
    }).catch((e) => setErr(e.message));
  }, []);

  // render overlays + AUTO-FIT BOUNDS whenever detail changes
  useEffect(() => {
    const g = (window as any).google;
    const map = mapRef.current;
    if (!g?.maps || !map || !detail) return;

    overlays.current.forEach((o) => o.setMap?.(null));
    overlays.current = [];
    const bounds = new g.maps.LatLngBounds();
    let boundsHasPoint = false;
    const extend = (pos: any) => { bounds.extend(pos); boundsHasPoint = true; };

    // trail polyline
    if (detail.trail?.length > 1) {
      const path = detail.trail.map((p: any) => ({ lat: p.lat, lng: p.lng }));
      overlays.current.push(new g.maps.Polyline({
        map, path, strokeColor: C.purple, strokeOpacity: 0.7, strokeWeight: 3,
      }));
      path.forEach(extend);
    }

    // per-source latest markers
    for (const s of detail.sources ?? []) {
      const st = SOURCE_STYLE[s.source];
      const pos = { lat: s.lat, lng: s.lng };
      overlays.current.push(new g.maps.Marker({
        map, position: pos, title: `${st.label} · ${new Date(s.recorded_at).toLocaleTimeString()}`,
        // A DRIVER-APP FIX IS A MAN WITH A PHONE, and it is drawn as one. The
        // other two sources are hardware and stay as plain dots — the point of
        // the distinction is that a person's phone can be in a different vehicle,
        // in his pocket at a dhaba, or switched off, and the desk should never
        // read it as the lorry's own position.
        icon: s.source === 'DRIVER_APP'
          ? driverIcon(detail.best?.source === s.source)
          : pingIcon(st.color, detail.best?.source === s.source),
      }));
      extend(pos);
    }

    // ── THE ROAD ITSELF ─────────────────────────────────────────────────────
    // Decoded from the server's cached polyline. This is what was missing: the
    // screen drew a trail joining GPS pings and nothing else, so a trip with no
    // telemetry — which is every trip today — showed two pins and empty space.
    if (geo?.route?.polyline && g.maps.geometry?.encoding?.decodePath) {
      const path = g.maps.geometry.encoding.decodePath(geo.route.polyline);
      if (path?.length) {
        // Casing under the line: a single stroke over dark tiles reads as a
        // scratch. Two strokes read as a road.
        overlays.current.push(new g.maps.Polyline({
          map, path, strokeColor: '#0a1024', strokeOpacity: 0.9, strokeWeight: 8, zIndex: 3,
        }));
        overlays.current.push(new g.maps.Polyline({
          map, path, strokeColor: C.blue, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 4,
        }));
        path.forEach(extend);
      }
    }

    // Endpoints, from the server's cached geocode rather than a fresh browser
    // lookup on every click.
    // "A" and "B" told a dispatcher nothing they did not already know, and the
    // two circles were a different shape and a different green from the same
    // two places on the trip sheet. Shared teardrops now — see lib/mapSymbols.
    const pin = (pt: any, icon: any, what: string) => {
      if (!pt || !Number.isFinite(Number(pt.lat))) return;
      const pos = { lat: Number(pt.lat), lng: Number(pt.lng) };
      overlays.current.push(new g.maps.Marker({
        map, position: pos, title: `${what}: ${pt.label ?? pt.resolved ?? ''}`, zIndex: 10, icon,
      }));
      extend(pos);
    };
    pin(geo?.origin, loadingPin(), 'Loading');
    pin(geo?.destination, unloadingPin(), 'Unloading');

    // ── TOLL GATES ON THIS LANE ───────────────────────────────────────────
    // Same gates, same pills, same rates as the trip sheet and the dispatch
    // board. Matched against the ROAD, so a plaza on the parallel highway is
    // not claimed by this lane.
    if (geo?.route?.polyline && g.maps.geometry?.encoding?.decodePath && plazas.length) {
      const path = g.maps.geometry.encoding.decodePath(geo.route.polyline)
        .map((pt: any) => ({ lat: pt.lat(), lng: pt.lng() }));
      const gates = plazasOnRoute(path, plazas);
      const crossed = new Set((geo?.tolls ?? []).map((x: any) => plazaKey(x.plaza_name)));
      for (const gate of gates) {
        const known = gate.rate !== null && gate.rate !== undefined && gate.rate !== '';
        const done = crossed.has(gate.name_key);
        const m = new g.maps.Marker({
          map, position: { lat: Number(gate.lat), lng: Number(gate.lng) },
          icon: gateIcon(done, known, gate.rate),
          title: gate.plaza_name, zIndex: 25,
        });
        overlays.current.push(m);
        extend({ lat: Number(gate.lat), lng: Number(gate.lng) });
      }
      const isRound = (detail?.trip?.trip_leg_kind
        ?? (detail?.trip?.is_market_vehicle ? 'ONE_WAY' : 'ROUND')) === 'ROUND';
      setToll(tollTotals(gates, { roundTrip: isRound }));
    } else {
      setToll(null);
    }

    // ── THE TRUCK ───────────────────────────────────────────────────────────
    // Only ever from a real fix. `geo.truck` is null when trip_gps_pings holds
    // nothing for this trip, and in that case nothing is drawn — an invented
    // marker is indistinguishable from a real one on the screen dispatch uses to
    // judge whether a lorry is off route.
    if (geo?.truck && Number.isFinite(Number(geo.truck.lat))) {
      const pos = { lat: Number(geo.truck.lat), lng: Number(geo.truck.lng) };
      overlays.current.push(new g.maps.Marker({
        map, position: pos, zIndex: 30,
        title: `${geo.trip?.vehicle_no ?? 'Vehicle'} · ${geo.truck.source ?? 'gps'} · `
             + new Date(geo.truck.at).toLocaleString('en-IN'),
        // Same arrow, same plate, as the dispatch board and the driver's phone.
        icon: truckIcon(Number(geo.truck.heading) || 0, 1.5),
        label: truckLabel(geo.trip?.vehicle_no),
      }));
      extend(pos);
    }

    // Kept callable so the resize observer below can re-run it. Google holds
    // centre and zoom when its container changes size, and this page's board
    // and map settle after the first paint.
    refitRef.current = () => {
      if (!boundsHasPoint) return;
      map.fitBounds(bounds, { top: 60, bottom: 40, left: 40, right: 40 });
    };
    refitRef.current();
  }, [detail, geo, plazas]);

  useEffect(() => observeAndRefit(mapDiv.current, () => refitRef.current?.()), []);

  const badge = detail?.best?.badge;
  const badgeStyle = detail?.best ? SOURCE_STYLE[detail.best.source] : null;

  return (
    <div style={{ padding: 20, background: C.bg, minHeight: '100vh' }}>
      <h2 style={{ color: C.purple, margin: '0 0 10px' }}>
        🛰️ Live Trip Tracking
        <span style={{ fontSize: 11, color: C.blue, border: `1px solid ${C.blue}`, borderRadius: 10, padding: '1px 8px', marginLeft: 8 }}>
          TRIANGULATED · DRIVER APP + GPRS + FASTAG
        </span>
      </h2>
      {err && <div style={{ padding: '10px 14px', border: `1px dashed ${C.warn}`, borderRadius: 10, color: C.warn, fontSize: 12, marginBottom: 10 }}>⚠️ {err}</div>}

      {/* The lane's toll, in the same words and the same rupees as every other
          screen: gates we have a rate for are added, gates we do not are
          counted and said out loud, and a round trip is doubled. */}
      {toll?.gates > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 10,
                      padding: '8px 12px', borderRadius: 10, fontSize: 12,
                      background: 'rgba(255,178,36,0.08)', border: '1px solid rgba(255,178,36,0.3)' }}>
          <b style={{ color: C.warn }}>🛣️ {toll.gates} toll gate</b>
          <span style={{ color: C.text }}>ek taraf <b style={{ color: C.warn }}>{inr(toll.one_way)}</b></span>
          {toll.round_trip && (
            <span style={{ color: C.text }}>aana-jaana <b style={{ color: C.warn, fontSize: 14 }}>{inr(toll.total)}</b></span>
          )}
          {toll.incomplete && (
            <span style={{ color: C.bad, fontSize: 11 }}>{toll.unknown} gate ka rate system mein nahi</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {/* moving-trips board */}
        <div style={{ width: 300, maxHeight: '78vh', overflowY: 'auto', background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 10 }}>
          <div style={{ fontSize: 10.5, color: C.dim, letterSpacing: 1, margin: '4px 6px 8px' }}>MOVING TRIPS ({trips.length})</div>
          {trips.map((t) => (
            <div key={t.id} onClick={() => setSelected(t.id)}
              style={{ padding: '9px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                       background: selected === t.id ? 'rgba(167, 139, 250,0.14)' : 'transparent',
                       border: `1px solid ${selected === t.id ? C.purple : 'transparent'}` }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{t.vehicle_no} <span style={{ color: C.dim, fontWeight: 400 }}>· {t.trip_code ?? t.id.slice(0, 6)}</span></div>
              <div style={{ fontSize: 11, color: C.dim }}>{t.loading_point ?? '—'} → {t.destination ?? '—'}</div>
              <div style={{ fontSize: 10, marginTop: 2 }}>
                <span style={{ color: C.warn }}>{t.status}</span>
                {t.source
                  ? <span style={{ color: SOURCE_STYLE[t.source].color }}> · {SOURCE_STYLE[t.source].icon} {SOURCE_STYLE[t.source].label} {new Date(t.recorded_at).toLocaleTimeString()}</span>
                  : <span style={{ color: C.dim }}> · no telemetry yet</span>}
              </div>
            </div>
          ))}
          {!trips.length && <div style={{ color: C.dim, fontSize: 12, padding: 10 }}>No trips in LOADED / IN_TRANSIT / UNLOADING.</div>}
        </div>

        {/* map */}
        <div style={{ flex: 1, minWidth: 320, position: 'relative' }}>
          <div ref={mapDiv} style={{ width: '100%', height: '78vh', borderRadius: 14, border: `1px solid ${C.line}` }} />
          {badge && badgeStyle && (
            <div style={{ position: 'absolute', top: 14, left: 14, background: 'rgba(18, 28, 56,0.9)', border: `1.5px solid ${badgeStyle.color}`,
                          borderRadius: 12, padding: '8px 14px', color: badgeStyle.color, fontWeight: 800, fontSize: 12.5,
                          boxShadow: `0 0 18px ${badgeStyle.color}55` }}>
              {badgeStyle.icon} {badge}
              <span style={{ color: C.dim, fontWeight: 400 }}> · {detail.best.age_s}s ago{detail.best.speed_kmh ? ` · ${detail.best.speed_kmh} km/h` : ''}</span>
            </div>
          )}
          {detail && !detail.best && (
            <div style={{ position: 'absolute', top: 14, left: 14, background: 'rgba(18, 28, 56,0.9)', border: `1px dashed ${C.dim}`, borderRadius: 12, padding: '8px 14px', color: C.dim, fontSize: 12 }}>
              No telemetry yet — framing origin → destination
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
