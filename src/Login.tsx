// @ts-nocheck
import React, { useState } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const AUTH = `${API}/api/v1/auth`;

const authFetch = async (path: string, body: any) => {
  const res = await fetch(`${AUTH}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

interface LoginProps {
  onLoginSuccess: (userData: any) => void;
  /** Raised when the credential was right but the account is PENDING/SUSPENDED. */
  onAccountHold?: (hold: { status: 'PENDING' | 'SUSPENDED'; user: any }) => void;
  onCustomerClick: () => void;
  onPartnerClick: () => void;
  onDriverClick: () => void;
  onBackToWeb: () => void;
}

export default function Login({ onLoginSuccess, onCustomerClick, onPartnerClick, onDriverClick, onBackToWeb, onAccountHold }: LoginProps) {
  // 🧭 STATES FOR ROUTING & UI
  const [loginMode, setLoginMode] = useState<'SELECT' | 'CUSTOMER' | 'PARTNER' | 'ADMIN'>('SELECT');
  
  // 🔐 STATES FOR OFFICE STAFF
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // 🔑 SELF-SERVICE PASSWORD (OTP). null = not in the flow; the two stages are
  // 'ask for a code' and 'enter it with the password you want'.
  const [resetStage, setResetStage] = useState<null | 'REQUEST' | 'CONFIRM'>(null);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [resetInfo, setResetInfo] = useState<string | null>(null);
  
  // 📱 STATES FOR OTP LOGIN
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);

  // ==========================================
  // 🏢 1. OFFICE STAFF / ADMIN LOGIN
  // ==========================================
  const handleOfficeLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return alert("⚠️ Enter both Email and Password");
    
    setLoading(true);

    try {
      // The ERP's own identity provider. One call returns the session token and
      // the profile together — the password is verified and the role read in
      // the same request, so there is no window where a session exists without
      // a profile behind it.
      const { token, expires_at, user } = await authFetch('/login', {
        email: email.trim().toLowerCase(), password,
      });

      // The token authorises every later request; the profile is only for
      // rendering. Both go where the app already looks for them.
      localStorage.setItem('prasad_token', token);
      localStorage.setItem('prasad_token_expires', String(expires_at ?? ''));
      onLoginSuccess({ ...user, uid: user.id });
    } catch (error: any) {
      console.error("Login error:", error?.code);
      if (error?.code === 'ACCOUNT_PENDING_APPROVAL' || error?.code === 'ACCOUNT_SUSPENDED') {
        // The approval gate. Not an alert: this is a state the person stays in
        // until the office acts, so it gets the full hold screen rather than a
        // dialog they dismiss and then stare at a login form they cannot pass.
        // The credential WAS correct — the account simply is not usable yet.
        onAccountHold?.({
          status: error.code === 'ACCOUNT_SUSPENDED' ? 'SUSPENDED' : 'PENDING',
          user: { full_name: email.trim(), email: email.trim().toLowerCase() },
        });
      } else if (error?.code === 'PASSWORD_RESET_REQUIRED') {
        // The cutover case, and the reason the API gives it a distinct code:
        // these accounts never had a password in PostgreSQL, Firebase held it.
        alert("🔑 Is account ka password abhi set nahi hai.\n\nFirebase se passwords transfer nahi ho sakte the — admin se naya password set karwayein.");
      } else if (error?.code === 'ACCOUNT_INACTIVE') {
        alert("🚨 Your account is disabled. Contact Super Admin.");
      } else if (error?.code === 'ACCOUNT_LOCKED') {
        alert("🚨 Bahut zyada galat attempts — " + error.message);
      } else if (error?.code === 'INVALID_CREDENTIALS') {
        alert("❌ Invalid Email or Password!");
      } else if (error?.code === 'DB_UNAVAILABLE') {
        alert("🚨 Server database se connect nahi ho pa raha — thodi der baad try karein.");
      } else {
        alert("❌ Login failed! Check your internet connection.");
      }
    }
    setLoading(false);
  };

  // ==========================================
  // 🔑 1b. APNA PASSWORD KHUD SET KAREIN (OTP)
  // ==========================================
  // WHY THIS EXISTS. Until now a password could only be created by an admin
  // typing one into the User & Role screen and then telling the person what it
  // was. That box reads "Leave blank to keep current password", so saving a
  // profile without filling it in sets nothing while still reporting success —
  // and the staff member is handed a password that was never created, fails
  // five times, and is locked out. The code comes to them instead, on both
  // channels the firm already runs, and they pick the password themselves.
  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!addr) return alert('⚠️ Apna registered email ID daalein.');
    setLoading(true);
    try {
      const r = await authFetch('/password-reset/request', { email: addr });
      // The server answers the same way whether or not the address belongs to
      // an account, so this cannot promise delivery — only say where to look.
      const where = (r.delivered ?? []).map((d: any) => `${d.channel === 'email' ? '📧' : '💬'} ${d.to}`).join('   ');
      setResetInfo(where
        ? `Code bhej diya gaya: ${where}`
        : `Agar ye email registered hai to code aapke email aur WhatsApp par bhej diya gaya hai.`);
      setResetStage('CONFIRM');
      setResetCode('');
    } catch (err: any) {
      console.error(err?.code);
      if (err?.code === 'OTP_SEND_FAILED') {
        // Both lanes dead. Said plainly — the alternative is somebody waiting
        // on a code that was never going to arrive, which is the exact failure
        // this flow was built to end.
        alert('🚨 Code kisi bhi channel par nahi bheja ja saka.\n\nOffice se sampark karein.');
      } else if (err?.code === 'ACCOUNT_PENDING_APPROVAL' || err?.code === 'ACCOUNT_SUSPENDED') {
        onAccountHold?.({
          status: err.code === 'ACCOUNT_SUSPENDED' ? 'SUSPENDED' : 'PENDING',
          user: { full_name: addr, email: addr },
        });
      } else if (err?.code === 'DB_UNAVAILABLE') {
        alert('🚨 Server database se connect nahi ho pa raha — thodi der baad try karein.');
      } else {
        alert('❌ Code bhejne me dikkat aayi — internet check karein.');
      }
    }
    setLoading(false);
  };

  const handleResetConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(resetCode)) return alert('⚠️ 6-digit code daalein.');
    if (newPassword.length < 8) return alert('⚠️ Password kam se kam 8 akshar ka hona chahiye.');
    // Checked here rather than server-side: the server only ever receives one
    // password, and a typo in a password you cannot see is not something it
    // could detect on your behalf.
    if (newPassword !== newPassword2) return alert('⚠️ Dono password ek jaise nahi hain.');
    setLoading(true);
    try {
      await authFetch('/password-reset/confirm', {
        email: email.trim().toLowerCase(), code: resetCode, password: newPassword,
      });
      alert('✅ Password set ho gaya!\n\nAb isi password se login karein.');
      // Straight back to the login form with the address still filled in —
      // the next thing they need to do is sign in.
      setResetStage(null);
      setResetCode(''); setNewPassword(''); setNewPassword2('');
      setPassword('');
    } catch (err: any) {
      console.error(err?.code);
      if (err?.code === 'OTP_EXPIRED') alert('⌛ Code expire ho gaya — naya code mangwayein.');
      else if (err?.code === 'OTP_ATTEMPTS_EXCEEDED') alert('🚨 Bahut zyada galat attempts — naya code mangwayein.');
      else if (err?.code === 'WEAK_PASSWORD') alert('⚠️ Password kam se kam 8 akshar ka hona chahiye.');
      else if (err?.code === 'OTP_INVALID') alert('❌ Code galat hai — dobara dekhein.');
      else alert('❌ Password set nahi ho paya — dobara try karein.');
    }
    setLoading(false);
  };

  // ==========================================
  // 📱 2. OTP SEND LOGIC 
  // ==========================================
  // 📱 Portal OTP. Firebase Phone Auth sent the SMS; the ERP has no SMS gateway,
  // so the code goes out over the WhatsApp engine the firm already runs
  // (server/lib/otpChannel.js — swap the driver there if an SMS gateway is
  // bought). No reCAPTCHA, because there is no Google widget to satisfy: abuse
  // is bounded server-side instead, by one live code per number, a 5-minute
  // expiry and a hard attempt cap — none of which the browser can talk its way
  // out of.

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    const m = mobile.replace(/[^\d]/g, '').replace(/^91(?=[6-9]\d{9}$)/, '');
    if (!/^[6-9]\d{9}$/.test(m)) return alert("⚠️ Please enter a valid 10-digit mobile number.");
    setLoading(true);
    try {
      const r = await authFetch('/otp/request', { mobile: m });
      setMobile(m);
      setOtpSent(true);
      alert(`📩 OTP sent to +91 ${m} on ${r.channel === 'whatsapp' ? 'WhatsApp' : r.channel}`);
    } catch (err: any) {
      console.error(err?.code);
      if (err?.code === 'OTP_CHANNEL_UNAVAILABLE' || err?.code === 'OTP_SEND_FAILED') {
        // Said plainly rather than as a generic failure: when the WhatsApp
        // engine is unlinked nobody can log in this way, and the operator needs
        // to know it is the engine and not the number.
        alert('🚨 OTP bhejne ka channel abhi offline hai (WhatsApp engine). Office se sampark karein.');
      } else {
        alert('❌ OTP send failed — check the number and your connection.');
      }
    }
    setLoading(false);
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) return alert("⚠️ Please enter the 6-digit OTP.");
    setLoading(true);
    try {
      const r = await authFetch('/otp/verify', { mobile, code: otp });
      // A staff number gets a real session; a portal number is identified but
      // carries no ERP token — the same access the Firebase flow granted.
      if (r.token) {
        localStorage.setItem('prasad_token', r.token);
        localStorage.setItem('prasad_token_expires', String(r.expires_at ?? ''));
      }
      if (loginMode === 'CUSTOMER') onCustomerClick();
      else if (loginMode === 'PARTNER') onPartnerClick();
    } catch (err: any) {
      console.error(err);
      if (err?.code === 'OTP_EXPIRED') alert('⌛ OTP expire ho gaya — naya code mangwayein.');
      else if (err?.code === 'OTP_ATTEMPTS_EXCEEDED') alert('🚨 Bahut zyada galat attempts — naya code mangwayein.');
      else if (err?.code === 'NO_ACCOUNT') alert('❌ Is number par koi account nahi mila.');
      else alert('❌ Wrong OTP — please check and try again.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#020617] flex font-sans selection:bg-blue-500 selection:text-white relative overflow-hidden">
      
      <div className="absolute inset-0 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:20px_20px] opacity-[0.03]"></div>
      <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] -translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>

      <button 
        onClick={() => {
          if (loginMode !== 'SELECT') { setLoginMode('SELECT'); setResetStage(null); setResetCode(''); } 
          else onBackToWeb(); 
        }} 
        className="absolute top-4 left-4 md:top-8 md:left-8 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white border border-white/10 px-5 py-2.5 rounded-full flex items-center gap-2 font-bold text-sm backdrop-blur-md transition-all z-20 shadow-lg"
      >
        <span>⬅️</span> <span className="hidden sm:inline">{loginMode !== 'SELECT' ? 'Back to Portals' : 'Back to Main Website'}</span><span className="sm:hidden">Back</span>
      </button>

      <div className="flex-1 flex flex-col justify-center items-center p-6 md:p-10 relative z-10 w-full max-w-lg mx-auto">
        <div className="w-full animate-fade-in-up">
          
          {loginMode === 'SELECT' && (
            <>
              <div className="text-center mb-8">
                <h2 className="text-3xl md:text-4xl font-black text-white mb-2">Select Your Portal</h2>
                <p className="text-slate-400 font-medium text-sm">Choose your login type to proceed securely.</p>
              </div>

              <div className="space-y-4 md:space-y-5">
                
                {/* 🔥 NEW: ADMIN / STAFF LOGIN BUTTON (Visible on all screens) */}
                <div onClick={() => setLoginMode('ADMIN')} className="group bg-gradient-to-r from-red-900 to-red-950 border border-red-800 hover:border-red-500 p-5 md:p-6 rounded-3xl cursor-pointer shadow-lg hover:shadow-[0_0_30px_rgba(220,38,38,0.4)] transition-all flex items-center gap-4 md:gap-5 hover:-translate-y-1 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-bl-full -mr-5 -mt-5 transition-transform group-hover:scale-150"></div>
                  <div className="w-14 h-14 md:w-16 md:h-16 bg-red-800 text-white rounded-2xl flex items-center justify-center text-2xl md:text-3xl shadow-inner group-hover:scale-110 transition-transform relative z-10">🔐</div>
                  <div className="relative z-10">
                    <h3 className="text-lg md:text-xl font-black text-white group-hover:text-red-400 transition-colors">Admin & Staff Login</h3>
                    <p className="text-xs text-red-200 mt-1 font-medium">Internal Core Team Only</p>
                  </div>
                </div>

                {/* CUSTOMER LOGIN */}
                <div onClick={() => setLoginMode('CUSTOMER')} className="group bg-gradient-to-r from-blue-900 to-blue-950 border border-blue-800 hover:border-blue-500 p-5 md:p-6 rounded-3xl cursor-pointer shadow-lg hover:shadow-[0_0_30px_rgba(37,99,235,0.4)] transition-all flex items-center gap-4 md:gap-5 hover:-translate-y-1 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-bl-full -mr-5 -mt-5 transition-transform group-hover:scale-150"></div>
                  <div className="w-14 h-14 md:w-16 md:h-16 bg-blue-800 text-white rounded-2xl flex items-center justify-center text-2xl md:text-3xl shadow-inner group-hover:scale-110 transition-transform relative z-10">🏢</div>
                  <div className="relative z-10">
                    <h3 className="text-lg md:text-xl font-black text-white group-hover:text-blue-400 transition-colors">Customer Login</h3>
                    <p className="text-xs text-blue-200 mt-1 font-medium">Load Providers (The Boss)</p>
                  </div>
                </div>

                {/* PARTNER LOGIN */}
                <div onClick={() => setLoginMode('PARTNER')} className="group bg-gradient-to-r from-orange-900/80 to-[#0f172a] border border-orange-900/50 hover:border-orange-500 p-5 md:p-6 rounded-3xl cursor-pointer shadow-lg hover:shadow-[0_0_30px_rgba(249,115,22,0.3)] transition-all flex items-center gap-4 md:gap-5 hover:-translate-y-1 relative overflow-hidden">
                   <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-bl-full -mr-5 -mt-5 transition-transform group-hover:scale-150"></div>
                  <div className="w-14 h-14 md:w-16 md:h-16 bg-orange-900/80 text-orange-400 rounded-2xl flex items-center justify-center text-2xl md:text-3xl shadow-inner group-hover:scale-110 transition-transform border border-orange-800/50 relative z-10">🚛</div>
                  <div className="relative z-10">
                    <h3 className="text-lg md:text-xl font-black text-white group-hover:text-orange-400 transition-colors">Fleet Partner Login</h3>
                    <p className="text-xs text-orange-200/70 mt-1 font-medium">Truck Owners & Transporters</p>
                  </div>
                </div>

                {/* DRIVER APP LINK */}
                <div onClick={onDriverClick} className="group bg-slate-900 border border-slate-800 hover:border-emerald-500 p-5 md:p-6 rounded-3xl cursor-pointer shadow-lg hover:shadow-[0_0_30px_rgba(16,185,129,0.2)] transition-all flex items-center gap-4 md:gap-5 hover:-translate-y-1 relative overflow-hidden">
                   <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-bl-full -mr-5 -mt-5 transition-transform group-hover:scale-150"></div>
                  <div className="w-14 h-14 md:w-16 md:h-16 bg-slate-800 text-emerald-400 rounded-2xl flex items-center justify-center text-2xl md:text-3xl shadow-inner group-hover:scale-110 transition-transform relative z-10 border border-slate-700">👨‍✈️</div>
                  <div className="relative z-10">
                    <h3 className="text-lg md:text-xl font-black text-white group-hover:text-emerald-400 transition-colors">Company Driver App</h3>
                    <p className="text-xs text-slate-400 mt-1 font-medium">Only for Prasad Transport Drivers</p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* 🔐 ADMIN / OFFICE STAFF LOGIN FORM */}
          {loginMode === 'ADMIN' && resetStage === null && (
            <div className="bg-slate-900/80 backdrop-blur-xl p-6 md:p-8 rounded-[32px] border border-slate-800 shadow-2xl relative overflow-hidden animate-fade-in-up w-full">
              <div className="absolute top-0 left-0 w-full h-2 bg-red-600"></div>
              
              <div className="flex items-center gap-3 mb-6 justify-center">
                <div className="bg-gradient-to-br from-blue-500 to-blue-700 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg text-white font-black text-xl border-2 border-blue-400">P</div>
                <div>
                  <h1 className="text-xl font-black tracking-tighter leading-none m-0 text-white">PRASAD<span className="text-blue-500">.</span></h1>
                  <h2 className="text-[8px] font-bold text-slate-500 tracking-[0.3em] uppercase mt-1">Transport ERP</h2>
                </div>
              </div>

              <div className="text-center mb-6">
                <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-3xl mb-3 shadow-inner bg-red-900 text-white border-2 border-red-500">🔐</div>
                <h2 className="text-xl md:text-2xl font-black text-white">Office Staff Login</h2>
                <p className="text-xs text-slate-400 mt-1">Core Operations Dashboard</p>
              </div>

              <form onSubmit={handleOfficeLogin} className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Email ID</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-sm font-bold text-white outline-none focus:border-red-500 transition-colors shadow-inner" required />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Password</label>
                  {/* 👁 Show/hide toggle — galat typing pakadne ke liye password dekh sakte hain */}
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-slate-950 border border-slate-700 p-4 pr-14 rounded-xl text-sm font-bold text-white outline-none focus:border-red-500 transition-colors shadow-inner" required />
                    <button type="button" tabIndex={-1} onClick={() => setShowPassword(s => !s)} title={showPassword ? 'Password chhupayein' : 'Password dekhein'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xl px-2 py-1 rounded-lg hover:bg-slate-800 transition-colors select-none">
                      {showPassword ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>
                <button type="submit" disabled={loading} className="w-full bg-red-600 hover:bg-red-500 text-white font-black text-sm py-4 rounded-xl shadow-[0_5px_15px_rgba(220,38,38,0.3)] transition-transform hover:-translate-y-0.5 mt-2">
                  {loading ? 'Authenticating...' : 'SECURE ERP LOGIN ➔'}
                </button>

                {/* The way out of the loop this whole flow exists for. Someone
                    who has never been given a password, or who has just locked
                    themselves out guessing, has nothing to type above — and
                    until now nothing to click either. */}
                <button type="button" onClick={() => { setResetStage('REQUEST'); setResetInfo(null); }}
                  className="w-full text-center text-xs text-slate-400 hover:text-red-400 font-bold pt-1 transition-colors">
                  Password bhool gaye / pehli baar login kar rahe hain?
                </button>
              </form>
            </div>
          )}

          {/* 🔑 OTP SE APNA PASSWORD KHUD SET KAREIN */}
          {loginMode === 'ADMIN' && resetStage !== null && (
            <div className="bg-slate-900/80 backdrop-blur-xl p-6 md:p-8 rounded-[32px] border border-slate-800 shadow-2xl relative overflow-hidden animate-fade-in-up w-full">
              <div className="absolute top-0 left-0 w-full h-2 bg-emerald-500"></div>

              <div className="text-center mb-6">
                <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-3xl mb-3 shadow-inner bg-emerald-900 text-white border-2 border-emerald-500">🔑</div>
                <h2 className="text-xl md:text-2xl font-black text-white">Apna Password Set Karein</h2>
                <p className="text-xs text-slate-400 mt-1">
                  {resetStage === 'REQUEST'
                    ? 'Code aapke email aur WhatsApp dono par jayega'
                    : 'Code daalein aur naya password chunein'}
                </p>
              </div>

              {resetStage === 'REQUEST' ? (
                <form onSubmit={handleResetRequest} className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Registered Email ID</label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aapka office email"
                      className="w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-sm font-bold text-white outline-none focus:border-emerald-500 transition-colors shadow-inner" required />
                  </div>
                  <button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm py-4 rounded-xl shadow-[0_5px_15px_rgba(16,185,129,0.3)] transition-transform hover:-translate-y-0.5">
                    {loading ? 'Bhej rahe hain...' : 'CODE BHEJEIN 📩'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleResetConfirm} className="space-y-4">
                  {/* Where the code actually went. Someone who does not know
                      which of their two channels to check will sit waiting on
                      the wrong one. */}
                  {resetInfo && (
                    <div className="bg-emerald-950/60 border border-emerald-800 rounded-xl p-3 text-[11px] text-emerald-200 font-semibold text-center">
                      {resetInfo}
                    </div>
                  )}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1 text-center">6-Digit Code</label>
                    <input type="text" inputMode="numeric" maxLength={6} value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.replace(/[^\d]/g, ''))} placeholder="••••••"
                      className="w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-white text-3xl tracking-[1em] font-black text-center outline-none focus:border-emerald-500 transition-colors" required />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Naya Password (kam se kam 8 akshar)</label>
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 p-4 pr-14 rounded-xl text-sm font-bold text-white outline-none focus:border-emerald-500 transition-colors shadow-inner" required />
                      <button type="button" tabIndex={-1} onClick={() => setShowPassword((s) => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-xl px-2 py-1 rounded-lg hover:bg-slate-800 transition-colors select-none">
                        {showPassword ? '🙈' : '👁️'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Password Dobara</label>
                    <input type={showPassword ? 'text' : 'password'} value={newPassword2} onChange={(e) => setNewPassword2(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-sm font-bold text-white outline-none focus:border-emerald-500 transition-colors shadow-inner" required />
                  </div>
                  <button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm py-4 rounded-xl shadow-[0_5px_15px_rgba(16,185,129,0.3)] transition-transform hover:-translate-y-0.5">
                    {loading ? 'Set kar rahe hain...' : 'PASSWORD SET KAREIN ✅'}
                  </button>
                  <button type="button" onClick={() => { setResetStage('REQUEST'); setResetCode(''); }}
                    className="w-full text-center text-xs text-slate-400 hover:text-emerald-400 font-bold transition-colors">
                    Code nahi mila? Dobara bhejein
                  </button>
                </form>
              )}

              <button type="button" onClick={() => { setResetStage(null); setResetCode(''); setNewPassword(''); setNewPassword2(''); }}
                className="w-full text-center text-xs text-slate-500 hover:text-white font-bold pt-4 transition-colors">
                ⬅ Wapas login par
              </button>
            </div>
          )}


          {/* 📱 CUSTOMER & PARTNER OTP LOGIN FORM */}
          {(loginMode === 'CUSTOMER' || loginMode === 'PARTNER') && (
            <div className="bg-slate-900/80 backdrop-blur-xl p-6 md:p-8 rounded-[32px] border border-slate-800 shadow-2xl relative overflow-hidden w-full">
              <div className={`absolute top-0 left-0 w-full h-2 ${loginMode === 'CUSTOMER' ? 'bg-blue-500' : 'bg-orange-500'}`}></div>
              
              <div className="text-center mb-8 mt-2">
                <div className={`w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-3xl mb-4 shadow-inner ${loginMode === 'CUSTOMER' ? 'bg-blue-900 text-white border-2 border-blue-500' : 'bg-orange-900 text-white border-2 border-orange-500'}`}>
                  {loginMode === 'CUSTOMER' ? '🏢' : '🚛'}
                </div>
                <h2 className="text-xl md:text-2xl font-black text-white">{loginMode === 'CUSTOMER' ? 'Customer Login' : 'Partner Login'}</h2>
                <p className="text-xs text-slate-400 mt-1">Secure OTP Access</p>
              </div>

              {!otpSent ? (
                <form onSubmit={handleSendOTP} className="space-y-4 md:space-y-5">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Mobile Number</label>
                    <div className="flex bg-slate-950 border border-slate-700 rounded-xl overflow-hidden focus-within:border-blue-500 transition-colors">
                      <span className="bg-slate-900 text-slate-400 font-black px-4 py-4 border-r border-slate-700">+91</span>
                      <input type="tel" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Enter 10 digits" className="w-full bg-transparent p-4 text-white font-black outline-none" required />
                    </div>
                  </div>
                  <button type="submit" disabled={loading} className={`w-full text-white font-black py-4 rounded-xl shadow-lg hover:-translate-y-0.5 transition-transform ${loginMode === 'CUSTOMER' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-orange-600 hover:bg-orange-500'}`}>
                    {loading ? 'Sending...' : 'SEND OTP 🚀'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleVerifyOTP} className="space-y-4 md:space-y-5 animate-fade-in-up">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1 text-center">Enter OTP</label>
                    <input type="text" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/[^\d]/g, ''))} placeholder="••••••" className={`w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-white text-3xl tracking-[1em] font-black text-center outline-none transition-colors ${loginMode === 'CUSTOMER' ? 'focus:border-blue-500' : 'focus:border-orange-500'}`} required />
                  </div>
                  <button type="submit" disabled={loading} className="w-full text-white font-black py-4 rounded-xl shadow-lg hover:-translate-y-0.5 transition-transform bg-emerald-600 hover:bg-emerald-500">
                    {loading ? 'Verifying...' : 'VERIFY & ENTER ✅'}
                  </button>
                </form>
              )}
            </div>
          )}

        </div>
      </div>

      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.4s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}