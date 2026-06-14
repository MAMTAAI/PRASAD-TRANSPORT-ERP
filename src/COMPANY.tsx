import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db } from './firebase';

export default function CompanyMgmt() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  
  // फॉर्म के अंदर टैब्स (Basic, Tax/Bank, Documents)
  const [formTab, setFormTab] = useState('basic'); 
  const [uploading, setUploading] = useState(false);

  // 📝 स्मार्ट ERP के लिए फुल डेटाबेस फील्ड्स
  const [formData, setFormData] = useState({
    company_name: '', tagline: '', email: '', phone: '',
    address: '', city: '', state: '', pincode: '',
    gstin: '', pan_no: '', tds_tan: '', 
    bank_name: '', account_no: '', ifsc_code: '',
    logo_url: '', gst_pdf_url: '', pan_pdf_url: ''
  });

  const storage = getStorage();

  useEffect(() => { fetchCompanies(); }, []);

  const fetchCompanies = async () => {
    setLoading(true);
    try {
      const querySnapshot = await getDocs(collection(db, "COMPANIES"));
      setCompanies(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 📁 फाइल/PDF अपलोड करने का स्मार्ट फंक्शन
  const handleFileUpload = async (e: any, fieldName: string) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `company_docs/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      setFormData(prev => ({ ...prev, [fieldName]: url }));
      alert(`✅ File Uploaded Successfully!`);
    } catch (error) {
      alert("Error uploading file. Please check Firebase Storage rules.");
      console.error(error);
    }
    setUploading(false);
  };

  const handleSave = async () => {
    if (!formData.company_name || !formData.gstin) return alert("Company Name & GSTIN are required!");
    // 🚫 Duplicate guard — one company record (name or GSTIN unique).
    const nrm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const dup = companies.find(c => c.id !== editingId && (nrm(c.company_name) === nrm(formData.company_name) || nrm(c.gstin) === nrm(formData.gstin)));
    if (dup) return alert(`⚠️ Yeh company pehle se hai: "${dup.company_name}" (same name/GSTIN). Duplicate save nahi hoga.`);
    try {
      if (editingId) {
        await updateDoc(doc(db, "COMPANIES", editingId), formData);
      } else {
        await addDoc(collection(db, "COMPANIES"), { ...formData, createdAt: serverTimestamp() });
      }
      resetForm(); fetchCompanies();
    } catch (err) { alert("Error saving data!"); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to delete ${name}?`)) {
      await deleteDoc(doc(db, "COMPANIES", id));
      fetchCompanies();
    }
  };

  const resetForm = () => {
    setFormData({ company_name: '', tagline: '', email: '', phone: '', address: '', city: '', state: '', pincode: '', gstin: '', pan_no: '', tds_tan: '', bank_name: '', account_no: '', ifsc_code: '', logo_url: '', gst_pdf_url: '', pan_pdf_url: '' });
    setShowForm(false); setEditingId(null); setFormTab('basic');
  };

  const filteredCompanies = companies.filter(c => 
    c.company_name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    c.city?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white' }}>
      
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.4s; }
        .glass-card:hover { border-color: rgba(56, 189, 248, 0.5); box-shadow: 0 10px 30px -10px rgba(56, 189, 248, 0.3); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 0 20px rgba(99, 102, 241, 0.6); transform: scale(1.05); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px 15px; outline: none; width: 100%; box-sizing: border-box; font-size: 13px; margin-top: 5px; }
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 10px rgba(56, 189, 248, 0.3); }
        .tab-btn { background: transparent; border: none; color: #94a3b8; padding: 10px 20px; cursor: pointer; font-weight: bold; border-bottom: 2px solid transparent; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 2px solid #38bdf8; }
        .file-upload-box { border: 2px dashed #475569; padding: 20px; text-align: center; border-radius: 10px; background: rgba(0,0,0,0.2); cursor: pointer; transition: 0.3s; }
        .file-upload-box:hover { border-color: #38bdf8; background: rgba(56, 189, 248, 0.05); }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900' }}>HQ & Master Setup</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Configure Companies for Automated Billing & Accounting</p>
        </div>
        <button className="glow-btn" onClick={() => setShowForm(true)}>+ Add Main Company</button>
      </div>

      {/* 🏢 Futuristic Grid View */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '25px' }}>
        {filteredCompanies.map((c) => (
          <div key={c.id} className="glass-card" style={{ padding: '25px' }}>
            <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginBottom: '20px' }}>
              {c.logo_url ? <img src={c.logo_url} alt="logo" style={{ width: '60px', height: '60px', borderRadius: '10px', objectFit: 'contain', background: 'white' }} /> : <div style={{ width: '60px', height: '60px', borderRadius: '10px', background: '#334155', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>🏢</div>}
              <div>
                <h2 style={{ margin: 0, fontSize: '20px', color: '#f8fafc' }}>{c.company_name}</h2>
                <span style={{ fontSize: '12px', color: '#38bdf8' }}>{c.city}, {c.state}</span>
              </div>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
              <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', borderLeft: '3px solid #818cf8' }}>
                <div style={{ fontSize: '10px', color: '#94a3b8' }}>GSTIN</div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#c084fc' }}>{c.gstin || 'N/A'}</div>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', borderLeft: '3px solid #10b981' }}>
                <div style={{ fontSize: '10px', color: '#94a3b8' }}>BANK A/C</div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#10b981' }}>{c.account_no ? `...${c.account_no.slice(-4)}` : 'N/A'}</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '15px' }}>
              <button onClick={() => { setFormData(c); setEditingId(c.id); setShowForm(true); }} style={{ flex: 1, background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '8px', borderRadius: '5px', cursor: 'pointer' }}>Edit Setup</button>
              <button onClick={() => handleDelete(c.id, c.company_name)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '8px 15px', borderRadius: '5px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* 🛸 Multi-Tab Form Modal */}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(2, 6, 23, 0.85)', backdropFilter: 'blur(10px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '800px', maxHeight: '90vh', overflowY: 'auto' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 className="gradient-text" style={{ margin: 0 }}>{editingId ? 'Edit Master Details' : 'New Company Setup'}</h2>
              <button onClick={resetForm} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>

            {/* 🟢 TABS */}
            <div style={{ display: 'flex', borderBottom: '1px solid #334155', marginBottom: '20px' }}>
              <button className={`tab-btn ${formTab === 'basic' ? 'active' : ''}`} onClick={() => setFormTab('basic')}>🏢 Basic Info</button>
              <button className={`tab-btn ${formTab === 'tax' ? 'active' : ''}`} onClick={() => setFormTab('tax')}>💰 Tax & Bank</button>
              <button className={`tab-btn ${formTab === 'docs' ? 'active' : ''}`} onClick={() => setFormTab('docs')}>📁 Logos & PDFs</button>
            </div>

            {/* 🟢 TAB 1: BASIC INFO */}
            {formTab === 'basic' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Registered Company Name *</label>
                  <input className="modern-input" value={formData.company_name} onChange={e => setFormData({...formData, company_name: e.target.value.toUpperCase()})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Email Address</label>
                  <input className="modern-input" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Phone Number</label>
                  <input className="modern-input" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Full Address (Appears on Invoice)</label>
                  <textarea className="modern-input" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} style={{ minHeight: '60px' }} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>City</label>
                  <input className="modern-input" value={formData.city} onChange={e => setFormData({...formData, city: e.target.value})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>State</label>
                  <input className="modern-input" value={formData.state} onChange={e => setFormData({...formData, state: e.target.value})} />
                </div>
              </div>
            )}

            {/* 🟢 TAB 2: TAX & BANK */}
            {formTab === 'tax' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div>
                  <label style={{ fontSize: '12px', color: '#c084fc', fontWeight: 'bold' }}>GSTIN Number *</label>
                  <input className="modern-input" value={formData.gstin} onChange={e => setFormData({...formData, gstin: e.target.value.toUpperCase()})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#38bdf8' }}>PAN Number</label>
                  <input className="modern-input" value={formData.pan_no} onChange={e => setFormData({...formData, pan_no: e.target.value.toUpperCase()})} />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: '12px', color: '#f59e0b' }}>TAN / TDS Registration No.</label>
                  <input className="modern-input" value={formData.tds_tan} onChange={e => setFormData({...formData, tds_tan: e.target.value.toUpperCase()})} />
                </div>
                <div style={{ gridColumn: 'span 2', marginTop: '10px', borderTop: '1px solid #334155', paddingTop: '10px' }}>
                  <h4 style={{ margin: '0 0 10px 0', color: '#10b981' }}>Bank Details (Printed on Bills)</h4>
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Bank Name</label>
                  <input className="modern-input" value={formData.bank_name} onChange={e => setFormData({...formData, bank_name: e.target.value})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Account Number</label>
                  <input className="modern-input" value={formData.account_no} onChange={e => setFormData({...formData, account_no: e.target.value})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>IFSC Code</label>
                  <input className="modern-input" value={formData.ifsc_code} onChange={e => setFormData({...formData, ifsc_code: e.target.value.toUpperCase()})} />
                </div>
              </div>
            )}

            {/* 🟢 TAB 3: DOCUMENTS (LOGOS & PDFs) */}
            {formTab === 'docs' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div className="file-upload-box">
                  <h4 style={{ margin: '0 0 10px 0', color: '#38bdf8' }}>🖼️ Upload Company Logo (For Invoices)</h4>
                  <input type="file" accept="image/*" onChange={(e) => handleFileUpload(e, 'logo_url')} style={{ color: 'white' }} />
                  {uploading && <p style={{ color: '#f59e0b', fontSize: '12px' }}>Uploading...</p>}
                  {formData.logo_url && <p style={{ color: '#10b981', fontSize: '12px' }}>✅ Logo Saved</p>}
                </div>
                
                <div className="file-upload-box">
                  <h4 style={{ margin: '0 0 10px 0', color: '#c084fc' }}>📄 Upload GST Certificate (PDF/Image)</h4>
                  <input type="file" accept=".pdf,image/*" onChange={(e) => handleFileUpload(e, 'gst_pdf_url')} style={{ color: 'white' }} />
                  {formData.gst_pdf_url && <p style={{ color: '#10b981', fontSize: '12px' }}>✅ GST Doc Saved</p>}
                </div>

                <div className="file-upload-box">
                  <h4 style={{ margin: '0 0 10px 0', color: '#f59e0b' }}>📄 Upload PAN Card (PDF/Image)</h4>
                  <input type="file" accept=".pdf,image/*" onChange={(e) => handleFileUpload(e, 'pan_pdf_url')} style={{ color: 'white' }} />
                  {formData.pan_pdf_url && <p style={{ color: '#10b981', fontSize: '12px' }}>✅ PAN Doc Saved</p>}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '30px', borderTop: '1px solid #334155', paddingTop: '20px' }}>
              <button className="glow-btn" onClick={handleSave} style={{ padding: '12px 30px' }}>✅ Save Setup to Server</button>
            </div>
            
          </div>
        </div>
      )}
    </div>
  );
}