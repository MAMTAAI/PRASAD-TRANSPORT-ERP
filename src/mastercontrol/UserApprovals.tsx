// @ts-nocheck
// ============================================================================
// <UserApprovals /> — "User Approvals & Access".
//
// One toggle per account: ON = ACTIVE, OFF = SUSPENDED. A PENDING account shows
// its toggle off with an "approve" affordance, because approving and restoring
// are the same action from the office's point of view — let this person in.
//
// OPTIMISTIC, BUT NOT DISHONEST. The switch moves immediately and rolls back if
// the server refuses. It does not pretend a refusal succeeded: the API can and
// does say no (suspending yourself, or the last active admin), and a toggle
// that silently stays flipped would tell the boss they had revoked someone who
// still has full access.
//
// Revocation is immediate on the server — auth_sessions rows are deleted and
// requireAuth re-reads account_status on every request — so the "online" dot
// going dark after a suspend is real, not cosmetic.
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, UserCheck, Clock, AlertTriangle, Search } from 'lucide-react';
import { GlassPanel, PanelHeader, StatusPill, Dot, Avatar } from './shared';
import { API_BASE } from '../lib/apiBase';

const REFRESH_MS = 30000;

const ROLE_TONE = {
  SUPER_ADMIN: 'violet', ADMIN: 'cyan', ACCOUNTS: 'emerald', DISPATCH: 'amber',
  DRIVER: 'cyan', CUSTOMER: 'violet', VENDOR: 'amber', VIEWER: 'slate',
};

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The switch itself. Controlled, disabled while in flight. */
function Toggle({ on, busy, onChange, title }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={title}
      disabled={busy}
      onClick={() => onChange(!on)}
      style={{
        position: 'relative', width: 44, height: 24, borderRadius: 999, border: 'none',
        cursor: busy ? 'wait' : 'pointer', flexShrink: 0,
        background: on ? '#10b981' : '#3d548a',
        opacity: busy ? 0.55 : 1, transition: 'background .18s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left .18s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }} />
    </button>
  );
}

export default function UserApprovals() {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');   // loading | ok | restricted | error
  const [detail, setDetail] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const token = localStorage.getItem('prasad_token');
      if (!token) { setState('restricted'); return; }
      const res = await fetch(`${API_BASE}/api/v1/auth/approvals`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) { setState('restricted'); return; }
      if (!res.ok) { setState('error'); setDetail(`API ${res.status}`); return; }
      setData(await res.json());
      setState('ok');
    } catch (e) { setState('error'); setDetail(e.message); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const setStatus = useCallback(async (u, next) => {
    setBusyId(u.id);
    setNote(null);
    // optimistic
    setData((d) => ({
      ...d,
      users: d.users.map((x) => (x.id === u.id ? { ...x, account_status: next } : x)),
    }));
    try {
      const token = localStorage.getItem('prasad_token');
      const res = await fetch(`${API_BASE}/api/v1/auth/users/${u.id}/account-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ account_status: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Roll the switch back to what the server still believes.
        setData((d) => ({
          ...d,
          users: d.users.map((x) => (x.id === u.id ? { ...x, account_status: u.account_status } : x)),
        }));
        setNote({ tone: 'warn', text: body.detail || body.error || `Refused (HTTP ${res.status})` });
        return;
      }
      setNote({
        tone: 'ok',
        text: next === 'ACTIVE'
          ? `${u.full_name} approved — access granted.`
          : `${u.full_name} suspended — sessions ended immediately.`,
      });
      load();
    } catch (e) {
      setData((d) => ({
        ...d,
        users: d.users.map((x) => (x.id === u.id ? { ...x, account_status: u.account_status } : x)),
      }));
      setNote({ tone: 'warn', text: e.message });
    } finally {
      setBusyId(null);
    }
  }, [load]);

  if (state === 'restricted') {
    return (
      <GlassPanel>
        <PanelHeader icon={ShieldOff} title="User Approvals & Access" accent="text-slate-400" sub="Admin only" />
        <div className="px-4 pb-4 text-[11px] text-slate-500">
          Restricted to owner-level accounts.
        </div>
      </GlassPanel>
    );
  }
  if (state === 'error') {
    return (
      <GlassPanel className="border-amber-500/30">
        <PanelHeader icon={AlertTriangle} title="User Approvals & Access" accent="text-amber-400" sub="Not available" />
        <div className="px-4 pb-4 text-[11px] text-amber-300/80">Approvals feed unreachable — {detail}.</div>
      </GlassPanel>
    );
  }

  const totals = data?.totals ?? {};
  const pending = totals.PENDING ?? 0;
  const needle = q.trim().toLowerCase();
  const users = (data?.users ?? []).filter(
    (u) => !needle
      || String(u.full_name ?? '').toLowerCase().includes(needle)
      || String(u.email ?? '').toLowerCase().includes(needle)
      || String(u.role ?? '').toLowerCase().includes(needle));

  return (
    <GlassPanel className={pending > 0 ? 'border-amber-500/40' : 'border-emerald-500/25'}>
      <PanelHeader
        icon={UserCheck}
        title="User Approvals & Access"
        accent={pending > 0 ? 'text-amber-400' : 'text-emerald-400'}
        sub={`${totals.ACTIVE ?? 0} active · ${totals.SUSPENDED ?? 0} suspended`}
        right={
          <StatusPill tone={pending > 0 ? 'amber' : 'emerald'} pulse={pending > 0}>
            {pending > 0 ? `${pending} awaiting approval` : 'no queue'}
          </StatusPill>
        }
      />

      <div className="px-4 pb-4">
        {note && (
          <div className={`mb-2 rounded-lg px-3 py-2 text-[11px] font-semibold border
            ${note.tone === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
              : 'bg-amber-500/10 border-amber-500/40 text-amber-300'}`}>
            {note.text}
          </div>
        )}

        <div className="relative mb-2">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name, email or role…"
            className="w-full rounded-lg bg-slate-900/70 border border-slate-800 pl-7 pr-3 py-1.5 text-[11px] text-slate-200 outline-none focus:border-cyan-600/60"
          />
        </div>

        <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto pr-1">
          {users.length === 0 && <p className="text-[11px] text-slate-600 py-3">No accounts match.</p>}
          {users.map((u) => {
            const st = u.account_status;
            const on = st === 'ACTIVE';
            return (
              <div
                key={u.id}
                className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2
                  ${st === 'PENDING' ? 'bg-amber-500/10 border-amber-500/40'
                    : st === 'SUSPENDED' ? 'bg-red-500/5 border-red-500/25'
                    : 'bg-white/5 border-slate-800/60'}`}
              >
                <Avatar name={u.full_name} size="w-8 h-8" textSize="text-[10px]"
                        ring={on ? 'ring-emerald-400/60' : 'ring-slate-700/60'} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-slate-100 truncate">{u.full_name}</span>
                    {u.online && <Dot color="bg-emerald-400" pulse size="w-1.5 h-1.5" />}
                  </div>
                  <div className="text-[9px] text-slate-500 truncate">
                    <span className="font-bold text-slate-400">{String(u.role || '').replace(/_/g, ' ')}</span>
                    {u.email && <span> · {u.email}</span>}
                    {u.branch && <span> · {u.branch}</span>}
                  </div>
                </div>

                <div className="text-right shrink-0 hidden sm:block">
                  {st === 'PENDING' ? (
                    <span className="flex items-center gap-1 text-[9px] font-bold text-amber-400">
                      <Clock size={9} /> registered {ago(u.created_at)}
                    </span>
                  ) : (
                    <span className="text-[9px] text-slate-600">
                      {u.last_login_at ? `last in ${ago(u.last_login_at)}` : 'never signed in'}
                    </span>
                  )}
                </div>

                <span className={`text-[8.5px] font-black shrink-0 w-[62px] text-right
                  ${st === 'ACTIVE' ? 'text-emerald-400' : st === 'PENDING' ? 'text-amber-400' : 'text-red-400'}`}>
                  {st}
                </span>

                <Toggle
                  on={on}
                  busy={busyId === u.id}
                  title={on ? 'Suspend access' : st === 'PENDING' ? 'Approve this account' : 'Restore access'}
                  onChange={(nextOn) => setStatus(u, nextOn ? 'ACTIVE' : 'SUSPENDED')}
                />
              </div>
            );
          })}
        </div>

        <p className="mt-2 text-[9px] text-slate-600 flex items-center gap-1.5">
          <ShieldCheck size={9} className="text-emerald-500" />
          Suspending ends every open session at once; the account is re-checked on every request.
        </p>
      </div>
    </GlassPanel>
  );
}
