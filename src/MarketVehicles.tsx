// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { db } from './firebase'; 

export default function MarketVehicles() {
  const [activeTab, setActiveTab] = useState('VENDORS');
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [canApprove, setCanApprove] = useState(false);

  // ========================
  // 🏢 VENDORS STATE & LOGIC
  // ========================
  const [vendorsList, setVendorsList] = useState([]); 
  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [editingVendorId, setEditingVendorId] = useState(null);
  const [vendorFormData, setVendorFormData] = useState({
    agency_name: '', owner_name: '', mobile: '', email: '', pan_no: '', gst_no: '', address: '', 
    opening_balance: '0', payment_terms: 'Advance', bank_account: '', ifsc_code: '', status: 'APPROVED',
    // 💰 NEW: SUBSCRIPTION & LIMITS
    subscription_plan: 'FREE', max_vehicle_limit: 2,
    // 🎛️ NEW: 110% PORTAL CONTROL
    portal_access: true,
    portal_features: { live_loads: true, fleet_mgmt: true, active_trips: false, wallet: false }
  });

  // ========================
  // 🚛 TRUCKS STATE & LOGIC
  // ========================
  const [vehiclesList, setVehiclesList] = useState([]);
  const [isTruckModalOpen, setIsTruckModalOpen] = useState(false);
  const [editingTruckId, setEditingTruckId] = useState(null);
  const [truckFormData, setTruckFormData] = useState({
    registration_no: '', vendor_agency: '', vehicle_class: '', capacity: '', 
    driver_name: '', driver_mobile: '', engine_no: '', chassis_no: '',
    rc_expiry: '', ins_expiry: '', puc_expiry: '', fit_expiry: '', np_expiry: '', system_status: 'System Active'
  });

  useEffect(() => { 
    const user = JSON.parse(localStorage.getItem('prasad_user') || '{}');
    setCurrentUser(user);
    const hasPower = user.role === 'ADMIN' || user.role === 'Super Admin' || user.role === 'MANAGER' || 
                     user.permissions?.find(p => p.id === 'MARKET_VEHICLE')?.approve === true;
    setCanApprove(hasPower);

    fetchVehicles(); 
    fetchVendors(); 
  }, []);

  const fetchVehicles = async () => {
    try {
      const q = query(collection(db, "MARKET_VEHICLES"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      setVehiclesList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };

  const fetchVendors = async () => {
    try {
      const q = query(collection(db, "VENDORS"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      setVendorsList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };

  // ------------------ 🏢 VENDOR CRUD (WITH AUTO LEDGER & SUBSCRIPTION) ------------------
  const openVendorModalForAdd = () => {
    setVendorFormData({ 
      agency_name: '', owner_name: '', mobile: '', email: '', pan_no: '', gst_no: '', address: '', 
      opening_balance: '0', payment_terms: 'Advance', bank_account: '', ifsc_code: '', status: 'APPROVED',
      subscription_plan: 'FREE', max_vehicle_limit: 2, portal_access: true,
      portal_features: { live_loads: true, fleet_mgmt: true, active_trips: false, wallet: false }
    });
    setEditingVendorId(null);
    setIsVendorModalOpen(true);
  };

  const openVendorModalForEdit = (vendor) => {
    setVendorFormData({ 
      ...vendor, 
      portal_features: vendor.portal_features || { live_loads: true, fleet_mgmt: true, active_trips: false, wallet: false },
      subscription_plan: vendor.subscription_plan || 'FREE',
      max_vehicle_limit: vendor.max_vehicle_limit || 2,
      portal_access: vendor.portal_access !== undefined ? vendor.portal_access : true
    });
    setEditingVendorId(vendor.id);
    setIsVendorModalOpen(true);
  };

  // SMART AUTO-LIMIT UPDATER
  const handlePlanChange = (plan) => {
    let limit = 2;
    if (plan === 'PRO') limit = 50;
    if (plan === 'ENTERPRISE') limit = 9999;
    setVendorFormData({ ...vendorFormData, subscription_plan: plan, max_vehicle_limit: limit });
  };

  const toggleFeature = (featureName) => {
    setVendorFormData(prev => ({
      ...prev,
      portal_features: { ...prev.portal_features, [featureName]: !prev.portal_features[featureName] }
    }));
  };

  const handleSaveVendor = async () => {
    if (!vendorFormData.agency_name || !vendorFormData.mobile) return alert("Agency Name & Mobile are required!");
    setLoading(true);
    try {
      if (editingVendorId) {
        await updateDoc(doc(db, "VENDORS", editingVendorId), { ...vendorFormData, updatedAt: serverTimestamp() });
        alert("✅ Vendor Profile, Subscription & Limits Updated!");
      } else {
        const vndId = 'VND-' + Math.floor(Math.random() * 9000 + 1000);
        const docRef = await addDoc(collection(db, "VENDORS"), { ...vendorFormData, vendor_id: vndId, createdAt: serverTimestamp() });
        
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: vendorFormData.agency_name,
          group_head: "Sundry Creditors", 
          opening_balance: parseFloat(vendorFormData.opening_balance || '0'),
          current_balance: parseFloat(vendorFormData.opening_balance || '0'),
          creation_type: "AUTO_SYSTEM",
          linked_module: "VENDOR",
          linked_id: docRef.id,
          created_at: serverTimestamp()
        });

        alert("✅ New Vendor Saved with Custom Portal Access!");
      }
      setIsVendorModalOpen(false); fetchVendors(); 
    } catch (e) { alert("❌ Error saving Vendor"); }
    setLoading(false);
  };

  const toggleVendorStatus = async (vendor) => {
    if(!canApprove) return alert("Only Boss can change status!");
    const newStatus = vendor.status === 'APPROVED' ? 'INACTIVE' : 'APPROVED';
    await updateDoc(doc(db, "VENDORS", vendor.id), { status: newStatus });
    fetchVendors();
  };

  const handleDeleteVendor = async (id, name) => {
    if (window.confirm(`Delete Vendor: ${name}? This action cannot be undone.`)) {
      await deleteDoc(doc(db, "VENDORS", id)); fetchVendors();
    }
  };

  // ------------------ 🚛 TRUCK CRUD (WITH DOC VALIDATION) ------------------
  const openTruckModalForAdd = () => {
    setTruckFormData({
      registration_no: '', vendor_agency: '', vehicle_class: '', capacity: '', driver_name: '', driver_mobile: '', engine_no: '', chassis_no: '', rc_expiry: '', ins_expiry: '', puc_expiry: '', fit_expiry: '', np_expiry: '', system_status: canApprove ? 'System Active' : 'PENDING APPROVAL'
    });
    setEditingTruckId(null);
    setIsTruckModalOpen(true);
  };

  const openTruckModalForEdit = (truck) => {
    setTruckFormData({ ...truck });
    setEditingTruckId(truck.id);
    setIsTruckModalOpen(true);
  };

  const handleSaveTruck = async () => {
    if (!truckFormData.registration_no || !truckFormData.vendor_agency) return alert("Reg No & Vendor Agency required!");
    setLoading(true);
    try {
      if (editingTruckId) {
        await updateDoc(doc(db, "MARKET_VEHICLES", editingTruckId), { ...truckFormData, updatedAt: serverTimestamp() });
        alert("✅ Market Truck Data Updated!");
      } else {
        const finalStatus = canApprove ? 'System Active' : 'PENDING APPROVAL';
        await addDoc(collection(db, "MARKET_VEHICLES"), { ...truckFormData, system_status: finalStatus, addedBy: currentUser?.full_name || 'Unknown', createdAt: serverTimestamp() });
        alert(canApprove ? "✅ Market Vehicle Registered!" : "⏳ Vehicle sent for Approval!");
      }
      setIsTruckModalOpen(false); fetchVehicles(); 
    } catch (e) { alert("Error saving data"); }
    setLoading(false);
  };

  const handleApproveVehicle = async (id) => {
    await updateDoc(doc(db, "MARKET_VEHICLES", id), { system_status: 'System Active' });
    fetchVehicles();
  };

  const handleDeleteTruck = async (id, regNo) => {
    if (window.confirm(`Remove Truck ${regNo} from system?`)) {
      await deleteDoc(doc(db, "MARKET_VEHICLES", id)); fetchVehicles();
    }
  };

  const isExpired = (dateString) => {
    if (!dateString) return true; 
    return new Date(dateString) < new Date();
  };

  return (
    <div style={{ padding: '20px 30px', minHeight: '100vh', background: '#020617', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .glass-input { width: 100%; padding: 10px; background: rgba(15,23,42,0.6); border: 1px solid rgba(51,65,85,0.8); color: white; border-radius: 8px; font-size: 13px; outline: none; box-sizing: border-box;}
        .glass-input:focus { border-color: #38bdf8; background: rgba(15,23,42,0.9); }
        .section-title { font-size: 12px; color: #38bdf8; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #1e293b; padding-bottom: 8px; margin-bottom: 15px; margin-top: 25px; }
        .action-btn { background: transparent; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: bold; transition: 0.3s; border: 1px solid #3b82f6; color: #38bdf8; }
        .action-btn:hover { background: #3b82f6; color: white; }
        .status-badge { font-size: 10px; font-weight: bold; padding: 5px 10px; border-radius: 10px; cursor: pointer; border: none; outline: none; }
        .doc-badge { font-size: 10px; font-weight: bold; padding: 4px 8px; border-radius: 6px; }
        
        .toggle-switch { position: relative; display: inline-block; width: 40px; height: 20px; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #334155; transition: .4s; border-radius: 20px; }
        .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #10b981; }
        input:checked + .slider:before { transform: translateX(20px); }
        .feature-card { background: rgba(15,23,42,0.6); border: 1px solid rgba(51,65,85,0.8); padding: 15px; border-radius: 12px; display: flex; justify-content: space-between; alignItems: center; transition: 0.3s; }
        .feature-card.active { border-color: #10b981; background: rgba(16,185,129,0.05); }
      `}</style>

      {/* HEADER & TABS */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '32px', fontWeight: '900', color: '#fff', background: 'linear-gradient(135deg, #38bdf8, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Market Vehicle & Vendor Master</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0 15px 0', fontSize: '13px' }}>Manage Vendors, Set Subscriptions, and Verify Truck Documents.</p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setActiveTab('VENDORS')} style={{ background: activeTab === 'VENDORS' ? '#3b82f6' : '#1e293b', color: activeTab === 'VENDORS' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              🏢 Fleet Owners (Vendors)
            </button>
            <button onClick={() => setActiveTab('TRUCKS')} style={{ background: activeTab === 'TRUCKS' ? '#10b981' : '#1e293b', color: activeTab === 'TRUCKS' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              🚛 Market Trucks DB
            </button>
          </div>
        </div>
        
        {activeTab === 'VENDORS' ? (
           <button onClick={openVendorModalForAdd} style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', padding: '12px 20px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(59,130,246,0.3)' }}>+ Setup New Vendor</button>
        ) : (
           <button onClick={openTruckModalForAdd} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', padding: '12px 20px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(16,185,129,0.3)' }}>+ Register Market Truck</button>
        )}
      </div>

      {/* ========================================= */}
      {/* 🏢 TAB 1: VENDOR / AGENCY FULL CONTROL    */}
      {/* ========================================= */}
      {activeTab === 'VENDORS' && (
        <div style={{ background: 'rgba(30, 41, 59, 0.4)', borderRadius: '15px', border: '1px solid #1e293b', padding: '20px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', borderBottom: '1px solid #334155' }}>
                <th style={{ padding: '15px' }}>Agency Name & ID</th>
                <th style={{ padding: '15px' }}>Owner Details</th>
                <th style={{ padding: '15px' }}>Subscription & Access</th>
                <th style={{ padding: '15px' }}>Status</th>
                <th style={{ padding: '15px', textAlign: 'right' }}>Admin Actions</th>
              </tr>
            </thead>
            <tbody>
              {vendorsList.length === 0 ? <tr><td colSpan="5" style={{padding:'20px', textAlign:'center'}}>No vendors found.</td></tr> : vendorsList.map(v => (
                <tr key={v.id} style={{ borderBottom: '1px solid #0f172a', transition:'0.3s' }}>
                  <td style={{ padding: '15px' }}>
                    <b style={{color: '#fff', fontSize: '15px'}}>{v.agency_name || v.company_name}</b><br/>
                    <small style={{color:'#38bdf8'}}>{v.vendor_id || v.id.slice(0,6).toUpperCase()}</small>
                  </td>
                  <td style={{ padding: '15px' }}>👤 {v.owner_name || 'N/A'}<br/><span style={{color:'#94a3b8'}}>📞 {v.mobile}</span></td>
                  
                  <td style={{ padding: '15px' }}>
                    <div style={{ color: v.subscription_plan === 'FREE' ? '#94a3b8' : '#f59e0b', fontWeight: 'bold', fontSize: '12px' }}>
                      Plan: {v.subscription_plan || 'FREE'} (Limit: {v.max_vehicle_limit || 2})
                    </div>
                    {v.portal_access ? (
                      <span style={{ fontSize: '10px', background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', padding: '2px 6px', borderRadius: '4px', marginTop: '5px', display: 'inline-block' }}>Portal ON 🌐</span>
                    ) : (
                      <span style={{ fontSize: '10px', background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', padding: '2px 6px', borderRadius: '4px', marginTop: '5px', display: 'inline-block' }}>Portal OFF 🚫</span>
                    )}
                  </td>

                  <td style={{ padding: '15px' }}>
                    <button onClick={() => toggleVendorStatus(v)} className="status-badge" style={{ cursor: canApprove ? 'pointer' : 'default', background: v.status === 'APPROVED' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: v.status === 'APPROVED' ? '#10b981' : '#ef4444' }}>
                      {v.status === 'APPROVED' ? 'ACTIVE ✅' : 'INACTIVE 🚫'}
                    </button>
                  </td>
                  <td style={{ padding: '15px', textAlign: 'right', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button className="action-btn" onClick={() => openVendorModalForEdit(v)}>✏️ Control Access</button>
                    {canApprove && <button className="action-btn" style={{borderColor:'#ef4444', color:'#ef4444'}} onClick={() => handleDeleteVendor(v.id, v.agency_name)}>🗑️</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 📝 VENDOR MEGA MODAL (WITH PORTAL CONTROL & LIMITS) */}
      {isVendorModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '800px', borderRadius: '20px', border: '1px solid #3b82f6', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', background: '#020617' }}>
              <h2 style={{ color: '#38bdf8', margin: 0 }}>{editingVendorId ? '🔍 Vendor Setup & Controls' : '➕ Setup New Vendor'}</h2>
              <button onClick={() => setIsVendorModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ padding: '25px', overflowY: 'auto', maxHeight: '75vh' }}>
              
              <div className="section-title" style={{marginTop:0}}>1. IDENTITY & CONTACT</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div style={{gridColumn:'span 2'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>Transport Agency Name *</label><input className="glass-input" value={vendorFormData.agency_name} onChange={e => setVendorFormData({...vendorFormData, agency_name: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Owner Name</label><input className="glass-input" value={vendorFormData.owner_name} onChange={e => setVendorFormData({...vendorFormData, owner_name: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Mobile Number *</label><input className="glass-input" value={vendorFormData.mobile} onChange={e => setVendorFormData({...vendorFormData, mobile: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Email Address (For Portal Login)</label><input className="glass-input" value={vendorFormData.email} onChange={e => setVendorFormData({...vendorFormData, email: e.target.value})} /></div>
                <div style={{gridColumn:'span 2'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>Full Address</label><textarea className="glass-input" style={{height:'50px'}} value={vendorFormData.address} onChange={e => setVendorFormData({...vendorFormData, address: e.target.value})} /></div>
              </div>

              <div className="section-title">2. TAX & ACCOUNTING (AUTO-LEDGER)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', background: 'rgba(16, 185, 129, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <div><label style={{fontSize:'11px', color:'#f59e0b', fontWeight:'bold'}}>PAN Number *</label><input className="glass-input" style={{borderColor:'#f59e0b'}} value={vendorFormData.pan_no} onChange={e => setVendorFormData({...vendorFormData, pan_no: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>GST Number</label><input className="glass-input" value={vendorFormData.gst_no} onChange={e => setVendorFormData({...vendorFormData, gst_no: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Payment Terms</label>
                  <select className="glass-input" value={vendorFormData.payment_terms} onChange={e => setVendorFormData({...vendorFormData, payment_terms: e.target.value})}>
                    <option>Advance</option><option>To Pay (Delivery)</option><option>15 Days Credit</option>
                  </select>
                </div>
                <div><label style={{fontSize:'11px', color:'#10b981', fontWeight:'bold'}}>Opening Balance (Cr)</label><input type="number" className="glass-input" style={{borderColor:'#10b981'}} value={vendorFormData.opening_balance} onChange={e => setVendorFormData({...vendorFormData, opening_balance: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Bank Account No.</label><input className="glass-input" value={vendorFormData.bank_account} onChange={e => setVendorFormData({...vendorFormData, bank_account: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#94a3b8'}}>IFSC Code</label><input className="glass-input" value={vendorFormData.ifsc_code} onChange={e => setVendorFormData({...vendorFormData, ifsc_code: e.target.value})} /></div>
              </div>

              {/* 🔥 NEW SECTION: SUBSCRIPTION & 110% PORTAL CONTROL */}
              <div className="section-title" style={{color:'#ec4899'}}>3. PORTAL ACCESS & SUBSCRIPTION RULES</div>
              <div style={{ background: 'rgba(236, 72, 153, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(236, 72, 153, 0.3)' }}>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px', borderBottom: '1px dashed rgba(255,255,255,0.1)', paddingBottom: '20px' }}>
                  <div>
                    <label style={{fontSize:'11px', color:'#ec4899', fontWeight:'bold'}}>Vendor Subscription Plan</label>
                    <select className="glass-input" style={{borderColor:'#ec4899', color:'#ec4899', fontWeight:'bold'}} value={vendorFormData.subscription_plan} onChange={e => handlePlanChange(e.target.value)}>
                      <option value="FREE">FREE PLAN (Max 2 Vehicles)</option>
                      <option value="PRO">PRO PLAN (Max 50 Vehicles)</option>
                      <option value="ENTERPRISE">ENTERPRISE (Unlimited)</option>
                    </select>
                  </div>
                  <div>
                     <label style={{fontSize:'11px', color:'#94a3b8'}}>Max Vehicles Allowed (Auto Set)</label>
                     <input type="number" className="glass-input" disabled value={vendorFormData.max_vehicle_limit} />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#fff' }}>Enable Fleet Partner Dashboard Login</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>Allow vendor to login using their Email Address.</div>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={vendorFormData.portal_access} onChange={(e) => setVendorFormData({...vendorFormData, portal_access: e.target.checked})} />
                    <span className="slider"></span>
                  </label>
                </div>

                {vendorFormData.portal_access && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px' }}>
                    <div className={`feature-card ${vendorFormData.portal_features?.live_loads ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🎯 Live Load Board</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can bid on loads</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.live_loads} onChange={() => toggleFeature('live_loads')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${vendorFormData.portal_features?.fleet_mgmt ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🚛 My Fleet & Drivers</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can add trucks</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.fleet_mgmt} onChange={() => toggleFeature('fleet_mgmt')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${vendorFormData.portal_features?.active_trips ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>📍 Active Trips (GPS)</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can track own trips</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.active_trips} onChange={() => toggleFeature('active_trips')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${vendorFormData.portal_features?.wallet ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>💰 Earnings & Wallet</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can view ledger/escrow</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.wallet} onChange={() => toggleFeature('wallet')} /><span className="slider"></span></label>
                    </div>
                  </div>
                )}
              </div>

            </div>

            <div style={{ padding: '20px', textAlign: 'right', background: '#020617', borderTop: '1px solid #1e293b' }}>
              <button onClick={handleSaveVendor} disabled={loading} style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', border: 'none', padding: '14px 30px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                {loading ? 'Saving...' : '💾 SAVE VENDOR DATA'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================= */}
      {/* 🚛 TAB 2: MARKET TRUCKS DB (THE VEHICLE FORM IS HERE) */}
      {/* ========================================= */}
      {activeTab === 'TRUCKS' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '20px' }}>
          {vehiclesList.map(v => {
            const rcBad = isExpired(v.rc_expiry);
            const insBad = isExpired(v.ins_expiry);
            const pucBad = isExpired(v.puc_expiry);
            const fitBad = isExpired(v.fit_expiry);
            const isReadyForLoading = !rcBad && !insBad && !pucBad && !fitBad;

            return (
              <div key={v.id} style={{ background: '#0f172a', border: v.system_status === 'PENDING APPROVAL' ? '1px solid #f59e0b' : (isReadyForLoading ? '1px solid #10b981' : '1px solid #ef4444'), borderRadius: '15px', padding: '20px', position: 'relative' }}>
                
                <div style={{ position: 'absolute', top: '15px', right: '15px', display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end' }}>
                  <div style={{ fontSize: '10px', fontWeight: 'bold', padding: '4px 8px', borderRadius: '10px', background: v.system_status === 'PENDING APPROVAL' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)', color: v.system_status === 'PENDING APPROVAL' ? '#f59e0b' : '#10b981' }}>
                    {v.system_status}
                  </div>
                  {v.system_status === 'System Active' && (
                    <div style={{ fontSize: '10px', fontWeight: 'bold', padding: '4px 8px', borderRadius: '10px', background: isReadyForLoading ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: isReadyForLoading ? '#10b981' : '#ef4444' }}>
                      {isReadyForLoading ? '✅ Ready For Loading' : '🚫 Docs Expired/Missing'}
                    </div>
                  )}
                </div>

                <div style={{ fontSize: '24px', fontWeight: '900', color: '#fff', marginBottom: '5px' }}>{v.registration_no}</div>
                <div style={{ fontSize: '12px', color: '#38bdf8', fontWeight: 'bold', marginBottom: '15px' }}>{v.vendor_agency}</div>
                
                <div style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '15px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
                  <div>🚛 Class: <span style={{color:'white'}}>{v.vehicle_class || 'N/A'}</span></div>
                  <div>⚖️ Cap: <span style={{color:'white'}}>{v.capacity ? `${v.capacity} Ton` : 'N/A'}</span></div>
                  <div>👨‍✈️ Driver: <span style={{color:'white'}}>{v.driver_name || 'N/A'}</span></div>
                  <div>📞 Mob: <span style={{color:'white'}}>{v.driver_mobile || 'N/A'}</span></div>
                </div>

                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', marginBottom: '15px' }}>
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase' }}>Compliance Check (For Loading)</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span className="doc-badge" style={{ background: rcBad ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: rcBad ? '#ef4444' : '#10b981' }}>RC</span>
                    <span className="doc-badge" style={{ background: insBad ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: insBad ? '#ef4444' : '#10b981' }}>INS</span>
                    <span className="doc-badge" style={{ background: pucBad ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: pucBad ? '#ef4444' : '#10b981' }}>PUC</span>
                    <span className="doc-badge" style={{ background: fitBad ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: fitBad ? '#ef4444' : '#10b981' }}>FIT</span>
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                  {v.system_status === 'PENDING APPROVAL' && canApprove && (
                    <button onClick={() => handleApproveVehicle(v.id)} style={{ background: '#10b981', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✅ Approve</button>
                  )}
                  <button className="action-btn" style={{flex:1}} onClick={() => openTruckModalForEdit(v)}>✏️ Edit / Docs</button>
                  {canApprove && <button className="action-btn" style={{borderColor:'#ef4444', color:'#ef4444'}} onClick={() => handleDeleteTruck(v.id, v.registration_no)}>🗑️</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 📝 TRUCK MEGA MODAL (THE VEHICLE ENTRY FORM) */}
      {isTruckModalOpen && (
         <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
           <div style={{ background: '#0f172a', width: '100%', maxWidth: '900px', borderRadius: '20px', border: '1px solid #10b981', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
             
             <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', background: '#020617' }}>
              <h2 style={{ color: '#10b981', margin: 0 }}>{editingTruckId ? '🔍 Update Market Truck Data' : '🚛 Register Market Truck'}</h2>
              <button onClick={() => setIsTruckModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
             </div>

             <div style={{ padding: '25px', overflowY: 'auto', maxHeight: '75vh' }}>
                <div className="section-title" style={{marginTop:0}}>1. IDENTITY & SPECIFICATIONS</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px' }}>
                  <div><label style={{fontSize:'11px', color:'#10b981', fontWeight:'bold'}}>Registration No *</label><input className="glass-input" style={{borderColor:'#10b981'}} placeholder="e.g. AS01X1234" value={truckFormData.registration_no} onChange={e=>setTruckFormData({...truckFormData, registration_no:e.target.value.toUpperCase()})} /></div>
                  
                  <div style={{gridColumn:'span 2'}}><label style={{fontSize:'11px', color:'#38bdf8', fontWeight:'bold'}}>Vendor Agency *</label>
                    <select className="glass-input" value={truckFormData.vendor_agency} onChange={e=>setTruckFormData({...truckFormData, vendor_agency:e.target.value})}>
                      <option value="">-- Select Registered Vendor --</option>
                      {vendorsList.filter(v=>v.status==='APPROVED').map(v => <option key={v.id} value={v.agency_name}>{v.agency_name}</option>)}
                    </select>
                  </div>

                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Vehicle Class</label><input className="glass-input" placeholder="e.g. Open Truck" value={truckFormData.vehicle_class} onChange={e=>setTruckFormData({...truckFormData, vehicle_class:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Capacity (Ton)</label><input className="glass-input" placeholder="e.g. 21 MT" value={truckFormData.capacity} onChange={e=>setTruckFormData({...truckFormData, capacity:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Engine No</label><input className="glass-input" value={truckFormData.engine_no} onChange={e=>setTruckFormData({...truckFormData, engine_no:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Chassis No</label><input className="glass-input" value={truckFormData.chassis_no} onChange={e=>setTruckFormData({...truckFormData, chassis_no:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Assigned Pilot (Driver)</label><input className="glass-input" value={truckFormData.driver_name} onChange={e=>setTruckFormData({...truckFormData, driver_name:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Pilot Mobile</label><input className="glass-input" value={truckFormData.driver_mobile} onChange={e=>setTruckFormData({...truckFormData, driver_mobile:e.target.value})} /></div>
                </div>

                <div className="section-title" style={{color:'#f59e0b'}}>2. LEGAL DOCUMENTS EXPIRY (CRITICAL FOR LOADING)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', background: 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>RC Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.rc_expiry} onChange={e=>setTruckFormData({...truckFormData, rc_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Insurance Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.ins_expiry} onChange={e=>setTruckFormData({...truckFormData, ins_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>PUC Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.puc_expiry} onChange={e=>setTruckFormData({...truckFormData, puc_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Fitness Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.fit_expiry} onChange={e=>setTruckFormData({...truckFormData, fit_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#94a3b8'}}>National Permit Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.np_expiry} onChange={e=>setTruckFormData({...truckFormData, np_expiry:e.target.value})} /></div>
                </div>
             </div>

             <div style={{ padding: '20px', textAlign: 'right', background: '#020617', borderTop: '1px solid #1e293b' }}>
               <button onClick={handleSaveTruck} disabled={loading} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', padding: '14px 30px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}>
                 {loading ? 'Saving...' : '💾 SAVE TRUCK & DOCS DATA'}
               </button>
             </div>
           </div>
         </div>
      )}
    </div>
  );
}