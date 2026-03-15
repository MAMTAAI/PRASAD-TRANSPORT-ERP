import React, { useState } from 'react';

export default function LookerAnalytics() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 🔗 यहाँ आपको अपने Looker Studio Pro की "Embed URL" डालनी है
  // (अभी मैंने एक डमी URL दी है ताकि आप डिज़ाइन देख सकें)
  const LOOKER_EMBED_URL = "https://lookerstudio.google.com/embed/reporting/a07cc37d-d9fe-4619-901e-2d19236736b9/page/wIqrF";
  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  return (
    <div style={{ 
      padding: isFullscreen ? '0' : '30px', 
      minHeight: '100vh', 
      background: 'radial-gradient(circle at top right, #0f172a, #020617)',
      position: isFullscreen ? 'fixed' : 'relative',
      top: 0, left: 0, right: 0, bottom: 0,
      zIndex: isFullscreen ? 9999 : 1
    }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.3s; }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #8b5cf6, #6366f1); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 14px; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4); display: flex; align-items: center; gap: 8px;}
        .glow-btn:hover { box-shadow: 0 4px 25px rgba(99, 102, 241, 0.7); transform: scale(1.05); }
        .iframe-container { width: 100%; height: ${isFullscreen ? '100vh' : '75vh'}; border-radius: ${isFullscreen ? '0' : '15px'}; overflow: hidden; border: ${isFullscreen ? 'none' : '1px solid #334155'}; }
      `}</style>

      {/* 🚀 Header (Only show if not fullscreen) */}
      {!isFullscreen && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
          <div>
            <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900', letterSpacing: '-1px' }}>Business Intelligence</h1>
            <p style={{ color: '#94a3b8', margin: '5px 0', fontSize: '14px' }}>Powered by Looker Studio Pro AI Analytics</p>
          </div>
          <div style={{ display: 'flex', gap: '15px' }}>
            <button className="glow-btn" onClick={toggleFullscreen} style={{ background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', boxShadow: 'none' }}>
              🔲 Full Screen Mode
            </button>
            <button className="glow-btn" onClick={() => window.open('https://lookerstudio.google.com/', '_blank')}>
              ⚙️ Open Data Studio
            </button>
          </div>
        </div>
      )}

      {/* 📊 Looker Studio Pro Embed Area */}
      <div className={`glass-card iframe-container`} style={{ padding: isFullscreen ? '0' : '10px' }}>
        
        {/* Fullscreen Exit Button */}
        {isFullscreen && (
          <button onClick={toggleFullscreen} style={{ position: 'absolute', top: '20px', right: '20px', zIndex: 1000, background: 'rgba(239,68,68,0.9)', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '50px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 5px 15px rgba(0,0,0,0.5)' }}>
            ✕ Exit Fullscreen
          </button>
        )}

        {/* The Magic Frame */}
        <iframe 
          src={LOOKER_EMBED_URL} 
          width="100%" 
          height="100%" 
          frameBorder="0" 
          style={{ border: 0, background: '#ffffff' }} 
          allowFullScreen 
          sandbox="allow-storage allow-scripts allow-popups allow-same-origin"
        ></iframe>

      </div>

      {!isFullscreen && (
        <div style={{ marginTop: '20px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
          Real-time data synchronization via Firebase BigQuery Export • Prasad Enterprise ERP
        </div>
      )}
    </div>
  );
}