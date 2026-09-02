// server/lib/shareLinks.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE FILE, ONE HOLDER, ONE WINDOW — the grant behind every document this ERP
// hands to somebody who has no login.
//
// The WhatsApp engine cannot send media (Option A, agreed 1-Sep-2026), so an
// attachment goes into the vault and the number is sent a link. Every other
// door into the vault demands a session; a driver tapping a WhatsApp link has
// none, and by design has no password either. This is that door, and it is
// deliberately the narrowest one that works:
//
//   · the token reaches EXACTLY ONE storage key — it cannot list or search;
//   · it expires, and the expiry is not optional;
//   · it can be revoked the moment a document goes to the wrong number;
//   · every open is counted and timestamped, so "did the driver open it" is a
//     question the office can answer instead of guessing.
//
// Only the SHA-256 is stored, exactly as driver_login_links does — a dump of
// this table must not be a bundle of working links to company paperwork.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db/pool.js';

const MIN_HOURS = 1;
// Seven days. Long enough that a driver who reads WhatsApp on Sunday still gets
// the paper, short enough that a sold handset is not carrying a live company
// document a year later.
const DEFAULT_HOURS = 168;
const MAX_HOURS = 720;   // 30 days, the ceiling for an LR a customer files away

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

/** The address a DRIVER's handset can open, which is not necessarily the one
 *  the minting request arrived on — the office may be on the LAN while the
 *  driver is on mobile data. Same variable the driver-app link already uses. */
export function publicBase() {
  return String(process.env.PUBLIC_APP_URL || process.env.DRIVER_APP_URL || '').replace(/\/+$/, '');
}

/**
 * Mint a share link. Returns the token ONCE — it is never readable again.
 *
 * @param {object} spec
 *   storageKey   — the vault key this token may read, and the only one
 *   filename     — what the browser should call it on download
 *   contentType  — stored so the public route does not have to guess from the
 *                  extension of an attacker-supplied string
 *   purpose      — 'WA_MEDIA' | 'LR_COPY' | …  (audit vocabulary, not a switch)
 *   phone        — the number it is being sent to, last ten digits; null when
 *                  it is only being previewed in the office
 *   tripId       — the trip it belongs to, where there is one
 *   createdBy    — the staff user id from the session, never from the body
 *   hours        — validity; clamped to [1, 720]
 */
export async function mintShareLink({
  storageKey, filename = null, contentType = null, purpose = 'WA_MEDIA',
  phone = null, tripId = null, createdBy = null, hours = DEFAULT_HOURS,
} = {}) {
  if (!storageKey) throw new Error('mintShareLink: storageKey is required');
  const validFor = Math.min(Math.max(Number(hours) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
  const token = randomBytes(32).toString('base64url');
  const { rows } = await query(
    `INSERT INTO share_links (token_hash, storage_key, filename, content_type,
                              purpose, phone, trip_id, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid, now() + ($9 || ' hours')::interval)
     RETURNING expires_at`,
    [hashToken(token), storageKey, filename, contentType, purpose, phone, tripId,
     createdBy, String(validFor)]);
  const base = publicBase();
  return {
    token,
    // Relative when PUBLIC_APP_URL is unset, so a misconfigured box produces a
    // visibly broken link rather than one pointing at localhost — which is the
    // admin's own laptop from the driver's side, and fails silently.
    url: `${base}/api/v1/share/${token}`,
    absolute: !!base,
    expires_at: rows[0].expires_at,
  };
}

/**
 * Spend a token: resolve it to its object and record the open.
 *
 * Revocation is checked BEFORE expiry so a revoke bites immediately, and both
 * are checked in the same UPDATE that increments the counter — a check-then-act
 * split would let two simultaneous taps race past a revoke.
 *
 * @returns the row, or null when the token is unknown, expired or revoked.
 *          The caller must not distinguish those three to the outside world:
 *          telling a stranger that a token *existed* is information.
 */
export async function spendShareToken(token) {
  const t = String(token ?? '').trim();
  // Length-checked before touching the database so a 5 MB path segment is not
  // hashed and looked up.
  if (!t || t.length > 128) return null;
  const { rows } = await query(
    `UPDATE share_links
        SET opens = opens + 1,
            first_open_at = COALESCE(first_open_at, now()),
            last_open_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING storage_key, filename, content_type, purpose, phone, trip_id, opens`,
    [hashToken(t)]);
  return rows[0] ?? null;
}

/** Pull a link out of circulation. Staff action; the token is gone for good. */
export async function revokeShareLink(token) {
  const { rows } = await query(
    `UPDATE share_links SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING storage_key, phone`, [hashToken(token)]);
  return rows[0] ?? null;
}
