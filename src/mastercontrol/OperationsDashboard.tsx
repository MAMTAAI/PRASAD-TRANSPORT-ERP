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

const chatList = [
  { id: 'PT00409', name: 'Sanjiv Yadav', time: '1m ago', active: true, unread: 3 },
  { id: 'PT00404', name: 'Nazrul Islam', time: '1h ago', active: false, unread: 0 },
  { id: 'PT00404B', name: 'Nazrul Islam', time: '1h ago', active: false, unread: 0 },
  { id: 'PT00403', name: 'Ajay Kumar', time: '1h ago', active: false, unread: 0 },
  { id: 'PT00402', name: 'Rohit Verma', time: '1h ago', active: false, unread: 0 },
  { id: 'PT00401', name: 'Vikram Das', time: '2h ago', active: false, unread: 0 },
];

const chatThread = [
  { from: 'driver', who: 'Driver Vijay', time: '10:20', text: 'Just starting Patgaon run.' },
  { from: 'admin', who: 'Admin', time: '10:22', text: 'Safe travels. Update ETA.' },
  { from: 'driver', who: 'Driver Vijay', time: '10:24', text: 'AS25C9807 status = Loading 🚛. Correct?' },
  { from: 'admin', who: 'Admin', time: '10:25', text: 'Yes. ETA Patgaon ≈ 2h. Safe travels.' },
];

// ---------------------------------------------------------------------------
export default function OperationsDashboard({ live, filter }) {
  const [message, setMessage] = useState('');

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
        <GlassPanel className="flex flex-col lg:h-full border-emerald-500/30 shadow-[0_0_30px_rgba(52,211,153,0.08)]">
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

          <div className="flex flex-col md:flex-row lg:flex-col flex-1 min-h-0">
            {/* Chat list */}
            <div className="md:w-1/3 lg:w-full border-b md:border-b-0 md:border-r lg:border-r-0 lg:border-b border-slate-700/50">
              <p className="px-4 pt-1 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Chat List</p>
              <div className="px-2 pb-2 max-h-44 overflow-y-auto flex flex-col gap-1">
                {chatList.map((c) => (
                  <div
                    key={c.id}
                    className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer transition-colors
                      ${c.active
                        ? 'bg-emerald-500/10 border border-emerald-500/40'
                        : 'hover:bg-white/5 border border-transparent'}`}
                  >
                    <Avatar name={c.name} size="w-8 h-8" textSize="text-[10px]" ring={c.active ? 'ring-emerald-500/60' : 'ring-slate-700/60'} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-bold text-slate-200 truncate">
                        {c.id} {c.active && <span className="text-emerald-400 font-semibold">(Active)</span>}
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">{c.name}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-[9px] text-slate-600">{c.time}</span>
                      {c.unread > 0 && (
                        <span className="grid place-items-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-[9px] font-black text-white">{c.unread}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Active conversation */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-slate-700/50 bg-white/5">
                <Avatar name="Vijay Singh" size="w-9 h-9" ring="ring-emerald-500/60" />
                <div className="min-w-0">
                  <p className="text-[12px] font-black text-slate-100 flex items-center gap-1.5 truncate">
                    Driver Vijay Singh <Dot color="bg-emerald-400" pulse size="w-1.5 h-1.5" />
                  </p>
                  <p className="text-[10px] text-emerald-400 font-semibold">Active · PT00409</p>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2.5 min-h-[220px]">
                {chatThread.map((m, i) => (
                  <div key={i} className={`flex ${m.from === 'admin' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-2 border
                        ${m.from === 'admin'
                          ? 'bg-slate-800/80 border-slate-700/60 rounded-br-sm'
                          : 'bg-emerald-600/25 border-emerald-500/40 rounded-bl-sm'}`}
                    >
                      <p className={`text-[9px] font-bold mb-0.5 ${m.from === 'admin' ? 'text-slate-500' : 'text-emerald-400'}`}>
                        [{m.who}] <span className="font-normal text-slate-600">{m.time}</span>
                      </p>
                      <p className="text-[12px] text-slate-100 leading-snug">{m.text}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Quick actions */}
              <div className="px-3 py-2 grid grid-cols-2 gap-2 border-t border-slate-700/50">
                <button className="flex items-center justify-center gap-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-2 py-2 text-[10px] font-black text-cyan-300 hover:bg-cyan-500/20 transition-colors">
                  <FileText size={13} /> SEND LR COPY
                </button>
                <button className="flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2 py-2 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/20 transition-colors">
                  <ScanLine size={13} /> SCAN FUEL SLIP OCR
                </button>
              </div>

              {/* Composer */}
              <div className="flex items-center gap-2 px-3 pb-3">
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type a message…"
                  className="flex-1 min-w-0 rounded-xl bg-slate-950/70 border border-slate-700/50 px-3 py-2 text-[12px] text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/60"
                />
                <button className="grid place-items-center w-9 h-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shrink-0">
                  <Send size={15} />
                </button>
                <button className="grid place-items-center w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors shrink-0">
                  <Mic size={15} />
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
