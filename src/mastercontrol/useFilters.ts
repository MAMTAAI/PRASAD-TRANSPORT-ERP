// @ts-nocheck
// Shared 3-tier dashboard filter: Company -> Branch -> Fleet/Owner.
//
// WHY THE STATE LIVES HERE AND NOT IN EACH TAB. Operations, Finance and CRM are
// three components inside one shell. If each held its own filter, switching
// tabs would silently reset the scope — you would narrow Finance to Gautam
// Prasad, glance at Operations, come back and be reading the whole group again
// without anything on screen having changed. One source of truth, held by the
// shell, passed down.
//
// It is also persisted to sessionStorage so a refresh keeps the scope. Session,
// not local: a filter is a "what am I looking at right now" state, and coming
// back tomorrow to a dashboard silently restricted to one branch is a good way
// to misread the business.
import { useCallback, useEffect, useState } from 'react';

const KEY = 'pt_dash_filter_v1';
export const EMPTY = { companyId: '', branchId: '', owner: '', fleet: '' };

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
  } catch { return { ...EMPTY }; }
}

export default function useFilters() {
  const [filters, setFilters] = useState(read);

  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify(filters)); } catch { /* private mode */ }
  }, [filters]);

  const set = useCallback((patch) => {
    setFilters((f) => {
      const next = { ...f, ...patch };
      // Changing the company invalidates the branch beneath it — a Bongaigaon
      // branch id means nothing under a different firm, and leaving it set
      // would return an empty dashboard that looks like "no data" rather than
      // "impossible combination".
      if (patch.companyId !== undefined && patch.companyId !== f.companyId) next.branchId = '';
      return next;
    });
  }, []);

  const clear = useCallback(() => setFilters({ ...EMPTY }), []);

  const active = !!(filters.companyId || filters.branchId || filters.owner || filters.fleet);

  /** Query string for the dashboard APIs. Empty values are omitted entirely so
   *  the server sees "absent" rather than an empty string to interpret. */
  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (filters.companyId) p.set('company_id', filters.companyId);
    if (filters.branchId) p.set('branch_id', filters.branchId);
    if (filters.owner) p.set('owner', filters.owner);
    if (filters.fleet) p.set('fleet', filters.fleet);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [filters]);

  return { filters, set, clear, active, qs };
}
