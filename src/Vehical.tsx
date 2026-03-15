// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function Vehical() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  
  // 🔍 स्मार्ट फिल्टर्स के स्टेट्स
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  
  const [editingId, setEditingId] = useState<string | null>(null);

  // 🚀 RC Upload States
  const [rcFile, setRcFile] = useState<File | null>(null);
  const [uploadingRC, setUploadingRC] = useState(false);

  const [formData, setFormData] = useState({
    vehicle_no: '', company_name: '', branch_name: '', owner_name: '', own_attach: 'Own', 
    veh_class: '', capacity_kl: '', chassis_no: '', engine_no: '', 
    mfg_date: '', reg_date: '', modal_no: '', fuel: 'Diesel', 
    g_v_w: '', unladen_wt: '', hypothecated_to: '', 
    driver_name: '', driver_mobile: '', rc_photo_url: '', vehicle_value: '0', 
    status: 'Active', approval: 'Pending'
  });

  useEffect(() => { 
    fetchVehicles(); 
    fetchMasters(); 
  }, []);

  const fetchVehicles = async () => {
    setLoading(true);
    try {
      const querySnapshot = await getDocs(collection(db, "VEHICLES"));
      setVehicles(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchMasters = async () => {
    try {
      const compSnap = await getDocs(collection(db, "COMPANIES"));
      setCompanies(compSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      
      const branchSnap = await getDocs(collection(db, "BRANCHES"));
      setBranches(branchSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
  };

  // 🌍 LIVE SERVER LINK ADDED HERE
  const handleRCUpload = async () => {
    if (!rcFile) return alert("⚠️ Please select an RC photo first!");
    
    setUploadingRC(true);
    const data = new FormData();
    data.append('file', rcFile);

    try {
      const response = await fetch('https://prasad-api.onrender.com/upload-to-drive', {
        method: 'POST',
        body: data,
      });

      const result = await response.json();
      if (result.success) {
        alert("✅ RC Scanned & Saved to Secure Drive!");
        setFormData({ ...formData, rc_photo_url: result.link });
      } else {
        alert("❌ Drive Upload Error: " + result.error);
      }
    } catch (error) {
      console.error(error);
      alert("❌ Live Server is unreachable right now!");
    }
    setUploadingRC(false);
  };

  const handleSave = async () => {
    if (!formData.vehicle_no) return alert("⚠️ Vehicle Number is strictly required!");
    if (formData.own_attach === 'Attached' && !formData.owner_name) {
        return alert("⚠️ Owner Name is required for Attached Vehicles!");
    }

    try {
      if (editingId) {
        await updateDoc(doc(db, "VEHICLES", editingId), formData);
        alert("✅ Vehicle Data Updated Successfully!");
      } else {
        const docRef = await addDoc(collection(db, "VEHICLES"), { ...formData, createdAt: serverTimestamp() });
        
        const isOwn = formData.own_attach === 'Own';
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: isOwn ? formData.vehicle_no : formData.owner_name,
          group_head: isOwn ? "Fixed Assets" : "Sundry Creditors",
          opening_balance: isOwn ? parseFloat(formData.vehicle_value || 0) : 0, 
          current_balance: isOwn ? parseFloat(formData.vehicle_value || 0) : 0,
          creation_type: "AUTO_SYSTEM",
          linked_module: "VEHICLE",
          linked_id: docRef.id,
          created_at: serverTimestamp()
        });

        alert("✅ New Asset Registered & Auto-Ledger Created!");
      }
      resetForm(); fetchVehicles();
    } catch (err) { alert("❌ Error saving data to the server!"); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to permanently erase ${name}?`)) {
      await deleteDoc(doc(db, "VEHICLES", id));
      fetchVehicles();
    }
  };

  const resetForm = () => {
    setFormData({ vehicle_no: '', company_name: '', branch_name: '', owner_name: '', own_attach: 'Own', veh_class: '', capacity_kl: '', chassis_no: '', engine_no: '', mfg_date: '', reg_date: '', modal_no: '', fuel: 'Diesel', g_v_w: '', unladen_wt: '', hypothecated_to: '', driver_name: '', driver_mobile: '', rc_photo_url: '', vehicle_value: '0', status: 'Active', approval: 'Pending' });
    setRcFile(null);
    setShowForm(false); setEditingId(null);
  };

  // 🪄 यूनीक मालिकों (Owners) की लिस्ट निकालना ताकि बार-बार नाम न दिखे
  const uniqueOwners = Array.from(new Set(vehicles.filter(v => v.own_attach === 'Attached' && v.owner_name).map(v => v.owner_name)));

  // 🚀 स्मार्ट फ़िल्टरिंग लॉजिक (Company, Owner और Search के आधार पर)
  const filteredVehicles = vehicles.filter(v => {
    const matchesSearch = v.vehicle_no?.toLowerCase().includes(searchTerm.toLowerCase()) || v.driver_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCompany = filterCompany ? v.company_name === filterCompany : true;
    const matchesOwner = filterOwner ? (filterOwner === 'Own' ? v.own_attach === 'Own' : v.owner_name === filterOwner) : true;
    
    return matchesSearch && matchesCompany && matchesOwner;
  });

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; transition: all 0.4s; }
        .glass-card:hover { transform: translateY(-5px); box-shadow: 0 15px 30px -10px rgba(56, 189, 248, 0.25); border: 1px solid rgba(56, 189, 248, 0.4); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); box-shadow: 0 0 20px rgba(99, 102, 241, 0.4); color: white; border: none; font-weight: bold; cursor: pointer; transition: all 0.3s; }
        .glow-btn:hover { box-shadow: 0 0 35px rgba(99, 102, 241, 0.8); transform: scale(1.05); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 10px; color: white; padding: 10px 14px; outline: none; width: 100%; box-sizing: border-box; font-size: 13px;}
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.9); }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(2, 6, 23, 0.85); backdrop-filter: blur(10px); display: flex; justify-content: center; align-items: center; z-index: 9999; }
        .modal-content { background: #0f172a; border: 1px solid #38bdf8; width: 95%; max-width: 1200px; max-height: 90vh; overflow-y: auto; padding: 30px; border-radius: 20px; box-shadow: 0 0 50px rgba(56, 189, 248, 0.2); }
        label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 4px; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900', letterSpacing: '-1px' }}>Prasad Fleet AI</h1>
        </div>
        <button className="glow-btn" onClick={() => setShowForm(true)} style={{ padding: '12px 25px', borderRadius: '50px', fontSize: '15px' }}>
          + Initialize Vehicle
        </button>
      </div>

      {/* 🔍 स्मार्ट फ़िल्टरिंग सेक्शन (नया फीचर) */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '30px', flexWrap: 'wrap', background: 'rgba(30, 41, 59, 0.3)', padding: '15px', borderRadius: '15px', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ flex: 1, minWidth: '250px', position: 'relative' }}>
          <input placeholder="Search Vehicle or Driver..." className="modern-input" style={{ paddingLeft: '40px' }} onChange={(e) => setSearchTerm(e.target.value)} />
          <span style={{ position: 'absolute', left: '12px', top: '10px', fontSize: '16px' }}>🔍</span>
        </div>
        
        <div style={{ flex: 1, minWidth: '200px' }}>
          <select className="modern-input" value={filterCompany} onChange={(e) => setFilterCompany(e.target.value)} style={{ color: filterCompany ? '#38bdf8' : 'white', fontWeight: filterCompany ? 'bold' : 'normal' }}>
            <option value="">🏢 All Companies</option>
            {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
          </select>
        </div>

        <div style={{ flex: 1, minWidth: '200px' }}>
          <select className="modern-input" value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)} style={{ color: filterOwner ? '#c084fc' : 'white', fontWeight: filterOwner ? 'bold' : 'normal' }}>
            <option value="">👤 All Owners (Own + Attached)</option>
            <option value="Own" style={{ color: '#10b981', fontWeight: 'bold' }}>⭐ Only Own Assets (Prasad)</option>
            {uniqueOwners.map((owner, i) => <option key={i} value={owner}>🤝 {owner}</option>)}
          </select>
        </div>
      </div>

      {/* 🚛 Grid List */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '30px' }}>
        {filteredVehicles.map((v) => (
          <div key={v.id} className="glass-card" style={{ padding: '25px', position: 'relative' }}>
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px', marginBottom: '15px' }}>
              <span className="gradient-text" style={{ fontSize: '24px', fontWeight: '900' }}>{v.vehicle_no}</span>
              <p style={{ margin: '5px 0 0 0', color: v.own_attach === 'Own' ? '#10b981' : '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                {v.own_attach} Asset {v.owner_name ? `• ${v.owner_name}` : ''}
              </p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', color: '#e2e8f0', fontSize: '12px' }}>
              <div>🏢 <b>{v.company_name || 'N/A'}</b></div>
              <div>👤 <b>{v.driver_name || 'No Driver'}</b></div>
              <div>📑 {v.rc_photo_url ? <a href={v.rc_photo_url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>RC Attached ✓</a> : <span style={{ color: '#ef4444' }}>No RC</span>}</div>
            </div>
            <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
              <button onClick={() => { setFormData(v); setEditingId(v.id); setShowForm(true); }} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 15px', borderRadius: '50px', fontSize: '12px', cursor: 'pointer' }}>Configure</button>
              <button onClick={() => handleDelete(v.id, v.vehicle_no)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '12px', cursor: 'pointer' }}>Erase</button>
            </div>
          </div>
        ))}
      </div>

      {/* 🛸 MODAL FORM */}
      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 className="gradient-text" style={{ margin: 0, fontSize: '24px' }}>{editingId ? 'System Update: Asset Data' : 'Initialize New Asset & Ledger'}</h2>
              <button onClick={resetForm} style={{ background: 'transparent', color: '#ef4444', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 768 ? 'repeat(3, 1fr)' : '1fr', gap: '25px' }}>
              
              {/* SECTION 1: CORE IDENTITY */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h4 style={{ color: '#38bdf8', margin: 0 }}>CORE IDENTITY</h4>
                
                <div><label>Registration No. *</label><input className="modern-input" placeholder="e.g. AS01AB1234" value={formData.vehicle_no} onChange={e => setFormData({...formData, vehicle_no: e.target.value.toUpperCase()})} /></div>
                
                <div>
                  <label>Asset Type</label>
                  <select className="modern-input" value={formData.own_attach} onChange={e => setFormData({...formData, own_attach: e.target.value})}>
                    <option value="Own">Own Asset (Fixed Asset)</option>
                    <option value="Attached">Attached Fleet (Sundry Creditor)</option>
                  </select>
                </div>

                {formData.own_attach === 'Attached' ? (
                  <div><label style={{ color: '#f59e0b', fontWeight: 'bold' }}>Asset Owner Name (For Ledger) *</label><input className="modern-input" style={{ border: '1px solid #f59e0b' }} value={formData.owner_name} onChange={e => setFormData({...formData, owner_name: e.target.value})} /></div>
                ) : (
                  <div><label style={{ color: '#38bdf8', fontWeight: 'bold' }}>Vehicle Value (₹) - For Asset Ledger</label><input type="number" className="modern-input" style={{ border: '1px solid #38bdf8' }} value={formData.vehicle_value} onChange={e => setFormData({...formData, vehicle_value: e.target.value})} /></div>
                )}

                <div>
                  <label>Operating Company</label>
                  <select className="modern-input" value={formData.company_name} onChange={e => setFormData({...formData, company_name: e.target.value})}>
                    <option value="">-- Select Company --</option>
                    {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
                  </select>
                </div>

                <div>
                  <label>Operating Branch</label>
                  <select className="modern-input" value={formData.branch_name} onChange={e => setFormData({...formData, branch_name: e.target.value})}>
                    <option value="">-- Select Branch --</option>
                    {branches.map(b => <option key={b.id} value={b.branch_name}>{b.branch_name}</option>)}
                  </select>
                </div>
                
                <div><label>Vehicle Class</label><input className="modern-input" placeholder="e.g. Tanker / Trailer" value={formData.veh_class} onChange={e => setFormData({...formData, veh_class: e.target.value})} /></div>
              </div>

              {/* SECTION 2: HARDWARE SPECS */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h4 style={{ color: '#c084fc', margin: 0 }}>HARDWARE SPECS</h4>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}><label>Capacity (KL/Ton)</label><input className="modern-input" value={formData.capacity_kl} onChange={e => setFormData({...formData, capacity_kl: e.target.value})} /></div>
                    <div style={{ flex: 1 }}><label>Fuel Core</label>
                      <select className="modern-input" value={formData.fuel} onChange={e => setFormData({...formData, fuel: e.target.value})}>
                        <option value="Diesel">Diesel</option><option value="CNG">CNG</option><option value="EV">EV</option>
                      </select>
                    </div>
                </div>

                <div><label>Engine Serial Code</label><input className="modern-input" value={formData.engine_no} onChange={e => setFormData({...formData, engine_no: e.target.value.toUpperCase()})} /></div>
                <div><label>Chassis Code</label><input className="modern-input" value={formData.chassis_no} onChange={e => setFormData({...formData, chassis_no: e.target.value.toUpperCase()})} /></div>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}><label>Mfg Date</label><input type="date" className="modern-input" value={formData.mfg_date} onChange={e => setFormData({...formData, mfg_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                    <div style={{ flex: 1 }}><label>Modal No</label><input className="modern-input" value={formData.modal_no} onChange={e => setFormData({...formData, modal_no: e.target.value})} /></div>
                </div>

                <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}><label>Gross Wt (GVW)</label><input className="modern-input" value={formData.g_v_w} onChange={e => setFormData({...formData, g_v_w: e.target.value})} /></div>
                    <div style={{ flex: 1 }}><label>Unladen Wt</label><input className="modern-input" value={formData.unladen_wt} onChange={e => setFormData({...formData, unladen_wt: e.target.value})} /></div>
                </div>
              </div>

              {/* SECTION 3: LEGAL, PILOT & RC UPLOAD */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h4 style={{ color: '#10b981', margin: 0 }}>LEGAL & PILOT</h4>
                
                <div><label>Registration Date</label><input type="date" className="modern-input" value={formData.reg_date} onChange={e => setFormData({...formData, reg_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div><label>Hypothecated To (Bank/Financer)</label><input className="modern-input" placeholder="e.g. HDFC Bank" value={formData.hypothecated_to} onChange={e => setFormData({...formData, hypothecated_to: e.target.value})} /></div>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}><label>Assigned Pilot</label><input className="modern-input" value={formData.driver_name} onChange={e => setFormData({...formData, driver_name: e.target.value})} /></div>
                    <div style={{ flex: 1 }}><label>Pilot Mobile</label><input className="modern-input" value={formData.driver_mobile} onChange={e => setFormData({...formData, driver_mobile: e.target.value})} /></div>
                </div>

                <div>
                  <label>System Status</label>
                  <select className="modern-input" value={formData.status} onChange={e => setFormData({...formData, status: e.target.value})} style={{ color: formData.status === 'Active' ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                    <option value="Active">System Active</option><option value="Inactive">Offline / Maintenance</option>
                  </select>
                </div>

                {/* 🌟 DOCUMENT SCANNER (RC UPLOAD) */}
                <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '15px', borderRadius: '10px', border: '1px dashed #38bdf8', marginTop: '10px' }}>
                  <label style={{ color: '#38bdf8', fontWeight: 'bold', marginBottom: '8px' }}>Upload Original RC (2TB Drive)</label>
                  <input type="file" onChange={(e) => setRcFile(e.target.files ? e.target.files[0] : null)} style={{ color: 'white', marginBottom: '10px', fontSize: '12px', width: '100%' }} />
                  
                  <button onClick={handleRCUpload} disabled={!rcFile || uploadingRC} style={{ width: '100%', padding: '10px', background: rcFile ? '#3b82f6' : '#334155', color: 'white', border: 'none', borderRadius: '8px', cursor: rcFile ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                    {uploadingRC ? '🚀 SCANNING & UPLOADING...' : '📤 SCAN TO DRIVE'}
                  </button>
                  
                  {formData.rc_photo_url && (
                     <div style={{ marginTop: '10px', fontSize: '12px', color: '#10b981', textAlign: 'center' }}>✅ RC Verified & Attached</div>
                  )}
                </div>

              </div>

            </div>

            <div style={{ marginTop: '30px', textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '20px' }}>
              <button className="glow-btn" onClick={handleSave} style={{ padding: '12px 30px', borderRadius: '50px', fontSize: '14px' }}>
                {editingId ? '💾 UPDATE ASSET DATA' : '🚀 REGISTER & INITIALIZE LEDGER'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}