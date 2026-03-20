// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export default function AiSettings() {
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchCurrentPrompt();
  }, []);

  const fetchCurrentPrompt = async () => {
    const docRef = doc(db, "SETTINGS", "ai_config");
    const snap = await getDoc(docRef);
    if (snap.exists()) setPrompt(snap.data().masterPrompt);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, "SETTINGS", "ai_config"), {
        masterPrompt: prompt,
        updatedAt: new Date().toISOString()
      });
      alert("🧠 Mamta AI Brain Updated Successfully!");
    } catch (e) { alert("Error saving prompt"); }
    setSaving(false);
  };

  return (
    <div style={{ padding: '30px', background: '#020617', minHeight: '100vh', color: 'white' }}>
      <h2 style={{ color: '#c084fc' }}>🤖 Mamta AI - Central Training Desk</h2>
      <p style={{ color: '#94a3b8' }}>यहाँ से आप Mamta AI को निर्देश (Instructions) दे सकते हैं।</p>
      
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', padding: '25px', borderRadius: '15px', border: '1px solid #c084fc' }}>
        <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: '#38bdf8' }}>MASTER INSTRUCTIONS (The Brain):</label>
        <textarea 
          value={prompt} 
          onChange={(e) => setPrompt(e.target.value)}
          style={{ width: '100%', height: '400px', background: '#0f172a', color: '#10b981', padding: '20px', borderRadius: '10px', border: '1px solid #334155', fontFamily: 'monospace', fontSize: '14px', outline: 'none' }}
          placeholder="Type how Mamta AI should behave..."
        />
        
        <button 
          onClick={handleSave} 
          disabled={saving}
          style={{ marginTop: '20px', width: '100%', padding: '15px', background: 'linear-gradient(135deg, #c084fc, #8b5cf6)', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          {saving ? "⏳ Syncing Brain..." : "💾 UPDATE AI INTELLIGENCE"}
        </button>
      </div>
      
      <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(245, 158, 11, 0.1)', border: '1px dashed #f59e0b', borderRadius: '10px' }}>
        <small style={{ color: '#f59e0b' }}>⚠️ ध्यान दें: यहाँ बदलाव करने के बाद Mamta AI पूरे ERP के लिए बदल जाएगी।</small>
      </div>
    </div>
  );
}