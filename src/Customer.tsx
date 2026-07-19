// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';
import { vGstin, vPan, vMobile, vPincode, gstinPanMatch, runChecks } from './lib/validators';

export default function Customer() {
  const [activeTab, setActiveTab] = useState('CORPORATE'); 
  
  // ----------------------------------------------------
  // 🏢 PART 1: CORPORATE CONTRACTS (MEGA FORM STATE)
  // ----------------------------------------------------
  const [customers, setCustomers] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]); 
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const [selectedVehicles, setSelectedVehicles] = useState<string[]>([]);
  const [showVehicleDropdown, setShowVehicleDropdown] = useState(false);
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [editingLocId, setEditingLocId] = useState<string | null>(null); 

  const getInitialFormData = () => ({
    customer_id: '', customer_name: '', address: '', state: '', pincode: '',
    gst_no: '', pan_no: '', contact_person: '', mobile_no: '', email: '', status: 'ACTIVE',
    opening_balance: '0', total_freight: '0', total_shortage: '0', total_tds: '0', total_received: '0', current_outstanding: '0',
    credit_limit: '0', payment_terms: '30 Days', account_manager: '',
    billing_cycle: '30_days', // '15_days' (Oil Cos, fortnightly) | '30_days' (regular monthly)
    detention_applicable: false, // ⏱️ oil companies: NO; AADHAR-style monthly clients: YES
    portal_access: false,
    portal_features: { live_tracking: true, ledger_invoices: true, place_orders: false, download_pods: true },
    locations: [], consignees: [] 
  });

  const [formData, setFormData] = useState(getInitialFormData());

  const [locForm, setLocForm] = useState({
    location_id: '', depot_name: '', depot_address: '', work_order_file: '', contract_expiry: '', rate_per_km: '', linked_vehicles: ''
  });

  const [rateForm, setRateForm] = useState({
    consignee_id: '', depot_link: '', registered_assessee: '', consignee_name: '', item_type: 'MS/HSD',
    rtkm_distance: '', start_date: new Date().toISOString().split('T')[0], rate_per_unit: '', fixed_hsd_qty: '', fixed_cash_amt: '', toll_amt: ''
  });

  // ----------------------------------------------------
  // 🌐 PART 2: EXTERNAL CUSTOMERS (KYC) STATE
  // ----------------------------------------------------
  const [externalCustomers, setExternalCustomers] = useState([]);
  const [isExternalModalOpen, setIsExternalModalOpen] = useState(false);
  const [editingExternalId, setEditingExternalId] = useState(null);
  
  const getInitialExternalForm = () => ({
    company_name: '', contact_person: '', mobile: '', email: '', 
    gst_no: '', pan_no: '', billing_address: '', city: '', state: '', status: 'APPROVED',
    portal_access: true, 
    portal_features: { live_tracking: true, ledger_invoices: true, place_orders: true, download_pods: true }
  });
  
  const [externalForm, setExternalForm] = useState(getInitialExternalForm());
  
  // --- ADMIN POWERS ---
  const [currentUser, setCurrentUser] = useState(null);
  const [canApprove, setCanApprove] = useState(false);

  useEffect(() => { 
    const user = JSON.parse(localStorage.getItem('prasad_user') || '{}');
    setCurrentUser(user);
    const hasPower = user.role === 'ADMIN' || user.role === 'Super Admin' || user.role === 'MANAGER' || 
                     user.permissions?.find(p => p.id === 'CUSTOMER')?.approve === true;
    setCanApprove(hasPower);

    fetchCustomers(); 
    fetchVehicles(); 
    fetchExternalCustomers(); 
  }, []);

  // --- FETCH FUNCTIONS ---
  const fetchCustomers = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "CUSTOMERS"));
      setCustomers(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchVehicles = async () => {
    try {
      const snap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
  };

  const fetchExternalCustomers = async () => {
    try {
      const q = query(collection(db, "EXTERNAL_CUSTOMERS"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      setExternalCustomers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };

  // --- CORPORATE LOGIC ---
  useEffect(() => {
    const ob = parseFloat(formData.opening_balance || '0') || 0;
    const tf = parseFloat(formData.total_freight || '0') || 0;
    const ts = parseFloat(formData.total_shortage || '0') || 0;
    const ttds = parseFloat(formData.total_tds || '0') || 0;
    const tr = parseFloat(formData.total_received || '0') || 0;
    const outstanding = ((ob + tf) - (ts + ttds + tr)).toFixed(2);
    setFormData(prev => ({ ...prev, current_outstanding: outstanding }));
  }, [formData.opening_balance, formData.total_freight, formData.total_shortage, formData.total_tds, formData.total_received]);

  const handleAddNew = () => {
    setFormData(getInitialFormData());
    setLocForm({ location_id: '', depot_name: '', depot_address: '', work_order_file: '', contract_expiry: '', rate_per_km: '', linked_vehicles: '' });
    setSelectedVehicles([]); setVehicleSearch(''); setEditingLocId(null);
    setRateForm({ consignee_id: '', depot_link: '', registered_assessee: '', consignee_name: '', item_type: 'MS/HSD', rtkm_distance: '', start_date: new Date().toISOString().split('T')[0], rate_per_unit: '', fixed_hsd_qty: '', fixed_cash_amt: '', toll_amt: '' });
    setEditingId(null); setShowForm(true);
  };

  const handleVehicleToggle = (vehicleNo: string) => {
    setSelectedVehicles(prev => prev.includes(vehicleNo) ? prev.filter(v => v !== vehicleNo) : [...prev, vehicleNo]);
  };

  const toggleFeature = (featureName) => {
    setFormData(prev => ({
      ...prev,
      portal_features: { ...prev.portal_features, [featureName]: !prev.portal_features[featureName] }
    }));
  };

  const handleSaveCustomer = async () => {
    if (!formData.customer_name) return alert("⚠️ Customer Name is required!");
    // ✅ Format validation (Truth Sprint) — GST/PAN/mobile/pincode were free text.
    const vErrors = runChecks([
      vGstin(formData.gst_no),
      vPan(formData.pan_no),
      gstinPanMatch(formData.gst_no, formData.pan_no),
      vMobile(formData.mobile_no),
      vPincode(formData.pincode),
    ]);
    if (vErrors.length) return alert("⚠️ Please fix these fields:\n\n• " + vErrors.join("\n• "));
    // 🚫 Duplicate guard — one unified customer record (name or GSTIN unique).
    const nrm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const dup = customers.find(c => c.id !== editingId && (
      nrm(c.customer_name) === nrm(formData.customer_name) ||
      (formData.gst_no && nrm(c.gst_no) === nrm(formData.gst_no))
    ));
    if (dup) return alert(`⚠️ Yeh customer pehle se hai: "${dup.customer_name}" (same name/GSTIN). Duplicate save nahi hoga — edit karein.`);
    try {
      if (editingId) {
        await updateDoc(doc(db, "CUSTOMERS", editingId), formData);
        alert("✅ Entire Customer Contract & Portal Access Updated!");
      } else {
        const docRef = await addDoc(collection(db, "CUSTOMERS"), { ...formData, createdAt: serverTimestamp() });
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: formData.customer_name, group: "Sundry Debtors", group_head: "Sundry Debtors", opening_balance: parseFloat(formData.opening_balance || '0'),
          current_balance: parseFloat(formData.opening_balance || '0'), creation_type: "AUTO_SYSTEM", linked_module: "CUSTOMER", linked_id: docRef.id, created_at: serverTimestamp()
        });
        alert("✅ New Customer Saved & Portal Access Configured!");
      }
      resetForm(); fetchCustomers();
    } catch (err) { alert("❌ Error saving data!"); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to completely erase ${name}?`)) {
      await deleteDoc(doc(db, "CUSTOMERS", id)); fetchCustomers();
    }
  };

  const toggleCorporateStatus = async (cust) => {
    if (!canApprove) return alert("Only Boss can change status!");
    const newStatus = cust.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await updateDoc(doc(db, "CUSTOMERS", cust.id), { status: newStatus });
    fetchCustomers();
  };

  const handleAddLocation = () => {
    if (!locForm.depot_name) return alert("⚠️ Depot Name is required!");
    const vehiclesString = selectedVehicles.join(', ');
    if (editingLocId) {
      setFormData(prev => ({ ...prev, locations: prev.locations.map(loc => loc.id === editingLocId ? { ...locForm, linked_vehicles: vehiclesString, id: loc.id } : loc) }));
      setEditingLocId(null);
    } else {
      setFormData(prev => ({ ...prev, locations: [...(prev.locations || []), { ...locForm, linked_vehicles: vehiclesString, id: Date.now().toString() }] }));
    }
    setLocForm({ location_id: '', depot_name: '', depot_address: '', work_order_file: '', contract_expiry: '', rate_per_km: '', linked_vehicles: '' });
    setSelectedVehicles([]); setShowVehicleDropdown(false); setVehicleSearch('');
  };

  const handleEditLocation = (loc: any) => {
    setLocForm({ ...loc, linked_vehicles: loc.linked_vehicles || '' });
    setSelectedVehicles(loc.linked_vehicles ? loc.linked_vehicles.split(', ') : []);
    setEditingLocId(loc.id);
  };

  const handleDeleteLocation = (id: string) => {
    setFormData(prev => ({ ...prev, locations: prev.locations.filter((loc: any) => loc.id !== id) }));
  };

  const handleAddRate = () => {
    if (!rateForm.consignee_name || !rateForm.depot_link) return alert("⚠️ Consignee Name & Depot Link are required!");
    setFormData(prev => ({ ...prev, consignees: [...(prev.consignees || []), { ...rateForm, id: Date.now().toString() }] }));
    setRateForm({ consignee_id: '', depot_link: '', registered_assessee: '', consignee_name: '', item_type: 'MS/HSD', rtkm_distance: '', start_date: new Date().toISOString().split('T')[0], rate_per_unit: '', fixed_hsd_qty: '', fixed_cash_amt: '', toll_amt: '' });
  };

  const handleDeleteRate = (id: string) => {
    setFormData(prev => ({ ...prev, consignees: prev.consignees.filter((c: any) => c.id !== id) }));
  };

  const resetForm = () => {
    setFormData(getInitialFormData()); setSelectedVehicles([]); setVehicleSearch(''); setEditingLocId(null); setShowForm(false); setEditingId(null);
  };

  // ----------------------------------------------------
  // 🌐 EXTERNAL KYC & AUTO-LEDGER LOGIC
  // ----------------------------------------------------
  const toggleExternalFeature = (featureName) => {
    setExternalForm(prev => ({
      ...prev,
      portal_features: { ...prev.portal_features, [featureName]: !prev.portal_features[featureName] }
    }));
  };

  const handleSaveExternal = async () => {
    if (!externalForm.company_name) return alert("Company Name is required!");
    setLoading(true);
    try {
      if (editingExternalId) {
        // Edit Existing
        await updateDoc(doc(db, "EXTERNAL_CUSTOMERS", editingExternalId), { ...externalForm, updatedAt: serverTimestamp() });
        alert("✅ External Customer Data & Portal Settings Updated!");
      } else {
        // Create New Customer
        const custId = 'EXT-' + Math.floor(Math.random() * 9000 + 1000);
        const docRef = await addDoc(collection(db, "EXTERNAL_CUSTOMERS"), { ...externalForm, customer_id: custId, createdAt: serverTimestamp() });
        
        // 🔥 AUTO-CREATE LEDGER ACCOUNT
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: externalForm.company_name, 
          group_head: "Sundry Debtors", 
          opening_balance: 0, 
          current_balance: 0, 
          creation_type: "AUTO_SYSTEM", 
          linked_module: "EXTERNAL_CUSTOMER", 
          linked_id: docRef.id, 
          created_at: serverTimestamp()
        });

        alert("✅ New Customer Saved, Portal Enabled & Auto-Ledger Created!");
      }
      setIsExternalModalOpen(false); 
      fetchExternalCustomers(); 
    } catch (e) { 
      alert("❌ Error saving Customer"); 
    }
    setLoading(false);
  };

  const toggleExternalStatus = async (cust) => {
    if(!canApprove) return alert("Only Admin can approve/block customers!");
    const newStatus = cust.status === 'APPROVED' ? 'BLOCKED' : 'APPROVED';
    await updateDoc(doc(db, "EXTERNAL_CUSTOMERS", cust.id), { status: newStatus });
    fetchExternalCustomers();
  };

  const handleDeleteExternal = async (id, name) => {
    if (window.confirm(`Delete ${name} permanently?`)) {
      await deleteDoc(doc(db, "EXTERNAL_CUSTOMERS", id)); fetchExternalCustomers();
    }
  };

  const filteredCustomers = customers.filter(c => c.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.4s; }
        .glass-card:hover { border-color: rgba(99, 102, 241, 0.5); box-shadow: 0 10px 30px -10px rgba(99, 102, 241, 0.3); }
        .gradient-text { background: linear-gradient(135deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; border: none; padding: 12px 25px; border-radius: 50px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 10px;}
        .glow-btn:hover { box-shadow: 0 0 25px rgba(124, 58, 237, 0.6); transform: scale(1.05); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 12px; color: white; padding: 10px 15px; outline: none; width: 100%; font-size: 13px; box-sizing: border-box;}
        .modern-input:focus { border-color: #818cf8; background: rgba(15, 23, 42, 0.9); }
        .data-table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px; }
        .data-table th { background: rgba(255, 255, 255, 0.05); color: #cbd5e1; padding: 12px; text-align: left; }
        .data-table td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #94a3b8; }
        .action-icon { cursor: pointer; padding: 5px; border-radius: 5px; transition: 0.2s; border: 1px solid transparent; }
        .action-icon:hover { border-color: #38bdf8; background: rgba(56,189,248,0.1); }
        .toggle-switch { position: relative; display: inline-block; width: 40px; height: 20px; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #334155; transition: .4s; border-radius: 20px; }
        .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #10b981; }
        input:checked + .slider:before { transform: translateX(20px); }
        .feature-card { background: rgba(15,23,42,0.6); border: 1px solid rgba(51,65,85,0.8); padding: 15px; border-radius: 12px; display: flex; justify-content: space-between; alignItems: center; transition: 0.3s; }
        .feature-card.active { border-color: #10b981; background: rgba(16,185,129,0.05); }
        .status-badge { font-size: 10px; font-weight: bold; padding: 5px 10px; border-radius: 10px; cursor: pointer; border: none; outline: none; }
        ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: rgba(129, 140, 248, 0.3); border-radius: 10px; }
      `}</style>

      {/* HEADER & TABS */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900' }}>Customer Master (CRM)</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0 15px 0' }}>Manage Contracts, Portal Access, and Verify External Clients.</p>
          
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setActiveTab('CORPORATE')} style={{ background: activeTab === 'CORPORATE' ? '#818cf8' : '#1e293b', color: activeTab === 'CORPORATE' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', transition: '0.3s' }}>
              🏢 Enterprise Contracts (IOCL/BPCL)
            </button>
            <button onClick={() => setActiveTab('EXTERNAL')} style={{ background: activeTab === 'EXTERNAL' ? '#10b981' : '#1e293b', color: activeTab === 'EXTERNAL' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', transition: '0.3s' }}>
              🌐 External B2B Customers (KYC)
            </button>
          </div>
        </div>

        {activeTab === 'CORPORATE' ? (
           <button className="glow-btn" onClick={handleAddNew}>+ Add Corporate Contract</button>
        ) : (
           <button onClick={() => { setExternalForm(getInitialExternalForm()); setEditingExternalId(null); setIsExternalModalOpen(true); }} style={{ background: '#10b981', color: 'white', padding: '12px 20px', borderRadius: '50px', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>+ Add External Customer</button>
        )}
      </div>

      {/* ============================================================== */}
      {/* 🏢 TAB 1: CORPORATE CONTRACTS */}
      {/* ============================================================== */}
      {activeTab === 'CORPORATE' && (
        <>
          <div style={{ position: 'relative', marginBottom: '35px' }}>
            <input className="modern-input" placeholder="Search by Corporate Name (e.g. IOCL)..." style={{ paddingLeft: '45px', fontSize: '16px', borderRadius: '50px' }} onChange={e => setSearchTerm(e.target.value)} />
            <span style={{ position: 'absolute', left: '18px', top: '12px', fontSize: '20px' }}>🔮</span>
          </div>

          {loading ? <p style={{color: '#818cf8'}}>Loading Database...</p> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '25px' }}>
              {filteredCustomers.map(c => (
                <div key={c.id} className="glass-card" style={{ padding: '25px', position: 'relative', border: c.status === 'INACTIVE' ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(255, 255, 255, 0.08)' }}>
                  
                  <div style={{ position: 'absolute', top: '-15px', right: '20px', display: 'flex', gap: '10px' }}>
                    <button onClick={() => toggleCorporateStatus(c)} style={{ background: c.status === 'ACTIVE' || !c.status ? '#10b981' : '#ef4444', color: '#fff', padding: '5px 15px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', border: 'none', cursor: canApprove ? 'pointer' : 'default', outline: 'none' }}>
                      {c.status === 'ACTIVE' || !c.status ? 'ACTIVE ✅' : 'INACTIVE 🚫'}
                    </button>
                    {c.portal_access && <div style={{ background: '#ec4899', color: '#fff', padding: '5px 15px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold' }}>Portal ON 🌐</div>}
                  </div>
                  
                  <div style={{ marginBottom: '15px', marginTop: '10px' }}>
                    <h2 style={{ color: '#f8fafc', margin: 0, fontSize: '24px' }}>{c.customer_name}</h2>
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '5px' }}>📝 GST: {c.gst_no || 'N/A'} | 📍 Depots: {c.locations?.length || 0}</div>
                  </div>
                  
                  <div style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: '15px', borderRadius: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>Company Outstanding</div>
                      <div style={{ color: '#10b981', fontWeight: 'bold', fontSize: '24px' }}>₹{c.current_outstanding || '0.00'}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '11px', color: '#94a3b8' }}>
                      <div>Total Freight: <span style={{ color: '#f8fafc' }}>₹{c.total_freight || '0'}</span></div>
                      <div>Total Received: <span style={{ color: '#38bdf8' }}>₹{c.total_received || '0'}</span></div>
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button onClick={() => { 
                      const initFeatures = { live_tracking: true, ledger_invoices: true, place_orders: false, download_pods: true };
                      setFormData({ ...c, portal_features: c.portal_features || initFeatures }); 
                      setEditingId(c.id); setShowForm(true); 
                    }} style={{ background: 'rgba(129, 140, 248, 0.1)', border: '1px solid #818cf8', color: '#818cf8', padding: '10px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontWeight: 'bold', transition: '0.3s' }}>
                      ✏️ Control Center
                    </button>
                    {canApprove && <button onClick={() => handleDelete(c.id, c.customer_name)} style={{ background: 'transparent', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 🚀 THE MEGA FORM (CORPORATE ONLY) */}
      {showForm && activeTab === 'CORPORATE' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1400px', height: '95vh', overflowY: 'auto', border: '1px solid #818cf8', display: 'flex', flexDirection: 'column', gap: '25px', background: '#0f172a' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 className="gradient-text" style={{ margin: 0, fontSize: '32px' }}>{editingId ? `Client Master: ${formData.customer_name}` : 'Setup New Master Contract'}</h2>
              <button onClick={resetForm} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '32px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#818cf8', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>1. CORPORATE DETAILS & SMART PROFILE</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '15px', background: 'rgba(129, 140, 248, 0.05)', padding: '20px', borderRadius: '10px' }}>
                <div><label style={{ fontSize:'11px', color:'#818cf8' }}>Customer ID</label><input className="modern-input" value={formData.customer_id} onChange={e=>setFormData({...formData, customer_id: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#818cf8', fontWeight: 'bold' }}>Corporate Name (IOCL/BPCL) *</label><input className="modern-input" value={formData.customer_name} onChange={e=>setFormData({...formData, customer_name: e.target.value.toUpperCase()})} /></div>
                <div><label style={{ fontSize:'11px', color:'#c084fc' }}>GST Number</label><input className="modern-input" value={formData.gst_no} onChange={e=>setFormData({...formData, gst_no: e.target.value.toUpperCase()})} /></div>
                <div><label style={{ fontSize:'11px', color:'#c084fc' }}>PAN Number</label><input className="modern-input" value={formData.pan_no} onChange={e=>setFormData({...formData, pan_no: e.target.value.toUpperCase()})} /></div>
                
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#94a3b8' }}>Billing Address</label><input className="modern-input" value={formData.address} onChange={e=>setFormData({...formData, address: e.target.value})} /></div>
                {/* Split fields — the old combined input could never save pincode and corrupted state on every edit */}
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>State</label><input className="modern-input" placeholder="State" value={formData.state} onChange={e=>setFormData({...formData, state: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Pincode</label><input className="modern-input" placeholder="6-digit Pincode" inputMode="numeric" maxLength={6} value={formData.pincode} onChange={e=>setFormData({...formData, pincode: e.target.value.replace(/[^\d]/g, '')})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Contact Person</label><input className="modern-input" value={formData.contact_person} onChange={e=>setFormData({...formData, contact_person: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Mobile No</label><input className="modern-input" value={formData.mobile_no} onChange={e=>setFormData({...formData, mobile_no: e.target.value})} /></div>

                <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Credit Limit (₹)</label><input type="number" className="modern-input" style={{borderColor:'#10b981'}} value={formData.credit_limit} onChange={e=>setFormData({...formData, credit_limit: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b' }}>Payment Terms</label>
                  <select className="modern-input" value={formData.payment_terms} onChange={e=>setFormData({...formData, payment_terms: e.target.value})}>
                    <option>Advance</option><option>15 Days</option><option>30 Days</option><option>45 Days</option><option>60 Days</option>
                  </select>
                </div>
                <div><label style={{ fontSize:'11px', color:'#c084fc', fontWeight:'bold' }}>🗓️ Billing Cycle (Auto-Billing)</label>
                  <select className="modern-input" style={{ borderColor: '#c084fc' }} value={formData.billing_cycle || '30_days'} onChange={e=>setFormData({...formData, billing_cycle: e.target.value})}>
                    <option value="30_days">30 Days — Monthly (Regular)</option>
                    <option value="15_days">15 Days — Fortnightly (Oil Companies)</option>
                  </select>
                </div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b', fontWeight:'bold' }}>⏱️ Detention Billing</label>
                  {/* Har company ka bill style alag: oil-company Transportation Bills me detention NAHI hota; AADHAR jaise clients ke monthly bills me hota hai */}
                  <select className="modern-input" style={{ borderColor: '#f59e0b' }} value={formData.detention_applicable === true ? 'YES' : 'NO'} onChange={e=>setFormData({...formData, detention_applicable: e.target.value === 'YES'})}>
                    <option value="NO">Not Applicable (Oil Companies)</option>
                    <option value="YES">Applicable (AADHAR-style bills)</option>
                  </select>
                </div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Key Account Manager</label><input className="modern-input" placeholder="Admin/Staff Name" value={formData.account_manager} onChange={e=>setFormData({...formData, account_manager: e.target.value})} /></div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '15px', background: 'rgba(16, 185, 129, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Opening Balance (+)</label><input type="number" className="modern-input" value={formData.opening_balance} onChange={e=>setFormData({...formData, opening_balance: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Total Freight (+)</label><input type="number" className="modern-input" value={formData.total_freight} onChange={e=>setFormData({...formData, total_freight: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Shortage Deduction (-)</label><input type="number" className="modern-input" value={formData.total_shortage} onChange={e=>setFormData({...formData, total_shortage: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b' }}>TDS Deduction (-)</label><input type="number" className="modern-input" value={formData.total_tds} onChange={e=>setFormData({...formData, total_tds: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981' }}>Amount Received (-)</label><input type="number" className="modern-input" value={formData.total_received} onChange={e=>setFormData({...formData, total_received: e.target.value})} /></div>
                <div>
                  <label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Current Outstanding</label>
                  <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '10px', borderRadius: '10px', border: '1px solid #10b981', color: '#10b981', fontWeight: 'bold', fontSize: '16px' }}>₹ {formData.current_outstanding}</div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#ec4899', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>2. CLIENT PORTAL ACCESS & FEATURE PERMISSIONS</h3>
              <div style={{ background: 'rgba(236, 72, 153, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(236, 72, 153, 0.3)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px dashed rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#fff' }}>Enable Customer Portal Login</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>Allow this client to login to the external dashboard.</div>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={formData.portal_access} onChange={(e) => setFormData({...formData, portal_access: e.target.checked})} />
                    <span className="slider"></span>
                  </label>
                </div>
                {formData.portal_access && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px' }}>
                    <div className={`feature-card ${formData.portal_features?.live_tracking ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>📍 Live GPS Tracking</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can track active trips</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={formData.portal_features?.live_tracking} onChange={() => toggleFeature('live_tracking')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${formData.portal_features?.ledger_invoices ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🧾 Invoices & Ledger</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can view billing data</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={formData.portal_features?.ledger_invoices} onChange={() => toggleFeature('ledger_invoices')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${formData.portal_features?.place_orders ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🛒 Place New Orders</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Can punch indents</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={formData.portal_features?.place_orders} onChange={() => toggleFeature('place_orders')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${formData.portal_features?.download_pods ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>📄 Download PODs</div><div style={{ color: '#94a3b8', fontSize: '11px' }}>Access proof of delivery</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={formData.portal_features?.download_pods} onChange={() => toggleFeature('download_pods')} /><span className="slider"></span></label>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#f59e0b', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>3. LOCATION & VEHICLE CONTRACT (LOADING DEPOTS)</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '15px', background: editingLocId ? 'rgba(56, 189, 248, 0.1)' : 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', alignItems: 'end', border: editingLocId ? '1px dashed #38bdf8' : 'none' }}>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Location ID</label><input className="modern-input" value={locForm.location_id} onChange={e=>setLocForm({...locForm, location_id: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color: editingLocId ? '#38bdf8' : '#f59e0b', fontWeight: 'bold' }}>Depot Name *</label><input className="modern-input" value={locForm.depot_name} onChange={e=>setLocForm({...locForm, depot_name: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 2', position: 'relative' }}>
                  <label style={{ fontSize:'11px', color:'#38bdf8', fontWeight:'bold' }}>🚛 Attach Vehicles</label>
                  <div onClick={() => setShowVehicleDropdown(!showVehicleDropdown)} style={{ background: 'rgba(15, 23, 42, 0.6)', border: '1px solid #38bdf8', borderRadius: '12px', padding: '10px 15px', color: selectedVehicles.length > 0 ? '#fff' : '#94a3b8', fontSize: '13px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>{selectedVehicles.length === 0 ? '-- Select --' : `${selectedVehicles.length} Selected`}</span><span>▼</span>
                  </div>
                  {showVehicleDropdown && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '8px', marginTop: '5px', zIndex: 50, maxHeight: '200px', overflowY: 'auto' }}>
                      <div style={{ padding: '10px', position: 'sticky', top: 0, background: '#1e293b' }}><input type="text" placeholder="Search..." value={vehicleSearch} onChange={(e) => setVehicleSearch(e.target.value)} style={{ width: '100%', padding: '5px' }} /></div>
                      {vehicles.filter(v=>v.vehicle_no?.toLowerCase().includes(vehicleSearch.toLowerCase())).map(v => (
                        <div key={v.id} style={{ padding: '8px 15px', display: 'flex', gap: '10px', cursor: 'pointer' }} onClick={() => handleVehicleToggle(v.vehicle_no)}>
                          <input type="checkbox" checked={selectedVehicles.includes(v.vehicle_no)} readOnly /> <span style={{ color: 'white', fontSize: '12px' }}>{v.vehicle_no}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Expiry</label><input type="date" className="modern-input" value={locForm.contract_expiry} onChange={e=>setLocForm({...locForm, contract_expiry: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div><label style={{ fontSize:'11px', color:'#10b981' }}>Rate / KM</label><input type="number" className="modern-input" value={locForm.rate_per_km} onChange={e=>setLocForm({...locForm, rate_per_km: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 7', textAlign: 'right', marginTop: '10px' }}><button className="glow-btn" style={{ background: editingLocId ? 'linear-gradient(135deg, #38bdf8, #2563eb)' : 'linear-gradient(135deg, #f59e0b, #d97706)', padding: '10px 30px', fontSize: '12px', display:'inline-flex' }} onClick={handleAddLocation}>{editingLocId ? "💾 UPDATE DEPOT DATA" : "+ ADD DEPOT"}</button></div>
              </div>
              {formData.locations?.length > 0 && (
                <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '10px' }}>
                  <table className="data-table">
                    <thead><tr><th>ID</th><th>Depot Name</th><th style={{ color: '#38bdf8' }}>🚛 Vehicles</th><th>Expiry</th><th>Rate/KM</th><th style={{textAlign:'center'}}>Actions</th></tr></thead>
                    <tbody>
                      {formData.locations.map((d:any, i) => (
                        <tr key={i} style={{ background: editingLocId === d.id ? 'rgba(56, 189, 248, 0.1)' : 'transparent' }}>
                          <td>{d.location_id||'-'}</td><td style={{color:'#fff', fontWeight:'bold'}}>{d.depot_name}</td><td style={{color:'#38bdf8'}}>{d.linked_vehicles || 'None'}</td>
                          <td style={{color:'#ef4444'}}>{d.contract_expiry||'-'}</td><td>{d.rate_per_km||'-'}</td>
                          <td style={{textAlign:'center'}}><span className="action-icon" onClick={() => handleEditLocation(d)}>✏️</span><span className="action-icon" onClick={() => handleDeleteLocation(d.id)} style={{color: '#ef4444'}}>🗑️</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#c084fc', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>4. CONSIGNEES & RTKM RATE REVISIONS</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '15px', background: 'rgba(192, 132, 252, 0.05)', padding: '20px', borderRadius: '10px', alignItems: 'end' }}>
                <div><label style={{ fontSize:'11px', color:'#c084fc', fontWeight:'bold' }}>Select Depot *</label><select className="modern-input" style={{ border: '1px solid #c084fc' }} value={rateForm.depot_link} onChange={e=>setRateForm({...rateForm, depot_link: e.target.value})}><option value="">-- Choose Depot --</option>{formData.locations?.map((d:any) => <option key={d.id} value={d.depot_name}>{d.depot_name}</option>)}</select></div>
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#fff', fontWeight:'bold' }}>Consignee Name *</label><input className="modern-input" value={rateForm.consignee_name} onChange={e=>setRateForm({...rateForm, consignee_name: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Item Type</label><input className="modern-input" value={rateForm.item_type} onChange={e=>setRateForm({...rateForm, item_type: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b' }}>RTKM Distance</label><input type="number" className="modern-input" value={rateForm.rtkm_distance} onChange={e=>setRateForm({...rateForm, rtkm_distance: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>📅 Effective From *</label><input type="date" className="modern-input" style={{ border: '2px solid #10b981', colorScheme: 'dark' }} value={rateForm.start_date} onChange={e=>setRateForm({...rateForm, start_date: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981' }}>Rate Amt/Unit</label><input type="number" className="modern-input" value={rateForm.rate_per_unit} onChange={e=>setRateForm({...rateForm, rate_per_unit: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Fixed HSD</label><input type="number" className="modern-input" value={rateForm.fixed_hsd_qty} onChange={e=>setRateForm({...rateForm, fixed_hsd_qty: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Fixed Cash</label><input type="number" className="modern-input" value={rateForm.fixed_cash_amt} onChange={e=>setRateForm({...rateForm, fixed_cash_amt: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Toll Amount</label><input type="number" className="modern-input" value={rateForm.toll_amt} onChange={e=>setRateForm({...rateForm, toll_amt: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 5', textAlign: 'right', marginTop: '10px' }}><button className="glow-btn" style={{ background: 'linear-gradient(135deg, #c084fc, #9333ea)', padding: '10px 30px', fontSize: '12px', display:'inline-flex' }} onClick={handleAddRate}>+ ADD RATE</button></div>
              </div>
              {formData.consignees?.length > 0 && (
                <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '10px' }}>
                  <table className="data-table">
                    <thead><tr><th>From</th><th>To</th><th>RTKM</th><th style={{color:'#10b981'}}>Effective</th><th>Rate</th><th>HSD</th><th>Cash</th><th>Toll</th><th>Action</th></tr></thead>
                    <tbody>
                      {formData.consignees.map((c:any, i) => (
                        <tr key={i}>
                          <td style={{color:'#38bdf8'}}>{c.depot_link}</td><td style={{color:'#fff'}}>{c.consignee_name}</td>
                          <td style={{color:'#f59e0b'}}>{c.rtkm_distance} KM</td><td style={{color:'#10b981'}}>{c.start_date}</td>
                          <td style={{color:'#10b981'}}>₹{c.rate_per_unit}</td><td>{c.fixed_hsd_qty}L</td><td>₹{c.fixed_cash_amt}</td><td style={{color:'#ef4444'}}>₹{c.toll_amt}</td>
                          <td><span className="action-icon" onClick={() => handleDeleteRate(c.id)} style={{color: '#ef4444'}}>🗑️</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={{ textAlign: 'center', marginTop: '20px', padding: '20px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <button className="glow-btn" style={{ fontSize: '18px', padding: '20px 60px', width: '100%', background: 'linear-gradient(135deg, #10b981, #059669)', justifyContent: 'center' }} onClick={handleSaveCustomer}>
                {editingId ? "💾 UPDATE ENTIRE CONTRACT DATA" : "💾 SAVE NEW CORPORATE CONTRACT TO SERVER"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* 🌐 TAB 2: EXTERNAL CUSTOMERS (FULL VIEW)                        */}
      {/* ============================================================== */}
      {activeTab === 'EXTERNAL' && (
        <div style={{ background: 'rgba(30, 41, 59, 0.4)', borderRadius: '15px', border: '1px solid #1e293b', padding: '20px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', borderBottom: '1px solid #334155' }}>
                <th style={{ padding: '15px' }}>Company Name & ID</th>
                <th style={{ padding: '15px' }}>Contact Details</th>
                <th style={{ padding: '15px' }}>Portal Access</th>
                <th style={{ padding: '15px' }}>Status</th>
                <th style={{ padding: '15px', textAlign: 'right' }}>Admin Actions</th>
              </tr>
            </thead>
            <tbody>
              {externalCustomers.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #0f172a' }}>
                  <td style={{ padding: '15px' }}>
                    <b style={{color: '#fff', fontSize: '15px'}}>{c.company_name}</b><br/>
                    <small style={{color:'#38bdf8'}}>{c.customer_id || 'PENDING'}</small>
                  </td>
                  <td style={{ padding: '15px' }}>👤 {c.contact_person}<br/><span style={{color:'#94a3b8'}}>📞 {c.mobile}</span><br/><span style={{color:'#94a3b8', fontSize:'10px'}}>📧 {c.email || 'N/A'}</span></td>
                  
                  <td style={{ padding: '15px' }}>
                    {c.portal_access ? (
                      <span style={{ fontSize: '10px', background: 'rgba(236, 72, 153, 0.2)', color: '#ec4899', padding: '4px 8px', borderRadius: '10px', fontWeight: 'bold' }}>Active 🌐</span>
                    ) : (
                      <span style={{ fontSize: '10px', background: 'rgba(148, 163, 184, 0.2)', color: '#94a3b8', padding: '4px 8px', borderRadius: '10px', fontWeight: 'bold' }}>Disabled 🚫</span>
                    )}
                  </td>
                  
                  <td style={{ padding: '15px' }}>
                    <button onClick={() => toggleExternalStatus(c)} className="status-badge" style={{ background: c.status === 'APPROVED' ? 'rgba(16, 185, 129, 0.2)' : (c.status === 'BLOCKED' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)'), color: c.status === 'APPROVED' ? '#10b981' : (c.status === 'BLOCKED' ? '#ef4444' : '#f59e0b'), border: 'none', cursor: canApprove ? 'pointer' : 'default' }}>
                      {c.status === 'APPROVED' ? 'ACTIVE ✅' : (c.status === 'BLOCKED' ? 'BLOCKED 🚫' : 'PENDING ⏳')}
                    </button>
                  </td>
                  
                  <td style={{ padding: '15px', textAlign: 'right', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button style={{ background: 'transparent', padding: '6px 10px', border: '1px solid #3b82f6', color: '#38bdf8', borderRadius: '6px', cursor: 'pointer', fontSize: '11px' }} onClick={() => { setExternalForm({...c, portal_features: c.portal_features || {live_tracking:true, ledger_invoices:true, place_orders:false, download_pods:true} }); setEditingExternalId(c.id); setIsExternalModalOpen(true); }}>✏️ Edit / Portal Setup</button>
                    {canApprove && <button style={{ background: 'transparent', padding: '6px 10px', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '6px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleDeleteExternal(c.id, c.company_name)}>🗑️</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* EXTERNAL CUSTOMER ADD/EDIT MODAL (NEW SMART VERSION WITH AUTO LEDGER) */}
      {isExternalModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '800px', borderRadius: '20px', border: '1px solid #10b981', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', background: '#020617' }}>
              <h2 style={{ color: '#10b981', margin: 0 }}>{editingExternalId ? '🔍 Setup External Customer' : '➕ Add External Customer'}</h2>
              <button onClick={() => setIsExternalModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ padding: '25px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', overflowY: 'auto', maxHeight: '70vh' }}>
              <div style={{gridColumn: 'span 2'}}><label style={{fontSize:'11px', color:'#38bdf8', fontWeight:'bold'}}>Company Name *</label><input className="modern-input" value={externalForm.company_name} onChange={e => setExternalForm({...externalForm, company_name: e.target.value})} /></div>
              
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Contact Person</label><input className="modern-input" value={externalForm.contact_person} onChange={e => setExternalForm({...externalForm, contact_person: e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Mobile Number</label><input className="modern-input" value={externalForm.mobile} onChange={e => setExternalForm({...externalForm, mobile: e.target.value})} /></div>
              
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Email Address (For Portal Login)</label><input className="modern-input" value={externalForm.email} onChange={e => setExternalForm({...externalForm, email: e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Approval Status</label>
                <select className="modern-input" value={externalForm.status} onChange={e => setExternalForm({...externalForm, status: e.target.value})} disabled={!canApprove}>
                  <option value="APPROVED">ACTIVE (Approved)</option>
                  <option value="PENDING">PENDING KYC</option>
                  <option value="BLOCKED">BLOCKED / INACTIVE</option>
                </select>
              </div>

              <div><label style={{fontSize:'11px', color:'#10b981', fontWeight:'bold'}}>GST Number</label><input className="modern-input" style={{borderColor:'#10b981'}} value={externalForm.gst_no} onChange={e => setExternalForm({...externalForm, gst_no: e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#10b981', fontWeight:'bold'}}>PAN Number</label><input className="modern-input" style={{borderColor:'#10b981'}} value={externalForm.pan_no} onChange={e => setExternalForm({...externalForm, pan_no: e.target.value})} /></div>

              <div style={{gridColumn: 'span 2'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>Billing Address</label><input className="modern-input" value={externalForm.billing_address} onChange={e => setExternalForm({...externalForm, billing_address: e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>City</label><input className="modern-input" value={externalForm.city} onChange={e => setExternalForm({...externalForm, city: e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>State</label><input className="modern-input" value={externalForm.state} onChange={e => setExternalForm({...externalForm, state: e.target.value})} /></div>

              {/* EXTERNAL PORTAL CONTROL */}
              <div style={{ gridColumn: 'span 2', background: 'rgba(236, 72, 153, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(236, 72, 153, 0.3)', marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px dashed rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#fff' }}>Enable Customer Portal Login</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>Allow this client to login to the external dashboard. Auto-Ledger will be created.</div>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={externalForm.portal_access} onChange={(e) => setExternalForm({...externalForm, portal_access: e.target.checked})} />
                    <span className="slider"></span>
                  </label>
                </div>

                {externalForm.portal_access && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px' }}>
                    <div className={`feature-card ${externalForm.portal_features?.live_tracking ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>📍 Live GPS Tracking</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={externalForm.portal_features?.live_tracking} onChange={() => toggleExternalFeature('live_tracking')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${externalForm.portal_features?.ledger_invoices ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🧾 Invoices & Ledger</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={externalForm.portal_features?.ledger_invoices} onChange={() => toggleExternalFeature('ledger_invoices')} /><span className="slider"></span></label>
                    </div>
                    <div className={`feature-card ${externalForm.portal_features?.place_orders ? 'active' : ''}`}>
                      <div><div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>🛒 Place New Orders</div></div>
                      <label className="toggle-switch"><input type="checkbox" checked={externalForm.portal_features?.place_orders} onChange={() => toggleExternalFeature('place_orders')} /><span className="slider"></span></label>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ padding: '20px', textAlign: 'right', background: '#020617', borderTop: '1px solid #1e293b' }}>
              <button onClick={handleSaveExternal} disabled={loading} style={{ background: '#10b981', color: 'white', border: 'none', padding: '12px 30px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                {loading ? 'Saving...' : '💾 Save External Customer & Generate Ledger'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}