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
import { API_BASE } from '../../lib/apiBase';
import { vGstin, vPan, vMobile, vIfsc, vAccountNo } from '../../lib/validators';
const GATE1_URL = '/login';

const EMPTY = ['', '', '', '', '', ''];

// ── NEW CUSTOMER REGISTRATION (owner directive, 2026-09-03) ─────────────────
// A firm with no account had exactly one way in until today: ring the office
// and ask to be keyed in by hand. This is the same KYC application the fleet
// partners have had since Phase A (POST /bazaar/onboarding — public, because
// the applicant has nothing to sign in with yet), with the company, GSTIN/PAN
// and bank details the owner asked for.
//
// It does NOT create an account. It creates a row the office must verify and
// activate; until an admin approves it in KYC Approvals, this number still
// cannot log in — which is exactly what the directive asked for, and what the
// last screen tells the applicant in as many words.
const REG_KEY = 'prasad_kyc_application';
const REG_FIELDS = [
  { k: 'corporate_name', hi: 'फर्म / कंपनी का नाम', en: 'Registered company name', req: true, ph: 'MARUTI TRADERS', caps: true },
  { k: 'contact_person', hi: 'संपर्क व्यक्ति', en: 'Contact person', ph: 'R. Sharma' },
  { k: 'email', hi: 'ईमेल', en: 'Email for bills', ph: 'accounts@firm.com', type: 'email' },
  { k: 'address', hi: 'पता', en: 'Address', ph: 'GS Road, Guwahati', area: true },
];
const REG_TAX = [
  { k: 'gst_no', hi: 'GSTIN', en: '15 characters', req: true, ph: '18ABCDE1234F1Z5', caps: true, check: (v) => vGstin(v, true) },
  { k: 'pan_no', hi: 'PAN', en: '10 characters', req: true, ph: 'AAAPA1234A', caps: true, check: (v) => vPan(v, true) },
];
// A fleet partner (owner directive, 3-Sep) MUST bring PAN and bank details.
// GST is asked for but not demanded: a single-lorry owner commonly has no
// registration, and refusing them would shut the market fleet to exactly the
// people it exists to reach.
const REG_TAX_PARTNER = [
  { k: 'pan_no', hi: 'PAN कार्ड', en: 'PAN — required', req: true, ph: 'AAAPA1234A', caps: true, check: (v) => vPan(v, true) },
  { k: 'gst_no', hi: 'GSTIN', en: 'if you have one', ph: '18ABCDE1234F1Z5', caps: true, check: (v) => vGstin(v) },
];
const REG_BANK = [
  { k: 'bank_name', hi: 'बैंक का नाम', en: 'Bank name', req: true, ph: 'State Bank of India' },
  { k: 'account_no', hi: 'खाता नंबर', en: 'Account number', req: true, ph: '30123456789', num: true, check: (v) => vAccountNo(v, true) },
  { k: 'ifsc_code', hi: 'IFSC', en: 'IFSC code', req: true, ph: 'SBIN0001234', caps: true, check: (v) => vIfsc(v, true) },
];

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

  // ── registration ──────────────────────────────────────────────────────────
  const [reg, setReg] = useState({});
  const [regErr, setRegErr] = useState({});
  const [applied, setApplied] = useState(null);
  const setF = (k, v) => { setReg((r) => ({ ...r, [k]: v })); setRegErr((e) => ({ ...e, [k]: '' })); };

  // THE OTP WALL (owner, 2026-09-03): "a user must verify their mobile number
  // before they can even see the KYC form." So the form is not a step the
  // applicant can reach by typing a URL or by closing a dialog — REG_OTP →
  // REG_CODE → REGISTER, and the form only mounts once a ticket exists. The
  // server enforces the same thing (POST /bazaar/onboarding wants the ticket),
  // because a wall only the browser knows about is a suggestion.
  const [regMobile, setRegMobile] = useState('');
  const [regDigits, setRegDigits] = useState(EMPTY);
  const [regTicket, setRegTicket] = useState('');
  const [regChannel, setRegChannel] = useState('');
  const regBoxes = useRef([]);

  const regClean = regMobile.replace(/\D/g, '').replace(/^91(?=[6-9]\d{9}$)/, '').slice(-10);
  const regValid = /^[6-9]\d{9}$/.test(regClean);

  // CUSTOMER or FLEET_PARTNER. Chosen before the wall, because a person should
  // know what they are applying to be before they are asked for a code.
  const [regType, setRegType] = useState('CUSTOMER');
  const [trucks, setTrucks] = useState([]);      // [{ registration_no, vehicle_class, capacity, rc_expiry, rc_file_key, uploading, name }]
  const isPartner = regType === 'FLEET_PARTNER';

  const openRegister = () => {
    setError(''); setRegDigits(EMPTY); setRegTicket(''); setTrucks([]);
    setStep('REG_TYPE');
  };

  const startWall = (type) => {
    setRegType(type);
    setError(''); setRegDigits(EMPTY); setRegTicket('');
    // The number they already typed is the number the office will ring, so it
    // carries into the wall rather than being asked for twice.
    setRegMobile(valid ? clean : '');
    setStep('REG_OTP');
  };

  const sendRegOtp = async () => {
    setError('');
    if (!regValid) { setError('10 अंकों का मोबाइल नंबर डालो'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/register/otp/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: regClean }),
      });
      const j = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok) {
        setError(j.detail || (j.error === 'OTP_CHANNEL_UNAVAILABLE'
          ? 'OTP भेजने का रास्ता अभी बंद है — ऑफिस को कॉल करो'
          : 'OTP नहीं भेज पाए — नंबर चेक करो'));
        return;
      }
      setRegChannel(j.channel === 'whatsapp' ? 'WhatsApp' : j.channel === 'sms' ? 'SMS' : j.channel === 'dev' ? 'test' : '');
      setRegDigits(EMPTY);
      setStep('REG_CODE');
      setTimeout(() => regBoxes.current[0]?.focus(), 60);
    } catch { setBusy(false); setError('इंटरनेट नहीं है — दोबारा कोशिश करो'); }
  };

  const verifyRegOtp = async (code) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/register/otp/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: regClean, code }),
      });
      const j = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok || !j.ticket) {
        setRegDigits(EMPTY);
        setError(j.error === 'OTP_INVALID' ? 'OTP गलत है — फिर से देखो'
          : j.error === 'OTP_ATTEMPTS_EXCEEDED' ? 'बहुत बार गलत — नया OTP मंगाओ'
          : j.error === 'OTP_EXPIRED' ? 'OTP का समय निकल गया — दोबारा भेजो'
          : (j.detail || 'OTP जाँच नहीं पाए'));
        regBoxes.current[0]?.focus();
        return;
      }
      setRegTicket(j.ticket);
      setReg((r) => ({ ...r, mobile_no: regClean }));
      setStep('REGISTER');
    } catch { setBusy(false); setError('इंटरनेट नहीं है — दोबारा कोशिश करो'); }
  };

  const onRegDigit = (i, v) => {
    const c = v.replace(/\D/g, '');
    if (c.length > 1) {
      const all = c.slice(0, 6).split('');
      setRegDigits([...all, ...EMPTY].slice(0, 6));
      if (all.length === 6) verifyRegOtp(all.join(''));
      return;
    }
    const next = [...regDigits]; next[i] = c; setRegDigits(next);
    if (c && i < 5) regBoxes.current[i + 1]?.focus();
    if (next.every((d) => d) && next.join('').length === 6) verifyRegOtp(next.join(''));
  };

  // ── the trucks a partner applies with ────────────────────────────────────
  // Each one carries its RC. The scan goes up on the ticket (POST
  // /auth/register/upload) — the applicant has no session, so the verified
  // handset is the credential, and the server picks the key.
  const addTruck = () => setTrucks((t) => [...t, { registration_no: '', vehicle_class: '', capacity: '', rc_expiry: '', rc_file_key: '', uploading: false, name: '' }]);
  const setTruck = (i, k, v) => setTrucks((t) => t.map((x, n) => (n === i ? { ...x, [k]: v } : x)));
  const dropTruck = (i) => setTrucks((t) => t.filter((_, n) => n !== i));

  const uploadRc = async (i, file) => {
    if (!file) return;
    setTruck(i, 'uploading', true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mobile', regClean);
      fd.append('ticket', regTicket);
      fd.append('tag', 'rc');
      const res = await fetch(`${API_BASE}/api/v1/auth/register/upload`, { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.path) throw new Error(j.detail || j.error || 'upload failed');
      setTrucks((t) => t.map((x, n) => (n === i ? { ...x, rc_file_key: j.path, name: file.name || 'RC', uploading: false } : x)));
      // The banner that said "attach the RC" is now false — clearing it is the
      // difference between a form that answers you and one that nags.
      setError('');
    } catch (e) {
      setTrucks((t) => t.map((x, n) => (n === i ? { ...x, uploading: false } : x)));
      setError(String(e?.message ?? e));
    }
  };

  const submitRegistration = async () => {
    const errs = {};
    const taxFields = isPartner ? REG_TAX_PARTNER : REG_TAX;
    for (const f of [...REG_FIELDS, ...taxFields, ...REG_BANK]) {
      const v = String(reg[f.k] ?? '').trim();
      if (f.req && !v) { errs[f.k] = 'यह ज़रूरी है / required'; continue; }
      if (v && f.check) { const c = f.check(v); if (!c.ok) errs[f.k] = c.message; }
    }
    const m = vMobile(reg.mobile_no, true);
    if (!m.ok) errs.mobile_no = m.message;
    setRegErr(errs);
    if (Object.keys(errs).length) {
      setError('कुछ जानकारी ठीक करनी है / please fix the marked fields');
      return;
    }
    // A truck with no plate, or a plate with no RC, is not something the office
    // can verify — the server refuses both, so the form says so first.
    if (isPartner) {
      const filled = trucks.filter((t) => String(t.registration_no).trim());
      if (trucks.length !== filled.length) { setError('हर गाड़ी का नंबर डालो / every truck needs its number'); return; }
      const noRc = filled.find((t) => !t.rc_file_key);
      if (noRc) { setError(`${noRc.registration_no} — RC की फोटो लगाओ / attach the RC`); return; }
    }
    setError(''); setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/bazaar/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...reg, mobile_no: regClean, ticket: regTicket, type: regType,
          ...(isPartner ? {
            agency_name: reg.corporate_name,
            owner_name: reg.contact_person,
            vehicles: trucks
              .filter((t) => String(t.registration_no).trim())
              .map((t) => ({
                registration_no: t.registration_no, vehicle_class: t.vehicle_class || null,
                capacity: t.capacity === '' ? null : t.capacity,
                rc_file_key: t.rc_file_key, rc_expiry: t.rc_expiry || null,
              })),
          } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok) {
        // The server re-runs every check this form ran, and its answer wins —
        // a 409 here is the office telling the applicant something the phone
        // could not know (already applied, already a customer).
        if (j.fields?.length) {
          setRegErr(Object.fromEntries(j.fields.map((f) => [f.field, f.message])));
        }
        // The 30-minute ticket died while they were typing. Sending them back
        // to the wall with the number still filled in is one tap, and leaving
        // them on a form whose Send button can never work is not.
        if (j.error === 'MOBILE_NOT_VERIFIED') {
          setRegTicket(''); setRegDigits(EMPTY); setStep('REG_OTP');
          setError('नंबर की जाँच का समय निकल गया — OTP दोबारा मंगाओ');
          return;
        }
        setError(j.detail || 'फॉर्म नहीं भेजा जा सका / could not send the form');
        return;
      }
      const id = j.application?.id ?? null;
      try { if (id) localStorage.setItem(REG_KEY, id); } catch { /* private mode */ }
      setApplied({ id, name: j.application?.corporate_name ?? reg.corporate_name });
      setStep('REGISTERED');
    } catch {
      setBusy(false);
      setError('इंटरनेट नहीं है — दोबारा कोशिश करो');
    }
  };

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

  // NOT a component — a function that returns markup. Declared inside the
  // render, <Field/> would be a NEW component type on every keystroke, so React
  // would unmount and remount the input and the caret would jump out after each
  // character typed. Calling it instead keeps one element identity.
  // 46 px targets, 16 px font: under 16 px iOS zooms the page on focus.
  const renderField = (f) => (
    <label className="block" key={f.k}>
      <span className="block text-[14px] font-black text-slate-800">
        {f.hi}{f.req && <span className="text-red-600"> *</span>}
        <span className="block text-[11.5px] font-semibold text-slate-500">{f.en}</span>
      </span>
      {f.area ? (
        <textarea
          rows={2} value={reg[f.k] ?? ''} placeholder={f.ph}
          onChange={(e) => setF(f.k, e.target.value)}
          data-reg={f.k}
          className={`mt-1 w-full rounded-xl border-2 bg-white px-3 py-2.5 text-[16px] font-semibold text-slate-900 outline-none ${regErr[f.k] ? 'border-red-400' : 'border-slate-300 focus:border-emerald-500'}`}
        />
      ) : (
        <input
          value={reg[f.k] ?? ''} placeholder={f.ph}
          type={f.type ?? 'text'} inputMode={f.num ? 'numeric' : undefined}
          autoCapitalize={f.caps ? 'characters' : undefined}
          onChange={(e) => setF(f.k, f.caps ? e.target.value.toUpperCase() : e.target.value)}
          data-reg={f.k}
          className={`mt-1 min-h-[46px] w-full rounded-xl border-2 bg-white px-3 text-[16px] font-semibold text-slate-900 outline-none ${f.caps || f.num ? 'font-mono tracking-wide' : ''} ${regErr[f.k] ? 'border-red-400' : 'border-slate-300 focus:border-emerald-500'}`}
        />
      )}
      {regErr[f.k] && <span className="mt-1 block text-[12px] font-bold text-red-700">{regErr[f.k]}</span>}
    </label>
  );
  const section = (icon, title, sub) => (
    <div className="mt-6 flex items-baseline gap-2 border-b-2 border-slate-200 pb-1">
      <span className="text-[17px]">{icon}</span>
      <b className="text-[16px] font-black text-slate-900">{title}</b>
      <span className="text-[11.5px] font-semibold text-slate-500">{sub}</span>
    </div>
  );

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
            <div className="mt-6 rounded-2xl border-2 border-dashed border-violet-300 bg-violet-50 p-3.5 text-center">
              <p className="text-[14px] font-black text-violet-900">नए हैं? कस्टमर या गाड़ी मालिक?</p>
              <p className="mt-0.5 text-[12px] font-semibold leading-snug text-violet-900/75">अपनी फर्म या गाड़ियाँ रजिस्टर करें — ऑफिस जाँच कर के चालू करेगा।</p>
              <button onClick={openRegister} className="mt-2.5 min-h-[46px] w-full rounded-xl bg-violet-600 text-[16px] font-black text-white shadow-[0_4px_0_rgba(0,0,0,0.16)] active:translate-y-0.5 active:shadow-none" id="g2-register">
                📝 नया रजिस्ट्रेशन / Register →
              </button>
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
            <button onClick={openRegister} className={`${BIG} mt-5 bg-violet-600`}>📝 नया रजिस्ट्रेशन करें</button>
            {DISPATCH_MOBILE && <a href={DISPATCH_TEL} className={`${GHOST} mt-2 block text-center`}>📞 ऑफिस को कॉल करो</a>}
            <button onClick={send} disabled={busy} className={`${GHOST} mt-2`}>🔁 OTP दोबारा भेजो</button>
            <button onClick={reset} className={`${GHOST} mt-2`}>‹ दूसरा नंबर</button>
          </>
        )}

        {step === 'REG_TYPE' && (
          <>
            <Brand icon="📝" title="नया रजिस्ट्रेशन" sub="New registration" tone="from-violet-500 to-purple-700" />
            <p className="mt-5 text-center text-[14px] font-bold text-slate-700">आप क्या हैं?<span className="block text-[12px] font-semibold text-slate-500">What are you registering as?</span></p>
            <button onClick={() => startWall('CUSTOMER')} className="mt-4 rounded-2xl border-2 border-slate-300 bg-white p-4 text-left active:translate-y-0.5" data-type="CUSTOMER">
              <div className="text-[17px] font-black text-slate-900">🏭 माल भेजने वाला</div>
              <div className="text-[12.5px] font-semibold leading-snug text-slate-600">Customer — आपको अपना माल भिजवाना है। ट्रैकिंग, POD और बिल दिखेंगे।</div>
            </button>
            <button onClick={() => startWall('FLEET_PARTNER')} className="mt-3 rounded-2xl border-2 border-slate-300 bg-white p-4 text-left active:translate-y-0.5" data-type="FLEET_PARTNER">
              <div className="text-[17px] font-black text-slate-900">🚛 गाड़ी मालिक</div>
              <div className="text-[12.5px] font-semibold leading-snug text-slate-600">Fleet Partner — आपकी अपनी गाड़ियाँ हैं और आप हमारा माल ढोना चाहते हैं। PAN, बैंक और हर गाड़ी की RC लगेगी।</div>
            </button>
            <button onClick={() => { setStep('NUMBER'); setError(''); }} className={`${GHOST} mt-4`}>‹ वापस लॉगिन पर</button>
          </>
        )}

        {step === 'REG_OTP' && (
          <>
            <Brand icon="📱" title="पहले नंबर जाँचें" sub="Verify your mobile first" tone="from-violet-500 to-purple-700" />
            <div className="mt-5 rounded-2xl bg-violet-50 px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-violet-900">
              रजिस्ट्रेशन फ़ॉर्म खोलने से पहले हम आपके नंबर पर एक कोड भेजेंगे। यही नंबर आपका लॉगिन नंबर बनेगा।
              <span className="mt-1 block text-[11.5px] text-violet-900/70">We send a code first — this becomes your login number.</span>
            </div>
            <label className="mt-5 block text-[16px] font-black">मोबाइल नंबर
              <span className="block text-[12px] font-semibold text-slate-500">Mobile number</span>
            </label>
            <div className={`mt-2 flex items-center gap-3 rounded-2xl border-2 bg-white px-4 py-3 ${error ? 'border-red-300' : 'border-slate-300 focus-within:border-violet-500'}`}>
              <span className="text-[16px] font-bold text-slate-500">+91</span>
              <input
                type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={13} autoFocus
                value={regMobile} onChange={(e) => { setRegMobile(e.target.value); setError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && sendRegOtp()}
                placeholder="98765 43210" data-reg-mobile
                className="min-w-0 flex-1 bg-transparent font-mono text-[24px] font-extrabold tracking-wider text-slate-900 placeholder-slate-300 outline-none"
              />
            </div>
            {Err}
            <button onClick={sendRegOtp} disabled={busy} className={`${BIG} mt-4 bg-violet-600`} id="g2-reg-otp">{busy ? 'भेज रहे हैं…' : 'कोड भेजो →'}</button>
            <button onClick={() => { setStep('NUMBER'); setError(''); }} className={`${GHOST} mt-2`}>‹ वापस लॉगिन पर</button>
          </>
        )}

        {step === 'REG_CODE' && (
          <>
            <Brand icon="💬" title="कोड डालो" sub={`+91 ${regClean.slice(0, 5)} ${regClean.slice(5)}${regChannel ? ` · ${regChannel}` : ''}`} tone="from-violet-500 to-purple-700" />
            <div className="mt-8 flex justify-between gap-2">
              {regDigits.map((d, i) => (
                <input
                  key={i} ref={(el) => (regBoxes.current[i] = el)} value={d}
                  onChange={(e) => onRegDigit(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Backspace' && !d && i > 0) regBoxes.current[i - 1]?.focus(); }}
                  inputMode="numeric" maxLength={6} autoComplete="one-time-code" data-reg-code
                  className={`h-14 w-full rounded-xl border-2 bg-white text-center font-mono text-[24px] font-black text-slate-900 outline-none ${d ? 'border-violet-500' : 'border-slate-300 focus:border-violet-500'}`}
                />
              ))}
            </div>
            {Err}
            <p className="mt-3 text-center text-[13px] font-semibold text-slate-500">{busy ? 'जाँच रहे हैं…' : 'कोड डालते ही फ़ॉर्म खुलेगा'}</p>
            <button onClick={() => verifyRegOtp(regDigits.join(''))} disabled={busy || regDigits.join('').length !== 6} className={`${BIG} mt-4 bg-violet-600`} id="g2-reg-verify">✅ जाँचो</button>
            <button onClick={sendRegOtp} disabled={busy} className={`${GHOST} mt-2`}>🔁 कोड दोबारा भेजो</button>
            <button onClick={() => { setStep('REG_OTP'); setError(''); }} className={`${GHOST} mt-2`}>‹ नंबर बदलो</button>
          </>
        )}

        {step === 'REGISTER' && (
          <>
            <Brand icon="🏢" title="नया कस्टमर" sub="New Customer Registration · KYC" tone="from-violet-500 to-purple-700" />
            <div className="mt-4 rounded-2xl bg-violet-50 px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-violet-900">
              यह फ़ॉर्म ऑफिस को जाता है। GSTIN, PAN और बैंक की जाँच के बाद ऑफिस आपका खाता चालू करेगा — तभी आप इस नंबर से लॉगिन कर पाएंगे.
              <span className="mt-1 block text-[11.5px] text-violet-900/70">The office verifies your GSTIN, PAN and bank account before the app opens.</span>
            </div>

            {section('🏭', 'फर्म की जानकारी', 'Company details')}
            <div className="mt-3 space-y-3">
              {/* Verified upstairs, so it is shown rather than asked. Editing it
                  here would only produce a form the server must reject: the
                  ticket is pinned to the number the code went to. */}
              <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 px-3 py-2.5">
                <div className="text-[11.5px] font-extrabold text-emerald-800">मोबाइल नंबर — जाँचा हुआ / verified</div>
                <div className="font-mono text-[17px] font-extrabold text-emerald-900" data-reg-verified>
                  ✅ +91 {regClean.slice(0, 5)} {regClean.slice(5)}
                </div>
                <button onClick={() => { setStep('REG_OTP'); setError(''); }} className="mt-1 text-[11.5px] font-bold text-emerald-800 underline decoration-dotted underline-offset-2">नंबर बदलना है?</button>
              </div>
              {REG_FIELDS.map(renderField)}
            </div>

            {section('🧾', isPartner ? 'PAN और GST' : 'GST और PAN', isPartner ? 'PAN required' : 'Tax details · required')}
            <div className="mt-3 space-y-3">{(isPartner ? REG_TAX_PARTNER : REG_TAX).map(renderField)}</div>

            {section('🏦', 'बैंक की जानकारी', 'Bank details · for payments')}
            <div className="mt-3 space-y-3">{REG_BANK.map(renderField)}</div>

            {isPartner && (
              <>
                {section('🚛', 'आपकी गाड़ियाँ', 'Your trucks · RC required for each')}
                <div className="mt-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-amber-900">
                  हर गाड़ी की RC की फोटो लगाओ। ऑफिस RC जाँच कर के गाड़ी चालू करेगा — तब तक वो लोड नहीं ले सकती।
                  <span className="mt-1 block text-[11.5px] text-amber-900/75">The office activates each truck after checking its RC.</span>
                </div>
                <div className="mt-3 space-y-3">
                  {trucks.map((tk, i) => (
                    <div key={i} className="rounded-2xl border-2 border-slate-300 bg-white p-3" data-truck-row={i}>
                      <div className="flex items-center justify-between">
                        <b className="text-[13px] font-extrabold text-slate-700">गाड़ी {i + 1}</b>
                        <button onClick={() => dropTruck(i)} className="min-h-[34px] rounded-lg px-2 text-[12px] font-extrabold text-red-700">हटाओ ✕</button>
                      </div>
                      <input
                        value={tk.registration_no} onChange={(e) => setTruck(i, 'registration_no', e.target.value.toUpperCase())}
                        placeholder="AS01AB1234" data-truck-reg={i}
                        className="mt-2 min-h-[46px] w-full rounded-xl border-2 border-slate-300 px-3 font-mono text-[16px] font-bold tracking-wide outline-none focus:border-emerald-500"
                      />
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <input value={tk.vehicle_class} onChange={(e) => setTruck(i, 'vehicle_class', e.target.value)} placeholder="Oil Tanker"
                          className="min-h-[46px] w-full rounded-xl border-2 border-slate-300 px-3 text-[15px] font-bold outline-none focus:border-emerald-500" />
                        <input value={tk.capacity} inputMode="decimal" onChange={(e) => setTruck(i, 'capacity', e.target.value)} placeholder="टन / T"
                          className="min-h-[46px] w-full rounded-xl border-2 border-slate-300 px-3 text-[15px] font-bold outline-none focus:border-emerald-500" />
                      </div>
                      <label className="mt-2 block text-[11.5px] font-extrabold text-slate-500">RC की तारीख / RC expiry
                        <input type="date" value={tk.rc_expiry} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setTruck(i, 'rc_expiry', e.target.value)}
                          className="mt-1 min-h-[46px] w-full rounded-xl border-2 border-slate-300 px-3 text-[15px] font-bold outline-none focus:border-emerald-500" />
                      </label>
                      <label className={`mt-2 flex min-h-[46px] cursor-pointer items-center justify-center gap-2 rounded-xl border-2 px-3 text-[14px] font-extrabold ${tk.rc_file_key ? 'border-green-400 bg-green-50 text-green-800' : 'border-dashed border-slate-400 bg-slate-50 text-slate-700'}`}>
                        {tk.uploading ? '⏳ भेज रहे हैं…' : tk.rc_file_key ? `✅ RC लगी — ${tk.name}` : '📎 RC की फोटो लगाओ'}
                        <input type="file" accept="image/*,application/pdf" hidden data-rc={i}
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadRc(i, f); }} />
                      </label>
                    </div>
                  ))}
                </div>
                <button onClick={addTruck} className={`${GHOST} mt-3`} data-add-truck>+ और गाड़ी जोड़ो</button>
              </>
            )}

            {Err}
            <button onClick={submitRegistration} disabled={busy} className={`${BIG} mt-5 bg-violet-600`} id="g2-reg-send">
              {busy ? 'भेज रहे हैं…' : '📤 ऑफिस को भेजो'}
            </button>
            <button onClick={() => { setStep('NUMBER'); setError(''); }} className={`${GHOST} mt-2 mb-4`}>‹ वापस लॉगिन पर</button>
          </>
        )}

        {step === 'REGISTERED' && (
          <>
            <Brand icon="✅" title="फ़ॉर्म ऑफिस पहुँच गया" sub="Sent to the office" tone="from-emerald-500 to-teal-600" />
            <div className="mt-6 rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4 text-center" data-screen="registered">
              <p className="text-[17px] font-black text-emerald-900">{applied?.name}</p>
              {applied?.id && (
                <p className="mt-1 font-mono text-[12.5px] font-bold text-emerald-800">
                  Ref: {String(applied.id).slice(0, 8).toUpperCase()}
                </p>
              )}
              <p className="mt-3 text-[14px] font-semibold leading-relaxed text-emerald-900/85">
                ऑफिस आपका GSTIN, PAN और बैंक खाता जाँचेगा और फिर आपका ऐप चालू करेगा। मंज़ूरी मिलने तक इस नंबर से लॉगिन नहीं होगा — ऑफिस आपको कॉल करेगा।
              </p>
              <p className="mt-2 text-[12px] font-semibold text-emerald-900/70">
                The office verifies and activates your account. You cannot sign in until they do.
              </p>
            </div>
            {DISPATCH_MOBILE && <a href={DISPATCH_TEL} className={`${BIG} mt-5 block text-center`}>📞 ऑफिस को कॉल करो</a>}
            <button onClick={() => { setApplied(null); reset(); }} className={`${GHOST} mt-2`}>‹ लॉगिन पर वापस</button>
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
