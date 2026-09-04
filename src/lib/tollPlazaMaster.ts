// src/lib/tollPlazaMaster.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE GATE LIST, FETCHED ONCE PER PAGE, SHARED BY EVERY MAP.
//
// Owner, 4-Sep-2026: the toll gates must be on the dispatch board and the trip
// sheet and the driver's phone — "har modal par". Four screens each calling
// /toll/plazas on mount is four requests for an answer that is identical and
// changes only when a new crossing lands.
//
// So: one module-level promise. The first map to ask pays for it; every other
// map on the page gets the same array, and React StrictMode's double-mount
// costs nothing.
//
// IT NEVER REJECTS. A map whose gate list failed must still draw its road and
// its pins — the toll strip is the only thing that goes quiet, and it says why.
// Callers that need to distinguish "no gates" from "could not ask" read
// `tollMasterError()`.
// ─────────────────────────────────────────────────────────────────────────────
import { API_BASE } from './apiBase';

export interface TollPlaza {
  id: string;
  name_key: string;
  plaza_name: string;
  lat: number | string | null;
  lng: number | string | null;
  rate: number | string | null;
  rate_source: 'FASTAG_HISTORY' | 'MANUAL';
  observations: number;
  rate_min?: number | string | null;
  rate_max?: number | string | null;
  last_seen?: string | null;
}

let inFlight: Promise<TollPlaza[]> | null = null;
let lastError = '';

/** Every gate we can place on a map. Resolves to [] rather than throwing. */
export function loadTollPlazas(): Promise<TollPlaza[]> {
  if (inFlight) return inFlight;
  inFlight = fetch(`${API_BASE}/api/v1/toll/plazas?located=true`)
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      lastError = '';
      return (j.plazas ?? []) as TollPlaza[];
    })
    .catch((e) => {
      lastError = e?.message || 'toll plaza master unavailable';
      // The failure is NOT cached as a permanent empty: a map mounted during a
      // deploy would otherwise show no gates for the rest of the session.
      inFlight = null;
      return [] as TollPlaza[];
    });
  return inFlight;
}

/** Why the gate list is empty, or '' when it simply is. */
export function tollMasterError(): string { return lastError; }

/** After a rate is typed in, so every open map picks it up without a reload. */
export function primeTollPlaza(saved: TollPlaza): void {
  if (!inFlight || !saved?.name_key) return;
  inFlight = inFlight.then((list) => {
    const i = list.findIndex((p) => p.name_key === saved.name_key);
    if (i < 0) return [...list, saved];
    const next = list.slice();
    next[i] = { ...next[i], ...saved };
    return next;
  });
}
