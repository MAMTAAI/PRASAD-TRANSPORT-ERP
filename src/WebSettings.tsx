// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from './firebase';

export default function WebSettings() {
  // 🌟 वेबसाइट का पूरा डिफ़ॉल्ट डेटा (ALL WEBSITE FIELDS)
  const defaultData = {
    // 1. Hero Section
    heroBadge: "India's #1 B2B Transport Ecosystem",
    title1: 'A New Era of',
    title2: 'Logistics & Trust.',
    desc: 'Welcome to Prasad Transport ERP. Experience the power of Live Bidding, 100% Secure Escrow Payments, and AI-Verified Fleets.',
    bgImages: [
      "https://images.unsplash.com/photo-1519003722824-194d4455a60c?q=80&w=2000&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1586528116311-ad8ed7c1590f?q=80&w=2000&auto=format&fit=crop"
    ],
    
    // 2. About Us Section
    aboutBadge: 'Our Heritage & Mission',
    aboutTitle: 'Legacy of Trust. Future of Logistics.',
    aboutDesc1: "For years, Prasad Transport has been the undisputed backbone of logistics in the region. We have proudly partnered with industry giants like IOCL, BPCL, and HPCL...",
    aboutVisionTitle: 'Our Super-App Vision',
    aboutVisionDesc: 'We are transforming traditional transport into a 100% transparent, AI-driven ecosystem. Eliminating middlemen ensures customers get the best rates...',

    // 3. Fleet Section (DYNAMIC ARRAY)
    fleetBadge: 'Unmatched Capacity',
    fleetTitle: 'Vehicles We Operate',
    fleetDesc: 'From highly volatile Oil & Gas to heavy industrial cargo, our AI-dispatched network covers every need.',
    fleetCards: [
      { id: 1, icon: '🛢️', title: 'Oil & Gas Tankers', desc: 'Highly secured tankers trusted by IOCL, BPCL & HPCL.', capacities: '20 KL, 24 KL, 34 KL' },
      { id: 2, icon: '🏗️', title: 'Open Trucks & Trailers', desc: 'Heavy-duty flatbeds for machinery, steel, and bulk goods.', capacities: '9 MT, 15 MT, 21 MT, 25+ MT' },
      { id: 3, icon: '📦', title: 'Closed Containers', desc: 'Weather-proof, for FMCG, electronics, and textiles.', capacities: '20 Ft, 32 Ft SXL, 32 Ft MXL' }
    ],

    // 4. Contact & Footer
    contactBadge: '24/7 Priority Support',
    contactTitle: 'Get In Touch',
    email1: 'info@prasadtransport.com',
    email2: 'support@prasadtransport.com',
    address: 'Bongaigaon, Assam, India',
    waNumber: '919999999999',
    waMessage: 'Hello Prasad Transport, I want to join your network.',
    footerText: '© 2026 PRASAD TRANSPORT ERP. SECURED BY MAMTA AI.'
  };

  const [data, setData] = useState(defaultData);
  const [loading, setLoading] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);

  // Load Settings from Firebase
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const docSnap = await getDoc(doc(db, "WEBSITE", "SETTINGS"));
        if (docSnap.exists()) {
            const dbData = docSnap.data();
            if(typeof dbData.bg === 'string') { dbData.bgImages = [dbData.bg]; delete dbData.bg; }
            setData({ ...defaultData, ...dbData }); // Merge with defaults
        }
      } catch (error) { console.error("Error loading settings", error); }
    };
    loadSettings();
  }, []);

  // Slider Animation for Preview
  useEffect(() => {
      if(data.bgImages.length <= 1) return;
      const interval = setInterval(() => { setCurrentSlide((prev) => (prev + 1) % data.bgImages.length); }, 4000); 
      return () => clearInterval(interval);
  }, [data.bgImages]);

  // 🚀 Firebase Storage Upload Logic
  const handleImageUpload = async (e: any) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      if(data.bgImages.length + files.length > 5) return alert("⚠️ आप अधिकतम 5 फोटो ही लगा सकते हैं!");
      
      setUploadingImg(true);
      const newImages = [...data.bgImages];

      for (const file of files as any[]) {
        if (file.size > 2000000) {
            alert(`⚠️ ${file.name} का साइज 2MB से ज्यादा है। इसे छोड़ दिया गया है।`);
            continue;
        }
        try {
            const imageRef = ref(storage, `website_bgs/prasad_${Date.now()}_${file.name}`);
            await uploadBytes(imageRef, file);
            const downloadUrl = await getDownloadURL(imageRef);
            newImages.push(downloadUrl);
        } catch (error) {
            console.error("Image Upload Failed:", error);
            alert("❌ फोटो अपलोड होने में दिक्कत आई।");
        }
      }
      
      setData({ ...data, bgImages: newImages });
      setUploadingImg(false);
    }
  };

  const removeImage = (index: number) => {
    const filtered = data.bgImages.filter((_, i) => i !== index);
    setData({ ...data, bgImages: filtered });
    if(currentSlide >= filtered.length) setCurrentSlide(0);
  };

  // 🚀 DYNAMIC FLEET MANAGER FUNCTIONS
  const handleFleetChange = (id: number, field: string, value: string) => {
    const updatedCards = data.fleetCards.map(card => card.id === id ? { ...card, [field]: value } : card);
    setData({ ...data, fleetCards: updatedCards });
  };

  const addFleetCard = () => {
    const newCard = { id: Date.now(), icon: '🚛', title: 'New Vehicle Type', desc: 'Describe the vehicle...', capacities: '10 MT, 12 MT' };
    setData({ ...data, fleetCards: [...data.fleetCards, newCard] });
  };

  const removeFleetCard = (id: number) => {
    if(window.confirm('Are you sure you want to delete this vehicle card from the website?')) {
      const filteredCards = data.fleetCards.filter(card => card.id !== id);
      setData({ ...data, fleetCards: filteredCards });
    }
  };

  const saveSettings = async () => {
    setLoading(true);
    try { 
        await setDoc(doc(db, "WEBSITE", "SETTINGS"), data); 
        alert("✅ वेबसाइट की सेटिंग्स सफलतापूर्वक लाइव कर दी गई हैं!"); 
    } 
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

  // Custom Input Style
  const inputStyle = { width: '100%', padding: '12px', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid #334155', color: '#fff', borderRadius: '8px', marginBottom: '15px', marginTop: '5px', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };
  const labelStyle = { color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' as const };

  return (
    <div className="cms-container" style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      
      {/* 📱 RESPONSIVE CSS STYLES */}
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 16px; backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .glow-btn { background: linear-gradient(135deg, #f97316, #ea580c); color: white; border: none; padding: 18px 25px; border-radius: 12px; font-weight: 900; cursor: pointer; box-shadow: 0 10px 25px rgba(249, 115, 22, 0.4); display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 16px; width: 100%; text-transform: uppercase; letter-spacing: 1px; transition: transform 0.2s;}
        .glow-btn:hover { transform: translateY(-2px); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        
        .main-layout { display: grid; grid-template-columns: 1fr 1.2fr; gap: 40px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        
        /* 📱 MOBILE VIEW LOGIC */
        @media (max-width: 1000px) {
            .cms-container { padding: 15px !important; }
            .main-layout { grid-template-columns: 1fr; } 
            .form-grid { grid-template-columns: 1fr; gap: 0px; }
            .header-flex { flex-direction: column; align-items: flex-start !important; gap: 15px; }
            .live-preview-box { height: 40vh !important; margin-bottom: 20px; } 
        }
      `}</style>

      <div className="header-flex" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', paddingBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900' }}>🌐 Website Control Room</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0 0 0', fontSize: '14px', fontWeight: '500' }}>Manage all text, images, and dynamic content of your Public Website directly from here.</p>
        </div>
        <button onClick={restoreDefaults} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.5)', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px', textTransform: 'uppercase' }}>🔄 Restore Defaults</button>
      </div>

      <div className="main-layout">
        
        {/* RIGHT PANEL: LIVE PREVIEW (Order 1 on Mobile, Order 2 on PC) */}
        <div style={{ position: 'sticky', top: '30px', alignSelf: 'start', order: window.innerWidth < 1000 ? 1 : 2 }}>
          <h3 style={{ color: '#fff', margin: '0 0 15px 0', fontSize: '18px' }}>👁️ Live Hero Preview</h3>
          <div className="live-preview-box" style={{ width: '100%', height: '80vh', borderRadius: '24px', overflow: 'hidden', position: 'relative', border: '4px solid #1e293b', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            {data.bgImages.map((img, i) => (
                <div key={i} style={{ position: 'absolute', inset: 0, backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center', zIndex: 1, opacity: currentSlide === i ? 1 : 0, transition: 'opacity 1s ease-in-out' }}></div>
            ))}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(2,6,23,0.98) 0%, rgba(2,6,23,0.7) 40%, rgba(2,6,23,0.2) 100%)', zIndex: 2 }}></div>
            
            <div style={{ position: 'relative', zIndex: 3, padding: '30px', height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ background: 'linear-gradient(135deg, #ea580c, #f97316)', padding: '8px', borderRadius: '8px', fontSize: '14px' }}>🏢</div>
                <h1 style={{ margin: 0, fontSize: '18px', fontWeight: '900', color: '#fff' }}>PRASAD<span style={{color:'#ea580c'}}>.</span></h1>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start' }}>
                <span style={{ background: 'rgba(249,115,22,0.2)', border: '1px solid #ea580c', color: '#fb923c', padding: '4px 12px', borderRadius: '20px', fontSize: '10px', fontWeight: 'bold', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '15px' }}>{data.heroBadge}</span>
                <h1 style={{ fontSize: '40px', margin: '0 0 15px 0', color: '#fff', fontWeight: '900', lineHeight: '1.1' }}>{data.title1} <br/><span style={{ color: '#fcd34d' }}>{data.title2}</span></h1>
                <p style={{ color: '#e2e8f0', fontSize: '13px', lineHeight: '1.6', maxWidth: '90%' }}>{data.desc}</p>
              </div>
            </div>
          </div>
        </div>

        {/* LEFT PANEL: CMS SCROLLABLE FORMS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '25px', order: window.innerWidth < 1000 ? 2 : 1 }}>
          
          {/* 1. HERO SECTION */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #38bdf8' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#38bdf8', fontSize: '18px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>🖼️ 1. Hero Section (Home Page)</h3>
            
            <label style={labelStyle}>Small Badge Text</label>
            <input type="text" value={data.heroBadge} onChange={e => setData({...data, heroBadge: e.target.value})} style={inputStyle} />
            
            <div className="form-grid">
              <div><label style={labelStyle}>Main Title</label><input type="text" value={data.title1} onChange={e => setData({...data, title1: e.target.value})} style={inputStyle} /></div>
              <div><label style={labelStyle}>Highlight Title (Colored)</label><input type="text" value={data.title2} onChange={e => setData({...data, title2: e.target.value})} style={inputStyle} /></div>
            </div>
            
            <label style={labelStyle}>Description / Subtitle</label>
            <textarea value={data.desc} onChange={e => setData({...data, desc: e.target.value})} rows={3} style={{...inputStyle, resize: 'none'}} />

            {/* Photo Upload Area */}
            <div style={{ marginTop: '15px', padding:'20px', background:'rgba(0,0,0,0.3)', borderRadius:'12px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <label style={labelStyle}>📸 Background Slider Images (Max 5)</label>
              <input type="file" multiple accept="image/*" onChange={handleImageUpload} style={{ width: '100%', padding: '12px', color: '#fff', borderRadius: '8px', marginBottom: '15px', border: '1px dashed #475569', marginTop: '10px', background: 'rgba(15,23,42,0.5)' }} disabled={uploadingImg} />
              {uploadingImg && <p style={{color: '#38bdf8', fontSize: '12px', marginTop: 0, fontWeight: 'bold'}}>⏳ Uploading to secure server... please wait.</p>}

              <div style={{display:'flex', gap:'10px', overflowX:'auto', paddingBottom: '5px'}}>
                  {data.bgImages.map((img, i) => (
                      <div key={i} style={{position:'relative', minWidth:'100px', height:'70px', borderRadius:'8px', overflow:'hidden', border: currentSlide === i ? '2px solid #38bdf8' : '2px solid transparent', boxShadow: '0 4px 10px rgba(0,0,0,0.5)'}}>
                          <img src={img} style={{width:'100%', height:'100%', objectFit:'cover'}} alt="slider" />
                          <button onClick={()=>removeImage(i)} style={{position:'absolute', top:4, right:4, background:'rgba(239,68,68,0.9)', border:'none', color:'white', borderRadius:'50%', width:'22px', height:'22px', cursor:'pointer', fontSize:'10px', fontWeight:'bold'}}>✕</button>
                      </div>
                  ))}
              </div>
            </div>
          </div>

          {/* 2. ABOUT US */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #f59e0b' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#f59e0b', fontSize: '18px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>🏢 2. About Us Section</h3>
            
            <label style={labelStyle}>Badge Text</label>
            <input type="text" value={data.aboutBadge} onChange={e => setData({...data, aboutBadge: e.target.value})} style={inputStyle} />
            
            <label style={labelStyle}>Main Heading</label>
            <input type="text" value={data.aboutTitle} onChange={e => setData({...data, aboutTitle: e.target.value})} style={inputStyle} />
            
            <label style={labelStyle}>Company History / Legacy Description</label>
            <textarea value={data.aboutDesc1} onChange={e => setData({...data, aboutDesc1: e.target.value})} rows={3} style={{...inputStyle, resize: 'none'}} />

            <div className="form-grid">
              <div><label style={labelStyle}>Vision Box Title</label><input type="text" value={data.aboutVisionTitle} onChange={e => setData({...data, aboutVisionTitle: e.target.value})} style={inputStyle} /></div>
              <div><label style={labelStyle}>Vision Box Details</label><textarea value={data.aboutVisionDesc} onChange={e => setData({...data, aboutVisionDesc: e.target.value})} rows={2} style={{...inputStyle, resize: 'none'}} /></div>
            </div>
          </div>

          {/* 3. OUR FLEET (DYNAMIC ADD/REMOVE SECTION) */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #8b5cf6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px', marginBottom: '20px' }}>
               <h3 style={{ margin: 0, color: '#8b5cf6', fontSize: '18px' }}>🚛 3. Fleet & Vehicles Setup</h3>
               <button onClick={addFleetCard} style={{ background: '#8b5cf6', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>+ Add New Vehicle</button>
            </div>

            <div className="form-grid">
              <div><label style={labelStyle}>Badge Text</label><input type="text" value={data.fleetBadge} onChange={e => setData({...data, fleetBadge: e.target.value})} style={inputStyle} /></div>
              <div><label style={labelStyle}>Main Title</label><input type="text" value={data.fleetTitle} onChange={e => setData({...data, fleetTitle: e.target.value})} style={inputStyle} /></div>
            </div>
            <label style={labelStyle}>Description</label>
            <textarea value={data.fleetDesc} onChange={e => setData({...data, fleetDesc: e.target.value})} rows={2} style={{...inputStyle, resize: 'none'}} />

            {/* DYNAMIC VEHICLE CARDS */}
            <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
              {data.fleetCards.map((card, index) => (
                <div key={card.id} style={{ background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '12px', border: '1px solid #334155', position: 'relative' }}>
                  <button onClick={() => removeFleetCard(card.id)} style={{ position: 'absolute', top: '10px', right: '10px', background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '4px', cursor: 'pointer', fontSize: '10px', padding: '4px 8px', fontWeight: 'bold' }}>DELETE</button>
                  
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
                    <div style={{ width: '40px' }}>
                      <label style={labelStyle}>Icon</label>
                      <input type="text" value={card.icon} onChange={(e) => handleFleetChange(card.id, 'icon', e.target.value)} style={{...inputStyle, textAlign: 'center', padding: '8px'}} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Vehicle Name / Category</label>
                      <input type="text" value={card.title} onChange={(e) => handleFleetChange(card.id, 'title', e.target.value)} style={{...inputStyle, padding: '8px'}} />
                    </div>
                  </div>
                  
                  <label style={labelStyle}>Short Description</label>
                  <input type="text" value={card.desc} onChange={(e) => handleFleetChange(card.id, 'desc', e.target.value)} style={{...inputStyle, padding: '8px'}} />
                  
                  <label style={labelStyle}>Available Capacities (Comma separated)</label>
                  <input type="text" value={card.capacities} onChange={(e) => handleFleetChange(card.id, 'capacities', e.target.value)} placeholder="e.g. 10 MT, 15 MT, 20 MT" style={{...inputStyle, padding: '8px'}} />
                </div>
              ))}
            </div>

          </div>

          {/* 4. CONTACT & SUPPORT */}
          <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #10b981' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#10b981', fontSize: '18px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>📞 4. Contact & Footer Settings</h3>
            
            <div className="form-grid">
               <div><label style={labelStyle}>General Email</label><input type="text" value={data.email1} onChange={e => setData({...data, email1: e.target.value})} style={inputStyle} /></div>
               <div><label style={labelStyle}>Support Email</label><input type="text" value={data.email2} onChange={e => setData({...data, email2: e.target.value})} style={inputStyle} /></div>
            </div>
            
            <label style={labelStyle}>Head Office Address</label>
            <input type="text" value={data.address} onChange={e => setData({...data, address: e.target.value})} style={inputStyle} />
            
            <div className="form-grid" style={{ marginTop: '10px' }}>
               <div>
                  <label style={labelStyle}>WhatsApp Number (With Code)</label>
                  <input type="text" value={data.waNumber} onChange={e => setData({...data, waNumber: e.target.value})} style={inputStyle} placeholder="919876543210" />
               </div>
               <div>
                  <label style={labelStyle}>Default WA Message</label>
                  <input type="text" value={data.waMessage} onChange={e => setData({...data, waMessage: e.target.value})} style={inputStyle} />
               </div>
            </div>

            <label style={labelStyle}>Footer Copyright Text</label>
            <input type="text" value={data.footerText} onChange={e => setData({...data, footerText: e.target.value})} style={inputStyle} />
          </div>

          {/* SAVE BUTTON */}
          <div style={{ position: 'sticky', bottom: '20px', zIndex: 10 }}>
            <button className="glow-btn" onClick={saveSettings} disabled={loading || uploadingImg}>
              {loading ? '⏳ SAVING CHANGES...' : '💾 PUBLISH TO LIVE WEBSITE'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}