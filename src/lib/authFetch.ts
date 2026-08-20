// src/lib/authFetch.ts
// ─────────────────────────────────────────────────────────────────────────────
// Attaches the logged-in staff member's bearer token to ERP API calls.
//
// THE BUG THIS FIXES. 64 routes across 11 modules are guarded by
// requireAdminOrService, and almost none of the screens that call them ever sent
// an Authorization header. Exception Resolution is the clearest case: its
// Resolve, Dismiss and Scan buttons post with `{ 'Content-Type': ... }` and
// nothing else, so every one of them came back 401 and the screen built to clear
// the backlog could not clear anything. Ten duplicate-billing exceptions worth
// ₹9.02 L had been sitting OPEN since May behind a button that could not work.
//
// WHY ONE WRAPPER AND NOT A HEADER PER CALL SITE. Exactly the argument
// dataChangeBus.ts already makes for the same reason: there is no central API
// client here, writes are spread across ~200 direct fetch() calls in 64 files,
// and the screen somebody adds next month would forget the header and
// rediscover this bug. Patching one screen fixes one screen. Wrapping fetch
// fixes the ones nobody has looked at yet, including the two portals.
//
// ── THE FOUR RULES, AND WHY EACH ONE EXISTS ────────────────────────────────
//
// 1. NEVER OVERWRITE AN EXISTING Authorization HEADER. The driver portal signs
//    its own requests with `prasad_driver_token`, a different credential for a
//    different subject. Overwriting it would hand a driver's session the staff
//    token — a privilege escalation dressed as a bug fix. A caller that has
//    already decided who it is always wins.
//
// 2. ONLY THE ERP'S OWN ORIGIN. Matching on the path alone would be enough
//    today, because the only third parties this app calls are Gmail
//    (`/gmail/v1/`) and the WhatsApp engine (no versioned path). It is not
//    enough tomorrow: the first external service that happens to expose
//    `/api/v1/` would silently receive a staff bearer token. The origin is
//    checked as well, so a leak needs someone to change the API base, not
//    merely to add a URL.
//
// 3. READ THE TOKEN AT CALL TIME, NEVER AT INSTALL TIME. This installs before
//    render; login happens minutes later. A token captured at install is
//    forever null, which is the same 401 with more machinery behind it.
//
// 4. FAIL OPEN, NEVER THROW. If anything here throws, the request goes out
//    exactly as the caller built it. Adding a header must never be able to
//    break a call that would otherwise have worked.
//
// WHAT THIS DOES NOT FIX. A 401 means "no credential"; a 403 means "not allowed"
// and is a different answer to a different question. requireAdminRole admits
// only SUPER_ADMIN and ADMIN, so a VIEWER now reaches the server and is properly
// refused instead of being refused for the wrong reason. That refusal is the
// system working. Widening who may resolve an exception is a permissions
// decision for the owner, not something a fetch wrapper should quietly grant.
import { API_BASE } from './apiBase';

/** Where the staff session token lives. Set by Login, cleared by App on 401. */
const TOKEN_KEY = 'prasad_token';

/** Our API's own paths. Gmail is `/gmail/v1/`, so it does not match. */
const ERP_PATH = /\/api\/v1\//;

let installed = false;

/**
 * The origin the ERP API is served from.
 *
 * API_BASE is deliberately an ORIGIN with no `/api` on the end, and is the empty
 * string when the app is same-origin behind nginx. Both shapes resolve here.
 */
function apiOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return API_BASE ? new URL(API_BASE, window.location.href).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

/** True only for a call to our own API, by origin AND path. */
function isErpCall(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl, window.location.href);
    return ERP_PATH.test(u.pathname) && u.origin === apiOrigin();
  } catch {
    return false;
  }
}

/** Does the caller already say who it is? Handles every Headers shape. */
function hasAuth(init?: RequestInit): boolean {
  const h = init?.headers;
  if (!h) return false;
  if (h instanceof Headers) return h.has('authorization');
  if (Array.isArray(h)) return h.some(([k]) => String(k).toLowerCase() === 'authorization');
  return Object.keys(h as Record<string, string>).some((k) => k.toLowerCase() === 'authorization');
}

/** Merge the bearer in, preserving whatever headers the caller set. */
function withAuth(init: RequestInit | undefined, token: string): RequestInit {
  const next: RequestInit = { ...(init ?? {}) };
  const h = init?.headers;
  if (h instanceof Headers) {
    const copy = new Headers(h);
    copy.set('Authorization', `Bearer ${token}`);
    next.headers = copy;
  } else if (Array.isArray(h)) {
    next.headers = [...h, ['Authorization', `Bearer ${token}`]];
  } else {
    next.headers = { ...(h as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
  }
  return next;
}

/** Install the wrapper once, at app start. Idempotent. */
export function installAuthFetch(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Decide FIRST, send once. An earlier draft wrapped the call itself in the
    // try/catch, which meant a genuine network failure — `TypeError: Failed to
    // fetch` — landed in the fallback and re-sent the request. A retry nobody
    // asked for is how one POST becomes two vouchers.
    let finalInit = init;
    try {
      // A Request object carries its own headers and, when it has a body, a
      // stream that cannot be re-wrapped without consuming it. Nothing in this
      // app constructs one; if that changes, the caller sets its own header
      // rather than this silently rebuilding the request.
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      if (!isRequest) {
        const url = typeof input === 'string' ? input : (input as URL).href;
        if (isErpCall(url) && !hasAuth(init)) {
          const token = localStorage.getItem(TOKEN_KEY);
          if (token) finalInit = withAuth(init, token);
        }
      }
    } catch {
      // Rule 4. A failure to decide is a decision to change nothing.
      finalInit = init;
    }
    return original(input as any, finalInit);
  };
}

export default installAuthFetch;
