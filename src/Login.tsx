// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

interface LoginProps {
  onLoginSuccess: (userData: any) => void;
  onDriverClick?: () => void;
}

export default function Login({ onLoginSuccess, onDriverClick }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // 🌐 Dynamic Website Data State
  const [webData, setWebData] = useState({
    title1: 'DRIVING',
    title2: 'PROGRESS.',
    desc: 'AI-driven, highly secured, and automated transportation network moving your business forward 24/7 across the North-East.',
    bg: 'https://images.unsplash.com/photo-1511447333015-45b65e60f6d5?q=80&w=2000&auto=format&fit=crop',
    link1: 'Home',
    link2: 'Network map',
    link3: 'AI Dispatch',
    link4: 'About',
    link5: 'Contact'
  });

  // 📥 Fetch Settings from Firebase
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const docSnap = await getDoc(doc(db, "WEBSITE", "SETTINGS"));
        if (docSnap.exists()) {
          setWebData({ ...webData, ...docSnap.data() as any });
        }
      } catch (e) {
        console.log("Using default settings");
      }
    };
    loadSettings();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return alert("⚠️ Please enter Email and Password!");
    setLoading(true);

    try {
      if (email === 'admin@prasad.com' && password === 'admin123') {
        onLoginSuccess({ name: 'Super Admin', role: 'ADMIN' });
        setLoading(false);
        return;
      }

      const q = query(collection(db, "USERS"), where("email", "==", email), where("password", "==", password));
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        const userData = querySnapshot.docs[0].data();
        if (userData.status === 'ACTIVE' || userData.status === 'APPROVED' || userData.is_approved === true) {
          onLoginSuccess(userData);
        } else {
          alert("⏳ LOGIN FAILED: Your account is pending Office Approval or has been Blocked!");
        }
      } else {
        alert("❌ Invalid Email ID or Password!");
      }
    } catch (error) {
      console.error("Login Error:", error);
      alert("⚠️ System Error! Please check your internet connection.");
    }
    setLoading(false);
  };

  return (
    <div className="root-container">
      
      {/* 🚀 RESPONSIVE CSS STYLES FOR BOTH DESKTOP & MOBILE */}
      <style>{`
        body, html { margin: 0 !important; padding: 0 !important; width: 100vw; height: 100vh; background-color: #020617; }
        
        .root-container { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; display: flex; flex-direction: column; font-family: 'Inter', sans-serif; margin: 0; padding: 0; overflow: hidden; }
        
        .hero-bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: -2; background-size: cover; background-position: center; transition: background-image 0.5s ease-in-out; }
        .hero-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background: linear-gradient(135deg, rgba(2, 6, 23, 0.95) 0%, rgba(2, 6, 23, 0.6) 50%, rgba(2, 6, 23, 0.8) 100%); }
        
        .glass-panel { background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 20px; box-shadow: 0 30px 60px rgba(0,0,0,0.8); }
        .nav-link { color: #f8fafc; font-weight: 700; font-size: 13px; text-transform: uppercase; text-decoration: none; cursor: pointer; transition: 0.3s; margin-left: 35px; letter-spacing: 1px; }
        .nav-link:hover { color: #ea580c; text-shadow: 0 0 10px rgba(234, 88, 12, 0.5); }
        
        .btn-smart { background: linear-gradient(135deg, #ea580c, #c2410c); color: white; border: none; padding: 12px 30px; fontSize: 13px; font-weight: 900; cursor: pointer; text-transform: uppercase; transition: all 0.3s ease; letter-spacing: 1px; border-radius: 50px; box-shadow: 0 10px 25px rgba(234, 88, 12, 0.4); }
        .btn-smart:hover { transform: translateY(-3px); box-shadow: 0 15px 35px rgba(234, 88, 12, 0.6); }

        input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus, input:-webkit-autofill:active{ -webkit-box-shadow: 0 0 0 30px #0f172a inset !important; -webkit-text-fill-color: white !important; transition: background-color 5000s ease-in-out 0s; border-radius: 12px; }

        /* DEFAULT DESKTOP LAYOUT */
        .top-header { padding: 20px 6%; display: flex; justify-content: space-between; align-items: center; z-index: 10; border-bottom: 1px solid rgba(255,255,255,0.05); background: rgba(2, 6, 23, 0.3); backdrop-filter: blur(15px); }
        .main-content { flex: 1; display: flex; align-items: center; justify-content: space-between; padding: 0 8%; z-index: 10; }
        .text-section { flex: 1; max-width: 650px; padding-right: 40px; animation: fadeIn 1s ease-in; }
        .main-title { font-size: 65px; margin: 0 0 20px 0; color: #ffffff; font-weight: 900; text-transform: uppercase; line-height: 1.1; text-shadow: 0 10px 30px rgba(0,0,0,0.8); }
        .desc-text { color: #cbd5e1; font-size: 18px; line-height: 1.7; margin: 0; max-width: 500px; text-shadow: 0 5px 15px rgba(0,0,0,0.8); }
        .login-section { flex: 0 0 420px; padding: 45px 40px; box-sizing: border-box; }
        .bottom-bar { position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); z-index: 10; width: 100%; display: flex; justify-content: center; }
        .bottom-pill { padding: 15px 25px; display: flex; align-items: center; gap: 30px; border-radius: 50px; border: 1px solid rgba(255,255,255,0.15); background: rgba(2, 6, 23, 0.6); }

        /* 📱 MOBILE RESPONSIVE LAYOUT (Magic happens here!) */
        @media (max-width: 850px) {
          .root-container { position: relative; display: block; overflow-y: auto !important; min-height: 100vh; padding-bottom: 150px; }
          .hero-bg, .hero-overlay { position: fixed !important; } /* Keeps background still while scrolling */
          
          .top-header { flex-direction: column; padding: 15px 20px; text-align: center; gap: 10px; }
          .nav-links { display: none !important; } /* Hides menu on mobile to save space */
          
          .main-content { flex-direction: column; padding: 30px 20px; justify-content: flex-start; gap: 40px; }
          .text-section { padding-right: 0; text-align: center; display: flex; flex-direction: column; align-items: center; }
          .main-title { font-size: 40px !important; margin-bottom: 15px; }
          .desc-text { font-size: 14px !important; }
          
          .login-section { width: 100% !important; flex: auto; max-width: 100%; padding: 30px 20px; }
          
          .bottom-bar { position: fixed !important; bottom: 0 !important; left: 0 !important; transform: none !important; padding: 10px; background: rgba(2,6,23,0.95); border-top: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(20px); }
          .bottom-pill { flex-direction: column; gap: 12px; width: 100%; padding: 10px; border: none; background: transparent; border-radius: 0; }
          .pill-buttons { display: flex; width: 100%; gap: 10px; }
          .btn-smart { width: 50%; padding: 12px 10px; font-size: 11px; text-align: center; display: flex; justify-content: center; align-items: center; border-radius: 10px;}
        }
      `}</style>

      {/* Dynamic Background Layer */}
      <div className="hero-bg" style={{ backgroundImage: `url(${webData.bg})` }}></div>
      <div className="hero-overlay"></div>

      {/* TOP NAVBAR */}
      <header className="top-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
           <div style={{ background: 'linear-gradient(135deg, #ea580c, #f97316)', padding: '10px 12px', borderRadius: '12px', fontSize: '24px', boxShadow: '0 0 20px rgba(234,88,12,0.5)' }}>🚛</div>
           <div>
              <h1 style={{ margin: 0, fontSize: '20px', fontWeight: '900', letterSpacing: '1px', color: '#fff' }}>PRASAD TRANSPORT</h1>
              <p style={{ margin: 0, color: '#38bdf8', fontSize: '10px', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase' }}>AI Fleet Command Center</p>
           </div>
        </div>
        
        {/* DYNAMIC MENU LINKS */}
        <div className="nav-links">
          {webData.link1 && <span className="nav-link" style={{ color: '#ea580c' }}>{webData.link1}</span>}
          {webData.link2 && <span className="nav-link">{webData.link2}</span>}
          {webData.link3 && <span className="nav-link">{webData.link3}</span>}
          {webData.link4 && <span className="nav-link">{webData.link4}</span>}
          {webData.link5 && <span className="nav-link">{webData.link5}</span>}
        </div>
      </header>

      {/* MAIN CONTENT AREA */}
      <main className="main-content">

        {/* LEFT SIDE: Dynamic Typography */}
        <div className="text-section">
           <div style={{ display: 'inline-block', background: 'rgba(234, 88, 12, 0.1)', border: '1px solid rgba(234, 88, 12, 0.3)', color: '#ea580c', padding: '8px 20px', borderRadius: '30px', fontSize: '11px', fontWeight: '900', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '20px' }}>
             🚀 THE FUTURE OF FREIGHT
           </div>
           <h1 className="main-title">
             {webData.title1} <br/><span style={{ background: 'linear-gradient(135deg, #38bdf8, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{webData.title2}</span>
           </h1>
           <p className="desc-text">
             {webData.desc}
           </p>
        </div>

        {/* RIGHT SIDE: Smart Login Box */}
        <div className="glass-panel login-section">
          <div style={{ textAlign: 'center', marginBottom: '35px' }}>
            <h2 style={{ margin: '0 0 5px 0', fontSize: '24px', color: '#fff', fontWeight: '900', letterSpacing: '1px' }}>ERP PORTAL</h2>
            <p style={{ margin: 0, color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>Secure System Access</p>
          </div>

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: '20px' }}>
              <input 
                type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="Admin ID / Email" 
                style={{ width: '100%', padding: '16px 20px', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '12px', fontSize: '15px', outline: 'none', transition: '0.3s', boxSizing: 'border-box' }}
                onFocus={e => { e.target.style.borderColor = '#38bdf8'; e.target.style.background = 'rgba(15, 23, 42, 0.9)'; }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; e.target.style.background = 'rgba(15, 23, 42, 0.6)'; }}
              />
            </div>
            <div style={{ marginBottom: '30px' }}>
              <input 
                type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Secure Password" 
                style={{ width: '100%', padding: '16px 20px', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '12px', fontSize: '15px', outline: 'none', transition: '0.3s', boxSizing: 'border-box' }}
                onFocus={e => { e.target.style.borderColor = '#38bdf8'; e.target.style.background = 'rgba(15, 23, 42, 0.9)'; }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; e.target.style.background = 'rgba(15, 23, 42, 0.6)'; }}
              />
            </div>

            <button type="submit" style={{ width: '100%', padding: '16px', background: 'linear-gradient(135deg, #38bdf8, #2563eb)', color: '#fff', border: 'none', borderRadius: '12px', fontSize: '15px', fontWeight: '900', cursor: 'pointer', transition: 'all 0.3s', textTransform: 'uppercase', letterSpacing: '1.5px', boxShadow: '0 10px 25px rgba(56, 189, 248, 0.4)' }} onMouseOver={(e) => e.currentTarget.style.transform = 'translateY(-2px)'} onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(0)'}>
              {loading ? 'Authenticating...' : 'Sign In ➔'}
            </button>
          </form>
          
          <div style={{ textAlign: 'center', marginTop: '25px' }}>
             <span style={{ color: '#10b981', fontSize: '11px', fontWeight: '900', letterSpacing: '1px' }}>🔒 256-BIT ENCRYPTED</span>
          </div>
        </div>
      </main>

      {/* FLOATING BOTTOM ACTION BAR */}
      <div className="bottom-bar">
        <div className="glass-panel bottom-pill">
          <div style={{ color: '#fff', fontSize: '12px', fontWeight: '900', letterSpacing: '1px', textTransform: 'uppercase', textAlign: 'center' }}>
            <span style={{ color: '#94a3b8' }}>Live Network : </span> <span style={{ color: '#10b981', textShadow: '0 0 10px #10b981' }}>🟢 Active</span>
          </div>
          
          <div className="pill-buttons">
            <button onClick={onDriverClick} className="btn-smart">
               🚚 DRIVER APP
            </button>
            <button className="btn-smart" style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 10px 25px rgba(59, 130, 246, 0.4)' }} onClick={() => alert("Tracking module coming soon!")}>
               📍 TRACKING
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}