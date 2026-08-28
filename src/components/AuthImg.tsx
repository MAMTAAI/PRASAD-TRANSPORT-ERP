import React, { useEffect, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

/**
 * An <img> for a file the API will only hand to a signed-in caller.
 *
 * GET /api/v1/files/* requires a bearer token, and a browser never sends one
 * from an <img src> — authFetch patches window.fetch, not the image loader.
 * So every driver photo answered 401 and rendered as a broken image: 104 of
 * them in the production log between 20 and 28 Aug, which is why the passport
 * circle on the driver screen sat empty for drivers who DO have a photo on
 * file.
 *
 * The route is deliberately NOT made public to fix this. The same endpoint
 * serves Aadhaar, PAN and bank passbook scans, and an unguessable path is not
 * access control. Instead the bytes are fetched with the token and handed to
 * the tag as an object URL.
 *
 * Anything already displayable — a blob: preview of a file the operator just
 * picked, or an absolute Drive/Firebase URL — is passed straight through.
 */
export default function AuthImg({
  src,
  alt = '',
  style,
  fallback = null,
}: {
  src?: string | null;
  alt?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
}) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    const raw = String(src ?? '').trim();
    if (!raw) { setUrl(''); return; }
    // Only our own file route needs the token.
    if (!/^\/?api\/v1\/files\//.test(raw)) { setUrl(raw); return; }

    let cancelled = false;
    let objectUrl = '';
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/${raw.replace(/^\/+/, '')}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // A missing or forbidden photo shows the fallback, not a broken icon.
        if (!cancelled) setUrl('');
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (!url) return <>{fallback}</>;
  return <img src={url} alt={alt} style={style} />;
}
