// @ts-nocheck
import React, { useState, useEffect } from 'react';

import { API_BASE } from './lib/apiBase';
import { isAdmin } from './lib/rbac';
const API = API_BASE;
const BAZAAR = `${API}/api/v1/bazaar`;
const MASTERS = `${API}/api/v1/masters`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  // The /bazaar routes are admin-guarded now — they hand out competitors' bid
  // amounts and the office's target rate, which any vendor token could read
  // while they were open. Every call from this screen carries the admin session.
  const token = localStorage.getItem('prasad_token');
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

// ── Fleet-partner field adapter ────────────────────────────────────────────
// This form was built against the Firestore VENDORS shape; PostgreSQL `vendors`
// is the party master and names the same things differently. Mapped in one pair
// of functions at the data boundary rather than renamed through the modal JSX.
// `status` is the real trap: the form says APPROVED/INACTIVE, the column is a
// record_status enum (ACTIVE|INACTIVE|BLACKLISTED|ARCHIVED).
const vendorFromApi = (v: any) => ({
  ...v,
  id: v.id,
  agency_name: v.vendor_name,
  mobile: v.mobile_no,
  status: v.status === 'ACTIVE' ? 'APPROVED' : v.status,
  portal_features: v.portal_features ?? {},
});

const vendorToApi = (f: any) => ({
  vendor_name: f.agency_name,
  vendor_type: 'FLEET PARTNER',
  contact_person: f.owner_name || '',
  owner_name: f.owner_name || null,
  mobile_no: f.mobile,
  email: f.email || null,
  pan_no: f.pan_no || null,
  gst_no: f.gst_no || null,
  address: f.address || null,
  bank_account: f.bank_account || null,
  ifsc_code: f.ifsc_code || null,
  // TDS 194C on the 15-day partner bill (migration 162): INDIVIDUAL 1%,
  // FIRM 2%, no PAN 20%, 194C(6) declaration NIL. Blank = the bill says
  // "rate nahi" and cannot be approved.
  entity_type: f.entity_type || null,
  tds_declaration_194c: f.tds_declaration_194c === true,
  payment_terms: f.payment_terms || null,
  opening_balance: Number.parseFloat(f.opening_balance || '0'),
  status: f.status === 'APPROVED' ? 'ACTIVE' : (f.status || 'ACTIVE'),
  portal_access: f.portal_access !== false,
  subscription_plan: f.subscription_plan || 'FREE',
  max_vehicle_limit: Number(f.max_vehicle_limit ?? 2),
  portal_features: f.portal_features || {},
});

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
    entity_type: '', tds_declaration_194c: false,
    // 💰 NEW: SUBSCRIPTION & LIMITS
    subscription_plan: 'FREE', max_vehicle_limit: 2,
    // 🎛️ NEW: 110% PORTAL CONTROL
    portal_access: true,
    // Keys are the REAL portal module keys (068: vend.<key>) that
    // visibleModules() reads — the old live_loads/fleet_mgmt/wallet names
    // matched nothing and every toggle was inert.
    portal_features: { bazaar: true, vehicles: true, bills: false, submit_bill: false }
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
    const hasPower = isAdmin(user) || user.role === 'MANAGER' ||
                     (Array.isArray(user.permissions) ? user.permissions : [])
                       .find(p => p.id === 'MARKET_VEHICLE')?.approve === true;
    setCanApprove(hasPower);

    fetchVehicles(); 
    fetchVendors(); 
  }, []);

  const fetchVehicles = async () => {
    try {
      const { vehicles } = await fetchJson(`${BAZAAR}/market-vehicles`);
      setVehiclesList(vehicles ?? []);
    } catch (e) { console.error(e); }
  };

  const fetchVendors = async () => {
    try {
      // Only the agencies — the 13 fuel pumps and spares suppliers in the same
      // table belong to Vendor Master, not to this screen.
      const { vendors } = await fetchJson(`${MASTERS}/vendors?vendor_type=FLEET%20PARTNER`);
      setVendorsList((vendors ?? []).map(vendorFromApi));
    } catch (e) { console.error(e); }
  };

  // ------------------ 🏢 VENDOR CRUD (SUBSCRIPTION & PORTAL ACCESS) ------------------
  const openVendorModalForAdd = () => {
    setVendorFormData({ 
      agency_name: '', owner_name: '', mobile: '', email: '', pan_no: '', gst_no: '', address: '', 
      opening_balance: '0', payment_terms: 'Advance', bank_account: '', ifsc_code: '', status: 'APPROVED',
    entity_type: '', tds_declaration_194c: false,
      subscription_plan: 'FREE', max_vehicle_limit: 2, portal_access: true,
      // Keys are the REAL portal module keys (068: vend.<key>) that
    // visibleModules() reads — the old live_loads/fleet_mgmt/wallet names
    // matched nothing and every toggle was inert.
    portal_features: { bazaar: true, vehicles: true, bills: false, submit_bill: false }
    });
    setEditingVendorId(null);
    setIsVendorModalOpen(true);
  };

  const openVendorModalForEdit = (vendor) => {
    setVendorFormData({ 
      ...vendor, 
      portal_features: vendor.portal_features || { bazaar: true, vehicles: true, bills: false, submit_bill: false },
      subscription_plan: vendor.subscription_plan || 'FREE',
      max_vehicle_limit: vendor.max_vehicle_limit || 2,
      portal_access: vendor.portal_access !== undefined ? vendor.portal_access : true
    });
    setEditingVendorId(vendor.id);
    setIsVendorModalOpen(true);
  };

  // SMART AUTO-LIMIT UPDATER. Plans are the DB's own CHECK values
  // (FREE|SILVER|GOLD|PLATINUM, migration 044) — the old PRO/ENTERPRISE
  // labels violated the constraint and every save with them failed.
  const handlePlanChange = (plan) => {
    let limit = 2;
    if (plan === 'SILVER') limit = 10;
    if (plan === 'GOLD') limit = 50;
    if (plan === 'PLATINUM') limit = 9999;
    setVendorFormData({ ...vendorFormData, subscription_plan: plan, max_vehicle_limit: limit });
  };

  const toggleFeature = (featureName) => {
    setVendorFormData(prev => ({
      ...prev,
      portal_features: { ...prev.portal_features, [featureName]: !prev.portal_features[featureName] }
    }));
  };

  // Fleet partners now live in PostgreSQL `vendors` like every other party.
  //
  // This block used to carry a documented refusal to move, valid while
  // PostgreSQL `vendors` held ZERO agency rows so the two stores could not
  // disagree. Migration 044 added the columns that were missing (owner, plan,
  // vehicle limit, portal feature flags) and KycApprovals already creates
  // approved partners here — so keeping a second copy was about to produce two
  // records for one agency. See the migration header.
  //
  // The auto-LEDGERS insert is gone with it: TARA opens the party account on
  // the first real posting, and a second writer of that table is exactly what
  // migration 026 removed everywhere else.
  const handleSaveVendor = async () => {
    if (!vendorFormData.agency_name || !vendorFormData.mobile) return alert("Agency Name & Mobile are required!");
    setLoading(true);
    try {
      if (editingVendorId) {
        await fetchJson(`${MASTERS}/vendors/${editingVendorId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vendorToApi(vendorFormData)),
        });
        alert("✅ Vendor Profile, Subscription & Limits Updated!");
      } else {
        await fetchJson(`${MASTERS}/vendors`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vendorToApi(vendorFormData)),
        });
        alert("✅ New Vendor Saved with Custom Portal Access!");
      }
      setIsVendorModalOpen(false); fetchVendors(); 
    } catch (e) { alert("❌ Error saving Vendor: " + (e as any).message); }
    setLoading(false);
  };

  const toggleVendorStatus = async (vendor) => {
    if(!canApprove) return alert("Only Boss can change status!");
    // The column is a record_status enum, so the form's APPROVED maps to ACTIVE.
    const newStatus = vendor.status === 'APPROVED' ? 'INACTIVE' : 'ACTIVE';
    try {
      await fetchJson(`${MASTERS}/vendors/${vendor.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchVendors();
    } catch (e) { alert("❌ " + (e as any).message); }
  };

  const handleDeleteVendor = async (id, name) => {
    if (window.confirm(`Delete Vendor: ${name}? This action cannot be undone.`)) {
      // A vendor with fuel slips or transactions against it answers 409 IN_USE
      // rather than vanishing and orphaning them.
      try {
        await fetchJson(`${MASTERS}/vendors/${id}`, { method: 'DELETE' });
        fetchVendors();
      } catch (e) { alert("❌ " + (e as any).message); }
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
        await fetchJson(`${BAZAAR}/market-vehicles/${editingTruckId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(truckFormData),
        });
        alert("✅ Market Truck Data Updated!");
      } else {
        const finalStatus = canApprove ? 'System Active' : 'PENDING APPROVAL';
        await fetchJson(`${BAZAAR}/market-vehicles`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...truckFormData, system_status: finalStatus, added_by: currentUser?.full_name || 'Unknown' }),
        });
        alert(canApprove ? "✅ Market Vehicle Registered!" : "⏳ Vehicle sent for Approval!");
      }
      setIsTruckModalOpen(false); fetchVehicles(); 
    } catch (e) { alert("Error saving data"); }
    setLoading(false);
  };

  const handleApproveVehicle = async (id) => {
    await fetchJson(`${BAZAAR}/market-vehicles/${id}/approve`, { method: 'POST' });
    fetchVehicles();
  };

  const handleDeleteTruck = async (id, regNo) => {
    if (window.confirm(`Remove Truck ${regNo} from system?`)) {
      await fetchJson(`${BAZAAR}/market-vehicles/${id}`, { method: 'DELETE' }); fetchVehicles();
    }
  };

  const isExpired = (dateString) => {
    if (!dateString) return true; 
    return new Date(dateString) < new Date();
  };

  return (
    <div style={{ padding: '20px 30px', minHeight: '100vh', background: '#0a1024', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .glass-input { width: 100%; padding: 10px; background: rgba(18, 28, 56,0.6); border: 1px solid rgba(39, 57, 95,0.8); color: white; border-radius: 8px; font-size: 13px; outline: none; box-sizing: border-box;}
        .glass-input:focus { border-color: #22d3ee; background: rgba(18, 28, 56,0.9); }
        .section-title { font-size: 12px; color: #22d3ee; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #18244a; padding-bottom: 8px; margin-bottom: 15px; margin-top: 25px; }
        .action-btn { background: transparent; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: bold; transition: 0.3s; border: 1px solid #3b82f6; color: #22d3ee; }
        .action-btn:hover { background: #3b82f6; color: white; }
        .status-badge { font-size: 10px; font-weight: bold; padding: 5px 10px; border-radius: 10px; cursor: pointer; border: none; outline: none; }
        .doc-badge { font-size: 10px; font-weight: bold; padding: 4px 8px; border-radius: 6px; }
        
        .toggle-switch { position: relative; display: inline-block; width: 40px; height: 20px; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #27395f; transition: .4s; border-radius: 20px; }
        .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #10b981; }
        input:checked + .slider:before { transform: translateX(20px); }
        .feature-card { background: rgba(18, 28, 56,0.6); border: 1px solid rgba(39, 57, 95,0.8); padding: 15px; border-radius: 12px; display: flex; justify-content: space-between; alignItems: center; transition: 0.3s; }
        .feature-card.active { border-color: #2fe39b; background: rgba(47, 227, 155,0.05); }
      `}</style>

      {/* HEADER & TABS */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '32px', fontWeight: '900', color: '#fff', background: 'linear-gradient(135deg, #22d3ee, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Market Vehicle & Fleet Partner Master</h1>
          <p style={{ color: '#9aadd4', margin: '5px 0 15px 0', fontSize: '13px' }}>Manage Fleet Partners (market truck owners), set subscriptions, and verify their truck documents. Service vendors — pumps, tyre shops, spares — live in Vendor Master under Accounts.</p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setActiveTab('VENDORS')} style={{ background: activeTab === 'VENDORS' ? '#3b82f6' : '#18244a', color: activeTab === 'VENDORS' ? 'white' : '#9aadd4', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              🏢 Fleet Partners
            </button>
            <button onClick={() => setActiveTab('TRUCKS')} style={{ background: activeTab === 'TRUCKS' ? '#10b981' : '#18244a', color: activeTab === 'TRUCKS' ? 'white' : '#9aadd4', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              🚛 Market Trucks DB
            </button>
          </div>
        </div>
        
        {activeTab === 'VENDORS' ? (
           <button onClick={openVendorModalForAdd} style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', padding: '12px 20px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(59,130,246,0.3)' }}>+ Setup New Fleet Partner</button>
        ) : (
           <button onClick={openTruckModalForAdd} style={{ background: 'linear-gradient(135deg, #2fe39b, #2fe39b)', color: 'white', padding: '12px 20px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(47, 227, 155,0.3)' }}>+ Register Market Truck</button>
        )}
      </div>

      {/* ========================================= */}
      {/* 🏢 TAB 1: VENDOR / AGENCY FULL CONTROL    */}
      {/* ========================================= */}
      {activeTab === 'VENDORS' && (
        <div style={{ background: 'rgba(24, 36, 74, 0.4)', borderRadius: '15px', border: '1px solid #18244a', padding: '20px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ color: '#9aadd4', fontSize: '11px', textTransform: 'uppercase', borderBottom: '1px solid #27395f' }}>
                <th style={{ padding: '15px' }}>Agency Name & ID</th>
                <th style={{ padding: '15px' }}>Owner Details</th>
                <th style={{ padding: '15px' }}>Subscription & Access</th>
                <th style={{ padding: '15px' }}>Status</th>
                <th style={{ padding: '15px', textAlign: 'right' }}>Admin Actions</th>
              </tr>
            </thead>
            <tbody>
              {vendorsList.length === 0 ? <tr><td colSpan="5" style={{padding:'20px', textAlign:'center'}}>No vendors found.</td></tr> : vendorsList.map(v => (
                <tr key={v.id} style={{ borderBottom: '1px solid #121c38', transition:'0.3s' }}>
                  <td style={{ padding: '15px' }}>
                    <b style={{color: '#fff', fontSize: '15px'}}>{v.agency_name || v.company_name}</b><br/>
                    <small style={{color:'#22d3ee'}}>{v.vendor_id || v.id.slice(0,6).toUpperCase()}</small>
                  </td>
                  <td style={{ padding: '15px' }}>👤 {v.owner_name || 'N/A'}<br/><span style={{color:'#9aadd4'}}>📞 {v.mobile}</span></td>
                  
                  <td style={{ padding: '15px' }}>
                    <div style={{ color: v.subscription_plan === 'FREE' ? '#9aadd4' : '#ffb224', fontWeight: 'bold', fontSize: '12px' }}>
                      Plan: {v.subscription_plan || 'FREE'} (Limit: {v.max_vehicle_limit || 2})
                    </div>
                    {v.portal_access ? (
                      <span style={{ fontSize: '10px', background: 'rgba(47, 227, 155, 0.2)', color: '#2fe39b', padding: '2px 6px', borderRadius: '4px', marginTop: '5px', display: 'inline-block' }}>Portal ON 🌐</span>
                    ) : (
                      <span style={{ fontSize: '10px', background: 'rgba(255, 107, 129, 0.2)', color: '#ff6b81', padding: '2px 6px', borderRadius: '4px', marginTop: '5px', display: 'inline-block' }}>Portal OFF 🚫</span>
                    )}
                  </td>

                  <td style={{ padding: '15px' }}>
                    <button onClick={() => toggleVendorStatus(v)} className="status-badge" style={{ cursor: canApprove ? 'pointer' : 'default', background: v.status === 'APPROVED' ? 'rgba(47, 227, 155, 0.2)' : 'rgba(255, 107, 129, 0.2)', color: v.status === 'APPROVED' ? '#2fe39b' : '#ff6b81' }}>
                      {v.status === 'APPROVED' ? 'ACTIVE ✅' : 'INACTIVE 🚫'}
                    </button>
                  </td>
                  <td style={{ padding: '15px', textAlign: 'right', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button className="action-btn" onClick={() => openVendorModalForEdit(v)}>✏️ Control Access</button>
                    {canApprove && <button className="action-btn" style={{borderColor:'#ff6b81', color:'#ff6b81'}} onClick={() => handleDeleteVendor(v.id, v.agency_name)}>🗑️</button>}
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
          <div style={{ background: '#121c38', width: '100%', maxWidth: '800px', borderRadius: '20px', border: '1px solid #3b82f6', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #18244a', background: '#0a1024' }}>
              <h2 style={{ color: '#22d3ee', margin: 0 }}>{editingVendorId ? '🔍 Fleet Partner Setup & Controls' : '➕ Setup New Fleet Partner'}</h2>
              <button onClick={() => setIsVendorModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ padding: '25px', overflowY: 'auto', maxHeight: '75vh' }}>
              
              <div className="section-title" style={{marginTop:0}}>1. IDENTITY & CONTACT</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div style={{gridColumn:'span 2'}}><label style={{fontSize:'11px', color:'#9aadd4'}}>Transport Agency Name *</label><input className="glass-input" value={vendorFormData.agency_name} onChange={e => setVendorFormData({...vendorFormData, agency_name: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Owner Name</label><input className="glass-input" value={vendorFormData.owner_name} onChange={e => setVendorFormData({...vendorFormData, owner_name: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Mobile Number *</label><input className="glass-input" value={vendorFormData.mobile} onChange={e => setVendorFormData({...vendorFormData, mobile: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Email Address (For Portal Login)</label><input className="glass-input" value={vendorFormData.email} onChange={e => setVendorFormData({...vendorFormData, email: e.target.value})} /></div>
                <div style={{gridColumn:'span 2'}}><label style={{fontSize:'11px', color:'#9aadd4'}}>Full Address</label><textarea className="glass-input" style={{height:'50px'}} value={vendorFormData.address} onChange={e => setVendorFormData({...vendorFormData, address: e.target.value})} /></div>
              </div>

              <div className="section-title">2. TAX & ACCOUNTING (AUTO-LEDGER)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', background: 'rgba(47, 227, 155, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(47, 227, 155, 0.2)' }}>
                <div><label style={{fontSize:'11px', color:'#ffb224', fontWeight:'bold'}}>PAN Number *</label><input className="glass-input" style={{borderColor:'#ffb224'}} value={vendorFormData.pan_no} onChange={e => setVendorFormData({...vendorFormData, pan_no: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>GST Number</label><input className="glass-input" value={vendorFormData.gst_no} onChange={e => setVendorFormData({...vendorFormData, gst_no: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Payment Terms</label>
                  <select className="glass-input" value={vendorFormData.payment_terms} onChange={e => setVendorFormData({...vendorFormData, payment_terms: e.target.value})}>
                    <option>Advance</option><option>To Pay (Delivery)</option><option>15 Days Credit</option>
                  </select>
                </div>
                <div><label style={{fontSize:'11px', color:'#2fe39b', fontWeight:'bold'}}>Opening Balance (Cr)</label><input type="number" className="glass-input" style={{borderColor:'#2fe39b'}} value={vendorFormData.opening_balance} onChange={e => setVendorFormData({...vendorFormData, opening_balance: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Bank Account No.</label><input className="glass-input" value={vendorFormData.bank_account} onChange={e => setVendorFormData({...vendorFormData, bank_account: e.target.value})} /></div>
                <div><label style={{fontSize:'11px', color:'#9aadd4'}}>IFSC Code</label><input className="glass-input" value={vendorFormData.ifsc_code} onChange={e => setVendorFormData({...vendorFormData, ifsc_code: e.target.value})} /></div>
                {/* TDS 194C for the 15-day partner bill (migration 162). The
                    bill reads the rate from here; blank = "rate nahi", no approve. */}
                <div><label style={{fontSize:'11px', color:'#f472b6', fontWeight:'bold'}}>TDS: Individual ya Firm? *</label>
                  <select className="glass-input" style={{borderColor:'#f472b6'}} value={vendorFormData.entity_type || ''} onChange={e => setVendorFormData({...vendorFormData, entity_type: e.target.value})}>
                    <option value="">-- chuniye --</option>
                    <option value="INDIVIDUAL">Individual / HUF — TDS 1%</option>
                    <option value="FIRM">Firm / Company — TDS 2%</option>
                  </select>
                </div>
                <div style={{gridColumn:'span 2', display:'flex', alignItems:'center', gap:'10px', paddingTop:'18px'}}>
                  <input type="checkbox" id="tds194c6" checked={!!vendorFormData.tds_declaration_194c} onChange={e => setVendorFormData({...vendorFormData, tds_declaration_194c: e.target.checked})} style={{width:'18px', height:'18px'}} />
                  <label htmlFor="tds194c6" style={{fontSize:'12px', color:'#c4d1ea'}}>194C(6) declaration mili hai (≤10 gaadi, PAN ke saath) — <b style={{color:'#2fe39b'}}>TDS NIL</b>. Bina PAN 20% kat-ta hai.</label>
                </div>
              </div>

              {/* 🔥 NEW SECTION: SUBSCRIPTION & 110% PORTAL CONTROL */}
              <div className="section-title" style={{color:'#ec4899'}}>3. PORTAL ACCESS & SUBSCRIPTION RULES</div>
              <div style={{ background: 'rgba(236, 72, 153, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(236, 72, 153, 0.3)' }}>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px', borderBottom: '1px dashed rgba(255,255,255,0.1)', paddingBottom: '20px' }}>
                  <div>
                    <label style={{fontSize:'11px', color:'#ec4899', fontWeight:'bold'}}>Vendor Subscription Plan</label>
                    <select className="glass-input" style={{borderColor:'#ec4899', color:'#ec4899', fontWeight:'bold'}} value={vendorFormData.subscription_plan} onChange={e => handlePlanChange(e.target.value)}>
                      <option value="FREE">FREE PLAN (Max 2 Vehicles)</option>
                      <option value="SILVER">SILVER PLAN (Max 10 Vehicles)</option>
                      <option value="GOLD">GOLD PLAN (Max 50 Vehicles)</option>
                      <option value="PLATINUM">PLATINUM (Unlimited)</option>
                    </select>
                  </div>
                  <div>
                     <label style={{fontSize:'11px', color:'#9aadd4'}}>Max Vehicles Allowed (Auto Set)</label>
                     <input type="number" className="glass-input" disabled value={vendorFormData.max_vehicle_limit} />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#fff' }}>Enable Fleet Partner Dashboard Login</div>
                    <div style={{ fontSize: '12px', color: '#9aadd4' }}>Allow vendor to login using their Email Address.</div>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={vendorFormData.portal_access} onChange={(e) => setVendorFormData({...vendorFormData, portal_access: e.target.checked})} />
                    <span className="slider"></span>
                  </label>
                </div>

                {vendorFormData.portal_access && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px' }}>
                    <div className={`feature-card ${vendorFormData.portal_features?.bazaar ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🎯 Live Load Board</div><div style={{ color: '#9aadd4', fontSize: '11px' }}>Can bid on loads (vend.bazaar)</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.bazaar} onChange={() => toggleFeature('bazaar')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${vendorFormData.portal_features?.vehicles ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🚛 My Fleet & Drivers</div><div style={{ color: '#9aadd4', fontSize: '11px' }}>Can add trucks (vend.vehicles)</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.vehicles} onChange={() => toggleFeature('vehicles')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${vendorFormData.portal_features?.submit_bill ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🧾 Submit Bills</div><div style={{ color: '#9aadd4', fontSize: '11px' }}>Can raise bills (vend.submit_bill)</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.submit_bill} onChange={() => toggleFeature('submit_bill')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${vendorFormData.portal_features?.bills ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>💰 Earnings & Wallet</div><div style={{ color: '#9aadd4', fontSize: '11px' }}>Can view ledger (vend.bills)</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={vendorFormData.portal_features?.bills} onChange={() => toggleFeature('bills')} /><span className="slider"></span></label>
                    </div>
                  </div>
                )}
              </div>

            </div>

            <div style={{ padding: '20px', textAlign: 'right', background: '#0a1024', borderTop: '1px solid #18244a' }}>
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
              <div key={v.id} style={{ background: '#121c38', border: v.system_status === 'PENDING APPROVAL' ? '1px solid #ffb224' : (isReadyForLoading ? '1px solid #2fe39b' : '1px solid #ff6b81'), borderRadius: '15px', padding: '20px', position: 'relative' }}>
                
                <div style={{ position: 'absolute', top: '15px', right: '15px', display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end' }}>
                  <div style={{ fontSize: '10px', fontWeight: 'bold', padding: '4px 8px', borderRadius: '10px', background: v.system_status === 'PENDING APPROVAL' ? 'rgba(255, 178, 36, 0.2)' : 'rgba(47, 227, 155, 0.2)', color: v.system_status === 'PENDING APPROVAL' ? '#ffb224' : '#2fe39b' }}>
                    {v.system_status}
                  </div>
                  {v.system_status === 'System Active' && (
                    <div style={{ fontSize: '10px', fontWeight: 'bold', padding: '4px 8px', borderRadius: '10px', background: isReadyForLoading ? 'rgba(47, 227, 155, 0.2)' : 'rgba(255, 107, 129, 0.2)', color: isReadyForLoading ? '#2fe39b' : '#ff6b81' }}>
                      {isReadyForLoading ? '✅ Ready For Loading' : '🚫 Docs Expired/Missing'}
                    </div>
                  )}
                </div>

                <div style={{ fontSize: '24px', fontWeight: '900', color: '#fff', marginBottom: '5px' }}>{v.registration_no}</div>
                <div style={{ fontSize: '12px', color: '#22d3ee', fontWeight: 'bold', marginBottom: '15px' }}>{v.vendor_agency}</div>
                
                <div style={{ fontSize: '12px', color: '#c4d1ea', marginBottom: '15px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
                  <div>🚛 Class: <span style={{color:'white'}}>{v.vehicle_class || 'N/A'}</span></div>
                  <div>⚖️ Cap: <span style={{color:'white'}}>{v.capacity ? `${v.capacity} Ton` : 'N/A'}</span></div>
                  <div>👨‍✈️ Driver: <span style={{color:'white'}}>{v.driver_name || 'N/A'}</span></div>
                  <div>📞 Mob: <span style={{color:'white'}}>{v.driver_mobile || 'N/A'}</span></div>
                </div>

                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', marginBottom: '15px' }}>
                  <div style={{ fontSize: '10px', color: '#9aadd4', marginBottom: '8px', textTransform: 'uppercase' }}>Compliance Check (For Loading)</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span className="doc-badge" style={{ background: rcBad ? 'rgba(255, 107, 129,0.2)' : 'rgba(47, 227, 155,0.2)', color: rcBad ? '#ff6b81' : '#2fe39b' }}>RC</span>
                    <span className="doc-badge" style={{ background: insBad ? 'rgba(255, 107, 129,0.2)' : 'rgba(47, 227, 155,0.2)', color: insBad ? '#ff6b81' : '#2fe39b' }}>INS</span>
                    <span className="doc-badge" style={{ background: pucBad ? 'rgba(255, 107, 129,0.2)' : 'rgba(47, 227, 155,0.2)', color: pucBad ? '#ff6b81' : '#2fe39b' }}>PUC</span>
                    <span className="doc-badge" style={{ background: fitBad ? 'rgba(255, 107, 129,0.2)' : 'rgba(47, 227, 155,0.2)', color: fitBad ? '#ff6b81' : '#2fe39b' }}>FIT</span>
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                  {v.system_status === 'PENDING APPROVAL' && canApprove && (
                    <button onClick={() => handleApproveVehicle(v.id)} style={{ background: '#10b981', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✅ Approve</button>
                  )}
                  <button className="action-btn" style={{flex:1}} onClick={() => openTruckModalForEdit(v)}>✏️ Edit / Docs</button>
                  {canApprove && <button className="action-btn" style={{borderColor:'#ff6b81', color:'#ff6b81'}} onClick={() => handleDeleteTruck(v.id, v.registration_no)}>🗑️</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 📝 TRUCK MEGA MODAL (THE VEHICLE ENTRY FORM) */}
      {isTruckModalOpen && (
         <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
           <div style={{ background: '#121c38', width: '100%', maxWidth: '900px', borderRadius: '20px', border: '1px solid #2fe39b', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
             
             <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #18244a', background: '#0a1024' }}>
              <h2 style={{ color: '#2fe39b', margin: 0 }}>{editingTruckId ? '🔍 Update Market Truck Data' : '🚛 Register Market Truck'}</h2>
              <button onClick={() => setIsTruckModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
             </div>

             <div style={{ padding: '25px', overflowY: 'auto', maxHeight: '75vh' }}>
                <div className="section-title" style={{marginTop:0}}>1. IDENTITY & SPECIFICATIONS</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px' }}>
                  <div><label style={{fontSize:'11px', color:'#2fe39b', fontWeight:'bold'}}>Registration No *</label><input className="glass-input" style={{borderColor:'#2fe39b'}} placeholder="e.g. AS01X1234" value={truckFormData.registration_no} onChange={e=>setTruckFormData({...truckFormData, registration_no:e.target.value.toUpperCase()})} /></div>
                  
                  <div style={{gridColumn:'span 2'}}><label style={{fontSize:'11px', color:'#22d3ee', fontWeight:'bold'}}>Vendor Agency *</label>
                    <select className="glass-input" value={truckFormData.vendor_agency} onChange={e=>setTruckFormData({...truckFormData, vendor_agency:e.target.value})}>
                      <option value="">-- Select Registered Vendor --</option>
                      {vendorsList.filter(v=>v.status==='APPROVED').map(v => <option key={v.id} value={v.agency_name}>{v.agency_name}</option>)}
                    </select>
                  </div>

                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Vehicle Class</label><input className="glass-input" placeholder="e.g. Open Truck" value={truckFormData.vehicle_class} onChange={e=>setTruckFormData({...truckFormData, vehicle_class:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Capacity (Ton)</label><input className="glass-input" placeholder="e.g. 21 MT" value={truckFormData.capacity} onChange={e=>setTruckFormData({...truckFormData, capacity:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Engine No</label><input className="glass-input" value={truckFormData.engine_no} onChange={e=>setTruckFormData({...truckFormData, engine_no:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Chassis No</label><input className="glass-input" value={truckFormData.chassis_no} onChange={e=>setTruckFormData({...truckFormData, chassis_no:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Assigned Pilot (Driver)</label><input className="glass-input" value={truckFormData.driver_name} onChange={e=>setTruckFormData({...truckFormData, driver_name:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Pilot Mobile</label><input className="glass-input" value={truckFormData.driver_mobile} onChange={e=>setTruckFormData({...truckFormData, driver_mobile:e.target.value})} /></div>
                </div>

                <div className="section-title" style={{color:'#ffb224'}}>2. LEGAL DOCUMENTS EXPIRY (CRITICAL FOR LOADING)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', background: 'rgba(255, 178, 36, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(255, 178, 36, 0.2)' }}>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>RC Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.rc_expiry} onChange={e=>setTruckFormData({...truckFormData, rc_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Insurance Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.ins_expiry} onChange={e=>setTruckFormData({...truckFormData, ins_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>PUC Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.puc_expiry} onChange={e=>setTruckFormData({...truckFormData, puc_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Fitness Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.fit_expiry} onChange={e=>setTruckFormData({...truckFormData, fit_expiry:e.target.value})} /></div>
                  <div><label style={{fontSize:'11px', color:'#9aadd4'}}>National Permit Expiry</label><input type="date" className="glass-input" style={{colorScheme:'dark'}} value={truckFormData.np_expiry} onChange={e=>setTruckFormData({...truckFormData, np_expiry:e.target.value})} /></div>
                </div>
             </div>

             <div style={{ padding: '20px', textAlign: 'right', background: '#0a1024', borderTop: '1px solid #18244a' }}>
               <button onClick={handleSaveTruck} disabled={loading} style={{ background: 'linear-gradient(135deg, #2fe39b, #2fe39b)', color: 'white', border: 'none', padding: '14px 30px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}>
                 {loading ? 'Saving...' : '💾 SAVE TRUCK & DOCS DATA'}
               </button>
             </div>
           </div>
         </div>
      )}
    </div>
  );
}