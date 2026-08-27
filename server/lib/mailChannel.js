// server/lib/mailChannel.js
// ─────────────────────────────────────────────────────────────────────────────
// Outbound email — the second delivery lane for one-time codes.
//
// WHY EMAIL AS WELL AS WHATSAPP. otpChannel.js already carries the warning that
// WhatsApp is not SMS: a staff member whose WhatsApp is signed out, or who has
// no number on file at all, cannot receive a code that way, and the engine has
// to be linked or every send fails. A password reset that can only arrive over
// one channel inherits that channel's whole failure surface. Email is the lane
// the firm can always reach a staff member on, because `users.email` is the
// login identifier itself — it is guaranteed present and already known good.
//
// The two are sent side by side and either one succeeding is enough.
//
// THE TRANSPORT ALREADY EXISTED, UNSHARED. bridge.cjs has been sending mail
// through the google-key.json service account since before the Postgres
// cutover (see its /test-email route). This module is that same JWT +
// gmail.send call, lifted to where the API can reach it, with the failure modes
// named — a bare `google.auth.JWT` throws a 400 with no indication that the
// real problem is domain-wide delegation not being granted for the scope.
//
// It is a SEAM, matching otpChannel.js: `available()` answers "could a send
// work right now" WITHOUT sending, so a caller can report an offline channel
// instead of a code that silently never arrives.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

export const CHANNEL_NAME = 'email';

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

// The mailbox the service account impersonates. Domain-wide delegation is
// granted to a SUBJECT, so this is not cosmetic: sending as an address the
// delegation does not cover fails with `unauthorized_client`.
const MAIL_FROM = process.env.MAIL_FROM || 'info@prasadtransport.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Prasad Transport ERP';

// Repo root, two levels up from server/lib/.
const KEY_FILE = process.env.GOOGLE_KEY_FILE
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'google-key.json');

export class MailChannelError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Read once and keep it — the file does not change under a running process,
 *  and re-reading it per send turns a mail failure into a disk failure. */
let keysCache;
function keys() {
  if (keysCache !== undefined) return keysCache;
  try {
    const parsed = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    keysCache = (parsed.client_email && parsed.private_key) ? parsed : null;
  } catch { keysCache = null; }
  return keysCache;
}

/** google-auth-library dropped the positional JWT(email, keyFile, key, scopes,
 *  subject) signature at v10 — it now reads only the options object, and the
 *  positional call fails with "No key or keyFile set." even though the key was
 *  right there in argument three. bridge.cjs still carries the old form, which
 *  is why its /test-email route cannot be working either.
 *
 *  `subject` is the impersonated mailbox and is not optional: domain-wide
 *  delegation is granted TO a subject, so omitting it authorises nothing. */
const jwt = (k) => new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: SCOPES,
  subject: MAIL_FROM,
});

/** Could a send work right now? Answered without sending anything.
 *
 *  `authorize()` is the honest probe: it performs the JWT grant, which is
 *  exactly the step that fails when delegation has not been granted for
 *  MAIL_FROM. Checking only that the key file parses would report healthy on
 *  the most common misconfiguration. */
export async function available() {
  const k = keys();
  if (!k) return { ok: false, reason: `no usable service-account key at ${KEY_FILE}` };
  try {
    await jwt(k).authorize();
    return { ok: true };
  } catch (e) {
    const detail = e?.response?.data?.error_description || e?.message || String(e);
    return { ok: false, reason: `gmail auth failed for ${MAIL_FROM}: ${detail}` };
  }
}

/** RFC-2047 encodes a header so a non-ASCII subject does not arrive as mojibake. */
const header = (s) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** Gmail wants base64url with no padding. */
const raw = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function send(to, subject, text) {
  const k = keys();
  if (!k) throw new MailChannelError('NO_CREDENTIALS', `no service-account key at ${KEY_FILE}`);

  const auth = jwt(k);
  try {
    await auth.authorize();
    const message = [
      `From: ${header(MAIL_FROM_NAME)} <${MAIL_FROM}>`,
      `To: ${to}`,
      `Subject: ${header(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
    ].join('\r\n');
    await google.gmail({ version: 'v1', auth }).users.messages.send({
      userId: 'me', requestBody: { raw: raw(message) },
    });
    return { channel: CHANNEL_NAME };
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.response?.data?.error_description || e?.message || String(e);
    throw new MailChannelError('SEND_FAILED', detail);
  }
}
