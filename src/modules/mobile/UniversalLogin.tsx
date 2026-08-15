// @ts-nocheck
// ============================================================================
// <UniversalLogin /> — the one door for all 5 roles.
//
// Step 1: mobile number or email. An email routes to the password lane
//         (staff/admin); a 10-digit mobile routes to the WhatsApp-OTP lane
//         (staff, drivers, customers, vendors — the API resolves who you are).
// Step 2: 6-digit OTP boxes (auto-advance, paste-aware) or password.
// On success the API's role decides which isolated environment loads —
// the client never picks its own privileges.
// ============================================================================
import React, { useMemo, useRef, useState } from 'react';
import { Hexagon, Smartphone, KeyRound, ArrowRight, ArrowLeft, MessageCircle, ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth, ROLES } from './auth/AuthProvider';

const ROLE_BADGES = {
  ADMIN: 'text-red-300 border-red-500/40', OFFICE_STAFF: 'text-cyan-300 border-cyan-500/40',
  CUSTOMER: 'text-emerald-300 border-emerald-500/40', VENDOR: 'text-amber-300 border-amber-500/40',
  DRIVER: 'text-violet-300 border-violet-500/40',
};

export default function UniversalLogin({ onAuthenticated }) {
  const { requestOtp, verifyOtp, loginPassword } = useAuth();
  const [step, setStep] = useState(1);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [channelNote, setChannelNote] = useState('');
  const boxes = useRef([]);

  const isEmail = useMemo(() => identifier.includes('@'), [identifier]);
  const mobile = useMemo(() => identifier.replace(/\D/g, '').slice(-10), [identifier]);

  const begin = async () => {
    setError('');
    if (isEmail) { setStep(2); return; }
    if (mobile.length !== 10) { setError('Enter a 10-digit mobile number or an email.'); return; }
    setBusy(true);
    const r = await requestOtp(mobile);
    setBusy(false);
    if (!r.ok) { setError(r.detail || r.error || 'Could not send OTP'); return; }
    setChannelNote(r.demo ? 'DEMO MODE — backend offline, OTP is 123456' : `OTP sent on ${r.channel} · valid ${r.ttl} min`);
    setStep(2);
    setTimeout(() => boxes.current[0]?.focus(), 60);
  };

  const submitOtp = async (code) => {
    setBusy(true); setError('');
    const r = await verifyOtp(mobile, code);
    setBusy(false);
    if (!r.ok) { setError(r.error || 'Invalid code'); setDigits(['', '', '', '', '', '']); boxes.current[0]?.focus(); return; }
    onAuthenticated?.(r.role);
  };

  const submitPassword = async () => {
    setBusy(true); setError('');
    const r = await loginPassword(identifier.trim().toLowerCase(), password);
    setBusy(false);
    if (!r.ok) { setError(r.error || 'Login failed'); return; }
    onAuthenticated?.(r.role);
  };

  const onDigit = (i, v) => {
    const c = v.replace(/\D/g, '');
    if (c.length > 1) { // paste of the whole code
      const all = c.slice(0, 6).split('');
      setDigits([...all, '', '', '', '', '', ''].slice(0, 6));
      if (all.length === 6) submitOtp(all.join(''));
      return;
    }
    const next = [...digits]; next[i] = c; setDigits(next);
    if (c && i < 5) boxes.current[i + 1]?.focus();
    if (next.every((d) => d) && next.join('').length === 6) submitOtp(next.join(''));
  };

  return (
    <div className="min-h-full w-full grid place-items-center p-4 bg-[#080c14]"
      style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div className="relative w-full max-w-md">
        {/* neon glow ground */}
        <div className="pointer-events-none absolute -top-16 -left-16 w-64 h-64 rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 -right-16 w-64 h-64 rounded-full bg-cyan-500/15 blur-3xl" />

        <div className="relative rounded-3xl bg-slate-900/40 backdrop-blur-md border border-slate-700/50 p-6 sm:p-8 shadow-[0_8px_40px_rgba(0,0,0,0.5)]">
          {/* brand */}
          <div className="flex flex-col items-center text-center">
            <span className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-600 shadow-[0_0_28px_rgba(52,211,153,0.45)]">
              <Hexagon size={26} className="text-white" />
            </span>
            <h1 className="mt-4 text-lg font-black text-white tracking-wide">PRASAD TRANSPORT</h1>
            <p className="text-[10px] font-bold tracking-[0.3em] text-emerald-400/80 uppercase">Universal Gateway · v5.0</p>
          </div>

          {/* the 5 environments this door serves */}
          <div className="mt-4 flex flex-wrap justify-center gap-1.5">
            {ROLES.map((r) => (
              <span key={r} className={`px-2 py-0.5 rounded-full border bg-white/5 text-[8px] font-black tracking-wider ${ROLE_BADGES[r]}`}>{r}</span>
            ))}
          </div>

          {step === 1 && (
            <div className="mt-7">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Mobile number / Email</label>
              <div className="mt-1.5 flex items-center gap-2 rounded-2xl bg-slate-950/70 border border-slate-700/50 px-4 py-3 focus-within:border-emerald-500/60 transition-colors">
                <Smartphone size={16} className="text-slate-500 shrink-0" />
                <input
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && begin()}
                  placeholder="98765 43210  or  you@prasad.com"
                  inputMode="email"
                  className="flex-1 min-w-0 bg-transparent text-[15px] text-slate-100 placeholder-slate-600 outline-none"
                  autoFocus
                />
              </div>
              <button
                onClick={begin} disabled={busy}
                className="mt-4 w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-600 to-cyan-600 px-4 py-3.5 text-[13px] font-black text-white shadow-[0_0_25px_rgba(52,211,153,0.35)] hover:brightness-110 transition-all disabled:opacity-60"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : isEmail ? <KeyRound size={15} /> : <MessageCircle size={15} />}
                {isEmail ? 'Continue with password' : 'Send WhatsApp OTP'}
                <ArrowRight size={15} />
              </button>
              <p className="mt-3 text-center text-[10px] text-slate-600">
                Your role is detected automatically — one app, five secure environments.
              </p>
            </div>
          )}

          {step === 2 && !isEmail && (
            <div className="mt-7">
              <p className="text-center text-[12px] text-slate-400">
                Code sent to <span className="font-black text-slate-100">+91 {mobile}</span>
              </p>
              {channelNote && <p className="mt-1 text-center text-[10px] font-bold text-emerald-400">{channelNote}</p>}
              <div className="mt-4 flex justify-center gap-2">
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => (boxes.current[i] = el)}
                    value={d}
                    onChange={(e) => onDigit(i, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus(); }}
                    inputMode="numeric" maxLength={6}
                    className="w-11 h-14 sm:w-12 rounded-xl bg-slate-950/70 border border-slate-700/50 text-center text-xl font-black text-emerald-300 outline-none focus:border-emerald-500/70 focus:shadow-[0_0_15px_rgba(52,211,153,0.25)] transition-all"
                  />
                ))}
              </div>
              {busy && <p className="mt-3 text-center text-[11px] text-cyan-400 flex items-center justify-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Verifying…</p>}
              <button onClick={() => { setStep(1); setDigits(['', '', '', '', '', '']); setError(''); }} className="mt-4 mx-auto flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-300 transition-colors">
                <ArrowLeft size={12} /> Change number
              </button>
            </div>
          )}

          {step === 2 && isEmail && (
            <div className="mt-7">
              <p className="text-center text-[12px] text-slate-400">Staff login for <span className="font-black text-slate-100">{identifier}</span></p>
              <div className="mt-4 flex items-center gap-2 rounded-2xl bg-slate-950/70 border border-slate-700/50 px-4 py-3 focus-within:border-cyan-500/60 transition-colors">
                <KeyRound size={16} className="text-slate-500 shrink-0" />
                <input
                  type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
                  placeholder="Password"
                  className="flex-1 min-w-0 bg-transparent text-[15px] text-slate-100 placeholder-slate-600 outline-none"
                  autoFocus
                />
              </div>
              <button
                onClick={submitPassword} disabled={busy}
                className="mt-4 w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-600 to-blue-600 px-4 py-3.5 text-[13px] font-black text-white shadow-[0_0_25px_rgba(34,211,238,0.3)] hover:brightness-110 transition-all disabled:opacity-60"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={15} />} Sign in
              </button>
              <button onClick={() => { setStep(1); setPassword(''); setError(''); }} className="mt-4 mx-auto flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-300 transition-colors">
                <ArrowLeft size={12} /> Back
              </button>
            </div>
          )}

          {error && (
            <p className="mt-4 text-center text-[11px] font-bold text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">{error}</p>
          )}
        </div>

        <p className="mt-4 text-center text-[9px] tracking-[0.25em] font-bold text-slate-700 uppercase">
          JWT-secured · Role-isolated bundles · WhatsApp OTP
        </p>
      </div>
    </div>
  );
}
