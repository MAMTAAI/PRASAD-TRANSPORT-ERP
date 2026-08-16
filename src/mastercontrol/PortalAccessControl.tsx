// @ts-nocheck
// ============================================================================
// <PortalAccessControl /> — the desk where an admin decides what the outside
// world can see.
//
// TWO CONTROLS, AND THEY ARE NOT THE SAME CONTROL.
//
//   THE GATE (per party)   is_approved_for_portal. Off by default. While it is
//                          off the account gets 403 on every route including
//                          "who am I" — not an empty dashboard, a refusal.
//   THE MATRIX (per role)  which pages and which FIELDS that role may see at
//                          all, set once instead of per customer.
//
// Effective visibility is both ANDed with the party's own feature map. Never
// ORed: a stale per-party flag must not re-open what the role matrix closed, or
// "no vendor sees ledgers" becomes a suggestion.
//
// EVERY TOGGLE HERE IS A LIVE PERMISSION CHANGE, so each one writes an audit row
// naming the admin, and the panel says so rather than feeling like a preference
// screen. Sensitive rows are marked: those are the ones that show money.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, ShieldOff, Lock, Unlock, Users, Truck, Building2, AlertTriangle, History,
} from 'lucide-react';
import {
  GlassPanel, PanelHeader, StatusPill, useHoverCard, HoverTitle, HoverKv, HoverNote,
} from './shared';
import { API_BASE } from '../lib/apiBase';

const ROLES = [
  { key: 'CUSTOMER', label: 'Customer', icon: Building2, accent: 'cyan' },
  { key: 'VENDOR', label: 'Vendor', icon: Users, accent: 'violet' },
  { key: 'DRIVER', label: 'Driver', icon: Truck, accent: 'emerald' },
];

const TONE = {
  cyan: { text: 'text-cyan-300', ring: 'border-cyan-500/50', bg: 'bg-cyan-500/10', on: 'bg-cyan-500' },
  violet: { text: 'text-violet-300', ring: 'border-violet-500/50', bg: 'bg-violet-500/10', on: 'bg-violet-500' },
  emerald: { text: 'text-emerald-300', ring: 'border-emerald-500/50', bg: 'bg-emerald-500/10', on: 'bg-emerald-500' },
};

/** The switch. Disabled while its own request is in flight, because a toggle
 *  that can be clicked twice before the server answers is a race with a
 *  permission on the other end. */
function Toggle({ on, busy, onChange, accent = 'cyan', label }) {
  const t = TONE[accent] ?? TONE.cyan;
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 outline-none
                  focus-visible:ring-2 focus-visible:ring-cyan-400/60 disabled:opacity-40
                  ${on ? t.on : 'bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200
                        ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function ModuleRow({ m, accent, busy, onToggle }) {
  const isField = !!m.parent_key;
  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={isField ? 'Field within a page' : 'Portal page'}>{m.label.trim()}</HoverTitle>
      {m.description && <HoverKv k="Shows" v={m.description} mono={false} />}
      <HoverKv k="Module key" v={m.module_key} />
      <HoverKv strong k="Currently" v={m.is_visible ? 'VISIBLE' : 'HIDDEN'}
               tone={m.is_visible ? 'text-emerald-400' : 'text-slate-500'} />
      {m.sensitive && (
        <HoverNote tone="text-amber-300/90">
          Marked sensitive — this one shows money. It starts closed and stays closed
          until somebody decides otherwise, with their name against the change.
        </HoverNote>
      )}
      {!isField && (
        <HoverNote>
          Closing a page also closes every field inside it. A field left open under a
          hidden page reads as permission and grants nothing.
        </HoverNote>
      )}
    </>
  ), { placement: 'top', width: 300 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className={`touch-manipulation flex items-center gap-2.5 rounded-lg border px-2.5 py-2 outline-none
                    transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-cyan-400/60
                    ${isField ? 'ml-5 border-slate-800/60 bg-white/[0.02]' : 'border-slate-700/60 bg-white/5'}
                    hover:bg-white/10`}
      >
        {m.sensitive
          ? <Lock size={12} className={m.is_visible ? 'text-amber-400' : 'text-slate-600'} />
          : <Unlock size={12} className="text-slate-700" />}
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[11px] font-bold ${m.is_visible ? 'text-slate-100' : 'text-slate-500'}`}>
            {m.label.trim()}
          </p>
          {m.description && <p className="truncate text-[9px] text-slate-600">{m.description}</p>}
        </div>
        {m.sensitive && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-amber-300">
            money
          </span>
        )}
        <Toggle on={m.is_visible} busy={busy} accent={accent} label={m.label}
                onChange={(v) => onToggle(m.module_key, v)} />
      </div>
      {overlay}
    </>
  );
}

export default function PortalAccessControl() {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [detail, setDetail] = useState('');
  const [role, setRole] = useState('CUSTOMER');
  const [busy, setBusy] = useState(null);
  const [audit, setAudit] = useState([]);
  const [showAudit, setShowAudit] = useState(false);

  // Same key UserApprovals reads. Inventing a second token name is how one
  // admin screen works and the one beside it silently 401s.
  const H = useMemo(() => {
    const token = localStorage.getItem('prasad_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/portal-access/matrix`, { headers: H });
      if (r.status === 401 || r.status === 403) {
        setState('forbidden');
        setDetail('This desk is admin-only. Sign in as an admin to change portal access.');
        return;
      }
      if (!r.ok) { setState('error'); setDetail(`API ${r.status}`); return; }
      setData(await r.json());
      setState('ok');
    } catch (e) { setState('error'); setDetail(e.message); }
  }, [H]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (moduleKey, next) => {
    setBusy(moduleKey);
    try {
      const r = await fetch(`${API_BASE}/api/v1/portal-access/${role}/${encodeURIComponent(moduleKey)}`, {
        method: 'PATCH',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ is_visible: next }),
      });
      if (!r.ok) { setDetail(`could not change ${moduleKey} — API ${r.status}`); return; }
      // Re-read rather than patching local state: closing a page cascades to its
      // fields server-side, and guessing what the server did is how a permission
      // screen ends up showing something the server disagrees with.
      await load();
    } finally { setBusy(null); }
  };

  const approveParty = async (partyRole, id, approved) => {
    setBusy(id);
    try {
      await fetch(`${API_BASE}/api/v1/portal-access/party/${partyRole}/${id}/approval`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ approved }),
      });
      await load();
    } finally { setBusy(null); }
  };

  const openAudit = async () => {
    setShowAudit((v) => !v);
    if (!showAudit) {
      const r = await fetch(`${API_BASE}/api/v1/portal-access/audit`, { headers: H });
      if (r.ok) setAudit((await r.json()).rows ?? []);
    }
  };

  if (state === 'loading') {
    // Skeleton, not a spinner: the shape of what is coming reads as "loading"
    // without the page jumping when it arrives.
    return (
      <GlassPanel className="border-slate-700/50">
        <PanelHeader icon={ShieldCheck} title="Portal Access Control" accent="text-slate-400" sub="loading" />
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-white/5" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      </GlassPanel>
    );
  }

  if (state !== 'ok') {
    return (
      <GlassPanel className="border-amber-500/30">
        <PanelHeader icon={AlertTriangle} title="Portal Access Control" accent="text-amber-400"
                     sub={state === 'forbidden' ? 'admin only' : 'not available'} />
        <p className="px-4 pb-4 text-[11px] leading-relaxed text-amber-300/80">{detail}</p>
      </GlassPanel>
    );
  }

  const modules = data.matrix?.[role] ?? [];
  const parties = (data.parties ?? []).filter((p) => p.role === role);
  const gate = (data.gate_summary ?? []).find((g) => g.role === role) ?? { approved: 0, total: 0 };
  const accent = ROLES.find((r) => r.key === role)?.accent ?? 'cyan';
  const t = TONE[accent];

  return (
    <GlassPanel className="border-violet-500/25">
      <PanelHeader
        icon={ShieldCheck}
        title="Portal Access Control"
        accent="text-violet-400"
        sub="what the outside world may see — every change is audited"
        right={
          <button onClick={openAudit}
            className="flex items-center gap-1 rounded-lg border border-slate-600/70 bg-white/5 px-2 py-1
                       text-[10px] font-bold text-slate-300 transition-colors hover:bg-white/10">
            <History size={11} /> {showAudit ? 'hide' : 'log'}
          </button>
        }
      />

      <div className="px-3 pb-3">
        {/* role selector */}
        <div className="mb-3 flex gap-1.5">
          {ROLES.map((r) => {
            const on = r.key === role;
            const rt = TONE[r.accent];
            const g = (data.gate_summary ?? []).find((x) => x.role === r.key) ?? { approved: 0, total: 0 };
            return (
              <button key={r.key} onClick={() => setRole(r.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-2
                            text-[11px] font-bold transition-all duration-150
                            ${on ? `${rt.ring} ${rt.bg} ${rt.text}` : 'border-slate-700/60 text-slate-500 hover:bg-white/5'}`}>
                <r.icon size={13} /> {r.label}
                <span className={`ml-1 rounded px-1 text-[9px] ${g.approved ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700/60 text-slate-400'}`}>
                  {g.approved}/{g.total}
                </span>
              </button>
            );
          })}
        </div>

        {/* THE GATE */}
        <div className={`mb-3 rounded-xl border px-3 py-2.5 ${gate.approved === 0 ? 'border-slate-700/60 bg-white/[0.03]' : `${t.ring} ${t.bg}`}`}>
          <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-300">
            {gate.approved === 0 ? <ShieldOff size={12} className="text-slate-500" /> : <ShieldCheck size={12} className={t.text} />}
            Portal gate — {gate.approved} of {gate.total} approved
          </p>
          <p className="mt-0.5 text-[9.5px] leading-relaxed text-slate-500">
            While a party is off, its account is refused on every route — including “who am I”. Not an
            empty dashboard: a refusal, so nobody mistakes silence for “no data yet”.
          </p>
          <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {parties.length === 0 && <p className="py-1 text-[10px] text-slate-600">No {role.toLowerCase()}s on record.</p>}
            {parties.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-slate-800/60 bg-white/5 px-2 py-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.is_approved_for_portal ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-slate-200">{p.name}</span>
                {p.is_approved_for_portal && p.portal_approved_at && (
                  <span className="shrink-0 text-[8.5px] text-slate-600">
                    since {String(p.portal_approved_at).slice(0, 10)}
                  </span>
                )}
                <Toggle on={p.is_approved_for_portal} busy={busy === p.id} accent={accent}
                        label={`portal access for ${p.name}`}
                        onChange={(v) => approveParty(role, p.id, v)} />
              </div>
            ))}
          </div>
        </div>

        {/* THE MATRIX */}
        <p className="mb-1.5 px-1 text-[9px] font-black uppercase tracking-wider text-slate-600">
          Pages and fields for every {role.toLowerCase()}
        </p>
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {modules.map((m) => (
            <ModuleRow key={m.module_key} m={m} accent={accent} busy={busy === m.module_key} onToggle={toggle} />
          ))}
        </div>

        {showAudit && (
          <div className="mt-2 rounded-xl border border-slate-700/60 bg-slate-950/60 px-3 py-2">
            <p className="mb-1 text-[9px] font-black uppercase tracking-wider text-slate-500">Recent changes</p>
            {audit.length === 0 && <p className="text-[10px] text-slate-600">Nothing changed yet.</p>}
            {audit.slice(0, 12).map((x, i) => (
              <div key={i} className="flex items-baseline gap-2 py-0.5 text-[9.5px]">
                <span className="shrink-0 font-mono text-slate-600">{String(x.created_at).slice(5, 16).replace('T', ' ')}</span>
                <span className={`shrink-0 font-black ${x.now_visible ? 'text-emerald-400' : 'text-red-400'}`}>
                  {x.now_visible ? 'OPEN' : 'SHUT'}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-400">{x.role} · {x.module_key}</span>
                <span className="shrink-0 text-slate-600">{x.actor_name ?? 'unknown'}</span>
              </div>
            ))}
          </div>
        )}

        <p className="mt-2 border-t border-slate-800 pt-1.5 text-[9px] leading-relaxed text-slate-600">
          Hiding a control in the portal is presentation only. Every route is guarded independently on the
          server, and a field the role may not see is never put in the query — a hidden button is not a permission.
        </p>
      </div>
    </GlassPanel>
  );
}
