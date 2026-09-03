// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRATION OTP WALL, for the two legacy onboarding doors.
//
// Owner, 2026-09-03: no unverified entries in the CRM. The server now refuses
// POST /bazaar/onboarding without a ticket from /auth/register/otp/*, so every
// door has to walk the wall — not only the new Gate 2 form. CustomerPortal.tsx
// and FleetPartnerPortal.tsx are the other two, and both speak in alert() and
// prompt(); this helper stays in that idiom rather than rebuilding either
// screen, which is not what today's directive asked for.
//
// The new Gate 2 form does NOT use this: there the wall is two proper screens
// shown before the form exists, which is what "before they can even see the KYC
// form" means. This is the minimum that closes the same hole on the old doors.
// ─────────────────────────────────────────────────────────────────────────────
import { API_BASE } from './apiBase';

const post = async (path: string, body: any) => {
  const res = await fetch(`${API_BASE}/api/v1/auth/register/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
};

/** Sends a code to `mobile`, asks for it, and returns the single-use ticket the
 *  onboarding POST needs. Returns '' when the applicant gave up or the code
 *  never verified — the caller must not submit in that case. */
export async function verifyMobileForRegistration(mobile: string): Promise<string> {
  const m = String(mobile ?? '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(m)) { alert('⚠️ Enter a valid 10-digit mobile number first.'); return ''; }

  const sent = await post('otp/request', { mobile: m });
  if (!sent.ok) {
    alert(`❌ Could not send the verification code.\n\n${sent.json?.detail ?? sent.json?.error ?? ''}`);
    return '';
  }
  const where = sent.json?.channel === 'sms' ? 'SMS' : sent.json?.channel === 'whatsapp' ? 'WhatsApp' : 'your phone';

  // Three tries here, and the server counts them too (5 per code) — this loop
  // cannot be used to grind at a code.
  for (let i = 0; i < 3; i++) {
    const code = (window.prompt(`We sent a 6-digit code to +91 ${m} on ${where}.\n\nEnter it to continue:`) || '').replace(/\D/g, '');
    if (!code) return '';
    const v = await post('otp/verify', { mobile: m, code });
    if (v.ok && v.json?.ticket) return v.json.ticket;
    if (v.json?.error === 'OTP_ATTEMPTS_EXCEEDED' || v.json?.error === 'OTP_EXPIRED') {
      alert('❌ That code is no longer usable. Please submit again to get a new one.');
      return '';
    }
    alert('❌ Wrong code — try again.');
  }
  return '';
}
