// server/lib/otpChannel.js
// ─────────────────────────────────────────────────────────────────────────────
// Delivery of one-time codes — what replaces Firebase Auth's SMS.
//
// WHY WHATSAPP AND NOT SMS. Firebase sent the OTP itself; removing the package
// removes the sender. There is no SMS gateway on this host and buying one is a
// cost and a credential decision, whereas the firm already runs a hardened
// WhatsApp engine (whatsapp-server/, port 5001) that talks to the same drivers
// every day. So the default channel is the infrastructure that already exists.
//
// It is a SEAM, not a commitment — the same shape as server/lib/storage.js:
//
//   whatsapp  through the local engine's /api/send-whatsapp
//   sms       a stub. Implement send() against the gateway and set
//             OTP_CHANNEL=sms. Nothing above this module changes.
//   log       development only: the code goes to the server log, nowhere else.
//
// ⚠️ WhatsApp is not SMS. A driver on a feature phone, or one whose WhatsApp is
// signed out, cannot receive a code this way — and the engine must be linked
// (QR scanned) or every login fails. `available()` is exposed so the login
// route can say "OTP channel is offline" rather than silently never arriving.
// ─────────────────────────────────────────────────────────────────────────────
const CHANNEL = (process.env.OTP_CHANNEL || 'whatsapp').toLowerCase();
// Exported because the CRM's send route talks to the same engine, and two
// modules each carrying their own default is how one of them ends up pointing
// at a port nothing is listening on. (It has moved once already: 5001 → 5002.)
export const WA_BASE = process.env.WA_ENGINE_URL || 'http://127.0.0.1:5001';
const TIMEOUT_MS = Number.parseInt(process.env.OTP_SEND_TIMEOUT_MS ?? '6000', 10);

export class OtpChannelError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const withTimeout = async (url, opts = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
};

const message = (code) =>
  `${code} — Prasad Transport login OTP. Ye code 5 minute me expire ho jayega. Kisi ko na batayein.`;

const whatsapp = {
  async available() {
    try {
      const res = await withTimeout(`${WA_BASE}/api/status`);
      if (!res.ok) return { ok: false, reason: `engine returned ${res.status}` };
      const j = await res.json();
      return j?.connected ? { ok: true } : { ok: false, reason: `engine ${j?.status ?? 'not linked'}` };
    } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'engine timeout' : e.message }; }
  },
  async send(mobile, code) {
    const res = await withTimeout(`${WA_BASE}/api/send-whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: mobile, message: message(code), userId: 'Auth', sentByUserName: 'Auth' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) {
      throw new OtpChannelError('SEND_FAILED', j.message || `engine returned ${res.status}`);
    }
    return { channel: 'whatsapp' };
  },
};

const sms = {
  async available() { return { ok: false, reason: 'sms driver not implemented — no gateway configured' }; },
  async send() { throw new OtpChannelError('DRIVER_UNAVAILABLE', 'sms driver is not implemented; see server/lib/otpChannel.js'); },
};

// Never the default, and it refuses to run outside development: a channel that
// "delivers" by writing the code to a log is an open door in production.
const log = {
  async available() {
    return process.env.NODE_ENV === 'production'
      ? { ok: false, reason: 'log channel refused in production' }
      : { ok: true };
  },
  async send(mobile, code) {
    if (process.env.NODE_ENV === 'production') {
      throw new OtpChannelError('DRIVER_UNAVAILABLE', 'log channel refused in production');
    }
    console.warn(`[otp] DEV ONLY — code for ${mobile} is ${code}`);
    return { channel: 'log' };
  },
};

const drivers = { whatsapp, sms, log };
const active = drivers[CHANNEL] ?? whatsapp;

export const CHANNEL_NAME = CHANNEL;
/**
 * The engine's full link state, including the pairing QR when it is waiting.
 *
 * WHY THE QR COMES THROUGH THE ERP AND NOT A PUBLIC PORT. The engine binds
 * loopback and its own API is unauthenticated, so it cannot be exposed; but
 * somebody has to SEE the code to scan it, and on a cloud box there is no
 * screen. This hands it to the ERP's admin-only route, which nginx already
 * fronts, so the pairing string never leaves the machine except to an
 * authenticated admin over TLS.
 *
 * THE STRING IS A CREDENTIAL. Anyone who renders that QR can link themselves as
 * a device on the company's WhatsApp account and read every conversation. It
 * must never be sent to a third-party QR image service — render it client-side.
 */
/** Per-user sessions. The engine gained a session registry so staff can link
 *  their own number instead of everything leaving the company line; these are
 *  the three calls the SPA needs, kept here beside linkStatus() so every route
 *  to the engine goes through one module with one timeout policy.
 *
 *  The session id is ALWAYS the caller's own user id, chosen by the route from
 *  the verified token and never taken from the request. A QR is a credential —
 *  scanning one links a device that can read every chat on that account — so an
 *  endpoint that accepted an arbitrary id would let any signed-in user request
 *  a QR that hijacks a colleague's WhatsApp. */
export async function userSessionStatus(sessionId) {
  try {
    const res = await withTimeout(`${WA_BASE}/api/status/${encodeURIComponent(sessionId)}`);
    if (!res.ok) return { reachable: false, reason: `engine returned ${res.status}` };
    const j = await res.json();

    // IS THE ENGINE ON THE OTHER END ACTUALLY THE MULTI-SESSION ONE?
    //
    // This matters more than it looks. The single-session engine ALSO answers
    // /api/status/:userId — it accepts the id and throws it away, and returns
    // the COMPANY session's state (the old comment on that line read "frontend
    // contract"). So against an old engine a staff member who has never
    // scanned anything is told they are linked, because the company number is
    // online. They would then send from a number they do not have, or wait for
    // a QR that is never coming.
    //
    // Only the session registry stamps `session` into the payload, so its
    // presence is what distinguishes the two. Reported rather than guessed, so
    // the UI can say "the engine has not been restarted yet" instead of
    // rendering a confident lie.
    //
    // THE KEY, NOT ITS VALUE. This first read the value and required a non-empty
    // string, which is wrong in exactly the case the screen is for: a staff
    // member who has never linked. The registry answers /api/status/:userId for
    // an unstarted session with `session: null` — correctly, there is no session
    // — and the old check read that null as "no registry" and told a perfectly
    // healthy engine it was out of date. Verified against the running engine:
    // /api/status returns session "company", /api/status/<nobody> returns
    // session null, and both come from the build that has the registry.
    // The single-session engine omits the key altogether, so presence is the
    // signal and `null` is a legitimate value of it.
    const multiSession = !!j && typeof j === 'object' && 'session' in j;

    return {
      reachable: true,
      multi_session: multiSession,
      // An old engine's `connected` describes the COMPANY line, never this
      // person's, so it must not be reported as their link.
      linked: multiSession ? !!j?.connected : false,
      status: j?.status ?? null,
      // Only while a scan is pending. Once linked the engine stops emitting one,
      // and a stale QR shown after linking would be scanned and fail.
      qr: multiSession && !j?.connected ? (j?.qr ?? null) : null,
      // Present only when this session was started with a phone number. An
      // engine that predates pairing simply omits it and the screen falls back
      // to the QR, which still works.
      pairing_code: multiSession && !j?.connected ? (j?.pairingCode || null) : null,
      // WHY THE FAILURE TRAVELS AND lastError DOES NOT. When WhatsApp refuses a
      // pairing code the engine still has a QR to offer, so the screen fell back
      // to one and said nothing about the refusal — which on a phone is a dead
      // end, because you cannot scan a QR with the handset that is displaying
      // it. The operator was left pressing a button that appeared to do nothing.
      // `pairingError` is the engine's one operator-facing sentence; lastError
      // is not (it also carries reconnect and crash text), so only this travels.
      pairing_error: multiSession && !j?.connected ? (j?.pairingError || null) : null,
      pairing_retry_in_sec: multiSession && !j?.connected ? (j?.pairingRetryInSec || 0) : 0,
      last_heartbeat: j?.lastHeartbeat ?? null,
      session: j?.session ?? null,
    };
  } catch (e) {
    return { reachable: false, reason: e.name === 'AbortError' ? 'engine timeout' : e.message };
  }
}

/** `phone` is the caller's OWN registered mobile, read from their user row by
 *  the route — never accepted from the request, for the same reason the session
 *  id is not. With it the engine asks WhatsApp for a pairing code instead of a
 *  QR; without it nothing changes and a QR comes back as before.
 *
 *  It is a routing hint, not a credential: the code still has to be typed into
 *  WhatsApp on the handset that owns that number, so passing somebody else's
 *  number yields a code that only they could use. There is no server-side way
 *  to link an account without its owner acting, and this does not invent one. */
export async function linkUserSession(sessionId, phone) {
  const res = await withTimeout(`${WA_BASE}/api/link/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(phone ? { phone } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 404 HAS EXACTLY ONE MEANING HERE, AND IT IS WORTH SAYING OUT LOUD.
    // /api/link/:userId exists only in the session-registry engine, so a 404 is
    // not "linking failed" — it is "the process on :5001 is still the old
    // build". That is a live footgun rather than a hypothetical: ci-deploy.sh
    // restarts the API, the web app and the AI bridge and did NOT restart
    // prasad-wa-engine, so whatsapp-server/ can be on disk for hours while the
    // running engine predates it. Reported as its own code so the screen can
    // say what to do instead of showing a shrug.
    if (res.status === 404) {
      throw new OtpChannelError('ENGINE_OUTDATED',
        'WhatsApp engine abhi purana version chala raha hai — box par `pm2 restart prasad-wa-engine` chalana padega.');
    }
    throw new OtpChannelError(j.code === 'SESSION_LIMIT' ? 'SESSION_LIMIT' : 'LINK_FAILED',
      j.message || `engine returned ${res.status}`);
  }
  return {
    linked: !!j.connected,
    status: j.status ?? null,
    qr: j.connected ? null : (j.qr ?? null),
    // Same rule as the QR: a link credential is only live while the link is
    // pending. Handing one back for a session already ONLINE gets it typed in
    // and rejected, which reads as a broken link rather than a finished one.
    pairing_code: j.connected ? null : (j.pairingCode || null),
    // Carried on the link reply as well as the status poll: pressing the button
    // while a cooldown is running answers immediately, and without this the
    // reply would look like an ordinary "starting…" and start the same wait
    // again with nothing at the end of it.
    pairing_error: j.connected ? null : (j.pairingError || null),
    pairing_retry_in_sec: j.connected ? 0 : (j.pairingRetryInSec || 0),
  };
}

export async function unlinkUserSession(sessionId, actorName) {
  const res = await withTimeout(`${WA_BASE}/api/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, userId: actorName || 'ERP' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new OtpChannelError('UNLINK_FAILED', j.message || `engine returned ${res.status}`);
  return { ok: true };
}


export async function linkStatus() {
  if (CHANNEL !== 'whatsapp') {
    return { channel: CHANNEL, supported: false, reason: `OTP_CHANNEL is ${CHANNEL}, not whatsapp` };
  }
  try {
    const res = await withTimeout(`${WA_BASE}/api/status`);
    if (!res.ok) return { channel: 'whatsapp', supported: true, reachable: false, reason: `engine returned ${res.status}` };
    const j = await res.json();
    return {
      channel: 'whatsapp',
      supported: true,
      reachable: true,
      connected: !!j?.connected,
      status: j?.status ?? null,
      // Only while WAITING_FOR_SCAN. Once linked the engine stops emitting one,
      // and a stale QR shown after linking would be scanned and fail.
      qr: j?.connected ? null : (j?.qr ?? null),
      server: j?.server ?? null,
      last_heartbeat: j?.lastHeartbeat ?? null,
      engine_url: WA_BASE,
    };
  } catch (e) {
    return {
      channel: 'whatsapp', supported: true, reachable: false,
      reason: e.name === 'AbortError' ? 'engine timeout' : e.message,
      engine_url: WA_BASE,
    };
  }
}

export const available = () => active.available();
export const send = (mobile, code) => active.send(mobile, code);
