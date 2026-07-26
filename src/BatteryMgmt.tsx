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

// 🔋 BATTERY FITMENT POSITIONS — commercial trucks mostly run dual 12V in the
// battery box, plus optional main/aux banks. Fixed, closed list (no axle math).
const BATTERY_POSITIONS = [
  { id: 'BOX_LEFT', label: 'Box - Left' },
  { id: 'BOX_RIGHT', label: 'Box - Right' },
  { id: 'MAIN', label: 'Main' },
  { id: 'AUX', label: 'Aux' },
];

// 🛡️ WARRANTY ENGINE — purchase_date + warranty_months se live status nikaalta
// hai. UI me 🟢 Active - N Months left / 🔴 Expired dikhta hai.
const getWarrantyStatus = (purchaseDate: any, warrantyMonths: any) => {
  const months = parseInt(warrantyMonths);
  if (!purchaseDate || !months) return { active: false, label: '⚪ N/A', color: '#94a3b8', monthsLeft: 0, expiryStr: '-' };
  const start = new Date(purchaseDate);
  if (isNaN(start.getTime())) return { active: false, label: '⚪ N/A', color: '#94a3b8', monthsLeft: 0, expiryStr: '-' };

  const expiry = new Date(start.getTime());
  expiry.setMonth(expiry.getMonth() + months);
  const now = new Date();
  const msLeft = expiry.getTime() - now.getTime();
  const expiryStr = expiry.toISOString().split('T')[0];

  if (msLeft <= 0) return { active: false, label: '🔴 Expired', color: '#ef4444', monthsLeft: 0, expiryStr };

  const dayMs = 1000 * 60 * 60 * 24;
  const daysLeft = Math.ceil(msLeft / dayMs);
  const monthsLeft = Math.floor(daysLeft / 30.44);
  const text = monthsLeft >= 1 ? `${monthsLeft} Month${monthsLeft > 1 ? 's' : ''} left` : `${daysLeft} Day${daysLeft > 1 ? 's' : ''} left`;
  // Amber warning window when <2 months of warranty remain.
  const color = monthsLeft < 2 ? '#f59e0b' : '#10b981';
  const icon = monthsLeft < 2 ? '🟡' : '🟢';
  return { active: true, label: `${icon} Active - ${text}`, color, monthsLeft, daysLeft, expiryStr };
};

// 💰 P&L LINKAGE: scrapped/dead battery ka poora cost ledger me Dr hota hai —
// Company P&L me Direct Expenses ke andar "Batteries & Maintenance" line ban
// kar dikhta hai (FinancialReports classifier). Warranty-claimed batteries me
// cost recover ho jaata hai isliye unka expense post NAHI hota.
const BATTERY_EXP_LEDGER_NAME = 'Battery Consumption Expenses';
const BATTERY_EXP_GROUP = 'Direct Expenses (Batteries & Maintenance)';
const ensureBatteryExpenseLedger = async () => {
  const snap = await getDocs(query(collection(db, 'LEDGERS'), where('ledger_name', '==', BATTERY_EXP_LEDGER_NAME)));
  if (!snap.empty) return snap.docs[0].id;
  const ref = await addDoc(collection(db, 'LEDGERS'), {
    name: BATTERY_EXP_LEDGER_NAME, ledger_name: BATTERY_EXP_LEDGER_NAME,
    group: BATTERY_EXP_GROUP, group_head: BATTERY_EXP_GROUP,
    op_balance: 0, company: 'ALL', branch: 'ALL', dr_cr: 'Dr (Debit)',
    creation_type: 'AUTO_SYSTEM', linked_module: 'BATTERY_EXPENSE', created_at: serverTimestamp(),
  });
  return ref.id;
};

export default function BatteryMgmt() {
  const [activeTab, setActiveTab] = useState('FITMENTS');
  const [batteries, setBatteries] = useState<any[]>([]);
  const [fitments, setFitments] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // MODALS
  const [isPurchaseModalOpen, setIsPurchaseModalOpen] = useState(false);
  const [isFitmentModalOpen, setIsFitmentModalOpen] = useState(false);
  const [isRemoveModalOpen, setIsRemoveModalOpen] = useState(false);
  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [isDispatchClaimModalOpen, setIsDispatchClaimModalOpen] = useState(false);
  const [isReceiveClaimModalOpen, setIsReceiveClaimModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  const [selectedClaimBattery, setSelectedClaimBattery] = useState<any>(null);
  const [selectedFitment, setSelectedFitment] = useState<any>(null);
  const [editData, setEditData] = useState<any>(null);

  const [currentVehicleFitments, setCurrentVehicleFitments] = useState<any[]>([]);
  const [historySearch, setHistorySearch] = useState('');

  const [purchaseData, setPurchaseData] = useState({ invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], vendor_name: '', invoice_file_url: '' });
  const [currentBattery, setCurrentBattery] = useState({ make: 'EXIDE', serial_no: '', capacity_ah: '150', warranty_months: '24', gst_percent: '28', inv_amount: '' });
  const [batteryList, setBatteryList] = useState<any[]>([]);
  const [dispatchData, setDispatchData] = useState({ claim_company: '', dispatch_date: new Date().toISOString().split('T')[0], claim_ref: '' });
  const [currentDispatchSerial, setCurrentDispatchSerial] = useState('');
  const [dispatchSerialList, setDispatchSerialList] = useState<string[]>([]);
  const [claimData, setClaimData] = useState({ outcome: 'REPAIRED', resolution_date: new Date().toISOString().split('T')[0], replacement_serial: '', remarks: '' });
  const [fitmentData, setFitmentData] = useState({ vehicle_no: '', battery_serial: '', position: '', fitting_km: '', fitment_date: new Date().toISOString().split('T')[0] });
  // 🆕 Naye (stock me na milne wale) battery ki procurement details — bina cost/vendor ke auto-add BLOCKED.
  const [newBatteryProc, setNewBatteryProc] = useState({ cost: '', vendor_name: '', make: 'EXIDE', capacity_ah: '150', warranty_months: '24', purchase_date: new Date().toISOString().split('T')[0], gst_percent: '28' });
  const [removeData, setRemoveData] = useState({ removal_km: '', removal_reason: 'WARRANTY CLAIM', removal_date: new Date().toISOString().split('T')[0] });
  const [newVendorData, setNewVendorData] = useState({ vendor_name: '', vendor_category: 'Battery Shop / Dealer', contact_person: '', mobile_no: '', gst_number: '', opening_balance: '0' });

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

      const bSnap = await getDocs(collection(db, "BATTERY_MASTER")).catch(()=>({docs:[]}));
      // 🛡️ CRASH-PROOF SORTING
      const fetchedBatteries = bSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => getSafeTime(b.createdAt) - getSafeTime(a.createdAt));
      setBatteries(fetchedBatteries);

      const fSnap = await getDocs(collection(db, "BATTERY_FITMENTS")).catch(()=>({docs:[]}));
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
    const headerHTML = `<html><head><title>Battery Report</title><style>body { font-family: Arial, sans-serif; padding: 20px; color: #333; } h2 { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; text-transform: uppercase; } table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; } th, td { border: 1px solid #ddd; padding: 8px; text-align: left; } th { background-color: #f4f4f4; font-weight: bold; } .date-text { text-align: right; font-size: 10px; color: #666; margin-bottom: 20px;} @media print { body { -webkit-print-color-adjust: exact; } }</style></head><body>`;
    if (activeTab === 'INVENTORY') {
        title = "Battery Inventory (Stock) Report";
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Serial No</th><th>Make</th><th>Capacity</th><th>Cost (Rs)</th><th>Inv No / Vendor</th><th>Warranty</th><th>Status</th></tr></thead><tbody>${batteries.map(b => { const w = getWarrantyStatus(b.purchase_date, b.warranty_months); return `<tr><td><b>${b.serial_no || '-'}</b></td><td>${b.make || '-'}</td><td>${b.capacity_ah || '-'}AH</td><td>${parseFloat(b.cost||0).toFixed(2)}</td><td>${b.invoice_no||'-'} <br/> ${b.vendor||'-'}</td><td>${w.label.replace(/[🟢🟡🔴⚪]/g,'').trim()}</td><td>${b.status||'-'}</td></tr>`; }).join('')}</tbody></table>`;
    } else if (activeTab === 'FITMENTS') {
        title = "Live Vehicle Battery Fitments Report";
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Vehicle No</th><th>Position</th><th>Battery Serial No</th><th>Make & AH</th><th>Fitment Date</th><th>Fitting KM</th><th>Warranty</th></tr></thead><tbody>${activeFitments.map(f => { const w = getWarrantyStatus(f.purchase_date, f.warranty_months); return `<tr><td><b>${f.vehicle_no || '-'}</b></td><td>${f.position || '-'}</td><td>${f.battery_serial || '-'}</td><td>${f.make||'-'} ${f.capacity_ah||''}AH</td><td>${f.fitment_date || '-'}</td><td>${f.fitting_km || 0}</td><td>${w.label.replace(/[🟢🟡🔴⚪]/g,'').trim()}</td></tr>`; }).join('')}</tbody></table>`;
    } else if (activeTab === 'HISTORY') {
        title = "Battery Removal & Lifecycle History";
        const dataToPrint = historySearch ? fitmentHistory.filter(f => String(f.battery_serial||'').toLowerCase().includes(historySearch.toLowerCase()) || String(f.vehicle_no || '').toLowerCase().includes(historySearch.toLowerCase())) : fitmentHistory;
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Date</th><th>Vehicle</th><th>Serial No</th><th>Position</th><th>Fitting KM</th><th>Removal KM</th><th>KM Run</th><th>Reason</th></tr></thead><tbody>${dataToPrint.map(f => `<tr><td>${f.removal_date||'-'}</td><td><b>${f.vehicle_no || '-'}</b></td><td>${f.battery_serial||'-'}</td><td>${f.position||'-'}</td><td>${f.fitting_km||0}</td><td>${f.removal_km||0}</td><td><b>${f.km_yield||0}</b></td><td>${f.removal_reason||'-'}</td></tr>`).join('')}</tbody></table>`;
    } else if (activeTab === 'WARRANTY') {
        title = "Warranty Claims & Scrap Register";
        tableHTML = `<h2>${title}</h2><div class="date-text">Printed on: ${new Date().toLocaleString('en-GB')}</div><table><thead><tr><th>Serial No</th><th>Make & AH</th><th>Claim Ref</th><th>Claim Company</th><th>Sent Date</th><th>Status</th></tr></thead><tbody>${claimBatteries.map(b => `<tr><td><b>${b.serial_no||'-'}</b></td><td>${b.make||'-'} ${b.capacity_ah||''}AH</td><td>${b.claim_ref||'-'}</td><td>${b.claim_company||'-'}</td><td>${b.claim_date||'-'}</td><td>${b.status||'-'}</td></tr>`).join('')}</tbody></table>`;
    }
    const footerHTML = `<script>window.onload = function() { setTimeout(function() { window.print(); }, 500); }</script></body></html>`;
    printWindow.document.write(headerHTML + tableHTML + footerHTML); printWindow.document.close();
  };

  const handleExportCSV = () => {
    let csvContent = ""; let fileName = "";
    if (activeTab === 'INVENTORY') {
        fileName = "Battery_Inventory_Report.csv"; csvContent = "Serial No,Make,Capacity (AH),Cost (Rs),Invoice No,Vendor,Warranty Months,Warranty Status,Status\n";
        batteries.forEach(b => { const w = getWarrantyStatus(b.purchase_date, b.warranty_months); csvContent += `${b.serial_no||'-'},${b.make||'-'},${b.capacity_ah||'-'},${b.cost||0},${b.invoice_no||'-'},${b.vendor||'-'},${b.warranty_months||'-'},${w.label.replace(/[🟢🟡🔴⚪]/g,'').trim()},${b.status||'-'}\n`; });
    } else if (activeTab === 'FITMENTS') {
        fileName = "Live_Battery_Fitments_Report.csv"; csvContent = "Vehicle No,Position,Battery Serial No,Make,Capacity (AH),Fitment Date,Fitting KM,Warranty Status\n";
        activeFitments.forEach(f => { const w = getWarrantyStatus(f.purchase_date, f.warranty_months); csvContent += `${f.vehicle_no||'-'},${f.position||'-'},${f.battery_serial||'-'},${f.make||'-'},${f.capacity_ah||'-'},${f.fitment_date||'-'},${f.fitting_km||0},${w.label.replace(/[🟢🟡🔴⚪]/g,'').trim()}\n`; });
    } else if (activeTab === 'HISTORY') {
        fileName = "Battery_Removal_History_Report.csv"; csvContent = "Date,Vehicle,Serial No,Position,Fitting KM,Removal KM,KM Run,Reason\n";
        const dataToExport = historySearch ? fitmentHistory.filter(f => String(f.battery_serial||'').toLowerCase().includes(historySearch.toLowerCase()) || String(f.vehicle_no || '').toLowerCase().includes(historySearch.toLowerCase())) : fitmentHistory;
        dataToExport.forEach(f => { csvContent += `${f.removal_date||'-'},${f.vehicle_no||'-'},${f.battery_serial||'-'},${f.position||'-'},${f.fitting_km||0},${f.removal_km||0},${f.km_yield||0},${f.removal_reason||'-'}\n`; });
    } else if (activeTab === 'WARRANTY') {
        fileName = "Warranty_Claims_Scrap_Report.csv"; csvContent = "Serial No,Make,Capacity (AH),Claim Ref,Claim Company,Sent Date,Status\n";
        claimBatteries.forEach(b => { csvContent += `${b.serial_no||'-'},${b.make||'-'},${b.capacity_ah||'-'},${b.claim_ref||'-'},${b.claim_company||'-'},${b.claim_date||'-'},${b.status||'-'}\n`; });
    }
    if(!csvContent) return alert("Nothing to export.");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a");
    link.setAttribute("href", URL.createObjectURL(blob)); link.setAttribute("download", fileName); document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const handleEditSave = async () => {
      if(!editData || !editData.serial_no) return;
      setLoading(true);
      try {
          await updateDoc(doc(db, "BATTERY_MASTER", editData.id), {
            make: editData.make, capacity_ah: editData.capacity_ah, cost: parseFloat(editData.cost) || 0,
            warranty_months: editData.warranty_months, purchase_date: editData.purchase_date, status: editData.status, updatedAt: serverTimestamp()
          });
          alert("✅ Battery Details Updated Successfully!"); setIsEditModalOpen(false); fetchData();
      } catch (e) { alert("❌ Error updating battery."); }
      setLoading(false);
  };

  const handleDelete = async (id: string, serial: string) => {
    if (window.confirm(`⚠️ Are you sure you want to permanently delete Battery Serial No: ${serial}?`)) {
      try { await deleteDoc(doc(db, "BATTERY_MASTER", id)); fetchData(); } catch (error) { alert("❌ Error deleting battery."); }
    }
  };

  const handleSaveVendor = async () => {
    if (!newVendorData.vendor_name) return alert("⚠️ Vendor Name is mandatory!");
    setLoading(true);
    try {
       const docRef = await addDoc(collection(db, "VENDORS"), { ...newVendorData, createdAt: serverTimestamp() });
       await addDoc(collection(db, "LEDGERS"), { ledger_name: newVendorData.vendor_name, group_head: "Sundry Creditors", opening_balance: parseFloat(newVendorData.opening_balance || '0'), current_balance: parseFloat(newVendorData.opening_balance || '0'), creation_type: "AUTO_SYSTEM", linked_module: "VENDOR", linked_id: docRef.id, created_at: serverTimestamp() });
       alert("✅ Vendor & Ledger Created Successfully!");
       if (isPurchaseModalOpen) setPurchaseData({ ...purchaseData, vendor_name: newVendorData.vendor_name });
       if (isFitmentModalOpen) setNewBatteryProc({ ...newBatteryProc, vendor_name: newVendorData.vendor_name });
       setIsVendorModalOpen(false); setNewVendorData({ vendor_name: '', vendor_category: 'Battery Shop / Dealer', contact_person: '', mobile_no: '', gst_number: '', opening_balance: '0' }); fetchData();
    } catch(e) { alert("❌ Error adding vendor"); }
    setLoading(false);
  };

  const handleScanInvoice = async () => {
    if (!invoiceFile) return alert("⚠️ Please select an Invoice PDF or Image first!");
    setScanning(true); setUploadingDoc(true);
    try {
      // 🤖 100% LOCAL extraction via Gemma 4 vision (no cloud).
      const prompt = `Extract from this battery purchase invoice and reply with ONLY JSON:
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

  const handleAddBatteryToGrid = () => {
      if(!currentBattery.serial_no.trim()) return alert("⚠️ Battery Serial Number is required!");
      if(!currentBattery.inv_amount || parseFloat(currentBattery.inv_amount) <= 0) return alert("⚠️ Valid Invoice Amount is required!");
      const cleanSerial = currentBattery.serial_no.trim().toUpperCase();
      if(batteryList.find(b => b.serial_no === cleanSerial)) return alert("⚠️ This Serial Number is already added in the list below!");
      if(batteries.find(b => b.serial_no === cleanSerial)) return alert("❌ This Serial Number already exists in the Master Database!");

      const invAmt = parseFloat(currentBattery.inv_amount); const gstPct = parseFloat(currentBattery.gst_percent);
      const baseAmt = invAmt / (1 + (gstPct/100)); const gstAmt = invAmt - baseAmt;

      setBatteryList([...batteryList, { ...currentBattery, serial_no: cleanSerial, make: currentBattery.make.toUpperCase(), gst_amount: gstAmt.toFixed(2), base_amount: baseAmt.toFixed(2) }]);
      setCurrentBattery({ ...currentBattery, serial_no: '', inv_amount: '' });
  };

  const handleRemoveBatteryFromGrid = (index: number) => { setBatteryList(batteryList.filter((_, i) => i !== index)); };

  const handleSavePurchase = async () => {
    if (batteryList.length === 0) return alert("⚠️ Please add at least one battery to the list.");
    if (!purchaseData.vendor_name) return alert("⚠️ Vendor Name is required!");
    setLoading(true);
    try {
      // ⚛️ ATOMIC: saare batteries + Cash/Bank entry ek hi batch.commit me — aadha invoice kabhi save nahi hota.
      const batch = writeBatch(db);
      let totalInvoiceValue = 0;
      for (const bat of batteryList) {
          totalInvoiceValue += parseFloat(bat.inv_amount);
          batch.set(doc(collection(db, "BATTERY_MASTER")), {
              serial_no: bat.serial_no, make: bat.make, capacity_ah: bat.capacity_ah, warranty_months: bat.warranty_months,
              cost: parseFloat(bat.inv_amount), base_cost: parseFloat(bat.base_amount), gst_amount: parseFloat(bat.gst_amount), gst_percent: bat.gst_percent,
              purchase_date: purchaseData.invoice_date, invoice_no: purchaseData.invoice_no, vendor: purchaseData.vendor_name,
              invoice_file_url: purchaseData.invoice_file_url, status: 'IN STOCK', total_km_run: 0, createdAt: serverTimestamp()
          });
      }
      // 🏦 Udhaar => vendor khata Purchase (IN); cash => Payment (OUT).
      const isCashPur = purchaseData.vendor_name === 'CASH PURCHASE';
      batch.set(doc(collection(db, "BANK_TRANSACTIONS")), {
          date: purchaseData.invoice_date, type: isCashPur ? 'Payment (OUT)' : 'Purchase (IN)', amount: totalInvoiceValue,
          party_name: isCashPur ? 'CASH' : purchaseData.vendor_name, ref_no: purchaseData.invoice_no,
          particulars: `Purchase of ${batteryList.length} Batteries (Make: ${batteryList[0]?.make}) | Inv: ${purchaseData.invoice_no}`,
          company: 'PRASAD TRANSPORT', createdAt: serverTimestamp()
      });
      await batch.commit();
      alert(`✅ Successfully Saved Invoice & Added ${batteryList.length} Batteries to Stock!\n(Total Amount: ₹${totalInvoiceValue.toLocaleString('en-IN')})`);
      setIsPurchaseModalOpen(false); setPurchaseData({ invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], vendor_name: '', invoice_file_url: '' });
      setBatteryList([]); setInvoiceFile(null); fetchData();
    } catch (e) { alert("❌ Error saving purchase data."); console.error(e); }
    setLoading(false);
  };

  const handleVehicleSearch = (vNo: string) => {
      const cleanVNo = String(vNo || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
      const vObj = vehicles.find(v => String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVNo);

      const currentKm = vObj ? (vObj.current_km || vObj.Current_KM || vObj.meter_reading || vObj.km_reading || '') : '';
      setFitmentData({...fitmentData, vehicle_no: vNo, position: '', fitting_km: currentKm});
      const fittedHere = fitments.filter(f => f.status === 'FITTED' && String(f.vehicle_no || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVNo);
      setCurrentVehicleFitments(cleanVNo ? fittedHere : []);
  };

  const handleFitBattery = async () => {
    if (!fitmentData.vehicle_no || !fitmentData.battery_serial || !fitmentData.fitting_km) return alert("⚠️ Fill all fitment details (Vehicle, Battery Serial, Fitting KM)!");
    if (!fitmentData.position) return alert("⚠️ Battery Position chunna zaroori hai — Position dropdown se select karein!");
    const alreadyFitted = currentVehicleFitments.find(f => f.position === fitmentData.position);
    if(alreadyFitted) return alert(`❌ Error: Battery (${alreadyFitted.battery_serial}) is already fitted on [${fitmentData.position}]! Please remove it first.`);
    const cleanSerial = fitmentData.battery_serial.toUpperCase().trim();
    const bat = batteries.find(b => String(b.serial_no || '').toUpperCase() === cleanSerial);
    // 🛡️ PROCUREMENT GUARD: naya battery bina Purchase Cost + Vendor ke inventory
    // me NAHI ghusega — cost 0 wale ghost assets P&L ko galat karte the.
    if (!bat) {
      if (!parseFloat(newBatteryProc.cost) || parseFloat(newBatteryProc.cost) <= 0) return alert(`🆕 NEW BATTERY DETECTED (${cleanSerial}):\n\n⚠️ Purchase Cost (₹) bharna zaroori hai — bina cost ke battery accounting/P&L me nahi aa sakta!`);
      if (!newBatteryProc.vendor_name) return alert(`🆕 NEW BATTERY DETECTED (${cleanSerial}):\n\n⚠️ Vendor/Ledger chunna zaroori hai (ya 💵 CASH PURCHASE select karein)!`);
    } else if (bat.status === 'FITTED') {
      return alert(`❌ Error: Battery ${cleanSerial} is already fitted on another vehicle!`);
    } else if (bat.status === 'SCRAP') {
      return alert(`❌ Error: Battery ${cleanSerial} is SCRAPPED — scrap battery dobara fit nahi ho sakta!`);
    } else if (bat.status === 'WARRANTY CLAIM') {
      return alert(`❌ Error: Battery ${cleanSerial} warranty claim par gaya hua hai — pehle Warranty tab se receive karein!`);
    }
    try {
      setLoading(true);
      // ⚛️ ATOMIC LIFECYCLE WRITE: battery status flip + fitment record (+ naye
      // battery ki purchase accounting) — sab ek hi batch.commit me.
      const batch = writeBatch(db);
      const fitKm = parseFloat(fitmentData.fitting_km) || 0;
      // Warranty display ke liye master fields fitment me denormalize karte hain.
      let make = '', capacity_ah = '', warranty_months = '', purchase_date = '', batteryId = '';
      if (!bat) {
          const cost = parseFloat(newBatteryProc.cost);
          const gstPct = parseFloat(newBatteryProc.gst_percent) || 0;
          const baseAmt = cost / (1 + (gstPct / 100));
          const autoRef = `AUTO-FIT-${cleanSerial}`;
          const batRef = doc(collection(db, "BATTERY_MASTER"));
          batteryId = batRef.id;
          make = (newBatteryProc.make || 'UNKNOWN').toUpperCase(); capacity_ah = newBatteryProc.capacity_ah;
          warranty_months = newBatteryProc.warranty_months; purchase_date = newBatteryProc.purchase_date;
          batch.set(batRef, {
              serial_no: cleanSerial, make, capacity_ah, warranty_months, purchase_date,
              cost, base_cost: Math.round(baseAmt * 100) / 100, gst_amount: Math.round((cost - baseAmt) * 100) / 100, gst_percent: newBatteryProc.gst_percent,
              vendor: newBatteryProc.vendor_name, invoice_no: autoRef,
              status: 'FITTED', total_km_run: 0, createdAt: serverTimestamp(),
          });
          // 🏦 Cash & Bank Book: cash purchase => Payment (OUT); udhaar => Purchase (IN).
          const isCash = newBatteryProc.vendor_name === 'CASH PURCHASE';
          batch.set(doc(collection(db, "BANK_TRANSACTIONS")), {
              date: fitmentData.fitment_date, type: isCash ? 'Payment (OUT)' : 'Purchase (IN)', amount: cost,
              party_name: isCash ? 'CASH' : newBatteryProc.vendor_name, ref_no: autoRef,
              particulars: `Battery ${cleanSerial} purchase (auto-added during fitment on ${fitmentData.vehicle_no})`,
              company: 'PRASAD TRANSPORT', createdAt: serverTimestamp(),
          });
      } else {
          batteryId = bat.id; make = bat.make; capacity_ah = bat.capacity_ah;
          warranty_months = bat.warranty_months; purchase_date = bat.purchase_date;
          batch.update(doc(db, "BATTERY_MASTER", bat.id), { status: 'FITTED' });
      }
      batch.set(doc(collection(db, "BATTERY_FITMENTS")), {
          vehicle_no: fitmentData.vehicle_no, vehicle_id: fitmentData.vehicle_no, battery_id: batteryId, battery_serial: cleanSerial,
          position: fitmentData.position, fitting_km: fitKm, fitment_km: fitKm, fitment_date: fitmentData.fitment_date,
          make, capacity_ah, warranty_months, purchase_date,
          status: 'FITTED', is_active_fitment: true, createdAt: serverTimestamp()
      });
      await batch.commit();
      alert(!bat
        ? `✅ Battery Fitted!\n\n🆕 New battery ${cleanSerial} inventory me add hua @ ₹${parseFloat(newBatteryProc.cost).toLocaleString('en-IN')}\n🏦 Accounting entry posted (${newBatteryProc.vendor_name}).`
        : "✅ Battery Fitted Successfully!");
      setIsFitmentModalOpen(false); setFitmentData({ vehicle_no: '', battery_serial: '', position: '', fitting_km: '', fitment_date: new Date().toISOString().split('T')[0] });
      setNewBatteryProc({ cost: '', vendor_name: '', make: 'EXIDE', capacity_ah: '150', warranty_months: '24', purchase_date: new Date().toISOString().split('T')[0], gst_percent: '28' });
      setCurrentVehicleFitments([]); fetchData();
    } catch (e) { console.error(e); alert("❌ Error fitting battery."); setLoading(false); }
  };

  const handleRemoveBattery = async () => {
    if (!removeData.removal_km) return alert("⚠️ Enter Removal KM!");
    const fittingKm = parseFloat(selectedFitment.fitting_km || 0); const removalKm = parseFloat(removeData.removal_km || 0);
    if (removalKm < fittingKm) return alert(`❌ Invalid Entry: Removal KM (${removalKm}) cannot be less than Fitting KM (${fittingKm})!`);
    const kmRunThisTime = removalKm - fittingKm;
    const bat = batteries.find(b => b.serial_no === selectedFitment.battery_serial);
    if (!bat) return alert("❌ Battery Master record missing!");
    try {
      setLoading(true);
      const newTotalKm = (parseFloat(bat.total_km_run) || 0) + kmRunThisTime;
      // Dead/Scrap => battery zindagi khatam, cost P&L me. Warranty Claim => cost
      // recover hoga isliye expense NAHI. Maintenance => wapas stock.
      const isScrap = removeData.removal_reason === 'DEAD/SCRAP';
      const isClaim = removeData.removal_reason === 'WARRANTY CLAIM';
      const newStatus = isScrap ? 'SCRAP' : isClaim ? 'WARRANTY CLAIM' : 'IN STOCK';

      // 💸 Scrap battery => poora cost Direct Expense. Warranty par gaya to nahi.
      const consumedCost = parseFloat(bat.cost || 0);
      const expLedgerId = (isScrap && consumedCost > 0) ? await ensureBatteryExpenseLedger() : null;

      // ⚛️ ATOMIC: fitment close + battery status + expense entry — ek hi batch.commit.
      const batch = writeBatch(db);
      batch.update(doc(db, "BATTERY_FITMENTS", selectedFitment.id), { ...removeData, removal_km: removalKm, status: 'REMOVED', is_active_fitment: false, km_yield: kmRunThisTime });
      batch.update(doc(db, "BATTERY_MASTER", bat.id), {
        status: newStatus, total_km_run: newTotalKm,
        ...(isScrap ? { scrapped_on: removeData.removal_date, scrap_reason: removeData.removal_reason } : {}),
        ...(isClaim ? { claim_date: removeData.removal_date, claim_ref: '', claim_company: '' } : {})
      });
      if (expLedgerId) {
          const vehNo = selectedFitment.vehicle_no || '';
          const cleanVeh = String(vehNo).replace(/[^A-Z0-9]/ig, '').toUpperCase();
          const vObj = vehicles.find(v => String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVeh);
          batch.set(doc(collection(db, "LEDGER_ENTRIES")), {
              ledgerId: expLedgerId, date: removeData.removal_date,
              particulars: `Battery ${bat.serial_no} scrapped (${removeData.removal_reason}) — Vehicle ${vehNo} | Total Life: ${newTotalKm.toLocaleString('en-IN')} KM`,
              dr_cr: 'Dr (Debit)', amount: consumedCost,
              company: vObj?.company_name || vObj?.Company_Name || 'ALL', branch: vObj?.branch_name || vObj?.branch || 'ALL',
              source: 'AUTO_BATTERY_SCRAP', linked_battery_id: bat.id, created_at: serverTimestamp(),
          });
      }
      await batch.commit();

      alert(`✅ Battery Removed Successfully!\n\n📏 KM Run this fitment: ${kmRunThisTime.toLocaleString('en-IN')} KM${isClaim ? '\n🛡️ Battery moved to WARRANTY CLAIMS tab.' : ''}${expLedgerId ? `\n💸 ₹${consumedCost.toLocaleString('en-IN')} posted to P&L — Direct Expenses ➜ ${BATTERY_EXP_LEDGER_NAME}.` : ''}`);
      setIsRemoveModalOpen(false); setRemoveData({ removal_km: '', removal_reason: 'WARRANTY CLAIM', removal_date: new Date().toISOString().split('T')[0] });
      setSelectedFitment(null); fetchData();
    } catch (e) { console.error(e); alert("❌ Error removing battery."); setLoading(false); }
  };

  const handleAddDispatchSerial = () => {
    if(!currentDispatchSerial.trim()) return;
    const newSerial = currentDispatchSerial.trim().toUpperCase();
    if(dispatchSerialList.includes(newSerial)) return alert("⚠️ Serial Number already added to claim list!");
    const exists = batteries.find(b => b.serial_no === newSerial);
    if (!exists) return alert(`❌ Battery ${newSerial} not found in inventory!`);
    if (exists.status === 'FITTED') return alert(`❌ Battery ${newSerial} is currently FITTED on a vehicle! Remove it first.`);
    if (exists.status === 'WARRANTY CLAIM') return alert(`❌ Battery ${newSerial} is already on a warranty claim!`);
    setDispatchSerialList([...dispatchSerialList, newSerial]); setCurrentDispatchSerial('');
  };

  const handleSaveDispatch = async () => {
      if (dispatchSerialList.length === 0) return alert("⚠️ Please add at least one battery to the claim.");
      if (!dispatchData.claim_company || !dispatchData.claim_ref) return alert("⚠️ Claim Company and Claim Ref No are required!");
      setLoading(true);
      try {
          for (const sno of dispatchSerialList) {
              const bat = batteries.find(b => b.serial_no === sno);
              if (bat) { await updateDoc(doc(db, "BATTERY_MASTER", bat.id), { status: 'WARRANTY CLAIM', claim_company: dispatchData.claim_company, claim_date: dispatchData.dispatch_date, claim_ref: dispatchData.claim_ref }); }
          }
          alert(`✅ Warranty Claim Created! ${dispatchSerialList.length} Batteries sent to ${dispatchData.claim_company}.`);
          setIsDispatchClaimModalOpen(false); setDispatchData({ claim_company: '', dispatch_date: new Date().toISOString().split('T')[0], claim_ref: '' });
          setDispatchSerialList([]); fetchData();
      } catch (e) { alert("❌ Error dispatching batteries."); }
      setLoading(false);
  };

  const handleResolveClaim = async () => {
      if (!selectedClaimBattery) return;
      setLoading(true);
      try {
          const batch = writeBatch(db);
          if (claimData.outcome === 'REJECTED') {
              // ❌ Company ne claim reject kiya => battery dead => cost P&L me jaati hai.
              const consumedCost = parseFloat(selectedClaimBattery.cost || 0);
              batch.update(doc(db, "BATTERY_MASTER", selectedClaimBattery.id), { status: 'SCRAP', scrapped_on: claimData.resolution_date, scrap_reason: 'WARRANTY REJECTED', claim_outcome: 'REJECTED', claim_remarks: claimData.remarks });
              if (consumedCost > 0) {
                  const expLedgerId = await ensureBatteryExpenseLedger();
                  batch.set(doc(collection(db, "LEDGER_ENTRIES")), {
                      ledgerId: expLedgerId, date: claimData.resolution_date,
                      particulars: `Battery ${selectedClaimBattery.serial_no} — warranty claim REJECTED, scrapped`,
                      dr_cr: 'Dr (Debit)', amount: consumedCost, company: 'ALL', branch: 'ALL',
                      source: 'AUTO_BATTERY_SCRAP', linked_battery_id: selectedClaimBattery.id, created_at: serverTimestamp(),
                  });
              }
          } else if (claimData.outcome === 'REPLACED' && claimData.replacement_serial.trim()) {
              // 🔄 Company ne naya battery diya => purana SCRAP, naya serial IN STOCK
              //     (same warranty terms; cost 0 kyunki free replacement hai).
              const newSerial = claimData.replacement_serial.trim().toUpperCase();
              batch.update(doc(db, "BATTERY_MASTER", selectedClaimBattery.id), { status: 'SCRAP', scrapped_on: claimData.resolution_date, scrap_reason: 'REPLACED UNDER WARRANTY', claim_outcome: 'REPLACED', claim_remarks: claimData.remarks });
              batch.set(doc(collection(db, "BATTERY_MASTER")), {
                  serial_no: newSerial, make: selectedClaimBattery.make, capacity_ah: selectedClaimBattery.capacity_ah,
                  warranty_months: selectedClaimBattery.warranty_months, purchase_date: claimData.resolution_date,
                  cost: 0, gst_percent: '0', vendor: selectedClaimBattery.claim_company || 'WARRANTY REPLACEMENT',
                  invoice_no: `WARR-REPL-${selectedClaimBattery.serial_no}`, status: 'IN STOCK', total_km_run: 0,
                  replacement_for: selectedClaimBattery.serial_no, createdAt: serverTimestamp(),
              });
          } else {
              // 🔧 Repaired / same battery wapas => seedha IN STOCK.
              batch.update(doc(db, "BATTERY_MASTER", selectedClaimBattery.id), { status: 'IN STOCK', claim_outcome: 'REPAIRED', claim_remarks: claimData.remarks, claim_resolved_on: claimData.resolution_date });
          }
          await batch.commit();
          alert("✅ Warranty Claim Resolved & Stock Updated!");
          setIsReceiveClaimModalOpen(false); setSelectedClaimBattery(null);
          setClaimData({ outcome: 'REPAIRED', resolution_date: new Date().toISOString().split('T')[0], replacement_serial: '', remarks: '' }); fetchData();
      } catch (e) { console.error(e); alert("❌ Error resolving claim."); }
      setLoading(false);
  };

  const availableBatteries = batteries.filter(b => b.status === 'IN STOCK');
  // 🆕 Typed serial master me kahin nahi hai => naya battery => procurement fields dikhao.
  const cleanFitSerial = String(fitmentData.battery_serial || '').trim().toUpperCase();
  const isNewBatterySerial = !!cleanFitSerial && !batteries.find(b => String(b.serial_no || '').toUpperCase() === cleanFitSerial);
  const activeFitments = fitments.filter(f => f.status === 'FITTED');
  const fitmentHistory = fitments.filter(f => f.status === 'REMOVED');
  const claimBatteries = batteries.filter(b => b.status === 'WARRANTY CLAIM' || b.status === 'SCRAP');
  const pendingClaims = batteries.filter(b => b.status === 'WARRANTY CLAIM');

  const filteredHistory = historySearch
      ? fitmentHistory.filter(f => String(f.battery_serial||'').toLowerCase().includes(historySearch.toLowerCase()) || String(f.vehicle_no || '').toLowerCase().includes(historySearch.toLowerCase()))
      : fitmentHistory;

  const groupedFitments: any = {};
  activeFitments.forEach(f => {
      const vNo = f.vehicle_no;
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
        .grid-input { background: transparent; border: 1px solid #334155; color: #fff; padding: 8px; width: 100%; border-radius: 4px; box-sizing: border-box; font-size: 12px; }
        .grid-input:focus { border-color: #c084fc; outline: none; background: rgba(0,0,0,0.5); }
        .pos-chip { padding: 14px 10px; border-radius: 10px; cursor: pointer; transition: 0.3s; text-align: center; font-weight: bold; font-size: 13px; }
        .pos-chip.empty { background: rgba(16, 185, 129, 0.08); border: 2px dashed #10b981; color: #10b981; }
        .pos-chip.empty:hover { background: rgba(16, 185, 129, 0.25); box-shadow: 0 0 15px rgba(16,185,129,0.4); }
        .pos-chip.occupied { background: rgba(239, 68, 68, 0.08); border: 2px solid #ef4444; color: #ef4444; cursor: not-allowed; }
        .pos-chip.selected { background: rgba(56, 189, 248, 0.2); border: 2px solid #38bdf8; color: #38bdf8; box-shadow: 0 0 20px rgba(56,189,248,0.5); }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900', letterSpacing: '-0.5px' }}>Battery & Asset Inventory</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Procurement, Fitment & Warranty Tracking</p>
        </div>
        <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
          <button className="glow-btn" style={{ background: '#334155', border: '1px solid #475569' }} onClick={handlePrintPDF}>🖨️ Print PDF</button>
          <button className="glow-btn" style={{ background: '#1e293b', border: '1px solid #38bdf8', color: '#38bdf8' }} onClick={handleExportCSV}>📥 Export Excel</button>
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }} onClick={() => setIsFitmentModalOpen(true)}>
            <span style={{ fontSize: '16px' }}>🔋</span> Fit Battery to Vehicle
          </button>
          <button className="glow-btn" onClick={() => setIsPurchaseModalOpen(true)}>
            <span style={{ fontSize: '16px' }}>➕</span> New Purchase / Add Stock
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        <button className={`tab-btn ${activeTab === 'FITMENTS' ? 'active' : ''}`} onClick={() => setActiveTab('FITMENTS')}>🔋 LIVE VEHICLE FITMENTS</button>
        <button className={`tab-btn ${activeTab === 'INVENTORY' ? 'active' : ''}`} onClick={() => setActiveTab('INVENTORY')}>📦 BATTERY INVENTORY (STOCK)</button>
        <button className={`tab-btn ${activeTab === 'WARRANTY' ? 'active' : ''}`} onClick={() => setActiveTab('WARRANTY')}>🛡️ WARRANTY CLAIMS & SCRAP</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📜 REMOVAL HISTORY</button>
      </div>

      {/* 🔋 TAB 1: LIVE FITMENTS */}
      {activeTab === 'FITMENTS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #f59e0b' }}>
          <h3 style={{ color: '#f59e0b', marginTop: 0, marginBottom: '15px' }}>Batteries Currently Running on Vehicles</h3>
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Data...</p> : (
            <div>
               {Object.keys(groupedFitments).length === 0 ? <div style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>No active fitments.</div> :
                 Object.keys(groupedFitments).map((vNo, idx) => (
                   <div key={idx} style={{ marginBottom: '30px', background: 'rgba(0,0,0,0.2)', border: '1px solid #334155', borderRadius: '12px', overflow: 'hidden' }}>
                      <div style={{ background: 'rgba(245, 158, 11, 0.1)', padding: '15px 20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                         <h3 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>🚚 {vNo}</h3>
                         <span className="badge" style={{ background: '#f59e0b', color: '#fff' }}>{groupedFitments[vNo].length} Batteries Fitted</span>
                      </div>
                      <table style={{ margin: 0, width: '100%' }}>
                        <thead>
                          <tr>
                            <th>Position</th>
                            <th style={{ color: '#10b981' }}>Battery Serial No</th>
                            <th>Make & AH</th>
                            <th>Fitment Date</th>
                            <th>Fitting KM</th>
                            <th>Warranty Status</th>
                            <th style={{ textAlign: 'center' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                           {groupedFitments[vNo].map((f: any, i: number) => {
                             const w = getWarrantyStatus(f.purchase_date, f.warranty_months);
                             return (
                             <tr key={i}>
                               <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{f.position}</td>
                               <td style={{ color: '#10b981', fontWeight: '900', fontSize: '15px' }}>{f.battery_serial}</td>
                               <td style={{ color: '#cbd5e1' }}>{f.make} {f.capacity_ah ? `${f.capacity_ah}AH` : ''}</td>
                               <td>{f.fitment_date}</td>
                               <td style={{ color: '#f59e0b', fontWeight: 'bold' }}>{parseFloat(f.fitting_km||0).toLocaleString('en-IN')} KM</td>
                               <td><span style={{ color: w.color, fontWeight: 'bold', fontSize: '12px' }}>{w.label}</span></td>
                               <td style={{ textAlign: 'center' }}>
                                 <button onClick={() => { setSelectedFitment(f); setIsRemoveModalOpen(true); }} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '10px', transition: '0.3s' }}>
                                   ✂️ Remove
                                 </button>
                               </td>
                             </tr>
                           )})}
                        </tbody>
                      </table>
                   </div>
                 ))
               }
            </div>
          )}
        </div>
      )}

      {/* 📦 TAB 2: BATTERY INVENTORY */}
      {activeTab === 'INVENTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #38bdf8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#38bdf8', margin: 0 }}>All Batteries Master Database</h3>
            <span style={{ background: 'rgba(56,189,248,0.1)', padding: '5px 12px', borderRadius: '20px', color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>Available Stock: {availableBatteries.length}</span>
          </div>

          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Inventory...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Serial No</th>
                  <th>Make & AH</th>
                  <th>Cost (₹)</th>
                  <th>Inv No / Vendor</th>
                  <th>Warranty Status</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {batteries.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No Batteries in Stock.</td></tr> :
                  batteries.map((b, i) => {
                  const w = getWarrantyStatus(b.purchase_date, b.warranty_months);
                  return (
                  <tr key={i}>
                    <td style={{ fontWeight: '900', color: '#fff', fontSize: '15px' }}>{b.serial_no}</td>
                    <td style={{ color: '#cbd5e1' }}>{b.make} <span style={{ color: '#c084fc', fontWeight: 'bold' }}>{b.capacity_ah ? `${b.capacity_ah}AH` : ''}</span></td>
                    <td style={{ fontWeight: 'bold', color: '#38bdf8' }}>₹{parseFloat(b.cost || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                           <span style={{ color: '#c084fc', fontSize: '11px', fontWeight: 'bold' }}>{b.invoice_no || '-'}</span>
                           {b.invoice_file_url && <a href={b.invoice_file_url} target="_blank" rel="noreferrer" style={{ color: '#10b981', fontSize: '14px', textDecoration: 'none' }} title="View Invoice">👁️</a>}
                        </div>
                        <small style={{ color: '#94a3b8' }}>{b.vendor || '-'}</small>
                    </td>
                    <td><span style={{ color: w.color, fontWeight: 'bold', fontSize: '12px' }}>{w.label}</span></td>
                    <td>
                      <span className="badge" style={{
                        background: b.status === 'IN STOCK' ? 'rgba(16,185,129,0.2)' : b.status === 'FITTED' ? 'rgba(56,189,248,0.2)' : b.status === 'SCRAP' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)',
                        color: b.status === 'IN STOCK' ? '#10b981' : b.status === 'FITTED' ? '#38bdf8' : b.status === 'SCRAP' ? '#ef4444' : '#f59e0b'
                      }}>{b.status}</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                        <button onClick={() => { setEditData({...b}); setIsEditModalOpen(true); }} style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✏️ Edit</button>
                        <button onClick={() => handleDelete(b.id, b.serial_no)} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', visibility: b.status === 'FITTED' ? 'hidden' : 'visible' }}>🗑️ Delete</button>
                      </div>
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 🛡️ TAB 3: WARRANTY CLAIMS & SCRAP */}
      {activeTab === 'WARRANTY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #10b981' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#10b981', margin: 0 }}>Warranty Claims & Scrapped Batteries</h3>
            <div style={{ display: 'flex', gap: '15px' }}>
                <span style={{ background: 'rgba(16,185,129,0.1)', padding: '5px 12px', borderRadius: '20px', color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>Pending Claims: {pendingClaims.length}</span>
                <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #c084fc, #9333ea)', padding: '8px 15px', fontSize: '12px' }} onClick={() => setIsDispatchClaimModalOpen(true)}>
                    📤 Send Battery to Warranty Claim
                </button>
            </div>
          </div>

          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Data...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Serial No</th>
                  <th>Make & AH</th>
                  <th style={{ color: '#10b981' }}>Total KM Run</th>
                  <th>Claim / Company Details</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {claimBatteries.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No warranty claims or scrapped batteries.</td></tr> :
                  claimBatteries.map((b, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: '900', color: '#fff', fontSize: '15px' }}>{b.serial_no}</td>
                    <td style={{ color: '#cbd5e1' }}>{b.make} {b.capacity_ah ? `${b.capacity_ah}AH` : ''}</td>
                    <td style={{ color: '#10b981', fontWeight: '900', fontSize: '14px' }}>{parseFloat(b.total_km_run || 0).toLocaleString('en-IN')} KM</td>
                    <td>
                        <span style={{ color: '#c084fc', fontWeight: 'bold' }}>{b.claim_company || (b.status === 'SCRAP' ? (b.scrap_reason || 'Scrapped') : '-')}</span><br/>
                        <span style={{ color: '#94a3b8', fontSize: '11px' }}>{b.status === 'WARRANTY CLAIM' ? `Ref: ${b.claim_ref || '-'} | Sent: ${b.claim_date || '-'}` : `Scrapped: ${b.scrapped_on || '-'}`}</span>
                    </td>
                    <td>
                      <span className="badge" style={{
                        background: b.status === 'SCRAP' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)',
                        color: b.status === 'SCRAP' ? '#ef4444' : '#f59e0b',
                        border: `1px solid ${b.status === 'SCRAP' ? '#ef4444' : '#f59e0b'}`
                      }}>{b.status}</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {b.status === 'WARRANTY CLAIM' ? (
                        <button onClick={() => { setSelectedClaimBattery(b); setIsReceiveClaimModalOpen(true); }} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', padding: '6px 15px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', transition: '0.3s' }}>
                          📥 Receive & Close Claim
                        </button>
                      ) : (
                        <button onClick={() => handleDelete(b.id, b.serial_no)} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' }}>🗑️ Delete</button>
                      )}
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
            <h3 style={{ color: '#c084fc', margin: 0 }}>Battery Removal & Lifecycle History</h3>
            <input
              className="modern-input"
              placeholder="🔍 Search Battery Serial No or Vehicle No..."
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
                <th style={{ color: '#10b981' }}>KM Run</th>
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
                  <td style={{ fontWeight: 'bold', color: '#fff' }}>{f.vehicle_no}</td>
                  <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{f.battery_serial}</td>
                  <td style={{ color: '#cbd5e1' }}>{f.position}</td>
                  <td style={{ fontSize: '11px', color: '#94a3b8' }}>{parseFloat(f.fitting_km||0).toLocaleString('en-IN')} ➔ {parseFloat(f.removal_km||0).toLocaleString('en-IN')}</td>
                  <td>
                    <span style={{ color: '#f59e0b', fontWeight: '900', fontSize: '15px' }}>
                       {yieldKm.toLocaleString('en-IN')} KM
                    </span>
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

      {/* ✏️ MODAL 0: EDIT BATTERY DATA */}
      {isEditModalOpen && editData && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '520px', border: '1px solid #38bdf8', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#38bdf8' }}>✏️ Edit Battery Profile</h2>
              <button onClick={() => setIsEditModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Battery Serial No (Unchangeable)</label>
                <input className="modern-input" value={editData.serial_no} disabled style={{background: 'rgba(0,0,0,0.3)', color: '#64748b'}}/>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Make / Brand</label>
                  <input className="modern-input" value={editData.make} onChange={e=>setEditData({...editData, make: e.target.value.toUpperCase()})} />
                </div>
                <div><label style={{ fontSize:'12px', color:'#c084fc', fontWeight:'bold' }}>Capacity (AH)</label>
                  <input className="modern-input" value={editData.capacity_ah} onChange={e=>setEditData({...editData, capacity_ah: e.target.value})} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Purchase Date</label>
                  <input type="date" className="modern-input" value={editData.purchase_date || ''} onChange={e=>setEditData({...editData, purchase_date: e.target.value})} style={{colorScheme:'dark'}}/>
                </div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Warranty (Months)</label>
                  <select className="modern-input" value={editData.warranty_months} onChange={e=>setEditData({...editData, warranty_months: e.target.value})}>
                    <option value="12">12 Months</option><option value="18">18 Months</option><option value="24">24 Months</option><option value="36">36 Months</option><option value="48">48 Months</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Total Cost (₹)</label>
                  <input type="number" className="modern-input" style={{ borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={editData.cost} onChange={e=>setEditData({...editData, cost: e.target.value})} />
                </div>
                <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Current Status</label>
                  <select className="modern-input" style={{ borderColor: '#ef4444', color: '#ef4444', fontWeight: 'bold' }} value={editData.status} onChange={e=>setEditData({...editData, status: e.target.value})} disabled={editData.status === 'FITTED'}>
                    <option value="IN STOCK">IN STOCK (Available)</option>
                    <option value="SCRAP">SCRAP / DEAD (Deactive)</option>
                    <option value="FITTED" disabled>FITTED (On Vehicle)</option>
                    <option value="WARRANTY CLAIM">WARRANTY CLAIM</option>
                  </select>
                </div>
              </div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '15px' }} onClick={handleEditSave} disabled={loading}>
              {loading ? '⏳ Updating...' : '✅ Save Battery Changes'}
            </button>
          </div>
        </div>
      )}

      {/* 🧾 MODAL 1: ADVANCED PURCHASE INVOICE & SMART TABLE */}
      {isPurchaseModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1150px', border: '1px solid #10b981', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)', maxHeight: '95vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>🧾 Register Battery Purchase Invoice</h2>
              <button onClick={() => setIsPurchaseModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #38bdf8', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
               <div>
                 <label style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '14px', display: 'block' }}>🤖 Upload Original Bill & Scan (Auto-Fill)</label>
                 <p style={{ color: '#94a3b8', fontSize: '11px', marginTop: '5px', marginBottom: 0 }}>Select PDF/Image of the invoice. AI (local Gemma 4) will extract details.</p>
               </div>
               <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                 <input type="file" accept="image/*,.pdf" onChange={(e) => setInvoiceFile(e.target.files ? e.target.files[0] : null)} style={{ color: 'white', fontSize: '12px', background: '#1e293b', padding: '8px', borderRadius: '8px' }} />
                 <button onClick={handleScanInvoice} disabled={!invoiceFile || scanning || uploadingDoc} style={{ padding: '10px 20px', background: invoiceFile ? '#3b82f6' : '#334155', color: 'white', border: 'none', borderRadius: '8px', cursor: invoiceFile ? 'pointer' : 'not-allowed', fontWeight: 'bold', transition: '0.3s' }}>
                    {scanning || uploadingDoc ? '🚀 SCANNING...' : '🔍 SCAN & AUTO-FILL'}
                 </button>
               </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '15px', marginBottom: '20px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Invoice Number *</label><input className="modern-input" placeholder="e.g. INV-2026-001" value={purchaseData.invoice_no} onChange={e=>setPurchaseData({...purchaseData, invoice_no: e.target.value.toUpperCase()})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Purchase Date *</label><input type="date" className="modern-input" value={purchaseData.invoice_date} onChange={e=>setPurchaseData({...purchaseData, invoice_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
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
               <label style={{ fontSize:'14px', color:'#c084fc', fontWeight:'bold', display:'block', marginBottom:'10px' }}>🔋 Add Batteries to Invoice (Line Items)</label>
               <div style={{ overflowX: 'auto', background: 'rgba(0,0,0,0.2)', border: '1px solid #334155', borderRadius: '8px' }}>
                 <table style={{ margin: 0, minWidth: '950px' }}>
                   <thead style={{ background: '#1e293b' }}>
                     <tr>
                       <th style={{ width: '40px', textAlign: 'center' }}>SL</th>
                       <th style={{ width: '110px' }}>Make</th>
                       <th style={{ width: '150px' }}>Battery Serial No *</th>
                       <th style={{ width: '90px' }}>Capacity (AH)</th>
                       <th style={{ width: '110px' }}>Warranty</th>
                       <th style={{ width: '70px' }}>GST %</th>
                       <th style={{ width: '95px', color: '#f59e0b' }}>GST Amount</th>
                       <th style={{ width: '110px', color: '#10b981' }}>Inv Amount (₹)</th>
                       <th style={{ width: '70px', textAlign: 'center' }}>Action</th>
                     </tr>
                   </thead>
                   <tbody>
                     {batteryList.map((b, idx) => (
                       <tr key={idx} style={{ background: 'rgba(16, 185, 129, 0.05)' }}>
                         <td style={{ textAlign: 'center', color: '#94a3b8' }}>{idx + 1}</td>
                         <td style={{ fontWeight: 'bold' }}>{b.make}</td>
                         <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{b.serial_no}</td>
                         <td><span className="badge" style={{ background: '#334155' }}>{b.capacity_ah}AH</span></td>
                         <td>{b.warranty_months} Mo</td>
                         <td>{b.gst_percent}%</td>
                         <td style={{ color: '#f59e0b' }}>₹{b.gst_amount}</td>
                         <td style={{ color: '#10b981', fontWeight: 'bold' }}>₹{parseFloat(b.inv_amount).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                         <td style={{ textAlign: 'center' }}>
                           <button onClick={() => handleRemoveBatteryFromGrid(idx)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '14px', cursor: 'pointer' }}>✕</button>
                         </td>
                       </tr>
                     ))}

                     <tr style={{ background: 'rgba(192, 132, 252, 0.05)', borderTop: '1px solid #c084fc' }}>
                       <td style={{ textAlign: 'center', color: '#c084fc', fontWeight: 'bold' }}>+</td>
                       <td><input className="grid-input" placeholder="e.g. EXIDE" value={currentBattery.make} onChange={e=>setCurrentBattery({...currentBattery, make: e.target.value.toUpperCase()})} /></td>
                       <td>
                          <input
                             className="grid-input"
                             style={{ borderColor: '#c084fc', color: '#c084fc', fontWeight: 'bold' }}
                             placeholder="Serial No..."
                             value={currentBattery.serial_no}
                             onChange={e=>setCurrentBattery({...currentBattery, serial_no: e.target.value.toUpperCase()})}
                             onKeyDown={e => { if(e.key === 'Enter') { e.preventDefault(); handleAddBatteryToGrid(); } }}
                          />
                       </td>
                       <td>
                          <select className="grid-input" value={currentBattery.capacity_ah} onChange={e=>setCurrentBattery({...currentBattery, capacity_ah: e.target.value})}>
                            <option value="80">80 AH</option><option value="100">100 AH</option><option value="120">120 AH</option><option value="130">130 AH</option><option value="150">150 AH</option><option value="180">180 AH</option><option value="200">200 AH</option>
                          </select>
                       </td>
                       <td>
                          <select className="grid-input" value={currentBattery.warranty_months} onChange={e=>setCurrentBattery({...currentBattery, warranty_months: e.target.value})}>
                            <option value="12">12 Mo</option><option value="18">18 Mo</option><option value="24">24 Mo</option><option value="36">36 Mo</option><option value="48">48 Mo</option>
                          </select>
                       </td>
                       <td>
                          <select className="grid-input" value={currentBattery.gst_percent} onChange={e=>setCurrentBattery({...currentBattery, gst_percent: e.target.value})}>
                            <option value="28">28%</option><option value="18">18%</option><option value="0">0%</option>
                          </select>
                       </td>
                       <td style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                          ₹{(parseFloat(currentBattery.inv_amount || '0') - (parseFloat(currentBattery.inv_amount || '0') / (1 + (parseFloat(currentBattery.gst_percent)/100)))).toFixed(2)}
                       </td>
                       <td>
                          <input
                            type="number"
                            className="grid-input"
                            style={{ borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }}
                            placeholder="Total ₹"
                            value={currentBattery.inv_amount}
                            onChange={e=>setCurrentBattery({...currentBattery, inv_amount: e.target.value})}
                            onKeyDown={e => { if(e.key === 'Enter') { e.preventDefault(); handleAddBatteryToGrid(); } }}
                          />
                       </td>
                       <td style={{ textAlign: 'center' }}>
                          <button onClick={handleAddBatteryToGrid} style={{ background: '#c084fc', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' }}>ADD</button>
                       </td>
                     </tr>
                   </tbody>
                 </table>
               </div>

               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '15px', padding: '15px', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '8px', border: '1px dashed #10b981' }}>
                  <div style={{ color: '#94a3b8', fontSize: '13px' }}>Total Batteries Added: <b style={{color: '#fff', fontSize: '16px'}}>{batteryList.length}</b></div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase' }}>Grand Invoice Total</span>
                    <h2 style={{ margin: 0, color: '#10b981', fontSize: '24px' }}>
                      ₹{batteryList.reduce((sum, b) => sum + parseFloat(b.inv_amount), 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                    </h2>
                  </div>
               </div>
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '16px' }} onClick={handleSavePurchase} disabled={loading || batteryList.length === 0}>
               {loading ? '⏳ Processing & Saving...' : '💾 Save Invoice, Auto-Ledger & Add Batteries to Stock'}
            </button>
          </div>
        </div>
      )}

      {/* 📤 MODAL 1C: DISPATCH TO WARRANTY CLAIM */}
      {isDispatchClaimModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '650px', border: '1px solid #c084fc', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#c084fc' }}>📤 Send Batteries to Warranty Claim</h2>
              <button onClick={() => setIsDispatchClaimModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Claim Company / Dealer *</label>
                <input className="modern-input" style={{ borderColor: '#38bdf8' }} placeholder="e.g. EXIDE Service Centre" value={dispatchData.claim_company} onChange={e=>setDispatchData({...dispatchData, claim_company: e.target.value.toUpperCase()})} />
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Sent Date</label><input type="date" className="modern-input" value={dispatchData.dispatch_date} onChange={e=>setDispatchData({...dispatchData, dispatch_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Claim Ref / Docket No *</label><input className="modern-input" placeholder="e.g. CLM-001" value={dispatchData.claim_ref} onChange={e=>setDispatchData({...dispatchData, claim_ref: e.target.value.toUpperCase()})} /></div>
            </div>

            <div style={{ background: 'rgba(192, 132, 252, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #c084fc' }}>
               <label style={{ fontSize:'12px', color:'#c084fc', fontWeight:'bold' }}>Enter Batteries for Claim (from Stock) *</label>
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
              {loading ? '⏳ Processing...' : `📤 File Warranty Claim for ${dispatchSerialList.length} Batteries`}
            </button>
          </div>
        </div>
      )}

      {/* 📥 MODAL 1B: RECEIVE / CLOSE WARRANTY CLAIM */}
      {isReceiveClaimModalOpen && selectedClaimBattery && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '600px', border: '1px solid #10b981', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>📥 Resolve Warranty Claim</h2>
              <button onClick={() => setIsReceiveClaimModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #38bdf8' }}>
              <p style={{ margin: '0 0 8px 0', color: '#94a3b8', fontSize: '13px' }}>Claim Battery: <b style={{color:'#fff'}}>{selectedClaimBattery.serial_no}</b> ({selectedClaimBattery.make} {selectedClaimBattery.capacity_ah}AH)</p>
              <p style={{ margin: 0, color: '#10b981', fontSize: '12px' }}>Sent to: {selectedClaimBattery.claim_company || '-'} | Ref: {selectedClaimBattery.claim_ref || '-'}</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Claim Outcome *</label>
                <select className="modern-input" style={{ borderColor: '#38bdf8' }} value={claimData.outcome} onChange={e=>setClaimData({...claimData, outcome: e.target.value})}>
                   <option value="REPAIRED">🔧 Repaired / Same Battery Returned → Back to Stock</option>
                   <option value="REPLACED">🔄 Replaced with New Battery → New Serial to Stock</option>
                   <option value="REJECTED">❌ Claim Rejected → Scrap (Cost to P&L)</option>
                </select>
              </div>

              {claimData.outcome === 'REPLACED' && (
                <div style={{ padding: '15px', background: 'rgba(16,185,129,0.05)', border: '1px dashed #10b981', borderRadius: '8px' }}>
                  <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>New Replacement Battery Serial No *</label>
                  <input className="modern-input" style={{ borderColor: '#10b981', textTransform: 'uppercase', fontWeight: 'bold' }} placeholder="Serial No of the new battery..." value={claimData.replacement_serial} onChange={e=>setClaimData({...claimData, replacement_serial: e.target.value.toUpperCase()})} />
                  <small style={{ color: '#94a3b8', fontSize: '10px' }}>💡 Free replacement — added to stock @ ₹0 with same warranty terms ({selectedClaimBattery.warranty_months} months).</small>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Resolution Date</label><input type="date" className="modern-input" value={claimData.resolution_date} onChange={e=>setClaimData({...claimData, resolution_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Remarks</label><input className="modern-input" placeholder="Optional notes" value={claimData.remarks} onChange={e=>setClaimData({...claimData, remarks: e.target.value})} /></div>
              </div>
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', justifyContent: 'center', fontSize: '15px' }} onClick={handleResolveClaim} disabled={loading}>
              {loading ? '⏳ Processing...' : '✅ Close Claim & Update Stock'}
            </button>
          </div>
        </div>
      )}

      {/* 🏢 MODAL 1A: QUICK ADD VENDOR */}
      {isVendorModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1200, padding: '20px' }}>
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

      {/* 🔋 MODAL 2: FIT BATTERY TO VEHICLE */}
      {isFitmentModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '700px', border: '1px solid #f59e0b', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#f59e0b' }}>🔋 Vehicle Battery Fitment</h2>
              <button onClick={() => { setIsFitmentModalOpen(false); setCurrentVehicleFitments([]); }} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '15px' }}>

              <div>
                <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>1. Search & Select Vehicle *</label>
                <input
                  className="modern-input"
                  style={{ border: '1px solid #38bdf8', fontSize: '16px', fontWeight: 'bold' }}
                  list="vehicle-battery-fitment-list"
                  placeholder="Type Vehicle No (e.g. 5107)..."
                  value={fitmentData.vehicle_no}
                  onChange={e => handleVehicleSearch(e.target.value)}
                />
                <datalist id="vehicle-battery-fitment-list">
                  {vehicles.map(v => {
                      const vNo = v.vehicle_no || v.Vehicle_No || v.vehical_no;
                      return <option key={v.id} value={vNo} />
                  })}
                </datalist>
              </div>

              {fitmentData.vehicle_no && (
                <div>
                  <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold', display: 'block', marginBottom: '8px' }}>2. Select Battery Position * (Green = free, Red = occupied)</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                    {BATTERY_POSITIONS.map(pos => {
                        const fitted = currentVehicleFitments.find(f => f.position === pos.label);
                        const isOccupied = !!fitted;
                        const isSelected = fitmentData.position === pos.label;
                        return (
                          <div
                            key={pos.id}
                            className={`pos-chip ${isOccupied ? 'occupied' : isSelected ? 'selected' : 'empty'}`}
                            title={isOccupied ? `FITTED: ${fitted.battery_serial}` : pos.label}
                            onClick={() => !isOccupied && setFitmentData({...fitmentData, position: pos.label})}
                          >
                             {pos.label}
                             {isOccupied && <div style={{ fontSize: '9px', marginTop: '4px', fontWeight: 'normal' }}>⛔ {fitted.battery_serial}</div>}
                          </div>
                        )
                    })}
                  </div>
                  {fitmentData.position && (
                       <p style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', margin: '12px 0 0 0', background: 'rgba(16,185,129,0.1)', padding: '10px', borderRadius: '8px' }}>
                           ✅ Selected Target Position: {fitmentData.position}
                       </p>
                  )}
                </div>
              )}

              <div>
                <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>3. Enter / Select Battery Serial No *</label>
                <input
                  className="modern-input"
                  style={{ border: '1px solid #10b981' }}
                  list="battery-stock-list"
                  placeholder="Type New or Select from Stock..."
                  value={fitmentData.battery_serial}
                  onChange={e=>setFitmentData({...fitmentData, battery_serial: e.target.value.toUpperCase()})}
                />
                <datalist id="battery-stock-list">
                  {availableBatteries.map(b => <option key={b.id} value={b.serial_no}>{b.serial_no} ({b.make} {b.capacity_ah}AH)</option>)}
                </datalist>
                <small style={{color: '#94a3b8', fontSize: '10px', marginTop: '5px', display: 'block'}}>
                   💡 Naya number type karne par niche Purchase Cost & Vendor bharna hoga — bina cost ke battery add nahi hoga (P&L accuracy).
                </small>
              </div>

              {/* 🆕 NEW BATTERY => MANDATORY PROCUREMENT */}
              {isNewBatterySerial && (
                <div style={{ padding: '18px', background: 'rgba(16,185,129,0.05)', border: '1px dashed #10b981', borderRadius: '10px' }}>
                  <p style={{ margin: '0 0 12px 0', color: '#10b981', fontSize: '13px', fontWeight: 'bold' }}>
                    🆕 NEW BATTERY DETECTED: <span style={{color:'#fff'}}>{cleanFitSerial}</span> stock me nahi hai — procurement details bharein (P&L ke liye mandatory)
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Purchase Cost (Total ₹) *</label>
                      <input type="number" className="modern-input" style={{ border: '1px solid #10b981', color: '#10b981', fontWeight: 'bold' }} placeholder="e.g. 12500" value={newBatteryProc.cost} onChange={e => setNewBatteryProc({ ...newBatteryProc, cost: e.target.value })} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight:'bold' }}>Vendor / Ledger *</label>
                        <span onClick={() => setIsVendorModalOpen(true)} style={{ fontSize:'11px', color:'#10b981', cursor: 'pointer', fontWeight: 'bold' }}>+ New Vendor</span>
                      </div>
                      <select className="modern-input" style={{ borderColor: '#38bdf8' }} value={newBatteryProc.vendor_name} onChange={e => setNewBatteryProc({ ...newBatteryProc, vendor_name: e.target.value })}>
                        <option value="">-- Choose Vendor * --</option>
                        <option value="CASH PURCHASE">💵 CASH PURCHASE (No Ledger)</option>
                        {vendors.map(v => <option key={v.id} value={v.vendor_name}>{v.vendor_name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Make / Brand</label>
                      <input className="modern-input" placeholder="e.g. EXIDE" value={newBatteryProc.make} onChange={e => setNewBatteryProc({ ...newBatteryProc, make: e.target.value.toUpperCase() })} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      <div>
                        <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Capacity (AH)</label>
                        <select className="modern-input" value={newBatteryProc.capacity_ah} onChange={e => setNewBatteryProc({ ...newBatteryProc, capacity_ah: e.target.value })}>
                          <option value="80">80 AH</option><option value="100">100 AH</option><option value="120">120 AH</option><option value="130">130 AH</option><option value="150">150 AH</option><option value="180">180 AH</option><option value="200">200 AH</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>GST %</label>
                        <select className="modern-input" value={newBatteryProc.gst_percent} onChange={e => setNewBatteryProc({ ...newBatteryProc, gst_percent: e.target.value })}>
                          <option value="28">28%</option><option value="18">18%</option><option value="0">0%</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Warranty (Months)</label>
                      <select className="modern-input" value={newBatteryProc.warranty_months} onChange={e => setNewBatteryProc({ ...newBatteryProc, warranty_months: e.target.value })}>
                        <option value="12">12 Months</option><option value="18">18 Months</option><option value="24">24 Months</option><option value="36">36 Months</option><option value="48">48 Months</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Purchase Date</label>
                      <input type="date" className="modern-input" value={newBatteryProc.purchase_date} onChange={e => setNewBatteryProc({ ...newBatteryProc, purchase_date: e.target.value })} style={{colorScheme:'dark'}}/>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Fitment Date</label><input type="date" className="modern-input" value={fitmentData.fitment_date} onChange={e=>setFitmentData({...fitmentData, fitment_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div>
                    <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold' }}>Current Odometer (Fitting KM) *</label>
                    <input type="number" className="modern-input" style={{ border: '1px solid #f59e0b', color: '#f59e0b', fontWeight: 'bold' }} value={fitmentData.fitting_km} onChange={e=>setFitmentData({...fitmentData, fitting_km: e.target.value})} placeholder="e.g. 125000" />
                </div>
              </div>

            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', justifyContent: 'center', fontSize: '15px' }} onClick={handleFitBattery} disabled={loading}>
              {loading ? '⏳ Fitting...' : '🔧 Confirm Fitment'}
            </button>
          </div>
        </div>
      )}

      {/* ✂️ MODAL 3: REMOVE BATTERY & CALCULATE KM */}
      {isRemoveModalOpen && selectedFitment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '520px', border: '1px solid #ef4444', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#ef4444' }}>✂️ Remove Battery</h2>
              <button onClick={() => setIsRemoveModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #38bdf8' }}>
              <p style={{ margin: '0 0 8px 0', color: '#94a3b8', fontSize: '13px' }}>Removing Battery <b style={{color:'#fff'}}>{selectedFitment.battery_serial}</b> from <b style={{color:'#fff'}}>{selectedFitment.vehicle_no}</b> <span style={{color:'#f59e0b'}}>({selectedFitment.position})</span></p>
              <p style={{ margin: 0, color: '#10b981', fontSize: '14px', fontWeight: 'bold' }}>Fitted at: {parseFloat(selectedFitment.fitting_km||0).toLocaleString('en-IN')} KM</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Current Vehicle Meter KM (Removal KM) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #ef4444', fontSize: '20px', fontWeight: '900', color: '#ef4444' }} value={removeData.removal_km} onChange={e=>setRemoveData({...removeData, removal_km: e.target.value})} placeholder="e.g. 165000" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Reason for Removal</label>
                  <select className="modern-input" value={removeData.removal_reason} onChange={e=>setRemoveData({...removeData, removal_reason: e.target.value})}>
                    <option value="WARRANTY CLAIM">🛡️ Sent for Warranty Claim</option>
                    <option value="MAINTENANCE">🔧 Maintenance (Back to Stock)</option>
                    <option value="DEAD/SCRAP">🗑️ Dead / Scrap (P&L Expense)</option>
                  </select>
                </div>

                <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Removal Date</label><input type="date" className="modern-input" value={removeData.removal_date} onChange={e=>setRemoveData({...removeData, removal_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              </div>
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #ef4444, #b91c1c)', justifyContent: 'center', fontSize: '15px' }} onClick={handleRemoveBattery} disabled={loading}>
              {loading ? '⏳ Removing...' : '✂️ Confirm Removal & Update Status'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
