// src/lib/dataChangeBus.ts
// ─────────────────────────────────────────────────────────────────────────────
// Makes a write announce itself, so every live panel refreshes without a reload.
//
// THE LISTENER EXISTED AND NOTHING EVER FIRED IT. useDashboardData has listened
// for 'erp:data-changed' since the dashboard fix, and the only dispatchEvent in
// the whole front end was the example INSIDE THE COMMENT describing it. So the
// hooks were wired to a signal no screen sent: every "live" panel was really
// just its own poll, and the instant refresh was theoretical.
//
// WHY A fetch WRAPPER AND NOT A DISPATCH PER SCREEN. There is no central API
// client here -- 196 write call sites across 64 files call fetch() directly.
// Adding a line to each is 196 edits, and the 197th screen somebody writes next
// month forgets it, which puts us back where we started with no way to notice.
// Wrapping fetch once covers every existing caller and every future one, and a
// screen author has to do nothing at all to opt in.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never reads or clones a response body --
// that would consume the stream the caller is about to read. It only looks at
// the method, the URL and res.ok. If anything in that inspection throws, the
// response is returned untouched: observing a request must never be able to
// break it.
const EVENT = 'erp:data-changed';
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;

// Only our own API. A POST to Ollama, the maps service or the WhatsApp engine
// is not an ERP data change and must not spray refetches across the dashboards.
const ERP_API = /\/api\/v1\//;

// A login is not a data change, and refetching the books on every token refresh
// is noise on the one path that runs most often.
const NOT_DATA = /\/api\/v1\/auth\//;

// Bursts coalesce into one event. Saving a trip writes the trip, its legs and a
// voucher in quick succession; that is ONE thing happening, and three refetches
// of a heavy dashboard payload would be the "fix" causing the load.
const COALESCE_MS = 250;

let pending: ReturnType<typeof setTimeout> | null = null;
let installed = false;

/**
 * Announce that ERP data changed. Safe to call directly from a screen that
 * writes by some path other than fetch (a socket, an upload widget).
 */
export function notifyDataChanged(detail: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    window.dispatchEvent(new CustomEvent(EVENT, { detail }));
  }, COALESCE_MS);
}

/** Install the wrapper once, at app start. Idempotent. */
export function installDataChangeBus(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input as any, init);
    try {
      const method = String(
        init?.method ?? (input as Request)?.method ?? 'GET',
      );
      if (!WRITE_METHOD.test(method)) return res;
      // A failed write changed nothing. Refreshing on a 409 or a 422 would just
      // re-read the same rows and make a rejected save look like a saved one.
      if (!res.ok) return res;

      const url =
        typeof input === 'string' ? input
          : input instanceof URL ? input.href
            : (input as Request)?.url ?? '';

      if (!ERP_API.test(url) || NOT_DATA.test(url)) return res;

      notifyDataChanged({ url, method: method.toUpperCase() });
    } catch {
      // Deliberately swallowed. See the note above: this is observation.
    }
    return res;
  };
}

export default installDataChangeBus;
