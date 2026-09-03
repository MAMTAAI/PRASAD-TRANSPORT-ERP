// @ts-nocheck
// 🚛 LOADING REGISTER — direct entry, loading advice, driver-app sync, sheet view.
// Live PostgreSQL, zero Firestore.
//
// Four tabs, unchanged in behaviour:
//   DIRECT ENTRY   fresh loading entry, or convert an open advice into a trip
//   LOADING ADVICE the pre-trip register (LoadingAdvice, also on PG now)
//   APP SYNC       approve the quantity the driver submitted from the app
//   SHEET VIEW     the loaded-trip register + multi-copy LR print
//
// What changed underneath:
//   • The LR / trip code is minted by the server inside the insert transaction
//     under a table lock. The Firestore version scanned the trips it happened to
//     have in memory for the highest number — two people loading at once could
//     reserve the same LR, and a stale page reliably did.
//   • 'ADVICE' is not a status in PostgreSQL. An advice is a PENDING trip that
//     carries an advice number (migration 025), which is also why converting one
//     is a PATCH of the same row: every advance already issued rides along
//     exactly as before.
//   • Deleting a loaded trip is now the server's decision. A trip with fuel,
//     advances or a bill against it is CANCELLED rather than destroyed — the old
//     screen hard-deleted it and the money it referenced became orphaned.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { extractLoadingSlip } from './lib/aiScanner';
import { parseDocDate } from './lib/tripMatch';
import { resolveRate } from './lib/freightEngine';
import { sendWhatsApp, waResultText } from './lib/waSend';
import LoadingAdvice from './LoadingAdvice';
import { speak } from './lib/voice/tts';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const OPS = `${API}/api/v1/ops`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const num = (v: any) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (n: any) => num(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const clean = (v: any) => String(v ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);

const PRODUCTS = ['HSD', 'MS', 'MS + HSD (Part Load)', 'ATF', 'LPG Bulk', 'LPG Cylinder', 'Iron/Steel', 'Cement/Coal', 'FMCG', 'Other'];

export default function LodingDetals() {
  const [activeTab, setActiveTab] = useState('MANUAL');
  const [trips, setTrips] = useState<any[]>([]);
  const [masters, setMasters] = useState<any>({ vehicles: [], drivers: [], customers: [], routes: [], companies: [], vehicle_links: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [selectedTripId, setSelectedTripId] = useState('');
  const [isNewEntry, setIsNewEntry] = useState(true);
  const [isScanningFile, setIsScanningFile] = useState(false);
  const [scanLowConf, setScanLowConf] = useState<string[]>([]);

  const [showInboxModal, setShowInboxModal] = useState(false);

  // ── Gmail invoice sync ──────────────────────────────────────────────────────
  // Pulls IOCL AC5 dispatch invoices from both mailboxes and files them as
  // loading entries. The heavy lifting is server-side; this only starts it,
  // reports what came back, and reloads the table.
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const toastTimer = useRef<any>(null);

  const say = useCallback((kind: 'ok' | 'err' | 'info', text: string, ms = 7000) => {
    setToast({ kind, text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const [isDragging, setIsDragging] = useState(false);

  const [vehSearch, setVehSearch] = useState('');
  const [showVehDropdown, setShowVehDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [routeSearchValue, setRouteSearchValue] = useState('');

  const [f, setF] = useState<any>({
    trip_code: '', customer_name: '', customer_id: '', loading_date: today(), challan_no: '',
    loading_point: '', vehicle_no: '', vehicle_id: '', registered_assessee: '', consignee_name: '',
    product_type: 'HSD', loaded_qty: '', rtkm: '', rate: '', driver_name: '', driver_id: '',
    driver_mobile: '', invoice_url: '', operating_company: '',
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [m, t] = await Promise.all([
        fetchJson(`${OPS}/masters`),
        fetchJson(`${OPS}/trips?limit=2000`),
      ]);
      setMasters(m);
      setTrips(t.trips || []);
      setF((prev: any) => prev.operating_company
        ? prev
        : { ...prev, operating_company: m.companies?.[0]?.company_name ?? 'M/S PRASAD TRANSPORT' });
    } catch (e: any) {
      setErr(`Loading register could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  }, []);

  const syncGmailInvoices = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    // Gmail + pdfplumber over a couple of hundred PDFs is minutes. Saying so is
    // better than a spinner that looks stuck.
    say('info', '📨 Reading both mailboxes… this can take a few minutes.', 600000);
    try {
      // The endpoint is admin-guarded, and the SPA authenticates with the
      // bearer token it stored at login -- the same way LiveStaffTracker and the
      // GPS emitter do. Without this the button reaches the API and comes
      // straight back UNAUTHENTICATED, which is what it did the first time.
      const token = localStorage.getItem('prasad_token');
      const res = await fetch(`${API}/api/v1/iocl/sync-gmail`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ apply: true }),
      });
      const j = await res.json().catch(() => ({}));

      if (res.status === 409) { say('info', `⏳ ${j.detail || 'A sync is already running.'}`); return; }
      if (res.status === 401 || res.status === 403) {
        say('err', '🔒 Sync needs an admin login — sign in as an admin and try again.', 12000);
        return;
      }
      if (!res.ok) { say('err', `❌ Sync failed: ${j.detail || j.error || res.status}`, 12000); return; }

      const bits = [`${j.duplicates ?? 0} already imported`];
      if (j.held_for_review) bits.push(`${j.held_for_review} held for review`);
      if (j.rejected) bits.push(`${j.rejected} not AC5 invoices`);
      say(j.inserted > 0 ? 'ok' : 'info',
          `${j.inserted > 0 ? '✅' : 'ℹ️'} ${j.message} · ${bits.join(' · ')}`, 12000);

      // Refresh regardless of the count: a concurrent hand entry may have landed
      // while the sync was running, and the table should not be stale either way.
      await loadAll();
    } catch (e: any) {
      say('err', `❌ Sync failed: ${e?.message || 'network error'}`, 12000);
    } finally {
      setSyncing(false);
    }
  }, [syncing, say, loadAll]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { setVehSearch(f.vehicle_no || ''); }, [f.vehicle_no]);

  useEffect(() => {
    const onPaste = (e: any) => {
      if (showInboxModal && e.clipboardData?.files?.length) processFile(e.clipboardData.files[0]);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [showInboxModal]);

  // ── Vehicle → driver → company resolution ─────────────────────────────────
  // `vehicle_links` is only the unreleased assignments, so this cannot resurrect
  // a driver who has since moved trucks — the Firestore version sorted every
  // historical link by date and hoped.
  const getVehicleDetails = (vNo: string) => {
    const c = clean(vNo);
    const veh = masters.vehicles.find((v: any) => clean(v.vehicle_no) === c);
    const link = masters.vehicle_links.find((l: any) => clean(l.vehicle_no) === c);
    const company = veh
      ? (masters.companies.find((x: any) => x.id === veh.company_id)?.company_name ?? veh.owner_name ?? f.operating_company)
      : f.operating_company;
    let driverName = link?.driver_name ?? '';
    let driverId = link?.driver_id ?? '';
    let mobile = link?.driver_mobile ?? '';
    if (driverName && !mobile) {
      const d = masters.drivers.find((x: any) => x.name === driverName);
      if (d) { mobile = d.mobile ?? ''; driverId = d.id; }
    }
    return { driverName, driverId, mobile, company };
  };

  // An open advice is a PENDING trip with an advice number on this vehicle.
  const findOpenAdvice = (vNo: string) => {
    const c = clean(vNo);
    if (!c) return null;
    return trips.find((t) => t.status === 'PENDING' && t.advice_no && clean(t.vehicle_no) === c) ?? null;
  };

  const maybeAttachAdvice = (vNo: string) => {
    if (!(isNewEntry && selectedTripId === 'NEW')) return false;
    const adv = findOpenAdvice(vNo);
    if (!adv) return false;
    const cashAdv = num(adv.office_cash_paid) + num(adv.bank_paid) + num(adv.pump_cash_advance);
    if (window.confirm(
      `📋 ${vNo} has an OPEN LOADING ADVICE.\n\n`
      + `Advise No: ${adv.advice_no ?? '—'} | LR: ${adv.trip_code}\n`
      + `Advances issued: ₹${inr(cashAdv)} cash + ${num(adv.hsd_issued)} L HSD\n\n`
      + `OK — attach the advice and turn it into this trip (the advances come with it)\n`
      + `Cancel — make a fresh direct entry (the advice stays open)`)) {
      handleEditTrip(adv);
      return true;
    }
    return false;
  };

  const handleEditTrip = (t: any) => {
    setIsNewEntry(false);
    setSelectedTripId(t.id);
    setF({
      trip_code: t.trip_code ?? '',
      customer_name: t.customer_name ?? t.registered_assessee ?? '',
      customer_id: t.customer_id ?? '',
      loading_date: t.loading_date ?? today(),
      challan_no: t.challan_no ?? '',
      loading_point: t.loading_point ?? '',
      vehicle_no: t.vehicle_no ?? '',
      vehicle_id: t.vehicle_id ?? '',
      registered_assessee: t.registered_assessee ?? '',
      consignee_name: t.consignee_name ?? '',
      product_type: t.product_type ?? 'HSD',
      loaded_qty: t.loaded_qty ?? t.driver_loaded_qty ?? '',
      rtkm: t.rtkm ?? '',
      rate: t.rate ?? '',
      driver_name: t.driver_name ?? '',
      driver_id: t.driver_id ?? '',
      driver_mobile: t.driver_mobile ?? '',
      invoice_url: t.invoice_url ?? '',
      operating_company: t.operating_company ?? masters.companies?.[0]?.company_name ?? 'M/S PRASAD TRANSPORT',
    });
    setActiveTab('MANUAL');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleManualTripSelect = (e: any) => {
    const tId = e.target.value;
    setSelectedTripId(tId);
    if (tId === 'NEW') {
      setIsNewEntry(true);
      setF({
        trip_code: '', customer_name: '', customer_id: '', loading_date: today(), challan_no: '',
        loading_point: '', vehicle_no: '', vehicle_id: '', registered_assessee: '', consignee_name: '',
        product_type: 'HSD', loaded_qty: '', rtkm: '', rate: '', driver_name: '', driver_id: '',
        driver_mobile: '', invoice_url: '',
        operating_company: masters.companies?.[0]?.company_name ?? 'M/S PRASAD TRANSPORT',
      });
      setRouteSearchValue('');
    } else if (tId) {
      const t = trips.find((x) => x.id === tId);
      if (t) handleEditTrip(t);
    }
  };

  const handleVehicleBlur = () => {
    setTimeout(() => setShowVehDropdown(false), 200);
    if (!vehSearch) return;
    const up = vehSearch.toUpperCase();
    const d = getVehicleDetails(up);
    setF((prev: any) => ({
      ...prev, vehicle_no: up,
      vehicle_id: masters.vehicles.find((v: any) => clean(v.vehicle_no) === clean(up))?.id ?? prev.vehicle_id,
      driver_name: d.driverName || prev.driver_name,
      driver_id: d.driverId || prev.driver_id,
      driver_mobile: d.mobile || prev.driver_mobile,
      operating_company: d.company || prev.operating_company,
    }));
    maybeAttachAdvice(up);
  };

  const handleVehicleSelect = (vNo: string) => {
    setVehSearch(vNo);
    setShowVehDropdown(false);
    const d = getVehicleDetails(vNo);
    setF((prev: any) => ({
      ...prev, vehicle_no: vNo,
      vehicle_id: masters.vehicles.find((v: any) => clean(v.vehicle_no) === clean(vNo))?.id ?? '',
      driver_name: d.driverName, driver_id: d.driverId, driver_mobile: d.mobile,
      operating_company: d.company || prev.operating_company,
    }));
    maybeAttachAdvice(vNo);
  };

  // Rate comes from the master's date-effective history, resolved for THIS
  // trip's loading date — a flat rate field only ever worked for legacy rows.
  const handleRouteSearchChange = (val: string) => {
    setRouteSearchValue(val);
    const [depotStr, consigneeStr] = val.split('➔').map((s) => s?.trim());
    if (!consigneeStr) return;
    const consigneeClean = consigneeStr.split('|')[0].trim();
    const route = masters.routes.find((r: any) =>
      (r.Consignee_Name ?? '') === consigneeClean && (r.Depot_Link ?? '') === depotStr);
    if (!route) return;
    const cust = masters.customers.find((c: any) =>
      clean(c.customer_name) === clean(route.Registered_Assessee ?? route.Customer_Name));
    setF((prev: any) => {
      const { rate } = resolveRate(route, prev.loading_date || today());
      return {
        ...prev,
        loading_point: route.Depot_Link ?? '',
        consignee_name: route.Consignee_Name ?? '',
        customer_name: route.Registered_Assessee ?? route.Customer_Name ?? prev.customer_name,
        customer_id: cust?.id ?? prev.customer_id,
        registered_assessee: route.Registered_Assessee ?? prev.registered_assessee,
        rtkm: String(route.RTKM_Distance ?? ''),
        rate: rate > 0 ? String(rate) : prev.rate,
        product_type: route.Item_Type ?? 'HSD',
      };
    });
  };

  const handleDriverSelect = (e: any) => {
    const name = e.target.value;
    const d = masters.drivers.find((x: any) => x.name === name);
    setF((prev: any) => ({ ...prev, driver_name: name, driver_id: d?.id ?? '', driver_mobile: d?.mobile ?? '' }));
  };

  // ── AI slip scan (local Gemma vision, unchanged) ───────────────────────────
  const processFile = async (file: File) => {
    setIsScanningFile(true);
    setScanLowConf([]);
    try {
      const ex = await extractLoadingSlip(file);
      const p = (ex.product_type || '').toUpperCase();
      const product = p.includes('ATF') || p.includes('JET') ? 'ATF'
        : p.includes('LPG') ? 'LPG Bulk'
        : p === 'MS' || p.includes('PETROL') ? 'MS'
        : 'HSD';
      const extractedVehicle = clean(ex.vehicle_no);
      const d = getVehicleDetails(extractedVehicle || f.vehicle_no);

      setIsNewEntry(true);
      setSelectedTripId('NEW');
      setF((prev: any) => {
        const isPartLoad = String(prev.challan_no ?? '').trim().length > 0;
        return {
          ...prev,
          operating_company: d.company || prev.operating_company,
          loading_date: parseDocDate(ex.document_date) || prev.loading_date,
          challan_no: isPartLoad && ex.challan_no ? `${prev.challan_no}, ${ex.challan_no}` : (ex.challan_no || prev.challan_no),
          vehicle_no: extractedVehicle || prev.vehicle_no,
          vehicle_id: masters.vehicles.find((v: any) => clean(v.vehicle_no) === extractedVehicle)?.id ?? prev.vehicle_id,
          customer_name: ex.customer || prev.customer_name,
          loading_point: ex.loading_point || prev.loading_point,
          consignee_name: ex.consignee_name || prev.consignee_name,
          loaded_qty: isPartLoad ? String(num(prev.loaded_qty) + num(ex.loaded_qty)) : String(ex.loaded_qty ?? ''),
          product_type: isPartLoad ? `${prev.product_type} + ${product} (Part Load)` : product,
          driver_name: ex.driver_name || d.driverName || prev.driver_name,
          driver_id: d.driverId || prev.driver_id,
          driver_mobile: d.mobile || prev.driver_mobile,
        };
      });
      setScanLowConf(ex._lowConfidence || []);
      setActiveTab('MANUAL');
      setShowInboxModal(false);
      alert(`✅ Mamta AI (local DeepSeek) scanned the slip. Verify and save.${ex._lowConfidence?.length ? ' Some fields are highlighted — check those.' : ''}`);
      try { speak('नमस्कार सर। लोडिंग स्लिप लोकल ए आई से स्कैन हो गई है। कृपया चेक करके सेव करें।'); } catch { /* voice optional */ }
    } catch (error: any) {
      alert(error?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(error?.message || '')
        ? '❌ The local AI engine (Ollama) is not running. Start it and try again.'
        : `❌ Could not read that file — ${error?.message ?? 'unknown error'}`);
    }
    setIsScanningFile(false);
  };

  const handleManualFileUpload = (e: any) => { if (e.target.files?.[0]) processFile(e.target.files[0]); };
  const handleDragOver = (e: any) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: any) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: any) => {
    e.preventDefault(); setIsDragging(false);
    if (e.dataTransfer.files?.length) processFile(e.dataTransfer.files[0]);
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleManualSave = async () => {
    if (!f.challan_no || !f.vehicle_no) return alert('⚠️ Vehicle No and Challan No are both required.');
    if (!f.loaded_qty && !window.confirm(
      'ℹ️ Loaded Qty is blank — it will save as 0.\n\nQty and rate can be filled in from Bill Management when the company challan arrives. Continue?')) return;

    const body = {
      operating_company: f.operating_company || null,
      customer_id: f.customer_id || null,
      customer_name: f.customer_name || null,
      registered_assessee: f.registered_assessee || null,
      consignee_name: f.consignee_name || null,
      vehicle_id: f.vehicle_id || null,
      vehicle_no: f.vehicle_no,
      driver_id: f.driver_id || null,
      driver_name: f.driver_name || null,
      driver_mobile: f.driver_mobile || null,
      loading_date: f.loading_date || null,
      loading_point: f.loading_point || null,
      challan_no: f.challan_no,
      product_type: f.product_type || null,
      loaded_qty: num(f.loaded_qty),
      rtkm: f.rtkm ? num(f.rtkm) : null,
      rate: f.rate ? num(f.rate) : null,
      invoice_url: f.invoice_url || null,
      office_approved_loading: true,
      sync_to_customer_portal: true,
      status: 'IN_TRANSIT',
    };

    setSaving(true);
    try {
      if (isNewEntry) {
        const out = await fetchJson(`${OPS}/trips`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        alert(`✅ Entry saved for ${f.operating_company}.\n\nLR / Trip code: ${out.trip.trip_code}`);
      } else {
        // Converting an advice: the same row becomes a real trip, so every
        // advance issued against the advice stays attached to it.
        const prior = trips.find((t) => t.id === selectedTripId);
        const out = await fetchJson(`${OPS}/trips/${selectedTripId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        alert(prior?.advice_no
          ? `✅ Advice ${prior.advice_no} converted to a live trip (${out.trip.trip_code}).\n\nEvery advance already issued has carried over.`
          : '✅ Loading entry updated.');
      }
      setSelectedTripId('');
      setIsNewEntry(true);
      setRouteSearchValue('');
      loadAll();
    } catch (e: any) {
      const hint = {
        TRIP_BILLED: 'This trip is already on a bill — its figures are frozen.',
        CONSTRAINT: 'A value was rejected by the database.',
        DUPLICATE: 'That challan or advice number already exists.',
      }[e.code];
      alert(`❌ ${hint ?? 'Entry not saved.'}\n\n${e.message}`);
    }
    setSaving(false);
  };

  const handleApproveDriverLoading = async (t: any) => {
    if (!window.confirm(`Approve the driver's quantity of ${t.driver_loaded_qty} for ${t.vehicle_no}?\n\nThe trip goes IN_TRANSIT and becomes visible on the Customer Portal.`)) return;
    setSaving(true);
    try {
      await fetchJson(`${OPS}/trips/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loaded_qty: num(t.driver_loaded_qty),
          office_approved_loading: true,
          status: 'IN_TRANSIT',
          loading_date: t.loading_date ?? today(),
          sync_to_customer_portal: true,
        }),
      });
      alert('✅ Driver loading approved and synced to the Customer Portal.');
      loadAll();
    } catch (e: any) {
      alert(`❌ Not approved.\n\n${e.message}`);
    }
    setSaving(false);
  };

  const handleDeleteTrip = async (t: any) => {
    if (!window.confirm(`⚠️ Delete loading entry ${t.trip_code} (${t.vehicle_no})?\n\nIf fuel, advances or a bill are attached the trip will be CANCELLED instead of deleted, so the money it references is never orphaned.`)) return;
    try {
      const out = await fetchJson(`${OPS}/trips/${t.id}`, { method: 'DELETE' });
      alert(out.hard_deleted
        ? `✅ ${t.trip_code} deleted.`
        : `✅ ${t.trip_code} marked CANCELLED.\n\n${out.detail ?? ''}`);
      loadAll();
    } catch (e: any) {
      const hint = { TRIP_BILLED: 'This trip is on a live bill — cancel the bill first.', TRIP_SETTLED: 'A settled trip cannot be removed.' }[e.code];
      alert(`❌ ${hint ?? 'Not deleted.'}\n\n${e.message}`);
    }
  };

  const sendCustomerWhatsApp = (t: any) => {
    const customerName = t.customer_name ?? t.registered_assessee;
    if (!customerName) return alert('⚠️ No customer name on this trip.');
    const found = masters.customers.find((c: any) => clean(c.customer_name) === clean(customerName));
    let mobile = found?.mobile ?? found?.phone ?? '';
    if (!mobile) {
      const p = window.prompt(`No mobile number on record for "${customerName}".\n\nEnter a number to send on WhatsApp:`);
      if (!p) return;
      mobile = p;
    }
    const company = t.operating_company ?? 'Prasad Transport';
    const invoiceLink = t.invoice_url ? `\n*Invoice/LR PDF:* ${t.invoice_url}` : '';
    const message = `🏢 *${String(company).toUpperCase()} - DISPATCH ALERT*\n\nDear ${customerName},\n`
      + `Your material has been loaded and dispatched successfully.\n\n`
      + `*LR / Trip ID:* ${t.trip_code}\n*Vehicle:* ${t.vehicle_no}\n*Product:* ${t.product_type ?? 'Material'}\n`
      + `*Loaded Qty:* ${t.loaded_qty ?? t.driver_loaded_qty ?? '-'}\n*Challan No:* ${t.challan_no ?? '-'}\n\n`
      + `*From:* ${t.loading_point ?? '-'}\n*To:* ${t.consignee_name ?? '-'}${invoiceLink}\n\n`
      + `You can track this live on your Customer Portal.\n\nRegards,\n${company} Team`;
    sendWhatsApp({ phone: mobile, message, tripId: t.trip_code, role: 'Customer' }).then((r) => alert(waResultText(r)));
  };

  // ── 4-copy LR print ───────────────────────────────────────────────────────
  const generateAndSavePDF = (t: any) => {
    const w = window.open('', '_blank');
    if (!w) return alert('Please allow popups to generate the PDF.');
    const copies = ['CONSIGNOR COPY', 'CONSIGNEE COPY', 'TRANSPORTER COPY', 'OFFICE COPY'];
    const printCompany = t.operating_company ?? 'M/S PRASAD TRANSPORT';
    const cd = masters.companies.find((c: any) => {
      const n = String(c.company_name ?? '').toUpperCase();
      return n && (n.includes(String(printCompany).toUpperCase()) || String(printCompany).toUpperCase().includes(n));
    }) ?? {};

    const companyNameFull = cd.company_name ?? printCompany;
    const cAddress = cd.address ?? 'H/No. 622, R/ No. 101, W/No. 12, Chapaguri Road';
    const cCity = cd.city ?? 'North Bongaigaon';
    const cState = cd.state ?? 'Assam';
    const cPin = cd.pincode ?? '783380';
    const cMobile = cd.phone ?? '9435021201, 9435022586';
    const cEmail = cd.email ?? 'support@prasadtransport.com';
    const cGST = cd.gstin ?? '18AAKFP2339R2ZG';
    const cPAN = cd.pan_no ?? 'AAKFP2339R';
    const cWebsite = 'www.prasadtransport.com';

    const nameParts = String(companyNameFull).toUpperCase().replace(/^M\/S\.? /, '').split(' ');
    const p1 = nameParts[0] ?? '';
    const p2 = nameParts.slice(1).join(' ');

    const pages = copies.map((copyName) => `
      <div style="border:2px solid black;width:100%;box-sizing:border-box;font-family:Arial,sans-serif;font-size:12px;margin-bottom:20px;page-break-inside:avoid;">
        <div style="display:flex;border-bottom:2px solid black;padding:10px;">
          <div style="flex:7;">
            <h1 style="margin:0;font-size:32px;color:#1e3a8a;font-style:italic;letter-spacing:2px;">${p1}</h1>
            <div style="font-weight:bold;margin-top:5px;">${p2}</div>
            <div style="font-weight:bold;margin-top:5px;">Fleet Owner &amp; Transport Contractor</div>
            <div>${cAddress},</div>
            <div>${cCity}, ${cState} - ${cPin}</div>
            <div><strong>GST No. : ${cGST} , PAN No. : ${cPAN}</strong></div>
          </div>
          <div style="flex:5;text-align:right;font-size:11px;line-height:1.4;">
            <div>Mobile : ${cMobile}</div><div>E-mail : ${cEmail}</div><div>Website : ${cWebsite}</div>
            <div style="margin-top:8px;font-weight:bold;border:1px solid #000;display:inline-block;padding:3px 8px;">${copyName}</div>
          </div>
        </div>
        <div style="display:flex;border-bottom:1px solid black;">
          <div style="flex:1;border-right:1px solid black;padding:5px;"><strong>C/N NO. -</strong> <span style="color:red;font-size:14px;">${t.trip_code ?? '-'}</span></div>
          <div style="flex:1;border-right:1px solid black;padding:5px;"><strong>DATE :</strong> ${t.loading_date ?? '-'}</div>
          <div style="flex:1;padding:5px;"><strong>CHALLAN :</strong> ${t.challan_no ?? '-'}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="border:1px solid #000;padding:6px;width:22%;"><strong>Consignor</strong></td><td style="border:1px solid #000;padding:6px;">${t.customer_name ?? t.registered_assessee ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>Consignee</strong></td><td style="border:1px solid #000;padding:6px;">${t.consignee_name ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>From ➔ To</strong></td><td style="border:1px solid #000;padding:6px;">${t.loading_point ?? '-'} ➔ ${t.consignee_name ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>Vehicle No</strong></td><td style="border:1px solid #000;padding:6px;font-weight:bold;">${t.vehicle_no ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>Driver / Mobile</strong></td><td style="border:1px solid #000;padding:6px;">${t.driver_name ?? '-'} / ${t.driver_mobile ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>Material</strong></td><td style="border:1px solid #000;padding:6px;">${t.product_type ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>Quantity</strong></td><td style="border:1px solid #000;padding:6px;font-weight:bold;">${t.loaded_qty ?? t.driver_loaded_qty ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>RTKM / Rate</strong></td><td style="border:1px solid #000;padding:6px;">${t.rtkm ?? '-'} km / ₹${t.rate ?? '-'}</td></tr>
          <tr><td style="border:1px solid #000;padding:6px;"><strong>Freight</strong></td><td style="border:1px solid #000;padding:6px;">${t.freight_amount ? `₹${inr(t.freight_amount)}` : 'As agreed'}</td></tr>
        </table>
        <div style="display:flex;justify-content:space-between;padding:30px 15px 10px;">
          <div style="border-top:1px solid #000;padding-top:5px;width:180px;text-align:center;">Consignor Signature</div>
          <div style="border-top:1px solid #000;padding-top:5px;width:180px;text-align:center;">Driver Signature</div>
          <div style="border-top:1px solid #000;padding-top:5px;width:180px;text-align:center;">for ${companyNameFull}</div>
        </div>
      </div>`).join('');

    w.document.write(`<html><head><title>LR_${t.trip_code}</title>
      <style>body{margin:0;padding:12px;background:#fff;} @media print{body{padding:0;} @page{margin:8mm;}}</style>
      </head><body>${pages}
      <script>window.onload=function(){setTimeout(function(){window.print()},500)}</script>
      </body></html>`);
    w.document.close();
  };

  // ── Derived lists ─────────────────────────────────────────────────────────
  const adviceCount = useMemo(() => trips.filter((t) => t.status === 'PENDING' && t.advice_no).length, [trips]);
  const pendingDriverApprovals = useMemo(
    () => trips.filter((t) => t.driver_loaded_qty != null && !t.office_approved_loading), [trips]);
  const pendingManualTrips = useMemo(
    () => trips.filter((t) => !t.office_approved_loading && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'), [trips]);

  const filteredRegister = useMemo(() => {
    let rows = trips.filter((t) => t.office_approved_loading);
    if (companyFilter) {
      rows = rows.filter((t) => String(t.operating_company ?? '').toUpperCase() === companyFilter.toUpperCase());
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter((t) => [t.vehicle_no, t.challan_no, t.trip_code, t.customer_name, t.consignee_name, t.driver_name]
        .some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return rows.sort((a, b) => String(b.loading_date ?? '').localeCompare(String(a.loading_date ?? '')));
  }, [trips, companyFilter, searchQuery]);

  const vehicleMatches = useMemo(() => {
    const q = clean(vehSearch);
    return masters.vehicles.filter((v: any) => !q || clean(v.vehicle_no).includes(q)).slice(0, 40);
  }, [masters.vehicles, vehSearch]);

  const inputStyle = { width: '100%', padding: '12px', background: '#121c38', border: '1px solid #3d548a', color: '#fff', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' as const, outline: 'none', colorScheme: 'dark' as const };
  const autoFillStyle = { ...inputStyle, background: 'rgba(34, 211, 238,0.05)', border: '1px dashed #22d3ee', color: '#9aadd4' };
  const lowConf = (field: string) => scanLowConf.includes(field) ? { borderColor: '#ffb224', background: 'rgba(255, 178, 36,0.08)' } : {};

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(22px,5vw,30px)', color: '#fff' }}>🚛 Loading Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#9aadd4', fontSize: '14px' }}>
            Live PostgreSQL · LR numbers reserved server-side{trips.length ? ` · ${trips.length} trips` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={loadAll} style={{ background: '#18244a', color: '#22d3ee', border: '1px solid #22d3ee', padding: '12px 20px', borderRadius: '30px', fontWeight: 'bold', cursor: 'pointer', fontSize: 13 }}>🔄 Refresh</button>
          <button onClick={syncGmailInvoices} disabled={syncing}
            title="Pull IOCL AC5 invoices from prasadtransport699@gmail.com and jaiswalenterprise2016@gmail.com"
            style={{ background: syncing ? '#27395f' : '#0f766e', color: syncing ? '#9aadd4' : '#ccfbf1', border: `1px solid ${syncing ? '#3d548a' : '#14b8a6'}`, padding: '12px 20px', borderRadius: '30px', fontWeight: 'bold', cursor: syncing ? 'wait' : 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>
            {syncing ? '⏳ Syncing…' : '📨 Sync Gmail Invoices'}
          </button>
          <button onClick={() => setShowInboxModal(true)}
            style={{ background: 'linear-gradient(135deg,#3b82f6,#8b5cf6)', color: '#fff', border: 'none', padding: '12px 25px', borderRadius: '30px', fontWeight: '900', cursor: 'pointer', fontSize: '14px', boxShadow: '0 5px 20px rgba(139,92,246,0.4)' }}>
            📥 Smart Inbox (Email &amp; Scan)
          </button>
        </div>
      </div>

      {/* Sync toast. Fixed so it stays visible while the table reloads under it,
          and dismissible because a 12-second message about 26 invoices is
          something an operator may want to keep reading, or get rid of. */}
      {toast && (
        <div
          onClick={() => setToast(null)}
          role="status"
          style={{
            position: 'fixed', top: 18, right: 18, zIndex: 9999, maxWidth: 460,
            padding: '14px 18px', borderRadius: 12, cursor: 'pointer', fontSize: 13, lineHeight: 1.5,
            background: toast.kind === 'ok' ? 'rgba(47, 227, 155,0.14)' : toast.kind === 'err' ? 'rgba(255, 107, 129,0.14)' : 'rgba(34, 211, 238,0.14)',
            border: `1px solid ${toast.kind === 'ok' ? '#2fe39b' : toast.kind === 'err' ? '#ff6b81' : '#22d3ee'}`,
            color: toast.kind === 'ok' ? '#a7f3d0' : toast.kind === 'err' ? '#fecaca' : '#bae6fd',
            boxShadow: '0 12px 40px rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)',
          }}
        >
          {toast.text}
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>click to dismiss</div>
        </div>
      )}

      {err && (
        <div style={{ background: 'rgba(255, 107, 129,0.1)', border: '1px solid #ff6b81', color: '#fca5a5', padding: '14px 18px', borderRadius: 12, marginBottom: 18, fontSize: 14 }}>
          ⚠️ {err}
          <div style={{ color: '#9aadd4', marginTop: 6, fontSize: 12 }}>Reads <code>{OPS}</code>. Check that the ERP API is running.</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #27395f', paddingBottom: '10px', flexWrap: 'wrap' }}>
        {[
          { k: 'MANUAL', label: '✍️ DIRECT ENTRY', color: '#2fe39b' },
          { k: 'ADVICE', label: '📋 LOADING ADVICE', color: '#ffb224', count: adviceCount },
          { k: 'AUTO', label: '📱 APP SYNC', color: '#22d3ee', count: pendingDriverApprovals.length },
          { k: 'REGISTER', label: '📋 SHEET VIEW', color: '#ffb224' },
        ].map((tb) => (
          <button key={tb.k} onClick={() => setActiveTab(tb.k)}
            style={{ padding: '10px 20px', background: activeTab === tb.k ? `${tb.color}1a` : 'transparent', color: activeTab === tb.k ? tb.color : '#9aadd4', border: 'none', borderBottom: `3px solid ${activeTab === tb.k ? tb.color : 'transparent'}`, fontWeight: 'bold', cursor: 'pointer' }}>
            {tb.label}
            {tb.count ? <span style={{ background: tb.color, color: '#121c38', padding: '1px 8px', borderRadius: '10px', fontSize: '11px', marginLeft: '4px' }}>{tb.count}</span> : null}
          </button>
        ))}
      </div>

      {activeTab === 'ADVICE' && <LoadingAdvice onChanged={loadAll} />}

      {/* ✍️ DIRECT ENTRY */}
      {activeTab === 'MANUAL' && (
        <div style={{ background: '#18244a', border: '1px solid #27395f', borderRadius: '15px', padding: 'clamp(16px,3vw,30px)' }}>
          <div style={{ marginBottom: '20px', background: 'rgba(47, 227, 155,0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(47, 227, 155,0.2)' }}>
            <label style={{ color: '#2fe39b', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>
              🔍 Start Loading Entry * {loading && <span style={{ color: '#22d3ee' }}>(loading…)</span>}
            </label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ ...inputStyle, borderColor: '#2fe39b', fontSize: 15 }}>
              <option value="">-- Choose Option --</option>
              <option value="NEW" style={{ background: '#10b981', color: '#121c38', fontWeight: 'bold' }}>➕ CREATE FRESH DIRECT ENTRY</option>
              <optgroup label="Auto-Fill from Pending Trips:">
                {pendingManualTrips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.advice_no ? `📋 ADVICE ${t.advice_no} | ` : ''}{t.vehicle_no} | {t.loading_point ?? '?'} ➔ {t.consignee_name ?? '?'}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          {selectedTripId === 'NEW' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginBottom: '20px', background: 'rgba(34, 211, 238,0.05)', padding: '15px', border: '1px dashed #22d3ee', borderRadius: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label style={{ color: '#22d3ee', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>
                  🤖 Mamta AI Scanner <span style={{ fontSize: '10px', color: '#2fe39b', border: '1px solid #2fe39b', borderRadius: '10px', padding: '1px 6px', marginLeft: '4px' }}>100% LOCAL</span>
                </label>
                <p style={{ margin: 0, color: '#9aadd4', fontSize: '12px' }}>Upload an invoice or loading slip (PDF/photo) — read on-device by DeepSeek (via Ollama), no internet. Auto-fills the form below.</p>
              </div>
              <label style={{ background: '#38bdf8', color: '#121c38', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: isScanningFile ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
                {isScanningFile ? '⏳ Scanning…' : '📎 Upload & Scan'}
                <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleManualFileUpload} disabled={isScanningFile} />
              </label>
            </div>
          )}

          {selectedTripId && (
            <>
              {!isNewEntry && f.trip_code && (
                <div style={{ background: 'rgba(255, 178, 36,0.1)', border: '1px solid #ffb224', borderRadius: '8px', padding: '10px 14px', marginBottom: '15px', fontSize: '12px', color: '#ffb224' }}>
                  📋 Editing <b>{f.trip_code}</b>
                  {trips.find((t) => t.id === selectedTripId)?.advice_no
                    ? ` — this is advice ${trips.find((t) => t.id === selectedTripId).advice_no}. Saving converts it into a live trip and every advance already issued carries over.`
                    : ' — saving updates this existing trip.'}
                </div>
              )}

              <div style={{ marginBottom: '15px' }}>
                <label style={{ color: '#ffb224', fontSize: '11px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Operating Company (drives the LR series) *</label>
                <select value={f.operating_company} onChange={(e) => setF({ ...f, operating_company: e.target.value })} style={{ ...inputStyle, borderColor: '#ffb224' }}>
                  {masters.companies.map((c: any) => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
                </select>
              </div>

              {isNewEntry && (
                <div style={{ background: 'rgba(255, 178, 36,0.1)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #ffb224' }}>
                  <label style={{ color: '#ffb224', fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔗 1. Search &amp; Select Route from RTKM Master (Optional)</label>
                  <input list="master-route-list" placeholder="🔍 Type depot or consignee to search…" value={routeSearchValue}
                    onChange={(e) => handleRouteSearchChange(e.target.value)} autoComplete="off"
                    style={{ ...inputStyle, borderColor: '#ffb224' }} />
                  <datalist id="master-route-list">
                    {masters.routes.map((r: any) => (
                      <option key={r.id} value={`${r.Depot_Link} ➔ ${r.Consignee_Name} | Rate: ₹${resolveRate(r, f.loading_date || today()).rate || '0'}`} />
                    ))}
                  </datalist>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
                <div>
                  <label style={{ color: '#9aadd4', fontSize: '11px', display: 'block', marginBottom: '5px' }}>LR No / Trip Code</label>
                  <input type="text" readOnly style={autoFillStyle}
                    value={isNewEntry ? 'auto-assigned on save' : f.trip_code}
                    title="Minted by the server inside the insert transaction, so two people cannot reserve the same LR" />
                </div>

                <div style={{ position: 'relative' }}>
                  <label style={{ color: '#22d3ee', fontSize: '11px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Vehicle No * 🔍</label>
                  <input type="text" value={vehSearch} placeholder="Type to search…"
                    onChange={(e) => { setVehSearch(e.target.value.toUpperCase()); setShowVehDropdown(true); }}
                    onFocus={() => setShowVehDropdown(true)} onBlur={handleVehicleBlur}
                    style={{ ...inputStyle, borderColor: '#22d3ee', ...lowConf('vehicle_no') }} autoComplete="off" />
                  {showVehDropdown && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#121c38', border: '1px solid #22d3ee', zIndex: 999, maxHeight: '200px', overflowY: 'auto', borderRadius: '8px', marginTop: '5px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
                      {vehicleMatches.length === 0
                        ? <div style={{ padding: '12px', color: '#5d7196', fontSize: '12px' }}>No vehicle found…</div>
                        : vehicleMatches.map((v: any) => (
                          <div key={v.id} onMouseDown={() => handleVehicleSelect(v.vehicle_no)}
                            style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #18244a', fontSize: 13, color: '#dde5f4' }}>
                            {v.vehicle_no} <span style={{ color: '#5d7196', fontSize: 11 }}>{v.vehicle_type ?? ''}{v.capacity_kl ? ` · ${v.capacity_kl} KL` : ''}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                <div>
                  <label style={{ color: '#9aadd4', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Name</label>
                  <select value={f.driver_name} onChange={handleDriverSelect} style={{ ...inputStyle, ...lowConf('driver_name') }}>
                    <option value="">-- Select Driver --</option>
                    {masters.drivers.map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: '#9aadd4', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Mobile</label>
                  <input type="text" value={f.driver_mobile} onChange={(e) => setF({ ...f, driver_mobile: e.target.value })} style={inputStyle} />
                </div>
                <div>
                  <label style={{ color: '#ffb224', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Customer Name (Billed To)</label>
                  <input type="text" list="customer-list" value={f.customer_name}
                    onChange={(e) => {
                      const c = masters.customers.find((x: any) => x.customer_name === e.target.value);
                      setF({ ...f, customer_name: e.target.value, customer_id: c?.id ?? '' });
                    }}
                    style={{ ...inputStyle, ...lowConf('customer') }} placeholder="e.g. INDIAN OIL CORPORATION LTD" />
                  <datalist id="customer-list">
                    {masters.customers.map((c: any) => <option key={c.id} value={c.customer_name} />)}
                  </datalist>
                  {f.customer_name && !f.customer_id && (
                    <div style={{ color: '#ffb224', fontSize: 10, marginTop: 4 }}>⚠️ Not in the customer master — a bill cannot be raised until it is linked.</div>
                  )}
                </div>
                <div><label style={{ color: '#ffb224', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Loading Point</label>
                  <input type="text" value={f.loading_point} onChange={(e) => setF({ ...f, loading_point: e.target.value })} style={{ ...inputStyle, ...lowConf('loading_point') }} /></div>
                <div><label style={{ color: '#ffb224', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee / Destination</label>
                  <input type="text" value={f.consignee_name} onChange={(e) => setF({ ...f, consignee_name: e.target.value })} style={{ ...inputStyle, ...lowConf('consignee_name') }} /></div>
                <div><label style={{ color: '#ffb224', fontSize: '11px', display: 'block', marginBottom: '5px' }}>RTKM (Distance)</label>
                  <input type="number" value={f.rtkm} onChange={(e) => setF({ ...f, rtkm: e.target.value })} style={inputStyle} /></div>
                <div><label style={{ color: '#ffb224', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Rate / Freight</label>
                  <input type="number" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} style={inputStyle} /></div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '25px' }}>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loading Date *</label>
                  <input type="date" value={f.loading_date} onChange={(e) => setF({ ...f, loading_date: e.target.value })} style={{ ...inputStyle, colorScheme: 'dark', ...lowConf('document_date') }} />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Challan / Invoice No *</label>
                  <input type="text" value={f.challan_no} onChange={(e) => setF({ ...f, challan_no: e.target.value })} style={{ ...inputStyle, borderColor: '#ffb224', ...lowConf('challan_no') }} placeholder="Enter challan no" />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Product Type / Material *</label>
                  <select value={f.product_type} onChange={(e) => setF({ ...f, product_type: e.target.value })} style={inputStyle}>
                    {PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
                    {!PRODUCTS.includes(f.product_type) && f.product_type && <option value={f.product_type}>{f.product_type}</option>}
                  </select>
                </div>
                <div>
                  <label style={{ color: '#2fe39b', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loaded Qty / Weight</label>
                  <input type="number" value={f.loaded_qty} onChange={(e) => setF({ ...f, loaded_qty: e.target.value })}
                    style={{ ...inputStyle, borderColor: '#2fe39b', fontSize: '16px', fontWeight: 'bold', color: '#2fe39b', ...lowConf('loaded_qty') }} placeholder="0.00" />
                </div>
              </div>

              <button onClick={handleManualSave} disabled={saving}
                style={{ width: '100%', background: saving ? '#27395f' : 'linear-gradient(135deg,#2fe39b,#2fe39b)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(47, 227, 155,0.4)' }}>
                {saving ? '⌛ Saving…' : isNewEntry ? '🚀 SAVE LOADING ENTRY & DISPATCH' : '💾 UPDATE / CONVERT TO TRIP'}
              </button>
            </>
          )}
        </div>
      )}

      {/* 📱 APP SYNC */}
      {activeTab === 'AUTO' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0
            ? <div style={{ color: '#5d7196', padding: 30, textAlign: 'center', gridColumn: '1 / -1', background: 'rgba(24, 36, 74,0.3)', borderRadius: 14, border: '1px dashed #27395f' }}>No pending approvals from the driver app.</div>
            : pendingDriverApprovals.map((t) => (
              <div key={t.id} style={{ background: '#18244a', border: '1px solid #22d3ee', borderRadius: '15px', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <span style={{ color: '#22d3ee', fontWeight: 'bold', fontSize: '18px' }}>{t.vehicle_no}</span>
                  <span style={{ background: '#27395f', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.trip_code}</span>
                </div>
                <div style={{ marginBottom: '10px' }}><span className="pt-pill pt-pill--loading">Loading</span></div>
                <div style={{ color: '#9aadd4', fontSize: '13px', marginBottom: '15px' }}>📍 {t.loading_point ?? '?'} ➔ {t.consignee_name ?? '?'}</div>
                <div style={{ background: 'rgba(34, 211, 238,0.1)', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                  <div style={{ fontSize: '12px', color: '#9aadd4' }}>Driver's submitted qty:</div>
                  <div style={{ fontSize: '24px', fontWeight: '900', color: '#22d3ee' }}>{t.driver_loaded_qty}</div>
                  {t.driver_loading_photo && (
                    <a href={t.driver_loading_photo} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#2fe39b' }}>📎 View slip photo</a>
                  )}
                </div>
                <button onClick={() => handleApproveDriverLoading(t)} disabled={saving}
                  style={{ width: '100%', background: '#38bdf8', color: '#121c38', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                  ✅ Verify &amp; Sync to Customer Portal
                </button>
              </div>
            ))}
        </div>
      )}

      {/* 📋 SHEET VIEW */}
      {activeTab === 'REGISTER' && (
        <div style={{ background: '#18244a', borderRadius: '15px', padding: '20px', border: '1px solid #27395f' }}>
          <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', flexWrap: 'wrap' }}>
            <input type="text" placeholder="🔍 Search vehicle, challan, trip code, party…" value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: 2, minWidth: 220, borderColor: '#22d3ee' }} />
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 180, borderColor: '#ffb224', color: '#ffb224' }}>
              <option value="">🏢 All Companies</option>
              {masters.companies.map((c: any) => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
            </select>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
              <thead style={{ background: '#121c38', color: '#ffb224', fontSize: '11px', textTransform: 'uppercase' }}>
                <tr>
                  <th style={{ padding: '15px' }}>LR / Trip</th>
                  <th style={{ padding: '15px', color: '#ffb224' }}>Company</th>
                  <th style={{ padding: '15px', color: '#22d3ee' }}>Customer / Party</th>
                  <th style={{ padding: '15px' }}>Loading Date</th>
                  <th style={{ padding: '15px' }}>Challan</th>
                  <th style={{ padding: '15px' }}>From ➔ To</th>
                  <th style={{ padding: '15px', color: '#22d3ee' }}>Vehicle</th>
                  <th style={{ padding: '15px' }}>Product</th>
                  <th style={{ padding: '15px', color: '#2fe39b' }}>Loaded Qty</th>
                  <th style={{ padding: '15px' }}>Driver</th>
                  <th style={{ padding: '15px' }}>Status</th>
                  <th style={{ padding: '15px', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={12} style={{ padding: 25, textAlign: 'center', color: '#22d3ee' }}>Loading from PostgreSQL…</td></tr>
                ) : filteredRegister.length === 0 ? (
                  <tr><td colSpan={12} style={{ padding: 25, textAlign: 'center', color: '#5d7196' }}>No loaded trips for these filters.</td></tr>
                ) : filteredRegister.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #27395f', color: '#c4d1ea', fontSize: '12px' }}>
                    <td style={{ padding: '12px 15px', color: '#22d3ee', fontWeight: 'bold' }}>{t.trip_code}</td>
                    <td style={{ padding: '12px 15px', color: '#ffb224' }}>{t.operating_company ?? '—'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.customer_name ?? '—'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.loading_date ?? '—'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.challan_no ?? '—'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.loading_point ?? '?'} ➔ {t.consignee_name ?? '?'}</td>
                    <td style={{ padding: '12px 15px', color: '#22d3ee', fontWeight: 'bold' }}>{t.vehicle_no}</td>
                    <td style={{ padding: '12px 15px' }}>{t.product_type ?? '—'}</td>
                    <td style={{ padding: '12px 15px', color: '#2fe39b', fontWeight: 'bold' }}>{t.loaded_qty ?? '—'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.driver_name ?? '—'}</td>
                    <td style={{ padding: '12px 15px' }}>
                      <span className={`pt-pill ${t.status === 'COMPLETED' ? 'pt-pill--completed' : t.status === 'CANCELLED' ? '' : 'pt-pill--loading'}`}>{t.status}</span>
                      {t.bill_no && <div style={{ fontSize: 10, color: '#2fe39b', marginTop: 3 }}>🧾 {t.bill_no}</div>}
                    </td>
                    <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button onClick={() => handleEditTrip(t)} title="Edit" style={{ background: 'rgba(34, 211, 238,.12)', border: '1px solid #22d3ee', color: '#22d3ee', borderRadius: 6, padding: '6px 9px', cursor: 'pointer', fontSize: 12 }}>✏️</button>
                        <button onClick={() => generateAndSavePDF(t)} title="4-copy LR print" style={{ background: 'rgba(255, 178, 36,.12)', border: '1px solid #ffb224', color: '#ffb224', borderRadius: 6, padding: '6px 9px', cursor: 'pointer', fontSize: 12 }}>🖨️</button>
                        <button onClick={() => sendCustomerWhatsApp(t)} title="WhatsApp the customer" style={{ background: 'rgba(34,197,94,.12)', border: '1px solid #22c55e', color: '#22c55e', borderRadius: 6, padding: '6px 9px', cursor: 'pointer', fontSize: 12 }}>💬</button>
                        <button onClick={() => handleDeleteTrip(t)} title="Delete / cancel" style={{ background: 'rgba(255, 107, 129,.12)', border: '1px solid #ff6b81', color: '#ff6b81', borderRadius: 6, padding: '6px 9px', cursor: 'pointer', fontSize: 12 }}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 📥 SMART INBOX */}
      {showInboxModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10, 16, 36,0.9)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setShowInboxModal(false)}>
          <div onClick={(e) => e.stopPropagation()} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
            style={{ width: '100%', maxWidth: 620, background: '#121c38', border: `2px dashed ${isDragging ? '#2fe39b' : '#22d3ee'}`, borderRadius: 18, padding: 34, textAlign: 'center' }}>
            <h3 style={{ color: '#22d3ee', marginTop: 0 }}>📥 Smart Inbox</h3>
            <p style={{ color: '#9aadd4', fontSize: 13 }}>
              Drop a loading slip or invoice here, paste one from the clipboard, or browse. It is read on-device by DeepSeek (via Ollama) — nothing leaves this machine.
            </p>
            <div style={{ fontSize: 48, margin: '18px 0' }}>{isScanningFile ? '⏳' : isDragging ? '📥' : '📄'}</div>
            <button onClick={syncGmailInvoices} disabled={syncing}
              style={{ background: syncing ? '#27395f' : '#0f766e', color: syncing ? '#9aadd4' : '#ccfbf1', border: `1px solid ${syncing ? '#3d548a' : '#14b8a6'}`, padding: '12px 26px', borderRadius: 10, fontWeight: 900, cursor: syncing ? 'wait' : 'pointer', display: 'block', margin: '0 auto 14px' }}>
              {syncing ? '⏳ Syncing both mailboxes…' : '📨 Sync Gmail Invoices'}
            </button>
            <div style={{ fontSize: 11, color: '#5d7196', marginBottom: 14 }}>
              prasadtransport699@gmail.com &nbsp;·&nbsp; jaiswalenterprise2016@gmail.com
            </div>
            <label style={{ background: '#38bdf8', color: '#121c38', padding: '12px 26px', borderRadius: 10, fontWeight: 900, cursor: isScanningFile ? 'not-allowed' : 'pointer', display: 'inline-block' }}>
              {isScanningFile ? 'Scanning…' : '📎 Browse a file'}
              <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleManualFileUpload} disabled={isScanningFile} />
            </label>
            <button onClick={() => setShowInboxModal(false)} style={{ display: 'block', margin: '18px auto 0', background: 'transparent', border: '1px solid #3d548a', color: '#9aadd4', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
