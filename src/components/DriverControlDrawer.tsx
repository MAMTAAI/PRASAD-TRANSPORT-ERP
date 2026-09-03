// @ts-nocheck
// ============================================================================
// DRIVER CONTROL DASHBOARD — the slide-out (owner, 2026-09-03)
//
// "When the Admin clicks on a driver (from the active trips, dispatch chat, or
// a driver list), it must open a comprehensive Driver Control Dashboard right
// there on the current screen … Do NOT navigate away from the Command Center."
//
// Approved from docs/mockups/admin-driver-control-mock-v2.html. One 600 px
// panel from the right over the dashboard; Esc or ✕ closes it and the screen
// behind is untouched. Opened from anywhere with the same window-event pattern
// the drill-down drawer uses:
//
//     openDriverControl(driverId, name)      → CustomEvent 'pt:driver-control'
//
// and <DriverControlHost/> (mounted once, in MasterControlApp) listens.
//
// Everything it does rides routes that already exist, plus the small module
// server/modules/driverControl.routes.js (summary, issue-hsd, pay-cash, notice):
//   suspend / re-activate / archive   /access/DRIVER/:id/block|activate|archive
//   profile edit                      PATCH /masters/drivers/:id
//   approve / reject a staged paper   /queues/partner-documents/:id/approve|reject
//   login link                        POST /auth/driver/link
//   the map                           GET /maps/trip/:tripId/route
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';
import RouteMap from '../lib/RouteMap';
import { uploadMedia, slug } from '../lib/uploadMedia';

const EVT = 'pt:driver-control';
export const openDriverControl = (driverId, name = '') =>
  window.dispatchEvent(new CustomEvent(EVT, { detail: { driver_id: driverId, name } }));

const tok = () => localStorage.getItem('prasad_token') || '';
const me = () => { try { return JSON.parse(localStorage.getItem('prasad_user') || 'null'); } catch { return null; } };
const api = async (path, opts = {}) => {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${tok()}`, ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error, status: res.status });
  return json;
};

const PAPER = {
  DL: { title: 'Driving Licence', icon: '🚗', col: 'dl_photo_url' },
  AADHAAR: { title: 'Aadhaar', icon: '🆔', col: 'aadhar_photo_url' },
  BANK_BOOK: { title: 'Bank Passbook', icon: '🏦', col: 'bank_photo_url' },
  PAN: { title: 'PAN Card', icon: '💳', col: 'pan_photo_url' },
  HZD: { title: 'Hazardous Certificate', icon: '☣️', col: 'hzd_photo_url' },
};
const OTHER_TITLES = { LOADING_INVOICE: 'Loading invoice', POD: 'POD', HSD_BILL: 'Diesel slip', CHALLAN: 'Challan', TOLL_BILL: 'Toll', TYRE_BILL: 'Tyre bill', MAINTENANCE_BILL: 'Maintenance bill', OTHER_BILL: 'Bill', OTHER_DOC: 'Paper', LOADING_QTY: 'Loading qty', UNLOADING_QTY: 'Unloading qty', KYC: 'KYC' };
const REJECT_REASONS = ['Photo blurred', 'Cut off', 'Wrong document', 'Expired', 'Name mismatch'];
const SUSPEND_REASONS = ['Left job', 'Docs expired', 'Absconding', 'Misconduct', 'Other'];
const CASH_MODES = ['Office Cash', 'UPI', 'Bank', 'Pump Cash', 'Fleet card'];

const inr = (n) => '₹ ' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inrTight = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const ago = (v) => { if (!v) return null; const s = Math.max(0, Math.round((Date.now() - new Date(v)) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// ── shell styles (self-contained; the ERP's Tailwind handles the rest) ─────
const BTN = 'rounded-lg border border-slate-700 bg-white/[0.04] px-3 py-2 text-[11.5px] font-extrabold text-slate-200 hover:border-slate-400 disabled:opacity-50';
const BTN_RD = 'rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-[11.5px] font-extrabold text-red-300 hover:border-red-400 disabled:opacity-50';
const BTN_EM = 'rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-[11.5px] font-extrabold text-emerald-300 hover:border-emerald-400 disabled:opacity-50';
const BTN_CY = 'rounded-lg border border-cyan-500/50 bg-cyan-500/10 px-3 py-2 text-[11.5px] font-extrabold text-cyan-300 hover:border-cyan-400 disabled:opacity-50';
const SOLID = 'rounded-lg bg-emerald-400 px-3 py-2 text-[11.5px] font-black text-[#04160d] hover:bg-emerald-300 disabled:opacity-50';
const SOLID_RD = 'rounded-lg bg-red-600 px-3 py-2 text-[11.5px] font-black text-white hover:bg-red-500 disabled:opacity-50';
const CHIP = (tone) => `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
  tone === 'cy' ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : tone === 'em' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : tone === 'am' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : tone === 'rd' ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : tone === 'vi' ? 'border-violet-500/40 bg-violet-500/10 text-violet-300' : 'border-slate-700 bg-white/[0.03] text-slate-400'}`;
const INP = 'w-full rounded-lg border border-slate-600 bg-[#0f172a] px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-cyan-400';

function useBlobOpener() {
  return useCallback(async (keyOrUrl) => {
    if (!keyOrUrl) return;
    if (/^https?:\/\//i.test(keyOrUrl)) { window.open(keyOrUrl, '_blank', 'noopener'); return; }
    const key = String(keyOrUrl).replace(/^\/?api\/v1\/files\//, '').replace(/^\/+/, '');
    const res = await fetch(`${API_BASE}/api/v1/files/${key}`, { headers: { Authorization: `Bearer ${tok()}` } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, []);
}

export default function DriverControlDrawer({ driverId, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('docs');
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const [geo, setGeo] = useState(null);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [rejectFor, setRejectFor] = useState(null);      // staged doc id
  const [rejectReason, setRejectReason] = useState('');
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({});
  const [delName, setDelName] = useState('');
  const [link, setLink] = useState(null);
  const [tripId, setTripId] = useState(null);
  const [hsd, setHsd] = useState({ litres: '', pump_name: '', slip_no: '', rate: '' });
  const [cash, setCash] = useState({ amount: '', mode: 'Office Cash', ref: '' });
  const [shown, setShown] = useState(false);
  const openFile = useBlobOpener();
  const officeUpload = useRef({});

  const say = (m) => { setToast(m); setTimeout(() => setToast(null), 3200); };
  const reviewer = me()?.full_name ?? me()?.email ?? 'office';

  const load = useCallback(async () => {
    try {
      const d = await api(`/driver-control/${driverId}/summary`);
      setData(d); setErr(null);
      if (!tripId && d.ledger?.trips?.[0]) setTripId(d.ledger.trips[0].trip_id);
    } catch (e) { setErr(e.message); }
  }, [driverId, tripId]);
  useEffect(() => { load(); const iv = setInterval(load, 45000); return () => clearInterval(iv); }, [load]);
  useEffect(() => { const t = setTimeout(() => setShown(true), 10); return () => clearTimeout(t); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const id = data?.position?.trip_id;
    if (!id) { setGeo(null); return; }
    api(`/maps/trip/${id}/route`).then(setGeo).catch(() => setGeo(null));
  }, [data?.position?.trip_id]);

  const d = data?.driver;
  const access = data?.access;
  const led = useMemo(() => data?.ledger?.trips?.find((t) => t.trip_id === tripId) ?? data?.ledger?.trips?.[0] ?? null, [data, tripId]);
  const pendingPapers = (data?.papers ?? []).filter((p) => ['PENDING', 'NEEDS_CORRECTION', 'MISSING', 'EXPIRED'].includes(p.state)).length;
  const otherDocs = (data?.documents ?? []).filter((x) => !PAPER[x.doc_type] && x.status === 'PENDING').slice(0, 8);
  const over = !!(led?.hsd?.over || led?.cash?.over);

  const act = async (key, fn, okMsg) => {
    setBusy(key);
    try { await fn(); if (okMsg) say(okMsg); await load(); }
    catch (e) { say(`❌ ${e.message}`); }
    setBusy(null);
  };

  // ── actions ───────────────────────────────────────────────────────────────
  const suspend = () => act('suspend', () => api(`/access/DRIVER/${driverId}/block`, { method: 'POST', body: JSON.stringify({ reason: suspendReason || 'Suspended from Driver Control' }) }), `⛔ ${d?.name} suspended — app login blocked, sessions killed`).then(() => { setSuspendOpen(false); setSuspendReason(''); });
  const activate = () => act('activate', () => api(`/access/DRIVER/${driverId}/activate`, { method: 'POST', body: '{}' }), `✅ ${d?.name} active — app login works`);
  const archive = () => act('archive', () => api(`/access/DRIVER/${driverId}/archive`, { method: 'POST', body: JSON.stringify({ reason: 'Deleted (archived) from Driver Control' }) }), `🗑 ${d?.name} archived`).then(() => setDelName(''));
  const mintLink = () => act('link', async () => { const r = await api('/auth/driver/link', { method: 'POST', body: JSON.stringify({ driver_id: driverId, valid_hours: 72 }) }); setLink(r); }, null);
  const approveDoc = (doc) => act(`ap-${doc.id}`, () => api(`/queues/partner-documents/${doc.id}/approve`, { method: 'POST', body: JSON.stringify({ reviewed_by: reviewer, ...(doc.ocr_data?.suggest ?? {}) }) }), `✓ ${PAPER[doc.doc_type]?.title ?? doc.doc_type} approved → core DB · driver app shows PDF`);
  const rejectDoc = (doc) => act(`rj-${doc.id}`, () => api(`/queues/partner-documents/${doc.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason || 'Please re-upload', reviewed_by: reviewer }) }), `↺ NEEDS CORRECTION · WhatsApp + app banner sent`).then(() => { setRejectFor(null); setRejectReason(''); });
  const notice = (kind, title, body) => act(`nt-${title}`, () => api(`/driver-control/${driverId}/notice`, { method: 'POST', body: JSON.stringify({ kind, title, body, whatsapp: true }) }), `🔔 Sent on WhatsApp + app banner: ${title}`);
  const issueHsd = () => act('hsd', async () => {
    const r = await api(`/driver-control/${driverId}/issue-hsd`, { method: 'POST', body: JSON.stringify({ trip_id: tripId, litres: Number(hsd.litres), pump_name: hsd.pump_name, slip_no: hsd.slip_no, rate: hsd.rate === '' ? null : Number(hsd.rate) }) });
    setData((s) => (s ? { ...s, ledger: r.ledger } : s));
    say(`⛽ ${hsd.litres} L issued → khata line written → driver app ledger updated${r.over ? ' · OVER TARGET (red on both screens)' : ''}`);
    setHsd({ litres: '', pump_name: hsd.pump_name, slip_no: '', rate: hsd.rate });
  }, null);
  const payCash = () => act('cash', async () => {
    const r = await api(`/driver-control/${driverId}/pay-cash`, { method: 'POST', body: JSON.stringify({ trip_id: tripId, amount: Number(cash.amount), mode: cash.mode, ref: cash.ref }) });
    setData((s) => (s ? { ...s, ledger: r.ledger } : s));
    say(`💵 ${inr(cash.amount)} paid (${cash.mode}) → khata line written → driver app ledger updated${r.over ? ' · OVER TARGET (red on both screens)' : ''}`);
    setCash({ amount: '', mode: cash.mode, ref: '' });
  }, null);
  const saveProfile = () => act('save', () => api(`/masters/drivers/${driverId}`, { method: 'PATCH', body: JSON.stringify(form) }), '💾 Saved').then(() => setEdit(false));
  const startEdit = () => { setForm({ name: d.name ?? '', mobile: d.mobile ?? '', alt_mobile: d.alt_mobile ?? '', address: d.address ?? '', join_date: d.join_date ? String(d.join_date).slice(0, 10) : '', guarantor_name: d.guarantor_name ?? '', guarantor_mobile: d.guarantor_mobile ?? '', remarks: d.remarks ?? '' }); setEdit(true); };
  const uploadFromOffice = async (kind, e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    await act(`up-${kind}`, async () => {
      const ext = (file.name?.match(/\.([A-Za-z0-9]+)$/)?.[1] || 'jpg').toLowerCase();
      const { url } = await uploadMedia(file, `drivers/${slug(d.mobile || d.name || driverId)}/${slug(PAPER[kind].col)}_${Date.now()}.${ext}`);
      await api(`/masters/drivers/${driverId}`, { method: 'PATCH', body: JSON.stringify({ [PAPER[kind].col]: url }) });
    }, `📎 ${PAPER[kind].title} filed from the office`);
  };

  // ── render ────────────────────────────────────────────────────────────────
  const truck = data?.position?.lat != null ? { lat: Number(data.position.lat), lng: Number(data.position.lng), heading: 0, label: data.position.vehicle_no } : geo?.truck ? { lat: geo.truck.lat, lng: geo.truck.lng, heading: 0, label: data?.position?.vehicle_no } : null;
  const fixAge = ago(data?.position?.recorded_at);
  const dlDays = d?.license_expiry ? Math.round((new Date(d.license_expiry) - new Date()) / 86400000) : null;
  const stateTone = access?.state === 'ACTIVE' ? 'em' : access?.state === 'PENDING' ? 'am' : 'rd';

  return (
    <div className="fixed inset-0 z-[1500]" role="dialog" aria-label="Driver Control Dashboard" data-driver-control>
      <div className={`absolute inset-0 bg-slate-950/55 backdrop-blur-[2px] transition-opacity duration-300 ${shown ? 'opacity-100' : 'opacity-0'}`} onMouseDown={onClose} />
      <aside className={`absolute right-0 top-0 flex h-full w-[600px] max-w-full flex-col border-l border-cyan-500/40 bg-[#0b1424] text-slate-200 shadow-[-30px_0_60px_rgba(0,0,0,0.6)] transition-transform duration-300 ${shown ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ fontFamily: '"Segoe UI",system-ui,-apple-system,Roboto,sans-serif' }}>
        {/* header */}
        <div className="border-b border-slate-800 bg-gradient-to-b from-cyan-500/[0.06] to-transparent px-4 pb-2.5 pt-3">
          <p className="text-[9.5px] font-black uppercase tracking-[0.15em] text-cyan-300">Driver Control Dashboard</p>
          <div className="mt-1.5 flex items-start gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-cyan-500/50 bg-cyan-500/10 text-[16px] font-black text-cyan-300">{initials(d?.name)}</span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[19px] font-black leading-tight text-white">{d?.name ?? '…'}</h2>
              <p className="text-[11.5px] text-slate-400">{d?.mobile ? `+91 ${d.mobile}` : 'no mobile'} · {d?.market_driver ? 'MARKET driver' : 'OWN driver'}{d?.join_date ? ` · joined ${day(d.join_date)}` : ''} · id ····{String(driverId).slice(-4)}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {data?.position?.vehicle_no && <span className={CHIP('cy')}>🚚 {data.position.vehicle_no}</span>}
                {data?.position?.trip_code && <span className={CHIP('em')}>{data.position.trip_code} · {String(data.position.status ?? '').replace('_', ' ').toLowerCase()}</span>}
                {led?.cash?.over && <span className={CHIP('rd')}>💵 cash over by {inrTight(-led.cash.balance)}</span>}
                {led?.hsd?.over && <span className={CHIP('rd')}>⛽ HSD over by {-led.hsd.balance_l} L</span>}
                {dlDays != null && dlDays < 30 && <span className={CHIP(dlDays < 0 ? 'rd' : 'am')}>DL {dlDays < 0 ? `expired ${-dlDays}d` : `expires ${dlDays}d`}</span>}
                {access?.live_sessions > 0 && <span className={CHIP('sl')}>app · {access.live_sessions} live</span>}
              </div>
            </div>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:border-white hover:text-white" title="Close (Esc)">✕</button>
          </div>

          {/* status */}
          <div className={`mt-2.5 flex items-center gap-2.5 rounded-xl border px-3 py-2 ${access?.state === 'ACTIVE' ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : access?.state === 'PENDING' ? 'border-amber-500/40 bg-amber-500/[0.07]' : 'border-red-500/45 bg-red-500/[0.08]'}`} data-status={access?.state}>
            <span className={`h-2.5 w-2.5 rounded-full ${access?.state === 'ACTIVE' ? 'bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.25)]' : access?.state === 'PENDING' ? 'bg-amber-400' : 'bg-red-400 shadow-[0_0_0_4px_rgba(248,113,113,0.25)]'}`} />
            <div className="min-w-0 flex-1">
              <b className="text-[12.5px] text-white">{access?.state === 'ACTIVE' ? 'ACTIVE · app access on' : access?.state === 'PENDING' ? 'PENDING · app access not enabled yet' : access?.state === 'ARCHIVED' ? 'ARCHIVED' : 'SUSPENDED · app access blocked'}</b>
              <small className="block text-[10.5px] text-slate-400">{access?.state === 'ACTIVE' ? 'Driver can log in, upload, see the map and the ledger. Trips stay either way.' : access?.last_action ? `${access.last_action.action} by ${access.last_action.actor_name ?? 'office'} · ${when(access.last_action.created_at)}${access.last_action.reason ? ` · ${access.last_action.reason}` : ''}` : 'Activate to let the driver into the app.'}</small>
            </div>
            {access?.state === 'ACTIVE'
              ? <button className={BTN_RD} disabled={busy === 'suspend'} onClick={() => setSuspendOpen((v) => !v)} data-toggle>⏻ Suspend app access</button>
              : <button className={BTN_EM} disabled={busy === 'activate'} onClick={activate} data-toggle>⏻ {access?.state === 'PENDING' ? 'Activate' : 'Re-activate'}</button>}
          </div>
          {suspendOpen && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-red-500/50 p-2" data-suspend>
              {SUSPEND_REASONS.map((r) => <button key={r} onClick={() => setSuspendReason(r)} className={`rounded-full border px-2.5 py-1 text-[10.5px] font-extrabold ${suspendReason === r ? 'border-red-400 bg-red-500/10 text-red-300' : 'border-slate-700 text-slate-200'}`}>{r}</button>)}
              <button className={`${SOLID_RD} ml-auto`} disabled={!suspendReason || busy === 'suspend'} onClick={suspend}>Confirm suspend</button>
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            <a className={`${BTN} flex-1 text-center`} href={d?.mobile ? `tel:+91${d.mobile}` : undefined}>📞 Call</a>
            <a className={`${BTN} flex-1 text-center`} href={d?.mobile ? `https://wa.me/91${d.mobile}` : undefined} target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>
            <button className={`${BTN_CY} flex-1`} onClick={mintLink} disabled={busy === 'link'}>🔗 Login link (72 h)</button>
          </div>
          {link?.url && (
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] px-2 py-1.5 text-[10.5px]">
              <span className="truncate font-mono text-cyan-200">{link.url}</span>
              <button className={`${BTN} ml-auto shrink-0 !py-1`} onClick={() => { navigator.clipboard?.writeText(link.url); say('Copied'); }}>Copy</button>
              <a className={`${BTN} shrink-0 !py-1`} href={`https://wa.me/91${d?.mobile}?text=${encodeURIComponent('Prasad Transport app login: ' + link.url)}`} target="_blank" rel="noopener noreferrer">Send</a>
            </div>
          )}
        </div>

        {/* live strip */}
        <div className="border-b border-slate-800">
          <div className="relative h-[170px] bg-[#0a1626]">
            <RouteMap height={170} className="!rounded-none !border-0" origin={geo?.origin ?? null} destination={geo?.destination ?? null} truck={truck} polyline={geo?.route?.polyline ?? null} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-1.5 text-[11.5px]">
            {data?.position?.lat != null
              ? <span className="flex items-center gap-1.5 font-extrabold text-emerald-300"><i className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> LIVE · {fixAge}</span>
              : <span className="font-extrabold text-slate-500">● no live fix</span>}
            {data?.position?.speed_kmh != null && <span className="text-slate-400">{Math.round(Number(data.position.speed_kmh))} km/h</span>}
            {data?.position ? <span className="text-slate-400">{data.position.loading_point ?? '?'} → {data.position.destination ?? '?'}{geo?.route?.distance_km ? ` · ${geo.route.distance_km} km` : ''}</span> : <span className="text-slate-500">no open trip</span>}
            {data?.position?.source && <span className={CHIP('sl')}>{data.position.source}</span>}
          </div>
        </div>

        {/* tabs */}
        <div className="flex gap-0.5 border-b border-slate-800 px-3 pt-1.5">
          {[['docs', 'Document Locker', pendingPapers ? String(pendingPapers) : null, 'am'], ['ledger', 'Ledger', led ? (over ? 'over' : 'ok') : null, over ? 'rd' : 'em'], ['profile', 'Profile', null], ['activity', 'Activity', null]].map(([k, label, badge, tone]) => (
            <button key={k} onClick={() => setTab(k)} className={`border-b-2 px-2.5 py-2 text-[12px] font-extrabold ${tab === k ? 'border-cyan-300 text-cyan-300' : 'border-transparent text-slate-400'}`} data-tab={k}>
              {label}{badge && <span className={`ml-1.5 rounded-full px-1.5 text-[9.5px] ${tone === 'rd' ? 'bg-red-600 text-white' : tone === 'em' ? 'bg-emerald-600 text-white' : 'bg-amber-400 text-[#1f1300]'}`}>{badge}</span>}
            </button>
          ))}
        </div>

        <div className="mc-thin-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3">
          {err && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{err}</p>}
          {!data && !err && <p className="text-[12px] text-slate-500">Loading…</p>}

          {/* ── DOCS ── */}
          {data && tab === 'docs' && (<>
            {(data.papers ?? []).map((p) => {
              const P = PAPER[p.kind]; const s = p.staged; const ocr = s?.ocr_data;
              const tone = p.state === 'APPROVED' ? 'em' : p.state === 'PENDING' ? 'am' : p.state === 'MISSING' ? 'sl' : 'rd';
              const border = p.state === 'PENDING' ? 'border-amber-500/45' : p.state === 'APPROVED' ? 'border-emerald-500/35' : p.state === 'MISSING' ? 'border-dashed border-slate-700' : 'border-red-500/45';
              return (
                <div key={p.kind} className={`rounded-xl border bg-white/[0.02] px-3 py-2.5 ${border}`} data-paper={p.kind}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[18px]">{P.icon}</span><b className="text-[13px] text-white">{P.title}</b>
                    <span className={CHIP(tone)}>{p.state.replace('_', ' ')}</span>
                    {ocr?.match?.score != null && <span className={CHIP('vi')}>🤖 Milan {ocr.match.score}%</span>}
                    {p.days_left != null && p.days_left < 30 && <span className={CHIP(p.days_left < 0 ? 'rd' : 'am')}>{p.days_left < 0 ? `expired ${-p.days_left}d` : `expires ${p.days_left}d`}</span>}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    {p.state === 'PENDING' && s && <>Uploaded from <em className="font-mono not-italic text-slate-200">driver app</em> · {when(s.created_at)}{ocr?.suggest && Object.keys(ocr.suggest).length ? <> · OCR read: <em className="font-mono not-italic text-slate-200">{Object.entries(ocr.suggest).map(([k, v]) => `${k} ${v}`).join(' · ')}</em></> : ' · OCR pending'}</>}
                    {p.state === 'NEEDS_CORRECTION' && s && <>Rejected by <em className="font-mono not-italic text-slate-200">{s.reviewed_by ?? 'office'}</em> · {when(s.reviewed_at)} · reason: <em className="font-mono not-italic text-slate-200">{s.reject_reason}</em> · WhatsApp + app banner sent · not re-uploaded yet</>}
                    {(p.state === 'APPROVED' || p.state === 'EXPIRED') && <>On the driver record{p.expiry ? ` · valid till ${day(p.expiry)}` : ''} · driver sees View + PDF in the app</>}
                    {p.state === 'MISSING' && <>Never uploaded. Ask the driver from here, or file it from the office if the paper is on the desk.</>}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.state === 'PENDING' && s && (<>
                      <button className={SOLID} disabled={busy === `ap-${s.id}`} onClick={() => approveDoc(s)}>✓ Approve → core DB</button>
                      <button className={BTN_RD} onClick={() => { setRejectFor(rejectFor === s.id ? null : s.id); setRejectReason(''); }}>↺ Resend / Reject</button>
                      <button className={BTN} onClick={() => openFile(s.file_key)}>👁 View</button>
                    </>)}
                    {(p.state === 'APPROVED' || p.state === 'EXPIRED') && (<>
                      <button className={BTN} onClick={() => openFile(p.approved_file)}>👁 View</button>
                      <label className={`${BTN} cursor-pointer`}>📎 Replace<input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => uploadFromOffice(p.kind, e)} /></label>
                      {p.state === 'EXPIRED' && <button className={BTN_CY} onClick={() => notice('DOC_REQUEST', `${P.title} expire ho gaya — naya bhejo`, 'Please upload the renewed paper from the app')}>🔔 Ask for renewed copy</button>}
                    </>)}
                    {p.state === 'NEEDS_CORRECTION' && s && (<>
                      <button className={BTN} onClick={() => openFile(s.file_key)}>👁 View</button>
                      <button className={BTN_CY} onClick={() => notice('DOC_REQUEST', `${P.title} — dobara bhejo`, s.reject_reason)}>🔔 Remind driver</button>
                    </>)}
                    {p.state === 'MISSING' && (<>
                      <button className={BTN_CY} onClick={() => notice('DOC_REQUEST', `${P.title} bhejo`, 'Please upload from the app — Digital Locker')}>🔔 Ask driver</button>
                      <label className={`${BTN} cursor-pointer`}>📎 Upload from office<input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => uploadFromOffice(p.kind, e)} /></label>
                    </>)}
                  </div>
                  {rejectFor === s?.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-red-500/50 p-2" data-reject>
                      {REJECT_REASONS.map((r) => <button key={r} onClick={() => setRejectReason(r)} className={`rounded-full border px-2.5 py-1 text-[10.5px] font-extrabold ${rejectReason === r ? 'border-red-400 bg-red-500/10 text-red-300' : 'border-slate-700 text-slate-200'}`}>{r}</button>)}
                      <button className={`${SOLID_RD} ml-auto`} disabled={!rejectReason || busy === `rj-${s.id}`} onClick={() => rejectDoc(s)}>Send to driver</button>
                    </div>
                  )}
                </div>
              );
            })}
            {otherDocs.length > 0 && (
              <div className="rounded-xl border border-slate-800 px-3 py-2">
                <b className="text-[11px] uppercase tracking-wide text-slate-400">Other papers from the cab · pending</b>
                {otherDocs.map((x) => (
                  <div key={x.id} className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px]">
                    <span className="font-bold text-slate-200">{OTHER_TITLES[x.doc_type] ?? x.doc_type}</span>
                    <span className="text-slate-500">{x.trip_code ?? ''} · {when(x.created_at)}{x.amount ? ` · ${inr(x.amount)}` : ''}{x.qty ? ` · ${x.qty}` : ''}</span>
                    {x.ocr_data?.match?.score != null && <span className={CHIP('vi')}>Milan {x.ocr_data.match.score}%</span>}
                    <span className="ml-auto flex gap-1">
                      <button className={`${BTN} !py-1`} onClick={() => openFile(x.file_key)}>👁</button>
                      <button className={`${SOLID} !py-1`} disabled={busy === `ap-${x.id}`} onClick={() => approveDoc(x)}>✓</button>
                      <button className={`${BTN_RD} !py-1`} onClick={() => { setRejectFor(x.id); setRejectReason('Photo blurred'); }}>↺</button>
                    </span>
                    {rejectFor === x.id && <button className={`${SOLID_RD} !py-1`} onClick={() => rejectDoc(x)}>Reject: {rejectReason}</button>}
                  </div>
                ))}
              </div>
            )}
          </>)}

          {/* ── LEDGER ── */}
          {data && tab === 'ledger' && (led ? (<>
            {data.ledger.trips.length > 1 && (
              <div className="flex flex-wrap gap-1.5">{data.ledger.trips.map((t) => <button key={t.trip_id} onClick={() => setTripId(t.trip_id)} className={`rounded-full border px-2.5 py-1 text-[10.5px] font-extrabold ${t.trip_id === led.trip_id ? 'border-cyan-400 text-cyan-300' : 'border-slate-700 text-slate-300'}`}>{t.trip_code} · {t.loading_point} → {t.destination}</button>)}</div>
            )}
            <div className="grid grid-cols-2 gap-2.5">
              {[['⛽ HSD (diesel)', led.hsd.target_l, led.hsd.issued_l, led.hsd.balance_l, led.hsd.over, 'L', `${led.trip_code}${led.rtkm ? ` · ${led.rtkm} km` : ''} · target = trip fixed HSD`],
                ['💵 Cash', led.cash.target, led.cash.paid, led.cash.balance, led.cash.over, '₹', `${led.loading_point ?? ''} → ${led.destination ?? ''} · target = trip fixed cash`]].map(([title, target, got, bal, ov, unit, note]) => (
                <div key={title} className="rounded-xl border border-slate-800 bg-white/[0.02] px-3 py-2.5" data-ledger-card>
                  <div className="flex items-baseline justify-between gap-2"><b className="text-[13px] text-white">{title}</b><span className="text-right text-[9.5px] text-slate-500">{note}</span></div>
                  {[['Target', target == null ? 'not set' : unit === 'L' ? `${target} L` : inr(target)], [unit === 'L' ? 'Issued' : 'Paid', unit === 'L' ? `${got} L` : inr(got)]].map(([k, v]) => <div key={k} className="flex justify-between py-0.5 text-[12px] text-slate-400"><span>{k}</span><b className="font-mono text-[13px] text-slate-100">{v}</b></div>)}
                  <div className="mt-1 flex items-baseline justify-between border-t border-slate-800 pt-1.5 text-[12px] text-slate-400"><span>Balance</span>
                    <b className={`font-mono text-[22px] font-black ${bal == null ? 'text-slate-500' : ov ? 'text-red-400' : 'text-emerald-300'}`} data-balance>{bal == null ? '—' : `${bal < 0 ? '-' : ''}${unit === 'L' ? `${Math.abs(bal)} L` : inr(Math.abs(bal))}`}</b></div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-slate-800"><i className={`block h-full ${ov ? 'bg-red-500' : 'bg-emerald-400'}`} style={{ width: `${target ? Math.min(100, Math.round((got / target) * 100)) : 0}%` }} /></div>
                  {ov && <p className="mt-1 text-[10.5px] font-extrabold text-red-400">Over target by {unit === 'L' ? `${-bal} L` : inr(-bal)} — shows RED on the driver's phone</p>}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1.5 rounded-xl border border-cyan-500/35 bg-cyan-500/[0.04] px-3 py-2.5" data-issue-hsd>
                <b className="text-[12.5px] text-cyan-300">Issue HSD</b>
                <div className="flex items-center gap-1.5"><input className={`${INP} !w-[76px] font-extrabold`} type="number" placeholder="L" value={hsd.litres} onChange={(e) => setHsd({ ...hsd, litres: e.target.value })} /><span className="text-[11px] font-bold text-slate-400">L</span><input className={INP} placeholder="Pump" value={hsd.pump_name} onChange={(e) => setHsd({ ...hsd, pump_name: e.target.value })} /></div>
                <div className="flex items-center gap-1.5"><input className={INP} placeholder="Slip no." value={hsd.slip_no} onChange={(e) => setHsd({ ...hsd, slip_no: e.target.value })} /><input className={`${INP} !w-[70px]`} type="number" placeholder="₹/L" value={hsd.rate} onChange={(e) => setHsd({ ...hsd, rate: e.target.value })} /></div>
                <button className={SOLID} disabled={!(Number(hsd.litres) > 0) || busy === 'hsd'} onClick={issueHsd}>Issue HSD →</button>
              </div>
              <div className="flex flex-col gap-1.5 rounded-xl border border-cyan-500/35 bg-cyan-500/[0.04] px-3 py-2.5" data-pay-cash>
                <b className="text-[12.5px] text-cyan-300">Pay cash</b>
                <div className="flex items-center gap-1.5"><span className="text-[11px] font-bold text-slate-400">₹</span><input className={`${INP} !w-[90px] font-extrabold`} type="number" placeholder="0" value={cash.amount} onChange={(e) => setCash({ ...cash, amount: e.target.value })} /><select className={INP} value={cash.mode} onChange={(e) => setCash({ ...cash, mode: e.target.value })}>{CASH_MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
                <input className={INP} placeholder="Ref / note" value={cash.ref} onChange={(e) => setCash({ ...cash, ref: e.target.value })} />
                <button className={SOLID} disabled={!(Number(cash.amount) > 0) || busy === 'cash'} onClick={payCash}>Pay cash →</button>
              </div>
            </div>
            {/* what the driver's phone shows right now */}
            <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/[0.04] px-3 py-2.5" data-driver-sees>
              <div className="mb-2 flex items-center justify-between text-[12px]"><b className="text-emerald-300">📱 Driver sees — live</b><span className="text-[10.5px] text-slate-500">as of {when(data.ledger.as_of)}</span></div>
              <div className="max-w-[340px] rounded-xl bg-white px-3 pb-1 pt-2 text-slate-900" style={{ fontFamily: '"Segoe UI","Nirmala UI",system-ui,sans-serif' }}>
                <div className="flex justify-between text-[12px] font-extrabold text-slate-700">💰 ट्रिप भत्ता · बैलेंस<span className="text-[10px] font-semibold text-slate-500">{led.trip_code}{led.rtkm ? ` · ${led.rtkm} km` : ''}</span></div>
                {[['⛽', 'डीज़ल (HSD)', led.hsd.target_l, led.hsd.issued_l, led.hsd.balance_l, led.hsd.over, 'L'], ['💵', 'कैश', led.cash.target, led.cash.paid, led.cash.balance, led.cash.over, '₹']].map(([ic, name, target, got, bal, ov, unit]) => (
                  <div key={name} className="grid grid-cols-[20px_1fr_auto] items-center gap-2 border-t border-slate-100 py-1.5">
                    <span>{ic}</span>
                    <div><div className="text-[12px] font-extrabold">{name}</div><div className="text-[10px] font-semibold text-slate-500">{target == null ? 'टारगेट तय नहीं' : `टारगेट ${unit === 'L' ? `${target} L` : inrTight(target)} · मिला ${unit === 'L' ? `${got} L` : inrTight(got)}`}</div>
                      <div className="mt-0.5 h-1 overflow-hidden rounded bg-slate-200"><i className={`block h-full ${ov ? 'bg-red-600' : 'bg-green-600'}`} style={{ width: `${target ? Math.min(100, Math.round((got / target) * 100)) : 0}%` }} /></div>
                      {ov && <div className="text-[9.5px] font-extrabold text-red-600">टारगेट से {unit === 'L' ? `${-bal} L` : inrTight(-bal)} ज़्यादा</div>}</div>
                    <div className="min-w-[60px] text-right"><div className={`text-[17px] font-black leading-none ${bal == null ? 'text-slate-400' : ov ? 'text-red-600' : 'text-green-700'}`}>{bal == null ? '—' : `${bal < 0 ? '-' : ''}${unit === 'L' ? `${Math.abs(bal)} L` : inrTight(Math.abs(bal))}`}</div><div className="text-[9px] font-bold text-slate-500">बाकी</div></div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <b className="text-[12px] text-white">Issued on this trip</b>
              {[...(led.hsd_lines ?? []).map((h) => ({ at: h.issued_at, tone: 'am', title: `HSD ${h.litres} L`, detail: `${h.pump_name ?? ''} ${h.slip_no ? '· slip ' + h.slip_no : ''} · by ${h.issued_by ?? 'office'}` })),
                ...(led.cash_lines ?? []).map((c) => ({ at: c.created_at ?? c.txn_date, tone: 'em', title: `${c.txn_type === 'FUEL_EXPENSE' ? 'Fuel money' : 'Cash'} ${inr(c.amount)}`, detail: `${c.mode ?? ''} · ${c.remarks ?? ''}` }))]
                .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 12).map((e, i) => (
                  <div key={i} className="grid grid-cols-[86px_12px_1fr] items-start gap-2 py-1.5 text-[11.5px]"><span className="font-mono text-[10.5px] text-slate-500">{when(e.at)}</span><span className={`mt-1 h-2.5 w-2.5 rounded-full ${e.tone === 'am' ? 'bg-amber-400' : 'bg-emerald-400'}`} /><div><b className="text-white">{e.title}</b><small className="block text-slate-400">{e.detail}</small></div></div>
                ))}
              {!(led.hsd_lines?.length || led.cash_lines?.length) && <p className="text-[11px] text-slate-500">Nothing issued on this trip yet.</p>}
            </div>
            <p className="border-t border-slate-800 pt-2 text-[10.5px] leading-relaxed text-slate-400">Every issue writes the trip's running total and a khata line for the driver, then the phone picks up the new balance on its next tick (30 s or when the app comes to the front). Over-target is allowed and stays red on both screens.</p>
          </>) : <p className="text-[12px] text-slate-500">No open trip — HSD and cash are issued against a trip.</p>)}

          {/* ── PROFILE ── */}
          {data && tab === 'profile' && (<>
            <div className="flex items-center gap-2">
              {!edit ? <button className={BTN_CY} onClick={startEdit} data-edit>✎ Edit</button> : (<><button className={SOLID} disabled={busy === 'save'} onClick={saveProfile}>💾 Save</button><button className={BTN} onClick={() => setEdit(false)}>Cancel</button></>)}
              <span className="ml-auto text-[10.5px] text-slate-500">Numbers approved from documents are locked — replace the document to change them.</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2" data-profile>
              {[['name', 'Name'], ['mobile', 'Mobile (login)'], ['alt_mobile', 'Alt mobile'], ['join_date', 'Joined', 'date'], ['guarantor_name', 'Guarantor'], ['guarantor_mobile', 'Guarantor mobile'], ['address', 'Address', 'text', true], ['remarks', 'Remarks', 'text', true]].map(([k, label, type = 'text', wide]) => (
                <div key={k} className={wide ? 'col-span-2' : ''}>
                  <label className="mb-0.5 block text-[9.5px] font-black uppercase tracking-wide text-slate-400">{label}</label>
                  {edit ? <input className={INP} type={type} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                    : <div className="min-h-[30px] rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[12.5px] text-white">{k === 'join_date' ? day(d[k]) : (d[k] ?? '—')}</div>}
                </div>
              ))}
              {[['license_no', 'DL number'], ['license_expiry', 'DL expiry', 'date'], ['aadhar_last4', 'Aadhaar (last 4)'], ['pan_no', 'PAN'], ['bank_name', 'Bank'], ['account_no', 'Bank A/C'], ['ifsc_code', 'IFSC'], ['hzd_cert_no', 'HZD cert'], ['hzd_expiry', 'HZD expiry', 'date']].map(([k, label, type]) => (
                <div key={k}><label className="mb-0.5 block text-[9.5px] font-black uppercase tracking-wide text-slate-400">{label} 🔒</label><div className="min-h-[30px] rounded-lg border border-dashed border-slate-700 bg-white/[0.02] px-2.5 py-1.5 font-mono text-[12px] text-slate-300">{type === 'date' ? day(d[k]) : (d[k] ?? '—')}</div></div>
              ))}
            </div>
            <div className="rounded-xl border border-red-500/40 bg-red-500/[0.05] px-3 py-2.5" data-danger>
              <b className="text-[12px] text-red-300">Delete driver</b>
              <p className="my-1 text-[11px] leading-relaxed text-slate-400">Archives the driver: app access ends and sessions are killed, the name leaves the pickers. Trips, expenses, khata and ledger lines stay untouched for the books. Type the name to confirm.</p>
              <input className={INP} placeholder={`Type ${String(d?.name ?? '').toUpperCase()} to confirm`} value={delName} onChange={(e) => setDelName(e.target.value)} />
              <button className={`${SOLID_RD} mt-2`} disabled={delName.trim().toUpperCase() !== String(d?.name ?? '').trim().toUpperCase() || busy === 'archive'} onClick={archive}>🗑 Delete (archive) driver</button>
            </div>
          </>)}

          {/* ── ACTIVITY ── */}
          {data && tab === 'activity' && (
            <div data-activity>
              {(data.activity ?? []).map((e, i) => (
                <div key={i} className="grid grid-cols-[86px_12px_1fr] items-start gap-2 py-1.5 text-[11.5px]">
                  <span className="font-mono text-[10.5px] text-slate-500">{when(e.at)}</span>
                  <span className={`mt-1 h-2.5 w-2.5 rounded-full ${e.kind === 'ACCESS' ? 'bg-red-400' : e.kind === 'LOGIN' ? 'bg-emerald-400' : e.kind === 'CASH' || e.kind === 'HSD' ? 'bg-amber-400' : e.kind === 'NOTICE' ? 'bg-cyan-400' : 'bg-slate-500'}`} />
                  <div><b className="text-white">{e.title}</b>{e.who && <span className="text-slate-400"> · {e.who}</span>}{e.detail && <small className="block text-slate-400">{e.detail}</small>}</div>
                </div>
              ))}
              {!(data.activity ?? []).length && <p className="text-[12px] text-slate-500">No activity yet.</p>}
            </div>
          )}
        </div>

        <div className="flex justify-between border-t border-slate-800 px-3.5 py-2 text-[10.5px] text-slate-500">
          <span>{access?.last_action ? `Last access change: ${access.last_action.actor_name ?? 'office'} · ${when(access.last_action.created_at)}` : 'No access changes yet'}</span>
          <span>access_hub_audit + khata · every action here is logged</span>
        </div>
        {toast && <div className="absolute bottom-14 left-1/2 z-10 w-[90%] -translate-x-1/2 rounded-xl bg-white px-4 py-2.5 text-center text-[12.5px] font-extrabold text-slate-900 shadow-2xl" data-toast>{toast}</div>}
      </aside>
    </div>
  );
}

/** Mount once. Listens for openDriverControl() and shows the drawer. */
export function DriverControlHost() {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const on = (e) => { if (e.detail?.driver_id) setOpen({ id: e.detail.driver_id, name: e.detail.name }); };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  if (!open) return null;
  return <DriverControlDrawer key={open.id} driverId={open.id} onClose={() => setOpen(null)} />;
}
