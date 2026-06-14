// @ts-nocheck
// 🧠 AI Brain Control — control panel for the LOCAL Gemma 4 engine.
// Live health (Ollama/model), swap active model + temperature + Mamta persona
// (saved to localStorage — instant, no Firestore read), and a quick self-test.
import React, { useEffect, useState } from 'react';
import { llmHealth, llmComplete } from './lib/llm';
import { LLM_CONFIG, getAiOverrides, setAiOverrides, getPersona, DEFAULT_PERSONA } from './lib/llm/config';

export default function AiSettings() {
  const [health, setHealth] = useState<any>(null);
  const [checking, setChecking] = useState(true);
  const [model, setModel] = useState(LLM_CONFIG.model);
  const [temp, setTemp] = useState(LLM_CONFIG.temperature);
  const [persona, setPersona] = useState(getPersona());
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState('');

  const refreshHealth = () => {
    setChecking(true);
    llmHealth().then(h => setHealth(h)).catch(() => setHealth({ online: false })).finally(() => setChecking(false));
  };
  useEffect(() => { refreshHealth(); }, []);

  const save = () => {
    setAiOverrides({ model, temperature: Number(temp), persona });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  const reset = () => {
    setAiOverrides({ model: undefined, temperature: undefined, persona: undefined });
    setModel('gemma4:12b'); setTemp(0.4); setPersona(DEFAULT_PERSONA);
  };

  const runTest = async () => {
    setTesting(true); setTestOut('');
    try {
      const out = await llmComplete(
        [{ role: 'system', content: persona }, { role: 'user', content: 'Ek line mein apna parichay do.' }],
        { model, temperature: Number(temp) },
        (t) => setTestOut(prev => prev + t),
      );
      if (!out) setTestOut('(no response)');
    } catch (e: any) {
      setTestOut('❌ ' + (e?.message || 'Engine error — Ollama chalu hai?'));
    }
    setTesting(false);
  };

  const installed: string[] = health?.models || [];
  const card = { background: 'rgba(30,41,59,0.5)', border: '1px solid #334155', borderRadius: '16px', padding: '22px', marginBottom: '20px' };

  return (
    <div style={{ padding: '24px', color: '#fff', maxWidth: '900px', margin: '0 auto' }}>
      <h2 style={{ color: '#c084fc', margin: 0 }}>🧠 AI Brain Control <span style={{ fontSize: '11px', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '1px 8px', marginLeft: '6px' }}>100% LOCAL</span></h2>
      <p style={{ color: '#94a3b8', marginTop: '6px' }}>Local Gemma 4 engine ka control — model, temperature, Mamta persona (sab .env/code change ke bina).</p>

      {/* Live health */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>⚡ Engine Health</h3>
          <button onClick={refreshHealth} className="pt-btn pt-btn--ghost" style={{ fontSize: '12px', padding: '6px 12px' }}>🔄 Refresh</button>
        </div>
        {checking ? <div style={{ color: '#94a3b8' }}>Checking…</div> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: '12px' }}>
            <Stat label="Ollama" value={health?.online ? '🟢 Online' : '🔴 Offline'} color={health?.online ? '#10b981' : '#ef4444'} />
            <Stat label="Primary model" value={health?.primaryInstalled ? '✅ Installed' : '⚠️ Missing'} color={health?.primaryInstalled ? '#10b981' : '#f59e0b'} />
            <Stat label="Models loaded" value={String(installed.length)} color="#38bdf8" />
            <Stat label="Endpoint" value={LLM_CONFIG.baseUrl.replace('http://', '')} color="#94a3b8" />
          </div>
        )}
        {installed.length > 0 && <div style={{ marginTop: '10px', fontSize: '11px', color: '#64748b' }}>Installed: {installed.join(', ')}</div>}
        {health && !health.online && <div style={{ marginTop: '10px', color: '#ef4444', fontSize: '13px' }}>⚠️ Ollama nahi mila. `ollama serve` chalu karein.</div>}
      </div>

      {/* Model + temperature + persona */}
      <div style={card}>
        <h3 style={{ margin: '0 0 14px', fontSize: '16px' }}>🎛️ Active Configuration</h3>
        <label style={{ fontSize: '12px', color: '#94a3b8' }}>Active model</label>
        <select value={model} onChange={e => setModel(e.target.value)} style={inp}>
          <option value="gemma4:12b">gemma4:12b — primary (accurate)</option>
          <option value="gemma4:e4b">gemma4:e4b — fast (live chat)</option>
          {installed.filter(m => !['gemma4:12b', 'gemma4:e4b'].includes(m)).map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <label style={{ fontSize: '12px', color: '#94a3b8', marginTop: '14px', display: 'block' }}>Temperature: <b style={{ color: '#c084fc' }}>{Number(temp).toFixed(2)}</b> <span style={{ color: '#64748b' }}>(0 = precise, 1 = creative)</span></label>
        <input type="range" min="0" max="1" step="0.05" value={temp} onChange={e => setTemp(parseFloat(e.target.value))} style={{ width: '100%' }} />

        <label style={{ fontSize: '12px', color: '#94a3b8', marginTop: '14px', display: 'block' }}>Mamta persona (system instruction)</label>
        <textarea value={persona} onChange={e => setPersona(e.target.value)} style={{ ...inp, height: '120px', fontFamily: 'inherit' }} />

        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexWrap: 'wrap' }}>
          <button onClick={save} className="pt-btn pt-btn--ai">{saved ? '✅ Saved' : '💾 Save Config'}</button>
          <button onClick={reset} className="pt-btn pt-btn--ghost">↺ Reset to defaults</button>
          <button onClick={runTest} disabled={testing} className={`pt-btn pt-btn--primary ${testing ? 'is-loading' : ''}`}>{testing ? 'Testing…' : '🧪 Test Brain'}</button>
        </div>
        {testOut && <div style={{ marginTop: '14px', background: '#0f172a', border: '1px solid #334155', borderRadius: '10px', padding: '14px', whiteSpace: 'pre-wrap', color: '#10b981' }}>{testOut}</div>}
      </div>

      <div style={{ padding: '12px 16px', background: 'rgba(245,158,11,0.08)', border: '1px dashed #f59e0b', borderRadius: '10px', fontSize: '12px', color: '#f59e0b' }}>
        ⚠️ Config localStorage mein save hota hai (is browser/device ke liye, turant lagu). RBAC: financial AI answers sirf Admin/Accounts ko milte hain (UGER se controlled).
      </div>
    </div>
  );
}

const inp: any = { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '10px', outline: 'none', marginTop: '6px' };
function Stat({ label, value, color }: any) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '12px' }}>
      <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '16px', fontWeight: 'bold', color, marginTop: '4px' }}>{value}</div>
    </div>
  );
}
