// @ts-nocheck
// ============================================================================
// <ChangePasswordCard /> — self-service password change, verified by OTP.
//
// The Profile Settings half of the 2026-08-31 mandate: any logged-in user
// (staff, vendor, customer) changes their OWN password after proving they hold
// the registered mobile. One component, mounted in three places — the staff
// ProfileMenu, CustomerApp's Account tab and FleetPartnerApp's Account tab —
// because three hand-rolled copies of an OTP flow is how one of them ends up
// skipping the verify step.
//
// Talks to auth.routes.js:
//   POST /auth/me/password/otp   → code to the account's registered mobile
//   POST /auth/me/password       → {code, new_password}; revokes every OTHER
//                                  session, keeps the one that proved the mobile
//
// Drivers never reach this: they have no password by design (OTP and link-claim
// logins only), and the server answers NOT_APPLICABLE if one tries.
// ============================================================================
import React, { useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const post = async (path, body) => {
  const token = localStorage.getItem('prasad_token') || localStorage.getItem('pt_mobile_token');
  const res = await fetch(`${API_BASE}/api/v1/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

/** What each server refusal means to the person holding the phone. */
const SAY = {
  NO_MOBILE: 'Is account par mobile number nahi hai — admin se number judwayein, tabhi OTP aa sakta hai.',
  NOT_APPLICABLE: 'Driver login OTP se hota hai — password hai hi nahi.',
  OTP_CHANNEL_UNAVAILABLE: 'OTP bhejne ka channel abhi offline hai — thodi der baad try karein.',
  OTP_SEND_FAILED: 'OTP bheja nahi ja saka — thodi der baad try karein.',
  OTP_INVALID: 'Code galat ya expire ho chuka hai — dobara dekhein.',
  OTP_ALREADY_USED: 'Ye code use ho chuka hai — naya OTP mangwayein.',
  OTP_LOCKED: 'Bahut zyada galat attempts — naya OTP mangwayein.',
  WEAK_PASSWORD: 'Password kam se kam 8 akshar ka hona chahiye.',
  DB_UNAVAILABLE: 'Server database se connect nahi ho pa raha — thodi der baad try karein.',
};

export default function ChangePasswordCard({ compact = false }) {
  // idle → sent (code on its way, form open) → done. Any error keeps the stage
  // and says why, so the person never loses what they typed.
  const [stage, setStage] = useState('idle');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { tone: 'ok'|'err', msg }

  const requestOtp = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await post('/me/password/otp');
      setSentTo(r.mobile ?? 'aapke mobile');
      setStage('sent');
      setCode(''); setPw1(''); setPw2('');
      setNote({ tone: 'ok', msg: `OTP bheja gaya: ${r.mobile} (${r.expires_in_minutes ?? 5} min valid)` });
    } catch (e) {
      setNote({ tone: 'err', msg: SAY[e.code] ?? `OTP nahi bheja ja saka — ${e.message}` });
    }
    setBusy(false);
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!/^\d{6}$/.test(code)) return setNote({ tone: 'err', msg: '6-digit OTP daalein.' });
    if (pw1.length < 8) return setNote({ tone: 'err', msg: SAY.WEAK_PASSWORD });
    // Checked here: the server only ever receives one password, and a typo in a
    // password you cannot see is not something it could detect on your behalf.
    if (pw1 !== pw2) return setNote({ tone: 'err', msg: 'Dono password ek jaise nahi hain.' });
    setBusy(true); setNote(null);
    try {
      await post('/me/password', { code, new_password: pw1 });
      setStage('done');
      setCode(''); setPw1(''); setPw2('');
      setNote({ tone: 'ok', msg: '✅ Password badal gaya. Baaki sab devices se logout kar diya gaya hai — ye session chalu rahega.' });
    } catch (e2) {
      // A burned code cannot be retyped into success; put the person back on
      // the button that mints a fresh one.
      if (e2.code === 'OTP_LOCKED' || e2.code === 'OTP_ALREADY_USED') { setStage('idle'); setCode(''); }
      setNote({ tone: 'err', msg: SAY[e2.code] ?? `Password badla nahi ja saka — ${e2.message}` });
    }
    setBusy(false);
  };

  const input = 'w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-3 text-[14px] font-semibold '
    + 'text-white outline-none transition-colors placeholder:text-white/20 focus:border-sky-400/60';
  const label = 'mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-white/40';

  return (
    <div className={compact ? '' : 'rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4'}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-lg">🔑</span>
        <div>
          <p className="text-[13px] font-black text-white">Change Password</p>
          <p className="text-[11px] leading-snug text-white/40">OTP aapke registered mobile par aayega</p>
        </div>
      </div>

      {note && (
        <div className={`mb-3 rounded-xl border px-3 py-2 text-[11.5px] font-semibold leading-snug
          ${note.tone === 'ok' ? 'border-emerald-400/30 bg-emerald-950/60 text-emerald-200'
                               : 'border-red-400/30 bg-red-950/60 text-red-200'}`}>
          {note.msg}
        </div>
      )}

      {stage !== 'sent' && (
        <button type="button" onClick={requestOtp} disabled={busy}
          className="w-full rounded-xl bg-sky-600 py-3 text-[12.5px] font-black text-white transition-colors
                     hover:bg-sky-500 disabled:opacity-40">
          {busy ? 'Bhej rahe hain…' : stage === 'done' ? 'PHIR SE BADLEIN — OTP BHEJEIN' : 'OTP BHEJEIN 📩'}
        </button>
      )}

      {stage === 'sent' && (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <span className={`${label} text-center`}>6-Digit OTP ({sentTo})</span>
            <input type="text" inputMode="numeric" maxLength={6} value={code} autoFocus
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))} placeholder="••••••"
              className={`${input} text-center text-2xl font-black tracking-[0.7em]`} required />
          </div>
          <div>
            <span className={label}>Naya Password (kam se kam 8 akshar)</span>
            <div className="relative">
              <input type={show ? 'text' : 'password'} value={pw1} onChange={(e) => setPw1(e.target.value)}
                className={`${input} pr-12`} required />
              <button type="button" tabIndex={-1} onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-lg hover:bg-white/10">
                {show ? '🙈' : '👁️'}
              </button>
            </div>
          </div>
          <div>
            <span className={label}>Password Dobara</span>
            <input type={show ? 'text' : 'password'} value={pw2} onChange={(e) => setPw2(e.target.value)}
              className={input} required />
          </div>
          <button type="submit" disabled={busy}
            className="w-full rounded-xl bg-emerald-600 py-3 text-[12.5px] font-black text-white transition-colors
                       hover:bg-emerald-500 disabled:opacity-40">
            {busy ? 'Badal rahe hain…' : 'PASSWORD BADLEIN ✅'}
          </button>
          <button type="button" onClick={requestOtp} disabled={busy}
            className="w-full text-center text-[11px] font-bold text-white/40 transition-colors hover:text-sky-300">
            Code nahi mila? Dobara bhejein
          </button>
        </form>
      )}
    </div>
  );
}
