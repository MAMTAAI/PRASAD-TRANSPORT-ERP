// @ts-nocheck
// ============================================================================
// MODULE 1 — OPERATIONS FLEET COMMAND (Ops View)
// Left: KPIs · Document Vault · Driver Command Center
// Center: Vehicle RTKM productivity · Driver shortage recovery ·
//         Fleet Maintenance Hub · Live Fleet table
// Right: Live Dispatch Chat (Driver Vijay Singh — PT00409)
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Truck, Route, PackageOpen, FileWarning, ShieldAlert, FileCheck2,
  Users, Wrench, Radio, MessageSquareText, Send, Mic,
  FileText, ScanLine, Phone, Video, AlertTriangle, Gauge,
  Plus, Search, X, Maximize2, Paperclip, ExternalLink,
} from 'lucide-react';
import { API_BASE } from '../lib/apiBase';
import {
  GlassPanel, PanelHeader, KpiCard, StatusPill, Dot, Avatar, openDrilldown,
  TONE_CHIP, chipCls, PANEL_SHELL, SCROLL_PANE, ROW_CLS, BADGE_CLS,
} from './shared';
import { expiryTone, expiryLabel } from './useDashboardData';
import OwnerFleetMatrix from './OwnerFleetMatrix';
import LiveFleetMap from './LiveFleetMap';
import { UnloadingQueue } from './OpsWidgets';
import { VehicleRtkmPanel, ShortageRecoveryPanel } from './FleetProductivity';
import { MyWhatsApp, WA_LINK_ROLES } from '../ui/whatsappLink';
import LoadingActivity from './LoadingActivity';
import UnloadingActivity from './UnloadingActivity';
import DispatchConsole from './DispatchConsole';
import DriverCommandCenter from './DriverCommandCenter';
import FleetDocumentVault from './FleetDocumentVault';

// The left-column panel kit (TONE_CHIP / chipCls / PANEL_SHELL / SCROLL_PANE /
// ROW_CLS / BADGE_CLS) now lives in ./shared so Compliance Expiry, which is in
// another file, renders from the same tokens instead of a second copy.

// The tab bar the dispatch desk asked for. UNKNOWN is deliberately not one of
// these four: it is a real state — a number that has written in and sits on no
// master — and it appears in ALL with its own badge, plus a fifth tab that
// materialises only when there is something in it. A number nobody recognises
// is exactly the one worth seeing, so it is never filtered into invisibility.
// PUMP IS NOT A NEW MASTER, IT IS A TAB THAT WAS MISSING. The fuel pumps have
// always been in `vendors` under vendor_type = 'Fuel Pump' — nine of them
// reachable — and flattening every vendor to VENDOR is why a pump writing in
// showed up under "Anjaan" on the very screen dispatch uses to ring them.
const CHAT_TABS = [
  { key: 'ALL', label: 'All' },
  { key: 'DRIVER', label: 'Driver' },
  { key: 'PUMP', label: 'Pump' },
  { key: 'VENDOR', label: 'Vendor' },
  { key: 'CUSTOMER', label: 'Customer' },
];
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

/** Named where the ERP knows the number, and plainly the number where it does
 *  not. Never a placeholder that reads like a name. */
const chatName = (c) => c?.contact_name || c?.driver_name || (c?.phone ? `+91 ${c.phone}` : '');

/** Role as the app stored it at login. Only used where the mounting component
 *  has no user prop; the server is the boundary either way. */
function storedRole() {
  try { return String(JSON.parse(localStorage.getItem('prasad_user') || '{}')?.role || '').toUpperCase(); }
  catch { return ''; }
}

// Shown wherever the ERP genuinely holds no rows yet — never faked with a
// plausible-looking number.
function EmptyNote({ children }) {
  return <p className="px-1 py-3 text-[11px] text-slate-500 leading-relaxed">{children}</p>;
}

// ---------------------------------------------------------------------------
// MOCK DATA — matches the approved v5.0 design numbers exactly
// ---------------------------------------------------------------------------
const kpis = [
  { label: 'Fleet Size', value: '50', sub: 'Vehicles', icon: Truck, accent: 'cyan' },
  { label: 'Active Trips', value: '266', sub: 'Trips running', icon: Route, accent: 'emerald' },
  { label: 'Pending Unloading', value: '14', sub: 'Trips waiting', icon: PackageOpen, accent: 'amber' },
];

const documentVault = [
  { doc: 'EXPLOSIVE LICENSE', icon: ShieldAlert, state: 'Expired', days: '0 Days', tone: 'red', pulse: true },
  { doc: 'RULE 18', icon: FileWarning, state: '<5 Days', days: 'Amber', tone: 'amber', pulse: true },
  { doc: 'PUC', icon: FileCheck2, state: '<10 Days', days: 'Amber', tone: 'amber', pulse: false },
];

const drivers = [
  { name: 'Sanjiv Yadav', dl: { label: 'DL: Valid', tone: 'green' }, hzd: { label: 'HZD: Valid', tone: 'green' } },
  { name: 'Nazrul Islam', dl: { label: 'DL: <10 Days', tone: 'amber' }, hzd: { label: 'HZD: Valid', tone: 'green' } },
  { name: 'Ajay Kumar', dl: { label: 'DL: <30 Days', tone: 'amber' }, hzd: { label: 'HZD: <5 Days', tone: 'amber' } },
];

const liveFleet = [
  { vehicle: 'AS 25C 9908', route: 'Patgaon → Guwahati', status: 'En Route', tone: 'green', location: 'NH-27, Rangia Bypass' },
  { vehicle: 'AS 18A 4531', route: 'Bongaigaon → Haldia', status: 'Loading', tone: 'amber', location: 'BGR Refinery Gate 2' },
  { vehicle: 'WB 02X 7890', route: 'Bongaigaon → Haldia', status: 'Unloading', tone: 'cyan', location: 'Bongaigaon Rd' },
  { vehicle: 'AS 25C 4521', route: 'Haldia → Kolkata', status: 'En Route', tone: 'green', location: 'NH-116, Kolaghat' },
  { vehicle: 'AS 01K 3345', route: 'Guwahati → Silchar', status: 'En Route', tone: 'green', location: 'Meghalaya Border' },
];

// The dispatch chat used to be six invented drivers and a four-message
// conversation written into this file. It read as a working dispatch line on
// a system where no driver has ever sent a message — the exact thing the
// honesty contract in useDashboardData was written to prevent. It now comes
// from ops.dispatch_chats, which is wa_chats joined to the driver master.

/** "1m ago" / "3h ago" / "12 Aug" — relative while it is still today's
 *  traffic, absolute once it is old enough that a duration stops meaning
 *  anything to somebody scanning the list. */
function ago(ts) {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const clock = (ts) => (ts
  ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
  : '');

// ---------------------------------------------------------------------------
export default function OperationsDashboard({ live, filter }) {
  const [message, setMessage] = useState('');
  // Which conversation is open. Null means "the newest one", so the panel
  // opens on whoever messaged last without needing an effect to pick it.
  const [activeChatId, setActiveChatId] = useState(null);
  const [chatTab, setChatTab] = useState('ALL');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);

  // ── STARTING A CONVERSATION, WHICH THIS PANEL COULD NOT DO ────────────────
  // Everything below the tabs is an INBOX: it lists numbers that have already
  // written in. Eleven had. Meanwhile the ERP holds 69 numbers it can reach —
  // 55 drivers, 9 fuel pumps, vendors, customers — and not one of them could be
  // messaged from here. To tell a pump anything you left the ERP, found the
  // number elsewhere and typed it into a phone.
  //
  // `draftChat` is a conversation with somebody who has never written in. It
  // has no rows in wa_chats, so it cannot come from ops.dispatch_chats; it
  // lives here until the first message is sent, at which point the next refresh
  // returns it as a real thread and this is dropped.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);   // the full Dispatch Console
  const [pickerQ, setPickerQ] = useState('');
  const [directory, setDirectory] = useState(null);   // null = not loaded yet
  const [dirError, setDirError] = useState(null);
  const [draftChat, setDraftChat] = useState(null);

  const authHeaders = () => {
    const token = localStorage.getItem('prasad_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const loadDirectory = useCallback(async (q) => {
    setDirError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/crm/directory?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`,
        { headers: authHeaders() });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setDirectory(j.contacts ?? []);
    } catch (e) {
      // Named, not swallowed: an empty picker and a broken picker look
      // identical, and only one of them is the operator's problem.
      setDirectory([]);
      setDirError(e.message || 'directory load failed');
    }
  }, []);

  // Debounced because it fires on every keystroke and the query joins four
  // masters. 250ms is below the threshold where typing feels laggy.
  useEffect(() => {
    if (!pickerOpen) return;
    const t = setTimeout(() => loadDirectory(pickerQ), directory === null ? 0 : 250);
    return () => clearTimeout(t);
  }, [pickerOpen, pickerQ, loadDirectory]);   // eslint-disable-line react-hooks/exhaustive-deps

  // LIVE from GET /api/v1/dashboard/v5 (server/modules/dashboard.routes.js).
  const ops = live?.data?.ops ?? null;
  // Offline means "we have NOTHING to show" — the hook keeps the last good
  // payload across a failed poll, and one 20s timeout must not flip a screen
  // full of real numbers to "API not reachable". Numbers a poll stale beat a
  // banner every time; with no payload at all the banner is the honest state.
  const offline = !!live?.error && !live?.data;

  const kpiLive = ops ? [
    { label: 'Fleet Size', value: String(ops.fleet_size), sub: 'Active vehicles', icon: Truck, accent: 'cyan',
      metric: 'ops.fleet_size', raw: ops.fleet_size },
    { label: 'Active Trips', value: String(ops.active_trips), sub: 'In transit now', icon: Route, accent: 'emerald',
      metric: 'ops.active_trips', raw: ops.active_trips },
    { label: 'Pending Unloading', value: String(ops.pending_unloading), sub: 'Awaiting unload', icon: PackageOpen, accent: 'amber',
      metric: 'ops.pending_unloading', raw: ops.pending_unloading },
  // NO MOCK FALLBACK. This used to fall back to `kpis` -- Fleet Size 50, Active
  // Trips 266, Pending Unloading 14 -- invented figures rendered in exactly the
  // same type as real ones, with nothing on screen to tell them apart. That is
  // the failure useDashboardData's own honesty contract exists to forbid, and
  // it is where the "14 pending unloading" that nobody could reconcile came
  // from: it was never a query result, it was a constant from the design mock.
  ] : kpis.map((k) => ({ ...k, value: '--', sub: offline ? 'API unreachable' : 'no data', metric: null, raw: null }));

  // Dispatch chat: wa_chats joined to the driver master, server-side. An empty
  // list is a real answer here — no driver has messaged the company number —
  // and the panel says so rather than falling back to the constants that used
  // to live at the top of this file.
  const serverChats = ops?.dispatch_chats ?? [];
  // A draft sits at the TOP and only while it is still a draft. Once the first
  // message lands, the next refresh returns the same number as a real thread,
  // and keeping both would show one contact twice with different histories.
  const dispatchChats = draftChat && !serverChats.some((c) => c.phone === draftChat.phone)
    ? [draftChat, ...serverChats]
    : serverChats;
  // Ordered newest-first by the query, so index 0 is whoever spoke last. That
  // is the right default to open on, and it means no effect has to reach in
  // and pick one after the fetch lands.
  //
  // KEYED ON PHONE, NOT driver_id. The list is no longer drivers only — the
  // query returns customers, vendors and unrecognised numbers too, and
  // driver_id is null for all three. The phone is the WhatsApp identity and the
  // only key every row actually has.
  const chatCounts = dispatchChats.reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + 1; return a; }, {});
  const unknownCount = chatCounts.UNKNOWN || 0;
  const visibleChats = chatTab === 'ALL' ? dispatchChats : dispatchChats.filter((c) => c.kind === chatTab);
  // Resolved against the VISIBLE list so switching tabs moves the open
  // conversation with it, instead of leaving a thread on screen whose row is
  // no longer in the list above it.
  const activeChat = visibleChats.find((c) => c.phone === activeChatId) ?? visibleChats[0] ?? null;

  /** Open a conversation with somebody from the directory — the one click the
   *  panel was missing. An existing thread is selected; a contact who has never
   *  written in becomes a draft. Either way no number is typed. */
  const openContact = (contact) => {
    setPickerOpen(false);
    setPickerQ('');
    setSendError(null);
    setChatTab('ALL');                 // the contact may not be in the open tab
    setActiveChatId(contact.phone);
    const existing = serverChats.find((c) => c.phone === contact.phone);
    setDraftChat(existing ? null : {
      phone: contact.phone,
      kind: contact.kind,
      contact_name: contact.name,
      driver_name: contact.name,
      contact_sub: contact.sub,
      driver_id: contact.driver_id,
      trip_id: null, trip_code: null, trip_status: null, vehicle_no: null,
      last_text: null, last_direction: null, last_ts: null,
      unread: 0,
      messages: [],
      draft: true,
    });
  };

  /** SEND. The button this sits behind had no onClick at all — it was drawn,
   *  wired to nothing, and every press did exactly nothing while looking like
   *  it had worked. That is why wa_chats holds 165 incoming messages and zero
   *  outgoing ones.
   *
   *  The row is written by the ENGINE, through POST /crm/chats, with the
   *  WhatsApp message id and the session it went out on. So there is nothing to
   *  insert here — the refresh below is what brings the sent message back. */
  const sendMessage = async () => {
    const text = message.trim();
    if (!text || !activeChat || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/crm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ phone: activeChat.phone, text, trip_id: activeChat.trip_id ?? null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setMessage('');
      // The draft is deliberately NOT cleared here. It stops being rendered the
      // moment the refresh below returns this number as a real thread — that is
      // what the merge above keys on. Clearing it now would blank the panel for
      // the second or two in between, on the screen that has just been used.
      //
      // The convention useDashboardData listens for. Cheaper than threading a
      // reload callback down through three components.
      window.dispatchEvent(new Event('erp:data-changed'));
    } catch (e) {
      // KEPT IN THE BOX. Clearing the message on a failure loses what the
      // operator wrote, and they have no way to know it was not sent.
      setSendError(e.message || 'bhej nahi paye');
    } finally {
      setSending(false);
    }
  };

  const fleetRows = ops?.live_fleet?.length ? ops.live_fleet : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

      {/* ══════════════ LEFT PANEL ══════════════ */}
      <div className="lg:col-span-3 min-w-0 flex flex-col gap-4">

        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-3">
          {kpiLive.map((k) => (
            <KpiCard key={k.label} icon={k.icon} label={k.label} value={k.value} sub={k.sub} accent={k.accent}
                     onDrill={k.metric ? () => openDrilldown(k.metric, k.raw) : null} />
          ))}
        </div>

        {/* Fleet Document Vault — Master Document Vault and the 10-Day Watch,
            merged. One answered which KIND of paper expires soonest and never
            named a lorry; the other named one but said nothing about the rest of
            its file. Stacked they cost twice the height and still sent you to
            another screen to act. One row per LORRY, its whole file in the sheet. */}
        <FleetDocumentVault vault={ops?.fleet_vault} alerts={ops?.compliance_alerts} history={ops?.doc_history} fees={ops?.pending_fees} />


        {/* Driver Command Center — its own file now. The panel answers WHO and
            HOW BAD in one line; WHAT exactly is missing is the overlay it opens,
            the same split Loading Activity makes with its 7 DIN sheet. */}
        <DriverCommandCenter drivers={ops?.drivers} alerts={ops?.compliance_alerts} />
      </div>

      {/* ══════════════ CENTER PANEL ══════════════ */}
      <div className="lg:col-span-6 min-w-0 flex flex-col gap-4">

        {/* Vehicle productivity replaces the old "Best Vehicle Trips" line
            chart. That chart plotted trips per weekday: a shape with no vehicle
            in it, so nothing followed from reading it. This names the trucks
            and puts what they earned and lost on the same row. */}
        <VehicleRtkmPanel live={live} filter={filter} />

        {/* Shortage recovery sits with operations because collecting it is an
            operations job, not an accounts one. */}
        <ShortageRecoveryPanel live={live} filter={filter} />

        {/* Fleet Maintenance Hub */}
        <GlassPanel>
          <PanelHeader icon={Wrench} title="Fleet Maintenance Hub" accent="text-amber-400" />
          <div className="relative mx-4 mb-4 h-52 rounded-xl overflow-hidden border border-slate-700/50 bg-gradient-to-br from-slate-950 via-[#061019] to-slate-950">
            {/* Wireframe grid ground */}
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(34,211,238,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.12) 1px, transparent 1px)',
                backgroundSize: '28px 28px',
              }}
            />
            {/* 3D truck placeholder */}
            <div className="absolute inset-0 grid place-items-center">
              <div className="relative">
                <Truck size={110} strokeWidth={0.8} className="text-cyan-400/80 drop-shadow-[0_0_18px_rgba(34,211,238,0.45)]" />
                {/* TODO: replace with the interactive 3D truck model (three.js) */}
              </div>
            </div>
            {/* Glowing red alert badges */}
            <div className="absolute left-3 top-1/2 -translate-y-1/2 sm:left-[14%]">
              <div className="mc-glow-pulse flex items-center gap-1.5 rounded-lg border border-red-500/60 bg-red-950/70 backdrop-blur-sm px-2.5 py-1.5 shadow-[0_0_18px_rgba(248,113,113,0.4)]">
                <AlertTriangle size={12} className="text-red-400" />
                <span className="text-[10px] font-black text-red-300 whitespace-nowrap">TYRE — LOW TREAD</span>
              </div>
              <div className="ml-6 h-6 w-px bg-red-500/50" />
            </div>
            <div className="absolute right-3 top-6 sm:right-[14%]">
              <div className="mc-glow-pulse flex items-center gap-1.5 rounded-lg border border-red-500/60 bg-red-950/70 backdrop-blur-sm px-2.5 py-1.5 shadow-[0_0_18px_rgba(248,113,113,0.4)]">
                <Gauge size={12} className="text-red-400" />
                <span className="text-[10px] font-black text-red-300 whitespace-nowrap">ENGINE — SERVICE DUE</span>
              </div>
              <div className="ml-6 h-6 w-px bg-red-500/50" />
            </div>
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] tracking-[0.3em] font-bold text-cyan-500/60 uppercase">
              Digital Twin · AS 25C 9908
            </div>
          </div>
        </GlassPanel>

        {/* Live Fleet Operations */}
        <GlassPanel>
          <PanelHeader
            icon={Radio}
            title="Live Fleet Operations"
            accent="text-emerald-400"
            right={<Dot color="bg-emerald-400" pulse />}
          />
          {/* horizontal scroll wrapper keeps the table usable on mobile */}
          <div className="px-4 pb-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700/50">
                  <th className="py-2 pr-3 font-bold">Vehicle No.</th>
                  <th className="py-2 pr-3 font-bold">Route</th>
                  <th className="py-2 pr-3 font-bold">Status</th>
                  <th className="py-2 font-bold">Last Location</th>
                </tr>
              </thead>
              <tbody>
                {fleetRows.length === 0 ? (
                  <tr><td colSpan={4} className="py-4 text-[11px] text-slate-500">
                    {offline ? 'Live data unavailable — API not reachable.' : 'No trips are in transit right now.'}
                  </td></tr>
                ) : fleetRows.map((v, i) => (
                  <tr key={`${v.vehicle}-${i}`} className="border-b border-slate-800/60 last:border-0 hover:bg-white/5 transition-colors">
                    <td className="py-2.5 pr-3 text-[12px] font-black text-slate-100 whitespace-nowrap">{v.vehicle}</td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-400 whitespace-nowrap">{v.route}</td>
                    <td className="py-2.5 pr-3"><StatusPill tone="green">{v.status}</StatusPill></td>
                    <td className="py-2.5 text-[11px] text-slate-500 whitespace-nowrap">{v.driver || v.product || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      </div>

      {/* ══════════════ RIGHT PANEL — LIVE DISPATCH CHAT ══════════════ */}
      {/* The right column is a STACK now, not a single panel. `gap-4` matches
          the left column's rhythm, and the chat panel keeps its own 500px cap
          while this wrapper stays unbounded — so the loading widget below it
          adds its own height instead of squeezing the conversation. */}
      <div className="lg:col-span-3 min-w-0 flex flex-col gap-4">
        {/* HEIGHT-CAPPED, AND THE CAP IS THE POINT.
            This panel had `lg:h-full` and nothing else, so it grew to whatever
            the grid row was and then grew the row: a chat list capped at 240px,
            a thread with min-h-[220px], quick actions and a composer stacked
            underneath added to well over 600px and dragged the dashboard's
            right column past its neighbours. Every one of those pieces was
            individually reasonable; the column had no ceiling.
            500px is the ceiling. `lg:h-full` stays so it still aligns with the
            cards beside it when the row is shorter — it fills the row UP TO the
            cap, never past it. overflow-hidden keeps the rounded corner from
            being cut by the panes inside. */}
        <GlassPanel className="flex flex-col overflow-hidden max-h-[500px] lg:h-full lg:max-h-[500px] border-emerald-500/30 shadow-[0_0_30px_rgba(52,211,153,0.08)]">
          <PanelHeader
            icon={MessageSquareText}
            title="Live Dispatch Chat"
            accent="text-emerald-400"
            right={
              <button
                onClick={() => setConsoleOpen(true)}
                title="Poora Dispatch Console kholo — inline PDF/photo, record linking, saare threads"
                className="flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/25 transition-colors"
              >
                <Maximize2 size={11} /> EXPAND
              </button>
            }
          />

          {/* WHATSAPP, WHERE THE CHATS ARE — not three screens away.
              An empty chat list has two very different causes: nobody has
              written in, or this desk's WhatsApp is not connected at all. The
              panel used to render the first message for both, which is a
              confident lie in the second case. This row says which, and offers
              the link right here when the answer is the second one. */}
          {WA_LINK_ROLES.includes(storedRole()) && <MyWhatsApp variant="panel" />}

          <div className="flex flex-col md:flex-row lg:flex-col flex-1 min-h-0">
            {/* Chat list */}
            <div className="md:w-1/3 lg:w-full border-b md:border-b-0 md:border-r lg:border-r-0 lg:border-b border-slate-700/50">
              {/* Tabs, with counts. A count on a tab is the cheapest way to say
                  "there is nothing here" without making somebody click to find
                  out — and it makes an empty Vendor tab read as an answer
                  rather than as a screen that failed to load. */}
              {/* The tab strip is a header, so it gets header height — one row
                  of chips and no more. It scrolls sideways rather than wrapping
                  to a second line, because a wrap here shifts every pane below
                  it and knocks the panel out of line with the cards beside it. */}
              <div className="flex items-center gap-1 px-2.5 pt-1 pb-1.5 overflow-x-auto mc-hide-scrollbar shrink-0">
                {/* FIRST, AND STICKY, BECAUSE IT IS THE ONLY CONTROL HERE THAT
                    IS NOT A FILTER. Everything else narrows a list of people
                    who already wrote in; this one reaches the other 69. It
                    stays put while the tabs scroll sideways past it. */}
                <button
                  onClick={() => { setPickerOpen(true); setDirectory(null); }}
                  title="Kisi bhi driver, pump, vendor ya customer ko message karein"
                  className="shrink-0 sticky left-0 z-10 flex items-center gap-0.5 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                >
                  <Plus size={11} /> NAYA
                </button>
                {CHAT_TABS.concat(unknownCount ? [{ key: 'UNKNOWN', label: 'Anjaan' }] : []).map((t) => {
                  const n = t.key === 'ALL' ? dispatchChats.length : (chatCounts[t.key] || 0);
                  const on = chatTab === t.key;
                  return (
                    <button
                      key={t.key}
                      onClick={() => { setChatTab(t.key); setActiveChatId(null); }}
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-black transition-colors border
                        ${on ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                             : 'bg-transparent border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600'}`}
                    >
                      {t.label}
                      <span className={`ml-1 font-bold ${on ? 'text-emerald-400/80' : 'text-slate-600'}`}>{n}</span>
                    </button>
                  );
                })}
              </div>

              {/* 140px is about three rows. The list is the INDEX, not the
                  content — past three the thread below it starts losing the
                  space that actually shows the conversation. */}
              <div className="px-2 pb-1.5 max-h-[140px] overflow-y-auto mc-thin-scrollbar flex flex-col gap-0.5">
                {visibleChats.length === 0 ? (
                  <EmptyNote>
                    {/* "Wait for somebody to write in" was the only advice this
                        could give while the panel was inbox-only. It is now
                        wrong advice — NAYA reaches every number the ERP holds
                        without waiting for anyone. */}
                    {offline
                      ? 'Live data unavailable — API not reachable.'
                      : dispatchChats.length === 0
                        ? 'Abhi kisi ne company ke WhatsApp number par message nahi kiya. Aap khud shuru kar sakte hain — upar NAYA dabayein aur kisi bhi driver, pump, vendor ya customer ko chunein.'
                        : `Is tab (${(CHAT_TABS.find((t) => t.key === chatTab) || {}).label || 'Anjaan'}) mein abhi koi chat nahi — baaki ${dispatchChats.length} All mein hain. Nayi baat shuru karne ke liye NAYA dabayein.`}
                  </EmptyNote>
                ) : visibleChats.map((c) => {
                  const on = c.phone === activeChat?.phone;
                  return (
                    <div
                      key={c.phone}
                      onClick={() => setActiveChatId(c.phone)}
                      className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors
                        ${on ? 'bg-emerald-500/10 border border-emerald-500/40'
                             : 'hover:bg-white/5 border border-transparent'}`}
                    >
                      <Avatar name={chatName(c)} size="w-7 h-7" textSize="text-[9px]"
                              ring={on ? 'ring-emerald-500/60' : 'ring-slate-700/60'} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-[11px] font-bold text-slate-200 truncate">{chatName(c)}</p>
                          <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${KIND_TONE[c.kind] || KIND_TONE.UNKNOWN}`}>
                            {KIND_LABEL[c.kind] || c.kind}
                          </span>
                        </div>
                        {/* Trip line only where there IS a trip — a vendor has
                            no trip and gets their number instead, rather than an
                            empty label sitting there looking broken. */}
                        <p className="text-[10px] text-slate-500 truncate">
                          {c.trip_code
                            ? <>
                                <span className="text-slate-400 font-semibold">{c.trip_code}</span>
                                {c.trip_status && <span className="text-emerald-400"> · {c.trip_status}</span>}
                                {c.vehicle_no && <span> · {c.vehicle_no}</span>}
                              </>
                            : `+91 ${c.phone}`}
                        </p>
                        {c.last_text && (
                          <p className="text-[10px] text-slate-600 truncate mt-0.5">
                            {c.last_direction === 'outgoing' && <span className="text-slate-500">Aap: </span>}
                            {c.last_text}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-[9px] text-slate-600">{ago(c.last_ts)}</span>
                        {c.unread > 0 && (
                          <span className="grid place-items-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-[9px] font-black text-white">{c.unread}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Active conversation */}
            <div className="flex-1 flex flex-col min-h-0">
              {activeChat && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700/50 bg-white/5 shrink-0">
                  <Avatar name={chatName(activeChat)} size="w-7 h-7" ring="ring-emerald-500/60" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-black text-slate-100 flex items-center gap-1.5 truncate">
                      {chatName(activeChat)} <Dot color="bg-emerald-400" pulse size="w-1.5 h-1.5" />
                      <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${KIND_TONE[activeChat.kind] || KIND_TONE.UNKNOWN}`}>
                        {KIND_LABEL[activeChat.kind] || activeChat.kind}
                      </span>
                    </p>
                    {/* "koi chalu trip nahi" is a DRIVER sentence. Said to a
                        vendor it reads as a fault on a record that was never
                        going to have a trip, so each kind gets its own line. */}
                    <p className="text-[10px] text-emerald-400 font-semibold truncate">
                      {activeChat.trip_code
                        ? `${activeChat.trip_status} · ${activeChat.trip_code}${activeChat.vehicle_no ? ' · ' + activeChat.vehicle_no : ''}`
                        : activeChat.kind === 'DRIVER'
                          ? `+91 ${activeChat.phone} · koi chalu trip nahi`
                          : activeChat.kind === 'UNKNOWN'
                            ? `+91 ${activeChat.phone} · kisi master mein nahi mila`
                            // vendor_type, where there is one: "Fuel Pump",
                            // "Spare Parts". It is the difference between
                            // ringing a pump and ringing a parts supplier, and
                            // the panel already has it.
                            : `+91 ${activeChat.phone}${activeChat.contact_sub ? ` · ${activeChat.contact_sub}` : ''}`}
                    </p>
                  </div>
                </div>
              )}

              {/* THE ONLY PANE THAT MAY GROW, AND IT GROWS INWARDS.
                  flex-1 with min-h-0 is what makes overflow-y-auto actually
                  scroll instead of expanding: without min-h-0 a flex child
                  refuses to shrink below its content, so the scroll container
                  never engages and the whole panel stretches — which is exactly
                  what a long conversation did to this dashboard. min-h-[110px]
                  keeps a couple of bubbles visible when the row is short. */}
              <div className="flex-1 min-h-[110px] overflow-y-auto mc-thin-scrollbar px-2.5 py-2 flex flex-col gap-1.5">
                {!activeChat ? (
                  <EmptyNote>
                    Jab koi chat aayegi, yahan uski poori baat-cheet dikhegi.
                  </EmptyNote>
                ) : (activeChat.messages ?? []).length === 0 ? (
                  <EmptyNote>
                    {activeChat.draft
                      ? `${chatName(activeChat)} ke saath abhi tak koi baat-cheet nahi hui. Neeche likh kar pehla message bhejein — poora record yahin save hoga.`
                      : 'Is number ke saath abhi koi message record nahi hai.'}
                  </EmptyNote>
                ) : (activeChat.messages ?? []).map((m, i) => {
                  const outgoing = m.direction === 'outgoing';
                  return (
                    <div key={i} className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[88%] rounded-xl px-2.5 py-1.5 border
                          ${outgoing
                            ? 'bg-slate-800/80 border-slate-700/60 rounded-br-sm'
                            : 'bg-emerald-600/25 border-emerald-500/40 rounded-bl-sm'}`}
                      >
                        <p className={`text-[9px] font-bold mb-px ${outgoing ? 'text-slate-500' : 'text-emerald-400'}`}>
                          [{outgoing ? (m.sent_by_user_name || 'Office') : chatName(activeChat)}] <span className="font-normal text-slate-600">{clock(m.ts)}</span>
                        </p>
                        <p className="text-[11.5px] text-slate-100 leading-[1.35] whitespace-pre-wrap break-words">{m.text}</p>
                        {/* Attachment chip — the compact panel says one exists;
                            opening it is the console's job (EXPAND). */}
                        {(m.media_key || m.media_type) && (
                          <button onClick={() => setConsoleOpen(true)}
                            className="mt-1 flex items-center gap-1 text-[9.5px] font-bold text-violet-300 hover:text-violet-200">
                            <Paperclip size={9} /> {m.media_key ? 'Attachment — console mein dekho' : m.media_type}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Quick actions and composer are FIXED FURNITURE — shrink-0 so
                  the thread above gives up space first. A composer that gets
                  squeezed to nothing is worse than a shorter message list. */}
              <div className="px-2.5 py-1.5 grid grid-cols-2 gap-1.5 border-t border-slate-700/50 shrink-0">
                <button className="flex items-center justify-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-1 text-[9.5px] font-black text-cyan-300 hover:bg-cyan-500/20 transition-colors">
                  <FileText size={12} /> SEND LR COPY
                </button>
                <button className="flex items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-1 text-[9.5px] font-black text-emerald-300 hover:bg-emerald-500/20 transition-colors">
                  <ScanLine size={12} /> SCAN FUEL SLIP OCR
                </button>
              </div>

              {/* Composer.
                  THIS BUTTON USED TO DO NOTHING. It was drawn with no onClick,
                  so pressing it looked exactly like sending and was not — which
                  is the whole of why wa_chats holds 165 incoming messages and
                  had zero outgoing ones. Enter sends too, because a chat box
                  that ignores Enter is a chat box people think is broken. */}
              <div className="px-2.5 pb-2 pt-1.5 shrink-0">
                {sendError && (
                  <p className="mb-1 text-[10px] text-red-400 leading-snug">
                    Bhej nahi paye — {sendError}. Aapka message neeche likha hua hai, dobara try karein.
                  </p>
                )}
                <div className="flex items-center gap-1.5">
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    disabled={!activeChat || sending}
                    placeholder={activeChat ? `${chatName(activeChat)} ko message…` : 'Pehle koi chat chunein…'}
                    className="flex-1 min-w-0 rounded-lg bg-slate-950/70 border border-slate-700/50 px-2.5 py-1.5 text-[11.5px] text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/60 disabled:opacity-50"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!activeChat || sending || !message.trim()}
                    title={activeChat ? 'Bhejein' : 'Koi chat chuni nahi gayi'}
                    className="grid place-items-center w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors shrink-0"
                  >
                    <Send size={14} className={sending ? 'animate-pulse' : ''} />
                  </button>
                  {/* Left visibly disabled rather than removed: voice notes are
                      not wired to anything, and a live-looking button that does
                      nothing is the exact fault being fixed one line above. */}
                  <button
                    disabled
                    title="Voice note abhi available nahi hai"
                    className="grid place-items-center w-8 h-8 rounded-lg bg-slate-800/60 text-slate-600 cursor-not-allowed shrink-0"
                  >
                    <Mic size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </GlassPanel>

        {/* DIRECTLY BELOW THE CHAT, WHICH IS WHERE IT WAS ASKED FOR AND ALSO
            WHERE IT BELONGS: dispatch watches this column all day, and "did
            today's loadings come in" is the same kind of question as "has
            anybody written in". */}
        {/* The full console — its own data path (/crm/threads + /crm/chats),
            inline media, record linking. Rendered above everything via portal
            semantics (fixed inset-0), unmounted when closed so its 5s poll
            stops with it. */}
        {consoleOpen && <DispatchConsole onClose={() => setConsoleOpen(false)} />}

        <LoadingActivity activity={ops?.loading_activity ?? null} offline={offline} />

        {/* AND UNLOADING DIRECTLY UNDER IT, because a trip is the pair and the
            two questions are asked in the same breath: what came in, and what
            is still out. The header's "PENDING UNLOADING 137" was the whole of
            the second answer until now — a number with nothing behind it. */}
        <UnloadingActivity activity={ops?.unloading_activity ?? null} offline={offline} />

        {/* ── CONTACT PICKER ────────────────────────────────────────────────
            PORTALLED, for the same reason the My WhatsApp dialog is: the shell
            header carries a backdrop-filter, and an ancestor with one becomes
            the containing block for `position: fixed`. Rendered in place this
            resolves `inset: 0` against a 75px-tall header.

            Grouped by kind rather than sorted flat. Dispatch thinks "I need
            the pump at Agartala", not "I need a contact beginning with A", and
            a flat list of 69 names makes them read every one. */}
        {pickerOpen && createPortal(
          <div
            onClick={() => setPickerOpen(false)}
            className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-[min(420px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60 bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
            >
              <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
                <span className="text-[13px] font-black text-slate-100">Kisko message karna hai?</span>
                <button onClick={() => setPickerOpen(false)} className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
              </div>

              <div className="px-4 pb-2.5">
                <div className="flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-950/70 px-2.5 py-1.5 focus-within:border-emerald-500/60">
                  <Search size={13} className="text-slate-500 shrink-0" />
                  <input
                    autoFocus
                    value={pickerQ}
                    onChange={(e) => setPickerQ(e.target.value)}
                    placeholder="Naam ya number se dhoondhein…"
                    className="flex-1 min-w-0 bg-transparent text-[12px] text-slate-200 placeholder-slate-600 outline-none"
                  />
                  {pickerQ && (
                    <button onClick={() => setPickerQ('')} className="text-slate-500 hover:text-slate-300 shrink-0">
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-2 pb-3">
                {directory === null ? (
                  <p className="px-2 py-4 text-[11.5px] text-slate-500">Directory laa rahe hain…</p>
                ) : dirError ? (
                  <p className="px-2 py-4 text-[11.5px] text-red-400 leading-relaxed">
                    Contact list nahi aa payi — {dirError}
                  </p>
                ) : directory.length === 0 ? (
                  <p className="px-2 py-4 text-[11.5px] text-slate-500 leading-relaxed">
                    {pickerQ
                      ? `"${pickerQ}" se koi contact nahi mila.`
                      : 'ERP ke kisi bhi master mein mobile number nahi hai. Driver Master, Vendor ya Customer mein number bharein — yahan apne aap aa jayenge.'}
                  </p>
                ) : CHAT_TABS.slice(1).concat([{ key: 'CONTACT', label: 'Contact' }]).map((g) => {
                  const rows = directory.filter((c) => c.kind === g.key);
                  if (!rows.length) return null;
                  return (
                    <div key={g.key} className="mb-1.5">
                      <p className="px-2 pt-2 pb-1 text-[9.5px] font-black uppercase tracking-wider text-slate-500">
                        {g.label} <span className="text-slate-600">{rows.length}</span>
                      </p>
                      {rows.map((c) => (
                        <button
                          key={c.phone}
                          onClick={() => openContact(c)}
                          className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/5 transition-colors"
                        >
                          <Avatar name={c.name || c.phone} size="w-7 h-7" textSize="text-[9px]" ring="ring-slate-700/60" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[11.5px] font-bold text-slate-200 truncate">{c.name || `+91 ${c.phone}`}</p>
                            <p className="text-[10px] text-slate-500 truncate">
                              +91 {c.phone}{c.sub ? ` · ${c.sub}` : ''}
                            </p>
                          </div>
                          <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${KIND_TONE[c.kind] || KIND_TONE.UNKNOWN}`}>
                            {KIND_LABEL[c.kind] || c.kind}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
      </div>
      {/* The dispatch map belongs with Operations, not CRM — it is what
          dispatch watches all day.

          THE col-span IS LOAD-BEARING. This block and the matrix below it are
          direct children of the `lg:grid-cols-12` grid that opens this
          component. A grid child with no column span occupies exactly ONE
          track, so without `lg:col-span-12` these two took a twelfth of the
          width each — about 8% — and the map, the "polling" pill and the
          waiting queue folded into a pair of unreadable ribbons with their
          labels stacked on top of each other. Anything appended to this grid
          from here on needs a span for the same reason. */}
      <div className="lg:col-span-12 grid grid-cols-1 xl:grid-cols-2 gap-4 items-stretch [&>*]:min-w-0">
        <LiveFleetMap />
        <UnloadingQueue live={live} />
      </div>

      {/* Owner fleet sits with the fleet. Clicking a row scopes the whole dashboard,
          so this table and the KPI cards above always agree. Full width — the
          matrix carries fourteen figures per owner and has nowhere to put them
          in a narrow column. */}
      <div className="lg:col-span-12 min-w-0">
      <OwnerFleetMatrix
        filters={filter?.filters}
        set={filter?.set}
        onOpenStatement={(owner) => {
          // The statement lives in the Accounts module. Hand the owner over
          // through sessionStorage so it opens already scoped instead of
          // making the user pick the same name a second time.
          try { sessionStorage.setItem('pt_owner_statement_owner', owner); } catch {}
          window.dispatchEvent(new CustomEvent('pt:open-owner-statement', { detail: owner }));
        }}
      />
      </div>

    </div>
  );
}
