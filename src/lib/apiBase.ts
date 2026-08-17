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
// THE SAME BUG, ONCE MORE, ON THE PHONE. Capacitor serves the bundled web
// assets to the Android WebView from `https://localhost` (androidScheme
// defaults to https, hostname to localhost). That hostname is *literally*
// "localhost", so the dev-fallback branch below matched and the release AAB
// told every handset to call port 3300 on itself. Nothing listens there, so
// the app installed, launched, painted its shell and then failed every single
// request. The bundle shipped on 15-08-2026 has exactly this defect — its
// inlined env object is empty (`G={}`), so nothing overrode the fallback.
//
// A phone is never same-origin with the API: the WebView origin is a local
// scheme with no server behind it. Native therefore needs an ABSOLUTE origin,
// and it must be wrong-loud rather than wrong-quiet.
//
// RESOLUTION ORDER
//   1. VITE_AGENT_API_URL, when set at build time (explicit always wins —
//      this is how a staging or on-prem build is pointed elsewhere).
//   2. Native shell (Capacitor Android/iOS) -> NATIVE_FALLBACK_ORIGIN, the
//      public site. Never same-origin, never loopback.
//   3. Served from a real host  -> '' = SAME-ORIGIN. nginx already proxies
//      /api on both prasadtransport.com and www.prasadtransport.com, so this
//      needs no CORS and cannot drift between the two hostnames.
//   4. Served from localhost    -> http://127.0.0.1:3300 for local dev.
//
// Callers keep using `${API}/api/v1/...`; with same-origin that is simply
// `/api/v1/...`. So this value is an ORIGIN, with no `/api` on the end — a
// base of `https://prasadtransport.com/api` would produce `/api/api/v1/...`
// and 404 every call.
// ─────────────────────────────────────────────────────────────────────────────

// Where a packaged app talks to when the build did not say otherwise. nginx on
// this host proxies /api/ to the Fastify API on :3300.
const NATIVE_FALLBACK_ORIGIN = 'https://prasadtransport.com';

/**
 * Is this bundle running inside a Capacitor shell rather than a browser tab?
 *
 * Three independent signals, because each one alone has a gap:
 *  - `window.Capacitor` is injected by the native bridge, but only after the
 *    bridge script has run, and this module is evaluated at import time.
 *  - `capacitor:` / `ionic:` are the iOS and legacy Android schemes.
 *  - Android's current default is `https://localhost` **with no port**, which
 *    is the case that broke the release build. A real dev server on localhost
 *    always carries a port (5173, 4173), so requiring an empty port keeps this
 *    from hijacking `npm run dev`.
 */
function isNativeShell(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;

  const cap = (window as any).Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return true;
  if (cap && cap.platform && cap.platform !== 'web') return true;

  const { protocol, hostname, port } = window.location;
  if (protocol === 'capacitor:' || protocol === 'ionic:') return true;
  if (protocol === 'https:' && hostname === 'localhost' && !port) return true;

  return false;
}

export const IS_NATIVE_APP: boolean = isNativeShell();

export const API_BASE: string = (() => {
  // TWO SPELLINGS ON PURPOSE. Vite substitutes the exact source text
  // `import.meta.env.VITE_AGENT_API_URL` with a string literal at build time.
  // The optional-chained form `(import.meta as any).env?.VITE_...` is not
  // statically analysable, so Vite cannot do the per-key substitution and
  // instead replaces the bare `import.meta.env` - which in the 15-08-2026
  // build compiled down to a read from an empty object literal (`G={}`). The
  // variable was set and the build still ignored it. The static form is what
  // actually makes the build-time override work; the loose one is kept only
  // so a non-Vite consumer (tests, SSR) still sees a value.
  const fromEnv = import.meta.env.VITE_AGENT_API_URL ?? (import.meta as any).env?.VITE_AGENT_API_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim().replace(/\/+$/, ''); // never leave a trailing slash
  }

  // A packaged app has no origin of its own to fall back on. Say so out loud:
  // the whole point of the 15-08 defect was that a misrouted build looked
  // healthy right up until the first request.
  if (IS_NATIVE_APP) {
    console.warn(
      '[apiBase] native shell built without VITE_AGENT_API_URL — falling back to ' +
        NATIVE_FALLBACK_ORIGIN +
        '. Set it at build time (see scripts/build-android.ps1) to target another environment.',
    );
    return NATIVE_FALLBACK_ORIGIN;
  }

  if (typeof window !== 'undefined' && window.location) {
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
    if (!isLocal) return ''; // production: same-origin
  }

  return 'http://127.0.0.1:3300'; // local development
})();

export default API_BASE;
