// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from './firebase';

export default function Vander() {
  const [activeTab, setActiveTab] = useState('MASTER');
  const [vendors, setVendors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [isTxnModalOpen, setIsTxnModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Vendor Master Data
  const [formData, setFormData] = useState({
    vendor_name: '', vendor_type: 'Fuel Pump', contact_person: '', mobile_no: '', 
    address: '', gst_no: '', bank_account: '', ifsc_code: '', 
    opening_balance: '0', current_balance: '0', status: 'Active'
  });

  // Vendor Transaction Data (Bill/Payment)
  const [txnData, setTxnData] = useState({
    vendor_id: '', vendor_name: '', txn_date: new Date().toISOString().split('T')[0], 
    txn_type: 'PAYMENT_GIVEN', amount: '', payment_mode: 'Bank Transfer', remarks: ''
  });

  useEffect(() => {
    fetchVendors();
  }, []);

  const fetchVendors = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "VENDORS"));
      const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // Crash-safe: VENDORS holds two doc shapes (vendor_name from this form,
      // agency_name from MarketVehicles) — a missing field must not throw and
      // silently blank the whole list.
      setVendors(data.sort((a: any, b: any) => String(a.vendor_name || a.agency_name || '').localeCompare(String(b.vendor_name || b.agency_name || ''))));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 📝 SAVE VENDOR MASTER & CREATE AUTO LEDGER
  const handleSaveVendor = async () => {
    if (!formData.vendor_name || !formData.mobile_no) return alert("⚠️ Name & Mobile required!");
    try {
      if (editingId) {
        await updateDoc(doc(db, "VENDORS", editingId), formData);
        alert("✅ Vendor Master Updated Successfully!");
      } else {
        const docRef = await addDoc(collection(db, "VENDORS"), { ...formData, current_balance: formData.opening_balance, createdAt: serverTimestamp() });
        
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: formData.vendor_name,         
          group_head: "Sundry Creditors",            
          opening_balance: parseFloat(formData.opening_balance || '0'), 
          current_balance: parseFloat(formData.opening_balance || '0'),
          creation_type: "AUTO_SYSTEM",
          linked_module: "VENDOR",
          linked_id: docRef.id,
          created_at: serverTimestamp()
        });

        alert("✅ New Vendor Saved & Sundry Creditors Ledger Created!");
      }
      setIsVendorModalOpen(false); fetchVendors();
    } catch (e) { alert("❌ Error saving vendor."); }
  };

  // 💰 SAVE VENDOR TRANSACTION & UPDATE BALANCE
  const handleSaveTxn = async () => {
    if (!txnData.vendor_id || !txnData.amount) return alert("⚠️ Select Vendor and enter Amount!");
    
    const txnAmt = parseFloat(txnData.amount);
    if (isNaN(txnAmt) || txnAmt <= 0) return alert("⚠️ Please enter a valid amount greater than 0!");

    try {
      const vendorRef = doc(db, "VENDORS", txnData.vendor_id);
      const selectedVendor = vendors.find(v => v.id === txnData.vendor_id);
      let currentBal = parseFloat(selectedVendor.current_balance || '0');

      if (txnData.txn_type === 'BILL_RECEIVED') {
        currentBal += txnAmt; // Liability increases
      } else {
        currentBal -= txnAmt; // Liability decreases
      }

      await addDoc(collection(db, "VENDOR_TXNS"), { ...txnData, createdAt: serverTimestamp() });
      await updateDoc(vendorRef, { current_balance: currentBal.toFixed(2) });

      alert("✅ Transaction Saved & Ledger Updated!");
      setIsTxnModalOpen(false);
      setTxnData({ vendor_id: '', vendor_name: '', txn_date: new Date().toISOString().split('T')[0], txn_type: 'PAYMENT_GIVEN', amount: '', payment_mode: 'Bank Transfer', remarks: '' });
      fetchVendors();
    } catch (e) { alert("❌ Transaction failed."); console.error(e); }
  };

  const openVendorModal = (vendor: any = null) => {
    if (vendor) { setFormData(vendor); setEditingId(vendor.id); } 
    else { setFormData({ vendor_name: '', vendor_type: 'Fuel Pump', contact_person: '', mobile_no: '', address: '', gst_no: '', bank_account: '', ifsc_code: '', opening_balance: '0', current_balance: '0', status: 'Active' }); setEditingId(null); }
    setIsVendorModalOpen(true);
  };

  const openTxnModal = (vendor: any = null) => {
    // ✅ BUG FIX: Purana amount form me na rahe isliye form reset kiya, sirf vendor select rakha
    setTxnData({
      vendor_id: vendor ? vendor.id : '',
      vendor_name: vendor ? vendor.vendor_name : '',
      txn_date: new Date().toISOString().split('T')[0],
      txn_type: 'PAYMENT_GIVEN',
      amount: '',
      payment_mode: 'Bank Transfer',
      remarks: ''
    });
    setIsTxnModalOpen(true);
  };

  // 💬 WHATSAPP SEND FUNCTION FOR VENDORS
  const sendVendorWhatsApp = (vendor: any) => {
    if (!vendor.mobile_no) {
      alert("⚠️ Mobile number not found for this vendor!");
      return;
    }

    const currentBal = parseFloat(vendor.current_balance || '0');
    let message = "";

    if (currentBal > 0) {
      message = `Dear ${vendor.vendor_name},\n\nThis is an automated alert from Prasad Transport Group.\n\nYour current outstanding balance payable by us is: *₹${currentBal.toFixed(2)}*.\n\nWe are processing this and it will be cleared soon.\n\nRegards,\nPrasad Transport ERP`;
    } else if (currentBal < 0) {
       message = `Dear ${vendor.vendor_name},\n\nThis is an automated alert from Prasad Transport Group.\n\nYou have an advance balance of: *₹${Math.abs(currentBal).toFixed(2)}* with us.\n\nRegards,\nPrasad Transport ERP`;
    } else {
       message = `Dear ${vendor.vendor_name},\n\nThis is a message from Prasad Transport Group.\n\nYour account is currently settled with a *₹0.00* balance.\n\nRegards,\nPrasad Transport ERP`;
    }

    const encodedMessage = encodeURIComponent(message);
    let phone = vendor.mobile_no.replace(/\s+/g, '');
    if (phone.length === 10) phone = '91' + phone;

    window.open(`https://wa.me/${phone}?text=${encodedMessage}`, '_blank');
  };

  const filteredVendors = vendors.filter(v => v.vendor_name?.toLowerCase().includes(searchTerm.toLowerCase()));
  
  // Stats Calculation
  const totalOutstanding = vendors.reduce((acc, curr) => acc + (parseFloat(curr.current_balance || '0') || 0), 0);

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; transition: all 0.3s; }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 12px 25px; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 14px;}
        .glow-btn:hover { box-shadow: 0 4px 25px rgba(16, 185, 129, 0.7); transform: scale(1.02); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; outline: none; width: 100%; font-size: 13px; box-sizing: border-box;}
        .modern-input:focus { border-color: #10b981; }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #10b981; border-bottom: 3px solid #10b981; background: rgba(16, 185, 129, 0.1); border-radius: 10px 10px 0 0; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
      `}</style>

      {/* 🚀 Dashboard Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '30px' }}>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '5px solid #10b981' }}>
          <h3 style={{ color: '#94a3b8', margin: '0 0 10px 0', fontSize: '14px' }}>🏢 TOTAL REGISTERED VENDORS</h3>
          <h1 style={{ color: '#fff', margin: 0, fontSize: '32px' }}>{vendors.length}</h1>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '5px solid #ef4444' }}>
          <h3 style={{ color: '#94a3b8', margin: '0 0 10px 0', fontSize: '14px' }}>💸 TOTAL MARKET OUTSTANDING (PAYABLE)</h3>
          <h1 style={{ color: '#ef4444', margin: 0, fontSize: '32px' }}>₹{totalOutstanding.toFixed(2)}</h1>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '10px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <button className={`tab-btn ${activeTab === 'MASTER' ? 'active' : ''}`} onClick={() => setActiveTab('MASTER')}>🏢 VENDOR MASTER LIST</button>
        </div>
        <div style={{ display: 'flex', gap: '15px' }}>
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', boxShadow: 'none' }} onClick={() => openTxnModal()}>💸 + Add Bill / Payment</button>
          <button className="glow-btn" onClick={() => openVendorModal()}>🏢 + Add New Vendor</button>
        </div>
      </div>

      <input className="modern-input" placeholder="🔍 Search Vendor by Name..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={{ marginBottom: '20px' }} />

      {/* 📋 Vendor Cards Grid */}
      {loading ? <p style={{ color: '#10b981' }}>Loading Database...</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '20px' }}>
          {filteredVendors.map(v => (
            <div key={v.id} className="glass-card" style={{ padding: '20px', position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                <span className="badge" style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8' }}>{v.vendor_type}</span>
                <span className="badge" style={{ background: parseFloat(v.current_balance) > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: parseFloat(v.current_balance) > 0 ? '#ef4444' : '#10b981' }}>
                  {parseFloat(v.current_balance) > 0 ? 'To Pay' : 'Clear'}
                </span>
              </div>
              <h2 style={{ color: '#fff', margin: '0 0 5px 0' }}>{v.vendor_name}</h2>
              <p style={{ color: '#94a3b8', fontSize: '12px', margin: '0 0 15px 0' }}>📱 {v.mobile_no} | 👤 {v.contact_person}</p>
              
              <div style={{ background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', marginBottom: '5px' }}>
                  <span>Bank A/c:</span> <b>{v.bank_account || 'N/A'}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
                  <span>IFSC:</span> <b>{v.ifsc_code || 'N/A'}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px dashed #334155', paddingTop: '10px' }}>
                  <span style={{ fontSize: '13px', color: '#94a3b8' }}>Current Balance:</span>
                  <span style={{ fontSize: '20px', fontWeight: 'bold', color: parseFloat(v.current_balance) > 0 ? '#ef4444' : '#10b981' }}>
                    ₹{parseFloat(v.current_balance).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* 💬 NEW FREE WHATSAPP BUTTON FOR VENDORS */}
              <button 
                style={{ width: '100%', marginBottom: '15px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid #22c55e', color: '#22c55e', padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', transition: '0.3s' }}
                onClick={() => sendVendorWhatsApp(v)}
                onMouseOver={(e) => { e.currentTarget.style.background = '#22c55e'; e.currentTarget.style.color = 'white'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(34, 197, 94, 0.1)'; e.currentTarget.style.color = '#22c55e'; }}
              >
                <span style={{ fontSize: '18px' }}>💬</span> Send WhatsApp Alert
              </button>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => openVendorModal(v)} style={{ flex: 1, background: 'transparent', color: '#38bdf8', border: '1px solid #38bdf8', padding: '10px', borderRadius: '8px', cursor: 'pointer' }}>Edit Master</button>
                <button onClick={() => openTxnModal(v)} style={{ flex: 1, background: '#10b981', color: '#fff', border: 'none', padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Pay / Bill</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 🏢 MODAL: VENDOR MASTER */}
      {isVendorModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '800px', border: '1px solid #10b981', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>{editingId ? 'Edit Vendor Master' : 'Register New Vendor & Auto-Ledger'}</h2>
              <button onClick={() => setIsVendorModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize:'12px', color:'#94a3b8' }}>Vendor/Shop Name *</label>
                <input className="modern-input" value={formData.vendor_name} onChange={e=>setFormData({...formData, vendor_name: e.target.value})} />
              </div>
              
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8' }}>Vendor Category</label>
                <select className="modern-input" value={formData.vendor_type} onChange={e=>setFormData({...formData, vendor_type: e.target.value})}>
                  <option value="Fuel Pump">Fuel Pump (HSD)</option>
                  <option value="Mechanic Garage">Mechanic Garage</option>
                  <option value="Spare Parts">Spare Parts & Tyres</option>
                  <option value="Broker/Commission">Broker / Commission Agent</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Contact Person</label><input className="modern-input" value={formData.contact_person} onChange={e=>setFormData({...formData, contact_person: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Mobile No (For WhatsApp) *</label><input className="modern-input" value={formData.mobile_no} onChange={e=>setFormData({...formData, mobile_no: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>GST Number</label><input className="modern-input" value={formData.gst_no} onChange={e=>setFormData({...formData, gst_no: e.target.value})} /></div>
              <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'12px', color:'#94a3b8' }}>Full Address</label><input className="modern-input" value={formData.address} onChange={e=>setFormData({...formData, address: e.target.value})} /></div>
              
              {/* Bank & Ledger Info */}
              <div style={{ gridColumn: 'span 2', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '10px', marginTop: '10px' }}>
                <h4 style={{ margin: '0 0 10px 0', color: '#38bdf8' }}>🏦 Financial Details & Ledger Setup</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Bank Account No</label><input className="modern-input" value={formData.bank_account} onChange={e=>setFormData({...formData, bank_account: e.target.value})} /></div>
                  <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>IFSC Code</label><input className="modern-input" value={formData.ifsc_code} onChange={e=>setFormData({...formData, ifsc_code: e.target.value})} /></div>
                  {!editingId && (
                    <div style={{ gridColumn: 'span 2' }}>
                      <label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Opening Balance (Amount you owe them) ₹</label>
                      <input type="number" className="modern-input" style={{ border: '1px solid #ef4444' }} value={formData.opening_balance} onChange={e=>setFormData({...formData, opening_balance: e.target.value})} />
                    </div>
                  )}
                </div>
              </div>

            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px' }} onClick={handleSaveVendor}>{editingId ? '💾 Update Master' : '✅ Save Vendor & Setup Ledger'}</button>
          </div>
        </div>
      )}

      {/* 💸 MODAL: TRANSACTION (BILL / PAYMENT) */}
      {isTxnModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #f59e0b', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#f59e0b' }}>Ledger Entry</h2>
              <button onClick={() => setIsTxnModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8' }}>Select Vendor *</label>
                <select className="modern-input" value={txnData.vendor_id} onChange={e => {
                  const selVendor = vendors.find(v => v.id === e.target.value);
                  setTxnData({...txnData, vendor_id: e.target.value, vendor_name: selVendor?.vendor_name || ''});
                }}>
                  <option value="">-- Select Vendor --</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name} (Bal: ₹{v.current_balance})</option>)}
                </select>
              </div>

              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8' }}>Transaction Type *</label>
                <select className="modern-input" value={txnData.txn_type} onChange={e=>setTxnData({...txnData, txn_type: e.target.value})} style={{ color: txnData.txn_type === 'BILL_RECEIVED' ? '#ef4444' : '#10b981', fontWeight: 'bold' }}>
                  <option value="PAYMENT_GIVEN">💸 Payment Given (Reduces Balance)</option>
                  <option value="BILL_RECEIVED">🧾 Bill / Invoice Received (Increases Balance)</option>
                </select>
              </div>

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Date</label><input type="date" className="modern-input" value={txnData.txn_date} onChange={e=>setTxnData({...txnData, txn_date: e.target.value})} style={{ colorScheme: 'dark' }} /></div>
              
              <div>
                <label style={{ fontSize:'12px', color: '#f59e0b', fontWeight: 'bold' }}>Amount (₹) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #f59e0b', fontSize: '18px', fontWeight: 'bold' }} value={txnData.amount} onChange={e=>setTxnData({...txnData, amount: e.target.value})} />
              </div>

              {txnData.txn_type === 'PAYMENT_GIVEN' && (
                <div>
                  <label style={{ fontSize:'12px', color:'#94a3b8' }}>Payment Mode</label>
                  <select className="modern-input" value={txnData.payment_mode} onChange={e=>setTxnData({...txnData, payment_mode: e.target.value})}>
                    <option value="Bank Transfer">Bank Transfer (NEFT/RTGS)</option>
                    <option value="UPI">UPI</option>
                    <option value="Cash">Cash</option>
                    <option value="Cheque">Cheque</option>
                  </select>
                </div>
              )}

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Remarks / Bill No / Reference</label><input className="modern-input" value={txnData.remarks} onChange={e=>setTxnData({...txnData, remarks: e.target.value})} placeholder="e.g. Bill #104 or UTR No" /></div>
            </div>
            
            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px', background: 'linear-gradient(135deg, #f59e0b, #d97706)' }} onClick={handleSaveTxn}>
              {txnData.txn_type === 'BILL_RECEIVED' ? '🧾 Add to Bill Ledger' : '💸 Confirm Payment'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}