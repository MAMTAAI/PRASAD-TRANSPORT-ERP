// @ts-nocheck
import React, { useState, useRef } from 'react';
import { collection, query, where, getDocs, getDoc, doc } from 'firebase/firestore';
import { db, auth } from './firebase';
import { signInWithEmailAndPassword, signInWithPhoneNumber, RecaptchaVerifier } from 'firebase/auth';

interface LoginProps {
  onLoginSuccess: (userData: any) => void;
  onCustomerClick: () => void;
  onPartnerClick: () => void;
  onDriverClick: () => void;
  onBackToWeb: () => void;
}

export default function Login({ onLoginSuccess, onCustomerClick, onPartnerClick, onDriverClick, onBackToWeb }: LoginProps) {
  // 🧭 STATES FOR ROUTING & UI
  const [loginMode, setLoginMode] = useState<'SELECT' | 'CUSTOMER' | 'PARTNER' | 'ADMIN'>('SELECT');
  
  // 🔐 STATES FOR OFFICE STAFF
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  
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
      // 🔐 PHASE 1: REAL Firebase Authentication. The server verifies the
      // password; security rules then trust request.auth.uid — identity can
      // no longer be forged via DevTools/localStorage.
      const cred = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      const uid = cred.user.uid;

      // Profile doc is keyed by the auth uid (imported that way).
      let data = null; let docId = uid;
      const snap = await getDoc(doc(db, "USERS", uid));
      if (snap.exists()) { data = snap.data(); }
      else {
        // Fallback for any legacy doc not keyed by uid
        const qs = await getDocs(query(collection(db, "USERS"), where("email", "==", email.trim().toLowerCase())));
        if (!qs.empty) { data = qs.docs[0].data(); docId = qs.docs[0].id; }
      }

      if (!data) {
        alert("🚨 Login to hua par staff profile nahi mila. Admin se sampark karein.");
      } else if (data.status === 'INACTIVE') {
        alert("🚨 Your account is disabled. Contact Super Admin.");
      } else {
        const { password_hash, password_salt, password: _pw, ...safeData } = data;
        onLoginSuccess({ id: docId, uid, ...safeData });
      }
    } catch (error: any) {
      console.error("Login error:", error?.code);
      if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(error?.code)) {
        alert("❌ Invalid Email or Password!");
      } else if (error?.code === 'auth/too-many-requests') {
        alert("🚨 Bahut zyada galat attempts — thodi der baad try karein.");
      } else {
        alert("❌ Login failed! Check your internet connection.");
      }
    }
    setLoading(false);
  };

  // ==========================================
  // 📱 2. OTP SEND LOGIC 
  // ==========================================
  // 📱 PHASE 1b: REAL portal OTP via Firebase Phone Auth — the server sends
  // and verifies the code (the old placeholder accepted any 4 digits).
  const confirmRef = useRef<any>(null);
  const recapRef = useRef<any>(null);

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    const m = mobile.replace(/[^\d]/g, '').replace(/^91(?=[6-9]\d{9}$)/, '');
    if (!/^[6-9]\d{9}$/.test(m)) return alert("⚠️ Please enter a valid 10-digit mobile number.");
    setLoading(true);
    try {
      if ((window as any).__QA_DISABLE_APP_VERIFY) (auth as any).settings.appVerificationDisabledForTesting = true;
      if (!recapRef.current) recapRef.current = new RecaptchaVerifier(auth, 'portal-recaptcha', { size: 'invisible' });
      confirmRef.current = await signInWithPhoneNumber(auth, '+91' + m, recapRef.current);
      setMobile(m);
      setOtpSent(true);
      alert(`📩 OTP sent to +91 ${m}`);
    } catch (err: any) {
      console.error(err?.code);
      alert(err?.code === 'auth/too-many-requests' ? '🚨 Too many attempts — please try again later.' : '❌ OTP send failed — check the number and your connection.');
      try { recapRef.current?.clear(); } catch {}
      recapRef.current = null;
    }
    setLoading(false);
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) return alert("⚠️ Please enter the 6-digit OTP.");
    setLoading(true);
    try {
      await confirmRef.current.confirm(otp);
      if (loginMode === 'CUSTOMER') onCustomerClick();
      else if (loginMode === 'PARTNER') onPartnerClick();
    } catch (err) {
      console.error(err);
      alert('❌ Wrong OTP — please check and try again.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#020617] flex font-sans selection:bg-blue-500 selection:text-white relative overflow-hidden">
      
      <div className="absolute inset-0 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:20px_20px] opacity-[0.03]"></div>
      <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] -translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>

      <button 
        onClick={() => {
          if (loginMode !== 'SELECT') setLoginMode('SELECT'); 
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
          {loginMode === 'ADMIN' && (
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
              </form>
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

      <div id="portal-recaptcha"></div>
      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.4s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}