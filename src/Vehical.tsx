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

  // 🌟 MERGED STATE: Old Fields + New IOCL e-TRP Fields + 🛞 TYRE CONFIG
  const [formData, setFormData] = useState({
    vehicle_no: '', company_name: '', branch_name: '', owner_name: '', own_attach: 'Own', 
    veh_class: '', capacity_kl: '', chassis_no: '', engine_no: '', 
    mfg_date: '', reg_date: '', modal_no: '', fuel: 'Diesel', 
    g_v_w: '', unladen_wt: '', hypothecated_to: '', 
    driver_name: '', driver_mobile: '', rc_photo_url: '', vehicle_value: '0', 
    status: 'System Active', approval: 'Pending',
    
    // 🛢️ NEW IOCL e-TRP FIELDS
    vehicle_category: 'Bulk Trucks',
    plant_attached: '', 
    contract_ref: '', 
    contract_validity: '', 
    fastag_id: '',
    
    // 🛞 NEW: TYRE MANAGEMENT LINK FIELD
    no_of_tyres: '10+1' // Default
  });

  useEffect(() => { 
    fetchVehicles(); 
    fetchMasters(); 
  }, []);

  const fetchVehicles = async () => {
    setLoading(true);
    try {
      const vSnap1 = await getDocs(collection(db, "VEHICLES")).catch(()=>({docs:[]}));
      const vSnap2 = await getDocs(collection(db, "ASSETS")).catch(()=>({docs:[]}));
      
      const allVehicles = [
          ...vSnap1.docs.map(d => ({ id: d.id, _collection: 'VEHICLES', ...d.data() })),
          ...vSnap2.docs.map(d => ({ id: d.id, _collection: 'ASSETS', ...d.data() }))
      ];
      
      setVehicles(allVehicles);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchMasters = async () => {
    try {
      const compSnap = await getDocs(collection(db, "COMPANIES")).catch(()=>({docs:[]}));
      setCompanies(compSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      
      const branchSnap = await getDocs(collection(db, "BRANCHES")).catch(()=>({docs:[]}));
      setBranches(branchSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
  };

  const handleInputChange = (e: any) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: name === 'vehicle_no' ? value.toUpperCase().replace(/\s+/g, '') : value });
  };

  // 🌍 LIVE SERVER LINK & MAMTA AI AUTO-FILL
  const handleRCUpload = async () => {
    if (!rcFile) return alert("⚠️ Please select an RC photo first!");
    
    setUploadingRC(true);
    const data = new FormData();
    data.append('file', rcFile);
    data.append('driverName', formData.vehicle_no || 'New_Vehicle_RC'); 

    try {
      const response = await fetch('https://prasad-api.onrender.com/upload-to-drive', {
        method: 'POST',
        body: data,
      });

      const result = await response.json();
      if (result.success) {
        alert("✅ RC Scanned & Saved to Secure Drive!\n🤖 Mamta AI is extracting details...");
        
        const aiData = result.aiData || {};
        setFormData(prev => ({ 
            ...prev, 
            rc_photo_url: result.driveLink, 
            vehicle_no: aiData.vehicleNumber || prev.vehicle_no,
            reg_date: aiData.documentDate || prev.reg_date
        }));
      } else {
        alert("❌ Drive Upload Error: " + result.message);
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
        const existing = vehicles.find(v => v.id === editingId);
        const colName = existing?._collection || 'VEHICLES';
        await updateDoc(doc(db, colName, editingId), { ...formData, updatedAt: serverTimestamp() });
        alert("✅ Vehicle Data Updated Successfully!");
      } else {
        const docRef = await addDoc(collection(db, "VEHICLES"), { ...formData, createdAt: serverTimestamp() });
        
        const isOwn = formData.own_attach === 'Own';
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: isOwn ? formData.vehicle_no : formData.owner_name,
          group_head: isOwn ? "Fixed Assets" : "Sundry Creditors",
          opening_balance: isOwn ? parseFloat(formData.vehicle_value || '0') : 0, 
          current_balance: isOwn ? parseFloat(formData.vehicle_value || '0') : 0,
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

  const handleEdit = (v: any) => {
    setFormData({
      ...v,
      vehicle_no: v.vehicle_no || v.Vehicle_No || v.vehical_no || '',
      own_attach: v.own_attach || v.asset_type || 'Own',
      owner_name: v.owner_name || v.Owner_Name || v.asset_owner_name || '',
      company_name: v.company_name || v.Company_Name || v.operating_company || '',
      branch_name: v.branch_name || v.operating_branch || '',
      status: v.status || 'System Active',
      vehicle_category: v.vehicle_category || 'Bulk Trucks',
      plant_attached: v.plant_attached || '',
      contract_ref: v.contract_ref || '',
      contract_validity: v.contract_validity || '',
      fastag_id: v.fastag_id || '',
      no_of_tyres: v.no_of_tyres || v.No_of_Tyres || '10+1', 
      fuel: v.fuel || v.fuel_type || 'Diesel',
      capacity_kl: v.capacity_kl || v.capacity || '',
      rc_photo_url: v.rc_photo_url || v.document_file || ''
    });
    setEditingId(v.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string, name: string, colName: string) => {
    if (window.confirm(`Are you sure you want to permanently erase ${name}?`)) {
      await deleteDoc(doc(db, colName || "VEHICLES", id));
      fetchVehicles();
    }
  };

  const resetForm = () => {
    setFormData({ 
      vehicle_no: '', company_name: '', branch_name: '', owner_name: '', own_attach: 'Own', 
      veh_class: '', capacity_kl: '', chassis_no: '', engine_no: '', 
      mfg_date: '', reg_date: '', modal_no: '', fuel: 'Diesel', 
      g_v_w: '', unladen_wt: '', hypothecated_to: '', 
      driver_name: '', driver_mobile: '', rc_photo_url: '', vehicle_value: '0', 
      status: 'System Active', approval: 'Pending',
      vehicle_category: 'Bulk Trucks', plant_attached: '', contract_ref: '', contract_validity: '', fastag_id: '',
      no_of_tyres: '10+1' 
    });
    setRcFile(null);
    setShowForm(false); setEditingId(null);
  };

  const uniqueOwners = Array.from(new Set(vehicles.filter(v => v.own_attach === 'Attached' && (v.owner_name || v.asset_owner_name)).map(v => v.owner_name || v.asset_owner_name)));

  const filteredVehicles = vehicles.filter(v => {
    const vNo = String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').toLowerCase();
    const fId = String(v.fastag_id || '').toLowerCase();
    const dName = String(v.driver_name || '').toLowerCase();
    
    const matchesSearch = vNo.includes(searchTerm.toLowerCase()) || dName.includes(searchTerm.toLowerCase()) || fId.includes(searchTerm.toLowerCase());
    
    const compName = String(v.company_name || v.operating_company || '');
    const matchesCompany = filterCompany ? compName === filterCompany : true;
    
    const ownerName = String(v.owner_name || v.asset_owner_name || '');
    const matchesOwner = filterOwner ? (filterOwner === 'Own' ? (v.own_attach === 'Own' || !ownerName) : ownerName === filterOwner) : true;
    
    return matchesSearch && matchesCompany && matchesOwner;
  });

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; transition: all 0.4s; }
        .glass-card:hover { transform: translateY(-5px); box-shadow: 0 15px 30px -10px rgba(56, 189, 248, 0.25); border: 1px solid rgba(56, 189, 248, 0.4); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); box-shadow: 0 0 20px rgba(99, 102, 241, 0.4); color: white; border: none; font-weight: bold; cursor: pointer; transition: all 0.3s; padding: 12px 25px; border-radius: 8px; }
        .glow-btn:hover { box-shadow: 0 0 35px rgba(99, 102, 241, 0.8); transform: scale(1.05); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 10px; color: white; padding: 10px 14px; outline: none; width: 100%; box-sizing: border-box; font-size: 13px;}
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.9); }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(2, 6, 23, 0.85); backdrop-filter: blur(10px); display: flex; justify-content: center; align-items: center; z-index: 9999; }
        .modal-content { background: #0f172a; border: 1px solid #38bdf8; width: 95%; max-width: 1300px; max-height: 90vh; overflow-y: auto; padding: 30px; border-radius: 20px; box-shadow: 0 0 50px rgba(56, 189, 248, 0.2); }
        label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 4px; font-weight: bold; text-transform: uppercase; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900', letterSpacing: '-1px' }}>Prasad Fleet AI</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Vehicle Data, Owner Mapping & IOCL e-TRP Integration</p>
        </div>
        <button className="glow-btn" onClick={() => { resetForm(); setShowForm(true); }} style={{ borderRadius: '50px', fontSize: '15px' }}>
          + Initialize Vehicle
        </button>
      </div>

      {/* 🔍 स्मार्ट फ़िल्टरिंग सेक्शन */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '30px', flexWrap: 'wrap', background: 'rgba(30, 41, 59, 0.3)', padding: '15px', borderRadius: '15px', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ flex: 1, minWidth: '250px', position: 'relative' }}>
          <input placeholder="Search Vehicle, Driver or FASTag..." className="modern-input" style={{ paddingLeft: '40px' }} onChange={(e) => setSearchTerm(e.target.value)} />
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
            {uniqueOwners.map((owner: any, i) => <option key={i} value={owner}>🤝 {owner}</option>)}
          </select>
        </div>
      </div>

      {/* 🚛 Grid List */}
      {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', fontSize: '18px' }}>🔄 Syncing with Global Database...</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '30px' }}>
          {filteredVehicles.map((v) => {
            const isActive = String(v.status || 'Active').toLowerCase().includes('active');
            return (
            <div key={v.id} className="glass-card" style={{ padding: '25px', position: 'relative' }}>
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px', marginBottom: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span className="gradient-text" style={{ fontSize: '24px', fontWeight: '900' }}>{v.vehicle_no || v.Vehicle_No || v.vehical_no}</span>
                  <p style={{ margin: '5px 0 0 0', color: v.own_attach === 'Own' ? '#10b981' : '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                    {v.own_attach} Asset {(v.owner_name || v.asset_owner_name) ? `• ${v.owner_name || v.asset_owner_name}` : ''}
                  </p>
                </div>
                <span style={{ fontSize: '10px', background: 'rgba(245,158,11,0.1)', color: '#f59e0b', padding: '4px 8px', borderRadius: '12px', border: '1px solid #f59e0b' }}>
                  {v.vehicle_category || 'Truck'}
                </span>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', color: '#e2e8f0', fontSize: '12px' }}>
                <div>🏢 <b>{v.company_name || v.operating_company || 'N/A'}</b></div>
                <div>👤 <b>{v.driver_name || 'No Driver'}</b></div>
                
                {/* 🛞 TYRE CONFIG DISPLAY */}
                <div style={{ color: '#cbd5e1' }}>🛞 Tyres: <b style={{color: '#f59e0b'}}>{v.no_of_tyres || '10+1'}</b></div>
                <div>📑 {v.rc_photo_url ? <a href={v.rc_photo_url} target="_blank" rel="noreferrer" style={{ color: '#10b981' }}>RC Attached ✓</a> : <span style={{ color: '#ef4444' }}>No RC</span>}</div>
                
                <div style={{ gridColumn: 'span 2', color: '#cbd5e1' }}>🏷️ FASTag: <b style={{color: '#38bdf8'}}>{v.fastag_id || 'Not Set'}</b></div>
                
                <div style={{ gridColumn: 'span 2', color: isActive ? '#10b981' : '#ef4444', fontWeight: 'bold', borderTop: '1px dashed #334155', paddingTop: '10px', marginTop: '5px' }}>Status: {v.status || 'Active'}</div>
              </div>
              
              <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
                <button onClick={() => handleEdit(v)} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 15px', borderRadius: '50px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>✏️ Configure</button>
                <button onClick={() => handleDelete(v.id, (v.vehicle_no || v.Vehicle_No), v._collection)} style={{ background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', padding: '6px 15px', borderRadius: '50px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>🗑️ Erase</button>
              </div>
            </div>
          )})}
        </div>
      )}

      {/* 🛸 MODAL FORM */}
      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 className="gradient-text" style={{ margin: 0, fontSize: '24px' }}>{editingId ? 'System Update: Asset Data' : 'Initialize New Asset & Ledger'}</h2>
              <button onClick={resetForm} style={{ background: 'transparent', color: '#ef4444', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 768 ? 'repeat(3, 1fr)' : '1fr', gap: '25px' }}>
              
              {/* 1️⃣ COLUMN 1: CORE IDENTITY & e-TRP DATA */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                
                {/* Core Block */}
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
                  <h4 style={{ color: '#38bdf8', margin: '0 0 15px 0' }}>1️⃣ CORE IDENTITY & OWNERSHIP</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div><label style={{color: '#38bdf8'}}>Vehicle Registration No. *</label><input className="modern-input" name="vehicle_no" style={{borderColor: '#38bdf8', fontWeight: 'bold', fontSize: '16px', textTransform: 'uppercase'}} value={formData.vehicle_no} onChange={handleInputChange} placeholder="e.g. AS 26C 5106" /></div>
                    
                    <div><label>Asset Type</label>
                      <select className="modern-input" name="own_attach" value={formData.own_attach} onChange={handleInputChange}>
                        <option value="Own">Own Asset (Fixed Asset)</option>
                        <option value="Attached">Attached Fleet (Sundry Creditor)</option>
                      </select>
                    </div>

                    {formData.own_attach === 'Attached' ? (
                      <div><label style={{ color: '#f59e0b', fontWeight: 'bold' }}>Asset Owner Name (For Ledger) *</label><input className="modern-input" name="owner_name" style={{border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.05)'}} value={formData.owner_name} onChange={handleInputChange} placeholder="e.g. SANDEEP KUMAR PRASAD" /></div>
                    ) : (
                      <div><label style={{ color: '#38bdf8', fontWeight: 'bold' }}>Vehicle Value (₹) - For Asset Ledger</label><input type="number" className="modern-input" name="vehicle_value" style={{ border: '1px solid #38bdf8' }} value={formData.vehicle_value} onChange={handleInputChange} /></div>
                    )}

                    <div><label>Operating Company</label>
                      <select className="modern-input" name="company_name" value={formData.company_name} onChange={handleInputChange}>
                        <option value="">-- Select Company --</option>
                        {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
                      </select>
                    </div>

                    <div><label>Operating Branch</label>
                      <select className="modern-input" name="branch_name" value={formData.branch_name} onChange={handleInputChange}>
                        <option value="">-- Select Branch --</option>
                        {branches.map(b => <option key={b.id} value={b.branch_name}>{b.branch_name}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                {/* 🛢️ Oil Company / e-TRP Block */}
                <div style={{ background: 'rgba(245,158,11,0.05)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(245,158,11,0.3)' }}>
                  <h4 style={{ color: '#f59e0b', margin: '0 0 15px 0' }}>🛢️ IOCL e-TRP / FASTAG DATA</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div><label style={{color: '#f59e0b'}}>Vehicle Category (e-TRP) *</label>
                      <select className="modern-input" name="vehicle_category" style={{borderColor: '#f59e0b', fontWeight: 'bold', color: '#f59e0b'}} value={formData.vehicle_category} onChange={handleInputChange}>
                        <option value="Bulk Trucks">Bulk Trucks</option>
                        <option value="Packed Trucks">Packed Trucks</option>
                        <option value="Others">Others</option>
                      </select>
                    </div>
                    <div><label>FASTag ID (Auto-Toll Map)</label><input className="modern-input" name="fastag_id" value={formData.fastag_id} onChange={handleInputChange} placeholder="e.g. 34161FA8203290D4CDCCB960" /></div>
                    <div><label>Plant Attached</label><input className="modern-input" name="plant_attached" value={formData.plant_attached} onChange={handleInputChange} placeholder="e.g. Indian Oil AOD / 7B03" /></div>
                    <div><label>Contract Ref No.</label><input className="modern-input" name="contract_ref" value={formData.contract_ref} onChange={handleInputChange} placeholder="e.g. LPG/BULK/TT/IOC/AS/2025-30/281" /></div>
                    <div><label>Contract Validity</label><input type="date" className="modern-input" name="contract_validity" value={formData.contract_validity} onChange={handleInputChange} style={{colorScheme:'dark'}}/></div>
                  </div>
                </div>

              </div>

              {/* 2️⃣ COLUMN 2: HARDWARE SPECS & 🛞 TYRE CONFIG */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
                <h4 style={{ color: '#c084fc', margin: '0 0 15px 0' }}>2️⃣ HARDWARE SPECS</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  
                  <div style={{ gridColumn: 'span 2' }}><label>Vehicle Class</label><input className="modern-input" name="veh_class" placeholder="e.g. Tanker / Trailer" value={formData.veh_class} onChange={handleInputChange} /></div>

                  {/* 🌟 SMART TYRE CONFIGURATION DATALIST 🌟 */}
                  <div style={{ gridColumn: 'span 2', background: 'rgba(245, 158, 11, 0.1)', padding: '10px', borderRadius: '8px', border: '1px dashed #f59e0b' }}>
                    <label style={{color: '#f59e0b'}}>🛞 Total Tyres (Wheel Config) *</label>
                    <input 
                      className="modern-input" 
                      list="tyre-config-options"
                      name="no_of_tyres" 
                      value={formData.no_of_tyres} 
                      onChange={handleInputChange} 
                      placeholder="Select or type (e.g. 16+1)"
                      style={{borderColor: '#f59e0b', fontWeight: 'bold', color: '#f59e0b'}}
                    />
                    <datalist id="tyre-config-options">
                      <option value="4+1" />
                      <option value="6+1" />
                      <option value="10+1" />
                      <option value="12+1" />
                      <option value="14+1" />
                      <option value="16+1" />
                      <option value="18+1" />
                      <option value="22+1" />
                    </datalist>
                    <small style={{color: '#cbd5e1', fontSize: '10px'}}>Type custom config (e.g. '16+1') if not in list. Links to Tyre Mgmt.</small>
                  </div>

                  <div><label>Capacity (KL/Ton)</label><input type="number" className="modern-input" name="capacity_kl" value={formData.capacity_kl} onChange={handleInputChange} placeholder="e.g. 18" /></div>
                  <div><label>Fuel Core</label>
                    <select className="modern-input" name="fuel" value={formData.fuel} onChange={handleInputChange}>
                      <option value="Diesel">Diesel</option><option value="CNG">CNG</option><option value="EV">EV</option>
                    </select>
                  </div>

                  <div style={{ gridColumn: 'span 2' }}><label>Chassis Code</label><input className="modern-input" name="chassis_no" value={formData.chassis_no} onChange={e => setFormData({...formData, chassis_no: e.target.value.toUpperCase()})} placeholder="MAT..." /></div>
                  <div style={{ gridColumn: 'span 2' }}><label>Engine Serial Code</label><input className="modern-input" name="engine_no" value={formData.engine_no} onChange={e => setFormData({...formData, engine_no: e.target.value.toUpperCase()})} /></div>
                  
                  <div><label>Mfg Date</label><input type="date" className="modern-input" name="mfg_date" value={formData.mfg_date} onChange={handleInputChange} style={{colorScheme:'dark'}}/></div>
                  <div><label>Modal No</label><input className="modern-input" name="modal_no" value={formData.modal_no} onChange={handleInputChange} /></div>

                  <div><label>Gross Wt (GVW)</label><input type="number" className="modern-input" name="g_v_w" value={formData.g_v_w} onChange={handleInputChange} /></div>
                  <div><label>Unladen Wt</label><input type="number" className="modern-input" name="unladen_wt" value={formData.unladen_wt} onChange={handleInputChange} /></div>
                </div>
              </div>

              {/* 3️⃣ COLUMN 3: LEGAL, PILOT & RC UPLOAD */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
                <h4 style={{ color: '#10b981', margin: '0 0 15px 0' }}>3️⃣ LEGAL & PILOT</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  
                  <div><label>Registration Date</label><input type="date" className="modern-input" name="reg_date" value={formData.reg_date} onChange={handleInputChange} style={{colorScheme:'dark'}}/></div>
                  <div><label>Hypothecated To (Bank/Financer)</label><input className="modern-input" name="hypothecated_to" value={formData.hypothecated_to} onChange={handleInputChange} placeholder="e.g. AXIS BANK LTD" /></div>
                  
                  <div style={{ display: 'flex', gap: '10px' }}>
                      <div style={{ flex: 1 }}><label>Assigned Pilot</label><input className="modern-input" name="driver_name" value={formData.driver_name} onChange={handleInputChange} /></div>
                      <div style={{ flex: 1 }}><label>Pilot Mobile</label><input className="modern-input" name="driver_mobile" value={formData.driver_mobile} onChange={handleInputChange} /></div>
                  </div>

                  <div>
                    <label>System Status</label>
                    <select className="modern-input" name="status" value={formData.status} onChange={handleInputChange} style={{ color: formData.status.includes('Active') ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                      <option value="System Active">🟢 System Active</option>
                      <option value="Offline / Maintenance">🔴 Offline / Maintenance</option>
                      <option value="Sold / Blacklisted">⚫ Sold / Blacklisted</option>
                    </select>
                  </div>

                  {/* 🌟 DOCUMENT SCANNER (RC UPLOAD) */}
                  <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #38bdf8', marginTop: '10px', textAlign: 'center' }}>
                    <label style={{ color: '#38bdf8', fontWeight: 'bold', marginBottom: '10px', fontSize: '13px' }}>📎 Upload Original RC (2TB Drive)</label>
                    <input type="file" accept="image/*,.pdf" onChange={(e) => setRcFile(e.target.files ? e.target.files[0] : null)} style={{ color: '#94a3b8', marginBottom: '15px', fontSize: '12px', width: '100%', background: '#0f172a', padding: '10px', borderRadius: '8px' }} />
                    
                    <button onClick={handleRCUpload} disabled={!rcFile || uploadingRC} style={{ width: '100%', padding: '12px', background: rcFile ? 'linear-gradient(135deg, #3b82f6, #2563eb)' : '#334155', color: 'white', border: 'none', borderRadius: '8px', cursor: rcFile ? 'pointer' : 'not-allowed', fontWeight: 'bold', transition: '0.3s' }}>
                      {uploadingRC ? '🚀 SCANNING AI...' : '🤖 SCAN TO DRIVE & AUTO-FILL'}
                    </button>
                    
                    {formData.rc_photo_url && (
                        <div style={{ marginTop: '15px', fontSize: '13px', color: '#10b981', fontWeight: 'bold' }}>✅ RC Verified & Attached</div>
                    )}
                  </div>

                </div>
              </div>

            </div>

            <div style={{ marginTop: '30px', display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '20px' }}>
              <button className="glow-btn" onClick={handleSave} disabled={loading} style={{ padding: '15px 40px', fontSize: '16px' }}>
                 {loading ? '⏳ SAVING ASSET...' : (editingId ? '💾 UPDATE ASSET DATA' : '🚀 INITIALIZE VEHICLE')}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}