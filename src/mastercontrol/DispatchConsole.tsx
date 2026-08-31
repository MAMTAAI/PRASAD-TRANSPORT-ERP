// @ts-nocheck
// ============================================================================
// DISPATCH CONSOLE — the full-screen rebuild of Live Dispatch Chat (2026-08-31)
//
// The old panel was a 3/12 grid cell capped at 500px, riding on the 8-second
// dashboard poll, showing 24 threads × 20 messages, printing "📎 Document"
// labels for media it could never open, and linking nothing to anything.
//
// This console is the module the mandate asked for:
//   · THREE PANES. Contexts + threads | the conversation | the record panel.
//     Tabs are the DATABASE's answer to who a number is (contactDirectory),
//     not a browser guess.
//   · INLINE MEDIA. The engine now downloads inbound photos/PDFs into the
//     vault; bubbles render images inline and open PDFs in an in-console
//     viewer — no download round-trip, no "send it again to the other number".
//   · STRUCTURED RECORDS. Every message can be pinned to a trip, a vehicle or
//     an expense (PATCH /crm/chats/:id/link) — searched live, verified
//     server-side, shown as a badge on the bubble and summarised per thread.
//   · ITS OWN DATA PATH. /crm/threads + /crm/chats?phone, polled at 5s only
//     while the console is open — the dashboard's embed is untouched.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Search, Send, Loader2, FileText, Link2, Truck, Package, ReceiptText,
  Paperclip, ChevronRight, RefreshCw, User, Image as ImageIcon,
} from 'lucide-react';
import { API_BASE } from '../lib/apiBase';

const authed = async (path, opts = {}) => {
  const token = localStorage.getItem('prasad_token');
  const headers = { ...(opts.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API_BASE}/api/v1${path}`, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* stream/empty */ }
  return { ok: r.ok, status: r.status, body };
};

const TABS = [
  ['ALL', 'All'], ['DRIVER', 'Driver'], ['PUMP', 'Pump'],
  ['VENDOR', 'Vendor'], ['CUSTOMER', 'Customer'], ['UNKNOWN', 'Anjaan'],
];
const KIND_TONE = {
  DRIVER: 'text-cyan-300 bg-cyan-400/10 border-cyan-400/25',
  PUMP: 'text-orange-300 bg-orange-400/10 border-orange-400/25',
  VENDOR: 'text-violet-300 bg-violet-400/10 border-violet-400/25',
  CUSTOMER: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/25',
  CONTACT: 'text-sky-300 bg-sky-400/10 border-sky-400/25',
  UNKNOWN: 'text-white/50 bg-white/5 border-white/10',
};

const clock = (ts) => { try { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const day = (ts) => { try { return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return ''; } };

// Media bytes need the bearer token, so every preview is a blob fetch. URLs
// are cached per key for the life of the console and revoked on close.
function useMediaBlob() {
  const cache = useRef(new Map());
  useEffect(() => () => { for (const u of cache.current.values()) URL.revokeObjectURL(u); }, []);
  return useCallback(async (key) => {
    if (cache.current.has(key)) return cache.current.get(key);
    const token = localStorage.getItem('prasad_token');
    const r = await fetch(`${API_BASE}/api/v1/files/${key}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) return null;
    const u = URL.createObjectURL(await r.blob());
    cache.current.set(key, u);
    return u;
  }, []);
}

// An <img> that fetches with the token. Inline, clickable to the big viewer.
function ChatImage({ mediaKey, onOpen, getBlob }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { let on = true; getBlob(mediaKey).then((u) => on && setSrc(u)); return () => { on = false; }; }, [mediaKey, getBlob]);
  if (!src) return <div className="h-36 w-48 animate-pulse rounded-xl bg-white/10" />;
  return (
    <img src={src} alt="attachment" onClick={() => onOpen({ kind: 'image', src })}
      className="max-h-64 max-w-full cursor-zoom-in rounded-xl border border-white/10 object-contain" />
  );
}

export default function DispatchConsole({ onClose }) {
  const [tab, setTab] = useState('ALL');
  const [q, setQ] = useState('');
  const [threads, setThreads] = useState(null);
  const [counts, setCounts] = useState({});
  const [active, setActive] = useState(null);          // thread row
  const [msgs, setMsgs] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [viewer, setViewer] = useState(null);          // {kind:'image'|'pdf', src, name}
  const [linkFor, setLinkFor] = useState(null);        // message being linked
  const getBlob = useMediaBlob();
  const bottomRef = useRef(null);

  const loadThreads = useCallback(async () => {
    const p = new URLSearchParams();
    if (tab !== 'ALL') p.set('kind', tab);
    if (q) p.set('q', q);
    const r = await authed(`/crm/threads?${p}`);
    if (r.ok) { setThreads(r.body.threads ?? []); if (!q && tab === 'ALL') setCounts(r.body.counts ?? {}); }
  }, [tab, q]);

  const loadMsgs = useCallback(async (phone) => {
    const r = await authed(`/crm/chats?phone=${encodeURIComponent(phone)}&limit=300`);
    if (r.ok) setMsgs(r.body.chats ?? []);
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);
  useEffect(() => {
    if (!active) return;
    setMsgs(null);
    loadMsgs(active.phone);
  }, [active?.phone]); // eslint-disable-line react-hooks/exhaustive-deps

  // A 5s heartbeat only while the console is open — the chat should feel live
  // without making the whole dashboard poll faster.
  useEffect(() => {
    const t = setInterval(() => {
      loadThreads();
      if (active) loadMsgs(active.phone);
    }, 5000);
    return () => clearInterval(t);
  }, [loadThreads, loadMsgs, active]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length, active?.phone]);

  // Esc closes viewer → link popover → console, in that order.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (viewer) setViewer(null);
      else if (linkFor) setLinkFor(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewer, linkFor, onClose]);

  const send = async () => {
    const body = text.trim();
    if (!body || !active) return;
    setSending(true); setErr('');
    const r = await authed('/crm/send', {
      method: 'POST',
      body: JSON.stringify({ phone: active.phone, text: body }),
    });
    setSending(false);
    if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `send failed (${r.status})`); return; }
    setText('');
    setTimeout(() => loadMsgs(active.phone), 900);   // engine logs the row
  };

  const openPdf = async (m) => {
    const src = await getBlob(m.media_key);
    if (src) setViewer({ kind: 'pdf', src, name: m.media_filename ?? 'document.pdf' });
  };

  const applyLink = async (msgId, field, value) => {
    const r = await authed(`/crm/chats/${msgId}/link`, {
      method: 'PATCH', body: JSON.stringify({ field, value }),
    });
    if (!r.ok) { setErr(r.body?.detail ?? 'link failed'); return; }
    setLinkFor(null);
    if (active) loadMsgs(active.phone);
  };

  // Per-thread record summary — what this conversation is pinned to.
  const linked = useMemo(() => {
    const out = { trips: new Set(), vehicles: new Set(), expenses: new Set() };
    for (const m of msgs ?? []) {
      if (m.trip_id) out.trips.add(m.trip_id);
      if (m.vehicle_id) out.vehicles.add(m.vehicle_id);
      if (m.expense_id) out.expenses.add(m.expense_id);
    }
    return out;
  }, [msgs]);

  let lastDay = '';

  return (
    <div className="fixed inset-0 z-[9000] flex bg-[#04070d]" role="dialog" aria-modal="true">

      {/* ── LEFT: contexts + threads ─────────────────────────────────────── */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-white/[0.07] bg-[#070b13]">
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
          <span className="text-[15px] font-black tracking-tight text-white">📡 Dispatch Console</span>
          <button onClick={loadThreads} className="ml-auto grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-white/50 hover:text-white">
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 border-b border-white/[0.07] px-3 py-2">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-black transition-colors
                ${tab === k ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-300' : 'border-white/10 bg-white/[0.03] text-white/45 hover:text-white/70'}`}>
              {label}{counts[k === 'ALL' ? '' : k] != null && k !== 'ALL' ? ` ${counts[k] ?? 0}` : ''}
            </button>
          ))}
        </div>
        <div className="border-b border-white/[0.07] px-3 py-2">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
            <Search size={13} className="shrink-0 text-white/30" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name ya number khojo…"
              className="w-full bg-transparent text-[13px] font-semibold text-white outline-none placeholder:text-white/25" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads == null && <p className="px-4 py-6 text-[12px] text-white/35">Loading threads…</p>}
          {threads?.length === 0 && <p className="px-4 py-6 text-[12px] text-white/35">Is context mein koi baat-cheet nahi.</p>}
          {threads?.map((t) => (
            <button key={t.phone} onClick={() => setActive(t)}
              className={`flex w-full items-start gap-3 border-b border-white/[0.04] px-4 py-3 text-left transition-colors
                ${active?.phone === t.phone ? 'bg-cyan-400/[0.08]' : 'hover:bg-white/[0.03]'}`}>
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/5 text-[12px] font-black text-white/60">
                {(t.name ?? t.phone).slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-black text-white">{t.name ?? `+91 ${t.phone}`}</span>
                  <span className={`shrink-0 rounded-full border px-1.5 py-px text-[9px] font-bold ${KIND_TONE[t.kind] ?? KIND_TONE.UNKNOWN}`}>
                    {t.kind === 'UNKNOWN' ? 'ANJAAN' : t.kind}
                  </span>
                </div>
                <p className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-white/40">
                  {t.last_media_type && <Paperclip size={11} className="shrink-0 text-violet-300" />}
                  {t.last_direction === 'outgoing' ? '↗ ' : ''}{t.last_text}
                </p>
              </div>
              <span className="shrink-0 text-[10px] text-white/30">{clock(t.last_ts)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── CENTER: the conversation ─────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-white/[0.07] bg-[#070b13] px-5 py-3">
          {active ? (
            <>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-black text-white">{active.name ?? `+91 ${active.phone}`}</p>
                <p className="text-[11px] text-white/40">
                  +91 {active.phone} · {active.messages} messages · {active.media_count} attachments
                </p>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${KIND_TONE[active.kind] ?? KIND_TONE.UNKNOWN}`}>
                {active.kind === 'UNKNOWN' ? 'ANJAAN' : active.kind}
              </span>
            </>
          ) : <p className="text-[13px] font-bold text-white/40">Baayein se koi baat-cheet chunein</p>}
          <button onClick={onClose} aria-label="Close"
            className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/5 text-white/50 hover:text-white">
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {active && msgs == null && <p className="text-[12px] text-white/35">Loading conversation…</p>}
          {msgs?.map((m) => {
            const d = day(m.ts);
            const sep = d !== lastDay; lastDay = d;
            const out = m.direction === 'outgoing';
            const isImage = m.media_key && /(webp|jpe?g|png)$/i.test(m.media_key);
            const isPdf = m.media_key && /pdf$/i.test(m.media_key);
            return (
              <React.Fragment key={m.id}>
                {sep && (
                  <div className="my-4 flex items-center gap-3">
                    <span className="h-px flex-1 bg-white/[0.06]" />
                    <span className="text-[10.5px] font-bold uppercase tracking-wider text-white/30">{d}</span>
                    <span className="h-px flex-1 bg-white/[0.06]" />
                  </div>
                )}
                <div className={`group mb-2.5 flex ${out ? 'justify-end' : 'justify-start'}`}>
                  <div className={`relative max-w-[72%] rounded-2xl border px-4 py-2.5
                    ${out ? 'rounded-br-md border-emerald-400/20 bg-emerald-500/[0.09]'
                          : 'rounded-bl-md border-white/[0.08] bg-white/[0.045]'}`}>
                    {isImage && <div className="mb-2"><ChatImage mediaKey={m.media_key} onOpen={setViewer} getBlob={getBlob} /></div>}
                    {isPdf && (
                      <button onClick={() => openPdf(m)}
                        className="mb-2 flex items-center gap-2 rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2.5 text-[12.5px] font-black text-violet-300">
                        <FileText size={15} /> {m.media_filename ?? 'document.pdf'}
                        <ChevronRight size={13} className="text-violet-300/60" />
                      </button>
                    )}
                    {m.media_type && !m.media_key && (
                      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-white/35">
                        <Paperclip size={11} /> {m.media_type}{m.media_filename ? `: ${m.media_filename}` : ''} (purana — file save nahi hui thi)
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/90">{m.text}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {m.trip_code_linked && <RecordBadge icon={Package} label={m.trip_code_linked} />}
                      {m.trip_id && !m.trip_code_linked && <RecordBadge icon={Package} label="trip" />}
                      {m.vehicle_id && <RecordBadge icon={Truck} label={m.vehicle_reg_linked ?? 'vehicle'} />}
                      {m.expense_id && <RecordBadge icon={ReceiptText} label="expense" />}
                      <span className="ml-auto text-[10px] text-white/30">
                        {out && m.sent_by_user_name ? `${m.sent_by_user_name} · ` : ''}{clock(m.ts)}
                      </span>
                      <button onClick={() => setLinkFor(m)} title="Record se jodo"
                        className="rounded-md p-0.5 text-white/25 opacity-0 transition-opacity hover:text-cyan-300 group-hover:opacity-100">
                        <Link2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {active && (
          <div className="border-t border-white/[0.07] bg-[#070b13] px-5 py-3">
            {err && <p className="mb-2 text-[12px] font-semibold text-red-400">{err}</p>}
            <div className="flex items-end gap-2">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={`${active.name ?? active.phone} ko message…`}
                className="max-h-32 min-h-[44px] w-full resize-y rounded-2xl border border-white/10 bg-black/40 px-4 py-2.5
                           text-[14px] font-semibold text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50" />
              <button onClick={send} disabled={sending || !text.trim()}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600
                           text-white shadow-[0_6px_18px_rgba(34,211,238,0.3)] transition-transform active:scale-95 disabled:opacity-40">
                {sending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: the record panel ──────────────────────────────────────── */}
      {active && (
        <div className="hidden w-[280px] shrink-0 flex-col border-l border-white/[0.07] bg-[#070b13] xl:flex">
          <div className="border-b border-white/[0.07] px-4 py-3">
            <p className="flex items-center gap-2 text-[12px] font-black uppercase tracking-wider text-white/40">
              <User size={13} /> Contact
            </p>
            <p className="mt-2 text-[14px] font-black text-white">{active.name ?? 'Anjaan number'}</p>
            <p className="text-[12px] text-white/45">+91 {active.phone}</p>
            <span className={`mt-2 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${KIND_TONE[active.kind] ?? KIND_TONE.UNKNOWN}`}>
              {active.kind === 'UNKNOWN' ? 'ANJAAN — masters mein nahi hai' : active.kind}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <p className="text-[12px] font-black uppercase tracking-wider text-white/40">Linked records</p>
            <p className="mt-1 text-[11px] leading-relaxed text-white/30">
              Is baat-cheet ke messages jin records se jude hain. Kisi bubble par 🔗 dabakar jodo.
            </p>
            <div className="mt-3 space-y-2">
              <SummaryRow icon={Package} label="Trips" n={linked.trips.size} />
              <SummaryRow icon={Truck} label="Vehicles" n={linked.vehicles.size} />
              <SummaryRow icon={ReceiptText} label="Expenses" n={linked.expenses.size} />
              <SummaryRow icon={ImageIcon} label="Attachments" n={active.media_count} />
            </div>
          </div>
        </div>
      )}

      {/* ── MEDIA VIEWER ─────────────────────────────────────────────────── */}
      {viewer && (
        <div className="fixed inset-0 z-[9500] flex flex-col bg-black/90 backdrop-blur-sm" onClick={() => setViewer(null)}>
          <div className="flex items-center gap-3 px-5 py-3">
            <span className="text-[13px] font-black text-white/70">{viewer.name ?? 'attachment'}</span>
            <button onClick={() => setViewer(null)} aria-label="Close viewer"
              className="ml-auto grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white/70"><X size={17} /></button>
          </div>
          <div className="min-h-0 flex-1 px-5 pb-5" onClick={(e) => e.stopPropagation()}>
            {viewer.kind === 'image'
              ? <img src={viewer.src} alt="attachment" className="mx-auto max-h-full max-w-full rounded-xl object-contain" />
              : <iframe title="pdf" src={viewer.src} className="h-full w-full rounded-xl border border-white/10 bg-white" />}
          </div>
        </div>
      )}

      {/* ── LINK PICKER ──────────────────────────────────────────────────── */}
      {linkFor && (
        <LinkPicker message={linkFor} onClose={() => setLinkFor(null)} onPick={applyLink} />
      )}
    </div>
  );
}

function RecordBadge({ icon: Icon, label }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-px text-[9.5px] font-black text-cyan-300">
      <Icon size={9} /> {label}
    </span>
  );
}

function SummaryRow({ icon: Icon, label, n }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <Icon size={14} className="text-white/35" />
      <span className="text-[12px] font-bold text-white/60">{label}</span>
      <span className={`ml-auto text-[13px] font-black ${n ? 'text-cyan-300' : 'text-white/25'}`}>{n}</span>
    </div>
  );
}

// ── the record link picker ──────────────────────────────────────────────────
// One message → one record. Search runs against the live masters; the server
// re-verifies the id, so this list is a convenience, not the authority.
const LINK_KINDS = [
  { field: 'trip_id', label: 'Trip', icon: Package },
  { field: 'vehicle_id', label: 'Vehicle', icon: Truck },
  { field: 'expense_id', label: 'Expense', icon: ReceiptText },
];
function LinkPicker({ message, onClose, onPick }) {
  const [kind, setKind] = useState(LINK_KINDS[0]);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    (async () => {
      setBusy(true);
      try {
        if (kind.field === 'trip_id') {
          const r = await authed(`/ops/trips?q=${encodeURIComponent(q)}&limit=15`);
          if (on && r.ok) setRows((r.body.trips ?? []).map((t) => ({
            id: t.id, title: `${t.trip_code} · ${t.vehicle_no ?? ''}`,
            sub: `${t.status} · ${t.customer_name ?? ''}` })));
        } else if (kind.field === 'vehicle_id') {
          const token = localStorage.getItem('prasad_token');
          const r = await fetch(`${API_BASE}/api/vehicles/?search=${encodeURIComponent(q)}&limit=15`,
            { headers: token ? { Authorization: `Bearer ${token}` } : {} });
          const j = await r.json().catch(() => ({}));
          if (on && r.ok) setRows((j.vehicles ?? j.data ?? []).map((v) => ({
            id: v.id, title: v.vehicle_no, sub: v.vehicle_type ?? '' })));
        } else {
          const r = await authed('/queues/expenses?status=PENDING&limit=100');
          const list = (r.body?.expenses ?? []).filter((e) =>
            !q || `${e.vendor_name ?? ''} ${e.bill_no ?? ''} ${e.expense_type}`.toLowerCase().includes(q.toLowerCase()));
          if (on && r.ok) setRows(list.slice(0, 15).map((e) => ({
            id: e.id, title: `${e.expense_type} · ₹${Number(e.amount).toLocaleString('en-IN')}`,
            sub: `${e.vendor_name ?? e.driver_name ?? ''} ${e.bill_no ? `· ${e.bill_no}` : ''}` })));
        }
      } finally { if (on) setBusy(false); }
    })();
    return () => { on = false; };
  }, [kind, q]);

  const current = message[kind.field];

  return (
    <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0a0f1a] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <Link2 size={16} className="text-cyan-400" />
          <p className="text-[15px] font-black text-white">Message ko record se jodo</p>
          <button onClick={onClose} className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-white/5 text-white/50"><X size={15} /></button>
        </div>
        <p className="mb-3 truncate rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[12px] text-white/50">
          “{message.text}”
        </p>
        <div className="mb-3 flex gap-2">
          {LINK_KINDS.map((k) => (
            <button key={k.field} onClick={() => { setKind(k); setQ(''); }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border py-2 text-[12px] font-black
                ${kind.field === k.field ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-300' : 'border-white/10 bg-white/[0.03] text-white/45'}`}>
              <k.icon size={13} /> {k.label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
          <Search size={13} className="text-white/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder={kind.field === 'trip_id' ? 'Trip code / vehicle / customer…' : kind.field === 'vehicle_id' ? 'Registration number…' : 'Vendor / bill no…'}
            className="w-full bg-transparent text-[13px] font-semibold text-white outline-none placeholder:text-white/25" />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {busy && <p className="px-2 py-3 text-[12px] text-white/35">Searching…</p>}
          {!busy && rows.length === 0 && <p className="px-2 py-3 text-[12px] text-white/35">Kuch nahi mila.</p>}
          {rows.map((r) => (
            <button key={r.id} onClick={() => onPick(message.id, kind.field, r.id)}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.05]
                ${current === r.id ? 'bg-cyan-400/10' : ''}`}>
              <kind.icon size={14} className="shrink-0 text-white/35" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-bold text-white">{r.title}</p>
                {r.sub && <p className="truncate text-[11px] text-white/40">{r.sub}</p>}
              </div>
              {current === r.id && <span className="ml-auto text-[10px] font-black text-cyan-300">linked</span>}
            </button>
          ))}
        </div>
        {current && (
          <button onClick={() => onPick(message.id, kind.field, null)}
            className="mt-3 w-full rounded-xl border border-red-400/25 bg-red-400/[0.06] py-2 text-[12px] font-black text-red-300">
            Yeh {kind.label.toLowerCase()} link hatao
          </button>
        )}
      </div>
    </div>
  );
}
