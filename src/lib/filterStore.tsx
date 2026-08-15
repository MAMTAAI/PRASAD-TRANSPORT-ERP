// @ts-nocheck
// ============================================================================
// GLOBAL 3-TIER FILTER — Company → Branch → Fleet/Owner, app-wide.
//
// WHY THIS MOVED OUT OF MASTER CONTROL. The filter used to live inside
// MasterControlApp, so it existed only while that screen was mounted. Open
// Company P&L, Cash & Bank Book or the Owner Statement and the scope silently
// vanished — you would narrow the dashboard to Gautam Prasad, click through to
// the P&L, and be reading the whole group again with nothing on screen saying
// so. A filter that only some screens honour is worse than none, because the
// ones that ignore it look like they are answering the question you asked.
//
// WHY NOT ZUSTAND. The brief suggested it. This is four strings that need to
// survive a remount and a refresh; React context plus sessionStorage plus the
// URL already do that, and adding a state library would be a dependency, a
// bundle cost and a second place to look for state that lives in three already.
//
// THE URL IS THE OUTER SOURCE OF TRUTH. On boot the query string wins, then
// sessionStorage, then empty. That ordering is what makes a pasted link open
// somebody else's exact view, and a refresh land on the same context rather
// than the group default. Written with replaceState, not pushState: changing a
// filter is not navigation, and stacking twenty history entries would make Back
// walk through every dropdown twiddle instead of leaving the screen.
// ============================================================================
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const KEY = 'pt_dash_filter_v1';
export const EMPTY = { companyId: '', branchId: '', owner: '', fleet: '' };

// Query-param names are snake_case to match the API they end up in, so a link
// can be read and understood without a translation table.
const PARAM = { companyId: 'company_id', branchId: 'branch_id', owner: 'owner', fleet: 'fleet' };

function fromUrl() {
  try {
    const p = new URLSearchParams(window.location.search);
    const out = {};
    for (const [k, name] of Object.entries(PARAM)) {
      const v = p.get(name);
      if (v) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

function fromSession() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const FilterCtx = createContext(null);

export function FilterProvider({ children }) {
  const [filters, setFilters] = useState(() => ({ ...EMPTY, ...(fromUrl() ?? fromSession() ?? {}) }));
  // The shell writes the active module/screen here so they ride in the URL too.
  const navRef = useRef({ module: null, screen: null });

  const writeUrl = useCallback((f, nav) => {
    try {
      const p = new URLSearchParams(window.location.search);
      for (const [k, name] of Object.entries(PARAM)) {
        if (f[k]) p.set(name, f[k]); else p.delete(name);
      }
      if (nav?.module) p.set('module', nav.module); else p.delete('module');
      if (nav?.screen) p.set('screen', nav.screen); else p.delete('screen');
      const qs = p.toString();
      window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    } catch { /* history is best-effort; the app still works without it */ }
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify(filters)); } catch { /* private mode */ }
    writeUrl(filters, navRef.current);
  }, [filters, writeUrl]);

  const set = useCallback((patch) => {
    setFilters((f) => {
      const next = { ...f, ...patch };
      // Changing the company invalidates the branch under it: a branch id from
      // another firm matches nothing, and the dashboard would come back empty
      // looking like "no data" rather than "impossible combination".
      if (patch.companyId !== undefined && patch.companyId !== f.companyId) next.branchId = '';
      return next;
    });
  }, []);

  const clear = useCallback(() => setFilters({ ...EMPTY }), []);

  /** Called by the shell so module/screen survive a refresh alongside the filter. */
  const setNav = useCallback((module, screen) => {
    navRef.current = { module, screen };
    writeUrl(filters, navRef.current);
  }, [filters, writeUrl]);

  const active = !!(filters.companyId || filters.branchId || filters.owner || filters.fleet);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    for (const [k, name] of Object.entries(PARAM)) if (filters[k]) p.set(name, filters[k]);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [filters]);

  const value = useMemo(
    () => ({ filters, set, clear, active, qs, setNav }),
    [filters, set, clear, active, qs, setNav]);

  return <FilterCtx.Provider value={value}>{children}</FilterCtx.Provider>;
}

/** Read the global filter. Safe outside the provider (returns an inert filter)
 *  so a screen rendered in isolation — a portal, a preview — does not crash. */
export function useGlobalFilter() {
  const ctx = useContext(FilterCtx);
  if (ctx) return ctx;
  return {
    filters: { ...EMPTY }, set: () => {}, clear: () => {},
    active: false, qs: () => '', setNav: () => {},
  };
}

/** Read the boot-time module/screen from the URL, so a refresh or a shared link
 *  lands on the same screen instead of the default home. */
export function navFromUrl() {
  try {
    const p = new URLSearchParams(window.location.search);
    return { module: p.get('module'), screen: p.get('screen') };
  } catch { return { module: null, screen: null }; }
}
