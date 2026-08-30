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
import { emit } from '../agents/bus.js';

// Infer the document kind from the stored key so BHUVANESHWARI (the OCR/vault
// agent) can classify without re-reading the bytes. drivers/<id>/dl_photo →
// 'DL', vehicle-docs/<plate>/fitness_… → 'FITNESS', etc. Best-effort only; an
// unrecognised shape is 'UNCLASSIFIED', which the agent routes to review.
function inferDocType(key) {
  const seg = String(key).toLowerCase();
  if (/\/dl[_./]|driving/.test(seg)) return 'DL';
  if (/aadh?ar/.test(seg)) return 'AADHAAR';
  if (/\bpan\b|pan_/.test(seg)) return 'PAN';
  if (/fitness/.test(seg)) return 'FITNESS';
  if (/insur/.test(seg)) return 'INSURANCE';
  if (/permit/.test(seg)) return 'PERMIT';
  if (/\brc\b|rc_/.test(seg)) return 'RC';
  if (/puc|pollution/.test(seg)) return 'PUC';
  if (/fuel|hsd|slip/.test(seg)) return 'FUEL_SLIP';
  if (/toll|fastag/.test(seg)) return 'TOLL';
  return 'UNCLASSIFIED';
}

// Only what a document archive should ever hold. An upload endpoint that
// accepts anything is an upload endpoint that will eventually serve a script
// back to a browser from the app's own origin.
const ALLOWED = new Map([
  ['image/webp', '.webp'], ['image/jpeg', '.jpg'], ['image/png', '.png'],
  ['application/pdf', '.pdf'],
]);

const fail = (reply, code, status, detail) => reply.code(status).send({ error: code, detail });

// ── WHOSE DOCUMENT IS THIS ───────────────────────────────────────────────────
// The stored key IS the party: uploads are laid out `drivers/<driverId>/...`,
// `vehicles/<vehicleId>/...` and `vehicle-docs/<PLATE>/...` (see
// services/fileIntoStorage.js). apiGuard lets a driver/vendor/customer session
// into /files at all — because they legitimately fetch their OWN photo and their
// portal bills — so the object-level lock has to live here: without it, a driver
// holding one login could pull any other driver's DL, Aadhaar and bank passbook
// by walking the driver ids the masters list hands out.
//
// The rule is strict on purpose. Staff and the service caller manage the whole
// vault and see everything. A DRIVER sees only their own `drivers/<sub>/...`
// folder. Nobody external reaches another party's KYC. A vendor/customer keeps
// every OTHER prefix (their portal uploads), so this narrows exactly the
// driver/vehicle KYC surface and nothing else.
const EXTERNAL_FILE_ROLES = new Set(['DRIVER', 'VENDOR', 'CUSTOMER']);
const KYC_PREFIXES = ['drivers/', 'vehicles/', 'vehicle-docs/'];

function mayAccessKey(user, key) {
  const role = user?.role;
  // Staff (SUPER_ADMIN/ADMIN/VIEWER/…) and the SERVICE caller: the vault is theirs.
  if (!EXTERNAL_FILE_ROLES.has(role)) return true;
  const norm = String(key).replace(/^\/+/, '');
  const isKyc = KYC_PREFIXES.some((p) => norm.startsWith(p));
  // A vendor/customer has no business in the driver/vehicle KYC tree at all.
  if (role !== 'DRIVER') return !isKyc;
  // A driver may read ONLY their own folder. `sub` is the driver id for a driver
  // session (auth.routes.js mints it from drivers.id).
  if (norm.startsWith('drivers/')) return norm.split('/')[1] === String(user.sub);
  // Vehicle KYC is resolved by plate/id, which a driver session cannot be tied
  // to here without an assignment lookup — kept closed rather than guessed.
  if (norm.startsWith('vehicles/') || norm.startsWith('vehicle-docs/')) return false;
  return true;  // non-KYC object (e.g. a bill the driver themselves uploaded)
}

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

    // An external session may not overwrite another party's KYC by choosing the
    // key. `mayAccessKey` allows a driver only their own `drivers/<sub>/…` folder
    // and refuses vendors/customers the KYC tree entirely, so a caller cannot
    // POST `path=drivers/<someone-else>/dl_photo` and silently replace it.
    if (!mayAccessKey(req.user, base + ext)) {
      return fail(reply, 'NOT_YOUR_DOCUMENT', 403, 'cannot write a document under another party');
    }
    try {
      const out = await put(safeKey(base + ext), buffer, contentType);
      // Tell the swarm a document landed. BHUVANESHWARI (AGENT_04, OCR/vault)
      // subscribes to document.uploaded but nothing emitted it, so it sat at
      // zero runs while uploads piled up — the OCR/classify step never fired.
      // The handler is non-destructive (it classifies and routes low-confidence
      // scans to review; it never writes a ledger or deletes the file), so this
      // is safe to fire on every stored object. Best-effort: a bus hiccup must
      // never fail the upload the operator just made.
      try {
        await emit('document.uploaded', {
          aggregate: 'document', aggregateId: out.key,
          payload: { s3_key: out.key, doc_type: inferDocType(out.key), content_type: contentType, bytes: out.bytes },
        });
      } catch (busErr) {
        req.log?.warn?.(`document.uploaded emit failed (upload still saved): ${busErr.message}`);
      }
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
    // Object-level ownership: a driver/vendor/customer session may not read
    // another party's KYC even though apiGuard let it into /files. Staff and the
    // service caller fall straight through.
    if (!mayAccessKey(req.user, req.params['*'])) {
      return fail(reply, 'NOT_YOUR_DOCUMENT', 403, 'this document belongs to another party');
    }
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
    // Deleting a document of record is staff work. Before this, any authenticated
    // session — a driver, a rejected vendor still holding a token — could unlink
    // every RC, insurance, POD and KYC scan, silently and unrecoverably.
    if (EXTERNAL_FILE_ROLES.has(req.user?.role)) {
      return fail(reply, 'STAFF_ONLY', 403, 'documents can only be removed by staff');
    }
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
