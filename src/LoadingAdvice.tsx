// @ts-nocheck
// 📋 LOADING ADVICE — pre-trip register (lives inside Loading Register's
// LOADING ADVICE tab). An advice IS a TRIPS doc with trip_status 'ADVICE':
// advances issued here stamp the reserved LR/Trip ID into FUEL_ENTRIES and
// DRIVER_TRANSACTIONS immediately, and the actual Loading Entry later converts
// the SAME doc to IN_TRANSIT (auto-attach in LodingDetals) — no re-linking.
// Money-write semantics mirror Trip Command Center's Pay/Fuel modals exactly
// (same fields, same increments) so settlement math sees identical data.
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, where, orderBy, limit, writeBatch, increment } from 'firebase/firestore';
import { db } from './firebase';
import { sendWhatsApp, waResultText } from './lib/waSend';

const round2 = (n) => Math.round(((parseFloat(n) || 0) + Number.EPSILON) * 100) / 100;
const checkMatch = (a, b) => {
  if (!a || !b) return false;
  const s1 = String(a).toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
  return s1 === s2 || s1.includes(s2) || s2.includes(s1);
};
const getVal = (obj, keys) => {
  if (!obj) return '';
  const ok = Object.keys(obj);
  for (const k of keys) {
    const t = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    const f = ok.find(x => x.toLowerCase().replace(/[^a-z0-9]/g, '') === t);
    if (f && obj[f]) return obj[f];
  }
  return '';
};
const today = () => new Date().toISOString().split('T')[0];

export default function LoadingAdvice({ onChanged }: { onChanged?: () => void }) {
  const [adviceTrips, setAdviceTrips] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]);
  const [fuelVendors, setFuelVendors] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  const [f, setF] = useState({
    advice_no: '', advice_date: today(), advice_valid_till: '',
    vehicle_no: '', driver_name: '', driver_mobil_no: '',
    loading_point: '', consignee_name: '', customer_name: '',
    operating_company: '', fixed_hsd: '', fixed_cash: '', rtkm: ''
  });

  // 💸/⛽ advance modals (against a selected advice)
  const [payFor, setPayFor] = useState<any>(null);
  const [pay, setPay] = useState({ amount: '', mode: 'Office Cash', date: today(), remarks: '' });
  const [fuelFor, setFuelFor] = useState<any>(null);
  const [fuel, setFuel] = useState({ vendor_id: '', fuel_type: 'FIXED', qty: '', rate: '', cash_advance: '', date: today() });
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetchAll(); }, []);
  const fetchAll = async () => {
    const safe = (p) => p.catch(() => ({ docs: [] }));
    const [aSnap, vSnap, dSnap, rSnap, venSnap] = await Promise.all([
      safe(getDocs(query(collection(db, 'TRIPS'), where('trip_status', '==', 'ADVICE')))),
      safe(getDocs(collection(db, 'VEHICLES'))),
      safe(getDocs(collection(db, 'DRIVERS'))),
      safe(getDocs(collection(db, 'RTKM_MASTER'))),
      safe(getDocs(collection(db, 'VENDORS'))),
    ]);
    const m = (s) => s.docs.map(d => ({ id: d.id, ...d.data() }));
    setAdviceTrips(m(aSnap).sort((a, b) => String(b.advice_date || '').localeCompare(String(a.advice_date || ''))));
    setVehicles(m(vSnap)); setDrivers(m(dSnap)); setRtkmMaster(m(rSnap)); setFuelVendors(m(venSnap));
  };
  const refresh = () => { fetchAll(); onChanged && onChanged(); };

  const handleVehicleChange = (vNo: string) => {
    const veh = vehicles.find(v => checkMatch(v.vehicle_no || v.vehical_no || v.registration_no, vNo));
    let dName = veh ? (veh.driver_name || veh.assigned_pilot || '') : '';
    let dMob = veh ? (veh.driver_mobile || veh.driver_mobil_no || veh.pilot_mobile || '') : '';
    if (dName && !dMob) { const drv = drivers.find(d => d.name === dName); if (drv) dMob = drv.mobile_no || drv.mobile || drv.phone || ''; }
    const opCo = veh ? (veh.company_name || veh.owner_name || veh.operating_company || '') : '';
    setF(prev => ({ ...prev, vehicle_no: vNo.toUpperCase(), driver_name: dName || prev.driver_name, driver_mobil_no: dMob || prev.driver_mobil_no, operating_company: opCo || prev.operating_company }));
  };

  const handleRouteSelect = (consignee: string) => {
    const route = rtkmMaster.find(m2 => checkMatch(m2.Consignee_Name || m2.consignee_name, consignee)) || {};
    setF(prev => ({
      ...prev, consignee_name: consignee,
      loading_point: getVal(route, ['depotlink', 'loadingpoint', 'depot']) || prev.loading_point,
      customer_name: getVal(route, ['registeredassessee', 'customer', 'customername']) || prev.customer_name,
      fixed_hsd: String(getVal(route, ['fixedhsdqty', 'fixedhsd', 'hsd']) || ''),
      fixed_cash: String(getVal(route, ['fixedcashamt', 'fixedcash', 'cash']) || ''),
      rtkm: String(getVal(route, ['rtkmdistance', 'rtkm']) || ''),
    }));
  };

  // Final LR-series id reserved AT ADVICE TIME — advances reference it, so it
  // can never change at loading. Server-side max lookup over both casings.
  const generateTripId = async (companyName: string) => {
    const cUp = String(companyName || '').toUpperCase();
    let prefix = 'TRP';
    if (cUp.includes('PRASAD') && !cUp.includes('GAUTAM')) prefix = 'PT';
    else if (cUp.includes('JAISWAL')) prefix = 'JE';
    else if (cUp.includes('GAUTAM')) prefix = 'GP';
    let highest = 0;
    const scan = (id) => {
      const m2 = String(id || '').trim().toUpperCase().match(new RegExp('^' + prefix + '(\\d+)$'));
      if (m2) highest = Math.max(highest, parseInt(m2[1], 10));
    };
    try {
      for (const field of ['Trip_ID', 'trip_id']) {
        const snap = await getDocs(query(collection(db, 'TRIPS'), where(field, '>=', prefix), where(field, '<', prefix + ''), orderBy(field, 'desc'), limit(20)));
        snap.docs.forEach(d => { const x = d.data(); scan(x.Trip_ID); scan(x.trip_id); });
      }
    } catch (e) { console.warn('ID range query fallback:', e); }
    adviceTrips.forEach(t => { scan(t.Trip_ID); scan(t.trip_id); });
    return `${prefix}${String(highest + 1).padStart(5, '0')}`;
  };

  const advances = (t) => round2((parseFloat(t.office_cash_paid || 0) + parseFloat(t.bank_paid || 0) + parseFloat(t.pump_cash_advance || 0)));

  const handleSave = async () => {
    if (saving) return;
    if (!f.advice_no.trim() || !f.vehicle_no) return alert('⚠️ Advise No aur Vehicle No dono zaroori hain!');
    const open = adviceTrips.find(t => checkMatch(t.vehicle_no || t.Vehical_No, f.vehicle_no));
    if (open && !window.confirm(`⚠️ ${f.vehicle_no} par pehle se open Advice #${open.advice_no || open.trip_id} hai. Phir bhi nayi advice banayein?`)) return;
    setSaving(true);
    try {
      const tripId = await generateTripId(f.operating_company);
      await addDoc(collection(db, 'TRIPS'), {
        trip_id: tripId, Trip_ID: tripId,
        vehicle_no: f.vehicle_no, Vehical_No: f.vehicle_no,
        driver_name: f.driver_name, Driver_Name: f.driver_name, driver_mobil_no: f.driver_mobil_no,
        loading_point: f.loading_point, consignee_name: f.consignee_name,
        customer_name: f.customer_name, operating_company: f.operating_company,
        advice_no: f.advice_no.trim(), advice_date: f.advice_date,
        advice_valid_till: f.advice_valid_till, advice_terminal: f.consignee_name,
        rtkm: f.rtkm, fixed_hsd: f.fixed_hsd, fixed_cash: f.fixed_cash,
        start_date: f.advice_date, sort_date: f.advice_date,
        trip_status: 'ADVICE', office_approved_loading: false,
        total_expense: 0, office_cash_paid: 0, bank_paid: 0, hsd_issued: 0, pump_cash_advance: 0, total_advances: 0,
        created_at: serverTimestamp()
      });
      alert(`✅ Loading Advice saved! LR/Trip ID reserved: ${tripId}\nAb isi par 💸 Cash / ⛽ HSD advance issue kar sakte hain.\nLoading Entry (Direct Entry tab) karte hi yeh trip ban jayegi.`);
      setF({ advice_no: '', advice_date: today(), advice_valid_till: '', vehicle_no: '', driver_name: '', driver_mobil_no: '', loading_point: '', consignee_name: '', customer_name: '', operating_company: '', fixed_hsd: '', fixed_cash: '', rtkm: '' });
      refresh();
    } catch (e) { console.error(e); alert('❌ Advice save nahi hui.'); }
    setSaving(false);
  };

  const handleCancel = async (t) => {
    if (advances(t) > 0 || parseFloat(t.hsd_issued || 0) > 0 || parseFloat(t.total_expense || 0) > 0) {
      return alert(`❌ Is advice par advances issue ho chuke hain (₹${advances(t)} cash / ${t.hsd_issued || 0}L HSD) — delete NahI ho sakti.\nLoading Entry karke trip banayein, ya driver se recovery karke settle karein.`);
    }
    if (!window.confirm(`Advice #${t.advice_no || t.trip_id} (${t.vehicle_no}) cancel karein? (koi advance issue nahi — safe delete)`)) return;
    try { await deleteDoc(doc(db, 'TRIPS', t.id)); refresh(); } catch (e) { alert('❌ Cancel error.'); }
  };

  // 💸 CASH ADVANCE — identical write semantics to Trip Command Center Pay modal.
  const handlePay = async () => {
    const amt = round2(pay.amount);
    if (!payFor || busy) return;
    if (!(amt > 0)) return alert('⚠️ Valid amount daalein!');
    if (!pay.date) return alert('⚠️ Date select karein!');
    setBusy(true);
    try {
      const field = pay.mode === 'Office Cash' ? 'office_cash_paid' : 'bank_paid';
      const batch = writeBatch(db);
      batch.update(doc(db, 'TRIPS', payFor.id), { [field]: increment(amt), total_advances: increment(amt) });
      batch.set(doc(collection(db, 'DRIVER_TRANSACTIONS')), {
        driver_name: payFor.driver_name || payFor.Driver_Name || '', txn_type: 'PAYMENT_GIVEN', amount: amt,
        mode: pay.mode, date: pay.date, trip_id: payFor.trip_id || payFor.Trip_ID,
        remarks: `[ADVICE ${payFor.advice_no || ''}] ${pay.remarks || 'Pre-trip advance'}`, createdAt: serverTimestamp()
      });
      await batch.commit();
      alert(`✅ ₹${amt} advance issue ho gaya (${pay.mode}) — driver khata mein darj.`);
      setPayFor(null); setPay({ amount: '', mode: 'Office Cash', date: today(), remarks: '' });
      refresh();
    } catch (e) { console.error(e); alert('❌ Payment error.'); }
    setBusy(false);
  };

  // ⛽ FUEL/HSD SLIP — identical write semantics to Trip Command Center fuel memo.
  const handleFuel = async () => {
    if (!fuelFor || busy) return;
    const qty = parseFloat(fuel.qty) || 0;
    const rate = parseFloat(fuel.rate) || 0;
    const cashAmt = round2(fuel.cash_advance || 0);
    if (fuel.vendor_id === '' || (!qty && !cashAmt)) return alert('⚠️ Pump select karke Liters ya Cash bharein!');
    if (qty > 0 && !(rate > 0)) return alert('⚠️ Rate (₹/L) zaroori hai — bina rate ke diesel kharcha ₹0 ban jata hai!');
    setBusy(true);
    try {
      const ven = fuelVendors.find(v => v.id === fuel.vendor_id) || {};
      const amt = round2(qty * rate);
      const batch = writeBatch(db);
      const slip = {
        date: fuel.date, vehicle_no: fuelFor.vehicle_no || fuelFor.Vehical_No,
        route_name: `${fuelFor.loading_point || '?'} To ${fuelFor.consignee_name || '?'}`,
        driver_name: fuelFor.driver_name || '', memo_no: `ADV-${(fuelFor.advice_no || fuelFor.trip_id || '').slice(-8)}`,
        vendor_id: fuel.vendor_id, vendor_name: ven.vendor_name || '', fuel_type: fuel.fuel_type,
        liters: String(qty || ''), rate: String(rate || ''), amount: amt.toFixed(2),
        cash_given_to_pump: String(cashAmt || ''), pump_mobile: ven.mobile_no || ven.phone || ven.mobile || '',
        bill_status: 'UNBILLED', trip_id: fuelFor.trip_id || fuelFor.Trip_ID, trip_db_id: fuelFor.id, createdAt: serverTimestamp()
      };
      batch.set(doc(collection(db, 'FUEL_ENTRIES')), slip);
      if (cashAmt > 0 && slip.driver_name) {
        batch.set(doc(collection(db, 'DRIVER_TRANSACTIONS')), {
          driver_name: slip.driver_name, txn_type: 'ADVANCE_GIVEN', amount: cashAmt, date: fuel.date,
          trip_id: slip.trip_id, remarks: `[ADVICE ${fuelFor.advice_no || ''}] Cash from ${slip.vendor_name}`, createdAt: serverTimestamp()
        });
      }
      batch.update(doc(db, 'TRIPS', fuelFor.id), {
        total_expense: increment(amt), hsd_issued: increment(qty),
        pump_cash_advance: increment(cashAmt), total_advances: increment(cashAmt),
      });
      await batch.commit();
      if (slip.pump_mobile && window.confirm('✅ Slip saved! Pump ko WhatsApp bhejein?')) {
        const msg = `*⛽ FUEL MEMO (ADVANCE / LOADING ADVICE)*\n\nDear ${slip.vendor_name},\n\n🚛 *Vehicle:* ${slip.vehicle_no}\n👤 *Driver:* ${slip.driver_name || 'N/A'}\n📍 *Route:* ${slip.route_name}\n💧 *Qty:* ${qty} L (${fuel.fuel_type})\n💵 *Cash Adv:* ₹${cashAmt || 0}\n📝 *Memo:* ${slip.memo_no}\n📅 *Date:* ${fuel.date}`;
        const r = await sendWhatsApp({ phone: slip.pump_mobile, message: msg, tripId: slip.trip_id });
        alert(waResultText(r));
      } else {
        alert('✅ Fuel/Cash slip saved & advance advice par darj ho gaya.');
      }
      setFuelFor(null); setFuel({ vendor_id: '', fuel_type: 'FIXED', qty: '', rate: '', cash_advance: '', date: today() });
      refresh();
    } catch (e) { console.error(e); alert('❌ Fuel slip error.'); }
    setBusy(false);
  };

  const input = { width: '100%', padding: '12px', minHeight: '46px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' as const, outline: 'none', colorScheme: 'dark' as const };
  const modalWrap = { position: 'fixed' as const, inset: 0, background: 'rgba(2,6,23,0.85)', backdropFilter: 'blur(6px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '15px' };
  const modalBox = { background: '#0f172a', border: '1px solid #f59e0b', width: '100%', maxWidth: '440px', padding: '25px', borderRadius: '16px' };

  return (
    <div>
      {/* 📋 FORM */}
      <div style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '12px', padding: '20px', marginBottom: '20px' }}>
        <h3 style={{ margin: '0 0 5px 0', color: '#f59e0b', fontSize: '17px' }}>📋 New Loading Advice (Pre-Trip)</h3>
        <p style={{ margin: '0 0 18px 0', color: '#94a3b8', fontSize: '12px' }}>Oil company ka Safety Checklist-cum-Loading Advise aate hi register karein — LR/Trip ID reserve hoga aur usi par Advance HSD/Cash issue honge. <b style={{ color: '#10b981' }}>Optional hai</b> — bina advice ke Direct Entry pehle jaisi chalegi.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' }}>
          <div><label style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Advise No *</label><input style={{ ...input, borderColor: '#f59e0b' }} value={f.advice_no} onChange={e => setF({ ...f, advice_no: e.target.value })} placeholder="e.g. 7B03…LA0033" /></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Advise Date</label><input type="date" style={input} value={f.advice_date} onChange={e => setF({ ...f, advice_date: e.target.value })} /></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Valid Till</label><input type="date" style={input} value={f.advice_valid_till} onChange={e => setF({ ...f, advice_valid_till: e.target.value })} /></div>
          <div><label style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Vehicle (TT) No *</label>
            <input list="la-vehicle-list" style={{ ...input, borderColor: '#38bdf8' }} value={f.vehicle_no} onChange={e => handleVehicleChange(e.target.value)} placeholder="AS 26C 5108" />
            <datalist id="la-vehicle-list">{vehicles.map(v => <option key={v.id} value={v.vehicle_no || v.vehical_no || v.registration_no} />)}</datalist>
          </div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Driver</label>
            <select style={input} value={f.driver_name} onChange={e => { const d = drivers.find(x => x.name === e.target.value); setF({ ...f, driver_name: e.target.value, driver_mobil_no: d ? (d.mobile_no || d.mobile || d.phone || '') : f.driver_mobil_no }); }}>
              <option value="">{f.driver_name ? f.driver_name + ' (vehicle link)' : '-- Select Driver --'}</option>
              {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
          </div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Target Route / Terminal</label>
            <select style={input} value={f.consignee_name} onChange={e => handleRouteSelect(e.target.value)}>
              <option value="">-- Route from RTKM Master --</option>
              {rtkmMaster.map(r => <option key={r.id} value={r.Consignee_Name || r.consignee_name}>{(r.Depot_Link || r.depot_link) + ' ➔ ' + (r.Consignee_Name || r.consignee_name)}</option>)}
            </select>
          </div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Operating Company</label><input style={input} value={f.operating_company} onChange={e => setF({ ...f, operating_company: e.target.value })} placeholder="PRASAD / GAUTAM / JAISWAL…" /></div>
          <div style={{ alignSelf: 'end', fontSize: '11px', color: '#94a3b8', paddingBottom: '8px' }}>{(f.fixed_hsd || f.fixed_cash) && <>🎯 Route targets: <b style={{ color: '#38bdf8' }}>{f.fixed_hsd || 0} L</b> · <b style={{ color: '#10b981' }}>₹{f.fixed_cash || 0}</b></>}</div>
        </div>
        <button onClick={handleSave} disabled={saving} style={{ marginTop: '16px', padding: '13px 30px', minHeight: '48px', background: saving ? '#64748b' : 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '15px', width: '100%', maxWidth: '400px' }}>{saving ? '⌛ Saving…' : '📋 Register Advice & Reserve LR No'}</button>
      </div>

      {/* 📄 OPEN ADVICE LIST */}
      <div style={{ background: '#1e293b', borderRadius: '12px', overflowX: 'auto', border: '1px solid #334155' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap', fontSize: '13px' }}>
          <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
            <tr><th style={{ padding: '13px' }}>Advise No / LR</th><th style={{ padding: '13px' }}>Vehicle / Driver</th><th style={{ padding: '13px' }}>Route</th><th style={{ padding: '13px' }}>Validity</th><th style={{ padding: '13px', textAlign: 'right' }}>Advances So Far</th><th style={{ padding: '13px', textAlign: 'center' }}>Actions</th></tr>
          </thead>
          <tbody>
            {adviceTrips.length === 0 ? <tr><td colSpan={6} style={{ padding: '28px', textAlign: 'center', color: '#64748b' }}>Koi open Loading Advice nahi. (Direct Entry hamesha available — advice optional hai.)</td></tr> :
              adviceTrips.map(t => {
                const daysLeft = t.advice_valid_till ? Math.ceil((new Date(t.advice_valid_till).getTime() - Date.now()) / 86400000) : null;
                return (
                  <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1' }}>
                    <td style={{ padding: '11px 13px' }}><b style={{ color: '#f59e0b' }}>{t.advice_no || '—'}</b><br /><small style={{ color: '#38bdf8' }}>LR: {t.trip_id}</small><br /><small style={{ color: '#94a3b8' }}>{t.advice_date}</small></td>
                    <td style={{ padding: '11px 13px' }}><b style={{ color: '#fff' }}>{t.vehicle_no}</b><br /><small style={{ color: '#94a3b8' }}>{t.driver_name || '—'}</small></td>
                    <td style={{ padding: '11px 13px', fontSize: '12px' }}>{(t.loading_point || '?')} ➔ {(t.consignee_name || t.advice_terminal || '?')}</td>
                    <td style={{ padding: '11px 13px' }}>{daysLeft === null ? <span style={{ color: '#64748b' }}>—</span> : daysLeft < 0 ? <span style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid #ef4444', padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 'bold' }}>⛔ EXPIRED</span> : <span style={{ color: daysLeft <= 3 ? '#f59e0b' : '#10b981', fontWeight: 'bold', fontSize: '12px' }}>{daysLeft}d left</span>}</td>
                    <td style={{ padding: '11px 13px', textAlign: 'right' }}><b style={{ color: '#f59e0b' }}>₹{advances(t).toLocaleString('en-IN')}</b><br /><small style={{ color: '#38bdf8' }}>{parseFloat(t.hsd_issued || 0)} L HSD</small></td>
                    <td style={{ padding: '11px 13px', textAlign: 'center' }}>
                      <button onClick={() => { setPayFor(t); setPay({ amount: '', mode: 'Office Cash', date: today(), remarks: '' }); }} style={{ background: '#8b5cf6', color: '#fff', border: 'none', padding: '9px 13px', minHeight: '40px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginRight: '5px', fontSize: '12px' }}>💸 Pay</button>
                      <button onClick={() => { setFuelFor(t); setFuel({ vendor_id: '', fuel_type: 'FIXED', qty: '', rate: '', cash_advance: '', date: today() }); }} style={{ background: '#f59e0b', color: '#fff', border: 'none', padding: '9px 13px', minHeight: '40px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginRight: '5px', fontSize: '12px' }}>⛽ Fuel</button>
                      <button onClick={() => handleCancel(t)} style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '9px 12px', minHeight: '40px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>✕</button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p style={{ color: '#64748b', fontSize: '12px', marginTop: '10px' }}>💡 Direct Entry tab mein yeh vehicle select karte hi open advice automatically attach ho jayegi — saare advances trip ke saath carry honge.</p>

      {/* 💸 PAY MODAL */}
      {payFor && (
        <div style={modalWrap} onClick={() => setPayFor(null)}>
          <div style={{ ...modalBox, borderColor: '#8b5cf6' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 5px 0', color: '#8b5cf6' }}>💸 Advance Cash — {payFor.vehicle_no}</h3>
            <p style={{ margin: '0 0 15px 0', color: '#94a3b8', fontSize: '12px' }}>Advice #{payFor.advice_no} · LR {payFor.trip_id} · {payFor.driver_name || 'Driver'}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <select style={{ ...input, borderColor: '#8b5cf6' }} value={pay.mode} onChange={e => setPay({ ...pay, mode: e.target.value })}><option value="Office Cash">🏢 Office Cash</option><option value="Bank Transfer">🏦 Bank / UPI Transfer</option></select>
              <input type="date" style={input} value={pay.date} onChange={e => setPay({ ...pay, date: e.target.value })} />
              <input type="number" inputMode="decimal" style={input} placeholder="Amount (₹)" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} />
              <input style={input} placeholder="Remarks / Ref No." value={pay.remarks} onChange={e => setPay({ ...pay, remarks: e.target.value })} />
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => setPayFor(null)} style={{ flex: 1, minHeight: '48px', background: '#334155', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
                <button onClick={handlePay} disabled={busy} style={{ flex: 1, minHeight: '48px', background: busy ? '#64748b' : '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>{busy ? '⌛…' : 'Confirm Advance'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ⛽ FUEL MODAL */}
      {fuelFor && (
        <div style={modalWrap} onClick={() => setFuelFor(null)}>
          <div style={modalBox} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 5px 0', color: '#f59e0b' }}>⛽ Advance HSD / Pump Cash — {fuelFor.vehicle_no}</h3>
            <p style={{ margin: '0 0 15px 0', color: '#94a3b8', fontSize: '12px' }}>Advice #{fuelFor.advice_no} · LR {fuelFor.trip_id}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <select style={{ ...input, borderColor: '#f59e0b' }} value={fuel.vendor_id} onChange={e => setFuel({ ...fuel, vendor_id: e.target.value })}><option value="">-- Petrol Pump --</option>{fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}</select>
              <div style={{ display: 'flex', gap: '10px' }}>
                <select style={{ ...input, flex: 1 }} value={fuel.fuel_type} onChange={e => setFuel({ ...fuel, fuel_type: e.target.value })}><option value="FIXED">Fixed</option><option value="ADVANCE">Advance</option></select>
                <input type="date" style={{ ...input, flex: 1 }} value={fuel.date} onChange={e => setFuel({ ...fuel, date: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input type="number" inputMode="decimal" style={{ ...input, flex: 1 }} placeholder="Liters" value={fuel.qty} onChange={e => setFuel({ ...fuel, qty: e.target.value })} />
                <input type="number" inputMode="decimal" style={{ ...input, flex: 1 }} placeholder="Rate ₹/L" value={fuel.rate} onChange={e => setFuel({ ...fuel, rate: e.target.value })} />
              </div>
              <div style={{ fontSize: '13px', color: '#f59e0b', fontWeight: 'bold' }}>Diesel Value: ₹{round2((parseFloat(fuel.qty) || 0) * (parseFloat(fuel.rate) || 0)).toLocaleString('en-IN')}</div>
              <input type="number" inputMode="decimal" style={input} placeholder="Cash to Driver via Pump (₹, optional)" value={fuel.cash_advance} onChange={e => setFuel({ ...fuel, cash_advance: e.target.value })} />
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => setFuelFor(null)} style={{ flex: 1, minHeight: '48px', background: '#334155', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
                <button onClick={handleFuel} disabled={busy} style={{ flex: 1, minHeight: '48px', background: busy ? '#64748b' : '#f59e0b', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>{busy ? '⌛…' : '🚀 Save & WA Slip'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
