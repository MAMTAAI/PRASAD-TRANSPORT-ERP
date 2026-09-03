// @ts-nocheck
// ============================================================================
// CUSTOMER APP v1 — the consignor's phone (Super-App role 3 of 4)
//
// Approved by the owner on 2026-09-03 from docs/mockups/customer-app-mock-v1.html,
// with these rules:
//   · ENGLISH FIRST with a हिं toggle — the readers are oil-company officers
//     (IOCL / BPCL / HPCL) and private consignors, not drivers. The vendor and
//     fleet-partner apps stay Hindi-first; this one flips the default only.
//   · POD IS VISIBLE ONLY AFTER THE OFFICE VERIFIES IT. Not when the driver
//     uploads it. An unverified delivery is listed with the truck, the date and
//     "with the office" — and no file. The server enforces the same rule twice
//     (customerPortal /pods, and files.routes mayReadKey), because a hidden
//     button is not a permission.
//   · BOOKINGS SPLIT ON THE CUSTOMER. A corporate whose loads arrive by mail
//     (AC4/AC5) gets a read-only indent list and NO booking button; a private
//     consignor gets "Request Indent" and the full form. The split is the
//     server's `can_request_indent` (cust.place_order, which now honours the
//     legacy `place_orders:false` written by the customer master).
//   · DRIVER PHONE AND FREIGHT stay hidden unless the office switches
//     cust.shipments.driver / .freight on for that account; the call bar goes
//     to dispatch either way.
//   · EVERY WRITE READS AS "SENT TO OFFICE" — the staging fence makes that
//     true server-side: a new booking lands PENDING_REVIEW and accepting an
//     offer only REQUESTS the award (the desk decides).
//
// Same family as DriverPortal.tsx / ServiceVendorApp.tsx: light theme,
// Segoe/Nirmala UI, emoji, 46 px targets, one map component (RouteMap).
// Nothing on this screen is invented — every number came out of the API on
// this visit, and a fact we do not have is drawn as absent, never as zero.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';
import RouteMap from '../lib/RouteMap';
import { DISPATCH_TEL, DISPATCH_DISPLAY } from '../lib/dispatchContact';

const API = API_BASE;
const LANG_KEY = 'prasad_customer_lang';

const authHeaders = () => {
  const h = {};
  const token = localStorage.getItem('prasad_token');
  if (token) h.Authorization = `Bearer ${token}`;
  // Staff preview (CustomerPreview.tsx): the server scopes every read to this
  // customer and refuses every write. Absent for a real customer session.
  const viewAs = localStorage.getItem('prasad_view_as_customer');
  if (viewAs) h['X-View-As-Customer'] = viewAs;
  return h;
};
const api = async (path, opts = {}) => {
  const headers = { ...authHeaders(), ...(opts.headers ?? {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}/api/v1${path}`, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, body };
};
/** Vault file (POD photo / PDF / statement) — the GET needs the bearer, so
 *  fetch → blob → object URL. Same reason openDocument.ts exists. */
const fetchFile = async (key, { download = false } = {}) => {
  const clean = String(key || '').replace(/^\/+/, '').replace(/^api\/v1\/files\//, '');
  const r = await fetch(`${API}/api/v1/files/${clean}${download ? '?download=1' : ''}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
};
const openBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  if (filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const inr = (n) => (Number.isFinite(Number(n)) ? '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—');
const inrShort = (n) => { const v = Number(n); if (!Number.isFinite(v)) return '—'; return Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(2)}L` : inr(v); };
const qty = (n, unit = 'KL') => (Number.isFinite(Number(n)) ? `${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}` : '—');
const dmy = (v) => { try { return v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—'; } catch { return '—'; } };
const dmyt = (v) => { try { return v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; } catch { return '—'; } };
const hm = (v) => { try { return v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''; } catch { return ''; } };
const today = () => new Date().toISOString().slice(0, 10);
const ON_ROAD = new Set(['LOADED', 'IN_TRANSIT', 'UNLOADING']);
const DONE = new Set(['COMPLETED', 'SETTLED']);

// ── words, English first ────────────────────────────────────────────────────
const T = {
  en: {
    brand: 'Prasad Transport · Customer', customer: 'Customer', home: 'Home', trips: 'Trips', book: 'Bookings', pod: 'POD', acct: 'Account',
    kRoad: 'trucks on road', kDone: 'delivered', kPod: 'POD pending',
    todays: "Today's dispatches", allN: (n) => `all ${n} ›`, none: 'Nothing on the road right now', noneSub: 'New dispatches appear here the moment the office loads a truck.',
    tTrack: 'Live Tracking', tTrackSub: 'trucks on road', tBook: 'Bookings', tBookSub: 'indent status', tPod: 'Digital POD', tPodSub: 'delivery proof', tBills: 'Bills', tBillsSub: 'statement · outstanding',
    call: 'Call dispatch', callSub: DISPATCH_DISPLAY, track: 'Track live', details: 'Details', viewPod: 'View POD',
    shipments: 'My shipments', segRoad: 'On road', segDone: 'Delivered', segAll: 'All', noTrips: 'No shipments on record yet',
    inTransit: 'IN TRANSIT', loaded: 'LOADED', unloading: 'UNLOADING', delivered: 'DELIVERED', pending: 'PENDING', cancelled: 'CANCELLED',
    via: 'Tracking via', viaNone: 'No position reported yet', viaNoneSub: 'The truck reports when the driver app or the GPS unit next connects.',
    minAgo: (n) => `${n} min ago`, hrAgo: (n) => `${n} h ago`, justNow: 'just now',
    eta: 'ETA', kmLeft: 'km left', routeIs: 'Route', about: 'about', noEta: 'ETA when the truck next reports',
    tlLoaded: 'Loaded', tlSeen: 'Last seen', tlDest: 'Unloading point', tlDelivered: 'Delivered', challan: 'Challan', share: 'Share status',
    truck: 'Truck', product: 'Product', advice: 'Advice no', loadedOn: 'Loaded', expected: 'Expected', driver: 'Driver', freight: 'Freight',
    viaOffice: 'via dispatch ☎', byContract: 'as per contract', unloadedQ: 'Unloaded', shortage: 'Shortage', route: 'Route',
    hiddenNote: 'Driver number and freight appear here only when the office enables them for your account.',
    bookTitle: 'Bookings', bookSub: 'Sent → Review → Arranging → Assigned → Delivered',
    steps: ['Sent', 'Review', 'Arranging', 'Assigned', 'Delivered'],
    stReview: 'Office is reviewing · you will get a WhatsApp', stOpen: 'Open to market · offers coming in', stAsked: 'Your choice is with the office for approval',
    stAwarded: 'Truck assigned', stClosed: 'Completed', stCancelled: 'Cancelled by office',
    offersN: (n) => `See ${n} offer${n === 1 ? '' : 's'}`, noBookings: 'No bookings yet', bookCta: 'Request Indent',
    corpTitle: 'Your indents come by mail', corpSub: 'Loads for this account are placed by your office (AC4 / AC5) and appear here as shipments. Nothing is booked from the phone.',
    offers: 'Offers', noOffers: 'No offers yet — the office invites verified fleet partners once the load is opened.',
    accept: 'Accept · send to office', accepting: 'Sending…', target: 'Your target', status: 'Status', material: 'Material', weight: 'Weight', loadDate: 'Loading date', vtype: 'Vehicle type',
    awardNote: 'Accepting an offer asks the office to award it. The desk confirms the truck and driver, then this shows “Assigned”.',
    newTitle: 'Request an indent', newSub: 'Goes to the office for review',
    lane: 'From → To (recent lanes)', other: '＋ other', fromLbl: 'From', toLbl: 'To', targetOpt: 'Target rate (optional)', perTrip: 'per trip',
    sendOffice: 'Send to office', sending: 'Sending…', needLane: 'Enter both the loading and the unloading point',
    newNote: 'The office reviews new bookings in office hours and opens them to the market or assigns own fleet. You get a WhatsApp at each step.',
    sent: 'Sent!', sentSub: (id) => `Booking ${id} is with the office`, sentPill: 'UNDER REVIEW',
    sentNote: 'You will get a WhatsApp when it is opened to the market or a truck is assigned. Track it under Bookings.', seeBookings: 'See bookings', homeBtn: 'Home',
    podTitle: 'Digital POD', podSub: 'Delivery proof · verified by office', segReady: 'Ready', segWait: 'Pending',
    podReady: 'POD ✅', podOffice: 'WITH OFFICE', podWait: 'PENDING', view: 'View', save: 'Save', noPods: 'No delivery proof yet',
    podPending: 'Delivered — the paper is with the office. It appears here the moment it is verified.',
    podView: 'POD', verified: 'verified', receivedBy: 'Received by', loadedUnloaded: 'Loaded / Unloaded', openFail: 'Could not open this file. Call the office.',
    account: 'Account', readonly: 'read-only', billsHead: 'Bills', billed: 'Billed', received: 'Received', outstanding: 'Outstanding',
    terms: 'terms', days: 'days', stmt: 'Statement PDF', billsList: 'Bills list', noBills: 'No bills on record',
    code: 'Customer code', gst: 'GST', payTerms: 'Payment terms', cycle: 'Billing cycle', city: 'City', language: 'Language',
    ledgerLocked: 'Bills and outstanding show only when the office enables the Ledger module for your account.',
    logout: 'Logout', loading: 'Opening…', notApproved: 'Awaiting office approval', cantReach: 'Cannot reach the office',
    preview: 'Staff preview — read-only. Nothing you press here is sent in this customer’s name.',
    back: 'Back', refresh: 'Refresh', month: 'this month',
  },
  hi: {
    brand: 'प्रसाद ट्रांसपोर्ट · कस्टमर', customer: 'कस्टमर', home: 'होम', trips: 'गाड़ियाँ', book: 'बुकिंग', pod: 'POD', acct: 'खाता',
    kRoad: 'गाड़ियाँ रास्ते में', kDone: 'डिलीवर हुईं', kPod: 'POD बाकी',
    todays: 'आज की गाड़ियाँ', allN: (n) => `सब ${n} ›`, none: 'अभी कोई गाड़ी रास्ते में नहीं', noneSub: 'ऑफिस गाड़ी लोड करते ही यहाँ दिखेगी।',
    tTrack: 'लाइव ट्रैकिंग', tTrackSub: 'रास्ते में', tBook: 'बुकिंग', tBookSub: 'इंडेंट की स्थिति', tPod: 'डिजिटल POD', tPodSub: 'डिलीवरी का सबूत', tBills: 'बिल', tBillsSub: 'स्टेटमेंट · बकाया',
    call: 'डिस्पैच को कॉल करो', callSub: DISPATCH_DISPLAY, track: 'लाइव देखो', details: 'विवरण', viewPod: 'POD देखो',
    shipments: 'मेरी गाड़ियाँ', segRoad: 'रास्ते में', segDone: 'डिलीवर', segAll: 'सब', noTrips: 'अभी कोई गाड़ी दर्ज नहीं',
    inTransit: 'रास्ते में', loaded: 'लोड हुई', unloading: 'खाली हो रही', delivered: 'डिलीवर', pending: 'बाकी', cancelled: 'रद्द',
    via: 'लोकेशन स्रोत', viaNone: 'अभी लोकेशन नहीं आई', viaNoneSub: 'ड्राइवर ऐप या GPS जुड़ते ही लोकेशन आएगी।',
    minAgo: (n) => `${n} मिनट पहले`, hrAgo: (n) => `${n} घंटे पहले`, justNow: 'अभी',
    eta: 'पहुँचने का समय', kmLeft: 'किमी बाकी', routeIs: 'रास्ता', about: 'लगभग', noEta: 'लोकेशन आते ही समय दिखेगा',
    tlLoaded: 'लोड हुई', tlSeen: 'आख़िरी लोकेशन', tlDest: 'खाली करने की जगह', tlDelivered: 'डिलीवर हुई', challan: 'चालान', share: 'स्थिति भेजो',
    truck: 'ट्रक', product: 'माल', advice: 'एडवाइस नं', loadedOn: 'लोड', expected: 'अनुमान', driver: 'ड्राइवर', freight: 'भाड़ा',
    viaOffice: 'डिस्पैच से ☎', byContract: 'अनुबंध अनुसार', unloadedQ: 'खाली हुआ', shortage: 'कमी', route: 'रास्ता',
    hiddenNote: 'ड्राइवर नंबर और भाड़ा तभी दिखेगा जब ऑफिस आपके खाते के लिए चालू करे।',
    bookTitle: 'बुकिंग', bookSub: 'भेजा → जाँच → गाड़ी ढूँढ रहे → गाड़ी लगी → डिलीवर',
    steps: ['भेजा', 'जाँच', 'ढूँढ रहे', 'गाड़ी लगी', 'डिलीवर'],
    stReview: 'ऑफिस देख रहा है · WhatsApp आएगा', stOpen: 'मार्केट में खुला · ऑफर आ रहे हैं', stAsked: 'आपकी पसंद ऑफिस की मंज़ूरी के लिए गई है',
    stAwarded: 'गाड़ी लग गई', stClosed: 'पूरा हुआ', stCancelled: 'ऑफिस ने रद्द किया',
    offersN: (n) => `${n} ऑफर देखो`, noBookings: 'अभी कोई बुकिंग नहीं', bookCta: 'इंडेंट माँगो',
    corpTitle: 'आपके इंडेंट मेल से आते हैं', corpSub: 'इस खाते की गाड़ियाँ आपका ऑफिस (AC4 / AC5) से भेजता है और यहाँ गाड़ियों में दिखती हैं। फोन से बुकिंग नहीं होती।',
    offers: 'ऑफर', noOffers: 'अभी कोई ऑफर नहीं — ऑफिस लोड खोलने पर वेरिफाइड पार्टनर बुलाता है।',
    accept: 'मंज़ूर · ऑफिस को भेजो', accepting: 'भेज रहे हैं…', target: 'आपका रेट', status: 'स्थिति', material: 'माल', weight: 'वज़न', loadDate: 'लोडिंग तारीख', vtype: 'गाड़ी का प्रकार',
    awardNote: 'ऑफर मंज़ूर करने पर ऑफिस से award माँगा जाता है। ऑफिस गाड़ी और ड्राइवर पक्का करेगा, फिर यहाँ “गाड़ी लगी” दिखेगा।',
    newTitle: 'इंडेंट माँगो', newSub: 'ऑफिस की जाँच के लिए जाएगा',
    lane: 'कहाँ से → कहाँ तक', other: '＋ और', fromLbl: 'कहाँ से', toLbl: 'कहाँ तक', targetOpt: 'रेट (ज़रूरी नहीं)', perTrip: 'प्रति ट्रिप',
    sendOffice: 'ऑफिस को भेजो', sending: 'भेज रहे हैं…', needLane: 'लोडिंग और अनलोडिंग दोनों जगह भरो',
    newNote: 'ऑफिस दफ़्तर के समय में देखेगा और मार्केट में खोलेगा या अपनी गाड़ी लगाएगा। हर कदम पर WhatsApp आएगा।',
    sent: 'भेज दिया!', sentSub: (id) => `बुकिंग ${id} ऑफिस के पास है`, sentPill: 'जाँच में',
    sentNote: 'मार्केट में खुलते ही या गाड़ी लगते ही WhatsApp आएगा। बुकिंग में देखते रहो।', seeBookings: 'बुकिंग देखो', homeBtn: 'होम',
    podTitle: 'डिजिटल POD', podSub: 'डिलीवरी का सबूत · ऑफिस से जाँचा हुआ', segReady: 'तैयार', segWait: 'बाकी',
    podReady: 'POD ✅', podOffice: 'ऑफिस के पास', podWait: 'बाकी', view: 'देखो', save: 'सेव', noPods: 'अभी कोई POD नहीं',
    podPending: 'डिलीवर हो गई — कागज़ ऑफिस के पास है। जाँच होते ही यहाँ दिखेगा।',
    podView: 'POD', verified: 'जाँचा', receivedBy: 'प्राप्तकर्ता', loadedUnloaded: 'लोड / खाली', openFail: 'फाइल नहीं खुली। ऑफिस को कॉल करो।',
    account: 'खाता', readonly: 'सिर्फ़ देखने के लिए', billsHead: 'बिल', billed: 'बिल बना', received: 'भुगतान मिला', outstanding: 'बकाया',
    terms: 'शर्त', days: 'दिन', stmt: 'स्टेटमेंट PDF', billsList: 'बिलों की सूची', noBills: 'कोई बिल नहीं',
    code: 'कस्टमर कोड', gst: 'GST', payTerms: 'भुगतान शर्त', cycle: 'बिलिंग', city: 'शहर', language: 'भाषा',
    ledgerLocked: 'बिल और बकाया तभी दिखेंगे जब ऑफिस लेजर मॉड्यूल चालू करे।',
    logout: 'बाहर निकलो', loading: 'खुल रहा है…', notApproved: 'ऑफिस की मंज़ूरी बाकी', cantReach: 'ऑफिस से संपर्क नहीं हो रहा',
    preview: 'स्टाफ प्रीव्यू — सिर्फ़ देखने के लिए। यहाँ से कुछ भी कस्टमर के नाम पर नहीं जाता।',
    back: 'वापस', refresh: 'फिर से', month: 'इस महीने',
  },
};

const FONT = { fontFamily: '"Segoe UI","Nirmala UI",system-ui,-apple-system,Roboto,sans-serif' };
const SHELL = 'mx-auto flex min-h-screen w-full max-w-md flex-col bg-[#f8fafc] text-slate-900';
const CARD = 'rounded-2xl border-2 border-slate-200 bg-white';
const PILL = {
  IN_TRANSIT: 'bg-blue-100 text-blue-800', LOADED: 'bg-blue-100 text-blue-800', UNLOADING: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-green-100 text-green-800', SETTLED: 'bg-green-100 text-green-800',
  PENDING: 'bg-slate-100 text-slate-600', CANCELLED: 'bg-red-100 text-red-800',
  READY: 'bg-green-100 text-green-800', WITH_OFFICE: 'bg-amber-100 text-amber-800',
};
const SOURCE = { DRIVER_APP: 'Driver app', DRIVER: 'Driver app', GPRS: 'GPRS', GPS: 'GPS', FASTAG: 'FASTag', MANUAL: 'Office entry' };

const Pill = ({ s, label }) => <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-extrabold ${PILL[s] ?? 'bg-slate-100 text-slate-600'}`}>{label ?? s}</span>;
const TruckNo = ({ n }) => (n ? <span className="inline-block rounded-md bg-amber-100 px-1.5 py-0.5 font-mono text-[11.5px] font-bold text-amber-900">{n}</span> : null);
const KV = ({ rows }) => (
  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-3">
    {rows.filter(Boolean).map(([k, v, cls]) => (
      <React.Fragment key={k}>
        <span className="text-[12.5px] font-semibold text-slate-500">{k}</span>
        <b className={`text-right text-[13.5px] font-extrabold ${cls ?? ''}`}>{v}</b>
      </React.Fragment>
    ))}
  </div>
);
const Steps = ({ n, labels }) => (
  <div className="flex items-center px-0.5 pt-2">
    {labels.map((l, i) => (
      <div key={l} className="relative flex flex-1 flex-col items-center gap-0.5 text-center text-[9px] font-extrabold">
        <i className={`grid h-[20px] w-[20px] place-items-center rounded-full not-italic text-[10px] ${i < n ? 'bg-green-600 text-white' : i === n ? 'bg-blue-600 text-white ring-4 ring-blue-200' : 'bg-slate-200 text-slate-500'}`}>{i < n ? '✓' : i + 1}</i>
        <span className={i <= n ? 'text-slate-900' : 'text-slate-400'}>{l}</span>
        {i < labels.length - 1 && <span className={`absolute left-[calc(50%+11px)] top-[10px] h-[2px] w-[calc(100%-22px)] ${i < n ? 'bg-green-600' : 'bg-slate-200'}`} />}
      </div>
    ))}
  </div>
);

/** Load status → how far along the 5-step stepper, in the customer's words. */
const bookStep = (status) => ({ PENDING_REVIEW: 1, OPEN: 2, AWARD_REQUESTED: 2, AWARDED: 3, CLOSED: 5, CANCELLED: 0 }[status] ?? 0);

export default function CustomerApp() {
  const [lang, setLang] = useState(() => (localStorage.getItem(LANG_KEY) === 'hi' ? 'hi' : 'en'));
  const t = T[lang];
  const toggleLang = () => { const n = lang === 'en' ? 'hi' : 'en'; setLang(n); try { localStorage.setItem(LANG_KEY, n); } catch { /* private mode */ } };

  const [gate, setGate] = useState('loading');       // loading | ok | not_approved | error
  const [gateMsg, setGateMsg] = useState('');
  const [vis, setVis] = useState({});
  const [me, setMe] = useState(null);
  const [sum, setSum] = useState(null);
  const [trips, setTrips] = useState([]);
  const [withheld, setWithheld] = useState([]);
  const [pods, setPods] = useState([]);
  const [loads, setLoads] = useState([]);
  const [bills, setBills] = useState([]);

  const [tab, setTab] = useState('home');
  const [view, setView] = useState({ k: 'tabs' });    // track | trip | booking | newbook | sent | podview
  const [seg, setSeg] = useState('ROAD');
  const [podSeg, setPodSeg] = useState('READY');
  const [toast, setToast] = useState('');
  const viewAs = !!localStorage.getItem('prasad_view_as_customer');

  const say = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };
  const canOrder = !!sum?.can_request_indent;
  const showLedger = !!vis['cust.ledger'];
  const showDriver = !!vis['cust.shipments.driver'];
  const showFreight = !!vis['cust.shipments.freight'];

  const loadAll = useCallback(async (v) => {
    const jobs = [
      v['cust.dashboard'] ? api('/portal/customer/summary') : Promise.resolve({ ok: false }),
      v['cust.shipments'] ? api('/portal/customer/trips?limit=120') : Promise.resolve({ ok: false }),
      v['cust.pods'] ? api('/portal/customer/pods') : Promise.resolve({ ok: false }),
      v['cust.place_order'] ? api('/portal/customer/loads') : Promise.resolve({ ok: false }),
      v['cust.ledger'] ? api('/portal/customer/bills?limit=24') : Promise.resolve({ ok: false }),
    ];
    const [s, tr, pd, ld, bl] = await Promise.all(jobs);
    if (s.ok) setSum(s.body);
    if (tr.ok) { setTrips(tr.body?.trips ?? []); setWithheld(tr.body?.withheld ?? []); }
    if (pd.ok) setPods(pd.body?.pods ?? []);
    if (ld.ok) setLoads(ld.body?.loads ?? []);
    if (bl.ok) setBills(bl.body?.bills ?? []);
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

  const tripByCode = useCallback((code) => trips.find((x) => x.trip_code === code) ?? null, [trips]);
  const podForTrip = useCallback((code) => pods.find((p) => p.ref === code && p.pod_status === 'READY') ?? null, [pods]);

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* best effort */ }
    localStorage.removeItem('prasad_token');
    window.location.href = '/app';
  };

  const openPodFile = async (p, download = false) => {
    if (!p?.file_key) return;
    try {
      const blob = await fetchFile(p.file_key, { download });
      openBlob(blob, download ? `POD_${p.ref}${/\.pdf$/i.test(p.file_key) ? '.pdf' : '.jpg'}` : null);
    } catch { say(t.openFail); }
  };
  const sharePod = async (p) => {
    const text = `Prasad Transport · POD ${p.ref} · ${p.vehicle_no ?? ''} · ${p.origin ?? ''} → ${p.destination ?? ''} · ${dmy(p.delivered_at)}`;
    try {
      if (p.file_key && navigator.canShare) {
        const blob = await fetchFile(p.file_key);
        const file = new File([blob], `POD_${p.ref}.jpg`, { type: blob.type || 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
      }
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch { /* user cancelled or share unsupported — fall through to WhatsApp */ }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  };
  const shareTrip = async (trip, tk) => {
    const bits = [
      `Prasad Transport · ${trip.trip_code} · ${trip.vehicle_no ?? ''}`,
      `${trip.loading_point ?? ''} → ${trip.unloading_location ?? ''}`,
      `${t.status}: ${statusWord(trip.status)}`,
      tk?.eta ? `${t.eta} ${hm(tk.eta.arrival_at)} · ${tk.eta.remaining_km} ${t.kmLeft}` : '',
      tk?.position ? `${t.via}: ${SOURCE[tk.position.source] ?? tk.position.source} · ${ago(tk.age_min)}` : '',
    ].filter(Boolean).join('\n');
    try { if (navigator.share) { await navigator.share({ text: bits }); return; } } catch { /* cancelled */ }
    window.open(`https://wa.me/?text=${encodeURIComponent(bits)}`, '_blank', 'noopener');
  };

  const statusWord = (s) => ({ IN_TRANSIT: t.inTransit, LOADED: t.loaded, UNLOADING: t.unloading, COMPLETED: t.delivered, SETTLED: t.delivered, PENDING: t.pending, CANCELLED: t.cancelled }[s] ?? s);
  const ago = (min) => (min == null ? '' : min < 1 ? t.justNow : min < 60 ? t.minAgo(min) : t.hrAgo(Math.round(min / 60)));

  // ── shared chrome ─────────────────────────────────────────────────────────
  const Bar = ({ title, sub, back, right }) => (
    <div className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2.5">
      {back && <button onClick={back} className="min-h-[42px] rounded-full bg-slate-100 px-3.5 text-[16px] font-bold">‹</button>}
      <div className="min-w-0 flex-1"><div className="truncate text-[17px] font-extrabold leading-tight">{title}</div>{sub && <div className="truncate text-[11.5px] font-semibold text-slate-500">{sub}</div>}</div>
      {right}
      <button onClick={toggleLang} className="min-h-[38px] shrink-0 rounded-full bg-slate-100 px-3 text-[12px] font-bold">{lang === 'en' ? 'EN · हिं' : 'हिं · EN'}</button>
    </div>
  );
  const CallBar = () => (
    <a href={DISPATCH_TEL} className="block min-h-[46px] rounded-2xl bg-slate-900 py-3 text-center text-[16px] font-extrabold text-white">📞 {t.call}</a>
  );
  const Seg = ({ items, value, onChange }) => (
    <div className="flex gap-1 rounded-xl bg-slate-200 p-[3px]">
      {items.map(([k, l]) => <button key={k} onClick={() => onChange(k)} className={`min-h-[38px] flex-1 rounded-[10px] px-1 text-[12.5px] font-extrabold ${value === k ? 'bg-white text-slate-900 shadow' : 'text-slate-600'}`}>{l}</button>)}
    </div>
  );
  const Tile = ({ tone, icon, label, sub, badge, onClick }) => (
    <button onClick={onClick} className={`relative flex min-h-[104px] flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-2 shadow-[0_5px_0_rgba(0,0,0,0.18)] active:translate-y-1 active:shadow-none ${tone}`}>
      <span className="text-[30px] leading-none">{icon}</span>
      <span className="mt-1 text-center text-[15px] font-extrabold leading-tight">{label}</span>
      <span className="text-[10.5px] font-semibold opacity-90">{sub}</span>
      {badge ? <span className="absolute right-2 top-2 rounded-full bg-red-500 px-2 py-0.5 text-[10.5px] font-extrabold text-white">{badge}</span> : null}
    </button>
  );
  const Nav = () => {
    const items = [
      ['home', '🏠', t.home, 0],
      ['trips', '🚚', t.trips, sum?.trips?.on_road ?? 0],
      ['book', '📋', t.book, sum?.bookings?.offers ?? 0],
      ['pod', '📄', t.pod, sum?.pods?.awaited ?? 0],
      ['acct', '👤', t.acct, 0],
    ];
    return (
      <nav className="fixed bottom-0 left-1/2 z-40 grid w-full max-w-md -translate-x-1/2 grid-cols-5 border-t border-slate-200 bg-white px-1 pb-2.5 pt-1.5">
        {items.map(([k, i, l, n]) => (
          <button key={k} onClick={() => { setTab(k); setView({ k: 'tabs' }); }} className={`relative flex min-h-[48px] flex-col items-center gap-0.5 py-1 text-[10.5px] font-extrabold ${tab === k ? 'text-blue-600' : 'text-slate-500'}`}>
            <span className="text-[21px] leading-none">{i}</span>{l}
            {n > 0 && <span className="absolute right-3 top-0 rounded-full bg-red-500 px-1.5 text-[9.5px] font-extrabold text-white">{n}</span>}
          </button>
        ))}
      </nav>
    );
  };
  const Toast = () => (toast ? <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] font-bold text-white shadow-lg">{toast}</div> : null);
  const PreviewNote = () => (viewAs ? <div className="rounded-2xl border-2 border-cyan-300 bg-cyan-50 px-3 py-2 text-[12px] font-bold text-cyan-900">👁 {t.preview}</div> : null);

  const TripRow = ({ x, highlight }) => {
    const pod = podForTrip(x.trip_code);
    return (
      <div className={`${CARD} ${highlight ? 'border-blue-300 bg-blue-50/40' : ''} px-3 py-2.5`}>
        <div className="flex items-start gap-2.5">
          <span className="text-[22px] leading-none">🚚</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-extrabold">{x.trip_code} · <TruckNo n={x.vehicle_no} /></div>
            <div className="truncate text-[12px] font-semibold text-slate-600">{x.loading_point ?? '—'} → {x.unloading_location ?? '—'}</div>
            <div className="truncate text-[11.5px] font-semibold text-slate-500">
              {[x.product_type, Number.isFinite(Number(x.loaded_qty)) ? qty(x.loaded_qty) : null, x.loading_date ? `${t.loadedOn} ${dmy(x.loading_date)}` : null].filter(Boolean).join(' · ')}
            </div>
          </div>
          <Pill s={x.status} label={statusWord(x.status)} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ON_ROAD.has(x.status) && vis['cust.tracking'] && (
            <button onClick={() => setView({ k: 'track', code: x.trip_code })} className="min-h-[38px] rounded-full bg-blue-600 px-3 text-[12.5px] font-extrabold text-white">📍 {t.track}</button>
          )}
          <button onClick={() => setView({ k: 'trip', code: x.trip_code })} className="min-h-[38px] rounded-full border-2 border-slate-300 bg-white px-3 text-[12.5px] font-extrabold">{t.details}</button>
          {pod && <button onClick={() => setView({ k: 'podview', pod })} className="min-h-[38px] rounded-full bg-green-600 px-3 text-[12.5px] font-extrabold text-white">📄 {t.viewPod}</button>}
        </div>
      </div>
    );
  };

  // ── gates ─────────────────────────────────────────────────────────────────
  if (gate === 'loading') return <div className="grid min-h-screen place-items-center bg-[#f8fafc] text-[13px] text-slate-500" style={FONT}>{t.loading}</div>;
  if (gate !== 'ok') {
    return (
      <div className={SHELL} style={FONT}>
        <Bar title={t.brand} />
        <div className="grid flex-1 place-items-center px-8 text-center">
          <div>
            <div className="text-5xl">🏭</div>
            <h2 className="mt-3 text-[20px] font-extrabold">{gate === 'not_approved' ? t.notApproved : t.cantReach}</h2>
            <p className="mt-2 text-[13.5px] font-semibold text-slate-500">{gateMsg}</p>
            <a href={DISPATCH_TEL} className="mt-6 block rounded-2xl bg-slate-900 py-3 text-[16px] font-extrabold text-white">📞 {t.call}</a>
          </div>
        </div>
      </div>
    );
  }

  // ══ TRACK ═════════════════════════════════════════════════════════════════
  if (view.k === 'track') return <TrackScreen code={view.code} />;

  // ══ TRIP DETAIL ═══════════════════════════════════════════════════════════
  if (view.k === 'trip') {
    const x = tripByCode(view.code);
    const pod = podForTrip(view.code);
    return (
      <div className={SHELL} style={FONT} data-screen="tripdetail">
        <Bar title={view.code} sub={x ? `${x.loading_point ?? '—'} → ${x.unloading_location ?? '—'}` : ''} back={() => setView({ k: 'tabs' })} />
        <div className="flex flex-1 flex-col gap-2.5 px-3 pb-8 pt-3">
          {!x ? <div className={`${CARD} px-3 py-6 text-center text-[13px] font-semibold text-slate-500`}>{t.noTrips}</div> : (
            <>
              <div className={CARD}>
                <KV rows={[
                  [t.truck, <TruckNo n={x.vehicle_no} />],
                  [t.status, <Pill s={x.status} label={statusWord(x.status)} />],
                  [t.product, [x.product_type, Number.isFinite(Number(x.loaded_qty)) ? qty(x.loaded_qty) : null].filter(Boolean).join(' · ') || '—'],
                  x.challan_no ? [t.challan, x.challan_no] : null,
                  x.advice_no ? [t.advice, x.advice_no] : null,
                  [t.loadedOn, x.loading_date ? `${dmy(x.loading_date)} · ${x.loading_point ?? ''}` : '—'],
                  [DONE.has(x.status) ? t.tlDelivered : t.expected, x.unloading_date ? `${dmy(x.unloading_date)} · ${x.unloading_location ?? ''}` : (x.unloading_location ?? '—')],
                  Number.isFinite(Number(x.unloaded_qty)) ? [t.unloadedQ, qty(x.unloaded_qty)] : null,
                  Number.isFinite(Number(x.shortage_qty)) ? [t.shortage, qty(x.shortage_qty), Number(x.shortage_qty) > 0 ? 'text-red-600' : 'text-green-700'] : null,
                  [t.driver, showDriver && x.driver_name ? <span>{x.driver_name}{x.driver_mobile ? <a className="ml-1 text-blue-600" href={`tel:${x.driver_mobile}`}>☎</a> : null}</span> : <span className="text-slate-400">{t.viaOffice}</span>],
                  [t.freight, showFreight && x.freight_amount != null ? inr(x.freight_amount) : <span className="text-slate-400">{t.byContract}</span>],
                ]} />
              </div>
              {withheld.length > 0 && <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.hiddenNote}</div>}
              {ON_ROAD.has(x.status) && vis['cust.tracking'] && (
                <button onClick={() => setView({ k: 'track', code: x.trip_code })} className="min-h-[56px] rounded-2xl bg-blue-600 text-[17px] font-extrabold text-white shadow-[0_5px_0_rgba(0,0,0,0.18)]">📍 {t.track}</button>
              )}
              {pod && <button onClick={() => setView({ k: 'podview', pod })} className="min-h-[56px] rounded-2xl bg-green-600 text-[17px] font-extrabold text-white shadow-[0_5px_0_rgba(0,0,0,0.18)]">📄 {t.viewPod}</button>}
              <CallBar />
            </>
          )}
        </div>
      </div>
    );
  }

  // ══ POD VIEWER ════════════════════════════════════════════════════════════
  if (view.k === 'podview') {
    const p = view.pod;
    return (
      <div className={SHELL} style={FONT} data-screen="podview">
        <Bar title={`${t.podView} · ${p.ref}`} sub={`${p.destination ?? ''} · ${dmy(p.delivered_at)}${p.verified_at ? ` · ${t.verified} ${dmy(p.verified_at)}` : ''}`} back={() => setView({ k: 'tabs' })} />
        <div className="flex flex-1 flex-col gap-2.5 px-3 pb-8 pt-3">
          <PodImage p={p} />
          <div className={CARD}>
            <KV rows={[
              [t.truck, <TruckNo n={p.vehicle_no} />],
              [t.route, `${p.origin ?? '—'} → ${p.destination ?? '—'}`],
              [t.loadedUnloaded, `${Number.isFinite(Number(p.loaded_qty)) ? qty(p.loaded_qty) : '—'} / ${Number.isFinite(Number(p.unloaded_qty)) ? qty(p.unloaded_qty) : '—'}`],
              Number.isFinite(Number(p.shortage_qty)) ? [t.shortage, qty(p.shortage_qty), Number(p.shortage_qty) > 0 ? 'text-red-600' : 'text-green-700'] : null,
              p.challan_no ? [t.challan, p.challan_no] : null,
              [t.verified, dmyt(p.verified_at)],
            ]} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => openPodFile(p, true)} className="min-h-[50px] flex-1 rounded-2xl bg-blue-600 text-[15px] font-extrabold text-white">⬇ {t.save}</button>
            <button onClick={() => sharePod(p)} className="min-h-[50px] flex-1 rounded-2xl bg-green-600 text-[15px] font-extrabold text-white">📲 {t.share}</button>
          </div>
          <CallBar />
        </div>
      </div>
    );
  }

  // ══ NEW BOOKING ═══════════════════════════════════════════════════════════
  if (view.k === 'newbook') return <NewBooking />;
  if (view.k === 'sent') {
    return (
      <div className={`${SHELL} items-center justify-center bg-white px-6 text-center`} style={FONT} data-screen="booksent">
        <div className="grid h-[120px] w-[120px] place-items-center rounded-full bg-green-600 text-[76px] font-black text-white">✓</div>
        <h2 className="mt-4 text-[30px] font-extrabold">{t.sent}</h2>
        <p className="text-[16px] font-semibold text-slate-600">{t.sentSub(view.id)}</p>
        <span className="mt-3 rounded-full bg-amber-100 px-3 py-1.5 text-[12px] font-extrabold text-amber-800">{t.sentPill}</span>
        <p className="mt-4 text-[13.5px] text-slate-500">{t.sentNote}</p>
        <button onClick={() => { setTab('book'); setView({ k: 'tabs' }); }} className="mt-8 min-h-[60px] w-full rounded-2xl border-[3px] border-slate-300 bg-white text-[18px] font-extrabold">{t.seeBookings}</button>
        <button onClick={() => { setTab('home'); setView({ k: 'tabs' }); }} className="mt-3 min-h-[60px] w-full rounded-2xl bg-slate-900 text-[18px] font-extrabold text-white">{t.homeBtn}</button>
      </div>
    );
  }

  // ══ BOOKING DETAIL ════════════════════════════════════════════════════════
  if (view.k === 'booking') return <BookingDetail id={view.id} />;

  // ══ TABS ══════════════════════════════════════════════════════════════════
  const onRoad = trips.filter((x) => ON_ROAD.has(x.status));
  const doneTrips = trips.filter((x) => DONE.has(x.status));
  const segTrips = seg === 'ROAD' ? onRoad : seg === 'DONE' ? doneTrips : trips;
  const readyPods = pods.filter((p) => p.pod_status === 'READY');
  const waitPods = pods.filter((p) => p.pod_status !== 'READY');

  return (
    <div className={SHELL} style={FONT} data-screen={tab}>
      {tab === 'home' ? (
        <div className="sticky top-0 z-30 flex items-start gap-2 border-b border-slate-200 bg-white px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{t.brand}</div>
            <div className="truncate text-[18px] font-extrabold leading-tight">{me?.name ?? '—'}</div>
            <div className="truncate text-[11.5px] font-semibold text-slate-500">{[t.customer, me?.code, me?.city].filter(Boolean).join(' · ')}</div>
          </div>
          <button onClick={toggleLang} className="min-h-[38px] shrink-0 rounded-full bg-slate-100 px-3 text-[12px] font-bold">{lang === 'en' ? 'EN · हिं' : 'हिं · EN'}</button>
        </div>
      ) : (
        <Bar
          title={tab === 'trips' ? t.shipments : tab === 'book' ? t.bookTitle : tab === 'pod' ? t.podTitle : t.account}
          sub={tab === 'trips' ? `${onRoad.length} ${t.segRoad.toLowerCase()} · ${sum?.trips?.delivered_month ?? doneTrips.length} ${t.kDone} ${t.month}`
            : tab === 'book' ? t.bookSub
            : tab === 'pod' ? t.podSub
            : `${me?.name ?? ''} · ${t.readonly}`}
        />
      )}

      <div className="flex flex-1 flex-col gap-2.5 px-3 pb-28 pt-2.5">
        <PreviewNote />

        {/* ── HOME ─────────────────────────────────────────────────────── */}
        {tab === 'home' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className={`${CARD} px-1.5 py-2 text-center`}><div className="text-[21px] font-black text-blue-600">{sum?.trips?.on_road ?? onRoad.length}</div><div className="mt-0.5 text-[10px] font-bold text-slate-500">{t.kRoad}</div></div>
              <div className={`${CARD} px-1.5 py-2 text-center`}><div className="text-[21px] font-black text-green-700">{sum?.trips?.delivered_month ?? 0}</div><div className="mt-0.5 text-[10px] font-bold text-slate-500">{t.kDone} · {t.month}</div></div>
              <div className={`${CARD} px-1.5 py-2 text-center`}><div className="text-[21px] font-black text-amber-600">{sum?.pods?.awaited ?? 0}</div><div className="mt-0.5 text-[10px] font-bold text-slate-500">{t.kPod}</div></div>
            </div>

            <div className="flex items-center justify-between px-0.5 pt-1 text-[12.5px] font-extrabold text-slate-700">
              {t.todays}
              {trips.length > 0 && <button onClick={() => setTab('trips')} className="text-[12px] font-bold text-blue-600">{t.allN(trips.length)}</button>}
            </div>
            {(sum?.latest?.length ? sum.latest : onRoad.slice(0, 3)).map((x, i) => <TripRow key={x.trip_code ?? i} x={x} highlight={i === 0 && ON_ROAD.has(x.status)} />)}
            {!(sum?.latest?.length || onRoad.length) && (
              <div className={`${CARD} px-3 py-5 text-center`}><div className="text-3xl">🅿️</div><div className="mt-1 text-[14px] font-extrabold">{t.none}</div><div className="text-[12px] font-semibold text-slate-500">{t.noneSub}</div></div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Tile tone="bg-blue-500 text-white" icon="📍" label={t.tTrack} sub={`${sum?.trips?.on_road ?? onRoad.length} ${t.tTrackSub}`} onClick={() => { setTab('trips'); setSeg('ROAD'); }} />
              <Tile tone="bg-violet-500 text-white" icon="📋" label={t.tBook} sub={t.tBookSub} badge={sum?.bookings?.offers || null} onClick={() => setTab('book')} />
              <Tile tone="bg-green-600 text-white" icon="📄" label={t.tPod} sub={t.tPodSub} badge={sum?.pods?.awaited || null} onClick={() => setTab('pod')} />
              <Tile tone="bg-amber-400 text-[#241a00]" icon="🧾" label={t.tBills} sub={showLedger ? t.tBillsSub : t.ledgerLocked.slice(0, 28) + '…'} onClick={() => setTab('acct')} />
            </div>
            <CallBar />
          </>
        )}

        {/* ── TRIPS ────────────────────────────────────────────────────── */}
        {tab === 'trips' && (
          <>
            <Seg items={[['ROAD', `${t.segRoad} ${onRoad.length}`], ['DONE', `${t.segDone} ${doneTrips.length}`], ['ALL', t.segAll]]} value={seg} onChange={setSeg} />
            {segTrips.length === 0 && <div className={`${CARD} px-3 py-6 text-center text-[13px] font-semibold text-slate-500`}>{t.noTrips}</div>}
            {segTrips.map((x, i) => <TripRow key={x.trip_code ?? i} x={x} highlight={seg === 'ROAD' && i === 0} />)}
          </>
        )}

        {/* ── BOOKINGS ─────────────────────────────────────────────────── */}
        {tab === 'book' && (
          <>
            {!canOrder && (
              <div className={`${CARD} border-blue-200 bg-blue-50/60 px-3 py-3`}>
                <div className="text-[14.5px] font-extrabold text-blue-900">📬 {t.corpTitle}</div>
                <div className="mt-1 text-[12.5px] font-semibold leading-snug text-blue-900/80">{t.corpSub}</div>
              </div>
            )}
            {canOrder && loads.length === 0 && <div className={`${CARD} px-3 py-6 text-center text-[13px] font-semibold text-slate-500`}>{t.noBookings}</div>}
            {canOrder && loads.map((l) => {
              const n = bookStep(l.status);
              return (
                <button key={l.load_id} onClick={() => setView({ k: 'booking', id: l.load_id })} className={`${CARD} ${l.status === 'PENDING_REVIEW' ? 'border-amber-300' : l.pending_bids > 0 ? 'border-blue-300' : ''} px-3 py-2.5 text-left`}>
                  <div className="flex items-start gap-2.5">
                    <span className="text-[20px] leading-none">📋</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-extrabold">{l.load_id} · {l.origin} → {l.destination}</div>
                      <div className="truncate text-[11.5px] font-semibold text-slate-500">
                        {[l.material, l.weight ? `${l.weight} MT` : null, l.loading_date ? `${t.loadDate} ${dmy(l.loading_date)}` : null, l.awarded_to].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {l.status === 'CANCELLED' && <Pill s="CANCELLED" label={t.cancelled} />}
                  </div>
                  <Steps n={n} labels={t.steps} />
                  {l.status === 'PENDING_REVIEW' && <div className="mt-2 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11.5px] font-bold text-amber-900">⏳ {t.stReview}</div>}
                  {l.status === 'AWARD_REQUESTED' && <div className="mt-2 rounded-xl bg-blue-50 px-2.5 py-1.5 text-[11.5px] font-bold text-blue-900">🏁 {t.stAsked}</div>}
                  {l.status === 'OPEN' && l.pending_bids > 0 && <div className="mt-2 inline-block rounded-full bg-blue-600 px-3 py-1.5 text-[12px] font-extrabold text-white">{t.offersN(l.pending_bids)}</div>}
                </button>
              );
            })}
            {!canOrder && (doneTrips.length + onRoad.length === 0
              ? <div className={`${CARD} px-3 py-6 text-center text-[13px] font-semibold text-slate-500`}>{t.noTrips}</div>
              : trips.slice(0, 20).map((x, i) => <TripRow key={x.trip_code ?? i} x={x} />))}
          </>
        )}

        {/* ── POD ──────────────────────────────────────────────────────── */}
        {tab === 'pod' && (
          <>
            <Seg items={[['READY', `${t.segReady} ${readyPods.length}`], ['WAIT', `${t.segWait} ${waitPods.length}`]]} value={podSeg} onChange={setPodSeg} />
            {(podSeg === 'READY' ? readyPods : waitPods).length === 0 && <div className={`${CARD} px-3 py-6 text-center text-[13px] font-semibold text-slate-500`}>{t.noPods}</div>}
            {(podSeg === 'READY' ? readyPods : waitPods).map((p, i) => (
              <div key={`${p.ref}-${i}`} className={`${CARD} ${p.pod_status === 'READY' ? 'border-green-200' : 'border-amber-200'} px-3 py-2.5`}>
                <div className="flex items-start gap-2.5">
                  <span className="text-[22px] leading-none">{p.pod_status === 'READY' ? '📄' : '📭'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-extrabold">{p.ref} · <TruckNo n={p.vehicle_no} /></div>
                    <div className="truncate text-[12px] font-semibold text-slate-600">{p.origin ?? '—'} → {p.destination ?? '—'}</div>
                    <div className="truncate text-[11.5px] font-semibold text-slate-500">
                      {[dmy(p.delivered_at), Number.isFinite(Number(p.unloaded_qty ?? p.loaded_qty)) ? qty(p.unloaded_qty ?? p.loaded_qty) : null,
                        Number.isFinite(Number(p.shortage_qty)) && Number(p.shortage_qty) > 0 ? `${qty(p.shortage_qty)} ${t.shortage.toLowerCase()}` : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <Pill s={p.pod_status} label={p.pod_status === 'READY' ? t.podReady : p.pod_status === 'WITH_OFFICE' ? t.podOffice : t.podWait} />
                </div>
                {p.pod_status === 'READY' ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button onClick={() => setView({ k: 'podview', pod: p })} className="min-h-[38px] rounded-full bg-green-600 px-3 text-[12.5px] font-extrabold text-white">📄 {t.view}</button>
                    <button onClick={() => openPodFile(p, true)} className="min-h-[38px] rounded-full border-2 border-slate-300 bg-white px-3 text-[12.5px] font-extrabold">⬇ {t.save}</button>
                    <button onClick={() => sharePod(p)} className="min-h-[38px] rounded-full border-2 border-slate-300 bg-white px-3 text-[12.5px] font-extrabold">📲 {t.share}</button>
                  </div>
                ) : (
                  <div className="mt-2 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11.5px] font-bold leading-snug text-amber-900">⏳ {t.podPending}</div>
                )}
              </div>
            ))}
          </>
        )}

        {/* ── ACCOUNT ──────────────────────────────────────────────────── */}
        {tab === 'acct' && (
          <>
            {showLedger ? (
              <>
                <div className={CARD}>
                  <div className="flex items-center justify-between px-3 pt-2.5 text-[12.5px] font-extrabold text-slate-700">
                    {t.billsHead}<span className="text-[10.5px] font-semibold text-slate-500">{String(sum?.customer?.billing_cycle ?? '').replace('_', ' ')}</span>
                  </div>
                  <KV rows={[
                    [t.billed, inr(bills.reduce((s, b) => s + (Number(b.total_net) || 0), 0)), 'text-blue-700'],
                    [t.received, inr(bills.reduce((s, b) => s + (Number(b.received_amount) || 0), 0)), 'text-green-700'],
                    vis['cust.ledger.balance'] ? [t.outstanding, inr(me?.current_outstanding), 'text-red-600'] : null,
                  ]} />
                </div>
                <button onClick={openStatement} className="min-h-[50px] w-full rounded-2xl bg-blue-600 text-[15px] font-extrabold text-white">📄 {t.stmt}</button>
                <div className={CARD}>
                  <div className="px-3 pt-2.5 text-[12.5px] font-extrabold text-slate-700">{t.billsList}</div>
                  {bills.length === 0 && <div className="px-3 py-4 text-center text-[12.5px] font-semibold text-slate-500">{t.noBills}</div>}
                  {bills.slice(0, 12).map((b) => (
                    <div key={b.bill_no} className="flex items-center gap-2 border-t border-slate-100 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-extrabold">{b.bill_no}</div>
                        <div className="truncate text-[11px] font-semibold text-slate-500">{dmy(b.bill_date)}{b.location ? ` · ${b.location}` : ''}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[13px] font-extrabold">{inrShort(b.total_net)}</div>
                        <div className="text-[10.5px] font-bold text-slate-500">{b.status}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className={`${CARD} px-3 py-4 text-center`}>
                <div className="text-3xl">🔒</div>
                <div className="mt-1 text-[13px] font-semibold leading-snug text-slate-600">{t.ledgerLocked}</div>
              </div>
            )}
            <div className={CARD}>
              <KV rows={[
                [t.code, me?.code ?? '—'],
                [t.gst, me?.gst_no ?? '—'],
                [t.payTerms, me?.payment_terms ? `${me.payment_terms}` : '—'],
                [t.city, me?.city ?? '—'],
                [t.language, <button onClick={toggleLang} className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-extrabold">{lang === 'en' ? 'English · हिं' : 'हिंदी · EN'}</button>],
              ]} />
            </div>
            <CallBar />
            <button onClick={logout} className="min-h-[46px] rounded-2xl border-2 border-slate-300 bg-white text-[15px] font-extrabold">🚪 {t.logout}</button>
          </>
        )}
      </div>

      {tab === 'book' && canOrder && (
        <button onClick={() => setView({ k: 'newbook' })} className="fixed bottom-[76px] left-1/2 z-40 -translate-x-1/2 rounded-full bg-violet-600 px-5 py-3.5 text-[15px] font-extrabold text-white shadow-[0_6px_18px_rgba(109,40,217,0.45)]">
          ➕ {t.bookCta}
        </button>
      )}
      <Toast />
      <Nav />
    </div>
  );

  // ══ sub-screens (declared after the return so they close over state) ══════

  function openStatement() {
    (async () => {
      try {
        const r = await fetch(`${API}/api/v1/portal/customer/statement.pdf`, { headers: authHeaders() });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        openBlob(await r.blob(), null);
      } catch { say(t.openFail); }
    })();
  }

  function PodImage({ p }) {
    const [url, setUrl] = useState('');
    const [state, setState] = useState('loading');
    useEffect(() => {
      let dead = false; let obj = '';
      (async () => {
        if (!p.file_key) { setState('none'); return; }
        try {
          const blob = await fetchFile(p.file_key);
          if (dead) return;
          if (/pdf/i.test(blob.type)) { setState('pdf'); return; }
          obj = URL.createObjectURL(blob); setUrl(obj); setState('ok');
        } catch { if (!dead) setState('err'); }
      })();
      return () => { dead = true; if (obj) URL.revokeObjectURL(obj); };
    }, [p.file_key]);
    if (state === 'ok') return <img src={url} alt={`POD ${p.ref}`} className="w-full rounded-2xl border-2 border-slate-200 bg-white object-contain" style={{ maxHeight: '52vh' }} />;
    return (
      <button onClick={() => openPodFile(p)} className={`${CARD} grid min-h-[180px] place-items-center px-3 py-6 text-center`}>
        <div>
          <div className="text-5xl">{state === 'pdf' ? '📕' : state === 'loading' ? '⏳' : '📄'}</div>
          <div className="mt-2 text-[13px] font-extrabold">{state === 'err' ? t.openFail : state === 'loading' ? t.loading : t.view}</div>
        </div>
      </button>
    );
  }

  function TrackScreen({ code }) {
    const x = tripByCode(code);
    const [geo, setGeo] = useState(null);
    const [tk, setTk] = useState(null);
    const etaAt = useRef(0);

    useEffect(() => {
      let dead = false;
      (async () => {
        const r = await api(`/portal/customer/trips/${encodeURIComponent(code)}/route`);
        if (!dead && r.ok) setGeo(r.body);
      })();
      const poll = async () => {
        // ETA is a billed Google call, so ask for it on open and then at most
        // once every five minutes — the position itself is free and polls at 45 s.
        const wantEta = Date.now() - etaAt.current > 5 * 60_000;
        const r = await api(`/portal/customer/trips/${encodeURIComponent(code)}/tracking${wantEta ? '?eta=1' : ''}`);
        if (dead) return;
        if (r.ok) { if (wantEta) etaAt.current = Date.now(); setTk((prev) => (r.body.eta ? r.body : { ...r.body, eta: prev?.eta ?? null })); }
      };
      poll();
      const h = setInterval(poll, 45_000);
      return () => { dead = true; clearInterval(h); };
    }, [code]);

    const pos = tk?.position ?? null;
    const truck = pos && pos.lat != null ? { lat: Number(pos.lat), lng: Number(pos.lng), label: tk?.vehicle_no ?? '' } : null;
    const mapH = Math.max(240, Math.round((typeof window !== 'undefined' ? window.innerHeight : 700) * 0.44));

    return (
      <div className={SHELL} style={FONT} data-screen="track">
        <div className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2">
          <button onClick={() => setView({ k: 'tabs' })} className="min-h-[42px] rounded-full bg-slate-100 px-3.5 text-[16px] font-bold">‹</button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-extrabold leading-tight">{code} · <TruckNo n={x?.vehicle_no ?? tk?.vehicle_no} /></div>
            <div className="truncate text-[11.5px] font-semibold text-slate-500">{x ? `${x.loading_point ?? '—'} → ${x.unloading_location ?? '—'}` : ''}{x?.product_type ? ` · ${x.product_type}` : ''}</div>
          </div>
          {x && <Pill s={x.status} label={statusWord(x.status)} />}
        </div>

        <div className="relative bg-[#e8efe3]" style={{ height: mapH }}>
          <RouteMap light height={mapH} className="!rounded-none !border-0"
            origin={geo?.origin ?? null} destination={geo?.destination ?? null} truck={truck} polyline={geo?.route?.polyline ?? null} />
          <div className="pointer-events-none absolute left-2.5 right-2.5 top-2 z-[500] flex items-start justify-between gap-2">
            <div className="pointer-events-auto rounded-xl bg-white px-2.5 py-1.5 text-[11px] font-bold shadow-[0_4px_14px_rgba(0,0,0,0.22)]">
              {pos ? <>📡 {t.via}: <b>{SOURCE[pos.source] ?? pos.source}</b> · {ago(tk?.age_min)}</> : <>📡 {t.viaNone}</>}
            </div>
          </div>
          <div className="absolute bottom-2 left-2.5 right-2.5 z-[500]">
            <div className="rounded-xl bg-white px-2.5 py-1.5 text-[11px] leading-tight shadow-[0_4px_14px_rgba(0,0,0,0.22)]">
              {tk?.eta ? (
                <>
                  <b className="block text-[13.5px]">🕒 {t.eta} {hm(tk.eta.arrival_at)} · {tk.eta.remaining_km} {t.kmLeft}</b>
                  <span className="text-slate-500">{pos?.speed_kmh != null ? `${Math.round(pos.speed_kmh)} km/h · ` : ''}{geo?.route?.distance_km ? `${t.routeIs} ${geo.route.distance_km} km` : ''}</span>
                </>
              ) : (
                <>
                  <b className="block text-[13.5px]">{geo?.route?.distance_km ? `🛣 ${t.routeIs} ${geo.route.distance_km} km` : `🛣 ${t.routeIs} —`}{geo?.route?.duration_min ? ` · ${t.about} ${Math.floor(geo.route.duration_min / 60)}h ${geo.route.duration_min % 60}m` : ''}</b>
                  <span className="text-slate-500">{pos ? t.noEta : t.viaNoneSub}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2.5 px-3 pb-8 pt-3">
          <div className={`${CARD} px-3 py-3`}>
            {[
              x?.loading_date ? { on: true, title: `${t.tlLoaded} · ${x.loading_point ?? ''}`, sub: [dmy(x.loading_date), x.challan_no ? `${t.challan} ${x.challan_no}` : null, Number.isFinite(Number(x.loaded_qty)) ? qty(x.loaded_qty) : null].filter(Boolean).join(' · ') } : null,
              pos ? { now: true, title: `${t.tlSeen}${pos.checkpoint ? ` · ${pos.checkpoint}` : ''}`, sub: [dmyt(pos.recorded_at), SOURCE[pos.source] ?? pos.source, pos.speed_kmh != null ? `${Math.round(pos.speed_kmh)} km/h` : null].filter(Boolean).join(' · ') } : null,
              {
                on: !!x?.unloading_date,
                title: `${x?.unloading_location ?? t.tlDest}${x?.unloading_date ? ` · ${t.tlDelivered}` : ''}`,
                sub: x?.unloading_date ? dmy(x.unloading_date) : tk?.eta ? `${t.eta} ${hm(tk.eta.arrival_at)}` : t.noEta,
              },
            ].filter(Boolean).map((s, i) => (
              <div key={i} className="flex gap-2.5 py-1.5">
                <div className={`mt-1 h-[12px] w-[12px] shrink-0 rounded-full ${s.on ? 'bg-green-600' : s.now ? 'bg-blue-600 ring-4 ring-blue-200' : 'bg-slate-300'}`} />
                <div className="min-w-0"><div className="truncate text-[13.5px] font-extrabold">{s.title}</div><div className="truncate text-[11.5px] font-semibold text-slate-500">{s.sub}</div></div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <a href={DISPATCH_TEL} className="min-h-[50px] flex-1 rounded-2xl bg-slate-900 py-3.5 text-center text-[15px] font-extrabold text-white">📞 {t.call}</a>
            <button onClick={() => shareTrip(x ?? { trip_code: code, vehicle_no: tk?.vehicle_no, status: tk?.status }, tk)} className="min-h-[50px] flex-1 rounded-2xl border-2 border-slate-300 bg-white text-[15px] font-extrabold">📲 {t.share}</button>
          </div>
        </div>
      </div>
    );
  }

  function BookingDetail({ id }) {
    const load = loads.find((l) => l.load_id === id) ?? null;
    const [bids, setBids] = useState(null);
    const [stl, setStl] = useState(null);
    const [sending, setSending] = useState('');

    const refresh = useCallback(async () => {
      const [b, s] = await Promise.all([
        api(`/portal/customer/loads/${encodeURIComponent(id)}/bids`),
        api(`/portal/customer/loads/${encodeURIComponent(id)}/settlement`),
      ]);
      setBids(b.ok ? (b.body?.bids ?? []) : []);
      setStl(s.ok ? (s.body?.settlement ?? null) : null);
    }, [id]);
    useEffect(() => { refresh(); }, [refresh]);

    const accept = async (bid) => {
      setSending(bid.id);
      const r = await api(`/portal/customer/loads/${encodeURIComponent(id)}/accept-bid`, { method: 'POST', body: JSON.stringify({ bid_id: bid.id }) });
      setSending('');
      if (!r.ok) { say(r.body?.detail ?? r.body?.error ?? `HTTP ${r.status}`); return; }
      say(r.body?.detail ?? t.stAsked);
      const ld = await api('/portal/customer/loads');
      if (ld.ok) setLoads(ld.body?.loads ?? []);
      refresh();
    };

    const n = load ? bookStep(load.status) : 0;
    const canAccept = load?.status === 'OPEN' && !viewAs;
    return (
      <div className={SHELL} style={FONT} data-screen="bookdetail">
        <Bar title={`${id}${load ? ` · ${load.origin} → ${load.destination}` : ''}`} sub={load ? [load.material, load.weight ? `${load.weight} MT` : null, load.loading_date ? `${t.loadDate} ${dmy(load.loading_date)}` : null].filter(Boolean).join(' · ') : ''} back={() => setView({ k: 'tabs' })} />
        <div className="flex flex-1 flex-col gap-2.5 px-3 pb-8 pt-3">
          <div className={CARD}>
            <div className="px-3 pt-1"><Steps n={n} labels={t.steps} /></div>
            <KV rows={[
              [t.status, load ? (load.status === 'PENDING_REVIEW' ? t.stReview : load.status === 'OPEN' ? t.stOpen : load.status === 'AWARD_REQUESTED' ? t.stAsked : load.status === 'AWARDED' ? t.stAwarded : load.status === 'CANCELLED' ? t.stCancelled : t.stClosed) : '—'],
              load?.target_rate ? [t.target, inr(load.target_rate)] : null,
              load?.vehicle_type ? [t.vtype, load.vehicle_type] : null,
              load?.awarded_to ? [t.stAwarded, load.awarded_to] : null,
              stl?.vehicle_reg ? [t.truck, <TruckNo n={stl.vehicle_reg} />] : null,
              stl?.driver_name && showDriver ? [t.driver, stl.driver_name] : null,
              stl?.status ? [t.route, String(stl.status).replaceAll('_', ' ')] : null,
            ]} />
          </div>

          {load?.status !== 'AWARDED' && (
            <>
              <div className="px-0.5 text-[12.5px] font-extrabold text-slate-700">{t.offers} {bids?.length ? `(${bids.length})` : ''}</div>
              {bids === null && <div className={`${CARD} px-3 py-4 text-center text-[12.5px] font-semibold text-slate-500`}>{t.loading}</div>}
              {bids?.length === 0 && <div className={`${CARD} px-3 py-4 text-center text-[12.5px] font-semibold leading-snug text-slate-500`}>{t.noOffers}</div>}
              {bids?.map((b, i) => (
                <div key={b.id} className={`${CARD} ${i === 0 ? 'border-green-300' : ''} px-3 py-2.5`}>
                  <div className="flex items-center gap-2.5">
                    <span className="text-[20px]">{['🥇', '🥈', '🥉'][i] ?? '📦'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-extrabold">{b.vendor_name ?? `${t.offers} ${i + 1}`}</div>
                      <div className="truncate text-[11px] font-semibold text-slate-500">{[b.remarks, dmy(b.created_at)].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className={`text-[15px] font-black ${i === 0 ? 'text-green-700' : ''}`}>{inr(b.bid_amount)}</div>
                  </div>
                  {canAccept && b.status === 'PENDING' && (
                    <button onClick={() => accept(b)} disabled={!!sending} className="mt-2 min-h-[44px] w-full rounded-xl bg-green-600 text-[14px] font-extrabold text-white disabled:opacity-60">
                      {sending === b.id ? t.accepting : `✅ ${t.accept}`}
                    </button>
                  )}
                  {b.status === 'ACCEPTED' && <div className="mt-2 rounded-xl bg-green-50 px-2.5 py-1.5 text-[11.5px] font-bold text-green-800">✅ {t.stAwarded}</div>}
                </div>
              ))}
              <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.awardNote}</div>
            </>
          )}
          <CallBar />
        </div>
        <Toast />
      </div>
    );
  }

  function NewBooking() {
    const lanes = sum?.lanes ?? [];
    // busy/err are LOCAL here on purpose: they used to be the parent's, and a
    // parent re-render remounts this screen (it is declared inside the
    // component), which would wipe a half-typed form the moment Send was
    // pressed and the error came back.
    const [sendBusy, setSendBusy] = useState(false);
    const [sendErr, setSendErr] = useState('');
    const [f, setF] = useState(() => ({
      origin: lanes[0]?.loading_point ?? '', destination: lanes[0]?.unloading_location ?? '',
      material: '', weight: '', loading_date: today(), vehicle_type: '', target_rate: '',
    }));
    const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
    const MATERIALS = ['Cement', 'Steel', 'Tea', 'HSD', 'MS', 'Other'];
    const VTYPES = ['Open 10-wheel', 'Trailer', 'Container', 'Tanker'];
    const Lbl = ({ children }) => <div className="mb-1 text-[11px] font-extrabold text-slate-500">{children}</div>;
    const Inp = (props) => <input {...props} className={`min-h-[46px] w-full rounded-xl border-2 border-slate-300 bg-white px-3 text-[16px] font-bold outline-none focus:border-blue-500 ${props.className ?? ''}`} />;
    const Chip = ({ on, children, onClick }) => <button type="button" onClick={onClick} className={`min-h-[38px] rounded-full border-2 px-3 text-[13px] font-extrabold ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-800'}`}>{children}</button>;

    const send = async () => {
      setSendErr('');
      if (!f.origin.trim() || !f.destination.trim()) { setSendErr(t.needLane); return; }
      setSendBusy(true);
      const r = await api('/portal/customer/loads', {
        method: 'POST',
        body: JSON.stringify({
          origin: f.origin.trim(), destination: f.destination.trim(),
          material: f.material || null, weight: f.weight === '' ? null : Number(f.weight),
          loading_date: f.loading_date || null, vehicle_type: f.vehicle_type || null,
          target_rate: f.target_rate === '' ? null : Number(f.target_rate),
        }),
      });
      setSendBusy(false);
      if (!r.ok) { setSendErr(r.body?.detail ?? r.body?.error ?? `HTTP ${r.status}`); return; }
      const ld = await api('/portal/customer/loads');
      if (ld.ok) setLoads(ld.body?.loads ?? []);
      setView({ k: 'sent', id: r.body?.load?.load_id ?? '' });
    };

    return (
      <div className={SHELL} style={FONT} data-screen="newbook">
        <Bar title={t.newTitle} sub={t.newSub} back={() => setView({ k: 'tabs' })} />
        <div className="flex flex-1 flex-col gap-2.5 px-3 pb-8 pt-3">
          <div className={`${CARD} flex flex-col gap-2.5 px-3 py-3`}>
            {lanes.length > 0 && (
              <div>
                <Lbl>{t.lane}</Lbl>
                <div className="flex flex-wrap gap-1.5">
                  {lanes.map((l, i) => (
                    <Chip key={i} on={f.origin === l.loading_point && f.destination === l.unloading_location}
                      onClick={() => { set('origin', l.loading_point); set('destination', l.unloading_location); }}>
                      {l.loading_point} → {l.unloading_location}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div><Lbl>{t.fromLbl}</Lbl><Inp value={f.origin} onChange={(e) => set('origin', e.target.value)} placeholder="Guwahati" data-origin /></div>
              <div><Lbl>{t.toLbl}</Lbl><Inp value={f.destination} onChange={(e) => set('destination', e.target.value)} placeholder="Agartala" data-destination /></div>
            </div>
            <div>
              <Lbl>{t.material}</Lbl>
              <div className="flex flex-wrap gap-1.5">{MATERIALS.map((m) => <Chip key={m} on={f.material === m} onClick={() => set('material', m)}>{m}</Chip>)}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Lbl>{t.weight} (MT)</Lbl><Inp inputMode="decimal" value={f.weight} onChange={(e) => set('weight', e.target.value)} placeholder="25" /></div>
              <div><Lbl>{t.loadDate}</Lbl><Inp type="date" value={f.loading_date} onChange={(e) => set('loading_date', e.target.value)} /></div>
            </div>
            <div>
              <Lbl>{t.vtype}</Lbl>
              <div className="flex flex-wrap gap-1.5">{VTYPES.map((v) => <Chip key={v} on={f.vehicle_type === v} onClick={() => set('vehicle_type', v)}>{v}</Chip>)}</div>
            </div>
            <div><Lbl>{t.targetOpt}</Lbl><Inp inputMode="decimal" value={f.target_rate} onChange={(e) => set('target_rate', e.target.value)} placeholder={`₹ · ${t.perTrip}`} /></div>
          </div>
          <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.newNote}</div>
          {sendErr && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{sendErr}</div>}
          <button onClick={send} disabled={sendBusy || viewAs} className="min-h-[62px] rounded-2xl bg-violet-600 text-[19px] font-extrabold text-white shadow-[0_6px_0_rgba(0,0,0,0.18)] disabled:opacity-60" data-send>
            {sendBusy ? t.sending : `📤 ${t.sendOffice}`}
          </button>
        </div>
      </div>
    );
  }
}
