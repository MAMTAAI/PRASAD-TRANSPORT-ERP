// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function Customer() {
  const [customers, setCustomers] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]); 
  
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // 🚙 Multi-Select Vehicle State & Search
  const [selectedVehicles, setSelectedVehicles] = useState<string[]>([]);
  const [showVehicleDropdown, setShowVehicleDropdown] = useState(false);
  const [vehicleSearch, setVehicleSearch] = useState(''); // 🔍 नया सर्च स्टेट

  // ✏️ Edit Depot State
  const [editingLocId, setEditingLocId] = useState<string | null>(null); 

  const getInitialFormData = () => ({
    customer_id: '', customer_name: '', address: '', state: '', pincode: '',
    gst_no: '', pan_no: '', contact_person: '', mobile_no: '', email: '',
    opening_balance: '0', total_freight: '0', total_shortage: '0', total_tds: '0', total_received: '0', current_outstanding: '0',
    locations: [], 
    consignees: [] 
  });

  const [formData, setFormData] = useState(getInitialFormData());

  const [locForm, setLocForm] = useState({
    location_id: '', depot_name: '', depot_address: '', work_order_file: '', contract_expiry: '', rate_per_km: '', linked_vehicles: ''
  });

  const [rateForm, setRateForm] = useState({
    consignee_id: '', depot_link: '', registered_assessee: '', consignee_name: '', item_type: 'MS/HSD',
    rtkm_distance: '', start_date: new Date().toISOString().split('T')[0], rate_per_unit: '', fixed_hsd_qty: '', fixed_cash_amt: '', toll_amt: ''
  });

  useEffect(() => { 
    fetchCustomers(); 
    fetchVehicles(); 
  }, []);

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

  useEffect(() => {
    const ob = parseFloat(formData.opening_balance || '0');
    const tf = parseFloat(formData.total_freight || '0');
    const ts = parseFloat(formData.total_shortage || '0');
    const ttds = parseFloat(formData.total_tds || '0');
    const tr = parseFloat(formData.total_received || '0');
    const outstanding = ((ob + tf) - (ts + ttds + tr)).toFixed(2);
    setFormData(prev => ({ ...prev, current_outstanding: outstanding }));
  }, [formData.opening_balance, formData.total_freight, formData.total_shortage, formData.total_tds, formData.total_received]);

  const handleAddNew = () => {
    setFormData(getInitialFormData());
    setLocForm({ location_id: '', depot_name: '', depot_address: '', work_order_file: '', contract_expiry: '', rate_per_km: '', linked_vehicles: '' });
    setSelectedVehicles([]); 
    setVehicleSearch('');
    setEditingLocId(null);
    setRateForm({ consignee_id: '', depot_link: '', registered_assessee: '', consignee_name: '', item_type: 'MS/HSD', rtkm_distance: '', start_date: new Date().toISOString().split('T')[0], rate_per_unit: '', fixed_hsd_qty: '', fixed_cash_amt: '', toll_amt: '' });
    setEditingId(null);
    setShowForm(true);
  };

  const handleVehicleToggle = (vehicleNo: string) => {
    setSelectedVehicles(prev => {
      const isSelected = prev.includes(vehicleNo);
      if (isSelected) {
        return prev.filter(v => v !== vehicleNo);
      } else {
        return [...prev, vehicleNo];
      }
    });
  };

  const handleSaveCustomer = async () => {
    if (!formData.customer_name) return alert("⚠️ Customer Name (e.g. IOCL/BPCL) is required!");
    try {
      if (editingId) {
        await updateDoc(doc(db, "CUSTOMERS", editingId), formData);
        alert("✅ Entire Customer & Contract Updated Successfully!");
      } else {
        const docRef = await addDoc(collection(db, "CUSTOMERS"), { ...formData, createdAt: serverTimestamp() });
        
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: formData.customer_name,         
          group_head: "Sundry Debtors",                
          opening_balance: parseFloat(formData.opening_balance || 0), 
          current_balance: parseFloat(formData.opening_balance || 0),
          creation_type: "AUTO_SYSTEM",
          linked_module: "CUSTOMER",
          linked_id: docRef.id,
          created_at: serverTimestamp()
        });

        alert("✅ New Customer Saved & Sundry Debtors Ledger Created!");
      }
      resetForm(); fetchCustomers();
    } catch (err) { alert("❌ Error saving data to the server!"); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to completely erase ${name} from the system?`)) {
      await deleteDoc(doc(db, "CUSTOMERS", id));
      fetchCustomers();
    }
  };

  // ✏️ Handle Add / Update Location (Depot)
  const handleAddLocation = () => {
    if (!locForm.depot_name) return alert("⚠️ Depot Name is required!");
    const vehiclesString = selectedVehicles.join(', ');

    if (editingLocId) {
      // 💾 Update Existing Depot
      setFormData(prev => ({ 
        ...prev, 
        locations: prev.locations.map(loc => loc.id === editingLocId ? { ...locForm, linked_vehicles: vehiclesString, id: loc.id } : loc)
      }));
      setEditingLocId(null);
    } else {
      // ➕ Add New Depot
      setFormData(prev => ({ 
        ...prev, 
        locations: [...(prev.locations || []), { ...locForm, linked_vehicles: vehiclesString, id: Date.now().toString() }] 
      }));
    }
    
    // Reset Form
    setLocForm({ location_id: '', depot_name: '', depot_address: '', work_order_file: '', contract_expiry: '', rate_per_km: '', linked_vehicles: '' });
    setSelectedVehicles([]); 
    setShowVehicleDropdown(false);
    setVehicleSearch('');
  };

  // ✏️ Edit Depot Button Click
  const handleEditLocation = (loc: any) => {
    setLocForm({
      location_id: loc.location_id || '',
      depot_name: loc.depot_name || '',
      depot_address: loc.depot_address || '',
      work_order_file: loc.work_order_file || '',
      contract_expiry: loc.contract_expiry || '',
      rate_per_km: loc.rate_per_km || '',
      linked_vehicles: loc.linked_vehicles || ''
    });
    setSelectedVehicles(loc.linked_vehicles ? loc.linked_vehicles.split(', ') : []);
    setEditingLocId(loc.id);
  };

  // 🗑️ Delete Depot Button Click
  const handleDeleteLocation = (id: string) => {
    setFormData(prev => ({
      ...prev,
      locations: prev.locations.filter((loc: any) => loc.id !== id)
    }));
  };

  const handleAddRate = () => {
    if (!rateForm.consignee_name || !rateForm.depot_link) return alert("⚠️ Consignee Name & Depot Link are required!");
    if (!rateForm.start_date) return alert("⚠️ Effective Date is required for Rate Revisions!");
    setFormData(prev => ({ ...prev, consignees: [...(prev.consignees || []), { ...rateForm, id: Date.now().toString() }] }));
    setRateForm({ consignee_id: '', depot_link: '', registered_assessee: '', consignee_name: '', item_type: 'MS/HSD', rtkm_distance: '', start_date: new Date().toISOString().split('T')[0], rate_per_unit: '', fixed_hsd_qty: '', fixed_cash_amt: '', toll_amt: '' });
  };

  const resetForm = () => {
    setFormData(getInitialFormData());
    setSelectedVehicles([]);
    setVehicleSearch('');
    setEditingLocId(null);
    setShowForm(false); setEditingId(null);
  };

  const filteredCustomers = customers.filter(c => c.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()));

  // 🔍 Filter vehicles based on search text
  const filteredVehicles = vehicles.filter(v => v.vehicle_no?.toLowerCase().includes(vehicleSearch.toLowerCase()));

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.4s; }
        .glass-card:hover { border-color: rgba(99, 102, 241, 0.5); box-shadow: 0 10px 30px -10px rgba(99, 102, 241, 0.3); }
        .gradient-text { background: linear-gradient(135deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; border: none; padding: 12px 25px; border-radius: 50px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 10px;}
        .glow-btn:hover { box-shadow: 0 0 25px rgba(124, 58, 237, 0.6); transform: scale(1.05); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 12px; color: white; padding: 10px 15px; outline: none; width: 100%; font-size: 13px; box-sizing: border-box;}
        .modern-input:focus { border-color: #818cf8; box-shadow: 0 0 15px rgba(129, 140, 248, 0.3); background: rgba(15, 23, 42, 0.9); }
        .data-table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px; }
        .data-table th { background: rgba(255, 255, 255, 0.05); color: #cbd5e1; padding: 12px; text-align: left; }
        .data-table td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #94a3b8; }
        .action-icon { cursor: pointer; padding: 5px; border-radius: 5px; transition: 0.2s; border: 1px solid transparent; }
        .action-icon:hover { border-color: #38bdf8; background: rgba(56,189,248,0.1); }
        ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: rgba(129, 140, 248, 0.3); border-radius: 10px; }
        
        /* Dropdown Scrollbar */
        .multi-select-dropdown::-webkit-scrollbar { width: 6px; }
        .multi-select-dropdown::-webkit-scrollbar-thumb { background: #38bdf8; border-radius: 10px; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900' }}>Enterprise Contracts Hub</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Manage Corporate Customers, Depots, & Fleet Mapping</p>
        </div>
        <button className="glow-btn" onClick={handleAddNew}>
          <span style={{ fontSize: '20px' }}>+</span> Add Corporate Contract
        </button>
      </div>

      <div style={{ position: 'relative', marginBottom: '35px' }}>
        <input className="modern-input" placeholder="Scan database by Customer Name (e.g. IOCL, BPCL)..." style={{ paddingLeft: '45px', fontSize: '16px', borderRadius: '50px' }} onChange={e => setSearchTerm(e.target.value)} />
        <span style={{ position: 'absolute', left: '18px', top: '12px', fontSize: '20px' }}>🔮</span>
      </div>

      {/* Grid View of Customers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '25px' }}>
        {filteredCustomers.map(c => (
          <div key={c.id} className="glass-card" style={{ padding: '25px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: '-15px', right: '20px', background: '#818cf8', color: '#fff', padding: '5px 15px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold' }}>
              {c.locations?.length || 0} Depots | {c.consignees?.length || 0} Rates
            </div>
            
            <div style={{ marginBottom: '15px', marginTop: '10px' }}>
              <h2 style={{ color: '#f8fafc', margin: 0, fontSize: '26px' }}>{c.customer_name}</h2>
              <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '5px' }}>📝 GST: {c.gst_no || 'N/A'}</div>
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
              <button onClick={() => { setFormData(c); setEditingId(c.id); setShowForm(true); }} style={{ background: 'rgba(129, 140, 248, 0.1)', border: '1px solid #818cf8', color: '#818cf8', padding: '10px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontWeight: 'bold', transition: '0.3s' }}>Manage Contract & Rates</button>
              <button onClick={() => handleDelete(c.id, c.customer_name)} style={{ background: 'transparent', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* 🚀 THE ALL-IN-ONE MEGA FORM */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1400px', height: '95vh', overflowY: 'auto', border: '1px solid #818cf8', display: 'flex', flexDirection: 'column', gap: '25px', background: '#0f172a' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 className="gradient-text" style={{ margin: 0, fontSize: '32px' }}>{editingId ? `Contract Master: ${formData.customer_name}` : 'Setup New Master Contract'}</h2>
              <button onClick={resetForm} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '32px', cursor: 'pointer' }}>✕</button>
            </div>

            {/* 🏢 PART 1: CORPORATE DETAILS & LEDGER */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#818cf8', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>1. CORPORATE DETAILS & MASTER LEDGER</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '15px', background: 'rgba(129, 140, 248, 0.05)', padding: '20px', borderRadius: '10px' }}>
                <div><label style={{ fontSize:'11px', color:'#818cf8' }}>Customer ID</label><input className="modern-input" value={formData.customer_id} onChange={e=>setFormData({...formData, customer_id: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#818cf8', fontWeight: 'bold' }}>Corporate Name (IOCL/BPCL) *</label><input className="modern-input" value={formData.customer_name} onChange={e=>setFormData({...formData, customer_name: e.target.value.toUpperCase()})} /></div>
                <div><label style={{ fontSize:'11px', color:'#c084fc' }}>GST Number</label><input className="modern-input" value={formData.gst_no} onChange={e=>setFormData({...formData, gst_no: e.target.value.toUpperCase()})} /></div>
                <div><label style={{ fontSize:'11px', color:'#c084fc' }}>PAN Number</label><input className="modern-input" value={formData.pan_no} onChange={e=>setFormData({...formData, pan_no: e.target.value.toUpperCase()})} /></div>
                
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#94a3b8' }}>Billing Address</label><input className="modern-input" value={formData.address} onChange={e=>setFormData({...formData, address: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>State & Pincode</label><input className="modern-input" placeholder="State - Pincode" value={`${formData.state} ${formData.pincode}`} onChange={e=>setFormData({...formData, state: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Contact Person</label><input className="modern-input" value={formData.contact_person} onChange={e=>setFormData({...formData, contact_person: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Mobile No</label><input className="modern-input" value={formData.mobile_no} onChange={e=>setFormData({...formData, mobile_no: e.target.value})} /></div>
              </div>

              {/* 💵 SMART AUTO LEDGER */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '15px', background: 'rgba(16, 185, 129, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Opening Balance (+)</label><input type="number" className="modern-input" value={formData.opening_balance} onChange={e=>setFormData({...formData, opening_balance: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Total Freight (+)</label><input type="number" className="modern-input" value={formData.total_freight} onChange={e=>setFormData({...formData, total_freight: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Shortage Deduction (-)</label><input type="number" className="modern-input" value={formData.total_shortage} onChange={e=>setFormData({...formData, total_shortage: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b' }}>TDS Deduction (-)</label><input type="number" className="modern-input" value={formData.total_tds} onChange={e=>setFormData({...formData, total_tds: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981' }}>Amount Received (-)</label><input type="number" className="modern-input" value={formData.total_received} onChange={e=>setFormData({...formData, total_received: e.target.value})} /></div>
                <div>
                  <label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Current Outstanding</label>
                  <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '10px', borderRadius: '10px', border: '1px solid #10b981', color: '#10b981', fontWeight: 'bold', fontSize: '16px' }}>
                    ₹ {formData.current_outstanding}
                  </div>
                </div>
              </div>
            </div>

            {/* 📍 PART 2: LOCATION / DEPOT MASTER WITH MULTI-VEHICLE ATTACHMENT */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#f59e0b', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>2. LOCATION & VEHICLE CONTRACT (LOADING DEPOTS)</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '15px', background: editingLocId ? 'rgba(56, 189, 248, 0.1)' : 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', alignItems: 'end', border: editingLocId ? '1px dashed #38bdf8' : 'none' }}>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Location ID</label><input className="modern-input" value={locForm.location_id} onChange={e=>setLocForm({...locForm, location_id: e.target.value})} /></div>
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color: editingLocId ? '#38bdf8' : '#f59e0b', fontWeight: 'bold' }}>Depot Name (e.g. Guwahati) *</label><input className="modern-input" value={locForm.depot_name} onChange={e=>setLocForm({...locForm, depot_name: e.target.value})} /></div>
                
                {/* 🚚 MULTI-SELECT VEHICLE DROPDOWN (WITH SEARCH 🔍) */}
                <div style={{ gridColumn: 'span 2', position: 'relative' }}>
                  <label style={{ fontSize:'11px', color:'#38bdf8', fontWeight:'bold' }}>🚛 Attach Vehicles (Multi-Select)</label>
                  <div 
                    onClick={() => setShowVehicleDropdown(!showVehicleDropdown)}
                    style={{ background: 'rgba(15, 23, 42, 0.6)', border: '1px solid #38bdf8', borderRadius: '12px', padding: '10px 15px', color: selectedVehicles.length > 0 ? '#fff' : '#94a3b8', fontSize: '13px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selectedVehicles.length === 0 ? '-- Select Vehicles --' : `${selectedVehicles.length} Vehicles Selected`}
                    </span>
                    <span>▼</span>
                  </div>

                  {/* 🔍 Dropdown List with Live Search */}
                  {showVehicleDropdown && (
                    <div className="multi-select-dropdown" style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '8px', marginTop: '5px', zIndex: 50, maxHeight: '250px', overflowY: 'auto', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
                      
                      {/* Search Bar inside Dropdown */}
                      <div style={{ padding: '10px', position: 'sticky', top: 0, background: '#1e293b', zIndex: 51, borderBottom: '1px solid #334155' }}>
                        <input 
                          type="text" 
                          placeholder="🔍 Search vehicle..." 
                          value={vehicleSearch} 
                          onChange={(e) => setVehicleSearch(e.target.value)} 
                          style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #38bdf8', background: '#0f172a', color: 'white', outline: 'none', boxSettings: 'border-box' }}
                        />
                      </div>

                      {filteredVehicles.length === 0 ? (
                        <div style={{ padding: '15px', color: '#94a3b8', fontSize: '12px', textAlign: 'center' }}>No vehicles found.</div>
                      ) : (
                        filteredVehicles.map(v => (
                          <div key={v.id} style={{ padding: '8px 15px', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }} onClick={() => handleVehicleToggle(v.vehicle_no)}>
                            <input 
                              type="checkbox" 
                              checked={selectedVehicles.includes(v.vehicle_no)} 
                              readOnly
                              style={{ cursor: 'pointer', accentColor: '#38bdf8', width: '16px', height: '16px' }}
                            />
                            <span style={{ color: selectedVehicles.includes(v.vehicle_no) ? '#38bdf8' : '#e2e8f0', fontWeight: selectedVehicles.includes(v.vehicle_no) ? 'bold' : 'normal', fontSize: '13px' }}>
                              {v.vehicle_no}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                
                <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Contract Expiry</label><input type="date" className="modern-input" value={locForm.contract_expiry} onChange={e=>setLocForm({...locForm, contract_expiry: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981' }}>Rate / KM</label><input type="number" className="modern-input" value={locForm.rate_per_km} onChange={e=>setLocForm({...locForm, rate_per_km: e.target.value})} /></div>
                
                <div style={{ gridColumn: 'span 7', textAlign: 'right', marginTop: '10px' }}>
                  <button className="glow-btn" style={{ background: editingLocId ? 'linear-gradient(135deg, #38bdf8, #2563eb)' : 'linear-gradient(135deg, #f59e0b, #d97706)', padding: '10px 30px', fontSize: '12px' }} onClick={handleAddLocation}>
                    {editingLocId ? "💾 UPDATE DEPOT DATA" : "+ ADD DEPOT & LINK VEHICLES"}
                  </button>
                </div>
              </div>

              {formData.locations?.length > 0 && (
                <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '10px' }}>
                  <table className="data-table">
                    <thead><tr><th>ID</th><th>Depot Name</th><th style={{ color: '#38bdf8' }}>🚛 Attached Vehicles</th><th>Contract Expiry</th><th>Rate/KM</th><th style={{textAlign:'center'}}>Actions</th></tr></thead>
                    <tbody>
                      {formData.locations.map((d:any, i) => (
                        <tr key={i} style={{ background: editingLocId === d.id ? 'rgba(56, 189, 248, 0.1)' : 'transparent' }}>
                          <td>{d.location_id||'-'}</td><td style={{color:'#fff', fontWeight:'bold'}}>{d.depot_name}</td>
                          <td style={{color:'#38bdf8', fontWeight:'bold'}}>{d.linked_vehicles || 'No vehicles mapped'}</td>
                          <td style={{color:'#ef4444'}}>{d.contract_expiry||'-'}</td><td>{d.rate_per_km||'-'}</td>
                          <td style={{textAlign:'center', display: 'flex', gap: '10px', justifyContent: 'center'}}>
                            {/* ✏️ EDIT BUTTON */}
                            <span className="action-icon" onClick={() => handleEditLocation(d)} title="Edit Depot">✏️</span>
                            {/* 🗑️ DELETE BUTTON */}
                            <span className="action-icon" onClick={() => handleDeleteLocation(d.id)} title="Delete Depot" style={{color: '#ef4444'}}>🗑️</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 🗺️ PART 3: CONSIGNEES & RTKM RATES */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <h3 style={{ color: '#c084fc', margin: 0, borderBottom: '1px solid #334155', paddingBottom: '5px' }}>3. CONSIGNEES & RTKM RATE REVISIONS (HSD ADJUSTMENTS)</h3>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '15px', background: 'rgba(192, 132, 252, 0.05)', padding: '20px', borderRadius: '10px', alignItems: 'end' }}>
                <div><label style={{ fontSize:'11px', color:'#c084fc', fontWeight:'bold' }}>Select Loading Depot *</label>
                  <select className="modern-input" style={{ border: '1px solid #c084fc' }} value={rateForm.depot_link} onChange={e=>setRateForm({...rateForm, depot_link: e.target.value})}>
                    <option value="">-- Choose Depot --</option>
                    {formData.locations?.map((d:any) => <option key={d.id} value={d.depot_name}>{d.depot_name}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#fff', fontWeight:'bold' }}>Consignee Name (Petrol Pump) *</label><input className="modern-input" value={rateForm.consignee_name} onChange={e=>setRateForm({...rateForm, consignee_name: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Item Type</label><input className="modern-input" value={rateForm.item_type} onChange={e=>setRateForm({...rateForm, item_type: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b' }}>RTKM Distance</label><input type="number" className="modern-input" value={rateForm.rtkm_distance} onChange={e=>setRateForm({...rateForm, rtkm_distance: e.target.value})} /></div>
                
                <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>📅 Rate Effective From *</label><input type="date" className="modern-input" style={{ border: '2px solid #10b981', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', fontWeight: 'bold' }} value={rateForm.start_date} onChange={e=>setRateForm({...rateForm, start_date: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981' }}>Rate Amt / Unit (₹)</label><input type="number" className="modern-input" value={rateForm.rate_per_unit} onChange={e=>setRateForm({...rateForm, rate_per_unit: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Fixed HSD Qty (Liters)</label><input type="number" className="modern-input" value={rateForm.fixed_hsd_qty} onChange={e=>setRateForm({...rateForm, fixed_hsd_qty: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Fixed Cash Amt (₹)</label><input type="number" className="modern-input" value={rateForm.fixed_cash_amt} onChange={e=>setRateForm({...rateForm, fixed_cash_amt: e.target.value})} /></div>
                <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Toll Amount (₹)</label><input type="number" className="modern-input" value={rateForm.toll_amt} onChange={e=>setRateForm({...rateForm, toll_amt: e.target.value})} /></div>
                
                <div style={{ gridColumn: 'span 5', textAlign: 'right', marginTop: '10px' }}>
                  <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #c084fc, #9333ea)', padding: '10px 30px', fontSize: '12px' }} onClick={handleAddRate}>+ ADD / REVISE RTKM RATE</button>
                </div>
              </div>

              {formData.consignees?.length > 0 && (
                <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '10px' }}>
                  <table className="data-table">
                    <thead><tr><th>From (Depot)</th><th>To (Consignee)</th><th>RTKM</th><th style={{color:'#10b981'}}>📅 Effective From</th><th>Rate/Unit</th><th>Fixed HSD</th><th>Cash</th><th>Toll</th></tr></thead>
                    <tbody>
                      {formData.consignees.map((c:any, i) => (
                        <tr key={i}>
                          <td style={{color:'#38bdf8', fontWeight: 'bold'}}>{c.depot_link}</td><td style={{color:'#fff', fontWeight: 'bold'}}>{c.consignee_name}</td>
                          <td style={{color:'#f59e0b'}}>{c.rtkm_distance} KM</td><td style={{color:'#10b981', fontWeight:'bold'}}>{c.start_date}</td>
                          <td style={{color:'#10b981'}}>₹{c.rate_per_unit}</td>
                          <td>{c.fixed_hsd_qty||0} Lts</td><td>₹{c.fixed_cash_amt||0}</td><td style={{color:'#ef4444'}}>₹{c.toll_amt||0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* FINAL SAVE BUTTON */}
            <div style={{ textAlign: 'center', marginTop: '20px', padding: '20px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <button className="glow-btn" style={{ fontSize: '18px', padding: '20px 60px', width: '100%', background: 'linear-gradient(135deg, #10b981, #059669)', boxShadow: '0 0 30px rgba(16, 185, 129, 0.4)' }} onClick={handleSaveCustomer}>
                {editingId ? "💾 UPDATE ENTIRE CONTRACT DATA" : "💾 SAVE NEW CORPORATE CONTRACT TO SERVER"}
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}