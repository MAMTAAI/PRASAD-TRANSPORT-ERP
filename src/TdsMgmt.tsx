// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { extractJsonFromImage } from './lib/aiScanner';

export default function TdsMgmt() {
  const [tdsRecords, setTdsRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanningBill, setScanningBill] = useState(false);

  // 📄 Scan a customer bill (PDF/photo) → auto-fill TDS (party + gross freight).
  const handleScanBill = async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    setScanningBill(true);
    try {
      const prompt = `This is a transport company's customer freight bill. Extract ONLY JSON:
{ "party_name": "", "total_gross_amount": 0 }
total_gross_amount = grand total gross freight amount. Numbers only, no commas.`;
      const ai = await extractJsonFromImage(file, prompt);
      const gross = Number(String(ai.total_gross_amount ?? '').replace(/[^0-9.]/g, '')) || 0;
      if (gross <= 0) { alert('⚠️ Bill ka total nahi mila — saaf PDF se try karein.'); setScanningBill(false); return; }
      setFormData(prev => ({ ...prev, Consignee_Name: ai.party_name || prev.Consignee_Name }));
      handleAmountChange(String(gross), formData.TDS_Rate); // TDS computed in code
      alert(`✅ Bill scan (local Gemma): ${ai.party_name || ''} · Gross ₹${gross.toLocaleString('en-IN')} — TDS ${formData.TDS_Rate}% auto-calculated. Verify karke Save.`);
    } catch (err: any) {
      const offline = err?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(err?.message || '');
      alert(offline ? '❌ Local AI (Ollama) band hai.' : '❌ Bill padhi nahi gayi.');
    }
    setScanningBill(false);
  };

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

  // 🧮 Auto Calculate TDS (with NaN protection)
  const handleAmountChange = (freight: string, rate: string) => {
    const gross = parseFloat(freight) || 0;
    const percent = parseFloat(rate) || 0;
    const deducted = ((gross * percent) / 100).toFixed(2);
    setFormData({ ...formData, Gross_Freight: freight, TDS_Rate: rate, TDS_Deducted: deducted });
  };

  // 💾 Save TDS Record
  const handleSave = async () => {
    if (!formData.Consignee_Name || !formData.Gross_Freight) {
      return alert("⚠️ Please fill Consignee Name and Gross Freight!");
    }
    if (parseFloat(formData.Gross_Freight) <= 0) {
      return alert("⚠️ Gross Freight must be greater than zero!");
    }
    
    try {
      await addDoc(collection(db, "TDS_MANAGEMENT"), {
        ...formData,
        createdAt: serverTimestamp()
      });
      alert("✅ TDS Record Saved Successfully!");
      setFormData({ ...formData, Consignee_Name: '', Gross_Freight: '', TDS_Deducted: '0' });
      fetchTDSData();
    } catch (e) { alert("❌ Error saving TDS data!"); }
  };

  // ✅ Toggle Filing Status (26AS Match)
  const toggleFilingStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'PENDING' ? 'FILED' : 'PENDING';
    try {
      await updateDoc(doc(db, "TDS_MANAGEMENT", id), { Status: newStatus });
      fetchTDSData();
    } catch (error) { alert("Error updating status"); }
  };

  // 🗑️ Delete TDS Record
  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to delete the TDS record for ${name}?`)) {
      try {
        await deleteDoc(doc(db, "TDS_MANAGEMENT", id));
        fetchTDSData();
      } catch (error) { alert("Error deleting record"); }
    }
  };

  // 📥 Export for CA (Form 26AS Matching)
  const handleExportCSV = () => {
    if (tdsRecords.length === 0) return alert("⚠️ No data to export!");
    const headers = ["Date", "Consignee_Name", "Gross_Freight", "TDS_Rate(%)", "TDS_Deducted", "Filing_Status"];
    let csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n";

    tdsRecords.forEach(r => {
      // Escape commas in Consignee Name just in case
      const safeName = r.Consignee_Name.replace(/,/g, " ");
      const row = [r.Date, safeName, r.Gross_Freight, r.TDS_Rate, r.TDS_Deducted, r.Status].join(",");
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
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; }
        .glow-btn:hover { background: #2563eb; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; outline: none; }
        .modern-input:focus { border-color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900' }}>TDS Management (Sec 194C)</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Track TDS Deductions & 26AS Filing Status</p>
        </div>
        <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }} onClick={handleExportCSV}>
          📥 Download for CA (CSV)
        </button>
      </div>

      {/* 📝 Input Form Section */}
      <div className="glass-card" style={{ padding: '20px', marginBottom: '30px', borderTop: '4px solid #10b981' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '15px' }}>
          <h3 style={{ color: '#10b981', margin: 0 }}>✂️ Add TDS Deduction</h3>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'linear-gradient(135deg,#c084fc,#8b5cf6)', color: '#fff', padding: '8px 14px', borderRadius: '8px', fontWeight: 'bold', cursor: scanningBill ? 'not-allowed' : 'pointer', fontSize: '12px' }}>
            {scanningBill ? '⏳ Reading…' : '📄 Scan Bill (PDF) — auto-fill'}
            <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleScanBill} disabled={scanningBill} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px', alignItems: 'end' }}>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Date</label>
          <input type="date" className="modern-input" value={formData.Date} onChange={e=>setFormData({...formData, Date: e.target.value})} style={{colorScheme: 'dark'}} /></div>
          
          <div style={{gridColumn: 'span 2'}}><label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Consignee Name (Party) *</label>
          <input className="modern-input" placeholder="e.g. Reliance Industries" value={formData.Consignee_Name} onChange={e=>setFormData({...formData, Consignee_Name: e.target.value})} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#38bdf8', fontWeight:'bold' }}>Gross Freight (₹) *</label>
          <input type="number" className="modern-input" style={{ border: '1px solid #38bdf8' }} value={formData.Gross_Freight} onChange={e=>handleAmountChange(e.target.value, formData.TDS_Rate)} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>TDS Rate (%)</label>
          <select className="modern-input" value={formData.TDS_Rate} onChange={e=>handleAmountChange(formData.Gross_Freight, e.target.value)}>
            <option value="1">1% (Individual/HUF)</option>
            <option value="2">2% (Company/Firm)</option>
            <option value="5">5%</option>
            <option value="10">10%</option>
          </select></div>
          
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '10px', borderRadius: '8px', border: '1px dashed #ef4444' }}>
            <label style={{ fontSize: '11px', color: '#ef4444', fontWeight:'bold' }}>TDS Deducted (₹)</label>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444', marginTop: '3px' }}>₹{formData.TDS_Deducted}</div>
          </div>

          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', justifyContent: 'center' }} onClick={handleSave}>✅ Save Record</button>
        </div>
      </div>

      {/* 📊 Data Table Section */}
      <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
        <h3 style={{ color: '#fff', marginTop: 0 }}>📋 TDS Deduction Registry</h3>
        {loading ? <p style={{ color: '#38bdf8' }}>Loading Data...</p> : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Consignee Name</th>
                <th>Gross Freight</th>
                <th>TDS Rate</th>
                <th style={{ color: '#ef4444' }}>TDS Deducted</th>
                <th>Return Filing Status</th>
                <th style={{ textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {tdsRecords.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No TDS records found.</td></tr>
              ) : (
                tdsRecords.map((r, i) => (
                  <tr key={i}>
                    <td>{r.Date}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{r.Consignee_Name}</td>
                    <td>₹{r.Gross_Freight}</td>
                    <td><span style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 'bold' }}>{r.TDS_Rate}%</span></td>
                    <td style={{ color: '#ef4444', fontWeight: 'bold' }}>₹{r.TDS_Deducted}</td>
                    
                    {/* Toggle Status Button */}
                    <td>
                      <button 
                        onClick={() => toggleFilingStatus(r.id, r.Status)}
                        style={{ 
                          background: r.Status === 'FILED' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', 
                          color: r.Status === 'FILED' ? '#10b981' : '#ef4444', 
                          border: `1px solid ${r.Status === 'FILED' ? '#10b981' : '#ef4444'}`, 
                          padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', transition: '0.3s'
                        }}
                      >
                        {r.Status === 'FILED' ? '✅ FILED (26AS OK)' : '⏳ PENDING'}
                      </button>
                    </td>

                    {/* Delete Button */}
                    <td style={{ textAlign: 'center' }}>
                      <span 
                        onClick={() => handleDelete(r.id, r.Consignee_Name)} 
                        style={{ cursor: 'pointer', color: '#64748b', fontSize: '16px', transition: '0.2s' }}
                        onMouseOver={(e) => e.currentTarget.style.color = '#ef4444'}
                        onMouseOut={(e) => e.currentTarget.style.color = '#64748b'}
                        title="Delete Record"
                      >
                        🗑️
                      </span>
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