// @ts-nocheck
// ============================================================================
// FLEET PARTNER APP v2 — the market partner's phone (Super-App role 4 of 4)
//
// Built to docs/mockups/fleet-partner-app-mock-v1.html, approved by the owner
// on 2026-09-03, with these rules from that approval and the same day's
// follow-ups:
//
//   · HOME ANSWERS ONE QUESTION: "which of my trucks is earning right now".
//     Not a wall of totals — the running trips, each showing the one thing the
//     partner has to do next.
//   · ONE BUTTON PER STAGE, NOTHING ELSE. A settlement walks
//     AWAITING_CONFIRM → CONFIRMED → VEHICLE_ASSIGNED → ADVANCE_PAID →
//     POD_SUBMITTED → POD_VERIFIED → SETTLED, and at any moment exactly one of
//     those belongs to the partner. The rest are the office's and are drawn as
//     waiting, never as a button that would fail.
//   · MONEY IS HONEST. The deposit line appears only when a deposit was taken,
//     and the advance and balance are greyed until the office has actually
//     released them. `vend.bills` gates the ledger view entirely.
//   · POD IS UPLOADED BY EITHER THE DRIVER OR THE PARTNER — the desk verifies
//     once, so this screen offers the upload even when a POD is already in.
//   · A BLOCKED TRUCK GETS THE REASON AND A PHONE NUMBER, NOT A FORM (owner,
//     3-Sep). No re-submit from the app: re-applying in a loop is how a partner
//     spends a week not ringing the office that already told them why.
//   · THE LOAD BAZAAR IS OFF (owner, 3-Sep) — shown as a tab that says so
//     rather than a tab that vanished. A partner who used it yesterday is owed
//     an explanation, not an absence.
//   · VEHICLE MANAGEMENT (owner, 3-Sep, after the first build): a truck opens
//     into its own screen with its five papers, their expiry, and a renewal
//     upload — plus the details the partner may edit. Expiry dates are NOT
//     typed here: a renewal is a document, and the office's approval is what
//     moves the date. That is the whole difference between a date and a fact.
//
// NO LIVE POSITION, AND IT SAYS SO. trip_gps_pings is keyed by trips.id — an
// own-fleet trip. A bazaar settlement has no row there, so this app has no
// position to draw for a market truck and draws the absence instead of a
// plausible dot.
//
// Hindi first (the readers are truck owners, not oil-company officers), same
// family as DriverPortal v4 / ServiceVendorApp: light, Segoe/Nirmala UI, emoji,
// 46 px targets.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';
import { uploadMedia } from '../lib/uploadMedia';
import { DISPATCH_TEL, DISPATCH_DISPLAY } from '../lib/dispatchContact';

const API = API_BASE;
const LANG_KEY = 'prasad_partner_lang';

const authHeaders = () => {
  const tok = localStorage.getItem('prasad_token');
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = `Bearer ${tok}`;
  const viewAs = localStorage.getItem('prasad_view_as_vendor');
  if (viewAs) h['X-View-As-Vendor'] = viewAs;
  return h;
};

const api = async (path, opts = {}) => {
  try {
    const res = await fetch(`${API}/api/v1${path}`, { ...opts, headers: { ...authHeaders(), ...(opts.headers ?? {}) } });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { detail: String(e?.message ?? e) } };
  }
};

// ── formatting ──────────────────────────────────────────────────────────────
const inr = (n) => (Number.isFinite(Number(n)) ? '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—');
const inrShort = (n) => { const v = Number(n); if (!Number.isFinite(v)) return '—'; return Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(2)}L` : inr(v); };
const dmy = (v) => { try { return v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'; } catch { return '—'; } };
const dmyt = (v) => { try { return v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; } catch { return '—'; } };
const today = () => new Date().toISOString().slice(0, 10);
const daysTo = (d) => { if (!d) return null; const ms = new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0); return Math.round(ms / 86400000); };
// "2 din 4 ghante" — a deadline a partner can act on, not a timestamp.
const leftFor = (iso) => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return { over: true, h: 0, m: 0 };
  return { over: false, h: Math.floor(ms / 3600000), m: Math.floor((ms % 3600000) / 60000) };
};

const T = {
  hi: {
    brand: 'प्रसाद ट्रांसपोर्ट · पार्टनर', partner: 'फ्लीट पार्टनर',
    home: 'होम', loads: 'लोड', trips: 'ट्रिप', money: 'पैसा', fleet: 'गाड़ी',
    running: 'अभी चल रही हैं', nothingRunning: 'अभी कोई ट्रिप नहीं चल रही।',
    nothingRunningSub: 'ऑफिस जब आपकी गाड़ी को लोड देगा, वो यहाँ दिखेगा।',
    kRunning: 'चल रही', kTrucks: 'चालू गाड़ी', kPending: 'मंज़ूरी बाकी',
    doNow: 'आपको यह करना है', officeSide: 'ऑफिस के पास है',
    stConfirm: 'हाँ, लोड लूँगा', stAssign: 'गाड़ी और ड्राइवर लगाओ', stPod: 'POD (रसीद) भेजो',
    waitAdvance: 'ऑफिस एडवांस भेज रहा है', waitPod: 'ऑफिस POD जाँच रहा है',
    waitBalance: 'ऑफिस बाकी पैसा भेज रहा है', doneAll: 'पूरा हो गया',
    tripsTitle: 'मेरी ट्रिप', tripsSub: 'चल रही और पुरानी', segLive: 'चल रही', segDone: 'पूरी', segAll: 'सब',
    noTrips: 'कोई ट्रिप नहीं मिली।',
    route: 'रास्ता', material: 'माल', loadDate: 'लोडिंग तारीख', truck: 'गाड़ी', driver: 'ड्राइवर',
    amount: 'तय भाड़ा', deposit: 'जमा (डिपॉज़िट)', advance: 'एडवांस', balance: 'बाकी',
    moneyNote: 'एडवांस और बाकी पैसा ऑफिस भेजता है — POD जाँचने के बाद बाकी रकम मिलती है।',
    noPosition: 'गाड़ी की लाइव लोकेशन नहीं है',
    noPositionSub: 'मार्केट गाड़ी की GPS हमारे पास नहीं आती। ड्राइवर से पूछें या ऑफिस को कॉल करें।',
    confirmBy: 'तक जवाब दें', overdue: 'समय निकल गया — ऑफिस को कॉल करें',
    assignTitle: 'गाड़ी लगाओ', pickTruck: 'गाड़ी चुनो', pickDriver: 'ड्राइवर चुनो (ज़रूरी नहीं)',
    onlyApproved: 'सिर्फ़ मंज़ूर गाड़ियाँ ही लोड ले सकती हैं।', noApproved: 'कोई मंज़ूर गाड़ी नहीं है — पहले गाड़ी जुड़वाएँ।',
    podTitle: 'POD भेजो', podBody: 'डिलीवरी की रसीद की फोटो खींचो या फ़ाइल चुनो। ऑफिस जाँच कर के बाकी पैसा भेजेगा।',
    podAlready: 'POD पहले ही भेजा जा चुका है — ऑफिस जाँच रहा है। ज़रूरत हो तो दोबारा भेज सकते हैं।',
    camera: '📷 फोटो खींचो', gallery: '🖼 फ़ाइल चुनो', send: 'भेजो', sending: 'भेज रहे हैं…',
    sent: 'ऑफिस को भेज दिया', needPhoto: 'पहले फोटो या फ़ाइल चुनो',
    moneyTitle: 'पैसा', moneySub: 'कमाई और खाता',
    billed: 'कुल बिल', posted: 'खाते में चढ़ा', awaiting: 'मंज़ूरी बाकी', bal: 'मौजूदा बकाया',
    moneyLocked: 'पैसे का हिसाब तभी दिखेगा जब ऑफिस आपके लिए यह चालू करे।',
    payTerms: 'भुगतान शर्तें', myName: 'नाम',
    fleetTitle: 'मेरी गाड़ियाँ', fleetSub: 'गाड़ी, कागज़ और ड्राइवर', trucksTab: 'गाड़ियाँ', driversTab: 'ड्राइवर',
    addTruck: '+ नई गाड़ी', addDriver: '+ नया ड्राइवर',
    noTrucks: 'कोई गाड़ी नहीं जुड़ी।', noDrivers: 'कोई ड्राइवर नहीं जुड़ा।',
    regNo: 'गाड़ी नंबर', vclass: 'गाड़ी का प्रकार', capacity: 'क्षमता (टन)',
    engineNo: 'इंजन नंबर', chassisNo: 'चेसिस नंबर',
    dName: 'ड्राइवर का नाम', dMobile: 'मोबाइल नंबर', dLicence: 'लाइसेंस नंबर', dLicExp: 'लाइसेंस की तारीख',
    pendingNote: 'ऑफिस जाँच कर के चालू करेगा। तब तक यह गाड़ी लोड नहीं ले सकती।',
    blockedTitle: 'यह गाड़ी रोकी गई है', blockedDriver: 'यह ड्राइवर रोका गया है',
    blockedNote: 'ऑफिस से बात किए बिना यह दोबारा नहीं जुड़ेगी।',
    callOffice: 'ऑफिस को कॉल करो',
    papers: 'गाड़ी के कागज़', paperNote: 'तारीख हाथ से नहीं बदलती — नया कागज़ भेजो, ऑफिस जाँच कर के तारीख चढ़ाएगा।',
    RC: 'RC', INSURANCE: 'बीमा', FITNESS: 'फिटनेस', PERMIT: 'परमिट', PUC: 'PUC',
    valid: 'वैध', expiringIn: 'दिन बचे', expired: 'तारीख निकल गई', noDate: 'तारीख दर्ज नहीं',
    renew: 'नया कागज़ भेजो', renewTitle: 'कागज़ भेजो', withOffice: 'ऑफिस के पास है',
    rejected: 'वापस आया', newExpiry: 'नई तारीख (कागज़ पर जो लिखी है)', docNo: 'नंबर (पॉलिसी / सर्टिफिकेट)',
    editTruck: 'गाड़ी की जानकारी बदलो', saved: 'बदलाव सेव हो गया',
    detailsNote: 'ये जानकारी सीधे बदल जाती है। गाड़ी नंबर नहीं बदल सकता — उसके लिए ऑफिस से बात करें।',
    docHistory: 'भेजे हुए कागज़', noDocs: 'अभी कोई कागज़ नहीं भेजा।', view: 'देखो',
    bidNote: 'बोली लगाना = ऑफर देना। ऑफिस तय करेगा और आपको बताएगा — गाड़ी तभी लगानी है।',
    noLoads: 'अभी कोई खुला लोड नहीं', noLoadsSub: 'नया लोड आते ही यहाँ दिखेगा।',
    bidsWord: 'बोली', myBid: 'आपकी बोली', withOffice: 'ऑफिस के पास', placeBid: 'बोली लगाओ',
    bidTitle: 'बोली लगाओ', bidAmt: 'आपका भाड़ा (₹)', bidSend: 'बोली भेजो',
    bidSentMsg: 'बोली ऑफिस को चली गई',
    loadsSoon: 'लोड बाज़ार जल्द आ रहा है',
    loadsSoonSub: 'बोली लगाने वाला हिस्सा ऑफिस ने अभी बंद रखा है। आपकी चल रही ट्रिप और पैसा वैसे ही चलता रहेगा — ऑफिस लोड देगा तो होम पर दिखेगा।',
    logout: 'साइन आउट', language: 'भाषा', call: `ऑफिस — ${DISPATCH_DISPLAY}`,
    viewAs: 'स्टाफ़ प्रीव्यू — सिर्फ़ देखने के लिए। यहाँ से कुछ भी पार्टनर के नाम पर नहीं जाता।',
    notApproved: 'आपका पोर्टल अभी चालू नहीं हुआ', save: 'भेजो', saveEdit: 'सेव करो',
  },
  en: {
    brand: 'Prasad Transport · Partner', partner: 'Fleet Partner',
    home: 'Home', loads: 'Loads', trips: 'Trips', money: 'Money', fleet: 'Fleet',
    running: 'Running now', nothingRunning: 'No trip is running right now.',
    nothingRunningSub: 'When the office gives your truck a load, it shows here.',
    kRunning: 'running', kTrucks: 'active trucks', kPending: 'awaiting approval',
    doNow: 'Your move', officeSide: 'With the office',
    stConfirm: 'Yes, I will take it', stAssign: 'Assign truck & driver', stPod: 'Send POD',
    waitAdvance: 'Office is releasing the advance', waitPod: 'Office is verifying the POD',
    waitBalance: 'Office is releasing the balance', doneAll: 'Settled',
    tripsTitle: 'My trips', tripsSub: 'Running and past', segLive: 'Running', segDone: 'Done', segAll: 'All',
    noTrips: 'No trips found.',
    route: 'Route', material: 'Material', loadDate: 'Loading date', truck: 'Truck', driver: 'Driver',
    amount: 'Agreed freight', deposit: 'Deposit', advance: 'Advance', balance: 'Balance',
    moneyNote: 'The office releases the advance and the balance — the balance after it verifies the POD.',
    noPosition: 'No live location for this truck',
    noPositionSub: 'We do not receive GPS from a market truck. Ask the driver, or call the office.',
    confirmBy: 'reply by', overdue: 'Time is up — please call the office',
    assignTitle: 'Assign a truck', pickTruck: 'Pick a truck', pickDriver: 'Pick a driver (optional)',
    onlyApproved: 'Only an approved truck can take a load.', noApproved: 'No approved truck yet — add one first.',
    podTitle: 'Send the POD', podBody: 'Photograph the delivery receipt or pick a file. The office verifies it and releases the balance.',
    podAlready: 'A POD is already with the office. You can send another if needed.',
    camera: '📷 Take a photo', gallery: '🖼 Pick a file', send: 'Send', sending: 'Sending…',
    sent: 'Sent to the office', needPhoto: 'Pick a photo or a file first',
    moneyTitle: 'Money', moneySub: 'Earnings and account',
    billed: 'Billed', posted: 'Posted to ledger', awaiting: 'Awaiting approval', bal: 'Current balance',
    moneyLocked: 'The money view appears only when the office enables it for you.',
    payTerms: 'Payment terms', myName: 'Name',
    fleetTitle: 'My fleet', fleetSub: 'Trucks, papers and drivers', trucksTab: 'Trucks', driversTab: 'Drivers',
    addTruck: '+ Add truck', addDriver: '+ Add driver',
    noTrucks: 'No trucks added.', noDrivers: 'No drivers added.',
    regNo: 'Registration no', vclass: 'Vehicle type', capacity: 'Capacity (T)',
    engineNo: 'Engine no', chassisNo: 'Chassis no',
    dName: 'Driver name', dMobile: 'Mobile number', dLicence: 'Licence no', dLicExp: 'Licence expiry',
    pendingNote: 'The office verifies and activates it. Until then this truck cannot take a load.',
    blockedTitle: 'This truck is blocked', blockedDriver: 'This driver is blocked',
    blockedNote: 'It will not go back on the fleet without speaking to the office.',
    callOffice: 'Call the office',
    papers: 'Vehicle papers', paperNote: 'Dates are not typed here — send the new paper and the office puts the date on the truck.',
    RC: 'RC', INSURANCE: 'Insurance', FITNESS: 'Fitness', PERMIT: 'Permit', PUC: 'PUC',
    valid: 'valid', expiringIn: 'days left', expired: 'expired', noDate: 'no date on file',
    renew: 'Send new paper', renewTitle: 'Send the paper', withOffice: 'With the office',
    rejected: 'Came back', newExpiry: 'New expiry (as printed on the paper)', docNo: 'Number (policy / certificate)',
    editTruck: 'Edit truck details', saved: 'Saved',
    detailsNote: 'These change straight away. The registration number cannot change — call the office for that.',
    docHistory: 'Papers sent', noDocs: 'No paper sent yet.', view: 'View',
    bidNote: 'A bid is an OFFER, not a booking. The office decides and tells you — send a truck only then.',
    noLoads: 'No open load right now', noLoadsSub: 'A new load appears here as soon as it is posted.',
    bidsWord: 'bids', myBid: 'Your bid', withOffice: 'with the office', placeBid: 'Place a bid',
    bidTitle: 'Place a bid', bidAmt: 'Your freight (₹)', bidSend: 'Send the bid',
    bidSentMsg: 'Your bid is with the office',
    loadsSoon: 'Load Bazaar is coming soon',
    loadsSoonSub: 'The bidding side is switched off by the office for now. Your running trips and your money are unaffected — a load the office gives you appears on Home.',
    logout: 'Sign out', language: 'Language', call: `Office — ${DISPATCH_DISPLAY}`,
    viewAs: 'Staff preview — read-only. Nothing you press here is sent in the partner’s name.',
    notApproved: 'Your portal is not active yet', save: 'Send', saveEdit: 'Save',
  },
};

const FONT = { fontFamily: '"Segoe UI","Nirmala UI",system-ui,-apple-system,Roboto,sans-serif' };
const SHELL = 'mx-auto flex min-h-screen w-full max-w-md flex-col bg-[#f8fafc] text-slate-900';
const CARD = 'rounded-2xl border-2 border-slate-200 bg-white';

// The settlement's own vocabulary, and who owns each step. `nextMove` below is
// the whole point of the screen: it decides whether the partner sees a button
// or is told to wait, derived from the status alone — never from a local flag
// that could disagree with the server.
const STAGES = ['AWAITING_CONFIRM', 'CONFIRMED', 'VEHICLE_ASSIGNED', 'ADVANCE_PAID', 'POD_SUBMITTED', 'POD_VERIFIED', 'SETTLED'];
const stageIndex = (s) => Math.max(0, STAGES.indexOf(s));
const LIVE = new Set(STAGES.slice(0, 6));
const DOC_TYPES = ['RC', 'INSURANCE', 'FITNESS', 'PERMIT', 'PUC'];

const PILL = {
  AWAITING_CONFIRM: 'bg-amber-100 text-amber-800',
  CONFIRMED: 'bg-blue-100 text-blue-800',
  VEHICLE_ASSIGNED: 'bg-indigo-100 text-indigo-800',
  ADVANCE_PAID: 'bg-violet-100 text-violet-800',
  POD_SUBMITTED: 'bg-cyan-100 text-cyan-800',
  POD_VERIFIED: 'bg-teal-100 text-teal-800',
  SETTLED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-700',
  'System Active': 'bg-green-100 text-green-800',
  'PENDING APPROVAL': 'bg-amber-100 text-amber-800',
  BLOCKED: 'bg-red-100 text-red-700',
  REJECTED: 'bg-red-100 text-red-700',
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-green-100 text-green-800',
  NEEDS_CORRECTION: 'bg-red-100 text-red-700',
};

export default function FleetPartnerApp() {
  const [lang, setLang] = useState(() => (localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'hi'));
  const t = T[lang];
  const toggleLang = () => { const n = lang === 'hi' ? 'en' : 'hi'; setLang(n); try { localStorage.setItem(LANG_KEY, n); } catch { /* private mode */ } };

  const [gate, setGate] = useState('loading');      // loading | ok | not_approved | error
  const [gateMsg, setGateMsg] = useState('');
  const [vis, setVis] = useState({});
  const [me, setMe] = useState(null);
  const [earn, setEarn] = useState(null);
  const [setts, setSetts] = useState([]);
  const [fleet, setFleet] = useState({ vehicles: [], drivers: [], pending: 0 });
  const [openLoads, setOpenLoads] = useState([]);

  const [tab, setTab] = useState('home');
  const [view, setView] = useState({ k: 'tabs' });
  const [seg, setSeg] = useState('LIVE');
  const [fleetSeg, setFleetSeg] = useState('TRUCKS');
  const [toast, setToast] = useState('');
  const viewAs = !!localStorage.getItem('prasad_view_as_vendor');

  const say = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };
  const showMoney = !!vis['vend.bills'];

  const loadAll = useCallback(async (v) => {
    const [e, s, f, lo] = await Promise.all([
      api('/portal/vendor/earnings'),
      api('/portal/vendor/settlements'),
      v['vend.vehicles'] ? api('/portal/vendor/fleet') : Promise.resolve({ ok: false }),
      // The blind board: no target rate, no other partner's amount — the view
      // behind this route carries neither (v_bazaar_load_feed).
      v['vend.bazaar'] ? api('/portal/vendor/loads') : Promise.resolve({ ok: false }),
    ]);
    if (e.ok) setEarn(e.body);
    if (s.ok) setSetts(s.body?.settlements ?? []);
    if (f.ok) setFleet(f.body ?? { vehicles: [], drivers: [], pending: 0 });
    if (lo.ok) setOpenLoads(lo.body?.loads ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api('/portal/capabilities');
      if (r.status === 403 && r.body?.error === 'PORTAL_NOT_APPROVED') { setGate('not_approved'); setGateMsg(r.body.detail); return; }
      if (!r.ok) { setGate('error'); setGateMsg(r.body?.detail ?? `API ${r.status}`); return; }
      const v = r.body?.visible ?? {};
      setVis(v);
      const m = await api('/portal/me');
      setMe(m.body?.party ?? null);
      setGate('ok');
      await loadAll(v);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => { await loadAll(vis); };

  // ── shared bits ───────────────────────────────────────────────────────────
  const Bar = ({ title, sub, back }) => (
    <div className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2.5">
      {back && <button onClick={back} className="min-h-[42px] rounded-full bg-slate-100 px-3.5 text-[16px] font-bold">‹</button>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[17px] font-extrabold leading-tight">{title}</div>
        {sub && <div className="truncate text-[11.5px] font-semibold text-slate-500">{sub}</div>}
      </div>
      <button onClick={toggleLang} className="min-h-[38px] shrink-0 rounded-full bg-slate-100 px-3 text-[12px] font-bold">{lang === 'hi' ? 'हिं · EN' : 'EN · हिं'}</button>
    </div>
  );
  const Pill = ({ s, label }) => <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-extrabold ${PILL[s] ?? 'bg-slate-100 text-slate-600'}`}>{label ?? s}</span>;
  const TruckNo = ({ n }) => (n ? <span className="inline-block rounded-md bg-amber-100 px-1.5 py-0.5 font-mono text-[11.5px] font-bold text-amber-900">{n}</span> : null);
  const KV = ({ rows }) => (
    <div className="px-3 py-2">
      {rows.filter(Boolean).map(([k, v, cls]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0">
          <span className="shrink-0 text-[12px] font-semibold text-slate-500">{k}</span>
          <span className={`min-w-0 truncate text-right text-[13.5px] font-extrabold ${cls ?? ''}`}>{v}</span>
        </div>
      ))}
    </div>
  );
  const CallBar = () => <a href={DISPATCH_TEL} className="block min-h-[46px] rounded-2xl bg-slate-900 py-3 text-center text-[15px] font-extrabold text-white">📞 {t.call}</a>;
  const Lbl = ({ children }) => <div className="mb-1 text-[11px] font-extrabold text-slate-500">{children}</div>;
  // `invalid` is ours, not the DOM's — spreading it onto <input> makes React
  // warn about a non-boolean attribute.
  const Inp = ({ invalid, className, ...rest }) => (
    <input {...rest} className={`min-h-[46px] w-full rounded-xl border-2 bg-white px-3 text-[16px] font-bold outline-none ${invalid ? 'border-red-400' : 'border-slate-300 focus:border-blue-500'} ${className ?? ''}`} />
  );

  const Steps = ({ n }) => {
    const labels = lang === 'hi'
      ? ['मिला', 'हाँ', 'गाड़ी', 'एडवांस', 'POD', 'जाँचा', 'पूरा']
      : ['Offered', 'Yes', 'Truck', 'Advance', 'POD', 'Verified', 'Settled'];
    return (
      <div className="flex items-start px-0.5 py-1">
        {labels.map((l, i) => (
          <div key={l} className="relative flex flex-1 flex-col items-center gap-0.5 text-center text-[8.5px] font-extrabold">
            <i className={`grid h-[20px] w-[20px] place-items-center rounded-full not-italic text-[10px] ${i < n ? 'bg-green-600 text-white' : i === n ? 'bg-blue-600 text-white ring-4 ring-blue-200' : 'bg-slate-200 text-slate-500'}`}>{i < n ? '✓' : i + 1}</i>
            <span className={i <= n ? 'text-slate-900' : 'text-slate-400'}>{l}</span>
            {i < labels.length - 1 && <span className={`absolute left-[calc(50%+10px)] top-[9px] h-[2px] w-[calc(100%-20px)] ${i < n ? 'bg-green-600' : 'bg-slate-200'}`} />}
          </div>
        ))}
      </div>
    );
  };

  /** The one action that belongs to the partner right now, or null when the
   *  ball is with the office. One place, so no screen can offer a button the
   *  server would refuse. */
  const nextMove = (s) => {
    if (s.status === 'AWAITING_CONFIRM') return { key: 'confirm', label: t.stConfirm, tone: 'bg-green-600' };
    if (s.status === 'CONFIRMED') return { key: 'assign', label: t.stAssign, tone: 'bg-blue-600' };
    if (s.status === 'VEHICLE_ASSIGNED' || s.status === 'ADVANCE_PAID') return { key: 'pod', label: t.stPod, tone: 'bg-violet-600' };
    return null;
  };
  const waitingLine = (s) => ({
    VEHICLE_ASSIGNED: t.waitAdvance, POD_SUBMITTED: t.waitPod,
    POD_VERIFIED: t.waitBalance, SETTLED: t.doneAll,
  }[s.status] ?? null);

  function Toast() {
    return <div className="fixed bottom-24 left-1/2 z-50 w-[86%] max-w-sm -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-3 text-center text-[14px] font-extrabold text-white shadow-lg">{toast}</div>;
  }

  // ══ GATES ═════════════════════════════════════════════════════════════════
  if (gate === 'loading') return <div className={`${SHELL} items-center justify-center`} style={FONT}><div className="text-[13px] font-semibold text-slate-500">…</div></div>;
  if (gate !== 'ok') {
    return (
      <div className={`${SHELL} items-center justify-center px-6 text-center`} style={FONT} data-screen="gate">
        <div className="text-5xl">{gate === 'not_approved' ? '⏳' : '⚠️'}</div>
        <div className="mt-3 text-[19px] font-extrabold">{gate === 'not_approved' ? t.notApproved : '—'}</div>
        <div className="mt-1 text-[13px] font-semibold leading-snug text-slate-600">{gateMsg}</div>
        <a href={DISPATCH_TEL} className="mt-5 min-h-[52px] w-full rounded-2xl bg-slate-900 py-3.5 text-[16px] font-extrabold text-white">📞 {t.call}</a>
      </div>
    );
  }

  // ══ SUB-SCREENS ═══════════════════════════════════════════════════════════
  if (view.k === 'trip') return <TripDetail id={view.id} />;
  if (view.k === 'assign') return <AssignScreen id={view.id} />;
  if (view.k === 'pod') return <PodScreen id={view.id} />;
  if (view.k === 'bid') return <BidScreen id={view.id} />;
  if (view.k === 'truck') return <TruckDetail id={view.id} />;
  if (view.k === 'renew') return <RenewScreen id={view.id} docType={view.docType} />;
  if (view.k === 'editTruck') return <EditTruck id={view.id} />;
  if (view.k === 'addTruck') return <AddTruck />;
  if (view.k === 'addDriver') return <AddDriver />;

  function TripDetail({ id }) {
    const s = setts.find((x) => x.id === id);
    if (!s) { setView({ k: 'tabs' }); return null; }
    const mv = nextMove(s);
    const wait = waitingLine(s);
    const dl = leftFor(s.confirm_deadline);
    const act = async () => {
      const r = await api(`/portal/vendor/settlements/${s.id}/confirm`, { method: 'POST', body: '{}' });
      if (!r.ok) { say(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      await refresh(); say(t.sent);
    };
    return (
      <div className={SHELL} style={FONT} data-screen="trip">
        <Bar title={`${s.origin ?? '—'} → ${s.destination ?? '—'}`} sub={`${s.load_id} · ${dmy(s.loading_date)}`} back={() => setView({ k: 'tabs' })} />
        <div className="flex-1 space-y-2.5 overflow-y-auto p-3 pb-32">
          <div className={`${CARD} px-1 py-2`}><Steps n={stageIndex(s.status)} /></div>
          <div className={CARD}>
            <KV rows={[
              [t.route, `${s.origin ?? '—'} → ${s.destination ?? '—'}`],
              [t.material, [s.material, s.weight ? `${s.weight} T` : null].filter(Boolean).join(' · ') || '—'],
              [t.loadDate, dmy(s.loading_date)],
              [t.truck, s.vehicle_reg ? <TruckNo n={s.vehicle_reg} /> : '—'],
              [t.driver, s.driver_name ?? '—'],
            ]} />
          </div>

          {/* Money, and only what the office has actually done. The deposit line
              appears only when a deposit was taken (owner's rule from the mock). */}
          <div className={CARD}>
            <div className="px-3 pt-2.5 text-[12.5px] font-extrabold text-slate-700">💰 {t.amount}</div>
            <KV rows={[
              [t.amount, inr(s.awarded_amount), 'text-slate-900'],
              Number(s.deposit_amount) > 0 ? [t.deposit, inr(s.deposit_amount), 'text-amber-700'] : null,
              [t.advance, inr(s.advance_amount), stageIndex(s.status) >= 3 ? 'text-green-700' : 'text-slate-400'],
              [t.balance, inr(s.balance_amount), s.status === 'SETTLED' ? 'text-green-700' : 'text-slate-400'],
            ]} />
            <div className="mx-3 mb-2.5 rounded-xl bg-blue-50 px-3 py-2 text-[12px] font-semibold leading-snug text-blue-900">{t.moneyNote}</div>
          </div>

          {LIVE.has(s.status) && (
            <div className={`${CARD} px-3 py-3 text-center`}>
              <div className="text-2xl">📍</div>
              <div className="mt-1 text-[13px] font-extrabold text-slate-700">{t.noPosition}</div>
              <div className="mt-0.5 text-[11.5px] font-semibold leading-snug text-slate-500">{t.noPositionSub}</div>
            </div>
          )}

          {s.status === 'AWAITING_CONFIRM' && dl && (
            <div className={`rounded-2xl px-3 py-2.5 text-[12.5px] font-extrabold ${dl.over ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}>
              {dl.over ? `⏰ ${t.overdue}` : `⏰ ${dl.h}h ${dl.m}m — ${t.confirmBy} ${dmyt(s.confirm_deadline)}`}
            </div>
          )}
          {s.cancel_reason && <div className="rounded-2xl bg-red-50 px-3 py-2.5 text-[12.5px] font-extrabold text-red-800">{s.cancel_reason}</div>}
          <CallBar />
        </div>

        <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-md -translate-x-1/2 border-t border-slate-200 bg-white p-3">
          {mv ? (
            <>
              <div className="mb-1.5 text-center text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{t.doNow}</div>
              <button
                onClick={() => { if (mv.key === 'confirm') act(); else if (mv.key === 'assign') setView({ k: 'assign', id: s.id }); else setView({ k: 'pod', id: s.id }); }}
                disabled={viewAs}
                className={`min-h-[58px] w-full rounded-2xl text-[18px] font-extrabold text-white shadow-[0_5px_0_rgba(0,0,0,0.18)] active:translate-y-1 active:shadow-none disabled:opacity-50 ${mv.tone}`}
                data-act={mv.key}
              >{mv.label}</button>
            </>
          ) : (
            <div className="rounded-2xl bg-slate-100 px-3 py-3 text-center">
              <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{t.officeSide}</div>
              <div className="text-[15px] font-extrabold text-slate-700">{wait ?? '—'}</div>
            </div>
          )}
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  /** One bid on one load. Deliberately plain: an amount and a send button.
   *  The partner is never shown the customer's target or anyone else's number —
   *  not because the screen hides them, but because the server never sends
   *  them (v_bazaar_load_feed carries no rates at all). */
  function BidScreen({ id }) {
    const l = openLoads.find((x) => x.load_id === id);
    const [amount, setAmount] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    if (!l) { setView({ k: 'tabs' }); return null; }

    const send = async () => {
      const amt = Number(amount);
      if (!(amt > 0)) { setErr(t.bidAmt); return; }
      setBusy(true); setErr('');
      const r = await api(`/portal/vendor/loads/${l.load_id}/bid`, {
        method: 'POST', body: JSON.stringify({ bid_amount: amt }),
      });
      setBusy(false);
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      await refresh(); say(t.bidSentMsg); setView({ k: 'tabs' });
    };

    return (
      <div className={SHELL} style={FONT} data-screen="bid">
        <Bar title={t.bidTitle} sub={`${l.origin} → ${l.destination}`} back={() => setView({ k: 'tabs' })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className={CARD}>
            <KV rows={[
              [t.route, `${l.origin} → ${l.destination}`],
              [t.material, [l.material, l.weight ? `${l.weight} T` : null].filter(Boolean).join(' · ') || '—'],
              [t.loadDate, dmy(l.loading_date)],
              [t.bidsWord, String(l.bid_count ?? 0)],
            ]} />
          </div>
          <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.bidNote}</div>
          <div>
            <Lbl>{t.bidAmt}</Lbl>
            <Inp inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); setErr(''); }}
              placeholder="₹" className="font-mono text-[20px]" data-bid-amount />
          </div>
          {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
          <button onClick={send} disabled={busy || viewAs} className="min-h-[58px] w-full rounded-2xl bg-blue-600 text-[18px] font-extrabold text-white shadow-[0_5px_0_rgba(0,0,0,0.18)] disabled:opacity-60" data-bid-send>
            {busy ? t.sending : `💰 ${t.bidSend}`}
          </button>
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  function AssignScreen({ id }) {
    const s = setts.find((x) => x.id === id);
    // Only an approved truck may take a load — the server refuses anything else
    // (409 VEHICLE_NOT_APPROVED), so the picker never lists one.
    const trucks = (fleet.vehicles ?? []).filter((v) => v.system_status === 'System Active');
    const drivers = (fleet.drivers ?? []).filter((d) => d.system_status === 'System Active');
    const [truck, setTruck] = useState(trucks[0]?.id ?? '');
    const [driver, setDriver] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    if (!s) { setView({ k: 'tabs' }); return null; }

    const send = async () => {
      if (!truck) { setErr(t.noApproved); return; }
      setBusy(true); setErr('');
      const r = await api(`/portal/vendor/settlements/${s.id}/assign`, {
        method: 'POST', body: JSON.stringify({ market_vehicle_id: truck, market_driver_id: driver || null }),
      });
      setBusy(false);
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      await refresh(); say(t.sent); setView({ k: 'trip', id: s.id });
    };

    return (
      <div className={SHELL} style={FONT} data-screen="assign">
        <Bar title={t.assignTitle} sub={`${s.origin} → ${s.destination}`} back={() => setView({ k: 'trip', id: s.id })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.onlyApproved}</div>
          {trucks.length === 0 ? (
            <div className={`${CARD} px-3 py-5 text-center`}>
              <div className="text-3xl">🚛</div>
              <div className="mt-1 text-[13.5px] font-extrabold text-slate-700">{t.noApproved}</div>
              <button onClick={() => setView({ k: 'addTruck' })} className="mt-3 min-h-[46px] w-full rounded-xl bg-blue-600 text-[15px] font-extrabold text-white">{t.addTruck}</button>
            </div>
          ) : (
            <>
              <div>
                <Lbl>{t.pickTruck}</Lbl>
                <div className="space-y-2">
                  {trucks.map((v) => (
                    <button key={v.id} onClick={() => setTruck(v.id)} data-truck={v.registration_no}
                      className={`flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2.5 text-left ${truck === v.id ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-white'}`}>
                      <span className="text-[20px]">{truck === v.id ? '🔘' : '⚪'}</span>
                      <span className="min-w-0 flex-1">
                        <TruckNo n={v.registration_no} />
                        <span className="ml-1.5 text-[11.5px] font-semibold text-slate-500">{[v.vehicle_class, v.capacity ? `${v.capacity} T` : null].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Lbl>{t.pickDriver}</Lbl>
                <div className="space-y-2">
                  {drivers.map((d) => (
                    <button key={d.id} onClick={() => setDriver(driver === d.id ? '' : d.id)}
                      className={`flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2.5 text-left ${driver === d.id ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-white'}`}>
                      <span className="text-[20px]">{driver === d.id ? '🔘' : '⚪'}</span>
                      <span className="min-w-0 flex-1 text-[14px] font-extrabold">{d.name}<span className="ml-1.5 font-mono text-[11.5px] font-semibold text-slate-500">{d.mobile}</span></span>
                    </button>
                  ))}
                  {drivers.length === 0 && <div className="rounded-xl bg-slate-100 px-3 py-2 text-[12px] font-semibold text-slate-500">{t.noDrivers}</div>}
                </div>
              </div>
              {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
              <button onClick={send} disabled={busy || viewAs} className="min-h-[58px] w-full rounded-2xl bg-blue-600 text-[18px] font-extrabold text-white shadow-[0_5px_0_rgba(0,0,0,0.18)] disabled:opacity-60" data-assign-send>
                {busy ? t.sending : t.save}
              </button>
            </>
          )}
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  /** Shared by the POD screen and the paper-renewal screen: pick a file, send
   *  it somewhere. Both are "photograph a piece of paper and hand it to the
   *  office", so they are one component with two destinations. */
  function Uploader({ onSend, busy, err, file, setFile }) {
    const cam = useRef(null), gal = useRef(null);
    const take = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setFile(f); };
    return (
      <>
        <input ref={cam} type="file" accept="image/*" capture="environment" hidden data-cam onChange={take} />
        <input ref={gal} type="file" accept="image/*,application/pdf" hidden data-gal onChange={take} />
        <button onClick={() => cam.current?.click()} className="min-h-[58px] w-full rounded-2xl bg-slate-900 text-[17px] font-extrabold text-white">{t.camera}</button>
        <button onClick={() => gal.current?.click()} className="min-h-[50px] w-full rounded-2xl border-2 border-slate-300 bg-white text-[15px] font-extrabold">{t.gallery}</button>
        {file && (
          <div className={`${CARD} px-3 py-2.5`}>
            <div className="text-[11px] font-extrabold text-slate-500">📎</div>
            <div className="truncate text-[13.5px] font-extrabold">{file.name || 'photo.jpg'}</div>
          </div>
        )}
        {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
        <button onClick={onSend} disabled={busy || viewAs} className="min-h-[58px] w-full rounded-2xl bg-violet-600 text-[18px] font-extrabold text-white shadow-[0_5px_0_rgba(0,0,0,0.18)] disabled:opacity-60" data-send>
          {busy ? t.sending : `📤 ${t.send}`}
        </button>
      </>
    );
  }

  function PodScreen({ id }) {
    const s = setts.find((x) => x.id === id);
    const [file, setFile] = useState(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    if (!s) { setView({ k: 'tabs' }); return null; }

    const send = async () => {
      if (!file) { setErr(t.needPhoto); return; }
      setBusy(true); setErr('');
      try {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        const up = await uploadMedia(file, `bazaar-pod/pod_${s.load_id}_${Date.now()}${isPdf ? '.pdf' : '.jpg'}`);
        const r = await api(`/portal/vendor/settlements/${s.id}/pod`, { method: 'POST', body: JSON.stringify({ pod_file: up.path }) });
        if (!r.ok) throw new Error(r.body?.detail ?? r.body?.error ?? `API ${r.status}`);
        await refresh(); say(t.sent); setView({ k: 'trip', id: s.id });
      } catch (e) { setErr(String(e?.message ?? e)); }
      setBusy(false);
    };

    return (
      <div className={SHELL} style={FONT} data-screen="pod">
        <Bar title={t.podTitle} sub={`${s.load_id} · ${s.origin} → ${s.destination}`} back={() => setView({ k: 'trip', id: s.id })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-2xl bg-violet-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-violet-900">{t.podBody}</div>
          {/* The driver may already have sent one — the desk verifies once, and
              whoever gets to it first is fine (owner's rule). */}
          {s.pod_submitted_at && <div className="rounded-2xl bg-amber-50 px-3 py-2.5 text-[12.5px] font-semibold text-amber-900">{t.podAlready} · {dmyt(s.pod_submitted_at)}</div>}
          <Uploader onSend={send} busy={busy} err={err} file={file} setFile={(f) => { setFile(f); setErr(''); }} />
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  // ══ VEHICLE MANAGEMENT (owner, 3-Sep) ═════════════════════════════════════

  /** One truck: its papers, their dates, and what is in flight for each. */
  function TruckDetail({ id }) {
    const [d, setD] = useState(null);
    const [err, setErr] = useState('');
    const load = useCallback(async () => {
      const r = await api(`/portal/vendor/fleet/vehicle/${id}`);
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      setD(r.body);
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const v = d?.vehicle;
    const blocked = v && (v.system_status === 'BLOCKED' || v.system_status === 'REJECTED');

    return (
      <div className={SHELL} style={FONT} data-screen="truck">
        <Bar title={v?.registration_no ?? '—'} sub={[v?.vehicle_class, v?.capacity ? `${v.capacity} T` : null].filter(Boolean).join(' · ')} back={() => setView({ k: 'tabs' })} />
        <div className="flex-1 space-y-2.5 overflow-y-auto p-3 pb-24">
          {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
          {!d && !err && <div className="py-8 text-center text-[13px] font-semibold text-slate-500">…</div>}

          {v && (
            <>
              <div className={CARD}>
                <div className="flex items-center justify-between px-3 pt-2.5">
                  <span className="text-[12.5px] font-extrabold text-slate-700">🚛 {t.truck}</span>
                  <Pill s={v.system_status} />
                </div>
                <KV rows={[
                  [t.regNo, <TruckNo n={v.registration_no} />],
                  [t.vclass, v.vehicle_class ?? '—'],
                  [t.capacity, v.capacity ? `${v.capacity} T` : '—'],
                  [t.engineNo, v.engine_no ?? '—'],
                  [t.chassisNo, v.chassis_no ?? '—'],
                  [t.driver, v.driver_name ?? '—'],
                ]} />
                {!blocked && (
                  <div className="px-3 pb-3">
                    <button onClick={() => setView({ k: 'editTruck', id: v.id })} disabled={viewAs}
                      className="min-h-[46px] w-full rounded-xl border-2 border-slate-300 bg-white text-[14px] font-extrabold disabled:opacity-50" data-edit-truck>
                      ✏️ {t.editTruck}
                    </button>
                  </div>
                )}
              </div>

              {blocked && (
                <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-3">
                  <div className="text-[14px] font-extrabold text-red-800">🚫 {t.blockedTitle}</div>
                  {v.reject_reason && <div className="mt-1 text-[12.5px] font-semibold leading-snug text-red-900">{v.reject_reason}</div>}
                  <div className="mt-1 text-[11.5px] font-semibold text-red-900/75">{t.blockedNote}</div>
                  <a href={DISPATCH_TEL} className="mt-2 block min-h-[46px] rounded-xl bg-red-600 py-3 text-center text-[15px] font-extrabold text-white">📞 {t.callOffice}</a>
                </div>
              )}

              {/* THE PAPERS. Each row is one document: the live date, how close
                  it is, and either a renewal button or what is already with the
                  office for it. The date itself is never an input here. */}
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-[13px] font-extrabold text-slate-700">📄 {t.papers}</span>
              </div>
              <div className="rounded-2xl bg-blue-50 px-3 py-2 text-[12px] font-semibold leading-snug text-blue-900">{t.paperNote}</div>

              {(d.papers ?? []).map((p) => {
                const n = daysTo(p.expiry);
                const tone = p.expiry == null ? 'bg-slate-100 text-slate-600'
                  : n < 0 ? 'bg-red-100 text-red-700'
                  : n <= 30 ? 'bg-amber-100 text-amber-800'
                  : 'bg-green-100 text-green-800';
                const note = p.expiry == null ? t.noDate
                  : n < 0 ? `${t.expired} · ${dmy(p.expiry)}`
                  : `${n} ${t.expiringIn} · ${dmy(p.expiry)}`;
                return (
                  <div key={p.doc_type} className={CARD} data-paper={p.doc_type}>
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-extrabold">{t[p.doc_type]}</div>
                        <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-extrabold ${tone}`}>{note}</span>
                      </div>
                      {p.pending
                        ? <Pill s="PENDING" label={`⏳ ${t.withOffice}`} />
                        : (
                          <button onClick={() => setView({ k: 'renew', id: v.id, docType: p.doc_type })} disabled={viewAs}
                            className="min-h-[42px] shrink-0 rounded-xl bg-blue-600 px-3 text-[13px] font-extrabold text-white disabled:opacity-50"
                            data-renew={p.doc_type}>
                            {t.renew}
                          </button>
                        )}
                    </div>
                    {p.pending && (
                      <div className="mx-3 mb-2.5 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900">
                        {dmy(p.pending.expiry_date)} · {dmyt(p.pending.created_at)}
                      </div>
                    )}
                    {p.last_reject && (
                      <div className="mx-3 mb-2.5 rounded-xl bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-800">
                        <b>{t.rejected}:</b> {p.last_reject.reject_reason ?? '—'}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="mt-1 text-[13px] font-extrabold text-slate-700">🗂 {t.docHistory}</div>
              {(d.documents ?? []).length === 0
                ? <div className={`${CARD} px-3 py-4 text-center text-[12.5px] font-semibold text-slate-500`}>{t.noDocs}</div>
                : (d.documents ?? []).slice(0, 15).map((x) => (
                  <div key={x.id} className={`${CARD} flex items-center gap-2 px-3 py-2`}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-extrabold">{t[x.doc_type] ?? x.doc_type}{x.doc_no ? ` · ${x.doc_no}` : ''}</div>
                      <div className="truncate text-[11px] font-semibold text-slate-500">{dmy(x.expiry_date)} · {dmyt(x.created_at)}</div>
                    </div>
                    <Pill s={x.status} />
                  </div>
                ))}
              <CallBar />
            </>
          )}
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  /** Send one renewed paper. The expiry typed here is a CLAIM: it rides with
   *  the document and only reaches the truck when the office approves it. */
  function RenewScreen({ id, docType }) {
    const [file, setFile] = useState(null);
    const [expiry, setExpiry] = useState('');
    const [docNo, setDocNo] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    const send = async () => {
      if (!file) { setErr(t.needPhoto); return; }
      if (!expiry) { setErr(t.newExpiry); return; }
      setBusy(true); setErr('');
      try {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        const up = await uploadMedia(file, `vehicle-docs/${docType.toLowerCase()}_${Date.now()}${isPdf ? '.pdf' : '.jpg'}`);
        const r = await api(`/portal/vendor/fleet/vehicle/${id}/document`, {
          method: 'POST',
          body: JSON.stringify({ doc_type: docType, file_key: up.path, expiry_date: expiry, doc_no: docNo || null }),
        });
        if (!r.ok) throw new Error(r.body?.detail ?? r.body?.error ?? `API ${r.status}`);
        await refresh(); say(t.sent); setView({ k: 'truck', id });
      } catch (e) { setErr(String(e?.message ?? e)); }
      setBusy(false);
    };

    return (
      <div className={SHELL} style={FONT} data-screen="renew">
        <Bar title={`${t.renewTitle} — ${t[docType]}`} back={() => setView({ k: 'truck', id })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.paperNote}</div>
          <div><Lbl>{t.newExpiry}</Lbl><Inp type="date" value={expiry} min={today()} onChange={(e) => { setExpiry(e.target.value); setErr(''); }} data-expiry /></div>
          <div><Lbl>{t.docNo}</Lbl><Inp value={docNo} onChange={(e) => setDocNo(e.target.value.toUpperCase())} placeholder="POL-123456" className="font-mono" data-docno /></div>
          <Uploader onSend={send} busy={busy} err={err} file={file} setFile={(f) => { setFile(f); setErr(''); }} />
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  /** The details the partner knows better than we do. Not the plate, and not
   *  the expiry dates — those two are the office's by design. */
  function EditTruck({ id }) {
    const v = (fleet.vehicles ?? []).find((x) => x.id === id);
    const [f, setF] = useState({
      vehicle_class: v?.vehicle_class ?? '', capacity: v?.capacity ?? '',
      engine_no: v?.engine_no ?? '', chassis_no: v?.chassis_no ?? '',
    });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const set = (k, x) => setF((o) => ({ ...o, [k]: x }));
    if (!v) { setView({ k: 'tabs' }); return null; }

    const save = async () => {
      setBusy(true); setErr('');
      const r = await api(`/portal/vendor/fleet/vehicle/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...f, capacity: f.capacity === '' ? null : Number(f.capacity) }),
      });
      setBusy(false);
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      await refresh(); say(t.saved); setView({ k: 'truck', id });
    };

    return (
      <div className={SHELL} style={FONT} data-screen="edittruck">
        <Bar title={t.editTruck} sub={v.registration_no} back={() => setView({ k: 'truck', id })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-2xl bg-slate-100 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-slate-700">{t.detailsNote}</div>
          <div><Lbl>{t.regNo}</Lbl><Inp value={v.registration_no} disabled className="font-mono opacity-60" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Lbl>{t.vclass}</Lbl><Inp value={f.vehicle_class ?? ''} onChange={(e) => set('vehicle_class', e.target.value)} placeholder="Oil Tanker" data-e="vehicle_class" /></div>
            <div><Lbl>{t.capacity}</Lbl><Inp inputMode="decimal" value={f.capacity ?? ''} onChange={(e) => set('capacity', e.target.value)} placeholder="20" data-e="capacity" /></div>
          </div>
          <div><Lbl>{t.engineNo}</Lbl><Inp value={f.engine_no ?? ''} onChange={(e) => set('engine_no', e.target.value.toUpperCase())} className="font-mono" data-e="engine_no" /></div>
          <div><Lbl>{t.chassisNo}</Lbl><Inp value={f.chassis_no ?? ''} onChange={(e) => set('chassis_no', e.target.value.toUpperCase())} className="font-mono" data-e="chassis_no" /></div>
          {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
          <button onClick={save} disabled={busy || viewAs} className="min-h-[58px] w-full rounded-2xl bg-blue-600 text-[18px] font-extrabold text-white disabled:opacity-60" data-edit-send>
            {busy ? t.sending : `💾 ${t.saveEdit}`}
          </button>
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  function AddTruck() {
    const [f, setF] = useState({ registration_no: '', vehicle_class: '', capacity: '', rc_expiry: '', ins_expiry: '', fit_expiry: '', np_expiry: '', puc_expiry: '' });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
    const send = async () => {
      if (!String(f.registration_no).trim()) { setErr(t.regNo); return; }
      setBusy(true); setErr('');
      const r = await api('/portal/vendor/fleet/vehicle', { method: 'POST', body: JSON.stringify({ ...f, capacity: f.capacity === '' ? null : Number(f.capacity) }) });
      setBusy(false);
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      await refresh(); say(t.sent); setView({ k: 'tabs' });
    };
    return (
      <div className={SHELL} style={FONT} data-screen="addtruck">
        <Bar title={t.addTruck} back={() => setView({ k: 'tabs' })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-2xl bg-amber-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-amber-900">{t.pendingNote}</div>
          <div><Lbl>{t.regNo}</Lbl><Inp value={f.registration_no} onChange={(e) => set('registration_no', e.target.value.toUpperCase())} placeholder="AS01AB1234" className="font-mono tracking-wide" data-v="registration_no" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Lbl>{t.vclass}</Lbl><Inp value={f.vehicle_class} onChange={(e) => set('vehicle_class', e.target.value)} placeholder="Oil Tanker" data-v="vehicle_class" /></div>
            <div><Lbl>{t.capacity}</Lbl><Inp inputMode="decimal" value={f.capacity} onChange={(e) => set('capacity', e.target.value)} placeholder="20" data-v="capacity" /></div>
          </div>
          <div className="text-[11px] font-extrabold text-slate-500">{t.papers}</div>
          <div className="grid grid-cols-2 gap-2">
            {[['rc_expiry', t.RC], ['ins_expiry', t.INSURANCE], ['fit_expiry', t.FITNESS], ['np_expiry', t.PERMIT], ['puc_expiry', t.PUC]].map(([k, l]) => (
              <div key={k}><Lbl>{l}</Lbl><Inp type="date" value={f[k]} min={today()} onChange={(e) => set(k, e.target.value)} /></div>
            ))}
          </div>
          {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
          <button onClick={send} disabled={busy || viewAs} className="min-h-[58px] w-full rounded-2xl bg-blue-600 text-[18px] font-extrabold text-white disabled:opacity-60" data-truck-send>{busy ? t.sending : `📤 ${t.save}`}</button>
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  function AddDriver() {
    const [f, setF] = useState({ name: '', mobile: '', licence_no: '', licence_expiry: '' });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
    const send = async () => {
      const m = String(f.mobile).replace(/\D/g, '').slice(-10);
      if (!String(f.name).trim() || !/^[6-9]\d{9}$/.test(m)) { setErr(`${t.dName} · ${t.dMobile}`); return; }
      setBusy(true); setErr('');
      const r = await api('/portal/vendor/fleet/driver', { method: 'POST', body: JSON.stringify({ ...f, mobile: m }) });
      setBusy(false);
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); return; }
      await refresh(); say(t.sent); setView({ k: 'tabs' });
    };
    return (
      <div className={SHELL} style={FONT} data-screen="adddriver">
        <Bar title={t.addDriver} back={() => setView({ k: 'tabs' })} />
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-2xl bg-amber-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-amber-900">{t.pendingNote}</div>
          <div><Lbl>{t.dName}</Lbl><Inp value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ramesh Das" data-d="name" /></div>
          <div><Lbl>{t.dMobile}</Lbl><Inp inputMode="numeric" maxLength={13} value={f.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="98765 43210" className="font-mono tracking-wide" data-d="mobile" /></div>
          <div><Lbl>{t.dLicence}</Lbl><Inp value={f.licence_no} onChange={(e) => set('licence_no', e.target.value.toUpperCase())} placeholder="AS0120200001234" className="font-mono" data-d="licence_no" /></div>
          <div><Lbl>{t.dLicExp}</Lbl><Inp type="date" value={f.licence_expiry} min={today()} onChange={(e) => set('licence_expiry', e.target.value)} /></div>
          {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
          <button onClick={send} disabled={busy || viewAs} className="min-h-[58px] w-full rounded-2xl bg-blue-600 text-[18px] font-extrabold text-white disabled:opacity-60" data-driver-send>{busy ? t.sending : `📤 ${t.save}`}</button>
        </div>
        {toast && <Toast />}
      </div>
    );
  }

  // ══ TABS ══════════════════════════════════════════════════════════════════
  const live = setts.filter((s) => LIVE.has(s.status));
  const done = setts.filter((s) => !LIVE.has(s.status));
  const segList = seg === 'LIVE' ? live : seg === 'DONE' ? done : setts;
  const mine = live.filter((s) => nextMove(s));
  // Papers that need the partner's attention, counted for the Fleet badge: an
  // expiry inside 30 days, or already gone.
  const paperAlerts = (fleet.vehicles ?? []).reduce((n, v) => {
    const dates = [v.rc_expiry, v.ins_expiry, v.fit_expiry, v.np_expiry, v.puc_expiry].filter(Boolean);
    return n + dates.filter((d) => daysTo(d) <= 30).length;
  }, 0);

  const TripCard = ({ s }) => {
    const mv = nextMove(s);
    return (
      <button onClick={() => setView({ k: 'trip', id: s.id })} className={`${CARD} w-full px-3 py-2.5 text-left`} data-trip={s.load_id}>
        <div className="flex items-start gap-2">
          <span className="text-[22px] leading-none">🚛</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-extrabold">{s.origin ?? '—'} → {s.destination ?? '—'}</div>
            <div className="truncate text-[11.5px] font-semibold text-slate-500">
              {s.load_id}{s.vehicle_reg ? ` · ${s.vehicle_reg}` : ''}{s.material ? ` · ${s.material}` : ''}{s.weight ? ` · ${s.weight} T` : ''}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <Pill s={s.status} />
            <div className="mt-1 text-[13.5px] font-extrabold">{inrShort(s.awarded_amount)}</div>
          </div>
        </div>
        {mv
          ? <div className="mt-2 rounded-xl bg-slate-900 px-3 py-2 text-center text-[13.5px] font-extrabold text-white">{mv.label} ›</div>
          : waitingLine(s) && <div className="mt-2 rounded-xl bg-slate-100 px-3 py-1.5 text-center text-[12px] font-extrabold text-slate-600">⏳ {waitingLine(s)}</div>}
      </button>
    );
  };

  /** One card for a truck or a driver in the list. A blocked one gets the
   *  office's reason and a phone number and NOTHING ELSE (owner, 3-Sep). */
  const PartyCard = ({ row, kind }) => {
    const st = row.system_status;
    const blocked = st === 'BLOCKED' || st === 'REJECTED';
    const pending = st === 'PENDING APPROVAL';
    const dates = kind === 'TRUCK'
      ? [[t.RC, row.rc_expiry], [t.INSURANCE, row.ins_expiry], [t.FITNESS, row.fit_expiry], [t.PERMIT, row.np_expiry], [t.PUC, row.puc_expiry]].filter(([, d]) => d)
      : [];
    const body = (
      <>
        <div className="flex items-start gap-2 px-3 py-2.5">
          <span className="text-[22px] leading-none">{kind === 'TRUCK' ? '🚛' : '🧑‍✈️'}</span>
          <div className="min-w-0 flex-1">
            {kind === 'TRUCK'
              ? <><TruckNo n={row.registration_no} /><div className="mt-0.5 truncate text-[11.5px] font-semibold text-slate-500">{[row.vehicle_class, row.capacity ? `${row.capacity} T` : null, row.driver_name].filter(Boolean).join(' · ') || '—'}</div></>
              : <><div className="truncate text-[14.5px] font-extrabold">{row.name}</div><div className="truncate font-mono text-[11.5px] font-semibold text-slate-500">{row.mobile}{row.licence_no ? ` · ${row.licence_no}` : ''}</div></>}
          </div>
          <Pill s={st} />
        </div>
        {pending && <div className="mx-3 mb-2.5 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-semibold leading-snug text-amber-900">⏳ {t.pendingNote}</div>}
        {blocked && (
          <div className="mx-3 mb-2.5 rounded-xl bg-red-50 px-3 py-2.5">
            <div className="text-[13px] font-extrabold text-red-800">🚫 {kind === 'TRUCK' ? t.blockedTitle : t.blockedDriver}</div>
            {row.reject_reason && <div className="mt-1 text-[12.5px] font-semibold leading-snug text-red-900">{row.reject_reason}</div>}
            <div className="mt-1 text-[11.5px] font-semibold text-red-900/75">{t.blockedNote}</div>
            <a href={DISPATCH_TEL} onClick={(e) => e.stopPropagation()} className="mt-2 block min-h-[44px] rounded-xl bg-red-600 py-2.5 text-center text-[14px] font-extrabold text-white">📞 {t.callOffice}</a>
          </div>
        )}
        {dates.length > 0 && !blocked && (
          <div className="border-t border-slate-100 px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {dates.map(([l, d]) => {
                const n = daysTo(d);
                return <span key={l} className={`rounded-full px-2 py-0.5 text-[10.5px] font-extrabold ${n < 0 ? 'bg-red-100 text-red-700' : n <= 30 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>{l} {dmy(d)}</span>;
              })}
            </div>
          </div>
        )}
      </>
    );
    // A truck opens; a driver has nothing behind it yet, so it does not pretend
    // to be a link.
    return kind === 'TRUCK'
      ? <button onClick={() => setView({ k: 'truck', id: row.id })} className={`${CARD} w-full text-left ${blocked ? 'border-red-300' : ''}`} data-vehicle={row.registration_no}>{body}</button>
      : <div className={`${CARD} ${blocked ? 'border-red-300' : ''}`}>{body}</div>;
  };

  const Nav = () => {
    const items = [
      ['home', '🏠', t.home, mine.length],
      ['loads', '📦', t.loads, openLoads.filter((l) => !l.my_bid_amount).length],
      ['trips', '🚛', t.trips, 0],
      ['money', '💰', t.money, 0],
      ['fleet', '🔧', t.fleet, (fleet.pending ?? 0) + paperAlerts],
    ];
    return (
      <nav className="fixed bottom-0 left-1/2 z-40 grid w-full max-w-md -translate-x-1/2 grid-cols-5 border-t border-slate-200 bg-white px-1 pb-2.5 pt-1.5">
        {items.map(([k, i, l, n]) => (
          <button key={k} onClick={() => { setTab(k); setView({ k: 'tabs' }); }}
            className={`relative flex min-h-[48px] flex-col items-center gap-0.5 py-1 text-[10.5px] font-extrabold ${tab === k ? 'text-blue-600' : 'text-slate-500'}`}
            data-nav={k}>
            <span className="text-[22px] leading-none">{i}</span>{l}
            {n > 0 && <span className="absolute right-[18%] top-0 rounded-full bg-red-500 px-1.5 text-[10px] font-extrabold text-white">{n}</span>}
          </button>
        ))}
      </nav>
    );
  };

  return (
    <div className={SHELL} style={FONT} data-screen={tab}>
      {tab === 'home' ? (
        <div className="sticky top-0 z-30 flex items-start gap-2 border-b border-slate-200 bg-white px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{t.brand}</div>
            <div className="truncate text-[18px] font-extrabold leading-tight">{me?.name ?? earn?.vendor ?? '—'}</div>
            <div className="truncate text-[11.5px] font-semibold text-slate-500">{t.partner}</div>
          </div>
          <button onClick={toggleLang} className="min-h-[38px] shrink-0 rounded-full bg-slate-100 px-3 text-[12px] font-bold">{lang === 'hi' ? 'हिं · EN' : 'EN · हिं'}</button>
        </div>
      ) : (
        <Bar
          title={tab === 'trips' ? t.tripsTitle : tab === 'money' ? t.moneyTitle : tab === 'fleet' ? t.fleetTitle : t.loads}
          sub={tab === 'trips' ? t.tripsSub : tab === 'money' ? t.moneySub : tab === 'fleet' ? t.fleetSub : ''}
        />
      )}

      {viewAs && <div className="mx-3 mt-2 rounded-2xl border-2 border-cyan-300 bg-cyan-50 px-3 py-2 text-[12px] font-extrabold text-cyan-900">👁 {t.viewAs}</div>}

      <div className="flex flex-1 flex-col gap-2.5 px-3 pb-28 pt-2.5">
        {tab === 'home' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {[[live.length, t.kRunning, 'text-blue-700'], [earn?.fleet?.active ?? 0, t.kTrucks, 'text-green-700'], [earn?.fleet?.pending ?? 0, t.kPending, 'text-amber-700']].map(([n, l, c]) => (
                <div key={l} className={`${CARD} px-2 py-2.5 text-center`}>
                  <div className={`text-[22px] font-extrabold ${c}`}>{n}</div>
                  <div className="text-[10.5px] font-semibold leading-tight text-slate-500">{l}</div>
                </div>
              ))}
            </div>

            {paperAlerts > 0 && (
              <button onClick={() => setTab('fleet')} className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-3 py-2.5 text-left" data-paper-alert>
                <div className="text-[13.5px] font-extrabold text-amber-900">📄 {paperAlerts} — {t.papers}</div>
                <div className="text-[11.5px] font-semibold text-amber-900/80">{t.paperNote}</div>
              </button>
            )}

            <div className="mt-1 text-[13px] font-extrabold text-slate-700">{t.running}</div>
            {live.length === 0 ? (
              <div className={`${CARD} px-3 py-6 text-center`}>
                {/* 🚛, not 🛻 — the pickup emoji has no glyph in Nirmala UI and
                    renders as a tofu box on the office machines. */}
                <div className="text-4xl">🚛</div>
                <div className="mt-2 text-[14px] font-extrabold text-slate-700">{t.nothingRunning}</div>
                <div className="mt-1 text-[12px] font-semibold leading-snug text-slate-500">{t.nothingRunningSub}</div>
              </div>
            ) : live.map((s) => <TripCard key={s.id} s={s} />)}
            <CallBar />
          </>
        )}

        {/* THE LOAD BOARD — switched back on 3-Sep at the owner's word, with the
            margin desk behind it. A bid here is an OFFER, not a booking: the
            office decides, and the screen says so rather than letting a partner
            plan a week around a lorry they have not been given. */}
        {tab === 'loads' && (
          <>
            <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.bidNote}</div>
            {openLoads.length === 0 ? (
              <div className={`${CARD} px-3 py-6 text-center`} data-screen="loads">
                <div className="text-4xl">📦</div>
                <div className="mt-2 text-[14px] font-extrabold text-slate-700">{t.noLoads}</div>
                <div className="mt-1 text-[12px] font-semibold leading-snug text-slate-500">{t.noLoadsSub}</div>
              </div>
            ) : openLoads.map((l) => (
              <div key={l.load_id} className={CARD} data-load={l.load_id}>
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <span className="text-[22px] leading-none">📦</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14.5px] font-extrabold">{l.origin} → {l.destination}</div>
                    <div className="truncate text-[11.5px] font-semibold text-slate-500">
                      {l.load_id}{l.material ? ` · ${l.material}` : ''}{l.weight ? ` · ${l.weight} T` : ''}{l.loading_date ? ` · ${dmy(l.loading_date)}` : ''}
                    </div>
                  </div>
                  {/* How many others are interested is fair to say; by how much
                      is not, and the server never sends it. */}
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10.5px] font-extrabold text-slate-600">
                    {l.bid_count ?? 0} {t.bidsWord}
                  </span>
                </div>
                {l.my_bid_amount ? (
                  <div className="mx-3 mb-2.5 rounded-xl bg-green-50 px-3 py-2 text-[12.5px] font-extrabold text-green-800">
                    ✅ {t.myBid} ₹{Number(l.my_bid_amount).toLocaleString('en-IN')} · {t.withOffice}
                  </div>
                ) : (
                  <div className="px-3 pb-3">
                    <button onClick={() => setView({ k: 'bid', id: l.load_id })} disabled={viewAs}
                      className="min-h-[50px] w-full rounded-xl bg-blue-600 text-[16px] font-extrabold text-white disabled:opacity-50" data-bid-open={l.load_id}>
                      💰 {t.placeBid}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'trips' && (
          <>
            <div className="flex gap-1 rounded-xl bg-slate-200 p-[3px]">
              {[['LIVE', `${t.segLive} ${live.length}`], ['DONE', `${t.segDone} ${done.length}`], ['ALL', t.segAll]].map(([k, l]) => (
                <button key={k} onClick={() => setSeg(k)} className={`min-h-[38px] flex-1 rounded-[10px] px-1 text-[12.5px] font-extrabold ${seg === k ? 'bg-white text-slate-900 shadow' : 'text-slate-600'}`}>{l}</button>
              ))}
            </div>
            {segList.length === 0
              ? <div className={`${CARD} px-3 py-6 text-center text-[13px] font-semibold text-slate-500`}>{t.noTrips}</div>
              : segList.map((s) => <TripCard key={s.id} s={s} />)}
          </>
        )}

        {tab === 'money' && (
          <>
            {showMoney && earn?.ledger ? (
              <div className={CARD}>
                <KV rows={[
                  [t.billed, inr(earn.ledger.billed), 'text-blue-700'],
                  [t.posted, inr(earn.ledger.posted), 'text-green-700'],
                  [t.awaiting, inr(earn.ledger.awaiting_approval), 'text-amber-700'],
                  [t.bal, inr(earn.ledger.current_balance), 'text-slate-900'],
                ]} />
              </div>
            ) : (
              <div className={`${CARD} px-3 py-5 text-center`}>
                <div className="text-3xl">🔒</div>
                <div className="mt-1 text-[13px] font-semibold leading-snug text-slate-600">{t.moneyLocked}</div>
              </div>
            )}

            <div className="mt-1 text-[13px] font-extrabold text-slate-700">{t.tripsTitle}</div>
            {done.length === 0
              ? <div className={`${CARD} px-3 py-4 text-center text-[12.5px] font-semibold text-slate-500`}>{t.noTrips}</div>
              : done.slice(0, 12).map((s) => (
                <div key={s.id} className={`${CARD} flex items-center gap-2 px-3 py-2`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-extrabold">{s.origin} → {s.destination}</div>
                    <div className="truncate text-[11px] font-semibold text-slate-500">{s.load_id} · {dmy(s.loading_date)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[13px] font-extrabold">{inrShort(s.awarded_amount)}</div>
                    <Pill s={s.status} />
                  </div>
                </div>
              ))}

            <div className={CARD}>
              <KV rows={[
                [t.myName, me?.name ?? earn?.vendor ?? '—'],
                [t.payTerms, earn?.payment_terms ?? '—'],
                [t.language, <button onClick={toggleLang} className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-extrabold">{lang === 'hi' ? 'हिंदी · EN' : 'English · हिं'}</button>],
              ]} />
            </div>
            <CallBar />
            <button onClick={() => { for (const k of ['prasad_token', 'prasad_user', 'prasad_view_as_vendor']) localStorage.removeItem(k); location.reload(); }}
              className="min-h-[46px] rounded-2xl border-2 border-slate-300 bg-white text-[15px] font-extrabold">🚪 {t.logout}</button>
          </>
        )}

        {tab === 'fleet' && (
          <>
            <div className="flex gap-1 rounded-xl bg-slate-200 p-[3px]">
              {[['TRUCKS', `${t.trucksTab} ${fleet.vehicles?.length ?? 0}`], ['DRIVERS', `${t.driversTab} ${fleet.drivers?.length ?? 0}`]].map(([k, l]) => (
                <button key={k} onClick={() => setFleetSeg(k)} className={`min-h-[38px] flex-1 rounded-[10px] px-1 text-[12.5px] font-extrabold ${fleetSeg === k ? 'bg-white text-slate-900 shadow' : 'text-slate-600'}`}>{l}</button>
              ))}
            </div>

            {fleetSeg === 'TRUCKS' ? (
              <>
                <button onClick={() => setView({ k: 'addTruck' })} disabled={viewAs} className="min-h-[50px] rounded-2xl bg-blue-600 text-[15px] font-extrabold text-white disabled:opacity-50" data-add-truck>{t.addTruck}</button>
                {(fleet.vehicles ?? []).length === 0 && <div className={`${CARD} px-3 py-5 text-center text-[13px] font-semibold text-slate-500`}>{t.noTrucks}</div>}
                {(fleet.vehicles ?? []).map((v) => <PartyCard key={v.id} row={v} kind="TRUCK" />)}
              </>
            ) : (
              <>
                <button onClick={() => setView({ k: 'addDriver' })} disabled={viewAs} className="min-h-[50px] rounded-2xl bg-blue-600 text-[15px] font-extrabold text-white disabled:opacity-50" data-add-driver>{t.addDriver}</button>
                {(fleet.drivers ?? []).length === 0 && <div className={`${CARD} px-3 py-5 text-center text-[13px] font-semibold text-slate-500`}>{t.noDrivers}</div>}
                {(fleet.drivers ?? []).map((d) => <PartyCard key={d.id} row={d} kind="DRIVER" />)}
              </>
            )}
          </>
        )}
      </div>

      <Nav />
      {toast && <Toast />}
    </div>
  );
}
