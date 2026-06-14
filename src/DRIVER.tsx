// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

// 🌟 FIX: UNIVERSAL DRIVE LINK EXTRACTOR (Bypasses Access Denied & Reads Old Data)
const getDriveLinks = (rawLink: string) => {
  if (!rawLink) return { view: '#', download: '#' };
  let fileId = '';
  try {
    if (rawLink.includes('/d/')) {
       fileId = rawLink.split('/d/')[1].split('/')[0];
    } else if (rawLink.includes('id=')) {
       fileId = rawLink.split('id=')[1].split('&')[0];
    }
  } catch (e) { console.error("Link Parse Error", e); }

  if (fileId) {
    return { 
      view: `https://drive.google.com/file/d/${fileId}/preview`, 
      download: `https://drive.google.com/uc?export=download&id=${fileId}` 
    };
  }
  return { view: rawLink, download: rawLink }; 
};

export default function DriverMgmt() {
  const [activeTab, setActiveTab] = useState('MASTER');
  const [drivers, setDrivers] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]); 
  const [loading, setLoading] = useState(true);

  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [localPicPreview, setLocalPicPreview] = useState<string | null>(null);

  const [isScanning, setIsScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [scannedAIData, setScannedAIData] = useState<any>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  // 🌟 NEW: ADDITIONAL DOCS STATE
  const [newCustomDocName, setNewCustomDocName] = useState('');
  
  const [driverData, setDriverData] = useState({
    name: '', mobile: '', profile_pic: '', address: '',
    license_no: '', license_expiry: '', dl_photo: '',
    hzd_cert_no: '', hzd_expiry: '', hzd_photo: '',
    aadhar_no: '', aadhar_photo: '', pan_no: '', pan_photo: '',
    bank_name: '', account_no: '', ifsc_code: '', bank_photo: '',
    guarantor_name: '', guarantor_mobile: '',
    join_date: new Date().toISOString().split('T')[0], 
    status: 'ACTIVE', 
    approval_status: 'PENDING',
    additional_docs: [] // 🌟 NEW: Store array of custom objects {id, name, link, valid_till}
  });

  const [selectedDriver, setSelectedDriver] = useState('');
  const [settleData, setSettleData] = useState({
    date: new Date().toISOString().split('T')[0],
    txn_type: 'SALARY_CREDIT', 
    amount: '',
    remarks: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const dSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(dSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => (a.name || '').localeCompare(b.name || '')));

      const tSnap = await getDocs(collection(db, "DRIVER_TRANSACTIONS"));
      setTransactions(tSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => new Date(b.date || b.createdAt).getTime() - new Date(a.date || a.createdAt).getTime()));

      try {
        const reqSnap = await getDocs(collection(db, "DRIVER_REQUESTS"));
        setPendingRequests(reqSnap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter((r:any) => r.status === 'PENDING' || r.status === 'APPROVED'));
      } catch(e) {}

    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleApproveRequest = async (req: any) => {
    if (!window.confirm(`Pass ${req.type} of ₹${req.amount} for ${req.driver_name}?\n(This will send it to Cashier for Payment)`)) return;
    try {
      await updateDoc(doc(db, "DRIVER_REQUESTS", req.id), { status: 'APPROVED', approvedAt: serverTimestamp() });
      alert("✅ Request Passed! Forwarded to Cashier for Payment.");
      fetchData(); 
    } catch(e) { alert("❌ Error processing approval."); }
  };

  const handlePayRequest = async (req: any) => {
    const payMode = window.prompt(`How are you paying ₹${req.amount} to ${req.driver_name}?\n(Type: Cash / Bank / PhonePe / Petrol Pump Name)`, 'Cash');
    if (!payMode) return; 
    try {
      await updateDoc(doc(db, "DRIVER_REQUESTS", req.id), { status: 'PAID', paidAt: serverTimestamp(), payment_mode: payMode });
      if (req.type === 'ADVANCE' || req.type === 'FUEL' || req.type === 'EXPENSE') {
        await addDoc(collection(db, "DRIVER_TRANSACTIONS"), { 
          driver_name: req.driver_name, 
          txn_type: req.type === 'ADVANCE' ? 'ADVANCE_GIVEN' : 'FUEL_EXPENSE',
          amount: parseFloat(req.amount || 0), 
          date: new Date().toISOString().split('T')[0], 
          remarks: `[APP PAID via ${payMode}] ${req.remarks || req.type}`, 
          createdAt: serverTimestamp() 
        });
        alert(`✅ Payment Done via ${payMode} & Auto-Posted to Ledger!`);
      } else {
        alert("✅ Request Settled!");
      }
      fetchData(); 
    } catch(e) { alert("❌ Error processing payment."); }
  };

  const handleRejectRequest = async (reqId: string) => {
    if (!window.confirm("Are you sure you want to REJECT this request?")) return;
    try {
      await updateDoc(doc(db, "DRIVER_REQUESTS", reqId), { status: 'REJECTED', rejectedAt: serverTimestamp() });
      fetchData();
    } catch(e) { alert("Error rejecting request."); }
  };

  // 🌍 UPLOAD TO GOOGLE DRIVE
  const handleDocUpload = async (e: any, field: string) => {
    const file = e.target.files[0];
    if (!file) return;

    if (field === 'profile_pic') setLocalPicPreview(URL.createObjectURL(file));

    setUploadingField(field); 
    setScannedAIData(null);

    const data = new FormData();
    data.append('file', file);
    data.append('driverName', driverData.name || 'New_Driver_Doc'); 
    data.append('docType', field);

    try {
      const response = await fetch('https://prasad-api.onrender.com/upload-to-drive', { 
        method: 'POST', 
        body: data 
      });
      const result = await response.json();
      if (result.success) {
        
        // 🌟 Handle Custom Docs vs Standard Docs
        if (field.startsWith('custom_')) {
           const updatedDocs = driverData.additional_docs.map((d: any) => 
               d.id === field ? { ...d, link: result.driveLink } : d
           );
           setDriverData(prev => ({ ...prev, additional_docs: updatedDocs }));
        } else {
           setDriverData(prev => ({ ...prev, [field]: result.driveLink })); 
        }

        setScannedAIData(result.aiData); 
        alert("✅ Document Saved to Secure Cloud!");
      } else alert("❌ Drive Upload Error: " + result.message);
    } catch (error) { alert("❌ Live Server is unreachable right now!"); }
    setUploadingField(null); 
  };

  // 🌟 NEW: ADD CUSTOM DOCUMENT CARD
  const handleAddCustomDoc = () => {
     if(!newCustomDocName.trim()) return alert("Please enter document name (e.g. Police Verification)");
     const newDoc = {
        id: `custom_${Date.now()}`,
        name: newCustomDocName.trim(),
        link: '',
        valid_till: ''
     };
     setDriverData(prev => ({
        ...prev, 
        additional_docs: [...(prev.additional_docs || []), newDoc]
     }));
     setNewCustomDocName('');
  };

  const handleCustomDocChange = (id: string, field: string, value: string) => {
     const updatedDocs = driverData.additional_docs.map((d: any) => 
         d.id === id ? { ...d, [field]: value } : d
     );
     setDriverData(prev => ({ ...prev, additional_docs: updatedDocs }));
  };

  const removeCustomDoc = (id: string) => {
     if(!window.confirm("Remove this document card?")) return;
     const updatedDocs = driverData.additional_docs.filter((d: any) => d.id !== id);
     setDriverData(prev => ({ ...prev, additional_docs: updatedDocs }));
  };


  const formatForDatePicker = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      const parts = dateStr.match(/\d+/g);
      if (parts && parts.length >= 3) {
        const d = parts[0], m = parts[1], y = parts[2];
        if (y.length === 4) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        if (d.length === 4) return `${d}-${m.padStart(2, '0')}-${y.padStart(2, '0')}`;
      }
      return dateStr;
    } catch (e) {
      return "";
    }
  };

  const speakSmartHinglishReport = async (docType: string) => {
      const aiSpeech = `नमस्कार सुभाष सर। आपका ${docType === 'DL' ? 'ड्राइविंग लाइसेंस' : docType} सफलतापूर्वक स्कैन हो गया है। असली डेटा निकाल लिया गया है।`;
      try {
          const response = await fetch("https://prasad-api.onrender.com/speak", {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: aiSpeech })
          });
          const data = await response.json();
          if (data.success && data.audioContent) {
              const audioSrc = `data:audio/mp3;base64,${data.audioContent}`;
              const audio = new Audio(audioSrc);
              audio.play(); 
          }
      } catch (error) { console.error("Error playing voice:", error); }
  };

  const triggerAIScan = (docType: string) => {
      if ((docType === 'DL' && !driverData.dl_photo) || 
          (docType === 'AADHAAR' && !driverData.aadhar_photo)) {
          alert(`⚠️ Please upload ${docType} document first!`);
          return;
      }
      if (!scannedAIData) {
          alert(`⚠️ AI data is processing or missing. Please re-upload if it fails.`);
          return;
      }

      setIsScanning(true);
      setScanMessage(`🤖 Extracting real data from ${docType}...`);

      setTimeout(() => {
          setIsScanning(false);
          setScanMessage('');
          
          const cleanDocNumber = scannedAIData.documentNumber ? scannedAIData.documentNumber.replace(/[^A-Za-z0-9/-]/g, '') : "";
          const formattedDate = formatForDatePicker(scannedAIData.documentDate);
          const extraDetails = scannedAIData.extraDetails || scannedAIData.partyName || "";

          if (docType === 'DL') {
              setDriverData(prev => ({
                  ...prev,
                  license_no: cleanDocNumber || prev.license_no,
                  license_expiry: formattedDate || prev.license_expiry
              }));
          } else if (docType === 'AADHAAR') {
              setDriverData(prev => ({
                  ...prev,
                  aadhar_no: cleanDocNumber || prev.aadhar_no,
                  address: extraDetails || prev.address 
              }));
          }
          
          alert(`🤖 Mamta AI Scan Complete! Real Data Extracted from ${docType}.`);
          speakSmartHinglishReport(docType); 
      }, 1000);
  };

  const handleSaveDriver = async () => {
    if (!driverData.name || !driverData.mobile) return alert("⚠️ Name and Mobile are required!");
    try {
      if (editingId) {
        await updateDoc(doc(db, "DRIVERS", editingId), driverData);
        alert("✅ Driver Profile Updated Successfully!");
      } else {
        const docRef = await addDoc(collection(db, "DRIVERS"), { ...driverData, createdAt: serverTimestamp() });
        await addDoc(collection(db, "LEDGERS"), {
          ledger_name: driverData.name, group_head: "Current Assets - Driver Advances", opening_balance: 0, current_balance: 0, creation_type: "AUTO_SYSTEM", linked_module: "DRIVER", linked_id: docRef.id, created_at: serverTimestamp()
        });
        alert("✅ Full KYC Profile & Auto-Ledger Created Successfully!");
      }
      closeModal(); fetchData();
    } catch (e) { alert("❌ Error saving driver."); }
  };

  const handleDeleteDriver = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to permanently erase the record of ${name}?`)) {
      try { await deleteDoc(doc(db, "DRIVERS", id)); fetchData(); } catch (e) { alert("Error deleting driver."); }
    }
  };

  const openEditModal = (driver: any) => {
    // Make sure additional_docs is always an array when editing
    setDriverData({ ...driver, additional_docs: driver.additional_docs || [] }); 
    setEditingId(driver.id); 
    setLocalPicPreview(driver.profile_pic || null); 
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false); setEditingId(null); setLocalPicPreview(null); setScannedAIData(null);
    setDriverData({ name: '', mobile: '', profile_pic: '', address: '', license_no: '', license_expiry: '', dl_photo: '', hzd_cert_no: '', hzd_expiry: '', hzd_photo: '', aadhar_no: '', aadhar_photo: '', pan_no: '', pan_photo: '', bank_name: '', account_no: '', ifsc_code: '', bank_photo: '', guarantor_name: '', guarantor_mobile: '', join_date: new Date().toISOString().split('T')[0], status: 'ACTIVE', approval_status: 'PENDING', additional_docs: [] });
  };

  const handleSaveTransaction = async () => {
    if (!selectedDriver || !settleData.amount) return alert("⚠️ Select Driver and Enter Amount!");
    try {
      await addDoc(collection(db, "DRIVER_TRANSACTIONS"), { driver_name: selectedDriver, txn_type: settleData.txn_type, amount: parseFloat(settleData.amount), date: settleData.date, remarks: settleData.remarks, createdAt: serverTimestamp() });
      alert(`✅ ${settleData.txn_type.replace('_', ' ')} entry saved!`);
      setSettleData({ ...settleData, amount: '', remarks: '' }); fetchData();
    } catch (e) { alert("❌ Error saving transaction."); }
  };

  const sendDriverWhatsApp = (driver: any) => {
    if (!driver.mobile) { alert("⚠️ Mobile number not found!"); return; }
    const message = `Hello ${driver.name},\n\nThis is a message from Prasad Transport ERP.\n\nPlease contact the transport office for your next trip assignment.\n\nDrive safe! 🚛`;
    let phone = driver.mobile.replace(/\s+/g, ''); if (phone.length === 10) phone = '91' + phone;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  const driverTxns = transactions.filter(t => t.driver_name === selectedDriver);
  const totalSalary = driverTxns.filter(t => t.txn_type === 'SALARY_CREDIT').reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  const totalAdvance = driverTxns.filter(t => t.txn_type === 'ADVANCE_GIVEN' || t.txn_type === 'ADVANCE').reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  const totalShortage = driverTxns.filter(t => t.txn_type === 'SHORTAGE_DEDUCTION').reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  const totalPaid = driverTxns.filter(t => t.txn_type === 'FINAL_PAYMENT').reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  const netPayable = totalSalary - (totalAdvance + totalShortage + totalPaid);

  const activeDriversCount = drivers.filter(d => d.status === 'ACTIVE' || !d.status).length;
  const pendingApprovalsCount = drivers.filter(d => d.approval_status === 'PENDING' || !d.approval_status).length;
  const totalAdvancesAll = transactions.filter(t => t.txn_type === 'ADVANCE_GIVEN').reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.3s; }
        .glass-card:hover { box-shadow: 0 10px 30px -10px rgba(56, 189, 248, 0.2); }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border: none; padding: 12px 25px; border-radius: 50px; font-weight: bold; cursor: pointer; transition: 0.3s; box-shadow: 0 0 15px rgba(59, 130, 246, 0.3); }
        .glow-btn:hover { box-shadow: 0 0 25px rgba(59, 130, 246, 0.6); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(2, 6, 23, 0.85); backdrop-filter: blur(10px); display: flex; justify-content: center; align-items: center; z-index: 9999; overflow-y: auto; padding: 20px;}
        .modal-content { background: #0f172a; border: 1px solid #c084fc; width: 100%; max-width: 1400px; padding: 40px; border-radius: 20px; box-shadow: 0 0 50px rgba(192, 132, 252, 0.2); }
        
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 10px; color: white; padding: 12px 16px; outline: none; width: 100%; box-sizing: border-box; font-size: 14px;}
        .modern-input:focus { border-color: #c084fc; box-shadow: 0 0 15px rgba(192, 132, 252, 0.3); background: rgba(15, 23, 42, 0.9); }
        
        .doc-card { background: rgba(15, 23, 42, 0.4); border: 1px solid rgba(51, 65, 85, 0.6); border-radius: 12px; padding: 15px; margin-bottom: 15px; box-shadow: inset 0 0 10px rgba(0,0,0,0.2); transition: 0.3s; position: relative;}
        .doc-card:hover { border-color: rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.6); }
        .doc-card label { color: #cbd5e1; font-size: 11px; margin-bottom: 8px; display: block;}
        
        .upload-btn { background: rgba(51, 65, 85, 0.8); border: 1px dashed #94a3b8; color: #cbd5e1; padding: 12px; border-radius: 8px; cursor: pointer; text-align: center; transition: 0.3s; font-size: 12px; display: flex; align-items: center; justify-content: center; font-weight: bold; width: 100%; box-sizing: border-box;}
        .upload-btn:hover { background: rgba(192, 132, 252, 0.2); border-color: #c084fc; color: #c084fc; }
        
        .view-btn { background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; color: #10b981; padding: 10px; border-radius: 8px; text-decoration: none; text-align: center; font-size: 11px; font-weight: bold; display: flex; align-items: center; justify-content: center; transition: 0.3s; width: 100%; box-sizing: border-box;}
        .view-btn:hover { background: #10b981; color: #020617; box-shadow: 0 0 10px rgba(16, 185, 129, 0.4); }
        
        .update-btn { background: rgba(245, 158, 11, 0.1); border: 1px dashed #f59e0b; color: #f59e0b; padding: 10px; border-radius: 8px; font-size: 11px;}
        .update-btn:hover { background: #f59e0b; color: #020617; }

        .ai-btn { background: rgba(56, 189, 248, 0.1); border: 1px solid #38bdf8; color: #38bdf8; padding: 10px; border-radius: 8px; cursor: pointer; text-align: center; transition: 0.3s; font-size: 11px; display: flex; align-items: center; justify-content: center; font-weight: bold; width: 100%; box-sizing: border-box;}
        .ai-btn:hover { background: #38bdf8; color: #0f172a; box-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }
        .ai-btn:disabled { opacity: 0.3; cursor: not-allowed; border-color: #64748b; color: #64748b; background: transparent;}
        
        table { width: 100%; border-collapse: collapse; margin-top: 10px; color: #e2e8f0; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 15px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px;}
        td { padding: 15px; border-bottom: 1px solid rgba(255,255,255,0.05); }
        tr:hover td { background: rgba(255,255,255,0.02); }
        
        .badge { padding: 6px 12px; border-radius: 20px; font-size: 10px; font-weight: bold; display: inline-block; letter-spacing: 0.5px;}
        
        .action-btn { background: rgba(56, 189, 248, 0.1); border: 1px solid #38bdf8; color: #38bdf8; padding: 6px 12px; border-radius: 20px; font-size: 11px; cursor: pointer; transition: 0.2s; font-weight: bold; }
        .action-btn:hover { background: #38bdf8; color: #0f172a; }
        .action-btn.delete { background: rgba(239, 68, 68, 0.1); border-color: #ef4444; color: #ef4444; }
        .action-btn.delete:hover { background: #ef4444; color: white; }
        
        label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 5px; text-transform: uppercase; font-weight: bold;}
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900', letterSpacing: '-1px' }}>Driver Command Center</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0 0 0', fontSize: '15px' }}>Full KYC, App Approvals, Alerts & Financial Settlements</p>
        </div>
        <button className="glow-btn" onClick={() => setIsModalOpen(true)}>👨‍✈️ + Register New Driver</button>
      </div>

      {/* 📊 SMART DASHBOARD STATS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '30px' }}>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #38bdf8' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Registered</div>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#fff' }}>{drivers.length}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #10b981' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Active Drivers</div>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#10b981' }}>{activeDriversCount}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #f59e0b' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Pending Approvals</div>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#f59e0b' }}>{pendingApprovalsCount}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #c084fc' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Advances Given</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#c084fc' }}>₹{totalAdvancesAll.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
        </div>
      </div>

      {/* 🔔 NEW COMPONENT: PENDING & APPROVED REQUESTS */}
      {pendingRequests.length > 0 && (
        <div className="glass-card" style={{ padding: '20px', marginBottom: '30px', borderLeft: '4px solid #ef4444', animation: 'pulse 2s infinite' }}>
          <h3 style={{ margin: '0 0 15px 0', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '10px' }}>
            🔔 Action Needed: App Requests ({pendingRequests.length})
          </h3>
          <div style={{ display: 'flex', gap: '15px', overflowX: 'auto', paddingBottom: '10px' }}>
            {pendingRequests.map(req => (
              <div key={req.id} style={{ minWidth: '300px', background: 'rgba(15, 23, 42, 0.8)', padding: '15px', borderRadius: '12px', border: `1px solid ${req.status === 'APPROVED' ? '#10b981' : '#334155'}`, flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <b style={{ color: '#fff' }}>{req.driver_name || 'Driver'}</b>
                  <div style={{ display: 'flex', gap: '5px' }}>
                    <span style={{ fontSize: '10px', background: 'rgba(239,68,68,0.2)', color: '#ef4444', padding: '3px 8px', borderRadius: '10px', fontWeight: 'bold' }}>
                      {req.type || 'REQUEST'}
                    </span>
                    {req.status === 'APPROVED' && (
                      <span style={{ fontSize: '10px', background: '#f59e0b', color: '#fff', padding: '3px 8px', borderRadius: '10px', fontWeight: 'bold' }}>
                        WAITING PAYMENT
                      </span>
                    )}
                  </div>
                </div>
                <p style={{ margin: '0 0 5px 0', color: '#cbd5e1', fontSize: '12px' }}>{req.remarks || 'Sent a request from mobile app.'}</p>
                
                {req.amount && (
                  <p style={{ margin: '0 0 15px 0', color: '#38bdf8', fontWeight: 'bold', fontSize: '20px' }}>
                    ₹{req.amount}
                  </p>
                )}

                {req.status === 'PENDING' ? (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                    <button onClick={() => handleApproveRequest(req)} style={{ flex: 1, background: '#f59e0b', color: '#fff', border: 'none', padding: '8px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>👍 Pass/Approve</button>
                    <button onClick={() => handleRejectRequest(req.id)} style={{ flex: 1, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '8px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>❌ Reject</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                    <button onClick={() => handlePayRequest(req)} style={{ width: '100%', background: '#10b981', color: '#fff', border: 'none', padding: '10px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '14px', boxShadow: '0 4px 10px rgba(16,185,129,0.3)' }}>💳 Pay & Settle Khata</button>
                  </div>
                )}

              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <button className={`tab-btn ${activeTab === 'MASTER' ? 'active' : ''}`} onClick={() => setActiveTab('MASTER')}>👨‍✈️ DRIVER LIST (KYC)</button>
        <button className={`tab-btn ${activeTab === 'SETTLEMENT' ? 'active' : ''}`} onClick={() => setActiveTab('SETTLEMENT')}>💸 SALARY & SETTLEMENT</button>
        <button className={`tab-btn ${activeTab === 'LEDGER' ? 'active' : ''}`} onClick={() => setActiveTab('LEDGER')}>📓 ALL TRANSACTIONS</button>
      </div>

      {/* 👨‍✈️ TAB 1: DRIVER MASTER */}
      {activeTab === 'MASTER' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Drivers from Server...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Driver Identity</th>
                  <th>Licenses & HZD</th>
                  <th>KYC Documents</th>
                  <th>Extra / Additional Docs</th>{/* NEW COLUMN */}
                  <th>Approval & Actions</th>
                </tr>
              </thead>
              <tbody>
                {drivers.length === 0 ? <tr><td colSpan={5} style={{ textAlign: 'center', padding: '30px' }}>No Drivers found.</td></tr> : 
                  drivers.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <div style={{ width: '50px', height: '50px', borderRadius: '50%', background: '#1e293b', border: '2px solid #38bdf8', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyItems: 'center' }}>
                          {d.profile_pic ? <img src={d.profile_pic} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: '20px' }}>👨‍✈️</span>}
                        </div>
                        <div>
                          <b style={{ color: '#fff', fontSize: '16px' }}>{d.name}</b><br/>
                          <span style={{ color: '#94a3b8', fontSize: '12px' }}>📱 {d.mobile}</span><br/>
                          <button onClick={() => sendDriverWhatsApp(d)} style={{ background: 'rgba(34, 197, 94, 0.2)', color: '#22c55e', border: '1px solid #22c55e', padding: '2px 8px', borderRadius: '10px', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', marginTop: '5px' }}>💬 WhatsApp</button>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span style={{ color: d.dl_photo ? '#10b981' : '#cbd5e1' }}>DL: {d.license_no || 'N/A'} {d.dl_photo && <a href={getDriveLinks(d.dl_photo).view} target="_blank" rel="noreferrer" style={{color:'#10b981', textDecoration:'none'}}>✅</a>}</span><br/>
                      <small style={{ color: '#64748b' }}>Exp: {d.license_expiry || 'N/A'}</small><br/>
                      <span style={{ color: d.hzd_photo ? '#10b981' : '#f59e0b', fontSize: '12px' }}>HZD: {d.hzd_cert_no || 'N/A'} {d.hzd_photo && <a href={getDriveLinks(d.hzd_photo).view} target="_blank" rel="noreferrer" style={{color:'#10b981', textDecoration:'none'}}>✅</a>}</span>
                    </td>
                    <td>
                      <span style={{ color: d.aadhar_photo ? '#10b981' : '#cbd5e1' }}>UID: {d.aadhar_no || 'N/A'} {d.aadhar_photo && <a href={getDriveLinks(d.aadhar_photo).view} target="_blank" rel="noreferrer" style={{color:'#10b981', textDecoration:'none'}}>✅</a>}</span><br/>
                      <span style={{ color: d.pan_photo ? '#10b981' : '#cbd5e1' }}>PAN: {d.pan_no || 'N/A'} {d.pan_photo && <a href={getDriveLinks(d.pan_photo).view} target="_blank" rel="noreferrer" style={{color:'#10b981', textDecoration:'none'}}>✅</a>}</span><br/>
                      <span style={{ color: '#38bdf8', fontSize: '11px' }}>A/C: {d.account_no || 'N/A'}</span>
                    </td>
                    <td>
                       {/* 🌟 NEW: SHOW ADDITIONAL DOCS */}
                       {(!d.additional_docs || d.additional_docs.length === 0) ? <span style={{ color: '#64748b', fontSize: '11px' }}>No Extra Docs</span> : 
                         d.additional_docs.map((doc: any, i: number) => (
                           <div key={i} style={{ marginBottom: '4px', fontSize: '11px' }}>
                              <span style={{ color: doc.link ? '#10b981' : '#cbd5e1' }}>• {doc.name} {doc.link && <a href={getDriveLinks(doc.link).view} target="_blank" rel="noreferrer" style={{color:'#10b981', textDecoration:'none'}}>✅</a>}</span>
                              {doc.valid_till && <div style={{ color: '#94a3b8', paddingLeft: '8px', fontSize: '10px' }}>Exp: {doc.valid_till}</div>}
                           </div>
                         ))
                       }
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-start' }}>
                        <span className="badge" style={{ 
                          background: d.approval_status === 'APPROVED' ? 'rgba(16,185,129,0.1)' : d.approval_status === 'REJECTED' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)', 
                          color: d.approval_status === 'APPROVED' ? '#10b981' : d.approval_status === 'REJECTED' ? '#ef4444' : '#f59e0b',
                          border: `1px solid ${d.approval_status === 'APPROVED' ? '#10b981' : d.approval_status === 'REJECTED' ? '#ef4444' : '#f59e0b'}`
                        }}>
                          {d.approval_status === 'APPROVED' ? '✅ VERIFIED' : d.approval_status === 'REJECTED' ? '❌ REJECTED' : '⏳ PENDING'}
                        </span>
                        <span className="badge" style={{ background: d.status === 'ACTIVE' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: d.status === 'ACTIVE' ? '#10b981' : '#ef4444' }}>
                          {d.status === 'ACTIVE' ? '🟢 ON DUTY' : '🔴 INACTIVE'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button className="action-btn" onClick={() => openEditModal(d)}>Configure</button>
                        <button className="action-btn delete" onClick={() => handleDeleteDriver(d.id, d.name)}>Erase</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 💸 TAB 2: SETTLEMENT & FINAL PAY */}
      {activeTab === 'SETTLEMENT' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '25px' }}>
          <div className="glass-card" style={{ padding: '30px', borderTop: '4px solid #f59e0b' }}>
            <h2 style={{ color: '#f59e0b', marginTop: 0, marginBottom: '25px', fontSize: '20px' }}>Create Ledger Entry</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div><label>Select Driver *</label>
                <select className="modern-input" value={selectedDriver} onChange={e=>setSelectedDriver(e.target.value)}>
                  <option value="">-- Choose Driver --</option>
                  {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                </select>
              </div>
              <div><label>Entry Type *</label>
                <select className="modern-input" value={settleData.txn_type} onChange={e=>setSettleData({...settleData, txn_type: e.target.value})}>
                  <option value="SALARY_CREDIT">🟢 (+) Add Salary / Trip Bhatta</option>
                  <option value="ADVANCE_GIVEN">🟡 (-) Give Advance</option>
                  <option value="FINAL_PAYMENT">🔵 (-) Make Final Payment</option>
                  <option value="SHORTAGE_DEDUCTION">🔴 (-) Manual Shortage Deduction</option>
                </select>
              </div>
              <div><label>Transaction Date</label><input type="date" className="modern-input" value={settleData.date} onChange={e=>setSettleData({...settleData, date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div><label style={{ color:'#38bdf8' }}>Amount (₹) *</label>
                <input type="number" className="modern-input" placeholder="0.00" style={{ fontSize: '24px', fontWeight: 'bold', border: '1px solid #38bdf8', color: '#38bdf8' }} value={settleData.amount} onChange={e=>setSettleData({...settleData, amount: e.target.value})} />
              </div>
              <div><label>Remarks / Notes</label><input className="modern-input" placeholder="e.g. Trip Advance for AS01X1234" value={settleData.remarks} onChange={e=>setSettleData({...settleData, remarks: e.target.value})} /></div>
              <button className="glow-btn" style={{ marginTop: '10px', width: '100%', fontSize: '16px' }} onClick={handleSaveTransaction}>✅ Post to Ledger</button>
            </div>
          </div>

          <div className="glass-card" style={{ padding: '30px', borderTop: '4px solid #38bdf8' }}>
            <h2 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '25px', fontSize: '20px' }}>Driver Khata Summary</h2>
            {!selectedDriver ? (
              <div style={{ textAlign: 'center', padding: '100px 20px', color: '#64748b', fontSize: '18px' }}>👈 Please select a driver from the dropdown above to view their complete financial summary.</div>
            ) : (
              <>
                <h2 style={{ color: '#fff', margin: '0 0 20px 0', fontSize: '28px' }}>👤 {selectedDriver}</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '30px' }}>
                  <div style={{ background: 'rgba(16, 185, 129, 0.05)', padding: '20px', borderRadius: '15px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                    <div style={{ fontSize: '13px', color: '#10b981', fontWeight: 'bold', textTransform: 'uppercase' }}>(+) Total Earned (Salary)</div>
                    <div style={{ fontSize: '32px', color: '#10b981', fontWeight: '900', marginTop: '5px' }}>₹{totalSalary.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                  </div>
                  <div style={{ background: 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '15px', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                    <div style={{ fontSize: '13px', color: '#f59e0b', fontWeight: 'bold', textTransform: 'uppercase' }}>(-) Total Advance Taken</div>
                    <div style={{ fontSize: '32px', color: '#f59e0b', fontWeight: '900', marginTop: '5px' }}>₹{totalAdvance.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                  </div>
                  <div style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '20px', borderRadius: '15px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                    <div style={{ fontSize: '13px', color: '#ef4444', fontWeight: 'bold', textTransform: 'uppercase' }}>(-) Shortages / Penalties</div>
                    <div style={{ fontSize: '32px', color: '#ef4444', fontWeight: '900', marginTop: '5px' }}>₹{totalShortage.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                  </div>
                  <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '20px', borderRadius: '15px', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                    <div style={{ fontSize: '13px', color: '#38bdf8', fontWeight: 'bold', textTransform: 'uppercase' }}>(-) Final Payments Cleared</div>
                    <div style={{ fontSize: '32px', color: '#38bdf8', fontWeight: '900', marginTop: '5px' }}>₹{totalPaid.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                  </div>
                </div>
                <div style={{ background: netPayable >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', padding: '30px', borderRadius: '15px', border: `2px dashed ${netPayable >= 0 ? '#10b981' : '#ef4444'}`, textAlign: 'center' }}>
                  <h3 style={{ margin: '0 0 10px 0', color: netPayable >= 0 ? '#10b981' : '#ef4444', letterSpacing: '1px' }}>
                    {netPayable >= 0 ? '💰 NET BALANCE PAYABLE TO DRIVER' : '⚠️ DRIVER OWES COMPANY (NEGATIVE BALANCE)'}
                  </h3>
                  <div style={{ fontSize: '48px', fontWeight: '900', color: netPayable >= 0 ? '#10b981' : '#ef4444' }}>
                    ₹{Math.abs(netPayable).toLocaleString(undefined, {minimumFractionDigits: 2})}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 📓 TAB 3: ALL TRANSACTIONS */}
      {activeTab === 'LEDGER' && (
        <div className="glass-card" style={{ padding: '30px', overflowX: 'auto' }}>
           <h2 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '20px', fontSize: '24px' }}>Global Transaction Ledger</h2>
           <table>
            <thead>
              <tr><th>Date</th><th>Driver Name</th><th>Transaction Category</th><th>Remarks / Trip Notes</th><th style={{ textAlign: 'right' }}>Amount (₹)</th></tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? <tr><td colSpan={5} style={{textAlign: 'center', padding: '30px'}}>No transactions recorded yet.</td></tr> : 
                transactions.map((t, i) => (
                <tr key={i}>
                  <td style={{ color: '#94a3b8' }}>{t.date}</td>
                  <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{t.driver_name}</td>
                  <td>
                    <span className="badge" style={{ background: t.txn_type.includes('SALARY') ? 'rgba(16,185,129,0.15)' : t.txn_type.includes('SHORTAGE') ? 'rgba(239,68,68,0.15)' : t.txn_type.includes('ADVANCE') ? 'rgba(245,158,11,0.15)' : 'rgba(56,189,248,0.15)', color: t.txn_type.includes('SALARY') ? '#10b981' : t.txn_type.includes('SHORTAGE') ? '#ef4444' : t.txn_type.includes('ADVANCE') ? '#f59e0b' : '#38bdf8', border: `1px solid ${t.txn_type.includes('SALARY') ? '#10b981' : t.txn_type.includes('SHORTAGE') ? '#ef4444' : t.txn_type.includes('ADVANCE') ? '#f59e0b' : '#38bdf8'}` }}>
                      {t.txn_type.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={{ color: '#cbd5e1' }}>{t.remarks || '-'}</td>
                  <td style={{ textAlign: 'right', fontWeight: '900', fontSize: '16px', color: t.txn_type.includes('SALARY') ? '#10b981' : '#ef4444' }}>
                    {t.txn_type.includes('SALARY') ? '+' : '-'} ₹{parseFloat(t.amount).toLocaleString(undefined, {minimumFractionDigits: 2})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 🤖 MEGA MODAL: FULL KYC, APPROVAL & UPLOADS */}
      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ display: 'flex', flexDirection: 'column', height: '95vh' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#c084fc', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '28px' }}>
                {editingId ? '✏️ Update Driver & Approvals' : '🤖 Driver Onboarding & KYC'}
              </h2>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            
            {isScanning && <div style={{ background: 'rgba(56, 189, 248, 0.2)', color: '#38bdf8', padding: '15px', textAlign: 'center', borderRadius: '10px', marginBottom: '20px', fontWeight: 'bold', border: '1px dashed #38bdf8', fontSize: '16px' }}>{scanMessage}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 768 ? 'repeat(3, 1fr)' : '1fr', gap: '30px', overflowY: 'auto', paddingRight: '10px', flex: 1 }}>
              
              {/* --- COLUMN 1: CORE DETAILS --- */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <h4 style={{ color: '#38bdf8', margin: '0 0 10px 0', borderBottom: '1px dashed #334155', paddingBottom: '5px' }}>👤 CORE DETAILS</h4>
                
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '10px' }}>
                  <div style={{ position: 'relative', width: '120px', height: '120px', borderRadius: '50%', border: '2px dashed #c084fc', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)' }}>
                    {localPicPreview || driverData.profile_pic ? <img src={localPicPreview || driverData.profile_pic} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '12px' }}>📷<br/>Passport<br/>Photo</div>}
                    <input type="file" accept="image/*" onChange={(e) => handleDocUpload(e, 'profile_pic')} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                  </div>
                </div>

                <div><label>Full Name *</label><input className="modern-input" value={driverData.name} onChange={e=>setDriverData({...driverData, name: e.target.value})} /></div>
                <div><label>Mobile Number *</label><input className="modern-input" value={driverData.mobile} onChange={e=>setDriverData({...driverData, mobile: e.target.value})} /></div>
                
                <div>
                  <label style={{ color: '#f59e0b' }}>App Approval Status *</label>
                  <select className="modern-input" value={driverData.approval_status || 'PENDING'} onChange={e=>setDriverData({...driverData, approval_status: e.target.value})} style={{ border: '1px solid #f59e0b' }}>
                    <option value="PENDING">⏳ Pending (From App)</option>
                    <option value="APPROVED">✅ Approved & Verified</option>
                    <option value="REJECTED">❌ Rejected (Invalid Docs)</option>
                  </select>
                </div>

                <div>
                  <label>Working Status</label>
                  <select className="modern-input" value={driverData.status} onChange={e=>setDriverData({...driverData, status: e.target.value})}>
                    <option value="ACTIVE">🟢 Active</option>
                    <option value="INACTIVE">🔴 Inactive / Left</option>
                  </select>
                </div>
              </div>

              {/* --- COLUMN 2: LICENSES & AADHAAR --- */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <h4 style={{ color: '#10b981', margin: '0 0 10px 0', borderBottom: '1px dashed #334155', paddingBottom: '5px' }}>🪪 LICENSE & AADHAAR</h4>
                
                <div className="doc-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label style={{ margin: 0 }}>Driving License Details</label>
                    <a href="https://parivahan.gov.in/rcdlstatus/" target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: '#38bdf8', textDecoration: 'none', background: 'rgba(56,189,248,0.1)', padding: '3px 8px', borderRadius: '5px', border: '1px solid #38bdf8', transition: '0.3s' }}>🌐 Verify Parivahan</a>
                  </div>
                  <input className="modern-input" placeholder="DL Number" value={driverData.license_no} onChange={e=>setDriverData({...driverData, license_no: e.target.value})} style={{marginBottom:'10px'}}/>
                  <input type="date" className="modern-input" value={driverData.license_expiry} onChange={e=>setDriverData({...driverData, license_expiry: e.target.value})} style={{colorScheme:'dark', marginBottom:'15px'}}/>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: driverData.dl_photo ? '1fr 1fr 1fr' : '2fr 1fr', gap: '8px' }}>
                    {driverData.dl_photo ? (
                      <>
                        <a href={getDriveLinks(driverData.dl_photo).view} target="_blank" rel="noreferrer" className="view-btn">👁️ View File</a>
                        <label className="upload-btn update-btn">
                          {uploadingField === 'dl_photo' ? '⏳...' : '🔄 Change'}
                          <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'dl_photo')} />
                        </label>
                      </>
                    ) : (
                      <label className="upload-btn">
                        {uploadingField === 'dl_photo' ? '⏳ Uploading...' : '📎 Upload DL'}
                        <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'dl_photo')} />
                      </label>
                    )}
                    <button className="ai-btn" onClick={() => triggerAIScan('DL')} disabled={!driverData.dl_photo}>🤖 Scan</button>
                  </div>
                </div>

                <div className="doc-card">
                  <label>Aadhaar Card Details</label>
                  <input className="modern-input" placeholder="Aadhaar Number" value={driverData.aadhar_no} onChange={e=>setDriverData({...driverData, aadhar_no: e.target.value})} style={{marginBottom:'15px'}}/>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: driverData.aadhar_photo ? '1fr 1fr 1fr' : '2fr 1fr', gap: '8px' }}>
                    {driverData.aadhar_photo ? (
                      <>
                        <a href={getDriveLinks(driverData.aadhar_photo).view} target="_blank" rel="noreferrer" className="view-btn">👁️ View File</a>
                        <label className="upload-btn update-btn">
                          {uploadingField === 'aadhar_photo' ? '⏳...' : '🔄 Change'}
                          <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'aadhar_photo')} />
                        </label>
                      </>
                    ) : (
                      <label className="upload-btn">
                        {uploadingField === 'aadhar_photo' ? '⏳ Uploading...' : '📎 Upload UID'}
                        <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'aadhar_photo')} />
                      </label>
                    )}
                    <button className="ai-btn" onClick={() => triggerAIScan('AADHAAR')} disabled={!driverData.aadhar_photo}>🤖 Scan</button>
                  </div>
                </div>

                <div className="doc-card">
                  <label>PAN Card Details</label>
                  <input className="modern-input" placeholder="PAN Number" value={driverData.pan_no} onChange={e=>setDriverData({...driverData, pan_no: e.target.value})} style={{marginBottom:'15px'}}/>
                  <div style={{ display: 'grid', gridTemplateColumns: driverData.pan_photo ? '1fr 1fr' : '1fr', gap: '8px' }}>
                    {driverData.pan_photo && <a href={getDriveLinks(driverData.pan_photo).view} target="_blank" rel="noreferrer" className="view-btn">👁️ View File</a>}
                    <label className={`upload-btn ${driverData.pan_photo ? 'update-btn' : ''}`}>
                      {uploadingField === 'pan_photo' ? '⏳ Uploading...' : driverData.pan_photo ? '🔄 Change File' : '📎 Upload PAN File'}
                      <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'pan_photo')} />
                    </label>
                  </div>
                </div>

              </div>

              {/* --- COLUMN 3: HAZARDOUS, BANK & 🌟 ADDITIONAL DOCS --- */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <h4 style={{ color: '#f59e0b', margin: '0 0 10px 0', borderBottom: '1px dashed #334155', paddingBottom: '5px' }}>⚠️ HAZARDOUS & BANK</h4>
                
                <div className="doc-card">
                  <label>Hazardous Certificate Details</label>
                  <input className="modern-input" placeholder="HZD Cert Number" value={driverData.hzd_cert_no} onChange={e=>setDriverData({...driverData, hzd_cert_no: e.target.value})} style={{marginBottom:'10px'}}/>
                  <input type="date" className="modern-input" value={driverData.hzd_expiry} onChange={e=>setDriverData({...driverData, hzd_expiry: e.target.value})} style={{colorScheme:'dark', marginBottom:'15px'}}/>
                  <div style={{ display: 'grid', gridTemplateColumns: driverData.hzd_photo ? '1fr 1fr' : '1fr', gap: '8px' }}>
                    {driverData.hzd_photo && <a href={getDriveLinks(driverData.hzd_photo).view} target="_blank" rel="noreferrer" className="view-btn">👁️ View File</a>}
                    <label className={`upload-btn ${driverData.hzd_photo ? 'update-btn' : ''}`}>
                      {uploadingField === 'hzd_photo' ? '⏳ Uploading...' : driverData.hzd_photo ? '🔄 Change File' : '📎 Upload HZD File'}
                      <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'hzd_photo')} />
                    </label>
                  </div>
                </div>

                <div className="doc-card">
                  <label>Bank Account Details</label>
                  <input className="modern-input" placeholder="Bank Account Number" value={driverData.account_no} onChange={e=>setDriverData({...driverData, account_no: e.target.value})} style={{marginBottom:'10px'}}/>
                  <input className="modern-input" placeholder="IFSC Code & Bank Name" value={driverData.ifsc_code} onChange={e=>setDriverData({...driverData, ifsc_code: e.target.value})} style={{marginBottom:'15px'}}/>
                  <div style={{ display: 'grid', gridTemplateColumns: driverData.bank_photo ? '1fr 1fr' : '1fr', gap: '8px' }}>
                    {driverData.bank_photo && <a href={getDriveLinks(driverData.bank_photo).view} target="_blank" rel="noreferrer" className="view-btn">👁️ View Passbook</a>}
                    <label className={`upload-btn ${driverData.bank_photo ? 'update-btn' : ''}`}>
                      {uploadingField === 'bank_photo' ? '⏳ Uploading...' : driverData.bank_photo ? '🔄 Change File' : '📎 Upload Passbook'}
                      <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, 'bank_photo')} />
                    </label>
                  </div>
                </div>
                
                {/* 🌟 NEW: ADDITIONAL CUSTOM DOCUMENTS SECTION 🌟 */}
                <h4 style={{ color: '#c084fc', margin: '20px 0 10px 0', borderBottom: '1px dashed #334155', paddingBottom: '5px' }}>📂 ADDITIONAL DOCUMENTS</h4>
                
                {driverData.additional_docs?.map((doc: any, index: number) => (
                   <div key={doc.id} className="doc-card" style={{ borderColor: '#c084fc' }}>
                      <button onClick={() => removeCustomDoc(doc.id)} style={{ position: 'absolute', top: '10px', right: '10px', background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '14px' }}>✕</button>
                      <label style={{ color: '#c084fc' }}>{doc.name}</label>
                      <input type="date" className="modern-input" value={doc.valid_till} onChange={e=>handleCustomDocChange(doc.id, 'valid_till', e.target.value)} style={{colorScheme:'dark', marginBottom:'15px'}} title="Expiry Date (If applicable)"/>
                      <div style={{ display: 'grid', gridTemplateColumns: doc.link ? '1fr 1fr' : '1fr', gap: '8px' }}>
                        {doc.link && <a href={getDriveLinks(doc.link).view} target="_blank" rel="noreferrer" className="view-btn" style={{ borderColor: '#c084fc', color: '#c084fc', background: 'rgba(192, 132, 252, 0.1)' }}>👁️ View File</a>}
                        <label className={`upload-btn ${doc.link ? 'update-btn' : ''}`} style={doc.link ? { borderColor: '#c084fc', color: '#c084fc' } : {}}>
                          {uploadingField === doc.id ? '⏳ Uploading...' : doc.link ? '🔄 Change File' : '📎 Upload File'}
                          <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={(e) => handleDocUpload(e, doc.id)} />
                        </label>
                      </div>
                   </div>
                ))}

                <div style={{ display: 'flex', gap: '10px' }}>
                   <input type="text" className="modern-input" placeholder="e.g. Police Verification" value={newCustomDocName} onChange={e=>setNewCustomDocName(e.target.value)} style={{ border: '1px solid #c084fc' }}/>
                   <button onClick={handleAddCustomDoc} style={{ background: '#c084fc', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>+ Add</button>
                </div>

              </div>
            </div>
            
            {/* 🔙 CANCEL & SAVE BUTTONS */}
            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '20px' }}>
              <button 
                onClick={closeModal} 
                style={{ padding: '15px 30px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '50px', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer', transition: '0.3s' }}
              >
                ⬅️ Go Back (Cancel)
              </button>
              <button className="glow-btn" style={{ padding: '15px 40px', fontSize: '16px' }} onClick={handleSaveDriver}>
                {editingId ? '💾 UPDATE DRIVER PROFILE' : '🚀 REGISTER DRIVER & SET LEDGER'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}