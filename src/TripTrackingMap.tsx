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

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const C = {
  bg: '#0f172a', card: 'rgba(30,41,59,0.72)', line: '#334155', dim: '#94a3b8',
  text: '#e2e8f0', ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', purple: '#c084fc', blue: '#38bdf8',
};
const SOURCE_STYLE: Record<string, { color: string; label: string; icon: string }> = {
  DRIVER_APP: { color: '#38bdf8', label: 'Driver App', icon: '📱' },
  GPRS: { color: '#10b981', label: 'GPRS', icon: '📡' },
  FASTAG: { color: '#f59e0b', label: 'FASTag', icon: '🛂' },
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
        styles: [{ elementType: 'geometry', stylers: [{ color: '#1e293b' }] },
                 { elementType: 'labels.text.fill', stylers: [{ color: '#94a3b8' }] },
                 { featureType: 'water', stylers: [{ color: '#0f172a' }] },
                 { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#334155' }] }],
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
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: detail.best?.source === s.source ? 10 : 7,
                fillColor: st.color, fillOpacity: 1, strokeColor: '#0f172a', strokeWeight: 2 },
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
          map, path, strokeColor: '#0b1220', strokeOpacity: 0.9, strokeWeight: 8, zIndex: 3,
        }));
        overlays.current.push(new g.maps.Polyline({
          map, path, strokeColor: C.blue, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 4,
        }));
        path.forEach(extend);
      }
    }

    // Endpoints, from the server's cached geocode rather than a fresh browser
    // lookup on every click.
    const pin = (pt: any, text: string, color: string) => {
      if (!pt || !Number.isFinite(Number(pt.lat))) return;
      const pos = { lat: Number(pt.lat), lng: Number(pt.lng) };
      overlays.current.push(new g.maps.Marker({
        map, position: pos, title: pt.resolved ?? pt.label ?? text, zIndex: 10,
        label: { text, color: '#0f172a', fontWeight: '900', fontSize: '11px' },
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 11, fillColor: color,
                fillOpacity: 1, strokeColor: '#0f172a', strokeWeight: 2 },
      }));
      extend(pos);
    };
    pin(geo?.origin, 'A', '#34d399');
    pin(geo?.destination, 'B', '#f472b6');

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
        icon: { path: 'M -7 -4 L 7 -4 L 9 0 L 7 4 L -7 4 Z', fillColor: '#22d3ee',
                fillOpacity: 1, strokeColor: '#0f172a', strokeWeight: 2, scale: 1.7 },
      }));
      extend(pos);
    }

    if (boundsHasPoint) map.fitBounds(bounds, { top: 60, bottom: 40, left: 40, right: 40 });
  }, [detail, geo]);

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

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {/* moving-trips board */}
        <div style={{ width: 300, maxHeight: '78vh', overflowY: 'auto', background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 10 }}>
          <div style={{ fontSize: 10.5, color: C.dim, letterSpacing: 1, margin: '4px 6px 8px' }}>MOVING TRIPS ({trips.length})</div>
          {trips.map((t) => (
            <div key={t.id} onClick={() => setSelected(t.id)}
              style={{ padding: '9px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                       background: selected === t.id ? 'rgba(192,132,252,0.14)' : 'transparent',
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
            <div style={{ position: 'absolute', top: 14, left: 14, background: 'rgba(15,23,42,0.9)', border: `1.5px solid ${badgeStyle.color}`,
                          borderRadius: 12, padding: '8px 14px', color: badgeStyle.color, fontWeight: 800, fontSize: 12.5,
                          boxShadow: `0 0 18px ${badgeStyle.color}55` }}>
              {badgeStyle.icon} {badge}
              <span style={{ color: C.dim, fontWeight: 400 }}> · {detail.best.age_s}s ago{detail.best.speed_kmh ? ` · ${detail.best.speed_kmh} km/h` : ''}</span>
            </div>
          )}
          {detail && !detail.best && (
            <div style={{ position: 'absolute', top: 14, left: 14, background: 'rgba(15,23,42,0.9)', border: `1px dashed ${C.dim}`, borderRadius: 12, padding: '8px 14px', color: C.dim, fontSize: 12 }}>
              No telemetry yet — framing origin → destination
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
