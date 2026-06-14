// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, where, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function FuelMgmt() {
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
      const vSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

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

      for (const pump of pumps) {
        if (!pump.vendor_id || !pump.qty) continue;
        
        const amt = parseFloat(pump.amount || '0');
        const cashAmt = parseFloat(pump.cash_advance || '0');
        totalAmount += amt;

        await addDoc(collection(db, "FUEL_ENTRIES"), {
          date: memoData.date,
          vehicle_no: memoData.vehicle_no,
          route_name: memoData.route_name,
          driver_name: memoData.driver_name,
          memo_no: memoData.memo_no,
          vendor_id: pump.vendor_id,
          vendor_name: pump.vendor_name,
          fuel_type: pump.fuel_type, 
          liters: pump.qty,
          rate: pump.rate,
          amount: amt.toFixed(2),
          cash_given_to_pump: pump.cash_advance,
          pump_mobile: pump.mobile,
          bill_status: 'UNBILLED', 
          createdAt: serverTimestamp()
        });

        // 🔥 AUTO-POST TO DRIVER SETTLEMENT (IF ADVANCE)
        if (pump.fuel_type === 'ADVANCE' && memoData.driver_name) {
          const totalDriverAdvance = amt + cashAmt; 
          
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

      const successMsg = `✅ Trip Fuel Memo Generated!\n\nNote: Vendor Balance will update ONLY after you Verify the Bill in Reconciliation Tab.`;
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

  const handleSelectAllFilteredSlips = (e: any) => {
     if(e.target.checked) {
        const filteredIds = filteredUnbilledSlips.map(s => s.id);
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
      await updateDoc(doc(db, "FUEL_ENTRIES", editingSlipId), {
         liters: editSlipData.liters,
         rate: editSlipData.rate,
         amount: editSlipData.amount
      });
      setEditingSlipId('');
      alert("✅ Slip Updated!");
      
      const fSnap = await getDocs(collection(db, "FUEL_ENTRIES"));
      const freshHistory = fSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setFuelHistory(freshHistory);
      
      const slips = freshHistory.filter(f => f.vendor_id === reconVendor && f.bill_status === 'UNBILLED');
      setUnbilledSlips(slips);

    } catch (e) { alert("❌ Error updating slip."); }
  };

  const deleteReconSlip = async (id: string) => {
    if(window.confirm("⚠️ Are you sure you want to permanently delete this Fuel Slip?")) {
      await deleteDoc(doc(db, "FUEL_ENTRIES", id));
      
      const fSnap = await getDocs(collection(db, "FUEL_ENTRIES"));
      const freshHistory = fSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setFuelHistory(freshHistory);
      
      const slips = freshHistory.filter(f => f.vendor_id === reconVendor && f.bill_status === 'UNBILLED');
      setUnbilledSlips(slips);
    }
  };

  // 🏦 FINAL BILL VERIFICATION & LEDGER POSTING
  const handleMatchBill = async () => {
    if (!vendorBillAmount) return alert("⚠️ Enter the Total Amount from Physical Bill!");
    if (selectedSlips.length === 0) return alert("⚠️ Please select at least one slip to verify!");
    
    const selectedTotal = filteredUnbilledSlips.filter(s => selectedSlips.includes(s.id)).reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
    
    if (Math.abs(selectedTotal - parseFloat(vendorBillAmount)) > 10) {
      if(!window.confirm(`⚠️ Difference Detected!\n\nSystem Selected Total: ₹${selectedTotal.toFixed(2)}\nPhysical Bill Amount: ₹${vendorBillAmount}\n\nDo you still want to force proceed and Post to Ledger?`)) {
        return;
      }
    }

    try {
      const slipsToUpdate = filteredUnbilledSlips.filter(s => selectedSlips.includes(s.id));
      for (const slip of slipsToUpdate) {
        await updateDoc(doc(db, "FUEL_ENTRIES", slip.id), { bill_status: 'BILLED_VERIFIED' });
      }

      // 🏦 POST TO LEDGER WITH DATE RANGE
      const vendor = fuelVendors.find(v => v.id === reconVendor);
      const vName = vendor ? vendor.vendor_name : 'Unknown Vendor';
      
      let periodStr = '';
      if (reconFromDate && reconToDate) {
         periodStr = ` (Period: ${new Date(reconFromDate).toLocaleDateString('en-GB')} to ${new Date(reconToDate).toLocaleDateString('en-GB')})`;
      }

      await addDoc(collection(db, "LEDGER_ENTRIES"), {
         ledgerId: reconVendor, 
         date: new Date().toISOString().split('T')[0],
         particulars: `Fuel Bill Verified & Reconciled - Included ${selectedSlips.length} Slips${periodStr}`,
         dr_cr: 'Cr (Credit)', 
         amount: parseFloat(vendorBillAmount),
         source: 'MANUAL', 
         company: 'ALL',
         branch: 'ALL',
         created_at: Timestamp.now()
      });

      if (vendor) {
         const currentBal = parseFloat(vendor.current_balance || vendor.opening_balance || '0');
         const newBal = currentBal + parseFloat(vendorBillAmount);
         await updateDoc(doc(db, "VENDORS", vendor.id), { current_balance: newBal });
      }

      alert(`✅ SUCCESS: Slips Reconciled!\n\n₹${vendorBillAmount} has been successfully POSTED to ${vName}'s Ledger Account.`);
      
      setVendorBillAmount('');
      setSelectedSlips([]);
      fetchData(); 
      handleVendorSelectRecon(reconVendor); 
      
    } catch (e) { alert("❌ Error updating slips and ledger."); }
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
        await deleteDoc(doc(db, "FUEL_ENTRIES", id));
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

  const quickBtnStyle = { background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 12px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; }
        .tab-btn.active { color: #f59e0b; border-bottom: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; outline: none; }
        .modern-input:focus { border-color: #f59e0b; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #f59e0b; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .wa-btn { background: rgba(34, 197, 94, 0.1); border: 1px solid #22c55e; color: #22c55e; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 5px; font-size: 11px; transition: 0.3s; }
        .wa-btn:hover { background: #22c55e; color: white; }
        .group-btn { background: rgba(56, 189, 248, 0.1); border: 1px solid #38bdf8; color: #38bdf8; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 5px; font-size: 11px; transition: 0.3s; margin-top: 5px;}
        .group-btn:hover { background: #38bdf8; color: white; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>Fuel Memo & Billing</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Multi-Pump Route Memos & Period-Wise Vendor Bill Reconciliation</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'MULTI_MEMO' ? 'active' : ''}`} onClick={() => setActiveTab('MULTI_MEMO')}>📝 ISSUE TRIP FUEL MEMO</button>
        <button className={`tab-btn ${activeTab === 'RECON' ? 'active' : ''}`} onClick={() => setActiveTab('RECON')}>🧾 BILL RECONCILIATION</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📈 ALL SLIPS HISTORY</button>
      </div>

      {/* 📝 TAB 1: MULTI-PUMP MEMO */}
      {activeTab === 'MULTI_MEMO' && (
        <div className="glass-card" style={{ padding: '30px', maxWidth: '1000px', borderTop: '3px solid #f59e0b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
            <h3 style={{ color: '#f59e0b', margin: 0 }}>Create Route Fuel Memo</h3>
            <span className="badge" style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8', fontSize: '14px' }}>{memoData.memo_no}</span>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px' }}>
            <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Date</label><input type="date" className="modern-input" value={memoData.date} onChange={e=>setMemoData({...memoData, date: e.target.value})} style={{colorScheme:'dark'}}/></div>
            <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Vehicle No *</label>
              <select className="modern-input" value={memoData.vehicle_no} onChange={e=>setMemoData({...memoData, vehicle_no: e.target.value})}>
                <option value="">-- Choose Vehicle --</option>
                {vehicles.map(v => <option key={v.id} value={v.vehicle_no || v.vehical_no}>{v.vehicle_no || v.vehical_no}</option>)}
              </select>
            </div>
            
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
                <button onClick={() => handleRemovePump(pump.id)} style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '20px', paddingBottom: '8px' }}>✕</button>
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

      {/* 🧾 TAB 2: BILL RECONCILIATION (WITH QUICK DATES & EDITING) */}
      {activeTab === 'RECON' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
          
          <div className="glass-card" style={{ padding: '20px', borderTop: '3px solid #10b981', height: 'fit-content' }}>
            <h3 style={{ color: '#10b981', marginTop: 0 }}>1. Enter Physical Bill Details</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Select Petrol Pump *</label>
                <select className="modern-input" value={reconVendor} onChange={e=>handleVendorSelectRecon(e.target.value)}>
                  <option value="">-- Choose Pump --</option>
                  {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
                </select>
              </div>
              
              {/* 🚀 QUICK BI-MONTHLY DATE SELECTORS */}
              <div>
                <label style={{ fontSize:'12px', color:'#38bdf8', display:'block', marginBottom:'5px' }}>Quick Select Period:</label>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                  <button onClick={() => setQuickDate('LAST_H1')} style={{...quickBtnStyle}}>Last Mth 1-15</button>
                  <button onClick={() => setQuickDate('LAST_H2')} style={{...quickBtnStyle}}>Last Mth 16-End</button>
                  <button onClick={() => setQuickDate('THIS_H1')} style={{...quickBtnStyle}}>This Mth 1-15</button>
                  <button onClick={() => setQuickDate('THIS_H2')} style={{...quickBtnStyle}}>This Mth 16-End</button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize:'12px', color:'#38bdf8' }}>From Date</label>
                  <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={reconFromDate} onChange={e => setReconFromDate(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize:'12px', color:'#38bdf8' }}>To Date</label>
                  <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={reconToDate} onChange={e => setReconToDate(e.target.value)} />
                </div>
              </div>
              {(reconFromDate || reconToDate) && <span onClick={() => {setReconFromDate(''); setReconToDate('');}} style={{ color: '#ef4444', fontSize: '11px', cursor: 'pointer', textAlign: 'right' }}>❌ Clear Dates</span>}

              <div><label style={{ fontSize:'12px', color:'#f59e0b', fontWeight: 'bold' }}>Physical Bill Amount (₹) *</label>
                <input type="number" className="modern-input" style={{ fontSize: '20px', fontWeight: 'bold', border: '1px solid #f59e0b', color: '#f59e0b' }} value={vendorBillAmount} onChange={e=>setVendorBillAmount(e.target.value)} placeholder="Total from PDF Bill" />
              </div>
              
              <div style={{ background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', marginTop: '10px' }}>
                <p style={{ margin: '0 0 5px 0', color: '#94a3b8', fontSize: '12px' }}>Total of <b style={{color: '#fff'}}>{selectedSlips.length}</b> Selected Slips:</p>
                <h2 style={{ margin: 0, color: activeReconTotal === parseFloat(vendorBillAmount || '0') ? '#10b981' : '#ef4444' }}>
                  ₹{activeReconTotal.toFixed(2)}
                </h2>
              </div>

              <button className="glow-btn" style={{ background: '#10b981', marginTop: '10px', justifyContent: 'center' }} onClick={handleMatchBill}>✅ Verify & Post to Ledger</button>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
            <h3 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '5px' }}>2. Match & Edit System Slips (Unbilled)</h3>
            <p style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '15px' }}>Verify rates and quantities before posting to the Vendor Ledger.</p>
            
            {!reconVendor ? <p style={{ color: '#64748b' }}>Select a vendor first to see pending slips...</p> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={{padding:'12px'}}>
                       <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#10b981' }} title="Select All Visible" 
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
                    <tr key={i} style={{ background: selectedSlips.includes(s.id) ? 'rgba(16,185,129,0.05)' : 'transparent', borderBottom: '1px solid #1e293b' }}>
                      <td style={{padding:'12px'}}>
                        <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#10b981' }} checked={selectedSlips.includes(s.id)} onChange={() => toggleSlipSelection(s.id)} />
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
                            <input type="number" className="modern-input" style={{ width: '80px', padding: '5px', borderColor: '#f59e0b' }} value={editSlipData.rate} onChange={e=>handleEditSlipChange('rate', e.target.value)} placeholder="Rate" />
                          </td>
                          <td style={{padding:'12px', textAlign: 'right'}}>
                            <input type="number" className="modern-input" style={{ width: '90px', padding: '5px', borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={editSlipData.amount} onChange={e=>handleEditSlipChange('amount', e.target.value)} />
                          </td>
                          <td style={{padding:'12px', textAlign: 'center'}}>
                            <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                              <button onClick={saveEditedSlip} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>💾 Save</button>
                              <button onClick={() => setEditingSlipId('')} style={{ background: '#334155', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={{padding:'12px'}}>{s.liters} Ltr</td>
                          <td style={{padding:'12px', color: '#f59e0b'}}>{s.rate || '-'}</td>
                          <td style={{ textAlign: 'right', color: '#38bdf8', fontWeight: 'bold', padding:'12px', fontSize: '15px' }}>₹{s.amount}</td>
                          <td style={{ textAlign: 'center', padding:'12px' }}>
                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                              <button onClick={() => startEditingSlip(s)} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>✏️ Edit</button>
                              <button onClick={() => deleteReconSlip(s.id)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>🗑️ Del</button>
                            </div>
                          </td>
                        </>
                      )}
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
          
          <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px' }}>
            <div style={{ flex: 1.5 }}>
              <label style={{ fontSize:'11px', color:'#94a3b8' }}>Filter by Pump / Vendor</label>
              <select className="modern-input" value={historyVendor} onChange={e=>setHistoryVendor(e.target.value)}>
                <option value="ALL">-- All Pumps --</option>
                {fuelVendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize:'11px', color:'#38bdf8' }}>From Date</label>
              <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={historyFromDate} onChange={e => setHistoryFromDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize:'11px', color:'#38bdf8' }}>To Date</label>
              <input type="date" className="modern-input" style={{ colorScheme: 'dark' }} value={historyToDate} onChange={e => setHistoryToDate(e.target.value)} />
            </div>
            <div style={{ flex: 1.5 }}>
              <label style={{ fontSize:'11px', color:'#f59e0b' }}>Search Vehicle / Memo No</label>
              <input type="text" className="modern-input" placeholder="Type to search..." value={historySearch} onChange={e => setHistorySearch(e.target.value)} />
            </div>
            {(historyFromDate || historyToDate || historySearch || historyVendor !== 'ALL') && (
               <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                 <button onClick={() => {setHistoryFromDate(''); setHistoryToDate(''); setHistorySearch(''); setHistoryVendor('ALL');}} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Clear</button>
               </div>
            )}
          </div>

          {loading ? <p style={{ color: '#f59e0b', textAlign: 'center', padding: '20px' }}>Loading History...</p> : (
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
                            style={{ cursor: 'pointer', color: '#64748b', fontSize: '16px', transition: '0.2s', marginTop: '5px' }}
                            onMouseOver={(e) => e.currentTarget.style.color = '#ef4444'}
                            onMouseOut={(e) => e.currentTarget.style.color = '#64748b'}
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