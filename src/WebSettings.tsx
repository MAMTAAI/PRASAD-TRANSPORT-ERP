import React, { useState, useEffect } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export default function WebSettings() {
  const [data, setData] = useState({
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      const docSnap = await getDoc(doc(db, "WEBSITE", "SETTINGS"));
      if (docSnap.exists()) setData({ ...data, ...docSnap.data() as any });
    };
    loadSettings();
  }, []);

  const handleImageUpload = (e: any) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setData({ ...data, bg: reader.result as string });
      reader.readAsDataURL(file);
    }
  };

  const saveSettings = async () => {
    setLoading(true);
    try {
      await setDoc(doc(db, "WEBSITE", "SETTINGS"), data);
      alert("✅ Website Updated Successfully! Refresh the login page to see changes.");
    } catch (error) {
      alert("Error saving settings.");
    }
    setLoading(false);
  };

  const inputStyle = { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', marginBottom: '15px', marginTop: '5px', boxSizing: 'border-box' as 'border-box' };

  return (
    <div style={{ padding: '20px', color: 'white' }}>
      <h2 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>🌐 Website Front-Page Settings</h2>
      
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginTop: '20px' }}>
        
        {/* TEXT & IMAGE SETTINGS */}
        <div style={{ flex: '1 1 400px', background: '#1e293b', padding: '25px', borderRadius: '15px' }}>
          <h3 style={{ margin: '0 0 15px 0', color: '#10b981' }}>📝 Text & Background</h3>
          
          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Main Title (White Text)</label>
          <input type="text" value={data.title1} onChange={e => setData({...data, title1: e.target.value})} style={inputStyle} />

          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Highlight Title (Gradient Text)</label>
          <input type="text" value={data.title2} onChange={e => setData({...data, title2: e.target.value})} style={inputStyle} />

          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Description</label>
          <textarea value={data.desc} onChange={e => setData({...data, desc: e.target.value})} rows={3} style={inputStyle} />

          <label style={{ color: '#38bdf8', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '10px' }}>📸 Upload Background Image (Branded Truck)</label>
          <input type="file" accept="image/*" onChange={handleImageUpload} style={{ width: '100%', padding: '10px', background: '#0f172a', color: '#fff', borderRadius: '8px', marginBottom: '15px' }} />
          
          {data.bg && <img src={data.bg} alt="Preview" style={{ width: '100%', height: '150px', objectFit: 'cover', borderRadius: '10px', border: '2px solid #38bdf8' }} />}
        </div>

        {/* MENU LINKS SETTINGS */}
        <div style={{ flex: '1 1 300px', background: '#1e293b', padding: '25px', borderRadius: '15px' }}>
          <h3 style={{ margin: '0 0 15px 0', color: '#f59e0b' }}>🔗 Top Menu Links</h3>
          
          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Menu Link 1 (Default: Home)</label>
          <input type="text" value={data.link1} onChange={e => setData({...data, link1: e.target.value})} style={inputStyle} />
          
          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Menu Link 2</label>
          <input type="text" value={data.link2} onChange={e => setData({...data, link2: e.target.value})} style={inputStyle} />
          
          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Menu Link 3</label>
          <input type="text" value={data.link3} onChange={e => setData({...data, link3: e.target.value})} style={inputStyle} />
          
          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Menu Link 4</label>
          <input type="text" value={data.link4} onChange={e => setData({...data, link4: e.target.value})} style={inputStyle} />
          
          <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Menu Link 5</label>
          <input type="text" value={data.link5} onChange={e => setData({...data, link5: e.target.value})} style={inputStyle} />
        </div>

      </div>

      <button onClick={saveSettings} style={{ width: '100%', maxWidth: '400px', marginTop: '20px', padding: '15px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '16px', fontWeight: 'bold', cursor: 'pointer', display: 'block' }}>
        {loading ? 'Saving...' : '💾 SAVE & PUBLISH TO LIVE WEBSITE'}
      </button>

    </div>
  );
}