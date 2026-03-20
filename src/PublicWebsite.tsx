// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { QRCodeSVG } from 'qrcode.react';

export default function PublicWebsite({ onLoginClick }: { onLoginClick?: () => void }) {
  const [data, setData] = useState({
    title1: 'DRIVING', title2: 'PROGRESS.',
    desc: 'AI-driven, highly secured, and automated transportation network moving your business forward 24/7 across the North-East.',
    bgImages: ['https://images.unsplash.com/photo-1511447333015-45b65e60f6d5?q=80&w=2000&auto=format&fit=crop'],
    link1: 'Home', link2: 'Network', link3: 'AI Dispatch', link4: 'About', link5: 'Contact', waNumber: '919876543210',
    stat1: '10,000+', stat1Desc: 'Trips Completed Successfully',
    stat2: '99.9%', stat2Desc: 'On-Time Delivery Rate',
    stat3: '24/7', stat3Desc: 'Live GPS & AI Tracking',
    aboutTitle: 'Legacy Meets Technology.',
    aboutDesc: 'Prasad Transport is not just a logistics company; we are a tech-forward freight ecosystem. With decades of experience, we have now integrated world-class AI and ERP solutions to ensure 100% transparency.'
  });

  const [currentSlide, setCurrentSlide] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const docSnap = await getDoc(doc(db, "WEBSITE", "SETTINGS"));
        if (docSnap.exists()) {
          const dbData = docSnap.data();
          if (typeof dbData.bg === 'string') { dbData.bgImages = [dbData.bg]; }
          setData(prev => ({ ...prev, ...dbData }));
        }
      } catch (error) { console.error("Error loading CMS settings", error); }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    if (data.bgImages && data.bgImages.length > 1) {
      const interval = setInterval(() => { setCurrentSlide(prev => (prev + 1) % data.bgImages.length); }, 5000); 
      return () => clearInterval(interval);
    }
  }, [data.bgImages?.length]);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const element = document.getElementById(id);
    if (element) {
      const yOffset = -80; 
      const y = element.getBoundingClientRect().top + window.pageYOffset + yOffset;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  };

  return (
    <div style={{ backgroundColor: '#020617', color: '#f8fafc', minHeight: '100vh', fontFamily: "'Inter', sans-serif", width: '100%', overflowX: 'hidden' }}>
      
      {/* 🚀 CRITICAL FIX: Overriding React Default Margins to stretch Full Screen */}
      <style>{`
        body, html, #root { margin: 0 !important; padding: 0 !important; width: 100% !important; max-width: 100% !important; overflow-x: hidden; }
        html { scroll-behavior: smooth; }
        .glass-nav { background: ${isScrolled ? 'rgba(2, 6, 23, 0.95)' : 'transparent'}; backdrop-filter: ${isScrolled ? 'blur(20px)' : 'none'}; border-bottom: ${isScrolled ? '1px solid rgba(255,255,255,0.05)' : '1px solid transparent'}; transition: all 0.4s ease; }
        .nav-link { color: white; text-decoration: none; font-size: 13px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; cursor: pointer; transition: 0.3s; padding: 8px 15px; border-radius: 20px; }
        .nav-link:hover { background: rgba(234, 88, 12, 0.1); color: #ea580c; }
        .btn-primary { background: linear-gradient(135deg, #ea580c, #c2410c); color: white; padding: 12px 30px; border-radius: 30px; font-weight: bold; border: none; cursor: pointer; transition: 0.3s; box-shadow: 0 10px 20px rgba(234, 88, 12, 0.3); text-transform: uppercase; letter-spacing: 1px; }
        .btn-primary:hover { transform: translateY(-3px) scale(1.02); box-shadow: 0 15px 25px rgba(234, 88, 12, 0.5); }
        .glass-card { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255,255,255,0.05); border-radius: 24px; padding: 40px; backdrop-filter: blur(20px); transition: 0.4s; position: relative; overflow: hidden; }
        .glass-card:hover { transform: translateY(-10px); border-color: rgba(234, 88, 12, 0.3); box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
        .mobile-menu { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.98); backdrop-filter: blur(20px); z-index: 999; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; transition: 0.4s cubic-bezier(0.4, 0, 0.2, 1); transform: ${mobileMenuOpen ? 'translateX(0)' : 'translateX(100%)'}; }
        
        /* Mobile Specific Fixes */
        @media (max-width: 768px) {
          .desktop-nav { display: none !important; }
          .mobile-toggle { display: block !important; }
          .hero-title { font-size: 50px !important; }
          .hero-desc { font-size: 15px !important; width: 100% !important; }
          .section-grid { grid-template-columns: 1fr !important; }
          .hero-content { padding-top: 80px !important; text-align: center; align-items: center; }
          .section-padding { padding: 60px 20px !important; }
        }
      `}</style>

      <nav className="glass-nav" style={{ position: 'fixed', top: 0, left: 0, width: '100%', zIndex: 100, padding: '15px 5%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
          <div onClick={() => scrollToSection('home')} style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
            <div style={{ background: 'linear-gradient(135deg, #ea580c, #f97316)', padding: '10px', borderRadius: '12px', fontSize: '20px', boxShadow: '0 5px 15px rgba(234,88,12,0.4)' }}>🚛</div>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: '900', letterSpacing: '1px' }}>PRASAD <span style={{color:'#ea580c'}}>PRO</span></h1>
          </div>
          <div className="desktop-nav" style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {data.link1 && <span className="nav-link" onClick={() => scrollToSection('home')}>{data.link1}</span>}
            {data.link2 && <span className="nav-link" onClick={() => scrollToSection('network')}>{data.link2}</span>}
            {data.link3 && <span className="nav-link" onClick={() => scrollToSection('ai-dispatch')}>{data.link3}</span>}
            {data.link4 && <span className="nav-link" onClick={() => scrollToSection('about')}>{data.link4}</span>}
            {data.link5 && <span className="nav-link" onClick={() => scrollToSection('contact')}>{data.link5}</span>}
            <button className="btn-primary" style={{ marginLeft: '15px' }} onClick={onLoginClick}>Sign In ERP ➔</button>
          </div>
          <div className="mobile-toggle" style={{ display: 'none', cursor: 'pointer', zIndex: 1000 }} onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            <div style={{ fontSize: '30px', color: 'white' }}>{mobileMenuOpen ? '✖' : '☰'}</div>
          </div>
        </div>
      </nav>

      <div className="mobile-menu">
        <div style={{ position: 'absolute', top: '20px', right: '30px', fontSize: '40px', cursor: 'pointer' }} onClick={() => setMobileMenuOpen(false)}>✖</div>
        <h2 style={{ color: '#ea580c', marginBottom: '20px', letterSpacing: '2px', fontSize: '14px' }}>NAVIGATION</h2>
        {data.link1 && <h1 onClick={() => scrollToSection('home')} style={{ margin:0, cursor:'pointer', fontSize:'30px' }}>{data.link1}</h1>}
        {data.link2 && <h1 onClick={() => scrollToSection('network')} style={{ margin:0, cursor:'pointer', fontSize:'30px' }}>{data.link2}</h1>}
        {data.link3 && <h1 onClick={() => scrollToSection('ai-dispatch')} style={{ margin:0, cursor:'pointer', fontSize:'30px' }}>{data.link3}</h1>}
        {data.link4 && <h1 onClick={() => scrollToSection('about')} style={{ margin:0, cursor:'pointer', fontSize:'30px' }}>{data.link4}</h1>}
        {data.link5 && <h1 onClick={() => scrollToSection('contact')} style={{ margin:0, cursor:'pointer', fontSize:'30px' }}>{data.link5}</h1>}
        <button className="btn-primary" onClick={onLoginClick} style={{ marginTop: '30px', fontSize: '18px', padding: '15px 40px' }}>Sign In ERP ➔</button>
      </div>

      <section id="home" style={{ position: 'relative', height: '100vh', width: '100%', display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
        {data.bgImages && data.bgImages.map((img, i) => (
            <div key={i} style={{ position: 'absolute', inset: 0, backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center', zIndex: 1, opacity: currentSlide === i ? 1 : 0, transform: currentSlide === i ? 'scale(1.05)' : 'scale(1)', transition: 'opacity 1.5s ease-in-out, transform 6s linear' }}></div>
        ))}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(2,6,23,0.95) 0%, rgba(2,6,23,0.7) 40%, rgba(2,6,23,0.2) 100%)', zIndex: 2 }}></div>
        <div className="hero-content" style={{ position: 'relative', zIndex: 3, maxWidth: '1400px', width: '100%', margin: '0 auto', padding: '0 5%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <div style={{ background: 'rgba(234, 88, 12, 0.1)', border: '1px solid rgba(234, 88, 12, 0.3)', color: '#ea580c', padding: '8px 20px', borderRadius: '30px', fontSize: '12px', fontWeight: '900', letterSpacing: '2px', marginBottom: '25px', display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(5px)' }}>
            <span style={{ width:'8px', height:'8px', background:'#ea580c', borderRadius:'50%', display:'inline-block', boxShadow:'0 0 10px #ea580c', animation: 'pulse 2s infinite' }}></span> NEXT-GEN LOGISTICS 2026
          </div>
          <h1 className="hero-title" style={{ fontSize: '85px', margin: '0 0 20px 0', color: '#fff', fontWeight: '900', lineHeight: '1.05', textTransform: 'uppercase' }}>
            {data.title1} <br/><span style={{ background: 'linear-gradient(135deg, #ea580c, #f59e0b)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{data.title2}</span>
          </h1>
          <p className="hero-desc" style={{ color: '#cbd5e1', fontSize: '18px', lineHeight: '1.6', maxWidth: '650px', marginBottom: '40px' }}>{data.desc}</p>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={onLoginClick}>Access Portal ➔</button>
            <button onClick={() => scrollToSection('ai-dispatch')} style={{ background: 'rgba(255,255,255,0.05)', color: 'white', padding: '12px 30px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '30px', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s', backdropFilter: 'blur(5px)' }}>Explore AI Tech</button>
          </div>
        </div>
      </section>

      <section id="network" className="section-padding" style={{ padding: '120px 5%', maxWidth: '1400px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ textAlign: 'center', marginBottom: '80px' }}>
          <div style={{ color: '#38bdf8', fontWeight: 'bold', letterSpacing: '2px', fontSize: '14px', marginBottom: '10px' }}>OUR REACH</div>
          <h2 style={{ fontSize: '45px', margin: 0 }}>Unmatched <span style={{color:'#ea580c'}}>Network Scale</span></h2>
        </div>
        <div className="section-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '40px' }}>
          {[
            { title: data.stat1 || '10,000+', desc: data.stat1Desc || 'Trips Completed', icon: '🛣️' },
            { title: data.stat2 || '99.9%', desc: data.stat2Desc || 'On-Time Delivery', icon: '⏱️' },
            { title: data.stat3 || '24/7', desc: data.stat3Desc || 'Live Tracking', icon: '🛰️' }
          ].map((stat, idx) => (
            <div key={idx} className="glass-card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '50px', marginBottom: '20px' }}>{stat.icon}</div>
              <h3 style={{ fontSize: '40px', margin: '0 0 10px 0', color: '#ea580c', fontWeight: '900' }}>{stat.title}</h3>
              <p style={{ color: '#cbd5e1', margin: 0, fontSize: '15px' }}>{stat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="ai-dispatch" className="section-padding" style={{ padding: '120px 5%', background: 'linear-gradient(to bottom, transparent, #0f172a, transparent)', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '60px', alignItems: 'center' }} className="section-grid">
          <div>
            <div style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '8px 20px', borderRadius: '30px', display: 'inline-block', fontSize: '12px', fontWeight: 'bold', marginBottom: '25px', border: '1px solid rgba(16,185,129,0.3)' }}>🤖 POWERED BY MAMTA AI</div>
            <h2 style={{ fontSize: '45px', margin: '0 0 25px 0', lineHeight: 1.1 }}>Smart Automations. <br/><span style={{color:'#38bdf8'}}>Zero Human Error.</span></h2>
            <p style={{ color: '#cbd5e1', fontSize: '18px', lineHeight: 1.6, marginBottom: '30px' }}>Say goodbye to manual calls. Our proprietary <b>Mamta AI</b> engine handles driver dispatch, customer updates, and advance payments directly via WhatsApp in real-time.</p>
          </div>
          <div className="glass-card" style={{ padding: '30px', border: '1px solid #38bdf8', boxShadow: '0 20px 60px rgba(56, 189, 248, 0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '20px', marginBottom: '25px' }}>
              <div style={{ width: '50px', height: '50px', background: 'linear-gradient(135deg, #38bdf8, #818cf8)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '900', color: '#0f172a', fontSize: '18px' }}>AI</div>
              <div><h4 style={{ margin: 0, fontSize: '18px' }}>Mamta AI </h4><span style={{ fontSize: '12px', color: '#10b981', fontWeight: 'bold' }}>● System Online</span></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ background: '#1e293b', padding: '15px 20px', borderRadius: '20px 20px 20px 0', width: '85%', color: '#f8fafc', fontSize: '14px', lineHeight: '1.5' }}>Trip TRP-9021 started from Lumding. Advance ₹15,000 transferred. 🚛</div>
              <div style={{ background: 'linear-gradient(135deg, #10b981, #059669)', padding: '15px 20px', borderRadius: '20px 20px 0 20px', width: '75%', alignSelf: 'flex-end', color: '#fff', fontSize: '14px', fontWeight: 'bold', boxShadow: '0 5px 15px rgba(16,185,129,0.3)' }}>Live GPS link sent to Customer. ✅</div>
            </div>
          </div>
        </div>
      </section>

      <section id="about" className="section-padding" style={{ padding: '120px 5%', maxWidth: '1400px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <div className="section-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '60px', alignItems: 'center' }}>
          <div style={{ borderRadius: '30px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 30px 60px rgba(0,0,0,0.5)' }}>
            <img src="https://images.unsplash.com/photo-1580674684081-77673ce42c85?q=80&w=1000&auto=format&fit=crop" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} alt="Logistics" />
          </div>
          <div>
            <div style={{ color: '#ea580c', fontWeight: 'bold', letterSpacing: '2px', fontSize: '14px', marginBottom: '10px' }}>WHO WE ARE</div>
            <h2 style={{ fontSize: '40px', margin: '0 0 25px 0' }}>{data.aboutTitle}</h2>
            <p style={{ color: '#cbd5e1', fontSize: '16px', lineHeight: 1.8, marginBottom: '20px', whiteSpace: 'pre-wrap' }}>{data.aboutDesc}</p>
          </div>
        </div>
      </section>

      <section id="contact" className="section-padding" style={{ padding: '120px 5%', maxWidth: '1400px', margin: '0 auto', textAlign: 'center', width: '100%', boxSizing: 'border-box' }}>
        <h2 style={{ fontSize: '50px', marginBottom: '20px', fontWeight: '900' }}>Ready to move with <span style={{color:'#ea580c'}}>Prasad?</span></h2>
        <p style={{ color: '#94a3b8', fontSize: '18px', marginBottom: '60px' }}>Scan the QR code to chat with our AI Engine instantly.</p>
        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8))', padding: '50px', borderRadius: '40px', border: '1px solid rgba(56,189,248,0.2)', backdropFilter: 'blur(20px)', boxShadow: '0 30px 60px rgba(0,0,0,0.5)' }}>
          <div style={{ padding: '20px', background: 'white', borderRadius: '24px', boxShadow: '0 0 40px rgba(56, 189, 248, 0.2)' }}>
            <QRCodeSVG value={`https://wa.me/${data.waNumber}?text=Hi%20Prasad%20Transport,%20I%20want%20to%20connect.`} size={220} />
          </div>
          <h3 style={{ margin: '30px 0 10px 0', fontSize: '24px' }}>Scan to WhatsApp</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#10b981', fontWeight: 'bold', fontSize: '14px', background: 'rgba(16,185,129,0.1)', padding: '8px 20px', borderRadius: '30px' }}>
            <span style={{ width: '8px', height: '8px', background: '#10b981', borderRadius: '50%', display: 'inline-block' }}></span> 24/7 Automated AI Support
          </div>
        </div>
      </section>

      <footer style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: '#020617', padding: '40px 5%', textAlign: 'center', color: '#64748b', fontSize: '14px' }}>
        © 2026 Prasad Transport. Engineered with Advance ERP & Mamta AI.
      </footer>
    </div>
  );
}