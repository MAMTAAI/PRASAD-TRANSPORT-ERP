// @ts-nocheck
// 🏢 VENDOR MASTER — pumps, garages, spares, brokers. Live PostgreSQL.
//
// TWO THINGS CHANGED SHAPE HERE, and both were bugs before.
//
// 1. THE BALANCE IS DERIVED. The Firestore version kept a stored
//    `current_balance` on the vendor and hand-adjusted it on every save:
//    read it, add or subtract, write it back. Two people paying the same pump
//    at once lost one of the payments, and nothing ever reconciled the counter
//    against the ledger. Now the balance is `opening_balance + Σ vendor_txns`,
//    computed by the API on every read, so it cannot drift by construction.
//    Migration 029 seeded opening_balance from the migrated current_balance so
//    no vendor's carried-forward figure was lost in the move.
//
// 2. A PAYMENT POSTS TO THE GENERAL LEDGER. Money leaving a bank account is a
//    PAYMENT voucher (Dr Creditors: <vendor> / Cr the account) posted through
//    TARA — which is why the payment form now asks WHICH account it left. The
//    old screen only bumped the counter, so the vendor sub-ledger and the books
//    disagreed the moment anyone paid anybody. "Subsidiary only" is still
//    available for a correction that must not touch the GL.
import React, { useState, useEffect } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const MASTERS = `${API}/api/v1/masters`;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

// record_status is ACTIVE/INACTIVE; this form has always said Active/Inactive.
const toDbStatus = (v: any) => (String(v || 'Active').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');

// The card reads `current_balance`. The honest number is the API's derived
// running_balance, so that is what the card is handed — the stored column is
// left untouched as the historical marker migration 029 anchored to.
const fromApi = (v: any) => ({ ...v, current_balance: v.running_balance ?? v.current_balance ?? '0' });

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
    txn_type: 'PAYMENT_GIVEN', amount: '', payment_mode: 'Bank Transfer', remarks: '',
    // Which bank/cash account the money left. Never defaulted — the operator
    // names it, or the payment stays out of the general ledger on purpose.
    account: '', post_to_ledger: true,
  });
  const [accounts, setAccounts] = useState<any[]>([]);
  const [savingTxn, setSavingTxn] = useState(false);

  useEffect(() => {
    fetchVendors();
    fetchJson(`${FIN}/accounts`).then(j => setAccounts(j.accounts ?? [])).catch(() => {});
  }, []);
  const fetchVendors = async () => {
    setLoading(true);
    try {
      const j = await fetchJson(`${MASTERS}/vendors?limit=1000`);
      setVendors((j.vendors ?? []).map(fromApi));
    } catch (e) { console.error('vendors:', e); }
    setLoading(false);
  };

  // 📝 SAVE VENDOR MASTER
  // The auto-LEDGERS write is gone: TARA opens `Creditors: <name>` the first
  // time a payment is actually posted against the vendor, so creating one here
  // would leave an empty account in the chart with nothing behind it.
  const handleSaveVendor = async () => {
    if (!formData.vendor_name || !formData.mobile_no) return alert("⚠️ Name & Mobile required!");
    const payload = {
      vendor_name: formData.vendor_name,
      vendor_type: formData.vendor_type,
      contact_person: formData.contact_person,
      mobile_no: formData.mobile_no,
      address: formData.address,
      gst_no: formData.gst_no || null,
      bank_account: formData.bank_account,
      ifsc_code: formData.ifsc_code,
      status: toDbStatus(formData.status),
    };
    try {
      if (editingId) {
        // opening_balance is deliberately NOT sent on edit — it is the anchor
        // the derived balance is measured from, and silently rewriting it would
        // move every historical figure at once.
        await fetchJson(`${MASTERS}/vendors/${editingId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        alert("✅ Vendor Master Updated Successfully!");
      } else {
        await fetchJson(`${MASTERS}/vendors`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, opening_balance: parseFloat(formData.opening_balance || '0') || 0 }),
        });
        alert("✅ New Vendor Saved!");
      }
      setIsVendorModalOpen(false); fetchVendors();
    } catch (e: any) {
      alert(e?.code === 'DUPLICATE' ? "⚠️ Yeh vendor pehle se hai." : "❌ Error saving vendor: " + (e?.message || ''));
    }
  };

  // 💰 SAVE VENDOR TRANSACTION
  // No balance arithmetic here any more. The row is inserted and the balance
  // is recomputed from it on the next read; a payment additionally posts a
  // PAYMENT voucher so the sub-ledger and the general ledger cannot disagree.
  const handleSaveTxn = async () => {
    if (!txnData.vendor_id || !txnData.amount) return alert("⚠️ Select Vendor and enter Amount!");

    const txnAmt = parseFloat(txnData.amount);
    if (isNaN(txnAmt) || txnAmt <= 0) return alert("⚠️ Please enter a valid amount greater than 0!");

    const posting = txnData.txn_type === 'PAYMENT_GIVEN' && txnData.post_to_ledger;
    if (posting && !txnData.account) {
      return alert('🏦 Yeh paisa kis account se gaya?\n\nBank ya cash account chunein — entry ledger me post hogi aur koi account apne aap maan nahi liya jayega.\n\n(Sirf vendor khata update karna hai to "Subsidiary only" tick karein.)');
    }

    setSavingTxn(true);
    try {
      const j = await fetchJson(`${MASTERS}/vendors/${txnData.vendor_id}/ledger`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_type: txnData.txn_type,
          amount: txnAmt,
          txn_date: txnData.txn_date,
          payment_mode: txnData.payment_mode,
          account: posting ? txnData.account : null,
          remarks: txnData.remarks || null,
          post_to_ledger: posting,
          created_by: (JSON.parse(localStorage.getItem('prasad_user') || '{}').email) || null,
        }),
      });
      alert(j.voucher_id
        ? "✅ Payment saved — vendor khata + ledger voucher posted."
        : "✅ Transaction saved to the vendor khata." + (j.ledger_note ? `\n\n⚠️ Ledger: ${j.ledger_note}` : ''));
      setIsTxnModalOpen(false);
      setTxnData({ vendor_id: '', vendor_name: '', txn_date: new Date().toISOString().split('T')[0], txn_type: 'PAYMENT_GIVEN', amount: '', payment_mode: 'Bank Transfer', remarks: '', account: '', post_to_ledger: true });
      fetchVendors();
    } catch (e: any) {
      const said = {
        OVERDRAFT: 'Us account me itna balance nahi hai.',
        NO_ACCOUNT: 'Account chunein — koi account apne aap nahi maana jata.',
        DUPLICATE_REF: 'Yeh reference pehle hi post ho chuka hai.',
      }[e?.code];
      alert("❌ " + (said || e?.message || 'Transaction failed.'));
      console.error(e);
    }
    setSavingTxn(false);
  };

  const openVendorModal = (vendor: any = null) => {
    if (vendor) { setFormData({ ...vendor, status: vendor.status === 'INACTIVE' ? 'Inactive' : 'Active' }); setEditingId(vendor.id); }
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
      remarks: '',
      account: '',
      post_to_ledger: true
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
                <>
                  <div>
                    <label style={{ fontSize:'12px', color:'#94a3b8' }}>Payment Mode</label>
                    <select className="modern-input" value={txnData.payment_mode} onChange={e=>setTxnData({...txnData, payment_mode: e.target.value})}>
                      <option value="Bank Transfer">Bank Transfer (NEFT/RTGS)</option>
                      <option value="UPI">UPI</option>
                      <option value="Cash">Cash</option>
                      <option value="Cheque">Cheque</option>
                    </select>
                  </div>

                  {/* A payment moves real money out of a real account. The
                      account is the operator's choice and is never defaulted —
                      guessing it would post the entry against the wrong bank. */}
                  <div style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '10px', padding: '14px' }}>
                    <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold' }}>Paid from which account? *</label>
                    <select className="modern-input" style={{ marginTop: '6px' }} disabled={!txnData.post_to_ledger}
                            value={txnData.account} onChange={e=>setTxnData({...txnData, account: e.target.value})}>
                      <option value="">-- Select the bank / cash account --</option>
                      {accounts.map((a: any) => (
                        <option key={a.ledger_name} value={a.ledger_name}>
                          {a.ledger_name} — ₹{Number(a.balance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </option>
                      ))}
                    </select>
                    <div style={{ marginTop: '10px', fontSize: '11px', color: '#94a3b8' }}>
                      Posts <b style={{ color: '#f87171' }}>Dr Creditors: {txnData.vendor_name || 'vendor'}</b>
                      {' / '}<b style={{ color: '#34d399' }}>Cr {txnData.account || 'the account you select'}</b>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '11px', color: '#94a3b8', cursor: 'pointer' }}>
                      <input type="checkbox" checked={!txnData.post_to_ledger}
                             onChange={e=>setTxnData({...txnData, post_to_ledger: !e.target.checked, account: e.target.checked ? '' : txnData.account})} />
                      Subsidiary only — record in the vendor khata without a ledger voucher
                    </label>
                  </div>
                </>
              )}

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Remarks / Bill No / Reference</label><input className="modern-input" value={txnData.remarks} onChange={e=>setTxnData({...txnData, remarks: e.target.value})} placeholder="e.g. Bill #104 or UTR No" /></div>
            </div>
            
            <button className="glow-btn" disabled={savingTxn} style={{ width: '100%', marginTop: '25px', padding: '15px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', opacity: savingTxn ? 0.6 : 1, cursor: savingTxn ? 'wait' : 'pointer' }} onClick={handleSaveTxn}>
              {savingTxn ? 'Posting…' : txnData.txn_type === 'BILL_RECEIVED' ? '🧾 Add to Bill Ledger' : '💸 Confirm Payment'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}