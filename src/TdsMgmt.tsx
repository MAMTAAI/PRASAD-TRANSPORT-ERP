import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function TdsMgmt() {
  const [tdsRecords, setTdsRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Form State matching your Excel Sheet
  const [formData, setFormData] = useState({
    Consignee_Name: '',
    Date: new Date().toISOString().split('T')[0],
    Gross_Freight: '',
    TDS_Rate: '2', // Transport typical: 1% (Individual) or 2% (Company)
    TDS_Deducted: '0',
    Status: 'PENDING' // PENDING or FILED
  });

  useEffect(() => {
    fetchTDSData();
  }, []);

  const fetchTDSData = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "TDS_MANAGEMENT"));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTdsRecords(data.sort((a, b) => new Date(b.Date).getTime() - new Date(a.Date).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 🧮 Auto Calculate TDS
  const handleAmountChange = (freight: string, rate: string) => {
    const gross = parseFloat(freight || '0');
    const percent = parseFloat(rate || '0');
    const deducted = ((gross * percent) / 100).toFixed(2);
    setFormData({ ...formData, Gross_Freight: freight, TDS_Rate: rate, TDS_Deducted: deducted });
  };

  // 💾 Save TDS Record
  const handleSave = async () => {
    if (!formData.Consignee_Name || !formData.Gross_Freight) {
      return alert("Please fill Consignee Name and Gross Freight!");
    }
    try {
      await addDoc(collection(db, "TDS_MANAGEMENT"), {
        ...formData,
        createdAt: serverTimestamp()
      });
      alert("✅ TDS Record Saved Successfully!");
      setFormData({ ...formData, Consignee_Name: '', Gross_Freight: '', TDS_Deducted: '0' });
      fetchTDSData();
    } catch (e) { alert("Error saving TDS data!"); }
  };

  // ✅ Toggle Filing Status (26AS Match)
  const toggleFilingStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'PENDING' ? 'FILED' : 'PENDING';
    try {
      await updateDoc(doc(db, "TDS_MANAGEMENT", id), { Status: newStatus });
      fetchTDSData();
    } catch (error) { alert("Error updating status"); }
  };

  // 📥 Export for CA (Form 26AS Matching)
  const handleExportCSV = () => {
    if (tdsRecords.length === 0) return alert("No data to export!");
    const headers = ["Date", "Consignee_Name", "Gross_Freight", "TDS_Rate(%)", "TDS_Deducted", "Filing_Status"];
    let csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n";

    tdsRecords.forEach(r => {
      const row = [r.Date, r.Consignee_Name, r.Gross_Freight, r.TDS_Rate, r.TDS_Deducted, r.Status].join(",");
      csvContent += row + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `TDS_Report_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: '#0f172a' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { background: #2563eb; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>TDS Management (Sec 194C)</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Track TDS Deductions & 26AS Filing Status</p>
        </div>
        <button className="glow-btn" style={{ background: '#f59e0b' }} onClick={handleExportCSV}>
          📥 Download for CA (CSV)
        </button>
      </div>

      {/* 📝 Input Form Section */}
      <div className="glass-card" style={{ padding: '20px', marginBottom: '30px' }}>
        <h3 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '15px' }}>✂️ Add TDS Deduction</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px', alignItems: 'end' }}>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>Date</label>
          <input type="date" className="modern-input" value={formData.Date} onChange={e=>setFormData({...formData, Date: e.target.value})} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>Consignee Name (Party) *</label>
          <input className="modern-input" placeholder="e.g. Reliance Ind." value={formData.Consignee_Name} onChange={e=>setFormData({...formData, Consignee_Name: e.target.value})} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#10b981', fontWeight:'bold' }}>Gross Freight (₹) *</label>
          <input type="number" className="modern-input" value={formData.Gross_Freight} onChange={e=>handleAmountChange(e.target.value, formData.TDS_Rate)} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>TDS Rate (%)</label>
          <select className="modern-input" value={formData.TDS_Rate} onChange={e=>handleAmountChange(formData.Gross_Freight, e.target.value)}>
            <option value="1">1% (Individual/HUF)</option>
            <option value="2">2% (Company/Firm)</option>
            <option value="5">5%</option>
            <option value="10">10%</option>
          </select></div>
          
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
            <label style={{ fontSize: '11px', color: '#ef4444', fontWeight:'bold' }}>TDS Deducted (₹)</label>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444', marginTop: '3px' }}>₹{formData.TDS_Deducted}</div>
          </div>

          <button className="glow-btn" onClick={handleSave}>✅ Save Record</button>
        </div>
      </div>

      {/* 📊 Data Table Section */}
      <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
        <h3 style={{ color: '#38bdf8', marginTop: 0 }}>📋 TDS Deduction Registry</h3>
        {loading ? <p style={{ color: '#38bdf8' }}>Loading Data...</p> : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Consignee Name</th>
                <th>Gross Freight</th>
                <th>TDS Rate</th>
                <th>TDS Deducted</th>
                <th>Return Filing Status</th>
              </tr>
            </thead>
            <tbody>
              {tdsRecords.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No TDS records found.</td></tr>
              ) : (
                tdsRecords.map((r, i) => (
                  <tr key={i}>
                    <td>{r.Date}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{r.Consignee_Name}</td>
                    <td>₹{r.Gross_Freight}</td>
                    <td>{r.TDS_Rate}%</td>
                    <td style={{ color: '#ef4444', fontWeight: 'bold' }}>₹{r.TDS_Deducted}</td>
                    
                    {/* Toggle Status Button */}
                    <td>
                      <button 
                        onClick={() => toggleFilingStatus(r.id, r.Status)}
                        style={{ 
                          background: r.Status === 'FILED' ? '#10b981' : '#ef4444', 
                          color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold'
                        }}
                      >
                        {r.Status === 'FILED' ? '✅ FILED (26AS OK)' : '⏳ PENDING'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}