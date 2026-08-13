// 🛡️ AI AGENT FLEET COMMAND CENTER — 10 Mahavidya Logistics Agents
// Polls the Fastify agent API (server/index.js, :3300) — NOT Firestore. This
// module is the first UI surface of the PostgreSQL/agent architecture and has
// zero Firebase imports by design.
import React, { useCallback, useEffect, useRef, useState } from 'react';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';

// ── palette (matches AiSettings / MAMTA AI PRO dark scheme) ────────────────
const C = {
  bg: '#0f172a', card: 'rgba(30,41,59,0.55)', line: '#334155', dim: '#94a3b8',
  text: '#e2e8f0', ok: '#10b981', warn: '#f59e0b', bad: '#ef4444',
  purple: '#c084fc', blue: '#38bdf8',
};

const AGENT_ICONS: Record<string, string> = {
  KAMALA: '👑', KALI: '🗡️', TARA: '⚖️', TRIPURA_SUNDARI: '💹', BHUVANESHWARI: '📑',
  BHAIRAVI: '🛡️', CHHINNAMASTA: '⛽', DHUMAVATI: '🛞', BAGALAMUKHI: '🔌', MATANGI: '💬',
};

const STATUS_COLOR: Record<string, string> = {
  OPTIMAL: C.ok, ACTIVE: C.blue, PARKED: C.warn, HALTED: C.bad,
};

// ── tiny UI atoms ───────────────────────────────────────────────────────────
function Bar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim }}>
        <span>{label}</span><span>{pct}%</span>
      </div>
      <div style={{ height: 5, background: '#1e293b', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .6s' }} />
      </div>
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 10, padding: '1px 8px', letterSpacing: 0.5 }}>
      {text}
    </span>
  );
}

function Btn({ label, color, onClick, disabled }: { label: string; color: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
               background: 'transparent', color: disabled ? C.line : color, border: `1px solid ${disabled ? C.line : color}`,
               borderRadius: 8, opacity: disabled ? 0.5 : 1 }}>
      {label}
    </button>
  );
}

// ── agent card ──────────────────────────────────────────────────────────────
function AgentCard({ a, onAction }: { a: any; onAction: (kind: string, agent: any) => void }) {
  const stColor = STATUS_COLOR[a.status] ?? C.dim;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderTop: `2px solid ${stColor}`, borderRadius: 16, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 800, color: C.text, fontSize: 13 }}>
          {AGENT_ICONS[a.name] ?? '🤖'} {a.agent.replace('AGENT_', '')} · {a.name.replace('_', ' ')}
        </div>
        <Badge text={a.status} color={stColor} />
      </div>
      <div style={{ fontSize: 11, color: C.dim, minHeight: 28, marginBottom: 8 }}>{a.role}</div>

      <Bar label="STM (short-term memory)" pct={a.memory?.stm_pct ?? 0} color={C.purple} />
      <Bar label="LTM (PostgreSQL memory)" pct={a.memory?.ltm_pct ?? 0} color={C.blue} />
      <Bar label="CPU (process)" pct={a.cpu_pct ?? 0} color={C.warn} />
      <Bar label="MEM (heap)" pct={a.mem_pct ?? 0} color={C.ok} />

      <div style={{ display: 'flex', gap: 6, margin: '8px 0', flexWrap: 'wrap' }}>
        <Badge text={`MEM ${a.memory_interface}`} color={a.memory_interface === 'IDLE' ? C.dim : C.ok} />
        <Badge text={a.loop_running ? 'LOOP ON' : 'LOOP OFF'} color={a.loop_running ? C.ok : C.warn} />
        {a.missing_tables?.length > 0 && <Badge text={`AWAITS ${a.missing_tables.length} TABLE(S)`} color={C.warn} />}
      </div>

      <div style={{ fontSize: 10, color: C.text, background: '#0b1220', border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 8px', marginBottom: 6 }}>
        <div><span style={{ color: C.dim }}>LIVE:</span> {a.live_action ?? '—'}</div>
        <div><span style={{ color: C.dim }}>HOMEWORK:</span> {a.homework ?? '—'}</div>
        <div>
          <span style={{ color: C.dim }}>TODAY:</span>{' '}
          {a.today.ticks} ticks · {a.today.runs_ok} ok · {a.today.blocked} blocked ·{' '}
          <span style={{ color: a.today.errors ? C.bad : C.ok }}>{a.today.errors} errors</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <Btn label="INJECT" color={C.purple} onClick={() => onAction('inject', a)} />
        <Btn label="BOOK" color={C.blue} onClick={() => onAction('book', a)} />
        <Btn label={a.loop_running ? 'STOP' : 'RESTART'} color={a.loop_running ? C.bad : C.ok}
             onClick={() => onAction(a.loop_running ? 'stop' : 'restart', a)} />
      </div>
    </div>
  );
}

// ── Smart AI Document Scanner dropzone ──────────────────────────────────────
function SmartScanner() {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scan = useCallback(async (file: File) => {
    setBusy(true); setError(null); setResult(null);
    setPreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/api/v1/documents/auto-scan-file`, { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || `HTTP ${res.status}`);
      setResult(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) scan(f);
  };

  const conf = result?.confidence?.effective ?? 0;
  const confPct = Math.round(conf * 100);
  const confColor = conf >= (result?.confidence?.autofile_threshold ?? 0.9) ? C.ok : conf >= 0.6 ? C.warn : C.bad;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, marginTop: 20 }}>
      <h3 style={{ color: C.purple, margin: '0 0 4px' }}>📸 Smart AI Document Scanner</h3>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 12 }}>
        Bilty/POD · E-Way Bill · Fuel Slip · DL · RC · FASTag · Spares Bill — drop it, BHUVANESHWARI (04) reads it,
        validates against PostgreSQL, and auto-files at ≥90% confidence (below that → human review).
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{ border: `2px dashed ${drag ? C.purple : C.line}`, borderRadius: 12, padding: 30, textAlign: 'center',
                 cursor: 'pointer', background: drag ? 'rgba(192,132,252,0.08)' : '#0b1220', transition: 'all .2s' }}>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden
               onChange={(e) => e.target.files?.[0] && scan(e.target.files[0])} />
        <div style={{ fontSize: 28 }}>{busy ? '🔎' : '📄'}</div>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 700 }}>
          {busy ? 'AI scanning… (local Gemma vision)' : 'Drag & drop a bill / receipt / POD — or click to choose'}
        </div>
      </div>

      {(preview || result || error) && (
        <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap' }}>
          {preview && <img src={preview} alt="scan preview" style={{ maxWidth: 180, maxHeight: 220, borderRadius: 10, border: `1px solid ${C.line}`, objectFit: 'contain' }} />}
          <div style={{ flex: 1, minWidth: 260 }}>
            {error && (
              <div style={{ color: C.bad, fontSize: 12, border: `1px dashed ${C.bad}`, borderRadius: 10, padding: 12 }}>
                ⚠️ {error}
              </div>
            )}
            {result && (
              <div style={{ background: '#0b1220', border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, fontSize: 12, color: C.text }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <Badge text={result.doc_type ?? 'UNKNOWN'} color={C.blue} />
                  <Badge text={`CONFIDENCE ${confPct}%`} color={confColor} />
                  {result.filing?.auto_filed
                    ? <Badge text="✔ AUTO-FILED → PostgreSQL" color={C.ok} />
                    : <Badge text={result.duplicate ? 'DUPLICATE' : 'HITL REVIEW'} color={C.warn} />}
                </div>
                <table style={{ width: '100%', fontSize: 11 }}>
                  <tbody>
                    {['invoice_no', 'gstin', 'vehicle_no', 'driver_name', 'freight_amount', 'hsd_litres', 'date', 'consignee', 'signature_present']
                      .filter((k) => result.fields?.[k] !== undefined && result.fields?.[k] !== '')
                      .map((k) => (
                        <tr key={k}>
                          <td style={{ color: C.dim, padding: '2px 8px 2px 0', whiteSpace: 'nowrap' }}>{k}</td>
                          <td style={{ color: C.text }}>{String(result.fields[k])}</td>
                          <td style={{ paddingLeft: 8 }}>
                            {result.validation?.[k === 'vehicle_no' ? 'vehicle' : k === 'driver_name' ? 'driver' : k]?.ok === true && <span style={{ color: C.ok }}>✔ DB</span>}
                            {result.validation?.[k === 'vehicle_no' ? 'vehicle' : k === 'driver_name' ? 'driver' : k]?.ok === false && <span style={{ color: C.bad }}>✖</span>}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <div style={{ color: C.dim, marginTop: 6, fontSize: 10 }}>
                  {result.filing?.reason} · engine {result.engine} · {result.ms}ms
                </div>
                {result.agent_action && <div style={{ color: C.purple, marginTop: 4, fontSize: 10 }}>{result.agent_action}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── main ────────────────────────────────────────────────────────────────────
export default function AgentFleetCommand() {
  const [fleet, setFleet] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/v1/agents/fleet-status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFleet(await res.json());
      setErr(null);
    } catch (e: any) {
      setErr(`Agent API unreachable at ${API} — is \`npm run api\` running? (${e.message})`);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const onAction = async (kind: string, a: any) => {
    try {
      if (kind === 'stop' || kind === 'restart') {
        await fetch(`${API}/api/v1/agents/${a.agent}/loop`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: kind === 'restart' }),
        });
      } else if (kind === 'book') {
        const note = window.prompt(`📘 Book today's homework for ${a.name}:`, a.homework ?? '');
        if (!note) return;
        await fetch(`${API}/api/v1/agents/${a.agent}/homework`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note }),
        });
      } else if (kind === 'inject') {
        const evt = window.prompt(`💉 Inject event for ${a.name} (e.g. ${a.name === 'TARA' ? 'ledger.audit.requested' : 'compliance.sweep.requested'}):`);
        if (!evt) return;
        const res = await fetch(`${API}/api/agents/events`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event_type: evt, aggregate: 'manual', payload: { injected_by: 'COMMAND_CENTER' } }),
        });
        if (!res.ok) alert(`Inject failed: ${(await res.json()).detail ?? res.status}`);
      }
      load();
    } catch (e: any) {
      alert(`Action failed: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: 20, background: C.bg, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ color: C.purple, margin: 0 }}>
          🛡️ AI Agent Fleet Command Center
          <span style={{ fontSize: 11, color: C.ok, border: `1px solid ${C.ok}`, borderRadius: 10, padding: '1px 8px', marginLeft: 8 }}>
            10 MAHAVIDYA · TRANSPORT ONLY
          </span>
        </h2>
        {fleet && (
          <div style={{ fontSize: 11, color: C.dim }}>
            DB {fleet.db_degraded ? <span style={{ color: C.warn }}>DEGRADED</span> : <span style={{ color: C.ok }}>CONNECTED</span>}
            {' · '}proc {fleet.process?.rss_mb}MB · up {fleet.process?.uptime_s}s
          </div>
        )}
      </div>

      {err && (
        <div style={{ marginTop: 14, padding: '12px 16px', background: 'rgba(245,158,11,0.08)', border: `1px dashed ${C.warn}`, borderRadius: 10, fontSize: 12, color: C.warn }}>
          ⚠️ {err}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 14, marginTop: 16 }}>
        {(fleet?.agents ?? []).map((a: any) => <AgentCard key={a.agent} a={a} onAction={onAction} />)}
      </div>

      <SmartScanner />
    </div>
  );
}
