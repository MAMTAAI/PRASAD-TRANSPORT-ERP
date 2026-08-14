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
export const available = () => active.available();
export const send = (mobile, code) => active.send(mobile, code);
