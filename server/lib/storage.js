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
//   s3      implemented below. Set STORAGE_DRIVER=s3 + S3_BUCKET and give the
//           box credentials (instance role preferred, else AWS_ACCESS_KEY_ID /
//           AWS_SECRET_ACCESS_KEY). Nothing above this module changes — the
//           stored URL is produced by `publicUrl()`, so old rows keep resolving
//           and reads stay behind the app's auth instead of a public bucket.
//
// Switching drivers does NOT move existing objects. Files written under `local`
// stay on disk; point the new driver at a bucket and sync the directory into it
// under the same keys first, or old links 404.
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

// ── s3 driver ───────────────────────────────────────────────────────────────
// Enabled by STORAGE_DRIVER=s3, or automatically when S3_BUCKET and
// AWS_ACCESS_KEY_ID are both present (see DRIVER above).
//
// The SDK is imported lazily. On the local-driver box the @aws-sdk packages may
// be absent or the credential chain unconfigured, and a top-level import would
// turn that into a boot failure for an API that never touches S3. Paying the
// import cost on the first upload instead keeps `STORAGE_DRIVER=local` free.
//
// publicUrl() is deliberately NOT changed to a bucket URL: every stored row
// holds `/api/v1/files/<key>`, so reads keep flowing through GET
// /api/v1/files/* and stay behind the app's own auth. The bucket can then stay
// private — no public-read policy, no signed-URL expiry visible to the client.
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

// Prefix lets one bucket hold several environments (prasad/, staging/) without
// the key hygiene above having to know about it.
const s3Key = (key) => (S3_PREFIX ? `${S3_PREFIX}/${key}` : key);

let _client = null;
async function s3Client() {
  if (_client) return _client;
  if (!S3_BUCKET) throw new StorageError('DRIVER_UNAVAILABLE', 'STORAGE_DRIVER=s3 but S3_BUCKET is not set');
  try {
    const { S3Client } = await import('@aws-sdk/client-s3');
    // No explicit credentials object: the default chain picks up
    // AWS_ACCESS_KEY_ID/SECRET from the environment, or the EC2 instance role
    // when the box has one. An instance role is the better answer on AWS —
    // nothing to rotate, nothing to leak into .env.
    _client = new S3Client({ region: AWS_REGION });
    return _client;
  } catch (e) {
    throw new StorageError('DRIVER_UNAVAILABLE', `@aws-sdk/client-s3 could not be loaded: ${e.message}`);
  }
}

const s3 = {
  async put(key, buffer, contentType) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await s3Client();
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key(key),
      Body: buffer,
      ContentType: contentType,
      // Objects are documents of record (bills, DLs, RCs). Server-side
      // encryption is free and the audit asks for it.
      ServerSideEncryption: 'AES256',
    }));
    return { key, url: publicUrl(key), bytes: buffer.length, contentType, driver: 's3' };
  },

  async openStream(key) {
    const { GetObjectCommand, NoSuchKey } = await import('@aws-sdk/client-s3');
    const client = await s3Client();
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(key) }));
      // Body is a Node Readable under Node's HTTP handler — the same shape
      // createReadStream() returns, so files.routes.js needs no branch.
      return { stream: out.Body, bytes: Number(out.ContentLength ?? 0) };
    } catch (e) {
      // A missing object is `null`, matching the local driver's contract; the
      // route turns that into a 404. Anything else is a real fault and rises.
      if (e instanceof NoSuchKey || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  },

  async remove(key) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await s3Client();
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(key) }));
  },

  async stats() {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await s3Client();
    // Paginated on purpose: ListObjectsV2 caps at 1000 keys per call and the
    // document store passes that within a year. Capped at 20 pages (20k keys)
    // so an operator's health check can never turn into a long bucket scan.
    let files = 0, bytes = 0, token, pages = 0, truncated = false;
    do {
      const out = await client.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET, Prefix: S3_PREFIX || undefined, ContinuationToken: token,
      }));
      for (const o of out.Contents ?? []) { files++; bytes += Number(o.Size ?? 0); }
      token = out.NextContinuationToken;
      if (++pages >= 20 && token) { truncated = true; break; }
    } while (token);
    return { driver: 's3', bucket: S3_BUCKET, prefix: S3_PREFIX || null, region: AWS_REGION, files, bytes, truncated };
  },
};

/** Presigned GET, for the rare case a client must fetch straight from the
 *  bucket (a bulk export, a link mailed out). Unused by the upload path — the
 *  default read route proxies through the API so the bucket stays private. */
export async function presignGet(key, ttlSeconds = Number(process.env.S3_PRESIGN_TTL_SECONDS ?? 900)) {
  if (DRIVER !== 's3') throw new StorageError('DRIVER_UNAVAILABLE', 'presigned URLs need the s3 driver');
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = await s3Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(safeKey(key)) }), { expiresIn: ttlSeconds });
}

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
