// @ts-nocheck
// 💬 MAMTA AI — local, RAG-grounded chat over ERP data (Phase 7).
import React, { useEffect, useRef, useState } from 'react';
import { ragAnswer, buildIndex, ragStatus } from './lib/rag';
import { runAgent } from './lib/agents/orchestrator';
import { commitWrite } from './lib/agents/tools';
import { llmHealth } from './lib/llm';
import { speak, stopSpeaking, voiceStatus } from './lib/voice/tts';
import { remember } from './lib/memory';
import { generateDailyReport } from './lib/analysis/dailyReport';

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
  const [agentMode, setAgentMode] = useState(true); // 🧭 multi-agent tool-calling
  const [speaker, setSpeaker] = useState(false);    // 🔊 local Hindi voice output
  const [voiceName, setVoiceName] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ragStatus().then(s => setIndexCount(s.count)).catch(() => {});
    llmHealth().then(h => setOnline(!!h?.online)).catch(() => setOnline(false));
    voiceStatus().then(v => setVoiceName(v.available ? v.voiceName : '')).catch(() => {});
  }, []);

  const toggleSpeaker = () => {
    setSpeaker(s => { const next = !s; if (!next) stopSpeaking(); return next; });
  };

  // 📋 Daily self-analysis report (Phase 14.2) — read-only.
  const runDailyReport = async () => {
    if (busy) return;
    setMessages(m => [...m, { role: 'user', content: '📋 Aaj ki daily report do' }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const patchLast = (fn: any) => setMessages(m => m.map((msg, i) => (i === m.length - 1 && msg.role === 'assistant' ? fn(msg) : msg)));
    try {
      const { report } = await generateDailyReport((t) => patchLast((msg: any) => ({ ...msg, content: msg.content + t })));
      patchLast((msg: any) => ({ ...msg, streaming: false }));
      if (speaker) speak(report);
    } catch (e: any) {
      patchLast((msg: any) => ({ ...msg, streaming: false, content: '❌ Report nahi ban payi: ' + (e?.message || 'error') }));
    }
    setBusy(false);
  };

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
    setMessages(m => [...m, { role: 'user', content: query }, { role: 'assistant', content: '', streaming: true, trace: [] }]);
    setBusy(true);
    try {
      // Immutable updates (StrictMode runs updaters twice — never mutate state).
      const patchLast = (fn: (msg: any) => any) =>
        setMessages(m => m.map((msg, i) => (i === m.length - 1 && msg.role === 'assistant' ? fn(msg) : msg)));

      if (agentMode) {
        // 🧭 Multi-agent: route via tools, show the trace as it runs.
        let rbacUser: any = undefined;
        try { rbacUser = JSON.parse(localStorage.getItem('prasad_user') || 'null') || undefined; } catch { /* ignore */ }
        const { answer, pendingWrite } = await runAgent(query, (ev) => {
          if (ev.type === 'tool_call') patchLast(msg => ({ ...msg, trace: [...(msg.trace || []), `🔧 ${ev.agent || 'Agent'} → ${ev.tool}(${JSON.stringify(ev.args)})`] }));
        }, rbacUser);
        if (pendingWrite) {
          // ✋ Write action — never auto-saved. Show preview + ask to confirm.
          const ask = 'Main yeh record banana chahta hoon. Confirm karein to hi save hoga:';
          patchLast(msg => ({ ...msg, streaming: false, content: ask, pendingWrite }));
          if (speaker) speak(ask);
        } else {
          patchLast(msg => ({ ...msg, streaming: false, content: answer }));
          if (speaker) speak(answer);
        }
      } else {
        let full = '';
        const { sources } = await ragAnswer(query, (tok) => { full += tok; patchLast(msg => ({ ...msg, content: msg.content + tok })); });
        patchLast(msg => ({ ...msg, streaming: false, sources }));
        if (speaker) speak(full);
      }
    } catch (e: any) {
      const offline = e?.name === 'LLMOfflineError' || /ollama|reach|engine/i.test(e?.message || '');
      const errText = offline ? '❌ Local AI engine (Ollama) band hai. Use chalu karke dobara try karein.' : `❌ ${e?.message || 'Error'}`;
      setMessages(m => m.map((msg, i) =>
        i === m.length - 1 && msg.role === 'assistant' ? { ...msg, streaming: false, content: errText } : msg
      ));
    }
    setBusy(false);
  };

  // 👍/👎 feedback — human-in-the-loop self-improvement (Phase 14.3).
  // 👍 reinforces a confirmed fact to long-term memory; 👎 logs for admin review.
  // Never changes code/rules/RBAC autonomously.
  const giveFeedback = (idx: number, good: boolean) => {
    const a = messages[idx]; const q = messages[idx - 1];
    if (!a || a.role !== 'assistant') return;
    setMessages(m => m.map((msg, i) => i === idx ? { ...msg, feedback: good ? 'up' : 'down' } : msg));
    let user: any; try { user = JSON.parse(localStorage.getItem('prasad_user') || 'null'); } catch { /* */ }
    if (good) {
      const sc = String(user?.role || '').toLowerCase();
      const scope = (sc === 'vendor' || sc === 'customer' || sc === 'driver') ? (user.vendor_name || user.customer_name || user.driver_name || 'all') : 'all';
      remember({ namespace: 'mamta', text: `Confirmed: ${q?.content || ''} → ${String(a.content).slice(0, 200)}`, scope, kind: 'confirmed' }).catch(() => {});
    } else {
      try { const log = JSON.parse(localStorage.getItem('mamta_feedback_log') || '[]'); log.push({ q: q?.content, a: a.content, at: Date.now() }); localStorage.setItem('mamta_feedback_log', JSON.stringify(log.slice(-100))); } catch { /* */ }
    }
  };

  const confirmWrite = async (idx: number) => {
    const pw = messages[idx]?.pendingWrite;
    if (!pw) return;
    setMessages(m => m.map((msg, i) => i === idx ? { ...msg, pendingWrite: null, content: msg.content + '\n⏳ Saving…' } : msg));
    try {
      const result = await commitWrite(pw.tool, pw.args);
      setMessages(m => m.map((msg, i) => i === idx ? { ...msg, content: `✅ Save ho gaya. ${result}` } : msg));
    } catch (e: any) {
      setMessages(m => m.map((msg, i) => i === idx ? { ...msg, content: `❌ Save nahi hua: ${e?.message || 'error'}` } : msg));
    }
  };
  const cancelWrite = (idx: number) => {
    setMessages(m => m.map((msg, i) => i === idx ? { ...msg, pendingWrite: null, content: '🚫 Cancel kiya — kuch save nahi hua.' } : msg));
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button onClick={runDailyReport} disabled={busy} title="Aaj ka operations + finance review" className="pt-btn pt-btn--ghost" style={{ fontSize: '12px', padding: '6px 12px' }}>📋 Daily Report</button>
          <button onClick={toggleSpeaker} title={voiceName ? `Voice: ${voiceName}` : 'No local voice found'} className={`pt-btn ${speaker ? 'pt-btn--success' : 'pt-btn--ghost'}`} style={{ fontSize: '12px', padding: '6px 12px' }}>
            {speaker ? '🔊 Voice On' : '🔇 Voice Off'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#94a3b8', cursor: 'pointer' }}>
            <input type="checkbox" checked={agentMode} onChange={e => setAgentMode(e.target.checked)} />
            🧭 Agent mode
          </label>
          <button onClick={handleBuildIndex} disabled={indexing} className={`pt-btn pt-btn--ai ${indexing ? 'is-loading' : ''}`}>
            {indexing ? (progress || 'Building…') : (indexCount ? '🔄 Refresh Index' : '⚙️ Build Index')}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px', background: 'rgba(2,6,23,0.4)', borderRadius: '14px', border: '1px solid #1e293b' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: '12px' }}>
            <div style={{ maxWidth: '80%', padding: '12px 16px', borderRadius: '14px', background: m.role === 'user' ? 'linear-gradient(135deg,#3b82f6,#6366f1)' : 'rgba(30,41,59,0.7)', color: '#f1f5f9', border: m.role === 'user' ? 'none' : '1px solid #334155', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {m.trace?.length > 0 && (
                <div style={{ marginBottom: '8px', fontSize: '11px', color: '#c084fc', fontFamily: 'monospace' }}>
                  {m.trace.map((t: string, k: number) => <div key={k}>{t}</div>)}
                </div>
              )}
              {m.content || (m.streaming ? '▌' : '')}
              {m.pendingWrite && (
                <div style={{ marginTop: '10px', background: 'rgba(245,158,11,0.08)', border: '1px solid #f59e0b', borderRadius: '10px', padding: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#f59e0b', marginBottom: '8px' }}>✍️ {m.pendingWrite.agent} → {m.pendingWrite.tool}</div>
                  {Object.entries(m.pendingWrite.args).map(([k, v]) => (
                    <div key={k} style={{ fontSize: '12px', color: '#cbd5e1' }}><span style={{ color: '#94a3b8' }}>{k}:</span> <b>{String(v)}</b></div>
                  ))}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button onClick={() => confirmWrite(i)} className="pt-btn pt-btn--success" style={{ fontSize: '12px', padding: '6px 14px' }}>✅ Confirm & Save</button>
                    <button onClick={() => cancelWrite(i)} className="pt-btn pt-btn--ghost" style={{ fontSize: '12px', padding: '6px 14px' }}>🚫 Cancel</button>
                  </div>
                </div>
              )}
              {m.sources?.length > 0 && (
                <details style={{ marginTop: '8px' }}>
                  <summary style={{ fontSize: '11px', color: '#94a3b8', cursor: 'pointer' }}>📎 {m.sources.length} source records</summary>
                  {m.sources.map((s: any, j: number) => (
                    <div key={j} style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>• {s.text.slice(0, 120)}</div>
                  ))}
                </details>
              )}
              {m.role === 'assistant' && m.content && !m.streaming && !m.pendingWrite && (
                <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {m.feedback ? (
                    <span style={{ fontSize: '11px', color: m.feedback === 'up' ? '#10b981' : '#f59e0b' }}>{m.feedback === 'up' ? '👍 Yaad rakh liya' : '👎 Review ke liye logged'}</span>
                  ) : (
                    <>
                      <button onClick={() => giveFeedback(i, true)} title="Sahi — yaad rakho" style={{ background: 'none', border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', padding: '2px 8px' }}>👍</button>
                      <button onClick={() => giveFeedback(i, false)} title="Galat — review" style={{ background: 'none', border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', padding: '2px 8px' }}>👎</button>
                    </>
                  )}
                </div>
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
