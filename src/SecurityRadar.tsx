// ═══════════════════════════════════════════════════════════════════════════
//  SECURITY RADAR · SOC  —  Phase-0 SHADOW (observe-only) — Prasad Transport
//
//  Live threat + bug radar for the PRASAD PRO dashboard. Polls the AI bridge's
//  GET /security/radar (aggregated `security_events`) and renders THREATS (red)
//  and BUGS (yellow) with IP / file:line, category, source company, action, and
//  AI-fix log. Same widget contract as the Jaiswal Capital SOC radar — one SOC
//  covers BOTH infrastructures (source chip: PT / JC).
//
//  Phase-0 = OBSERVE ONLY: capture + classify + display. Active-defense IP bans
//  and the auto kill-switch are God-gated (armState flips them on). This widget
//  never fires anything — it is a read-only radar.
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BRIDGE_URL, LLM_AUTH_TOKEN } from './lib/llm/config';

interface SecEvent {
  id: string;
  ts: string;
  kind: 'threat' | 'bug';
  severity: 'critical' | 'high' | 'med' | 'low';
  source: 'jaiswal' | 'prasad';
  sensor: string;
  category: string;
  ip?: string;
  method?: string;
  path?: string;
  botId?: string;
  symbol?: string;
  file?: string;
  line?: number;
  message?: string;
  action?: string;
  acked?: boolean;
  remediation?: { proposal?: string; status?: string; by?: string };
}

interface KillState { active: boolean; by?: string; ts?: string; }

interface RadarData {
  status: string;
  armState: string;
  kill?: KillState;
  config?: { strikeThreshold: number; windowMin: number; armed: boolean };
  counts: {
    threatsToday: number;
    bugsToday: number;
    bySeverity: Record<string, number>;
    bannedIps: number;
    wouldBan?: number;
  };
  events: SecEvent[];
  banned: Array<{ ip: string; reason?: string; ts?: string }>;
  wouldBan?: Array<{ ip: string; reason?: string; ts?: string }>;
}

// Bridge fetch helpers — X-PT-Token gated, hard timeout, never throw.
const radarHeaders = (): Record<string, string> =>
  LLM_AUTH_TOKEN ? { 'X-PT-Token': LLM_AUTH_TOKEN } : {};

async function radarGet<T>(path: string, timeoutMs = 10000): Promise<{ ok: boolean; data?: T; error?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, { headers: radarHeaders(), signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network error' };
  } finally {
    clearTimeout(t);
  }
}

async function radarPost(path: string, body: unknown): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...radarHeaders() },
      body: JSON.stringify(body),
    });
  } catch { /* observe-only widget — ack failures are non-fatal */ }
}

const SEV_COLOR: Record<string, string> = {
  critical: '#ff6b81',
  high: '#f97316',
  med: '#fbbf24',
  low: '#5d7196',
};

const fmtTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return iso;
  }
};

export const SecurityRadar: React.FC = () => {
  const [data, setData] = useState<RadarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpd, setLastUpd] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'threat' | 'bug'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const r = await radarGet<RadarData>('/security/radar');
    if (r.ok && r.data) {
      setData(r.data);
      setError(null);
      setLastUpd(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    } else {
      setError(r.error || 'radar unreachable');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 20000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const ack = async (id: string) => {
    await radarPost('/security/ack', { id });
    load();
  };

  const kill = data?.kill;
  const [busy, setBusy] = useState(false);

  // 🔴 Manual "fight back" control. ENGAGE double-confirms (this halts the
  // business) and sends confirm:"HALT". RELEASE resumes. Never automatic.
  const toggleKill = async () => {
    const engaging = !kill?.active;
    const who = (() => {
      try { return JSON.parse(localStorage.getItem('prasad_user') || '{}').full_name || 'God'; }
      catch { return 'God'; }
    })();
    if (engaging && !window.confirm('⚠️ ENGAGE KILL-SWITCH?\n\nThis HALTS AI, uploads and payout across the system until you release it. Proceed?')) return;
    setBusy(true);
    await radarPost('/security/killswitch', { active: engaging, confirm: engaging ? 'HALT' : undefined, by: who });
    setBusy(false);
    load();
  };

  const c = data?.counts;
  const events = (data?.events || []).filter(e => filter === 'all' ? true : e.kind === filter);
  const arm = data?.armState || 'OBSERVE';
  const critHigh = (c?.bySeverity?.critical || 0) + (c?.bySeverity?.high || 0);

  return (
    <div className="sr-root">
      <style>{CSS}</style>

      <div className="sr-head">
        <div className="sr-title">
          <span className="sr-shield">🛡️</span>
          <span>SECURITY RADAR</span>
          <span className="sr-soc">· SOC</span>
          <span className={`sr-arm sr-arm-${arm.toLowerCase()}`}>{arm}</span>
          {!error && <span className="sr-live"><span className="sr-dot" /> LIVE</span>}
        </div>
        <div className="sr-head-r">
          {lastUpd && <span className="sr-upd">⟳ {lastUpd}</span>}
          <button className="sr-refresh" onClick={load}>Refresh</button>
          <button
            className={`sr-kill ${kill?.active ? 'sr-kill-on' : ''}`}
            disabled={busy}
            onClick={toggleKill}
            title="Manual kill-switch — halts AI/uploads/payout across the system"
          >
            {kill?.active ? '▶ RELEASE' : '🔴 HALT & SQUARE-OFF'}
          </button>
        </div>
      </div>

      {kill?.active && (
        <div className="sr-kill-banner">
          🔴 SYSTEM HALTED by {kill.by || 'God'} — sensitive endpoints are returning 503.
          Press <b>RELEASE</b> to resume.
        </div>
      )}

      <div className="sr-note">
        {arm === 'ARMED'
          ? <>Phase-1 <b>ARMED</b> — IP bans are being <b>enforced</b> (403 at the edge).</>
          : <>Phase-1 <b>SHADOW</b> — strike counter logs <b>would-ban</b> decisions but blocks nothing yet
             (arm with <code>SOC_ARM=1</code> after a clean session). </>}
        {' '}Kill-switch is <b>manual only</b>. Covers Prasad Transport + Jaiswal Capital.
      </div>

      {error ? (
        <div className="sr-err">⚠️ Radar feed error: {error} — showing last known state.</div>
      ) : null}

      <div className="sr-tiles">
        <div className="sr-tile">
          <div className="sr-tile-lbl">THREATS TODAY</div>
          <div className="sr-tile-val" style={{ color: (c?.threatsToday || 0) > 0 ? '#ff6b81' : '#2fe39b' }}>
            {c?.threatsToday ?? (loading ? '…' : 0)}
          </div>
        </div>
        <div className="sr-tile">
          <div className="sr-tile-lbl">BUGS TODAY</div>
          <div className="sr-tile-val" style={{ color: (c?.bugsToday || 0) > 0 ? '#fbbf24' : '#2fe39b' }}>
            {c?.bugsToday ?? (loading ? '…' : 0)}
          </div>
        </div>
        <div className="sr-tile">
          <div className="sr-tile-lbl">CRITICAL / HIGH</div>
          <div className="sr-tile-val" style={{ color: critHigh > 0 ? '#f97316' : '#2fe39b' }}>{critHigh}</div>
        </div>
        <div className="sr-tile">
          <div className="sr-tile-lbl">{arm === 'ARMED' ? 'IPs BANNED' : 'IPs WOULD-BAN'}</div>
          <div className="sr-tile-val" style={{ color: arm === 'ARMED' ? '#ff6b81' : '#22d3ee' }}>
            {arm === 'ARMED' ? (c?.bannedIps ?? 0) : (c?.wouldBan ?? 0)}
          </div>
        </div>
      </div>

      <div className="sr-filter">
        {(['all', 'threat', 'bug'] as const).map(f => (
          <button key={f} className={`sr-fbtn ${filter === f ? 'sr-fbtn-on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'threat' ? '🔴 Threats' : '🟡 Bugs'}
          </button>
        ))}
      </div>

      <div className="sr-feed">
        {events.length === 0 ? (
          <div className="sr-empty">
            {loading ? 'Loading security events…' : '✓ No security events — all clear.'}
          </div>
        ) : (
          events.map(e => {
            const isBug = e.kind === 'bug';
            const loc = isBug
              ? (e.file ? `${e.file}${e.line ? ':' + e.line : ''}` : (e.botId || '—'))
              : (e.ip || '—');
            const open = expanded === e.id;
            return (
              <div key={e.id} className={`sr-row ${e.acked ? 'sr-row-ack' : ''}`}>
                <div className="sr-row-main" onClick={() => setExpanded(open ? null : e.id)}>
                  <span className="sr-sev" style={{ background: SEV_COLOR[e.severity] || '#5d7196' }} />
                  <span className={`sr-badge ${isBug ? 'sr-badge-bug' : 'sr-badge-threat'}`}>
                    {isBug ? 'BUG' : 'THREAT'}
                  </span>
                  <span className="sr-cat">{e.category || '—'}</span>
                  <span className={`sr-src sr-src-${e.source}`}>{e.source === 'prasad' ? 'PT' : 'JC'}</span>
                  <span className="sr-loc" title={loc}>{loc}</span>
                  <span className="sr-msg">{e.message || ''}</span>
                  <span className="sr-time">{fmtTime(e.ts)}</span>
                </div>
                {open && (
                  <div className="sr-detail">
                    <div className="sr-drow"><b>Severity</b><span style={{ color: SEV_COLOR[e.severity] }}>{e.severity}</span></div>
                    <div className="sr-drow"><b>Sensor</b><span>{e.sensor || '—'}</span></div>
                    {e.method || e.path ? <div className="sr-drow"><b>Request</b><span>{e.method} {e.path}</span></div> : null}
                    {e.ip ? <div className="sr-drow"><b>IP</b><span>{e.ip}</span></div> : null}
                    {isBug && e.file ? <div className="sr-drow"><b>Location</b><span>{e.file}:{e.line}</span></div> : null}
                    {e.botId ? <div className="sr-drow"><b>Bot</b><span>{e.botId} {e.symbol}</span></div> : null}
                    <div className="sr-drow"><b>Action</b><span>{e.action || 'logged'}</span></div>
                    <div className="sr-drow"><b>AI Fix</b>
                      <span className="sr-fix">
                        {e.remediation?.proposal
                          ? `${e.remediation.proposal} (${e.remediation.status || 'proposed'})`
                          : 'MAMTA AI: analysis pending — proposals appear here (apply is God-gated).'}
                      </span>
                    </div>
                    {!e.acked && <button className="sr-ackbtn" onClick={() => ack(e.id)}>Acknowledge</button>}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SecurityRadar;

const CSS = `
.sr-root{background:#0d1117;border:1px solid #1e2333;border-radius:12px;padding:16px 18px;margin:0 0 14px;font-family:Inter,system-ui,sans-serif;color:#e6edf3;}
.sr-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px;flex-wrap:wrap;}
.sr-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;letter-spacing:.02em;}
.sr-shield{font-size:16px;}
.sr-soc{color:#5d7196;font-weight:600;}
.sr-arm{font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 8px;border-radius:6px;border:1px solid;}
.sr-arm-observe{color:#22d3ee;border-color:#164e63;background:#0b2b33;}
.sr-arm-armed{color:#ff6b81;border-color:#7f1d1d;background:#2b0b0b;}
.sr-live{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#2fe39b;letter-spacing:.06em;margin-left:2px;}
.sr-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #2fe39b;animation:srpulse 1.6s infinite;}
@keyframes srpulse{0%,100%{opacity:1}50%{opacity:.35}}
.sr-head-r{display:flex;align-items:center;gap:10px;}
.sr-upd{font-size:11px;color:#5d7196;}
.sr-refresh{background:#161b22;border:1px solid #2a2e39;color:#9aadd4;border-radius:6px;padding:4px 12px;font-size:11px;cursor:pointer;}
.sr-refresh:hover{border-color:#3b82f6;color:#e6edf3;}
.sr-kill{background:#2b0b0b;border:1px solid #7f1d1d;color:#fca5a5;border-radius:6px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:.03em;}
.sr-kill:hover{background:#3b0f0f;border-color:#ff6b81;color:#fff;}
.sr-kill:disabled{opacity:.5;cursor:wait;}
.sr-kill-on{background:#10b981;border-color:#2fe39b;color:#04120c;}
.sr-kill-on:hover{background:#34d399;color:#04120c;}
.sr-kill-banner{background:#2b0b0b;border:1px solid #ff6b81;color:#fecaca;border-radius:8px;padding:9px 12px;margin:8px 0;font-size:12px;font-weight:600;animation:srpulse 2s infinite;}
.sr-note{font-size:11px;color:#8b949e;background:#0a1024;border:1px solid #1e2333;border-radius:8px;padding:7px 10px;margin:10px 0;}
.sr-note b{color:#c9d1d9;}
.sr-err{font-size:12px;color:#fca5a5;background:#2b0f0f;border:1px solid #7f1d1d;border-radius:8px;padding:8px 10px;margin-bottom:10px;}
.sr-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px;}
.sr-tile{background:#0a1024;border:1px solid #1e2333;border-radius:10px;padding:12px 14px;}
.sr-tile-lbl{font-size:9px;letter-spacing:.1em;color:#5d7196;font-weight:700;margin-bottom:6px;}
.sr-tile-val{font-size:26px;font-weight:800;line-height:1;}
.sr-filter{display:flex;gap:6px;margin-bottom:8px;}
.sr-fbtn{background:#0a1024;border:1px solid #1e2333;color:#8b949e;border-radius:7px;padding:4px 12px;font-size:11px;cursor:pointer;}
.sr-fbtn-on{border-color:#3b82f6;color:#e6edf3;background:#0d1b2e;}
.sr-feed{max-height:340px;overflow-y:auto;border:1px solid #161b22;border-radius:10px;background:#080b12;}
.sr-empty{padding:26px;text-align:center;color:#5d7196;font-size:13px;}
.sr-row{border-bottom:1px solid #131722;}
.sr-row:last-child{border-bottom:none;}
.sr-row-ack{opacity:.5;}
.sr-row-main{display:grid;grid-template-columns:10px 62px 110px 34px 150px 1fr 62px;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;font-size:12px;}
.sr-row-main:hover{background:#0d1420;}
.sr-sev{width:9px;height:9px;border-radius:50%;}
.sr-badge{font-size:9px;font-weight:800;letter-spacing:.05em;padding:2px 6px;border-radius:5px;text-align:center;}
.sr-badge-threat{background:#2b0b0b;color:#ff6b81;border:1px solid #7f1d1d;}
.sr-badge-bug{background:#2b2408;color:#fbbf24;border:1px solid #78560a;}
.sr-cat{color:#c9d1d9;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sr-src{font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;text-align:center;}
.sr-src-jaiswal{background:#0b2b33;color:#22d3ee;}
.sr-src-prasad{background:#2a1533;color:#a78bfa;}
.sr-loc{color:#9aadd4;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sr-msg{color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sr-time{color:#5d7196;font-size:10px;text-align:right;font-family:ui-monospace,monospace;}
.sr-detail{padding:8px 14px 12px 34px;background:#0a0f18;font-size:12px;display:flex;flex-direction:column;gap:5px;}
.sr-drow{display:grid;grid-template-columns:80px 1fr;gap:10px;}
.sr-drow b{color:#5d7196;font-weight:600;font-size:11px;}
.sr-drow span{color:#c9d1d9;}
.sr-fix{color:#7ee787 !important;font-style:italic;}
.sr-ackbtn{align-self:flex-start;margin-top:4px;background:#161b22;border:1px solid #2a2e39;color:#9aadd4;border-radius:6px;padding:3px 12px;font-size:11px;cursor:pointer;}
.sr-ackbtn:hover{border-color:#2fe39b;color:#7ee787;}
@media(max-width:900px){
  .sr-tiles{grid-template-columns:repeat(2,1fr);}
  .sr-row-main{grid-template-columns:10px 54px 1fr 46px;grid-template-areas:'sev badge cat time';}
  .sr-src,.sr-loc,.sr-msg{display:none;}
}
`;
