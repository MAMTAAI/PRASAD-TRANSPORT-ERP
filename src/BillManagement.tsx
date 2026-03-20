// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from './firebase';

export default function BillManagement() {
  const [activeTab, setActiveTab] = useState('UNBILLED_TRIPS'); 
  const [unbilledTrips, setUnbilledTrips] = useState<any[]>([]);
  const [generatedBills, setGeneratedBills] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  
  const [selectedTripsForBill, setSelectedTripsForBill] = useState<string[]>([]);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [selectedBill, setSelectedBill] = useState<any>(null);
  
  // 🌟 NEW: Trip Wise Editing State
  const [tripAdjustments, setTripAdjustments] = useState<any[]>([]);
  const [adjustmentData, setAdjustmentData] = useState({ received_amount: '', tds_deducted: '', remarks: '' });

  useEffect(() => {
    fetchUnbilledTrips();
    fetchGeneratedBills();
  }, []);

  const fetchUnbilledTrips = async () => {
    setLoading(true);
    try {
      // 🚫 BLOCK TRIP ENTRY: Only fetches PENDING trips. Billed trips are blocked.
      const q = query(collection(db, "TRIPS"), where("billing_status", "==", "PENDING"));
      const snap = await getDocs(q);
      let tripsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      tripsData = tripsData.filter(t => t.trip_status === "COMPLETED" || t.trip_status === "UNLOADED" || t.Trip_Status === "COMPLETED" || t.Trip_Status === "UNLOADED");
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

  // 🎤 MAMTA AI - ULTRA PREMIUM NEURAL VOICE
  const speakSmartHinglishReport = async (text: string) => {
      try {
          const response = await fetch("https://prasad-api.onrender.com/speak", {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text })
          });
          const data = await response.json();
          if (data.success && data.audioContent) {
              const audioSrc = `data:audio/mp3;base64,${data.audioContent}`;
              const audio = new Audio(audioSrc);
              audio.play(); 
          }
      } catch (error) { console.error("Voice Error:", error); }
  };

  const toggleTripSelection = (tripId: string) => {
    setSelectedTripsForBill(prev => prev.includes(tripId) ? prev.filter(id => id !== tripId) : [...prev, tripId]);
  };

  const handleGenerateInvoice = async () => {
    if (selectedTripsForBill.length === 0) return alert("⚠️ Select at least one trip to generate a bill!");
    
    setLoading(true);
    try {
      const selectedTripData = unbilledTrips.filter(t => selectedTripsForBill.includes(t.id));
      const customerName = selectedTripData[0].customer_name || selectedTripData[0].Customer || selectedTripData[0].Registered_Assessee || 'Corporate Customer';
      
      const totalFreight = selectedTripData.reduce((acc, curr) => acc + parseFloat(curr.gross_freight || curr.Gross_Freight || 0), 0);
      const totalShortage = selectedTripData.reduce((acc, curr) => acc + parseFloat(curr.shortage_amt || curr.Shortage_Amt || curr.shortage || 0), 0);
      const expectedNet = totalFreight - totalShortage;

      const newBillNo = `INV-${customerName.substring(0,3).toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`;

      await addDoc(collection(db, "COMPANY_BILLS"), {
        bill_no: newBillNo,
        customer_name: customerName,
        bill_date: new Date().toISOString().split('T')[0],
        total_gross: totalFreight,
        total_shortage_deduction: totalShortage,
        total_net_expected: expectedNet,
        status: 'PENDING_PAYMENT',
        trips: selectedTripData.map(t => ({ 
          trip_id: t.trip_id || t.Trip_ID, 
          vehicle_no: t.vehicle_no || t.Vehical_No, 
          driver_name: t.driver_name || t.Driver_Name || 'N/A', 
          gross_freight: t.gross_freight || t.Gross_Freight || '0', 
          shortage_amt: t.shortage_amt || t.shortage || '0' 
        })),
        createdAt: serverTimestamp()
      });

      for (let tripId of selectedTripsForBill) {
        await updateDoc(doc(db, "TRIPS", tripId), { billing_status: 'BILLED', linked_bill_no: newBillNo });
      }

      alert(`✅ Invoice ${newBillNo} Generated Successfully!`);
      speakSmartHinglishReport(`सुभाष सर, इनवॉइस ${newBillNo} सफलतापूर्वक जनरेट हो गया है।`);
      
      setSelectedTripsForBill([]);
      fetchUnbilledTrips();
      fetchGeneratedBills();
      setActiveTab('GENERATED_BILLS');

    } catch (error) { alert("❌ Error generating invoice!"); console.error(error); }
    setLoading(false);
  };

  const openAdjustmentModal = (bill: any) => {
    setSelectedBill(bill);
    setFileName('');
    // 🌟 Initialize Trip-Wise Data Table
    const initialTrips = bill.trips.map((t: any) => ({ 
      ...t, 
      final_passed_amt: (parseFloat(t.gross_freight) - parseFloat(t.shortage_amt)).toFixed(2),
      tds_amt: (parseFloat(t.gross_freight) * 0.02).toFixed(2),
      extra_shortage_amt: 0, 
      recover_from_driver: true 
    }));
    setTripAdjustments(initialTrips);
    setAdjustmentData({ received_amount: '', tds_deducted: '', remarks: '' });
    setIsAdjustModalOpen(true);
  };

  // 🤖 1. AUTO-FETCH EMAILS FOR RECONCILIATION
  const handleAutoFetchEmailAdvice = async () => {
    setIsProcessing(true);
    try {
      const response = await fetch('https://prasad-api.onrender.com/fetch-iocl-bills', { method: 'POST' });
      const result = await response.json();

      if (result.success && result.aiData && result.aiData.trips) {
        const crossCheckedData = tripAdjustments.map((t: any) => {
          const partyData = result.aiData.trips.find((pt: any) => pt.vehicleNumber && pt.vehicleNumber.replace(/[^A-Za-z0-9]/g, '') === t.vehicle_no.replace(/[^A-Za-z0-9]/g, ''));
          if (partyData) {
            let extraShort = Math.max(0, parseFloat(t.gross_freight) - parseFloat(t.shortage_amt) - parseFloat(partyData.netPayable) - parseFloat(partyData.tdsDeducted || 0)).toFixed(2);
            return {
              ...t,
              tds_amt: partyData.tdsDeducted || t.tds_amt,
              final_passed_amt: partyData.netPayable || t.final_passed_amt,
              extra_shortage_amt: extraShort
            };
          }
          return t;
        });

        setTripAdjustments(crossCheckedData);
        alert("🤖 Mamta AI Success! IOCL Bill fetched and cross-checked trip-wise.");
        speakSmartHinglishReport(`ईमेल से पेमेंट एडवाइस फेच हो गई है। हर ट्रिप का डेटा मिला लिया गया है।`);
      } else {
        alert("⚠️ No matching payment advice found in Gmail.");
      }
    } catch (e) { alert("❌ Live Server error. Please check your Render backend."); }
    setIsProcessing(false);
  };

  // 🤖 2. MANUAL PDF/FILE UPLOAD & MAMTA AI SCAN
  const handleFileUpload = async (e: any) => {
    const file = e.target.files[0]; 
    if (!file) return; 
    setFileName(file.name); 
    setIsProcessing(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('driverName', 'Company_Bill_Advice');
    formData.append('docType', 'PAYMENT_ADVICE');

    try {
      const response = await fetch('https://prasad-api.onrender.com/upload-to-drive', {
        method: 'POST', body: formData
      });
      const result = await response.json();

      if (result.success && result.aiData) {
        const ai = result.aiData;
        
        // Map AI Data to Trips (Smart Assignment)
        const crossCheckedData = tripAdjustments.map((t: any) => {
          let tds = (parseFloat(t.gross_freight) * 0.02).toFixed(2);
          let passed = (parseFloat(t.gross_freight) - parseFloat(t.shortage_amt)).toFixed(2);
          let extraShort = 0;

          // If AI detected a specific vehicle matching this trip
          if (ai.vehicleNumber && ai.vehicleNumber.replace(/[^A-Za-z0-9]/g, '') === t.vehicle_no.replace(/[^A-Za-z0-9]/g, '')) {
            if (ai.totalAmount) {
              passed = ai.totalAmount;
              extraShort = Math.max(0, parseFloat(t.gross_freight) - parseFloat(t.shortage_amt) - parseFloat(passed) - parseFloat(tds));
            }
          }

          return { ...t, tds_amt: tds, final_passed_amt: passed, extra_shortage_amt: extraShort.toFixed(2) };
        });

        setTripAdjustments(crossCheckedData);
        alert("✅ PDF Advice Scanned & Auto-Mapped Trip-Wise!");
        speakSmartHinglishReport(`पेमेंट एडवाइस पीडीएफ स्कैन हो गई है। ट्रिप के हिसाब से कटौती और टीडीएस भर दिया गया है। कृपया चेक करें।`);
      } else {
        alert("❌ AI could not read the document properly.");
      }
    } catch (error) {
      alert("❌ Live Server is unreachable.");
    }
    setIsProcessing(false);
  };

  // ✍️ Trip-Wise Manual Editing Function
  const handleTripShortageChange = (index: number, field: string, value: any) => {
    const updated = [...tripAdjustments]; 
    updated[index][field] = value; 
    
    // Auto-calculate Total Received dynamically
    let totalRcv = 0;
    let totalTds = 0;
    updated.forEach(t => {
      totalRcv += parseFloat(t.final_passed_amt || 0);
      totalTds += parseFloat(t.tds_amt || 0);
    });
    setAdjustmentData(prev => ({ ...prev, received_amount: totalRcv.toFixed(2), tds_deducted: totalTds.toFixed(2) }));
    setTripAdjustments(updated);
  };

  const handleSettlePayment = async () => {
    if (!adjustmentData.received_amount) return alert("⚠️ Enter Received Amount!");
    try {
      let totalExtraShortage = 0;
      for (let trip of tripAdjustments) {
        totalExtraShortage += parseFloat(trip.extra_shortage_amt || 0);
        if (parseFloat(trip.extra_shortage_amt) > 0 && trip.recover_from_driver) {
          await addDoc(collection(db, "DRIVER_TRANSACTIONS"), {
            driver_name: trip.driver_name, vehicle_no: trip.vehicle_no, trip_id: trip.trip_id,
            txn_type: 'SHORTAGE_DEDUCTION', amount: parseFloat(trip.extra_shortage_amt), date: new Date().toISOString().split('T')[0],
            remarks: `Party extra deduction on Bill ${selectedBill.bill_no}`, createdAt: serverTimestamp()
          });
        }
      }
      await updateDoc(doc(db, "COMPANY_BILLS", selectedBill.id), {
        status: 'SETTLED',
        settlement_details: { ...adjustmentData, extra_shortage_cut: totalExtraShortage, settlement_date: new Date().toISOString().split('T')[0] },
        trips: tripAdjustments 
      });
      alert("✅ Payment Settled & Driver Khata Updated!");
      speakSmartHinglishReport(`पेमेंट का हिसाब पूरा हो गया है। ड्राइवर के खाते में शॉर्टेज काट ली गई है।`);
      
      setIsAdjustModalOpen(false); fetchGeneratedBills();
    } catch (e) { alert("❌ Error settling bill."); }
  };

  const handlePrintInvoice = (bill: any) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to print invoices.");

    const rows = bill.trips.map((t: any, i: number) => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px; text-align: center;">${i + 1}</td>
        <td style="padding: 12px; font-weight: bold;">${t.vehicle_no}</td>
        <td style="padding: 12px;">${t.trip_id}</td>
        <td style="padding: 12px; text-align: right;">₹${parseFloat(t.gross_freight).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
        <td style="padding: 12px; text-align: right; color: red;">- ₹${parseFloat(t.shortage_amt).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
        <td style="padding: 12px; text-align: right; font-weight: bold;">₹${(parseFloat(t.gross_freight) - parseFloat(t.shortage_amt)).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
      </tr>
    `).join('');

    const html = `
      <html>
        <head>
          <title>Invoice - ${bill.bill_no}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; color: #0f172a; }
            .header { text-align: center; margin-bottom: 30px; }
            .title { font-size: 28px; font-weight: 900; margin: 0; color: #1e293b; text-transform: uppercase; letter-spacing: 1px; }
            .subtitle { font-size: 14px; color: #64748b; margin-top: 5px; }
            .bill-info { display: flex; justify-content: space-between; margin-bottom: 30px; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th { background: #1e293b; color: white; padding: 12px; text-align: left; }
            .total-row { background: #f1f5f9; font-weight: bold; font-size: 16px; }
            @media print { body { padding: 0; } .bill-info { border: 1px solid #000; } th { background: #000 !important; color: #fff !important; -webkit-print-color-adjust: exact; } }
          </style>
        </head>
        <body>
          <div class="header">
            <h1 class="title">PRASAD TRANSPORT GROUP</h1>
            <div class="subtitle">TAX INVOICE / FREIGHT BILL</div>
          </div>
          
          <div class="bill-info">
            <div>
              <p style="margin: 0 0 5px 0; color: #64748b; font-size: 12px;">Billed To:</p>
              <h3 style="margin: 0; font-size: 18px;">${bill.customer_name}</h3>
            </div>
            <div style="text-align: right;">
              <p style="margin: 0 0 5px 0;"><strong>Invoice No:</strong> ${bill.bill_no}</p>
              <p style="margin: 0;"><strong>Date:</strong> ${new Date(bill.bill_date).toLocaleDateString('en-IN')}</p>
              <p style="margin: 5px 0 0 0; color: ${bill.status === 'SETTLED' ? 'green' : 'red'};"><strong>Status:</strong> ${bill.status}</p>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th style="text-align: center;">S.No</th>
                <th>Vehicle No</th>
                <th>Trip ID</th>
                <th style="text-align: right;">Gross Freight</th>
                <th style="text-align: right;">Shortage Cut</th>
                <th style="text-align: right;">Net Payable</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr class="total-row">
                <td colspan="5" style="padding: 15px; text-align: right;">GRAND TOTAL EXPECTED:</td>
                <td style="padding: 15px; text-align: right; font-size: 18px;">₹${parseFloat(bill.total_net_expected).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
              </tr>
            </tbody>
          </table>

          <div style="margin-top: 80px; display: flex; justify-content: space-between;">
            <div>
              <p style="margin: 0;"><strong>Bank Details for NEFT/RTGS:</strong></p>
              <p style="margin: 5px 0 0 0; font-size: 12px; color: #475569;">A/C Name: Prasad Transport Group<br/>A/C No: 502000XXXXXX<br/>IFSC: HDFC000XXXX</p>
            </div>
            <div style="text-align: center;">
              <p style="margin: 0 0 40px 0;"><strong>For Prasad Transport Group</strong></p>
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

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 12px 25px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); }
        .glow-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(16, 185, 129, 0.6); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; transition: 0.3s; }
        .modern-input:focus { border-color: #38bdf8; background: rgba(15, 23, 42, 0.9); }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 15px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 15px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; letter-spacing: 1px; }
        .upload-zone { border: 2px dashed #38bdf8; padding: 25px; text-align: center; border-radius: 12px; background: rgba(56, 189, 248, 0.05); cursor: pointer; transition: 0.3s; height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center;}
        .upload-zone:hover { background: rgba(56, 189, 248, 0.1); }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px', fontWeight: '900', letterSpacing: '-0.5px' }}>Company Billing & Reconciliation</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Auto-generate bills from Unloaded Trips & Cross-Check Payments via Gmail / PDF Scan</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'UNBILLED_TRIPS' ? 'active' : ''}`} onClick={() => setActiveTab('UNBILLED_TRIPS')}>🚚 UNBILLED TRIPS {unbilledTrips.length > 0 && <span style={{background: '#ef4444', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '10px', marginLeft: '5px'}}>{unbilledTrips.length}</span>}</button>
        <button className={`tab-btn ${activeTab === 'GENERATED_BILLS' ? 'active' : ''}`} onClick={() => setActiveTab('GENERATED_BILLS')}>🧾 GENERATED INVOICES</button>
      </div>

      {activeTab === 'UNBILLED_TRIPS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #10b981' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ color: '#10b981', margin: 0 }}>Trips Ready for Billing</h3>
            {selectedTripsForBill.length > 0 && (
              <button className="glow-btn" onClick={handleGenerateInvoice}>
                🧾 Generate Invoice ({selectedTripsForBill.length} Trips)
              </button>
            )}
          </div>
          
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Loading Unbilled Trips...</p> : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: '50px' }}>Select</th><th>Unload Date</th><th>Trip ID</th><th>Vehicle No</th><th>Customer</th><th style={{ textAlign: 'right' }}>Gross Freight</th><th style={{ textAlign: 'right' }}>Shortage Cut</th>
                </tr>
              </thead>
              <tbody>
                {unbilledTrips.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No Unbilled Trips Available. Complete unloads first.</td></tr> : 
                  unbilledTrips.map(t => (
                  <tr key={t.id} style={{ background: selectedTripsForBill.includes(t.id) ? 'rgba(16,185,129,0.1)' : 'transparent', transition: '0.2s' }}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#10b981' }} checked={selectedTripsForBill.includes(t.id)} onChange={() => toggleTripSelection(t.id)} />
                    </td>
                    <td>{t.unloading_date || t.Unloading_Date || '-'}</td>
                    <td style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold' }}>{t.trip_id || t.Trip_ID}</td>
                    <td style={{ fontWeight: '900', color: '#fff', fontSize: '15px' }}>{t.vehicle_no || t.Vehical_No || t.vehical_no}</td>
                    <td>{t.customer_name || t.Customer || t.Registered_Assessee}</td>
                    <td style={{ color: '#38bdf8', fontWeight: 'bold', textAlign: 'right' }}>₹{parseFloat(t.gross_freight || t.Gross_Freight || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style={{ color: '#ef4444', fontWeight: 'bold', textAlign: 'right' }}>₹{parseFloat(t.shortage_amt || t.Shortage_Amt || t.shortage || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
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
              <tr><th>Bill Date</th><th>Invoice No / Party</th><th>Trips Included</th><th style={{ textAlign: 'right' }}>Expected Net Pay</th><th>Status</th><th style={{ textAlign: 'center' }}>Action</th></tr>
            </thead>
            <tbody>
              {generatedBills.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No Invoices Generated Yet.</td></tr> : 
                generatedBills.map((b, i) => (
                <tr key={i}>
                  <td>{b.bill_date || (b.createdAt && new Date(b.createdAt.toDate()).toISOString().split('T')[0])}</td>
                  <td><b style={{ color: '#fff', fontSize: '16px' }}>{b.bill_no}</b> <br/><small style={{ color: '#94a3b8', fontWeight: 'bold' }}>{b.customer_name}</small></td>
                  <td><span className="badge" style={{ background: '#334155', color: '#fff', fontSize: '11px' }}>{b.trips?.length || 0} Trips</span></td>
                  <td style={{ color: '#f59e0b', fontWeight: '900', fontSize: '16px', textAlign: 'right' }}>₹{parseFloat(b.total_net_expected).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                  <td>
                    <span className="badge" style={{ background: b.status === 'SETTLED' ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)', color: b.status === 'SETTLED' ? '#10b981' : '#f59e0b', border: `1px solid ${b.status === 'SETTLED' ? '#10b981' : '#f59e0b'}` }}>
                      {b.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                      <button onClick={() => handlePrintInvoice(b)} style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', transition: '0.2s' }} onMouseOver={e=>e.currentTarget.style.background='#38bdf8'} onMouseOut={e=>e.currentTarget.style.background='rgba(56, 189, 248, 0.1)'}>
                        🖨️ Print
                      </button>
                      {b.status !== 'SETTLED' ? (
                        <button onClick={() => openAdjustmentModal(b)} style={{ background: '#f59e0b', color: '#000', border: 'none', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', transition: '0.2s' }}>
                          ⚖️ Cross-Check & Settle
                        </button>
                      ) : <span style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', padding: '8px' }}>✅ Reconciled</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ⚖️ MODAL: CROSS-CHECK & SETTLEMENT */}
      {isAdjustModalOpen && selectedBill && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1100px', border: '1px solid #f59e0b', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <div>
                <h2 style={{ margin: 0, color: '#f59e0b', fontSize: '24px' }}>⚖️ Invoice Reconciliation (Trip Wise)</h2>
                <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '13px' }}>Bill No: <b style={{color: '#fff'}}>{selectedBill.bill_no}</b> | Client: <b style={{color: '#fff'}}>{selectedBill.customer_name}</b></p>
              </div>
              <button onClick={() => setIsAdjustModalOpen(false)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            
            {/* STEP 1: AI UPLOAD OR GMAIL FETCH */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '25px' }}>
              
              <div 
                onClick={handleAutoFetchEmailAdvice} 
                style={{ border: '2px dashed #8b5cf6', padding: '25px', textAlign: 'center', borderRadius: '12px', background: 'rgba(139, 92, 246, 0.05)', cursor: isProcessing ? 'not-allowed' : 'pointer', transition: '0.3s' }}
              >
                <div style={{ fontSize: '40px', marginBottom: '10px', animation: isProcessing ? 'bounce 1s infinite' : 'none' }}>📥</div>
                <div style={{ color: '#c084fc', fontWeight: 'bold', fontSize: '16px' }}>Auto-Fetch Bill from Gmail</div>
                <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '5px' }}>Mamta AI will read the Transportation Email</div>
              </div>

              {/* 🤖 NEW MANUAL AI UPLOAD */}
              <label className="upload-zone">
                <div style={{ fontSize: '40px', marginBottom: '10px' }}>📎</div>
                <div style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '16px' }}>{isProcessing && fileName ? `Scanning ${fileName}...` : 'Upload PDF/Image Payment Advice'}</div>
                <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '5px' }}>Mamta AI will scan and Auto-Fill below table</div>
                <input type="file" hidden accept="image/*,.pdf,.xlsx" onChange={handleFileUpload} disabled={isProcessing} />
              </label>

              <style>{`@keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }`}</style>
            </div>

            {/* ✍️ STEP 2: TRIP-WISE EDITING & DEDUCTIONS */}
            <div style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '20px', borderRadius: '12px', marginBottom: '25px', overflowX: 'auto' }}>
              <h4 style={{ margin: '0 0 15px 0', color: '#ef4444', fontSize: '16px' }}>✂️ Trip-Wise Verification & Deductions (Manual Edit Allowed)</h4>
              <table style={{ width: '100%', textAlign: 'left', fontSize: '12px', minWidth: '800px' }}>
                <thead style={{ color: '#94a3b8', background: 'rgba(0,0,0,0.3)' }}>
                  <tr>
                    <th style={{padding: '10px'}}>Vehicle No</th>
                    <th style={{padding: '10px'}}>Gross Freight (₹)</th>
                    <th style={{padding: '10px'}}>TDS Cut (₹)</th>
                    <th style={{padding: '10px'}}>Net Passed (₹)</th>
                    <th style={{padding: '10px'}}>Extra Shortage (₹)</th>
                    <th style={{padding: '10px', textAlign: 'center'}}>Recover from Driver?</th>
                  </tr>
                </thead>
                <tbody>
                  {tripAdjustments.map((trip, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ fontWeight: 'bold', color: '#fff', padding: '10px' }}>{trip.vehicle_no}</td>
                      <td style={{ color: '#38bdf8', padding: '10px', fontWeight: 'bold' }}>{parseFloat(trip.gross_freight).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                      <td style={{ padding: '10px' }}>
                        <input type="number" className="modern-input" style={{ border: '1px solid #f59e0b', padding: '8px', width: '90px' }} value={trip.tds_amt} onChange={e => handleTripShortageChange(idx, 'tds_amt', e.target.value)} placeholder="0.00" />
                      </td>
                      <td style={{ padding: '10px' }}>
                        <input type="number" className="modern-input" style={{ border: '1px solid #10b981', padding: '8px', color: '#10b981', fontWeight: 'bold', width: '110px' }} value={trip.final_passed_amt} onChange={e => handleTripShortageChange(idx, 'final_passed_amt', e.target.value)} placeholder="0.00" />
                      </td>
                      <td style={{ padding: '10px' }}>
                        <input type="number" className="modern-input" style={{ border: '1px solid #ef4444', padding: '8px', color: '#ef4444', fontWeight: 'bold', width: '100px' }} value={trip.extra_shortage_amt} onChange={e => handleTripShortageChange(idx, 'extra_shortage_amt', e.target.value)} placeholder="0.00" />
                      </td>
                      <td style={{ textAlign: 'center', padding: '10px' }}>
                        <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#ef4444' }} checked={trip.recover_from_driver} onChange={e => handleTripShortageChange(idx, 'recover_from_driver', e.target.checked)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: '11px', color: '#ef4444', margin: '10px 0 0 0', fontWeight: 'bold' }}>* If 'Recover' is checked, the Extra Shortage amount will be auto-debited from the Driver's Khata.</p>
            </div>

            {/* STEP 3: FINAL SETTLEMENT */}
            <h4 style={{ color: '#fff', margin: '0 0 15px 0', fontSize: '16px' }}>💰 Final Payment Details (Auto-Calculated from above table)</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Total Amount Received in Bank (₹) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #10b981', fontSize: '24px', fontWeight: '900', color: '#10b981' }} value={adjustmentData.received_amount} onChange={e=>setAdjustmentData({...adjustmentData, received_amount: e.target.value})} placeholder="e.g. 150000" />
              </div>
              <div>
                <label style={{ fontSize:'12px', color:'#f59e0b', fontWeight: 'bold' }}>Total TDS Deducted</label>
                <input type="number" className="modern-input" value={adjustmentData.tds_deducted} onChange={e=>setAdjustmentData({...adjustmentData, tds_deducted: e.target.value})} placeholder="0.00" />
              </div>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>Adjustment Remarks (UTR No)</label>
                <input className="modern-input" value={adjustmentData.remarks} onChange={e=>setAdjustmentData({...adjustmentData, remarks: e.target.value})} placeholder="e.g. UTR123456789" />
              </div>
            </div>

            <button style={{ width: '100%', marginTop: '30px', padding: '16px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#000', border: 'none', borderRadius: '10px', fontSize: '16px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 5px 15px rgba(245,158,11,0.4)' }} onClick={handleSettlePayment}>
              💸 Confirm Reconciliation & Settle Account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}