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
const WA_BASE = process.env.WA_ENGINE_URL || 'http://127.0.0.1:5001';
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
