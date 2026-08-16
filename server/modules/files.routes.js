// server/modules/files.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/files — document upload and delivery. The replacement for Firebase
// Storage, which was the last Google service the app still wrote to.
//
//   POST /files            multipart: file + path   → { url, key, bytes }
//   GET  /files/*          stream a stored object
//   GET  /files-stats      driver, object count, bytes, free disk
//   POST /files/import     fetch a remote URL and re-host it (used once, to
//                          pull the 17 surviving Firebase objects across)
//
// COMPRESSION STAYS IN THE BROWSER. src/lib/uploadMedia.ts already re-encodes
// images to WebP and rebuilds PDFs to hit ~140 KB before anything is sent, and
// that is deliberate: it saves the bandwidth as well as the disk, and it works
// the same whether the bytes end up on this disk or in a bucket later. The
// server does not re-compress; it stores what it is given, and enforces a
// ceiling in case a caller skips the client path.
// ─────────────────────────────────────────────────────────────────────────────
import multipart from '@fastify/multipart';
import { put, openStream, remove, stats, safeKey, MAX_BYTES, DRIVER, StorageError } from '../lib/storage.js';

// Only what a document archive should ever hold. An upload endpoint that
// accepts anything is an upload endpoint that will eventually serve a script
// back to a browser from the app's own origin.
const ALLOWED = new Map([
  ['image/webp', '.webp'], ['image/jpeg', '.jpg'], ['image/png', '.png'],
  ['application/pdf', '.pdf'],
]);

const fail = (reply, code, status, detail) => reply.code(status).send({ error: code, detail });

export async function registerFileRoutes(app) {
  // Registered here as well as in fleet.routes: Fastify encapsulates plugins
  // per scope, so a sibling module's registration is not visible to this one.
  await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  app.post('/files', async (req, reply) => {
    let part;
    try { part = await req.file(); } catch (e) { return fail(reply, 'BAD_MULTIPART', 400, e.message); }
    if (!part) return fail(reply, 'NO_FILE', 400, 'multipart field "file" is required');

    const contentType = String(part.mimetype || '').split(';')[0].trim();
    if (!ALLOWED.has(contentType)) {
      return fail(reply, 'BAD_TYPE', 415,
        `refused ${contentType || 'unknown type'} — this archive stores ${[...ALLOWED.keys()].join(', ')} only`);
    }

    const buffer = await part.toBuffer();
    // @fastify/multipart truncates at the limit rather than throwing, so a file
    // over the ceiling would otherwise be stored silently half-written.
    if (part.file?.truncated) return fail(reply, 'TOO_LARGE', 413, `file exceeds ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);

    // The client sends the path it wants (mirroring the old Firebase layout).
    // The extension is forced to match the bytes actually received — a .pdf
    // holding a JPEG would be served with the wrong content type forever.
    const wanted = part.fields?.path?.value ?? part.fields?.key?.value ?? '';
    const ext = ALLOWED.get(contentType);
    const base = String(wanted).replace(/\.[^./]+$/, '') || `misc/${Date.now()}`;
    try {
      const out = await put(safeKey(base + ext), buffer, contentType);
      reply.code(201);
      return out;
    } catch (e) {
      if (e instanceof StorageError) {
        const status = { NO_SPACE: 507, TOO_LARGE: 413, BAD_KEY: 400, DRIVER_UNAVAILABLE: 503 }[e.code] ?? 400;
        return fail(reply, e.code, status, e.message);
      }
      throw e;
    }
  });

  app.get('/files/*', async (req, reply) => {
    let found;
    try { found = await openStream(req.params['*']); }
    catch (e) { return fail(reply, e.code ?? 'BAD_KEY', 400, e.message); }
    if (!found) return fail(reply, 'NOT_FOUND', 404, 'no such object');

    const key = req.params['*'];
    const type = key.endsWith('.webp') ? 'image/webp'
      : key.endsWith('.png') ? 'image/png'
      : key.endsWith('.pdf') ? 'application/pdf'
      : 'image/jpeg';
    // Content-addressed enough in practice (paths carry record ids) and these
    // are documents that rarely change, so a long cache is safe and keeps the
    // Node process out of the way of repeat views.
    // ?download=1 turns a view into a save. Without a Content-Disposition the
    // browser renders a PDF inline and the "Download" button is indistinguish-
    // able from "View" — which is what it had been.
    //
    // The filename is sanitised and quoted: it comes from a stored key, and a
    // quote or newline in a Content-Disposition is a header-injection vector,
    // not a cosmetic problem.
    if (req.query?.download === '1' || req.query?.download === 'true') {
      const raw = key.split('/').pop() || 'document';
      const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      reply.header('Content-Disposition', `attachment; filename="${safe}"`);
    }

    reply.header('Content-Type', type)
      .header('Content-Length', found.bytes)
      .header('Cache-Control', 'private, max-age=86400')
      // Never let a stored object be interpreted as markup on our own origin.
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'none'");
    return reply.send(found.stream);
  });

  app.delete('/files/*', async (req, reply) => {
    try { await remove(req.params['*']); return { deleted: true }; }
    catch (e) { return fail(reply, e.code ?? 'BAD_KEY', 400, e.message); }
  });

  app.get('/files-stats', async () => ({ driver: DRIVER, ...(await stats()) }));

  // The one-time Firebase Storage import endpoint has been REMOVED.
  //
  // It existed to pull surviving objects across before the Firebase project was
  // switched off. That is done: a scan of all 677 text columns in the schema
  // finds zero rows pointing at firebasestorage/storage.googleapis.com, so it
  // had nothing left to fetch — and a server-side fetcher on an internal API is
  // not something to leave lying around once it has no purpose.
  //
  // If an old backup ever needs re-hosting, it is a POST /files away with the
  // bytes in hand; it does not need the API to go and get them.
}
