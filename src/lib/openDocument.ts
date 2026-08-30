// src/lib/openDocument.ts
// ─────────────────────────────────────────────────────────────────────────────
// Open a stored document (PDF or image) from the ERP file vault in a new tab.
//
// WHY A HELPER AND NOT A PLAIN <a href>. GET /api/v1/files/* requires a bearer
// token (the same route serves DLs, Aadhaar and bank passbooks — an unguessable
// path is not access control). A browser sends NO Authorization header when it
// follows an <a href> or a window.open(url): those are navigations, not fetch()
// calls, so authFetch's window.fetch patch never sees them. The link therefore
// resolved to a 401 and the tab painted blank — which is exactly the "PDF shows
// nothing on Driver Master and Vehicle Vault" the office reported, for the 271
// documents whose bytes are on this box's disk.
//
// The fix mirrors AuthImg: fetch the bytes WITH the token (window.fetch is
// patched to attach it for same-origin /api/v1 calls), wrap them in an object
// URL, and point the tab at that. Drive/Firebase and any other absolute URL are
// already reachable without our token, so they open directly.
//
// POPUP BLOCKERS. A tab opened after an await has lost the click's transient
// activation and is blocked. So the blank tab is opened SYNCHRONOUSLY on the
// click and only its location is set once the blob is ready.
// ─────────────────────────────────────────────────────────────────────────────
import { API_BASE } from './apiBase';

/** True for a link the browser can open on its own — Drive, Firebase, any http(s)
 *  URL that is NOT our token-guarded file route. */
function isDirectlyOpenable(raw: string): boolean {
  if (!/^https?:\/\//i.test(raw)) return false;
  return !/\/api\/v1\/files\//.test(raw);
}

/** Normalise a stored value to the file key, whether it was saved as
 *  "vehicle-docs/x.pdf" or "/api/v1/files/vehicle-docs/x.pdf". */
function keyOf(raw: string): string {
  return raw.replace(/^\/+/, '').replace(/^api\/v1\/files\//, '');
}

export async function openDocument(
  rawLink: string | null | undefined,
  opts: { download?: boolean } = {},
): Promise<void> {
  const raw = String(rawLink ?? '').trim();
  if (!raw) { alert('No document file is on record for this entry.'); return; }

  // Drive / Firebase / other absolute link — open as-is.
  if (isDirectlyOpenable(raw)) {
    window.open(raw, '_blank', 'noopener');
    return;
  }

  const url = `${API_BASE}/api/v1/files/${keyOf(raw)}${opts.download ? '?download=1' : ''}`;

  // Open the tab up front, inside the user gesture, so it is not popup-blocked.
  const win = window.open('', '_blank');
  try {
    const res = await fetch(url); // window.fetch is patched to attach the bearer
    if (!res.ok) {
      // 403 here is the strict per-document lock doing its job; 404 is a missing
      // Firebase/Drive object whose bytes never came across. Both should read as
      // "cannot open", not a blank tab.
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    if (win) win.location.href = objUrl;
    else window.open(objUrl, '_blank', 'noopener');
    // Give the tab time to load before the URL is released.
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
  } catch {
    if (win) win.close();
    alert(
      'Could not open this document. It is either missing from storage ' +
      '(an old Firebase/Drive file that was not migrated) or belongs to another party.',
    );
  }
}

export default openDocument;
