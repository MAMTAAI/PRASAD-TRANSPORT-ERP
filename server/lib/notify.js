// server/lib/notify.js
// ─────────────────────────────────────────────────────────────────────────────
// Best-effort WhatsApp notification for marketplace events (bid received,
// award, KYC decision). One rule: A NOTIFICATION MAY NEVER FAIL THE WORK.
// The award transaction, the approval, the bid insert — all of them must
// commit whether or not the WhatsApp engine is up, paired, or slow. So every
// path here swallows its errors and reports them only to the log.
//
// Goes through the same engine endpoint crm.routes.js /send uses, with the
// same 15s ceiling. The engine writes the wa_chats row itself (single insert
// path — see the note atop crm.routes.js); nothing is recorded here.
//
// SMS fallback: otpChannel.js's sms driver is still a stub, so there is no
// second channel yet. When a gateway is configured, add it HERE so every
// marketplace notification inherits it at once.
// ─────────────────────────────────────────────────────────────────────────────
const WA_BASE = process.env.WA_ENGINE_URL || 'http://127.0.0.1:5001';

const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);

/**
 * Fire-and-forget WhatsApp message. Returns true if the engine accepted it,
 * false otherwise — callers may log the boolean but must not branch on it.
 */
export async function notifyWhatsApp(phone, text) {
  const number = last10(phone);
  if (number.length < 10 || !String(text ?? '').trim()) return false;
  try {
    const res = await fetch(`${WA_BASE}/api/send-whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number,
        message: String(text).trim(),
        userId: 'LOAD_BAZAAR',
        sentByUserName: 'Load Bazaar',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    const ok = res.ok && j.success !== false;
    if (!ok) console.warn(`[notify] whatsapp to ${number} refused: ${j.message ?? res.status}`);
    return ok;
  } catch (e) {
    console.warn(`[notify] whatsapp to ${number} failed: ${e.message}`);
    return false;
  }
}
