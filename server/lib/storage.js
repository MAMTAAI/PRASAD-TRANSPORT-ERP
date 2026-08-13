// server/lib/storage.js
// ─────────────────────────────────────────────────────────────────────────────
// Object storage for uploaded documents — the replacement for Firebase Storage.
//
// WHY A DRIVER SEAM RATHER THAN JUST S3. .env.example has carried S3_BUCKET and
// AWS_REGION for a while, but this box has no AWS credentials at all (no
// ~/.aws, nothing in its .env) — the same reason the database runs on the
// instance instead of RDS. Writing an S3-only backend would have produced code
// that cannot run here and cannot be tested here, which is worse than no code.
//
// So the interface is the contract and the driver is a detail:
//
//   local   writes under UPLOAD_DIR and serves through GET /api/v1/files/*.
//           Files arrive already compressed to ~140 KB by the browser, so this
//           is a few GB even at years of volume.
//   s3      a drop-in: implement put/get/remove against the bucket and set
//           STORAGE_DRIVER=s3. Nothing above this module changes — the stored
//           URL is produced by `publicUrl()`, so old rows keep resolving.
//
// ⚠️ DISK. /var/www lives on the box's single 100 GB root volume, which was 91%
// full when this was written (9.4 GB free, shared with the trading system).
// `stats()` is exposed so an operator can see the usage, and the local driver
// refuses to write once the free space falls under LOCAL_MIN_FREE_MB rather
// than filling the disk out from under the other services on the machine.
// ─────────────────────────────────────────────────────────────────────────────
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, stat, unlink, readdir, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// resolve() rather than the raw env value: UPLOAD_DIR is compared against
// join()ed paths, and join() emits the platform separator. An env var written
// with forward slashes on Windows (or with a trailing slash anywhere) made
// every legitimate key look like an escape attempt.
const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || join(process.cwd(), 'uploads'));
const LOCAL_MIN_FREE_MB = Number.parseInt(process.env.LOCAL_MIN_FREE_MB ?? '1024', 10);
const MAX_BYTES = Number.parseInt(process.env.UPLOAD_MAX_BYTES ?? String(25 * 1024 * 1024), 10);

// s3 only when a bucket AND credentials exist. Naming a bucket without keys is
// how you get an upload path that fails only in production.
export const DRIVER = (process.env.STORAGE_DRIVER
  || (process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID ? 's3' : 'local')).toLowerCase();

export class StorageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── Key hygiene ─────────────────────────────────────────────────────────────
// Keys come from the browser (they mirror the old Firebase paths, e.g.
// `drivers/<id>/dl_photo.webp`). A key is joined onto a real directory, so
// traversal has to be impossible rather than unlikely: reject anything with a
// segment that is not a plain name.
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function safeKey(raw) {
  const key = String(raw ?? '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!key || key.length > 400) throw new StorageError('BAD_KEY', 'key missing or too long');
  const parts = key.split('/');
  if (parts.length > 8) throw new StorageError('BAD_KEY', 'key nested too deeply');
  for (const p of parts) {
    if (!KEY_SEGMENT.test(p)) throw new StorageError('BAD_KEY', `bad path segment '${p}'`);
  }
  return parts.join('/');
}

/** The URL stored in the database. Relative on purpose — the SPA and the API
 *  share an origin behind nginx, so a stored absolute host would break the day
 *  the domain changes (which is exactly what the Firebase URLs did). */
export const publicUrl = (key) => `/api/v1/files/${key}`;

// ── local driver ────────────────────────────────────────────────────────────
const localPath = (key) => {
  // Both sides resolved, so the comparison is separator-agnostic. This is the
  // belt to safeKey()'s braces — safeKey already rejects '..' segments, but a
  // containment check is the one that has to hold if that ever regresses.
  const full = resolve(UPLOAD_DIR, key);
  if (full !== UPLOAD_DIR && !full.startsWith(UPLOAD_DIR + sep)) {
    throw new StorageError('BAD_KEY', 'key escapes the upload directory');
  }
  return full;
};

async function freeMb() {
  try {
    const s = await statfs(UPLOAD_DIR);
    return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
  } catch { return null; }
}

const local = {
  async put(key, buffer, contentType) {
    const free = await freeMb();
    if (free !== null && free < LOCAL_MIN_FREE_MB) {
      throw new StorageError('NO_SPACE',
        `only ${free} MB free on the upload volume (floor is ${LOCAL_MIN_FREE_MB} MB) — uploads are refused rather than filling the disk the trading system shares`);
    }
    const full = localPath(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return { key, url: publicUrl(key), bytes: buffer.length, contentType, driver: 'local' };
  },
  async openStream(key) {
    const full = localPath(key);
    const st = await stat(full).catch(() => null);
    if (!st || !st.isFile()) return null;
    return { stream: createReadStream(full), bytes: st.size };
  },
  async remove(key) { await unlink(localPath(key)).catch(() => {}); },
  async stats() {
    let files = 0, bytes = 0;
    const walk = async (dir, depth = 0) => {
      if (depth > 8) return;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else { files++; bytes += (await stat(p).catch(() => ({ size: 0 }))).size; }
      }
    };
    await walk(UPLOAD_DIR);
    return { driver: 'local', dir: UPLOAD_DIR, files, bytes, free_mb: await freeMb(), min_free_mb: LOCAL_MIN_FREE_MB };
  },
};

// ── s3 driver (not implemented — see the header) ────────────────────────────
// To enable: add @aws-sdk/client-s3, implement these three against the bucket,
// set S3_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, STORAGE_DRIVER=s3.
// `publicUrl()` should then return the CDN/bucket URL. Nothing else changes.
const s3 = {
  async put() { throw new StorageError('DRIVER_UNAVAILABLE', 's3 driver is not implemented — no credentials on this host; see server/lib/storage.js'); },
  async openStream() { throw new StorageError('DRIVER_UNAVAILABLE', 's3 driver is not implemented'); },
  async remove() { throw new StorageError('DRIVER_UNAVAILABLE', 's3 driver is not implemented'); },
  async stats() { return { driver: 's3', implemented: false }; },
};

const drivers = { local, s3 };
const active = drivers[DRIVER] ?? local;

export async function put(key, buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new StorageError('EMPTY', 'nothing to store');
  if (buffer.length > MAX_BYTES) throw new StorageError('TOO_LARGE', `file exceeds ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
  return active.put(safeKey(key), buffer, contentType || 'application/octet-stream');
}
export const openStream = (key) => active.openStream(safeKey(key));
export const remove = (key) => active.remove(safeKey(key));
export const stats = () => active.stats();
export { MAX_BYTES, UPLOAD_DIR };
