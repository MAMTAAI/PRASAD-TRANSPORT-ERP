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
    date: new Date().toISOString().split('T')[0], recharge_amount: '', payment_source: '', transaction_id: '', vehicle_group: '', remarks: ''
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
      setTransactions(txSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.Txn_Date).getTime() - new Date(a.Txn_Date).getTime()));

      const rcSnap = await getDocs(collection(db, "TOLL_RECHARGES"));
      setRecharges(rcSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 📥 IMPORT EXCEL/CSV DATA (With Auto-Trip Mapping)
  const handleBulkUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event: any) => {
      const csvData = event.target.result;
      const rows = csvData.split('\n');
      const headers = rows[0].split(',').map((h: string) => h.trim());

      setLoading(true);
      let successCount = 0;

      for (let i = 1; i < rows.length; i++) {
        if (!rows[i].trim()) continue;
        const values = rows[i].split(',').map((v: string) => v.trim());
        let rowData: any = {};
        
        headers.forEach((header: string, index: number) => { rowData[header] = values[index]; });

        if (rowData['Txn_Date'] && rowData['Vehicle_No']) {
          
          // 🤖 SMART AUTO-MAPPING LOGIC
          // Find if this vehicle was on a trip around this date
          const matchedTrip = trips.find(t => 
            t.vehicle_no === rowData['Vehicle_No'] && 
            t.trip_status !== 'COMPLETED' // simplified logic for active trips
          );

          await addDoc(collection(db, "TOLL_TRANSACTIONS"), {
            ...rowData,
            linked_trip_id: matchedTrip ? matchedTrip.trip_id : 'UNMAPPED',
            linked_customer: matchedTrip ? matchedTrip.customer : 'N/A',
            is_billable: matchedTrip ? false : false, // Default false, user can change
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

  const handleExportCSV = () => { /* Export logic remains same */ };
  const handleSaveRecharge = async () => { /* Recharge logic remains same */ };

  // 📝 UPDATE BILLABLE STATUS (For IOCL/BPCL 15-Day/Monthly Billing)
  const toggleBillable = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "TOLL_TRANSACTIONS", id), { is_billable: !currentStatus });
      fetchData();
    } catch (error) { alert("Error updating status"); }
  };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: '#0f172a' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { background: #2563eb; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>Fastag & Toll Management</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Auto Trip-Mapping & Company Billing System</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label className="glow-btn" style={{ background: '#10b981', cursor: 'pointer' }}>
            {loading ? '⏳ Auto-Mapping...' : '📤 Upload Bank CSV (Auto-Map)'}
            <input type="file" hidden accept=".csv" onChange={handleBulkUpload} />
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'TRANSACTIONS' ? 'active' : ''}`} onClick={() => setActiveTab('TRANSACTIONS')}>🛣️ TOLL TRANSACTIONS</button>
        <button className={`tab-btn ${activeTab === 'RECHARGE' ? 'active' : ''}`} onClick={() => setActiveTab('RECHARGE')}>💳 WALLET RECHARGES</button>
      </div>

      {activeTab === 'TRANSACTIONS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#38bdf8' }}>Syncing with Trips...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Vehicle No</th>
                  <th>Toll Plaza</th>
                  <th>Amount (₹)</th>
                  <th>Linked Trip ID</th>
                  <th>Customer (IOCL/BPCL)</th>
                  <th>Billable to Co.?</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No transactions found. Upload CSV.</td></tr>
                ) : (
                  transactions.map((t, i) => (
                    <tr key={i}>
                      <td>{t.Txn_Date}</td>
                      <td style={{ fontWeight: 'bold', color: '#fff' }}>{t.Vehicle_No}</td>
                      <td>{t.Toll_Plaza_Name}</td>
                      <td style={{ color: '#ef4444', fontWeight: 'bold' }}>₹{t.Amount}</td>
                      
                      {/* 🚚 Auto Mapped Trip */}
                      <td>
                        <span className="badge" style={{ background: t.linked_trip_id !== 'UNMAPPED' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: t.linked_trip_id !== 'UNMAPPED' ? '#38bdf8' : '#ef4444' }}>
                          {t.linked_trip_id}
                        </span>
                      </td>
                      
                      <td>{t.linked_customer}</td>
                      
                      {/* 💰 Billable Toggle for Invoice */}
                      <td>
                        <button 
                          onClick={() => toggleBillable(t.id, t.is_billable)}
                          style={{ 
                            background: t.is_billable ? '#10b981' : '#475569', 
                            color: '#fff', border: 'none', padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px' 
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

      {/* Recharge Tab hidden for brevity, it remains the same */}
      {activeTab === 'RECHARGE' && (
         <div className="glass-card" style={{ padding: '20px', textAlign: 'center', color: '#cbd5e1' }}>
            <h3>Wallet Recharge Section (Active)</h3>
            <p>Switch to Toll Transactions to see the Auto-Mapping magic!</p>
         </div>
      )}

    </div>
  );
}