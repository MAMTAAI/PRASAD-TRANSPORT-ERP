// @ts-nocheck
// ============================================================================
// DRIVER APP v4 — map on top, live allowance under it, four buttons, a locker
//
// Approved by the owner on 2026-09-03 from docs/mockups/driver-app-mock-v4.html:
//   · top: the trip map (RouteMap — origin, destination, the lorry when a fix
//     exists) with the driver's name, lorry and a km/time chip floating on it;
//   · under it: TRIP ALLOWANCE & BALANCE — HSD target vs issued, cash target
//     vs paid; the balance turns BOLD RED the moment issued/paid passes the
//     target (the server reports the negative number; nothing is clamped);
//   · under that: a 2×2 grid — Loading Invoice · Unloading POD · Diesel Slip ·
//     Digital Locker — camera first, no typing anywhere; the office reads the
//     numbers off the photo (BHUVANESHWARI + Milan) and approves;
//   · Digital Locker: an approved paper has View + PDF; a rejected or missing
//     one has the camera; the office's reason shows on the card and as a
//     banner (driver_notices);
//   · market (hired) driver: map + Loading Invoice + Unloading POD only;
//   · one black bar calls the dispatch mobile.
//
// Hindi first, English under it; every tap target is a thumb-sized block.
// Session, uploads and GPS pings follow the same server contract as before:
// /portal/driver/* scoped by the session, POST /files for the photo, staged
// partner_documents rows, /tracking/ping throttled to 3 min or 500 m.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from './lib/apiBase';
import RouteMap from './lib/RouteMap';
import { uploadMedia } from './lib/uploadMedia';

const API = API_BASE;
const tok = () => localStorage.getItem('prasad_driver_token') || '';
const api = async (path: string, opts: RequestInit = {}) => {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${tok()}`, ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error, status: res.status });
  return json;
};

import { DISPATCH_TEL, DISPATCH_DISPLAY } from './lib/dispatchContact';
import { APP_SHELL } from './portal/appShell';
const LANG_KEY = 'prasad_driver_lang';

// ── words, Hindi first ──────────────────────────────────────────────────────
const T = {
  hi: {
    brand: 'प्रसाद ट्रांसपोर्ट', market: 'बाज़ार गाड़ी', noTrip: 'अभी कोई ट्रिप नहीं', noTripSub: 'ऑफिस नई ट्रिप देगा तो यहाँ दिखेगी',
    ledger: 'ट्रिप भत्ता · बैलेंस', hsd: 'डीज़ल (HSD)', cash: 'कैश', target: 'टारगेट', got: 'मिला', left: 'बाकी', over: 'टारगेट से', overSuffix: 'ज़्यादा', noTarget: 'टारगेट तय नहीं',
    loading: 'लोडिंग इनवॉइस', pod: 'अनलोडिंग पर्ची / POD', diesel: 'डीज़ल पर्ची', locker: 'डिजिटल लॉकर', call: 'डिस्पैच को कॉल करो',
    pending: 'बाकी', shoot: 'फोटो खींचो', frame: 'कागज़ को पीली चौखट के अंदर रखो', gallery: 'गैलरी', back: 'वापस', auto: 'अपने आप जुड़ेगा',
    clear: 'साफ़ दिख रहा है?', send: 'भेजो', retake: 'दोबारा खींचो', morePage: 'एक और पन्ना जोड़ो', sending: 'भेज रहे हैं…',
    sent: 'भेज दिया!', sentSub: 'ऑफिस चेक करके बताएगा', offline: 'नेटवर्क नहीं है? कोई बात नहीं — फोटो अपने आप बाद में चली जाएगी', ok: 'ठीक है',
    lockerSub: 'मंज़ूर कागज़ यहाँ PDF में मिलेंगे', view: 'देखो', pdf: 'PDF', sendPhoto: 'फोटो भेजो', resend: 'दोबारा भेजो', checking: 'ऑफिस देख रहा है', approved: 'मंज़ूर', missing: 'बाकी', expired: 'समय निकल गया',
    lockerNote: 'PDF पर ऑफिस की मुहर और तारीख रहती है — चेकपोस्ट पर दिखा सकते हो। कुछ टाइप नहीं करना।', validTill: 'वैध', officeSays: 'ऑफिस',
    approvedBy: 'ऑफिस से मंज़ूर', downloadPdf: 'PDF डाउनलोड करो', pinch: 'दो उंगली से बड़ा करो', queued: 'फोटो बाद में जाएगी', queuedN: 'फोटो भेजना बाकी',
    logout: 'बाहर निकलो', kmLeft: 'बाकी', hrs: 'घं', min: 'मि', near: 'के पास', noFix: 'लोकेशन नहीं मिली', gpsOn: 'GPS चालू',
    dl: 'ड्राइविंग लाइसेंस', aadhaar: 'आधार', bank: 'बैंक पासबुक', pan: 'PAN कार्ड', hzd: 'हज़ार्डस सर्टिफिकेट', front: 'आगे की तरफ',
  },
  en: {
    brand: 'Prasad Transport', market: 'Market vehicle', noTrip: 'No trip right now', noTripSub: 'It will show here when the office assigns one',
    ledger: 'Trip allowance · balance', hsd: 'Diesel (HSD)', cash: 'Cash', target: 'Target', got: 'Received', left: 'Balance', over: 'Over target by', overSuffix: '', noTarget: 'No target set',
    loading: 'Loading Invoice', pod: 'Unloading POD', diesel: 'Diesel Slip', locker: 'Digital Locker', call: 'Call dispatch',
    pending: 'pending', shoot: 'Take photo', frame: 'Keep the paper inside the yellow frame', gallery: 'Gallery', back: 'Back', auto: 'attached automatically',
    clear: 'Is it clear?', send: 'Send', retake: 'Retake', morePage: 'Add another page', sending: 'Sending…',
    sent: 'Sent!', sentSub: 'The office will check and tell you', offline: 'No network? No problem — the photo goes by itself later', ok: 'OK',
    lockerSub: 'Approved papers are here as PDF', view: 'View', pdf: 'PDF', sendPhoto: 'Send photo', resend: 'Send again', checking: 'Office is checking', approved: 'Approved', missing: 'Missing', expired: 'Expired',
    lockerNote: 'The PDF carries the office stamp and date — show it at a checkpost. Nothing to type.', validTill: 'Valid', officeSays: 'Office',
    approvedBy: 'Approved by the office', downloadPdf: 'Download PDF', pinch: 'Pinch to zoom', queued: 'Photo will go later', queuedN: 'photo(s) waiting to send',
    logout: 'Sign out', kmLeft: 'left', hrs: 'h', min: 'm', near: 'near', noFix: 'No location yet', gpsOn: 'GPS on',
    dl: 'Driving Licence', aadhaar: 'Aadhaar', bank: 'Bank passbook', pan: 'PAN card', hzd: 'Hazardous certificate', front: 'front side',
  },
};

// Which paper each button sends, and which locker slot it fills.
const PAPERS = {
  LOADING_INVOICE: { icon: '📄', key: 'loading', tone: 'bg-violet-600' },
  POD:             { icon: '📦', key: 'pod', tone: 'bg-green-600' },
  HSD_BILL:        { icon: '⛽', key: 'diesel', tone: 'bg-amber-500 text-[#1f1300]' },
  DL:              { icon: '🚗', key: 'dl' },
  AADHAAR:         { icon: '🆔', key: 'aadhaar' },
  BANK_BOOK:       { icon: '🏦', key: 'bank' },
  PAN:             { icon: '💳', key: 'pan' },
  HZD:             { icon: '☣️', key: 'hzd' },
};
const LOCKER_ORDER = ['DL', 'AADHAAR', 'BANK_BOOK', 'PAN', 'HZD'];

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const litres = (n) => `${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} L`;
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// Demo data for the staff preview (owner: "Staff Preview — demo data").
const DEMO = {
  OWN: {
    driver: { id: 'DEMO-OWN', name: 'राम कुमार', mobile: '9999999999', employed_by_owner_id: null },
    trips: [{ id: 'DEMO-TRIP', trip_code: 'PT00745', status: 'IN_TRANSIT', vehicle_no: 'BR 01 GX 4521', loading_point: 'Barauni', unloading_location: 'Ranchi' }],
    ledger: { trips: [{ trip_id: 'DEMO-TRIP', trip_code: 'PT00745', vehicle_no: 'BR 01 GX 4521', rtkm: 285,
      hsd: { target_l: 95, issued_l: 80, balance_l: 15, over: false }, cash: { target: 3000, paid: 3500, balance: -500, over: true } }] },
    locker: { market_driver: false, notices: [], papers: [
      { kind: 'DL', state: 'APPROVED', expiry: '2028-12-31', number: 'BR01 2019 0012345', view_url: null, pdf_url: null },
      { kind: 'AADHAAR', state: 'NEEDS_CORRECTION', reject_reason: 'फोटो धुंधली थी' },
      { kind: 'BANK_BOOK', state: 'APPROVED', number: '····4521' },
      { kind: 'PAN', state: 'MISSING' },
      { kind: 'HZD', state: 'APPROVED', expiry: '2026-09-12', days_left: 9 },
    ] },
    geo: { origin: { lat: 25.47, lng: 86.03, label: 'Barauni' }, destination: { lat: 23.36, lng: 85.33, label: 'Ranchi' }, route: { distance_km: 285, duration_min: 400 }, truck: { lat: 24.88, lng: 85.54, speed_kmh: 62 } },
  },
  MARKET: {
    driver: { id: 'DEMO-MKT', name: 'सुरेश यादव', mobile: '8888888888', employed_by_owner_id: 'x' },
    trips: [{ id: 'DEMO-TRIP-M', trip_code: 'PT00744', status: 'IN_TRANSIT', vehicle_no: 'JH 05 AB 9012', loading_point: 'Guwahati', unloading_location: 'Jorhat' }],
    ledger: { trips: [] },
    locker: { market_driver: true, notices: [], papers: [] },
    geo: { origin: { lat: 26.14, lng: 91.73, label: 'Guwahati' }, destination: { lat: 26.75, lng: 94.22, label: 'Jorhat' }, route: { distance_km: 305, duration_min: 420 }, truck: null },
  },
};

interface DriverPortalProps {
  onBack?: () => void;
  preview?: boolean;
  session?: { token: string; driver: any } | null;
}

export default function DriverPortal({ onBack, preview = false, session = null }: DriverPortalProps) {
  const [lang, setLang] = useState(() => (localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'hi'));
  const t = T[lang];
  const toggleLang = () => { const n = lang === 'hi' ? 'en' : 'hi'; setLang(n); try { localStorage.setItem(LANG_KEY, n); } catch { /* private mode */ } };

  const [driver, setDriver] = useState<any>(null);
  const [trips, setTrips] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any>(null);
  const [locker, setLocker] = useState<any>(null);
  const [geo, setGeo] = useState<any>(null);           // /maps/trip/:id/route
  const [currentLoc, setCurrentLoc] = useState<any>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [screen, setScreen] = useState<'HOME' | 'CAMERA' | 'CONFIRM' | 'SENT' | 'LOCKER' | 'VIEW'>('HOME');
  const [paper, setPaper] = useState<string | null>(null);   // doc_type being photographed
  const [origin, setOrigin] = useState<'HOME' | 'LOCKER'>('HOME');
  const [shots, setShots] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ file: File; doc_type: string; trip_id: string | null }[]>([]);
  const [viewPaper, setViewPaper] = useState<any>(null);
  const [demo, setDemo] = useState<null | 'OWN' | 'MARKET'>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(!preview);
  const watchIdRef = useRef<number | null>(null);
  const lastPingRef = useRef<any>(null);
  const camRef = useRef<HTMLInputElement | null>(null);
  const galRef = useRef<HTMLInputElement | null>(null);

  const isDemo = !!demo || String(driver?.id ?? '').startsWith('DEMO');
  const market = !!(locker?.market_driver ?? driver?.employed_by_owner_id);
  const trip = trips[0] ?? null;
  const led = ledger?.trips?.find((x) => x.trip_id === trip?.id) ?? ledger?.trips?.[0] ?? null;
  const lockerPending = (locker?.papers ?? []).filter((p) => ['MISSING', 'NEEDS_CORRECTION', 'EXPIRED'].includes(p.state)).length;

  const say = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2600); };

  // ── session ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (preview) { setLoadingSession(false); return; }
    if (session?.token && session?.driver) {
      try { localStorage.setItem('prasad_driver_token', session.token); localStorage.setItem('prasad_driver', JSON.stringify(session.driver)); } catch { /* private mode */ }
      setDriver(session.driver);
      setLoadingSession(false);
      return;
    }
    const saved = localStorage.getItem('prasad_driver');
    if (saved && tok()) {
      try { setDriver(JSON.parse(saved)); } catch { /* corrupt */ }
      setLoadingSession(false);
      return;
    }
    // THE WHATSAPP LOGIN LINK (Door 1, 1-Sep): https://…/driver?k=<token>. The
    // office mints it from Driver Master or the Driver Control drawer; tapping
    // it is the login. Claimed once, then the session lives on the phone.
    const k = new URLSearchParams(window.location.search).get('k');
    if (k) {
      (async () => {
        try {
          const res = await fetch(`${API}/api/v1/auth/driver/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: k }) });
          const r = await res.json().catch(() => ({}));
          if (res.ok && r.token && r.driver) {
            localStorage.setItem('prasad_driver_token', r.token);
            localStorage.setItem('prasad_driver', JSON.stringify(r.driver));
            setDriver(r.driver);
            window.history.replaceState({}, '', '/driver');
          } else {
            say(r.error === 'LINK_USED' || r.error === 'LINK_EXPIRED' ? 'यह लिंक पुराना है — ऑफिस से नया लिंक माँगो' : 'लिंक नहीं चला — ऑफिस से नया लिंक माँगो');
          }
        } catch { say('इंटरनेट नहीं है — दोबारा कोशिश करो'); }
        setLoadingSession(false);
      })();
      return;
    }
    setLoadingSession(false);
  }, [preview, session?.token]);

  const signOut = () => {
    try { localStorage.removeItem('prasad_driver_token'); localStorage.removeItem('prasad_driver'); } catch { /* private mode */ }
    if (watchIdRef.current !== null) navigator.geolocation?.clearWatch(watchIdRef.current);
    setDriver(null); setTrips([]); setLedger(null); setLocker(null); setDemo(null);
    onBack?.();
  };

  // ── data ──────────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!driver || isDemo) return;
    try {
      const [tr, lg, lk] = await Promise.all([
        api('/portal/driver/trips').catch((e) => { if (e.status === 401 || e.status === 403) throw e; return { trips: [] }; }),
        api('/portal/driver/ledger').catch(() => null),
        api('/portal/driver/locker').catch(() => null),
      ]);
      setTrips(tr.trips ?? []);
      if (lg) setLedger(lg);
      if (lk) setLocker(lk);
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) {
        say(e.code === 'PORTAL_NOT_APPROVED' ? 'ऑफिस ने अभी ऐप चालू नहीं किया' : 'दोबारा लॉगिन करो');
        if (e.status === 401) signOut();
      }
    }
  }, [driver?.id, isDemo]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // The ledger keeps itself fresh: every 30 s and whenever the app comes back
  // to the front. This is the "syncs instantly" the owner asked for — the
  // office issues, the phone shows it on the next tick.
  useEffect(() => {
    if (!driver || isDemo) return;
    const tick = () => api('/portal/driver/ledger').then(setLedger).catch(() => {});
    const iv = setInterval(tick, 30000);
    const vis = () => { if (document.visibilityState === 'visible') { tick(); api('/portal/driver/locker').then(setLocker).catch(() => {}); } };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', vis); };
  }, [driver?.id, isDemo]);

  // Route geometry for the map, once per trip.
  useEffect(() => {
    if (!trip || isDemo) return;
    api(`/maps/trip/${trip.id}/route`).then(setGeo).catch(() => setGeo(null));
  }, [trip?.id, isDemo]);

  // ── GPS (unchanged contract: 3 min or 500 m) ──────────────────────────────
  const metersBetween = (a, b) => {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  useEffect(() => {
    if (!trip || isTracking || !navigator.geolocation) return;
    setIsTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition((pos) => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      setCurrentLoc({ lat, lng, heading: pos.coords.heading ?? 0, speed: pos.coords.speed != null ? Math.max(0, pos.coords.speed * 3.6) : null });
      if (isDemo) return;
      const last = lastPingRef.current, now = Date.now();
      const due = !last || now - last.t >= 180000 || metersBetween(last, { lat, lng }) >= 500;
      if (!due) return;
      lastPingRef.current = { t: now, lat, lng };
      api('/tracking/ping', { method: 'POST', body: JSON.stringify({ trip_id: trip.id, source: 'DRIVER_APP', lat, lng, accuracy_m: pos.coords.accuracy ?? null, speed_kmh: pos.coords.speed != null ? Math.max(0, pos.coords.speed * 3.6) : null }) })
        .catch(() => { lastPingRef.current = last; });
    }, () => setIsTracking(false), { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 });
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; setIsTracking(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);

  // ── demo (staff preview) ──────────────────────────────────────────────────
  const startDemo = (kind: 'OWN' | 'MARKET') => {
    const d = DEMO[kind];
    setDemo(kind); setDriver(d.driver); setTrips(d.trips); setLedger(d.ledger); setLocker(d.locker); setGeo(d.geo); setScreen('HOME');
  };

  // ── camera flow ───────────────────────────────────────────────────────────
  const openCamera = (docType: string, from: 'HOME' | 'LOCKER' = 'HOME') => { setPaper(docType); setOrigin(from); setShots([]); setScreen('CAMERA'); };
  const onPick = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setShots((s) => [...s, f]); setScreen('CONFIRM');
  };
  const sendShots = async () => {
    if (!shots.length || !paper) return;
    if (isDemo) { setScreen('SENT'); return; }
    setBusy(true);
    const failed: any[] = [];
    for (const f of shots) {
      try {
        const up = await uploadMedia(f, `driver-docs/${paper.toLowerCase()}_${Date.now()}.jpg`);
        await api('/portal/driver/documents', { method: 'POST', body: JSON.stringify({ doc_type: paper, file_key: up.path, trip_id: trip?.id ?? null, remarks: `app v4 · ${paper}` }) });
      } catch (e) { failed.push({ file: f, doc_type: paper, trip_id: trip?.id ?? null }); }
    }
    setBusy(false);
    if (failed.length) setQueue((q) => [...q, ...failed]);
    setShots([]); setScreen('SENT');
    loadAll();
  };
  // Retry the offline queue when the network comes back.
  useEffect(() => {
    const flush = async () => {
      if (!queue.length || isDemo) return;
      const rest: any[] = [];
      for (const q of queue) {
        try {
          const up = await uploadMedia(q.file, `driver-docs/${q.doc_type.toLowerCase()}_${Date.now()}.jpg`);
          await api('/portal/driver/documents', { method: 'POST', body: JSON.stringify({ doc_type: q.doc_type, file_key: up.path, trip_id: q.trip_id, remarks: 'app v4 · queued' }) });
        } catch { rest.push(q); }
      }
      setQueue(rest);
      if (rest.length < queue.length) { say('✅ रुकी हुई फोटो चली गई'); loadAll(); }
    };
    window.addEventListener('online', flush);
    const iv = setInterval(flush, 60000);
    return () => { window.removeEventListener('online', flush); clearInterval(iv); };
  }, [queue, isDemo, loadAll]);

  const openPdf = async (p) => {
    if (isDemo || !p?.pdf_url) { say('📄 ' + (t.downloadPdf)); return; }
    try {
      const res = await fetch(`${API}${p.pdf_url}`, { headers: { Authorization: `Bearer ${tok()}` } });
      if (!res.ok) throw new Error('pdf');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = `${p.kind}.pdf`; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { say('❌ PDF नहीं बना — दोबारा कोशिश करो'); }
  };
  const dismissNotice = async (n) => {
    setLocker((l) => (l ? { ...l, notices: (l.notices ?? []).filter((x) => x.id !== n.id) } : l));
    if (!isDemo) api(`/portal/driver/notices/${n.id}/seen`, { method: 'POST', body: '{}' }).catch(() => {});
  };

  // ── derived map bits ──────────────────────────────────────────────────────
  const truck = currentLoc ? { lat: currentLoc.lat, lng: currentLoc.lng, heading: currentLoc.heading ?? 0, label: trip?.vehicle_no } : geo?.truck ? { lat: geo.truck.lat, lng: geo.truck.lng, heading: 0, label: trip?.vehicle_no } : null;
  const speed = currentLoc?.speed ?? geo?.truck?.speed_kmh ?? null;
  const km = geo?.route?.distance_km ?? led?.rtkm ?? null;
  const mins = geo?.route?.duration_min ?? null;

  // ── UI atoms ──────────────────────────────────────────────────────────────
  const Tile = ({ docType, tone, icon, label, sub, badge, onClick, big = false }) => (
    <button onClick={onClick} className={`relative flex flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-2 text-white shadow-[0_5px_0_rgba(0,0,0,0.18)] active:translate-y-1 active:shadow-none ${tone} ${big ? 'min-h-[128px]' : 'min-h-[86px]'}`} data-tile={docType}>
      <span className={big ? 'text-[44px] leading-none' : 'text-[30px] leading-none'}>{icon}</span>
      <span className={`mt-1 text-center font-extrabold leading-tight ${big ? 'text-[19px]' : 'text-[16px]'}`}>{label}</span>
      <span className={`font-semibold opacity-90 ${big ? 'text-[12px]' : 'text-[10.5px]'}`}>{sub}</span>
      {badge ? <span className="absolute right-2 top-2 rounded-full bg-red-500 px-2 py-0.5 text-[10.5px] font-extrabold text-white">{badge}</span> : null}
    </button>
  );
  const Bal = ({ line, unit }) => {
    if (!line || line.target == null && line.target_l == null) return <div className="min-w-[64px] text-right"><div className="text-[12px] font-bold text-slate-500">{t.noTarget}</div></div>;
    const bal = unit === 'L' ? line.balance_l : line.balance;
    const neg = bal < 0;
    const txt = unit === 'L' ? `${neg ? '-' : ''}${litres(Math.abs(bal))}` : `${neg ? '-' : ''}${inr(Math.abs(bal))}`;
    return (
      <div className="min-w-[64px] text-right">
        <div className={`text-[19px] font-black leading-none ${neg ? 'text-red-600' : 'text-green-700'}`}>{txt}</div>
        <div className="mt-0.5 text-[9.5px] font-bold text-slate-500">{t.left}</div>
      </div>
    );
  };
  const Bar = ({ frac, over }) => (
    <div className="mt-1 h-[5px] overflow-hidden rounded bg-slate-200"><i className={`block h-full ${over ? 'bg-red-600' : 'bg-green-600'}`} style={{ width: `${Math.min(100, Math.round((frac || 0) * 100))}%` }} /></div>
  );

  // ── screens ───────────────────────────────────────────────────────────────
  if (loadingSession) return <div className="grid min-h-screen place-items-center bg-[#f6f8fd] text-slate-500">…</div>;

  // Staff preview landing (demo data) or a driver with no session: the real
  // door is Gate 2 (/app). This landing only exists for the preview.
  if (!driver) {
    return (
      <div className="relative grid min-h-screen place-items-center bg-[#0a1024] p-6 text-center font-sans text-white">
        {onBack && <button onClick={onBack} className="absolute left-5 top-5 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[12px] font-bold text-slate-400">← Back</button>}
        <div className="w-full max-w-sm">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-[26px] bg-gradient-to-br from-emerald-500 to-teal-600 text-4xl shadow-[0_20px_40px_rgba(16,185,129,0.35)]">🚛</div>
          <h1 className="mt-4 text-3xl font-black">Driver App v4</h1>
          <p className="text-[13px] text-white/50">Secured by Prasad Transport</p>
          {preview ? (
            <div className="mt-8 space-y-3">
              <p className="text-[13px] font-bold text-white/70">👁️ Staff Preview — demo data</p>
              <button onClick={() => startDemo('OWN')} className="w-full rounded-2xl bg-blue-600 py-4 text-[17px] font-black">🏢 OWN DRIVER DEMO</button>
              <button onClick={() => startDemo('MARKET')} className="w-full rounded-2xl bg-orange-600 py-4 text-[17px] font-black">🚚 MARKET DRIVER DEMO</button>
            </div>
          ) : (
            <a href="/app" className="mt-8 block rounded-2xl bg-emerald-600 py-4 text-[17px] font-black">📱 Login → OTP</a>
          )}
        </div>
      </div>
    );
  }

  const shell = APP_SHELL;
  const font = { fontFamily: '"Segoe UI","Nirmala UI",system-ui,-apple-system,Roboto,sans-serif' };

  if (screen === 'CAMERA') {
    const P = PAPERS[paper] ?? { icon: '📷', key: 'loading' };
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-black text-white" style={font} data-screen="camera">
        <div className="flex items-center gap-3 px-4 pt-4">
          <button onClick={() => setScreen(origin)} className="rounded-full bg-white/10 px-4 py-2.5 text-[16px] font-bold">‹ {t.back}</button>
          <div className="min-w-0"><div className="text-[18px] font-extrabold leading-tight">{P.icon} {t[P.key]}</div><div className="text-[12px] font-semibold text-neutral-400">{trip?.vehicle_no ?? ''}{trip?.trip_code ? ` · ${trip.trip_code}` : ''} · {t.auto}</div></div>
        </div>
        <div className="mx-4 my-3 flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl bg-[radial-gradient(#3a3f4a,#15181f)]">
          <div className="grid h-[52vh] w-[70%] place-items-center rounded-xl border-[3px] border-dashed border-yellow-300"><span className="text-6xl opacity-60">{P.icon}</span></div>
          <p className="text-[15px] font-bold text-yellow-300">{t.frame}</p>
          {shots.length > 0 && <p className="text-[12px] font-semibold text-neutral-300">{shots.length} ✓</p>}
        </div>
        <div className="flex items-center justify-around pb-2 pt-1">
          <button onClick={() => galRef.current?.click()} className="text-[15px] font-bold text-neutral-200">🖼️ {t.gallery}</button>
          <button onClick={() => camRef.current?.click()} aria-label={t.shoot} className="h-[88px] w-[88px] rounded-full border-[6px] border-neutral-400 bg-white" data-shutter />
          <span className="w-16" />
        </div>
        <p className="pb-6 text-center text-[18px] font-extrabold">{t.shoot}</p>
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
        <input ref={galRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
      </div>
    );
  }

  if (screen === 'CONFIRM') {
    const last = shots[shots.length - 1];
    const url = last ? URL.createObjectURL(last) : null;
    return (
      <div className={shell} style={font} data-screen="confirm">
        <div className="flex items-center gap-3 bg-white px-4 py-3 text-[20px] font-extrabold"><button onClick={() => setScreen('CAMERA')} className="rounded-full bg-slate-100 px-4 py-2 text-[16px]">‹</button>{t.clear}</div>
        <div className="mx-5 my-2 grid flex-1 place-items-center overflow-hidden rounded-2xl bg-slate-200">{url && <img src={url} alt="" className="max-h-[52vh] max-w-full rounded shadow-lg" onLoad={() => URL.revokeObjectURL(url)} />}</div>
        <button onClick={sendShots} disabled={busy} className="mx-5 min-h-[76px] rounded-2xl bg-green-600 text-[24px] font-extrabold text-white shadow-[0_6px_0_rgba(0,0,0,0.18)] disabled:opacity-60" data-send>{busy ? t.sending : `✅ ${t.send}${shots.length > 1 ? ` (${shots.length})` : ''}`}</button>
        <button onClick={() => { setShots((s) => s.slice(0, -1)); setScreen('CAMERA'); }} className="mx-5 mt-2 min-h-[60px] rounded-2xl border-[3px] border-slate-300 bg-white text-[19px] font-extrabold">🔁 {t.retake}</button>
        <button onClick={() => setScreen('CAMERA')} className="py-3 text-[16px] font-bold text-blue-700">+ {t.morePage}</button>
      </div>
    );
  }

  if (screen === 'SENT') {
    return (
      <div className={`${shell} items-center justify-center bg-white px-6 text-center`} style={font} data-screen="sent">
        <div className="grid h-32 w-32 place-items-center rounded-full bg-green-600 text-[84px] font-black text-white shadow-[0_10px_30px_rgba(22,163,74,0.4)]">✓</div>
        <h2 className="mt-4 text-[34px] font-black">{t.sent}</h2>
        <p className="text-[18px] font-semibold text-slate-700">{t.sentSub}</p>
        <p className="mt-3 text-[14px] text-slate-500">{queue.length ? `⏳ ${queue.length} ${t.queuedN}` : t.offline}</p>
        <button onClick={() => setScreen(origin)} className="mt-8 min-h-[76px] w-full rounded-2xl bg-slate-900 text-[24px] font-extrabold text-white" data-ok>{t.ok}</button>
      </div>
    );
  }

  if (screen === 'VIEW' && viewPaper) {
    const P = PAPERS[viewPaper.kind];
    return (
      <div className={shell} style={font} data-screen="view">
        <div className="flex items-center gap-3 bg-white px-4 py-3 text-[20px] font-extrabold"><button onClick={() => setScreen('LOCKER')} className="rounded-full bg-slate-100 px-4 py-2 text-[16px]">‹</button>{P?.icon} {t[P?.key]}</div>
        <div className="mx-4 rounded-2xl border-2 border-green-300 bg-green-100 px-3 py-2.5 text-[15px] font-extrabold text-green-800">✅ {t.approvedBy}{viewPaper.expiry ? <span className="block text-[12px] font-semibold text-green-900/80">{t.validTill} {fmtDate(viewPaper.expiry)}</span> : null}{viewPaper.number ? <span className="block text-[12px] font-semibold text-green-900/80">{viewPaper.number}</span> : null}</div>
        <div className="mx-4 my-3 grid flex-1 place-items-center overflow-auto rounded-2xl bg-slate-200 p-3">
          {viewPaper.view_url && !isDemo ? <img src={viewPaper.view_url.startsWith('http') ? viewPaper.view_url : `${API}${viewPaper.view_url}`} alt="" className="max-w-full rounded shadow-lg" /> : <div className="h-44 w-72 rounded-xl bg-gradient-to-br from-[#fdf6e3] to-[#f5e7c4] shadow-lg" />}
          <p className="mt-2 text-[12px] font-semibold text-slate-500">🔍 {t.pinch}</p>
        </div>
        <button onClick={() => openPdf(viewPaper)} className="mx-5 min-h-[76px] rounded-2xl bg-blue-600 text-[24px] font-extrabold text-white shadow-[0_6px_0_rgba(0,0,0,0.18)]">⬇️ {t.downloadPdf}</button>
        <button onClick={() => setScreen('LOCKER')} className="mx-5 my-3 min-h-[60px] rounded-2xl border-[3px] border-slate-300 bg-white text-[19px] font-extrabold">{t.back}</button>
      </div>
    );
  }

  if (screen === 'LOCKER') {
    const papers = LOCKER_ORDER.map((k) => (locker?.papers ?? []).find((p) => p.kind === k) ?? { kind: k, state: 'MISSING' });
    return (
      <div className={shell} style={font} data-screen="locker">
        <div className="flex items-center gap-3 bg-white px-4 py-3"><button onClick={() => setScreen('HOME')} className="rounded-full bg-slate-100 px-4 py-2 text-[16px] font-bold">‹</button><div><div className="text-[20px] font-extrabold">📋 {t.locker}</div><div className="text-[12px] font-semibold text-slate-500">{t.lockerSub}</div></div></div>
        <div className="flex flex-col gap-2 px-4 pt-2">
          {papers.map((p) => {
            const P = PAPERS[p.kind];
            const bad = p.state === 'NEEDS_CORRECTION' || p.state === 'EXPIRED';
            const need = p.state === 'MISSING';
            const cls = bad ? 'border-red-300 bg-red-50' : need ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white';
            const pill = p.state === 'APPROVED' ? ['bg-green-100 text-green-800', `✅ ${t.approved}`] : p.state === 'PENDING' ? ['bg-amber-100 text-amber-800', `⏳ ${t.checking}`] : p.state === 'EXPIRED' ? ['bg-red-100 text-red-800', `❌ ${t.expired}`] : bad ? ['bg-red-100 text-red-800', t.resend] : ['bg-amber-100 text-amber-800', `📷 ${t.missing}`];
            return (
              <div key={p.kind} className={`flex flex-col gap-2 rounded-2xl border-2 px-3 py-2.5 ${cls}`} data-paper={p.kind}>
                <div className="flex items-center gap-2.5">
                  <span className="text-[30px] leading-none">{P.icon}</span>
                  <div className="min-w-0 flex-1"><div className="text-[17px] font-extrabold leading-tight">{t[P.key]}</div>
                    <div className="text-[12px] font-semibold text-slate-500">
                      {p.reject_reason ? `❌ ${t.officeSays}: ${p.reject_reason}`
                        : (p.state === 'APPROVED' || p.state === 'EXPIRED') && p.expiry ? `${t.validTill} ${fmtDate(p.expiry)}${p.days_left != null && p.days_left >= 0 && p.days_left <= 30 ? ` · ${p.days_left} din` : ''}`
                          : (p.state === 'APPROVED' || p.state === 'EXPIRED') && p.number && !/^MIGRATION/i.test(String(p.number)) ? p.number : ''}
                    </div></div>
                  <span className={`whitespace-nowrap rounded-full px-2.5 py-1.5 text-[12px] font-extrabold ${pill[0]}`}>{pill[1]}</span>
                </div>
                <div className="flex gap-2">
                  {p.state === 'APPROVED' || p.state === 'EXPIRED' ? (<>
                    <button onClick={() => { setViewPaper(p); setScreen('VIEW'); }} className="min-h-[46px] flex-1 rounded-xl border-2 border-slate-300 bg-white text-[16px] font-extrabold">👁️ {t.view}</button>
                    <button onClick={() => openPdf(p)} className="min-h-[46px] flex-1 rounded-xl bg-blue-600 text-[16px] font-extrabold text-white">⬇️ {t.pdf}</button>
                    {p.state === 'EXPIRED' && <button onClick={() => openCamera(p.kind, 'LOCKER')} className="min-h-[46px] flex-1 rounded-xl bg-red-600 text-[16px] font-extrabold text-white">📷</button>}
                  </>) : p.state === 'PENDING' ? (
                    <div className="min-h-[46px] flex-1 rounded-xl bg-slate-100 text-center text-[14px] font-bold leading-[46px] text-slate-500">⏳ {t.checking}</div>
                  ) : (
                    <button onClick={() => openCamera(p.kind, 'LOCKER')} className={`min-h-[46px] flex-1 rounded-xl text-[16px] font-extrabold text-white ${bad ? 'bg-red-600' : 'bg-amber-500 text-[#1f1300]'}`}>📷 {t.sendPhoto}{p.kind === 'AADHAAR' ? ` (${t.front})` : ''}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mx-4 mb-3 mt-auto rounded-2xl bg-blue-50 px-3 py-2.5 text-[13px] font-semibold leading-snug text-blue-900">🔒 {t.lockerNote}</div>
        <button onClick={signOut} className="pb-4 text-center text-[12px] font-bold text-slate-400">⏻ {t.logout}</button>
      </div>
    );
  }

  // ── HOME ──────────────────────────────────────────────────────────────────
  const hsdFrac = led?.hsd?.target_l ? led.hsd.issued_l / led.hsd.target_l : 0;
  const cashFrac = led?.cash?.target ? led.cash.paid / led.cash.target : 0;
  const notices = locker?.notices ?? [];
  return (
    <div className={shell} style={font} data-screen="home">
      {/* map */}
      <div className={`relative ${market ? 'h-[46vh]' : 'h-[36vh]'} min-h-[220px] bg-[#e8efe3]`}>
        <RouteMap light height={market ? Math.max(220, Math.round(window.innerHeight * 0.46)) : Math.max(220, Math.round(window.innerHeight * 0.36))} className="!rounded-none !border-0"
          origin={geo?.origin ?? null} destination={geo?.destination ?? null} truck={truck} polyline={geo?.route?.polyline ?? null} />
        <div className="pointer-events-none absolute left-2.5 right-2.5 top-2 z-[500] flex items-start justify-between">
          <div className="pointer-events-auto rounded-xl bg-white px-2.5 py-1.5 shadow-[0_4px_14px_rgba(0,0,0,0.22)]">
            <div className="text-[10px] font-bold text-slate-500">{market ? t.market : t.brand}</div>
            <div className="text-[17px] font-extrabold leading-tight">{driver.name}</div>
            {trip?.vehicle_no && <div className="mt-0.5 inline-block rounded-md border-2 border-amber-500 bg-amber-100 px-1.5 font-mono text-[12px] font-bold tracking-wider text-amber-900">{trip.vehicle_no}</div>}
          </div>
          <button onClick={toggleLang} className="pointer-events-auto min-h-[40px] rounded-full bg-white px-3 text-[12px] font-bold shadow-[0_4px_14px_rgba(0,0,0,0.22)]">{lang === 'hi' ? 'हिं · EN' : 'EN · हिं'}</button>
        </div>
        <div className="absolute bottom-2 left-2.5 right-2.5 z-[500] flex items-end gap-2">
          <div className="flex-1 rounded-xl bg-white px-2.5 py-1.5 text-[11px] leading-tight shadow-[0_4px_14px_rgba(0,0,0,0.22)]">
            {trip ? (<>
              <b className="block text-[13px]">🚚 {speed != null ? `${Math.round(speed)} km/h` : isTracking ? t.gpsOn : t.noFix}</b>
              <span className="text-slate-500">{trip.loading_point ?? ''} → {trip.unloading_location ?? trip.destination ?? ''}{km ? ` · ${km} km` : ''}{mins ? ` · ${Math.floor(mins / 60)}${t.hrs} ${mins % 60}${t.min}` : ''} · {trip.trip_code}</span>
            </>) : (<><b className="block text-[13px]">💤 {t.noTrip}</b><span className="text-slate-500">{t.noTripSub}</span></>)}
          </div>
        </div>
      </div>

      {/* notices */}
      {notices.slice(0, 2).map((n) => (
        <div key={n.id} className="mx-3 mt-2 flex items-start gap-2 rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2" data-notice>
          <span className="text-[18px]">📢</span>
          <div className="min-w-0 flex-1"><div className="text-[14px] font-extrabold text-red-800">{n.title}</div>{n.body && <div className="text-[12px] font-semibold text-red-900/80">{n.body}</div>}</div>
          <button onClick={() => dismissNotice(n)} className="text-[14px] font-black text-red-700">✕</button>
        </div>
      ))}

      {/* ledger */}
      {!market && (
        <div className="mx-3 mt-2 rounded-2xl border-2 border-slate-200 bg-white px-3 pb-1 pt-2" data-ledger>
          <div className="flex items-center justify-between text-[12.5px] font-extrabold text-slate-700">💰 {t.ledger}<span className="text-[10.5px] font-semibold text-slate-500">{led?.trip_code ?? ''}{led?.rtkm ? ` · ${led.rtkm} km` : ''}</span></div>
          <div className="grid grid-cols-[22px_1fr_auto] items-center gap-2 border-t border-slate-100 py-1.5">
            <span className="text-[18px]">⛽</span>
            <div><div className="text-[12.5px] font-extrabold leading-tight">{t.hsd}</div>
              <div className="text-[10.5px] font-semibold text-slate-500">{led?.hsd?.target_l != null ? `${t.target} ${litres(led.hsd.target_l)} · ${t.got} ${litres(led.hsd.issued_l)}` : `${t.got} ${litres(led?.hsd?.issued_l ?? 0)}`}</div>
              <Bar frac={hsdFrac} over={!!led?.hsd?.over} />
              {led?.hsd?.over && <div className="mt-0.5 text-[10px] font-extrabold text-red-600">{t.over} {litres(-led.hsd.balance_l)} {t.overSuffix}</div>}
            </div>
            <Bal line={led?.hsd ? { ...led.hsd, target: led.hsd.target_l } : null} unit="L" />
          </div>
          <div className="grid grid-cols-[22px_1fr_auto] items-center gap-2 border-t border-slate-100 py-1.5">
            <span className="text-[18px]">💵</span>
            <div><div className="text-[12.5px] font-extrabold leading-tight">{t.cash}</div>
              <div className="text-[10.5px] font-semibold text-slate-500">{led?.cash?.target != null ? `${t.target} ${inr(led.cash.target)} · ${t.got} ${inr(led.cash.paid)}` : `${t.got} ${inr(led?.cash?.paid ?? 0)}`}</div>
              <Bar frac={cashFrac} over={!!led?.cash?.over} />
              {led?.cash?.over && <div className="mt-0.5 text-[10px] font-extrabold text-red-600">{t.over} {inr(-led.cash.balance)} {t.overSuffix}</div>}
            </div>
            <Bal line={led?.cash ?? null} unit="₹" />
          </div>
        </div>
      )}

      {/* buttons */}
      <div className="flex flex-1 flex-col gap-2 px-3 pb-3 pt-2">
        <div className={`grid flex-1 gap-2 ${market ? 'grid-cols-2' : 'grid-cols-2'}`}>
          <Tile docType="LOADING_INVOICE" tone="bg-violet-600" icon="📄" label={t.loading} sub={T.en.loading === t.loading ? 'लोडिंग इनवॉइस' : 'Loading Invoice'} onClick={() => openCamera('LOADING_INVOICE')} big={market} />
          <Tile docType="POD" tone="bg-green-600" icon="📦" label={t.pod} sub={T.en.pod === t.pod ? 'अनलोडिंग पर्ची' : 'Unloading POD'} onClick={() => openCamera('POD')} big={market} />
          {!market && <Tile docType="HSD_BILL" tone="bg-amber-500 text-[#1f1300]" icon="⛽" label={t.diesel} sub={T.en.diesel === t.diesel ? 'डीज़ल पर्ची' : 'Diesel Slip'} onClick={() => openCamera('HSD_BILL')} />}
          {!market && <Tile docType="LOCKER" tone="bg-blue-600" icon="📋" label={t.locker} sub={T.en.locker === t.locker ? 'डिजिटल लॉकर' : 'Digital Locker'} badge={lockerPending ? `${lockerPending} ${t.pending}` : null} onClick={() => setScreen('LOCKER')} />}
        </div>
        {queue.length > 0 && <div className="rounded-xl bg-amber-100 px-3 py-1.5 text-center text-[12px] font-bold text-amber-900">⏳ {queue.length} {t.queuedN}</div>}
        {/* One tap → the phone's dialer with the dispatch desk's number filled in. */}
        <a href={DISPATCH_TEL} title={DISPATCH_DISPLAY}
          className="block min-h-[48px] rounded-2xl bg-slate-900 text-center text-[17px] font-extrabold leading-[48px] text-white" data-call>📞 {t.call}</a>
        {market && <button onClick={signOut} className="pt-1 text-center text-[12px] font-bold text-slate-400">⏻ {t.logout}</button>}
      </div>
      {toast && <div className="fixed bottom-24 left-1/2 z-[900] w-[88%] max-w-sm -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-3 text-center text-[15px] font-extrabold text-white shadow-2xl">{toast}</div>}
    </div>
  );
}
