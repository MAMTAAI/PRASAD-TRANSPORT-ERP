// ═══════════════════════════════════════════════════════════════════════════
// fileIntoStorage.js — put a queued document where the app can actually serve it.
//
// THE BUG THIS EXISTS TO FIX.
// The queue holds files at raw vault paths — F:\Prasad_Transport_Data\...\ab12.pdf.
// Writing that path straight into drivers.dl_photo_url "worked": the column was
// set, the queue emptied, the counts went up. It just could not be opened.
// Every other driver document is stored through server/lib/storage.js and
// referenced as /api/v1/files/<key>, which files.routes serves; a raw drive path
// means nothing to a browser. Sixty-six documents were filed that way before
// anyone would have clicked one.
//
// So filing now MOVES THE BYTES into app storage and returns the served URL.
// The vault copy stays where it is — this is a publish, not a relocation, and
// the vault remains the thing the importer can re-run against.
// ═══════════════════════════════════════════════════════════════════════════
import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { put, publicUrl, safeKey } from '../lib/storage.js';

const TYPES = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

/** True for a value the browser can already fetch — an app key or a real URL. */
export const isServable = (u) =>
  typeof u === 'string' && (u.startsWith('/api/') || /^https?:\/\//i.test(u));

/**
 * Publish a file from disk into app storage.
 *
 * @param {string} sourcePath  where the bytes are now
 * @param {string} keyBase     e.g. `drivers/<uuid>/dl_photo` — extension is added
 * @returns {Promise<string>}  the /api/v1/files/... URL to store on the record
 */
export async function fileIntoStorage(sourcePath, keyBase) {
  const ext = extname(sourcePath).toLowerCase() || '.bin';
  const buffer = await readFile(sourcePath);
  const key = safeKey(`${keyBase}${ext}`);
  await put(key, buffer, TYPES[ext] ?? 'application/octet-stream');
  return publicUrl(key);
}

/**
 * The naming every driver document follows, so a slot is predictable and a
 * re-file overwrites its own key rather than accumulating copies.
 */
export const driverDocKey = (driverId, slot) =>
  `drivers/${driverId}/${String(slot).replace(/_url$/, '')}`;

/** Same idea for a vehicle document. */
export const vehicleDocKey = (vehicleId, docType) =>
  `vehicles/${vehicleId}/${String(docType)}`;

export default { fileIntoStorage, driverDocKey, vehicleDocKey, isServable };
