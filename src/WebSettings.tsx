// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export default function WebSettings() {
  const defaultData = {
    title1: 'DRIVING',
    title2: 'PROGRESS.',
    desc: 'AI-driven, highly secured, and automated transportation network moving your business forward 24/7 across the North-East.',
    bgImages: ['https://images.unsplash.com/photo-1511447333015-45b65e60f6d5?q=80&w=2000&auto=format&fit=crop'],
    link1: 'Home', link2: 'Network', link3: 'AI Dispatch', link4: 'About', link5: 'Contact',
    waNumber: '919876543210',
    stat1: '10,000+', stat1Desc: 'Trips Completed Successfully',
    stat2: '99.9%', stat2Desc: 'On-Time Delivery Rate',
    stat3: '24/7', stat3Desc: 'Live GPS & AI Tracking',
    aboutTitle: 'Legacy Meets Technology.',
    aboutDesc: 'Prasad Transport is not just a logistics company; we are a tech-forward freight ecosystem. With decades of experience, we have now integrated world-class AI and ERP solutions to ensure 100% transparency.'
  };

  const [data, setData] = useState(defaultData);
  const [loading, setLoading] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const docSnap = await getDoc(doc(db, "WEBSITE", "SETTINGS"));
        if (docSnap.exists()) {
            const dbData = docSnap.data();
            if(typeof dbData.bg === 'string') { dbData.bgImages = [dbData.bg]; delete dbData.bg; }
            setData({ ...defaultData, ...dbData });
        }
      } catch (error) { console.error("Error loading settings", error); }
    };
    loadSettings();
  }, []);

  useEffect(() => {
      if(data.bgImages.length <= 1) return;
      const interval = setInterval(() => { setCurrentSlide((prev) => (prev + 1) % data.bgImages.length); }, 4000); 
      return () => clearInterval(interval);
  }, [data.bgImages]);

  const handleImageUpload = (e: any) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      if(data.bgImages.length + files.length > 5) return alert("⚠️ आप अधिकतम 5 फोटो ही लगा सकते हैं!");
      const newImages = [...data.bgImages];
      files.forEach((file: any) => {
          if (file.size > 2000000) return alert(`⚠️ ${file.name} का साइज बहुत बड़ा है। कृपया 2MB से कम की फोटो डालें।`);
          const reader = new FileReader();
          reader.onloadend = () => { newImages.push(reader.result as string); setData({ ...data, bgImages: newImages }); };
          reader.readAsDataURL(file);
      });
    }
  };

  const removeImage = (index: number) => {
    const filtered = data.bgImages.filter((_, i) => i !== index);
    setData({ ...data, bgImages: filtered });
    if(currentSlide >= filtered.length) setCurrentSlide(0);
  };

  const clearLink = (linkKey: string) => { setData({ ...data, [linkKey]: '' }); };

  const saveSettings = async () => {
    setLoading(true);
    try { await setDoc(doc(db, "WEBSITE", "SETTINGS"), data); alert("✅ वेबसाइट की सेटिंग्स सफलतापूर्वक लाइव कर दी गई हैं!"); } 
    catch (error) { alert("❌ सेटिंग्स सेव करने में समस्या आ रही है।"); }
    setLoading(false);
  };

  const restoreDefaults = async () => {
    if (window.confirm("⚠️ क्या आप सच में पुरानी (डिफ़ॉल्ट) सेटिंग्स वापस लाना चाहते हैं?")) {
      setData(defaultData);
      try { await setDoc(doc(db, "WEBSITE", "SETTINGS"), defaultData); alert("✅ डिफ़ॉल्ट सेटिंग्स वापस आ गई हैं!"); } 
      catch (e) { alert("❌ डिफ़ॉल्ट करने में समस्या आई।"); }
    }
  };

  const inputStyle = { width: '100%', padding: '12px', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid #334155', color: '#fff', borderRadius: '8px', marginBottom: '15px', marginTop: '5px', boxSizing: 'border-box' as 'border-box', outline: 'none' };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 15px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 15px 25px; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 15px; margin-top: 20px;}
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900' }}>🌐 वेबसाइट कंट्रोल रूम (CMS)</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0', fontSize: '14px' }}>पूरा कंट्रोल: अपनी लाइव वेबसाइट का टेक्स्ट और फोटो यहीं से बदलें।</p>
        </div>
        <button onClick={restoreDefaults} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>🔄 पुरानी सेटिंग्स वापस लाएं</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(500px, 1fr))', gap: '30px' }}>
        
        {/* LEFT PANEL: CMS FORM */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* 1. HERO SECTION */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #38bdf8' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#38bdf8' }}>📝 1. मुख्य स्क्रीन (Home Page)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div><label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>मुख्य शीर्षक (सफ़ेद रंग)</label><input type="text" value={data.title1} onChange={e => setData({...data, title1: e.target.value})} style={inputStyle} /></div>
              <div><label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>हाइलाइट शीर्षक (नारंगी रंग)</label><input type="text" value={data.title2} onChange={e => setData({...data, title2: e.target.value})} style={inputStyle} /></div>
            </div>
            <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>कम्पनी का विवरण (Description)</label>
            <textarea value={data.desc} onChange={e => setData({...data, desc: e.target.value})} rows={3} style={{...inputStyle, resize: 'none'}} />

            <div style={{ marginTop: '15px', padding:'15px', background:'rgba(255,255,255,0.05)', borderRadius:'10px' }}>
              <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>📸 बैकग्राउंड फोटो (अधिकतम 5)</label>
              <input type="file" multiple accept="image/*" onChange={handleImageUpload} style={{ width: '100%', padding: '10px', color: '#fff', borderRadius: '8px', marginBottom: '15px', border: '1px dashed #475569', marginTop: '10px' }} />
              <div style={{display:'flex', gap:'10px', overflowX:'auto'}}>
                  {data.bgImages.map((img, i) => (
                      <div key={i} style={{position:'relative', minWidth:'80px', height:'60px', borderRadius:'5px', overflow:'hidden', border: currentSlide === i ? '2px solid #38bdf8' : '2px solid transparent'}}>
                          <img src={img} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="slider" />
                          <button onClick={()=>removeImage(i)} style={{position:'absolute', top:2, right:2, background:'rgba(239,68,68,0.8)', border:'none', color:'white', borderRadius:'50%', width:'20px', height:'20px', cursor:'pointer', fontSize:'10px'}}>X</button>
                      </div>
                  ))}
              </div>
            </div>
          </div>

          {/* 2. NETWORK STATS */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #8b5cf6' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#8b5cf6' }}>📈 2. कम्पनी के आँकड़े (Stats)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '10px' }}>
              <input type="text" value={data.stat1} onChange={e => setData({...data, stat1: e.target.value})} style={inputStyle} placeholder="जैसे: 10,000+" />
              <input type="text" value={data.stat1Desc} onChange={e => setData({...data, stat1Desc: e.target.value})} style={inputStyle} placeholder="ट्रिप्स पूरी कीं" />
              
              <input type="text" value={data.stat2} onChange={e => setData({...data, stat2: e.target.value})} style={inputStyle} placeholder="जैसे: 99.9%" />
              <input type="text" value={data.stat2Desc} onChange={e => setData({...data, stat2Desc: e.target.value})} style={inputStyle} placeholder="समय पर डिलीवरी" />
              
              <input type="text" value={data.stat3} onChange={e => setData({...data, stat3: e.target.value})} style={inputStyle} placeholder="जैसे: 24/7" />
              <input type="text" value={data.stat3Desc} onChange={e => setData({...data, stat3Desc: e.target.value})} style={inputStyle} placeholder="लाइव ट्रैकिंग" />
            </div>
          </div>

          {/* 3. ABOUT US */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #ec4899' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#ec4899' }}>🏢 3. हमारे बारे में (About Us)</h3>
            <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>About का टाइटल</label>
            <input type="text" value={data.aboutTitle} onChange={e => setData({...data, aboutTitle: e.target.value})} style={inputStyle} />
            <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>कम्पनी का इतिहास (About Description)</label>
            <textarea value={data.aboutDesc} onChange={e => setData({...data, aboutDesc: e.target.value})} rows={4} style={{...inputStyle, resize: 'none'}} />
          </div>

          {/* 4. CONTACT & WHATSAPP */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #10b981' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#10b981' }}>📱 4. संपर्क और WhatsApp नंबर</h3>
            <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>WhatsApp नंबर (Format: 9198XXXXXXXX)</label>
            <input type="text" value={data.waNumber} onChange={e => setData({...data, waNumber: e.target.value})} style={inputStyle} placeholder="919876543210" />
          </div>

          {/* 5. NAVBAR */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #f59e0b' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#f59e0b' }}>🔗 5. मेनू बटन के नाम (Navbar)</h3>
            {[1, 2, 3, 4, 5].map((num) => {
              const key = `link${num}`;
              return (
                <div key={num} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ width: '30px', color: '#94a3b8', fontWeight: 'bold', fontSize: '12px' }}>0{num}.</div>
                  <input type="text" value={data[key as keyof typeof data]} onChange={e => setData({...data, [key]: e.target.value})} style={{ ...inputStyle, marginBottom: 0, marginTop: 0 }} />
                  <button onClick={() => clearLink(key)} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: 'none', borderRadius: '8px', padding: '12px', cursor: 'pointer' }}>🗑️</button>
                </div>
              );
            })}
          </div>

          <button className="glow-btn" onClick={saveSettings} disabled={loading}>{loading ? '⏳ सेव हो रहा है...' : '💾 लाइव वेबसाइट पर सेव करें'}</button>
        </div>

        {/* RIGHT PANEL: LIVE PREVIEW */}
        <div style={{ position: 'sticky', top: '20px', alignSelf: 'start' }}>
          <h3 style={{ color: '#fff', margin: '0 0 15px 0' }}>👁️ लाइव वेबसाइट प्रीव्यू</h3>
          <div style={{ width: '100%', height: '70vh', borderRadius: '24px', overflow: 'hidden', position: 'relative', border: '4px solid #1e293b', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            {data.bgImages.map((img, i) => (
                <div key={i} style={{ position: 'absolute', inset: 0, backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center', zIndex: 1, opacity: currentSlide === i ? 1 : 0, transition: 'opacity 1s ease-in-out' }}></div>
            ))}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(2,6,23,0.98) 0%, rgba(2,6,23,0.7) 40%, rgba(2,6,23,0.2) 100%)', zIndex: 2 }}></div>
            <div style={{ position: 'relative', zIndex: 3, padding: '20px', height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '15px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ background: 'linear-gradient(135deg, #ea580c, #f97316)', padding: '6px', borderRadius: '8px', fontSize: '12px' }}>🚛</div>
                  <h1 style={{ margin: 0, fontSize: '14px', fontWeight: '900', color: '#fff' }}>PRASAD <span style={{color:'#ea580c'}}>PRO</span></h1>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', paddingLeft: '10px' }}>
                <h1 style={{ fontSize: '38px', margin: '0 0 10px 0', color: '#fff', fontWeight: '900', lineHeight: '1.05' }}>{data.title1} <br/><span style={{ color: '#ea580c' }}>{data.title2}</span></h1>
                <p style={{ color: '#cbd5e1', fontSize: '10px', lineHeight: '1.6', maxWidth: '85%' }}>{data.desc}</p>
                <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.1)', padding: '10px', borderRadius: '10px', backdropFilter: 'blur(5px)' }}><h4 style={{margin:0, color:'#ea580c', fontSize:'12px'}}>{data.stat1}</h4><span style={{fontSize:'8px', color:'#cbd5e1'}}>{data.stat1Desc}</span></div>
                  <div style={{ background: 'rgba(255,255,255,0.1)', padding: '10px', borderRadius: '10px', backdropFilter: 'blur(5px)' }}><h4 style={{margin:0, color:'#ea580c', fontSize:'12px'}}>{data.stat2}</h4><span style={{fontSize:'8px', color:'#cbd5e1'}}>{data.stat2Desc}</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}