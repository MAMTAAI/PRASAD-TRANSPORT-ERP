// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, serverTimestamp, addDoc, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { extractDocument } from './lib/aiScanner';
import { uploadMedia, slug } from './lib/uploadMedia';
import { toISODate } from './lib/accounting/tripMath';

// Legacy scans stored values like ":AS240718V5684090" — strip stray leading
// punctuation/labels so old data displays and saves clean.
const cleanRef = (v: any): string => String(v ?? '').replace(/^[\s:;,.-]+/, '').trim();

// Case-tolerant plate lookup: real data stores vehicle_no / vehical_no /
// Vehicle_No — the lowercase-only lookup rendered one real truck as "Unknown Plate".
const plateOf = (v: any): string => String(getVal(v, ['vehicle_no', 'vehical_no', 'vehicleno']) || '').trim();

// 🔥 SUPER SMART AUTO-RECOVERY HELPER (Case-Insensitive)
const getVal = (obj: any, keysArr: string[], defaultVal = '') => {
  if(!obj || typeof obj !== 'object') return defaultVal;
  const objKeys = Object.keys(obj);
  for(const k of keysArr) {
     const target = k.toLowerCase().replace(/[^a-z0-9]/g, '');
     const found = objKeys.find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
     if(found && obj[found] !== undefined && obj[found] !== null && obj[found] !== '') return obj[found];
  }
  return defaultVal;
};

// 🕵️‍♂️ AGGRESSIVE DEEP LINK EXTRACTOR (Finds any URL hidden in old data)
const extractDeepLink = (obj: any): string => {
  if (!obj) return '';
  // 1. Try common keys first
  const common = getVal(obj, ['document_file', 'file_url', 'url', 'link', 'doc_link', 'driveLink', 'file', 'documentFile', 'attachment', 'image', 'pdf', 'upload']);
  if (typeof common === 'string' && (common.includes('http') || common.includes('drive'))) return common;

  // 2. If not found, deeply scan the entire object for ANYTHING starting with http
  let foundLink = '';
  const searchDeep = (target: any) => {
    if (foundLink) return;
    if (typeof target === 'string' && target.includes('http')) {
      foundLink = target;
      return;
    }
    if (typeof target === 'object' && target !== null) {
      Object.values(target).forEach(searchDeep);
    }
  };
  searchDeep(obj);
  return foundLink;
};

// 🌟 Universal Mapper for Old Data
const parseOldDocData = (rawData: any, type: any) => {
  if(!rawData) return {};
  const mapped = {
    ...rawData,
    application_no: cleanRef(getVal(rawData, ['application_no', 'Application_No', 'policy_no', 'Policy_No', 'policyNo'])),
    receipt_no: cleanRef(getVal(rawData, ['receipt_no', 'Receipt_No', 'challan_no', 'receiptNo'])),
    inspected_on: getVal(rawData, ['inspected_on', 'issue_date', 'Issue_Date', 'valid_from', 'issueDate', 'date']),
    next_due_date: getVal(rawData, ['next_due_date', 'expiry_date', 'Expiry_Date', 'valid_till', 'expiryDate']),
    amount: getVal(rawData, ['amount', 'Amount', 'total_fees', 'Total_Fees', 'fees', 'totalAmount']),
    payment_mode: getVal(rawData, ['payment_mode', 'Payment_Mode', 'mode']),
    document_file: extractDeepLink(rawData), // Uses the new Deep Scanner
  };
  if (type && type.id.startsWith('custom_')) mapped.doc_name = type.name;
  return mapped;
};

export default function VehicleDocs() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiScanning, setAiScanning] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);

  const [scannedAIData, setScannedAIData] = useState<any>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [companies, setCompanies] = useState<any[]>([]);

  const portals = [
    { name: 'Parivahan (Fitness/Permit)', url: 'https://vahan.parivahan.gov.in/vahan/vahan/ui/login/login.xhtml' },
    { name: 'E-Challan System', url: 'https://echallan.parivahan.gov.in/' },
    { name: 'Insurance (V-Seva)', url: 'https://www.vsez.gov.in/' },
    { name: 'DigiLocker Admin', url: 'https://digitallocker.gov.in/' }
  ];

  // 📝 DYNAMIC DOC TYPES
  const [docTypes, setDocTypes] = useState([
    { id: 'fitness', name: '1. Fitness / Inspection' },
    { id: 'insurance', name: '2. Vehicle Insurance' },
    { id: 'explosive', name: '3. Explosive License' },
    { id: 'calibration', name: '4. Certificate Calibration' },
    { id: 'rule18', name: '5. Rule 18 (Hydro Test)' },
    { id: 'rule43', name: '6. Rule 43 (Safety Cert)' },
    { id: 'cii', name: '7. CII Insurance' },
    { id: 'national_permit', name: '8. National Permit' },
    { id: 'pollution', name: '9. Pollution (PUC)' },
    { id: 'home_permit', name: '10. Home State Permit' },
    { id: 'mv_tax', name: '11. MV Tax' },
  ]);

  const [newDocName, setNewDocName] = useState('');

  const [activeTab, setActiveTab] = useState(docTypes[0]);
  const [formData, setFormData] = useState<any>({});

  useEffect(() => {
    fetchVehicles();
    fetchCompanies();
  }, []);

  const fetchVehicles = async () => {
    setLoading(true);
    try {
      const querySnapshot = await getDocs(collection(db, "VEHICLES"));
      const vList = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setVehicles(vList);
    } catch (error) { console.error("Error fetching vehicles:", error); }
    setLoading(false);
  };

  const fetchCompanies = async () => {
    try {
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      const compList = [...cSnap1.docs, ...cSnap2.docs].map(d => ({ id: d.id, ...d.data() }));
      setCompanies(compList);
    } catch (error) { console.error(error); }
  };

  // 🚀 Load Custom Docs & Recover Old Data
  const loadVehicleDocs = (vehicle: any) => {
    const currentTypes = [...docTypes.slice(0, 11)]; 
    
    if (vehicle.documents) {
      Object.keys(vehicle.documents).forEach(key => {
         if (!currentTypes.find(t => t.id === key)) {
           currentTypes.push({ id: key, name: vehicle.documents[key].doc_name || key });
         }
      });
    }

    setDocTypes(currentTypes);
    setSelectedVehicle(vehicle);
    setActiveTab(currentTypes[0]);
    
    const existingData = vehicle.documents?.[currentTypes[0].id] || {};
    setFormData(parseOldDocData(existingData, currentTypes[0]));
    setScannedAIData(null);
  };

  const handleAddCustomDoc = () => {
    if(!newDocName.trim()) return alert("Please enter a document name.");
    const newId = `custom_${Date.now()}`;
    const newDoc = { id: newId, name: `📄 ${newDocName}` };
    setDocTypes([...docTypes, newDoc]);
    setNewDocName('');
    handleTabChange(newDoc); 
  };

  const handleTabChange = (type: any) => {
    setActiveTab(type);
    const existingData = selectedVehicle.documents?.[type.id] || {};
    setFormData(parseOldDocData(existingData, type));
    setScannedAIData(null);
  };

  const handleInputChange = (e: any) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // 📎 REAL upload (Firebase Storage) + 🤖 local Gemma OCR, in parallel.
  // The old flow only ran OCR and DISCARDED the file — new documents never got
  // a View/Download link and the AI Scan button stayed permanently disabled.
  const handleFileUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    setUploadingDoc(true);
    setScannedAIData(null);

    const vNo = slug(plateOf(selectedVehicle) || 'vehicle');
    const uploadPromise = uploadMedia(file, `vehicle-docs/${vNo}/${slug(activeTab.id)}_${Date.now()}.jpg`);

    // A dead Ollama must not lose the document — store the file regardless.
    let storedUrl = '';
    try {
      const { url } = await uploadPromise;
      storedUrl = url;
      setFormData(prev => ({ ...prev, document_file: url }));
    } catch (err) {
      console.error(err);
      alert('❌ File upload nahi hui — network check karke dobara try karein.');
      setUploadingDoc(false);
      return;
    }

    try {
      // 🤖 100% LOCAL extraction via Gemma 4 vision (no cloud).
      const ex = await extractDocument(file, activeTab.name);
      const docNum = cleanRef(ex.document_number).replace(/[^A-Za-z0-9/-]/g, '').trim();
      setFormData(prev => ({
        ...prev,
        document_file: storedUrl,
        application_no: docNum || prev.application_no || '',
        receipt_no: docNum || prev.receipt_no || '',
        inspected_on: formatForDatePicker(ex.issue_date) || prev.inspected_on || '',
        next_due_date: formatForDatePicker(ex.expiry_date) || prev.next_due_date || '',
      }));
      setScannedAIData(ex);
      const note = ex._lowConfidence.length ? ` (check: ${ex._lowConfidence.join(', ')})` : '';
      alert(`✅ File saved + Mamta AI ne ${activeTab.name} padh liya. Kripya verify karein.${note}`);
    } catch (error: any) {
      const offline = error?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(error?.message || '');
      alert(`✅ File save ho gayi.\n${offline ? '⚠️ Local AI engine (Ollama) band hai — scan nahi hua, fields manually bharein.' : '⚠️ Document scan nahi ho paya (file phir bhi save hai) — fields manually bharein.'}`);
    }
    setUploadingDoc(false);
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
    } catch (e) { return ""; }
  };

  const triggerAIScan = () => {
    if (!scannedAIData) {
       alert("⚠️ Pehle document upload karein — upload ke saath Mamta AI scan apne aap chalta hai. Yeh button scanned data ko dobara fields me bharta hai.");
       return;
    }

    setAiScanning(true);
    
    setTimeout(() => {
      const findValue = (obj: any, searchKeys: string[]): string => {
        if (!obj || typeof obj !== 'object') return "";
        for (const k of Object.keys(obj)) {
          if (searchKeys.includes(k) && obj[k]) return String(obj[k]);
          if (typeof obj[k] === 'object') {
             const nestedResult = findValue(obj[k], searchKeys);
             if (nestedResult) return nestedResult;
          }
        }
        return "";
      };

      let rawDocNum = findValue(scannedAIData, ['documentNumber', 'Document No', 'Policy No', 'Application No', 'Vehicle No', 'receiptNo']);
      const rawAmount = findValue(scannedAIData, ['totalAmount', 'Amount', 'Amounts', 'Total Fees Paid', 'Fees', 'fees']);
      const rawIssueDate = findValue(scannedAIData, ['documentDate', 'Date', 'Issue Date', 'issueDate']);
      const rawExpiryDate = findValue(scannedAIData, ['expiryDate', 'Expiry Date', 'Expiry Dates', 'nextDueDate', 'validUpto']);

      if (rawDocNum.startsWith(":")) rawDocNum = rawDocNum.substring(1); 
      
      const cleanDocNumber = rawDocNum.replace(/[^A-Za-z0-9/-]/g, '').trim();
      const cleanAmount = rawAmount.replace(/[^0-9.]/g, '');
      const formattedDate = formatForDatePicker(rawIssueDate);
      const formattedExpiryDate = formatForDatePicker(rawExpiryDate);

      setFormData(prev => ({
        ...prev,
        application_no: cleanDocNumber || prev.application_no || "",
        receipt_no: cleanDocNumber || prev.receipt_no || "",
        inspected_on: formattedDate || prev.inspected_on || "",
        amount: cleanAmount || prev.amount,
        payment_mode: cleanAmount ? "Online Transfer" : prev.payment_mode,
        next_due_date: formattedExpiryDate || prev.next_due_date || "" 
      }));
      
      setAiScanning(false);
      alert(`🤖 Mamta AI Scan Complete! Original Data Extracted & Formatted Successfully.`);
    }, 1000);
  };

  // 💾 PROPER ACCOUNTING SAVE TO FIREBASE
  const handleSave = async () => {
    if (!selectedVehicle) return;
    setSaving(true);
    try {
      const vehicleRef = doc(db, "VEHICLES", selectedVehicle.id);
      
      const safeDataToSave = {};
      for (const key in formData) {
        safeDataToSave[key] = formData[key] === undefined ? "" : formData[key];
      }
      safeDataToSave.application_no = cleanRef(safeDataToSave.application_no);
      safeDataToSave.receipt_no = cleanRef(safeDataToSave.receipt_no);
      safeDataToSave.updated_at = new Date().toISOString();

      // 🔒 Duplicate-expense guard: the same (amount + ref) must post to the
      // ledger only once — re-saving the form previously duplicated the fee.
      const expenseKey = `${parseFloat(safeDataToSave.amount || '0')}|${safeDataToSave.receipt_no || safeDataToSave.application_no || ''}`;
      const alreadyPosted = selectedVehicle.documents?.[activeTab.id]?.expense_posted_key === expenseKey;
      if (safeDataToSave.amount && parseFloat(safeDataToSave.amount) > 0 && !alreadyPosted) {
        safeDataToSave.expense_posted_key = expenseKey;
      } else if (alreadyPosted) {
        safeDataToSave.expense_posted_key = expenseKey;
      }

      const updatePayload = {
        [`documents.${activeTab.id}`]: safeDataToSave
      };

      if(activeTab.id === 'fitness') updatePayload['fitness_validity'] = safeDataToSave.next_due_date || '';
      if(activeTab.id === 'insurance') updatePayload['insurance_validity'] = safeDataToSave.next_due_date || '';
      if(activeTab.id === 'explosive') updatePayload['explosive_validity'] = safeDataToSave.next_due_date || '';
      if(activeTab.id === 'calibration') updatePayload['calibration_validity'] = safeDataToSave.next_due_date || '';
      if(activeTab.id === 'pollution') updatePayload['pollution_validity'] = safeDataToSave.next_due_date || '';
      if(activeTab.id === 'national_permit') updatePayload['national_permit_validity'] = safeDataToSave.next_due_date || '';
      if(activeTab.id === 'mv_tax') updatePayload['tax_validity'] = safeDataToSave.next_due_date || '';

      await updateDoc(vehicleRef, updatePayload);

      // 🔥 PROPER ACCOUNTING LOGIC (skipped when this exact fee was already posted)
      if (safeDataToSave.amount && parseFloat(safeDataToSave.amount) > 0 && !alreadyPosted) {
        const cleanDocName = activeTab.name.replace(/[0-9.]/g, '').trim();
        const expectedLedgerName = `${cleanDocName} Expenses`; 

        const q = query(collection(db, "LEDGERS"), where("name", "==", expectedLedgerName));
        const querySnapshot = await getDocs(q);

        let ledgerIdToUse = null;

        if (!querySnapshot.empty) {
           ledgerIdToUse = querySnapshot.docs[0].id; 
        } else {
           const newLedgerRef = await addDoc(collection(db, "LEDGERS"), {
              name: expectedLedgerName,
              ledger_name: expectedLedgerName, // rest of the ERP reads ledger_name
              group: "Direct Expenses (Vehicle Compliance & Docs)",
              op_balance: 0,
              company: "ALL", 
              branch: "ALL",
              dr_cr: "Dr (Debit)", 
              creation_type: "AUTO_SYSTEM",
              linked_module: "MASTER_DOC_EXPENSE",
              created_at: serverTimestamp()
           });
           ledgerIdToUse = newLedgerRef.id;
        }

        await addDoc(collection(db, "LEDGER_ENTRIES"), {
           ledgerId: ledgerIdToUse,
           date: safeDataToSave.inspected_on || new Date().toISOString().split('T')[0],
           particulars: `Paid for Vehicle: ${plateOf(selectedVehicle)} | Ref: ${safeDataToSave.receipt_no || safeDataToSave.application_no || 'Auto-Sync'}`,
           dr_cr: "Dr (Debit)",
           amount: parseFloat(safeDataToSave.amount),
           company: selectedVehicle.company_name || selectedVehicle.Company_Name || 'ALL',
           branch: selectedVehicle.branch_name || selectedVehicle.branch || 'ALL',
           created_at: serverTimestamp()
        });
      }

      const updatedVehicle = { ...selectedVehicle };
      if (!updatedVehicle.documents) updatedVehicle.documents = {};
      updatedVehicle.documents[activeTab.id] = safeDataToSave;
      setSelectedVehicle(updatedVehicle);
      setVehicles(vehicles.map(v => v.id === updatedVehicle.id ? updatedVehicle : v));

      alert(`✅ ${activeTab.name} Saved & Accounted Properly!`);
    } catch (error) {
      console.error("Save Error:", error);
      alert("❌ Error saving document to server! Please try again.");
    }
    setSaving(false);
  };

  // 🌟 UNIVERSAL DRIVE LINK EXTRACTOR
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

  const shareDocument = (docName: string, link: string, expiry: string) => {
     if(!link) return alert("No document file found to share.");
     const vNo = plateOf(selectedVehicle);
     const viewLink = getDriveLinks(link).view;
     const message = `📄 *Vehicle Document Alert*\n\n🚛 Vehicle: *${vNo}*\n🔖 Document: *${docName}*\n📅 Valid Till: *${expiry || 'N/A'}*\n\n📂 View/Download Document here:\n${viewLink}\n\n- Prasad Transport System`;
     const encodedMsg = encodeURIComponent(message);
     window.open(`https://wa.me/?text=${encodedMsg}`, '_blank');
  };

  const uniqueOwners = Array.from(new Set(vehicles.filter(v => v.own_attach === 'Attached' && v.owner_name).map(v => v.owner_name)));

  const filteredVehicles = vehicles.filter(v => {
    const vNo = plateOf(v).toLowerCase();
    if (!vNo) return false; // records with no plate at all — nothing to file docs against
    const matchesSearch = vNo.includes(searchTerm.toLowerCase());
    const matchesCompany = filterCompany ? (v.company_name || v.Company_Name || v.company) === filterCompany : true;
    const matchesOwner = filterOwner ? (filterOwner === 'Own' ? v.own_attach === 'Own' : v.owner_name === filterOwner) : true;
    return matchesSearch && matchesCompany && matchesOwner;
  });

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      <style>{`
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 10px; color: white; padding: 12px 16px; outline: none; width: 100%; box-sizing: border-box; font-size: 14px;}
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.9); }
        .vehicle-card { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.05); padding: 25px; border-radius: 15px; cursor: pointer; transition: 0.3s; }
        .vehicle-card:hover { background: rgba(56, 189, 248, 0.1); transform: translateY(-5px); border-color: #38bdf8; box-shadow: 0 10px 20px rgba(56,189,248,0.1); }
        .upload-area { border: 2px dashed #475569; padding: 25px; border-radius: 15px; text-align: center; background: rgba(255,255,255,0.02); transition: 0.3s; }
        .upload-area:hover { border-color: #38bdf8; background: rgba(56,189,248,0.05); }
        .portal-btn { background: #1e293b; border: 1px solid #334155; color: #38bdf8; padding: 10px; border-radius: 8px; cursor: pointer; text-decoration: none; display: block; text-align: center; margin-bottom: 10px; font-size: 12px; font-weight: bold; }
        .portal-btn:hover { background: #38bdf8; color: #000; }
        .action-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px 15px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.2s; display: flex; align-items: center; gap: 8px; text-decoration: none;}
        .action-btn:hover { background: rgba(255,255,255,0.2); transform: scale(1.05); }
        .docs-filters { display: flex; gap: 15px; margin-bottom: 30px; background: rgba(30, 41, 59, 0.4); padding: 20px; border-radius: 15px; border: 1px solid rgba(255,255,255,0.05); }
        .camera-btn { background: #059669; color: white; border: none; border-radius: 10px; padding: 12px 18px; font-weight: bold; cursor: pointer; min-height: 44px; }

        /* 📱 MOBILE: the 3-column vault becomes a stacked, full-screen sheet */
        @media (max-width: 900px) {
          .docs-filters { flex-direction: column; gap: 10px; padding: 12px; }
          .vault-overlay { align-items: stretch !important; }
          .vault-shell { flex-direction: column; width: 100% !important; max-width: 100% !important; height: 100dvh !important; border-radius: 0 !important; }
          .vault-side { width: 100% !important; max-height: 30dvh; border-right: none !important; border-bottom: 1px solid #334155; padding: 15px !important; }
          .vault-side h3 { font-size: 20px !important; }
          .vault-main { padding: 18px !important; padding-bottom: 30px !important; }
          .vault-main h2 { font-size: 20px !important; }
          .vault-help { display: none; } /* helper portals are desktop-only chrome */
          .form-grid { grid-template-columns: 1fr !important; gap: 15px !important; }
          .vault-header { flex-direction: column; align-items: flex-start !important; gap: 12px; }
        }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(24px, 5vw, 38px)', color: '#fff', fontWeight: '900', letterSpacing: '-1px' }}>📂 Fleet Document Vault</h2>
          <p style={{ color: '#94a3b8', fontSize: '15px' }}>Upload, Track Expiry, and Auto-sync to P&L Expenses.</p>
        </div>
      </div>

      <div className="docs-filters">
        <div style={{ flex: 1, position: 'relative' }}>
          <input placeholder="Search Vehicle No..." className="modern-input" style={{ paddingLeft: '45px' }} onChange={(e) => setSearchTerm(e.target.value)} />
          <span style={{ position: 'absolute', left: '15px', top: '12px', fontSize: '18px' }}>🔍</span>
        </div>
        <select className="modern-input" style={{ flex: 1 }} value={filterCompany} onChange={(e) => setFilterCompany(e.target.value)}>
          <option value="">🏢 All Companies</option>
          {companies.map((c, i) => <option key={i} value={c.company_name || c.Company_Name}>{c.company_name || c.Company_Name}</option>)}
        </select>
        <select className="modern-input" style={{ flex: 1 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
          <option value="">👤 All Owners</option>
          <option value="Own" style={{ color: '#10b981', fontWeight: 'bold' }}>⭐ Only Own Assets</option>
          {uniqueOwners.map((owner: any, i: number) => <option key={i} value={owner}>🤝 {owner}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '50px', color: '#38bdf8', fontSize: '20px', fontWeight: 'bold' }}>Loading Database...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 'clamp(14px, 2.5vw, 25px)' }}>
          {filteredVehicles.map((v) => {
            const updatedDocs = v.documents ? Object.keys(v.documents).length : 0;
            const statusColor = updatedDocs >= 10 ? '#10b981' : updatedDocs > 0 ? '#f59e0b' : '#ef4444';

            return (
              <div key={v.id} className="vehicle-card" onClick={() => loadVehicleDocs(v)}>
                <div style={{ fontSize: '35px', marginBottom: '15px' }}>📁</div>
                <h3 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '24px', fontWeight: '900' }}>{plateOf(v) || 'Unknown Plate'}</h3>
                <p style={{ margin: '0', color: v.own_attach === 'Own' ? '#10b981' : '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                  {v.own_attach} Asset {v.owner_name && `• ${v.owner_name}`}
                </p>
                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '15px' }}>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Compliance Status</span>
                  <span style={{ background: statusColor + '20', color: statusColor, padding: '4px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>
                    {updatedDocs} Docs Updated
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedVehicle && (
        <div className="vault-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', backdropFilter: 'blur(10px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="vault-shell" style={{ width: '95%', maxWidth: '1400px', height: '90vh', background: '#0f172a', borderRadius: '20px', border: '1px solid #38bdf8', display: 'flex', overflow: 'hidden', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }}>

            <div className="vault-side" style={{ width: '350px', background: '#1e293b', padding: '30px 20px', borderRight: '1px solid #334155', overflowY: 'auto' }}>
              <h3 style={{ color: '#38bdf8', margin: '0 0 5px 0', fontSize: '26px', fontWeight: '900' }}>{plateOf(selectedVehicle)}</h3>
              <p style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '30px' }}>Master Document Vault</p>
              
              {docTypes.map((tab) => {
                const docData = selectedVehicle.documents && selectedVehicle.documents[tab.id];
                const isUpdated = !!docData;
                
                let dateColor = '#94a3b8';
                if(isUpdated && docData.next_due_date) {
                   // toISODate handles legacy DD-MM-YYYY strings that new Date() misparses
                   const expDate = new Date(toISODate(docData.next_due_date) || docData.next_due_date);
                   const today = new Date();
                   if (expDate < today) dateColor = '#ef4444'; 
                   else if ((expDate.getTime() - today.getTime()) / (1000 * 3600 * 24) < 15) dateColor = '#f59e0b'; 
                   else dateColor = '#10b981'; 
                }

                return (
                  <div 
                    key={tab.id} 
                    onClick={() => handleTabChange(tab)}
                    style={{ 
                      padding: '12px 15px', marginBottom: '10px', cursor: 'pointer', borderRadius: '12px', display: 'flex', flexDirection: 'column',
                      background: activeTab.id === tab.id ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                      borderLeft: activeTab.id === tab.id ? '4px solid #38bdf8' : '4px solid transparent',
                      color: activeTab.id === tab.id ? '#fff' : '#cbd5e1',
                      transition: '0.2s'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', fontWeight: activeTab.id === tab.id ? 'bold' : 'normal' }}>{tab.name}</span>
                      {isUpdated && <span style={{ fontSize: '12px', background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '2px 6px', borderRadius: '5px' }}>✅</span>}
                    </div>
                    {isUpdated && (
                       <div style={{ fontSize: '11px', color: dateColor, marginTop: '5px', fontWeight: 'bold' }}>
                         Valid: {getVal(docData, ['inspected_on', 'issue_date', 'date'], '?')} ➔ {getVal(docData, ['next_due_date', 'expiry_date'], '?')}
                       </div>
                    )}
                  </div>
                )
              })}

              <div style={{ marginTop: '20px', borderTop: '1px dashed #475569', paddingTop: '20px' }}>
                 <input 
                   type="text" 
                   value={newDocName} 
                   onChange={(e) => setNewDocName(e.target.value)} 
                   placeholder="e.g. Police Verification..." 
                   style={{ width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '6px', fontSize: '12px', marginBottom: '10px', outline: 'none' }}
                 />
                 <button onClick={handleAddCustomDoc} style={{ width: '100%', background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px dashed #38bdf8', padding: '10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>
                   ➕ Add New Document
                 </button>
              </div>
            </div>

            <div className="vault-main" style={{ flex: 1, padding: '40px', overflowY: 'auto', position: 'relative' }}>
              <button onClick={() => setSelectedVehicle(null)} style={{ position: 'absolute', top: '20px', right: '20px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '8px 15px', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold' }}>Close ✕</button>

              <div className="vault-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '40px', borderBottom: '1px solid #334155', paddingBottom: '20px' }}>
                <div>
                  <h2 style={{ color: 'white', margin: 0, fontSize: '28px' }}>{activeTab.name.replace(/[0-9.]/g, '').trim()} <span style={{color: '#38bdf8'}}>Details</span></h2>
                </div>
                
                <button
                  onClick={triggerAIScan}
                  disabled={aiScanning || !scannedAIData}
                  title={scannedAIData ? 'Re-apply scanned values to the form' : 'Upload a document below — scan runs automatically'}
                  style={{
                    background: scannedAIData ? 'linear-gradient(135deg, #10b981, #059669)' : '#334155',
                    color: scannedAIData ? 'white' : '#94a3b8',
                    border: 'none', padding: '12px 25px', borderRadius: '30px', fontWeight: 'bold', cursor: scannedAIData ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px'
                  }}
                >
                  {aiScanning ? '⏳ Extracting Data...' : '🤖 Mamta AI Scan'}
                </button>
              </div>

              <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '25px' }}>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Application / Policy No</label>
                  <input className="modern-input" name="application_no" value={formData.application_no || ''} onChange={handleInputChange} placeholder="e.g. APP-12345" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Receipt / Challan No</label>
                  <input className="modern-input" name="receipt_no" value={formData.receipt_no || ''} onChange={handleInputChange} placeholder="e.g. REC-9908" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Issue Date (Valid From)</label>
                  <input type="date" className="modern-input" name="inspected_on" value={formData.inspected_on || ''} onChange={handleInputChange} style={{colorScheme:'dark'}} />
                </div>
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Next Expiry Date *</label>
                  <input type="date" className="modern-input" name="next_due_date" value={formData.next_due_date || ''} onChange={handleInputChange} style={{colorScheme:'dark', border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.05)'}} />
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Total Fees Paid (₹)</label>
                  <input type="number" className="modern-input" name="amount" value={formData.amount || ''} onChange={handleInputChange} placeholder="Hits Ledger Account" style={{border: '1px solid #ef4444', background: 'rgba(239,68,68,0.05)', fontWeight: 'bold'}} />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Payment Mode</label>
                  <select className="modern-input" name="payment_mode" value={formData.payment_mode || ''} onChange={handleInputChange}>
                    <option value="">-- Select Mode --</option>
                    <option value="Online Transfer">Online Transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Card">Card</option>
                  </select>
                </div>
              </div>

              <div className="upload-area" style={{ marginTop: '35px' }}>
                <label style={{ color: '#38bdf8', fontSize: '16px', fontWeight: 'bold', display: 'block', marginBottom: '15px' }}>📎 Upload Original PDF/IMG (saved to secure Storage + Mamta AI scan)</label>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '15px', flexWrap: 'wrap' }}>
                  <button className="camera-btn" onClick={() => document.getElementById('vd-camera-input')?.click()}>📸 Photo Kheencho</button>
                  <input id="vd-camera-input" type="file" accept="image/*" capture="environment" onChange={handleFileUpload} style={{ display: 'none' }} />
                  <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} style={{ color: '#94a3b8', background: '#1e293b', padding: '10px', borderRadius: '10px', maxWidth: '100%' }} />
                  {uploadingDoc && <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>⏳ Uploading + Mamta AI scan…</span>}
                </div>
                
                {/* 🌟 FILE PREVIEW BUTTONS */}
                {formData.document_file && !uploadingDoc && (
                  <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(16,185,129,0.1)', border: '1px dashed #10b981', borderRadius: '10px', display: 'inline-block' }}>
                     <p style={{ margin: '0 0 10px 0', color: '#10b981', fontWeight: 'bold', fontSize: '13px' }}>✅ File Available</p>
                     <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', justifyContent: 'center' }}>
                       <a href={getDriveLinks(formData.document_file).view} target="_blank" rel="noreferrer" className="action-btn" style={{ borderColor: '#38bdf8', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)' }}>👁️ View Document</a>
                       <a href={getDriveLinks(formData.document_file).download} target="_blank" rel="noreferrer" className="action-btn" style={{ borderColor: '#f59e0b', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)' }}>⬇️ Download</a>
                       <button onClick={() => shareDocument(activeTab.name, formData.document_file, formData.next_due_date)} className="action-btn" style={{ borderColor: '#22c55e', color: '#22c55e', background: 'rgba(34, 197, 94, 0.1)' }}>💬 Share (WhatsApp)</button>
                     </div>
                  </div>
                )}
              </div>

              <button onClick={handleSave} disabled={saving} style={{ width: '100%', marginTop: '35px', padding: '18px', background: 'linear-gradient(135deg, #3b82f6, #6366f1)', color: 'white', border: 'none', borderRadius: '12px', fontSize: '18px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 10px 20px rgba(59,130,246,0.4)', transition: '0.3s' }}>
                {saving ? '⏳ Syncing with Server...' : '💾 SAVE DOCUMENT & UPDATE EXPENSE LEDGER'}
              </button>

            </div>

            <div className="vault-help" style={{ width: '250px', background: '#020617', padding: '25px', borderLeft: '1px solid #1e293b' }}>
               <h4 style={{color:'#fff', marginBottom:'20px'}}>🌐 Helper Portals</h4>
               {portals.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer" className="portal-btn">{p.name} ↗</a>
               ))}
               <button onClick={() => setSelectedVehicle(null)} style={{width:'100%', marginTop:'60px', padding:'12px', background:'#ef444422', color:'#ef4444', border:'1px solid #ef4444', borderRadius:'8px', cursor:'pointer', fontWeight: 'bold'}}>Close Vault</button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}