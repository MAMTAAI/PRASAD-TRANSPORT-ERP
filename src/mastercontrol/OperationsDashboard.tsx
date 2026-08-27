// @ts-nocheck
// ============================================================================
// MODULE 1 — OPERATIONS FLEET COMMAND (Ops View)
// Left: KPIs · Document Vault · Driver Command Center
// Center: Vehicle RTKM productivity · Driver shortage recovery ·
//         Fleet Maintenance Hub · Live Fleet table
// Right: Live Dispatch Chat (Driver Vijay Singh — PT00409)
// ============================================================================
import React, { useEffect, useState } from 'react';
import {
  Truck, Route, PackageOpen, FileWarning, ShieldAlert, FileCheck2,
  Users, Wrench, Radio, MessageSquareText, Send, Mic,
  FileText, ScanLine, Phone, Video, AlertTriangle, Gauge,
} from 'lucide-react';
import {
  GlassPanel, PanelHeader, KpiCard, StatusPill, Dot, Avatar, openDrilldown,
} from './shared';
import { expiryTone, expiryLabel } from './useDashboardData';
import OwnerFleetMatrix from './OwnerFleetMatrix';
import LiveFleetMap from './LiveFleetMap';
import { UnloadingQueue } from './OpsWidgets';
import { VehicleRtkmPanel, ShortageRecoveryPanel, ComplianceAlertsPanel } from './FleetProductivity';
import { MyWhatsApp, WA_LINK_ROLES } from '../ui/whatsappLink';

// The tab bar the dispatch desk asked for. UNKNOWN is deliberately not one of
// these four: it is a real state — a number that has written in and sits on no
// master — and it appears in ALL with its own badge, plus a fifth tab that
// materialises only when there is something in it. A number nobody recognises
// is exactly the one worth seeing, so it is never filtered into invisibility.
const CHAT_TABS = [
  { key: 'ALL', label: 'All' },
  { key: 'DRIVER', label: 'Driver' },
  { key: 'VENDOR', label: 'Vendor' },
  { key: 'CUSTOMER', label: 'Customer' },
];
const KIND_TONE = {
  DRIVER:   'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  VENDOR:   'text-amber-300 border-amber-500/40 bg-amber-500/10',
  CUSTOMER: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  UNKNOWN:  'text-slate-400 border-slate-600/50 bg-slate-700/20',
};
const KIND_LABEL = { DRIVER: 'Driver', VENDOR: 'Vendor', CUSTOMER: 'Customer', UNKNOWN: 'Anjaan' };

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

  // LIVE from GET /api/v1/dashboard/v5 (server/modules/dashboard.routes.js).
  const ops = live?.data?.ops ?? null;
  const offline = !!live?.error;

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
  const dispatchChats = ops?.dispatch_chats ?? [];
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

  const fleetRows = ops?.live_fleet?.length ? ops.live_fleet : [];
  const driverRows = ops?.drivers?.length ? ops.drivers : [];
  const vault = ops?.doc_vault ?? [];

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

        {/* Master Document Vault */}
        <GlassPanel>
          <PanelHeader
            icon={FileWarning}
            title="Master Document Vault"
            onTitleClick={() => openDrilldown('ops.doc_expiry', null)}
            accent="text-red-400"
            right={<StatusPill tone="red" pulse>Compliance Alerts</StatusPill>}
          />
          <div className="px-4 pb-4 flex flex-col gap-2">
            {vault.length === 0 ? (
              <EmptyNote>
                No vehicle document expiry dates are recorded in the ERP yet — all
                {' '}{ops ? ops.fleet_size : 0} active vehicles have insurance, fitness,
                permit, PUC and tax dates blank. Fill them in <span className="text-slate-300 font-semibold">Vehicle Documents</span>
                {' '}and this vault starts warning you before anything expires.
              </EmptyNote>
            ) : vault.map((d) => {
              const tone = expiryTone(d.days);
              return (
                <div key={d.doc}
                  className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 bg-white/5
                    ${tone === 'red' ? 'border-red-500/50 shadow-[0_0_18px_rgba(248,113,113,0.18)]'
                      : tone === 'amber' ? 'border-amber-500/40' : 'border-slate-700/50'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <FileWarning size={15} className={tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-400' : 'text-slate-400'} />
                    <span className="text-[11px] font-bold text-slate-200 truncate">{d.doc}</span>
                  </div>
                  <StatusPill tone={tone} pulse={tone === 'red'}>{expiryLabel(d.days)}</StatusPill>
                </div>
              );
            })}
          </div>
        </GlassPanel>

        {/* The 10-day red alert, directly under the vault it belongs to. The
            vault says WHICH KIND of paper expires soonest; this says whose. */}
        <ComplianceAlertsPanel live={live} />

        {/* Driver Command Center */}
        <GlassPanel>
          <PanelHeader icon={Users} title="Driver Command Center" accent="text-cyan-400" />
          <div className="px-4 pb-4 flex flex-col gap-2">
            {driverRows.length === 0 ? (
              <EmptyNote>No driver licence / hazardous-cert expiry dates recorded yet.</EmptyNote>
            ) : driverRows.map((d) => (
              <div key={d.name} className="flex items-center justify-between gap-2 rounded-xl bg-white/5 border border-slate-700/50 px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar name={d.name} />
                  <span className="text-[12px] font-semibold text-slate-200 truncate">{d.name}</span>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5 shrink-0">
                  <StatusPill tone={expiryTone(d.dl_days)}>DL: {expiryLabel(d.dl_days)}</StatusPill>
                  <StatusPill tone={expiryTone(d.hzd_days)}>HZD: {expiryLabel(d.hzd_days)}</StatusPill>
                </div>
              </div>
            ))}
          </div>
        </GlassPanel>
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
      <div className="lg:col-span-3 min-w-0">
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
              <div className="flex items-center gap-2 text-slate-500">
                <Phone size={14} className="hover:text-emerald-400 cursor-pointer" />
                <Video size={14} className="hover:text-emerald-400 cursor-pointer" />
              </div>
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
                    {offline
                      ? 'Live data unavailable — API not reachable.'
                      : dispatchChats.length === 0
                        ? 'Abhi kisi ne company ke WhatsApp number par message nahi kiya. Jaise hi koi driver, vendor ya customer likhega, uski baat-cheet yahan apne aap aa jayegi.'
                        : `Is tab (${(CHAT_TABS.find((t) => t.key === chatTab) || {}).label || 'Anjaan'}) mein abhi koi chat nahi — baaki ${dispatchChats.length} All mein hain.`}
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
                            : `+91 ${activeChat.phone}`}
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

              {/* Composer */}
              <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1.5 shrink-0">
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type a message…"
                  className="flex-1 min-w-0 rounded-lg bg-slate-950/70 border border-slate-700/50 px-2.5 py-1.5 text-[11.5px] text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/60"
                />
                <button className="grid place-items-center w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shrink-0">
                  <Send size={14} />
                </button>
                <button className="grid place-items-center w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors shrink-0">
                  <Mic size={14} />
                </button>
              </div>
            </div>
          </div>
        </GlassPanel>
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
