// @ts-nocheck
// ============================================================================
// useGeoPolling — the driver device's 5-second location heartbeat.
// Real Geolocation API when the device grants it; a smooth simulated NH-27
// drift otherwise, so the radar UI is demonstrable on any desktop.
// Every fix is appended to `history` (the breadcrumb trail the dispatch map
// draws) and handed to `onFix` — which is where the WebSocket broadcast to
// AWS API Gateway will hang off (see useLiveTracking).
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 5000;

// Simulated fallback: eastbound along NH-27 near Bongaigaon.
const SIM_START = { lat: 26.4831, lng: 90.5533 };

export default function useGeoPolling({ onFix } = {}) {
  const [active, setActive] = useState(false);
  const [fix, setFix] = useState(null);          // {lat,lng,speedKmh,accuracy,at,simulated}
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const simState = useRef({ ...SIM_START, heading: 78 });
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  const record = useCallback((f) => {
    setFix(f);
    setHistory((h) => [...h.slice(-119), f]); // keep last 10 minutes of fixes
    onFixRef.current?.(f);
  }, []);

  const poll = useCallback(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setError(null);
          record({
            lat: pos.coords.latitude, lng: pos.coords.longitude,
            speedKmh: pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : null,
            accuracy: Math.round(pos.coords.accuracy ?? 0),
            at: Date.now(), simulated: false,
          });
        },
        (err) => {
          // Permission denied / no GPS: fall through to the simulator so the
          // duty screen never freezes on a desktop preview.
          setError(err.message);
          const s = simState.current;
          const stepKm = (42 / 3600) * (POLL_MS / 1000); // ~42 km/h
          s.lat += (stepKm / 111) * Math.cos((s.heading * Math.PI) / 180);
          s.lng += (stepKm / 102) * Math.sin((s.heading * Math.PI) / 180);
          s.heading += (Math.sin(Date.now() / 40000) * 4); // gentle curve
          record({ lat: +s.lat.toFixed(6), lng: +s.lng.toFixed(6), speedKmh: 42, accuracy: 12, at: Date.now(), simulated: true });
        },
        { enableHighAccuracy: true, timeout: 4000, maximumAge: 2000 }
      );
    } else {
      setError('Geolocation unsupported');
    }
  }, [record]);

  const start = useCallback(() => {
    if (timer.current) return;
    setActive(true);
    poll();
    timer.current = setInterval(poll, POLL_MS);
  }, [poll]);

  const stop = useCallback(() => {
    setActive(false);
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  return { active, fix, history, error, start, stop, pollMs: POLL_MS };
}
