// @ts-nocheck
// ============================================================================
// useLiveTracking — the bi-directional coordinate bus between Driver,
// Customer and Office Dispatch.
//
// STRUCTURE IS REAL, TRANSPORT IS MOCKED. The hook speaks the exact envelope
// the AWS API Gateway WebSocket stage will carry:
//
//   {action:'position', tripId, lat, lng, speedKmh, heading, at}
//   {action:'status',   tripId, state:'LOADING'|'EN_ROUTE'|'ARRIVING'|...}
//
// Until VITE_TRACKING_WS_URL is set (wss://…execute-api…/prod), connect()
// spins up an in-memory simulator that drives a truck along the given route
// polyline — so Customer tracking is fully demonstrable today, and flipping
// to the real gateway is a config change, not a rewrite.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const WS_URL = (import.meta as any).env?.VITE_TRACKING_WS_URL || null;
const TICK_MS = 2000;

// Great-circle-ish distance in km — good enough for ETA at freight scale.
export function haversineKm(a, b) {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export default function useLiveTracking({ tripId, route = [] }) {
  const [status, setStatus] = useState('IDLE');       // IDLE|CONNECTING|OPEN|MOCK|CLOSED
  const [position, setPosition] = useState(null);     // {lat,lng,speedKmh,heading,at,progress}
  const [tripState, setTripState] = useState('EN_ROUTE');
  const wsRef = useRef(null);
  const simRef = useRef(null);
  const progressRef = useRef(0.18); // trucks rarely start at the depot gate in a demo

  const totalKm = useMemo(() => {
    let km = 0;
    for (let i = 1; i < route.length; i++) km += haversineKm(route[i - 1], route[i]);
    return km;
  }, [route]);

  // Position at a fractional progress along the polyline.
  const pointAt = useCallback((p) => {
    if (route.length < 2) return route[0] ?? null;
    const target = p * totalKm;
    let acc = 0;
    for (let i = 1; i < route.length; i++) {
      const seg = haversineKm(route[i - 1], route[i]);
      if (acc + seg >= target) {
        const f = seg === 0 ? 0 : (target - acc) / seg;
        return {
          lat: route[i - 1].lat + (route[i].lat - route[i - 1].lat) * f,
          lng: route[i - 1].lng + (route[i].lng - route[i - 1].lng) * f,
          heading: (Math.atan2(route[i].lng - route[i - 1].lng, route[i].lat - route[i - 1].lat) * 180) / Math.PI,
        };
      }
      acc += seg;
    }
    return { ...route[route.length - 1], heading: 0 };
  }, [route, totalKm]);

  const connect = useCallback(() => {
    if (WS_URL) {
      // ── REAL LANE (AWS API Gateway WebSocket) ────────────────────────────
      setStatus('CONNECTING');
      const ws = new WebSocket(`${WS_URL}?tripId=${encodeURIComponent(tripId)}`);
      wsRef.current = ws;
      ws.onopen = () => { setStatus('OPEN'); ws.send(JSON.stringify({ action: 'subscribe', tripId })); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.action === 'position') setPosition({ ...m, progress: m.progress ?? null });
          if (m.action === 'status') setTripState(m.state);
        } catch { /* malformed frame — drop */ }
      };
      ws.onclose = () => setStatus('CLOSED');
      ws.onerror = () => setStatus('CLOSED');
      return;
    }
    // ── MOCK LANE (in-memory simulator) ────────────────────────────────────
    setStatus('MOCK');
    simRef.current = setInterval(() => {
      const speed = 38 + Math.round(Math.sin(Date.now() / 15000) * 10); // 28–48 km/h
      progressRef.current = Math.min(1, progressRef.current + (speed / 3600) * (TICK_MS / 1000) / Math.max(totalKm, 1));
      const pt = pointAt(progressRef.current);
      if (pt) setPosition({ ...pt, speedKmh: speed, at: Date.now(), progress: progressRef.current });
      if (progressRef.current >= 0.97) setTripState('ARRIVING');
    }, TICK_MS);
  }, [tripId, pointAt, totalKm]);

  const disconnect = useCallback(() => {
    wsRef.current?.close(); wsRef.current = null;
    if (simRef.current) { clearInterval(simRef.current); simRef.current = null; }
    setStatus('CLOSED');
  }, []);

  // Driver side: publish a fix onto the bus (real send when OPEN, no-op in mock
  // — the simulator IS the publisher there).
  const sendPosition = useCallback((fix) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ action: 'position', tripId, ...fix }));
    }
  }, [tripId]);

  useEffect(() => () => disconnect(), [disconnect]);

  const remainingKm = position?.progress != null ? Math.max(0, totalKm * (1 - position.progress)) : null;
  const etaMin = remainingKm != null && position?.speedKmh > 0 ? Math.round((remainingKm / position.speedKmh) * 60) : null;

  return { status, position, tripState, totalKm, remainingKm, etaMin, connect, disconnect, sendPosition };
}
