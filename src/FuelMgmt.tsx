// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from './firebase';

export default function FuelMgmt() {
  const [activeTab, setActiveTab] = useState('MULTI_MEMO');
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]); // 🆕 Drivers State
  const [fuelVendors, setFuelVendors] = useState<any[]>([]);
  const [fuelHistory, setFuelHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 📝 1. MULTI-PUMP MEMO STATE
  const [memoData, setMemoData] = useState({
    date: new Date().toISOString().split('T')[0], 
    vehicle_no: '', 
    route_name: '', 
    driver_name: '', // Now a dropdown
    fixed_hsd: '', 
    fixed_cash: '',
    memo_no: `MEMO-${Math.floor(Math.random()*10000)}`
  });
  
  // 🆕 Added 'fuel_type' (FIXED / ADVANCE)
  const [pumps, setPumps] = useState([
    { id: 1, vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }
  ]);

  // 🧾 2. BILL RECONCILIATION STATE
  const [reconVendor, setReconVendor] = useState('');
  const [unbilledSlips, setUnbilledSlips] = useState<any[]>([]);
  const [selectedSlips, setSelectedSlips] = useState<string[]>([]);
  const [vendorBillAmount, setVendorBillAmount] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      // 🆕 Fetch Drivers for Dropdown
      const dSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(dSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const venSnap = await getDocs(collection(db, "VENDORS"));
      const allVendors = venSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setFuelVendors(allVendors.filter(v => v.vendor_type === 'Fuel Pump' || v.vendor_type === 'Fuel Pump (HSD)'));

      const fSnap = await getDocs(collection(db, "FUEL_ENTRIES"));
      setFuelHistory(fSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // --- MULTI-PUMP LOGIC ---
  const handleAddPump = () => {
    if (pumps.length >= 4) return alert("Maximum 4 pumps allowed per trip memo!");
    setPumps([...pumps, { id: Date.now(), vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }]);
  };

  const handleRemovePump = (id: number) => {
    setPumps(pumps.filter(p => p.id !== id));
  };

  const handlePumpChange = (id: number, field: string, value: string) => {
    const updated = pumps.map(p => {
      if (p.id === id) {
        let newP = { ...p, [field]: value };
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

  // 💾 SAVE MULTI-PUMP MEMO & AUTO-POST ADVANCE TO DRIVER
  const handleSaveMultiMemo = async () => {
    if (!memoData.vehicle_no) return alert("Select Vehicle!");
    if (!memoData.driver_name) return alert("Select Driver! (Required for Settlement)");
    
    try {
      let totalAmount = 0;
      let advancePosted = false;

      for (let pump of pumps) {
        if (!pump.vendor_id || !pump.qty) continue;
        
        const amt = parseFloat(pump.amount || '0');
        const cashAmt = parseFloat(pump.cash_advance || '0');
        totalAmount += amt;

        // 1. Save Fuel Slip
        await addDoc(collection(db, "FUEL_ENTRIES"), {
          date: memoData.date,
          vehicle_no: memoData.vehicle_no,
          route_name: memoData.route_name,
          driver_name: memoData.driver_name,
          memo_no: memoData.memo_no,
          vendor_id: pump.vendor_id,
          vendor_name: pump.vendor_name,
          fuel_type: pump.fuel_type, // FIXED or ADVANCE
          liters: pump.qty,
          rate: pump.rate,
          amount: amt.toFixed(2),
          cash_given_to_pump: pump.cash_advance,
          pump_mobile: pump.mobile,
          bill_status: 'UNBILLED', 
          createdAt: serverTimestamp()
        });

        // 2. Update Vendor Balance (Add Liability - Pay to pump)
        const vendor = fuelVendors.find(v => v.id === pump.vendor_id);
        if (vendor) {
          const newBal = (parseFloat(vendor.current_balance || '0') + amt).toFixed(2);
          await updateDoc(doc(db, "VENDORS", vendor.id), { current_balance: newBal });
        }

        // 🔥 3. AUTO-POST TO DRIVER SETTLEMENT (IF ADVANCE) 🔥
        if (pump.fuel_type === 'ADVANCE' && memoData.driver_name) {
          const totalDriverAdvance = amt + cashAmt; // Fuel Amount + Cash Amount
          
          await addDoc(collection(db, "DRIVER_TRANSACTIONS"), {
            driver_name: memoData.driver_name,
            txn_type: 'ADVANCE_GIVEN',
            amount: totalDriverAdvance,
            date: memoData.date,
            remarks: `Fuel/Cash Advance at ${pump.vendor_name} (Memo: ${memoData.memo_no})`,
            createdAt: serverTimestamp()
          });
          advancePosted = true;
        }
      }

      let successMsg = `✅ Trip Fuel Memo Generated! Total Fuel: ₹${totalAmount.toFixed(2)}`;
      if (advancePosted) successMsg += `\n⚠️ Advance fuel amounts successfully posted to Driver's Khata!`;

      alert(successMsg);

      setMemoData({ date: new Date().toISOString().split('T')[0], vehicle_no: '', route_name: '', driver_name: '', fixed_hsd: '', fixed_cash: '', memo_no: `MEMO-${Math.floor(Math.random()*10000)}` });
      setPumps([{ id: 1, vendor_id: '', vendor_name: '', fuel_type: 'FIXED', qty: '', rate: '', amount: '', cash_advance: '', mobile: '' }]);
      fetchData();
    } catch (e) { alert("Error saving memo."); console.error(e); }
  };

  // --- RECONCILIATION LOGIC ---
  const handleVendorSelectRecon = (vid: string) => {
    setReconVendor(vid);
    const slips = fuelHistory.filter(f => f.vendor_id === vid && f.bill_status === 'UNBILLED');
    setUnbilledSlips(slips);
    setSelectedSlips(slips.map(s => s.id));
  };

  const toggleSlipSelection = (id: string) => {
    if (selectedSlips.includes(id)) {
      setSelectedSlips(selectedSlips.filter(s => s !== id));
    } else {
      setSelectedSlips([...selectedSlips, id]);
    }
  };

  const handleMatchBill = async () => {
    if (!vendorBillAmount) return alert("Enter the Total Amount from Physical Bill!");
    const selectedTotal = unbilledSlips.filter(s => selectedSlips.includes(s.id)).reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
    
    if (Math.abs(selectedTotal - parseFloat(vendorBillAmount)) > 10) {
      if(!window.confirm(`⚠️ Difference Detected! Selected Slips: ₹${selectedTotal.toFixed(2)} | Physical Bill: ₹${vendorBillAmount}. Do you still want to proceed?`)) {
        return;
      }
    }

    try {
      for (let slipId of selectedSlips) {
        await updateDoc(doc(db, "FUEL_ENTRIES", slipId), { bill_status: 'BILLED_VERIFIED' });
      }
      alert("✅ Slips Reconciled with Physical Bill successfully!");
      handleVendorSelectRecon(reconVendor); 
      fetchData();
    } catch (e) { alert("Error updating slips."); }
  };

  const sendFuelMemoWhatsApp = (slip: any) => {
    if (!slip.pump_mobile) {
      alert("⚠️ Mobile number not found for this Petrol Pump!");
      return;
    }

    const message = `*⛽ FUEL MEMO ALERT* \n\nDear ${slip.vendor_name},\n\nPlease provide fuel to our vehicle based on the following approved memo:\n\n🚛 *Vehicle No:* ${slip.vehicle_no}\n👤 *Driver:* ${slip.driver_name || 'N/A'}\n📍 *Route:* ${slip.route_name || 'N/A'}\n\n💧 *Quantity Approved:* ${slip.liters} Liters (${slip.fuel_type})\n📝 *Memo No:* ${slip.memo_no}\n📅 *Date:* ${slip.date}\n\nKindly process the fueling and add it to our billing cycle.\n\nRegards,\n*Prasad Transport ERP*`;
    const encodedMessage = encodeURIComponent(message);
    let phone = slip.pump_mobile.replace(/\s+/g, '');
    if (phone.length === 10) phone = '91' + phone;
    window.open(`https://wa.me/${phone}?text=${encodedMessage}`, '_blank');
  };

  // 📊 CALCULATE LIVE BALANCES (ONLY DEDUCT IF 'FIXED')
  const totalSelectedAmt = unbilledSlips.filter(s => selectedSlips.includes(s.id)).reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  
  // 🧠 SMART TRACKER: Only sum up those where fuel_type is 'FIXED'
  const totalHsdFixedGiven = pumps.filter(p => p.fuel_type === 'FIXED').reduce((sum, p) => sum + (parseFloat(p.qty) || 0), 0);
  const totalCashFixedGiven = pumps.filter(p => p.fuel_type === 'FIXED').reduce((sum, p) => sum + (parseFloat(p.cash_advance) || 0), 0);
  
  const hsdBalance = (parseFloat(memoData.fixed_hsd) || 0) - totalHsdFixedGiven;
  const cashBalance = (parseFloat(memoData.fixed_cash) || 0) - totalCashFixedGiven;

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; }
        .tab-btn.active { color: #f59e0b; border-bottom: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #f59e0b; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .wa-btn { background: rgba(34, 197, 94, 0.1); border: 1px solid #22c55e; color: #22c55e; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 5px; font-size: 11px; transition: 0.3s; }
        .wa-btn:hover { background: #22c55e; color: white; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>Fuel Memo & Billing</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Multi-Pump Route Memos & 15-Day Vendor Bill Reconciliation</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'MULTI_MEMO' ? 'active' : ''}`} onClick={() => setActiveTab('MULTI_MEMO')}>📝 ISSUE TRIP FUEL MEMO</button>
        <button className={`tab-btn ${activeTab === 'RECON' ? 'active' : ''}`} onClick={() => setActiveTab('RECON')}>🧾 15-DAY BILL RECONCILIATION</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📈 ALL SLIPS HISTORY</button>
      </div>

      {/* 📝 TAB 1: MULTI-PUMP MEMO (ROUTE MASTER) */}
      {activeTab === 'MULTI_MEMO' && (
        <div className="glass-card" style={{ padding: '30px', maxWidth: '1000px', borderTop: '3px solid #f59e0b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
            <h3 style={{ color: '#f59e0b', margin: 0 }}>Create Route Fuel Memo</h3>
            <span className="badge" style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8', fontSize: '14px' }}>{memoData.memo_no}</span>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px' }}>
            <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Date</label><input type="date" className="modern-input" value={memoData.date} onChange={e=>setMemoData({...memoData, date: e.target.value})} /></div>
            <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Vehicle No *</label>
              <select className="modern-input" value={memoData.vehicle_no} onChange={e=>setMemoData({...memoData, vehicle_no: e.target.value})}>
                <option value="">-- Choose Vehicle --</option>
                {vehicles.map(v => <option key={v.id} value={v.vehicle_no}>{v.vehicle_no}</option>)}
              </select>
            </div>
            
            {/* 🆕 DRIVER DROPDOWN */}
            <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Driver Name (For Khata) *</label>
              <select className="modern-input" style={{ border: '1px solid #10b981' }} value={memoData.driver_name} onChange={e=>setMemoData({...memoData, driver_name: e.target.value})}>
                <option value="">-- Select Driver --</option>
                {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
            
            <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Route (e.g. GHY-Haldia)</label><input className="modern-input" value={memoData.route_name} onChange={e=>setMemoData({...memoData, route_name: e.target.value})} /></div>
            
            <div><label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Trip Total Fixed HSD (Ltr)</label><input type="number" className="modern-input" style={{ border: '1px solid #38bdf8' }} placeholder="e.g. 600" value={memoData.fixed_hsd} onChange={e=>setMemoData({...memoData, fixed_hsd: e.target.value})} /></div>
            <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Trip Total Cash Adv (₹)</label><input type="number" className="modern-input" style={{ border: '1px solid #10b981' }} placeholder="e.g. 5000" value={memoData.fixed_cash} onChange={e=>setMemoData({...memoData, fixed_cash: e.target.value})} /></div>
          </div>

          {/* 📊 LIVE BALANCE TRACKER */}
          <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
            <div style={{ flex: 1, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#38bdf8', fontWeight: 'bold', marginBottom: '8px' }}>⛽ 'FIXED' HSD BALANCE (LITERS)</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#cbd5e1', fontSize: '13px' }}>
                <span>Fixed: <b style={{color:'#fff'}}>{memoData.fixed_hsd || 0} L</b></span>
                <span>Given: <b style={{color:'#f59e0b'}}>{totalHsdFixedGiven} L</b></span>
                <span>Balance: <b style={{color: hsdBalance < 0 ? '#ef4444' : '#10b981', fontSize: '16px'}}>{hsdBalance} L</b></span>
              </div>
            </div>
            <div style={{ flex: 1, background: 'rgba(16, 185, 129, 0.05)', border: '1px dashed #10b981', padding: '15px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 'bold', marginBottom: '8px' }}>💵 'FIXED' CASH ADVANCE BALANCE (₹)</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#cbd5e1', fontSize: '13px' }}>
                <span>Fixed: <b style={{color:'#fff'}}>₹{memoData.fixed_cash || 0}</b></span>
                <span>Given: <b style={{color:'#f59e0b'}}>₹{totalCashFixedGiven}</b></span>
                <span>Balance: <b style={{color: cashBalance < 0 ? '#ef4444' : '#10b981', fontSize: '16px'}}>₹{cashBalance}</b></span>
              </div>
            </div>
          </div>

          <h4 style={{ color: '#f59e0b', marginBottom: '10px' }}>⛽ Designated Pumps for this Route</h4>
          
          {pumps.map((pump, index) => (
            <div key={pump.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', marginBottom: '15px', borderLeft: `4px solid ${pump.fuel_type === 'ADVANCE' ? '#ef4444' : '#38bdf8'}` }}>
              <div style={{ width: '30px', fontWeight: 'bold', color: '#94a3b8' }}>P{index + 1}</div>
              
              <div style={{ flex: 1.5 }}><label style={{ fontSize:'11px', color:'#94a3b8' }}>Petrol Pump Name *</label>
                <select className="modern-input" value={pump.vendor_id} onChange={e=>handlePumpChange(pump.id, 'vendor_id', e.target.value)}>
                  <option value="">-- Select Pump --</option>
                  {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </select>
              </div>

              {/* 🆕 TYPE: FIXED vs ADVANCE */}
              <div style={{ flex: 1 }}>
                <label style={{ fontSize:'11px', color: pump.fuel_type === 'ADVANCE' ? '#ef4444' : '#38bdf8', fontWeight: 'bold' }}>Fuel Type *</label>
                <select className="modern-input" style={{ border: `1px solid ${pump.fuel_type === 'ADVANCE' ? '#ef4444' : '#38bdf8'}`, color: pump.fuel_type === 'ADVANCE' ? '#ef4444' : '#38bdf8' }} value={pump.fuel_type} onChange={e=>handlePumpChange(pump.id, 'fuel_type', e.target.value)}>
                  <option value="FIXED">✅ Fixed (Route)</option>
                  <option value="ADVANCE">⚠️ Advance (Driver)</option>
                </select>
              </div>
              
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#94a3b8' }}>Qty (Ltr) *</label><input type="number" className="modern-input" value={pump.qty} onChange={e=>handlePumpChange(pump.id, 'qty', e.target.value)} /></div>
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#94a3b8' }}>Rate/Ltr</label><input type="number" className="modern-input" value={pump.rate} onChange={e=>handlePumpChange(pump.id, 'rate', e.target.value)} /></div>
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#10b981' }}>Amt (₹)</label><input type="number" className="modern-input" style={{ background: 'transparent' }} value={pump.amount} disabled /></div>
              <div style={{ flex: 1 }}><label style={{ fontSize:'11px', color:'#f59e0b' }}>Cash Adv (₹)</label><input type="number" className="modern-input" value={pump.cash_advance} onChange={e=>handlePumpChange(pump.id, 'cash_advance', e.target.value)} /></div>
              
              {pumps.length > 1 && (
                <button onClick={() => handleRemovePump(pump.id)} style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '20px', marginTop: '15px' }}>✕</button>
              )}
            </div>
          ))}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
            <button onClick={handleAddPump} style={{ background: 'rgba(56,189,248,0.1)', color: '#38bdf8', border: '1px dashed #38bdf8', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>+ Add Another Pump</button>
            <button className="glow-btn" style={{ padding: '15px 40px', background: '#f59e0b', opacity: (hsdBalance < 0 || cashBalance < 0) ? 0.5 : 1, cursor: (hsdBalance < 0 || cashBalance < 0) ? 'not-allowed' : 'pointer' }} onClick={handleSaveMultiMemo} disabled={hsdBalance < 0 || cashBalance < 0}>
              {(hsdBalance < 0 || cashBalance < 0) ? '⚠️ Check Negative Fixed Balance' : '🚀 Generate & Save Memos'}
            </button>
          </div>
        </div>
      )}

      {/* 🧾 TAB 2: BILL RECONCILIATION */}
      {activeTab === 'RECON' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
          <div className="glass-card" style={{ padding: '20px', borderTop: '3px solid #10b981' }}>
            <h3 style={{ color: '#10b981', marginTop: 0 }}>1. Enter Physical Bill Details</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Select Petrol Pump *</label>
                <select className="modern-input" value={reconVendor} onChange={e=>handleVendorSelectRecon(e.target.value)}>
                  <option value="">-- Choose Pump --</option>
                  {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>15-Day Bill Amount (₹) *</label>
                <input type="number" className="modern-input" style={{ fontSize: '18px', fontWeight: 'bold', border: '1px solid #10b981' }} value={vendorBillAmount} onChange={e=>setVendorBillAmount(e.target.value)} placeholder="Total from PDF Bill" />
              </div>
              
              <div style={{ background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', marginTop: '10px' }}>
                <p style={{ margin: '0 0 5px 0', color: '#94a3b8', fontSize: '12px' }}>Total of Selected Slips in System:</p>
                <h2 style={{ margin: 0, color: totalSelectedAmt === parseFloat(vendorBillAmount || '0') ? '#10b981' : '#ef4444' }}>
                  ₹{totalSelectedAmt.toFixed(2)}
                </h2>
              </div>

              <button className="glow-btn" style={{ background: '#10b981', marginTop: '10px' }} onClick={handleMatchBill}>✅ Mark Slips as Verified</button>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
            <h3 style={{ color: '#38bdf8', marginTop: 0 }}>2. Match with System Slips (Unbilled)</h3>
            {!reconVendor ? <p style={{ color: '#94a3b8' }}>Select a vendor first to see pending slips...</p> : (
              <table>
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Date</th>
                    <th>Vehicle</th>
                    <th>Type</th>
                    <th>Qty</th>
                    <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {unbilledSlips.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No pending slips for this vendor.</td></tr> : 
                    unbilledSlips.map((s, i) => (
                    <tr key={i} style={{ background: selectedSlips.includes(s.id) ? 'rgba(16,185,129,0.05)' : 'transparent' }}>
                      <td>
                        <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer' }} checked={selectedSlips.includes(s.id)} onChange={() => toggleSlipSelection(s.id)} />
                      </td>
                      <td>{s.date} <br/> <small style={{ color: '#f59e0b' }}>{s.memo_no}</small></td>
                      <td style={{ fontWeight: 'bold', color: '#fff' }}>{s.vehicle_no}</td>
                      <td>
                         <span className="badge" style={{ background: s.fuel_type === 'ADVANCE' ? 'rgba(239,68,68,0.2)' : 'rgba(56,189,248,0.2)', color: s.fuel_type === 'ADVANCE' ? '#ef4444' : '#38bdf8' }}>
                           {s.fuel_type}
                         </span>
                      </td>
                      <td>{s.liters} Ltr</td>
                      <td style={{ textAlign: 'right', color: '#38bdf8', fontWeight: 'bold' }}>₹{s.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* 📈 TAB 3: ALL SLIPS HISTORY */}
      {activeTab === 'HISTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#f59e0b' }}>Loading...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Date & Memo No</th>
                  <th>Vehicle & Driver</th>
                  <th>Petrol Pump</th>
                  <th>Type</th>
                  <th>Qty & Amount</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {fuelHistory.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No Fuel Memos Found.</td></tr> : 
                  fuelHistory.map((f, i) => (
                  <tr key={i}>
                    <td>{f.date}<br/><span style={{ color: '#f59e0b', fontSize: '11px' }}>{f.memo_no}</span></td>
                    <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '14px' }}>
                      {f.vehicle_no}<br/>
                      <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 'normal' }}>👤 {f.driver_name || 'N/A'}</span>
                    </td>
                    <td style={{ color: '#38bdf8' }}>{f.vendor_name}</td>
                    <td>
                      <span className="badge" style={{ background: f.fuel_type === 'ADVANCE' ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: f.fuel_type === 'ADVANCE' ? '#ef4444' : '#10b981' }}>
                        {f.fuel_type || 'FIXED'}
                      </span>
                    </td>
                    <td>
                      <span style={{ color: '#fff', fontWeight: 'bold' }}>{f.liters} Ltr</span> <br/>
                      <small style={{ color: '#10b981' }}>₹{f.amount}</small>
                    </td>
                    <td>
                      <span className="badge" style={{ background: f.bill_status === 'BILLED_VERIFIED' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)', color: f.bill_status === 'BILLED_VERIFIED' ? '#10b981' : '#ef4444' }}>
                        {f.bill_status === 'BILLED_VERIFIED' ? '✅ Reconciled' : '⏳ Pending'}
                      </span>
                    </td>
                    <td>
                      <button className="wa-btn" onClick={() => sendFuelMemoWhatsApp(f)}>
                        💬 Send Memo
                      </button>
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