// @ts-nocheck
// ============================================================================
// GATE 1 — ADMIN & STAFF LOGIN (desktop)
//
// The office door, and only the office door (owner, 2026-09-03: "two distinct
// login gateways — strict separation between external users and office
// staff"). Until today this screen opened with a "Select Your Portal" page that
// carried Customer / Fleet Partner / Driver buttons beside the staff form. Those
// buttons are gone: every outside party now enters through Gate 2, the mobile
// Super-App gateway (/app), where a mobile number and an OTP are the whole
// login and the server routes them to their own isolated portal.
//
// What this screen does:
//   1. username (email) + password            → POST /auth/login
//   2. the one-time code that has been mandatory for staff since 31-Aug
//                                             → POST /auth/login/verify
//   3. lands on the ERP — App.tsx opens Command Center: Transport Fleet Ops.
//
// Who it refuses: a driver, vendor, customer or fleet partner. The server
// answers 403 EXTERNAL_PARTY for their number or account, and the screen says
// so in words instead of "invalid credentials", with a link to the mobile app.
// Nothing is logged in on that path.
//
// Self-service password (request a code, set a password) stays exactly as it
// was — it is the only way a staff member who was never given a password can
// get one without an admin typing it in.
// ============================================================================
import React, { useState } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const AUTH = `${API}/api/v1/auth`;

const authFetch = async (path: string, body: any) => {
  const res = await fetch(`${AUTH}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error, kind: json.kind });
  return json;
};

/** Where the outside parties go. Same origin, the /app path is Gate 2. */
const GATE2_URL = '/app';

interface LoginProps {
  onLoginSuccess: (userData: any) => void;
  /** Raised when the credential was right but the account is PENDING/SUSPENDED. */
  onAccountHold?: (hold: { status: 'PENDING' | 'SUSPENDED'; user: any }) => void;
  onBackToWeb?: () => void;
}

const KIND_LABEL: Record<string, string> = {
  driver: 'driver', customer: 'customer', vendor: 'vendor / fleet partner', fleet_partner: 'fleet partner',
};

export default function Login({ onLoginSuccess, onBackToWeb, onAccountHold }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<null | { tone: 'bad' | 'warn' | 'ok'; text: string }>(null);

  // 403 EXTERNAL_PARTY: the identifier belongs to an outside party. Rendered as
  // its own state, not an alert — it is the one answer this door gives that is
  // not "try again".
  const [refused, setRefused] = useState<null | { kind: string }>(null);

  // Self-service password (OTP). null = not in the flow.
  const [resetStage, setResetStage] = useState<null | 'REQUEST' | 'CONFIRM'>(null);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [resetInfo, setResetInfo] = useState<string | null>(null);

  // Second factor. null = not in the flow; otherwise the password stage
  // succeeded and the server is holding the session until the code comes back.
  const [twoFa, setTwoFa] = useState<null | {
    mobile: string | null;
    email?: string | null;
    delivered?: { channel: string; to: string }[];
    ttl: number;
  }>(null);
  const [twoFaCode, setTwoFaCode] = useState('');

  const say = (tone: 'bad' | 'warn' | 'ok', text: string) => setNotice({ tone, text });

  // ── 1. username + password ────────────────────────────────────────────────
  const handleOfficeLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (!email || !password) return say('warn', 'Username aur password dono daalein.');
    setLoading(true);
    try {
      const r = await authFetch('/login', { email: email.trim().toLowerCase(), password });
      if (r.otp_required) {
        setTwoFa({
          mobile: r.mobile ?? null, email: r.email ?? null,
          delivered: r.delivered ?? [], ttl: r.expires_in_minutes ?? 5,
        });
        setTwoFaCode('');
        setLoading(false);
        return;
      }
      localStorage.setItem('prasad_token', r.token);
      localStorage.setItem('prasad_token_expires', String(r.expires_at ?? ''));
      onLoginSuccess({ ...r.user, uid: r.user.id });
    } catch (error: any) {
      console.error('Login error:', error?.code);
      const code = error?.code;
      if (code === 'EXTERNAL_PARTY') {
        setRefused({ kind: String(error.kind || 'external') });
      } else if (code === 'ACCOUNT_PENDING_APPROVAL' || code === 'ACCOUNT_SUSPENDED') {
        onAccountHold?.({
          status: code === 'ACCOUNT_SUSPENDED' ? 'SUSPENDED' : 'PENDING',
          user: { full_name: email.trim(), email: email.trim().toLowerCase() },
        });
      } else if (code === 'PASSWORD_RESET_REQUIRED') {
        say('warn', 'Is account ka password abhi set nahi hai — neeche "Password set karein" se code mangwa kar apna password banayein.');
      } else if (code === 'ACCOUNT_INACTIVE') {
        say('bad', 'Ye account band hai. Super Admin se sampark karein.');
      } else if (code === 'ACCOUNT_LOCKED') {
        say('bad', 'Bahut zyada galat attempts — ' + error.message);
      } else if (code === 'INVALID_CREDENTIALS') {
        say('bad', 'Username ya password galat hai.');
      } else if (code === 'DB_UNAVAILABLE') {
        say('bad', 'Server database se connect nahi ho pa raha — thodi der baad try karein.');
      } else {
        say('bad', 'Login nahi hua — internet check karein.');
      }
    }
    setLoading(false);
  };

  // ── 2. the one-time code ──────────────────────────────────────────────────
  const handleVerify2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (!/^\d{6}$/.test(twoFaCode)) return say('warn', '6-digit code daalein.');
    setLoading(true);
    try {
      const { token, expires_at, user } = await authFetch('/login/verify', {
        email: email.trim().toLowerCase(), code: twoFaCode,
      });
      localStorage.setItem('prasad_token', token);
      localStorage.setItem('prasad_token_expires', String(expires_at ?? ''));
      setTwoFa(null); setTwoFaCode('');
      onLoginSuccess({ ...user, uid: user.id });
    } catch (err: any) {
      console.error(err?.code);
      if (err?.code === 'OTP_LOCKED') {
        say('bad', 'Bahut zyada galat attempts — password se dobara login karein.');
        setTwoFa(null); setTwoFaCode('');
      } else if (err?.code === 'OTP_INVALID' || err?.code === 'OTP_ALREADY_USED') {
        say('bad', 'Code galat ya expire ho chuka hai — dobara dekhein, ya login se naya code mangwayein.');
      } else if (err?.code === 'DB_UNAVAILABLE') {
        say('bad', 'Server database se connect nahi ho pa raha — thodi der baad try karein.');
      } else {
        say('bad', 'Verify nahi ho paya — internet check karein.');
      }
    }
    setLoading(false);
  };

  // ── 3. self-service password ──────────────────────────────────────────────
  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    const addr = email.trim().toLowerCase();
    if (!addr) return say('warn', 'Apna registered office email daalein.');
    setLoading(true);
    try {
      const r = await authFetch('/password-reset/request', { email: addr });
      const where = (r.delivered ?? []).map((d: any) => `${d.channel === 'email' ? '📧' : '💬'} ${d.to}`).join('   ');
      setResetInfo(where ? `Code bhej diya gaya: ${where}` : 'Agar ye email registered hai to code aapke email aur WhatsApp par bhej diya gaya hai.');
      setResetStage('CONFIRM');
      setResetCode('');
    } catch (err: any) {
      console.error(err?.code);
      if (err?.code === 'OTP_SEND_FAILED') say('bad', 'Code kisi bhi channel par nahi bheja ja saka. Office se sampark karein.');
      else if (err?.code === 'ACCOUNT_PENDING_APPROVAL' || err?.code === 'ACCOUNT_SUSPENDED') {
        onAccountHold?.({ status: err.code === 'ACCOUNT_SUSPENDED' ? 'SUSPENDED' : 'PENDING', user: { full_name: addr, email: addr } });
      } else if (err?.code === 'DB_UNAVAILABLE') say('bad', 'Server database se connect nahi ho pa raha — thodi der baad try karein.');
      else say('bad', 'Code bhejne me dikkat aayi — internet check karein.');
    }
    setLoading(false);
  };

  const handleResetConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (!/^\d{6}$/.test(resetCode)) return say('warn', '6-digit code daalein.');
    if (newPassword.length < 8) return say('warn', 'Password kam se kam 8 akshar ka hona chahiye.');
    if (newPassword !== newPassword2) return say('warn', 'Dono password ek jaise nahi hain.');
    setLoading(true);
    try {
      await authFetch('/password-reset/confirm', { email: email.trim().toLowerCase(), code: resetCode, password: newPassword });
      setResetStage(null);
      setResetCode(''); setNewPassword(''); setNewPassword2(''); setPassword('');
      say('ok', 'Password set ho gaya — ab isi password se login karein.');
    } catch (err: any) {
      console.error(err?.code);
      if (err?.code === 'OTP_EXPIRED') say('bad', 'Code expire ho gaya — naya code mangwayein.');
      else if (err?.code === 'OTP_ATTEMPTS_EXCEEDED') say('bad', 'Bahut zyada galat attempts — naya code mangwayein.');
      else if (err?.code === 'WEAK_PASSWORD') say('warn', 'Password kam se kam 8 akshar ka hona chahiye.');
      else if (err?.code === 'OTP_INVALID') say('bad', 'Code galat hai — dobara dekhein.');
      else say('bad', 'Password set nahi ho paya — dobara try karein.');
    }
    setLoading(false);
  };

  // ── render helpers ────────────────────────────────────────────────────────
  const INPUT = 'w-full rounded-xl border border-slate-700 bg-[#0a1024] px-4 py-3 text-[14px] text-white placeholder-slate-600 outline-none transition-colors focus:border-cyan-400/70';
  const LABEL = 'mb-1.5 mt-3 block text-[10.5px] font-black uppercase tracking-[0.12em] text-slate-400';
  const PRIMARY = 'mt-5 w-full rounded-xl bg-cyan-400 px-4 py-3.5 text-[14px] font-black text-[#02131a] shadow-[0_8px_24px_rgba(34,211,238,0.25)] transition-all hover:bg-cyan-300 disabled:opacity-60';
  const GHOST = 'mt-2 w-full rounded-xl border border-slate-700 bg-white/[0.03] px-4 py-3 text-[13px] font-bold text-slate-300 transition-colors hover:border-slate-500 hover:text-white';

  const Notice = notice ? (
    <p className={`mt-4 rounded-xl border px-3 py-2.5 text-[12px] font-semibold leading-snug ${
      notice.tone === 'ok' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
        : notice.tone === 'warn' ? 'border-amber-500/50 bg-amber-500/10 text-amber-100'
          : 'border-red-500/50 bg-red-500/10 text-red-200'}`}>
      {notice.text}
    </p>
  ) : null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a1024] p-6 font-sans text-slate-200 selection:bg-cyan-500 selection:text-white"
      data-gate="1">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(#ffffff_1px,transparent_1px)] opacity-[0.03] [background-size:20px_20px]" />
      <div className="pointer-events-none absolute -top-40 left-1/4 h-[520px] w-[520px] rounded-full bg-cyan-600/15 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 h-[420px] w-[420px] rounded-full bg-blue-700/15 blur-[120px]" />

      <div className="relative z-10 w-full max-w-[420px] animate-fade-in-up rounded-3xl border border-slate-700/60 bg-slate-900/85 p-7 shadow-[0_20px_60px_rgba(0,0,0,0.55)] backdrop-blur">
        {/* brand */}
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-700 text-[22px] shadow-[0_0_18px_rgba(34,211,238,0.4)]">🚛</span>
          <div className="min-w-0">
            <p className="text-[16px] font-black leading-tight text-white">Prasad Transport ERP</p>
            <p className="text-[11px] font-semibold text-slate-400">Office login · staff and admins only</p>
          </div>
        </div>

        {/* ── REFUSED: an outside party at the office door ── */}
        {refused && (
          <div className="mt-5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-500/10 px-2.5 py-1 text-[11px] font-black text-red-300">⛔ Refused · external role</span>
            <div className="mt-3 rounded-xl border border-red-500/50 bg-red-500/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-red-100">
              <b className="block text-white">This door is for office staff only.</b>
              <span className="font-mono text-white">{email.trim()}</span> belongs to a <b>{KIND_LABEL[refused.kind] || 'registered party'}</b>.
              Drivers, vendors, customers and fleet partners sign in on the mobile app with an OTP. Nothing was logged in.
            </div>
            <a href={GATE2_URL} className={`${PRIMARY} block text-center`}>📱 Open the mobile app →</a>
            <button type="button" className={GHOST} onClick={() => { setRefused(null); setPassword(''); setNotice(null); }}>← Back to staff login</button>
            <p className="mt-4 text-center text-[11px] leading-snug text-slate-500">Server side: the staff login accepts staff accounts only. A driver has no password by design.</p>
          </div>
        )}

        {/* ── STEP 2: the one-time code ── */}
        {!refused && twoFa && (
          <form onSubmit={handleVerify2FA} className="mt-5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-black text-cyan-300">🔐 Step 2 of 2 · one-time code</span>
            <p className="mt-3 text-[13px] leading-relaxed text-slate-300">
              {twoFa.delivered && twoFa.delivered.length > 0 ? (
                <>Code sent to {twoFa.delivered.map((d, i) => (
                  <b key={i} className="text-white">{d.channel === 'email' ? '📧' : '💬'} {d.to}{i < twoFa.delivered!.length - 1 ? ' and ' : ''}</b>
                ))}. Valid {twoFa.ttl} minutes.</>
              ) : (
                <>Password sahi hai — code aapke mobile <b className="text-white">{twoFa.mobile}</b> par bheja gaya hai ({twoFa.ttl} min valid).</>
              )}
            </p>
            <label className={LABEL}>Enter code</label>
            <input type="text" inputMode="numeric" maxLength={6} autoFocus value={twoFaCode}
              onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, ''))}
              className={`${INPUT} text-center font-mono text-[24px] font-black tracking-[0.5em]`} placeholder="••••••" />
            {Notice}
            <button type="submit" disabled={loading} className={PRIMARY}>{loading ? 'Verifying…' : 'Verify & enter →'}</button>
            <button type="button" className={GHOST} onClick={() => { setTwoFa(null); setTwoFaCode(''); setNotice(null); }}>← Back</button>
            <p className="mt-4 text-center text-[11px] leading-snug text-slate-500">This step has been mandatory for staff since 31-Aug.</p>
          </form>
        )}

        {/* ── SELF-SERVICE PASSWORD ── */}
        {!refused && !twoFa && resetStage !== null && (
          <div className="mt-5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-black text-emerald-300">🔑 Apna password set karein</span>
            <p className="mt-3 text-[12.5px] leading-relaxed text-slate-400">
              {resetStage === 'REQUEST'
                ? 'Registered office email daalein — 6-digit code email aur WhatsApp par aayega.'
                : (resetInfo || 'Code aa gaya hoga — neeche daalein aur naya password chunein.')}
            </p>
            {resetStage === 'REQUEST' ? (
              <form onSubmit={handleResetRequest}>
                <label className={LABEL}>Office email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aapka office email" className={INPUT} autoFocus />
                {Notice}
                <button type="submit" disabled={loading} className={PRIMARY}>{loading ? 'Bhej rahe hain…' : 'Code bhejo →'}</button>
              </form>
            ) : (
              <form onSubmit={handleResetConfirm}>
                <label className={LABEL}>6-digit code</label>
                <input type="text" inputMode="numeric" maxLength={6} value={resetCode} onChange={(e) => setResetCode(e.target.value.replace(/\D/g, ''))}
                  className={`${INPUT} text-center font-mono text-[22px] font-black tracking-[0.5em]`} placeholder="••••••" autoFocus />
                <label className={LABEL}>Naya password</label>
                <input type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={INPUT} placeholder="kam se kam 8 akshar" />
                <label className={LABEL}>Dobara likhein</label>
                <input type={showPassword ? 'text' : 'password'} value={newPassword2} onChange={(e) => setNewPassword2(e.target.value)} className={INPUT} placeholder="wahi password" />
                {Notice}
                <button type="submit" disabled={loading} className={PRIMARY}>{loading ? 'Set kar rahe hain…' : 'Password set karo →'}</button>
                <button type="button" className={GHOST} onClick={() => { setResetStage('REQUEST'); setResetCode(''); setNotice(null); }}>Naya code mangwao</button>
              </form>
            )}
            <button type="button" className={GHOST} onClick={() => { setResetStage(null); setResetCode(''); setNewPassword(''); setNewPassword2(''); setNotice(null); }}>← Back to login</button>
          </div>
        )}

        {/* ── STEP 1: username + password ── */}
        {!refused && !twoFa && resetStage === null && (
          <form onSubmit={handleOfficeLogin} className="mt-4">
            <label className={LABEL} htmlFor="g1-user">Username / email</label>
            <input id="g1-user" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
              className={INPUT} placeholder="name@prasadtransport.in" autoFocus />
            <label className={LABEL} htmlFor="g1-pass">Password</label>
            <div className="relative">
              <input id="g1-pass" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
                className={`${INPUT} pr-14`} placeholder="••••••••" />
              <button type="button" tabIndex={-1} onClick={() => setShowPassword((s) => !s)} title={showPassword ? 'Password chhupayein' : 'Password dikhayein'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-black text-slate-500 hover:text-cyan-300">{showPassword ? 'HIDE' : 'SHOW'}</button>
            </div>
            {Notice}
            <button type="submit" disabled={loading} className={PRIMARY} id="g1-signin">{loading ? 'Checking…' : 'Sign in →'}</button>
            <button type="button" onClick={() => { setResetStage('REQUEST'); setResetInfo(null); setNotice(null); }}
              className="mt-3 w-full text-center text-[11.5px] font-bold text-slate-500 hover:text-cyan-300">Password nahi hai / bhool gaye? Khud set karein →</button>
            <p className="mt-5 border-t border-slate-800 pt-4 text-center text-[11px] leading-relaxed text-slate-500">
              Drivers, vendors, customers, fleet partners: this door does not open for you.<br />
              <a href={GATE2_URL} className="font-bold text-slate-300 underline decoration-dotted underline-offset-4 hover:text-cyan-300">Use the mobile app →</a>
            </p>
          </form>
        )}
      </div>

      {onBackToWeb && (
        <button onClick={onBackToWeb} className="absolute left-5 top-5 z-10 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[12px] font-bold text-slate-400 hover:text-white">← Website</button>
      )}
      <p className="absolute bottom-4 z-10 text-[10.5px] font-semibold text-slate-600">Gate 1 · office staff · desktop</p>
    </div>
  );
}
