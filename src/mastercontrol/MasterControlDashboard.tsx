// @ts-nocheck
// ============================================================================
// MODULE 3 — CRM & PRASAD MASTER CONTROL
// Left: 10 Mahavidya AI Agent Fleet · Staff Profiles & Powers
// Center: High-resolution Live tracking in India (neon network placeholder)
// Right: Super WhatsApp CRM Inbox · Advanced Webmail & AI Desk · Tender pipeline
// Bottom HUD: scrolling Activity Logs & Reports ticker
// ============================================================================
import React, { useEffect } from 'react';
import {
  Bot, Wifi, Users, Satellite, MessageCircle, Mail, BrainCircuit,
  Activity, Signal, MapPin, Zap, ChevronRight, Inbox, Tags, AlarmClock,
} from 'lucide-react';
import { GlassPanel, PanelHeader, StatusPill, Dot, Avatar } from './shared';
import LiveStaffTracker from './LiveStaffTracker';
import LiveFleetMap from './LiveFleetMap';

// ---------------------------------------------------------------------------
// MOCK DATA — matches the approved v5.0 design exactly
// ---------------------------------------------------------------------------
const agents = [
  { name: 'Kali', load: 95 }, { name: 'Tara', load: 93 }, { name: 'Tripura Sundari', load: 93 },
  { name: 'Bhuvaneshwari', load: 90 }, { name: 'Chhinnamasta', load: 93 }, { name: 'Bhairavi', load: 92 },
  { name: 'Dhumavati', load: 92 }, { name: 'Bagalamukhi', load: 95 }, { name: 'Matangi', load: 95 },
  { name: 'Kamala', load: 92 },
];

const staff = [
  { name: 'Anjali Sharma', role: 'Chief Ops', active: true },
  { name: 'Rahul Gupta', role: 'Lead Dev', active: false },
  { name: 'Sameer Khan', role: 'Dispatch Mgr', active: false },
  { name: 'Anjali Goran', role: 'Chief Ops', active: false },
];

const powers = [
  { label: 'GPRS', tone: 'green' },
  { label: 'Driver Comms', tone: 'cyan' },
  { label: 'API Access', tone: 'amber' },
  { label: 'Security', tone: 'violet' },
];

const waChats = [
  { name: 'Driver Rohit', tag: 'Hello Pro-com Drivers…', time: '21 Nov', unread: 0, active: true },
  { name: 'Client IOCL', tag: 'Odd messages see and…', time: '19 Nov', unread: 8, active: false },
  { name: 'Client IOCL', tag: 'Client IOCL Notice', time: '19 Apr', unread: 0, active: false },
];

const waThread = [
  { from: 'them', text: 'Rohit, was that your AI messages and wud delivery?' , time: '18:23' },
  { from: 'us', text: 'Haan, LR + invoice covered. You message?', time: '18:25' },
];

const tenders = [
  { name: 'IOCL Tender', value: '₹8.5 Cr', win: '85% Win', tone: 'cyan' },
  { name: 'Tata Motors', value: '₹5.2 Cr', win: '70% Win', tone: 'emerald' },
];

const pipelineStages = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed/Won'];

const activityLog = [
  '08:14 Fleet node 7624 active', '08:14 IOCL deal stage updated', '08:14 Driver Vikram updated',
  '08:13 Driver Vikram updated', '08:13 Driver Vikram completed trip', '08:12 FASTag toll debit ₹485 · AS 25C 9908',
  '08:11 Tally sync batch #4471 committed', '08:10 KALI dispatched trip PT-2661', '08:09 New tender doc parsed by AI Desk',
];

// ---------------------------------------------------------------------------
// Neon India tracking network — decorative SVG placeholder (no external map)
// ---------------------------------------------------------------------------
function IndiaTrackingMap({ geo }) {
  // REAL toll-plaza footprint. trip_gps_pings is empty, so there is no live
  // vehicle position to plot; these are the plazas the fleet actually paid at,
  // which is a true record of the routes run. Labelled as such — a map that
  // implies live GPS when none exists is the worst kind of dashboard.
  const plazas = geo?.plazas ?? [];

  // Equirectangular projection over a fixed India bounding box, so a plaza
  // always lands in the same place regardless of which subset is loaded.
  const LAT_N = 35.5, LAT_S = 6.5, LNG_W = 68.0, LNG_E = 97.5;
  const px = (lat, lng) => ({
    x: ((lng - LNG_W) / (LNG_E - LNG_W)) * 100,
    y: ((LAT_N - lat) / (LAT_N - LAT_S)) * 100,
  });

  const maxCross = plazas.reduce((m, p) => Math.max(m, p.crossings), 1);
  const nodes = plazas.map((p) => ({ ...p, ...px(p.lat, p.lng) }));
  return (
    <div className="relative w-full h-full min-h-[340px] rounded-xl overflow-hidden border border-cyan-500/20 bg-[radial-gradient(ellipse_at_center,rgba(8,20,35,1)_0%,rgba(4,8,16,1)_75%)]">
      {/* starfield speckle */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: 'radial-gradient(rgba(148,163,184,0.25) 0.5px, transparent 0.5px)',
          backgroundSize: '22px 22px',
        }}
      />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
        <defs>
          <filter id="mcGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" /><feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Each plaza sized by how often the fleet crossed it. Radius is on a
            sqrt scale so a 111-crossing plaza does not swamp a 5-crossing one. */}
        {nodes.map((n, i) => {
          const r = 0.7 + 1.9 * Math.sqrt(n.crossings / maxCross);
          return (
            <g key={`${n.name}-${i}`} filter="url(#mcGlow)">
              <circle cx={n.x} cy={n.y} r={r * 2.1} fill="rgba(34,211,238,0.10)" />
              <circle cx={n.x} cy={n.y} r={r} fill="#22d3ee" opacity="0.85" />
            </g>
          );
        })}
      </svg>

      {/* Name only the busiest few — 149 labels would be a smear. */}
      {nodes.slice(0, 6).map((n, i) => (
        <span
          key={`lbl-${i}`}
          className="absolute -translate-x-1/2 text-[8px] font-bold text-slate-300/90 drop-shadow-[0_0_6px_rgba(34,211,238,0.6)] pointer-events-none whitespace-nowrap"
          style={{ left: `${n.x}%`, top: `calc(${n.y}% + 9px)` }}
        >
          {n.name.replace(/\s*(TOLL PLAZA|FEE PLAZA|PLAZA)$/i, '')}
        </span>
      ))}

      <div className="absolute top-3 right-3 flex items-center gap-2 rounded-full bg-slate-950/70 backdrop-blur-sm border border-slate-700/50 px-3 py-1.5">
        <span className="flex items-center gap-1 text-[9px] font-bold text-slate-300">
          <Dot color="bg-cyan-400" size="w-1.5 h-1.5" /> Toll plaza · size = crossings
        </span>
      </div>

      {/* The honest caption. This is a paid-toll footprint, not live tracking. */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-center px-3">
        {plazas.length === 0 ? (
          <p className="text-[10px] text-slate-500">No plaza coordinates available.</p>
        ) : (
          <>
            <p className="text-[9px] tracking-[0.25em] font-bold text-cyan-500/60 uppercase whitespace-nowrap">
              {plazas.length} toll plazas · {geo.geo_txns?.toLocaleString('en-IN')} crossings
            </p>
            <p className="mt-0.5 text-[8px] text-slate-500 leading-snug">
              Where the fleet actually paid toll.
              {!geo.live_gps_available && ' Live GPS is not available — no vehicle has ever reported a position.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function MasterControlDashboard({ live }) {
  // LIVE from GET /api/v1/dashboard/v5
  const crm = live?.data?.crm ?? null;
  const staffLive = crm?.staff?.length
    ? crm.staff.map((s) => ({ name: s.name, role: s.role, active: !!s.last_login }))
    : staff;
  // Ledger movements are the one activity feed that is real today; the WhatsApp
  // and tender panels below are still design placeholders.
  const wa = crm?.whatsapp ?? null;
  const geo = crm?.geo ?? null;
  const tickerLive = crm?.activity?.length
    ? crm.activity.map((a) => `${a.at}  ${a.text}`)
    : activityLog;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

        {/* ══════════════ LEFT PANEL ══════════════ */}
        <div className="lg:col-span-3 flex flex-col gap-4">

          {/* 10 Mahavidya AI Agent Fleet Command Center */}
          <GlassPanel className="border-emerald-500/30">
            <PanelHeader icon={Bot} title="10 Mahavidya AI Agent Fleet" accent="text-emerald-400" sub="Command Center" />
            <div className="px-3 pb-3">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 px-2 pb-1 text-[9px] font-bold uppercase tracking-wider text-slate-600">
                <span>AI Agent</span><span>Load</span><span>Net</span><span>Status</span>
              </div>
              <div className="max-h-72 overflow-y-auto flex flex-col gap-1 pr-1">
                {agents.map((a, i) => (
                  <div
                    key={a.name}
                    className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-2 rounded-lg px-2 py-1.5 border
                      ${i === 0 ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-white/5 border-slate-800/60'}`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {/* green optimal ring */}
                      <span className="relative grid place-items-center w-5 h-5 shrink-0">
                        <span className="absolute inset-0 rounded-full border-2 border-emerald-400/80 mc-glow-pulse" />
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      </span>
                      <span className="text-[11px] font-bold text-slate-200 truncate">{a.name}</span>
                    </span>
                    <span className="text-[11px] font-black text-emerald-300">{a.load}%</span>
                    <Signal size={11} className="text-emerald-400" />
                    <span className="text-[9px] font-bold text-cyan-300">Navigating</span>
                  </div>
                ))}
              </div>
            </div>
          </GlassPanel>

          {/* Staff Profiles & Powers */}
          <GlassPanel>
            <PanelHeader icon={Users} title="Staff Profiles & Powers" accent="text-violet-400" sub="Access module" />
            <div className="px-4 pb-4 grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1 lg:col-span-2 grid grid-cols-2 gap-2">
                {staffLive.map((s) => (
                  <div
                    key={s.name + s.role}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center
                      ${s.active ? 'bg-cyan-500/10 border-cyan-500/50' : 'bg-white/5 border-slate-700/50'}`}
                  >
                    <Avatar name={s.name} size="w-10 h-10" ring={s.active ? 'ring-cyan-400/70' : 'ring-slate-700/60'} />
                    <p className="text-[10px] font-black text-slate-100 leading-tight">{s.name}</p>
                    <p className="text-[9px] text-slate-500">{s.role}</p>
                  </div>
                ))}
              </div>
              <div className="col-span-2 sm:col-span-1 lg:col-span-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">Powers</p>
                <div className="flex lg:flex-col flex-wrap gap-1.5">
                  {powers.map((p) => (
                    <StatusPill key={p.label} tone={p.tone}>
                      <Zap size={9} /> {p.label}
                    </StatusPill>
                  ))}
                </div>
              </div>
            </div>
          </GlassPanel>
        </div>

        {/* ══════════════ CENTER PANEL — LIVE TRACKING ══════════════ */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* Real Google Maps with the live traffic layer. The SVG footprint
              that used to sit here (IndiaTrackingMap, still below) drew the
              toll-plaza network — useful as a coverage picture, but it is not
              vehicle tracking and was titled as though it might be. The map
              plots trucks that are actually reporting GPS and says plainly how
              many are not. */}
          <LiveFleetMap />

          <GlassPanel className="flex flex-col">
            <PanelHeader
              icon={Satellite}
              title="Fleet Route Footprint — India"
              accent="text-slate-400"
              sub="Toll-plaza network, not live positions"
              right={<StatusPill tone="cyan"><MapPin size={9} /> TOLL DATA</StatusPill>}
            />
            <div className="flex-1 px-4 pb-4">
              <IndiaTrackingMap geo={geo} />
            </div>
          </GlassPanel>
        </div>

        {/* ══════════════ RIGHT PANEL ══════════════ */}
        <div className="lg:col-span-4 flex flex-col gap-4">

          {/* Super WhatsApp CRM Inbox */}
          <GlassPanel className={wa?.engine?.connected ? 'border-emerald-500/30' : 'border-red-500/30'}>
            <PanelHeader
              icon={MessageCircle}
              title="Super WhatsApp CRM Inbox"
              accent={wa?.engine?.connected ? 'text-emerald-400' : 'text-red-400'}
              sub={wa ? `${wa.contacts} contacts · ${wa.total} messages` : ''}
              right={
                <StatusPill tone={wa?.engine?.connected ? 'green' : 'red'} pulse={!!wa?.engine?.connected}>
                  {wa?.engine?.status || '--'}
                </StatusPill>
              }
            />
            <div className="px-4 pb-4">
              {/* Engine state and message ledger are separate facts: the phone
                  can be linked while nothing has been said yet. */}
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="rounded-xl bg-white/5 border border-slate-700/50 px-2 py-2 text-center">
                  <p className="text-sm font-black text-white">{wa ? wa.inbound : '--'}</p>
                  <p className="text-[8px] text-slate-500 uppercase">received</p>
                </div>
                <div className="rounded-xl bg-white/5 border border-slate-700/50 px-2 py-2 text-center">
                  <p className="text-sm font-black text-white">{wa ? wa.outbound : '--'}</p>
                  <p className="text-[8px] text-slate-500 uppercase">sent</p>
                </div>
                <div className="rounded-xl bg-white/5 border border-slate-700/50 px-2 py-2 text-center">
                  <p className="text-sm font-black text-cyan-300">{wa ? wa.last_24h : '--'}</p>
                  <p className="text-[8px] text-slate-500 uppercase">last 24h</p>
                </div>
              </div>

              {(!wa || wa.chats.length === 0) ? (
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  {wa?.engine?.connected
                    ? 'WhatsApp is linked, but no message has been sent or received through the ERP yet. Conversations appear here the moment the first one flows.'
                    : 'WhatsApp engine is not reachable — link the phone from the Prasad engine, then messages start recording here.'}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-slate-600">Recent conversations</p>
                  {wa.chats.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-xl px-2 py-1.5 border border-transparent hover:bg-white/5 transition-colors">
                      <Avatar name={c.phone} size="w-7 h-7" textSize="text-[9px]" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-bold text-slate-200 truncate">
                          {c.phone}{c.role ? <span className="text-slate-500 font-normal"> · {c.role}</span> : null}
                        </p>
                        <p className="text-[9px] text-slate-500 truncate">
                          {c.direction === 'OUT' ? '↗ ' : '↘ '}{c.last}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-0.5 shrink-0">
                        <span className="text-[8px] text-slate-600">
                          {c.at ? new Date(c.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''}
                        </span>
                        <span className="text-[8px] text-slate-500">{c.msgs} msg</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </GlassPanel>

          {/* Advanced Webmail & AI Desk */}
          <GlassPanel>
            <PanelHeader icon={Mail} title="Advanced Webmail & AI Desk" accent="text-cyan-400" />
            <div className="px-4 pb-4">
              <div className="flex gap-1.5 mb-3 flex-wrap">
                {['Inbox', 'Tabs', 'AI Summary', 'Urgency'].map((t, i) => (
                  <span key={t} className={`px-2.5 py-1 rounded-lg text-[9px] font-bold border
                    ${i === 0 ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : 'text-slate-500 border-slate-700/50'}`}>
                    {t}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  {[{ i: Inbox, l: 'Inbox' }, { i: Tags, l: 'Tabs' }, { i: BrainCircuit, l: 'AI Summary' }].map((row) => (
                    <div key={row.l} className="flex items-center justify-between rounded-lg bg-white/5 border border-slate-700/50 px-2.5 py-1.5 cursor-pointer hover:bg-white/10 transition-colors">
                      <span className="flex items-center gap-2 text-[10px] font-bold text-slate-300"><row.i size={11} className="text-cyan-400" /> {row.l}</span>
                      <ChevronRight size={11} className="text-slate-600" />
                    </div>
                  ))}
                </div>
                <div className="rounded-xl bg-cyan-500/5 border border-cyan-500/30 px-3 py-2">
                  <p className="text-[9px] font-black text-cyan-300 uppercase flex items-center gap-1"><BrainCircuit size={10} /> AI Summary</p>
                  <p className="mt-1 text-[9px] text-slate-400 leading-relaxed">
                    New messages containing AI Summary tactics sorted automatically for theme.
                  </p>
                  <p className="mt-1.5 text-[9px] font-bold text-amber-400 flex items-center gap-1">
                    <AlarmClock size={9} /> Urgency <span className="text-slate-500 font-normal">· Read next</span>
                  </p>
                </div>
              </div>
            </div>
          </GlassPanel>

          {/* AI Brain Control — Visual Tender Pipeline */}
          <GlassPanel className="border-cyan-500/30">
            <PanelHeader icon={BrainCircuit} title="AI Brain Control" accent="text-cyan-400" sub="Visual tender pipeline" />
            <div className="px-4 pb-4">
              {/* stage rail */}
              <div className="flex items-center gap-1 overflow-x-auto pb-2 mc-hide-scrollbar">
                {pipelineStages.map((s, i) => (
                  <React.Fragment key={s}>
                    <span className={`shrink-0 px-2 py-1 rounded-full text-[8px] font-black uppercase border whitespace-nowrap
                      ${i === pipelineStages.length - 1
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                        : i === 2 ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : 'text-slate-500 border-slate-700/50'}`}>
                      {s}
                    </span>
                    {i < pipelineStages.length - 1 && <ChevronRight size={10} className="text-slate-700 shrink-0" />}
                  </React.Fragment>
                ))}
              </div>
              {/* deal cards linked by a glowing connector */}
              <div className="relative mt-2 flex flex-col gap-3 pl-4">
                <span className="absolute left-1 top-3 bottom-3 w-px bg-gradient-to-b from-cyan-400/70 via-emerald-400/50 to-emerald-400/70" />
                {tenders.map((t) => (
                  <div key={t.name} className="relative rounded-xl bg-white/5 border border-slate-700/50 px-3 py-2.5 hover:border-cyan-500/50 transition-colors">
                    <span className="absolute -left-[13px] top-1/2 -translate-y-1/2"><Dot color={t.tone === 'cyan' ? 'bg-cyan-400' : 'bg-emerald-400'} pulse size="w-2 h-2" /></span>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-black text-slate-100 truncate">{t.name} — {t.value}</p>
                      <StatusPill tone={t.tone === 'cyan' ? 'cyan' : 'green'}>{t.win}</StatusPill>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[9px] text-slate-500">
                      <span>Stage · Value</span><span>Probability</span><span>Time to Close</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </GlassPanel>
        </div>
      </div>

      {/* ══════════════ BOTTOM HUD — ACTIVITY TICKER ══════════════ */}
      {/* Boss monitoring — real sessions and the real audit trail, as opposed
          to the ticker below it, which is a scrolling summary of ledger
          movements. */}
      <LiveStaffTracker />

      <GlassPanel className="overflow-hidden border-cyan-500/25">
        <div className="flex items-center">
          <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-cyan-500/10 border-r border-cyan-500/30">
            <Activity size={13} className="text-cyan-400" />
            <span className="text-[10px] font-black uppercase tracking-wider text-cyan-300 whitespace-nowrap">Activity Logs & Reports</span>
          </div>
          <div className="relative flex-1 overflow-hidden py-2.5">
            <div className="mc-ticker flex items-center gap-8 whitespace-nowrap will-change-transform">
              {[...tickerLive, ...tickerLive].map((line, i) => (
                <span key={i} className="flex items-center gap-2 text-[10px] font-semibold text-slate-400">
                  <Dot color="bg-emerald-400" size="w-1.5 h-1.5" />
                  <span className="text-slate-300">{line}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="shrink-0 hidden sm:flex items-center gap-1.5 px-4">
            <Wifi size={12} className="text-emerald-400" />
            <span className="text-[9px] font-bold text-emerald-400">MESH ONLINE</span>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
