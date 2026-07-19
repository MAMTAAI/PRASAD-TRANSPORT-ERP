// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, writeBatch, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { extractJsonFromImage } from './lib/aiScanner';

// 🌟 CRASH-PROOF SAFE DATE PARSER FOR OLD DATA
const getSafeTime = (dateVal: any) => {
  if (!dateVal) return 0;
  if (typeof dateVal.toDate === 'function') return dateVal.toDate().getTime();
  if (typeof dateVal === 'string' || typeof dateVal === 'number') {
      const parsed = new Date(dateVal).getTime();
      return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

// 🌟 SMART AXLE GENERATOR
const getAxlePositions = (config: string) => {
  const basePositions = [
    { id: 'FL', label: 'Front Axle - Left (Steering)' },
    { id: 'FR', label: 'Front Axle - Right (Steering)' },
    { id: 'STEPNEY', label: 'Stepney (Spare)' }
  ];

  if (!config) return basePositions;

  if (config.includes('4+1')) {
    return [...basePositions, { id: 'RDL', label: 'Rear Drive Axle - Left' }, { id: 'RDR', label: 'Rear Drive Axle - Right' }];
  }

  if (config.includes('6+1')) {
    return [...basePositions, 
      { id: 'RDL_OUT', label: 'Rear Drive Axle - Outer Left' }, { id: 'RDL_IN', label: 'Rear Drive Axle - Inner Left' },
      { id: 'RDR_IN', label: 'Rear Drive Axle - Inner Right' }, { id: 'RDR_OUT', label: 'Rear Drive Axle - Outer Right' }
    ];
  }

  if (config.includes('10+1')) {
    return [...basePositions, 
      { id: 'RDL1_OUT', label: 'Drive Axle 1 - Outer Left' }, { id: 'RDL1_IN', label: 'Drive Axle 1 - Inner Left' },
      { id: 'RDR1_IN', label: 'Drive Axle 1 - Inner Right' }, { id: 'RDR1_OUT', label: 'Drive Axle 1 - Outer Right' },
      { id: 'RDL2_OUT', label: 'Drive Axle 2 - Outer Left' }, { id: 'RDL2_IN', label: 'Drive Axle 2 - Inner Left' },
      { id: 'RDR2_IN', label: 'Drive Axle 2 - Inner Right' }, { id: 'RDR2_OUT', label: 'Drive Axle 2 - Outer Right' }
    ];
  }

  if (config.includes('14+1')) {
    return [...basePositions, 
      { id: 'RDL1_OUT', label: 'Drive Axle 1 - Outer Left' }, { id: 'RDL1_IN', label: 'Drive Axle 1 - Inner Left' },
      { id: 'RDR1_IN', label: 'Drive Axle 1 - Inner Right' }, { id: 'RDR1_OUT', label: 'Drive Axle 1 - Outer Right' },
      { id: 'RDL2_OUT', label: 'Drive Axle 2 - Outer Left' }, { id: 'RDL2_IN', label: 'Drive Axle 2 - Inner Left' },
      { id: 'RDR2_IN', label: 'Drive Axle 2 - Inner Right' }, { id: 'RDR2_OUT', label: 'Drive Axle 2 - Outer Right' },
      { id: 'DUMMY_L_OUT', label: 'Dummy Axle - Outer Left' }, { id: 'DUMMY_L_IN', label: 'Dummy Axle - Inner Left' },
      { id: 'DUMMY_R_IN', label: 'Dummy Axle - Inner Right' }, { id: 'DUMMY_R_OUT', label: 'Dummy Axle - Outer Right' }
    ];
  }

  const advanced = [...basePositions];
  const totalT = parseInt(config.split('+')[0]);
  if(totalT >= 16) {
      for(let i=1; i<=(totalT-2)/4; i++) {
          advanced.push({ id: `AXLE${i}_L_OUT`, label: `Axle ${i} - Outer Left` });
          advanced.push({ id: `AXLE${i}_L_IN`, label: `Axle ${i} - Inner Left` });
          advanced.push({ id: `AXLE${i}_R_IN`, label: `Axle ${i} - Inner Right` });
          advanced.push({ id: `AXLE${i}_R_OUT`, label: `Axle ${i} - Outer Right` });
      }
      return advanced;
  }

  return [...basePositions, { id: 'GENERAL_REAR', label: 'General Rear Axle' }];
};

// 💰 P&L LINKAGE: scrapped/burst tyre ka poora accumulated cost (purchase +
// resoles) is ledger me Dr hota hai — Company P&L me Direct Expenses ke andar
// "Tyres & Maintenance" line ban kar dikhta hai (FinancialReports classifier).
const TYRE_EXP_LEDGER_NAME = 'Tyre Consumption Expenses';
const TYRE_EXP_GROUP = 'Direct Expenses (Tyres & Maintenance)';
const ensureTyreExpenseLedger = async () => {
  const snap = await getDocs(query(collection(db, 'LEDGERS'), where('ledger_name', '==', TYRE_EXP_LEDGER_NAME)));
  if (!snap.empty) return snap.docs[0].id;
  const ref = await addDoc(collection(db, 'LEDGERS'), {
    name: TYRE_EXP_LEDGER_NAME, ledger_name: TYRE_EXP_LEDGER_NAME,
    group: TYRE_EXP_GROUP, group_head: TYRE_EXP_GROUP,
    op_balance: 0, company: 'ALL', branch: 'ALL', dr_cr: 'Dr (Debit)',
    creation_type: 'AUTO_SYSTEM', linked_module: 'TYRE_EXPENSE', created_at: serverTimestamp(),
  });
  return ref.id;
};

export default function TyreMgmt() {
  const [activeTab, setActiveTab] = useState('INVENTORY');
  const [tyres, setTyres] = useState<any[]>([]);
  const [fitments, setFitments] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // MODALS
  const [isTyreModalOpen, setIsTyreModalOpen] = useState(false);
  const [isFitmentModalOpen, setIsFitmentModalOpen] = useState(false);
  const [isRemoveModalOpen, setIsRemoveModalOpen] = useState(false);
  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [isDispatchResoleModalOpen, setIsDispatchResoleModalOpen] = useState(false);
  const [isReceiveResoleModalOpen, setIsReceiveResoleModalOpen] = useState(false);
  const [isEditTyreModalOpen, setIsEditTyreModalOpen] = useState(false);
  
  const [selectedResoleTyre, setSelectedResoleTyre] = useState<any>(null);
  const [selectedFitment, setSelectedFitment] = useState<any>(null);
  const [editTyreData, setEditTyreData] = useState<any>(null);

  const [availablePositions, setAvailablePositions] = useState<{id: string, label: string}[]>([]);
  const [currentVehicleFitments, setCurrentVehicleFitments] = useState<any[]>([]);
  const [historySearch, setHistorySearch] = useState('');

  const [purchaseData, setPurchaseData] = useState({ invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], vendor_name: '', invoice_file_url: '' });
  const [currentTyre, setCurrentTyre] = useState({ brand: 'MRF', serial_no: '', type: 'NEW', gst_percent: '28', inv_amount: '' });
  const [tyreList, setTyreList] = useState<any[]>([]);
  const [dispatchData, setDispatchData] = useState({ vendor_name: '', dispatch_date: new Date().toISOString().split('T')[0], challan_no: '' });
  const [currentDispatchSerial, setCurrentDispatchSerial] = useState('');
  const [dispatchSerialList, setDispatchSerialList] = useState<string[]>([]);
  const [resoleData, setResoleData] = useState({ vendor_name: '', invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], cost: '', gst_percent: '18', remarks: 'Resoled' });
  const [fitmentData, setFitmentData] = useState({ vehicle_no: '', tyre_serial: '', position: '', fitting_km: '', fitment_date: new Date().toISOString().split('T')[0] });
  // 🆕 Naye (stock me na milne wale) tyre ki procurement details — bina cost/vendor ke auto-add BLOCKED.
  const [newTyreProc, setNewTyreProc] = useState({ cost: '', vendor_name: '', brand: 'MRF', type: 'NEW', gst_percent: '28' });
  const [removeData, setRemoveData] = useState({ removal_km: '', removal_reason: 'SEND FOR RESOLE', removal_date: new Date().toISOString().split('T')[0] });
  const [newVendorData, setNewVendorData] = useState({ vendor_name: '', vendor_category: 'Tyre Shop / Factory', contact_person: '', mobile_no: '', gst_number: '', opening_balance: '0' });

  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap1 = await getDocs(collection(db, "VEHICLES")).catch(()=>({docs:[]}));
      const vSnap2 = await getDocs(collection(db, "ASSETS")).catch(()=>({docs:[]}));
      const allVehicles = [ ...vSnap1.docs.map(d => ({ id: d.id, ...d.data() })), ...vSnap2.docs.map(d => ({ id: d.id, ...d.data() })) ];
      setVehicles(allVehicles);

      const tSnap = await getDocs(collection(db, "TYRE_MASTER")).catch(()=>({docs:[]}));
      // 🛡️ CRASH-PROOF SORTING
      const fetchedTyres = tSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => getSafeTime(b.createdAt) - getSafeTime(a.createdAt));
      setTyres(fetchedTyres);

      const fSnap = await getDocs(collection(db, "TYRE_FITMENTS")).catch(()=>({docs:[]}));
      // 🛡️ CRASH-PROOF SORTING
      const fetchedFitments = fSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => getSafeTime(b.fitment_date) - getSafeTime(a.fitment_date));
      setFitments(fetchedFitments);

      const venSnap = await getDocs(collection(db, "VENDORS")).catch(()=>({docs:[]}));
      setVendors(venSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { 
      console.error("Fetch Data Error:", e); 
      alert("⚠️ Network issue: Loading cached data."); 
    }
    setLoading(false);
  };

  const handlePrintPDF = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to generate PDF.");

    let tableHTML = ''; let title = '';
    const headerHTML = `<html><head><title>Tyre Report</title><style>body { font-family: Arial, sans-serif; padding: 20px; color: #333; } h2 { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; text-transform: uppercase; } table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; } th, td { border: 1px solid #ddd; padding: 8px; text-align: left; } th { background-color: #f4f4f4; font-weight: bold; } .date-text { text-align: right; font-size: 10px; color: #666; margin-bottom: 20px;} @media print { body { -webkit-print-color-adjust: exact; } }</style></head><body>`;
    if (activeTab === 'INVENTORY') {
        title = "Tyre Inventory (Stock) Report";
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Serial No</th><th>Brand</th><th>Type</th><th>Cost (Rs)</th><th>Inv No / Vendor</th><th>Total KM</th><th>Status</th></tr></thead><tbody>${tyres.map(t => `<tr><td><b>${t.serial_no || '-'}</b></td><td>${t.brand || '-'}</td><td>${t.type || '-'}</td><td>${parseFloat(t.cost||0).toFixed(2)}</td><td>${t.invoice_no||'-'} <br/> ${t.vendor||'-'}</td><td>${t.total_km_run||0}</td><td>${t.status||'-'}</td></tr>`).join('')}</tbody></table>`;
    } else if (activeTab === 'FITMENTS') {
        title = "Live Vehicle Fitments Report";
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Vehicle No</th><th>Position</th><th>Tyre Serial No</th><th>Fitment Date</th><th>Fitting KM</th></tr></thead><tbody>${activeFitments.map(f => `<tr><td><b>${f.vehicle_no || f.vehical_no || '-'}</b></td><td>${f.position || '-'}</td><td>${f.tyre_serial || '-'}</td><td>${f.fitment_date || '-'}</td><td>${f.fitting_km || 0}</td></tr>`).join('')}</tbody></table>`;
    } else if (activeTab === 'HISTORY') {
        title = "Tyre Removal & Lifecycle History";
        const dataToPrint = historySearch ? fitmentHistory.filter(f => String(f.tyre_serial||'').toLowerCase().includes(historySearch.toLowerCase()) || String(f.vehicle_no || f.vehical_no || '').toLowerCase().includes(historySearch.toLowerCase())) : fitmentHistory;
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Date</th><th>Vehicle</th><th>Serial No</th><th>Position</th><th>Fitting KM</th><th>Removal KM</th><th>Yield (Run)</th><th>Reason</th></tr></thead><tbody>${dataToPrint.map(f => `<tr><td>${f.removal_date||'-'}</td><td><b>${f.vehicle_no || f.vehical_no || '-'}</b></td><td>${f.tyre_serial||'-'}</td><td>${f.position||'-'}</td><td>${f.fitting_km||0}</td><td>${f.removal_km||0}</td><td><b>${f.km_yield||0}</b></td><td>${f.removal_reason||'-'}</td></tr>`).join('')}</tbody></table>`;
    } else if (activeTab === 'RESOLE') {
        title = "Tyres Sent For Resole (Factory) Report";
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Serial No</th><th>Brand</th><th>Total Prev KM</th><th>Factory Vendor</th><th>Challan No</th><th>Date</th></tr></thead><tbody>${resoleTyres.map(t => `<tr><td><b>${t.serial_no||'-'}</b></td><td>${t.brand||'-'}</td><td>${t.total_km_run||0}</td><td>${t.dispatch_vendor||'-'}</td><td>${t.dispatch_challan||'-'}</td><td>${t.dispatch_date||'-'}</td></tr>`).join('')}</tbody></table>`;
    }
    const footerHTML = `<script>window.onload = function() { setTimeout(function() { window.print(); }, 500); }</script></body></html>`;
    printWindow.document.write(headerHTML + tableHTML + footerHTML); printWindow.document.close();
  };

  const handleExportCSV = () => {
    let csvContent = ""; let fileName = "";
    if (activeTab === 'INVENTORY') {
        fileName = "Tyre_Inventory_Report.csv"; csvContent = "Serial No,Brand,Type,Cost (Rs),Invoice No,Vendor,Total KM Yield,Status\n";
        tyres.forEach(t => { csvContent += `${t.serial_no||'-'},${t.brand||'-'},${t.type||'-'},${t.cost||0},${t.invoice_no||'-'},${t.vendor||'-'},${t.total_km_run||0},${t.status||'-'}\n`; });
    } else if (activeTab === 'FITMENTS') {
        fileName = "Live_Fitments_Report.csv"; csvContent = "Vehicle No,Position,Tyre Serial No,Fitment Date,Fitting KM\n";
        activeFitments.forEach(f => { csvContent += `${f.vehicle_no||f.vehical_no||'-'},${f.position||'-'},${f.tyre_serial||'-'},${f.fitment_date||'-'},${f.fitting_km||0}\n`; });
    } else if (activeTab === 'HISTORY') {
        fileName = "Removal_History_Report.csv"; csvContent = "Date,Vehicle,Serial No,Position,Fitting KM,Removal KM,Yield (Run),Reason\n";
        const dataToExport = historySearch ? fitmentHistory.filter(f => String(f.tyre_serial||'').toLowerCase().includes(historySearch.toLowerCase()) || String(f.vehicle_no || f.vehical_no || '').toLowerCase().includes(historySearch.toLowerCase())) : fitmentHistory;
        dataToExport.forEach(f => { csvContent += `${f.removal_date||'-'},${f.vehicle_no||f.vehical_no||'-'},${f.tyre_serial||'-'},${f.position||'-'},${f.fitting_km||0},${f.removal_km||0},${f.km_yield||0},${f.removal_reason||'-'}\n`; });
    } else if (activeTab === 'RESOLE') {
        fileName = "Resole_Factory_Report.csv"; csvContent = "Serial No,Brand,Total Prev KM,Factory Vendor,Challan No,Dispatch Date\n";
        resoleTyres.forEach(t => { csvContent += `${t.serial_no||'-'},${t.brand||'-'},${t.total_km_run||0},${t.dispatch_vendor||'-'},${t.dispatch_challan||'-'},${t.dispatch_date||'-'}\n`; });
    }
    if(!csvContent) return alert("Nothing to export.");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a");
    link.setAttribute("href", URL.createObjectURL(blob)); link.setAttribute("download", fileName); document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const handleEditTyreSave = async () => {
      if(!editTyreData || !editTyreData.serial_no) return;
      setLoading(true);
      try {
          await updateDoc(doc(db, "TYRE_MASTER", editTyreData.id), { brand: editTyreData.brand, type: editTyreData.type, cost: parseFloat(editTyreData.cost) || 0, status: editTyreData.status, updatedAt: serverTimestamp() });
          alert("✅ Tyre Details Updated Successfully!"); setIsEditTyreModalOpen(false); fetchData();
      } catch (e) { alert("❌ Error updating tyre."); }
      setLoading(false);
  };

  const handleDeleteTyre = async (id: string, serial: string) => {
    if (window.confirm(`⚠️ Are you sure you want to permanently delete Tyre Serial No: ${serial}?`)) {
      try { await deleteDoc(doc(db, "TYRE_MASTER", id)); fetchData(); } catch (error) { alert("❌ Error deleting tyre."); }
    }
  };

  const handleSaveVendor = async () => {
    if (!newVendorData.vendor_name) return alert("⚠️ Vendor Name is mandatory!");
    setLoading(true);
    try {
       const docRef = await addDoc(collection(db, "VENDORS"), { ...newVendorData, createdAt: serverTimestamp() });
       await addDoc(collection(db, "LEDGERS"), { ledger_name: newVendorData.vendor_name, group_head: "Sundry Creditors", opening_balance: parseFloat(newVendorData.opening_balance || '0'), current_balance: parseFloat(newVendorData.opening_balance || '0'), creation_type: "AUTO_SYSTEM", linked_module: "VENDOR", linked_id: docRef.id, created_at: serverTimestamp() });
       alert("✅ Vendor & Ledger Created Successfully!");
       if (isTyreModalOpen) setPurchaseData({ ...purchaseData, vendor_name: newVendorData.vendor_name });
       if (isDispatchResoleModalOpen) setDispatchData({ ...dispatchData, vendor_name: newVendorData.vendor_name });
       if (isFitmentModalOpen) setNewTyreProc({ ...newTyreProc, vendor_name: newVendorData.vendor_name });
       if (isReceiveResoleModalOpen) setResoleData({ ...resoleData, vendor_name: newVendorData.vendor_name });
       setIsVendorModalOpen(false); setNewVendorData({ vendor_name: '', vendor_category: 'Tyre Shop / Factory', contact_person: '', mobile_no: '', gst_number: '', opening_balance: '0' }); fetchData();
    } catch(e) { alert("❌ Error adding vendor"); }
    setLoading(false);
  };

  const handleScanInvoice = async () => {
    if (!invoiceFile) return alert("⚠️ Please select an Invoice PDF or Image first!");
    setScanning(true); setUploadingDoc(true);
    try {
      // 🤖 100% LOCAL extraction via Gemma 4 vision (no cloud).
      const prompt = `Extract from this tyre purchase invoice and reply with ONLY JSON:
{ "invoice_no": "", "vendor_name": "", "total_amount": 0, "gst_percent": 0 }
Empty string / 0 if absent.`;
      const ai = await extractJsonFromImage(invoiceFile, prompt);
      setPurchaseData({
        ...purchaseData,
        invoice_no: ai.invoice_no || `INV-${Math.floor(Math.random() * 10000)}`,
        vendor_name: ai.vendor_name || purchaseData.vendor_name,
      });
      alert("✅ Invoice ko Mamta AI (local Gemma 4) ne padh liya. Verify karein.");
    } catch (error: any) {
      const offline = error?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(error?.message || '');
      alert(offline ? '❌ Local AI engine (Ollama) band hai. Manually bharein.' : '❌ Invoice padhi nahi gayi. Manually bharein.');
    }
    setScanning(false); setUploadingDoc(false);
  };

  const handleAddTyreToGrid = () => {
      if(!currentTyre.serial_no.trim()) return alert("⚠️ Tyre Serial Number is required!");
      if(!currentTyre.inv_amount || parseFloat(currentTyre.inv_amount) <= 0) return alert("⚠️ Valid Invoice Amount is required!");
      const cleanSerial = currentTyre.serial_no.trim().toUpperCase();
      if(tyreList.find(t => t.serial_no === cleanSerial)) return alert("⚠️ This Serial Number is already added in the list below!");
      if(tyres.find(t => t.serial_no === cleanSerial)) return alert("❌ This Serial Number already exists in the Master Database!");

      const invAmt = parseFloat(currentTyre.inv_amount); const gstPct = parseFloat(currentTyre.gst_percent);
      const baseAmt = invAmt / (1 + (gstPct/100)); const gstAmt = invAmt - baseAmt;

      setTyreList([...tyreList, { ...currentTyre, serial_no: cleanSerial, brand: currentTyre.brand.toUpperCase(), gst_amount: gstAmt.toFixed(2), base_amount: baseAmt.toFixed(2) }]);
      setCurrentTyre({ ...currentTyre, serial_no: '', inv_amount: '' });
  };

  const handleRemoveTyreFromGrid = (index: number) => { setTyreList(tyreList.filter((_, i) => i !== index)); };

  const handleSavePurchase = async () => {
    if (tyreList.length === 0) return alert("⚠️ Please add at least one tyre to the list.");
    if (!purchaseData.vendor_name) return alert("⚠️ Vendor Name is required!");
    setLoading(true);
    try {
      // ⚛️ ATOMIC: saare tyres + Cash/Bank entry ek hi batch.commit me — aadha invoice kabhi save nahi hota.
      const batch = writeBatch(db);
      let totalInvoiceValue = 0;
      for (const tyre of tyreList) {
          totalInvoiceValue += parseFloat(tyre.inv_amount);
          batch.set(doc(collection(db, "TYRE_MASTER")), {
              serial_no: tyre.serial_no, brand: tyre.brand, type: tyre.type,
              cost: parseFloat(tyre.inv_amount), base_cost: parseFloat(tyre.base_amount), gst_amount: parseFloat(tyre.gst_amount), gst_percent: tyre.gst_percent,
              invoice_no: purchaseData.invoice_no, vendor: purchaseData.vendor_name, invoice_file_url: purchaseData.invoice_file_url, status: 'IN STOCK', total_km_run: 0, createdAt: serverTimestamp()
          });
      }
      // 🏦 Udhaar => vendor khata Purchase (IN); cash => Payment (OUT) — pehle
      // cash purchase par KOI entry nahi banti thi (Cash Book me hole tha).
      const isCashPur = purchaseData.vendor_name === 'CASH PURCHASE';
      batch.set(doc(collection(db, "BANK_TRANSACTIONS")), {
          date: purchaseData.invoice_date, type: isCashPur ? 'Payment (OUT)' : 'Purchase (IN)', amount: totalInvoiceValue,
          party_name: isCashPur ? 'CASH' : purchaseData.vendor_name, ref_no: purchaseData.invoice_no,
          particulars: `Purchase of ${tyreList.length} Tyres (Brand: ${tyreList[0]?.brand}) | Inv: ${purchaseData.invoice_no}`,
          company: 'PRASAD TRANSPORT', createdAt: serverTimestamp()
      });
      await batch.commit();
      alert(`✅ Successfully Saved Invoice & Added ${tyreList.length} Tyres to Stock!\n(Total Amount: ₹${totalInvoiceValue.toLocaleString('en-IN')})`);
      setIsTyreModalOpen(false); setPurchaseData({ invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], vendor_name: '', invoice_file_url: '' }); 
      setTyreList([]); setInvoiceFile(null); fetchData();
    } catch (e) { alert("❌ Error saving purchase data."); console.error(e); }
    setLoading(false);
  };

  const handleVehicleSearch = (vNo: string) => {
      const cleanVNo = String(vNo || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
      const vObj = vehicles.find(v => String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVNo);

      const currentKm = vObj ? (vObj.current_km || vObj.Current_KM || vObj.meter_reading || vObj.km_reading || '') : '';
      setFitmentData({...fitmentData, vehicle_no: vNo, position: '', fitting_km: currentKm});
      // Vehicle master me na bhi mile to default 10+1 layout se position selection
      // possible rahe — pehle positions hi nahi bante the aur fitment block ho jata tha.
      setAvailablePositions(cleanVNo ? getAxlePositions(vObj ? (vObj.no_of_tyres || '10+1') : '10+1') : []);
      const fittedHere = fitments.filter(f => f.status === 'FITTED' && String(f.vehicle_no || f.vehical_no || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVNo);
      setCurrentVehicleFitments(cleanVNo ? fittedHere : []);
  };

  const handleFitTyre = async () => {
    if (!fitmentData.vehicle_no || !fitmentData.tyre_serial || !fitmentData.fitting_km) return alert("⚠️ Fill all fitment details (Vehicle, Tyre Serial, Fitting KM)!");
    if (!fitmentData.position) return alert("⚠️ Tyre Position chunna zaroori hai — truck map par green slot click karein ya Position dropdown se select karein!");
    const alreadyFitted = currentVehicleFitments.find(f => f.position === fitmentData.position);
    if(alreadyFitted) return alert(`❌ Error: Tyre (${alreadyFitted.tyre_serial}) is already fitted on [${fitmentData.position}]! Please remove it first.`);
    const cleanSerial = fitmentData.tyre_serial.toUpperCase().trim();
    const tyre = tyres.find(t => String(t.serial_no || '').toUpperCase() === cleanSerial);
    // 🛡️ PROCUREMENT GUARD: naya tyre bina Purchase Cost + Vendor ke inventory me
    // NAHI ghusega — cost 0 wale ghost tyres P&L ko galat karte the.
    if (!tyre) {
      if (!parseFloat(newTyreProc.cost) || parseFloat(newTyreProc.cost) <= 0) return alert(`🆕 NEW TYRE DETECTED (${cleanSerial}):\n\n⚠️ Purchase Cost (₹) bharna zaroori hai — bina cost ke tyre accounting/P&L me nahi aa sakta!`);
      if (!newTyreProc.vendor_name) return alert(`🆕 NEW TYRE DETECTED (${cleanSerial}):\n\n⚠️ Vendor/Ledger chunna zaroori hai (ya 💵 CASH PURCHASE select karein)!`);
    } else if (tyre.status === 'FITTED') {
      return alert(`❌ Error: Tyre ${cleanSerial} is already fitted on another vehicle!`);
    } else if (tyre.status === 'SCRAPPED') {
      return alert(`❌ Error: Tyre ${cleanSerial} is SCRAPPED — scrap tyre dobara fit nahi ho sakta!`);
    }
    try {
      setLoading(true);
      // ⚛️ ATOMIC LIFECYCLE WRITE: tyre status flip + fitment record (+ naye tyre
      // ki purchase accounting) — sab ek hi batch.commit me, aadha data kabhi nahi.
      const batch = writeBatch(db);
      const fitKm = parseFloat(fitmentData.fitting_km) || 0;
      if (!tyre) {
          const cost = parseFloat(newTyreProc.cost);
          const gstPct = parseFloat(newTyreProc.gst_percent) || 0;
          const baseAmt = cost / (1 + (gstPct / 100));
          const autoRef = `AUTO-FIT-${cleanSerial}`;
          const tyreRef = doc(collection(db, "TYRE_MASTER"));
          batch.set(tyreRef, {
              serial_no: cleanSerial, brand: (newTyreProc.brand || 'UNKNOWN').toUpperCase(), type: newTyreProc.type,
              cost, base_cost: Math.round(baseAmt * 100) / 100, gst_amount: Math.round((cost - baseAmt) * 100) / 100, gst_percent: newTyreProc.gst_percent,
              vendor: newTyreProc.vendor_name, invoice_no: autoRef,
              status: 'FITTED', total_km_run: 0, createdAt: serverTimestamp(),
          });
          // 🏦 Cash & Bank Book: cash purchase => Payment (OUT); udhaar => vendor khata Purchase (IN).
          const isCash = newTyreProc.vendor_name === 'CASH PURCHASE';
          batch.set(doc(collection(db, "BANK_TRANSACTIONS")), {
              date: fitmentData.fitment_date, type: isCash ? 'Payment (OUT)' : 'Purchase (IN)', amount: cost,
              party_name: isCash ? 'CASH' : newTyreProc.vendor_name, ref_no: autoRef,
              particulars: `Tyre ${cleanSerial} purchase (auto-added during fitment on ${fitmentData.vehicle_no})`,
              company: 'PRASAD TRANSPORT', createdAt: serverTimestamp(),
          });
      } else {
          batch.update(doc(db, "TYRE_MASTER", tyre.id), { status: 'FITTED' });
      }
      batch.set(doc(collection(db, "TYRE_FITMENTS")), { ...fitmentData, tyre_serial: cleanSerial, fitting_km: fitKm, status: 'FITTED', createdAt: serverTimestamp() });
      await batch.commit();
      alert(!tyre
        ? `✅ Tyre Fitted!\n\n🆕 New tyre ${cleanSerial} inventory me add hua @ ₹${parseFloat(newTyreProc.cost).toLocaleString('en-IN')}\n🏦 Accounting entry posted (${newTyreProc.vendor_name}).`
        : "✅ Tyre Fitted Successfully!");
      setIsFitmentModalOpen(false); setFitmentData({ vehicle_no: '', tyre_serial: '', position: '', fitting_km: '', fitment_date: new Date().toISOString().split('T')[0] });
      setNewTyreProc({ cost: '', vendor_name: '', brand: 'MRF', type: 'NEW', gst_percent: '28' });
      setAvailablePositions([]); setCurrentVehicleFitments([]); fetchData();
    } catch (e) { console.error(e); alert("❌ Error fitting tyre."); setLoading(false); }
  };

  const handleRemoveTyre = async () => {
    if (!removeData.removal_km) return alert("⚠️ Enter Removal KM!");
    const fittingKm = parseFloat(selectedFitment.fitting_km || 0); const removalKm = parseFloat(removeData.removal_km || 0);
    if (removalKm <= fittingKm) return alert(`❌ Invalid Entry: Removal KM (${removalKm}) must be strictly greater than Fitting KM (${fittingKm})!`);
    const kmRunThisTime = removalKm - fittingKm;
    const tyre = tyres.find(t => t.serial_no === selectedFitment.tyre_serial);
    if (!tyre) return alert("❌ Tyre Master record missing!");
    try {
      setLoading(true);
      const newTotalKm = (parseFloat(tyre.total_km_run) || 0) + kmRunThisTime;
      // BURST bhi SCRAPPED hai — dono me tyre ki zindagi khatam, cost P&L me jaati hai.
      const isConsumed = removeData.removal_reason === 'SCRAP/AUCTION' || removeData.removal_reason === 'BURST';
      const newTyreStatus = isConsumed ? 'SCRAPPED' : removeData.removal_reason === 'SEND FOR RESOLE' ? 'SENT FOR RESOLE' : 'IN STOCK';

      // 💸 Consumed tyre => poora accumulated cost (purchase + resoles) Direct
      // Expense. Ledger id batch se pehle resolve hota hai; entry batch me jaati hai.
      const consumedCost = parseFloat(tyre.cost || 0);
      const expLedgerId = (isConsumed && consumedCost > 0) ? await ensureTyreExpenseLedger() : null;

      // ⚛️ ATOMIC: fitment close + tyre status + expense entry — ek hi batch.commit.
      const batch = writeBatch(db);
      batch.update(doc(db, "TYRE_FITMENTS", selectedFitment.id), { ...removeData, removal_km: removalKm, status: 'REMOVED', km_yield: kmRunThisTime });
      batch.update(doc(db, "TYRE_MASTER", tyre.id), { status: newTyreStatus, total_km_run: newTotalKm, ...(isConsumed ? { scrapped_on: removeData.removal_date, scrap_reason: removeData.removal_reason } : {}) });
      if (expLedgerId) {
          const vehNo = selectedFitment.vehicle_no || selectedFitment.vehical_no || '';
          const cleanVeh = String(vehNo).replace(/[^A-Z0-9]/ig, '').toUpperCase();
          const vObj = vehicles.find(v => String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVeh);
          batch.set(doc(collection(db, "LEDGER_ENTRIES")), {
              ledgerId: expLedgerId, date: removeData.removal_date,
              particulars: `Tyre ${tyre.serial_no} consumed (${removeData.removal_reason}) — Vehicle ${vehNo} | Total Life: ${newTotalKm.toLocaleString('en-IN')} KM`,
              dr_cr: 'Dr (Debit)', amount: consumedCost,
              company: vObj?.company_name || vObj?.Company_Name || 'ALL', branch: vObj?.branch_name || vObj?.branch || 'ALL',
              source: 'AUTO_TYRE_SCRAP', linked_tyre_id: tyre.id, created_at: serverTimestamp(),
          });
      }
      await batch.commit();

      alert(`✅ Tyre Removed Successfully!\n\n📏 KM Yield this fitment: ${kmRunThisTime.toLocaleString('en-IN')} KM${expLedgerId ? `\n💸 ₹${consumedCost.toLocaleString('en-IN')} posted to P&L — Direct Expenses ➜ ${TYRE_EXP_LEDGER_NAME}.` : ''}`);
      setIsRemoveModalOpen(false); setRemoveData({ removal_km: '', removal_reason: 'SEND FOR RESOLE', removal_date: new Date().toISOString().split('T')[0] });
      setSelectedFitment(null); fetchData();
    } catch (e) { console.error(e); alert("❌ Error removing tyre."); setLoading(false); }
  };

  const handleAddDispatchSerial = () => {
    if(!currentDispatchSerial.trim()) return;
    const newSerial = currentDispatchSerial.trim().toUpperCase();
    if(dispatchSerialList.includes(newSerial)) return alert("⚠️ Serial Number already added to dispatch list!");
    const exists = tyres.find(t => t.serial_no === newSerial);
    if (!exists) return alert(`❌ Tyre ${newSerial} not found in inventory!`);
    if (exists.status === 'FITTED') return alert(`❌ Tyre ${newSerial} is currently FITTED on a vehicle! Remove it first.`);
    if (exists.status === 'SENT FOR RESOLE' || exists.status === 'AT FACTORY') return alert(`❌ Tyre ${newSerial} is already at the factory!`);
    setDispatchSerialList([...dispatchSerialList, newSerial]); setCurrentDispatchSerial('');
  };

  const handleSaveDispatch = async () => {
      if (dispatchSerialList.length === 0) return alert("⚠️ Please add at least one tyre to dispatch.");
      if (!dispatchData.vendor_name || !dispatchData.challan_no) return alert("⚠️ Factory Name and Challan No are required!");
      setLoading(true);
      try {
          for (const sno of dispatchSerialList) {
              const tyre = tyres.find(t => t.serial_no === sno);
              if (tyre) { await updateDoc(doc(db, "TYRE_MASTER", tyre.id), { status: 'AT FACTORY', dispatch_vendor: dispatchData.vendor_name, dispatch_date: dispatchData.dispatch_date, dispatch_challan: dispatchData.challan_no }); }
          }
          alert(`✅ Dispatch Challan Created! ${dispatchSerialList.length} Tyres sent to ${dispatchData.vendor_name}.`);
          setIsDispatchResoleModalOpen(false); setDispatchData({ vendor_name: '', dispatch_date: new Date().toISOString().split('T')[0], challan_no: '' });
          setDispatchSerialList([]); fetchData();
      } catch (e) { alert("❌ Error dispatching tyres."); }
      setLoading(false);
  };

  const handleReceiveResole = async () => {
      if (!resoleData.cost || !resoleData.invoice_no) return alert("⚠️ Resole Cost and Invoice No are required!");
      setLoading(true);
      try {
          const resoleCost = parseFloat(resoleData.cost); const oldCost = parseFloat(selectedResoleTyre.cost || 0); const newTotalCost = oldCost + resoleCost;
          // Modal me chuna vendor priority par — pehle yeh field ignore hota tha.
          const factoryVendor = resoleData.vendor_name || selectedResoleTyre.dispatch_vendor || 'UNKNOWN FACTORY';
          const gstPct = parseFloat(resoleData.gst_percent) || 0;
          // ⚛️ ATOMIC: tyre wapas stock + Cash/Bank entry ek saath.
          const batch = writeBatch(db);
          batch.update(doc(db, "TYRE_MASTER", selectedResoleTyre.id), { status: 'RESOLED', type: 'RESOLED', cost: newTotalCost, last_resole_date: resoleData.invoice_date, last_resole_vendor: factoryVendor, dispatch_vendor: '', dispatch_challan: '' });
          const isCashResole = factoryVendor === 'CASH PURCHASE';
          batch.set(doc(collection(db, "BANK_TRANSACTIONS")), {
              date: resoleData.invoice_date, type: isCashResole ? 'Payment (OUT)' : 'Purchase (IN)', amount: resoleCost,
              party_name: isCashResole ? 'CASH' : factoryVendor, ref_no: resoleData.invoice_no,
              particulars: `Resole Charges for Serial: ${selectedResoleTyre.serial_no} | GST: ${gstPct}%`,
              company: 'PRASAD TRANSPORT', createdAt: serverTimestamp()
          });
          await batch.commit();
          alert("✅ Tyre received from Factory, Added to Stock & Accounts Updated!");
          setIsReceiveResoleModalOpen(false); setSelectedResoleTyre(null);
          setResoleData({ vendor_name: '', invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], cost: '', gst_percent: '18', remarks: 'Resoled' }); fetchData();
      } catch (e) { alert("❌ Error saving resole data."); }
      setLoading(false);
  };

  const availableTyres = tyres.filter(t => t.status === 'IN STOCK' || t.status === 'RESOLED');
  // 🆕 Typed serial master me kahin nahi hai => naya tyre => procurement fields dikhao.
  const cleanFitSerial = String(fitmentData.tyre_serial || '').trim().toUpperCase();
  const isNewTyreSerial = !!cleanFitSerial && !tyres.find(t => String(t.serial_no || '').toUpperCase() === cleanFitSerial);
  const activeFitments = fitments.filter(f => f.status === 'FITTED');
  const fitmentHistory = fitments.filter(f => f.status === 'REMOVED');
  const resoleTyres = tyres.filter(t => t.status === 'SENT FOR RESOLE' || t.status === 'AT FACTORY'); 

  const filteredHistory = historySearch 
      ? fitmentHistory.filter(f => String(f.tyre_serial||'').toLowerCase().includes(historySearch.toLowerCase()) || String(f.vehicle_no || f.vehical_no || '').toLowerCase().includes(historySearch.toLowerCase()))
      : fitmentHistory;

  const groupedFitments: any = {};
  activeFitments.forEach(f => {
      const vNo = f.vehicle_no || f.vehical_no;
      if (!groupedFitments[vNo]) groupedFitments[vNo] = [];
      groupedFitments[vNo].push(f);
  });

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); display: flex; align-items: center; gap: 8px;}
        .glow-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(16, 185, 129, 0.6); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; transition: 0.3s;}
        .modern-input:focus { border-color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 15px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px;}
        td { padding: 12px 15px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; letter-spacing: 1px;}
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        
        .truck-chassis-container { position: relative; display: flex; flex-direction: column; gap: 20px; alignItems: center; padding: 30px 20px 50px 20px; background: rgba(15,23,42,0.9); border-radius: 20px; border: 2px solid #1e293b; margin-top: 15px; overflow: hidden; box-shadow: inset 0 0 50px rgba(0,0,0,0.9), 0 10px 30px rgba(0,0,0,0.5); }
        .truck-cabin { width: 160px; height: 70px; background: linear-gradient(180deg, #38bdf8, #0369a1); border-radius: 20px 20px 5px 5px; border-bottom: 8px solid #0f172a; display: flex; justify-content: center; align-items: center; color: #fff; font-weight: 900; box-shadow: inset 0 15px 25px rgba(255,255,255,0.4), 0 10px 20px rgba(0,0,0,0.7); z-index: 5; font-size: 14px; letter-spacing: 3px; text-shadow: 1px 1px 3px rgba(0,0,0,0.8); position: relative; }
        .truck-cabin::after { content: ''; position: absolute; bottom: -8px; width: 40px; height: 15px; background: #fbbf24; border-radius: 0 0 5px 5px; box-shadow: 0 5px 10px rgba(251, 191, 36, 0.5); }
        .chassis-rail { position: absolute; top: 80px; bottom: 0; width: 18px; background: linear-gradient(90deg, #1e293b, #475569, #1e293b); z-index: 0; border-radius: 2px; box-shadow: 5px 0 15px rgba(0,0,0,0.8), inset 2px 0 5px rgba(255,255,255,0.1); }
        .chassis-rail.left { left: calc(50% - 35px); }
        .chassis-rail.right { right: calc(50% - 35px); }

        .tyre-dot { width: 38px; height: 85px; border-radius: 8px; cursor: pointer; transition: 0.3s; position: relative; display: flex; align-items: center; justify-content: center; z-index: 2; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.5); }
        .tyre-dot.empty { background: rgba(16, 185, 129, 0.1); border: 2px dashed #10b981; }
        .tyre-dot.empty:hover { background: rgba(16, 185, 129, 0.3); box-shadow: 0 0 20px #10b981; transform: scale(1.05) translateY(-2px); }
        .tyre-dot.occupied { background: repeating-linear-gradient(0deg, #0f172a, #0f172a 5px, #1e293b 5px, #1e293b 10px); border: 2px solid #ef4444; cursor: not-allowed; box-shadow: inset 0 0 20px rgba(0,0,0,0.9), 0 0 10px rgba(239, 68, 68, 0.3); }
        .tyre-dot.selected { background: repeating-linear-gradient(0deg, #0284c7, #0284c7 5px, #38bdf8 5px, #38bdf8 10px); border: 2px solid #bae6fd; box-shadow: 0 0 25px #38bdf8, inset 0 0 15px rgba(255,255,255,0.5); transform: scale(1.1); z-index: 10; }
        .tyre-text { font-size: 11px; font-weight: 900; color: #fbbf24; writing-mode: vertical-rl; text-orientation: mixed; letter-spacing: 2px; text-shadow: 2px 2px 4px black, -1px -1px 2px black; background: rgba(0,0,0,0.7); padding: 6px 3px; border-radius: 4px; border: 1px solid rgba(251, 191, 36, 0.3); }
        .axle-line { height: 12px; background: linear-gradient(to bottom, #94a3b8, #334155, #0f172a); width: 85px; margin: 0; border-radius: 2px; z-index: 1; box-shadow: 0 8px 10px rgba(0,0,0,0.7), inset 0 2px 4px rgba(255,255,255,0.2);}

        .grid-input { background: transparent; border: 1px solid #334155; color: #fff; padding: 8px; width: 100%; border-radius: 4px; box-sizing: border-box; font-size: 12px; }
        .grid-input:focus { border-color: #c084fc; outline: none; background: rgba(0,0,0,0.5); }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900', letterSpacing: '-0.5px' }}>Tyre & Asset Inventory</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Procurement, Auto-Billing & Tyre Fitment Maps</p>
        </div>
        <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
          <button className="glow-btn" style={{ background: '#334155', border: '1px solid #475569' }} onClick={handlePrintPDF}>🖨️ Print PDF</button>
          <button className="glow-btn" style={{ background: '#1e293b', border: '1px solid #38bdf8', color: '#38bdf8' }} onClick={handleExportCSV}>📥 Export Excel</button>
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }} onClick={() => setIsFitmentModalOpen(true)}>
            <span style={{ fontSize: '16px' }}>🚛</span> Fit Tyre to Vehicle
          </button>
          <button className="glow-btn" onClick={() => setIsTyreModalOpen(true)}>
            <span style={{ fontSize: '16px' }}>🧾</span> New Purchase / Add Stock
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        <button className={`tab-btn ${activeTab === 'FITMENTS' ? 'active' : ''}`} onClick={() => setActiveTab('FITMENTS')}>🚛 LIVE VEHICLE FITMENTS</button>
        <button className={`tab-btn ${activeTab === 'INVENTORY' ? 'active' : ''}`} onClick={() => setActiveTab('INVENTORY')}>📦 TYRE INVENTORY (STOCK)</button>
        <button className={`tab-btn ${activeTab === 'RESOLE' ? 'active' : ''}`} onClick={() => setActiveTab('RESOLE')}>♻️ FACTORY & RESOLE</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📜 REMOVAL HISTORY</button>
      </div>

      {/* 🚛 TAB 1: LIVE FITMENTS */}
      {activeTab === 'FITMENTS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #f59e0b' }}>
          <h3 style={{ color: '#f59e0b', marginTop: 0, marginBottom: '15px' }}>Tyres Currently Running on Vehicles</h3>
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Data...</p> : (
            <div>
               {Object.keys(groupedFitments).length === 0 ? <div style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>No active fitments.</div> : 
                 Object.keys(groupedFitments).map((vNo, idx) => (
                   <div key={idx} style={{ marginBottom: '30px', background: 'rgba(0,0,0,0.2)', border: '1px solid #334155', borderRadius: '12px', overflow: 'hidden' }}>
                      <div style={{ background: 'rgba(245, 158, 11, 0.1)', padding: '15px 20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                         <h3 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>🚛 {vNo}</h3>
                         <span className="badge" style={{ background: '#f59e0b', color: '#fff' }}>{groupedFitments[vNo].length} Tyres Fitted</span>
                      </div>
                      <table style={{ margin: 0, width: '100%' }}>
                        <thead>
                          <tr>
                            <th>Position (Axle)</th>
                            <th style={{ color: '#10b981' }}>Tyre Serial No</th>
                            <th>Fitment Date</th>
                            <th>Fitting KM</th>
                            <th style={{ textAlign: 'center' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                           {groupedFitments[vNo].map((f: any, i: number) => (
                             <tr key={i}>
                               <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{f.position}</td>
                               <td style={{ color: '#10b981', fontWeight: '900', fontSize: '15px' }}>{f.tyre_serial}</td>
                               <td>{f.fitment_date}</td>
                               <td style={{ color: '#f59e0b', fontWeight: 'bold' }}>{parseFloat(f.fitting_km||0).toLocaleString('en-IN')} KM</td>
                               <td style={{ textAlign: 'center' }}>
                                 <button onClick={() => { setSelectedFitment(f); setIsRemoveModalOpen(true); }} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '10px', transition: '0.3s' }}>
                                   ✂️ Remove
                                 </button>
                               </td>
                             </tr>
                           ))}
                        </tbody>
                      </table>
                   </div>
                 ))
               }
            </div>
          )}
        </div>
      )}

      {/* 📦 TAB 2: TYRE INVENTORY */}
      {activeTab === 'INVENTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #38bdf8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#38bdf8', margin: 0 }}>All Tyres Master Database</h3>
            <span style={{ background: 'rgba(56,189,248,0.1)', padding: '5px 12px', borderRadius: '20px', color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>Total Stock: {availableTyres.length}</span>
          </div>
          
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Inventory...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Serial No</th>
                  <th>Brand</th>
                  <th>Type</th>
                  <th>Cost (₹)</th>
                  <th>Inv No / Vendor</th>
                  <th style={{ color: '#10b981' }}>Total KM Yield</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {tyres.length === 0 ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: '30px' }}>No Tyres in Stock.</td></tr> : 
                  tyres.map((t, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: '900', color: '#fff', fontSize: '15px' }}>{t.serial_no}</td>
                    <td style={{ color: '#cbd5e1' }}>{t.brand}</td>
                    <td>
                      <span className="badge" style={{ 
                        background: t.type === 'NEW' ? 'rgba(16,185,129,0.1)' : t.type === 'RESOLED' ? 'rgba(245,158,11,0.1)' : 'rgba(168,85,247,0.1)', 
                        color: t.type === 'NEW' ? '#10b981' : t.type === 'RESOLED' ? '#f59e0b' : '#a855f7', 
                        border: `1px solid ${t.type === 'NEW' ? '#10b981' : t.type === 'RESOLED' ? '#f59e0b' : '#a855f7'}` 
                      }}>{t.type === 'SECOND_HAND' ? 'OLD / 2ND HAND' : t.type}</span>
                    </td>
                    <td style={{ fontWeight: 'bold', color: '#38bdf8' }}>₹{parseFloat(t.cost || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                           <span style={{ color: '#c084fc', fontSize: '11px', fontWeight: 'bold' }}>{t.invoice_no || '-'}</span>
                           {t.invoice_file_url && <a href={t.invoice_file_url} target="_blank" rel="noreferrer" style={{ color: '#10b981', fontSize: '14px', textDecoration: 'none' }} title="View Invoice">👁️</a>}
                        </div>
                        <small style={{ color: '#94a3b8' }}>{t.vendor || '-'}</small>
                    </td>
                    <td style={{ fontWeight: '900', fontSize: '14px' }}>
                      <span style={{ color: parseFloat(t.total_km_run || 0) >= 60000 ? '#ef4444' : '#10b981' }}>{parseFloat(t.total_km_run || 0).toLocaleString('en-IN')} KM</span>
                      {parseFloat(t.total_km_run || 0) >= 60000 && String(t.status || '').toUpperCase() !== 'SCRAPPED' && (
                        <span className="pt-pill pt-pill--pending-unload" style={{ marginLeft: '6px', fontSize: '9px' }}>⚠️ Change Due</span>
                      )}
                    </td>
                    <td>
                      <span className="badge" style={{ 
                        background: t.status === 'IN STOCK' ? 'rgba(16,185,129,0.2)' : t.status === 'RESOLED' ? 'rgba(16,185,129,0.2)' : t.status === 'FITTED' ? 'rgba(56,189,248,0.2)' : t.status === 'SCRAPPED' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', 
                        color: t.status === 'IN STOCK' ? '#10b981' : t.status === 'RESOLED' ? '#10b981' : t.status === 'FITTED' ? '#38bdf8' : t.status === 'SCRAPPED' ? '#ef4444' : '#f59e0b' 
                      }}>{t.status}</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                        <button onClick={() => { setEditTyreData({...t}); setIsEditTyreModalOpen(true); }} style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✏️ Edit</button>
                        <button onClick={() => handleDeleteTyre(t.id, t.serial_no)} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', visibility: t.status === 'FITTED' ? 'hidden' : 'visible' }}>🗑️ Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ♻️ TAB 3: RESOLE MANAGEMENT */}
      {activeTab === 'RESOLE' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #10b981' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#10b981', margin: 0 }}>Tyres Sent for Resoling (At Factory)</h3>
            <div style={{ display: 'flex', gap: '15px' }}>
                <span style={{ background: 'rgba(16,185,129,0.1)', padding: '5px 12px', borderRadius: '20px', color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>Pending Resoles: {resoleTyres.length}</span>
                <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #c084fc, #9333ea)', padding: '8px 15px', fontSize: '12px' }} onClick={() => setIsDispatchResoleModalOpen(true)}>
                    📤 Dispatch Tyres to Factory
                </button>
            </div>
          </div>
          
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Data...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Serial No</th>
                  <th>Brand</th>
                  <th style={{ color: '#10b981' }}>Total Previous KM</th>
                  <th>Factory / Vendor Details</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {resoleTyres.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No tyres currently at factory.</td></tr> : 
                  resoleTyres.map((t, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: '900', color: '#fff', fontSize: '15px' }}>{t.serial_no}</td>
                    <td style={{ color: '#cbd5e1' }}>{t.brand}</td>
                    <td style={{ color: '#10b981', fontWeight: '900', fontSize: '14px' }}>{parseFloat(t.total_km_run || 0).toLocaleString('en-IN')} KM</td>
                    <td>
                        <span style={{ color: '#c084fc', fontWeight: 'bold' }}>{t.dispatch_vendor || '-'}</span><br/>
                        <span style={{ color: '#94a3b8', fontSize: '11px' }}>Challan: {t.dispatch_challan || '-'} | Date: {t.dispatch_date || '-'}</span>
                    </td>
                    <td>
                      <span className="badge" style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b', border: '1px solid #f59e0b' }}>{t.status}</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button onClick={() => { setSelectedResoleTyre(t); setIsReceiveResoleModalOpen(true); }} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', padding: '6px 15px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', transition: '0.3s' }}>
                        📥 Receive & Pay Bill
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 📜 TAB 4: REMOVAL HISTORY WITH SEARCH */}
      {activeTab === 'HISTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #8b5cf6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#c084fc', margin: 0 }}>Tyre Removal & Lifecycle History</h3>
            <input 
              className="modern-input" 
              placeholder="🔍 Search Tyre Serial No or Vehicle No..." 
              value={historySearch} 
              onChange={e => setHistorySearch(e.target.value)} 
              style={{ width: '300px', borderColor: '#c084fc' }}
            />
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Vehicle</th>
                <th>Serial No</th>
                <th>Position</th>
                <th>Fit KM ➔ Rem KM</th>
                <th style={{ color: '#10b981' }}>KM Yield (Run)</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No removal history found.</td></tr> : 
                filteredHistory.map((f, i) => {
                const yieldKm = parseFloat(f.km_yield || 0);
                return (
                <tr key={i}>
                  <td>{f.removal_date}</td>
                  <td style={{ fontWeight: 'bold', color: '#fff' }}>{f.vehicle_no || f.vehical_no}</td>
                  <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{f.tyre_serial}</td>
                  <td style={{ color: '#cbd5e1' }}>{f.position}</td>
                  <td style={{ fontSize: '11px', color: '#94a3b8' }}>{parseFloat(f.fitting_km||0).toLocaleString('en-IN')} ➔ {parseFloat(f.removal_km||0).toLocaleString('en-IN')}</td>
                  <td>
                    <span style={{ color: yieldKm > 50000 ? '#10b981' : yieldKm < 20000 ? '#ef4444' : '#f59e0b', fontWeight: '900', fontSize: '15px' }}>
                       {yieldKm.toLocaleString('en-IN')} KM
                    </span>
                    {yieldKm > 50000 && <span style={{fontSize:'10px', marginLeft:'5px'}} title="High Yield">🌟</span>}
                    {yieldKm < 20000 && <span style={{fontSize:'10px', marginLeft:'5px'}} title="Low Yield">⚠️</span>}
                  </td>
                  <td>
                    <span className="badge" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid #ef4444' }}>
                      {f.removal_reason}
                    </span>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      )}

      {/* ✏️ MODAL 0: EDIT TYRE DATA */}
      {isEditTyreModalOpen && editTyreData && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #38bdf8', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#38bdf8' }}>✏️ Edit Tyre Profile</h2>
              <button onClick={() => setIsEditTyreModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Tyre Serial No (Unchangeable)</label>
                <input className="modern-input" value={editTyreData.serial_no} disabled style={{background: 'rgba(0,0,0,0.3)', color: '#64748b'}}/>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Brand / Make</label>
                  <input className="modern-input" value={editTyreData.brand} onChange={e=>setEditTyreData({...editTyreData, brand: e.target.value.toUpperCase()})} />
                </div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Tyre Type</label>
                  <select className="modern-input" value={editTyreData.type} onChange={e=>setEditTyreData({...editTyreData, type: e.target.value})}>
                    <option value="NEW">Brand New</option>
                    <option value="RESOLED">Resoled</option>
                    <option value="SECOND_HAND">Old / 2nd Hand</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Total Cost (₹)</label>
                  <input type="number" className="modern-input" style={{ borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={editTyreData.cost} onChange={e=>setEditTyreData({...editTyreData, cost: e.target.value})} />
                </div>
                <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Current Status</label>
                  <select className="modern-input" style={{ borderColor: '#ef4444', color: '#ef4444', fontWeight: 'bold' }} value={editTyreData.status} onChange={e=>setEditTyreData({...editTyreData, status: e.target.value})} disabled={editTyreData.status === 'FITTED'}>
                    <option value="IN STOCK">IN STOCK (Available)</option>
                    <option value="SCRAPPED">SCRAPPED / SOLD (Deactive)</option>
                    <option value="FITTED" disabled>FITTED (On Vehicle)</option>
                    <option value="SENT FOR RESOLE">SENT FOR RESOLE</option>
                  </select>
                </div>
              </div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '15px' }} onClick={handleEditTyreSave} disabled={loading}>
              {loading ? '⏳ Updating...' : '✅ Save Tyre Changes'}
            </button>
          </div>
        </div>
      )}

      {/* 🧾 MODAL 1: ADVANCED PURCHASE INVOICE & SMART TABLE */}
      {isTyreModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1100px', border: '1px solid #10b981', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)', maxHeight: '95vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>🧾 Register Tyre Purchase Invoice</h2>
              <button onClick={() => setIsTyreModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #38bdf8', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
               <div>
                 <label style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '14px', display: 'block' }}>🤖 Upload Original Bill & Scan (Auto-Fill)</label>
                 <p style={{ color: '#94a3b8', fontSize: '11px', marginTop: '5px', marginBottom: 0 }}>Select PDF/Image of the invoice. It will be securely stored and AI will extract details.</p>
               </div>
               <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                 <input type="file" accept="image/*,.pdf" onChange={(e) => setInvoiceFile(e.target.files ? e.target.files[0] : null)} style={{ color: 'white', fontSize: '12px', background: '#1e293b', padding: '8px', borderRadius: '8px' }} />
                 <button onClick={handleScanInvoice} disabled={!invoiceFile || scanning || uploadingDoc} style={{ padding: '10px 20px', background: invoiceFile ? '#3b82f6' : '#334155', color: 'white', border: 'none', borderRadius: '8px', cursor: invoiceFile ? 'pointer' : 'not-allowed', fontWeight: 'bold', transition: '0.3s' }}>
                    {scanning || uploadingDoc ? '🚀 SCANNING & UPLOADING...' : '🔍 UPLOAD TO SECURE DRIVE & AUTO-FILL'}
                 </button>
               </div>
            </div>
            
            {purchaseData.invoice_file_url && (
                 <div style={{ padding: '10px', background: 'rgba(16,185,129,0.1)', color: '#10b981', borderRadius: '8px', marginBottom: '20px', fontWeight: 'bold', textAlign: 'center' }}>
                     ✅ Invoice File Uploaded Successfully!
                 </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '15px', marginBottom: '20px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Invoice Number *</label><input className="modern-input" placeholder="e.g. INV-2026-001" value={purchaseData.invoice_no} onChange={e=>setPurchaseData({...purchaseData, invoice_no: e.target.value.toUpperCase()})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Invoice Date *</label><input type="date" className="modern-input" value={purchaseData.invoice_date} onChange={e=>setPurchaseData({...purchaseData, invoice_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Select Vendor (Ledger) *</label>
                  <span onClick={() => setIsVendorModalOpen(true)} style={{ fontSize:'11px', color:'#10b981', cursor: 'pointer', fontWeight: 'bold' }}>+ New Vendor</span>
                </div>
                <select className="modern-input" style={{ borderColor: '#38bdf8' }} value={purchaseData.vendor_name} onChange={e=>setPurchaseData({...purchaseData, vendor_name: e.target.value})}>
                   <option value="">-- Choose Vendor --</option>
                   <option value="CASH PURCHASE">💵 CASH PURCHASE (No Ledger)</option>
                   {vendors.map(v => <option key={v.id} value={v.vendor_name}>{v.vendor_name}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginTop: '20px' }}>
               <label style={{ fontSize:'14px', color:'#c084fc', fontWeight:'bold', display:'block', marginBottom:'10px' }}>🛒 Add Tyres to Invoice (Line Items)</label>
               <div style={{ overflowX: 'auto', background: 'rgba(0,0,0,0.2)', border: '1px solid #334155', borderRadius: '8px' }}>
                 <table style={{ margin: 0, minWidth: '800px' }}>
                   <thead style={{ background: '#1e293b' }}>
                     <tr>
                       <th style={{ width: '40px', textAlign: 'center' }}>SL</th>
                       <th style={{ width: '120px' }}>Tyre Brand</th>
                       <th style={{ width: '150px' }}>Tyre Serial No *</th>
                       <th style={{ width: '120px' }}>Tyre Type</th>
                       <th style={{ width: '80px' }}>GST %</th>
                       <th style={{ width: '100px', color: '#f59e0b' }}>GST Amount</th>
                       <th style={{ width: '120px', color: '#10b981' }}>Inv Amount (₹)</th>
                       <th style={{ width: '80px', textAlign: 'center' }}>Action</th>
                     </tr>
                   </thead>
                   <tbody>
                     {tyreList.map((t, idx) => (
                       <tr key={idx} style={{ background: 'rgba(16, 185, 129, 0.05)' }}>
                         <td style={{ textAlign: 'center', color: '#94a3b8' }}>{idx + 1}</td>
                         <td style={{ fontWeight: 'bold' }}>{t.brand}</td>
                         <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{t.serial_no}</td>
                         <td><span className="badge" style={{ background: '#334155' }}>{t.type}</span></td>
                         <td>{t.gst_percent}%</td>
                         <td style={{ color: '#f59e0b' }}>₹{t.gst_amount}</td>
                         <td style={{ color: '#10b981', fontWeight: 'bold' }}>₹{parseFloat(t.inv_amount).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                         <td style={{ textAlign: 'center' }}>
                           <button onClick={() => handleRemoveTyreFromGrid(idx)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '14px', cursor: 'pointer' }}>✕</button>
                         </td>
                       </tr>
                     ))}

                     <tr style={{ background: 'rgba(192, 132, 252, 0.05)', borderTop: '1px solid #c084fc' }}>
                       <td style={{ textAlign: 'center', color: '#c084fc', fontWeight: 'bold' }}>+</td>
                       <td><input className="grid-input" placeholder="e.g. MRF" value={currentTyre.brand} onChange={e=>setCurrentTyre({...currentTyre, brand: e.target.value.toUpperCase()})} /></td>
                       <td>
                          <input 
                             className="grid-input" 
                             style={{ borderColor: '#c084fc', color: '#c084fc', fontWeight: 'bold' }} 
                             placeholder="Serial No..." 
                             value={currentTyre.serial_no} 
                             onChange={e=>setCurrentTyre({...currentTyre, serial_no: e.target.value.toUpperCase()})}
                             onKeyDown={e => { if(e.key === 'Enter') { e.preventDefault(); handleAddTyreToGrid(); } }}
                          />
                       </td>
                       <td>
                          <select className="grid-input" value={currentTyre.type} onChange={e=>setCurrentTyre({...currentTyre, type: e.target.value})}>
                            <option value="NEW">Brand New</option>
                            <option value="RESOLED">Resoled</option>
                            <option value="SECOND_HAND">Old / 2nd Hand</option>
                          </select>
                       </td>
                       <td>
                          <select className="grid-input" value={currentTyre.gst_percent} onChange={e=>setCurrentTyre({...currentTyre, gst_percent: e.target.value})}>
                            <option value="28">28%</option><option value="18">18%</option><option value="0">0%</option>
                          </select>
                       </td>
                       <td style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                          ₹{(parseFloat(currentTyre.inv_amount || '0') - (parseFloat(currentTyre.inv_amount || '0') / (1 + (parseFloat(currentTyre.gst_percent)/100)))).toFixed(2)}
                       </td>
                       <td>
                          <input 
                            type="number" 
                            className="grid-input" 
                            style={{ borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} 
                            placeholder="Total ₹" 
                            value={currentTyre.inv_amount} 
                            onChange={e=>setCurrentTyre({...currentTyre, inv_amount: e.target.value})}
                            onKeyDown={e => { if(e.key === 'Enter') { e.preventDefault(); handleAddTyreToGrid(); } }}
                          />
                       </td>
                       <td style={{ textAlign: 'center' }}>
                          <button onClick={handleAddTyreToGrid} style={{ background: '#c084fc', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' }}>ADD</button>
                       </td>
                     </tr>
                   </tbody>
                 </table>
               </div>
               
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '15px', padding: '15px', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '8px', border: '1px dashed #10b981' }}>
                  <div style={{ color: '#94a3b8', fontSize: '13px' }}>Total Tyres Added: <b style={{color: '#fff', fontSize: '16px'}}>{tyreList.length}</b></div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase' }}>Grand Invoice Total</span>
                    <h2 style={{ margin: 0, color: '#10b981', fontSize: '24px' }}>
                      ₹{tyreList.reduce((sum, t) => sum + parseFloat(t.inv_amount), 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                    </h2>
                  </div>
               </div>
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '16px' }} onClick={handleSavePurchase} disabled={loading || tyreList.length === 0}>
               {loading ? '⏳ Processing & Saving...' : '💾 Save Invoice, Auto-Ledger & Add Tyres to Stock'}
            </button>
          </div>
        </div>
      )}

      {/* 🚚 MODAL 1C: DISPATCH TO FACTORY FOR RESOLE */}
      {isDispatchResoleModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '650px', border: '1px solid #c084fc', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#c084fc' }}>📤 Dispatch Tyres to Factory (For Resole)</h2>
              <button onClick={() => setIsDispatchResoleModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Select Factory/Vendor *</label>
                  <span onClick={() => setIsVendorModalOpen(true)} style={{ fontSize:'11px', color:'#10b981', cursor: 'pointer', fontWeight: 'bold' }}>+ New Factory</span>
                </div>
                <select className="modern-input" style={{ borderColor: '#38bdf8' }} value={dispatchData.vendor_name} onChange={e=>setDispatchData({...dispatchData, vendor_name: e.target.value})}>
                   <option value="">-- Choose Factory --</option>
                   {vendors.map(v => <option key={v.id} value={v.vendor_name}>{v.vendor_name}</option>)}
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Dispatch Date</label><input type="date" className="modern-input" value={dispatchData.dispatch_date} onChange={e=>setDispatchData({...dispatchData, dispatch_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Challan No *</label><input className="modern-input" placeholder="e.g. CH-001" value={dispatchData.challan_no} onChange={e=>setDispatchData({...dispatchData, challan_no: e.target.value.toUpperCase()})} /></div>
            </div>

            <div style={{ background: 'rgba(192, 132, 252, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #c084fc' }}>
               <label style={{ fontSize:'12px', color:'#c084fc', fontWeight:'bold' }}>Scan/Enter Tyres to Dispatch *</label>
               <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                  <input 
                     className="modern-input" 
                     style={{ borderColor: '#c084fc', textTransform: 'uppercase', fontWeight: 'bold' }} 
                     placeholder="Type Serial No. and press Enter or Add..." 
                     value={currentDispatchSerial} 
                     onChange={e => setCurrentDispatchSerial(e.target.value)} 
                     onKeyDown={e => { if(e.key === 'Enter') { e.preventDefault(); handleAddDispatchSerial(); } }}
                  />
                  <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #c084fc, #9333ea)', whiteSpace: 'nowrap' }} onClick={(e) => { e.preventDefault(); handleAddDispatchSerial(); }}>➕ Add</button>
               </div>

               {dispatchSerialList.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '8px', border: '1px solid #334155' }}>
                     {dispatchSerialList.map((serial, idx) => (
                        <div key={idx} style={{ background: 'rgba(192, 132, 252, 0.2)', border: '1px solid #c084fc', color: '#fff', padding: '6px 15px', borderRadius: '20px', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 'bold' }}>
                           {serial}
                           <span onClick={() => setDispatchSerialList(dispatchSerialList.filter(s => s !== serial))} style={{ color: '#ef4444', cursor: 'pointer', fontSize: '16px' }} title="Remove">✕</span>
                        </div>
                     ))}
                  </div>
               )}
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '15px' }} onClick={handleSaveDispatch} disabled={loading || dispatchSerialList.length === 0}>
              {loading ? '⏳ Dispatching...' : `📤 Generate Challan & Dispatch ${dispatchSerialList.length} Tyres`}
            </button>
          </div>
        </div>
      )}

      {/* 📥 MODAL 1B: RECEIVE RESOLED TYRE MODAL */}
      {isReceiveResoleModalOpen && selectedResoleTyre && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '600px', border: '1px solid #10b981', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>📥 Receive Resoled Tyre (From Factory)</h2>
              <button onClick={() => setIsReceiveResoleModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #38bdf8' }}>
              <p style={{ margin: '0 0 8px 0', color: '#94a3b8', fontSize: '13px' }}>Receiving Tyre Serial: <b style={{color:'#fff'}}>{selectedResoleTyre.serial_no}</b></p>
              <p style={{ margin: 0, color: '#10b981', fontSize: '12px' }}>Previous Total Run: {parseFloat(selectedResoleTyre.total_km_run || 0).toLocaleString('en-IN')} KM</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Resoling Vendor (Ledger) *</label>
                  <span onClick={() => setIsVendorModalOpen(true)} style={{ fontSize:'11px', color:'#10b981', cursor: 'pointer', fontWeight: 'bold' }}>+ New Vendor</span>
                </div>
                <select className="modern-input" style={{ borderColor: '#38bdf8' }} value={resoleData.vendor_name} onChange={e=>setResoleData({...resoleData, vendor_name: e.target.value})}>
                   <option value="">-- Choose Vendor --</option>
                   <option value="CASH PURCHASE">💵 CASH BILL (No Ledger)</option>
                   {vendors.map(v => <option key={v.id} value={v.vendor_name}>{v.vendor_name}</option>)}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Factory Invoice No *</label><input className="modern-input" value={resoleData.invoice_no} onChange={e=>setResoleData({...resoleData, invoice_no: e.target.value.toUpperCase()})} /></div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Invoice Date *</label><input type="date" className="modern-input" value={resoleData.invoice_date} onChange={e=>setResoleData({...resoleData, invoice_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Resole Cost (Total ₹) *</label><input type="number" className="modern-input" style={{ border: '1px solid #10b981', color: '#10b981', fontWeight: 'bold' }} value={resoleData.cost} onChange={e=>setResoleData({...resoleData, cost: e.target.value})} placeholder="e.g. 3500" /></div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>GST %</label>
                  <select className="modern-input" value={resoleData.gst_percent} onChange={e=>setResoleData({...resoleData, gst_percent: e.target.value})}>
                    <option value="18">18%</option><option value="28">28%</option><option value="0">0% (Exempt)</option>
                  </select>
                </div>
              </div>
            </div>
            
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '15px' }} onClick={handleReceiveResole} disabled={loading}>
              {loading ? '⏳ Processing...' : '✅ Save to Stock & Post Account Entry'}
            </button>
          </div>
        </div>
      )}

      {/* 🏢 MODAL 1A: QUICK ADD VENDOR */}
      {isVendorModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #10b981', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>🏢 Quick Register Vendor</h2>
              <button onClick={() => setIsVendorModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Vendor / Shop Name *</label><input className="modern-input" value={newVendorData.vendor_name} onChange={e=>setNewVendorData({...newVendorData, vendor_name: e.target.value.toUpperCase()})} /></div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Contact Person</label><input className="modern-input" value={newVendorData.contact_person} onChange={e=>setNewVendorData({...newVendorData, contact_person: e.target.value})} /></div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Mobile No</label><input className="modern-input" value={newVendorData.mobile_no} onChange={e=>setNewVendorData({...newVendorData, mobile_no: e.target.value})} /></div>
              </div>

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>GST Number</label><input className="modern-input" value={newVendorData.gst_number} onChange={e=>setNewVendorData({...newVendorData, gst_number: e.target.value.toUpperCase()})} /></div>
              <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Opening Balance (Amount you owe) ₹</label><input type="number" className="modern-input" style={{ borderColor: '#ef4444', color: '#ef4444' }} value={newVendorData.opening_balance} onChange={e=>setNewVendorData({...newVendorData, opening_balance: e.target.value})} /></div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '15px' }} onClick={handleSaveVendor}>✅ Save Vendor & Setup Ledger</button>
          </div>
        </div>
      )}

      {/* 🚛 MODAL 2: FIT TYRE TO VEHICLE WITH 🧠 REAL TRUCK 3D VISUAL MAP */}
      {isFitmentModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '750px', border: '1px solid #f59e0b', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#f59e0b' }}>🚛 Vehicle Tyre Fitment</h2>
              <button onClick={() => { setIsFitmentModalOpen(false); setAvailablePositions([]); setCurrentVehicleFitments([]); }} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '15px' }}>
              
              <div>
                <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>1. Search & Select Vehicle *</label>
                <input 
                  className="modern-input" 
                  style={{ border: '1px solid #38bdf8', fontSize: '16px', fontWeight: 'bold' }} 
                  list="vehicle-fitment-list"
                  placeholder="Type Vehicle No (e.g. 9805)..."
                  value={fitmentData.vehicle_no} 
                  onChange={e => handleVehicleSearch(e.target.value)}
                />
                <datalist id="vehicle-fitment-list">
                  {vehicles.map(v => {
                      const vNo = v.vehicle_no || v.Vehicle_No || v.vehical_no;
                      return <option key={v.id} value={vNo} />
                  })}
                </datalist>
              </div>

              {availablePositions.length > 0 && (
                <div style={{ textAlign: 'center' }}>
                   <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold', display: 'block' }}>2. Click on a Green Slot to Fit Tyre</label>
                   
                   <div className="truck-chassis-container">
                     <div className="truck-cabin">DRIVER CABIN</div>
                     <div className="chassis-rail left"></div>
                     <div className="chassis-rail right"></div>

                     {Array.from(new Set(availablePositions.map(p => p.label.split('-')[0].trim()))).map((axleGroup, aIdx) => {
                         const axleTyres = availablePositions.filter(p => p.label.includes(axleGroup));
                         return (
                            <div key={aIdx} style={{ display: 'flex', alignItems: 'center', gap: '8px', zIndex: 2, position: 'relative' }}>
                                {axleTyres.filter(p => p.id.includes('L') || p.id === 'FL' || p.id === 'STEPNEY').map((pos, pIdx) => {
                                    const fittedTyre = currentVehicleFitments.find(f => f.position === pos.label);
                                    const isOccupied = !!fittedTyre;
                                    const isSelected = fitmentData.position === pos.label;
                                    return (
                                        <div 
                                          key={pIdx}
                                          className={`tyre-dot ${isOccupied ? 'occupied' : isSelected ? 'selected' : 'empty'}`}
                                          title={isOccupied ? `FITTED: ${fittedTyre.tyre_serial}\nDate: ${fittedTyre.fitment_date}\nKM: ${fittedTyre.fitting_km}` : pos.label}
                                          onClick={() => !isOccupied && setFitmentData({...fitmentData, position: pos.label})}
                                        >
                                           {isOccupied && <span className="tyre-text">{fittedTyre.tyre_serial}</span>}
                                        </div>
                                    )
                                })}
                                
                                <div className="axle-line"></div>

                                {axleTyres.filter(p => p.id.includes('R') && p.id !== 'FR' && p.id !== 'STEPNEY').map((pos, pIdx) => {
                                    const fittedTyre = currentVehicleFitments.find(f => f.position === pos.label);
                                    const isOccupied = !!fittedTyre;
                                    const isSelected = fitmentData.position === pos.label;
                                    return (
                                        <div 
                                          key={pIdx}
                                          className={`tyre-dot ${isOccupied ? 'occupied' : isSelected ? 'selected' : 'empty'}`}
                                          title={isOccupied ? `FITTED: ${fittedTyre.tyre_serial}\nDate: ${fittedTyre.fitment_date}\nKM: ${fittedTyre.fitting_km}` : pos.label}
                                          onClick={() => !isOccupied && setFitmentData({...fitmentData, position: pos.label})}
                                        >
                                           {isOccupied && <span className="tyre-text">{fittedTyre.tyre_serial}</span>}
                                        </div>
                                    )
                                })}
                            </div>
                         )
                     })}
                   </div>
                   
                   <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', marginTop: '15px', fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>
                      <div style={{display:'flex', alignItems:'center', gap:'5px'}}><div style={{width:'12px', height:'12px', background:'rgba(16,185,129,0.2)', border:'2px dashed #10b981'}}></div> Empty</div>
                      <div style={{display:'flex', alignItems:'center', gap:'5px'}}><div style={{width:'12px', height:'12px', background:'#ef4444', border: '1px solid #dc2626'}}></div> Fitted</div>
                      <div style={{display:'flex', alignItems:'center', gap:'5px'}}><div style={{width:'12px', height:'12px', background:'#38bdf8'}}></div> Selected</div>
                   </div>

                   {currentVehicleFitments.length > 0 && (
                      <div style={{marginTop: '20px', padding: '12px', background: 'rgba(239,68,68,0.05)', border: '1px dashed #ef4444', borderRadius: '8px', textAlign: 'left'}}>
                         <p style={{margin: '0 0 8px 0', color: '#ef4444', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase'}}>🔴 Currently Fitted Tyres List:</p>
                         <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
                           {currentVehicleFitments.map((f, idx) => {
                               const shortPos = f.position.includes('(') ? f.position.split('(')[1].replace(')', '') : f.position;
                               return (
                                 <span key={idx} style={{fontSize: '11px', color: '#cbd5e1', background: '#0f172a', padding: '5px 8px', borderRadius: '4px', border: '1px solid #334155'}}>
                                   <b>{shortPos}:</b> <span style={{color: '#38bdf8'}}>{f.tyre_serial}</span>
                                 </span>
                               )
                           })}
                         </div>
                      </div>
                   )}

                   {fitmentData.position && (
                       <p style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', margin: '15px 0 0 0', background: 'rgba(16,185,129,0.1)', padding: '10px', borderRadius: '8px' }}>
                           ✅ Selected Target Position: {fitmentData.position}
                       </p>
                   )}
                </div>
              )}

              {availablePositions.length > 0 && (
                <div>
                  <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold' }}>2b. Tyre Position (Dropdown) * — map ki jagah yahan se bhi chun sakte hain</label>
                  <select
                    className="modern-input"
                    style={{ border: '1px solid #f59e0b', fontWeight: 'bold' }}
                    value={fitmentData.position}
                    onChange={e => setFitmentData({ ...fitmentData, position: e.target.value })}
                  >
                    <option value="">-- Select Tyre Position * --</option>
                    {availablePositions.map(p => {
                      const occupied = currentVehicleFitments.find(f => f.position === p.label);
                      return <option key={p.id} value={p.label} disabled={!!occupied}>{p.label}{occupied ? ` — ⛔ FITTED: ${occupied.tyre_serial}` : ''}</option>;
                    })}
                  </select>
                </div>
              )}

              <div>
                <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>3. Enter / Select Tyre No *</label>
                <input 
                  className="modern-input" 
                  style={{ border: '1px solid #10b981' }} 
                  list="tyre-stock-list"
                  placeholder="Type New or Select from Stock..."
                  value={fitmentData.tyre_serial} 
                  onChange={e=>setFitmentData({...fitmentData, tyre_serial: e.target.value.toUpperCase()})}
                />
                <datalist id="tyre-stock-list">
                  {availableTyres.map(t => <option key={t.id} value={t.serial_no}>{t.serial_no} ({t.type})</option>)}
                </datalist>
                <small style={{color: '#94a3b8', fontSize: '10px', marginTop: '5px', display: 'block'}}>
                   💡 Naya number type karne par niche Purchase Cost & Vendor bharna hoga — bina cost ke tyre add nahi hoga (P&L accuracy).
                </small>
              </div>

              {/* 🆕 NEW TYRE => MANDATORY PROCUREMENT (cost 0 wale ghost tyres ab possible nahi) */}
              {isNewTyreSerial && (
                <div style={{ padding: '18px', background: 'rgba(16,185,129,0.05)', border: '1px dashed #10b981', borderRadius: '10px' }}>
                  <p style={{ margin: '0 0 12px 0', color: '#10b981', fontSize: '13px', fontWeight: 'bold' }}>
                    🆕 NEW TYRE DETECTED: <span style={{color:'#fff'}}>{cleanFitSerial}</span> stock me nahi hai — procurement details bharein (P&L ke liye mandatory)
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Purchase Cost (Total ₹) *</label>
                      <input type="number" className="modern-input" style={{ border: '1px solid #10b981', color: '#10b981', fontWeight: 'bold' }} placeholder="e.g. 18500" value={newTyreProc.cost} onChange={e => setNewTyreProc({ ...newTyreProc, cost: e.target.value })} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Vendor / Ledger *</label>
                        <span onClick={() => setIsVendorModalOpen(true)} style={{ fontSize:'11px', color:'#10b981', cursor: 'pointer', fontWeight: 'bold' }}>+ New Vendor</span>
                      </div>
                      <select className="modern-input" style={{ borderColor: '#38bdf8' }} value={newTyreProc.vendor_name} onChange={e => setNewTyreProc({ ...newTyreProc, vendor_name: e.target.value })}>
                        <option value="">-- Choose Vendor * --</option>
                        <option value="CASH PURCHASE">💵 CASH PURCHASE (No Ledger)</option>
                        {vendors.map(v => <option key={v.id} value={v.vendor_name}>{v.vendor_name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Brand / Make</label>
                      <input className="modern-input" placeholder="e.g. MRF" value={newTyreProc.brand} onChange={e => setNewTyreProc({ ...newTyreProc, brand: e.target.value.toUpperCase() })} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      <div>
                        <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Type</label>
                        <select className="modern-input" value={newTyreProc.type} onChange={e => setNewTyreProc({ ...newTyreProc, type: e.target.value })}>
                          <option value="NEW">Brand New</option>
                          <option value="RESOLED">Resoled</option>
                          <option value="SECOND_HAND">Old / 2nd Hand</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>GST %</label>
                        <select className="modern-input" value={newTyreProc.gst_percent} onChange={e => setNewTyreProc({ ...newTyreProc, gst_percent: e.target.value })}>
                          <option value="28">28%</option><option value="18">18%</option><option value="0">0%</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Fitment Date</label><input type="date" className="modern-input" value={fitmentData.fitment_date} onChange={e=>setFitmentData({...fitmentData, fitment_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div>
                    <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold' }}>Vehicle Meter (Fitting KM) *</label>
                    <input type="number" className="modern-input" style={{ border: '1px solid #f59e0b', color: '#f59e0b', fontWeight: 'bold' }} value={fitmentData.fitting_km} onChange={e=>setFitmentData({...fitmentData, fitting_km: e.target.value})} placeholder="e.g. 150000" />
                </div>
              </div>

            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', justifyContent: 'center', fontSize: '15px' }} onClick={handleFitTyre}>
              {loading ? '⏳ Fitting...' : '🔧 Confirm Fitment'}
            </button>
          </div>
        </div>
      )}

      {/* ✂️ MODAL 3: REMOVE TYRE & CALCULATE KM */}
      {isRemoveModalOpen && selectedFitment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #ef4444', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#ef4444' }}>✂️ Remove Tyre</h2>
              <button onClick={() => setIsRemoveModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #38bdf8' }}>
              <p style={{ margin: '0 0 8px 0', color: '#94a3b8', fontSize: '13px' }}>Removing Tyre <b style={{color:'#fff'}}>{selectedFitment.tyre_serial}</b> from <b style={{color:'#fff'}}>{selectedFitment.vehicle_no || selectedFitment.vehical_no}</b> <span style={{color:'#f59e0b'}}>({selectedFitment.position})</span></p>
              <p style={{ margin: 0, color: '#10b981', fontSize: '14px', fontWeight: 'bold' }}>Fitted at: {parseFloat(selectedFitment.fitting_km||0).toLocaleString('en-IN')} KM</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Current Vehicle Meter KM (Removal KM) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #ef4444', fontSize: '20px', fontWeight: '900', color: '#ef4444' }} value={removeData.removal_km} onChange={e=>setRemoveData({...removeData, removal_km: e.target.value})} placeholder="e.g. 210000" />
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Reason for Removal</label>
                  <select className="modern-input" value={removeData.removal_reason} onChange={e=>setRemoveData({...removeData, removal_reason: e.target.value})}>
                    <option value="SEND FOR RESOLE">♻️ Send for Resoling</option>
                    <option value="PUNCTURE/REPAIR">🛠️ Puncture / Repair</option>
                    <option value="SCRAP/AUCTION">🗑️ Damaged / Scrap</option>
                    <option value="BURST">🔥 Tyre Burst (Scrap + P&L Expense)</option>
                  </select>
                </div>

                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Removal Date</label><input type="date" className="modern-input" value={removeData.removal_date} onChange={e=>setRemoveData({...removeData, removal_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              </div>
            </div>
            
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #ef4444, #b91c1c)', justifyContent: 'center', fontSize: '15px' }} onClick={handleRemoveTyre}>
              ✂️ Confirm Removal & Calc KM Yield
            </button>
          </div>
        </div>
      )}

    </div>
  );
}