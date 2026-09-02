// server/lib/waSend.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE PLACE THAT KNOWS HOW TO HAND A MESSAGE TO THE ENGINE.
//
// There was one caller and it still went wrong: the SPA had its own copy of
// this call and posted to `${ERP_API}/api/v1/api/send-whatsapp` — note the
// doubled segment — for months, with nothing answering and no caller reading
// the response. Now there are three callers (chat send, chat attachment, LR
// copy) and a fourth will arrive, so the shape lives here rather than being
// copied a third time.
//
// THE FOOTPRINT COMES FROM THE SESSION, NEVER FROM A REQUEST BODY. The old
// callers passed sentByUserId/sentByUserName up from browser state, so the
// audit trail recorded whoever the client claimed to be.
//
// THE CHAT ROW IS WRITTEN BY THE ENGINE, NOT HERE. doSend() posts it back
// through POST /crm/chats with the WhatsApp message id and the session it went
// out on — things only the engine knows. A second insert on this side would be
// a second insert path for the same event.
// ─────────────────────────────────────────────────────────────────────────────
import { WA_BASE } from './otpChannel.js';

/**
 * @param {object} spec
 *   phone   — last ten digits; the engine prefixes 91
 *   text    — the message body
 *   user    — req.user, or null for an unattended caller
 *   tripId  — recorded on the chat row where there is one
 *   role    — DRIVER / PUMP / VENDOR / CUSTOMER, from the directory
 *   media   — { key, type, filename } when the message carries a vault link.
 *             An engine that has not been restarted since 2-Sep ignores these
 *             and logs a plain text row; the message still arrives, so this is
 *             deliberately not a hard dependency — the box's WhatsApp session
 *             is expensive to restart.
 * @throws   Error with .code = 'ENGINE_UNREACHABLE' | 'SEND_FAILED', and a
 *           message written for the operator: every caller puts it on screen.
 */
export async function sendViaEngine({ phone, text, user = null, tripId = null, role = null, media = null }) {
  // The sender's OWN session when they have linked one, so the driver sees the
  // name of the person actually talking to them. The engine falls back to the
  // company line when that session is not connected, so this is a preference
  // rather than a requirement — see doSend() in whatsapp-server/server.js.
  const sessionId = user?.sub ? `u${String(user.sub).replace(/-/g, '')}` : undefined;
  let res;
  try {
    res = await fetch(`${WA_BASE}/api/send-whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number: phone,
        message: text,
        sessionId,
        userId: user?.name ?? 'ERP',
        sentByUserId: user?.sub ?? null,
        sentByUserName: user?.name ?? 'ERP',
        tripId,
        role,
        media_key: media?.key ?? null,
        media_type: media?.type ?? null,
        media_filename: media?.filename ?? null,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    // An unreachable engine is not a 500 on the ERP: nothing here is broken,
    // and the operator needs to be told which half is down.
    throw Object.assign(
      new Error(e.name === 'TimeoutError' ? 'engine timeout' : e.message),
      { code: 'ENGINE_UNREACHABLE' });
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    throw Object.assign(new Error(j.message || `engine returned ${res.status}`), { code: 'SEND_FAILED' });
  }
  return j;
}
