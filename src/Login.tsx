// @ts-nocheck
import React, { useState } from 'react';
import { collection, query, where, getDocs, updateDoc, doc, deleteField } from 'firebase/firestore';
import { db } from './firebase';
import { hashPassword, verifyPassword } from './lib/passwords';

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
      const q = query(collection(db, "USERS"), where("email", "==", email));
      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        alert("❌ Invalid Email or Password!");
        setLoading(false);
        return;
      }

      const userDoc = querySnapshot.docs[0];
      const data = userDoc.data();

      let ok = false;
      if (data.password_hash && data.password_salt) {
        ok = await verifyPassword(password, data.password_salt, data.password_hash);
      } else if (data.password) {
        // Legacy plaintext doc (created before the security migration):
        // verify once, then upgrade it to a salted hash and remove the plaintext.
        ok = data.password === password;
        if (ok) {
          const { saltHex, hashHex } = await hashPassword(password);
          await updateDoc(doc(db, "USERS", userDoc.id), {
            password_hash: hashHex,
            password_salt: saltHex,
            password: deleteField()
          }).catch(() => {});
          delete data.password;
        }
      }

      if (!ok) {
        alert("❌ Invalid Email or Password!");
      } else if (data.status === 'INACTIVE') {
        alert("🚨 Your account is disabled. Contact Super Admin.");
      } else {
        const { password_hash, password_salt, password: _pw, ...safeData } = data;
        onLoginSuccess({ id: userDoc.id, ...safeData });
      }
    } catch (error) {
      console.error("Login error:", error);
      alert("❌ Login failed! Check your internet connection.");
    }
    setLoading(false);
  };

  // ==========================================
  // 📱 2. OTP SEND LOGIC 
  // ==========================================
  // 🔒 SECURITY: the previous OTP flow was a placeholder that accepted any 4 digits,
  // leaving the Customer/Partner portals open to anyone. Portal login stays disabled
  // until real phone verification (Firebase Phone Auth) ships in Phase 1.
  const handleSendOTP = (e: React.FormEvent) => {
    e.preventDefault();
    alert("🔒 Portal login is temporarily disabled for a security upgrade.\nPlease contact the Prasad Transport office for your account details.");
  };

  const handleVerifyOTP = (e: React.FormEvent) => {
    e.preventDefault();
    alert("🔒 Portal login is temporarily disabled for a security upgrade.");
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
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-sm font-bold text-white outline-none focus:border-red-500 transition-colors shadow-inner" required />
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
                    <input type="text" maxLength={4} value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="••••" className={`w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-white text-3xl tracking-[1em] font-black text-center outline-none transition-colors ${loginMode === 'CUSTOMER' ? 'focus:border-blue-500' : 'focus:border-orange-500'}`} required />
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