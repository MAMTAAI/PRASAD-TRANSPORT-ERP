// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp, query, where, Timestamp } from 'firebase/firestore';
import { db } from './firebase';
import { extractJsonFromImage } from './lib/aiScanner';
import { postEntry } from './lib/accounting/journal';

export default function BillManagement() {
  const [activeTab, setActiveTab] = useState('UNBILLED_TRIPS');
  // 📄 Scan a purchase/vendor/pump bill locally (Gemma vision) → record + journal.
  const [scanningBill, setScanningBill] = useState(false);
  const [scannedBill, setScannedBill] = useState<any>(null);

  const handleScanPurchaseBill = async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    setScanningBill(true); setScannedBill(null);
    try {
      const prompt = `Extract from this purchase/vendor/pump bill and reply ONLY JSON:
{ "vendor_name": "", "bill_no": "", "bill_date": "DD-MM-YYYY", "total_amount": 0, "gst_amount": 0, "description": "" }
Empty string / 0 if absent.`;
      const ai = await extractJsonFromImage(file, prompt);
      const amount = Number(String(ai.total_amount).replace(/[^0-9.]/g, '')) || 0;
      const billNo = ai.bill_no || `PB-${Date.now().toString().slice(-6)}`;
      if (amount <= 0) { alert('⚠️ Bill amount nahi mila — saaf photo/PDF se try karein.'); setScanningBill(false); return; }
      setScannedBill({ ...ai, bill_no: billNo, total_amount: amount });
      // ADD-ONLY purchase bill record (idempotent doc id by bill_no — no duplicate).
      await setDoc(doc(db, 'PURCHASE_BILLS', String(billNo).replace(/[^A-Za-z0-9_-]/g, '_')), {
        vendor_name: ai.vendor_name || '', bill_no: billNo, bill_date: ai.bill_date || '',
        total_amount: amount, gst_amount: Number(ai.gst_amount) || 0, description: ai.description || '',
        source: 'ai_scan', updated_at: serverTimestamp(),
      });
      // Journal: Dr Purchases/Expense, Cr Vendor (idempotent by bill_no).
      await postEntry({ source_type: 'PURCHASE_BILL', source_ref: String(billNo), date: ai.bill_date || '', narration: `Purchase bill ${billNo} — ${ai.vendor_name || ''}`, lines: [ { ledger: 'Purchases / Expense', dr_cr: 'Dr', amount }, { ledger: `Creditors: ${ai.vendor_name || 'Unknown Vendor'}`, dr_cr: 'Cr', amount } ] }).catch(() => {});
      alert(`✅ Bill scan ho gaya (local Gemma): ${ai.vendor_name || ''} ₹${amount} — record + journal updated.`);
    } catch (err: any) {
      const offline = err?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(err?.message || '');
      alert(offline ? '❌ Local AI engine (Ollama) band hai.' : '❌ Bill padhi nahi gayi.');
    }
    setScanningBill(false);
  };

  const [unbilledTrips, setUnbilledTrips] = useState<any[]>([]);
  const [generatedBills, setGeneratedBills] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  
  const [selectedTripsForBill, setSelectedTripsForBill] = useState<string[]>([]);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [selectedBill, setSelectedBill] = useState<any>(null);
  
  // 📅 FILTERS: DATES, CUSTOMER, & SEARCH
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [customersList, setCustomersList] = useState<string[]>([]);

  // 🌟 Trip Wise Editing State & Search
  const [tripAdjustments, setTripAdjustments] = useState<any[]>([]);
  const [tripSearchTerm, setTripSearchTerm] = useState('');
  const [adjustmentData, setAdjustmentData] = useState({ received_amount: '', tds_deducted: '', remarks: '', deposit_bank: 'SBI' });

  // 🏢 BANK ACCOUNTS
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);

  useEffect(() => {
    fetchUnbilledTrips();
    fetchGeneratedBills();
    fetchBankAccounts();
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    try {
      const cSnap = await getDocs(collection(db, "CUSTOMERS"));
      let cList = cSnap.docs.map(d => d.data().customer_name || d.data().name || d.data().party_name);
      cList = [...new Set(cList.filter(Boolean))];
      setCustomersList(cList);
    } catch (error) { console.error("Error fetching customers", error); }
  };

  const fetchBankAccounts = async () => {
    try {
      const snap = await getDocs(collection(db, "COMPANY_BANKS"));
      const banks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      banks.unshift({ id: 'cash_hq', name: 'Cash in Hand (HQ)' });
      setBankAccounts(banks);
    } catch (e) { console.error("Error fetching banks", e); }
  };

  const fetchUnbilledTrips = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "TRIPS"), where("billing_status", "==", "PENDING"));
      const snap = await getDocs(q);
      
      let tripsData = snap.docs.map(d => {
        const t = d.data();
        
        // 🧮 AUTO-CALCULATION ENGINE FOR BILLING
        const qty = parseFloat(t.qty || t.weight || t.quantity || 1);
        const rate = parseFloat(t.rate || t.freight_rate || 0);
        const gross = parseFloat(t.gross_freight || t.Gross_Freight || (qty * rate)) || 0;
        const penalty = parseFloat(t.shortage_amt || t.Shortage_Amt || t.shortage || 0);
        
        // 📉 TDS @ 2% Auto-Calculation
        const tds = parseFloat((gross * 0.02).toFixed(2)); 
        const net = gross - penalty - tds;

        return { 
          id: d.id, 
          ...t,
          calc_qty: qty,
          calc_rate: rate,
          calc_gross: gross,
          calc_penalty: penalty,
          calc_tds: tds,
          calc_net: net
        };
      });

      tripsData = tripsData.filter(t => t.trip_status === "COMPLETED" || t.trip_status === "UNLOADED" || t.Trip_Status === "COMPLETED" || t.Trip_Status === "UNLOADED");
      
      const dynamicCustomers = tripsData.map(t => t.customer_name || t.Customer || t.Registered_Assessee);
      setCustomersList(prev => [...new Set([...prev, ...dynamicCustomers].filter(Boolean))]);

      setUnbilledTrips(tripsData);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchGeneratedBills = async () => {
    try {
      const snap = await getDocs(collection(db, "COMPANY_BILLS"));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setGeneratedBills(data.sort((a:any, b:any) => new Date(b.createdAt?.toDate() || b.bill_date).getTime() - new Date(a.createdAt?.toDate() || a.bill_date).getTime()));
    } catch (e) { console.error(e); }
  };

  const toggleTripSelection = (tripId: string) => {
    setSelectedTripsForBill(prev => prev.includes(tripId) ? prev.filter(id => id !== tripId) : [...prev, tripId]);
  };

  const handleSelectAllTrips = (e: any, filteredList: any[]) => {
    if (e.target.checked) {
      setSelectedTripsForBill(filteredList.map(t => t.id));
    } else {
      setSelectedTripsForBill([]);
    }
  };

  // 📝 GENERATE INVOICE WITH TAXES & TDS
  const handleGenerateInvoice = async () => {
    if (selectedTripsForBill.length === 0) return alert("⚠️ Select at least one trip to generate a bill!");
    
    setLoading(true);
    try {
      const selectedTripData = unbilledTrips.filter(t => selectedTripsForBill.includes(t.id));
      
      const firstCustomer = selectedTripData[0].customer_name || selectedTripData[0].Customer || selectedTripData[0].Registered_Assessee;
      const isSameCustomer = selectedTripData.every(t => (t.customer_name || t.Customer || t.Registered_Assessee) === firstCustomer);
      
      if(!isSameCustomer) {
        setLoading(false);
        return alert("⚠️ You can only generate a single bill for trips belonging to the SAME Customer.");
      }

      const customerName = firstCustomer || 'Corporate Customer';
      const companyName = selectedTripData[0].company || 'M/S PRASAD TRANSPORT'; 
      const branchName = selectedTripData[0].branch || 'ALL'; 
      
      const totalGross = selectedTripData.reduce((acc, curr) => acc + curr.calc_gross, 0);
      const totalPenalty = selectedTripData.reduce((acc, curr) => acc + curr.calc_penalty, 0);
      const totalTds = selectedTripData.reduce((acc, curr) => acc + curr.calc_tds, 0);
      const expectedNet = selectedTripData.reduce((acc, curr) => acc + curr.calc_net, 0);

      const newBillNo = `INV-${customerName.substring(0,3).toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`;

      await addDoc(collection(db, "COMPANY_BILLS"), {
        bill_no: newBillNo,
        customer_name: customerName,
        company: companyName,
        branch: branchName, 
        bill_date: new Date().toISOString().split('T')[0],
        total_gross: totalGross,
        total_shortage_deduction: totalPenalty,
        total_tds_deduction: totalTds,
        total_net_expected: expectedNet,
        status: 'PENDING_PAYMENT',
        trips: selectedTripData.map(t => ({ 
          trip_db_id: t.id, 
          trip_id: t.trip_id || t.Trip_ID, 
          lr_no: t.lr_no || t.lr_number || 'N/A',
          vehicle_no: t.vehicle_no || t.Vehical_No, 
          driver_name: t.driver_name || t.Driver_Name || 'N/A', 
          loading_date: t.loading_date || t.date || t.start_date || '',
          unloading_date: t.unloading_date || t.Unloading_Date || '',
          qty: t.calc_qty,
          rate: t.calc_rate,
          gross_freight: t.calc_gross, 
          shortage_amt: t.calc_penalty,
          tds_amt: t.calc_tds,
          igst_amt: 0, cgst_amt: 0, sgst_amt: 0, // For IOCL Print format
          net_payable: t.calc_net,
          payment_status: 'PENDING'
        })),
        createdAt: serverTimestamp()
      });

      for (const tripId of selectedTripsForBill) {
        await updateDoc(doc(db, "TRIPS", tripId), { billing_status: 'BILLED', linked_bill_no: newBillNo });
      }

      alert(`✅ Invoice ${newBillNo} Generated Successfully!`);
      setSelectedTripsForBill([]);
      fetchUnbilledTrips();
      fetchGeneratedBills();
      setActiveTab('GENERATED_BILLS');

    } catch (error) { alert("❌ Error generating invoice!"); console.error(error); }
    setLoading(false);
  };

  const handleDeleteBill = async (bill: any) => {
    if(window.confirm(`⚠️ Are you sure you want to delete Invoice ${bill.bill_no}? Trips will be reverted to UNBILLED.`)) {
      try {
        for (const trip of bill.trips) {
          if(trip.trip_db_id) await updateDoc(doc(db, "TRIPS", trip.trip_db_id), { billing_status: 'PENDING', linked_bill_no: '' });
        }
        await deleteDoc(doc(db, "COMPANY_BILLS", bill.id));
        alert(`🗑️ Invoice deleted.`);
        fetchGeneratedBills();
        fetchUnbilledTrips();
      } catch (error) { alert("❌ Error deleting bill!"); }
    }
  };

  const openAdjustmentModal = (bill: any) => {
    setSelectedBill(bill);
    setFileName('');
    setTripSearchTerm('');
    
    const initialTrips = bill.trips.map((t: any) => ({ 
      ...t, 
      final_passed_amt: t.payment_status === 'SETTLED' ? t.final_passed_amt : t.net_payable,
      extra_shortage_amt: t.payment_status === 'SETTLED' ? t.extra_shortage_amt : 0, 
      recover_from_driver: t.payment_status === 'SETTLED' ? t.recover_from_driver : true,
      selected_for_payment: false 
    }));
    
    setTripAdjustments(initialTrips);
    setAdjustmentData({ received_amount: '', tds_deducted: '', remarks: '', deposit_bank: bankAccounts[0]?.name || 'Cash in Hand (HQ)' });
    setIsAdjustModalOpen(true);
  };

  const handleTripSelection = (index: number, isChecked: boolean) => {
    const updated = [...tripAdjustments];
    updated[index].selected_for_payment = isChecked;
    setTripAdjustments(updated);
    recalculateTotals(updated);
  };

  const handleTripShortageChange = (index: number, field: string, value: any) => {
    const updated = [...tripAdjustments]; 
    updated[index][field] = value; 
    setTripAdjustments(updated);
    recalculateTotals(updated);
  };

  const recalculateTotals = (trips: any[]) => {
    let totalRcv = 0; let totalTds = 0;
    trips.forEach(t => {
      if (t.selected_for_payment && t.payment_status !== 'SETTLED') {
        totalRcv += parseFloat(t.final_passed_amt || 0);
        totalTds += parseFloat(t.tds_amt || 0);
      }
    });
    setAdjustmentData(prev => ({ ...prev, received_amount: totalRcv.toFixed(2), tds_deducted: totalTds.toFixed(2) }));
  };

  const handleSettlePayment = async () => {
    const tripsToSettle = tripAdjustments.filter(t => t.selected_for_payment && t.payment_status !== 'SETTLED');
    if (tripsToSettle.length === 0) return alert("⚠️ Select at least one Pending Trip to settle!");
    if (!adjustmentData.received_amount) return alert("⚠️ Enter Received Amount!");

    try {
      let totalExtraShortage = 0;
      
      for (const trip of tripsToSettle) {
        totalExtraShortage += parseFloat(trip.extra_shortage_amt || 0);
        const tripIndex = tripAdjustments.findIndex(t => t.trip_id === trip.trip_id);
        tripAdjustments[tripIndex].payment_status = 'SETTLED';
        tripAdjustments[tripIndex].selected_for_payment = false;

        if (parseFloat(trip.extra_shortage_amt) > 0 && trip.recover_from_driver) {
          await addDoc(collection(db, "DRIVER_TRANSACTIONS"), {
            driver_name: trip.driver_name, vehicle_no: trip.vehicle_no, trip_id: trip.trip_id,
            txn_type: 'SHORTAGE_DEDUCTION', amount: parseFloat(trip.extra_shortage_amt), date: new Date().toISOString().split('T')[0],
            remarks: `Party extra deduction on Bill ${selectedBill.bill_no}`, createdAt: serverTimestamp()
          });
        }
        if(trip.trip_db_id) await updateDoc(doc(db, "TRIPS", trip.trip_db_id), { payment_received_status: 'SETTLED' });
      }

      const allTripsSettled = tripAdjustments.every(t => t.payment_status === 'SETTLED');
      const newBillStatus = allTripsSettled ? 'SETTLED' : 'PARTIALLY_PAID';

      await updateDoc(doc(db, "COMPANY_BILLS", selectedBill.id), { status: newBillStatus, trips: tripAdjustments });

      await addDoc(collection(db, "BANK_TRANSACTIONS"), {
        date: new Date().toISOString().split('T')[0],
        type: 'Receipt (IN)', party_id: 'SYSTEM_CUSTOMER', party_name: selectedBill.customer_name, party_type: 'Customer',
        amount: parseFloat(adjustmentData.received_amount),
        particulars: `Bill Payment Received - ${selectedBill.bill_no} | Included ${tripsToSettle.length} Trips | ${adjustmentData.remarks}`,
        bank_account: adjustmentData.deposit_bank, ref_no: adjustmentData.remarks || `SYS-REC-${Math.floor(Math.random()*1000)}`,
        company: selectedBill.company || 'ALL', branch: selectedBill.branch || 'ALL', created_at: Timestamp.now()
      });

      alert(`✅ Payment of ₹${adjustmentData.received_amount} Settled & Added to Bank Book!`);
      setIsAdjustModalOpen(false); fetchGeneratedBills();
    } catch (e) { alert("❌ Error settling payment."); console.error(e); }
  };

  // 🖨️ IOCL FORMAT PDF PRINT
  const handlePrintInvoice = (bill: any) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to print invoices.");

    // Grouping trips by vehicle for the IOCL Format
    const groupedTrips = bill.trips.reduce((acc: any, trip: any) => {
      acc[trip.vehicle_no] = acc[trip.vehicle_no] || [];
      acc[trip.vehicle_no].push(trip);
      return acc;
    }, {});

    let rowsHTML = "";
    let sNo = 1;

    Object.keys(groupedTrips).forEach(vehicleNo => {
      rowsHTML += `<tr><td colspan="12" style="font-weight:bold; background:#f1f5f9; padding:8px;">Vehicle: ${vehicleNo}</td></tr>`;
      let vehGross = 0, vehPenalty = 0, vehNet = 0;

      groupedTrips[vehicleNo].forEach((t: any) => {
        vehGross += parseFloat(t.gross_freight || 0);
        vehPenalty += parseFloat(t.shortage_amt || 0);
        vehNet += parseFloat(t.net_payable || 0);

        rowsHTML += `
          <tr style="border-bottom: 1px solid #e2e8f0; font-size:12px;">
            <td style="padding: 8px; text-align: center;">${sNo++}</td>
            <td style="padding: 8px;">${t.lr_no || t.trip_id}</td>
            <td style="padding: 8px;">${t.loading_date || '-'}</td>
            <td style="padding: 8px;">${t.unloading_date || '-'}</td>
            <td style="padding: 8px; text-align:right;">${t.qty || 1}</td>
            <td style="padding: 8px; text-align:right;">${t.rate || 0}</td>
            <td style="padding: 8px; text-align:right;">${parseFloat(t.gross_freight).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
            <td style="padding: 8px; text-align:right;">${parseFloat(t.shortage_amt).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
            <td style="padding: 8px; text-align:right;">0.00</td>
            <td style="padding: 8px; text-align:right;">0.00</td>
            <td style="padding: 8px; text-align:right;">0.00</td>
            <td style="padding: 8px; text-align:right; font-weight: bold;">${parseFloat(t.net_payable).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
          </tr>
        `;
      });
      rowsHTML += `
        <tr style="border-bottom: 2px solid #000; font-weight: bold; font-size:12px;">
          <td colspan="6" style="text-align:right; padding:8px;">Subtotal for Vehicle:</td>
          <td style="text-align:right; padding:8px;">${vehGross.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
          <td style="text-align:right; padding:8px;">${vehPenalty.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
          <td style="text-align:right; padding:8px;">0.00</td>
          <td style="text-align:right; padding:8px;">0.00</td>
          <td style="text-align:right; padding:8px;">0.00</td>
          <td style="text-align:right; padding:8px;">${vehNet.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
        </tr>
      `;
    });

    const html = `
      <html>
        <head>
          <title>Invoice - ${bill.bill_no}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; font-size: 13px; }
            .header { text-align: center; margin-bottom: 20px; }
            .title { font-size: 22px; font-weight: 900; margin: 0; text-transform: uppercase; }
            .bill-info { display: flex; justify-content: space-between; margin-bottom: 20px; padding: 15px; border: 1px solid #000; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #000; padding: 6px; }
            th { background: #f0f0f0; text-align: center; font-size: 11px; }
            @media print { body { padding: 0; } th { background: #e2e8f0 !important; -webkit-print-color-adjust: exact; } }
          </style>
        </head>
        <body>
          <div class="header">
            <h1 class="title">${bill.company || 'PRASAD TRANSPORT'}</h1>
            <p style="margin: 5px 0;">TAX INVOICE / TRANSPORTATION BILL</p>
            <p style="margin: 0; font-size:11px;">Reverse Charge Mechanism | GST Payable by Consignee</p>
          </div>
          
          <div class="bill-info">
            <div>
              <p style="margin: 0 0 5px 0;"><strong>Billed To / Ship-to-Party:</strong></p>
              <h3 style="margin: 0;">${bill.customer_name}</h3>
            </div>
            <div style="text-align: right;">
              <p style="margin: 0 0 5px 0;"><strong>Invoice No:</strong> ${bill.bill_no}</p>
              <p style="margin: 0;"><strong>Date:</strong> ${new Date(bill.bill_date).toLocaleDateString('en-IN')}</p>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>S.No</th>
                <th>Trip / LR No</th>
                <th>Load Dt</th>
                <th>Unload Dt</th>
                <th>Qty</th>
                <th>Rate</th>
                <th>Gross Amt (Rs)</th>
                <th>Penalty/Short (Rs)</th>
                <th>IGST (Rs)</th>
                <th>CGST (Rs)</th>
                <th>SGST (Rs)</th>
                <th>Net Payable (Rs)</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHTML}
              <tr style="font-weight: 900; font-size: 14px; background: #e2e8f0;">
                <td colspan="6" style="padding: 10px; text-align: right;">GRAND TOTAL EXPECTED:</td>
                <td style="padding: 10px; text-align: right;">${parseFloat(bill.total_gross).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                <td style="padding: 10px; text-align: right;">${parseFloat(bill.total_shortage_deduction).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                <td colspan="3"></td>
                <td style="padding: 10px; text-align: right;">${parseFloat(bill.total_net_expected).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
              </tr>
            </tbody>
          </table>

          <p style="font-size: 11px; margin-top:10px;">* GST payable by Consignee under Reverse Charge. TDS deducted as applicable (Sec 194C).</p>
          
          <div style="margin-top: 50px; display: flex; justify-content: space-between;">
            <div>
              <p style="margin: 0;"><strong>Bank Details for NEFT/RTGS:</strong></p>
              <p style="margin: 5px 0 0 0; font-size: 12px;">A/C Name: Prasad Transport<br/>A/C No: 502000XXXXXX<br/>IFSC: HDFC000XXXX</p>
            </div>
            <div style="text-align: center;">
              <p style="margin: 0 0 40px 0;"><strong>For ${bill.company || 'Prasad Transport'}</strong></p>
              <p style="margin: 0; border-top: 1px solid #000; padding-top: 5px;">Authorized Signatory</p>
            </div>
          </div>
        </body>
      </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  };

  const filteredTripAdjustments = tripAdjustments.filter(t => 
    t.vehicle_no?.toLowerCase().includes(tripSearchTerm.toLowerCase()) || 
    t.trip_id?.toLowerCase().includes(tripSearchTerm.toLowerCase()) ||
    t.lr_no?.toLowerCase().includes(tripSearchTerm.toLowerCase())
  );

  const filteredUnbilledTrips = unbilledTrips.filter(t => {
    let matchDate = true;
    const tDate = t.unloading_date || t.Unloading_Date || t.date || '';
    if (fromDate && tDate && tDate < fromDate) matchDate = false;
    if (toDate && tDate && tDate > toDate) matchDate = false;

    const custName = t.customer_name || t.Customer || t.Registered_Assessee || 'Unknown';
    const matchCustomer = selectedCustomer === 'ALL' || custName === selectedCustomer;
    
    let matchSearch = true;
    if(searchQuery) {
      const q = searchQuery.toLowerCase();
      matchSearch = (t.trip_id || '').toLowerCase().includes(q) || 
                    (t.vehicle_no || '').toLowerCase().includes(q) ||
                    (t.lr_no || '').toLowerCase().includes(q);
    }
    return matchDate && matchCustomer && matchSearch;
  });

  const filteredGeneratedBills = generatedBills.filter(b => {
    let matchDate = true;
    const bDate = b.bill_date || (b.createdAt ? new Date(b.createdAt.toDate()).toISOString().split('T')[0] : '');
    if (fromDate && bDate && bDate < fromDate) matchDate = false;
    if (toDate && bDate && bDate > toDate) matchDate = false;

    const custName = b.customer_name || 'Unknown';
    const matchCustomer = selectedCustomer === 'ALL' || custName === selectedCustomer;

    let matchSearch = true;
    if(searchQuery) {
      const q = searchQuery.toLowerCase();
      matchSearch = (b.bill_no || '').toLowerCase().includes(q) || 
                    (b.customer_name || '').toLowerCase().includes(q);
    }
    return matchDate && matchCustomer && matchSearch;
  });

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 12px 25px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); }
        .glow-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(16, 185, 129, 0.6); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; transition: 0.3s; colorScheme: dark; }
        .modern-input:focus { border-color: #38bdf8; background: rgba(15, 23, 42, 0.9); }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; letter-spacing: 1px; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px', fontWeight: '900', letterSpacing: '-0.5px' }}>Company Billing & Reconciliation</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Auto-generate bills, Verify, Edit, Delete & Cross-Check Payments</p>
        </div>
      </div>

      {/* 📄 SCAN PURCHASE BILL (local Gemma 4 vision → record + journal) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginBottom: '20px', background: 'rgba(192,132,252,0.06)', padding: '15px', border: '1px dashed #c084fc', borderRadius: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '220px' }}>
          <div style={{ color: '#c084fc', fontWeight: 'bold', fontSize: '14px' }}>📄 Scan Purchase Bill <span style={{ fontSize: '10px', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '1px 6px' }}>100% LOCAL</span></div>
          <div style={{ color: '#94a3b8', fontSize: '12px' }}>Vendor/pump bill (PDF/photo) upload → Gemma 4 padhega → record + journal auto-update.</div>
          {scannedBill && <div style={{ marginTop: '6px', fontSize: '12px', color: '#10b981' }}>✅ {scannedBill.vendor_name} · Bill {scannedBill.bill_no} · ₹{Number(scannedBill.total_amount).toLocaleString('en-IN')}</div>}
        </div>
        <label className="pt-btn pt-btn--ai" style={{ cursor: scanningBill ? 'not-allowed' : 'pointer' }}>
          {scanningBill ? '⏳ Scanning…' : '📎 Upload & Scan'}
          <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleScanPurchaseBill} disabled={scanningBill} />
        </label>
      </div>

      {/* 📅 GLOBAL FILTERS */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#1e293b', padding: '15px', borderRadius: '10px', border: '1px solid #334155', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 200px' }}>
            <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>👤 Select Customer Filter</label>
            <select value={selectedCustomer} onChange={e => setSelectedCustomer(e.target.value)} className="modern-input" style={{ marginTop: '5px', cursor: 'pointer' }}>
               <option value="ALL">-- All Customers --</option>
               {customersList.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
        </div>
        <div style={{ flex: '1 1 200px' }}>
            <label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold' }}>From Date</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="modern-input" style={{ marginTop: '5px' }}/>
        </div>
        <div style={{ flex: '1 1 200px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold' }}>To Date</label>
              {(fromDate || toDate) && <span onClick={() => {setFromDate(''); setToDate('');}} style={{ color: '#ef4444', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>❌ Clear</span>}
            </div>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="modern-input" style={{ marginTop: '5px' }}/>
        </div>
        <div style={{ flex: '2 1 250px' }}>
            <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold' }}>🔍 Search Trip / Invoice / Vehicle</label>
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Type to search..." className="modern-input" style={{ marginTop: '5px' }}/>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'UNBILLED_TRIPS' ? 'active' : ''}`} onClick={() => setActiveTab('UNBILLED_TRIPS')}>🚚 UNBILLED TRIPS {filteredUnbilledTrips.length > 0 && <span style={{background: '#ef4444', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '10px', marginLeft: '5px'}}>{filteredUnbilledTrips.length}</span>}</button>
        <button className={`tab-btn ${activeTab === 'GENERATED_BILLS' ? 'active' : ''}`} onClick={() => setActiveTab('GENERATED_BILLS')}>🧾 GENERATED INVOICES</button>
      </div>

      {activeTab === 'UNBILLED_TRIPS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #10b981' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#10b981', margin: 0 }}>Trips Ready for Billing</h3>
            {selectedTripsForBill.length > 0 && (
              <button className="glow-btn" onClick={handleGenerateInvoice}>
                🧾 Generate Bulk Invoice ({selectedTripsForBill.length} Trips)
              </button>
            )}
          </div>
          
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Unbilled Trips...</p> : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
                    <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#10b981' }} title="Select All Filtered Trips" onChange={(e) => handleSelectAllTrips(e, filteredUnbilledTrips)} checked={filteredUnbilledTrips.length > 0 && selectedTripsForBill.length === filteredUnbilledTrips.length} />
                  </th>
                  <th>Dates (Ld / Unld)</th>
                  <th>Trip ID / LR</th>
                  <th>Vehicle No</th>
                  <th>Qty x Rate</th>
                  <th style={{ textAlign: 'right' }}>Gross (₹)</th>
                  <th style={{ textAlign: 'right' }}>Short/Pen (₹)</th>
                  <th style={{ textAlign: 'right', color: '#f59e0b' }}>TDS (2%)</th>
                  <th style={{ textAlign: 'right', color: '#10b981' }}>Net Pay (₹)</th>
                </tr>
              </thead>
              <tbody>
                {filteredUnbilledTrips.length === 0 ? <tr><td colSpan={9} style={{ textAlign: 'center', padding: '30px' }}>No Unbilled Trips found. Complete unloads first or clear filters.</td></tr> : 
                  filteredUnbilledTrips.map(t => (
                  <tr key={t.id} style={{ background: selectedTripsForBill.includes(t.id) ? 'rgba(16,185,129,0.1)' : 'transparent', transition: '0.2s' }}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#10b981' }} checked={selectedTripsForBill.includes(t.id)} onChange={() => toggleTripSelection(t.id)} />
                    </td>
                    <td>
                      <div style={{fontSize:'11px', color:'#94a3b8'}}>Ld: {t.loading_date || t.start_date || t.date || '-'}</div>
                      <div style={{fontSize:'12px', fontWeight:'bold', color:'#fff'}}>Un: {t.unloading_date || t.Unloading_Date || '-'}</div>
                    </td>
                    <td style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold' }}>{t.trip_id || t.Trip_ID} <br/> <span style={{color:'#f59e0b'}}>{t.lr_no || t.lr_number || ''}</span></td>
                    <td style={{ fontWeight: '900', color: '#fff', fontSize: '14px' }}>{t.vehicle_no || t.Vehical_No || t.vehical_no} <br/><span style={{fontSize:'10px', color:'#94a3b8', fontWeight:'normal'}}>{t.customer_name || t.Customer}</span></td>
                    <td style={{ fontSize: '12px' }}>{t.calc_qty} <span style={{color:'#64748b'}}>x</span> {t.calc_rate}</td>
                    <td style={{ color: '#38bdf8', fontWeight: 'bold', textAlign: 'right' }}>{t.calc_gross.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style={{ color: '#ef4444', fontWeight: 'bold', textAlign: 'right' }}>{t.calc_penalty.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style={{ color: '#f59e0b', fontWeight: 'bold', textAlign: 'right' }}>{t.calc_tds.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style={{ color: '#10b981', fontWeight: 'bold', textAlign: 'right', fontSize:'15px' }}>{t.calc_net.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'GENERATED_BILLS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #38bdf8' }}>
          <h3 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '15px' }}>Generated Invoices Tracking</h3>
          <table>
            <thead>
              <tr><th>Bill Date</th><th>Invoice No / Party</th><th>Trips Included</th><th style={{ textAlign: 'right' }}>TDS Cut</th><th style={{ textAlign: 'right' }}>Expected Net Pay</th><th>Status</th><th style={{ textAlign: 'center' }}>Action</th></tr>
            </thead>
            <tbody>
              {filteredGeneratedBills.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No Invoices found.</td></tr> : 
                filteredGeneratedBills.map((b, i) => (
                <tr key={i}>
                  <td>{b.bill_date || (b.createdAt && new Date(b.createdAt.toDate()).toISOString().split('T')[0])}</td>
                  <td><b style={{ color: '#fff', fontSize: '15px' }}>{b.bill_no}</b> <br/><small style={{ color: '#94a3b8', fontWeight: 'bold' }}>{b.customer_name}</small></td>
                  <td><span className="badge" style={{ background: '#334155', color: '#fff', fontSize: '11px' }}>{b.trips?.length || 0} Trips</span></td>
                  <td style={{ color: '#f59e0b', fontWeight: 'bold', textAlign: 'right' }}>₹{parseFloat(b.total_tds_deduction || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                  <td style={{ color: '#10b981', fontWeight: '900', fontSize: '15px', textAlign: 'right' }}>₹{parseFloat(b.total_net_expected).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                  <td>
                    <span className="badge" style={{ background: b.status === 'SETTLED' ? 'rgba(16,185,129,0.2)' : b.status === 'PARTIALLY_PAID' ? 'rgba(56,189,248,0.2)' : 'rgba(245,158,11,0.2)', color: b.status === 'SETTLED' ? '#10b981' : b.status === 'PARTIALLY_PAID' ? '#38bdf8' : '#f59e0b', border: `1px solid ${b.status === 'SETTLED' ? '#10b981' : b.status === 'PARTIALLY_PAID' ? '#38bdf8' : '#f59e0b'}` }}>
                      {b.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                      <button onClick={() => handlePrintInvoice(b)} style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }} title="Print Invoice">
                        🖨️
                      </button>
                      <button onClick={() => openAdjustmentModal(b)} style={{ background: '#f59e0b', color: '#000', border: 'none', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }} title="Smart Checklist & Settle Payment">
                        ⚖️ Edit / Settle
                      </button>
                      <button onClick={() => handleDeleteBill(b)} style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '8px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' }} title="Delete Bill & Revert Trips">
                        🗑️
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ⚖️ MODAL: SMART MANUAL CHECKLIST & SETTLEMENT */}
      {isAdjustModalOpen && selectedBill && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1200px', border: '1px solid #f59e0b', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <div>
                <h2 style={{ margin: 0, color: '#f59e0b', fontSize: '24px' }}>📝 Smart Invoice Checklist & Edit</h2>
                <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '13px' }}>Bill No: <b style={{color: '#fff'}}>{selectedBill.bill_no}</b> | Client: <b style={{color: '#fff'}}>{selectedBill.customer_name}</b></p>
              </div>
              <button onClick={() => setIsAdjustModalOpen(false)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.3)', padding: '20px', borderRadius: '12px', marginBottom: '25px', overflowX: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h4 style={{ margin: 0, color: '#38bdf8', fontSize: '16px' }}>✔️ Manual Checklist: Select Trips to Pay & Edit Amounts</h4>
                <input type="text" placeholder="🔍 Search inside bill (LR, Vehicle)..." value={tripSearchTerm} onChange={e => setTripSearchTerm(e.target.value)} className="modern-input" style={{ width: '250px', padding: '8px 15px', borderRadius: '20px' }} />
              </div>
              
              <table style={{ width: '100%', textAlign: 'left', fontSize: '12px', minWidth: '800px' }}>
                <thead style={{ color: '#94a3b8', background: 'rgba(0,0,0,0.3)' }}>
                  <tr>
                    <th style={{padding: '10px', textAlign: 'center'}}>Tick to Pay</th>
                    <th style={{padding: '10px'}}>Vehicle No & Trip</th>
                    <th style={{padding: '10px'}}>Gross (₹)</th>
                    <th style={{padding: '10px'}}>TDS Cut (₹) Edit</th>
                    <th style={{padding: '10px'}}>Net Passed (₹) Edit</th>
                    <th style={{padding: '10px'}}>Extra Shortage (₹) Edit</th>
                    <th style={{padding: '10px', textAlign: 'center'}}>Recover?</th>
                    <th style={{padding: '10px', textAlign: 'center'}}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTripAdjustments.length === 0 ? <tr><td colSpan={8} style={{textAlign:'center', padding:'20px'}}>No trips match your search.</td></tr> :
                   filteredTripAdjustments.map((trip, idx) => {
                    const globalIdx = tripAdjustments.findIndex(t => t.trip_id === trip.trip_id); 
                    return (
                    <tr key={globalIdx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: trip.payment_status === 'SETTLED' ? 'rgba(16,185,129,0.05)' : trip.selected_for_payment ? 'rgba(56,189,248,0.1)' : 'transparent' }}>
                      <td style={{ textAlign: 'center', padding: '10px' }}>
                        {trip.payment_status !== 'SETTLED' ? (
                          <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#38bdf8' }} checked={trip.selected_for_payment} onChange={e => handleTripSelection(globalIdx, e.target.checked)} />
                        ) : '✅'}
                      </td>
                      <td style={{ fontWeight: 'bold', color: '#fff', padding: '10px' }}>
                        {trip.vehicle_no} <br/> <span style={{fontSize:'10px', color:'#94a3b8'}}>{trip.trip_id} | {trip.lr_no || ''}</span>
                      </td>
                      <td style={{ color: '#38bdf8', padding: '10px', fontWeight: 'bold' }}>{parseFloat(trip.gross_freight).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                      
                      <td style={{ padding: '10px' }}>
                        <input type="number" className="modern-input" disabled={trip.payment_status === 'SETTLED'} style={{ border: '1px solid #f59e0b', padding: '8px', width: '90px' }} value={trip.tds_amt} onChange={e => handleTripShortageChange(globalIdx, 'tds_amt', e.target.value)} placeholder="0.00" />
                      </td>
                      <td style={{ padding: '10px' }}>
                        <input type="number" className="modern-input" disabled={trip.payment_status === 'SETTLED'} style={{ border: '1px solid #10b981', padding: '8px', color: '#10b981', fontWeight: 'bold', width: '110px' }} value={trip.final_passed_amt} onChange={e => handleTripShortageChange(globalIdx, 'final_passed_amt', e.target.value)} placeholder="0.00" />
                      </td>
                      <td style={{ padding: '10px' }}>
                        <input type="number" className="modern-input" disabled={trip.payment_status === 'SETTLED'} style={{ border: '1px solid #ef4444', padding: '8px', color: '#ef4444', fontWeight: 'bold', width: '100px' }} value={trip.extra_shortage_amt} onChange={e => handleTripShortageChange(globalIdx, 'extra_shortage_amt', e.target.value)} placeholder="0.00" />
                      </td>
                      <td style={{ textAlign: 'center', padding: '10px' }}>
                        <input type="checkbox" disabled={trip.payment_status === 'SETTLED'} style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#ef4444' }} checked={trip.recover_from_driver} onChange={e => handleTripShortageChange(globalIdx, 'recover_from_driver', e.target.checked)} />
                      </td>
                      <td style={{ textAlign: 'center', padding: '10px' }}>
                        <span style={{ fontSize: '10px', fontWeight: 'bold', color: trip.payment_status === 'SETTLED' ? '#10b981' : '#f59e0b' }}>{trip.payment_status || 'PENDING'}</span>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>

            <h4 style={{ color: '#fff', margin: '0 0 15px 0', fontSize: '16px' }}>💰 Final Payment to Bank Ledger</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Total Amount Received for Checked Trips (₹) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #10b981', fontSize: '24px', fontWeight: '900', color: '#10b981', background: '#020617' }} value={adjustmentData.received_amount} readOnly placeholder="0.00" />
              </div>
              <div>
                <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold' }}>Bank Account Deposited To *</label>
                <select className="modern-input" value={adjustmentData.deposit_bank} onChange={e=>setAdjustmentData({...adjustmentData, deposit_bank: e.target.value})} style={{ border: '1px solid #38bdf8' }}>
                  {bankAccounts.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>Payment Remarks / UTR No</label>
                <input className="modern-input" value={adjustmentData.remarks} onChange={e=>setAdjustmentData({...adjustmentData, remarks: e.target.value})} placeholder="e.g. UTR123456789" />
              </div>
            </div>

            <button style={{ width: '100%', marginTop: '30px', padding: '16px', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '16px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 5px 15px rgba(16,185,129,0.4)' }} onClick={handleSettlePayment}>
              💸 Record Manual Payment & Update Ledgers
            </button>
          </div>
        </div>
      )}
    </div>
  );
}