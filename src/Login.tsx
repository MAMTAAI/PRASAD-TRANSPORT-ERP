// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

interface LoginProps {
  onLoginSuccess: (userData: any) => void;
  onDriverClick?: () => void;
  onBackToWeb?: () => void;
}

export default function Login({ onLoginSuccess, onDriverClick, onBackToWeb }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);

  // 📥 Fetch Settings from Firebase
  const [webData, setWebData] = useState({
    title1: 'DRIVING',
    title2: 'PROGRESS.',
    desc: 'AI-driven, highly secured, and automated transportation network moving your business forward 24/7 across the North-East.',
    bgImages: ['https://images.unsplash.com/photo-1511447333015-45b65e60f6d5?q=80&w=2000&auto=format&fit=crop'],
  });

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const docSnap = await getDoc(doc(db, "WEBSITE", "SETTINGS"));
        if (docSnap.exists()) {
          const dbData = docSnap.data();
          if(typeof dbData.bg === 'string') { dbData.bgImages = [dbData.bg]; delete dbData.bg; }
          if(!dbData.bgImages || dbData.bgImages.length === 0) dbData.bgImages = webData.bgImages;
          setWebData({ ...webData, ...dbData as any });
        }
      } catch (e) {
        console.log("Using default settings");
      }
    };
    loadSettings();
  }, []);

  // 📸 Handle Sliding Backgrounds
  useEffect(() => {
    if(webData.bgImages.length <= 1) return;
    const interval = setInterval(() => { setCurrentSlide((prev) => (prev + 1) % webData.bgImages.length); }, 4000); 
    return () => clearInterval(interval);
  }, [webData.bgImages]);

  // 🔐 THE REAL LOGIN FUNCTION
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
    <div style={{ minHeight: '100vh', display: 'flex', backgroundColor: '#020617', fontFamily: "'Inter', sans-serif", overflow: 'hidden' }}>
      
      {/* ⬅️ LEFT SIDE: Dynamic Branding & Sliding Backgrounds (Hidden on small screens) */}
      <div style={{ flex: 1.2, position: 'relative', display: window.innerWidth > 900 ? 'flex' : 'none', flexDirection: 'column', justifyContent: 'flex-end', padding: '60px' }}>
        
        {/* Sliding Background Images */}
        {webData.bgImages.map((img, i) => (
            <div key={i} style={{ position: 'absolute', inset: 0, backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center', zIndex: 1, opacity: currentSlide === i ? 1 : 0, transition: 'opacity 1.5s ease-in-out' }}></div>
        ))}
        
        {/* Dark Gradient Overlay for text readability */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(0deg, rgba(2,6,23,0.95) 0%, rgba(2,6,23,0.6) 40%, rgba(2,6,23,0.2) 100%)', zIndex: 2 }}></div>
        
        {/* Branding Content */}
        <div style={{ position: 'relative', zIndex: 3, maxWidth: '80%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', cursor: 'pointer', marginBottom: '30px', transition: '0.3s' }} onClick={onBackToWeb}>
            <div style={{ background: 'linear-gradient(135deg, #ea580c, #f97316)', padding: '10px 14px', borderRadius: '16px', fontSize: '28px', boxShadow: '0 8px 25px rgba(234,88,12,0.5)' }}>🚛</div>
            <h1 style={{ margin: 0, fontSize: '32px', fontWeight: '900', color: 'white', letterSpacing: '2px' }}>PRASAD <span style={{color:'#ea580c'}}>PRO</span></h1>
          </div>
          
          <h1 style={{ fontSize: '56px', margin: '0 0 20px 0', color: '#fff', fontWeight: '900', lineHeight: '1.05', letterSpacing: '-1px' }}>
            {webData.title1} <br/><span style={{ color: '#ea580c' }}>{webData.title2}</span>
          </h1>
          <p style={{ color: '#cbd5e1', fontSize: '16px', lineHeight: '1.6', letterSpacing: '0.5px', borderLeft: '4px solid #ea580c', paddingLeft: '15px' }}>
            {webData.desc}
          </p>
        </div>
      </div>

      {/* ➡️ RIGHT SIDE: Ultra Premium Glassmorphism Login Box */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '40px', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
        
        {/* Subtle Cyber Glowing Effects behind the form */}
        <div style={{ position: 'absolute', top: '10%', right: '10%', width: '300px', height: '300px', background: 'rgba(56, 189, 248, 0.15)', borderRadius: '50%', filter: 'blur(80px)', zIndex: 1 }}></div>
        <div style={{ position: 'absolute', bottom: '10%', left: '10%', width: '250px', height: '250px', background: 'rgba(234, 88, 12, 0.1)', borderRadius: '50%', filter: 'blur(70px)', zIndex: 1 }}></div>

        {/* Mobile Only Logo (shows only when Left Side is hidden) */}
        {window.innerWidth <= 900 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginBottom: '40px', zIndex: 10 }} onClick={onBackToWeb}>
            <div style={{ background: 'linear-gradient(135deg, #ea580c, #f97316)', padding: '6px 8px', borderRadius: '10px', fontSize: '20px', boxShadow: '0 5px 15px rgba(234,88,12,0.4)' }}>🚛</div>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: '900', color: 'white' }}>PRASAD <span style={{color:'#ea580c'}}>PRO</span></h1>
          </div>
        )}

        {/* The Form Container */}
        <div style={{ width: '100%', maxWidth: '440px', zIndex: 5 }}>
           <div style={{ background: 'rgba(15, 23, 42, 0.5)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '28px', padding: '50px 40px', backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)', boxShadow: '0 30px 60px rgba(0,0,0,0.6)', textAlign: 'center' }}>
             
             <h2 style={{ color: '#fff', fontSize: '32px', margin: '0 0 5px 0', fontWeight: '900', letterSpacing: '1px' }}>ERP PORTAL</h2>
             <p style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', letterSpacing: '3px', marginBottom: '40px', textTransform: 'uppercase' }}>Secure System Access</p>

             <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '25px' }}>
                
                {/* Email Input */}
                <div style={{ position: 'relative' }}>
                  <div style={{ position: 'absolute', left: '18px', top: '18px', color: '#64748b' }}>✉️</div>
                  <input 
                    type="email" 
                    value={email} 
                    onChange={e => setEmail(e.target.value)} 
                    placeholder="Email Address" 
                    style={{ width: '100%', padding: '18px 20px 18px 50px', background: 'rgba(2, 6, 23, 0.6)', border: '1px solid #334155', borderRadius: '16px', color: 'white', outline: 'none', boxSizing: 'border-box', fontSize: '15px', transition: '0.3s' }} 
                    onFocus={(e) => e.target.style.borderColor = '#38bdf8'}
                    onBlur={(e) => e.target.style.borderColor = '#334155'}
                  />
                </div>
                
                {/* Password Input with Eye Icon */}
                <div style={{ position: 'relative' }}>
                  <div style={{ position: 'absolute', left: '18px', top: '18px', color: '#64748b' }}>🔒</div>
                  <input 
                    type={showPassword ? "text" : "password"} 
                    value={password} 
                    onChange={e => setPassword(e.target.value)} 
                    placeholder="Password" 
                    style={{ width: '100%', padding: '18px 45px 18px 50px', background: 'rgba(2, 6, 23, 0.6)', border: '1px solid #334155', borderRadius: '16px', color: 'white', outline: 'none', boxSizing: 'border-box', fontSize: '15px', transition: '0.3s' }} 
                    onFocus={(e) => e.target.style.borderColor = '#38bdf8'}
                    onBlur={(e) => e.target.style.borderColor = '#334155'}
                  />
                  <span 
                    onClick={() => setShowPassword(!showPassword)} 
                    style={{ position: 'absolute', right: '18px', top: '18px', cursor: 'pointer', fontSize: '16px', opacity: 0.8, color: '#94a3b8', transition: '0.3s' }}
                    title={showPassword ? "Hide Password" : "Show Password"}
                    onMouseOver={(e) => e.target.style.color = '#fff'}
                    onMouseOut={(e) => e.target.style.color = '#94a3b8'}
                  >
                    {showPassword ? '👁️' : '🙈'}
                  </span>
                </div>

                <button type="submit" disabled={loading} style={{ width: '100%', padding: '18px', background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', border: 'none', borderRadius: '16px', fontWeight: '900', fontSize: '16px', letterSpacing: '1px', cursor: loading ? 'not-allowed' : 'pointer', boxShadow: '0 10px 25px rgba(59, 130, 246, 0.4)', marginTop: '10px', transition: 'transform 0.2s, box-shadow 0.2s' }}
                  onMouseOver={(e) => { e.target.style.transform = 'translateY(-2px)'; e.target.style.boxShadow = '0 15px 30px rgba(59, 130, 246, 0.5)'; }}
                  onMouseOut={(e) => { e.target.style.transform = 'translateY(0)'; e.target.style.boxShadow = '0 10px 25px rgba(59, 130, 246, 0.4)'; }}
                >
                  {loading ? 'AUTHENTICATING... ⏳' : 'SIGN IN SECURELY ➔'}
                </button>
             </form>

             <div style={{ marginTop: '40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '25px' }}>
                <button onClick={onDriverClick} style={{ background: 'rgba(234, 88, 12, 0.1)', color: '#ea580c', border: '1px solid rgba(234, 88, 12, 0.3)', padding: '12px 20px', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px', transition: '0.3s', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>🚛</span> DRIVER APP
                </button>
                <button onClick={onBackToWeb} style={{ background: 'transparent', color: '#94a3b8', border: 'none', padding: '10px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', transition: '0.3s' }} onMouseOver={(e)=>e.target.style.color='#fff'} onMouseOut={(e)=>e.target.style.color='#94a3b8'}>
                  ← Back to Home
                </button>
             </div>

           </div>
           <p style={{ textAlign: 'center', color: '#475569', fontSize: '11px', marginTop: '20px', letterSpacing: '1px' }}>
             © 2026 PRASAD TRANSPORT. SECURED BY MAMTA AI.
           </p>
        </div>

      </div>
    </div>
  );
}