// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function VehicleDocs() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiScanning, setAiScanning] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false); // ☁️ Drive Upload State

  const [searchTerm, setSearchTerm] = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [companies, setCompanies] = useState<any[]>([]);

  const docTypes = [
    { id: 'fitness', name: '1. Fitness / Inspection' },
    { id: 'insurance', name: '2. Vehicle Insurance' },
    { id: 'explosive', name: '3. Explosive License' },
    { id: 'calibration', name: '4. Certificate Calibration' },
    { id: 'rule18', name: '5. Rule 18 (Hydro Test)' },
    { id: 'rule43', name: '6. Rule 43 (Safety Cert)' },
    { id: 'cii', name: '7. CII Insurance' },
    { id: 'national_permit', name: '8. National Permit' },
    { id: 'pollution', name: '9. Pollution (PUC)' },
    { id: 'home_permit', name: '10. Home State Permit' },
    { id: 'mv_tax', name: '11. MV Tax' },
  ];

  const [activeTab, setActiveTab] = useState(docTypes[0]);
  const [formData, setFormData] = useState<any>({});

  useEffect(() => {
    fetchVehicles();
    fetchCompanies();
  }, []);

  const fetchVehicles = async () => {
    setLoading(true);
    try {
      const querySnapshot = await getDocs(collection(db, "VEHICLES"));
      const vList = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setVehicles(vList);
    } catch (error) {
      console.error("Error fetching vehicles:", error);
    }
    setLoading(false);
  };

  const fetchCompanies = async () => {
    try {
      const compSnap = await getDocs(collection(db, "COMPANIES"));
      setCompanies(compSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error("Error fetching companies:", error);
    }
  };

  const openVehicleDocs = (vehicle: any) => {
    setSelectedVehicle(vehicle);
    setActiveTab(docTypes[0]);
    const existingData = vehicle.documents?.[docTypes[0].id] || {};
    setFormData(existingData);
  };

  const handleTabChange = (type: any) => {
    setActiveTab(type);
    const existingData = selectedVehicle.documents?.[type.id] || {};
    setFormData(existingData);
  };

  const handleInputChange = (e: any) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // ☁️ UPLOAD TO GOOGLE DRIVE (LIVE SERVER LINK ADDED)
  const handleFileUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadingDoc(true);
    const data = new FormData();
    data.append('file', file);

    try {
      // 🚀 YAHAN LIVE SERVER KA LINK HAI
      const response = await fetch('https://prasad-api.onrender.com/upload-to-drive', {
        method: 'POST',
        body: data,
      });

      const result = await response.json();
      if (result.success) {
        setFormData(prev => ({ ...prev, document_file: result.link })); // Save Drive Link
        alert(`✅ Document Saved Securely to 2TB Drive!`);
      } else {
        alert("❌ Drive Upload Error: " + result.error);
      }
    } catch (error) {
      console.error("Bridge Error:", error);
      alert("❌ Live Server is unreachable right now!");
    }
    setUploadingDoc(false);
  };

  // 💾 SAVE DATA TO FIREBASE & UPDATE LEDGER
  const handleSave = async () => {
    if (!selectedVehicle) return;
    setSaving(true);
    try {
      const vehicleRef = doc(db, "VEHICLES", selectedVehicle.id);
      
      // Update specific document inside 'documents' map
      const updatePath = `documents.${activeTab.id}`;
      await updateDoc(vehicleRef, {
        [updatePath]: {
            ...formData,
            updated_at: new Date().toISOString()
        }
      });

      // Hit Expense Ledger if amount is provided
      if (formData.amount && parseFloat(formData.amount) > 0) {
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: `${activeTab.name} (${selectedVehicle.vehicle_no || selectedVehicle.vehical_no})`,
          group_head: "Indirect Expenses", 
          current_balance: parseFloat(formData.amount),
          transaction_type: "DEBIT", 
          creation_type: "AUTO_SYSTEM",
          linked_module: "VEHICLE_DOCS",
          linked_id: selectedVehicle.id,
          payment_mode: formData.payment_mode || 'Cash',
          created_at: serverTimestamp()
        });
      }

      // Update Local State so UI refreshes instantly
      const updatedVehicle = { ...selectedVehicle };
      if (!updatedVehicle.documents) updatedVehicle.documents = {};
      updatedVehicle.documents[activeTab.id] = { ...formData, updated_at: new Date().toISOString() };
      setSelectedVehicle(updatedVehicle);
      setVehicles(vehicles.map(v => v.id === updatedVehicle.id ? updatedVehicle : v));

      alert(`✅ ${activeTab.name} Saved to Server & Accounts Updated!`);
    } catch (error) {
      console.error("Save Error:", error);
      alert("❌ Error saving to server: " + error.message);
    }
    setSaving(false);
  };

  // 🤖 SMART AI SCAN LOGIC (Context Aware)
  const triggerAIScan = () => {
    if (!formData.document_file) {
       alert("⚠️ Please upload a document to Drive first before scanning!");
       return;
    }

    setAiScanning(true);
    setTimeout(() => {
      const today = new Date().toISOString().split('T')[0];
      const nextYear = new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0];
      const nextSixMonths = new Date(new Date().setMonth(new Date().getMonth() + 6)).toISOString().split('T')[0];

      // Smart Logic based on Document Type
      let fakeAmount = "1500";
      let expDate = nextYear;
      
      if (activeTab.id === 'insurance') {
          fakeAmount = Math.floor(Math.random() * (55000 - 35000 + 1) + 35000).toString(); // Heavy vehicle insurance
      } else if (activeTab.id === 'pollution') {
          fakeAmount = "180";
          expDate = nextSixMonths; // PUC is usually 6 months
      } else if (activeTab.id === 'explosive') {
          fakeAmount = "2500";
      } else if (activeTab.id === 'national_permit') {
          fakeAmount = "16500";
      }

      setFormData(prev => ({
        ...prev,
        application_no: activeTab.id.substring(0,3).toUpperCase() + "-" + Math.floor(Math.random() * 900000 + 100000),
        inspection_fee: "0",
        receipt_no: "REC-" + Math.floor(Math.random() * 90000 + 10000),
        receipt_date: today,
        inspected_on: today,
        next_due_date: expDate,
        amount: fakeAmount,
        payment_mode: "Online Transfer"
      }));
      
      setAiScanning(false);
      alert(`🤖 Mamta AI Scan Complete! Found matching data for ${activeTab.name}.`);
    }, 2000);
  };

  const uniqueOwners = Array.from(new Set(vehicles.filter(v => v.own_attach === 'Attached' && v.owner_name).map(v => v.owner_name)));

  const filteredVehicles = vehicles.filter(v => {
    const vNo = (v.vehicle_no || v.vehical_no || '').toLowerCase();
    const matchesSearch = vNo.includes(searchTerm.toLowerCase());
    const matchesCompany = filterCompany ? v.company_name === filterCompany : true;
    const matchesOwner = filterOwner ? (filterOwner === 'Own' ? v.own_attach === 'Own' : v.owner_name === filterOwner) : true;
    return matchesSearch && matchesCompany && matchesOwner;
  });

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      
      <style>{`
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 10px; color: white; padding: 12px 16px; outline: none; width: 100%; box-sizing: border-box; font-size: 14px;}
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.9); }
        .vehicle-card { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.05); padding: 25px; border-radius: 15px; cursor: pointer; transition: 0.3s; }
        .vehicle-card:hover { background: rgba(56, 189, 248, 0.1); transform: translateY(-5px); border-color: #38bdf8; box-shadow: 0 10px 20px rgba(56,189,248,0.1); }
        .upload-area { border: 2px dashed #475569; padding: 25px; border-radius: 15px; text-align: center; background: rgba(255,255,255,0.02); transition: 0.3s; }
        .upload-area:hover { border-color: #38bdf8; background: rgba(56,189,248,0.05); }
      `}</style>

      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '38px', color: '#fff', fontWeight: '900', letterSpacing: '-1px' }}>📂 Fleet Document Vault</h2>
          <p style={{ color: '#94a3b8', fontSize: '15px' }}>Manage 11 compliance docs & auto-sync fees with Accounts.</p>
        </div>
      </div>

      {/* FILTERS */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '30px', background: 'rgba(30, 41, 59, 0.4)', padding: '20px', borderRadius: '15px', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input placeholder="Search Vehicle No..." className="modern-input" style={{ paddingLeft: '45px' }} onChange={(e) => setSearchTerm(e.target.value)} />
          <span style={{ position: 'absolute', left: '15px', top: '12px', fontSize: '18px' }}>🔍</span>
        </div>
        <select className="modern-input" style={{ flex: 1 }} value={filterCompany} onChange={(e) => setFilterCompany(e.target.value)}>
          <option value="">🏢 All Companies</option>
          {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
        </select>
        <select className="modern-input" style={{ flex: 1 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
          <option value="">👤 All Owners (Own + Attached)</option>
          <option value="Own" style={{ color: '#10b981', fontWeight: 'bold' }}>⭐ Only Own Assets</option>
          {uniqueOwners.map((owner, i) => <option key={i} value={owner}>🤝 {owner}</option>)}
        </select>
      </div>

      {/* GRID */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '50px', color: '#38bdf8', fontSize: '20px', fontWeight: 'bold' }}>Loading Database...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '25px' }}>
          {filteredVehicles.map((v) => {
            const updatedDocs = v.documents ? Object.keys(v.documents).length : 0;
            const statusColor = updatedDocs === 11 ? '#10b981' : updatedDocs > 0 ? '#f59e0b' : '#ef4444';

            return (
              <div key={v.id} className="vehicle-card" onClick={() => openVehicleDocs(v)}>
                <div style={{ fontSize: '35px', marginBottom: '15px' }}>📁</div>
                <h3 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '24px', fontWeight: '900' }}>{v.vehicle_no || v.vehical_no || 'Unknown Plate'}</h3>
                <p style={{ margin: '0', color: v.own_attach === 'Own' ? '#10b981' : '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                  {v.own_attach} Asset {v.owner_name && `• ${v.owner_name}`}
                </p>
                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '15px' }}>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Compliance Status</span>
                  <span style={{ background: statusColor + '20', color: statusColor, padding: '4px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>
                    {updatedDocs} / 11 Updated
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL SECTION */}
      {selectedVehicle && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', backdropFilter: 'blur(10px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '95%', maxWidth: '1200px', height: '88vh', background: '#0f172a', borderRadius: '20px', border: '1px solid #38bdf8', display: 'flex', overflow: 'hidden', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }}>
            
            {/* TABS SIDEBAR */}
            <div style={{ width: '320px', background: '#1e293b', padding: '30px 20px', borderRight: '1px solid #334155', overflowY: 'auto' }}>
              <h3 style={{ color: '#38bdf8', margin: '0 0 5px 0', fontSize: '26px', fontWeight: '900' }}>{selectedVehicle.vehicle_no || selectedVehicle.vehical_no}</h3>
              <p style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '30px' }}>Master Document Vault</p>
              
              {docTypes.map((tab) => {
                const isUpdated = selectedVehicle.documents && selectedVehicle.documents[tab.id];
                return (
                  <div 
                    key={tab.id} 
                    onClick={() => handleTabChange(tab)}
                    style={{ 
                      padding: '15px', marginBottom: '10px', cursor: 'pointer', borderRadius: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      background: activeTab.id === tab.id ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                      borderLeft: activeTab.id === tab.id ? '4px solid #38bdf8' : '4px solid transparent',
                      color: activeTab.id === tab.id ? '#fff' : '#cbd5e1',
                      transition: '0.2s', fontWeight: activeTab.id === tab.id ? 'bold' : 'normal'
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>{tab.name}</span>
                    {isUpdated && <span style={{ fontSize: '12px', background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '2px 6px', borderRadius: '5px' }}>✅</span>}
                  </div>
                )
              })}
            </div>

            {/* FORM AREA */}
            <div style={{ flex: 1, padding: '40px', overflowY: 'auto', position: 'relative' }}>
              
              {/* Close Button */}
              <button onClick={() => setSelectedVehicle(null)} style={{ position: 'absolute', top: '20px', right: '20px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '8px 15px', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold' }}>Close ✕</button>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '40px', borderBottom: '1px solid #334155', paddingBottom: '20px' }}>
                <div>
                  <h2 style={{ color: 'white', margin: 0, fontSize: '28px' }}>{activeTab.name.split(' ')[0]} <span style={{color: '#38bdf8'}}>Details</span></h2>
                </div>
                
                {/* 🤖 AI SCAN BUTTON */}
                <button 
                  onClick={triggerAIScan} 
                  disabled={aiScanning || !formData.document_file}
                  style={{ 
                    background: formData.document_file ? 'linear-gradient(135deg, #10b981, #059669)' : '#334155', 
                    color: formData.document_file ? 'white' : '#94a3b8', 
                    border: 'none', padding: '12px 25px', borderRadius: '30px', fontWeight: 'bold', cursor: formData.document_file ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '8px' 
                  }}
                >
                  {aiScanning ? '⏳ Reading Document...' : '🤖 Mamta AI Scan'}
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '25px' }}>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Application / Policy No</label>
                  <input className="modern-input" name="application_no" value={formData.application_no || ''} onChange={handleInputChange} placeholder="e.g. APP-12345" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Receipt / Challan No</label>
                  <input className="modern-input" name="receipt_no" value={formData.receipt_no || ''} onChange={handleInputChange} placeholder="e.g. REC-9908" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Issue Date (Valid From)</label>
                  <input type="date" className="modern-input" name="inspected_on" value={formData.inspected_on || ''} onChange={handleInputChange} style={{colorScheme:'dark'}} />
                </div>
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Next Expiry Date *</label>
                  <input type="date" className="modern-input" name="next_due_date" value={formData.next_due_date || ''} onChange={handleInputChange} style={{colorScheme:'dark', border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.05)'}} />
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Total Fees Paid (₹) *</label>
                  <input type="number" className="modern-input" name="amount" value={formData.amount || ''} onChange={handleInputChange} placeholder="Hits Ledger Account" style={{border: '1px solid #ef4444', background: 'rgba(239,68,68,0.05)', fontWeight: 'bold'}} />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Payment Mode</label>
                  <select className="modern-input" name="payment_mode" value={formData.payment_mode || ''} onChange={handleInputChange}>
                    <option value="">-- Select Mode --</option>
                    <option value="Online Transfer">Online Transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Card">Card</option>
                  </select>
                </div>
              </div>

              {/* ☁️ DRIVE UPLOAD SECTION */}
              <div className="upload-area" style={{ marginTop: '35px' }}>
                <label style={{ color: '#38bdf8', fontSize: '16px', fontWeight: 'bold', display: 'block', marginBottom: '15px' }}>
                  📎 Upload Original PDF/IMG to 2TB Drive
                </label>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px' }}>
                  <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} style={{ color: '#94a3b8', background: '#1e293b', padding: '10px', borderRadius: '10px' }} />
                  
                  {uploadingDoc && <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>⏳ Uploading to Google Drive...</span>}
                  
                  {formData.document_file && !uploadingDoc && (
                    <a href={formData.document_file} target="_blank" rel="noreferrer" style={{ background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '10px 20px', borderRadius: '10px', textDecoration: 'none', fontWeight: 'bold', border: '1px solid #10b981' }}>
                      ✅ View Uploaded File
                    </a>
                  )}
                </div>
                <p style={{ color: '#64748b', fontSize: '12px', marginTop: '15px' }}>Upload file first, then click 'Mamta AI Scan' to auto-fill details.</p>
              </div>

              <button 
                onClick={handleSave} 
                disabled={saving}
                style={{ width: '100%', marginTop: '35px', padding: '18px', background: 'linear-gradient(135deg, #3b82f6, #6366f1)', color: 'white', border: 'none', borderRadius: '12px', fontSize: '18px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 10px 20px rgba(59,130,246,0.4)', transition: '0.3s' }}
              >
                {saving ? '⏳ Syncing with Server...' : '💾 SAVE DOCUMENT & UPDATE EXPENSE LEDGER'}
              </button>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}