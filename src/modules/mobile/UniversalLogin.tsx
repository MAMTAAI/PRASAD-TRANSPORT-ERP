// @ts-nocheck
// ============================================================================
// GATE 2 — SUPER-APP GATEWAY (mobile-first, external parties only)
//
// Owner, 2026-09-03: "Simple mobile login asking ONLY for a Mobile Number for
// OTP. Target: Drivers, Vendors, Customers, Fleet Partners. Upon OTP
// verification, the backend auto-routes the user directly to their isolated
// mobile portal. They never see the Admin dashboard."
//
// So this screen has exactly one field. No email lane, no password lane, no
// role picker: the server looks the number up on the masters and answers with
// the one role it belongs to, and <MobileSuiteApp> mounts that portal and
// nothing else. A staff number is refused here (403 STAFF_USE_DESKTOP) and
// pointed at the office door, Gate 1 (/login). A number on no master gets the
// "get registered by the office" screen — the OTP still verified, so the
// person knows the phone and the code work and only the registration is
// missing.
//
// Hindi first, English under it, buttons a thumb can hit in a moving cab.
// ============================================================================
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthProvider';

import { DISPATCH_MOBILE, DISPATCH_TEL } from '../../lib/dispatchContact';
const GATE1_URL = '/login';

const EMPTY = ['', '', '', '', '', ''];

export default function UniversalLogin({ onAuthenticated }) {
  const { requestOtp, verifyOtp } = useAuth();
  // NUMBER → OTP → ROUTING, or one of the three dead ends.
  const [step, setStep] = useState('NUMBER');
  const [mobile, setMobile] = useState('');
  const [digits, setDigits] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState('');
  const [ttl, setTtl] = useState(5);
  const boxes = useRef([]);

  const clean = mobile.replace(/\D/g, '').replace(/^91(?=[6-9]\d{9}$)/, '').slice(-10);
  const valid = /^[6-9]\d{9}$/.test(clean);
  const pretty = clean ? `${clean.slice(0, 5)} ${clean.slice(5)}` : '';

  const send = async () => {
    setError('');
    if (!valid) { setError('10 अंकों का मोबाइल नंबर डालो'); return; }
    setBusy(true);
    const r = await requestOtp(clean);
    setBusy(false);
    if (!r.ok) {
      if (r.error === 'OTP_CHANNEL_UNAVAILABLE' || r.error === 'OTP_SEND_FAILED') { setStep('DOWN'); return; }
      setError(r.error === 'NETWORK' ? 'इंटरनेट नहीं है — दोबारा कोशिश करो' : 'OTP नहीं भेज पाए — नंबर चेक करो');
      return;
    }
    setChannel(r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'sms' ? 'SMS' : r.channel === 'dev' ? 'test' : String(r.channel || ''));
    setTtl(r.ttl || 5);
    setDigits(EMPTY);
    setStep('OTP');
    setTimeout(() => boxes.current[0]?.focus(), 60);
  };

  const verify = async (code) => {
    setBusy(true); setError('');
    const r = await verifyOtp(clean, code);
    setBusy(false);
    if (r.ok) {
      // The role is the server's word. A short "opening your portal" beat so the
      // switch to the portal is not a flash.
      setStep('ROUTING');
      setTimeout(() => onAuthenticated?.(r.role), 900);
      return;
    }
    setDigits(EMPTY);
    if (r.error === 'NO_ACCOUNT') { setStep('NO_ACCOUNT'); return; }
    if (r.error === 'STAFF_USE_DESKTOP') { setStep('STAFF'); return; }
    if (r.error === 'ACCOUNT_PENDING_APPROVAL') { setError('आपका खाता अभी ऑफिस की मंज़ूरी का इंतज़ार कर रहा है'); return; }
    if (r.error === 'ACCOUNT_SUSPENDED') { setError('आपका खाता रोका गया है — ऑफिस से बात करो'); return; }
    // No live code for this number. The server sends nothing to a number that
    // is on no master (and says nothing about it, on purpose), so from the
    // phone this looks the same as an expired code — the screen offers both
    // ways out: send again, or get registered by the office.
    if (r.error === 'OTP_EXPIRED') { setStep('NO_ACCOUNT'); return; }
    if (r.error === 'OTP_ATTEMPTS_EXCEEDED') { setError('बहुत बार गलत — नया OTP मंगाओ'); return; }
    if (r.error === 'OTP_INVALID') { setError('OTP गलत है — फिर से देखो'); boxes.current[0]?.focus(); return; }
    setError(r.error === 'NETWORK' ? 'इंटरनेट नहीं है — दोबारा कोशिश करो' : 'कुछ गड़बड़ हुई — दोबारा कोशिश करो');
  };

  const onDigit = (i, v) => {
    const c = v.replace(/\D/g, '');
    if (c.length > 1) {
      const all = c.slice(0, 6).split('');
      setDigits([...all, ...EMPTY].slice(0, 6));
      if (all.length === 6) verify(all.join(''));
      return;
    }
    const next = [...digits]; next[i] = c; setDigits(next);
    if (c && i < 5) boxes.current[i + 1]?.focus();
    if (next.every((d) => d) && next.join('').length === 6) verify(next.join(''));
  };

  // WebOTP: on Android Chrome an SMS in the standard format fills the boxes by
  // itself. Best effort — silent when the browser cannot do it.
  useEffect(() => {
    if (step !== 'OTP' || !('OTPCredential' in window)) return;
    const ac = new AbortController();
    navigator.credentials.get({ otp: { transport: ['sms'] }, signal: ac.signal })
      .then((otp) => { if (otp?.code) onDigit(0, otp.code); })
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const reset = () => { setStep('NUMBER'); setDigits(EMPTY); setError(''); setBusy(false); };

  // ── shared bits ───────────────────────────────────────────────────────────
  const BIG = 'w-full rounded-2xl bg-emerald-600 px-4 py-4 text-[20px] font-black text-white shadow-[0_6px_0_rgba(0,0,0,0.18)] active:translate-y-1 active:shadow-none disabled:opacity-60';
  const GHOST = 'w-full rounded-2xl border-2 border-slate-300 bg-white px-4 py-3.5 text-[16px] font-bold text-slate-800';
  const Brand = ({ icon = '🚛', title = 'Prasad Transport', sub = 'App · ऐप', tone = 'from-emerald-500 to-teal-600' }) => (
    <div className="pt-8 text-center">
      <span className={`mx-auto grid h-16 w-16 place-items-center rounded-[18px] bg-gradient-to-br ${tone} text-[32px] shadow-[0_10px_24px_rgba(22,163,74,0.35)]`}>{icon}</span>
      <h1 className="mt-3 text-[24px] font-black text-slate-900">{title}</h1>
      <p className="text-[13px] font-semibold text-slate-500">{sub}</p>
    </div>
  );
  const Err = error ? <p className="mt-3 rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-center text-[14px] font-bold text-red-700">{error}</p> : null;

  return (
    <div className="min-h-screen w-full bg-[#f8fafc] text-slate-900" data-gate="2"
      style={{ fontFamily: '"Segoe UI","Nirmala UI",system-ui,-apple-system,Roboto,sans-serif' }}>
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-8">

        {step === 'NUMBER' && (
          <>
            <Brand />
            <label className="mt-8 block text-[16px] font-black">अपना मोबाइल नंबर डालो
              <span className="block text-[12px] font-semibold text-slate-500">Enter your mobile number · bas itna hi</span>
            </label>
            <div className={`mt-2 flex items-center gap-3 rounded-2xl border-2 bg-white px-4 py-3 ${error ? 'border-red-300' : 'border-slate-300 focus-within:border-emerald-500'}`}>
              <span className="text-[16px] font-bold text-slate-500">+91</span>
              <input
                type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={13} autoFocus
                value={mobile} onChange={(e) => { setMobile(e.target.value); setError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder="98765 43210"
                className="min-w-0 flex-1 bg-transparent font-mono text-[24px] font-extrabold tracking-wider text-slate-900 placeholder-slate-300 outline-none"
              />
            </div>
            {Err}
            <button onClick={send} disabled={busy} className={`${BIG} mt-4`} id="g2-send">{busy ? 'भेज रहे हैं…' : 'OTP भेजो →'}</button>
            <p className="mt-3 text-center text-[13px] font-semibold leading-relaxed text-slate-500">
              OTP WhatsApp पर आएगा · न आए तो SMS पर<br />कोई पासवर्ड नहीं · कोई फॉर्म नहीं
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-1.5">
              {['🚚 Driver', '🔧 Vendor', '🏭 Customer', '🤝 Fleet Partner'].map((w) => (
                <span key={w} className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-extrabold text-slate-700">{w}</span>
              ))}
            </div>
            <a href={GATE1_URL} className="mt-auto pt-8 text-center text-[11.5px] font-bold text-slate-400 underline decoration-dotted underline-offset-4">ऑफिस स्टाफ? Desktop login →</a>
          </>
        )}

        {step === 'OTP' && (
          <>
            <Brand icon="💬" title="OTP डालो" sub={`+91 ${pretty} पर भेजा${channel ? ` · ${channel}` : ''}`} />
            <div className="mt-8 flex justify-between gap-2">
              {digits.map((d, i) => (
                <input
                  key={i} ref={(el) => (boxes.current[i] = el)} value={d}
                  onChange={(e) => onDigit(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus(); }}
                  inputMode="numeric" maxLength={6} autoComplete="one-time-code"
                  className={`h-14 w-full rounded-xl border-2 bg-white text-center font-mono text-[24px] font-black text-slate-900 outline-none ${d ? 'border-emerald-500' : 'border-slate-300 focus:border-emerald-500'}`}
                />
              ))}
            </div>
            {Err}
            <p className="mt-3 text-center text-[13px] font-semibold text-slate-500">
              {busy ? 'चेक हो रहा है…' : `अपने आप पढ़ लेगा · ${ttl} मिनट तक चलेगा`}
            </p>
            <button onClick={() => verify(digits.join(''))} disabled={busy || digits.join('').length !== 6} className={`${BIG} mt-4`} id="g2-verify">✅ आगे बढ़ो</button>
            <button onClick={send} disabled={busy} className={`${GHOST} mt-2`}>🔁 OTP दोबारा भेजो</button>
            <button onClick={reset} className={`${GHOST} mt-2`}>‹ नंबर बदलो</button>
          </>
        )}

        {step === 'ROUTING' && (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <span className="h-14 w-14 animate-spin rounded-full border-[6px] border-slate-200 border-t-emerald-600" />
            <p className="mt-6 text-[18px] font-black">✅ OTP सही है</p>
            <p className="text-[16px] font-bold text-slate-700">आपका पोर्टल खुल रहा है…</p>
            <p className="mt-2 text-[12px] font-semibold text-slate-500">server is opening the one portal this number belongs to</p>
          </div>
        )}

        {step === 'NO_ACCOUNT' && (
          <>
            <Brand icon="❓" title="OTP नहीं मिला?" sub={`+91 ${pretty}`} tone="from-slate-500 to-slate-700" />
            <div className="mt-8 rounded-2xl border-2 border-red-200 bg-red-50 p-4 text-center">
              <p className="text-[20px] font-black text-red-800">नंबर रजिस्टर नहीं है?</p>
              <p className="mt-1 text-[14px] font-semibold leading-relaxed text-red-900/80">OTP सिर्फ़ उन्हीं नंबरों पर जाता है जो ऑफिस में ड्राइवर, वेंडर, कस्टमर या पार्टनर के नाम दर्ज हैं। नहीं आया तो ऑफिस से रजिस्टर करवाओ — या समय निकल गया हो तो दोबारा भेजो।</p>
            </div>
            {DISPATCH_MOBILE && <a href={DISPATCH_TEL} className={`${BIG} mt-5 block text-center`}>📞 ऑफिस को कॉल करो</a>}
            <button onClick={send} disabled={busy} className={`${DISPATCH_MOBILE ? GHOST : BIG} mt-2`}>🔁 OTP दोबारा भेजो</button>
            <button onClick={reset} className={`${GHOST} mt-2`}>‹ दूसरा नंबर</button>
          </>
        )}

        {step === 'STAFF' && (
          <>
            <Brand icon="🏢" title="ऑफिस स्टाफ" sub="यह ऐप ड्राइवर, वेंडर, कस्टमर और पार्टनर के लिए है" tone="from-cyan-500 to-blue-700" />
            <div className="mt-8 rounded-2xl border-2 border-cyan-200 bg-cyan-50 p-4 text-center">
              <p className="text-[18px] font-black text-cyan-900">Office staff sign in on the desktop ERP</p>
              <p className="mt-1 text-[13px] font-semibold leading-relaxed text-cyan-900/80">Username, password and the one-time code. Nothing was opened for this number here.</p>
            </div>
            <a href={GATE1_URL} className={`${BIG} mt-5 block bg-cyan-500 text-center text-[#02131a]`}>Desktop login खोलो →</a>
            <button onClick={reset} className={`${GHOST} mt-2`}>‹ दूसरा नंबर</button>
          </>
        )}

        {step === 'DOWN' && (
          <>
            <Brand icon="📵" title="OTP अभी नहीं जा रहा" sub="WhatsApp / SMS का रास्ता बंद है" tone="from-amber-500 to-orange-600" />
            <div className="mt-8 rounded-2xl border-2 border-amber-200 bg-amber-50 p-4 text-center">
              <p className="text-[14px] font-semibold leading-relaxed text-amber-900">ऑफिस का OTP भेजने वाला सिस्टम अभी ऑफलाइन है। थोड़ी देर बाद कोशिश करो, या ऑफिस को बताओ।</p>
            </div>
            {DISPATCH_MOBILE && <a href={DISPATCH_TEL} className={`${BIG} mt-5 block text-center`}>📞 ऑफिस को कॉल करो</a>}
            <button onClick={reset} className={`${GHOST} mt-2`}>🔁 फिर से कोशिश</button>
          </>
        )}
      </div>
    </div>
  );
}
