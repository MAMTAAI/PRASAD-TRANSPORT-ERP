import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function GstMgmt() {
  const [gstRecords, setGstRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    Customer_Name: '',
    GST_Type: 'CGST+SGST', // Default
    Invoice_No: '',
    Taxable_Amt: '',
    GST_Rate: '5', // Transport mostly uses 5% or 12%
    Total_GST: '0',
    is_submitted: false // Pending by default
  });

  useEffect(() => {
    fetchGSTData();
  }, []);

  const fetchGSTData = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "GST_MANAGEMENT"));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort by latest first
      setGstRecords(data.sort((a, b) => b.createdAt?.seconds - a.createdAt?.seconds));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 🧮 Auto Calculate GST
  const handleAmountChange = (amt: string, rate: string) => {
    const taxable = parseFloat(amt || '0');
    const gstPercent = parseFloat(rate || '0');
    const totalGst = ((taxable * gstPercent) / 100).toFixed(2);
    setFormData({ ...formData, Taxable_Amt: amt, GST_Rate: rate, Total_GST: totalGst });
  };

  // 💾 Save GST Record
  const handleSave = async () => {
    if (!formData.Customer_Name || !formData.Invoice_No || !formData.Taxable_Amt) {
      return alert("Please fill Customer Name, Invoice No, and Taxable Amount!");
    }
    try {
      await addDoc(collection(db, "GST_MANAGEMENT"), {
        ...formData,
        Entry_Date: new Date().toISOString().split('T')[0],
        createdAt: serverTimestamp()
      });
      alert("✅ GST Record Saved Successfully!");
      setFormData({ Customer_Name: '', GST_Type: 'CGST+SGST', Invoice_No: '', Taxable_Amt: '', GST_Rate: '5', Total_GST: '0', is_submitted: false });
      fetchGSTData();
    } catch (e) { alert("Error saving GST data!"); }
  };

  // ✅ Toggle "Submitted" Status
  const toggleSubmitStatus = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "GST_MANAGEMENT", id), { is_submitted: !currentStatus });
      fetchGSTData();
    } catch (error) { alert("Error updating status"); }
  };

  // 📥 Export for CA / Accountant
  const handleExportCSV = () => {
    if (gstRecords.length === 0) return alert("No data to export!");
    const headers = ["Entry_Date", "Customer_Name", "GST_Type", "Invoice_No", "Taxable_Amt", "GST_Rate(%)", "Total_GST", "Filing_Status"];
    let csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n";

    gstRecords.forEach(r => {
      const row = [
        r.Entry_Date || "N/A", r.Customer_Name, r.GST_Type, r.Invoice_No, r.Taxable_Amt, r.GST_Rate, r.Total_GST,
        r.is_submitted ? "SUBMITTED" : "PENDING"
      ].join(",");
      csvContent += row + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `GST_Report_${new Date().toISOString().split('T')[0]}.csv`);
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

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>GST & Tax Management</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Invoice Registry & Return Submission Status</p>
        </div>
        <button className="glow-btn" style={{ background: '#10b981' }} onClick={handleExportCSV}>
          📥 Download CA Report (CSV)
        </button>
      </div>

      {/* Input Form Section */}
      <div className="glass-card" style={{ padding: '20px', marginBottom: '30px' }}>
        <h3 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '15px' }}>➕ New GST Entry</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px', alignItems: 'end' }}>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>Customer Name *</label>
          <input className="modern-input" placeholder="e.g. IOCL" value={formData.Customer_Name} onChange={e=>setFormData({...formData, Customer_Name: e.target.value})} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>GST Type</label>
          <select className="modern-input" value={formData.GST_Type} onChange={e=>setFormData({...formData, GST_Type: e.target.value})}>
            <option value="CGST+SGST">CGST + SGST (Local)</option>
            <option value="IGST">IGST (Interstate)</option>
            <option value="EXEMPT">Exempt / RCM</option>
          </select></div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>Invoice No *</label>
          <input className="modern-input" placeholder="INV-2026-01" value={formData.Invoice_No} onChange={e=>setFormData({...formData, Invoice_No: e.target.value})} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#f59e0b', fontWeight:'bold' }}>Taxable Amt (₹) *</label>
          <input type="number" className="modern-input" value={formData.Taxable_Amt} onChange={e=>handleAmountChange(e.target.value, formData.GST_Rate)} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8' }}>GST Rate (%)</label>
          <select className="modern-input" value={formData.GST_Rate} onChange={e=>handleAmountChange(formData.Taxable_Amt, e.target.value)}>
            <option value="0">0%</option>
            <option value="5">5%</option>
            <option value="12">12%</option>
            <option value="18">18%</option>
          </select></div>
          
          <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
            <label style={{ fontSize: '11px', color: '#38bdf8', fontWeight:'bold' }}>Total GST (₹)</label>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#38bdf8', marginTop: '3px' }}>₹{formData.Total_GST}</div>
          </div>

          <button className="glow-btn" onClick={handleSave}>✅ Save Entry</button>
        </div>
      </div>

      {/* Data Table Section */}
      <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
        <h3 style={{ color: '#38bdf8', marginTop: 0 }}>📊 GST Invoice Registry</h3>
        {loading ? <p style={{ color: '#38bdf8' }}>Loading Data...</p> : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Invoice No</th>
                <th>GST Type</th>
                <th>Taxable Amt</th>
                <th>Rate</th>
                <th>Total GST</th>
                <th>GSTR Filing Status</th>
              </tr>
            </thead>
            <tbody>
              {gstRecords.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: '30px' }}>No GST records found.</td></tr>
              ) : (
                gstRecords.map((r, i) => (
                  <tr key={i}>
                    <td>{r.Entry_Date || 'N/A'}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{r.Customer_Name}</td>
                    <td style={{ color: '#f59e0b' }}>{r.Invoice_No}</td>
                    <td>{r.GST_Type}</td>
                    <td>₹{r.Taxable_Amt}</td>
                    <td>{r.GST_Rate}%</td>
                    <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>₹{r.Total_GST}</td>
                    
                    {/* Toggle Status Button */}
                    <td>
                      <button 
                        onClick={() => toggleSubmitStatus(r.id, r.is_submitted)}
                        style={{ 
                          background: r.is_submitted ? '#10b981' : '#f59e0b', 
                          color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold'
                        }}
                      >
                        {r.is_submitted ? '✅ SUBMITTED' : '⏳ PENDING'}
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