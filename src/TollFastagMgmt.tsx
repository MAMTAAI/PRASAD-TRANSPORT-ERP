// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function TollFastagMgmt() {
  const [activeTab, setActiveTab] = useState('TRANSACTIONS');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [recharges, setRecharges] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]); // 🚚 Trips Data for Auto-Mapping
  const [loading, setLoading] = useState(false);

  const [rechargeData, setRechargeData] = useState({
    date: new Date().toISOString().split('T')[0], recharge_amount: '', payment_source: 'Bank Transfer', transaction_id: '', vehicle_group: 'All Fleet', remarks: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch Trips for mapping
      const trSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(trSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const txSnap = await getDocs(collection(db, "TOLL_TRANSACTIONS"));
      setTransactions(txSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.Txn_Date || b.createdAt).getTime() - new Date(a.Txn_Date || a.createdAt).getTime()));

      const rcSnap = await getDocs(collection(db, "TOLL_RECHARGES"));
      setRecharges(rcSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 📥 IMPORT EXCEL/CSV DATA (With Smart Auto-Trip Mapping)
  const handleBulkUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event: any) => {
      const csvData = event.target.result;
      const rows = csvData.split('\n');
      const headers = rows[0].split(',').map((h: string) => h.trim().replace(/"/g, '')); // Clean headers

      setLoading(true);
      let successCount = 0;

      for (let i = 1; i < rows.length; i++) {
        if (!rows[i].trim()) continue;
        const values = rows[i].split(',').map((v: string) => v.trim().replace(/"/g, ''));
        let rowData: any = {};
        
        headers.forEach((header: string, index: number) => { rowData[header] = values[index]; });

        const vehicleKey = rowData['Vehicle_No'] || rowData['Vehicle No'] || rowData['Vehicle Number'];
        
        if (rowData['Txn_Date'] && vehicleKey) {
          
          // 🤖 SMART AUTO-MAPPING LOGIC (Ignores spaces & case sensitivity)
          const csvVNo = vehicleKey.replace(/\s+/g, '').toUpperCase();
          
          const matchedTrip = trips.find(t => {
            const dbVNo = (t.vehicle_no || t.vehical_no || t.Vehical_No || '').replace(/\s+/g, '').toUpperCase();
            return dbVNo === csvVNo && t.trip_status !== 'COMPLETED'; // Links to currently running trip
          });

          await addDoc(collection(db, "TOLL_TRANSACTIONS"), {
            ...rowData,
            Vehicle_No: vehicleKey.toUpperCase(),
            linked_trip_id: matchedTrip ? (matchedTrip.trip_id || matchedTrip.Trip_ID) : 'UNMAPPED',
            linked_customer: matchedTrip ? (matchedTrip.customer_name || matchedTrip.Customer || matchedTrip.registered_assessee) : 'N/A',
            is_billable: false, // Default false, user can change later
            createdAt: serverTimestamp()
          });
          successCount++;
        }
      }
      setLoading(false);
      alert(`✅ Upload Complete! ${successCount} Tolls added & auto-mapped to active Trips.`);
      fetchData();
    };
    reader.readAsText(file);
  };

  // 💳 SAVE WALLET RECHARGE
  const handleSaveRecharge = async () => { 
    if (!rechargeData.recharge_amount) return alert("⚠️ Please enter recharge amount!");
    try {
      await addDoc(collection(db, "TOLL_RECHARGES"), {
        ...rechargeData,
        createdAt: serverTimestamp()
      });
      alert("✅ Wallet Recharge Saved Successfully!");
      setRechargeData({ date: new Date().toISOString().split('T')[0], recharge_amount: '', payment_source: 'Bank Transfer', transaction_id: '', vehicle_group: 'All Fleet', remarks: '' });
      fetchData();
    } catch (e) {
      alert("❌ Error saving recharge data.");
    }
  };

  // 📝 UPDATE BILLABLE STATUS (For IOCL/BPCL Billing)
  const toggleBillable = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "TOLL_TRANSACTIONS", id), { is_billable: !currentStatus });
      fetchData();
    } catch (error) { alert("Error updating status"); }
  };

  const totalTollAmount = transactions.reduce((acc, curr) => acc + (parseFloat(curr.Amount || curr.amount || '0')), 0);
  const totalRechargeAmount = recharges.reduce((acc, curr) => acc + (parseFloat(curr.recharge_amount || '0')), 0);
  const estimatedBalance = totalRechargeAmount - totalTollAmount;

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: 'sans-serif' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; backdrop-filter: blur(10px); }
        .glow-btn { background: #3b82f6; color: white; border: none; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; }
        .glow-btn:hover { background: #2563eb; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; }
        .modern-input:focus { border-color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 15px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 12px 15px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '36px', fontWeight: '900' }}>Fastag & Toll Central</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Auto Trip-Mapping & Company Billing System</p>
        </div>
        <div style={{ display: 'flex', gap: '15px' }}>
          <label className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }}>
            {loading ? '⏳ Auto-Mapping Data...' : '📤 Upload Bank CSV (Auto-Map)'}
            <input type="file" hidden accept=".csv" onChange={handleBulkUpload} disabled={loading} />
          </label>
        </div>
      </div>

      {/* 📊 Fastag Dashboard Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '30px' }}>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #10b981' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Wallet Recharges</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#10b981' }}>₹{totalRechargeAmount.toLocaleString()}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #ef4444' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Toll Deductions</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#ef4444' }}>₹{totalTollAmount.toLocaleString()}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #38bdf8' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Estimated Wallet Balance</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#38bdf8' }}>₹{estimatedBalance.toLocaleString()}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'TRANSACTIONS' ? 'active' : ''}`} onClick={() => setActiveTab('TRANSACTIONS')}>🛣️ TOLL TRANSACTIONS</button>
        <button className={`tab-btn ${activeTab === 'RECHARGE' ? 'active' : ''}`} onClick={() => setActiveTab('RECHARGE')}>💳 WALLET RECHARGES</button>
      </div>

      {/* 🛣️ TOLL TRANSACTIONS TAB */}
      {activeTab === 'TRANSACTIONS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Syncing with Trips Database...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Date & Time</th>
                  <th>Vehicle No</th>
                  <th>Toll Plaza Name</th>
                  <th>Amount (₹)</th>
                  <th>Linked Trip ID</th>
                  <th>Customer (IOCL/BPCL)</th>
                  <th style={{ textAlign: 'center' }}>Billable to Co.?</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No transactions found. Upload your Fastag Bank CSV to populate this list.</td></tr>
                ) : (
                  transactions.map((t, i) => (
                    <tr key={i}>
                      <td>{t.Txn_Date || t.date}</td>
                      <td style={{ fontWeight: 'bold', color: '#fff' }}>{t.Vehicle_No || t.vehicle_no}</td>
                      <td>{t.Toll_Plaza_Name || t.Plaza || 'N/A'}</td>
                      <td style={{ color: '#ef4444', fontWeight: 'bold' }}>₹{t.Amount || t.amount}</td>
                      
                      {/* 🚚 Auto Mapped Trip */}
                      <td>
                        <span className="badge" style={{ background: t.linked_trip_id !== 'UNMAPPED' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: t.linked_trip_id !== 'UNMAPPED' ? '#38bdf8' : '#ef4444', border: `1px solid ${t.linked_trip_id !== 'UNMAPPED' ? '#38bdf8' : '#ef4444'}` }}>
                          {t.linked_trip_id}
                        </span>
                      </td>
                      
                      <td style={{ color: '#cbd5e1', fontWeight: 'bold' }}>{t.linked_customer !== 'N/A' ? t.linked_customer : '-'}</td>
                      
                      {/* 💰 Billable Toggle for Invoice */}
                      <td style={{ textAlign: 'center' }}>
                        <button 
                          onClick={() => toggleBillable(t.id, t.is_billable)}
                          style={{ 
                            background: t.is_billable ? 'rgba(16, 185, 129, 0.1)' : 'rgba(71, 85, 105, 0.3)', 
                            color: t.is_billable ? '#10b981' : '#94a3b8', 
                            border: `1px solid ${t.is_billable ? '#10b981' : '#475569'}`, 
                            padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', transition: '0.3s' 
                          }}
                        >
                          {t.is_billable ? '✅ YES (Add to Bill)' : '❌ NO (Freight Inc.)'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 💳 WALLET RECHARGE TAB */}
      {activeTab === 'RECHARGE' && (
         <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
            
            {/* Recharge Entry Form */}
            <div className="glass-card" style={{ padding: '30px', borderTop: '4px solid #10b981' }}>
              <h2 style={{ color: '#10b981', marginTop: 0, marginBottom: '20px', fontSize: '20px' }}>Add Fastag Recharge</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Recharge Date</label><input type="date" className="modern-input" value={rechargeData.date} onChange={e=>setRechargeData({...rechargeData, date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div><label style={{ fontSize: '12px', color: '#38bdf8', fontWeight: 'bold' }}>Amount (₹) *</label><input type="number" className="modern-input" style={{ border: '1px solid #38bdf8', fontSize: '18px', fontWeight: 'bold', color: '#38bdf8' }} value={rechargeData.recharge_amount} onChange={e=>setRechargeData({...rechargeData, recharge_amount: e.target.value})} /></div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Payment Source</label>
                  <select className="modern-input" value={rechargeData.payment_source} onChange={e=>setRechargeData({...rechargeData, payment_source: e.target.value})}>
                    <option value="Bank Transfer">Bank Transfer (HDFC/SBI etc)</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="UPI">UPI</option>
                  </select>
                </div>
                <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Bank Ref / UTR No</label><input className="modern-input" value={rechargeData.transaction_id} onChange={e=>setRechargeData({...rechargeData, transaction_id: e.target.value})} /></div>
                <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Remarks</label><input className="modern-input" placeholder="e.g. Monthly Topup" value={rechargeData.remarks} onChange={e=>setRechargeData({...rechargeData, remarks: e.target.value})} /></div>
                
                <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', justifyContent: 'center', marginTop: '10px' }} onClick={handleSaveRecharge}>
                   ✅ Add Funds to Wallet
                </button>
              </div>
            </div>

            {/* Recharge History Table */}
            <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
              <h2 style={{ color: '#fff', marginTop: 0, marginBottom: '20px', fontSize: '20px' }}>Recharge History</h2>
              <table>
                <thead>
                  <tr><th>Date</th><th>Amount (₹)</th><th>Payment Mode</th><th>Ref No</th><th>Remarks</th></tr>
                </thead>
                <tbody>
                  {recharges.length === 0 ? <tr><td colSpan={5} style={{textAlign: 'center', padding: '30px'}}>No recharges recorded.</td></tr> : 
                    recharges.map((r, i) => (
                      <tr key={i}>
                        <td>{r.date}</td>
                        <td style={{ color: '#10b981', fontWeight: 'bold', fontSize: '16px' }}>+ ₹{r.recharge_amount}</td>
                        <td><span className="badge" style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8' }}>{r.payment_source}</span></td>
                        <td>{r.transaction_id || '-'}</td>
                        <td>{r.remarks || '-'}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>

         </div>
      )}

    </div>
  );
}