// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import GlobalPagination, { usePagination } from './components/GlobalPagination';
import { round2, getTripFreight, getTripExpense, getTripAdvances } from './lib/accounting/tripMath';
import { sendWhatsApp, waResultText } from './lib/waSend';
import BottomSheet from './ui/BottomSheet';
import { useIsMobile } from './hooks/useIsMobile';

// 📊 Compact target-vs-used meter for trip cards (HSD / Cash)
function TripMeter({ label, used, target, unit, color }) {
  const pct = target > 0 ? Math.min(100, Math.round((used / target) * 100)) : 0;
  const over = target > 0 && used > target;
  return (
    <div style={{ flex: 1, minWidth: '130px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
        <span style={{ color: '#9aadd4', fontWeight: 'bold' }}>{label}</span>
        <span style={{ color: over ? '#ff6b81' : color, fontWeight: 'bold' }}>{unit === '₹' ? `₹${used.toLocaleString('en-IN')}/${target ? '₹' + target.toLocaleString('en-IN') : '—'}` : `${used}/${target || '—'} ${unit}`}</span>
      </div>
      <div style={{ height: '6px', borderRadius: '3px', background: '#18244a', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: over ? '#ef4444' : color, transition: 'width .3s' }} />
      </div>
    </div>
  );
}
import { getDrivingDistance } from './lib/maps';
import { placeOf, routeAppUrl } from './lib/tripPlaces';
import TripRouteMap from './lib/TripRouteMap';
import PlaceInput from './lib/PlaceInput';
import { legKindOf, tollTotals } from './lib/tollRoute.mjs';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const OPS = `${API}/api/v1/ops`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

// ── Field-name adapter ─────────────────────────────────────────────────────
// This screen's 900 lines of JSX, its Google-Maps route view and its LR print
// all read Firestore-era field names. Rewriting every reference would have meant
// touching presentation code that has nothing to do with the data layer, on the
// last file of the cluster — so the legacy names are mapped in exactly ONE place
// instead, right where rows enter the component.
//
// This is deliberate, visible debt: when the JSX is modernised, delete this
// function and the aliases go with it. Nothing else in the file depends on
// Firestore any more.
const withCompatFields = (t: any) => ({
  ...t,
  trip_status: t.status,                       // PG: status
  Trip_ID: t.trip_code,                        // PG: trip_code
  trip_id: t.trip_code,
  sort_date: t.loading_date,                   // PG orders on loading_date
  start_date: t.loading_date,
  gross_freight: t.freight_amount,             // PG: freight_amount
  driver_mobil_no: t.driver_mobile,            // PG: driver_mobile
  total_advances: Number(t.driver_advances ?? 0),
  shortage_amt: t.shortage_penalty,
});
import { scopeCurrent } from './lib/rbac';
import { logAudit } from './lib/audit';

// 🔥 SUPER MATCH FUNCTION
const checkMatch = (str1, str2) => {
  if(!str1 || !str2) return false;
  const s1 = String(str1).toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = String(str2).toLowerCase().replace(/[^a-z0-9]/g, '');
  return s1 === s2 || s1.includes(s2) || s2.includes(s1);
};

const getVal = (obj, keysArr) => {
  if(!obj) return '';
  const objKeys = Object.keys(obj);
  for(const k of keysArr) {
      const target = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      const found = objKeys.find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
      if(found && obj[found]) return obj[found];
  }
  return '';
};

// ── 🛣️ FASTag "last passed toll" helpers ────────────────────────────────
/** 'YYYY-MM-DD HH:mm:ss' (IST wall-clock from GTROPY) → "2 hrs ago". */
const timeAgo = (iso: any): string => {
  if (!iso) return '';
  const t = Date.parse(String(iso).replace(' ', 'T'));
  if (!Number.isFinite(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24); return `${d} day${d > 1 ? 's' : ''} ago`;
};
/** '2026-07-23 10:04:51' → '23-07-2026 10:04' for display. */
const fmtToll = (iso: any): string => {
  const s = String(iso || '').replace('T', ' ');
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ ]?(\d{2}:\d{2})?/);
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4] ? ' ' + m[4] : ''}` : (s || '—');
};
/** Normalize a TOLL_TRANSACTIONS doc → the compact shape the UI needs. */
const normalizeToll = (x: any) => ({
  plaza: x.plaza_name || x.Toll_Plaza_Name || x.Plaza || 'Toll Plaza',
  datetime: x.txn_datetime || x.txn_date || x.Txn_Date || '',
  // PG stores lng; the map helper below still reads `long`.
  lat: x.lat, long: x.lng ?? x.long,
  amount: Number(x.amount ?? x.Amount) || 0,
  ref: x.ref || x.txn_ref || x.Transaction_Ref || x.ext_txn_id || '',
  vehicle: x.vehicle_no || x.Vehicle_No || '',
});
/** True only when a toll carries usable map coordinates (strict null checks). */
const tollHasCoords = (toll: any) => {
  if (!toll) return false;
  const lat = Number(toll.lat), lng = Number(toll.long);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

// ── 🗺️ FASTag Route Map (Google Maps JS API) ────────────────────────────
// Renders the trip's origin→destination route + a distinct marker at the last
// FASTag toll crossing, auto-bounding to show both. Mounts only while its tab
// is active; the effect's cleanup removes every marker/renderer/listener so the
// map is torn down cleanly each time the modal (or tab) closes — no leaks.
// The FASTag tab used to carry its OWN Google map here — a second map, with a
// second dark theme, a second idea of where the lane was and its own
// DirectionsService call. Flipping between "Full Route Plan" and "FASTag Toll"
// tore the road down and rebuilt it, and the two tabs could disagree about the
// same trip. All four tabs now render one <TripRouteMap /> with different pins
// switched on. Deleted 4-Sep-2026 — see src/lib/TripRouteMap.tsx.

export default function TripManagment() {
  const { isMobile } = useIsMobile();
  const [activeTab, setActiveTab] = useState('ACTIVE'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [fuelVendors, setFuelVendors] = useState<any[]>([]); 
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);
  
  // 🌟 Global Search & History Filters
  const [globalSearch, setGlobalSearch] = useState('');
  // Debounced copy of the search text — filtering runs 250ms after typing
  // stops instead of on every keystroke over the full trips array.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(globalSearch), 250);
    return () => clearTimeout(t);
  }, [globalSearch]);
  const [historyFromDate, setHistoryFromDate] = useState('');
  const [historyToDate, setHistoryToDate] = useState('');

  // ✏️ Edit Trip State
  const [editingTripId, setEditingTripId] = useState('');

  const [formData, setFormData] = useState({
    trip_id: 'TRP-' + Math.floor(Math.random() * 90000 + 10000),
    vehicle_no: '', driver_name: '', driver_mobil_no: '', loading_point: '', consignee_name: '',
    customer_name: '', challan_no: '', start_date: new Date().toISOString().split('T')[0],
    gross_freight: '', rtkm: '', fixed_hsd: '', fixed_cash: '', toll_amt: '',
    operating_company: '',
    trip_status: 'IN_TRANSIT', billing_status: 'PENDING',
  });

  // 🗺️ Google Maps RTKM auto-calc (used when route is NOT in RTKM master)
  const [mapsCalc, setMapsCalc] = useState({ loading: false, error: '', info: '' });

  // 💰 Bulk freight setter — fills missing freight so Revenue flows (Phase 12).
  const [showFreightTool, setShowFreightTool] = useState(false);
  const [freightCust, setFreightCust] = useState('');
  const [freightRate, setFreightRate] = useState('');
  const [freightBusy, setFreightBusy] = useState(false);
  const tripCust = (t: any) => String(t.customer_name || t.Customer || t.Registered_Assessee || '').trim();
  const tripHasFreight = (t: any) => parseFloat(t.gross_freight || t.Gross_Freight || t.Rate || 0) > 0;
  const freightTargets = trips.filter(t => (!freightCust || tripCust(t) === freightCust) && !tripHasFreight(t));
  const applyBulkFreight = async () => {
    const rate = parseFloat(freightRate);
    if (!freightCust) return alert('⚠️ Customer chunein.');
    if (!(rate > 0)) return alert('⚠️ Valid freight ₹ daalein.');
    if (!freightTargets.length) return alert('Is customer ke saare trips mein freight already hai.');
    if (!window.confirm(`${freightTargets.length} trips (customer: ${freightCust}) mein freight ₹${rate} set karein? (sirf un trips mein jinme abhi freight nahi — add-only)`)) return;
    setFreightBusy(true);
    try {
      for (const t of freightTargets) {
        await fetchJson(`${OPS}/trips/${t.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ freight_amount: rate, freight_set_by: 'bulk_tool' }),
        });
      }
      logAudit({ action: 'FREIGHT_BULK_SET', target: freightCust, details: `₹${rate} × ${freightTargets.length} trips` });
      alert(`✅ ${freightTargets.length} trips mein freight ₹${rate} set ho gaya. Ab Accounts → Live Journal sync par Revenue flow karega.`);
      setShowFreightTool(false); setFreightCust(''); setFreightRate(''); fetchData();
    } catch (e) { alert('❌ Error: ' + (e?.message || 'failed')); }
    setFreightBusy(false);
  };

  const [showFuelModal, setShowFuelModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false); 
  const [showUnloadModal, setShowUnloadModal] = useState(false);
  const [showTrackModal, setShowTrackModal] = useState(false); 
  const [activeTrip, setActiveTrip] = useState<any>(null);

  const [paymentData, setPaymentData] = useState({ amount: '', mode: 'Office Cash', date: new Date().toISOString().split('T')[0], remarks: '' });
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingMemo, setSavingMemo] = useState(false);
  const [gpsRefreshing, setGpsRefreshing] = useState(false);
  
  const [memoData, setMemoData] = useState({ date: new Date().toISOString().split('T')[0], fixed_hsd: '', fixed_cash: '', hsd_issued: 0, cash_issued: 0, memo_no: '', driver_mobile: '' });
  
  const [pumps, setPumps] = useState([{ id: 1, vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }]);
  const [generatedMemos, setGeneratedMemos] = useState<any[]>([]); 
  const [unloadData, setUnloadData] = useState({ unloading_date: new Date().toISOString().split('T')[0], loaded_qty: '', unloaded_qty: '', shortage_qty: '', penalty_rate: '', shortage_penalty: '', unloading_location: '', remarks: '' });

  // Recompute shortage (Loaded − Unloaded) and penalty (Shortage × rate) on change.
  const recalcUnload = (patch: any) => {
    setUnloadData(prev => {
      const next = { ...prev, ...patch };
      const loaded = parseFloat(next.loaded_qty || '0');
      const unloaded = parseFloat(next.unloaded_qty || '0');
      const shortage = next.unloaded_qty !== '' ? Math.max(0, Math.round((loaded - unloaded) * 100) / 100) : '';
      next.shortage_qty = shortage === '' ? '' : String(shortage);
      // Auto penalty only when a rate is set; user may still override the field.
      if (patch.shortage_penalty === undefined) {
        const rate = parseFloat(next.penalty_rate || '0');
        next.shortage_penalty = (rate > 0 && shortage !== '') ? String(Math.round(Number(shortage) * rate)) : next.shortage_penalty;
      }
      return next;
    });
  };
  const [trackMode, setTrackMode] = useState('ROUTE');

  // 🛣️ FASTag "last passed toll" per active trip (list indicators + modal map).
  const [tollByTrip, setTollByTrip] = useState<Record<string, any>>({});
  const [tollLoaded, setTollLoaded] = useState(false);
  const [modalToll, setModalToll] = useState<any>(undefined); // undefined=loading, null=none

  // ── TOLL GATES ON THE ROUTE (owner, 4-Sep-2026) ──────────────────────────
  // The master is every gate this fleet has ever paid at, with the rate it was
  // charged. Fetched ONCE when the tracking sheet first opens — it is a few
  // hundred rows, it changes only when a new crossing lands, and re-fetching it
  // per trip would be a request per click for an answer that never differs.
  const [plazaMaster, setPlazaMaster] = useState<any[]>([]);
  const [plazaErr, setPlazaErr] = useState('');
  const [tripGates, setTripGates] = useState<any[]>([]);
  const [tollOpen, setTollOpen] = useState(false);
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({});
  const [savingRate, setSavingRate] = useState('');
  // What the operator has said about THIS trip, before it is saved.
  const [legOverride, setLegOverride] = useState<string | null>(null);

  /** Latest toll for ONE trip. Optimized: equality-only query (no composite
   *  index needed) on trip_db_id — a trip crosses a bounded set of plazas — then
   *  pick the max toll_reader time (txn_datetime) client-side. */
  const fetchLatestToll = async (tripDocId: string) => {
    if (!tripDocId) return null;
    try {
      const j = await fetchJson(`${OPS}/tolls/latest?trip_ids=${tripDocId}`);
      const r = j.tolls?.[tripDocId];
      return r ? normalizeToll(r) : null;
    } catch { return null; }
  };

  // One request for every active trip, newest-per-trip picked by the index. The
  // Firestore version fired a query per trip and sorted in the browser.
  const fetchLatestTolls = async (ids: string[]) => {
    if (!ids.length) return {};
    try {
      const j = await fetchJson(`${OPS}/tolls/latest?trip_ids=${ids.join(',')}`);
      const map: Record<string, any> = {};
      for (const [id, row] of Object.entries(j.tolls ?? {})) map[id] = normalizeToll(row);
      return map;
    } catch { return {}; }
  };

  useEffect(() => { fetchData(); }, []);

  // Lazy: nobody who never opens a map should pay for this call.
  useEffect(() => {
    if (!showTrackModal || plazaMaster.length || plazaErr) return;
    fetchJson(`${API}/api/v1/toll/plazas?located=true`)
      .then((j: any) => setPlazaMaster(j.plazas ?? []))
      // A missing master is not a broken map. The route, the pins and the
      // distance all still draw; only the toll strip goes quiet, and it says
      // why rather than showing ₹0 as though the lane were free.
      .catch((e: any) => setPlazaErr(e?.message || 'toll plaza master unavailable'));
  }, [showTrackModal, plazaMaster.length, plazaErr]);

  // Reset the per-trip toll view when the sheet moves to another lorry.
  useEffect(() => { setTripGates([]); setRateDraft({}); setLegOverride(null); }, [activeTrip?.id]);

  /** ROUND TRIP OR ONE SIDE — see legKindOf(). Oil-company work returns and is
   *  only complete on return, so its toll is paid twice; a market vehicle runs
   *  the owner's side once. The operator can override it on the sheet and what
   *  they choose is written to the trip. */
  const legKind = legOverride
    ?? (activeTrip ? legKindOf(activeTrip).kind : 'ROUND');
  const isRoundTrip = legKind === 'ROUND';

  const setLegKind = async (kind: string) => {
    setLegOverride(kind);
    if (!activeTrip?.id) return;
    try {
      await fetchJson(`${OPS}/trips/${activeTrip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_leg_kind: kind }),
      });
      setActiveTrip((t: any) => (t ? { ...t, trip_leg_kind: kind } : t));
      setTrips((all: any[]) => all.map((t) => (t.id === activeTrip.id ? { ...t, trip_leg_kind: kind } : t)));
    } catch (e: any) {
      // The map keeps the operator's choice either way — losing it because a
      // write failed would be worse than a total that is right on screen and
      // not yet saved.
      console.error('trip_leg_kind not saved:', e?.message);
    }
  };

  /** A gate whose rate nobody has ever paid, typed in by hand. It goes to the
   *  master, not to this trip — so the next trip down the same road already has
   *  it. That is the owner's "auto add kar le ... next time show ho". */
  const saveGateRate = async (gate: any) => {
    const raw = rateDraft[gate.name_key];
    const rate = Number(raw);
    if (!(rate > 0)) return alert('⚠️ Toll rate ek number hona chahiye (₹).');
    setSavingRate(gate.name_key);
    try {
      const j: any = await fetchJson(`${API}/api/v1/toll/plazas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plaza_name: gate.plaza_name,
          lat: gate.lat === null ? null : Number(gate.lat),
          lng: gate.lng === null ? null : Number(gate.lng),
          rate,
        }),
      });
      const saved = j.plaza;
      // Update the master in place so the map redraws with the new rate without
      // a round trip for the whole list.
      setPlazaMaster((m) => m.map((x) => (x.name_key === saved.name_key ? { ...x, ...saved } : x)));
      setRateDraft((d) => { const n = { ...d }; delete n[gate.name_key]; return n; });
    } catch (e: any) {
      alert(`❌ Rate save nahi hua.\n\n${e?.message || ''}`);
    }
    setSavingRate('');
  };

  // ── ARRIVING FROM THE DASHBOARD WITH A TRIP ALREADY CHOSEN ────────────────
  //
  // The Unloading Activity panel on Master Control lists pending trips
  // oldest-first, and its "Unload" button dispatches pt:navigate with
  // focusId = trip id. App.tsx puts that in the URL as ?focus=. This is the
  // half that reads it — nothing did until now, which is why the mechanism
  // was safe to dispatch but had no effect.
  //
  // IT OPENS THE SAME BOTTOM SHEET the Unload button on this screen opens,
  // from the same setUnloadData call. A second unloading form living on the
  // dashboard would be a second way to write the same closing entry, with its
  // own idea of how shortage and penalty are derived; this adds a DOOR to the
  // one that exists rather than another one beside it.
  //
  // The param is consumed once and cleared immediately, so a refresh — or a
  // Back into this screen — does not reopen a sheet the operator just
  // cancelled. A trip that is already closed only gets selected, not reopened:
  // arriving with a stale link must never look like an invitation to
  // double-enter an unloading.
  useEffect(() => {
    if (!trips.length) return;
    const url = new URL(window.location.href);
    const focus = url.searchParams.get('focus');
    if (!focus) return;
    url.searchParams.delete('focus');
    window.history.replaceState(null, '', url.toString());

    const t = trips.find((x: any) => String(x.id) === String(focus));
    if (!t) return;
    setActiveTrip(t);
    if (t.unloading_date || t.trip_status === 'COMPLETED') return;
    setUnloadData({
      unloading_date: new Date().toISOString().split('T')[0],
      loaded_qty: String(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || ''),
      unloaded_qty: '', shortage_qty: '', penalty_rate: '', shortage_penalty: '',
      unloading_location: t.consignee_name || t.Consignee_Name || '', remarks: '',
    });
    setShowUnloadModal(true);
  }, [trips]);

  // 🛣️ Bulk-load the last toll for every ACTIVE trip (keyed on the id set so
  // history pagination doesn't re-trigger it). Parallel single-trip queries.
  const activeTripIdKey = useMemo(
    () => trips.filter(t => t.trip_status !== 'COMPLETED' && t.trip_status !== 'ADVICE').map(t => t.id).sort().join(','),
    [trips]
  );
  useEffect(() => {
    const ids = activeTripIdKey ? activeTripIdKey.split(',') : [];
    if (!ids.length) { setTollByTrip({}); setTollLoaded(true); return; }
    let cancelled = false;
    setTollLoaded(false);
    (async () => {
      const map = await fetchLatestTolls(ids);
      if (cancelled) return;
      setTollByTrip(map);
      setTollLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [activeTripIdKey]);

  // 🗺️ Modal: resolve the active trip's last toll (reuse cache, else fetch).
  useEffect(() => {
    if (!showTrackModal || !activeTrip) { setModalToll(undefined); return; }
    if (tollByTrip[activeTrip.id]) { setModalToll(tollByTrip[activeTrip.id]); return; }
    let cancelled = false;
    setModalToll(undefined);
    fetchLatestToll(activeTrip.id).then(t => { if (!cancelled) setModalToll(t); });
    return () => { cancelled = true; };
  }, [showTrackModal, activeTrip?.id, tollByTrip]);

  // 📄 PAGINATED lifecycle queries (Phase B3): the old full-collection fetch
  // downloaded all 800+ completed trips on every mount/mutation. Active trips
  // load fully (small set); history loads HISTORY_PAGE at a time by OFFSET.
  const HISTORY_PAGE = 100;
  const historyOffset = React.useRef(0);
  const [err, setErr] = useState('');
  const [historyDone, setHistoryDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setErr('');
    try {
      // Active trips load in full (a small set); history is paginated by OFFSET.
      // The Firestore version needed a composite index and a '!=' filter that
      // silently dropped every trip whose status field was missing.
      const [m, active, hist] = await Promise.all([
        fetchJson(`${OPS}/masters`),
        fetchJson(`${OPS}/trips?exclude_status=COMPLETED,SETTLED,CANCELLED&limit=500`),
        fetchJson(`${OPS}/trips?status=COMPLETED&limit=${HISTORY_PAGE}&offset=0`),
      ]);
      historyOffset.current = (hist.trips ?? []).length;
      setHistoryDone(!hist.has_more);
      // RBAC scoping still applies: a branch-scoped role sees only its own trips.
      setTrips(scopeCurrent([...(active.trips ?? []), ...(hist.trips ?? [])].map(withCompatFields)));

      setVehicles(m.vehicles ?? []);
      setDrivers(m.drivers ?? []);
      setFuelVendors((m.vendors ?? []).filter((v: any) => /fuel|pump|petrol|diesel|hsd|oil/i.test(v.vendor_type ?? '')));
      setRtkmMaster(m.routes ?? []);
    } catch (e: any) {
      setErr(`Trips could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  };

  const loadMoreHistory = async () => {
    if (historyDone || loadingMore) return;
    setLoadingMore(true);
    try {
      const j = await fetchJson(`${OPS}/trips?status=COMPLETED&limit=${HISTORY_PAGE}&offset=${historyOffset.current}`);
      const more = (j.trips ?? []).map(withCompatFields);
      historyOffset.current += more.length;
      setHistoryDone(!j.has_more);
      setTrips((prev) => scopeCurrent([...prev, ...more.filter((mm: any) => !prev.some((pp: any) => pp.id === mm.id))]));
    } catch (e) { console.error(e); }
    setLoadingMore(false);
  };

  const handleConsigneeChange = (val: string) => {
    const master = findRoute(val);
    
    if (master) {
      setFormData({
        ...formData, 
        consignee_name: master.Consignee_Name || master.unloading_point || master.Destination || val, 
        loading_point: master.Depot_Link || master.loading_point || master.Origin || '', 
        customer_name: master.Registered_Assessee || master.customer_name || master.Customer || '',
        rtkm: master.RTKM_Distance || master.rtkm_distance || master.Distance || master.RTKM || '', 
        fixed_hsd: getVal(master, ['fixedhsdqty', 'fixedhsd', 'hsd', 'fuel']) || '', 
        fixed_cash: getVal(master, ['fixedcashamt', 'fixedcash', 'cash']) || '', 
        toll_amt: master.Toll_Amt || master.toll_amt || master.Toll || ''
      });
    } else {
      setFormData({ ...formData, consignee_name: val });
    }
  };

  // Median HSD-per-km and Cash-per-km derived from existing RTKM master rows
  // (robust to the many 0/blank entries). Used to estimate fixed HSD/Cash for
  // off-master routes calculated via Google Maps.
  const deriveRatesFromMaster = () => {
    const hsdRates: number[] = [];
    const cashRates: number[] = [];
    rtkmMaster.forEach(m => {
      const km = parseFloat(getVal(m, ['rtkmdistance', 'distance', 'rtkm']) || 0);
      const hsd = parseFloat(getVal(m, ['fixedhsdqty', 'fixedhsd', 'hsd']) || 0);
      const cash = parseFloat(getVal(m, ['fixedcashamt', 'fixedcash', 'cash']) || 0);
      if (km > 0 && hsd > 0) hsdRates.push(hsd / km);
      if (km > 0 && cash > 0) cashRates.push(cash / km);
    });
    const median = (arr: number[]) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    return { hsdPerKm: median(hsdRates), cashPerKm: median(cashRates) };
  };

  // 🗺️ Off-master fallback: compute RTKM via Google Maps (round-trip) and
  // derive editable Fix HSD / Fix Cash estimates from master medians.
  const calcRouteViaMaps = async () => {
    setMapsCalc({ loading: true, error: '', info: '' });
    try {
      const { roundTripKm, oneWayKm, durationText } = await getDrivingDistance(formData.loading_point, formData.consignee_name);
      const { hsdPerKm, cashPerKm } = deriveRatesFromMaster();
      const estHsd = hsdPerKm ? Math.round(roundTripKm * hsdPerKm) : '';
      const estCash = cashPerKm ? Math.round(roundTripKm * cashPerKm) : '';
      setFormData(prev => ({
        ...prev,
        rtkm: String(roundTripKm),
        fixed_hsd: estHsd === '' ? prev.fixed_hsd : String(estHsd),
        fixed_cash: estCash === '' ? prev.fixed_cash : String(estCash),
      }));
      setMapsCalc({ loading: false, error: '', info: `RTKM ${roundTripKm} km (one-way ${oneWayKm} km, ~${durationText}). HSD/Cash estimated — please verify.` });
    } catch (e: any) {
      setMapsCalc({ loading: false, error: e?.message || 'Could not calculate route', info: '' });
    }
  };

  // 💡 Suggest a customer's most recent freight rate from their past trips.
  const getLastCustomerRate = (cust: string) => {
    if (!cust || cust.trim().length < 2) return null;
    const matches = trips
      .filter(t => checkMatch(t.customer_name || t.Customer || t.Registered_Assessee, cust))
      .filter(t => parseFloat(t.gross_freight || t.Gross_Freight || t.Rate || 0) > 0);
    if (!matches.length) return null;
    matches.sort((a, b) => String(b.start_date || b.Loading_Date || '').localeCompare(String(a.start_date || a.Loading_Date || '')));
    const last = matches[0];
    return {
      rate: String(last.gross_freight || last.Gross_Freight || last.Rate),
      route: last.consignee_name || last.Consignee_Name || '',
    };
  };

  const handleVehicleChange = (vNo: string) => {
      const selectedVeh = vehicles.find(v => checkMatch(v.vehicle_no || v.vehical_no || v.registration_no, vNo));
      let dName = '';
      let dMob = '';
      if(selectedVeh) {
          dName = selectedVeh.driver_name || selectedVeh.assigned_pilot || '';
          dMob = selectedVeh.driver_mobile || selectedVeh.driver_mobil_no || selectedVeh.pilot_mobile || '';
      }
      
      if(dName && !dMob) {
         const drv = drivers.find(d => d.name === dName);
         if (drv) dMob = drv.mobile_no || drv.mobile || drv.phone || '';
      }

      // Operating company (and branch) follow the vehicle.
      const opCo = selectedVeh ? (selectedVeh.company_name || selectedVeh.owner_name || selectedVeh.operating_company || '') : '';

      setFormData({...formData, vehicle_no: vNo, driver_name: dName, driver_mobil_no: dMob, operating_company: opCo});

      // Non-blocking hint: an open advice exists — Loading Entry would attach
      // it automatically; a fresh trip here would run parallel to it.
      const adv = trips.find(t => t.trip_status === 'ADVICE' && checkMatch(t.vehicle_no || t.Vehical_No, vNo));
      if (adv) alert(`ℹ️ ${vNo} par open Loading Advice #${adv.advice_no || adv.trip_id} hai.\nBehtar: Loading Details se Loading Entry karein — advice auto-attach hogi (advances saath aayenge).\nYahan se naya trip banaya to advice alag hi rahegi.`);
  };

  const handleDriverSelect = (e: any) => {
      const dName = e.target.value;
      const selectedDriver = drivers.find(d => d.name === dName);
      setFormData(prev => ({
        ...prev, 
        driver_name: dName,
        driver_mobil_no: selectedDriver ? (selectedDriver.mobile_no || selectedDriver.mobile || selectedDriver.phone || '') : ''
      }));
  };

  const handleSaveTrip = async () => {
    if (!formData.vehicle_no || !formData.consignee_name) return alert('⚠️ Please fill Vehicle No and Consignee!');
    try {
      const veh = vehicles.find((v: any) => checkMatch(v.vehicle_no, formData.vehicle_no));
      const drv = drivers.find((d: any) => d.name === formData.driver_name);
      const body = {
        vehicle_id: veh?.id ?? null,
        vehicle_no: formData.vehicle_no,
        driver_id: drv?.id ?? null,
        driver_name: formData.driver_name || null,
        driver_mobile: formData.driver_mobil_no || null,
        loading_point: formData.loading_point || null,
        consignee_name: formData.consignee_name || null,
        customer_name: formData.customer_name || null,
        challan_no: formData.challan_no || null,
        loading_date: formData.start_date || new Date().toISOString().slice(0, 10),
        freight_amount: formData.gross_freight ? Number(formData.gross_freight) : null,
        rtkm: formData.rtkm ? Number(formData.rtkm) : null,
        fixed_hsd: formData.fixed_hsd ? Number(formData.fixed_hsd) : null,
        fixed_cash: formData.fixed_cash ? Number(formData.fixed_cash) : null,
        operating_company: formData.operating_company || null,
        status: formData.trip_status || 'IN_TRANSIT',
      };
      if (editingTripId) {
        await fetchJson(`${OPS}/trips/${editingTripId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        alert('✅ Trip updated.');
        setEditingTripId('');
      } else {
        // The LR code is minted server-side inside the insert transaction, so
        // two people starting a trip at once cannot collide on it.
        const out = await fetchJson(`${OPS}/trips`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        alert(`✅ New trip started.\n\nLR / Trip code: ${out.trip.trip_code}`);
      }
      setFormData({ trip_id: '', vehicle_no: '', driver_name: '', driver_mobil_no: '', loading_point: '', consignee_name: '', customer_name: '', challan_no: '', start_date: new Date().toISOString().split('T')[0], gross_freight: '', rtkm: '', fixed_hsd: '', fixed_cash: '', toll_amt: '', operating_company: '', trip_status: 'IN_TRANSIT', billing_status: 'PENDING' });
      setActiveTab('ACTIVE');
      fetchData();
    } catch (e: any) {
      const hint = { TRIP_BILLED: 'This trip is on a live bill — its figures are frozen.', BAD_STATUS: 'That status is not allowed.' }[e.code];
      alert(`❌ ${hint ?? 'Trip not saved.'}\n\n${e.message}`);
    }
  };

  const handleEditCompletedTrip = (t: any) => {
      setFormData({
        trip_id: t.trip_id || t.Trip_ID || '',
        vehicle_no: t.vehicle_no || t.Vehical_No || '',
        driver_name: t.driver_name || t.Driver_Name || '',
        driver_mobil_no: t.driver_mobil_no || t.Driver_Mobil_No || t.driver_mobile || '',
        loading_point: t.loading_point || t.Loading_Point || '',
        consignee_name: t.consignee_name || t.Consignee_Name || '',
        customer_name: t.customer_name || t.Customer || t.Registered_Assessee || '',
        challan_no: t.challan_no || t.Challan_No || '',
        start_date: t.start_date || t.Loading_Date || t.loading_date || new Date().toISOString().split('T')[0],
        gross_freight: t.gross_freight || t.Gross_Freight || '',
        rtkm: t.rtkm || t.RTKM || '',
        fixed_hsd: t.fixed_hsd || t.Fixed_HSD || '',
        fixed_cash: t.fixed_cash || t.Fixed_Cash || '',
        toll_amt: t.toll_amt || t.Toll_Amt || '',
        trip_status: t.trip_status || t.Trip_Status || 'COMPLETED',
        billing_status: t.billing_status || 'PENDING'
      });
      setEditingTripId(t.id);
      setActiveTab('NEW'); 
      window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
      setEditingTripId('');
      setFormData({ trip_id: 'TRP-' + Math.floor(Math.random() * 90000 + 10000), vehicle_no: '', driver_name: '', driver_mobil_no: '', loading_point: '', consignee_name: '', customer_name: '', challan_no: '', start_date: new Date().toISOString().split('T')[0], gross_freight: '', rtkm: '', fixed_hsd: '', fixed_cash: '', toll_amt: '', trip_status: 'IN_TRANSIT', billing_status: 'PENDING' });
      setActiveTab('COMPLETED');
  };

  // 📅 Fresh date on every open — the old inline open left whatever date the
  // last save (or a previous day's session) had in state.
  const openPaymentModal = (trip: any) => {
    setActiveTrip(trip);
    setPaymentData(prev => ({ ...prev, date: new Date().toISOString().split('T')[0] }));
    setShowPaymentModal(true);
  };

  const handleDriverPayment = async () => {
    if (!paymentData.amount || !activeTrip || savingPayment) return;
    const amt = round2(parseFloat(paymentData.amount));
    if (!Number.isFinite(amt) || amt <= 0) return alert('⚠️ Enter a valid amount!');
    if (!paymentData.date) return alert('⚠️ Pick a payment date.');
    setSavingPayment(true);
    try {
      // Cash to the driver is a recoverable ADVANCE in their khata, not a trip
      // expense. The endpoint writes the subsidiary row and moves the trip's own
      // cash column in one transaction, so a double-click cannot clobber either.
      await fetchJson(`${OPS}/trips/${activeTrip.id}/driver-txn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_type: 'PAYMENT_GIVEN', amount: amt, txn_date: paymentData.date,
          mode: paymentData.mode,
          remarks: `Trip: ${activeTrip.trip_code} - ${paymentData.remarks || 'advance'}`,
        }),
      });
      alert(`✅ ₹${amt} paid via ${paymentData.mode} and recorded in the driver's khata.`);
      setShowPaymentModal(false);
      setPaymentData({ amount: '', mode: 'Office Cash', date: new Date().toISOString().split('T')[0], remarks: '' });
      fetchData();
    } catch (e: any) {
      alert(`❌ ${e.code === 'NO_DRIVER' ? 'This trip has no driver assigned.' : 'Payment failed.'}\n\n${e.message}`);
    }
    setSavingPayment(false);
  };

  const openFuelModal = (trip: any) => {
    setActiveTrip(trip);
    const masterRoute = findRoute(trip.consignee_name || trip.Consignee_Name);
    
    let hsdTarget = parseFloat(getVal(trip, ['fixedhsd', 'fixedhsdqty'])) || 0;
    if (hsdTarget === 0) hsdTarget = parseFloat(getVal(masterRoute, ['fixedhsdqty', 'fixedhsd', 'hsd'])) || 0;

    let cashTarget = parseFloat(getVal(trip, ['fixedcash', 'fixedcashamt'])) || 0;
    if (cashTarget === 0) cashTarget = parseFloat(getVal(masterRoute, ['fixedcashamt', 'fixedcash', 'cash'])) || 0;

    const drvInfo = drivers.find(d => checkMatch(d.name || d.driver_name, trip.driver_name || trip.Driver_Name));
    const driverMob = getVal(drvInfo, ['mobileno', 'mobile', 'contact', 'phone']) || trip.driver_mobil_no || trip.Driver_Mobil_No || 'N/A';

    const hIssued = parseFloat(trip.hsd_issued || 0);
    const cIssued = parseFloat(trip.office_cash_paid || 0) + parseFloat(trip.bank_paid || 0) + parseFloat(trip.pump_cash_advance || 0);

    setMemoData({ 
      date: new Date().toISOString().split('T')[0], 
      fixed_hsd: hsdTarget, 
      fixed_cash: cashTarget, 
      hsd_issued: hIssued, 
      cash_issued: cIssued, 
      memo_no: `MEMO-${Math.floor(Math.random()*10000)}`, 
      driver_mobile: driverMob 
    });
    
    setPumps([{ id: 1, vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }]);
    setGeneratedMemos([]);
    setShowFuelModal(true);
  };

  const handlePumpChange = (id: number, field: string, value: string) => {
    setPumps(pumps.map(p => {
      if (p.id === id) {
        const newP = { ...p, [field]: value };
        if (field === 'vendor_id') {
          const ven = fuelVendors.find(v => v.id === value);
          newP.vendor_name = ven ? ven.vendor_name : '';
          newP.mobile = ven ? (ven.mobile_no || ven.phone || ven.mobile) : '';
        }
        if (field === 'qty' || field === 'rate') {
          newP.amount = (parseFloat(field === 'qty' ? value : newP.qty || '0') * parseFloat(field === 'rate' ? value : newP.rate || '0')).toFixed(2);
        }
        return newP;
      }
      return p;
    }));
  };

  const handleSaveFuelMemo = async () => {
    if (!activeTrip || savingMemo) return;
    const hasValidPump = pumps.some((p) => p.vendor_id && p.qty);
    if (!hasValidPump) return alert("⚠️ Select a petrol pump and enter litres.");
    if (!memoData.date) return alert('⚠️ Pick the transaction / issue date.');
    // Without a rate the diesel value saves as ₹0 and the HSD cost silently
    // vanishes from settlement, so the rate is mandatory.
    if (pumps.find((p) => p.vendor_id && p.qty && !(parseFloat(p.rate) > 0))) {
      return alert('⚠️ Enter the rate (₹/litre) on every pump row.');
    }

    setSavingMemo(true);
    try {
      const savedSlips = [];
      const failures = [];
      for (const pump of pumps) {
        if (!pump.vendor_id || !pump.qty) continue;
        const qty = parseFloat(pump.qty);
        const rate = parseFloat(pump.rate);
        const cashAmt = round2(parseFloat(pump.cash_advance || '0') || 0);
        try {
          const out = await fetchJson(`${OPS}/trips/${activeTrip.id}/fuel-slip`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vendor_id: pump.vendor_id,
              memo_no: memoData.memo_no || null,
              entry_date: memoData.date,
              fuel_type: pump.fuel_type,
              liters: qty,
              rate,
              amount: round2(qty * rate),
              cash_given_to_pump: cashAmt,
              pump_mobile: pump.mobile || null,
            }),
          });
          // Shaped for sendFuelMemoWhatsApp, which reads the slip it is handed.
          savedSlips.push({
            ...out.fuel_entry,
            date: out.fuel_entry.entry_date,
            trip_id: activeTrip.trip_code,
            route_name: `${activeTrip.loading_point ?? '?'} To ${activeTrip.consignee_name ?? '?'}`,
            pump_mobile: pump.mobile,
            vendor_name: pump.vendor_name,
          });
        } catch (e: any) {
          // Each slip is posted on its own, so one bad row cannot discard the
          // others — the server's guards are reported per pump instead.
          const hint = { SLIP_ARITHMETIC: 'amount does not match litres × rate', DUPLICATE_MEMO: 'this memo is already recorded for that pump' }[e.code];
          failures.push(`${pump.vendor_name || 'pump'}: ${hint ?? e.message}`);
        }
      }
      // Fixed targets are trip fields, not slip fields.
      if (memoData.fixed_hsd !== '' || memoData.fixed_cash !== '') {
        await fetchJson(`${OPS}/trips/${activeTrip.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fixed_hsd: memoData.fixed_hsd === '' ? null : Number(memoData.fixed_hsd),
            fixed_cash: memoData.fixed_cash === '' ? null : Number(memoData.fixed_cash),
          }),
        }).catch(() => {});
      }
      if (failures.length) {
        alert(`⚠️ ${savedSlips.length} slip(s) saved, ${failures.length} refused:\n\n${failures.join('\n')}`);
      }
      setGeneratedMemos(savedSlips);
      fetchData();
    } catch (e: any) {
      alert(`❌ Fuel memo not saved.\n\n${e.message}`);
    }
    setSavingMemo(false);
  };

  const sendFuelMemoWhatsApp = async (slip: any) => {
    if (!slip.pump_mobile) return alert("⚠️ Mobile not found for this Pump!");
    const message = `*⛽ FUEL MEMO ALERT* \n\nDear ${slip.vendor_name},\n\n🚛 *Vehicle No:* ${slip.vehicle_no}\n👤 *Driver:* ${slip.driver_name || 'N/A'}\n📍 *Route:* ${slip.route_name}\n\n💧 *Quantity:* ${slip.liters} Liters (${slip.fuel_type})\n💵 *Cash Adv:* ₹${slip.cash_given_to_pump || 0}\n📅 *Date:* ${slip.date}`;
    // 💬 Dual-mode: PRASAD PRO auto-send (footprint logged) → wa.me deep link fallback
    const r = await sendWhatsApp({ phone: slip.pump_mobile, message, tripId: slip.trip_id });
    alert(waResultText(r));
  };

  // 📡 Re-read this trip's doc so the Live GPS view shows the freshest ping
  const refreshLiveLocation = async () => {
    if (!activeTrip?.id || gpsRefreshing) return;
    setGpsRefreshing(true);
    try {
      const j = await fetchJson(`${OPS}/trips/${activeTrip.id}`);
      if (j.trip) setActiveTrip(withCompatFields(j.trip));
    } catch (e) { console.error(e); }
    setGpsRefreshing(false);
  };

  const gpsAgeMinutes = (loc: any): number | null => {
    if (!loc?.lastUpdated) return null;
    const t = new Date(loc.lastUpdated).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  };

  const requestLiveLocation = () => {
      if(!activeTrip) return;
      const dMobile = activeTrip.driver_mobil_no || activeTrip.Driver_Mobil_No || memoData.driver_mobile;
      if (!dMobile || dMobile === 'N/A') return alert("⚠️ Driver mobile number not found!");
      const message = `📍 *LIVE LOCATION REQUIRED*\n\nDear ${activeTrip.driver_name || activeTrip.Driver_Name || 'Driver'},\n\nPlease share your *Live Location* on WhatsApp immediately for tracking Trip: ${activeTrip.trip_id || activeTrip.Trip_ID} (${activeTrip.vehicle_no || activeTrip.Vehical_No}).\n\n- Control Room, Prasad Transport`;
      sendWhatsApp({ phone: dMobile, message, tripId: activeTrip.trip_id || activeTrip.Trip_ID, role: 'Driver' }).then(r => alert(waResultText(r)));
  };

  const handleCompleteTrip = async () => {
    if (!activeTrip) return;
    try {
      const gross = getTripFreight(activeTrip);
      const expenses = getTripExpense(activeTrip);
      const advances = getTripAdvances(activeTrip);
      const penalty = round2(parseFloat(unloadData.shortage_penalty || '0') || 0);
      const finalBal = round2(gross - expenses - penalty);
      const unloadDate = unloadData.unloading_date || new Date().toISOString().slice(0, 10);

      // One call closes the trip: the server recomputes the shortage from the two
      // quantities (never trusting the browser with a figure a driver is charged
      // for), stamps approval, debits the driver's khata and posts the matching
      // ledger journal — the leg the Firestore version never wrote.
      const out = await fetchJson(`${OPS}/trips/${activeTrip.id}/unload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unloading_date: unloadDate,
          unloading_location: unloadData.unloading_location || null,
          unloaded_qty: Number(unloadData.unloaded_qty || 0),
          shortage_penalty: penalty,
          unloading_remarks: unloadData.remarks || null,
          complete: true,
          recover_from_driver: penalty > 0,
        }),
      });
      const rec = out.driver_recovery;
      alert(`✅ Trip completed.\n\n`
        + `💰 Settlement (freight − kharcha − penalty): ₹${finalBal.toLocaleString('en-IN')}\n`
        + `🤝 Driver advances outstanding: ₹${advances.toLocaleString('en-IN')}\n`
        + `📉 Shortage ${out.shortage_qty}${penalty > 0 ? ` · penalty ₹${penalty.toLocaleString('en-IN')}` : ''}\n`
        + (rec
          ? rec.already_posted
            ? `💸 Already debited to ${rec.driver}'s khata.\n`
            : rec.ledger_note
              ? `💸 ₹${rec.amount} debited to ${rec.driver}'s khata.\n⚠️ Ledger: ${rec.ledger_note}\n`
              : `💸 ₹${rec.amount} debited to ${rec.driver}'s khata and posted to the ledger.\n`
          : '')
        + `\n🧾 The trip now appears in Bill Management → Pending Billing.`);
      setShowUnloadModal(false);
      fetchData();
    } catch (e: any) {
      alert(`❌ ${e.code === 'TRIP_SETTLED' ? 'This trip is already settled.' : 'Could not complete the trip.'}\n\n${e.message}`);
    }
  };

  // 🗺️ Cached route lookup: rtkmMaster fuzzy-match ran regex-normalization
  // per table row per render; results are now cached per consignee name.
  const routeCache = useMemo(() => new Map(), [rtkmMaster]);
  const findRoute = (name: any) => {
    const key = String(name || '').toLowerCase();
    if (routeCache.has(key)) return routeCache.get(key);
    const hit = rtkmMaster.find(m => checkMatch(m.Consignee_Name || m.unloading_point || m.Destination, name)) || {};
    routeCache.set(key, hit);
    return hit;
  };

  // 📏 Trip ka RTKM: pehle trip ki apni value, warna Route & RTKM master se
  // (consignee match). Live Tracking + History dono me route ke saath dikhta hai.
  const tripRtkm = (t: any) => {
    const own = parseFloat(t.rtkm || t.RTKM || 0) || 0;
    if (own > 0) return own;
    const r = findRoute(t.consignee_name || t.Consignee_Name);
    return parseFloat(r?.RTKM_Distance || r?.rtkm_distance || 0) || 0;
  };
  const RtkmBadge = ({ t }: any) => {
    const km = tripRtkm(t);
    return km > 0 ? <span style={{ color: '#ffb224', fontWeight: 'bold', fontSize: '11px' }}> · 📏 {km} km</span> : null;
  };

  // 🛣️ Last-passed-toll indicator for the Live Tracking list (card + table).
  const LastTollBadge = ({ tripId }: { tripId: string }) => {
    if (!tollLoaded) return <div style={{ fontSize: '11px', color: '#5d7196', marginTop: '4px' }}>🛣️ checking tolls…</div>;
    const toll = tollByTrip[tripId];
    if (!toll) return <div style={{ fontSize: '11px', color: '#5d7196', marginTop: '4px' }}>🛣️ No tolls crossed yet</div>;
    return (
      <div style={{ fontSize: '11px', marginTop: '4px', fontWeight: 'bold' }} title={`Crossed at ${fmtToll(toll.datetime)}`}>
        🛣️ <span style={{ color: '#9aadd4' }}>Last Toll:</span> <span style={{ color: '#fbbf24' }}>{toll.plaza}</span>
        <span style={{ color: '#9aadd4', fontWeight: 'normal' }}> · {timeAgo(toll.datetime) || 'recently'}</span>
      </div>
    );
  };

  // 🔥 FILTER LOGIC FOR TRIPS — memoized; recomputes only when trips or the
  // (debounced) filters change, not on every keystroke/modal state change.
  const activeTrips = useMemo(() => trips.filter(t => t.trip_status !== 'COMPLETED' && t.trip_status !== 'ADVICE').filter(t => {
      if(!debouncedSearch) return true;
      const q = debouncedSearch.toLowerCase();
      return (
          (t.vehicle_no || t.Vehical_No || '').toLowerCase().includes(q) ||
          (t.driver_name || t.Driver_Name || '').toLowerCase().includes(q) ||
          (t.loading_point || t.Loading_Point || '').toLowerCase().includes(q) ||
          (t.consignee_name || t.Consignee_Name || '').toLowerCase().includes(q) ||
          (t.trip_id || t.Trip_ID || '').toLowerCase().includes(q) ||
          (t.Operating_Company || t.operating_company || '').toLowerCase().includes(q) ||
          (t.challan_no || t.Challan_No || '').toLowerCase().includes(q)
      );
  }), [trips, debouncedSearch]);
  const pgActiveTrips = usePagination(activeTrips);

  const completedTrips = useMemo(() => trips.filter(t => t.trip_status === 'COMPLETED').filter(t => {
      let matchDate = true;
      const tDate = t.unloading_date || t.start_date || t.Loading_Date || '';
      if (historyFromDate && tDate < historyFromDate) matchDate = false;
      if (historyToDate && tDate > historyToDate) matchDate = false;

      let matchSearch = true;
      if(debouncedSearch) {
        const q = debouncedSearch.toLowerCase();
        matchSearch = (
            (t.vehicle_no || t.Vehical_No || '').toLowerCase().includes(q) ||
            (t.loading_point || t.Loading_Point || '').toLowerCase().includes(q) ||
            (t.consignee_name || t.Consignee_Name || '').toLowerCase().includes(q) ||
            (t.trip_id || t.Trip_ID || '').toLowerCase().includes(q) ||
            (t.customer_name || t.Customer || t.Registered_Assessee || '').toLowerCase().includes(q) ||
            (t.challan_no || t.Challan_No || '').toLowerCase().includes(q) ||
            (t.Operating_Company || t.operating_company || '').toLowerCase().includes(q)
        );
      }
      return matchDate && matchSearch;
  }), [trips, debouncedSearch, historyFromDate, historyToDate]);
  const pgCompletedTrips = usePagination(completedTrips);

  // 🚦 Map a raw trip_status to a design-system lifecycle pill (Phase 4)
  const tripStatusPill = (status: string) => {
    const s = String(status || '').toUpperCase();
    if (s === 'COMPLETED') return { cls: 'pt-pill--completed', label: 'Completed' };
    if (s === 'UNLOADED' || s === 'ARRIVED_DESTINATION') return { cls: 'pt-pill--pending-unload', label: 'Pending Unload' };
    if (s === 'IN_TRANSIT' || s === 'DISPATCHED') return { cls: 'pt-pill--transit', label: 'In Transit' };
    return { cls: 'pt-pill--pending-load', label: 'Pending Load' }; // PENDING / LOADED / default
  };

  const getActiveDriverInfo = (trip) => {
    if (!trip) return null;
    return drivers.find(d => checkMatch(d.name || d.driver_name, trip.driver_name || trip.Driver_Name));
  };
  const activeDriverInfo = getActiveDriverInfo(activeTrip);

  let payModalCashTarget = 0;
  let payModalCashIssued = 0;
  if(activeTrip) {
      const mRoute = findRoute(activeTrip.consignee_name || activeTrip.Consignee_Name);
      payModalCashTarget = parseFloat(getVal(activeTrip, ['fixedcash', 'fixedcashamt'])) || parseFloat(getVal(mRoute, ['fixedcashamt', 'fixedcash', 'cash'])) || 0;
      payModalCashIssued = parseFloat(activeTrip.office_cash_paid||0) + parseFloat(activeTrip.bank_paid||0) + parseFloat(activeTrip.pump_cash_advance||0);
  }
  const payModalCashBal = payModalCashTarget - payModalCashIssued;

  // ── WHAT THE DROPDOWNS OFFER ──────────────────────────────────────────────
  // Built from the register itself rather than a hardcoded list, so a depot the
  // office starts using appears on its own. Loading points come from the routes
  // that HAVE one; the consignee list is the RTKM master, because choosing from
  // it is what fills in the money.
  const routeOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const m of rtkmMaster) {
      const v = String(m.Consignee_Name || m.unloading_point || m.Destination || '').trim();
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      const km = m.RTKM_Distance || m.rtkm_distance || m.Distance || m.RTKM;
      const from = m.Depot_Link || m.loading_point || m.Origin;
      out.push({ value: v, hint: [from, km ? `${km} km` : null].filter(Boolean).join(' · ') || null });
    }
    return out;
  }, [rtkmMaster]);

  const depotOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    const add = (raw: any) => {
      const v = String(raw ?? '').trim();
      if (!v || seen.has(v.toLowerCase())) return;
      seen.add(v.toLowerCase());
      out.push({ value: v, hint: placeOf(v).unresolved ? 'map par nahi mil raha' : null });
    };
    for (const m of rtkmMaster) add(m.Depot_Link || m.loading_point || m.Origin);
    for (const t of trips) add(t.loading_point || t.Loading_Point);
    return out;
  }, [rtkmMaster, trips]);

  const styles = {
    container: { padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #121c38, #0a1024)', fontFamily: "'Inter', sans-serif", color: 'white' },
    glassCard: { background: 'rgba(24, 36, 74, 0.4)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '12px', padding: '25px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)', overflowX: 'auto' as const },
    input: { background: 'rgba(18, 28, 56, 0.6)', border: '1px solid rgba(39, 57, 95, 0.8)', borderRadius: '8px', color: 'white', padding: '12px', width: '100%', boxSizing: 'border-box', outline: 'none', colorScheme: 'dark' },
    modalOverlay: { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.85)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
    modalContent: { background: '#121c38', padding: '30px', borderRadius: '12px', border: '1px solid #27395f', width: '800px', maxHeight: '90vh', overflowY: 'auto' as const, boxShadow: '0 10px 30px rgba(0,0,0,0.8)' },
    modalSm: { width: '450px' },
    table: { width: '100%', borderCollapse: 'collapse', marginTop: '10px', color: '#c4d1ea', fontSize: '12px', textAlign: 'left' as const, minWidth: '800px' },
    th: { padding: '12px', borderBottom: '2px solid #27395f', color: '#22d3ee', textTransform: 'uppercase' as const },
    td: { padding: '12px', borderBottom: '1px solid #18244a' },
    btn: { padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', border: 'none', color: 'white' }
  };

  return (
    <div style={styles.container}>
      
      {/* MODALS */}
      <BottomSheet open={!!(showTrackModal && activeTrip)} onClose={() => setShowTrackModal(false)} title={`📍 Route Tracking: ${activeTrip?.vehicle_no || activeTrip?.Vehical_No || ''}`} accent="#22d3ee" maxWidth={860}>
        {activeTrip && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '68dvh' }}>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '15px', flexWrap: 'wrap' }}>
              <button onClick={() => setTrackMode('ROUTE')} style={{ flex: 1, padding: '10px', borderRadius: '6px', fontWeight: 'bold', border: '1px solid #22d3ee', cursor: 'pointer', background: trackMode === 'ROUTE' ? '#38bdf8' : '#18244a', color: trackMode === 'ROUTE' ? '#121c38' : '#22d3ee' }}>🛣️ Full Route Plan</button>
              <button onClick={() => setTrackMode('GPRS')} style={{ flex: 1, padding: '10px', borderRadius: '6px', fontWeight: 'bold', border: '1px solid #2fe39b', cursor: 'pointer', background: trackMode === 'GPRS' ? '#10b981' : '#18244a', color: trackMode === 'GPRS' ? '#121c38' : '#2fe39b' }}>📡 Live GPS (Driver App)</button>
              <button onClick={() => setTrackMode('MOBILE')} style={{ flex: 1, padding: '10px', borderRadius: '6px', fontWeight: 'bold', border: '1px solid #ffb224', cursor: 'pointer', background: trackMode === 'MOBILE' ? '#f59e0b' : '#18244a', color: trackMode === 'MOBILE' ? '#121c38' : '#ffb224' }}>📱 Driver Mobile (Live)</button>
              <button onClick={() => setTrackMode('FASTAG')} style={{ flex: 1, padding: '10px', borderRadius: '6px', fontWeight: 'bold', border: '1px solid #a78bfa', cursor: 'pointer', background: trackMode === 'FASTAG' ? '#a78bfa' : '#18244a', color: trackMode === 'FASTAG' ? '#121c38' : '#a78bfa' }}>🛣️ FASTag Toll</button>
            </div>

            {/* 🛣️ Last-passed-toll summary — visible on every tab */}
            <div style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: modalToll ? 'rgba(255, 178, 36,0.08)' : 'rgba(100,116,139,0.08)', border: `1px solid ${modalToll ? 'rgba(255, 178, 36,0.35)' : '#27395f'}`, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {modalToll === undefined ? (
                <span style={{ color: '#9aadd4' }}>🛣️ Checking FASTag tolls…</span>
              ) : modalToll ? (
                <>
                  <span style={{ color: '#ffb224', fontWeight: 'bold' }}>🛣️ Last Toll: {modalToll.plaza}</span>
                  <span style={{ color: '#c4d1ea' }}>· {fmtToll(modalToll.datetime)} ({timeAgo(modalToll.datetime) || 'recently'})</span>
                  {tollHasCoords(modalToll) && <button onClick={() => setTrackMode('FASTAG')} style={{ marginLeft: 'auto', background: '#a78bfa', color: '#121c38', border: 'none', borderRadius: '6px', padding: '4px 10px', fontWeight: 'bold', cursor: 'pointer', fontSize: '11px' }}>📍 Show on Map</button>}
                </>
              ) : (
                <span style={{ color: '#9aadd4' }}>🛣️ No FASTag toll crossed yet on this trip.</span>
              )}
            </div>

            {/* GPS FRESHNESS - its own bar, ABOVE the map.
                It used to be a strip inside the map, which is why the Live GPS
                tab threw the road away: no ping meant no map at all, just a
                satellite dish and a "Check Again" button on an empty panel.
                The lane is known whether or not the lorry is reporting, so the
                lane stays on screen and this bar says what is missing. */}
            {trackMode === 'GPRS' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px',
                            background: activeTrip.liveLocation?.lat ? 'rgba(47,227,155,0.08)' : 'rgba(255,178,36,0.08)',
                            border: `1px solid ${activeTrip.liveLocation?.lat ? 'rgba(47,227,155,0.35)' : 'rgba(255,178,36,0.35)'}` }}>
                {activeTrip.liveLocation?.lat ? (() => {
                  const age = gpsAgeMinutes(activeTrip.liveLocation);
                  const stale = age === null || age > 15;
                  return (
                    <span style={{ color: stale ? '#ffb224' : '#2fe39b', fontWeight: 'bold' }}>
                      📡 {age === null ? 'Driver app se live ping' : age < 1 ? 'Updated just now' : `Updated ${age} min ago`}{stale ? ' ⚠️ (purana ho sakta hai)' : ''}
                    </span>
                  );
                })() : (
                  <span style={{ color: '#ffb224', fontWeight: 'bold' }}>
                    📡 Abhi tak koi GPS ping nahi aayi — driver se Driver App kholne ko kahein. Rasta neeche bana hua hai.
                  </span>
                )}
                <button onClick={refreshLiveLocation} disabled={gpsRefreshing} style={{ marginLeft: 'auto', background: '#10b981', color: '#121c38', border: 'none', padding: '6px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>
                  {gpsRefreshing ? '⌛ Checking…' : '🔄 Check Again'}
                </button>
              </div>
            )}

            <div style={{ flex: 1, background: '#0a1024', borderRadius: '12px', overflow: 'hidden', border: '1px solid #27395f', position: 'relative' }}>
              {/* ONE MAP FOR THREE OF THE FOUR TABS.
                  Full Route Plan, Live GPS and FASTag Toll were an iframe, a
                  second iframe and a hand-rolled map. Each tab flip tore down
                  what the last one had drawn, and the two iframes never drew a
                  road at all - Google's legacy `output=embed` directions frame
                  renders the search boxes and then does NOT compute the route,
                  which is the world map in the owner's screenshot.

                  <TripRouteMap /> asks DirectionsService for the real road,
                  draws it, and fits the camera to it. It stays MOUNTED across
                  these three tabs - the tab only changes which pins are lit and
                  where the camera opens - so switching tabs no longer re-bills
                  a map load or re-asks for a route that has not changed. */}
              {trackMode !== 'MOBILE' && (
                <TripRouteMap
                  origin={activeTrip.loading_point || activeTrip.Loading_Point || ''}
                  destination={activeTrip.consignee_name || activeTrip.Consignee_Name || activeTrip.unloading_location || ''}
                  truck={activeTrip.liveLocation?.lat ? {
                    lat: activeTrip.liveLocation.lat,
                    lng: activeTrip.liveLocation.lng,
                    heading: activeTrip.liveLocation.heading ?? 0,
                    at: activeTrip.liveLocation.lastUpdated,
                    speed_kmh: activeTrip.liveLocation.speed,
                  } : null}
                  tolls={tollHasCoords(modalToll) ? [modalToll] : []}
                  trip={{
                    vehicle_no: activeTrip.vehicle_no || activeTrip.Vehical_No,
                    driver_name: activeTrip.driver_name || activeTrip.Driver_Name,
                    trip_code: activeTrip.trip_id || activeTrip.Trip_ID,
                  }}
                  focus={trackMode === 'GPRS' ? 'TRUCK' : 'ROUTE'}
                  height="100%"
                  plazaMaster={plazaMaster}
                  roundTrip={isRoundTrip}
                  onGates={setTripGates}
                />
              )}
              {trackMode === 'MOBILE' && (
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100%', textAlign: 'center', padding:'20px' }}>
                  <span style={{ fontSize: '50px' }}>📱</span>
                  <h2 style={{ color: '#ffb224', margin:'10px 0' }}>Track via Driver&apos;s Mobile</h2>
                  <p style={{color:'#9aadd4', marginBottom:'20px'}}>Since hardware GPS is not active, you can request the driver to share their Live Location via WhatsApp.</p>
                  <button onClick={requestLiveLocation} style={{ background: '#25d366', color: 'white', padding: '15px 30px', borderRadius: '8px', border: 'none', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
                    Send WhatsApp Request to Driver
                  </button>
                </div>
              )}
            </div>

            {/* ── TOLL: THE GATES, THEIR RATES, AND THE TRIP'S TOTAL ──────────
                Owner, 4-Sep-2026: "trip route may toll gate and toll rate ...
                total trip par kitna toll tax lag rahi hay ... one way and
                return ... aur jo system may nahi aayi, wo rate add ho to auto
                add kar le taaki next time show ho."

                The rates are not a published tariff — they are what THIS
                fleet's own trucks were charged at those gates, read off
                toll_transactions. So a gate we have never crossed has no rate,
                and this panel is where somebody types it in once. It goes to
                the plaza master, not to this trip: the next lorry down the same
                road already has it, on the map, without anyone doing anything. */}
            {trackMode !== 'MOBILE' && (() => {
              const t = tollTotals(tripGates, { roundTrip: isRoundTrip });
              return (
                <div style={{ marginTop: '12px', border: '1px solid #27395f', borderRadius: '10px', background: 'rgba(24,36,74,0.5)', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '9px 12px' }}>
                    <button onClick={() => setTollOpen((v) => !v)} disabled={!t.gates}
                      style={{ background: 'none', border: 'none', color: t.gates ? '#ffb224' : '#5d7196', fontWeight: 'bold', fontSize: '13px', cursor: t.gates ? 'pointer' : 'default', padding: 0 }}>
                      🛣️ {t.gates ? `${t.gates} toll gate` : 'Toll gate'} {t.gates ? (tollOpen ? '▲' : '▼') : ''}
                    </button>

                    {t.gates > 0 ? (
                      <>
                        <span style={{ color: '#c4d1ea', fontSize: '12px' }}>
                          एक तरफ़ <b style={{ color: '#ffb224' }}>₹{t.one_way.toLocaleString('en-IN')}</b>
                        </span>
                        {isRoundTrip && (
                          <span style={{ color: '#c4d1ea', fontSize: '12px' }}>
                            आना-जाना <b style={{ color: '#ffb224', fontSize: '14px' }}>₹{t.total.toLocaleString('en-IN')}</b>
                          </span>
                        )}
                        {t.incomplete && (
                          <span style={{ color: '#ff9b9b', fontSize: '11px' }}>
                            {t.unknown} गेट का rate नहीं — नीचे भर दें
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: '#9aadd4', fontSize: '12px' }}>
                        {plazaErr
                          ? 'Toll master abhi nahi mila — rasta phir bhi sahi hai.'
                          : plazaMaster.length
                            ? 'Is raste par apna koi toll gate record mein nahi hai.'
                            : 'Toll gates dhoondh rahe hain…'}
                      </span>
                    )}

                    {/* ROUND vs ONE WAY. Oil-company trips return and pay again;
                        a market vehicle runs one side. Saved on the trip. */}
                    <div style={{ marginLeft: 'auto', display: 'flex', border: '1px solid #27395f', borderRadius: '7px', overflow: 'hidden' }}>
                      {[['ROUND', 'आना-जाना'], ['ONE_WAY', 'एक तरफ़']].map(([k, label]) => (
                        <button key={k} onClick={() => setLegKind(k)}
                          style={{ padding: '5px 11px', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold',
                                   background: legKind === k ? '#ffb224' : 'transparent',
                                   color: legKind === k ? '#121c38' : '#9aadd4' }}>{label}</button>
                      ))}
                    </div>
                  </div>

                  {tollOpen && t.gates > 0 && (
                    <div style={{ borderTop: '1px solid #27395f', maxHeight: '190px', overflowY: 'auto' }}>
                      {tripGates.map((g: any, i: number) => {
                        const known = g.rate !== null && g.rate !== undefined && g.rate !== '';
                        return (
                          <div key={g.name_key || i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 12px', borderBottom: '1px solid rgba(39,57,95,0.5)', flexWrap: 'wrap' }}>
                            <span style={{ color: g.crossed ? '#2fe39b' : '#5d7196', fontSize: '11px', fontWeight: 'bold', minWidth: '22px' }}>{i + 1}.</span>
                            <span style={{ color: '#dde5f4', fontSize: '12px', flex: 1, minWidth: '150px' }}>
                              {g.plaza_name}
                              {g.crossed && <span style={{ color: '#2fe39b', fontSize: '10px', marginLeft: '6px' }}>✅ cross हो चुका</span>}
                            </span>
                            {known ? (
                              <>
                                <b style={{ color: '#ffb224', fontSize: '12px' }}>₹{Number(g.rate).toLocaleString('en-IN')}</b>
                                {/* Where the number came from, so nobody has to trust it blindly. */}
                                <span style={{ color: '#5d7196', fontSize: '10px', minWidth: '92px', textAlign: 'right' }}>
                                  {g.rate_source === 'MANUAL' ? 'हाथ से भरा' : `FASTag · ${g.observations || 0}×`}
                                </span>
                              </>
                            ) : (
                              <>
                                <input
                                  type="number" placeholder="₹ rate"
                                  value={rateDraft[g.name_key] ?? ''}
                                  onChange={(e) => setRateDraft((d) => ({ ...d, [g.name_key]: e.target.value }))}
                                  style={{ width: '86px', background: 'rgba(18,28,56,0.8)', border: '1px solid #ffb224', borderRadius: '6px', color: '#ffb224', padding: '4px 7px', fontSize: '12px', outline: 'none' }} />
                                <button onClick={() => saveGateRate(g)} disabled={savingRate === g.name_key}
                                  style={{ background: '#ffb224', color: '#121c38', border: 'none', borderRadius: '6px', padding: '4px 11px', fontWeight: 'bold', fontSize: '11px', cursor: 'pointer' }}>
                                  {savingRate === g.name_key ? '⌛' : 'Save'}
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })}
                      <div style={{ padding: '7px 12px', color: '#5d7196', fontSize: '10.5px', lineHeight: 1.5 }}>
                        Rate हमारी अपनी FASTag history से आते हैं — यानी इन्हीं gates पर हमारे trucks ने जो असल में दिया।
                        {isRoundTrip && ' आना-जाना = वही रास्ता, वही rate, दो बार (अनुमान).'}
                        {' '}यहाँ भरा हुआ rate master में जाता है, तो अगली बार अपने आप दिखेगा.
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* The same route in the real app — one tap to turn-by-turn on a
                phone, and the deep link opens the installed Google Maps rather
                than the browser. Hidden, not dead, when the route cannot be
                placed: a button that opens a map of the world is worse than no
                button, because somebody presses it every time. */}
            {trackMode === 'ROUTE' && (() => {
              const url = routeAppUrl(
                activeTrip.loading_point || activeTrip.Loading_Point || '',
                activeTrip.consignee_name || activeTrip.Consignee_Name || activeTrip.unloading_location || '');
              if (!url) return null;
              const a = placeOf(activeTrip.loading_point || activeTrip.Loading_Point || '');
              const b = placeOf(activeTrip.consignee_name || activeTrip.Consignee_Name || activeTrip.unloading_location || '');
              return (
                <div style={{ marginTop: '15px', textAlign: 'center' }}>
                  <a href={url} target="_blank" rel="noopener noreferrer"
                    style={{ background: '#2563eb', color: 'white', padding: '12px 25px', borderRadius: '6px', textDecoration: 'none', fontWeight: 'bold', display: 'inline-block' }}>
                    🗺️ Open Full Route in Google Maps App
                  </a>
                  {/* What it is actually going to search for. The codes are how
                      the office talks about these depots; the names are what a
                      map can find — showing both is what makes a wrong pin
                      obvious instead of mysterious. */}
                  <div style={{ marginTop: '8px', color: '#5d7196', fontSize: '12px' }}>
                    {a.label} <span style={{ color: '#22d3ee' }}>→</span> {b.label}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </BottomSheet>

      <BottomSheet open={!!(showPaymentModal && activeTrip)} onClose={() => setShowPaymentModal(false)} title={`💸 Pay to Driver (${activeTrip?.driver_name || activeTrip?.Driver_Name || ''})`} accent="#8b5cf6" maxWidth={480}>
        {activeTrip && (<>
            <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(255, 178, 36, 0.1)', padding: '12px', borderRadius: '8px', border: '1px solid #ffb224', marginBottom: '15px' }}>
               <div style={{textAlign: 'center'}}><span style={{fontSize:'11px', color:'#9aadd4'}}>Cash Target</span><br/><b style={{color:'#ffb224'}}>₹{payModalCashTarget}</b></div>
               <div style={{textAlign: 'center'}}><span style={{fontSize:'11px', color:'#9aadd4'}}>Total Paid</span><br/><b style={{color:'#ffb224'}}>₹{payModalCashIssued}</b></div>
               <div style={{textAlign: 'center'}}><span style={{fontSize:'11px', color:'#9aadd4'}}>Remaining</span><br/><b style={{color: payModalCashBal < 0 ? '#ff6b81' : '#2fe39b', fontSize:'14px'}}>₹{payModalCashBal}</b></div>
            </div>

            {activeDriverInfo && (
              <div style={{ background: 'rgba(47, 227, 155, 0.1)', padding: '12px', borderRadius: '8px', border: '1px solid #2fe39b', marginBottom: '15px' }}>
                <p style={{ margin: '0 0 5px 0', color: '#2fe39b', fontSize: '13px', fontWeight: 'bold' }}>🏦 Driver Bank Details</p>
                <p style={{ margin: '0 0 4px 0', color: '#c4d1ea', fontSize: '13px' }}><b>A/C No:</b> {getVal(activeDriverInfo, ['accountno', 'accountnumber', 'bankaccount', 'account', 'acno']) || 'Not Updated'}</p>
                <p style={{ margin: '0', color: '#c4d1ea', fontSize: '13px' }}><b>IFSC:</b> {getVal(activeDriverInfo, ['ifsccode', 'ifsc']) || 'Not Updated'}</p>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <select style={{...styles.input, borderColor: '#8b5cf6'}} value={paymentData.mode} onChange={e=>setPaymentData({...paymentData, mode: e.target.value})}>
                <option value="Office Cash">🏢 Office Cash</option><option value="Bank Transfer">🏦 Bank / UPI Transfer</option>
              </select>
              <div>
                <label style={{ fontSize: '11px', color: '#8b5cf6', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>📅 Payment Date (backdate allowed) *</label>
                <input type="date" style={{...styles.input, colorScheme: 'dark', borderColor: '#8b5cf6'}} value={paymentData.date} onChange={e=>setPaymentData({...paymentData, date: e.target.value})} />
              </div>
              <input type="number" style={styles.input} placeholder="Amount (₹)" value={paymentData.amount} onChange={e=>setPaymentData({...paymentData, amount: e.target.value})} />
              <input type="text" style={styles.input} placeholder="Remarks / Ref No." value={paymentData.remarks} onChange={e=>setPaymentData({...paymentData, remarks: e.target.value})} />
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                <button onClick={()=>setShowPaymentModal(false)} style={{ flex: 1, background: '#27395f', color: 'white', padding: '10px', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleDriverPayment} disabled={savingPayment} style={{ flex: 1, background: savingPayment ? '#5d7196' : '#8b5cf6', color: 'white', padding: '14px', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', minHeight: '48px' }}>{savingPayment ? '⌛ Paying...' : 'Confirm Payment'}</button>
              </div>
            </div>
        </>)}
      </BottomSheet>

      <BottomSheet open={!!(showFuelModal && activeTrip)} onClose={() => setShowFuelModal(false)} title="⛽ Issue Trip Fuel/Cash Memo" accent="#ffb224" maxWidth={880}>
        {activeTrip && (<>
            {generatedMemos.length > 0 ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <h2 style={{ color: '#2fe39b' }}>✅ Memos Generated!</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', alignItems: 'center' }}>
                  {generatedMemos.map((slip, i) => (
                    <button key={i} onClick={() => sendFuelMemoWhatsApp(slip)} style={{ background: '#22c55e', color: 'white', padding: '10px 15px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', border: 'none' }}>💬 Send WhatsApp to {slip.vendor_name}</button>
                  ))}
                </div>
                <button onClick={() => setShowFuelModal(false)} style={{ marginTop: '30px', background: '#27395f', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '5px', cursor: 'pointer' }}>Close Window</button>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: '15px', marginBottom: '15px', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', flexWrap: 'wrap' }}>
                  <div style={{flex: 1, minWidth: 'min(100%, 160px)'}}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Vehicle</label><input style={styles.input} value={activeTrip.vehicle_no || activeTrip.Vehical_No} readOnly /></div>
                  <div style={{flex: 1, minWidth: 'min(100%, 160px)'}}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Driver</label><input style={styles.input} value={activeTrip.driver_name || activeTrip.Driver_Name} readOnly /></div>
                  <div style={{flex: 1, minWidth: 'min(100%, 160px)'}}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Mobile</label><input style={styles.input} value={memoData.driver_mobile} readOnly /></div>
                  <div style={{flex: 1, minWidth: 'min(100%, 160px)'}}><label style={{ fontSize:'11px', color:'#ffb224', fontWeight: 'bold' }}>📅 Transaction / Issue Date *</label><input type="date" style={{...styles.input, colorScheme: 'dark', borderColor: '#ffb224'}} value={memoData.date} onChange={e=>setMemoData({...memoData, date: e.target.value})} /></div>
                </div>

                <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', flexWrap: 'wrap' }}>
                  <div style={{flex: 1, minWidth: 'min(100%, 300px)', background: 'rgba(34, 211, 238, 0.05)', padding: '15px', borderRadius: '8px', border: '1px solid rgba(34, 211, 238, 0.3)'}}>
                    <h4 style={{margin: '0 0 10px 0', color: '#22d3ee'}}>💧 HSD Calculation</h4>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <div style={{flex: 1}}><label style={{ fontSize:'11px', color:'#22d3ee' }}>Target (Edit)</label><input type="number" style={{...styles.input, borderColor: '#22d3ee'}} value={memoData.fixed_hsd} onChange={e=>setMemoData({...memoData, fixed_hsd: e.target.value})} /></div>
                      <div style={{flex: 1}}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Issued</label><input style={styles.input} value={memoData.hsd_issued} readOnly /></div>
                      <div style={{flex: 1}}><label style={{ fontSize:'11px', color: (memoData.fixed_hsd - memoData.hsd_issued) < 0 ? '#ff6b81' : '#2fe39b' }}>Balance</label><input style={{...styles.input, fontWeight: 'bold', color: (memoData.fixed_hsd - memoData.hsd_issued) < 0 ? '#ff6b81' : '#2fe39b'}} value={(memoData.fixed_hsd || 0) - (memoData.hsd_issued || 0)} readOnly /></div>
                    </div>
                  </div>

                  <div style={{flex: 1, minWidth: 'min(100%, 300px)', background: 'rgba(47, 227, 155, 0.05)', padding: '15px', borderRadius: '8px', border: '1px solid rgba(47, 227, 155, 0.3)'}}>
                    <h4 style={{margin: '0 0 10px 0', color: '#2fe39b'}}>💵 Cash Calculation</h4>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <div style={{flex: 1}}><label style={{ fontSize:'11px', color:'#2fe39b' }}>Target (Edit)</label><input type="number" style={{...styles.input, borderColor: '#2fe39b'}} value={memoData.fixed_cash} onChange={e=>setMemoData({...memoData, fixed_cash: e.target.value})} /></div>
                      <div style={{flex: 1}}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Paid</label><input style={styles.input} value={memoData.cash_issued} readOnly /></div>
                      <div style={{flex: 1}}><label style={{ fontSize:'11px', color: (memoData.fixed_cash - memoData.cash_issued) < 0 ? '#ff6b81' : '#2fe39b' }}>Balance</label><input style={{...styles.input, fontWeight: 'bold', color: (memoData.fixed_cash - memoData.cash_issued) < 0 ? '#ff6b81' : '#2fe39b'}} value={(memoData.fixed_cash || 0) - (memoData.cash_issued || 0)} readOnly /></div>
                    </div>
                  </div>
                </div>

                <h4 style={{ color: '#ffb224', marginBottom: '10px' }}>⛽ Issue New Fuel / Cash</h4>
                {pumps.map((pump) => (
                  <div key={pump.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px', marginBottom: '15px', flexWrap: 'wrap' }}>
                    <select style={{...styles.input, flex: 1.5, minWidth: 'min(100%, 180px)'}} value={pump.vendor_id} onChange={e=>handlePumpChange(pump.id, 'vendor_id', e.target.value)}><option value="">-- Petrol Pump --</option>{fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}</select>
                    <select style={{...styles.input, flex: 1, minWidth: '110px'}} value={pump.fuel_type} onChange={e=>handlePumpChange(pump.id, 'fuel_type', e.target.value)}><option value="FIXED">Fixed</option><option value="ADVANCE">Advance</option></select>
                    <input type="number" inputMode="decimal" style={{...styles.input, flex: 1, minWidth: '95px'}} placeholder="Liters (New)" value={pump.qty} onChange={e=>handlePumpChange(pump.id, 'qty', e.target.value)} />
                    <input type="number" inputMode="decimal" style={{...styles.input, flex: 1, minWidth: '95px', borderColor: pump.qty && !(parseFloat(pump.rate) > 0) ? '#ff6b81' : undefined}} placeholder="Rate ₹/L" value={pump.rate} onChange={e=>handlePumpChange(pump.id, 'rate', e.target.value)} />
                    <div style={{flex: 1, minWidth: '90px', textAlign: 'center'}}><span style={{fontSize:'10px', color:'#9aadd4', display:'block'}}>Amount</span><b style={{color:'#ffb224'}}>₹{pump.amount || '0.00'}</b></div>
                    <input type="number" inputMode="decimal" style={{...styles.input, flex: 1, minWidth: '95px'}} placeholder="Cash (New)" value={pump.cash_advance} onChange={e=>handlePumpChange(pump.id, 'cash_advance', e.target.value)} />
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                  <button onClick={() => setPumps([...pumps, { id: Date.now(), vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }])} style={{ background: 'transparent', color: '#22d3ee', border: '1px dashed #22d3ee', padding: '10px 20px', borderRadius: '5px', cursor: 'pointer' }}>+ Add Pump</button>
                  <button onClick={handleSaveFuelMemo} disabled={savingMemo} style={{ padding: '12px 30px', background: savingMemo ? '#5d7196' : '#f59e0b', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>{savingMemo ? '⌛ Saving...' : '🚀 Save & Generate WA Slip'}</button>
                </div>
              </>
            )}
        </>)}
      </BottomSheet>

      <BottomSheet open={!!(showUnloadModal && activeTrip)} onClose={() => setShowUnloadModal(false)} title="📦 Final Unloading" accent="#2fe39b" maxWidth={480}>
        {activeTrip && (<>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '15px', marginBottom: '20px' }}>
              <div style={{ gridColumn: 'span 2' }}><label style={{ color: '#fff', fontSize: '12px' }}>Date</label><input type="date" style={styles.input} value={unloadData.unloading_date} onChange={e=>recalcUnload({ unloading_date: e.target.value })} /></div>
              <div><label style={{ color: '#22d3ee', fontSize: '12px' }}>Loaded Qty (Auto)</label><input type="number" style={{...styles.input, color: '#22d3ee'}} value={unloadData.loaded_qty} onChange={e=>recalcUnload({ loaded_qty: e.target.value })} /></div>
              <div><label style={{ color: '#2fe39b', fontSize: '12px' }}>Unloaded Qty *</label><input type="number" style={{...styles.input, borderColor: '#2fe39b'}} value={unloadData.unloaded_qty} onChange={e=>recalcUnload({ unloaded_qty: e.target.value })} placeholder="Enter received qty" /></div>
              <div><label style={{ color: '#ff6b81', fontSize: '12px' }}>Shortage (Auto)</label><input type="number" style={{...styles.input, borderColor: '#ff6b81', color: '#ff6b81', fontWeight: 'bold'}} value={unloadData.shortage_qty} readOnly /></div>
              <div><label style={{ color: '#ffb224', fontSize: '12px' }}>Penalty Rate (₹/unit)</label><input type="number" style={{...styles.input, borderColor: '#ffb224'}} value={unloadData.penalty_rate} onChange={e=>recalcUnload({ penalty_rate: e.target.value })} placeholder="e.g. 50" /></div>
              <div style={{ gridColumn: 'span 2' }}><label style={{ color: '#ff6b81', fontSize: '12px' }}>Penalty ₹ (Auto, editable)</label><input type="number" style={{...styles.input, borderColor: '#ff6b81'}} value={unloadData.shortage_penalty} onChange={e=>recalcUnload({ shortage_penalty: e.target.value })} /></div>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setShowUnloadModal(false)} style={{ flex: 1, padding: '12px', background: '#27395f', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleCompleteTrip} style={{ flex: 1, padding: '14px', background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', minHeight: '48px' }}>✅ Complete Trip</button>
            </div>
        </>)}
      </BottomSheet>

      {/* --- HEADER & TABS --- */}
      <div style={{ marginBottom: '25px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '32px', fontWeight: '900', color: 'white' }}>🚛 Trip Command Center</h1>
          <p style={{ margin: '4px 0 0', color: '#9aadd4', fontSize: '13px' }}>
            Live PostgreSQL · advances, fuel slips and trip closure post through the ledger
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={fetchData} className="pt-btn pt-btn--ghost" title="Reload from PostgreSQL">🔄 Refresh</button>
          <button onClick={() => setShowFreightTool(true)} className="pt-btn pt-btn--ai" title="Fill missing freight so Revenue flows">💰 Set Freight (Bulk)</button>
        </div>
      </div>

      {err && (
        <div style={{ background: 'rgba(255, 107, 129,0.1)', border: '1px solid #ff6b81', color: '#fca5a5', padding: '14px 18px', borderRadius: 12, marginBottom: 18, fontSize: 14 }}>
          ⚠️ {err}
          <div style={{ color: '#9aadd4', marginTop: 6, fontSize: 12 }}>Reads <code>{OPS}/trips</code>. Check that the ERP API is running.</div>
        </div>
      )}

      {/* 💰 BULK FREIGHT TOOL — fills missing freight so Accounts Revenue flows */}
      <BottomSheet open={showFreightTool} onClose={() => setShowFreightTool(false)} title="💰 Set Freight (Bulk)" accent="#a78bfa" maxWidth={480}>
            <p style={{ color: '#9aadd4', fontSize: '13px', marginTop: 0 }}>Customer chuno + freight ₹ daalo. Sirf un trips mein lagega jinme abhi freight nahi hai (add-only). Phir Revenue journal mein flow karega.</p>
            <label style={{ fontSize: '12px', color: '#22d3ee' }}>Customer</label>
            <select style={styles.input} value={freightCust} onChange={e => setFreightCust(e.target.value)}>
              <option value="">-- Choose customer --</option>
              {Array.from(new Set(trips.map(tripCust).filter(Boolean))).sort().map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ fontSize: '12px', color: '#2fe39b', marginTop: '10px', display: 'block' }}>Freight per trip (₹)</label>
            <input type="number" style={styles.input} value={freightRate} onChange={e => setFreightRate(e.target.value)} placeholder="e.g. 25000" />
            <div style={{ margin: '12px 0', fontSize: '13px', color: '#ffb224' }}>
              {freightCust ? `${freightTargets.length} trips ko freight milega (jinme abhi nahi hai).` : 'Customer chuno preview ke liye.'}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setShowFreightTool(false)} style={{ flex: 1, padding: '12px', background: '#27395f', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={applyBulkFreight} disabled={freightBusy} className={`pt-btn pt-btn--success ${freightBusy ? 'is-loading' : ''}`} style={{ flex: 1 }}>{freightBusy ? 'Applying…' : '✅ Apply Freight'}</button>
            </div>
      </BottomSheet>

      {/* 🌟 GLOBAL SEARCH BAR & FILTERS — sticky so it never scrolls away */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 30, background: '#121c38', padding: '10px 0', margin: '0 0 20px 0' }}>
        <input 
          type="text" 
          placeholder="🔍 Global Search: Vehicle, Route, Driver, Trip ID, Challan, Company..." 
          value={globalSearch}
          onChange={(e) => setGlobalSearch(e.target.value)}
          style={{...styles.input, borderColor: '#5d7196', fontSize: '15px', background: '#18244a', flex: 2}}
        />
        
        {/* Date Filters ONLY for History Tab */}
        {activeTab === 'COMPLETED' && (
          <>
            <div style={{ flex: 1, position: 'relative' }}>
              <label style={{ position: 'absolute', top: '-8px', left: '10px', background: '#121c38', padding: '0 5px', fontSize: '11px', color: '#ffb224' }}>From Date</label>
              <input type="date" style={styles.input} value={historyFromDate} onChange={e=>setHistoryFromDate(e.target.value)} />
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <label style={{ position: 'absolute', top: '-8px', left: '10px', background: '#121c38', padding: '0 5px', fontSize: '11px', color: '#ffb224' }}>To Date</label>
              <input type="date" style={styles.input} value={historyToDate} onChange={e=>setHistoryToDate(e.target.value)} />
            </div>
            {(historyFromDate || historyToDate) && (
              <button onClick={()=>{setHistoryFromDate(''); setHistoryToDate('');}} style={{...styles.btn, background:'#ef4444', height:'45px'}}>Clear</button>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #27395f' }}>
        <button onClick={() => {setActiveTab('ACTIVE'); setEditingTripId('');}} style={{ padding: '12px 25px', background: activeTab === 'ACTIVE' ? 'rgba(34, 211, 238, 0.1)' : 'transparent', color: activeTab === 'ACTIVE' ? '#22d3ee' : '#9aadd4', border: 'none', borderBottom: activeTab === 'ACTIVE' ? '3px solid #22d3ee' : '3px solid transparent', cursor: 'pointer', fontWeight: 'bold', borderRadius: '8px 8px 0 0' }}>🟢 LIVE TRACKING</button>
        <button onClick={() => setActiveTab('NEW')} style={{ padding: '12px 25px', background: activeTab === 'NEW' ? 'rgba(34, 211, 238, 0.1)' : 'transparent', color: activeTab === 'NEW' ? '#22d3ee' : '#9aadd4', border: 'none', borderBottom: activeTab === 'NEW' ? '3px solid #22d3ee' : '3px solid transparent', cursor: 'pointer', fontWeight: 'bold', borderRadius: '8px 8px 0 0' }}>
           {editingTripId ? '✏️ EDIT TRIP' : '➕ START NEW TRIP'}
        </button>
        <button onClick={() => {setActiveTab('COMPLETED'); setEditingTripId('');}} style={{ padding: '12px 25px', background: activeTab === 'COMPLETED' ? 'rgba(34, 211, 238, 0.1)' : 'transparent', color: activeTab === 'COMPLETED' ? '#22d3ee' : '#9aadd4', border: 'none', borderBottom: activeTab === 'COMPLETED' ? '3px solid #22d3ee' : '3px solid transparent', cursor: 'pointer', fontWeight: 'bold', borderRadius: '8px 8px 0 0' }}>✅ TRIP HISTORY</button>
      </div>

      {activeTab === 'NEW' && (
        <div style={{...styles.glassCard, borderTop: '4px solid #22d3ee'}}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{color: '#fff', margin: 0}}>{editingTripId ? `✏️ Edit Trip: ${formData.trip_id}` : '➕ New Quick Trip'}</h3>
            {editingTripId && <button onClick={cancelEdit} style={{...styles.btn, background: '#ef4444'}}>✕ Cancel Edit</button>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
            {/* 🌟 NEW FIELDS ADDED HERE */}
            <div><label style={{ fontSize: '12px' }}>Loading Date *</label><input type="date" style={styles.input} value={formData.start_date} onChange={e=>setFormData({...formData, start_date: e.target.value})} /></div>
            <div><label style={{ fontSize: '12px' }}>Trip ID / LR No</label><input type="text" style={{...styles.input, color:'#ffb224'}} value={formData.trip_id} readOnly /></div>
            <div><label style={{ fontSize: '12px' }}>Challan / Invoice No *</label><input type="text" style={styles.input} value={formData.challan_no} onChange={e=>setFormData({...formData, challan_no: e.target.value})} placeholder="Enter Challan" /></div>
            
            <div><label style={{ fontSize: '12px' }}>Vehicle No *</label><select style={styles.input} value={formData.vehicle_no} onChange={e=>handleVehicleChange(e.target.value)}><option value="">-- Choose --</option>{vehicles.map(v => <option key={v.id} value={v.vehical_no || v.vehicle_no || v.registration_no}>{v.vehical_no || v.vehicle_no || v.registration_no}</option>)}</select></div>
            <div><label style={{ fontSize: '12px', color: '#ffb224' }}>Operating Company (Auto)</label><input style={{...styles.input, color: '#ffb224'}} value={formData.operating_company} onChange={e=>setFormData({...formData, operating_company: e.target.value})} placeholder="Follows vehicle" /></div>
            <div>
              <label style={{ fontSize: '12px' }}>Customer Name (Billed To)</label>
              <input type="text" style={styles.input} value={formData.customer_name} onChange={e=>setFormData({...formData, customer_name: e.target.value})} placeholder="Enter Customer" />
              {(() => { const r = getLastCustomerRate(formData.customer_name); return (r && !formData.gross_freight) ? (
                <div style={{ marginTop: '5px', fontSize: '11px', color: '#a78bfa' }}>
                  💡 Last freight: ₹{r.rate}
                  <button type="button" onClick={() => setFormData(p => ({ ...p, gross_freight: r.rate }))} style={{ marginLeft: '6px', background: 'rgba(167, 139, 250,0.15)', color: '#a78bfa', border: '1px solid #a78bfa', borderRadius: '6px', padding: '1px 8px', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold' }}>Use</button>
                </div>
              ) : null; })()}
            </div>
            {/* CONSIGNEE - the company's own routes first, then Google.
                This was a bare <datalist>, which is why a lane the office had
                never run before had to be typed blind and then failed to place
                on the map. It is now <PlaceInput>: the RTKM master is shown at
                the top (picking one still auto-fills rtkm / fixed cash / fixed
                HSD through handleConsigneeChange, which is the whole reason the
                datalist existed) and Google's India-restricted suggestions
                follow underneath for anywhere new. Free text is still accepted
                - half these consignees are AFS depots Google has never heard
                of, and the operator must always be able to type what they have. */}
            <div>
              <label style={{ color: '#22d3ee', fontSize: '12px', fontWeight: 'bold' }}>Consignee / Route *</label>
              <PlaceInput
                value={formData.consignee_name}
                onChange={handleConsigneeChange}
                onPickLocal={handleConsigneeChange}
                onResolved={(pl) => setFormData(prev => ({ ...prev, consignee_name: pl.description }))}
                local={routeOptions}
                localLabel="Apni routes (auto-fill)"
                placeholder="Route chunein ya nayi jagah likhein..."
                style={{...styles.input, borderColor: '#22d3ee', background: 'rgba(34, 211, 238, 0.05)'}}
              />
            </div>
            
            <div><label style={{ fontSize: '12px' }}>Driver</label><select style={styles.input} value={formData.driver_name} onChange={handleDriverSelect}><option value="">-- Choose --</option>{drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}</select></div>
            <div><label style={{ fontSize: '12px' }}>Driver Mobile *</label><input type="text" style={styles.input} value={formData.driver_mobil_no} onChange={e=>setFormData({...formData, driver_mobil_no: e.target.value})} placeholder="Driver Mobile" /></div>
            
            <div>
              <label style={{ fontSize: '12px' }}>Loading Point (Auto)</label>
              <PlaceInput
                value={formData.loading_point}
                onChange={(v) => setFormData(prev => ({ ...prev, loading_point: v }))}
                onPickLocal={(v) => setFormData(prev => ({ ...prev, loading_point: v }))}
                onResolved={(pl) => setFormData(prev => ({ ...prev, loading_point: pl.description }))}
                local={depotOptions}
                localLabel="Apne depot"
                placeholder="Depot ka naam"
                style={{...styles.input, color: '#9aadd4'}}
              />
            </div>
            <div><label style={{ fontSize: '12px' }}>RTKM (Auto)</label><input style={{...styles.input, color: '#9aadd4'}} value={formData.rtkm} onChange={e=>setFormData({...formData, rtkm: e.target.value})} /></div>
            <div><label style={{ color: '#2fe39b', fontSize: '12px' }}>Fix HSD (Auto)</label><input style={{...styles.input, borderColor: 'rgba(47, 227, 155, 0.3)', color: '#2fe39b'}} value={formData.fixed_hsd} onChange={e=>setFormData({...formData, fixed_hsd: e.target.value})} /></div>
            <div><label style={{ color: '#2fe39b', fontSize: '12px' }}>Fix Cash (Auto)</label><input style={{...styles.input, borderColor: 'rgba(47, 227, 155, 0.3)', color: '#2fe39b'}} value={formData.fixed_cash} onChange={e=>setFormData({...formData, fixed_cash: e.target.value})} /></div>
            <div><label style={{ fontSize: '12px' }}>Freight (₹)</label><input type="number" style={styles.input} value={formData.gross_freight} onChange={e=>setFormData({...formData, gross_freight: e.target.value})} placeholder="Enter Amount" /></div>
          </div>

          {/* 🗺️ Off-master route: auto-calc RTKM via Google Maps (only external API) */}
          <div style={{ marginTop: '14px', padding: '12px 14px', background: 'rgba(34, 211, 238,0.05)', border: '1px dashed #27395f', borderRadius: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <button
                onClick={calcRouteViaMaps}
                disabled={mapsCalc.loading}
                className={`pt-btn pt-btn--secondary ${mapsCalc.loading ? 'is-loading' : ''}`}
              >
                {mapsCalc.loading ? 'Calculating…' : '🗺️ Calculate RTKM via Google Maps'}
              </button>
              <span style={{ fontSize: '11px', color: '#5d7196' }}>
                Route master mein nahi hai? Loading Point + Consignee bhar kar yeh dabaayein.
              </span>
            </div>
            {mapsCalc.info && <div style={{ marginTop: '8px', fontSize: '12px', color: '#2fe39b' }}>✅ {mapsCalc.info}</div>}
            {mapsCalc.error && <div style={{ marginTop: '8px', fontSize: '12px', color: '#ff6b81' }}>⚠️ {mapsCalc.error}</div>}
          </div>

          <button onClick={handleSaveTrip} style={{ marginTop: '20px', width: '100%', background: '#38bdf8', color: '#121c38', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
             {editingTripId ? '💾 Save Changes' : '🚀 Start Trip Manually'}
          </button>
        </div>
      )}

      {/* 📱 MOBILE: touch-first trip cards with HSD/Cash meters */}
      {activeTab === 'ACTIVE' && isMobile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {activeTrips.length === 0 ? <div style={{ padding: '30px', textAlign: 'center', color: '#5d7196' }}>No matching active trips found.</div> :
           pgActiveTrips.slice.map(t => {
            const mRoute = findRoute(t.consignee_name || t.Consignee_Name);
            let hTarget = parseFloat(getVal(t, ['fixedhsd', 'fixedhsdqty'])) || 0;
            if (hTarget === 0) hTarget = parseFloat(getVal(mRoute, ['fixedhsdqty', 'fixedhsd', 'hsd', 'fuel'])) || 0;
            let cTarget = parseFloat(getVal(t, ['fixedcash', 'fixedcashamt'])) || 0;
            if (cTarget === 0) cTarget = parseFloat(getVal(mRoute, ['fixedcashamt', 'fixedcash', 'cash'])) || 0;
            const paidCash = parseFloat(t.office_cash_paid||0) + parseFloat(t.bank_paid||0) + parseFloat(t.pump_cash_advance||0);
            const hsdIssued = parseFloat(t.hsd_issued||0);
            const pill = tripStatusPill(t.trip_status);
            const phone = t.driver_mobil_no || t.driver_mobile || '';
            return (
              <div key={t.id} style={{ background: 'rgba(24, 36, 74,0.5)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <b style={{ fontSize: '17px', color: '#fff' }}>{t.vehicle_no || t.Vehical_No}</b>
                  <span className={`pt-pill ${pill.cls}`}>{pill.label}</span>
                </div>
                <div style={{ fontSize: '12px', color: '#22d3ee', fontWeight: 'bold', margin: '3px 0' }}>{t.trip_id || t.Trip_ID}</div>
                <div style={{ fontSize: '13px', color: '#c4d1ea', margin: '4px 0 2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.loading_point || t.Loading_Point} ➔ {t.consignee_name || t.Consignee_Name}<RtkmBadge t={t} />
                </div>
                <div style={{ marginBottom: '8px' }}><LastTollBadge tripId={t.id} /></div>
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <TripMeter label="⛽ HSD" used={hsdIssued} target={hTarget} unit="L" color="#2fe39b" />
                  <TripMeter label="💵 Cash" used={paidCash} target={cTarget} unit="₹" color="#ffb224" />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#9aadd4', marginBottom: '10px' }}>
                  <span>👨‍✈️ {t.driver_name || t.Driver_Name || '—'}</span>
                  {phone && <a href={`tel:${phone}`} style={{ color: '#2fe39b', fontWeight: 'bold', textDecoration: 'none', padding: '6px 12px', border: '1px solid #2fe39b', borderRadius: '8px' }}>📞 Call</a>}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => openPaymentModal(t)} style={{ flex: 1, minHeight: '48px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>💸 Pay</button>
                  <button onClick={() => openFuelModal(t)} style={{ flex: 1, minHeight: '48px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>⛽ Fuel</button>
                  <button onClick={() => { setActiveTrip(t); setUnloadData({ unloading_date: new Date().toISOString().split('T')[0], loaded_qty: String(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || ''), unloaded_qty: '', shortage_qty: '', penalty_rate: '', shortage_penalty: '', unloading_location: t.consignee_name || t.Consignee_Name || '', remarks: '' }); setShowUnloadModal(true); }} style={{ flex: 1, minHeight: '48px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>✅ Unload</button>
                  <button onClick={() => { setActiveTrip(t); setTrackMode('ROUTE'); setShowTrackModal(true); }} style={{ flex: 1, minHeight: '48px', background: '#18244a', color: '#22d3ee', border: '1px solid #22d3ee', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>📍 Track</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'ACTIVE' && !isMobile && (
        <div style={styles.glassCard}>
          <table style={styles.table}>
            <thead><tr><th style={styles.th}>Vehicle / Driver</th><th style={styles.th}>Route</th><th style={{...styles.th, color: '#2fe39b'}}>HSD Balance</th><th style={{...styles.th, color: '#ffb224'}}>Cash Balance</th><th style={{...styles.th, textAlign: 'center'}}>Track</th><th style={{...styles.th, textAlign: 'center'}}>Action</th></tr></thead>
            <tbody>
              {activeTrips.length === 0 ? <tr><td colSpan={6} style={{padding: '20px', textAlign: 'center', color: '#5d7196'}}>No matching active trips found.</td></tr> : 
               activeTrips.map(t => {
                const mRoute = findRoute(t.consignee_name || t.Consignee_Name);
                
                let hTarget = parseFloat(getVal(t, ['fixedhsd', 'fixedhsdqty'])) || 0;
                if(hTarget === 0) hTarget = parseFloat(getVal(mRoute, ['fixedhsdqty', 'fixedhsd', 'hsd', 'fuel'])) || 0;
                
                let cTarget = parseFloat(getVal(t, ['fixedcash', 'fixedcashamt'])) || 0;
                if(cTarget === 0) cTarget = parseFloat(getVal(mRoute, ['fixedcashamt', 'fixedcash', 'cash'])) || 0;

                const paidCash = parseFloat(t.office_cash_paid||0) + parseFloat(t.bank_paid||0) + parseFloat(t.pump_cash_advance||0);
                const hsdIssued = parseFloat(t.hsd_issued||0);

                return (
                <tr key={t.id}>
                  <td style={styles.td}>
                     <b style={{fontSize:'14px', color:'#fff'}}>{t.vehicle_no || t.Vehical_No}</b><br/>
                     <span style={{fontSize:'11px', color:'#9aadd4'}}>{t.driver_name || t.Driver_Name}</span><br/>
                     <span style={{fontSize:'10px', color:'#ffb224', fontWeight:'bold'}}>{t.Operating_Company || t.operating_company || 'PRASAD TRANSPORT'}</span>
                     
                     {/* 🌟 EXTRA INFO ADDED IN LIVE TRACKING */}
                     <div style={{marginTop:'5px', fontSize:'10px', color:'#c4d1ea'}}>
                        Ld: {t.start_date || t.Loading_Date || t.loading_date || '-'}<br/>
                        Ch: {t.challan_no || t.Challan_No || '-'}<br/>
                        Ph: {t.driver_mobil_no || t.driver_mobile || '-'}
                     </div>
                  </td>
                  <td style={styles.td}>
                     <span style={{fontSize:'11px', color:'#22d3ee', fontWeight:'bold'}}>{t.trip_id || t.Trip_ID}</span>
                     {(() => { const p = tripStatusPill(t.trip_status); return <span className={`pt-pill ${p.cls}`} style={{marginLeft:'8px'}}>{p.label}</span>; })()}
                     <br/>
                     {t.loading_point || t.Loading_Point} ➔ {t.consignee_name || t.Consignee_Name}<RtkmBadge t={t} />
                     <LastTollBadge tripId={t.id} />
                  </td>
                  <td style={{...styles.td, color: '#2fe39b'}}><b>{hsdIssued}</b> / {hTarget} L<br/>Bal: {hTarget - hsdIssued} L</td>
                  <td style={{...styles.td, color: '#ffb224'}}><b>₹{paidCash}</b> / ₹{cTarget}<br/>Bal: ₹{cTarget - paidCash}</td>
                  <td style={{...styles.td, textAlign: 'center'}}><button onClick={() => { setActiveTrip(t); setTrackMode('ROUTE'); setShowTrackModal(true); }} style={{...styles.btn, background: '#18244a', color: '#22d3ee', border: '1px solid #22d3ee'}}>📍 Map</button></td>
                  <td style={{...styles.td, textAlign: 'center'}}>
                    <button onClick={() => openPaymentModal(t)} style={{...styles.btn, background: '#8b5cf6', marginRight: '5px', marginBottom:'5px'}}>💸 Pay</button>
                    <button onClick={() => openFuelModal(t)} style={{...styles.btn, background: '#f59e0b', marginRight: '5px'}}>⛽ Fuel</button>
                    <button onClick={() => { setActiveTrip(t); setUnloadData({ unloading_date: new Date().toISOString().split('T')[0], loaded_qty: String(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || ''), unloaded_qty: '', shortage_qty: '', penalty_rate: '', shortage_penalty: '', unloading_location: t.consignee_name || t.Consignee_Name || '', remarks: '' }); setShowUnloadModal(true); }} style={{...styles.btn, background: '#10b981', marginTop:'5px'}}>✅ Unload</button>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
            <GlobalPagination {...pgActiveTrips} />
        </div>
      )}

      {/* 📱 MOBILE: history as cards */}
      {activeTab === 'COMPLETED' && isMobile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {completedTrips.length === 0 ? <div style={{ padding: '30px', textAlign: 'center', color: '#5d7196' }}>No matching completed trips found.</div> :
           pgCompletedTrips.slice.map(t => (
            <div key={t.id} style={{ background: 'rgba(24, 36, 74,0.5)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <b style={{ fontSize: '16px', color: '#22d3ee' }}>{t.vehicle_no || t.Vehical_No}</b>
                <span style={{ fontSize: '11px', color: '#ffb224', fontWeight: 'bold' }}>{t.trip_id || t.Trip_ID}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#c4d1ea', margin: '6px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.loading_point || t.Loading_Point} ➔ {t.consignee_name || t.Consignee_Name}<RtkmBadge t={t} />
              </div>
              <div style={{ fontSize: '11px', color: '#9aadd4' }}>Ld: {t.start_date || t.Loading_Date || '-'} · Un: {t.unloading_date || '-'} · {t.driver_name || t.Driver_Name || '—'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', gap: '8px' }}>
                <div style={{ fontSize: '12px' }}>
                  <span style={{ color: '#9aadd4' }}>Gross ₹{(parseFloat(t.gross_freight || t.Gross_Freight) || 0).toLocaleString('en-IN')}</span>
                  <span style={{ color: '#ff6b81', marginLeft: '8px' }}>Exp ₹{(parseFloat(t.total_expense) || 0).toLocaleString('en-IN')}</span>
                  <b style={{ color: '#2fe39b', marginLeft: '8px' }}>Bal ₹{(parseFloat(t.final_balance) || 0).toLocaleString('en-IN')}</b>
                </div>
                <button onClick={() => handleEditCompletedTrip(t)} style={{ minHeight: '44px', padding: '0 16px', background: 'rgba(34, 211, 238,0.15)', color: '#22d3ee', border: '1px solid #22d3ee', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>✏️ Edit</button>
              </div>
            </div>
          ))}
          {!historyDone && !debouncedSearch && (
            <button onClick={loadMoreHistory} disabled={loadingMore} style={{ minHeight: '52px', background: loadingMore ? '#3d548a' : '#18244a', color: '#22d3ee', border: '1px dashed #22d3ee', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
              {loadingMore ? '⌛ Loading…' : `⬇️ Aur purani trips dikhao (${HISTORY_PAGE} aur)`}
            </button>
          )}
        </div>
      )}

      {activeTab === 'COMPLETED' && !isMobile && (
        <div style={styles.glassCard}>
          <table style={{...styles.table, whiteSpace: 'nowrap'}}>
            <thead>
               <tr>
                 <th style={styles.th}>Dates (Ld / Unld)</th>
                 <th style={styles.th}>Vehicle & Driver</th>
                 <th style={styles.th}>Route & Details</th>
                 <th style={styles.th}>Financials</th>
                 <th style={{...styles.th, textAlign: 'center'}}>Action</th>
               </tr>
            </thead>
            <tbody>
              {completedTrips.length === 0 ? <tr><td colSpan={5} style={{padding: '20px', textAlign: 'center', color: '#5d7196'}}>No matching completed trips found.</td></tr> :
               completedTrips.map(t => (
                <tr key={t.id}>
                  <td style={styles.td}>
                    <div style={{fontSize:'11px', color:'#9aadd4'}}>Ld: {t.start_date || t.Loading_Date || t.loading_date || '-'}</div>
                    <div style={{fontSize:'12px', fontWeight:'bold', color:'#fff'}}>Un: {t.unloading_date || '-'}</div>
                  </td>
                  <td style={styles.td}>
                    <b style={{fontSize:'14px', color:'#22d3ee'}}>{t.vehicle_no || t.Vehical_No}</b><br/>
                    <span style={{fontSize:'11px'}}>{t.driver_name || t.Driver_Name || 'No Driver'}</span><br/>
                    <span style={{fontSize:'10px', color:'#9aadd4'}}>Ph: {t.driver_mobil_no || t.driver_mobile || '-'}</span>
                  </td>
                  <td style={styles.td}>
                    <span style={{fontSize:'11px', color:'#ffb224', fontWeight:'bold'}}>{t.trip_id || t.Trip_ID}</span> | <span style={{fontSize:'11px', color:'#c4d1ea'}}>Ch: {t.challan_no || t.Challan_No || '-'}</span><br/>
                    {t.loading_point || t.Loading_Point} ➔ {t.consignee_name || t.Consignee_Name}<RtkmBadge t={t} /><br/>
                    <span style={{fontSize:'10px', color:'#2fe39b', fontWeight:'bold'}}>{t.Operating_Company || t.operating_company || 'PRASAD TRANSPORT'}</span> | <span style={{fontSize:'10px', color:'#9aadd4'}}>{t.customer_name || t.Customer || t.Registered_Assessee || ''}</span>
                  </td>
                  <td style={styles.td}>
                     <div style={{fontSize:'11px', color:'#9aadd4'}}>Gross: ₹{t.gross_freight || t.Gross_Freight || 0}</div>
                     <div style={{fontSize:'11px', color:'#ff6b81'}}>Exp: ₹{t.total_expense || 0}</div>
                     <div style={{fontSize:'13px', color:'#2fe39b', fontWeight:'bold'}}>Bal: ₹{t.final_balance || 0}</div>
                  </td>
                  <td style={{...styles.td, textAlign: 'center'}}>
                     <button onClick={() => handleEditCompletedTrip(t)} style={{...styles.btn, background: 'rgba(34, 211, 238, 0.2)', color: '#22d3ee', border: '1px solid #22d3ee'}}>✏️ Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
            <GlobalPagination {...pgCompletedTrips} />
          {!historyDone && !debouncedSearch && (
            <button onClick={loadMoreHistory} disabled={loadingMore} style={{ width: '100%', marginTop: '14px', minHeight: '48px', background: loadingMore ? '#3d548a' : 'transparent', color: '#22d3ee', border: '1px dashed #22d3ee', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>
              {loadingMore ? '⌛ Loading…' : `⬇️ Load ${HISTORY_PAGE} more completed trips`}
            </button>
          )}
        </div>
      )}
      {activeTab === 'COMPLETED' && (debouncedSearch || historyFromDate || historyToDate) && !historyDone && (
        <p style={{ fontSize: '12px', color: '#ffb224', marginTop: '10px' }}>⚠️ Search/date filter sirf loaded trips ({trips.filter(t => t.trip_status === 'COMPLETED').length}) me chal raha hai — puri history ke liye "Load more" karte jaayein.</p>
      )}
    </div>
  );
}