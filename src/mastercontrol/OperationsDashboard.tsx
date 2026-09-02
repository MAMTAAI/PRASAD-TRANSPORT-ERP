// @ts-nocheck
// ============================================================================
// MODULE 1 — OPERATIONS FLEET COMMAND (Ops View)
// Left: KPIs · Document Vault · Driver Command Center
// Center: Vehicle RTKM productivity · Driver shortage recovery ·
// Right: Live Dispatch Chat (Driver Vijay Singh — PT00409)
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Truck, Route, PackageOpen, Send, Search, X } from 'lucide-react';
import { API_BASE } from '../lib/apiBase';
import { KpiCard, Avatar, openDrilldown } from './shared';
import OwnerFleetMatrix from './OwnerFleetMatrix';
import LiveFleetMap from './LiveFleetMap';
import { VehicleRtkmPanel, ShortageRecoveryPanel } from './FleetProductivity';
import LoadingActivity from './LoadingActivity';
import UnloadingActivity from './UnloadingActivity';
import DispatchConsole from './DispatchConsole';
import DispatchTripChat from './DispatchTripChat';
import DriverCommandCenter from './DriverCommandCenter';
import FleetDocumentVault from './FleetDocumentVault';

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

// ---------------------------------------------------------------------------
export default function OperationsDashboard({ live, filter }) {
  // ── REACHING SOMEBODY WHO IS NOT ON A TRIP ────────────────────────────────
  // The chat panel is trip-centric now (2026-09-02): its list is the lorries
  // that are out, and selecting one opens that driver. That is the right
  // default and it deliberately cannot show a fuel pump, a vendor or a
  // customer — none of them are on a trip.
  //
  // They still have to be reachable. The ERP holds ~69 numbers it can dial and
  // before 1-Sep not one of them could be messaged from this screen at all: to
  // tell a pump anything you left the ERP, found the number elsewhere and typed
  // it into a phone. So the directory picker survives the rebuild, moved out of
  // the trip list and into a NAYA button in the panel header — a one-off
  // message to anybody on the books, without pretending they are a trip.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);   // the full Dispatch Console
  const [pickerQ, setPickerQ] = useState('');
  const [directory, setDirectory] = useState(null);   // null = not loaded yet
  const [dirError, setDirError] = useState(null);
  // The contact chosen in the picker, then the message being written to them.
  const [quickTo, setQuickTo] = useState(null);
  const [quickText, setQuickText] = useState('');
  const [quickSending, setQuickSending] = useState(false);
  const [quickResult, setQuickResult] = useState(null);   // { ok, detail }

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

  /** Send a one-off message to somebody the picker chose. Not a thread: the
   *  conversation itself lives in the Dispatch Console once it exists, and
   *  duplicating a chat surface here is what made this file 800 lines.
   *
   *  The ROW IS WRITTEN BY THE ENGINE, through POST /crm/chats with the
   *  WhatsApp message id and the session it went out on — so nothing is
   *  inserted here, and the refresh is what brings the sent message back. */
  const sendQuick = async () => {
    const text = quickText.trim();
    if (!text || !quickTo || quickSending) return;
    setQuickSending(true);
    setQuickResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/crm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ phone: quickTo.phone, text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setQuickText('');
      setQuickResult({ ok: true });
      window.dispatchEvent(new Event('erp:data-changed'));
    } catch (e) {
      // KEPT IN THE BOX. Clearing what the operator wrote on a failure loses it
      // with no way for them to know it never went.
      setQuickResult({ ok: false, detail: e.message || 'bhej nahi paye' });
    } finally {
      setQuickSending(false);
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
      {/* ══════════════ CENTRE — LIVE DISPATCH CHAT ══════════════
          The chat moved here from the right column on 2026-09-01. It was the
          narrowest panel on the screen carrying the widest content: message
          text wrapped after four words, the vehicle tags fell onto their own
          line and SEND LR COPY / SCAN FUEL SLIP OCR were squeezed side by
          side at nine pixels. A conversation is the one thing on this
          dashboard that is read word by word, so it gets the six-column
          track and the panels that are read as numbers take the narrow one. */}
      <div className="lg:col-span-6 min-w-0 flex flex-col gap-4">
        {/* HEIGHT-CAPPED, AND THE CAP IS THE POINT.
            This panel had `lg:h-full` and nothing else, so it grew to whatever
            the grid row was and then grew the row: a chat list capped at 240px,
            a thread with min-h-[220px], quick actions and a composer stacked
            underneath added to well over 600px and dragged the dashboard's
            right column past its neighbours. Every one of those pieces was
            individually reasonable; the column had no ceiling.
            720px is the ceiling now it holds the centre track — the cap exists
            to stop the column outgrowing its neighbours, and in six columns the
            neighbours are taller. Raising it was the point of the move: 500px
            in a wide track wastes the width without showing another message. `lg:h-full` stays so it still aligns with the
            cards beside it when the row is shorter — it fills the row UP TO the
            cap, never past it. overflow-hidden keeps the rounded corner from
            being cut by the panes inside. */}
        {/* TRIP-CENTRIC SINCE 2026-09-02, AND ITS OWN FILE.
            The left pane was an inbox — wa_chats newest-first — so the panel
            led with strangers (a horoscope forward, a news chain, six rows of
            "Anjaan") while the 146 lorries actually on the road, and the
            drivers on them, could not be reached from here at all. It now
            starts from TRIPS. The inbox is not gone: unknown numbers, pumps and
            vendors live in the Dispatch Console behind EXPAND, which is where a
            stranger belongs.

            Lifted out of this file at the same time. It had grown to 265 lines
            of JSX in the middle of a dashboard that also owns the KPI column,
            the vault and the fleet map, and it now carries a composer, an
            attachment menu, an OCR pass and an LR generator on top. */}
        <DispatchTripChat
          trips={ops?.dispatch_trips}
          offline={offline}
          onExpand={() => setConsoleOpen(true)}
          onNewContact={() => { setPickerOpen(true); setDirectory(null); setQuickTo(null); setQuickResult(null); }}
        />

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

        {/* Unloading Activity moved to the right column 2026-09-01 — the
            centre is the reading column (chat, then what came in today) and
            the right is the counting column. */}

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
                <span className="text-[13px] font-black text-slate-100">
                  {quickTo ? `Message: ${quickTo.name || `+91 ${quickTo.phone}`}` : 'Kisko message karna hai?'}
                </span>
                <button onClick={() => setPickerOpen(false)} className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
              </div>

              {/* STEP 2 — WRITE IT. The picker used to hand the contact to the
                  chat panel below, which was an inbox and could hold a draft.
                  That panel is trip-centric now and correctly has no room for
                  somebody who is not on a trip, so the message is written here.
                  One message, then out: the conversation itself belongs in the
                  Dispatch Console, and a second chat surface on this screen is
                  what this rebuild removed. */}
              {quickTo && (
                <div className="px-4 pb-3">
                  <button
                    onClick={() => { setQuickTo(null); setQuickResult(null); }}
                    className="mb-2 text-[10.5px] font-bold text-slate-500 hover:text-slate-300"
                  >
                    ‹ Kisi aur ko chunein
                  </button>
                  <div className="flex items-center gap-2.5 rounded-lg border border-slate-700/60 bg-slate-950/60 px-2.5 py-2 mb-2">
                    <Avatar name={quickTo.name || quickTo.phone} size="w-8 h-8" textSize="text-[10px]" ring="ring-emerald-500/50" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-bold text-slate-100 truncate">{quickTo.name || `+91 ${quickTo.phone}`}</p>
                      <p className="text-[10px] text-slate-500 truncate">+91 {quickTo.phone}{quickTo.sub ? ` · ${quickTo.sub}` : ''}</p>
                    </div>
                    <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${KIND_TONE[quickTo.kind] || KIND_TONE.UNKNOWN}`}>
                      {KIND_LABEL[quickTo.kind] || quickTo.kind}
                    </span>
                  </div>
                  <textarea
                    autoFocus
                    rows={3}
                    value={quickText}
                    onChange={(e) => setQuickText(e.target.value)}
                    placeholder="Message likhein…"
                    className="w-full resize-none rounded-lg bg-slate-950/70 border border-slate-700/50 px-2.5 py-2 text-[12px] text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/60"
                  />
                  {quickResult && (
                    <p className={`mt-1.5 text-[11px] leading-snug ${quickResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                      {quickResult.ok
                        ? 'Bhej diya. Poori baat-cheet Dispatch Console (EXPAND) mein dikhegi.'
                        : `Bhej nahi paye — ${quickResult.detail}. Aapka message neeche likha hai, dobara try karein.`}
                    </p>
                  )}
                  <button
                    onClick={sendQuick}
                    disabled={quickSending || !quickText.trim()}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 px-3 py-2 text-[12px] font-black text-white transition-colors"
                  >
                    <Send size={13} className={quickSending ? 'animate-pulse' : ''} /> BHEJEIN
                  </button>
                </div>
              )}

              {!quickTo && <div className="px-4 pb-2.5">
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
              </div>}

              {!quickTo && <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-2 pb-3">
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
                          onClick={() => { setQuickTo(c); setQuickResult(null); }}
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
              </div>}
            </div>
          </div>,
          document.body,
        )}
      </div>

      {/* ══════════════ RIGHT — PRODUCTIVITY AND RECOVERY ══════════════
          RTKM and shortage recovery read as tables of figures: a narrow column
          costs them nothing, because nobody reads a rupee total left to right
          the way they read a sentence. */}
      <div className="lg:col-span-3 min-w-0 flex flex-col gap-4">

        {/* Vehicle productivity replaces the old "Best Vehicle Trips" line
            chart. That chart plotted trips per weekday: a shape with no vehicle
            in it, so nothing followed from reading it. This names the trucks
            and puts what they earned and lost on the same row. */}
        <VehicleRtkmPanel live={live} filter={filter} />

        {/* Shortage recovery sits with operations because collecting it is an
            operations job, not an accounts one. */}
        <ShortageRecoveryPanel live={live} filter={filter} />

        {/* WHAT IS STILL OUT, under what it cost. 144 loads are waiting to be
            unloaded and 59 of them left over sixty days ago; that is a figure
            to be counted against the fleet, not a conversation, so it belongs
            on the counting side with productivity and recovery. */}
        <UnloadingActivity activity={ops?.unloading_activity ?? null} offline={offline} />

        {/* Fleet Maintenance Hub removed 2026-09-01 — it was a placeholder: a
            wireframe truck and a TODO for a three.js model, no data behind it. */}

        {/* Live Fleet Operations removed 2026-09-01 — the same trucks, routes and
            drivers are on Trip Management, which can also act on them. */}
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
      {/* Unloading Queue removed 2026-09-01 — 144 rows of "still not unloaded"
          that nobody cleared from here; the same list is actionable on Trip
          Management, where the Unload button actually lives. The map takes the
          full width it was always cramped out of. */}
      <div className="lg:col-span-12 [&>*]:min-w-0">
        <LiveFleetMap />
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
