// @ts-nocheck
import React, { useState, useEffect } from 'react';

import GlobalPagination, { usePagination } from './components/GlobalPagination';
import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const MASTERS_API = `${API}/api/v1/masters`;
const QUEUES_API = `${API}/api/v1/queues`;
const OPS_API = `${API}/api/v1/ops`;

const apiJson = async (url: string, opts: RequestInit = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
const mastersFetch = async (path: string, opts?: RequestInit) => {
  const res = await fetch(`${MASTERS_API}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

import { extractJsonFromImage } from './lib/aiScanner';
import { auditBill, settlementGate, VERDICTS } from './lib/pumpBillAudit.mjs';

export default function FuelMgmt() {
  // 📄 Scan a petrol-pump bill (PDF/photo) locally → auto-fill Physical Bill Amount.
  const [scanningPump, setScanningPump] = useState(false);
  const [scannedPumpItems, setScannedPumpItems] = useState<any[]>([]);
  // The parsed bill, its line-by-line audit against our memos, and what the
  // desk has decided about each flagged line.
  const [scanMeta, setScanMeta] = useState<any>(null);
  const [billResolutions, setBillResolutions] = useState<Record<number, string>>({});
  const [auditFilter, setAuditFilter] = useState<'FLAGGED' | 'ALL'>('FLAGGED');
  const [linkingIdx, setLinkingIdx] = useState<number | null>(null);
  // Inline correction of a bill line we read wrong. Keyed by index.
  const [editingBillIdx, setEditingBillIdx] = useState<number | null>(null);
  const [billEdit, setBillEdit] = useState<any>({});
  const [savingMemo, setSavingMemo] = useState(false);
  const [activeTab, setActiveTab] = useState('RECON');
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]); 
  const [fuelVendors, setFuelVendors] = useState<any[]>([]);
  const [fuelHistory, setFuelHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 📝 1. MULTI-PUMP MEMO STATE
  const [memoData, setMemoData] = useState({
    date: new Date().toISOString().split('T')[0], 
    vehicle_no: '', 
    route_name: '', 
    driver_name: '',
    fixed_hsd: '', 
    fixed_cash: '',
    memo_no: `MEMO-${Math.floor(Math.random()*10000)}`
  });
  
  const [pumps, setPumps] = useState([
    { id: 1, vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }
  ]);

  // 🧾 2. BILL RECONCILIATION STATE (WITH DATES & EDITING)
  const [reconVendor, setReconVendor] = useState('');
  const [reconFromDate, setReconFromDate] = useState('');
  const [reconToDate, setReconToDate] = useState('');
  const [unbilledSlips, setUnbilledSlips] = useState<any[]>([]);
  const [selectedSlips, setSelectedSlips] = useState<string[]>([]);
  const [vendorBillAmount, setVendorBillAmount] = useState('');
  
  // ✏️ SLIP EDITING STATE
  const [editingSlipId, setEditingSlipId] = useState('');
  const [editSlipData, setEditSlipData] = useState({ liters: '', rate: '', amount: '' });

  // 📈 3. HISTORY FILTERS
  const [historyVendor, setHistoryVendor] = useState('ALL');
  const [historyFromDate, setHistoryFromDate] = useState('');
  const [historyToDate, setHistoryToDate] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  // Settled memos are hidden by default: 540 of 1,042 rows are finished work,
  // and burying the ones still owed under them is what made the screen unusable.
  const [showSettled, setShowSettled] = useState(false);
  const [unlinked, setUnlinked] = useState<any>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap = await apiJson(`${MASTERS_API}/vehicles`);
      setVehicles(vSnap.vehicles ?? []);

      const dSnap = await apiJson(`${MASTERS_API}/drivers`);
      setDrivers(dSnap.drivers ?? []);

      const venSnap = await apiJson(`${MASTERS_API}/vendors`);
      const allVendors = venSnap.vendors ?? [];
      setFuelVendors(allVendors.filter(v => v.vendor_type === 'Fuel Pump' || v.vendor_type === 'Fuel Pump (HSD)'));

      const fSnap = await apiJson(`${QUEUES_API}/fuel-entries?limit=2000`);
      // Already newest-first from the API (entry_date DESC).
      setFuelHistory(fSnap.entries ?? []);

      // The memos that name a pump the vendor master does not hold. Failing to
      // load this must not take the history screen down with it.
      try {
        setUnlinked(await apiJson(`${QUEUES_API}/fuel-unlinked-pumps`));
      } catch { setUnlinked(null); }
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  /**
   * Attach every memo carrying one nickname to the pump the master holds. Only
   * offered where exactly one vendor matches; the confirm spells out how many
   * memos and how much money move, because after this they start appearing in
   * that pump's fortnight bill.
   */
  const linkPump = async (n: any) => {
    if (!n?.suggested_vendor_id) return;
    const money = `₹${Math.round(Number(n.amount)).toLocaleString('en-IN')}`;
    const NL = String.fromCharCode(10);
    if (!window.confirm(
      `"${n.vendor_name}" ke ${n.slips} slip (${money}) ko` + NL
      + `"${n.suggested_vendor_name}" se jod dein?` + NL + NL
      + `Iske baad ye us pump ke 15-din ke bill me aayenge.` + NL
      + `Settle ho chuke slip nahi chhuenge.`)) return;
    try {
      const r = await apiJson(`${QUEUES_API}/fuel-link-pump`, {
        method: 'POST',
        body: JSON.stringify({ vendor_name: n.vendor_name, vendor_id: n.suggested_vendor_id }),
      });
      alert(`✅ ${r.linked} slip jud gaye — ${r.vendor_name}.`);
      await fetchData();
    } catch (e: any) {
      alert(`❌ Nahi jud paaye: ${e?.message ?? 'unknown'}`);
    }
  };

  // --- MULTI-PUMP LOGIC ---
  const handleAddPump = () => {
    if (pumps.length >= 4) return alert("⚠️ Maximum 4 pumps allowed per trip memo!");
    setPumps([...pumps, { id: Date.now(), vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }]);
  };

  const handleRemovePump = (id: number) => {
    setPumps(pumps.filter(p => p.id !== id));
  };

  const handlePumpChange = (id: number, field: string, value: string) => {
    const updated = pumps.map(p => {
      if (p.id === id) {
        const newP = { ...p, [field]: value };
        if (field === 'vendor_id') {
          const ven = fuelVendors.find(v => v.id === value);
          newP.vendor_name = ven ? ven.vendor_name : '';
          newP.mobile = ven ? ven.mobile_no : '';
        }
        if (field === 'qty' || field === 'rate') {
          const q = parseFloat(field === 'qty' ? value : newP.qty || '0');
          const r = parseFloat(field === 'rate' ? value : newP.rate || '0');
          newP.amount = (q * r).toFixed(2);
        }
        return newP;
      }
      return p;
    });
    setPumps(updated);
  };

  const handleSaveMultiMemo = async () => {
    if (!memoData.vehicle_no) return alert("⚠️ Select Vehicle!");
    if (!memoData.driver_name) return alert("⚠️ Select Driver! (Required for Settlement)");
    
    try {
      let totalAmount = 0;
      let advancePosted = false;

      // 🚨 DATA-FLOW FIX (audit): fuel memo ka kharcha pehle kisi TRIP tak
      // pahunchta hi nahi tha => dono P&L screens (jo trips ke total_expense
      // se fuel nikalti hain) me diesel GAYAB rehta tha. Ab memo save par
      // vehicle+date se trip match hoti hai — single confident match par
      // trip ka total_expense/diesel_amount bump hota hai.
      let matchedTrip = null;
      try {
        const normV = (s) => String(s || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
        const tSnap = await apiJson(`${OPS_API}/trips?limit=1000`);
        const memoTs = new Date(`${memoData.date}T12:00:00`).getTime();
        const cands = (tSnap.trips ?? []).filter(t => {
          if (normV(t.vehicle_no || t.Vehical_No) !== normV(memoData.vehicle_no)) return false;
          const ld = String(t.loading_date || t.Loading_Date || t.start_date || '').slice(0, 10);
          if (!ld) return false;
          const from = new Date(`${ld}T00:00:00`).getTime();
          const ud = String(t.unloading_date || t.Unloading_Date || '').slice(0, 10);
          const to = ud ? new Date(`${ud}T23:59:59`).getTime()
            : (String(t.trip_status || t.Trip_Status) !== 'COMPLETED' ? Date.now() : from + 15 * 86400000);
          return memoTs >= from && memoTs <= to;
        });
        if (cands.length === 1) matchedTrip = cands[0];
      } catch (me) { console.warn('Fuel→trip match skipped:', me?.message); }

      let dieselExpense = 0; // sirf FUEL rows (ADVANCE = driver khata, expense nahi)

      for (const pump of pumps) {
        if (!pump.vendor_id || !pump.qty) continue;

        const amt = parseFloat(pump.amount || '0');
        const cashAmt = parseFloat(pump.cash_advance || '0');
        totalAmount += amt;
        if (pump.fuel_type !== 'ADVANCE') dieselExpense += amt;

        // CHHINNAMASTA owns fuel_entries and re-applies its two guards (slip
        // arithmetic within tolerance, one memo per pump) on the way in, so the
        // slip goes through the ops endpoint rather than a direct insert.
        await apiJson(`${OPS_API}/trips/${matchedTrip?.id ?? 'unlinked'}/fuel-slip`, {
          method: 'POST',
          body: JSON.stringify({
            entry_date: memoData.date,
            vehicle_no: memoData.vehicle_no,
            route_name: memoData.route_name,
            driver_name: memoData.driver_name,
            memo_no: memoData.memo_no,
            vendor_id: pump.vendor_id,
            vendor_name: pump.vendor_name,
            fuel_type: pump.fuel_type,
            liters: Number(pump.qty) || 0,
            rate: Number(pump.rate) || 0,
            amount: amt,
            cash_given_to_pump: Number(pump.cash_advance) || 0,
            pump_mobile: pump.mobile,
          }),
        });

        // 🔥 AUTO-POST TO DRIVER SETTLEMENT (IF ADVANCE)
        if (pump.fuel_type === 'ADVANCE' && memoData.driver_name) {
          const totalDriverAdvance = amt + cashAmt; 
          
          // The khata is written by the masters module now — the same table
          // the ops and billing modules write, so the Driver Master and Master
          // Trip Settlement both see this advance.
          await apiJson(`${MASTERS_API}/drivers/${encodeURIComponent(memoData.driver_name)}/ledger`, {
            method: 'POST',
            body: JSON.stringify({
              txn_type: 'ADVANCE_GIVEN',
              amount: totalDriverAdvance,
              txn_date: memoData.date,
              remarks: `Fuel/Cash Advance at ${pump.vendor_name} (Memo: ${memoData.memo_no})`,
            }),
          }).catch(e => console.warn('driver khata:', e?.message));
          advancePosted = true;
        }
      }

      // 🔗 Trip P&L propagation: matched trip ka total_expense + diesel_amount
      // bump — ab fuel dono P&L screens par usi trip ke kharch me dikhta hai.
      // The fuel-slip endpoint already attributes the slip to the trip, so the
      // trip's expense is derived from fuel_entries rather than bumped by a
      // second write that could drift from it.

      const successMsg = `✅ Trip Fuel Memo Generated!\n\n${matchedTrip ? `🔗 Trip ${matchedTrip.trip_id || matchedTrip.Trip_ID || matchedTrip.id} se link — ₹${dieselExpense.toLocaleString('en-IN')} diesel trip kharch me juda (P&L me dikhega).` : '⚠️ Koi single matching trip nahi mili — kharcha trip P&L se nahi juda (memo phir bhi saved hai).'}\n\nNote: Vendor Balance will update ONLY after you Verify the Bill in Reconciliation Tab.`;
      alert(successMsg);

      setMemoData({ date: new Date().toISOString().split('T')[0], vehicle_no: '', route_name: '', driver_name: '', fixed_hsd: '', fixed_cash: '', memo_no: `MEMO-${Math.floor(Math.random()*10000)}` });
      setPumps([{ id: 1, vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }]);
      fetchData();
    } catch (e) { alert("❌ Error saving memo."); console.error(e); }
  };

  // --- RECONCILIATION LOGIC ---
  const handleVendorSelectRecon = (vid: string) => {
    setReconVendor(vid);
    refreshUnbilledSlips(vid);
  };

  const refreshUnbilledSlips = (vid: string) => {
    const slips = fuelHistory.filter(f => f.vendor_id === vid && f.bill_status === 'UNBILLED');
    setUnbilledSlips(slips);
    setSelectedSlips(slips.map(s => s.id)); 
  };

  // 🚀 QUICK DATE SELECTORS (1-15 & 16-End)
  const setQuickDate = (period: string) => {
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth(); 

    if (period === 'LAST_H1') {
       m = m - 1; if(m < 0) { m = 11; y = y - 1; }
       setReconFromDate(`${y}-${String(m+1).padStart(2,'0')}-01`);
       setReconToDate(`${y}-${String(m+1).padStart(2,'0')}-15`);
    } else if (period === 'LAST_H2') {
       m = m - 1; if(m < 0) { m = 11; y = y - 1; }
       const lastDay = new Date(y, m + 1, 0).getDate();
       setReconFromDate(`${y}-${String(m+1).padStart(2,'0')}-16`);
       setReconToDate(`${y}-${String(m+1).padStart(2,'0')}-${lastDay}`);
    } else if (period === 'THIS_H1') {
       setReconFromDate(`${y}-${String(m+1).padStart(2,'0')}-01`);
       setReconToDate(`${y}-${String(m+1).padStart(2,'0')}-15`);
    } else if (period === 'THIS_H2') {
       const lastDay = new Date(y, m + 1, 0).getDate();
       setReconFromDate(`${y}-${String(m+1).padStart(2,'0')}-16`);
       setReconToDate(`${y}-${String(m+1).padStart(2,'0')}-${lastDay}`);
    }
  };

  const filteredUnbilledSlips = unbilledSlips.filter(s => {
    let matchDate = true;
    if (reconFromDate && s.date < reconFromDate) matchDate = false;
    if (reconToDate && s.date > reconToDate) matchDate = false;
    return matchDate;
  });
  const pgFilteredUnbilledSlips = usePagination(filteredUnbilledSlips);

  const handleSelectAllFilteredSlips = (e: any) => {
     if(e.target.checked) {
        const filteredIds = pgFilteredUnbilledSlips.slice.map(s => s.id);
        setSelectedSlips(filteredIds);
     } else {
        setSelectedSlips([]);
     }
  };

  const toggleSlipSelection = (id: string) => {
    if (selectedSlips.includes(id)) {
      setSelectedSlips(selectedSlips.filter(s => s !== id));
    } else {
      setSelectedSlips([...selectedSlips, id]);
    }
  };

  // ✏️ EDIT SLIP LOGIC
  const startEditingSlip = (slip: any) => {
    setEditingSlipId(slip.id);
    setEditSlipData({ liters: slip.liters || '', rate: slip.rate || '', amount: slip.amount || '' });
  };

  const handleEditSlipChange = (field: string, val: string) => {
    const newData = { ...editSlipData, [field]: val };
    if (field === 'liters' || field === 'rate') {
       const l = parseFloat(field === 'liters' ? val : newData.liters) || 0;
       const r = parseFloat(field === 'rate' ? val : newData.rate) || 0;
       newData.amount = (l * r).toFixed(2);
    }
    setEditSlipData(newData);
  };

  const saveEditedSlip = async () => {
    try {
      // Refused with 409 if the slip has already been verified against a
      // pump bill — its value is what a posted voucher was built from.
      await apiJson(`${QUEUES_API}/fuel-entries/${editingSlipId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          liters: Number(editSlipData.liters) || 0,
          rate: Number(editSlipData.rate) || 0,
          amount: Number(editSlipData.amount) || 0,
        }),
      });
      setEditingSlipId('');
      alert("✅ Slip Updated!");
      
      const fSnap = await apiJson(`${QUEUES_API}/fuel-entries?limit=2000`);
      const freshHistory = fSnap.entries ?? [];
      setFuelHistory(freshHistory);
      
      const slips = freshHistory.filter(f => f.vendor_id === reconVendor && f.bill_status === 'UNBILLED');
      setUnbilledSlips(slips);

    } catch (e) { alert("❌ Error updating slip."); }
  };

  const deleteReconSlip = async (id: string) => {
    if(window.confirm("⚠️ Are you sure you want to permanently delete this Fuel Slip?")) {
      // DELETE WAS NEVER WIRED after the move off Firestore: this called
      // deleteDoc(doc(db, …)) with no db in scope, so the button threw a
      // ReferenceError and did nothing. Saying so is better than crashing, and
      // better than quietly building a delete for a financial record that may
      // already be attached to a trip. The correction a clerk needs is ✏️ Edit.
      alert('🚫 Fuel slip/memo delete abhi is screen se nahi hota.'
        + String.fromCharCode(10) + String.fromCharCode(10)
        + 'Galti sudharni ho to us line par ✏️ Edit dabaiye. Poori slip hatani ho'
        + ' to accounts se kahiye — wo kisi trip se judi ho sakti hai.');
      return;
      
      const fSnap = await apiJson(`${QUEUES_API}/fuel-entries?limit=2000`);
      const freshHistory = fSnap.entries ?? [];
      setFuelHistory(freshHistory);
      
      const slips = freshHistory.filter(f => f.vendor_id === reconVendor && f.bill_status === 'UNBILLED');
      setUnbilledSlips(slips);
    }
  };

  // 🏦 FINAL BILL VERIFICATION & LEDGER POSTING
  // 📄 Scan petrol-pump bill PDF/photo with LOCAL Gemma 4 vision → total + line items.
  /**
   * Read the pump's bill.
   *
   * A PDF WITH REAL TEXT IS READ, NOT GUESSED AT. /fuel/parse-pdf pulls the
   * embedded text out of a B N Filling or Sree Krishna invoice and checks the
   * rows against the total the pump itself printed — so the digits are exact
   * and a mis-read bill cannot pass. Only when that refuses the file (a
   * photograph, or a pump whose layout is not known) does the local vision
   * model take over, and its numbers are treated as a draft to be checked.
   */
  const handleScanPumpBill = async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    setScanningPump(true); setScannedPumpItems([]); setScanMeta(null); setBillResolutions({});

    // 1 — the exact path
    if (/\.pdf$/i.test(file.name || '') || file.type === 'application/pdf') {
      try {
        const b64: string = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] ?? '');
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        const resp = await fetch(`${API}/api/v1/fuel/parse-pdf`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdf_base64: b64, source_file: file.name }),
        });
        const j = await resp.json();
        if (resp.ok && Array.isArray(j.rows) && j.rows.length) {
          setScannedPumpItems(j.rows.map((r: any) => ({
            date: r.date, vehicle_no: r.vehicle_raw, product: 'HSD',
            qty: r.qty, rate: r.rate, amount: r.amount,
            confidence: r.confidence, flags: r.flags,
          })));
          setScanMeta({ ...j, exact: true });

          // THE BILL NAMES ITS OWN PUMP, so pick it. Without this the audit ran
          // with reconVendor still empty, the memo pool was empty with it, and
          // every line came back "no memo exists" while the screen showed
          // "-- Choose Pump --" at the top. Matched on the same normalisation
          // the database uses (pump_key), so "BN FILLING STATION (Bharat
          // Petroleum Dealer)" on the invoice finds "B N FILLING STATION" in
          // the vendor master.
          const pk = (t: string) => String(t || '').toUpperCase()
            .replace(/(BHARAT PETROLEUM DEALERS?|BPCL DEALERS?|INDIAN OIL|IOCL|HPCL|PVT LTD|PRIVATE LIMITED)/g, ' ')
            .replace(/STN/g, 'STATION').replace(/[^A-Z0-9]/g, '');
          const hit = fuelVendors.find((v: any) => pk(v.vendor_name) === pk(j.pump));
          if (hit && hit.id !== reconVendor) handleVendorSelectRecon(hit.id);
          else if (!hit) {
            setScanMeta((m: any) => ({ ...(m ?? {}), exact: true,
              pump_not_in_master: j.pump }));
          }

          if (j.check?.stated_amount) setVendorBillAmount(String(Math.round(j.check.stated_amount)));
          if (j.period?.from) setReconFromDate(j.period.from);
          if (j.period?.to) setReconToDate(j.period.to);
          setScanningPump(false);
          return;
        }
        // A refusal is information, not a failure — say which one it was.
        if (!resp.ok) {
          setScanMeta({ exact: false, refused: j.error, refused_detail: j.detail || j.hint });
        }
      } catch {
        setScanMeta({ exact: false, refused: 'NETWORK', refused_detail: 'server se baat nahi hui' });
      }
    }

    // 2 — the photograph path
    try {
      const prompt = `This is a petrol pump fuel bill (IndianOil/HPCL/BPCL) for a transport company. Extract and reply with ONLY JSON:
{ "pump_name": "", "invoice_no": "", "total_amount": 0, "items": [{"date":"DD-MM-YYYY","vehicle_no":"","product":"HSD/MS","qty":0,"rate":0,"amount":0}] }
Sum all row amounts into total_amount. Empty/0 if absent.`;
      const ai = await extractJsonFromImage(file, prompt);
      const items = Array.isArray(ai.items) ? ai.items : [];
      const amt = (v: any) => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;
      // 🔢 LLMs are unreliable at summing — sum the line items in CODE; only
      // fall back to the model's stated total when no items were extracted.
      const itemSum = items.reduce((s: number, it: any) => s + amt(it.amount), 0);
      const total = items.length ? Math.round(itemSum) : amt(ai.total_amount);
      if (total > 0) setVendorBillAmount(String(Math.round(total)));
      // The vision model's dates come back DD-MM-YYYY; the audit needs ISO.
      setScannedPumpItems(items.map((it: any) => ({
        ...it,
        date: /^\d{2}-\d{2}-\d{4}$/.test(String(it.date ?? ''))
          ? String(it.date).split('-').reverse().join('-')
          : it.date,
      })));
      setScanMeta((m: any) => ({ ...(m ?? {}), exact: false, pump: ai.pump_name || null,
        counts: { rows: items.length, ready: 0, needs_review: items.length } }));
    } catch (err: any) {
      const offline = err?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(err?.message || '');
      alert(offline ? '❌ Local AI engine (Ollama) band hai.' : '❌ Bill padhi nahi gayi. Saaf PDF/photo se try karein.');
    }
    setScanningPump(false);
  };

  // ── THE AUDIT ────────────────────────────────────────────────────────────
  //
  // Derived on every render from the scanned lines and the unbilled memos.
  // Deliberately not stored: an audit kept in state drifts the moment a slip is
  // edited on the right, and a stale verdict is worse than none.
  // AUDITED AGAINST EVERY UNBILLED MEMO FOR THIS PUMP — never the date-filtered
  // list. The on-screen From/To is there to shorten the table on the right; the
  // audit constrains dates itself, per line, to within a day of the bill line.
  // Feeding it the filtered list made a June bill read against an August filter
  // report all 39 lines as "no memo exists" and ₹6,47,352 as unauthorised —
  // which is what the screen showed before this was fixed.
  // EVERY memo for this pump goes into the audit, not only the unbilled ones —
  // and each carries whether it may be used again. Feeding it only the unbilled
  // list is what made a scanned bill report 39 ghosts: on 4-Sep exactly ONE of
  // 1,042 memos in the whole database was UNBILLED, so the pool was empty and
  // every real, already-paid memo looked like it did not exist. Now the line
  // says "already settled", which is the truth and stops the clerk hunting.
  const auditPool = React.useMemo(() => fuelHistory
    .filter((f: any) => f.vendor_id === reconVendor)
    .map((f: any) => ({
      ...f,
      reusable: String(f.bill_status ?? 'UNBILLED') === 'UNBILLED',
      settled_label: f.settled_label ?? f.settled_ref ?? null,
    })), [fuelHistory, reconVendor]);

  const billAudit = React.useMemo(
    () => (scannedPumpItems.length ? auditBill(scannedPumpItems, auditPool) : null),
    [scannedPumpItems, auditPool]);
  const gate = React.useMemo(
    () => (billAudit ? settlementGate(billAudit, billResolutions) : null),
    [billAudit, billResolutions]);
  const auditRows = React.useMemo(() => {
    if (!billAudit) return [];
    return auditFilter === 'ALL'
      ? billAudit.lines
      : billAudit.lines.filter((l: any) => VERDICTS[l.verdict]?.blocks);
  }, [billAudit, auditFilter]);

  /**
   * Correct what we READ from the bill — a lorry number, a date, litres, a rate.
   *
   * THE ORIGINAL IS KEPT on the row and shown. Editing here changes our reading
   * of the paper, not the paper: if a clerk quietly "corrects" the pump's rate
   * down to ours the disagreement disappears from the screen while the pump is
   * still charging what it charged. Keeping the original is what stops this
   * button from becoming a way to make an over-charge vanish.
   */
  const startBillEdit = (l: any) => {
    setEditingBillIdx(l.idx);
    setBillEdit({ date: l.date ?? '', vehicle_no: l.vehicle_raw ?? '',
                  qty: l.qty ?? '', rate: l.rate ?? '', amount: l.amount ?? '' });
  };
  const onBillEditChange = (field: string, val: string) => {
    setBillEdit((b: any) => {
      const next = { ...b, [field]: val };
      // Litres × rate keeps the amount honest while the clerk types, unless
      // they are editing the amount itself.
      if (field === 'qty' || field === 'rate') {
        const q = parseFloat(field === 'qty' ? val : next.qty) || 0;
        const r = parseFloat(field === 'rate' ? val : next.rate) || 0;
        if (q && r) next.amount = (q * r).toFixed(2);
      }
      return next;
    });
  };
  const saveBillEdit = (idx: number) => {
    setScannedPumpItems((items) => items.map((it: any, i: number) => {
      if (i !== idx) return it;
      return {
        ...it,
        _original: it._original ?? { date: it.date, vehicle_no: it.vehicle_no,
                                     qty: it.qty, rate: it.rate, amount: it.amount },
        date: billEdit.date || it.date,
        vehicle_no: billEdit.vehicle_no || it.vehicle_no,
        vehicle_raw: billEdit.vehicle_no || it.vehicle_no,
        qty: billEdit.qty === '' ? it.qty : Number(billEdit.qty),
        rate: billEdit.rate === '' ? it.rate : Number(billEdit.rate),
        amount: billEdit.amount === '' ? it.amount : Number(billEdit.amount),
        _edited: true,
      };
    }));
    // A corrected line starts over: whatever was decided about the old reading
    // no longer applies to the new one.
    setBillResolutions((r) => { const n = { ...r }; delete n[idx]; return n; });
    setEditingBillIdx(null);
  };

  /** Correct OUR memo. Real data, so it goes to the server and comes back. */
  const saveMemoEditFromAudit = async (slipId: string, patch: any) => {
    setSavingMemo(true);
    try {
      await apiJson(`${QUEUES_API}/fuel-entries/${slipId}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      const fSnap = await apiJson(`${QUEUES_API}/fuel-entries?limit=2000`);
      const fresh = fSnap.entries ?? [];
      setFuelHistory(fresh);
      setUnbilledSlips(fresh.filter((f: any) => f.vendor_id === reconVendor && f.bill_status === 'UNBILLED'));
      setEditingSlipId('');
    } catch (e: any) {
      alert(e?.code === 'NOT_EDITABLE'
        ? '❌ Yeh slip pehle hi kisi bill se verify ho chuki hai — ab badli nahi ja sakti.'
        : '❌ Slip update nahi hui.');
    }
    setSavingMemo(false);
  };

  const resolve = (idx: number, how: string) =>
    setBillResolutions((r) => {
      const next = { ...r };
      if (next[idx] === how) delete next[idx]; else next[idx] = how;
      return next;
    });

  /** Pair a bill line with a slip the clerk picked on the right. */
  const linkLineToSlip = (idx: number, slipId: string) => {
    // THE SHIELD, at the last possible moment. The list below only offers
    // reusable memos, but a snapshot in a browser goes stale — another clerk
    // may have settled this one while this screen sat open. The server refuses
    // it too (fuel-reconcile takes UNBILLED slips only, FOR UPDATE); this is
    // the polite refusal that arrives before the rude one.
    const sl: any = fuelHistory.find((f: any) => String(f.id) === String(slipId));
    if (sl && String(sl.bill_status ?? 'UNBILLED') !== 'UNBILLED') {
      alert('🚫 Yeh memo pehle hi settle ho chuka hai'
        + (sl.settled_ref ? ' — ' + sl.settled_ref : '')
        + '.' + String.fromCharCode(10) + 'Ise dobara kisi bill par nahi lagaya ja sakta.');
      return;
    }
    setBillResolutions((r) => ({ ...r, [idx]: 'LINKED' }));
    setSelectedSlips((sel) => (sel.includes(slipId) ? sel : [...sel, slipId]));
    setLinkingIdx(null);
  };

  const handleMatchBill = async () => {
    // ── THE GATEKEEPER ─────────────────────────────────────────────────────
    // A 15-day bill with unresolved lines must not post. Without this a bill
    // carrying six ghost lines settles as quietly as a clean one, and the pump
    // is paid for diesel nobody issued.
    if (gate && !gate.ok) {
      const worst = gate.open_lines.slice(0, 6)
        .map((l: any) => `  • #${l.sno} ${l.date} ${l.vehicle} — ${VERDICTS[l.verdict]?.label ?? l.verdict}`)
        .join(String.fromCharCode(10));
      const more = gate.open > 6 ? String.fromCharCode(10) + `  …aur ${gate.open - 6}` : '';
      const NL = String.fromCharCode(10);
      alert(`🚫 ${gate.open} line(s) abhi tay nahi hui hain.` + NL + NL + worst + more
        + NL + NL + 'Har line par Link / Accept / Dispute karein, tab hi 15-din ka bill post hoga.');
      return;
    }
    if (!vendorBillAmount) return alert("⚠️ Enter the Total Amount from Physical Bill!");
    if (selectedSlips.length === 0) return alert("⚠️ Please select at least one slip to verify!");
    
    const selectedTotal = filteredUnbilledSlips.filter(s => selectedSlips.includes(s.id)).reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
    
    if (Math.abs(selectedTotal - parseFloat(vendorBillAmount)) > 10) {
      if(!window.confirm(`⚠️ Difference Detected!\n\nSystem Selected Total: ₹${selectedTotal.toFixed(2)}\nPhysical Bill Amount: ₹${vendorBillAmount}\n\nDo you still want to force proceed and Post to Ledger?`)) {
        return;
      }
    }

    try {
      // ONE server call. This used to be a browser loop: read every trip,
      // update each slip, bump each trip, then append a ONE-SIDED Cr row to
      // LEDGER_ENTRIES. That last write is impossible on PostgreSQL — the table
      // is TARA's, append-only, with a deferred Dr=Cr constraint — and the loop
      // could half-complete, leaving slips verified with no liability posted.
      //
      // The endpoint does the slip values, the per-trip DELTA and the
      // Dr Diesel / Cr Creditors journal in one transaction, and refuses a
      // replay (the voucher reference is derived from the slip set).
      const vendor = fuelVendors.find(v => v.id === reconVendor);
      const vName = vendor ? vendor.vendor_name : 'Unknown Vendor';

      // ── DISPUTED MONEY IS NOT PAID ────────────────────────────────────
      //
      // The bill amount is what the pump asked for; the PAYABLE is that less
      // whatever the desk disputed. Posting the full amount would credit the
      // pump for exactly the money the office is refusing — which is what the
      // Dispute button exists to prevent. The disputed lines' slips are held
      // back too, so the pro-rata split stays consistent with what is paid.
      const disputedIdx = new Set(Object.entries(billResolutions)
        .filter(([, v]) => v === 'DISPUTED').map(([k]) => Number(k)));
      const disputedAmount = billAudit
        ? Number(billAudit.lines.filter((l: any) => disputedIdx.has(l.idx))
            .reduce((a: number, l: any) => a + (Number(l.amount) || 0), 0).toFixed(2))
        : 0;
      const heldSlipIds = new Set(billAudit
        ? billAudit.lines.filter((l: any) => disputedIdx.has(l.idx) && l.slip_id)
            .map((l: any) => String(l.slip_id))
        : []);
      const postSlipIds = selectedSlips.filter((id) => !heldSlipIds.has(String(id)));

      const settled = await apiJson(`${API}/api/v1/fuel/pump-bill-settle`, {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: reconVendor,
          slip_ids: postSlipIds,
          bill_amount: parseFloat(vendorBillAmount) || 0,
          disputed_amount: disputedAmount,
          period_from: reconFromDate || undefined,
          period_to: reconToDate || undefined,
          slip_count: billAudit?.summary?.lines ?? postSlipIds.length,
          total_liters: billAudit
            ? Number(billAudit.lines.reduce((a: number, l: any) => a + (Number(l.qty) || 0), 0).toFixed(3))
            : 0,
          resolutions: billResolutions,
          lines: billAudit?.lines ?? [],
          created_by: 'desk',
        }),
      });
      const recon = settled;
      const tripsBumped = settled.trips_adjusted ?? 0;

      const NL = String.fromCharCode(10);
      alert('✅ 15-din ka bill settle ho gaya' + NL + NL
        + 'Invoice: ' + settled.bill.invoice_no + NL
        + 'Pump ne laga: ₹' + Number(settled.bill.bill_amount).toLocaleString('en-IN') + NL
        + (disputedAmount > 0
            ? 'Dispute me roka: ₹' + disputedAmount.toLocaleString('en-IN') + NL : '')
        + 'Payable posted: ₹' + Number(settled.bill.payable_amount).toLocaleString('en-IN')
        + ' → ' + vName + NL
        + (settled.pump_outstanding
            ? 'Pump ka bakaya ab: ₹' + Number(settled.pump_outstanding.outstanding).toLocaleString('en-IN') + NL : '')
        + '🚛 ' + tripsBumped + ' trip ke kharche me diesel value update hui.' + NL
        + '🔒 Yeh 15-din ab lock ho gaya — dobara post nahi hoga.');
      setScannedPumpItems([]); setScanMeta(null); setBillResolutions({});
      
      setVendorBillAmount('');
      setSelectedSlips([]);
      fetchData(); 
      handleVendorSelectRecon(reconVendor); 
      
    } catch (e: any) {
      alert(e?.code === 'ALREADY_POSTED'
        ? "⚠️ Ye bill pehle hi verify ho chuka hai — dobara post nahi hoga."
        : e?.code === 'PERIOD_LOCKED'
        ? "🔒 Yeh 15-din pehle hi settle aur lock ho chuka hai. " + (e?.message ?? '')
        : e?.code === 'NOTHING_PAYABLE'
        ? "⚠️ Poora bill dispute me hai — post karne ko kuch bacha hi nahi. " + (e?.message ?? '')
        : "❌ Error updating slips and ledger: " + (e?.message || ''));
    }
  };

  const sendFuelMemoWhatsApp = (slip: any) => {
    if (!slip.pump_mobile) {
      alert("⚠️ Mobile number not found for this Petrol Pump!");
      return;
    }
    const message = `*⛽ FUEL MEMO ALERT* \n\nDear ${slip.vendor_name},\n\nPlease provide fuel to our vehicle based on the following approved memo:\n\n🚛 *Vehicle No:* ${slip.vehicle_no}\n👤 *Driver:* ${slip.driver_name || 'N/A'}\n📍 *Route:* ${slip.route_name || 'N/A'}\n\n💧 *Quantity Approved:* ${slip.liters} Liters (${slip.fuel_type})\n📝 *Memo No:* ${slip.memo_no}\n📅 *Date:* ${slip.date}\n\nKindly process the fueling and add it to our billing cycle.\n\nRegards,\n*Prasad Transport ERP*`;
    // 💬 Dual-mode: PRASAD PRO auto-send (footprint) → phone WhatsApp fallback
    import('./lib/waSend').then(({ sendWhatsApp, waResultText }) =>
      sendWhatsApp({ phone: slip.pump_mobile, message, tripId: slip.trip_id }).then(r => alert(waResultText(r))));
  };

  const sendFuelSlipToPumpGroup = async (slip: any) => {
    const groupName = "Pawan service Station || Prasad Transport"; 
    const message = `⛽ *FUEL SLIP - PRASAD TRANSPORT*\n\n🚛 Vehicle No: *${slip.vehicle_no}*\n🛢️ Fuel Qty: *${slip.liters} Liters*\n👤 Driver: *${slip.driver_name || 'N/A'}*\n📝 Memo No: *${slip.memo_no}*\n\nकृपया इस गाड़ी में डीज़ल भर दें।\n\n- सिस्टम द्वारा ऑटो-जेनरेटेड मैसेज`;

    try {
        const response = await fetch('https://prasad-api.onrender.com/send-group-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupName: groupName, message: message })
        });
        const result = await response.json();
        if(result.success) alert(`✅ डीजल की पर्ची '${groupName}' ग्रुप में भेज दी गई है!`);
        else alert(`⚠️ ग्रुप नहीं मिला। कृपया चेक करें कि आपका WhatsApp Bot '${groupName}' ग्रुप में ऐड है या नहीं।`);
    } catch (error) { alert("❌ सर्वर से कनेक्ट नहीं हो पाया।"); }
  };

  const handleDeleteHistorySlip = async (id: string, memoNo: string) => {
    if (window.confirm(`⚠️ Are you sure you want to delete Memo No: ${memoNo}?\n\nNote: If this was an 'ADVANCE' fuel, the entry will be removed from here, but you will need to manually reverse the advance from the Driver's Ledger.`)) {
      try {
        // DELETE WAS NEVER WIRED after the move off Firestore: this called
        // deleteDoc(doc(db, …)) with no db in scope, so the button threw a
        // ReferenceError and did nothing. Saying so is better than crashing, and
        // better than quietly building a delete for a financial record that may
        // already be attached to a trip. The correction a clerk needs is ✏️ Edit.
        alert('🚫 Fuel slip/memo delete abhi is screen se nahi hota.'
          + String.fromCharCode(10) + String.fromCharCode(10)
          + 'Galti sudharni ho to us line par ✏️ Edit dabaiye. Poori slip hatani ho'
          + ' to accounts se kahiye — wo kisi trip se judi ho sakti hai.');
        return;
        fetchData();
      } catch (error) { alert("Error deleting memo"); }
    }
  };

  // 📈 HISTORY FILTERS LOGIC
  //
  // The date comparisons read `entry_date`. They used to read `f.date`, which
  // fuel_entries has never had — so From/To silently matched everything and the
  // Date column beside every memo rendered blank. Both were the same undefined.
  const historyCounts = React.useMemo(() => fuelHistory.reduce((a: any, f: any) => {
    const s = f.slip_status ?? (f.bill_status === 'BILLED_VERIFIED' ? 'SETTLED'
              : (f.vendor_id ? 'PENDING' : 'NO_PUMP'));
    a[s] = (a[s] ?? 0) + 1;
    if (s !== 'SETTLED') a.open_amount += Number(f.amount) || 0;
    return a;
  }, { SETTLED: 0, PENDING: 0, NO_PUMP: 0, open_amount: 0 }), [fuelHistory]);

  const filteredHistory = fuelHistory.filter(f => {
     const matchVendor = historyVendor === 'ALL' || f.vendor_id === historyVendor;
     let matchDate = true;
     if (historyFromDate && f.entry_date < historyFromDate) matchDate = false;
     if (historyToDate && f.entry_date > historyToDate) matchDate = false;

     let matchSearch = true;
     if (historySearch) {
        const q = historySearch.toLowerCase();
        matchSearch = (f.vehicle_no || '').toLowerCase().includes(q) ||
                      (f.driver_name || '').toLowerCase().includes(q) ||
                      (f.memo_no || '').toLowerCase().includes(q);
     }
     // A settled memo is finished work. It is kept out of the way by default so
     // the screen shows what is still owed, and put back by the toggle for an
     // audit — never deleted, and never hidden while someone is searching for a
     // particular memo, because then "not found" would be a lie.
     const settled = f.slip_status
       ? f.slip_status === 'SETTLED'
       : f.bill_status === 'BILLED_VERIFIED';
     const matchSettled = (showSettled || !!historySearch) ? true : !settled;

     return matchVendor && matchDate && matchSearch && matchSettled;
  });

  // Ten rows at a time, newest first. The same hook the unbilled-slips table two
  // tabs over already uses, so the control is the one the staff know and the
  // chosen page size follows them across the ERP.
  //
  // What was slow here was never the fetch — the reconciliation tab needs the
  // whole register anyway — it was painting 1,042 rows with three buttons each
  // into the DOM. Slicing fixes exactly that and nothing else.
  //
  // Ordering needs no work: the API returns entry_date DESC and nothing here
  // re-sorts, so page 1 is always the latest.
  const pgHistory = usePagination(filteredHistory, { defaultSize: 10 });

  // Any change to WHAT is being listed goes back to page 1. Sitting on page 14
  // of a list that just became four pages long shows an empty table, which
  // reads as "the data is gone".
  useEffect(() => { pgHistory.setPage(1); },
    [historyVendor, historyFromDate, historyToDate, historySearch, showSettled]);

  const totalHsdFixedGiven = pumps.filter(p => p.fuel_type === 'FIXED').reduce((sum, p) => sum + (parseFloat(p.qty) || 0), 0);
  const totalCashFixedGiven = pumps.filter(p => p.fuel_type === 'FIXED').reduce((sum, p) => sum + (parseFloat(p.cash_advance) || 0), 0);
  
  const hsdBalance = (parseFloat(memoData.fixed_hsd) || 0) - totalHsdFixedGiven;
  const cashBalance = (parseFloat(memoData.fixed_cash) || 0) - totalCashFixedGiven;

  const activeReconTotal = filteredUnbilledSlips.filter(s => selectedSlips.includes(s.id)).reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);

  const quickBtnStyle = { background: 'rgba(34, 211, 238, 0.1)', border: '1px solid #22d3ee', color: '#22d3ee', padding: '6px 12px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #121c38, #0a1024)' }}>
      <style>{`
        .glass-card { background: rgba(24, 36, 74, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #2fe39b, #2fe39b); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(47, 227, 155, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #9aadd4; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; }
        .tab-btn.active { color: #ffb224; border-bottom: 3px solid #ffb224; background: rgba(255, 178, 36, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(18, 28, 56, 0.6); border: 1px solid rgba(39, 57, 95, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; outline: none; }
        .modern-input:focus { border-color: #ffb224; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #c4d1ea; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #27395f; color: #ffb224; }
        td { padding: 12px; border-bottom: 1px solid #27395f; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .wa-btn { background: rgba(34, 197, 94, 0.1); border: 1px solid #22c55e; color: #22c55e; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 5px; font-size: 11px; transition: 0.3s; }
        .wa-btn:hover { background: #22c55e; color: white; }
        .group-btn { background: rgba(34, 211, 238, 0.1); border: 1px solid #22d3ee; color: #22d3ee; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 5px; font-size: 11px; transition: 0.3s; margin-top: 5px;}
        .group-btn:hover { background: #38bdf8; color: white; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f6f8fd', fontSize: '32px' }}>Fuel Memo & Billing</h1>
          <p style={{ color: '#9aadd4', margin: '5px 0' }}>Multi-Pump Route Memos & Period-Wise Vendor Bill Reconciliation</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #27395f' }}>
        <button className={`tab-btn ${activeTab === 'MULTI_MEMO' ? 'active' : ''}`} onClick={() => setActiveTab('MULTI_MEMO')}>📝 ISSUE TRIP FUEL MEMO</button>
        <button className={`tab-btn ${activeTab === 'RECON' ? 'active' : ''}`} onClick={() => setActiveTab('RECON')}>🧾 BILL RECONCILIATION</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📈 ALL SLIPS HISTORY</button>
      </div>

      {/* 📝 TAB 1: MULTI-PUMP MEMO */}
      {activeTab === 'MULTI_MEMO' && (
        <div className="glass-card" style={{ padding: '30px', maxWidth: '1000px', borderTop: '3px solid #ffb224' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
            <h3 style={{ color: '#ffb224', margin: 0 }}>Create Route Fuel Memo</h3>
            <span className="badge" style={{ background: 'rgba(34, 211, 238,0.2)', color: '#22d3ee', fontSize: '14px' }}>{memoData.memo_no}</span>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px' }}>
            <div><label style={{ fontSize:'12px', color:'#9aadd4' }}>Date</label><input type="date" className="modern-input" value={memoData.date} onChange={e=>setMemoData({...memoData, date: e.target.value})} style={{colorScheme:'dark'}}/></div>
            <div><label style={{ fontSize:'12px', color:'#9aadd4' }}>Vehicle No *</label>
              <select className="modern-input" value={memoData.vehicle_no} onChange={e=>setMemoData({...memoData, vehicle_no: e.target.value})}>
                <option value="">-- Choose Vehicle --</option>
                {vehicles.map(v => <option key={v.id} value={v.vehicle_no || v.vehical_no}>{v.vehicle_no || v.vehical_no}</option>)}
              </select>
            </div>
            
            <div><label style={{ fontSize:'12px', color:'#2fe39b', fontWeight:'bold' }}>Driver Name (For Khata) *</label>
              <select className="modern-input" style={{ border: '1px solid #2fe39b' }} value={memoData.driver_name} onChange={e=>setMemoData({...memoData, driver_name: e.target.value})}>
                <option value="">-- Select Driver --</option>
                {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
            
            <div><label style={{ fontSize:'12px', color:'#9aadd4' }}>Route (e.g. GHY-Haldia)</label><input className="modern-input" value={memoData.route_name} onChange={e=>setMemoData({...memoData, route_name: e.target.value})} /></div>
            
            <div><label style={{ fontSize:'12px', color:'#22d3ee', fontWeight:'bold' }}>Trip Total Fixed HSD (Ltr)</label><input type="number" className="modern-input" style={{ border: '1px solid #22d3ee' }} placeholder="e.g. 600" value={memoData.fixed_hsd} onChange={e=>setMemoData({...memoData, fixed_hsd: e.target.value})} /></div>
            <div><label style={{ fontSize:'12px', color:'#2fe39b', fontWeight:'bold' }}>Trip Total Cash Adv (₹)</label><input type="number" className="modern-input" style={{ border: '1px solid #2fe39b' }} placeholder="e.g. 5000" value={memoData.fixed_cash} onChange={e=>setMemoData({...memoData, fixed_cash: e.target.value})} /></div>
          </div>

          <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
            <div style={{ flex: 1, background: 'rgba(34, 211, 238, 0.05)', border: '1px dashed #22d3ee', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#22d3ee', fontWeight: 'bold', marginBottom: '8px' }}>⛽ 'FIXED' HSD BALANCE (LITERS)</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#c4d1ea', fontSize: '13px' }}>
                <span>Fixed: <b style={{color:'#fff'}}>{memoData.fixed_hsd || 0} L</b></span>
                <span>Given: <b style={{color:'#ffb224'}}>{totalHsdFixedGiven} L</b></span>
                <span>Balance: <b style={{color: hsdBalance < 0 ? '#ff6b81' : '#2fe39b', fontSize: '16px'}}>{hsdBalance} L</b></span>
              </div>
            </div>
            <div style={{ flex: 1, background: 'rgba(47, 227, 155, 0.05)', border: '1px dashed #2fe39b', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#2fe39b', fontWeight: 'bold', marginBottom: '8px' }}>💵 'FIXED' CASH ADVANCE BALANCE (₹)</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#c4d1ea', fontSize: '13px' }}>
                <span>Fixed: <b style={{color:'#fff'}}>₹{memoData.fixed_cash || 0}</b></span>
                <span>Given: <b style={{color:'#ffb224'}}>₹{totalCashFixedGiven}</b></span>
                <span>Balance: <b style={{color: cashBalance < 0 ? '#ff6b81' : '#2fe39b', fontSize: '16px'}}>₹{cashBalance}</b></span>
              </div>
            </div>
          </div>

          <h4 style={{ color: '#ffb224', marginBottom: '10px' }}>⛽ Designated Pumps for this Route</h4>
          
          {pumps.map((pump, index) => (
            <div key={pump.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', marginBottom: '15px', borderLeft: `4px solid ${pump.fuel_type === 'ADVANCE' ? '#ff6b81' : '#22d3ee'}` }}>
              <div style={{ width: '30px', fontWeight: 'bold', color: '#9aadd4' }}>P{index + 1}</div>
              
              <div style={{ flex: 1.5 }}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Petrol Pump Name *</label>
                <select className="modern-input" value={pump.vendor_id} onChange={e=>handlePumpChange(pump.id, 'vendor_id', e.target.value)}>
                  <option value="">-- Select Pump --</option>
                  {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </select>
              </div>

              <div style={{ flex: 1 }}>
                <label style={{ fontSize:'11px', color: pump.fuel_type === 'ADVANCE' ? '#ff6b81' : '#22d3ee', fontWeight: 'bold' }}>Fuel Type *</label>
                <select className="modern-input" style={{ border: `1px solid ${pump.fuel_type === 'ADVANCE' ? '#ff6b81' : '#22d3ee'}`, color: pump.fuel_type === 'ADVANCE' ? '#ff6b81' : '#22d3ee' }} value={pump.fuel_type} onChange={e=>handlePumpChange(pump.id, 'fuel_type', e.target.value)}>
                  <option value="FIXED">✅ Fixed (Route)</option>
                  <option value="ADVANCE">⚠️ Advance (Driver)</option>
                </select>
              </div>
              
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Qty (Ltr) *</label><input type="number" className="modern-input" value={pump.qty} onChange={e=>handlePumpChange(pump.id, 'qty', e.target.value)} /></div>
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#9aadd4' }}>Rate/Ltr</label><input type="number" className="modern-input" value={pump.rate} onChange={e=>handlePumpChange(pump.id, 'rate', e.target.value)} /></div>
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#2fe39b' }}>Amt (₹)</label><input type="number" className="modern-input" style={{ background: 'transparent' }} value={pump.amount} disabled /></div>
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#ffb224' }}>Cash Adv (₹)</label><input type="number" className="modern-input" value={pump.cash_advance} onChange={e=>handlePumpChange(pump.id, 'cash_advance', e.target.value)} /></div>
              
              {pumps.length > 1 && (
                <button onClick={() => handleRemovePump(pump.id)} style={{ background: 'transparent', color: '#ff6b81', border: 'none', cursor: 'pointer', fontSize: '20px', paddingBottom: '8px' }}>✕</button>
              )}
            </div>
          ))}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
            <button onClick={handleAddPump} style={{ background: 'rgba(34, 211, 238,0.1)', color: '#22d3ee', border: '1px dashed #22d3ee', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>+ Add Another Pump</button>
            <button className="glow-btn" style={{ padding: '15px 40px', background: '#f59e0b', opacity: (hsdBalance < 0 || cashBalance < 0) ? 0.5 : 1, cursor: (hsdBalance < 0 || cashBalance < 0) ? 'not-allowed' : 'pointer' }} onClick={handleSaveMultiMemo} disabled={hsdBalance < 0 || cashBalance < 0}>
              {(hsdBalance < 0 || cashBalance < 0) ? '⚠️ Check Negative Fixed Balance' : '🚀 Generate & Save Memos'}
            </button>
          </div>
        </div>
      )}

      {/* 🧾 TAB 2: BILL RECONCILIATION (WITH QUICK DATES & EDITING) */}
      {activeTab === 'RECON' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
          
          <div className="glass-card" style={{ padding: '20px', borderTop: '3px solid #2fe39b', height: 'fit-content' }}>
            <h3 style={{ color: '#2fe39b', marginTop: 0 }}>1. Enter Physical Bill Details</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#9aadd4' }}>Select Petrol Pump *</label>
                <select className="modern-input" value={reconVendor} onChange={e=>handleVendorSelectRecon(e.target.value)}>
                  <option value="">-- Choose Pump --</option>
                  {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </select>
              </div>
              
              {/* 🚀 QUICK BI-MONTHLY DATE SELECTORS */}
              <div>
                <label style={{ fontSize:'12px', color:'#22d3ee', display:'block', marginBottom:'5px' }}>Quick Select Period:</label>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                  <button onClick={() => setQuickDate('LAST_H1')} style={{...quickBtnStyle}}>Last Mth 1-15</button>
                  <button onClick={() => setQuickDate('LAST_H2')} style={{...quickBtnStyle}}>Last Mth 16-End</button>
                  <button onClick={() => setQuickDate('THIS_H1')} style={{...quickBtnStyle}}>This Mth 1-15</button>
                  <button onClick={() => setQuickDate('THIS_H2')} style={{...quickBtnStyle}}>This Mth 16-End</button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize:'12px', color:'#22d3ee' }}>From Date</label>
                  <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={reconFromDate} onChange={e => setReconFromDate(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize:'12px', color:'#22d3ee' }}>To Date</label>
                  <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={reconToDate} onChange={e => setReconToDate(e.target.value)} />
                </div>
              </div>
              {(reconFromDate || reconToDate) && <span onClick={() => {setReconFromDate(''); setReconToDate('');}} style={{ color: '#ff6b81', fontSize: '11px', cursor: 'pointer', textAlign: 'right' }}>❌ Clear Dates</span>}

              {/* 📄 Scan the pump's PDF/photo bill → auto-fill total (100% local Gemma) */}
              <div style={{ background: 'rgba(167, 139, 250,0.06)', border: '1px dashed #a78bfa', borderRadius: '8px', padding: '12px' }}>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg,#a78bfa,#8b5cf6)', color: '#fff', padding: '10px', borderRadius: '8px', fontWeight: 'bold', cursor: scanningPump ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
                  {scanningPump ? '⏳ Reading bill…' : '📄 Scan Pump Bill (PDF/Photo)'}
                  <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleScanPumpBill} disabled={scanningPump} />
                </label>
                <div style={{ fontSize: '10px', color: '#9aadd4', marginTop: '6px', textAlign: 'center' }}>Local Gemma 4 — total + entries auto-fill, no internet</div>
                {scannedPumpItems.length > 0 && (
                  <div style={{ marginTop: '8px', maxHeight: '140px', overflowY: 'auto', fontSize: '11px' }}>
                    {scannedPumpItems.map((it, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: '#c4d1ea', borderBottom: '1px solid #18244a', padding: '3px 0' }}>
                        <span>{it.vehicle_no || '-'} · {it.qty || 0}L</span><span style={{ color: '#2fe39b' }}>₹{Number(it.amount || 0).toLocaleString('en-IN')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div><label style={{ fontSize:'12px', color:'#ffb224', fontWeight: 'bold' }}>Physical Bill Amount (₹) *</label>
                <input type="number" className="modern-input" style={{ fontSize: '20px', fontWeight: 'bold', border: '1px solid #ffb224', color: '#ffb224' }} value={vendorBillAmount} onChange={e=>setVendorBillAmount(e.target.value)} placeholder="Total from PDF Bill" />
              </div>
              
              <div style={{ background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', marginTop: '10px' }}>
                <p style={{ margin: '0 0 5px 0', color: '#9aadd4', fontSize: '12px' }}>Total of <b style={{color: '#fff'}}>{selectedSlips.length}</b> Selected Slips:</p>
                <h2 style={{ margin: 0, color: activeReconTotal === parseFloat(vendorBillAmount || '0') ? '#2fe39b' : '#ff6b81' }}>
                  ₹{activeReconTotal.toFixed(2)}
                </h2>
              </div>

              <button className="glow-btn" style={{ background: '#10b981', marginTop: '10px', justifyContent: 'center' }} onClick={handleMatchBill}>✅ Verify & Post to Ledger</button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 }}>

          {/* ═══ 1:1 LINE AUDIT — the pump's paper against our own memos ═════
              Shown only once a bill has been read. Each row is one printed
              line: on the left what the pump billed and what is wrong with it,
              on the right the memo it was paired to — or the memos it could be
              paired to, one click away. */}
          {billAudit && (
            <div className="glass-card" style={{ padding: '20px', borderTop: '3px solid #a78bfa' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <h3 style={{ color: '#a78bfa', margin: 0 }}>
                  🔍 Line-by-line audit
                  <span style={{ fontSize: '12px', color: '#9aadd4', fontWeight: 'normal', marginLeft: '10px' }}>
                    {scanMeta?.exact
                      ? (scanMeta.pump || '') + ' · PDF ka asli text padha gaya'
                      : 'Photo se padha gaya — ank khud check karein'}
                  </span>
                </h3>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {(['FLAGGED', 'ALL'] as const).map((f) => (
                    <button key={f} onClick={() => setAuditFilter(f)}
                      style={{ background: auditFilter === f ? 'rgba(167,139,250,0.2)' : 'transparent',
                               color: auditFilter === f ? '#c4b5fd' : '#9aadd4',
                               border: '1px solid ' + (auditFilter === f ? '#a78bfa' : '#27395f'),
                               borderRadius: '6px', padding: '4px 10px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}>
                      {f === 'FLAGGED' ? 'Sirf gadbad (' + billAudit.summary.blocking + ')' : 'Sab (' + billAudit.summary.lines + ')'}
                    </button>
                  ))}
                </div>
              </div>

              {/* What each side claims. The difference is the figure a
                  total-only check hides, because an over-bill and a missing
                  line cancel each other in a sum. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: '1px',
                            background: '#27395f', border: '1px solid #27395f', borderRadius: '8px', overflow: 'hidden', margin: '14px 0' }}>
                {[
                  ['Pump ne laga', '₹' + billAudit.summary.billed_amount.toLocaleString('en-IN'), '#eef3ff'],
                  ['Humne di thi', '₹' + billAudit.summary.authorised_amount.toLocaleString('en-IN'), '#2fe39b'],
                  ['Antar', '₹' + billAudit.summary.difference.toLocaleString('en-IN'),
                    Math.abs(billAudit.summary.difference) > 1 ? '#ff6b81' : '#2fe39b'],
                  ['Milte hain', billAudit.summary.matched + '/' + billAudit.summary.lines, '#2fe39b'],
                  ['Pehle hi settle', String(billAudit.summary.already_settled ?? 0),
                    (billAudit.summary.already_settled ?? 0) > 0 ? '#ff6b81' : '#5d7196'],
                  ['Bill me nahi', String(billAudit.summary.unbilled_slips), '#ffb224'],
                ].map((cell: any) => (
                  <div key={cell[0]} style={{ background: '#121c38', padding: '10px 12px' }}>
                    <div style={{ fontSize: '10px', color: '#9aadd4', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{cell[0]}</div>
                    <div style={{ fontSize: '17px', fontWeight: 700, color: cell[2], fontVariantNumeric: 'tabular-nums' }}>{cell[1]}</div>
                  </div>
                ))}
              </div>

              {/* THE GATE, stated before the work rather than after it. */}
              <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
                            background: gate && gate.ok ? 'rgba(47,227,155,0.08)' : 'rgba(255,178,36,0.08)',
                            border: '1px solid ' + (gate && gate.ok ? 'rgba(47,227,155,0.4)' : 'rgba(255,178,36,0.4)'),
                            color: gate && gate.ok ? '#2fe39b' : '#ffb224', fontSize: '12.5px', lineHeight: 1.5 }}>
                {gate && gate.ok ? (
                  <>✅ Sab line tay ho gayi — 15-din ka bill post ho sakta hai.
                    {gate.disputed > 0 && (
                      <span style={{ color: '#ff6b81' }}> {gate.disputed} line dispute me hai, uska paisa rok liya —
                        settle ₹{gate.settleable_amount.toLocaleString('en-IN')}.</span>
                    )}</>
                ) : (
                  <>🚫 {gate ? gate.open : 0} line abhi tay nahi hui. Jab tak har gadbad par Link / Accept / Dispute
                    nahi hota, poora 15-din ka bill settle nahi hoga.</>
                )}
              </div>

              {/* Why the right-hand side is empty, said before the clerk wonders. */}
              {(!reconVendor || scanMeta?.pump_not_in_master) && (
                <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
                              background: 'rgba(255,107,129,0.08)', border: '1px solid rgba(255,107,129,0.4)',
                              color: '#ff6b81', fontSize: '12.5px', lineHeight: 1.5 }}>
                  {scanMeta?.pump_not_in_master
                    ? <>⚠️ "{scanMeta.pump_not_in_master}" vendor master me nahi mila — isliye koi memo
                        milaya nahi ja saka. Pehle is pump ko vendor master me joड़ें, phir dobara scan karein.</>
                    : <>⚠️ Upar se pump chunna baaki hai — jab tak pump nahi chunte, kisi memo se milan
                        nahi ho sakta aur har line "memo hi nahi" dikhegi.</>}
                </div>
              )}

              {auditRows.length === 0 ? (
                <p style={{ color: '#5d7196', fontSize: '13px' }}>
                  {auditFilter === 'FLAGGED' ? '✅ Koi gadbad nahi — har line memo se milti hai.' : 'Koi line nahi.'}
                </p>
              ) : (
                // A COLUMN FLEXBOX WITH A BOUNDED HEIGHT SHRINKS ITS CHILDREN.
                // flex-shrink defaults to 1, so 31 cards inside a 520px column
                // were squeezed to about ten pixels each and overflow:hidden on
                // the card did the rest — thirty-one empty blue stripes. It
                // looked fine at five cards, which is how it shipped. Plain
                // block flow cannot do that to its children.
                <div style={{ display: 'block', maxHeight: '620px', overflowY: 'auto', paddingRight: '4px' }}>
                  {auditRows.map((l: any) => {
                    const v = VERDICTS[l.verdict] || { label: l.verdict, tone: 'warn', blocks: true };
                    const tone = v.tone === 'ok' ? '#2fe39b' : v.tone === 'bad' ? '#ff6b81' : '#ffb224';
                    const decided = billResolutions[l.idx];
                    const src = scannedPumpItems[l.idx] || {};
                    const editingThis = editingBillIdx === l.idx;
                    const memoEditing = l.slip && editingSlipId === String(l.slip.id);

                    // One field, side by side. `diff` paints only the figures
                    // that actually disagree — a card where everything is red
                    // tells the clerk nothing.
                    const Field = ({ label, a, b, diff }: any) => (
                      <div style={{ display: 'grid', gridTemplateColumns: '68px 1fr', gap: '8px', padding: '3px 0' }}>
                        <span style={{ fontSize: '10.5px', color: '#5d7196', textTransform: 'uppercase', letterSpacing: '0.06em', paddingTop: '2px' }}>{label}</span>
                        <span style={{ fontSize: '12.5px', color: diff ? tone : '#c4d1ea', fontWeight: diff ? 700 : 400,
                                       fontVariantNumeric: 'tabular-nums' }}>{a}</span>
                      </div>
                    );

                    return (
                      <div key={l.idx} style={{ border: '1px solid ' + (decided ? 'rgba(47,227,155,0.45)' : '#27395f'),
                                                background: decided ? 'rgba(47,227,155,0.04)' : 'rgba(18,28,56,0.6)',
                                                borderRadius: '10px', overflow: 'hidden',
                                                marginBottom: '10px', flexShrink: 0 }}>

                        {/* the line's own header: which line, and what is wrong */}
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
                                      padding: '8px 12px', borderBottom: '1px solid #27395f', background: 'rgba(10,16,36,0.5)' }}>
                          <b style={{ color: '#eef3ff', fontSize: '12.5px' }}>#{l.sno}</b>
                          <span style={{ border: '1px solid ' + tone, color: tone, borderRadius: '99px',
                                         padding: '1px 8px', fontSize: '10px', fontWeight: 700 }}>{v.label}</span>
                          {/* THE DUPLICATE INDICATOR. A memo that exists and is already paid is a
                              different problem from a memo that does not exist, and the clerk needs
                              to stop looking rather than start. */}
                          {l.verdict === 'ALREADY_SETTLED' && (
                            <span style={{ border: '1px solid #ff6b81', background: 'rgba(255,107,129,0.12)',
                                           color: '#ff6b81', borderRadius: '99px', padding: '1px 8px',
                                           fontSize: '10px', fontWeight: 700 }}>
                              ⚠️ Already Settled{l.settled_label ? ' in Bill #' + l.settled_label : ''}
                            </span>
                          )}
                          {src._edited && (
                            <span title={'Pehle bill par: ' + (src._original?.date || '') + ' · ' + (src._original?.vehicle_no || '')
                                         + ' · ' + (src._original?.qty ?? '') + 'L · ₹' + (src._original?.rate ?? '')}
                              style={{ border: '1px solid #a78bfa', color: '#c4b5fd', borderRadius: '99px',
                                       padding: '1px 8px', fontSize: '10px', fontWeight: 700 }}>
                              ✏️ hum ne theek kiya
                            </span>
                          )}
                          {decided && <span style={{ color: '#2fe39b', fontSize: '10.5px', fontWeight: 700 }}>✓ {decided}</span>}
                          {l.notes.length > 0 && (
                            <span style={{ color: tone, fontSize: '11.5px', flexBasis: '100%', lineHeight: 1.45 }}>
                              {l.notes.map((n: string, i: number) => <div key={i}>⚠ {n}</div>)}
                            </span>
                          )}
                        </div>

                        {/* ═══ THE TWO SIDES ═════════════════════════════════ */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>

                          {/* ── LEFT: what the pump billed ────────────────── */}
                          <div style={{ padding: '10px 12px', borderRight: '1px solid #27395f' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                              <b style={{ fontSize: '10.5px', color: '#ffb224', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                📄 Pump Bill Entry
                              </b>
                              <button onClick={() => (editingThis ? setEditingBillIdx(null) : startBillEdit(l))}
                                style={{ background: 'transparent', border: '1px solid #3d548a', color: '#9aadd4',
                                         borderRadius: '5px', padding: '2px 8px', fontSize: '10.5px', cursor: 'pointer' }}>
                                {editingThis ? '✕ band' : '✏️ Edit'}
                              </button>
                            </div>

                            {editingThis ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                {[['date', 'Date', 'date'], ['vehicle_no', 'Lorry', 'text'],
                                  ['qty', 'Litres', 'number'], ['rate', 'Rate', 'number'],
                                  ['amount', 'Amount', 'number']].map((f: any) => (
                                  <div key={f[0]} style={{ display: 'grid', gridTemplateColumns: '68px 1fr', gap: '8px', alignItems: 'center' }}>
                                    <span style={{ fontSize: '10.5px', color: '#5d7196', textTransform: 'uppercase' }}>{f[1]}</span>
                                    <input type={f[2]} value={billEdit[f[0]] ?? ''} onChange={(e) => onBillEditChange(f[0], e.target.value)}
                                      style={{ background: '#0a1024', border: '1px solid #3d548a', borderRadius: '5px',
                                               color: '#eef3ff', padding: '4px 7px', fontSize: '12px', width: '100%' }} />
                                  </div>
                                ))}
                                <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                                  <button onClick={() => saveBillEdit(l.idx)}
                                    style={{ background: '#2fe39b', color: '#0a1024', border: 'none', borderRadius: '5px',
                                             padding: '4px 12px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                                    💾 Save & re-check
                                  </button>
                                  <button onClick={() => setEditingBillIdx(null)}
                                    style={{ background: 'transparent', border: '1px solid #27395f', color: '#9aadd4',
                                             borderRadius: '5px', padding: '4px 10px', fontSize: '11px', cursor: 'pointer' }}>
                                    rehne do
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <Field label="Date"   a={l.date || '—'} diff={l.slip && String(l.slip.entry_date || '').slice(0, 10) !== l.date} />
                                <Field label="Lorry"  a={l.vehicle_raw || '—'} diff={false} />
                                <Field label="Litres" a={(l.qty == null ? '—' : l.qty) + ' L'} diff={l.verdict === 'QTY_MISMATCH'} />
                                <Field label="Rate"   a={'₹' + (l.rate == null ? '—' : l.rate)} diff={l.verdict === 'RATE_MISMATCH'} />
                                <Field label="Amount" a={'₹' + Number(l.amount || 0).toLocaleString('en-IN')}
                                       diff={l.verdict === 'AMOUNT_MISMATCH' || l.verdict === 'QTY_MISMATCH'} />
                                {src._edited && src._original && (
                                  <div style={{ marginTop: '5px', fontSize: '10.5px', color: '#7a5ca8', lineHeight: 1.4 }}>
                                    Bill par tha: {src._original.date} · {src._original.vehicle_no} ·{' '}
                                    {src._original.qty}L · ₹{src._original.rate}
                                  </div>
                                )}
                              </>
                            )}
                          </div>

                          {/* ── RIGHT: what we authorised on WhatsApp ─────── */}
                          <div style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                              <b style={{ fontSize: '10.5px', color: '#2fe39b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                💬 WhatsApp Memo Entry
                              </b>
                              {l.slip && (
                                <button onClick={() => {
                                    if (memoEditing) { setEditingSlipId(''); return; }
                                    setEditingSlipId(String(l.slip.id));
                                    setEditSlipData({ liters: String(l.slip_liters ?? ''), rate: String(l.slip_rate ?? ''),
                                                      amount: String(l.slip_amount ?? ''),
                                                      vehicle_no: l.slip.vehicle_no ?? '',
                                                      entry_date: String(l.slip.entry_date || '').slice(0, 10) } as any);
                                  }}
                                  style={{ background: 'transparent', border: '1px solid #3d548a', color: '#9aadd4',
                                           borderRadius: '5px', padding: '2px 8px', fontSize: '10.5px', cursor: 'pointer' }}>
                                  {memoEditing ? '✕ band' : '✏️ Edit'}
                                </button>
                              )}
                            </div>

                            {!l.slip ? (
                              linkingIdx === l.idx ? (
                                <>
                                  <div style={{ fontSize: '10.5px', color: '#22d3ee', marginBottom: '5px' }}>Kis memo se jodein?</div>
                                  <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                    {unbilledSlips.length === 0 && (
                                      <span style={{ color: '#5d7196', fontSize: '12px', lineHeight: 1.5 }}>
                                        Koi memo bacha nahi jo dobara lagaya ja sake — is pump ke sab memo
                                        pehle hi kisi bill me settle ho chuke hain.
                                      </span>
                                    )}
                                    {unbilledSlips.map((sl: any) => (
                                      <button key={sl.id} onClick={() => linkLineToSlip(l.idx, sl.id)}
                                        style={{ textAlign: 'left', background: 'rgba(34,211,238,0.08)', border: '1px solid #27395f',
                                                 borderRadius: '6px', padding: '5px 8px', color: '#c4d1ea', fontSize: '11.5px', cursor: 'pointer' }}>
                                        {String(sl.entry_date || sl.date || '').slice(0, 10)} · {sl.vehicle_no} · {sl.liters}L · ₹{Number(sl.amount || 0).toLocaleString('en-IN')}
                                      </button>
                                    ))}
                                  </div>
                                  <button onClick={() => setLinkingIdx(null)}
                                    style={{ marginTop: '6px', background: 'transparent', border: 'none', color: '#9aadd4', fontSize: '11px', cursor: 'pointer' }}>
                                    rehne do
                                  </button>
                                </>
                              ) : (
                                <div style={{ color: '#5d7196', fontSize: '12px', padding: '16px 0' }}>
                                  Koi memo nahi juda.
                                </div>
                              )
                            ) : memoEditing ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                {[['entry_date', 'Date', 'date'], ['vehicle_no', 'Lorry', 'text'],
                                  ['liters', 'Litres', 'number'], ['rate', 'Rate', 'number'],
                                  ['amount', 'Amount', 'number']].map((f: any) => (
                                  <div key={f[0]} style={{ display: 'grid', gridTemplateColumns: '68px 1fr', gap: '8px', alignItems: 'center' }}>
                                    <span style={{ fontSize: '10.5px', color: '#5d7196', textTransform: 'uppercase' }}>{f[1]}</span>
                                    <input type={f[2]} value={(editSlipData as any)[f[0]] ?? ''}
                                      onChange={(e) => handleEditSlipChange(f[0], e.target.value)}
                                      style={{ background: '#0a1024', border: '1px solid #3d548a', borderRadius: '5px',
                                               color: '#eef3ff', padding: '4px 7px', fontSize: '12px', width: '100%' }} />
                                  </div>
                                ))}
                                <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                                  <button disabled={savingMemo}
                                    onClick={() => saveMemoEditFromAudit(String(l.slip.id), {
                                      liters: Number((editSlipData as any).liters) || 0,
                                      rate: Number((editSlipData as any).rate) || 0,
                                      amount: Number((editSlipData as any).amount) || 0,
                                      vehicle_no: (editSlipData as any).vehicle_no || undefined,
                                      entry_date: (editSlipData as any).entry_date || undefined,
                                    })}
                                    style={{ background: '#2fe39b', color: '#0a1024', border: 'none', borderRadius: '5px',
                                             padding: '4px 12px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: savingMemo ? 0.5 : 1 }}>
                                    {savingMemo ? '⌛' : '💾 Save & re-check'}
                                  </button>
                                  <button onClick={() => setEditingSlipId('')}
                                    style={{ background: 'transparent', border: '1px solid #27395f', color: '#9aadd4',
                                             borderRadius: '5px', padding: '4px 10px', fontSize: '11px', cursor: 'pointer' }}>
                                    rehne do
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <Field label="Date"   a={String(l.slip.entry_date || l.slip.date || '').slice(0, 10) || '—'}
                                       diff={String(l.slip.entry_date || '').slice(0, 10) !== l.date} />
                                <Field label="Lorry"  a={l.slip.vehicle_no || '—'} diff={false} />
                                <Field label="Litres" a={(l.slip_liters == null ? '—' : l.slip_liters) + ' L'} diff={l.verdict === 'QTY_MISMATCH'} />
                                <Field label="Rate"   a={'₹' + (l.slip_rate == null ? '—' : l.slip_rate)} diff={l.verdict === 'RATE_MISMATCH'} />
                                <Field label="Amount" a={'₹' + Number(l.slip_amount || 0).toLocaleString('en-IN')}
                                       diff={l.verdict === 'AMOUNT_MISMATCH' || l.verdict === 'QTY_MISMATCH'} />
                                <div style={{ marginTop: '4px', fontSize: '10.5px', color: '#5d7196' }}>
                                  Memo {l.slip.memo_no || l.slip.id}
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        {/* ACTION TOOLS — always available, on the updated row */}
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap',
                                      padding: '8px 12px', borderTop: '1px solid #27395f', background: 'rgba(10,16,36,0.35)' }}>
                          <button onClick={() => setLinkingIdx(linkingIdx === l.idx ? null : l.idx)}
                            style={{ background: 'rgba(34,211,238,0.12)', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.5)',
                                     borderRadius: '6px', padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                            🔗 Link / Adjust
                          </button>
                          <button onClick={() => resolve(l.idx, 'ACCEPTED')}
                            style={{ background: decided === 'ACCEPTED' ? '#2fe39b' : 'rgba(47,227,155,0.12)',
                                     color: decided === 'ACCEPTED' ? '#0a1024' : '#2fe39b',
                                     border: '1px solid rgba(47,227,155,0.5)', borderRadius: '6px',
                                     padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                            ✅ Accept pump bill
                          </button>
                          <button onClick={() => resolve(l.idx, 'DISPUTED')}
                            style={{ background: decided === 'DISPUTED' ? '#ff6b81' : 'rgba(255,107,129,0.12)',
                                     color: decided === 'DISPUTED' ? '#0a1024' : '#ff6b81',
                                     border: '1px solid rgba(255,107,129,0.5)', borderRadius: '6px',
                                     padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                            ⚠ Dispute
                          </button>
                          {l.verdict === 'MATCHED' && !decided && (
                            <span style={{ color: '#2fe39b', fontSize: '11px', alignSelf: 'center', marginLeft: '4px' }}>
                              ✅ Ab dono taraf milte hain — kuch karne ki zaroorat nahi.
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* The other side of the audit: diesel we issued that this bill
                  does not carry. Nobody finds these from a total. */}
              {billAudit.unbilled_slips.length > 0 && (
                <div style={{ marginTop: '16px', borderTop: '1px solid #27395f', paddingTop: '12px' }}>
                  <div style={{ fontSize: '11px', color: '#ffb224', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                    Humne di, par is bill me nahi ({billAudit.unbilled_slips.length})
                  </div>
                  <div style={{ marginTop: '6px', maxHeight: '150px', overflowY: 'auto' }}>
                    {billAudit.unbilled_slips.map((u: any) => (
                      <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px',
                                               borderBottom: '1px solid #18244a', padding: '4px 0', fontSize: '12px' }}>
                        <span style={{ color: '#c4d1ea' }}>{u.date} · {u.key} · {u.liters == null ? '—' : u.liters}L</span>
                        <span style={{ color: '#ffb224', fontVariantNumeric: 'tabular-nums' }}>₹{Number(u.amount || 0).toLocaleString('en-IN')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* the pump layout we could not read, said plainly */}
          {scanMeta && scanMeta.refused && !billAudit && (
            <div className="glass-card" style={{ padding: '16px', borderLeft: '3px solid #ffb224' }}>
              <b style={{ color: '#ffb224', fontSize: '13px' }}>Yeh PDF seedha padha nahi ja saka</b>
              <p style={{ color: '#9aadd4', fontSize: '12px', margin: '6px 0 0', lineHeight: 1.5 }}>
                {scanMeta.refused_detail || scanMeta.refused}
                {' '}Photo wale bill ke ank khud check karein — unka OCR bharosemand nahi hai.
              </p>
            </div>
          )}

          <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
            <h3 style={{ color: '#22d3ee', marginTop: 0, marginBottom: '5px' }}>2. Match & Edit System Slips (Unbilled)</h3>
            <p style={{ color: '#9aadd4', fontSize: '12px', marginBottom: '15px' }}>Verify rates and quantities before posting to the Vendor Ledger.</p>
            
            {!reconVendor ? <p style={{ color: '#5d7196' }}>Select a vendor first to see pending slips...</p> : (
              <>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={{padding:'12px'}}>
                       <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#2fe39b' }} title="Select All Visible" 
                         checked={filteredUnbilledSlips.length > 0 && selectedSlips.length === filteredUnbilledSlips.length} 
                         onChange={handleSelectAllFilteredSlips} 
                       />
                    </th>
                    <th style={{padding:'12px'}}>Date & Vehicle</th>
                    <th style={{padding:'12px'}}>Qty (Ltr)</th>
                    <th style={{padding:'12px'}}>Rate (₹)</th>
                    <th style={{padding:'12px', textAlign: 'right'}}>Amount (₹)</th>
                    <th style={{padding:'12px', textAlign: 'center'}}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnbilledSlips.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No pending slips for this vendor in selected dates.</td></tr> : 
                    filteredUnbilledSlips.map((s, i) => (
                    <tr key={i} style={{ background: selectedSlips.includes(s.id) ? 'rgba(47, 227, 155,0.05)' : 'transparent', borderBottom: '1px solid #18244a' }}>
                      <td style={{padding:'12px'}}>
                        <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#2fe39b' }} checked={selectedSlips.includes(s.id)} onChange={() => toggleSlipSelection(s.id)} />
                      </td>
                      <td style={{padding:'12px'}}>
                        {s.date} <br/>
                        <b style={{ color: '#fff' }}>{s.vehicle_no}</b>
                      </td>
                      
                      {/* ✏️ EDITING MODE VS VIEW MODE */}
                      {editingSlipId === s.id ? (
                        <>
                          <td style={{padding:'12px'}}>
                            <input type="number" className="modern-input" style={{ width: '80px', padding: '5px' }} value={editSlipData.liters} onChange={e=>handleEditSlipChange('liters', e.target.value)} />
                          </td>
                          <td style={{padding:'12px'}}>
                            <input type="number" className="modern-input" style={{ width: '80px', padding: '5px', borderColor: '#ffb224' }} value={editSlipData.rate} onChange={e=>handleEditSlipChange('rate', e.target.value)} placeholder="Rate" />
                          </td>
                          <td style={{padding:'12px', textAlign: 'right'}}>
                            <input type="number" className="modern-input" style={{ width: '90px', padding: '5px', borderColor: '#2fe39b', color: '#2fe39b', fontWeight: 'bold' }} value={editSlipData.amount} onChange={e=>handleEditSlipChange('amount', e.target.value)} />
                          </td>
                          <td style={{padding:'12px', textAlign: 'center'}}>
                            <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                              <button onClick={saveEditedSlip} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>💾 Save</button>
                              <button onClick={() => setEditingSlipId('')} style={{ background: '#27395f', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{padding:'12px'}}>{s.liters} Ltr</td>
                          <td style={{padding:'12px', color: '#ffb224'}}>{s.rate || '-'}</td>
                          <td style={{ textAlign: 'right', color: '#22d3ee', fontWeight: 'bold', padding:'12px', fontSize: '15px' }}>₹{s.amount}</td>
                          <td style={{ textAlign: 'center', padding:'12px' }}>
                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                              <button onClick={() => startEditingSlip(s)} style={{ background: 'rgba(34, 211, 238, 0.1)', border: '1px solid #22d3ee', color: '#22d3ee', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>✏️ Edit</button>
                              <button onClick={() => deleteReconSlip(s.id)} style={{ background: 'rgba(255, 107, 129, 0.1)', border: '1px solid #ff6b81', color: '#ff6b81', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>🗑️ Del</button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            <GlobalPagination {...pgFilteredUnbilledSlips} />
              </>
            )}
          </div>

          {/* The bills the machine could not read, waiting to be keyed in.
              Clicking one puts the clerk into manual entry for that bill: the
              pump and the period are pre-filled from the queue, and the split
              screen below is where the lines get typed. */}
          <ManualBillQueue onEnter={(b: any) => {
            const NL = String.fromCharCode(10);
            if (b.vendor_id) handleVendorSelectRecon(b.vendor_id);
            if (b.period_from) setReconFromDate(String(b.period_from).slice(0, 10));
            if (b.period_to) setReconToDate(String(b.period_to).slice(0, 10));
            setScannedPumpItems([]); setScanMeta(null); setBillResolutions({});
            window.scrollTo({ top: 0, behavior: 'smooth' });
            alert('📝 Manual entry: ' + b.pump + ' · ' + b.cycle_label + NL + NL
              + 'File: ' + b.source_file + NL
              + 'Dikkat: ' + b.issue + NL + NL
              + (b.vendor_id ? 'Pump aur tareekh upar bhar di gayi hai.'
                             : '⚠️ Yeh pump vendor master me nahi mila — upar se khud chuniye.') + NL
              + 'Ab bill ke line upar "Match & Edit System Slips" me daaliye.');
          }} />

          {/* Every fortnight already settled, and one click into any of them. */}
          <SettledBills vendorId={reconVendor || null} />
          </div>
        </div>
      )}

      {/* 📈 TAB 3: ALL SLIPS HISTORY */}
      {activeTab === 'HISTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          
          <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px' }}>
            <div style={{ flex: 1.5 }}>
              <label style={{ fontSize:'11px', color:'#9aadd4' }}>Filter by Pump / Vendor</label>
              <select className="modern-input" value={historyVendor} onChange={e=>setHistoryVendor(e.target.value)}>
                <option value="ALL">-- All Pumps --</option>
                {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize:'11px', color:'#22d3ee' }}>From Date</label>
              <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={historyFromDate} onChange={e => setHistoryFromDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize:'11px', color:'#22d3ee' }}>To Date</label>
              <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={historyToDate} onChange={e => setHistoryToDate(e.target.value)} />
            </div>
            <div style={{ flex: 1.5 }}>
              <label style={{ fontSize:'11px', color:'#ffb224' }}>Search Vehicle / Memo No</label>
              <input type="text" className="modern-input" placeholder="Type to search..." value={historySearch} onChange={e => setHistorySearch(e.target.value)} />
            </div>
            {(historyFromDate || historyToDate || historySearch || historyVendor !== 'ALL') && (
               <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                 <button onClick={() => {setHistoryFromDate(''); setHistoryToDate(''); setHistorySearch(''); setHistoryVendor('ALL');}} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Clear</button>
               </div>
            )}
          </div>

          {/* ── what the list is actually showing ───────────────────────── */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
                        marginBottom: '14px' }}>
            {[['⏳ Baaki', historyCounts.PENDING, '#ffb224'],
              ['⚠️ Pump nahi juda', historyCounts.NO_PUMP, '#ff6b81'],
              ['✅ Settle ho gaye', historyCounts.SETTLED, '#2fe39b']].map((t: any) => (
              <div key={t[0]} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #27395f',
                                       borderRadius: '8px', padding: '7px 12px' }}>
                <span style={{ color: t[2], fontWeight: 800, fontSize: '15px' }}>{t[1]}</span>
                <span style={{ color: '#9aadd4', fontSize: '11.5px', marginLeft: '7px' }}>{t[0]}</span>
              </div>
            ))}
            <div style={{ color: '#5d7196', fontSize: '11.5px' }}>
              ₹{Math.round(historyCounts.open_amount).toLocaleString('en-IN')} abhi tak settle nahi hua
            </div>
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '7px',
                            color: showSettled ? '#2fe39b' : '#9aadd4', fontSize: '12px',
                            cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)}
                     style={{ accentColor: '#2fe39b', width: '15px', height: '15px', cursor: 'pointer' }} />
              Settle hue slip bhi dikhaayein
            </label>
          </div>

          {/* ── the memos no fortnight can ever pick up ──────────────────── */}
          {/* These are the reason ₹75 lakh of diesel reads as "pending". The
              memo carries the pump's WhatsApp nickname — 'B N filling' — where
              the master holds 'B N FILLING STATION', so it belongs to no
              vendor, lands in no fortnight, and can never be billed. The link
              is offered, never taken: two of these names reach more than one
              vendor row, and choosing for the desk would be a coin flip on
              104 memos. */}
          {unlinked?.names?.length > 0 && (
            <div style={{ border: '1px solid rgba(255,107,129,0.45)', borderRadius: '10px',
                          background: 'rgba(255,107,129,0.06)', padding: '14px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px',
                            flexWrap: 'wrap', alignItems: 'baseline' }}>
                <b style={{ color: '#ff6b81', fontSize: '13.5px' }}>
                  ⚠️ {unlinked.slips} slip kisi pump se jude nahi — ₹{Math.round(unlinked.amount).toLocaleString('en-IN')}
                </b>
                <span style={{ color: '#9aadd4', fontSize: '11.5px' }}>
                  Jab tak pump nahi juda, in ka 15-din ka bill ban hi nahi sakta.
                </span>
              </div>
              <div style={{ overflowX: 'auto', marginTop: '10px' }}>
                <table style={{ width: '100%', minWidth: '640px', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr>
                      {['Slip par likha naam', 'Slip', 'Rakam', 'Master ka pump', ''].map((h, i) => (
                        <th key={i} style={{ padding: '6px 9px', textAlign: i === 1 || i === 2 ? 'right' : 'left',
                                             fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.07em',
                                             color: '#5d7196', borderBottom: '1px solid #27395f' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {unlinked.names.map((n: any) => (
                      <tr key={n.vendor_name}>
                        <td style={{ padding: '7px 9px', borderBottom: '1px solid #18244a', color: '#eef3ff', fontWeight: 600 }}>
                          {n.vendor_name}
                          <div style={{ fontSize: '10px', color: '#5d7196', fontWeight: 400 }}>
                            {n.first_slip} → {n.last_slip}
                          </div>
                        </td>
                        <td style={{ padding: '7px 9px', borderBottom: '1px solid #18244a', color: '#c4d1ea',
                                     textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n.slips}</td>
                        <td style={{ padding: '7px 9px', borderBottom: '1px solid #18244a', color: '#c4d1ea',
                                     textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          ₹{Math.round(Number(n.amount)).toLocaleString('en-IN')}
                        </td>
                        <td style={{ padding: '7px 9px', borderBottom: '1px solid #18244a',
                                     color: n.suggested_vendor_id ? '#22d3ee' : '#ffb224' }}>
                          {n.suggested_vendor_name ?? n.advice}
                        </td>
                        <td style={{ padding: '7px 9px', borderBottom: '1px solid #18244a', textAlign: 'right' }}>
                          {n.suggested_vendor_id ? (
                            <button onClick={() => linkPump(n)}
                              style={{ background: 'rgba(47,227,155,0.14)', color: '#2fe39b',
                                       border: '1px solid rgba(47,227,155,0.5)', borderRadius: '6px',
                                       padding: '4px 11px', fontSize: '11.5px', fontWeight: 700, cursor: 'pointer' }}>
                              🔗 Jod dein
                            </button>
                          ) : (
                            <span style={{ color: '#5d7196', fontSize: '11px' }}>desk ka faisla</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {loading ? <p style={{ color: '#ffb224', textAlign: 'center', padding: '20px' }}>Loading History...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Date & Memo No</th>
                  <th>Vehicle & Driver</th>
                  <th>Petrol Pump</th>
                  <th>Type</th>
                  <th>Qty & Amount</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No Fuel Memos Found for selected filters.</td></tr> :
                  pgHistory.slice.map((f: any, i: number) => (
                  <tr key={f.id ?? i}>
                    <td>{f.entry_date}<br/><span style={{ color: '#ffb224', fontSize: '11px' }}>{f.memo_no}</span></td>
                    <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '14px' }}>
                      {f.vehicle_no}<br/>
                      <span style={{ fontSize: '10px', color: '#9aadd4', fontWeight: 'normal' }}>👤 {f.driver_name || 'N/A'}</span>
                    </td>
                    <td style={{ color: '#22d3ee' }}>{f.vendor_name}</td>
                    <td>
                      <span className="badge" style={{ background: f.fuel_type === 'ADVANCE' ? 'rgba(255, 107, 129,0.2)' : 'rgba(47, 227, 155,0.2)', color: f.fuel_type === 'ADVANCE' ? '#ff6b81' : '#2fe39b' }}>
                        {f.fuel_type || 'FIXED'}
                      </span>
                    </td>
                    <td>
                      <span style={{ color: '#fff', fontWeight: 'bold' }}>{f.liters} Ltr</span> <br/>
                      <small style={{ color: '#2fe39b' }}>₹{f.amount}</small>
                    </td>
                    <td>
                      {/* Three states, not two. "Pending" used to cover both a
                          memo waiting for its pump's fortnight to close and a
                          memo whose pump name reaches no vendor at all — which
                          no fortnight can ever pick up. The second one is work
                          for the desk and was invisible. */}
                      {(() => {
                        const s = f.slip_status
                          ?? (f.bill_status === 'BILLED_VERIFIED' ? 'SETTLED'
                              : (f.vendor_id ? 'PENDING' : 'NO_PUMP'));
                        const look: any = {
                          SETTLED: ['rgba(47,227,155,0.18)', '#2fe39b', '✅ Settled'],
                          PENDING: ['rgba(255,178,36,0.18)', '#ffb224', '⏳ Pending'],
                          NO_PUMP: ['rgba(255,107,129,0.18)', '#ff6b81', '⚠️ Pump nahi juda'],
                        }[s] ?? ['rgba(255,178,36,0.18)', '#ffb224', '⏳ Pending'];
                        return (
                          <>
                            <span className="badge" style={{ background: look[0], color: look[1] }}>
                              {look[2]}
                            </span>
                            {/* Which bill paid it — the difference between a
                                badge that claims and a badge that proves. */}
                            {s === 'SETTLED' && f.status_label && (
                              <div style={{ fontSize: '10px', color: '#5d7196', marginTop: '4px', maxWidth: '150px' }}>
                                {f.settled_invoice_no ? `Bill ${f.settled_invoice_no}` : f.status_label}
                              </div>
                            )}
                            {s === 'NO_PUMP' && (
                              <div style={{ fontSize: '10px', color: '#8a5c6a', marginTop: '4px', maxWidth: '150px' }}>
                                bill nahi ban sakta
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'center' }}>
                        <button className="wa-btn" onClick={() => sendFuelMemoWhatsApp(f)}>
                          💬 Direct
                        </button>
                        <button className="group-btn" onClick={() => sendFuelSlipToPumpGroup(f)}>
                          👥 Pump Group
                        </button>
                        {f.bill_status !== 'BILLED_VERIFIED' && (
                          <span 
                            onClick={() => handleDeleteHistorySlip(f.id, f.memo_no)} 
                            style={{ cursor: 'pointer', color: '#5d7196', fontSize: '16px', transition: '0.2s', marginTop: '5px' }}
                            onMouseOver={(e) => e.currentTarget.style.color = '#ff6b81'}
                            onMouseOut={(e) => e.currentTarget.style.color = '#5d7196'}
                            title="Delete Memo"
                          >
                            🗑️
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* The ERP's own pagination footer. `total` is the whole filtered
              set, not this page — a screen saying "1–10 of 10" while 501 slips
              wait would be lying about how much work is left. */}
          <GlobalPagination {...pgHistory} label="slips" />
        </div>
      )}

    </div>
  );
}

// ══ SETTLED 15-DAY BILLS, AND THE DRILL-DOWN ════════════════════════════════
//
// A settled fortnight is a document someone will be asked about months later —
// by the pump, by an auditor, or by the owner. So the modal shows what it was
// built from: every printed line, what our memo said beside it, what the desk
// decided, and who decided it. Nothing is recomputed here; it is read back from
// the bill's own `lines` and `resolutions`, exactly as they were at settlement.
// Recomputing would quietly restate history every time the screen is opened.
function SettledBills({ vendorId }: any) {
  const [bills, setBills] = useState<any[]>([]);
  const [outstanding, setOutstanding] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState(true);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      const j = await apiJson(`${API}/api/v1/fuel/pump-bill-settled`
        + (vendorId ? `?vendor_id=${vendorId}` : ''));
      setBills(j.bills ?? []);
      setOutstanding(j.outstanding ?? []);
    } catch { /* the panel just stays empty */ }
    setBusy(false);
  }, [vendorId]);
  useEffect(() => { load(); }, [load]);

  const inr = (n: any) => `₹${(Number(n) || 0).toLocaleString('en-IN')}`;
  const day = (d: any) => (d ? new Date(d).toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

  return (
    <div className="glass-card" style={{ padding: '20px', marginTop: '20px' }}>
      <h3 style={{ color: '#2fe39b', marginTop: 0, marginBottom: '4px' }}>🧾 Settled 15-Day Bills</h3>
      <p style={{ color: '#9aadd4', fontSize: '12px', marginTop: 0 }}>
        Kisi bhi bill par click karein — poori line-by-line audit khulegi.
      </p>

      {/* what each pump is still owed, live off its own khata */}
      {outstanding.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))',
                      gap: '10px', margin: '14px 0' }}>
          {outstanding.slice(0, 6).map((o: any) => (
            <div key={o.vendor_id} style={{ background: 'rgba(18,28,56,0.6)', border: '1px solid #27395f',
                                            borderRadius: '10px', padding: '10px 12px' }}>
              <div style={{ fontSize: '12px', color: '#c4d1ea' }}>{o.vendor_name}</div>
              <div style={{ fontSize: '19px', fontWeight: 800,
                            color: Number(o.outstanding) > 0 ? '#ffb224' : '#2fe39b',
                            fontVariantNumeric: 'tabular-nums' }}>
                {inr(o.outstanding)}
              </div>
              <div style={{ fontSize: '10.5px', color: '#5d7196' }}>
                bill {inr(o.billed)} · diya {inr(o.paid)} · {o.settled_fortnights} pakhwade settled
              </div>
              {Number(o.adjustment_count) > 0 && (
                <div style={{ fontSize: '10.5px', color: '#a78bfa' }}>
                  {o.adjustment_count} adjustment ({inr(o.adjustments)}) — balance me nahi joda gaya
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {busy ? <p style={{ color: '#5d7196' }}>Loading…</p> : bills.length === 0 ? (
        <p style={{ color: '#5d7196', fontSize: '13px' }}>Abhi koi 15-din ka bill settle nahi hua.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: '780px', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#5d7196', fontSize: '10.5px', textTransform: 'uppercase' }}>
                <th style={{ padding: '10px' }}>Invoice</th>
                <th style={{ padding: '10px' }}>Pump</th>
                <th style={{ padding: '10px' }}>Cycle</th>
                <th style={{ padding: '10px', textAlign: 'right' }}>Litre</th>
                <th style={{ padding: '10px', textAlign: 'right' }}>Bill</th>
                <th style={{ padding: '10px', textAlign: 'right' }}>Dispute</th>
                <th style={{ padding: '10px', textAlign: 'right' }}>Payable</th>
                <th style={{ padding: '10px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b: any) => (
                <tr key={b.id} onClick={() => setOpen(b)}
                    style={{ borderBottom: '1px solid #18244a', cursor: 'pointer' }}
                    title="Click to view details">
                  <td style={{ padding: '10px', fontFamily: 'monospace', color: '#22d3ee' }}>{b.invoice_no}</td>
                  <td style={{ padding: '10px', color: '#c4d1ea' }}>{b.vendor_name}</td>
                  <td style={{ padding: '10px', color: '#9aadd4' }}>{b.cycle_label}</td>
                  <td style={{ padding: '10px', textAlign: 'right', color: '#9aadd4', fontVariantNumeric: 'tabular-nums' }}>
                    {Number(b.total_liters || 0).toLocaleString('en-IN')}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', color: '#eef3ff', fontVariantNumeric: 'tabular-nums' }}>{inr(b.bill_amount)}</td>
                  <td style={{ padding: '10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                               color: Number(b.disputed_amount) > 0 ? '#ff6b81' : '#5d7196' }}>
                    {Number(b.disputed_amount) > 0 ? inr(b.disputed_amount) : '—'}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', color: '#2fe39b', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{inr(b.payable_amount)}</td>
                  <td style={{ padding: '10px' }}>
                    <span style={{ border: '1px solid ' + (b.locked ? '#2fe39b' : '#ffb224'),
                                   color: b.locked ? '#2fe39b' : '#ffb224', borderRadius: '99px',
                                   padding: '2px 8px', fontSize: '10px', fontWeight: 700 }}>
                      {b.locked ? '🔒 LOCKED' : b.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <BillDrillDown bill={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
// ══ THE DRILL-DOWN ══════════════════════════════════════════════════════════
//
// The lines are FETCHED, not taken from the row that was clicked. Every one of
// the 49 historical bills does carry its lines — the list view simply does not
// select them, and reading whatever the list happened to have is how this modal
// came up empty. The endpoint also falls back to the bill's own slip_ids, and
// then to the pump's memos over the period, so this table is never blank.
function BillDrillDown({ bill: seed, onClose, onChanged }: any) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  // Local edits live here until Save. `edits` is keyed by line idx, so a row
  // the clerk has touched is obvious and an untouched row is never rewritten.
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<number, any>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    apiJson(`${API}/api/v1/fuel/pump-bill/${seed.id}/details`)
      .then((j) => { if (!dead) setData(j); })
      .catch((e) => { if (!dead) setErr(e?.message ?? 'details load nahi hui'); });
    return () => { dead = true; };
  }, [seed.id]);

  useEffect(() => {
    const h = (e: any) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const bill = data?.bill ?? seed;
  // Every line as it will be saved: the stored row with any local edit on top.
  const lines: any[] = (data?.lines ?? []).map((l: any) =>
    (edits[l.idx] ? { ...l, ...edits[l.idx], edited: true } : l));
  const dirty = Object.keys(edits).length;

  const reload = async () => {
    const j = await apiJson(`${API}/api/v1/fuel/pump-bill/${seed.id}/details`);
    setData(j); setEdits({}); setEditIdx(null);
    onChanged?.();
  };

  /** Persist the edited rows. Refused while the fortnight is locked. */
  const saveLines = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await apiJson(`${API}/api/v1/fuel/pump-bill/${seed.id}/lines`, {
        method: 'PATCH', body: JSON.stringify({ lines }),
      });
      await reload();
      const NL = String.fromCharCode(10);
      setMsg(`✅ ${r.lines} line save ho gayi. Bill ab ₹${Number(r.bill_amount).toLocaleString('en-IN')}`
        + (Math.abs(r.ledger_gap) > 0.005
            ? ` — ledger abhi ₹${Number(r.posted_payable).toLocaleString('en-IN')} par hai,`
              + ` antar ₹${Math.abs(r.ledger_gap).toLocaleString('en-IN')}.`
              + NL + '"Update Ledger" dabaiye tab hisaab barabar hoga.'
            : '.'));
    } catch (e: any) {
      setErr(e?.code === 'FORTNIGHT_LOCKED'
        ? '🔒 ' + (e.message ?? 'Bill locked hai — pehle "Modify Bill" dabaiye.')
        : (e?.message ?? 'save nahi hui'));
    }
    setBusy(false);
  };

  /** Unlock the fortnight so it can be restated. Reason required. */
  const modifyBill = async () => {
    const reason = window.prompt('Yeh 15-din ka bill settle ho chuka hai. Kholne ka kaaran likhiye:');
    if (!reason || reason.trim().length < 6) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await apiJson(`${API}/api/v1/fuel/pump-bill-unlock/${seed.id}`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      await reload();
      setMsg('🔓 Bill khul gaya — ab lines badli ja sakti hain. '
        + (r.note ?? '') + ' Badalne ke baad "Update Ledger" dabana zaroori hai.');
    } catch (e: any) { setErr(e?.message ?? 'unlock nahi hua'); }
    setBusy(false);
  };

  /**
   * Bring the ledger to what the bill now says.
   *
   * A posted voucher is never rewritten — this posts a SECOND journal for the
   * difference only, which is what a correction looks like on paper.
   */
  const updateLedger = async () => {
    if (dirty && !window.confirm('Pehle save karna hoga. Bina save kiye ledger update nahi hoga. Save karke aage badhein?')) return;
    if (dirty) { await saveLines(); }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await apiJson(`${API}/api/v1/fuel/pump-bill/${seed.id}/post-correction`, {
        method: 'POST', body: JSON.stringify({ by: 'desk' }),
      });
      await reload();
      const NL = String.fromCharCode(10);
      setMsg(`✅ Ledger theek ho gaya. ₹${Number(r.was).toLocaleString('en-IN')} → `
        + `₹${Number(r.now).toLocaleString('en-IN')} (${r.direction === 'INCREASED' ? '+' : '−'}`
        + `₹${Math.abs(r.delta).toLocaleString('en-IN')}).` + NL
        + 'Purana voucher waisa hi hai — antar ka naya voucher bana hai.' + NL
        + (r.pump_outstanding ? `${bill.vendor_name} ka bakaya ab ₹${Number(r.pump_outstanding.outstanding).toLocaleString('en-IN')}.` + NL : '')
        + '🔒 Bill dobara lock ho gaya.');
    } catch (e: any) {
      setErr(e?.code === 'NOTHING_TO_CORRECT'
        ? 'Ledger pehle se sahi hai — koi antar nahi.'
        : (e?.message ?? 'correction post nahi hui'));
    }
    setBusy(false);
  };

  /** The bill as a message the pump can read, opened in WhatsApp. */
  const sendWhatsApp = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await apiJson(`${API}/api/v1/fuel/pump-bill/${seed.id}/summary-text`);
      if (!r.wa_url) { setErr(r.note ?? 'is pump ka number nahi hai'); setBusy(false); return; }
      window.open(r.wa_url, '_blank', 'noopener');
    } catch (e: any) { setErr(e?.message ?? 'summary nahi bani'); }
    setBusy(false);
  };
  const inr = (n: any) => `₹${(Number(n) || 0).toLocaleString('en-IN',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const STATUS: any = {
    MATCHED:   { t: '✅ Matched',            c: '#2fe39b' },
    ACCEPTED:  { t: '✅ Accepted as billed', c: '#2fe39b' },
    ADJUSTED:  { t: '✏️ Adjusted',           c: '#a78bfa' },
    DISPUTED:  { t: '⚠️ Disputed',           c: '#ff6b81' },
    RECORDED:  { t: '📄 As billed',          c: '#9aadd4' },
    FROM_MEMO: { t: '💬 From memo',          c: '#9aadd4' },
  };
  const st = (l: any) => STATUS[l.status] ?? { t: l.status ?? '—', c: '#ffb224' };

  const disputed = lines.filter((l) => l.status === 'DISPUTED');
  const adjusted = lines.filter((l) => l.status === 'ADJUSTED');
  // A rate that was derived rather than read off the pump's paper. Saying so is
  // the difference between an audit sheet and a guess with a total on it.
  const derived = lines.filter((l) => l.rate_basis && l.rate_basis !== 'FROM_BILL'
                                   && l.rate_basis !== 'SLIP_RATE');

  const printSheet = () => {
    const w = window.open('', '_blank', 'width=1040,height=800');
    if (!w) { alert('Print window block ho gayi — popup allow karein.'); return; }
    const esc = (t: any) => String(t ?? '').replace(/[&<>]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]);
    const rows = lines.map((l) => `<tr>
        <td>${esc(l.sno)}</td><td>${esc(l.date)}</td><td>${esc(l.vehicle)}</td>
        <td class="n">${esc(l.liters)}</td>
        <td class="n">${l.billed_rate == null ? '—' : esc(l.billed_rate)}${
          l.rate_basis && l.rate_basis !== 'FROM_BILL' ? ` <small>(${esc(l.rate_basis)})</small>` : ''}</td>
        <td class="n">${l.authorised_rate == null ? '—' : esc(l.authorised_rate)}</td>
        <td class="n">${Number(l.amount || 0).toFixed(2)}</td>
        <td>${esc(l.memo_no ?? (l.memo_id ? String(l.memo_id).slice(0, 8) : '—'))}</td>
        <td>${esc(st(l).t)}</td>
        <td>${esc((l.notes || []).join(' · '))}</td></tr>`).join('');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(bill.invoice_no)}</title>
      <style>
        @page{size:A4;margin:14mm}
        body{font:11px/1.4 system-ui,sans-serif;color:#111;margin:0}
        tr{break-inside:avoid} thead{display:table-header-group}
        h1{font-size:17px;margin:0 0 2px} h2{font-size:12px;font-weight:400;color:#555;margin:0 0 14px}
        table{border-collapse:collapse;width:100%;font-size:11px}
        th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}
        th{background:#eee} .n{text-align:right;font-variant-numeric:tabular-nums}
        small{color:#777}
        .sum{display:flex;gap:22px;margin:12px 0;font-size:12px}
        .sum b{display:block;font-size:15px}
        .note{margin:10px 0;padding:8px 10px;border:1px solid #e2c391;background:#fdf6e7;font-size:11px}
        .foot{margin-top:16px;font-size:10.5px;color:#555}
      </style>
      <h1>15-Day Consolidated Bill — ${esc(bill.invoice_no)}</h1>
      <h2>${esc(bill.vendor_name)} · ${esc(bill.cycle_label)} · ${esc(bill.period_from)} to ${esc(bill.period_to)}</h2>
      <div class="sum">
        <span>Total litres <b>${Number(bill.total_liters || 0).toLocaleString('en-IN')}</b></span>
        <span>Pump billed <b>${inr(bill.bill_amount)}</b></span>
        <span>Disputed <b>${inr(bill.disputed_amount)}</b></span>
        <span>Net payable <b>${inr(bill.payable_amount)}</b></span>
      </div>
      ${derived.length ? `<div class="note"><b>${derived.length} of ${lines.length} lines carry a DERIVED rate</b>,
        not one read from the pump's invoice. The slips were issued with litres and no price;
        the rule used is printed against each line.</div>` : ''}
      ${data?.source && data.source !== 'RECORDED'
        ? `<div class="note">${esc(data.source_note)}</div>` : ''}
      <table><thead><tr>
        <th>#</th><th>Date</th><th>Lorry No</th><th class="n">Litres</th>
        <th class="n">Billed rate</th><th class="n">Authorized rate</th>
        <th class="n">Amount</th><th>WhatsApp memo</th><th>Status</th><th>Note</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <div class="foot">
        Settled ${esc(bill.locked_at ? new Date(bill.locked_at).toLocaleString('en-IN')
                     : bill.created_at ? new Date(bill.created_at).toLocaleString('en-IN') : '—')}
        by ${esc(bill.locked_by ?? '—')} · voucher ${esc(bill.voucher_id ?? '—')}
        ${bill.locked ? '· LOCKED' : ''}
      </div>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const th = { padding: '8px 10px', textAlign: 'left' as const, fontSize: '10px',
               textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#5d7196',
               borderBottom: '1px solid #27395f', whiteSpace: 'nowrap' as const };
  const td = { padding: '8px 10px', borderBottom: '1px solid #18244a', color: '#c4d1ea' };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(5,9,20,0.82)',
               backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-start',
               justifyContent: 'center', overflowY: 'auto', padding: '24px' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(1220px, 100%)', background: '#0d1530', border: '1px solid #27395f',
                 borderRadius: '14px', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.6)' }}>

        <div style={{ padding: '18px 22px', borderBottom: '1px solid #27395f',
                      display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '10.5px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#5d7196' }}>
              15-Day Consolidated Bill Audit Details
            </div>
            <div style={{ fontSize: '21px', fontWeight: 800, color: '#eef3ff', marginTop: '3px' }}>
              {bill.vendor_name}
            </div>
            <div style={{ fontSize: '12.5px', color: '#9aadd4', marginTop: '2px' }}>
              <span style={{ fontFamily: 'monospace', color: '#22d3ee' }}>{bill.invoice_no}</span>
              {' · '}{bill.cycle_label}{' · '}{bill.period_from} → {bill.period_to}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* MODIFY comes before SAVE for a reason: a locked bill cannot be
                edited at all, so offering "save" on it would be offering a
                button that always refuses. */}
            {bill.locked ? (
              <button onClick={modifyBill} disabled={busy}
                style={{ background: 'rgba(255,178,36,0.12)', color: '#ffb224', border: '1px solid rgba(255,178,36,0.5)',
                         borderRadius: '8px', padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                🔓 Modify Bill
              </button>
            ) : (
              <>
                <button onClick={saveLines} disabled={busy || !dirty}
                  style={{ background: dirty ? '#2fe39b' : 'transparent', color: dirty ? '#0a1024' : '#5d7196',
                           border: '1px solid ' + (dirty ? '#2fe39b' : '#27395f'), borderRadius: '8px',
                           padding: '7px 13px', fontSize: '12px', fontWeight: 700,
                           cursor: dirty ? 'pointer' : 'not-allowed' }}>
                  💾 Save{dirty ? ' (' + dirty + ')' : ''}
                </button>
                <button onClick={updateLedger} disabled={busy}
                  title="Purana voucher waisa hi rehta hai — antar ka naya voucher banta hai"
                  style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.5)',
                           borderRadius: '8px', padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                  📘 Update Ledger
                </button>
              </>
            )}
            <button onClick={sendWhatsApp} disabled={busy}
              style={{ background: 'rgba(47,227,155,0.14)', color: '#2fe39b', border: '1px solid rgba(47,227,155,0.5)',
                       borderRadius: '8px', padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
              🟢 Send WhatsApp
            </button>
            <button onClick={printSheet} disabled={!lines.length}
              style={{ background: 'rgba(34,211,238,0.12)', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.5)',
                       borderRadius: '8px', padding: '7px 13px', fontSize: '12px', fontWeight: 700,
                       cursor: lines.length ? 'pointer' : 'not-allowed', opacity: lines.length ? 1 : 0.4 }}>
              🖨️ Print / PDF
            </button>
            <button onClick={onClose}
              style={{ background: 'transparent', border: '1px solid #27395f', color: '#9aadd4',
                       borderRadius: '8px', padding: '7px 12px', fontSize: '12px', cursor: 'pointer' }}>
              ✕ Band karein
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))',
                      gap: '1px', background: '#27395f' }}>
          {[
            ['Total litres', Number(bill.total_liters || 0).toLocaleString('en-IN'), '#eef3ff'],
            ['Pump ne laga', inr(bill.bill_amount), '#eef3ff'],
            ['Dispute me roka', inr(bill.disputed_amount), Number(bill.disputed_amount) > 0 ? '#ff6b81' : '#5d7196'],
            ['Net payable', inr(bill.payable_amount), '#2fe39b'],
            ['Status', bill.locked ? '🔒 Locked' : bill.status, bill.locked ? '#2fe39b' : '#ffb224'],
          ].map((c: any) => (
            <div key={c[0]} style={{ background: '#0d1530', padding: '12px 16px' }}>
              <div style={{ fontSize: '10px', color: '#5d7196', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{c[0]}</div>
              <div style={{ fontSize: '17px', fontWeight: 700, color: c[2], marginTop: '3px', fontVariantNumeric: 'tabular-nums' }}>{c[1]}</div>
            </div>
          ))}
        </div>

        {(msg || err) && (
          <div style={{ padding: '10px 22px', borderBottom: '1px solid #27395f', fontSize: '12.5px',
                        lineHeight: 1.55, whiteSpace: 'pre-line',
                        background: err ? 'rgba(255,107,129,0.08)' : 'rgba(47,227,155,0.08)',
                        color: err ? '#ff6b81' : '#2fe39b' }}>
            {err || msg}
          </div>
        )}

        {/* WHERE THESE LINES CAME FROM, and how much of the rate is an estimate.
            Both belong above the table: a reader should know what they are
            looking at before they read the figures. */}
        {(data && data.source !== 'RECORDED') && (
          <div style={{ padding: '10px 22px', borderBottom: '1px solid #27395f',
                        background: 'rgba(34,211,238,0.06)', color: '#9aadd4', fontSize: '12px' }}>
            ℹ️ {data.source_note}
          </div>
        )}
        {derived.length > 0 && (
          <div style={{ padding: '10px 22px', borderBottom: '1px solid #27395f',
                        background: 'rgba(255,178,36,0.07)', color: '#ffb224', fontSize: '12px', lineHeight: 1.5 }}>
            ⚠️ {derived.length} / {lines.length} line ka rate <b>nikala gaya hai</b>, pump ke bill se padha nahi —
            slip par litre thay, paisa nahi. Har line ke saamne likha hai kis niyam se rate laga
            ({Object.entries(data?.rate_bases ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}).
          </div>
        )}

        {(disputed.length > 0 || adjusted.length > 0) && (
          <div style={{ padding: '14px 22px', borderBottom: '1px solid #27395f',
                        background: 'rgba(255,107,129,0.05)' }}>
            <div style={{ fontSize: '10.5px', color: '#ff6b81', textTransform: 'uppercase',
                          letterSpacing: '0.1em', fontWeight: 700, marginBottom: '6px' }}>
              Discrepancy &amp; audit log
            </div>
            {disputed.map((l) => (
              <div key={'d' + l.idx} style={{ fontSize: '12.5px', color: '#ff6b81', lineHeight: 1.5 }}>
                ⚠️ Disputed — #{l.sno} {l.vehicle} on {l.date}: {(l.notes || []).join(' · ') || 'no note'}
                {' '}({inr(l.amount)} rok liya gaya)
              </div>
            ))}
            {adjusted.map((l) => (
              <div key={'a' + l.idx} style={{ fontSize: '12.5px', color: '#a78bfa', lineHeight: 1.5 }}>
                ✏️ Adjusted — #{l.sno} {l.vehicle} on {l.date}: {(l.notes || []).join(' · ') || 'linked by hand'}
              </div>
            ))}
          </div>
        )}

        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          <table style={{ width: '100%', minWidth: '980px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#0d1530' }}>
              <tr>
                <th style={th}>#</th><th style={th}>Date</th><th style={th}>Lorry No</th>
                <th style={{ ...th, textAlign: 'right' }}>Litres</th>
                <th style={{ ...th, textAlign: 'right' }}>Billed rate</th>
                <th style={{ ...th, textAlign: 'right' }}>Authorized rate</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                <th style={th}>WhatsApp memo</th><th style={th}>Audit status</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {err ? (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#ff6b81', padding: '26px' }}>{err}</td></tr>
              ) : !data ? (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#5d7196', padding: '26px' }}>Lines khul rahi hain…</td></tr>
              ) : lines.length === 0 ? (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: '#5d7196', padding: '26px' }}>
                  Is pump ka is period me koi memo bhi nahi mila — na bill par line, na register me slip.
                </td></tr>
              ) : lines.map((l) => {
                const s = st(l);
                const rateDiff = l.authorised_rate != null && l.billed_rate != null
                  && Math.abs(Number(l.authorised_rate) - Number(l.billed_rate)) > 0.005;
                const editing = editIdx === l.idx;
                const touched = !!edits[l.idx];
                // While the fortnight is locked nothing here may move — the
                // trigger would refuse it anyway, and offering a pencil that
                // always fails is worse than not offering one.
                const canEdit = !bill.locked;

                // Editing litres or rate recomputes the amount as the clerk
                // types, because a row whose three figures disagree is the very
                // thing this screen exists to catch.
                const put = (field: string, v: string) => setEdits((e) => {
                  const cur = { ...(e[l.idx] ?? {}) };
                  cur[field] = v === '' ? null : (field === 'vehicle' ? v : Number(v));
                  if (field === 'liters' || field === 'billed_rate') {
                    const q = Number(cur.liters ?? l.liters) || 0;
                    const r = Number(cur.billed_rate ?? l.billed_rate) || 0;
                    if (q && r) cur.amount = Number((q * r).toFixed(2));
                  }
                  return { ...e, [l.idx]: cur };
                });
                const cell = (field: string, val: any, w = '82px') => (
                  <input value={val ?? ''} onChange={(ev) => put(field, ev.target.value)}
                    style={{ width: w, background: '#0a1024', border: '1px solid #3d548a', borderRadius: '5px',
                             color: '#eef3ff', padding: '3px 6px', fontSize: '12px',
                             fontVariantNumeric: 'tabular-nums', textAlign: field === 'vehicle' ? 'left' : 'right' }} />
                );

                return (
                  <tr key={l.idx} style={{ background: touched ? 'rgba(167,139,250,0.08)' : 'transparent' }}>
                    <td style={td}>{l.sno}</td>
                    <td style={td}>{l.date}</td>
                    <td style={{ ...td, fontFamily: 'monospace' }}>
                      {editing ? cell('vehicle', l.vehicle, '120px') : (l.vehicle ?? '—')}
                      {!editing && l.driver && (
                        <div style={{ fontSize: '10px', color: '#5d7196', fontFamily: 'system-ui' }}>{l.driver}</div>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {editing ? cell('liters', l.liters, '70px') : (l.liters ?? '—')}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 color: rateDiff ? '#ffb224' : '#c4d1ea' }}>
                      {editing ? cell('billed_rate', l.billed_rate, '76px') : <>₹{l.billed_rate ?? '—'}</>}
                      {!editing && l.rate_basis && l.rate_basis !== 'FROM_BILL' && (
                        <div style={{ fontSize: '9.5px', color: '#ffb224', fontFamily: 'system-ui' }}
                             title="Yeh rate nikala gaya hai, bill se padha nahi">
                          {l.rate_basis}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 color: rateDiff ? '#2fe39b' : '#5d7196' }}>₹{l.authorised_rate ?? '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#eef3ff' }}>
                      {editing ? cell('amount', l.amount, '96px') : inr(l.amount)}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11.5px', color: '#9aadd4' }}>
                      {l.memo_no ?? (l.memo_id ? String(l.memo_id).slice(0, 8) : '—')}
                      {l.reusable === false && l.settled_label && (
                        <div style={{ fontSize: '9.5px', color: '#5d7196', fontFamily: 'system-ui' }}>
                          {l.settled_label}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, color: s.c, whiteSpace: 'nowrap' }}>
                      {touched ? <span style={{ color: '#c4b5fd' }}>✏️ Badla gaya</span> : s.t}
                    </td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canEdit ? (
                        <button onClick={() => setEditIdx(editing ? null : l.idx)}
                          style={{ background: 'transparent', border: '1px solid #3d548a', color: '#9aadd4',
                                   borderRadius: '5px', padding: '2px 8px', fontSize: '10.5px', cursor: 'pointer' }}>
                          {editing ? '✓ ho gaya' : '✏️ Edit'}
                        </button>
                      ) : (
                        <span title="Bill locked hai — pehle Modify Bill dabaiye"
                              style={{ color: '#5d7196', fontSize: '11px' }}>🔒</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid #27395f',
                      fontSize: '11.5px', color: '#5d7196', display: 'flex',
                      gap: '20px', flexWrap: 'wrap' }}>
          <span>Lines: <b style={{ color: '#c4d1ea' }}>{lines.length}</b></span>
          <span>Settled: <b style={{ color: '#c4d1ea' }}>
            {bill.locked_at ? new Date(bill.locked_at).toLocaleString('en-IN')
              : bill.created_at ? new Date(bill.created_at).toLocaleString('en-IN') : '—'}</b></span>
          <span>By: <b style={{ color: '#c4d1ea' }}>{bill.locked_by ?? '—'}</b></span>
          <span>Voucher: <b style={{ color: '#c4d1ea', fontFamily: 'monospace' }}>
            {bill.voucher_id ? String(bill.voucher_id).slice(0, 8) : '—'}</b></span>
          {bill.locked && <span style={{ color: '#2fe39b' }}>🔒 Locked — is period me ab koi badlav nahi</span>}
        </div>
      </div>
    </div>
  );
}

// ══ MANUAL REVIEW QUEUE ═════════════════════════════════════════════════════
//
// The bills the parser refused, waiting to be keyed in — grouped by fortnight,
// then by pump, then by bill. That order is not a preference: a pump BILLS a
// fortnight at a time, so a clerk works a fortnight at a time, and sorting by
// upload date would scatter one cycle's paper down the whole list with no way
// to tell when June was finished.
//
// The pump and the period on these rows come from the FILENAME, because the
// whole reason a bill is here is that its contents could not be read. They sort
// the queue; they never post money. The entry screen makes a person confirm
// them.
function ManualBillQueue({ onEnter }: any) {
  const [data, setData] = useState<any>(null);
  const [openCycle, setOpenCycle] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);

  const load = React.useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const j = await apiJson(`${API}/api/v1/fuel/pump-bill-queue?status=NEEDS_ENTRY`);
      setData(j);
      // Open the newest cycle by default — it is the one being worked.
      setOpenCycle((c) => c ?? (j.cycles?.[0]?.cycle ?? null));
    } catch (e: any) { setErr(e?.message ?? 'queue load nahi hui'); }
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  /** Show the system a folder of bills. Each one is tried and recorded. */
  const addFiles = async (e: any) => {
    const files: File[] = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(files.length);
    let queued = 0; let readable = 0; let already = 0;
    for (const file of files) {
      try {
        const b64: string = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] ?? '');
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        // webkitRelativePath keeps the folder, and the folder is the pump —
        // "Alam/June 30.06.2026.pdf". Without it the pump is unknown and the
        // bill lands in the queue with nothing to sort it by.
        const rel = (file as any).webkitRelativePath || file.name;
        const j = await apiJson(`${API}/api/v1/fuel/pump-bill-scan`, {
          method: 'POST',
          body: JSON.stringify({ pdf_base64: b64, source_file: rel, uploaded_by: 'desk' }),
        });
        if (j.already) already += 1; else { queued += 1; if (j.readable) readable += 1; }
      } catch { /* one bad file must not stop the folder */ }
      setUploading((n) => n - 1);
    }
    setUploading(0);
    const NL = String.fromCharCode(10);
    alert(`${files.length} file dekhi gayi.` + NL
      + `${queued} nayi darj hui — inme ${readable} apne aap padh li gayi.` + NL
      + (already ? `${already} pehle se darj thi.` + NL : '')
      + `Baaki manual queue me hain.`);
    await load();
  };

  const cycles = data?.cycles ?? [];
  const totals = data?.totals ?? {};

  const th = { padding: '7px 10px', textAlign: 'left' as const, fontSize: '10px',
               textTransform: 'uppercase' as const, letterSpacing: '0.08em',
               color: '#5d7196', borderBottom: '1px solid #27395f', whiteSpace: 'nowrap' as const };
  const td = { padding: '7px 10px', borderBottom: '1px solid #18244a', color: '#c4d1ea' };

  return (
    <div className="glass-card" style={{ padding: '20px', marginTop: '20px', borderTop: '3px solid #ffb224' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ color: '#ffb224', margin: 0 }}>📂 Manual Review Queue</h3>
          <p style={{ color: '#9aadd4', fontSize: '12px', margin: '4px 0 0', lineHeight: 1.5, maxWidth: '62ch' }}>
            Jo bill machine nahi padh saki. 15-din ke cycle, phir pump, phir bill —
            usi tarteeb me jisme kaam hota hai. Pump aur tareekh <b>file ke naam</b> se
            aayi hai, isliye entry karte waqt use confirm karna hoga.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {[['Baaki', totals.needs_entry, '#ffb224'], ['Padh li', totals.parsed, '#2fe39b'],
            ['Ho gayi', totals.entered, '#9aadd4']].map((t: any) => (
            <div key={t[0]} style={{ textAlign: 'center', minWidth: '58px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: t[2] }}>{t[1] ?? 0}</div>
              <div style={{ fontSize: '9.5px', color: '#5d7196', textTransform: 'uppercase' }}>{t[0]}</div>
            </div>
          ))}
          <label style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd',
                          border: '1px solid rgba(167,139,250,0.5)', borderRadius: '8px',
                          padding: '8px 14px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
            {uploading ? `⏳ ${uploading} baaki…` : '📥 Bill folder daalein'}
            {/* A whole pump folder at once, because that is how they are kept. */}
            <input type="file" multiple accept=".pdf,image/*" style={{ display: 'none' }}
                   onChange={addFiles} disabled={!!uploading}
                   {...({ webkitdirectory: '', directory: '' } as any)} />
          </label>
        </div>
      </div>

      {err && <p style={{ color: '#ff6b81', fontSize: '13px', marginTop: '12px' }}>{err}</p>}
      {busy && !data && <p style={{ color: '#5d7196', marginTop: '12px' }}>Queue khul rahi hai…</p>}

      {data && cycles.length === 0 && (
        <p style={{ color: '#5d7196', fontSize: '13px', marginTop: '14px' }}>
          Queue khaali hai. Upar se pump ka folder daaliye — har bill try hogi, aur jo
          nahi padhi jayegi wo yahan cycle ke hisaab se lag jayegi.
        </p>
      )}

      {/* ── accordion: cycle → pump → bill ──────────────────────────────── */}
      <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {cycles.map((c: any) => {
          const open = openCycle === c.cycle;
          return (
            <div key={c.cycle} style={{ border: '1px solid ' + (open ? '#3d548a' : '#27395f'),
                                        borderRadius: '10px', overflow: 'hidden',
                                        background: open ? 'rgba(24,36,74,0.5)' : 'rgba(18,28,56,0.4)' }}>
              <button onClick={() => setOpenCycle(open ? null : c.cycle)}
                style={{ width: '100%', display: 'flex', justifyContent: 'space-between',
                         alignItems: 'center', gap: '12px', background: 'transparent', border: 'none',
                         padding: '11px 14px', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <span style={{ color: '#9aadd4', fontSize: '12px', width: '10px' }}>{open ? '▾' : '▸'}</span>
                  <b style={{ color: '#eef3ff', fontSize: '14px' }}>{c.cycle_label}</b>
                  {c.period_from && (
                    <span style={{ color: '#5d7196', fontSize: '11.5px' }}>
                      {c.period_from} → {c.period_to}
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: '14px', fontSize: '11.5px', color: '#9aadd4', whiteSpace: 'nowrap' }}>
                  <span>{c.pumps.length} pump</span>
                  <span style={{ color: '#ffb224', fontWeight: 700 }}>{c.bills} bill</span>
                  <span>{c.pages || '—'} page</span>
                </span>
              </button>

              {open && (
                <div style={{ borderTop: '1px solid #27395f' }}>
                  {c.pumps.map((p: any) => (
                    <div key={p.pump} style={{ borderBottom: '1px solid #18244a' }}>
                      <div style={{ padding: '7px 14px 4px 34px', display: 'flex',
                                    justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                        <b style={{ color: '#22d3ee', fontSize: '12.5px' }}>⛽ {p.pump}</b>
                        <span style={{ color: '#5d7196', fontSize: '11px' }}>{p.bills.length} bill</span>
                      </div>
                      <div style={{ overflowX: 'auto', padding: '0 14px 10px 34px' }}>
                        <table style={{ width: '100%', minWidth: '720px', borderCollapse: 'collapse', fontSize: '12px' }}>
                          <thead>
                            <tr>
                              <th style={th}>Billing cycle</th>
                              <th style={th}>Pump</th>
                              <th style={th}>Bill no.</th>
                              <th style={{ ...th, textAlign: 'right' }}>Pages</th>
                              <th style={th}>Issue</th>
                              <th style={th} />
                            </tr>
                          </thead>
                          <tbody>
                            {p.bills.map((b: any) => (
                              <tr key={b.id} style={{ cursor: 'pointer' }}
                                  onClick={() => onEnter?.(b)}
                                  title="Manual entry kholne ke liye click karein">
                                <td style={{ ...td, whiteSpace: 'nowrap' }}>{b.cycle_label}</td>
                                <td style={td}>{b.pump}</td>
                                <td style={{ ...td, fontFamily: 'monospace', fontSize: '11.5px' }}>
                                  {b.bill_no_hint ?? <span style={{ color: '#5d7196' }}>{b.source_file}</span>}
                                </td>
                                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                  {b.pages ?? '—'}
                                </td>
                                <td style={{ ...td, color: '#ffb224' }}>
                                  {b.issue}
                                  {Number(b.text_lines) > 0 && (
                                    <span style={{ color: '#5d7196' }}> · {b.text_lines} text line</span>
                                  )}
                                </td>
                                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  <span style={{ color: '#22d3ee', fontSize: '11.5px', fontWeight: 700 }}>
                                    Manual entry →
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
