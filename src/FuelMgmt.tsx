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
    } catch (e) { console.error(e); }
    setLoading(false);
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

      const recon = await apiJson(`${QUEUES_API}/fuel-reconcile`, {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: reconVendor,
          slip_ids: selectedSlips,
          bill_amount: parseFloat(vendorBillAmount) || 0,
          from: reconFromDate || undefined,
          to: reconToDate || undefined,
        }),
      });
      const tripsBumped = recon.trips_adjusted ?? 0;

      alert(`✅ SUCCESS: Slips Reconciled!\n\n₹${vendorBillAmount} POSTED to ${vName}'s Ledger Account.\n🚛 ${tripsBumped} trips ke kharche me diesel value update ho gayi (P&L me dikhega).`);
      
      setVendorBillAmount('');
      setSelectedSlips([]);
      fetchData(); 
      handleVendorSelectRecon(reconVendor); 
      
    } catch (e: any) {
      alert(e?.code === 'ALREADY_POSTED'
        ? "⚠️ Ye bill pehle hi verify ho chuka hai — dobara post nahi hoga."
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
  const filteredHistory = fuelHistory.filter(f => {
     const matchVendor = historyVendor === 'ALL' || f.vendor_id === historyVendor;
     let matchDate = true;
     if (historyFromDate && f.date < historyFromDate) matchDate = false;
     if (historyToDate && f.date > historyToDate) matchDate = false;

     let matchSearch = true;
     if (historySearch) {
        const q = historySearch.toLowerCase();
        matchSearch = (f.vehicle_no || '').toLowerCase().includes(q) || 
                      (f.driver_name || '').toLowerCase().includes(q) ||
                      (f.memo_no || '').toLowerCase().includes(q);
     }
     return matchVendor && matchDate && matchSearch;
  });

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

              {auditRows.length === 0 ? (
                <p style={{ color: '#5d7196', fontSize: '13px' }}>
                  {auditFilter === 'FLAGGED' ? '✅ Koi gadbad nahi — har line memo se milti hai.' : 'Koi line nahi.'}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '520px', overflowY: 'auto' }}>
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
                                                borderRadius: '10px', overflow: 'hidden' }}>

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
                  filteredHistory.map((f, i) => (
                  <tr key={i}>
                    <td>{f.date}<br/><span style={{ color: '#ffb224', fontSize: '11px' }}>{f.memo_no}</span></td>
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
                      <span className="badge" style={{ background: f.bill_status === 'BILLED_VERIFIED' ? 'rgba(47, 227, 155,0.2)' : 'rgba(255, 107, 129,0.2)', color: f.bill_status === 'BILLED_VERIFIED' ? '#2fe39b' : '#ff6b81' }}>
                        {f.bill_status === 'BILLED_VERIFIED' ? '✅ Reconciled' : '⏳ Pending'}
                      </span>
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
        </div>
      )}

    </div>
  );
}