// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { logAudit } from './lib/audit';
import { db } from './firebase'; 

export default function UGER() {
  // 🔥 NEW: TAB SYSTEM STATE
  const [activeMainTab, setActiveMainTab] = useState('PROFILES'); // 'PROFILES' or 'LOGS'

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // 📝 FULL IDENTITY & COMPANY STATE
  const [formData, setFormData] = useState({
    full_name: '', company_name: 'PRASAD TRANSPORT', mobile: '', email: '', password: '', 
    role: 'DATA ENTRY STAFF', status: 'ACTIVE', branch: 'BONGAIGAON (HO)', 
    city: 'Bongaigaon', state: 'ASSAM', gst_no: '', scope: 'LOCAL' 
  });

  // 📈 NEW: ACTIVITY LOGS STATE (WITH FROM & TO DATE)
  const [activityLogs, setActivityLogs] = useState([]);
  const [logFilters, setLogFilters] = useState({ 
    startDate: new Date().toISOString().split('T')[0], 
    endDate: new Date().toISOString().split('T')[0], 
    user: 'ALL' 
  });

  // 🛡️ ALL SYSTEM MODULES
  const getAppModulesList = () => [
    { id: 'DASHBOARD', name: 'Operations Dashboard', category: '🚛 OPERATIONS', view: true, add: false, edit: false, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'TRIP', name: 'Trip Management', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: true, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'VEHICLE', name: 'Vehicle Fleet', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: true, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'MARKET_VEHICLE', name: 'Market Vehicles (Vendors)', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'DRIVER', name: 'Driver Master (DL)', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'LOADING', name: 'Loading / Unloading', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'DOCS', name: 'Vehicle Documents', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'FUEL', name: 'Fuel & Maintenance', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'LOCATION_RTKM', name: 'Route & RTKM Master', category: '🚛 OPERATIONS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'BANK', name: 'Cash & Bank Book', category: '💰 ACCOUNTS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'LEDGER', name: 'Ledger Management', category: '💰 ACCOUNTS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'PNL', name: 'Finance Hub (P&L)', category: '💰 ACCOUNTS', view: false, add: false, edit: false, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'BILLING', name: 'Billing & Invoicing', category: '💰 ACCOUNTS', view: false, add: true, edit: true, delete: true, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'GST', name: 'GST & TDS Management', category: '💰 ACCOUNTS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'VENDOR', name: 'Vendor Master', category: '💰 ACCOUNTS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'LOAN', name: 'Loan & EMI Mgmt', category: '💰 ACCOUNTS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'CUSTOMER', name: 'Customer CRM', category: '🤝 CRM & TOOLS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: true, assigned_approver: '' },
    { id: 'WHATSAPP', name: 'WhatsApp AI Dashboard', category: '🤝 CRM & TOOLS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'INBOX', name: 'Company Inbox', category: '🤝 CRM & TOOLS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'WEB_SETTINGS', name: 'Website Builder', category: '🤝 CRM & TOOLS', view: false, add: true, edit: true, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'CUSTOMER_PORTAL', name: 'Customer External Login', category: '🌐 PORTALS', view: false, add: false, edit: false, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'DRIVER_PORTAL', name: 'Driver External Login', category: '🌐 PORTALS', view: false, add: false, edit: false, delete: false, approve: false, needs_approval: false, assigned_approver: '' },
    { id: 'PARTNER_PORTAL', name: 'Fleet Partner Login', category: '🌐 PORTALS', view: false, add: false, edit: false, delete: false, approve: false, needs_approval: false, assigned_approver: '' }
  ];

  const [modules, setModules] = useState(getAppModulesList());

  // 🔄 FETCH USERS & LOGS
  useEffect(() => { 
    fetchUsers(); 
    fetchLogs(); // Fetch logs on load
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "USERS"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      setUsersList(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchLogs = async () => {
    try {
      // Assuming you have an 'ACTIVITY_LOGS' collection where every action saves data like {user, action, timestamp}
      const q = query(collection(db, "ACTIVITY_LOGS"), orderBy("timestamp", "desc"));
      const snap = await getDocs(q);
      setActivityLogs(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error("No logs yet or error fetching logs."); }
  };

  const branchBosses = usersList.filter(u => 
    (u.role === 'ADMIN' || u.permissions?.some(p => p.approve)) && 
    (u.branch === formData.branch || u.scope === 'GLOBAL')
  );

  const handleSave = async () => {
    if (!formData.email || !formData.full_name) return alert("⚠️ Name and Email are required!");
    setLoading(true);
    try {
      const finalData = { ...formData, permissions: modules, updatedAt: serverTimestamp() };
      if (editingId) {
        await updateDoc(doc(db, "USERS", editingId), finalData);
      } else {
        await addDoc(collection(db, "USERS"), { ...finalData, createdAt: serverTimestamp() });
      }
      logAudit({ action: editingId ? 'USER_UPDATE' : 'USER_CREATE', target: formData.email, details: `${formData.full_name} → role ${formData.role}` });
      setIsModalOpen(false); fetchUsers(); fetchLogs(); alert("✅ Data Saved Successfully!");
    } catch (e) { alert("❌ Error saving data!"); }
    setLoading(false);
  };

  const handleEdit = (user) => {
    setFormData({ ...user });
    setModules(user.permissions || getAppModulesList());
    setEditingId(user.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id, name) => {
    if (window.confirm(`Delete ${name}?`)) {
      await deleteDoc(doc(db, "USERS", id));
      fetchUsers();
    }
  };

  const toggleStatus = async (user) => {
    const newStatus = user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await updateDoc(doc(db, "USERS", user.id), { status: newStatus });
    fetchUsers();
  };

  const handlePermChange = (idx, field, val) => {
    const updated = [...modules];
    updated[idx][field] = val;
    if (field === 'needs_approval' && !val) {
      updated[idx].assigned_approver = '';
    }
    setModules(updated);
  };

  const categories = Array.from(new Set(modules.map(m => m.category)));

  // 📈 FILTER LOGS LOGIC (DATE FROM & TO)
  const filteredLogs = activityLogs.filter(log => {
    const logDate = log.timestamp?.toDate ? log.timestamp.toDate().toISOString().split('T')[0] : log.date || '';
    
    // Check if the log date falls between startDate and endDate
    let dateMatch = true;
    if (logFilters.startDate && logFilters.endDate) {
      dateMatch = logDate >= logFilters.startDate && logDate <= logFilters.endDate;
    } else if (logFilters.startDate) {
      dateMatch = logDate >= logFilters.startDate;
    } else if (logFilters.endDate) {
      dateMatch = logDate <= logFilters.endDate;
    }

    const userMatch = logFilters.user === 'ALL' || log.user_name === logFilters.user;
    return dateMatch && userMatch;
  });

  return (
    <div style={{ padding: '20px 30px', minHeight: '100vh', background: '#020617', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .input-box { width: 100%; padding: 10px; background: #0f172a; border: 1px solid #1e293b; color: white; border-radius: 8px; box-sizing: border-box; margin-top: 5px; }
        .input-box:focus { border-color: #38bdf8; outline: none; }
        .action-btn { background: transparent; border: 1px solid #38bdf8; color: #38bdf8; padding: 4px 8px; border-radius: 5px; cursor: pointer; margin-right: 5px; font-size: 11px; }
        .perm-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1e293b; font-size: 12px; }
        input[type="checkbox"] { cursor: pointer; accent-color: #38bdf8; width: 14px; height: 14px; }
        
        .main-tab { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 15px; transition: 0.3s; margin-right: 15px; letter-spacing: 1px; }
        .main-tab.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        
        .log-table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 13px; }
        .log-table th { background: rgba(15, 23, 42, 0.8); padding: 15px; text-align: left; color: #94a3b8; border-bottom: 2px solid #1e293b; }
        .log-table td { padding: 15px; border-bottom: 1px solid #0f172a; color: #cbd5e1; }
        .log-table tr:hover td { background: rgba(30, 41, 59, 0.3); }
      `}</style>

      {/* HEADER & MAIN TABS */}
      <div style={{ marginBottom: '20px', borderBottom: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#38bdf8', marginBottom: '15px' }}>👑 PRASAD MASTER CONTROL</h1>
          <div>
            <button className={`main-tab ${activeMainTab === 'PROFILES' ? 'active' : ''}`} onClick={() => setActiveMainTab('PROFILES')}>👥 STAFF PROFILES & POWERS</button>
            <button className={`main-tab ${activeMainTab === 'LOGS' ? 'active' : ''}`} onClick={() => setActiveMainTab('LOGS')}>📈 ACTIVITY LOGS & REPORT</button>
          </div>
        </div>
        {activeMainTab === 'PROFILES' && (
          <button onClick={() => { setEditingId(null); setFormData({full_name:'', company_name:'PRASAD TRANSPORT', mobile:'', email:'', password:'', role:'DATA ENTRY STAFF', status:'ACTIVE', branch:'BONGAIGAON (HO)', city:'Bongaigaon', state:'ASSAM', gst_no:'', scope:'LOCAL'}); setModules(getAppModulesList()); setIsModalOpen(true); }} style={{ background: '#3b82f6', color: 'white', padding: '10px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 'bold', marginBottom: '10px' }}>+ Add New Profile</button>
        )}
      </div>

      {/* 📈 TAB 2: ACTIVITY LOGS RENDER */}
      {activeMainTab === 'LOGS' && (
        <div>
          <div style={{ display: 'flex', gap: '20px', background: 'rgba(30, 41, 59, 0.5)', padding: '20px', borderRadius: '15px', border: '1px solid #1e293b', alignItems: 'flex-end' }}>
            
            {/* FROM DATE */}
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold', letterSpacing: '1px' }}>📅 FROM DATE</label>
              <input type="date" className="input-box" value={logFilters.startDate} onChange={e => setLogFilters({...logFilters, startDate: e.target.value})} style={{ colorScheme: 'dark' }} />
            </div>

            {/* TO DATE */}
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold', letterSpacing: '1px' }}>📅 TO DATE</label>
              <input type="date" className="input-box" value={logFilters.endDate} onChange={e => setLogFilters({...logFilters, endDate: e.target.value})} style={{ colorScheme: 'dark' }} />
            </div>

            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold', letterSpacing: '1px' }}>👤 SELECT STAFF</label>
              <select className="input-box" value={logFilters.user} onChange={e => setLogFilters({...logFilters, user: e.target.value})}>
                <option value="ALL">-- All Staff --</option>
                {usersList.map(u => <option key={u.id} value={u.full_name}>{u.full_name}</option>)}
              </select>
            </div>
            <button onClick={fetchLogs} style={{ background: '#10b981', color: 'white', padding: '12px 30px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>🔄 Get Report</button>
          </div>

          <div style={{ background: 'rgba(30, 41, 59, 0.3)', padding: '20px', borderRadius: '15px', border: '1px solid #1e293b', marginTop: '20px', overflowX: 'auto' }}>
            <table className="log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Staff Name</th>
                  <th>Module</th>
                  <th>Action / Details</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>No activity found for this date range/staff.</td></tr>
                ) : (
                  filteredLogs.map((log, i) => (
                    <tr key={i}>
                      <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{log.time || new Date(log.timestamp?.toDate()).toLocaleTimeString()}</td>
                      <td style={{ fontWeight: 'bold', color: 'white' }}>{log.user_name}</td>
                      <td><span style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', padding: '3px 8px', borderRadius: '5px', fontSize: '10px' }}>{log.module}</span></td>
                      <td>{log.action_details}</td>
                      <td><span style={{ color: log.status === 'SUCCESS' ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>{log.status || 'SUCCESS'}</span></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 👥 TAB 1: USERS TABLE RENDER */}
      {activeMainTab === 'PROFILES' && (
        <div style={{ background: 'rgba(30, 41, 59, 0.5)', padding: '20px', borderRadius: '15px', border: '1px solid #1e293b', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ color: '#38bdf8', borderBottom: '2px solid #1e293b' }}>
                <th style={{ padding: '12px' }}>Name & Company</th>
                <th style={{ padding: '12px' }}>Branch / Scope</th>
                <th style={{ padding: '12px' }}>Login ID & Role</th>
                <th style={{ padding: '12px' }}>Status</th>
                <th style={{ padding: '12px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {usersList.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid #0f172a' }}>
                  <td style={{ padding: '12px' }}><b>{u.full_name}</b><br/><small style={{color:'#64748b'}}>{u.company_name}</small></td>
                  <td style={{ padding: '12px' }}><span style={{color: '#f59e0b'}}>🏢 {u.branch}</span><br/><small>{u.scope}</small></td>
                  <td style={{ padding: '12px' }}>{u.email}<br/><small style={{color:'#10b981'}}>{u.role}</small></td>
                  <td style={{ padding: '12px' }}>
                    <button onClick={() => toggleStatus(u)} style={{ background: u.status==='ACTIVE'?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)', color: u.status==='ACTIVE'?'#10b981':'#ef4444', border: `1px solid ${u.status==='ACTIVE'?'#10b981':'#ef4444'}`, padding:'3px 8px', borderRadius:'15px', fontSize:'10px', cursor:'pointer' }}>{u.status}</button>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <button className="action-btn" onClick={() => handleEdit(u)}>⚙️ Edit Powers</button>
                    <button className="action-btn" style={{borderColor:'#ef4444', color:'#ef4444'}} onClick={() => handleDelete(u.id, u.full_name)}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* FULL SCREEN MODAL FOR EDITING/ADDING USERS */}
      {isModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: '#020617', width: '100%', maxWidth: '1350px', maxHeight: '95vh', borderRadius: '20px', border: '1px solid #38bdf8', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            
            <div style={{ padding: '15px 25px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b' }}>
              <h2 style={{ color: '#38bdf8', margin: 0, fontSize:'20px' }}>⚙️ Setup System Identity & Workflow Access</h2>
              <button onClick={() => setIsModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '350px 1fr', gap: '25px', padding: '25px', overflowY: 'auto' }}>
              
              {/* LEFT: IDENTITY DATA */}
              <div style={{ borderRight: '1px solid #1e293b', paddingRight: '20px' }}>
                <h4 style={{ color: '#38bdf8', marginTop: 0, borderBottom: '1px solid #1e293b', paddingBottom:'5px' }}>🏢 COMPANY INFO</h4>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>COMPANY NAME</label><input className="input-box" value={formData.company_name} onChange={e => setFormData({...formData, company_name: e.target.value})} /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>GST NUMBER</label><input className="input-box" value={formData.gst_no} onChange={e => setFormData({...formData, gst_no: e.target.value})} /></div>
                
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'15px'}}>
                   <div><label style={{fontSize:'11px', color:'#f59e0b'}}>BRANCH *</label>
                    <select className="input-box" value={formData.branch} onChange={e => setFormData({...formData, branch: e.target.value})} style={{borderColor:'#f59e0b'}}>
                      <option>BONGAIGAON (HO)</option>
                      <option>GUWAHATI BRANCH</option>
                      <option>SILIGURI BRANCH</option>
                    </select>
                   </div>
                   <div><label style={{fontSize:'11px', color:'#38bdf8'}}>SCOPE *</label>
                    <select className="input-box" value={formData.scope} onChange={e => setFormData({...formData, scope: e.target.value})} style={{borderColor:'#38bdf8'}}>
                      <option value="LOCAL">🔒 LOCAL</option>
                      <option value="GLOBAL">🌐 GLOBAL</option>
                    </select>
                   </div>
                </div>

                <h4 style={{ color: '#10b981', marginTop: '20px', borderBottom: '1px solid #1e293b', paddingBottom:'5px' }}>👤 CREDENTIALS & ROLE</h4>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px'}}>FULL NAME</label><input className="input-box" value={formData.full_name} onChange={e => setFormData({...formData, full_name: e.target.value})} /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px'}}>MOBILE NO</label><input className="input-box" value={formData.mobile} onChange={e => setFormData({...formData, mobile: e.target.value})} /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px'}}>LOGIN EMAIL</label><input className="input-box" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px'}}>PASSWORD</label><input className="input-box" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#f59e0b'}}>SYSTEM ROLE (RBAC)</label>
                  <select className="input-box" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}>
                    <option>ADMIN</option><option>MANAGER</option><option>OPERATOR</option><option>ACCOUNTS</option><option>DATA ENTRY STAFF</option><option>VENDOR</option><option>CUSTOMER</option><option>DRIVER</option>
                  </select>
                </div>
                {/* 🔐 RBAC data scope — for external roles, restrict their data to this party. */}
                {['VENDOR','CUSTOMER','DRIVER'].includes(String(formData.role).toUpperCase()) && (
                  <div style={{marginBottom:'10px'}}>
                    <label style={{fontSize:'11px', color:'#c084fc'}}>SCOPE — {String(formData.role).toUpperCase()} NAME (data restricted to this)</label>
                    <input className="input-box" placeholder={`Exact ${formData.role} name as in records`} value={formData.scope_name || ''}
                      onChange={e => {
                        const v = e.target.value; const r = String(formData.role).toUpperCase();
                        setFormData({ ...formData, scope_name: v,
                          vendor_name: r==='VENDOR'? v : formData.vendor_name,
                          customer_name: r==='CUSTOMER'? v : formData.customer_name,
                          driver_name: r==='DRIVER'? v : formData.driver_name });
                      }} />
                    <small style={{color:'#64748b', fontSize:'10px'}}>Mamta AI + saari tables sirf isi {formData.role.toLowerCase()} ka data dikhayenge.</small>
                  </div>
                )}
              </div>

              {/* RIGHT: PERMISSIONS GRID WITH APPROVAL DROPDOWN */}
              <div>
                <h4 style={{ textAlign: 'center', color: '#f59e0b', margin: '0 0 15px 0' }}>📊 ASSIGN APP PAGES & APPROVAL AUTHORITY</h4>
                {categories.map(cat => (
                  <div key={cat} style={{ marginBottom: '20px', background: 'rgba(15, 23, 42, 0.4)', padding: '15px', borderRadius: '12px', border: '1px solid #1e293b' }}>
                    <div style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '13px', borderBottom: '1px solid #334155', paddingBottom: '5px', marginBottom: '10px' }}>{cat}</div>
                    {modules.filter(m => m.category === cat).map((mod, i) => {
                       const idx = modules.findIndex(x => x.id === mod.id);
                       return (
                         <div key={i} className="perm-row">
                           <span style={{ width: '200px', fontWeight: '500' }}>{mod.name}</span>
                           <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                             <label><input type="checkbox" checked={mod.view} onChange={e => handlePermChange(idx, 'view', e.target.checked)} /> 👁️ View</label>
                             <label><input type="checkbox" checked={mod.add} onChange={e => handlePermChange(idx, 'add', e.target.checked)} /> ➕ Add</label>
                             <label><input type="checkbox" checked={mod.edit} onChange={e => handlePermChange(idx, 'edit', e.target.checked)} /> ✏️ Edit</label>
                             <label><input type="checkbox" checked={mod.delete} onChange={e => handlePermChange(idx, 'delete', e.target.checked)} /> 🗑️ Del</label>
                             
                             {/* ⏳ APPROVAL AUTHORITY SETUP (The magic dropdown) */}
                             {mod.add && (
                               <div style={{ display: 'flex', alignItems: 'center', background: '#020617', border: '1px solid #f59e0b', padding: '2px 5px', borderRadius: '4px' }}>
                                 <input type="checkbox" checked={mod.needs_approval} onChange={e => handlePermChange(idx, 'needs_approval', e.target.checked)} />
                                 <span style={{ fontSize: '10px', color: '#f59e0b', marginLeft: '3px' }}>Need Approv.</span>
                                 {mod.needs_approval && (
                                   <select style={{ fontSize: '10px', background: 'transparent', color: '#38bdf8', border: 'none', outline: 'none', marginLeft: '5px', cursor: 'pointer' }} value={mod.assigned_approver} onChange={e => handlePermChange(idx, 'assigned_approver', e.target.value)}>
                                      <option value="">-- Any Boss --</option>
                                      {branchBosses.map(b => <option key={b.id} value={b.id}>{b.full_name}</option>)}
                                   </select>
                                 )}
                               </div>
                             )}

                             {/* THE BIG BOSS BUTTON */}
                             <label style={{ color: '#10b981', fontWeight: '900', borderLeft: '1px solid #334155', paddingLeft: '10px' }}>
                               <input type="checkbox" checked={mod.approve} onChange={e => handlePermChange(idx, 'approve', e.target.checked)} /> IS BOSS
                             </label>
                           </div>
                         </div>
                       )
                    })}
                  </div>
                ))}
              </div>

            </div>

            {/* MODAL FOOTER */}
            <div style={{ padding: '15px 30px', textAlign: 'right', background: '#020617', borderTop: '1px solid #1e293b' }}>
              <button onClick={handleSave} disabled={loading} style={{ background: '#10b981', color: 'white', padding: '12px 50px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}>
                {loading ? '⌛ SAVING...' : '✅ SAVE FULL SYSTEM DATA'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}