// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { extractJsonFromImage } from './lib/aiScanner';

export default function GstMgmt() {
  const [gstRecords, setGstRecords] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]); // 🏢 For Auto-Dropdown
  const [loading, setLoading] = useState(false);
  const [scanningBill, setScanningBill] = useState(false);

  // 📄 Scan a customer sales bill (PDF/photo) → auto-fill GST entry (100% local).
  const handleScanBill = async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    setScanningBill(true);
    try {
      const prompt = `This is a transport company's customer sales/freight bill (IOCL/HPCL/BPCL). Extract ONLY JSON:
{ "party_name": "", "invoice_no": "", "total_gross_amount": 0, "cgst": 0, "sgst": 0, "igst": 0 }
total_gross_amount = the grand total taxable/gross freight (sum of all gross amounts). Numbers only, no commas.`;
      const ai = await extractJsonFromImage(file, prompt);
      const num = (v: any) => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;
      const gross = num(ai.total_gross_amount);
      if (gross <= 0) { alert('⚠️ Bill ka total nahi mila — saaf PDF se try karein.'); setScanningBill(false); return; }
      setFormData(prev => ({ ...prev, Customer_Name: ai.party_name || prev.Customer_Name, Invoice_No: ai.invoice_no || prev.Invoice_No }));
      // tax computed in code (LLM arithmetic unreliable) via the existing handler
      handleAmountChange(String(gross), formData.GST_Rate);
      alert(`✅ Bill scan (local Gemma): ${ai.party_name || ''} · Taxable ₹${gross.toLocaleString('en-IN')} — GST auto-calculated. Verify karke Save.`);
    } catch (err: any) {
      const offline = err?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(err?.message || '');
      alert(offline ? '❌ Local AI (Ollama) band hai.' : '❌ Bill padhi nahi gayi.');
    }
    setScanningBill(false);
  };

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
    fetchCustomers();
  }, []);

  const fetchGSTData = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "GST_MANAGEMENT"));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort by latest entry date or creation time
      setGstRecords(data.sort((a, b) => new Date(b.Entry_Date || b.createdAt).getTime() - new Date(a.Entry_Date || a.createdAt).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchCustomers = async () => {
    try {
      const snap = await getDocs(collection(db, "CUSTOMERS"));
      setCustomers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error("Error fetching customers", e); }
  };

  // 🧮 Auto Calculate GST (Safe against NaN)
  const handleAmountChange = (amt: string, rate: string) => {
    const taxable = parseFloat(amt) || 0;
    const gstPercent = parseFloat(rate) || 0;
    const totalGst = ((taxable * gstPercent) / 100).toFixed(2);
    setFormData({ ...formData, Taxable_Amt: amt, GST_Rate: rate, Total_GST: totalGst });
  };

  // 💾 Save GST Record
  const handleSave = async () => {
    if (!formData.Customer_Name || !formData.Invoice_No || !formData.Taxable_Amt) {
      return alert("⚠️ Please fill Customer Name, Invoice No, and Taxable Amount!");
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
    } catch (e) { alert("❌ Error saving GST data!"); }
  };

  // ✅ Toggle "Submitted" Status
  const toggleSubmitStatus = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "GST_MANAGEMENT", id), { is_submitted: !currentStatus });
      fetchGSTData();
    } catch (error) { alert("Error updating status"); }
  };

  // 🗑️ Delete GST Record
  const handleDelete = async (id: string, invoice: string) => {
    if (window.confirm(`Are you sure you want to delete the GST record for Invoice: ${invoice}?`)) {
      try {
        await deleteDoc(doc(db, "GST_MANAGEMENT", id));
        fetchGSTData();
      } catch (error) { alert("Error deleting record"); }
    }
  };

  // 📥 Export for CA / Accountant
  const handleExportCSV = () => {
    if (gstRecords.length === 0) return alert("⚠️ No data to export!");
    const headers = ["Entry_Date", "Customer_Name", "GST_Type", "Invoice_No", "Taxable_Amt", "GST_Rate(%)", "Total_GST", "Filing_Status"];
    let csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n";

    gstRecords.forEach(r => {
      const safeName = (r.Customer_Name || "").replace(/,/g, " "); // escape commas
      const row = [
        r.Entry_Date || "N/A", safeName, r.GST_Type, r.Invoice_No, r.Taxable_Amt, r.GST_Rate, r.Total_GST,
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
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; }
        .glow-btn:hover { background: #059669; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; outline: none; }
        .modern-input:focus { border-color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900' }}>GST & Tax Management</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Invoice Registry & Return Submission Status</p>
        </div>
        <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }} onClick={handleExportCSV}>
          📥 Download CA Report (CSV)
        </button>
      </div>

      {/* Input Form Section */}
      <div className="glass-card" style={{ padding: '20px', marginBottom: '30px', borderTop: '4px solid #38bdf8' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '15px' }}>
          <h3 style={{ color: '#38bdf8', margin: 0 }}>➕ New GST Entry</h3>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'linear-gradient(135deg,#c084fc,#8b5cf6)', color: '#fff', padding: '8px 14px', borderRadius: '8px', fontWeight: 'bold', cursor: scanningBill ? 'not-allowed' : 'pointer', fontSize: '12px' }}>
            {scanningBill ? '⏳ Reading…' : '📄 Scan Bill (PDF) — auto-fill'}
            <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleScanBill} disabled={scanningBill} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px', alignItems: 'end' }}>
          
          <div style={{ gridColumn: 'span 2' }}>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Customer Name *</label>
            <select className="modern-input" value={formData.Customer_Name} onChange={e=>setFormData({...formData, Customer_Name: e.target.value})}>
              <option value="">-- Select Customer --</option>
              {customers.map((c: any) => <option key={c.id} value={c.customer_name}>{c.customer_name}</option>)}
              {formData.Customer_Name && !customers.find((c: any)=>c.customer_name === formData.Customer_Name) && <option value={formData.Customer_Name}>{formData.Customer_Name}</option>}
            </select>
          </div>
          
          <div>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>GST Type</label>
            <select className="modern-input" value={formData.GST_Type} onChange={e=>setFormData({...formData, GST_Type: e.target.value})}>
              <option value="CGST+SGST">CGST + SGST (Local)</option>
              <option value="IGST">IGST (Interstate)</option>
              <option value="EXEMPT">Exempt / RCM</option>
            </select>
          </div>
          
          <div><label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Invoice No *</label>
          <input className="modern-input" placeholder="INV-2026-01" value={formData.Invoice_No} onChange={e=>setFormData({...formData, Invoice_No: e.target.value})} /></div>
          
          <div><label style={{ fontSize: '11px', color: '#f59e0b', fontWeight:'bold' }}>Taxable Amt (₹) *</label>
          <input type="number" className="modern-input" style={{ border: '1px solid #f59e0b' }} value={formData.Taxable_Amt} onChange={e=>handleAmountChange(e.target.value, formData.GST_Rate)} /></div>
          
          <div>
            <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>GST Rate (%)</label>
            <select className="modern-input" value={formData.GST_Rate} onChange={e=>handleAmountChange(formData.Taxable_Amt, e.target.value)}>
              <option value="0">0%</option>
              <option value="5">5%</option>
              <option value="12">12%</option>
              <option value="18">18%</option>
            </select>
          </div>
          
          <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '10px', borderRadius: '8px', border: '1px dashed #38bdf8' }}>
            <label style={{ fontSize: '11px', color: '#38bdf8', fontWeight:'bold' }}>Total GST (₹)</label>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#38bdf8', marginTop: '3px' }}>₹{formData.Total_GST}</div>
          </div>

          <button className="glow-btn" onClick={handleSave}>✅ Save Entry</button>
        </div>
      </div>

      {/* Data Table Section */}
      <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
        <h3 style={{ color: '#fff', marginTop: 0 }}>📊 GST Invoice Registry</h3>
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
                <th style={{ color: '#38bdf8' }}>Total GST</th>
                <th>GSTR Filing Status</th>
                <th style={{ textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {gstRecords.length === 0 ? (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: '30px' }}>No GST records found.</td></tr>
              ) : (
                gstRecords.map((r, i) => (
                  <tr key={i}>
                    <td>{r.Entry_Date || 'N/A'}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{r.Customer_Name}</td>
                    <td style={{ color: '#f59e0b' }}>{r.Invoice_No}</td>
                    <td>{r.GST_Type}</td>
                    <td>₹{r.Taxable_Amt}</td>
                    <td><span style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 'bold' }}>{r.GST_Rate}%</span></td>
                    <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>₹{r.Total_GST}</td>
                    
                    {/* Toggle Status Button */}
                    <td>
                      <button 
                        onClick={() => toggleSubmitStatus(r.id, r.is_submitted)}
                        style={{ 
                          background: r.is_submitted ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', 
                          color: r.is_submitted ? '#10b981' : '#f59e0b', 
                          border: `1px solid ${r.is_submitted ? '#10b981' : '#f59e0b'}`, 
                          padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', transition: '0.3s'
                        }}
                      >
                        {r.is_submitted ? '✅ SUBMITTED (GSTR-1)' : '⏳ PENDING'}
                      </button>
                    </td>

                    {/* Delete Button */}
                    <td style={{ textAlign: 'center' }}>
                      <span 
                        onClick={() => handleDelete(r.id, r.Invoice_No)} 
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