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

// Poll cadence for every Master Control hub. 8s rather than the old 30s:
// these dashboards are watched while somebody else is entering trips, and a
// half-minute of staleness reads as 'the entry did not save'. Overridable
// with VITE_DASHBOARD_REFRESH_MS.
//
// Still gated on document.visibilityState below -- a hidden tab polling every
// eight seconds is just load with nobody looking at it.
const REFRESH_MS = Number((import.meta as any).env?.VITE_DASHBOARD_REFRESH_MS) || 8000;

export default function useDashboardData(qs = '') {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const alive = useRef(true);

  // fresh=1 skips the server's 30 s cache — used only after a write announced
  // itself, so "save and look" stays instant while the poll stays cheap.
  const load = useCallback(async (fresh = false) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const url = `${API_BASE}/api/v1/dashboard/v5${qs}${fresh ? (qs ? '&' : '?') + 'fresh=1' : ''}`;
      const res = await fetch(url, {
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
  }, [qs]);

  useEffect(() => {
    alive.current = true;
    // A changed filter must re-query, not re-render stale numbers under a new
    // label — that would show the group's figures captioned as one company's.
    setLoading(true);
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    // Coming back to a tab should show current numbers at once, not whatever
    // was true when you wandered off plus up to REFRESH_MS.
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    // Any screen that writes can announce it and the hubs refresh immediately
    // instead of waiting out the poll:
    //     window.dispatchEvent(new Event('erp:data-changed'))
    // Cheaper and far less to go wrong than a socket, and it covers the case
    // that actually bites -- saving a trip in one tab and watching the dashboard
    // in another still needs the poll, but saving and looking is instant.
    const onChanged = () => load(true);
    window.addEventListener('erp:data-changed', onChanged);
    return () => {
      alive.current = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('erp:data-changed', onChanged);
    };
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
