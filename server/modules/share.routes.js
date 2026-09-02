// server/modules/share.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/share/:token — the one public door into the document vault.
//
// It is public because the people it is for cannot log in: a driver tapping a
// WhatsApp link has no session and, by design, no password. Everything that
// makes that safe lives in the token, not in this file — see
// server/lib/shareLinks.js. One object, time-bounded, revocable, counted.
//
// WHAT THIS ROUTE MUST NEVER GROW. No listing, no search, no "related
// documents", no token in a query parameter that a referrer header could leak
// to a third-party page. If a second object ever needs sending, mint a second
// token; that is the whole design.
// ─────────────────────────────────────────────────────────────────────────────
import { openStream } from '../lib/storage.js';
import { isDegraded } from '../db/pool.js';
import { spendShareToken } from '../lib/shareLinks.js';

// Deliberately identical for unknown, expired and revoked. Telling a stranger
// that a token once existed, or that it expired yesterday, is information about
// the office's traffic that they have no business having.
const GONE = (reply) => reply.code(404).type('text/plain; charset=utf-8').send(
  'Yeh link ab kaam nahi karta.\n\n'
  + 'This document link has expired or been withdrawn. Please ask the Prasad '
  + 'Transport office to send it again.\n');

const TYPE_BY_EXT = {
  '.pdf': 'application/pdf', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

export function registerShareRoutes(app) {
  app.get('/share/:token', async (req, reply) => {
    // A degraded database cannot validate the token, and serving the object
    // without validating it is precisely the thing this route exists to
    // prevent. So it fails closed.
    if (isDegraded()) {
      return reply.code(503).type('text/plain; charset=utf-8')
        .send('Service abhi uplabdh nahi hai — thodi der baad koshish karein.\n');
    }

    const grant = await spendShareToken(req.params.token);
    if (!grant) return GONE(reply);

    let found;
    try { found = await openStream(grant.storage_key); }
    catch { return GONE(reply); }
    // The row survived but the bytes did not — a document removed from the
    // vault after the link went out. Same answer: from the holder's side there
    // is nothing to reach.
    if (!found) return GONE(reply);

    const key = String(grant.storage_key);
    const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
    const type = grant.content_type || TYPE_BY_EXT[ext] || 'application/octet-stream';

    // Quoted and sanitised: the filename is stored text, and a quote or a
    // newline in a Content-Disposition is header injection, not a typo.
    const raw = grant.filename || key.split('/').pop() || 'document';
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

    reply
      .header('Content-Type', type)
      .header('Content-Length', found.bytes)
      // inline so a PDF or a photo opens in the phone's browser instead of
      // landing in Downloads unopened — the driver is meant to read it.
      .header('Content-Disposition', `inline; filename="${safe}"`)
      // Never cached by an intermediary: the URL carries a credential.
      .header('Cache-Control', 'private, no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Robots-Tag', 'noindex, nofollow, noarchive')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'none'");
    return reply.send(found.stream);
  });
}
