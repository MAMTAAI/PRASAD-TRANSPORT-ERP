// @ts-nocheck
// 💬 MAMTA AI — local, RAG-grounded chat over ERP data (Phase 7).
import React, { useEffect, useRef, useState } from 'react';
import { ragAnswer, buildIndex, ragStatus } from './lib/rag';
import { llmHealth } from './lib/llm';

const SUGGESTIONS = [
  'Kaunse trips abhi In Transit hain?',
  'Agartala jaane wale trips kaunse hain?',
  'Vehicle AS 26C 9815 ka driver kaun hai?',
  'Driver Nur Alam ka mobile number kya hai?',
];

export default function MamtaChat() {
  const [messages, setMessages] = useState<any[]>([
    { role: 'assistant', content: 'Namaste! Main MAMTA AI hoon — aapke ERP data par sawaal poochhiye (trips, vehicles, drivers). Pehli baar "Build Index" dabaayein taaki main aapka data padh saku.' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [indexCount, setIndexCount] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState('');
  const [online, setOnline] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ragStatus().then(s => setIndexCount(s.count)).catch(() => {});
    llmHealth().then(h => setOnline(!!h?.online)).catch(() => setOnline(false));
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const handleBuildIndex = async () => {
    setIndexing(true);
    setProgress('Starting…');
    try {
      const { indexed } = await buildIndex(p => setProgress(`${p.phase}: ${p.done}/${p.total || '…'}`));
      const s = await ragStatus();
      setIndexCount(s.count);
      setProgress('');
      setMessages(m => [...m, { role: 'assistant', content: `✅ Index ready — ${indexed} ERP records padh liye. Ab sawaal poochhiye.` }]);
    } catch (e: any) {
      setProgress('');
      setMessages(m => [...m, { role: 'assistant', content: `❌ Index nahi ban paaya: ${e?.message || 'error'}. Ollama chalu hai?` }]);
    }
    setIndexing(false);
  };

  const send = async (q: string) => {
    const query = q.trim();
    if (!query || busy) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', content: query }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    try {
      // Immutable updates (StrictMode runs updaters twice — never mutate state).
      const { sources } = await ragAnswer(query, (tok) => {
        setMessages(m => m.map((msg, i) =>
          i === m.length - 1 && msg.role === 'assistant' ? { ...msg, content: msg.content + tok } : msg
        ));
      });
      setMessages(m => m.map((msg, i) =>
        i === m.length - 1 && msg.role === 'assistant' ? { ...msg, streaming: false, sources } : msg
      ));
    } catch (e: any) {
      const offline = e?.name === 'LLMOfflineError' || /ollama|reach|engine/i.test(e?.message || '');
      const errText = offline ? '❌ Local AI engine (Ollama) band hai. Use chalu karke dobara try karein.' : `❌ ${e?.message || 'Error'}`;
      setMessages(m => m.map((msg, i) =>
        i === m.length - 1 && msg.role === 'assistant' ? { ...msg, streaming: false, content: errText } : msg
      ));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '78vh' }}>
      {/* Header / index control */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#c084fc' }}>🤖 MAMTA AI <span style={{ fontSize: '11px', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '1px 8px', marginLeft: '6px' }}>100% LOCAL</span></h2>
          <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
            Index: <b style={{ color: indexCount ? '#10b981' : '#f59e0b' }}>{indexCount} records</b>
            {online === false && <span style={{ color: '#ef4444', marginLeft: '10px' }}>● Engine offline</span>}
            {online === true && <span style={{ color: '#10b981', marginLeft: '10px' }}>● Engine online</span>}
          </div>
        </div>
        <button onClick={handleBuildIndex} disabled={indexing} className={`pt-btn pt-btn--ai ${indexing ? 'is-loading' : ''}`}>
          {indexing ? (progress || 'Building…') : (indexCount ? '🔄 Refresh Index' : '⚙️ Build Index')}
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px', background: 'rgba(2,6,23,0.4)', borderRadius: '14px', border: '1px solid #1e293b' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: '12px' }}>
            <div style={{ maxWidth: '80%', padding: '12px 16px', borderRadius: '14px', background: m.role === 'user' ? 'linear-gradient(135deg,#3b82f6,#6366f1)' : 'rgba(30,41,59,0.7)', color: '#f1f5f9', border: m.role === 'user' ? 'none' : '1px solid #334155', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {m.content || (m.streaming ? '▌' : '')}
              {m.sources?.length > 0 && (
                <details style={{ marginTop: '8px' }}>
                  <summary style={{ fontSize: '11px', color: '#94a3b8', cursor: 'pointer' }}>📎 {m.sources.length} source records</summary>
                  {m.sources.map((s: any, j: number) => (
                    <div key={j} style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>• {s.text.slice(0, 120)}</div>
                  ))}
                </details>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Suggestions */}
      {messages.length <= 1 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '12px 0 0' }}>
          {SUGGESTIONS.map(s => (
            <button key={s} onClick={() => send(s)} disabled={busy} className="pt-btn pt-btn--ghost" style={{ fontSize: '12px', padding: '6px 12px' }}>{s}</button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(input); }}
          placeholder={indexCount ? 'ERP data par sawaal poochhiye…' : 'Pehle Build Index dabaayein…'}
          style={{ flex: 1, padding: '14px 16px', background: '#0f172a', border: '1px solid #334155', borderRadius: '12px', color: '#fff', outline: 'none', fontSize: '15px' }}
        />
        <button onClick={() => send(input)} disabled={busy || !input.trim()} className={`pt-btn pt-btn--primary ${busy ? 'is-loading' : ''}`}>
          {busy ? '' : '➤ Send'}
        </button>
      </div>
    </div>
  );
}
