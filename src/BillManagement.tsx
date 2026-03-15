// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from './firebase';

export default function BillManagement() {
  const [activeTab, setActiveTab] = useState('UNBILLED_TRIPS'); // UNBILLED_TRIPS, GENERATED_BILLS, RECONCILIATION
  const [unbilledTrips, setUnbilledTrips] = useState<any[]>([]);
  const [generatedBills, setGeneratedBills] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Selection State for Invoice Generation
  const [selectedTripsForBill, setSelectedTripsForBill] = useState<string[]>([]);
  
  // Reconciliation States
  const [isProcessing, setIsProcessing] = useState(false);
  const [scannedData, setScannedData] = useState<any[]>([]);
  const [fileName, setFileName] = useState('');
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [selectedBill, setSelectedBill] = useState<any>(null);
  const [tripAdjustments, setTripAdjustments] = useState<any[]>([]);
  const [adjustmentData, setAdjustmentData] = useState({ received_amount: '', tds_deducted: '', remarks: '' });

  useEffect(() => {
    fetchUnbilledTrips();
    fetchGeneratedBills();
  }, []);

  // 1️⃣ FETCH COMPLETED TRIPS THAT ARE NOT BILLED YET
  const fetchUnbilledTrips = async () => {
    setLoading(true);
    try {
      // Logic: Fetch all completed trips where billing_status is PENDING
      const q = query(collection(db, "TRIPS"), where("trip_status", "in", ["COMPLETED", "UNLOADED"]), where("billing_status", "==", "PENDING"));
      const snap = await getDocs(q);
      setUnbilledTrips(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 2️⃣ FETCH GENERATED INVOICES
  const fetchGeneratedBills = async () => {
    try {
      const snap = await getDocs(collection(db, "COMPANY_BILLS"));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setGeneratedBills(data.sort((a:any, b:any) => new Date(b.bill_date).getTime() - new Date(a.bill_date).getTime()));
    } catch (e) { console.error(e); }
  };

  // 🧾 SELECT TRIPS TO GENERATE INVOICE
  const toggleTripSelection = (tripId: string) => {
    setSelectedTripsForBill(prev => prev.includes(tripId) ? prev.filter(id => id !== tripId) : [...prev, tripId]);
  };

  const handleGenerateInvoice = async () => {
    if (selectedTripsForBill.length === 0) return alert("Select at least one trip to generate a bill!");
    
    setLoading(true);
    try {
      const selectedTripData = unbilledTrips.filter(t => selectedTripsForBill.includes(t.id));
      const customerName = selectedTripData[0].customer_name || selectedTripData[0].Customer || 'Unknown Customer';
      
      // Calculate Totals
      const totalFreight = selectedTripData.reduce((acc, curr) => acc + parseFloat(curr.gross_freight || 0), 0);
      const totalShortage = selectedTripData.reduce((acc, curr) => acc + parseFloat(curr.shortage_amt || 0), 0);
      const expectedNet = totalFreight - totalShortage;

      const newBillNo = `INV-${customerName.substring(0,3).toUpperCase()}-${Math.floor(Math.random() * 10000)}`;

      // 1. Create the Bill Document
      const newBillRef = await addDoc(collection(db, "COMPANY_BILLS"), {
        bill_no: newBillNo,
        customer_name: customerName,
        bill_date: new Date().toISOString().split('T')[0],
        total_gross: totalFreight,
        total_shortage_deduction: totalShortage,
        total_net_expected: expectedNet,
        status: 'PENDING_PAYMENT',
        trips: selectedTripData.map(t => ({ trip_id: t.trip_id, vehicle_no: t.vehicle_no, driver_name: t.driver_name, gross_freight: t.gross_freight, shortage_amt: t.shortage_amt })),
        createdAt: serverTimestamp()
      });

      // 2. Mark those trips as BILLED in the TRIPS collection
      for (let tripId of selectedTripsForBill) {
        await updateDoc(doc(db, "TRIPS", tripId), { billing_status: 'BILLED', linked_bill_no: newBillNo });
      }

      alert(`✅ Invoice ${newBillNo} Generated Successfully!`);
      setSelectedTripsForBill([]);
      fetchUnbilledTrips();
      fetchGeneratedBills();
      setActiveTab('GENERATED_BILLS');

    } catch (error) { alert("Error generating invoice!"); console.error(error); }
    setLoading(false);
  };

  // 🤖 CROSS-CHECK (RECONCILIATION) UPLOAD LOGIC
  const handleFileUpload = (e: any) => {
    const file = e.target.files[0]; if (!file) return; 
    setFileName(file.name); setIsProcessing(true);

    const reader = new FileReader();
    reader.onload = async (event: any) => {
      // SIMULATE AI READING EXCEL/PDF FROM IOCL/BPCL
      setTimeout(() => {
        if (!selectedBill) return;
        // Mock data mapping to the selected bill's trips
        const crossCheckedData = selectedBill.trips.map((t: any) => ({
          ...t,
          party_approved_freight: parseFloat(t.gross_freight) - 500, // Simulating party deducted 500 extra
          tds_amt: (parseFloat(t.gross_freight) * 0.02).toFixed(0), // 2% TDS
          party_shortage_cut: t.shortage_amt, 
          final_passed_amt: (parseFloat(t.gross_freight) - 500 - (parseFloat(t.gross_freight) * 0.02) - parseFloat(t.shortage_amt)).toFixed(2)
        }));
        setScannedData(crossCheckedData);
        setIsProcessing(false);
      }, 2500); 
    };
    reader.readAsDataURL(file); 
  };

  const openAdjustmentModal = (bill: any) => {
    setSelectedBill(bill);
    setScannedData([]); setFileName('');
    const initialTrips = bill.trips.map((t: any) => ({ ...t, extra_shortage_amt: 0, recover_from_driver: true }));
    setTripAdjustments(initialTrips);
    setAdjustmentData({ received_amount: '', tds_deducted: '', remarks: '' });
    setIsAdjustModalOpen(true);
  };

  const handleTripShortageChange = (index: number, field: string, value: any) => {
    const updated = [...tripAdjustments]; updated[index][field] = value; setTripAdjustments(updated);
  };

  const handleSettlePayment = async () => {
    if (!adjustmentData.received_amount) return alert("Enter Received Amount!");
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
      setIsAdjustModalOpen(false); fetchGeneratedBills();
    } catch (e) { alert("Error settling bill."); }
  };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border: none; padding: 12px 25px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; }
        .tab-btn.active { color: #10b981; border-bottom: 3px solid #10b981; background: rgba(16, 185, 129, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .upload-zone { border: 2px dashed #38bdf8; padding: 40px; text-align: center; border-radius: 12px; background: rgba(56, 189, 248, 0.05); cursor: pointer; transition: 0.3s; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>Company Billing & Reconciliation</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Auto-generate bills from Unloaded Trips & Cross-Check Payments</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'UNBILLED_TRIPS' ? 'active' : ''}`} onClick={() => setActiveTab('UNBILLED_TRIPS')}>🚚 UNBILLED TRIPS {unbilledTrips.length > 0 && `(${unbilledTrips.length})`}</button>
        <button className={`tab-btn ${activeTab === 'GENERATED_BILLS' ? 'active' : ''}`} onClick={() => setActiveTab('GENERATED_BILLS')}>🧾 GENERATED INVOICES</button>
      </div>

      {/* 🚚 TAB 1: UNBILLED TRIPS (Select to generate Bill) */}
      {activeTab === 'UNBILLED_TRIPS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ color: '#10b981', margin: 0 }}>Trips Ready for Billing</h3>
            {selectedTripsForBill.length > 0 && (
              <button className="glow-btn" style={{ background: '#10b981' }} onClick={handleGenerateInvoice}>
                🧾 Generate Invoice ({selectedTripsForBill.length} Trips)
              </button>
            )}
          </div>
          
          {loading ? <p style={{ color: '#38bdf8' }}>Loading...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Select</th><th>Unload Date</th><th>Trip ID</th><th>Vehicle No</th><th>Customer</th><th>Gross Freight</th><th>Shortage Cut</th>
                </tr>
              </thead>
              <tbody>
                {unbilledTrips.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center' }}>No Unbilled Trips Available. Complete unloads first.</td></tr> : 
                  unbilledTrips.map(t => (
                  <tr key={t.id} style={{ background: selectedTripsForBill.includes(t.id) ? 'rgba(16,185,129,0.1)' : 'transparent' }}>
                    <td><input type="checkbox" style={{ transform: 'scale(1.5)' }} checked={selectedTripsForBill.includes(t.id)} onChange={() => toggleTripSelection(t.id)} /></td>
                    <td>{t.unloading_date || t.Unloading_Date}</td>
                    <td>{t.trip_id || t.Trip_ID}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{t.vehicle_no || t.Vehical_No}</td>
                    <td>{t.customer_name || t.Customer}</td>
                    <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>₹{t.gross_freight || 0}</td>
                    <td style={{ color: '#ef4444' }}>₹{t.shortage_amt || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 🧾 TAB 2: GENERATED INVOICES & RECONCILIATION */}
      {activeTab === 'GENERATED_BILLS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          <h3 style={{ color: '#38bdf8', marginTop: 0 }}>Generated Invoices Tracking</h3>
          <table>
            <thead>
              <tr><th>Bill Date</th><th>Invoice No / Party</th><th>Trips Included</th><th>Expected Net Pay</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {generatedBills.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center' }}>No Invoices Generated</td></tr> : 
                generatedBills.map((b, i) => (
                <tr key={i}>
                  <td>{b.bill_date}</td>
                  <td><b style={{ color: '#fff' }}>{b.bill_no}</b> <br/><small style={{ color: '#94a3b8' }}>{b.customer_name}</small></td>
                  <td><span className="badge" style={{ background: '#334155' }}>{b.trips?.length || 0} Trips</span></td>
                  <td style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '15px' }}>₹{b.total_net_expected}</td>
                  <td><span className="badge" style={{ background: b.status === 'SETTLED' ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)', color: b.status === 'SETTLED' ? '#10b981' : '#f59e0b' }}>{b.status}</span></td>
                  <td>
                    {b.status !== 'SETTLED' ? (
                      <button onClick={() => openAdjustmentModal(b)} style={{ background: '#f59e0b', color: '#000', border: 'none', padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' }}>
                        ⚖️ Cross-Check & Settle
                      </button>
                    ) : <span style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold' }}>✅ Reconciled</span>}
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
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1000px', border: '1px solid #f59e0b', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#f59e0b' }}>⚖️ Invoice Reconciliation: {selectedBill.bill_no}</h2>
              <button onClick={() => setIsAdjustModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            {/* STEP 1: AI UPLOAD OR MANUAL ENTRY */}
            <div style={{ display: 'grid', gridTemplateColumns: scannedData.length > 0 ? '1fr 2.5fr' : '1fr', gap: '20px', marginBottom: '20px' }}>
              <label className="upload-zone">
                <div style={{ fontSize: '30px', marginBottom: '10px' }}>🤖</div>
                {isProcessing ? <div style={{ color: '#f59e0b', fontWeight: 'bold' }}>Scanning Party PDF...</div> : <div style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '12px' }}>Upload Party Payment Advice (PDF/Excel) for Auto Cross-Check</div>}
                <input type="file" hidden accept=".pdf,.csv,.xlsx" onChange={handleFileUpload} />
              </label>

              {scannedData.length > 0 && (
                <div style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid #10b981', padding: '15px', borderRadius: '8px' }}>
                  <h4 style={{ margin: '0 0 10px 0', color: '#10b981' }}>✅ AI Cross-Check Results</h4>
                  <table style={{ marginTop: 0, fontSize: '11px' }}>
                    <thead><tr><th>Vehicle</th><th>Our Expected</th><th>Party Passed</th><th>TDS Cut</th><th>Extra Shortage Cut</th></tr></thead>
                    <tbody>
                      {scannedData.map((d, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>{d.vehicle_no}</td>
                          <td style={{ color: '#38bdf8' }}>₹{parseFloat(d.gross_freight) - parseFloat(d.shortage_amt)}</td>
                          <td style={{ color: '#10b981', fontWeight: 'bold' }}>₹{d.final_passed_amt}</td>
                          <td style={{ color: '#f59e0b' }}>₹{d.tds_amt}</td>
                          <td style={{ color: '#ef4444' }}>₹{parseFloat(d.gross_freight) - parseFloat(d.shortage_amt) - parseFloat(d.final_passed_amt) - parseFloat(d.tds_amt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* STEP 2: SHORTAGE DEDUCTION */}
            <div style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 10px 0', color: '#ef4444' }}>✂️ Manual Extra Shortage / Deductions</h4>
              <table style={{ marginTop: 0 }}>
                <thead><tr><th>Vehicle No</th><th>Driver</th><th>Extra Shortage (By Party) ₹</th><th>Recover from Driver?</th></tr></thead>
                <tbody>
                  {tripAdjustments.map((trip, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 'bold', color: '#fff' }}>{trip.vehicle_no}</td><td style={{ color: '#f59e0b' }}>{trip.driver_name}</td>
                      <td><input type="number" className="modern-input" style={{ border: '1px solid #ef4444', padding: '5px' }} value={trip.extra_shortage_amt} onChange={e => handleTripShortageChange(idx, 'extra_shortage_amt', e.target.value)} placeholder="0" /></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer' }} checked={trip.recover_from_driver} onChange={e => handleTripShortageChange(idx, 'recover_from_driver', e.target.checked)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '10px' }}>* If checked, extra shortage will be debited from Driver's Khata.</p>
            </div>

            {/* STEP 3: FINAL SETTLEMENT */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Total Amount Received in Bank (₹) *</label><input type="number" className="modern-input" style={{ border: '1px solid #10b981', fontSize: '20px', fontWeight: 'bold' }} value={adjustmentData.received_amount} onChange={e=>setAdjustmentData({...adjustmentData, received_amount: e.target.value})} placeholder="e.g. 150000" /></div>
              <div><label style={{ fontSize:'12px', color:'#f59e0b' }}>Total TDS Deducted (As per 26AS)</label><input type="number" className="modern-input" value={adjustmentData.tds_deducted} onChange={e=>setAdjustmentData({...adjustmentData, tds_deducted: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Adjustment Remarks (UTR No)</label><input className="modern-input" value={adjustmentData.remarks} onChange={e=>setAdjustmentData({...adjustmentData, remarks: e.target.value})} /></div>
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px', background: '#f59e0b', color: '#000', justifyContent: 'center' }} onClick={handleSettlePayment}>💸 Confirm Reconciliation & Settle Account</button>
          </div>
        </div>
      )}
    </div>
  );
}