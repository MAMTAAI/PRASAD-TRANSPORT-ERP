// @ts-nocheck
// Live data for the three Master Control v5.0 modules.
//
// One fetch of /api/v1/dashboard/v5 feeds all three tabs, refreshed on a timer
// and paused while the tab is hidden (a background tab polling the books is
// just load with nobody looking at it).
//
// HONESTY CONTRACT: when the API is unreachable this returns `data: null` and
// an `error`, and the screens render an explicit "not available" state. It
// does NOT fall back to the old demo numbers — a dashboard that silently shows
// invented figures next to real ones is worse than one that admits it is down.
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const REFRESH_MS = 60000;

export default function useDashboardData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(`${API_BASE}/api/v1/dashboard/v5`, {
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${localStorage.getItem('prasad_token') || ''}` },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json = await res.json();
      if (!alive.current) return;
      setData(json);
      setError(null);
      setFetchedAt(new Date());
    } catch (e) {
      if (!alive.current) return;
      setError(e.name === 'AbortError' ? 'request timed out' : e.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => { alive.current = false; clearInterval(id); };
  }, [load]);

  return { data, error, loading, fetchedAt, reload: load };
}

// ── formatting helpers, shared by the three dashboards ──────────────────────

/** Indian short form: 1,42,54,038 -> "1.43 Cr". Keeps a real 0 as "0". */
export function inr(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)} K`;
  return `${sign}${a.toFixed(0)}`;
}

/** Full rupee figure with Indian digit grouping. */
export function inrFull(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Days-to-expiry -> pill tone. */
export function expiryTone(days) {
  if (days == null) return 'slate';
  if (days < 0) return 'red';
  if (days <= 10) return 'red';
  if (days <= 30) return 'amber';
  return 'green';
}

export function expiryLabel(days) {
  if (days == null) return 'not set';
  if (days < 0) return `expired ${Math.abs(days)}d`;
  if (days === 0) return 'expires today';
  return `${days}d left`;
}
