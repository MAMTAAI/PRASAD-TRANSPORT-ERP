// @ts-nocheck
// ============================================================================
// LIVE DISPATCH CHAT — TRIP-CENTRIC (2026-09-02)
//
// WHAT THIS REPLACED, AND WHY. The panel was an INBOX: `wa_chats` ordered by
// who wrote last. On this system that is mostly people dispatch has no business
// with — six of the top rows on 2-Sep were "Anjaan" (a number on no master),
// carrying a horoscope forward and a news chain. Meanwhile the one question the
// screen exists to answer — "146 lorries are out; let me talk to the driver of
// one of them" — could not be asked here at all. A driver who has never
// messaged the company number was invisible, which is most of them.
//
// So the left pane starts from TRIPS. It is the same "🚚 Active ERP Trips" list
// the CRM's Trip Manager already uses, brought to the dashboard where dispatch
// actually sits, and selecting a trip opens the conversation with THAT trip's
// driver.
//
// THE INBOX IS NOT DELETED. Unknown numbers, pumps, vendors and customers all
// still live in the Dispatch Console behind EXPAND, which is the right place to
// deal with a stranger. What is gone is the stranger being the first thing a
// dispatcher sees on the operations dashboard.
//
// MESSAGES ARE FETCHED PER TRIP, NOT EMBEDDED. The old panel rode the 8-second
// dashboard poll with 20 messages × 24 threads inside it. Doing that for 146
// trips would be ~3,000 messages every 8 seconds. The list carries the last
// line and the unread count; the conversation is pulled from /crm/chats?phone=
// when a trip is opened, and polled only while it is open.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquareText, Send, Mic, FileText, ScanLine, Maximize2, Search, Plus,
  Paperclip, Image as ImageIcon, Camera, X, Loader2, Truck, Users,
  AlertTriangle, ExternalLink, CheckCircle2,
} from 'lucide-react';
import { API_BASE } from '../lib/apiBase';
import { GlassPanel, PanelHeader, Avatar, Dot } from './shared';
import { MyWhatsApp, WA_LINK_ROLES } from '../ui/whatsappLink';
import { compressImage, compressPdf } from '../lib/uploadMedia';
import { openDriverControl } from '../components/DriverControlDrawer';

const authHeaders = () => {
  const token = localStorage.getItem('prasad_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** Role as the app stored it at login. The server is the boundary either way;
 *  this only decides whether to offer the "link my WhatsApp" row. */
function storedRole() {
  try { return String(JSON.parse(localStorage.getItem('prasad_user') || '{}')?.role || '').toUpperCase(); }
  catch { return ''; }
}

const KIND_TONE = {
  DRIVER:   'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  PUMP:     'text-orange-300 border-orange-500/40 bg-orange-500/10',
  VENDOR:   'text-amber-300 border-amber-500/40 bg-amber-500/10',
  CUSTOMER: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  CONTACT:  'text-violet-300 border-violet-500/40 bg-violet-500/10',
  UNKNOWN:  'text-slate-400 border-slate-600/50 bg-slate-700/20',
};
const KIND_LABEL = {
  DRIVER: 'Driver', PUMP: 'Pump', VENDOR: 'Vendor',
  CUSTOMER: 'Customer', CONTACT: 'Contact', UNKNOWN: 'Anjaan',
};

const STATUS_TONE = {
  IN_TRANSIT: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  LOADED:     'text-amber-300 border-amber-500/40 bg-amber-500/10',
  UNLOADING:  'text-violet-300 border-violet-500/40 bg-violet-500/10',
};

const ago = (ts) => {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const clock = (ts) => (ts
  ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
  : '');

/** The lane, as the trip records it. Never invented: a trip with neither end
 *  filled in says so, because that is a Trip Management problem and hiding it
 *  here is how a blank consignee reaches a bill. */
const lane = (t) => {
  const from = t.loading_point;
  const to = t.unloading_location || t.consignee_name;
  if (from && to) return `${from} → ${to}`;
  return from || to || 'route darj nahi';
};

// Shown wherever the ERP genuinely holds no rows — never faked.
function EmptyNote({ children }) {
  return <p className="px-2 py-3 text-[11px] text-slate-500 leading-relaxed">{children}</p>;
}

export default function DispatchTripChat({ trips, offline, onExpand, onNewContact }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('TRIPS');
  const [activeId, setActiveId] = useState(null);
  // Everybody the ERP can reach, and every number that has ever written in.
  // The TRIPS tab needs neither; the other three are made of them.
  const [dir, setDir] = useState(null);            // null = not loaded
  const [threads, setThreads] = useState([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);

  const [msgs, setMsgs] = useState(null);          // null = not loaded yet
  const [msgErr, setMsgErr] = useState(null);

  const [attachOpen, setAttachOpen] = useState(false);
  const [busy, setBusy] = useState(null);          // 'attach' | 'scan' | 'lr' | null
  const [toast, setToast] = useState(null);        // { tone, title, lines[] }

  const docRef = useRef(null);
  const photoRef = useRef(null);
  const camRef = useRef(null);
  const scanRef = useRef(null);
  const bottomRef = useRef(null);

  // Memoised so the `?? []` does not mint a new array on every render and
  // re-run everything below it for nothing.
  const list = useMemo(() => trips ?? [], [trips]);

  // ── THE TABS ARE NOT A FILTER OVER ONE LIST, THEY ARE FOUR SOURCES ───────
  // TRIPS comes from ops.dispatch_trips — the lorries that are out. The other
  // two come from the contact directory, which is the only thing that knows
  // about a driver sitting at home or a pump that has never messaged us. A
  // trip-only pane could not reach either, and an inbox-only pane (what this
  // replaced) could not reach anyone who has not written in first.
  //
  // `threads` supplies last-message and unread for the directory rows, because
  // the directory itself knows who exists, not who spoke.
  const loadSidebar = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([
        fetch(`${API_BASE}/api/v1/crm/directory?limit=500`, { headers: authHeaders() })
          .then((r) => r.json()).catch(() => ({})),
        fetch(`${API_BASE}/api/v1/crm/threads?limit=300`, { headers: authHeaders() })
          .then((r) => r.json()).catch(() => ({})),
      ]);
      setDir(d.contacts ?? []);
      setThreads(t.threads ?? []);
    } catch {
      // An empty directory and a failed fetch look the same on screen, so the
      // tabs report their own counts as 0 rather than pretending to be loading
      // for ever. The TRIPS tab is unaffected — it rides the dashboard payload.
      setDir([]);
    }
  }, []);

  useEffect(() => {
    loadSidebar();
    const onChange = () => loadSidebar();
    window.addEventListener('erp:data-changed', onChange);
    return () => window.removeEventListener('erp:data-changed', onChange);
  }, [loadSidebar]);

  const byPhone = useMemo(() => {
    const m = new Map();
    for (const t of threads) m.set(t.phone, t);
    return m;
  }, [threads]);

  /** One shape for both kinds of row, so the list renders once and the
   *  conversation pane does not care how you got there. */
  const tripEntry = (t) => ({
    key: `trip:${t.trip_id}`,
    kind: 'TRIP',
    phone: t.phone,
    name: t.driver_name || t.vehicle_no || t.trip_code,
    trip: t,
    last_text: t.last_text, last_direction: t.last_direction, last_ts: t.last_ts,
    unread: t.unread || 0,
    hay: [t.trip_code, t.vehicle_no, t.driver_name, t.consignee_name, t.customer_name,
      t.loading_point, t.unloading_location, t.phone],
  });
  const contactEntry = (c) => {
    const th = byPhone.get(c.phone);
    return {
      key: `ph:${c.phone}`,
      kind: c.kind,
      phone: c.phone,
      name: c.name || `+91 ${c.phone}`,
      sub: c.sub || null,
      trip: null,
      last_text: th?.last_text ?? null,
      last_direction: th?.last_direction ?? null,
      last_ts: th?.last_ts ?? null,
      unread: 0,
      hay: [c.name, c.phone, c.sub],
    };
  };

  // Memoised: `dir ?? []` would be a new array on every render while the
  // directory is still loading, and groups below would recompute for nothing.
  const contacts = useMemo(() => dir ?? [], [dir]);

  const groups = useMemo(() => {
    const tripRows = list.map(tripEntry);
    const tripByPhone = new Map(tripRows.filter((r) => r.phone).map((r) => [r.phone, r]));
    const onTrip = new Set(tripByPhone.keys());
    // A DRIVER WHO IS OUT KEEPS HIS TRIP IN THIS TAB. Listing him as a bare
    // contact would open the same conversation with the trip context stripped
    // off — SEND LR COPY greyed out for a lorry that is on the road, which
    // reads as broken rather than as "this tab is a different list".
    const drivers = contacts.filter((c) => c.kind === 'DRIVER')
      .map((c) => tripByPhone.get(c.phone) ?? contactEntry(c));
    const pumps = contacts.filter((c) => c.kind === 'PUMP' || c.kind === 'VENDOR').map(contactEntry);
    // ALL leads with the lorries that are out, then everyone else the ERP can
    // reach — a driver already on a trip is not listed twice.
    const rest = contacts
      .filter((c) => !onTrip.has(c.phone))
      .map(contactEntry)
      .sort((a, b) => (b.last_ts ? Date.parse(b.last_ts) : 0) - (a.last_ts ? Date.parse(a.last_ts) : 0));
    return { TRIPS: tripRows, DRIVERS: drivers, PUMPVEN: pumps, ALL: [...tripRows, ...rest] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, contacts, byPhone]);

  const shown = useMemo(() => {
    const rows = groups[tab] ?? groups.TRIPS;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.hay.some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }, [groups, tab, q]);

  // Resolved against the VISIBLE list so a search or a tab change moves the
  // conversation with it, instead of leaving a thread on screen whose row is
  // no longer above it.
  const active = shown.find((r) => r.key === activeId) ?? shown[0] ?? null;
  const phone = active?.phone ?? null;
  const trip = active?.trip ?? null;

  // ── The conversation, on its own data path ───────────────────────────────
  const loadMsgs = useCallback(async (p) => {
    if (!p) { setMsgs([]); return; }
    setMsgErr(null);
    try {
      const r = await fetch(`${API_BASE}/api/v1/crm/chats?phone=${encodeURIComponent(p)}&limit=100`,
        { headers: authHeaders() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setMsgs(j.chats ?? []);
    } catch (e) {
      // Named, not swallowed: an empty thread and a broken fetch look identical
      // on screen, and only one of them is the operator's problem.
      setMsgs([]);
      setMsgErr(e.message || 'chat load failed');
    }
  }, []);

  useEffect(() => {
    setMsgs(null);
    loadMsgs(phone);
    if (!phone) return undefined;
    // Only while a trip is open, and only while the tab is visible — this poll
    // is in addition to the dashboard's own.
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadMsgs(phone); }, 8000);
    const onChange = () => loadMsgs(phone);
    window.addEventListener('erp:data-changed', onChange);
    return () => { clearInterval(t); window.removeEventListener('erp:data-changed', onChange); };
  }, [phone, loadMsgs]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  const refresh = () => window.dispatchEvent(new Event('erp:data-changed'));

  // ── Send ─────────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = message.trim();
    if (!text || !phone || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await fetch(`${API_BASE}/api/v1/crm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ phone, text, trip_id: active?.trip_id ?? null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setMessage('');
      loadMsgs(phone);
      refresh();
    } catch (e) {
      // KEPT IN THE BOX. Clearing the message on a failure loses what the
      // operator wrote, and they have no way to know it was not sent.
      setSendError(e.message || 'bhej nahi paye');
    } finally {
      setSending(false);
    }
  };

  // ── The + menu: vault upload, then a link over WhatsApp (Option A) ───────
  const sendAttachment = async (file) => {
    if (!file || !phone) return;
    setAttachOpen(false);
    setBusy('attach');
    setToast(null);
    try {
      // The same compression every other upload in this app uses: images to
      // WebP at ~140 KB, PDFs re-rendered. The box's disk is shared, and these
      // are documents, not photographs of anything that needs the pixels.
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
      const c = isPdf ? await compressPdf(file) : await compressImage(file);
      const name = (file.name || 'document').replace(/\.[^./]+$/, '') + (c.ext || '');

      const form = new FormData();
      // `phone` first: @fastify/multipart only exposes fields that PRECEDE the
      // file part, and a field sent after it is invisible to the handler.
      form.append('phone', phone);
      if (trip?.trip_id) form.append('trip_id', trip.trip_id);
      if (message.trim()) form.append('caption', message.trim());
      form.append('file', c.blob, name);

      const r = await fetch(`${API_BASE}/api/v1/crm/attach`, {
        method: 'POST', headers: authHeaders(), body: form,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);

      setMessage('');
      loadMsgs(phone);
      refresh();
      if (j.sent) {
        setToast({
          tone: 'ok', title: 'Bhej diya',
          lines: [`${name} vault mein file ho gaya aur link WhatsApp par chala gaya.`,
            j.absolute ? 'Link 7 din tak chalega.' : 'WARNING: PUBLIC_APP_URL set nahi hai — link adhoora gaya hai.'],
        });
      } else {
        // The file IS saved. Saying "failed" flatly would send somebody
        // hunting for a document that is already there.
        setToast({
          tone: 'warn', title: 'File save ho gayi, message nahi gaya',
          lines: [j.detail || 'WhatsApp engine ne message nahi bheja.',
            'Document vault mein hai — WhatsApp jud jane par dobara bhejein.'],
        });
      }
    } catch (e) {
      setToast({ tone: 'err', title: 'Attachment nahi gaya', lines: [e.message || 'unknown error'] });
    } finally {
      setBusy(null);
    }
  };

  // ── SCAN FUEL SLIP OCR → POST /api/v1/scan ───────────────────────────────
  // This button was drawn with no onClick — pressing it looked exactly like
  // scanning and was not.
  const scanSlip = async (file) => {
    if (!file) return;
    setBusy('scan');
    setToast(null);
    try {
      const c = (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''))
        ? await compressPdf(file) : await compressImage(file);
      const form = new FormData();
      form.append('source', 'dispatch-chat');
      form.append('file', c.blob, (file.name || 'slip') + (c.ext || ''));
      const r = await fetch(`${API_BASE}/api/v1/scan`, { method: 'POST', headers: authHeaders(), body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setToast({ tone: j.ok === false ? 'err' : (j.needs_human ? 'warn' : 'ok'), scan: j });
    } catch (e) {
      setToast({ tone: 'err', title: 'Slip padh nahi paye', lines: [e.message || 'unknown error'] });
    } finally {
      setBusy(null);
    }
  };

  // ── SEND LR COPY ─────────────────────────────────────────────────────────
  const previewLr = async () => {
    if (!trip) return;
    setBusy('lr');
    try {
      const r = await fetch(`${API_BASE}/api/v1/ops/trips/${trip.trip_id}/lr?preview=1`, { headers: authHeaders() });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      }
      const url = URL.createObjectURL(await r.blob());
      window.open(url, '_blank', 'noopener');
      // Revoked late: revoking immediately can race the new tab's own load.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setToast({ tone: 'err', title: 'LR ban nahi paya', lines: [e.message || 'unknown error'] });
    } finally { setBusy(null); }
  };

  const sendLr = async () => {
    if (!trip) return;
    setBusy('lr');
    setToast(null);
    try {
      const r = await fetch(`${API_BASE}/api/v1/ops/trips/${trip.trip_id}/lr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ phone: phone ?? undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      loadMsgs(phone);
      refresh();
      setToast({
        tone: j.sent ? 'ok' : 'warn',
        title: j.sent ? `LR ${j.lr_no} bhej diya` : `LR ${j.lr_no} ban gaya, message nahi gaya`,
        lines: [
          j.sent ? `Link ${j.phone} par gaya — 30 din tak chalega.` : (j.detail || 'WhatsApp engine ne message nahi bheja.'),
          'Layout abhi provisional hai — office ka asli LR format aana baaki hai.',
        ],
        lr: j,
      });
    } catch (e) {
      setToast({ tone: 'err', title: 'LR nahi gaya', lines: [e.message || 'unknown error'] });
    } finally { setBusy(null); }
  };

  const unreadTotal = list.reduce((a, t) => a + (t.unread || 0), 0);

  return (
    <GlassPanel className="flex flex-col overflow-hidden max-h-[720px] lg:h-full lg:max-h-[720px] border-emerald-500/30 shadow-[0_0_30px_rgba(52,211,153,0.08)]">
      <PanelHeader
        icon={MessageSquareText}
        title="Live Dispatch Chat"
        accent="text-emerald-400"
        sub={`${list.length} chalu trip${unreadTotal ? ` · ${unreadTotal} unread` : ''}`}
        right={
          <div className="flex items-center gap-1">
          {/* THE ONE CONTROL HERE THAT IS NOT ABOUT A TRIP, which is why it is
              in the header and not in the list. The list is strictly the
              lorries that are out; a fuel pump is on no trip and must not
              appear among them — but it still has to be reachable, and before
              1-Sep it was not reachable from this screen at all. */}
          {onNewContact && (
            <button
              onClick={onNewContact}
              title="Kisi bhi driver, pump, vendor ya customer ko message karein — trip ke bina"
              className="flex items-center gap-0.5 rounded-md border border-slate-600/60 bg-white/5 px-1.5 py-0.5 text-[10px] font-black text-slate-300 hover:bg-white/10 transition-colors"
            >
              <Plus size={11} /> NAYA
            </button>
          )}
          <button
            onClick={onExpand}
            title="Poora Dispatch Console — saare threads (pump, vendor, anjaan numbers), inline PDF/photo, record linking"
            className="flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/25 transition-colors"
          >
            <Maximize2 size={11} /> EXPAND
          </button>
          </div>
        }
      />

      {/* An empty list has two very different causes — nobody is out, or this
          desk's WhatsApp is not connected. This row answers the second. */}
      {WA_LINK_ROLES.includes(storedRole()) && <MyWhatsApp variant="panel" />}

      <div className="flex flex-col md:flex-row lg:flex-col flex-1 min-h-0">

        {/* ══ WHO TO TALK TO ══
            The tab strip is back, but it is no longer the old inbox's
            Driver/Pump/Vendor/Anjaan split over "numbers that wrote in". These
            four are SOURCES: TRIPS is the lorries that are out, DRIVERS and
            PUMP / VENDORS are the masters — people who can be reached whether
            or not they have ever messaged the company number. That is the
            difference that made the old strip useless: it could show six
            strangers and none of the 55 drivers. */}
        <div className="md:w-1/3 lg:w-full border-b md:border-b-0 md:border-r lg:border-r-0 lg:border-b border-slate-700/50">
          <div className="flex items-center gap-1 px-2.5 pt-1 pb-1 overflow-x-auto mc-hide-scrollbar shrink-0">
            {/* FIRST AND STICKY, because it is the only control here that is
                not a filter: everything else narrows a list, this one reaches a
                number that is on no list at all. */}
            {onNewContact && (
              <button
                onClick={onNewContact}
                title="Kisi bhi number par naya message — trip ke bina"
                className="shrink-0 sticky left-0 z-10 flex items-center gap-0.5 rounded-md border border-emerald-500/50
                           bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-black text-emerald-300
                           transition-colors hover:bg-emerald-500/25">
                <Plus size={11} /> NAYA
              </button>
            )}
            {[['ALL', 'All'], ['TRIPS', 'Trips'], ['DRIVERS', 'Drivers'], ['PUMPVEN', 'Pump / Vendors']].map(([id, label]) => {
              const on = tab === id;
              const n = (groups[id] ?? []).length;
              return (
                <button key={id}
                  onClick={() => { setTab(id); setActiveId(null); setToast(null); setSendError(null); }}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-black transition-colors
                    ${on ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                         : 'border-slate-700/50 bg-transparent text-slate-400 hover:border-slate-600 hover:text-slate-200'}`}>
                  {label}
                  <span className={`ml-1 font-bold ${on ? 'text-emerald-400/80' : 'text-slate-600'}`}>
                    {dir === null && id !== 'TRIPS' ? '·' : n}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 px-2.5 pb-1.5 shrink-0">
            <span className="flex items-center gap-1 text-[10px] font-black text-emerald-300 shrink-0">
              {tab === 'TRIPS' || tab === 'ALL'
                ? <><Truck size={11} /> ACTIVE ERP TRIPS</>
                : <><Users size={11} /> DIRECTORY</>}
            </span>
            <span className="text-[9.5px] text-slate-600 shrink-0">
              {tab === 'TRIPS' || tab === 'ALL' ? 'auto-synced' : 'masters se'}
            </span>
            <label className="ml-auto flex items-center gap-1 rounded-md border border-slate-700/60 bg-slate-950/60 px-1.5 py-0.5 min-w-0">
              <Search size={10} className="text-slate-600 shrink-0" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Trip, gaadi, driver, number…"
                className="w-28 sm:w-40 lg:w-48 bg-transparent text-[10.5px] text-slate-200 placeholder-slate-600 outline-none"
              />
            </label>
          </div>

          <div className="px-2 pb-1.5 max-h-[168px] overflow-y-auto mc-thin-scrollbar flex flex-col gap-0.5">
            {shown.length === 0 ? (
              <EmptyNote>
                {offline
                  ? 'Live data unavailable — API not reachable.'
                  : q
                    ? `“${q}” se kuch nahi mila.`
                    : tab === 'TRIPS'
                      ? 'Abhi koi trip LOADED / IN TRANSIT / UNLOADING mein nahi hai. Trip Management se trip chalu hone par woh yahan apne aap aa jayegi.'
                      : dir === null
                        ? 'Directory aa rahi hai…'
                        : 'Kisi master mein mobile number darj nahi hai. Driver / Vendor master mein number bharein — yahan apne aap aa jayenge.'}
              </EmptyNote>
            ) : shown.map((r) => {
              const on = r.key === active?.key;
              const t = r.trip;
              return (
                <div
                  key={r.key}
                  onClick={() => { setActiveId(r.key); setSendError(null); setToast(null); }}
                  className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors border
                    ${on ? 'bg-emerald-500/10 border-emerald-500/40' : 'border-transparent hover:bg-white/5'}`}
                >
                  <Avatar name={r.name} size="w-7 h-7" textSize="text-[9px]"
                          ring={on ? 'ring-emerald-500/60' : 'ring-slate-700/60'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-[11px] font-black text-slate-100 truncate">
                        {t ? (t.trip_code || '(no code)') : r.name}
                      </p>
                      {t && t.status && (
                        <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${STATUS_TONE[t.status] || 'text-slate-400 border-slate-600/50 bg-slate-700/20'}`}>
                          {String(t.status).replace(/_/g, ' ')}
                        </span>
                      )}
                      {!t && (
                        <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${KIND_TONE[r.kind] || KIND_TONE.CONTACT}`}>
                          {KIND_LABEL[r.kind] || r.kind}
                        </span>
                      )}
                      {/* A lorry we cannot reach is dispatch information, not a
                          row to hide. */}
                      {!r.phone && (
                        <span className="shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border text-amber-300 border-amber-500/40 bg-amber-500/10">
                          no number
                        </span>
                      )}
                    </div>
                    {t ? (
                      <>
                        <p className="text-[10px] text-slate-400 truncate">
                          {t.vehicle_no || 'gaadi darj nahi'}
                          {/* The driver's name opens the Driver Control Dashboard
                              (owner, 2026-09-03) — a slide-out over this screen. */}
                          {t.driver_name ? (
                            t.driver_id
                              ? <span role="button" title="Driver Control Dashboard" data-driver-link
                                  onClick={(e) => { e.stopPropagation(); openDriverControl(t.driver_id, t.driver_name); }}
                                  className="cursor-pointer text-slate-400 underline decoration-dotted decoration-cyan-500/60 underline-offset-2 hover:text-cyan-300"> · {t.driver_name}</span>
                              : <span className="text-slate-500"> · {t.driver_name}</span>
                          ) : null}
                        </p>
                        <p className="text-[9.5px] text-slate-600 truncate">{lane(t)}</p>
                      </>
                    ) : (
                      <p className="text-[10px] text-slate-400 truncate">
                        +91 {r.phone}{r.sub ? <span className="text-slate-500"> · {r.sub}</span> : null}
                      </p>
                    )}
                    {r.last_text && (
                      <p className="text-[9.5px] text-slate-600 truncate mt-0.5">
                        {r.last_direction === 'outgoing' && <span className="text-slate-500">Aap: </span>}
                        {r.last_text}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[9px] text-slate-600">{ago(r.last_ts)}</span>
                    {r.unread > 0 && (
                      <span className="grid place-items-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-[9px] font-black text-white">{r.unread}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ══ THE CONVERSATION ══ */}
        <div className="flex-1 flex flex-col min-h-0 relative">
          {active && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700/50 bg-white/5 shrink-0">
              <Avatar name={active.name} size="w-7 h-7" ring="ring-emerald-500/60" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-black text-slate-100 flex items-center gap-1.5 truncate">
                  {active.name}
                  {phone && <Dot color="bg-emerald-400" pulse size="w-1.5 h-1.5" />}
                  {!trip && (
                    <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${KIND_TONE[active.kind] || KIND_TONE.CONTACT}`}>
                      {KIND_LABEL[active.kind] || active.kind}
                    </span>
                  )}
                </p>
                {/* "koi chalu trip nahi" is a DRIVER sentence. Said to a fuel
                    pump it reads as a fault on a record that was never going to
                    have a trip, so each kind gets its own line. */}
                <p className="text-[10px] text-emerald-400 font-semibold truncate">
                  {trip ? (
                    <>
                      {trip.trip_code}{trip.status ? ` · ${String(trip.status).replace(/_/g, ' ')}` : ''}
                      {trip.vehicle_no ? ` · ${trip.vehicle_no}` : ''}
                      {phone ? ` · +91 ${phone}` : ' · koi mobile number nahi'}
                    </>
                  ) : (
                    <>
                      +91 {phone}
                      {active.sub ? ` · ${active.sub}` : ''}
                      {active.kind === 'DRIVER' ? ' · abhi koi chalu trip nahi' : ''}
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          <div className="flex-1 min-h-[110px] overflow-y-auto mc-thin-scrollbar px-2.5 py-2 flex flex-col gap-1.5">
            {!active ? (
              <EmptyNote>Left se koi trip ya contact chunein — baat-cheet yahin hogi.</EmptyNote>
            ) : !phone ? (
              <EmptyNote>
                <span className="text-amber-400 font-bold">Is trip par driver ka mobile number darj nahi hai.</span>{' '}
                Na trip record par, na Driver Master mein. Number daalne ke baad hi message ja payega — Driver Master
                mein {active.name || 'is driver'} ka number update karein.
              </EmptyNote>
            ) : msgs === null ? (
              <p className="px-2 py-3 text-[11px] text-slate-500 flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> chat load ho rahi hai…
              </p>
            ) : msgErr ? (
              <EmptyNote><span className="text-red-400">Chat load nahi hui — {msgErr}.</span></EmptyNote>
            ) : msgs.length === 0 ? (
              <EmptyNote>
                {active.name} ke saath abhi tak koi baat-cheet nahi hui.
                Neeche likh kar pehla message bhejein — poora record yahin save hoga.
              </EmptyNote>
            ) : msgs.map((m) => {
              const outgoing = m.direction === 'outgoing';
              return (
                <div key={m.id} className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[88%] rounded-xl px-2.5 py-1.5 border
                    ${outgoing ? 'bg-slate-800/80 border-slate-700/60 rounded-br-sm'
                               : 'bg-emerald-600/25 border-emerald-500/40 rounded-bl-sm'}`}>
                    <p className={`text-[9px] font-bold mb-px ${outgoing ? 'text-slate-500' : 'text-emerald-400'}`}>
                      [{outgoing ? (m.sent_by_user_name || 'Office') : (active.name || `+91 ${phone}`)}]{' '}
                      <span className="font-normal text-slate-600">{clock(m.ts)}</span>
                    </p>
                    <p className="text-[11.5px] text-slate-100 leading-[1.35] whitespace-pre-wrap break-words">{m.text}</p>
                    {(m.media_key || m.media_type) && (
                      <button onClick={onExpand}
                        className="mt-1 flex items-center gap-1 text-[9.5px] font-bold text-violet-300 hover:text-violet-200">
                        <Paperclip size={9} /> {m.media_key ? 'Attachment — console mein kholo' : m.media_type}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* ══ RESULT SHEET — scan / LR / attachment outcome ══
              Inside the panel, over the thread. No page jump: the operator is
              in a conversation and must not lose it to read a result. */}
          {toast && (
            <div
              className="absolute inset-x-2 bottom-2 z-20 rounded-xl border bg-slate-950/95 backdrop-blur-md p-2.5
                         shadow-2xl max-h-[70%] overflow-y-auto mc-thin-scrollbar"
              /* Tailwind cannot build a class name at runtime, and the three
                 tones are decided by the result — so the one colour that varies
                 is an inline style rather than a class that would be purged. */
              style={{ borderColor: toast.tone === 'err' ? 'rgba(248,113,113,.5)' : toast.tone === 'warn' ? 'rgba(251,191,36,.5)' : 'rgba(52,211,153,.5)' }}>
              <div className="flex items-start gap-2">
                {toast.tone === 'err' ? <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />
                  : toast.tone === 'warn' ? <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  : <CheckCircle2 size={13} className="text-emerald-400 mt-0.5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  {toast.scan ? <ScanCard scan={toast.scan} /> : (
                    <>
                      <p className="text-[11px] font-black text-slate-100">{toast.title}</p>
                      {(toast.lines ?? []).map((l, i) => (
                        <p key={i} className="text-[10px] text-slate-400 leading-snug mt-0.5">{l}</p>
                      ))}
                      {toast.lr?.url && (
                        <a href={toast.lr.url} target="_blank" rel="noreferrer"
                           className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-cyan-300 hover:text-cyan-200">
                          <ExternalLink size={10} /> Jo link driver ko gaya, woh kholein
                        </a>
                      )}
                    </>
                  )}
                </div>
                <button onClick={() => setToast(null)} className="shrink-0 text-slate-500 hover:text-slate-300">
                  <X size={13} />
                </button>
              </div>
            </div>
          )}

          {/* ══ QUICK ACTIONS ══ */}
          <div className="px-2.5 py-1.5 grid grid-cols-2 gap-1.5 border-t border-slate-700/50 shrink-0">
            <div className="flex items-stretch gap-1">
              <button
                onClick={sendLr}
                disabled={!trip || !phone || busy === 'lr'}
                title={trip
                  ? `LR ${trip.trip_code} driver ko WhatsApp par bhejein`
                  : 'LR sirf kisi trip par bheja ja sakta hai — Trips tab se trip chunein'}
                className="flex-1 flex items-center justify-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-1 text-[9.5px] font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 disabled:hover:bg-cyan-500/10 transition-colors"
              >
                {busy === 'lr' ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} SEND LR COPY
              </button>
              {/* Look before you send. The layout is provisional and somebody
                  should be able to see what is going out. */}
              <button
                onClick={previewLr}
                disabled={!trip || busy === 'lr'}
                title="LR dekhein (bheja nahi jayega)"
                className="shrink-0 grid place-items-center w-7 rounded-lg border border-cyan-500/30 bg-cyan-500/5 text-cyan-400 hover:bg-cyan-500/15 disabled:opacity-40 transition-colors"
              >
                <ExternalLink size={11} />
              </button>
            </div>
            <button
              onClick={() => scanRef.current?.click()}
              disabled={busy === 'scan'}
              title="Fuel slip ki photo padhein — OCR /api/v1/scan se"
              className="flex items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-1 text-[9.5px] font-black text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors"
            >
              {busy === 'scan' ? <Loader2 size={12} className="animate-spin" /> : <ScanLine size={12} />} SCAN FUEL SLIP OCR
            </button>
          </div>

          {/* ══ COMPOSER ══ */}
          <div className="px-2.5 pb-2 pt-1.5 shrink-0 relative">
            {sendError && (
              <p className="mb-1 text-[10px] text-red-400 leading-snug">
                Bhej nahi paye — {sendError}. Aapka message neeche likha hua hai, dobara try karein.
              </p>
            )}

            {/* The + menu. Three doors, the same as WhatsApp's: a file, a
                picture, and the camera. `capture` is what makes the third one
                open the camera rather than the gallery on a phone. */}
            {attachOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setAttachOpen(false)} />
                <div className="absolute bottom-12 left-2.5 z-30 w-44 rounded-xl border border-slate-700/70 bg-slate-950/98 backdrop-blur-md p-1 shadow-2xl">
                  <AttachItem icon={FileText} label="Document" hint="PDF ya scan"
                              onClick={() => docRef.current?.click()} />
                  {/* PHOTOS, NOT "PHOTOS & VIDEOS". The vault stores webp /
                      jpeg / png / pdf and nothing else (files.routes.js), so a
                      video picker here would open the gallery, let somebody
                      choose a clip, and answer 415. The label says what the
                      button can actually do. */}
                  <AttachItem icon={ImageIcon} label="Photos" hint="gallery se · video abhi nahi"
                              onClick={() => photoRef.current?.click()} />
                  <AttachItem icon={Camera} label="Camera" hint="abhi kheenchein"
                              onClick={() => camRef.current?.click()} />
                  <p className="px-2 py-1 text-[8.5px] text-slate-600 leading-snug border-t border-slate-800 mt-1">
                    File ERP vault mein jayegi aur driver ko uska secure link WhatsApp par milega.
                  </p>
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setAttachOpen((v) => !v)}
                disabled={!phone || busy === 'attach'}
                title={phone ? 'Document, photo ya camera' : 'Pehle koi trip chunein jiska number ho'}
                className={`grid place-items-center w-8 h-8 rounded-lg shrink-0 transition-colors
                  ${attachOpen ? 'bg-emerald-600 text-white' : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700'}
                  disabled:bg-slate-800/40 disabled:text-slate-600`}
              >
                {busy === 'attach' ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              </button>
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                disabled={!phone || sending}
                placeholder={phone ? `${active?.name || 'Inko'} ko message…` : 'Koi trip ya contact chunein…'}
                className="flex-1 min-w-0 rounded-lg bg-slate-950/70 border border-slate-700/50 px-2.5 py-1.5 text-[11.5px] text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/60 disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={!phone || sending || !message.trim()}
                title={phone ? 'Bhejein' : 'Number nahi hai'}
                className="grid place-items-center w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors shrink-0"
              >
                <Send size={14} className={sending ? 'animate-pulse' : ''} />
              </button>
              {/* Left visibly disabled rather than removed: voice notes are not
                  wired to anything, and a live-looking button that does nothing
                  is the exact fault this panel keeps being fixed for. */}
              <button disabled title="Voice note abhi available nahi hai"
                      className="grid place-items-center w-8 h-8 rounded-lg bg-slate-800/60 text-slate-600 cursor-not-allowed shrink-0">
                <Mic size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* The pickers. Kept out of the menu markup so closing it does not unmount
          the input mid-selection — which silently cancels the file dialog. */}
      <input ref={docRef} type="file" accept="application/pdf,image/*" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; sendAttachment(f); }} />
      <input ref={photoRef} type="file" accept="image/*" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; sendAttachment(f); }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; sendAttachment(f); }} />
      <input ref={scanRef} type="file" accept="application/pdf,image/*" capture="environment" className="hidden"
             onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; scanSlip(f); }} />
    </GlassPanel>
  );
}

function AttachItem({ icon: Icon, label, hint, onClick }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/5 transition-colors">
      <span className="grid place-items-center w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 shrink-0">
        <Icon size={13} />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-bold text-slate-200">{label}</span>
        <span className="block text-[9px] text-slate-500">{hint}</span>
      </span>
    </button>
  );
}

/** What the scanner actually read. Only fields it FOUND are shown — a grid of
 *  labels with blanks beside them reads as a broken screen rather than as a
 *  slip the reader could not make out. */
function ScanCard({ scan }) {
  const FIELDS = [
    ['Kind', scan.kind],
    ['Memo / Invoice no', scan.invoice_no || scan.challan_no || scan.gr_no],
    ['Date', scan.document_date],
    ['Product', scan.product],
    ['Litres', scan.quantity_ltr],
    ['Amount', scan.total_amount],
    ['Vehicle', (scan.vehicle_regs ?? []).join(', ') || scan.matched_vehicle?.vehicle_no],
    ['GSTIN', scan.gstin],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <>
      <p className="text-[11px] font-black text-slate-100">
        Slip padh li — {scan.engine} · {scan.took_ms}ms
      </p>
      {scan.ok === false && (
        <p className="text-[10px] text-red-400 mt-0.5">Padh nahi paye: {scan.detail || scan.error}</p>
      )}
      {FIELDS.length === 0 ? (
        <p className="text-[10px] text-amber-400 mt-0.5 leading-snug">
          Is page se koi field nahi nikli{scan.text_chars ? ` (${scan.text_chars} akshar mile)` : ''}.
          Saaf, seedhi photo dobara kheenchein.
        </p>
      ) : (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {FIELDS.map(([k, v]) => (
            <p key={k} className="text-[10px] text-slate-400 truncate">
              {k}: <span className="text-slate-100 font-bold">{String(v)}</span>
            </p>
          ))}
        </div>
      )}
      <p className="text-[9px] leading-snug mt-1.5 text-slate-500">
        {scan.needs_human
          ? 'Scanner ko is padhaai par bharosa NAHI hai — koi bhi field aage badhane se pehle khud dekh lein.'
          : 'Scanner ko is padhaai par bharosa hai.'}
        {' '}Scan sirf padhta hai — kahin file nahi karta. Expense banane ke liye Smart Scanner / Fuel Review Queue
        se aage badhein.
      </p>
    </>
  );
}
