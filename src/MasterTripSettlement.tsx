// @ts-nocheck
// 🧾 MASTER TRIP SETTLEMENT — consolidated driver/vehicle trip hisaab.
// Replaces the standalone "Unloading Details" nav slot; the unloading/close-trip
// flow lives on as the second tab (UnloadingDetails component, unchanged).
//
// Flow: pick Vehicle/Driver + date range → all UNSETTLED trips in the window
// list with date-wise HSD (FUEL_ENTRIES) and cash advances (DRIVER_TRANSACTIONS)
// → tick trips → add extra en-route expenses → Net Balance → either
// "Carry Forward" (parks the balance, consumed by the next settlement) or
// "Post to Driver Ledger" (SALARY_CREDIT in driver khata + idempotent JOURNAL).
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { getField, toISODate, isDateInRange, round2, getTripFreight, getTripAdvances } from './lib/accounting/tripMath';
import { postEntry } from './lib/accounting/journal';
import { sendWhatsApp, waResultText } from './lib/waSend';
import UnloadingDetails from './UnlodingDetals';

const num = (v: any) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const normV = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const inr = (n: number) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function MasterTripSettlement() {
  const [activeTab, setActiveTab] = useState('SETTLEMENT');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  const [trips, setTrips] = useState<any[]>([]);
  const [fuelEntries, setFuelEntries] = useState<any[]>([]);
  const [driverTxns, setDriverTxns] = useState<any[]>([]);
  const [settlements, setSettlements] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]); // fixed-expense fallback for old trips

  // 🎛️ Filters
  const [vehicleFilter, setVehicleFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState('');
  const [includeHsd, setIncludeHsd] = useState(false);

  // ➕ Extra en-route expenses (maintenance, dhaba, police, misc…)
  const [extraExpenses, setExtraExpenses] = useState<any[]>([]);
  const [newExpName, setNewExpName] = useState('');
  const [newExpAmt, setNewExpAmt] = useState('');

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const safe = (p) => p.catch(() => ({ docs: [] }));
      const [tSnap, fSnap, dtSnap, sSnap, drSnap, vSnap, rSnap] = await Promise.all([
        safe(getDocs(collection(db, 'TRIPS'))),
        safe(getDocs(collection(db, 'FUEL_ENTRIES'))),
        safe(getDocs(collection(db, 'DRIVER_TRANSACTIONS'))),
        safe(getDocs(collection(db, 'TRIP_SETTLEMENTS'))),
        safe(getDocs(collection(db, 'DRIVERS'))),
        safe(getDocs(collection(db, 'VEHICLES'))),
        safe(getDocs(collection(db, 'RTKM_MASTER'))),
      ]);
      const m = (s) => s.docs.map(d => ({ id: d.id, ...d.data() }));
      setTrips(m(tSnap)); setFuelEntries(m(fSnap)); setDriverTxns(m(dtSnap));
      setSettlements(m(sSnap)); setDrivers(m(drSnap)); setVehicles(m(vSnap));
      setRtkmMaster(m(rSnap));
    } catch (e) { console.error('Settlement fetch error:', e); }
    setLoading(false);
  };

  // ── Per-trip data joins ────────────────────────────────────────────────
  const bizId = (t: any) => String(getField(t, ['Trip_ID', 'trip_id']) || t.id);
  const tripVehicle = (t: any) => String(getField(t, ['Vehical_No', 'vehicle_no', 'vehical_no']) || '');
  const tripDriver = (t: any) => String(getField(t, ['Driver_Name', 'driver_name']) || '');
  const tripDate = (t: any) => toISODate(getField(t, ['Loading_Date', 'loading_date', 'sort_date', 'start_date']));
  const tripRoute = (t: any) => `${getField(t, ['Loading_Point', 'loading_point']) || '?'} ➔ ${getField(t, ['Consignee_Name', 'consignee_name']) || '?'}`;
  const tripChallan = (t: any) => String(getField(t, ['Challan_No', 'challan_no']) || '—');

  // Date-wise HSD rows for a trip (FIXED route diesel + retro fuel bills).
  const tripFuelRows = (t: any) => fuelEntries.filter(f =>
    (f.trip_db_id === t.id || (f.trip_id && f.trip_id === bizId(t))) &&
    f.fuel_type !== 'ADVANCE'
  ).sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Date-wise cash advances: driver khata rows tagged with this trip.
  const CASH_TYPES = ['ADVANCE_GIVEN', 'PAYMENT_GIVEN', 'ADVANCE'];
  const tripCashRows = (t: any) => driverTxns.filter(x =>
    x.trip_id && x.trip_id === bizId(t) && CASH_TYPES.includes(x.txn_type)
  ).sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const tripHsd = (t: any) => {
    const rows = tripFuelRows(t);
    if (rows.length) return { ltr: round2(rows.reduce((s, r) => s + num(r.liters), 0)), amt: round2(rows.reduce((s, r) => s + num(r.amount), 0)) };
    // Fallback to trip roll-up counters when no FUEL_ENTRIES rows exist (old data).
    return { ltr: 0, amt: round2(num(getField(t, ['hsd_issued', 'diesel_amount']))) };
  };

  const tripCash = (t: any) => {
    const rowSum = round2(tripCashRows(t).reduce((s, r) => s + num(r.amount), 0));
    // Roll-up counters and khata rows normally agree (both written together);
    // max() covers old trips where one side is missing, without double-counting.
    return Math.max(rowSum, getTripAdvances(t));
  };

  const tripAllowance = (t: any) => round2(num(getField(t, ['fixed_cash', 'Fixed_Cash'])));

  // 🎯 FIXED EXPENSES (Trip Command Center parity) — targets stamped on the
  // trip; older trips fall back to the RTKM Master route (same consignee
  // matcher the Command Center fuel modal uses). Display-only: settlement
  // math/totals deliberately do NOT read from this.
  const looseMatch = (a: any, b: any) => {
    if (!a || !b) return false;
    const s1 = String(a).toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
    return s1 === s2 || s1.includes(s2) || s2.includes(s1);
  };
  const tripFixed = (t: any) => {
    let hsdL = num(getField(t, ['fixed_hsd', 'Fixed_HSD']));
    let cash = num(getField(t, ['fixed_cash', 'Fixed_Cash']));
    let fromMaster = false;
    if (hsdL <= 0 && cash <= 0) {
      const consignee = getField(t, ['Consignee_Name', 'consignee_name']);
      const route = rtkmMaster.find(m => looseMatch(m.Consignee_Name || m.consignee_name || m.unloading_point || m.Destination, consignee));
      if (route) {
        hsdL = num(getField(route, ['Fixed_HSD_Qty', 'Fixed_HSD', 'fixed_hsd']));
        cash = num(getField(route, ['Fixed_Cash_Amt', 'Fixed_Cash', 'fixed_cash']));
        fromMaster = hsdL > 0 || cash > 0;
      }
    }
    return {
      hsdL: round2(hsdL), cash: round2(cash), fromMaster,
      toll: round2(num(getField(t, ['toll_amt', 'toll_amount', 'Toll_Amt']))),
      hsdIssuedL: round2(num(getField(t, ['hsd_issued']))),
    };
  };

  // ── Unsettled trip list for current filters ────────────────────────────
  const filterReady = !!(vehicleFilter || driverFilter);
  const unsettledTrips = !filterReady ? [] : trips.filter(t => {
    if (t.settlement_status) return false; // SETTLED or CARRIED_FORWARD
    if (t.trip_status === 'ADVICE') return false; // pre-trip advice — settle only after it becomes a real trip
    if (vehicleFilter && normV(tripVehicle(t)) !== normV(vehicleFilter)) return false;
    if (driverFilter && tripDriver(t).toUpperCase() !== driverFilter.toUpperCase()) return false;
    return isDateInRange(tripDate(t), fromDate || undefined, toDate || undefined);
  }).sort((a, b) => tripDate(a).localeCompare(tripDate(b)));

  const selectedTrips = unsettledTrips.filter(t => selectedIds.has(t.id));

  // 🔁 Open carry-forwards for this driver (or vehicle when no driver picked).
  const openCarryForwards = settlements.filter(s =>
    s.mode === 'CARRY_FORWARD' && s.status !== 'CONSUMED' &&
    (driverFilter ? String(s.driver_name || '').toUpperCase() === driverFilter.toUpperCase()
                  : vehicleFilter ? normV(s.vehicle_no) === normV(vehicleFilter) : false)
  );

  // ── Totals ─────────────────────────────────────────────────────────────
  const totCash = round2(selectedTrips.reduce((s, t) => s + tripCash(t), 0));
  const totHsdAmt = round2(selectedTrips.reduce((s, t) => s + tripHsd(t).amt, 0));
  const totHsdLtr = round2(selectedTrips.reduce((s, t) => s + tripHsd(t).ltr, 0));
  const totAllowance = round2(selectedTrips.reduce((s, t) => s + tripAllowance(t), 0));
  const totFreight = round2(selectedTrips.reduce((s, t) => s + getTripFreight(t), 0));
  const totExtra = round2(extraExpenses.reduce((s, x) => s + num(x.amount), 0));
  const cfEarned = round2(openCarryForwards.reduce((s, c) => s + num(c.earned_total), 0));
  const cfNet = round2(openCarryForwards.reduce((s, c) => s + num(c.net_balance), 0));
  // Net: what the driver has earned (bhatta + approved extras + carried balance)
  // minus what he already took (cash advances; HSD only if the toggle says so).
  const netBalance = round2(totAllowance + totExtra + cfNet - totCash - (includeHsd ? totHsdAmt : 0));

  const toggleTrip = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const toggleAll = () => setSelectedIds(prev =>
    prev.size === unsettledTrips.length ? new Set() : new Set(unsettledTrips.map(t => t.id)));

  const addExtraExpense = () => {
    if (!newExpName.trim() || !num(newExpAmt)) return alert('⚠️ Expense name aur amount dono bharein!');
    setExtraExpenses(prev => [...prev, { id: `x_${prev.length}_${newExpName.trim().slice(0, 8)}`, name: newExpName.trim(), amount: num(newExpAmt) }]);
    setNewExpName(''); setNewExpAmt('');
  };

  // ── Settlement writers ─────────────────────────────────────────────────
  const settlementDraft = (mode: string) => ({
    settlement_no: `STL-${Date.now()}`,
    mode, // 'POSTED' | 'CARRY_FORWARD'
    status: mode === 'CARRY_FORWARD' ? 'OPEN' : 'CLOSED',
    vehicle_no: vehicleFilter || tripVehicle(selectedTrips[0]) || '',
    driver_name: driverFilter || tripDriver(selectedTrips[0]) || '',
    from_date: fromDate || '', to_date: toDate || '',
    trip_ids: selectedTrips.map(bizId), trip_db_ids: selectedTrips.map(t => t.id),
    trip_count: selectedTrips.length,
    totals: { cash: totCash, hsd_amt: totHsdAmt, hsd_ltr: totHsdLtr, allowance: totAllowance, extra: totExtra, freight: totFreight },
    extra_expenses: extraExpenses.map(x => ({ name: x.name, amount: num(x.amount) })),
    include_hsd_in_recovery: includeHsd,
    carried_in: openCarryForwards.map(c => ({ id: c.id, settlement_no: c.settlement_no, net: num(c.net_balance) })),
    // earned side that has NOT yet hit the driver khata (advances hit it when given)
    earned_total: round2(totAllowance + totExtra + cfEarned),
    net_balance: netBalance,
    created_at: serverTimestamp(),
  });

  const stampTrips = async (status: string, stlNo: string) => {
    for (const t of selectedTrips) {
      await updateDoc(doc(db, 'TRIPS', t.id), { settlement_status: status, settlement_no: stlNo, settled_at: new Date().toISOString() });
    }
  };
  const consumeCarryForwards = async (stlNo: string) => {
    for (const c of openCarryForwards) {
      await updateDoc(doc(db, 'TRIP_SETTLEMENTS', c.id), { status: 'CONSUMED', consumed_by: stlNo });
    }
  };

  const handleCarryForward = async () => {
    if (!selectedTrips.length) return alert('⚠️ Kam se kam ek trip select karein!');
    if (!window.confirm(`🔁 ${selectedTrips.length} trips ka balance ${inr(netBalance)} agli settlement tak carry-forward karein?\n(Khata mein abhi kuch post NahI hoga)`)) return;
    setPosting(true);
    try {
      const draft = settlementDraft('CARRY_FORWARD');
      await addDoc(collection(db, 'TRIP_SETTLEMENTS'), draft);
      await stampTrips('CARRIED_FORWARD', draft.settlement_no);
      await consumeCarryForwards(draft.settlement_no); // old CF rolls into this one
      alert(`✅ Balance ${inr(netBalance)} carry-forward ho gaya (${draft.settlement_no}).\nAgli settlement mein Opening Balance ki tarah judega.`);
      resetSelection(); fetchAll();
    } catch (e) { console.error(e); alert('❌ Carry-forward save nahi hua.'); }
    setPosting(false);
  };

  const handlePostToLedger = async () => {
    if (!selectedTrips.length) return alert('⚠️ Kam se kam ek trip select karein!');
    const driverName = driverFilter || tripDriver(selectedTrips[0]);
    if (!driverName) return alert('⚠️ Driver ka naam nahi mila — Driver filter select karein.');
    const earned = round2(totAllowance + totExtra + cfEarned);
    if (!window.confirm(`📓 ${selectedTrips.length} trips settle karke Driver Ledger mein post karein?\n\nDriver: ${driverName}\nBhatta + Extra (credit hoga): ${inr(earned)}\nCash Advances (pehle se khata mein debit): ${inr(totCash)}\nNet Balance: ${inr(netBalance)} ${netBalance >= 0 ? '(driver ko dena)' : '(driver se lena)'}`)) return;
    setPosting(true);
    try {
      const draft = settlementDraft('POSTED');
      const today = new Date().toISOString().split('T')[0];
      // 1️⃣ Khata credit: the earned side only — every cash advance was already
      // debited (ADVANCE_GIVEN/PAYMENT_GIVEN) the day it was handed over.
      if (earned > 0) {
        await addDoc(collection(db, 'DRIVER_TRANSACTIONS'), {
          driver_name: driverName, txn_type: 'SALARY_CREDIT', amount: earned, date: today,
          trip_id: draft.settlement_no,
          remarks: `[TRIP SETTLEMENT ${draft.settlement_no}] ${selectedTrips.length} trips — bhatta ${inr(totAllowance)} + extra ${inr(totExtra)}${cfEarned ? ` + carry-fwd ${inr(cfEarned)}` : ''}`,
          createdAt: serverTimestamp(),
        });
      }
      // 2️⃣ Double-entry journal (idempotent by settlement no).
      if (earned > 0) {
        try {
          await postEntry({
            source_type: 'TRIP_SETTLEMENT', source_ref: draft.settlement_no, date: today,
            narration: `Trip settlement ${draft.settlement_no}: ${selectedTrips.length} trips of ${draft.vehicle_no || driverName} (bhatta+extra)`,
            lines: [
              { ledger: 'Trip Allowance & Bhatta', dr_cr: 'Dr', amount: earned },
              { ledger: `Driver Advances: ${driverName}`, dr_cr: 'Cr', amount: earned },
            ],
          });
        } catch (je) { console.error('Journal post failed (settlement saved):', je); }
      }
      // 3️⃣ Persist settlement + stamp trips + retire consumed carry-forwards.
      await addDoc(collection(db, 'TRIP_SETTLEMENTS'), draft);
      await stampTrips('SETTLED', draft.settlement_no);
      await consumeCarryForwards(draft.settlement_no);
      alert(`✅ Settlement ${draft.settlement_no} posted!\n💰 ${inr(earned)} driver khata mein credit.\nNet Balance: ${inr(netBalance)} ${netBalance >= 0 ? '— driver ko payable' : '— driver se recover karna hai'} (Driver Master ➔ Salary & Settlement mein final payment karein).`);
      resetSelection(); fetchAll();
    } catch (e) { console.error(e); alert('❌ Settlement post nahi hua — console check karein.'); }
    setPosting(false);
  };

  const resetSelection = () => { setSelectedIds(new Set()); setExtraExpenses([]); setExpandedId(''); };

  // 💬 Settlement hisaab WhatsApp — dual mode (PRASAD PRO auto-send → phone WhatsApp)
  const sendSettlementWhatsApp = async () => {
    if (!selectedTrips.length) return alert('⚠️ Pehle trips select karein!');
    const driverName = driverFilter || tripDriver(selectedTrips[0]);
    const drv = drivers.find(d => (d.name || '').toUpperCase() === driverName.toUpperCase());
    const mobile = drv?.mobile || drv?.mobile_no || drv?.phone;
    if (!mobile) return alert(`⚠️ ${driverName || 'Driver'} ka mobile number Driver Master mein nahi mila!`);
    const lines = selectedTrips.map(t => `• ${tripDate(t)} ${bizId(t)} — Cash ${inr(tripCash(t))}, HSD ${inr(tripHsd(t).amt)}`).join('\n');
    const message = `🧾 *TRIP SETTLEMENT SUMMARY*\n\nDear ${driverName},\n\n${selectedTrips.length} trips ka hisaab:\n${lines}\n\n(+) Bhatta: ${inr(totAllowance)}\n(+) Extra Kharcha: ${inr(totExtra)}\n(−) Cash Advances: ${inr(totCash)}${includeHsd ? `\n(−) HSD: ${inr(totHsdAmt)}` : ''}${cfNet ? `\n(±) Purana Balance: ${inr(cfNet)}` : ''}\n\n*NET BALANCE: ${inr(Math.abs(netBalance))} ${netBalance >= 0 ? '(aapko milega)' : '(aapse recovery hogi)'}*\n\nRegards,\nPrasad Transport ERP`;
    const r = await sendWhatsApp({ phone: mobile, message, role: 'Driver' });
    alert(waResultText(r));
  };

  // ── UI helpers ─────────────────────────────────────────────────────────
  const inputStyle = { width: '100%', padding: '12px 14px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '10px', fontSize: '14px', boxSizing: 'border-box' as const, outline: 'none', colorScheme: 'dark' as const };
  const vehicleOptions = [...new Set([
    ...vehicles.map(v => String(v.vehicle_no || v.vehical_no || v.registration_no || '')).filter(Boolean),
    ...trips.map(tripVehicle).filter(Boolean),
  ])].sort();
  const driverOptions = [...new Set([...drivers.map(d => String(d.name || '')).filter(Boolean), ...trips.map(tripDriver).filter(Boolean)])].sort();

  const settlementHistory = [...settlements].sort((a, b) => String(b.settlement_no || '').localeCompare(String(a.settlement_no || '')));

  return (
    <div className="pt-anim-fade" style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      <div style={{ marginBottom: '25px' }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 28px)', color: '#fff' }}>🧾 Master Trip Settlement</h2>
        <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Consolidated multi-trip driver hisaab — HSD, cash advances, bhatta & extra expenses</p>
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '25px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        <button className={`pt-tab ${activeTab === 'SETTLEMENT' ? 'is-active is-active--success' : ''}`} onClick={() => setActiveTab('SETTLEMENT')}>💰 TRIP SETTLEMENT</button>
        <button className={`pt-tab ${activeTab === 'UNLOADING' ? 'is-active' : ''}`} onClick={() => setActiveTab('UNLOADING')}>🏁 UNLOADING / CLOSE TRIP</button>
        <button className={`pt-tab ${activeTab === 'HISTORY' ? 'is-active is-active--warning' : ''}`} onClick={() => setActiveTab('HISTORY')}>📋 SETTLEMENT HISTORY</button>
      </div>

      {/* 🏁 TAB: the old Unloading module, intact */}
      {activeTab === 'UNLOADING' && <UnloadingDetails />}

      {/* 📋 TAB: history */}
      {activeTab === 'HISTORY' && (
        <div className="pt-anim-up" style={{ background: '#1e293b', borderRadius: '16px', overflowX: 'auto', border: '1px solid #334155' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap', fontSize: '13px' }}>
            <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
              <tr>
                <th style={{ padding: '14px' }}>Settlement No</th><th style={{ padding: '14px' }}>Vehicle / Driver</th>
                <th style={{ padding: '14px' }}>Period</th><th style={{ padding: '14px' }}>Trips</th>
                <th style={{ padding: '14px', textAlign: 'right' }}>Cash</th><th style={{ padding: '14px', textAlign: 'right' }}>HSD ₹</th>
                <th style={{ padding: '14px', textAlign: 'right' }}>Bhatta+Extra</th><th style={{ padding: '14px', textAlign: 'right' }}>Net</th>
                <th style={{ padding: '14px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {settlementHistory.length === 0 ? <tr><td colSpan={9} style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>No settlements yet.</td></tr> :
                settlementHistory.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1' }}>
                    <td style={{ padding: '12px 14px', fontWeight: 'bold', color: '#38bdf8' }}>{s.settlement_no}</td>
                    <td style={{ padding: '12px 14px' }}>{s.vehicle_no || '—'}<br /><small style={{ color: '#94a3b8' }}>{s.driver_name || '—'}</small></td>
                    <td style={{ padding: '12px 14px', color: '#94a3b8' }}>{s.from_date || '…'} → {s.to_date || '…'}</td>
                    <td style={{ padding: '12px 14px' }}>{s.trip_count}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'right', color: '#f59e0b' }}>{inr(num(s.totals?.cash))}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'right', color: '#38bdf8' }}>{inr(num(s.totals?.hsd_amt))}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'right', color: '#10b981' }}>{inr(num(s.totals?.allowance) + num(s.totals?.extra))}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: '900', color: num(s.net_balance) >= 0 ? '#10b981' : '#ef4444' }}>{inr(num(s.net_balance))}</td>
                    <td style={{ padding: '12px 14px' }}>
                      {s.mode === 'POSTED' ? <span className="pt-badge pt-badge--success">📓 Posted</span>
                        : s.status === 'CONSUMED' ? <span className="pt-badge pt-badge--info">🔁 CF → {s.consumed_by}</span>
                          : <span className="pt-badge pt-badge--warning">🔁 Carry-Fwd OPEN</span>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 💰 TAB: settlement builder */}
      {activeTab === 'SETTLEMENT' && (
        <>
          {/* 🎛️ FILTERS */}
          <div className="pt-anim-up" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '14px', padding: '20px', marginBottom: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
              <div>
                <label style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>🚛 VEHICLE</label>
                <select value={vehicleFilter} onChange={e => { setVehicleFilter(e.target.value); resetSelection(); }} style={{ ...inputStyle, borderColor: '#10b981' }}>
                  <option value="">-- All / Choose Vehicle --</option>
                  {vehicleOptions.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>👨‍✈️ DRIVER</label>
                <select value={driverFilter} onChange={e => { setDriverFilter(e.target.value); resetSelection(); }} style={{ ...inputStyle, borderColor: '#38bdf8' }}>
                  <option value="">-- All / Choose Driver --</option>
                  {driverOptions.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>📅 FROM DATE</label>
                <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); resetSelection(); }} style={inputStyle} />
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>📅 TO DATE</label>
                <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); resetSelection(); }} style={inputStyle} />
              </div>
            </div>
            {openCarryForwards.length > 0 && (
              <div style={{ marginTop: '12px', background: 'rgba(245,158,11,0.1)', border: '1px dashed #f59e0b', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', color: '#f59e0b' }}>
                🔁 Opening Balance (carry-forward): <b>{inr(cfNet)}</b> from {openCarryForwards.map(c => c.settlement_no).join(', ')} — is settlement mein auto-adjust hoga.
              </div>
            )}
          </div>

          {!filterReady ? (
            <div style={{ color: '#64748b', padding: '50px', textAlign: 'center', background: 'rgba(30,41,59,0.3)', borderRadius: '16px', border: '1px dashed #334155' }}>
              👆 Vehicle ya Driver select karein — us par saari <b>unsettled trips</b> yahan aa jayengi.
            </div>
          ) : loading ? (
            <div style={{ color: '#38bdf8', textAlign: 'center', padding: '40px' }}>Loading trips…</div>
          ) : (
            <>
              {/* 🧾 UNSETTLED TRIP LIST */}
              <div className="pt-anim-up" style={{ background: '#1e293b', borderRadius: '16px', border: '1px solid #334155', overflowX: 'auto', marginBottom: '20px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead style={{ background: '#0f172a', color: '#38bdf8', fontSize: '11px', textTransform: 'uppercase' }}>
                    <tr>
                      <th style={{ padding: '14px', width: '40px' }}>
                        <input type="checkbox" checked={unsettledTrips.length > 0 && selectedIds.size === unsettledTrips.length} onChange={toggleAll} style={{ width: '18px', height: '18px', accentColor: '#10b981', cursor: 'pointer' }} />
                      </th>
                      <th style={{ padding: '14px' }}>Date & Trip</th>
                      <th style={{ padding: '14px' }}>Challan / Invoice</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>HSD (Fuel)</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>Cash Advances</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>Bhatta</th>
                      <th style={{ padding: '14px', width: '60px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {unsettledTrips.length === 0 ? <tr><td colSpan={7} style={{ padding: '35px', textAlign: 'center', color: '#64748b' }}>🎉 Is filter par koi unsettled trip nahi hai.</td></tr> :
                      unsettledTrips.map(t => {
                        const hsd = tripHsd(t); const cash = tripCash(t);
                        const fuelRows = tripFuelRows(t); const cashRows = tripCashRows(t);
                        const isOpen = expandedId === t.id;
                        return (
                          <React.Fragment key={t.id}>
                            <tr style={{ borderBottom: isOpen ? 'none' : '1px solid #334155', color: '#cbd5e1', background: selectedIds.has(t.id) ? 'rgba(16,185,129,0.06)' : 'transparent' }}>
                              <td style={{ padding: '12px 14px' }}>
                                <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleTrip(t.id)} style={{ width: '18px', height: '18px', accentColor: '#10b981', cursor: 'pointer' }} />
                              </td>
                              <td style={{ padding: '12px 14px' }}>
                                <b style={{ color: '#fff' }}>{tripDate(t) || '—'}</b> · <span style={{ color: '#38bdf8' }}>{bizId(t)}</span><br />
                                <small style={{ color: '#94a3b8' }}>📍 {tripRoute(t)}</small><br />
                                <span className={`pt-pill ${t.trip_status === 'COMPLETED' ? 'pt-pill--completed' : 'pt-pill--pending-unload'}`} style={{ marginTop: '4px' }}>{t.trip_status || '—'}</span>
                              </td>
                              <td style={{ padding: '12px 14px', color: '#f59e0b' }}>{tripChallan(t)}</td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', color: '#38bdf8', fontWeight: 'bold' }}>{hsd.ltr > 0 && <small>{hsd.ltr} L<br /></small>}{inr(hsd.amt)}</td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', color: '#f59e0b', fontWeight: 'bold' }}>{inr(cash)}</td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', color: '#10b981', fontWeight: 'bold' }}>{inr(tripAllowance(t))}</td>
                              <td style={{ padding: '12px 14px' }}>
                                <button onClick={() => setExpandedId(isOpen ? '' : t.id)} style={{ background: 'none', border: '1px solid #475569', color: '#94a3b8', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px' }}>{isOpen ? '▲' : '▼ Detail'}</button>
                              </td>
                            </tr>
                            {isOpen && (
                              <tr style={{ borderBottom: '1px solid #334155', background: 'rgba(15,23,42,0.6)' }}>
                                <td></td>
                                <td colSpan={6} style={{ padding: '5px 14px 15px' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '15px' }}>
                                    {(() => {
                                      const fx = tripFixed(t);
                                      const hsdBal = round2(fx.hsdL - fx.hsdIssuedL);
                                      const cashBal = round2(fx.cash - cash);
                                      const balCol = (v: number) => v < 0 ? '#ef4444' : '#10b981';
                                      const Row = ({ label, target, actual, bal, unit }: any) => (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', padding: '4px 0', borderBottom: '1px dotted #334155' }}>
                                          <span style={{ color: '#94a3b8' }}>{label}</span>
                                          <span>Target <b style={{ color: '#c084fc' }}>{target}{unit}</b> · Actual <b style={{ color: '#38bdf8' }}>{actual}{unit}</b> · Bal <b style={{ color: balCol(bal) }}>{bal}{unit}</b></span>
                                        </div>
                                      );
                                      return (
                                        <div>
                                          <div style={{ fontSize: '11px', color: '#c084fc', fontWeight: 'bold', marginBottom: '6px' }}>🎯 FIXED EXPENSES (TRIP TARGET){fx.fromMaster && <span style={{ color: '#f59e0b', fontWeight: 'normal' }}> · from Route Master</span>}</div>
                                          {fx.hsdL <= 0 && fx.cash <= 0 && fx.toll <= 0
                                            ? <small style={{ color: '#64748b' }}>Is trip/route par koi fixed target set nahi hai.</small>
                                            : <>
                                                {fx.hsdL > 0 && <Row label="⛽ Fixed HSD" target={fx.hsdL} actual={fx.hsdIssuedL} bal={hsdBal} unit=" L" />}
                                                {fx.cash > 0 && <Row label="💵 Fixed Cash (Bhatta)" target={fx.cash} actual={round2(cash)} bal={cashBal} unit=" ₹" />}
                                                {fx.toll > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', padding: '4px 0' }}><span style={{ color: '#94a3b8' }}>🛣️ Toll (recorded)</span><b style={{ color: '#38bdf8' }}>{inr(fx.toll)}</b></div>}
                                              </>}
                                        </div>
                                      );
                                    })()}
                                    <div>
                                      <div style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 'bold', marginBottom: '6px' }}>⛽ DATE-WISE HSD ISSUED</div>
                                      {fuelRows.length === 0 ? <small style={{ color: '#64748b' }}>Koi fuel entry nahi{hsd.amt > 0 ? ` (trip par ₹${hsd.amt} recorded)` : ''}.</small> :
                                        fuelRows.map(f => <div key={f.id} style={{ fontSize: '12px', color: '#cbd5e1', padding: '3px 0', borderBottom: '1px dotted #334155' }}>{toISODate(f.date)} · {f.vendor_name || f.memo_no || 'Pump'} — <b style={{ color: '#38bdf8' }}>{num(f.liters) ? `${f.liters} L / ` : ''}{inr(num(f.amount))}</b></div>)}
                                    </div>
                                    <div>
                                      <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', marginBottom: '6px' }}>💵 TRIP CASH ADVANCES</div>
                                      {cashRows.length === 0 ? <small style={{ color: '#64748b' }}>Koi khata row nahi{cash > 0 ? ` (trip roll-up: ${inr(cash)})` : ''}.</small> :
                                        cashRows.map(x => <div key={x.id} style={{ fontSize: '12px', color: '#cbd5e1', padding: '3px 0', borderBottom: '1px dotted #334155' }}>{toISODate(x.date)} · {x.remarks || x.txn_type} — <b style={{ color: '#f59e0b' }}>{inr(num(x.amount))}</b></div>)}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {/* ➕ EXTRA EXPENSES + 🧮 SUMMARY */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
                <div className="pt-card" style={{ borderTop: '3px solid #c084fc' }}>
                  <h4 style={{ color: '#c084fc', margin: '0 0 12px 0' }}>➕ Add Extra Expense (en-route / maintenance)</h4>
                  {extraExpenses.map((x, i) => (
                    <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px dotted #334155', fontSize: '13px' }}>
                      <span style={{ color: '#cbd5e1' }}>{i + 1}. {x.name}</span>
                      <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <b style={{ color: '#c084fc' }}>{inr(num(x.amount))}</b>
                        <button onClick={() => setExtraExpenses(prev => prev.filter(p => p.id !== x.id))} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>✕</button>
                      </span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                    <input placeholder="e.g. Tyre Puncture / Dhaba" value={newExpName} onChange={e => setNewExpName(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                    <input type="number" placeholder="₹" value={newExpAmt} onChange={e => setNewExpAmt(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                    <button onClick={addExtraExpense} style={{ background: '#c084fc', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>+ Add</button>
                  </div>
                </div>

                <div className="pt-card" style={{ borderTop: '3px solid #10b981' }}>
                  <h4 style={{ color: '#10b981', margin: '0 0 12px 0' }}>🧮 Settlement Summary ({selectedTrips.length} trips selected)</h4>
                  {[
                    ['(+) Trip Bhatta / Allowance', totAllowance, '#10b981'],
                    ['(+) Extra Expenses', totExtra, '#c084fc'],
                    ...(openCarryForwards.length ? [[`(±) Opening Carry-Forward`, cfNet, '#f59e0b']] : []),
                    ['(−) Cash Advances Taken', -totCash, '#f59e0b'],
                    [`(${includeHsd ? '−' : 'ℹ️'}) HSD Issued ${totHsdLtr ? `(${totHsdLtr} L)` : ''}`, includeHsd ? -totHsdAmt : totHsdAmt, '#38bdf8'],
                    ['ℹ️ Freight (company side)', totFreight, '#64748b'],
                  ].map(([lbl, val, col], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dotted #334155', fontSize: '13px' }}>
                      <span style={{ color: '#94a3b8' }}>{lbl}</span><b style={{ color: col }}>{inr(Math.abs(num(val))) }{num(val) < 0 ? ' −' : ''}</b>
                    </div>
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0', fontSize: '12px', color: '#94a3b8', cursor: 'pointer' }}>
                    <input type="checkbox" checked={includeHsd} onChange={e => setIncludeHsd(e.target.checked)} style={{ accentColor: '#38bdf8' }} />
                    HSD amount bhi driver se recover karein (Net mein minus hoga)
                  </label>
                  <div style={{ background: netBalance >= 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)', border: `2px dashed ${netBalance >= 0 ? '#10b981' : '#ef4444'}`, borderRadius: '12px', padding: '15px', textAlign: 'center', margin: '10px 0' }}>
                    <div style={{ fontSize: '11px', fontWeight: 'bold', color: netBalance >= 0 ? '#10b981' : '#ef4444', textTransform: 'uppercase' }}>{netBalance >= 0 ? '💰 Net Payable to Driver' : '⚠️ Recover from Driver'}</div>
                    <div style={{ fontSize: '30px', fontWeight: '900', color: netBalance >= 0 ? '#10b981' : '#ef4444' }}>{inr(Math.abs(netBalance))}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <button disabled={posting || !selectedTrips.length} onClick={handleCarryForward} style={{ flex: 1, minWidth: '150px', minHeight: '48px', background: 'rgba(245,158,11,0.15)', border: '1px solid #f59e0b', color: '#f59e0b', padding: '13px', borderRadius: '12px', fontWeight: '900', cursor: posting ? 'wait' : 'pointer', fontSize: '13px', opacity: !selectedTrips.length ? 0.4 : 1 }}>🔁 Carry Forward Balance</button>
                    <button disabled={posting || !selectedTrips.length} onClick={handlePostToLedger} style={{ flex: 1, minWidth: '150px', minHeight: '48px', background: 'linear-gradient(135deg, #10b981, #059669)', border: 'none', color: '#fff', padding: '13px', borderRadius: '12px', fontWeight: '900', cursor: posting ? 'wait' : 'pointer', fontSize: '13px', boxShadow: '0 5px 18px rgba(16,185,129,0.35)', opacity: !selectedTrips.length ? 0.4 : 1 }}>{posting ? '⏳ Posting…' : '📓 Post to Driver Ledger'}</button>
                  </div>
                  <button disabled={!selectedTrips.length} onClick={sendSettlementWhatsApp} style={{ width: '100%', marginTop: '10px', minHeight: '48px', background: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e', color: '#22c55e', padding: '12px', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', fontSize: '13px', opacity: !selectedTrips.length ? 0.4 : 1 }}>💬 WhatsApp Hisaab to Driver</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
