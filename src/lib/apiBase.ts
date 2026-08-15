// src/lib/apiBase.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ERP API base URL, resolved ONCE for the whole front end.
//
// WHY THIS FILE EXISTS. Every screen used to carry its own copy of
//   const API = import.meta.env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300'
// and VITE_AGENT_API_URL was never set at build time, so the deployed bundle
// shipped `http://127.0.0.1:3300` to every visitor. A browser that was not the
// server itself then called ITS OWN machine for every request — login included,
// which surfaced as "Login failed! Check your internet connection" while the
// API was perfectly healthy. The site only worked for someone running the API
// locally; no other staff member could ever have used it.
//
// RESOLUTION ORDER
//   1. VITE_AGENT_API_URL, when set at build time (explicit wins).
//   2. Served from a real host  -> '' = SAME-ORIGIN. nginx already proxies
//      /api on both prasadtransport.com and www.prasadtransport.com, so this
//      needs no CORS and cannot drift between the two hostnames.
//   3. Served from localhost    -> http://127.0.0.1:3300 for local dev.
//
// Callers keep using `${API}/api/v1/...`; with same-origin that is simply
// `/api/v1/...`.
// ─────────────────────────────────────────────────────────────────────────────

export const API_BASE: string = (() => {
  const fromEnv = (import.meta as any).env?.VITE_AGENT_API_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim().replace(/\/+$/, ''); // never leave a trailing slash
  }

  if (typeof window !== 'undefined' && window.location) {
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
    if (!isLocal) return ''; // production: same-origin
  }

  return 'http://127.0.0.1:3300'; // local development
})();

export default API_BASE;
