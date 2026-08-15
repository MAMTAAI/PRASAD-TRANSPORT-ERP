// @ts-nocheck
// ============================================================================
// <LiveStaffTracker /> — who is signed in right now, and what they changed.
//
// Reads GET /api/v1/monitoring/live, which is admin-only. Two things it is
// careful about:
//
//   ONLINE IS A CLAIM WITH A TIMESTAMP. "Online" here means a request stamped
//   last_seen_at within five minutes; anything older shows as an idle duration
//   instead of a green dot. A monitor that shows a permanent green light for
//   everyone who ever logged in is worse than no monitor, because it is
//   believed.
//
//   ACTIONS ARE WRITES THAT LANDED. The feed comes from audit_logs (stamped
//   server-side on every mutating route) filtered to status < 400 — not from
//   activity_logs, which the SPA writes about itself and can simply omit.
//
// A non-admin gets a plain "restricted" state rather than an error card: the
// 403 is the correct answer, not a fault.
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Radar, ShieldOff, History, Users, AlertTriangle } from 'lucide-react';
import { GlassPanel, PanelHeader, StatusPill, Dot, Avatar } from './shared';
import { API_BASE } from '../lib/apiBase';

const REFRESH_MS = 20000;   // faster than the books; this is a presence view

/** "just now" / "4m idle" / "2h idle" */
function idleLabel(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m idle`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h idle`;
  return `${Math.floor(seconds / 86400)}d idle`;
}

function clockOf(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '--:--'; }
}

const ROLE_TONE = {
  SUPER_ADMIN: 'violet', ADMIN: 'cyan', ACCOUNTS: 'emerald',
  DISPATCH: 'amber', DRIVER: 'cyan', CUSTOMER: 'violet', VENDOR: 'amber', VIEWER: 'slate',
};

export default function LiveStaffTracker() {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');   // loading | ok | restricted | error
  const [detail, setDetail] = useState('');

  const load = useCallback(async () => {
    try {
      const token = localStorage.getItem('prasad_token');
      if (!token) { setState('restricted'); return; }
      const res = await fetch(`${API_BASE}/api/v1/monitoring/live?minutes=120`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403 || res.status === 401) { setState('restricted'); return; }
      if (!res.ok) { setState('error'); setDetail(`API ${res.status}`); return; }
      setData(await res.json());
      setState('ok');
    } catch (e) {
      setState('error');
      setDetail(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (state === 'restricted') {
    return (
      <GlassPanel>
        <PanelHeader icon={ShieldOff} title="Live Staff Monitor" accent="text-slate-400" sub="Admin only" />
        <div className="px-4 pb-4 text-[11px] text-slate-500">
          This view is restricted to owner-level accounts.
        </div>
      </GlassPanel>
    );
  }

  if (state === 'error') {
    return (
      <GlassPanel className="border-amber-500/30">
        <PanelHeader icon={AlertTriangle} title="Live Staff Monitor" accent="text-amber-400" sub="Not available" />
        <div className="px-4 pb-4 text-[11px] text-amber-300/80">
          Monitoring feed unreachable — {detail}. No figures are shown rather than stale ones.
        </div>
      </GlassPanel>
    );
  }

  const totals = data?.totals ?? {};
  const sessions = data?.sessions ?? [];
  const actions = data?.actions ?? [];

  return (
    <GlassPanel className="border-cyan-500/25">
      <PanelHeader
        icon={Radar}
        title="Live Staff Monitor"
        accent="text-cyan-400"
        sub={`Sessions & audit trail · last ${data?.window_minutes ?? 120}m`}
        right={
          <StatusPill tone={totals.online_now > 0 ? 'emerald' : 'slate'} pulse={totals.online_now > 0}>
            {totals.online_now ?? 0} online
          </StatusPill>
        }
      />

      <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── who is here ─────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Users size={11} className="text-slate-500" />
            <span className="text-[9px] font-black uppercase tracking-wider text-slate-600">
              Sessions ({totals.sessions_open ?? 0} open)
            </span>
          </div>
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
            {sessions.length === 0 && (
              <p className="text-[11px] text-slate-600 py-3">No open sessions.</p>
            )}
            {sessions.map((s, i) => (
              <div
                key={`${s.name}-${s.since}-${i}`}
                className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2
                  ${s.online ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-white/5 border-slate-800/60'}`}
              >
                <Avatar name={s.name} size="w-8 h-8" textSize="text-[10px]"
                        ring={s.online ? 'ring-emerald-400/70' : 'ring-slate-700/60'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-slate-100 truncate">{s.name}</span>
                    {s.online && <Dot color="bg-emerald-400" pulse size="w-1.5 h-1.5" />}
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] text-slate-500">
                    <span className="font-bold text-slate-400">{String(s.role || '').replace(/_/g, ' ')}</span>
                    {s.branch && <span>· {s.branch}</span>}
                    <span>· {s.device}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[9px] font-mono text-slate-400">{s.ip ?? '—'}</div>
                  <div className={`text-[9px] font-bold ${s.online ? 'text-emerald-400' : 'text-slate-600'}`}>
                    {idleLabel(s.idle_seconds)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── what they did ───────────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <History size={11} className="text-slate-500" />
              <span className="text-[9px] font-black uppercase tracking-wider text-slate-600">
                Recent actions ({totals.writes_window ?? 0})
              </span>
            </div>
            {totals.rejected_window > 0 && (
              <span className="text-[9px] font-bold text-amber-400/80">
                {totals.rejected_window} rejected
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-1">
            {actions.length === 0 && (
              <p className="text-[11px] text-slate-600 py-3">
                No write actions recorded in this window.
              </p>
            )}
            {actions.map((a, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-white/5 border border-slate-800/60 px-2.5 py-1.5">
                <span className="text-[9px] font-mono text-slate-600 shrink-0">{clockOf(a.at)}</span>
                <span className="text-[10px] font-bold text-slate-200 truncate min-w-0 flex-1">
                  {a.who}
                  <span className="font-normal text-slate-500"> — {a.what}</span>
                </span>
                {a.has_diff && (
                  <span title="before/after captured"
                        className="text-[8px] font-black text-cyan-400/80 shrink-0">DIFF</span>
                )}
                <span className="text-[9px] font-mono text-slate-600 shrink-0">{a.ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}
