// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function TollFastagMgmt() {
  const [activeTab, setActiveTab] = useState('TRIP_ENTRY'); 
  const [transactions, setTransactions] = useState<any[]>([]);
  const [recharges, setRecharges] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);

  const [rechargeData, setRechargeData] = useState({
    date: new Date().toISOString().split('T')[0], recharge_amount: '', payment_source: 'Bank Transfer', transaction_id: '', vehicle_group: 'All Fleet', remarks: ''
  });

  const [tripToll, setTripToll] = useState({
    trip_id: '', vehicle_no: '', invoice_no: '', invoice_date: new Date().toISOString().split('T')[0],
    loading_loc: '', dest_loc: '', txn_date: new Date().toISOString().split('T')[0],
    txn_ref: '', toll_amount: '', billing_type: 'Reimbursable (Bill to Co.)', remarks: 'Full'
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const trSnap = await getDocs(collection(db, "TRIPS")).catch(() => ({docs:[]}));
      setTrips(trSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.created_at || b.Date || 0).getTime() - new Date(a.created_at || a.Date || 0).getTime()));

      const txSnap = await getDocs(collection(db, "TOLL_TRANSACTIONS")).catch(() => ({docs:[]}));
      setTransactions(txSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.Txn_Date || b.createdAt).getTime() - new Date(a.Txn_Date || a.createdAt).getTime()));

      const rcSnap = await getDocs(collection(db, "TOLL_RECHARGES")).catch(() => ({docs:[]}));
      setRecharges(rcSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleTripSelect = (tripId: string) => {
    const selectedTrip = trips.find(t => t.id === tripId || t.trip_id === tripId || t.Trip_ID === tripId);
    if (selectedTrip) {
      setTripToll({
        ...tripToll,
        trip_id: tripId,
        vehicle_no: selectedTrip.vehicle_no || selectedTrip.vehical_no || selectedTrip.Vehicle_No || '',
        invoice_no: selectedTrip.invoice_no || selectedTrip.Invoice_No || selectedTrip.challan_no || '',
        invoice_date: selectedTrip.invoice_date || selectedTrip.Date || tripToll.invoice_date,
        loading_loc: selectedTrip.loading_point || selectedTrip.from_loc || selectedTrip.Loading_Location || 'IOCL/BPCL',
        dest_loc: selectedTrip.unloading_point || selectedTrip.to_loc || selectedTrip.Destination || ''
      });
    } else {
      setTripToll({ ...tripToll, trip_id: tripId });
    }
  };

  const handleSaveTripToll = async () => {
    if (!tripToll.vehicle_no || !tripToll.toll_amount) return alert("⚠️ Vehicle No and Toll Amount are mandatory!");
    setLoading(true);
    try {
      await addDoc(collection(db, "TOLL_TRANSACTIONS"), {
        Vehicle_No: tripToll.vehicle_no.toUpperCase(),
        Amount: parseFloat(tripToll.toll_amount),
        Txn_Date: tripToll.txn_date,
        Transaction_Ref: tripToll.txn_ref,
        linked_trip_id: tripToll.trip_id || 'MANUAL',
        invoice_no: tripToll.invoice_no,
        invoice_date: tripToll.invoice_date,
        loading_loc: tripToll.loading_loc,
        dest_loc: tripToll.dest_loc,
        billing_type: tripToll.billing_type,
        is_billable: tripToll.billing_type === 'Reimbursable (Bill to Co.)',
        remarks: tripToll.remarks,
        createdAt: serverTimestamp()
      });
      alert(`✅ Trip-wise Toll Saved! (${tripToll.billing_type})`);
      setTripToll({
        trip_id: '', vehicle_no: '', invoice_no: '', invoice_date: new Date().toISOString().split('T')[0],
        loading_loc: '', dest_loc: '', txn_date: new Date().toISOString().split('T')[0],
        txn_ref: '', toll_amount: '', billing_type: 'Reimbursable (Bill to Co.)', remarks: 'Full'
      });
      fetchData();
    } catch (e) { alert("❌ Error saving toll data."); }
    setLoading(false);
  };

  // 🤖 100% SMART CSV AUTO-MAPPER
  const handleBulkUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event: any) => {
      const csvData = event.target.result;
      const rows = csvData.split(/\r?\n/);
      if(rows.length < 2) return alert("⚠️ Empty or Invalid CSV File!");

      const rawHeaders = rows[0].split(',').map((h: string) => h.trim().replace(/"/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')); 
      
      const getIndex = (keywords: string[]) => rawHeaders.findIndex(h => keywords.some(k => h.includes(k)));
      
      const vNoIdx = getIndex(['vehicle', 'plate', 'reg', 'lpn']);
      const dateIdx = getIndex(['date', 'time', 'txn', 'activity', 'processed']);
      const amtIdx = getIndex(['amount', 'fee', 'charge', 'deduction', 'debit', 'dr']);
      const plazaIdx = getIndex(['plaza', 'toll', 'location', 'park']);
      const refIdx = getIndex(['ref', 'txnno', 'transactionid']);

      if (vNoIdx === -1 || amtIdx === -1) {
          return alert("❌ Invalid CSV Format! Could not detect 'Vehicle No' or 'Amount' columns. Please check your bank CSV.");
      }

      setLoading(true);
      let successCount = 0;
      let mappedCount = 0;

      for (let i = 1; i < rows.length; i++) {
        if (!rows[i].trim()) continue;
        
        const values = rows[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((v: string) => v.trim().replace(/"/g, ''));
        
        const rawVNo = values[vNoIdx];
        const rawAmt = values[amtIdx];
        if (!rawVNo || !rawAmt) continue;

        const cleanVNo = rawVNo.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); 
        const amt = parseFloat(rawAmt) || 0;
        if (amt <= 0) continue; 

        const rawDate = values[dateIdx] || '';
        const plaza = plazaIdx > -1 ? values[plazaIdx] : 'Unknown Toll Plaza';
        const ref = refIdx > -1 ? values[refIdx] : `TXN-AUTO-${Date.now()}`;

        let formattedDate = new Date().toISOString().split('T')[0];
        if(rawDate) {
             const dateMatch = rawDate.match(/(\d{2,4})[-/](\d{1,2})[-/](\d{2,4})/);
             if(dateMatch) {
                 if(dateMatch[1].length === 4) {
                     formattedDate = `${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`;
                 } else {
                     formattedDate = `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}`;
                 }
             }
        }

        const matchedTrip = trips.find(t => {
            const dbVNo = String(t.vehicle_no || t.vehical_no || t.Vehicle_No || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            return dbVNo === cleanVNo && t.trip_status !== 'COMPLETED'; 
        });

        await addDoc(collection(db, "TOLL_TRANSACTIONS"), {
            Vehicle_No: rawVNo.toUpperCase(), 
            Amount: amt,
            Txn_Date: formattedDate,
            Toll_Plaza_Name: plaza,
            Transaction_Ref: ref,
            linked_trip_id: matchedTrip ? (matchedTrip.trip_id || matchedTrip.Trip_ID || matchedTrip.id) : 'UNMAPPED',
            invoice_no: matchedTrip ? (matchedTrip.invoice_no || matchedTrip.Invoice_No || matchedTrip.challan_no) : '',
            invoice_date: matchedTrip ? (matchedTrip.invoice_date || matchedTrip.Date) : '',
            loading_loc: matchedTrip ? (matchedTrip.loading_point || matchedTrip.Loading_Location) : '',
            dest_loc: matchedTrip ? (matchedTrip.unloading_point || matchedTrip.Destination) : '',
            linked_customer: matchedTrip ? (matchedTrip.customer_name || matchedTrip.Customer || matchedTrip.registered_assessee) : 'N/A',
            billing_type: 'Reimbursable (Bill to Co.)', 
            is_billable: true,
            createdAt: serverTimestamp()
        });

        successCount++;
        if(matchedTrip) mappedCount++;
      }
      
      setLoading(false);
      alert(`✅ Fastag Sync Complete!\n\n📊 Total Processed: ${successCount} Tolls\n🔗 Auto-Mapped to Running Trips: ${mappedCount} Tolls\n\n(Note: Tolls for completed trips or resting vehicles are saved as UNMAPPED.)`);
      fetchData();
    };
    reader.readAsText(file);
  };

  const handleSaveRecharge = async () => { 
    if (!rechargeData.recharge_amount) return alert("⚠️ Please enter recharge amount!");
    try {
      await addDoc(collection(db, "TOLL_RECHARGES"), { ...rechargeData, createdAt: serverTimestamp() });
      alert("✅ Wallet Recharge Saved Successfully!");
      setRechargeData({ date: new Date().toISOString().split('T')[0], recharge_amount: '', payment_source: 'Bank Transfer', transaction_id: '', vehicle_group: 'All Fleet', remarks: '' });
      fetchData();
    } catch (e) { alert("❌ Error saving recharge data."); }
  };

  // 🖨️ PRINT IOCL/HPCL FORMAT CLAIM BILL
  const handlePrintClaim = () => {
    const billableTolls = transactions.filter(t => t.is_billable || t.billing_type === 'Reimbursable (Bill to Co.)');
    if (billableTolls.length === 0) return alert("⚠️ No billable toll records found to generate claim!");

    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups.");

    let totalAmount = 0;

    const rowsHtml = billableTolls.map((t, idx) => {
        const amt = parseFloat(t.Amount || t.amount || 0);
        totalAmount += amt;
        
        return `
        <tr>
            <td style="text-align:center;">${idx + 1}</td>
            <td style="font-weight:bold;">${t.Vehicle_No || t.vehicle_no || '-'}</td>
            <td>${t.invoice_no || '-'}</td>
            <td style="text-align:center;">${t.invoice_date || '-'}</td>
            <td>${t.loading_loc || 'IOCL/BPCL'}</td>
            <td>${t.dest_loc || '-'}</td>
            <td style="font-size:10px;">${t.Transaction_Ref || t.txn_ref || t.Ref_No || '-'}</td>
            <td style="text-align:center;">${t.Txn_Date || t.txn_date || '-'}</td>
            <td style="text-align:right; font-weight:bold;">${amt.toFixed(2)}</td>
            <td style="text-align:right; font-weight:bold;">${amt.toFixed(2)}</td>
            <td style="text-align:center;">${t.remarks || 'Full'}</td>
        </tr>
        `;
    }).join('');

    const htmlContent = `
    <html>
    <head>
        <title>Claim for Reimbursement of Toll Charges</title>
        <style>
            body { font-family: Arial, sans-serif; padding: 20px; font-size: 12px; color: #000; }
            .header-table { width: 100%; margin-bottom: 20px; border-collapse: collapse; }
            .header-table td { padding: 5px; }
            .claim-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            .claim-table th, .claim-table td { border: 1px solid #000; padding: 8px; font-size: 11px; }
            .claim-table th { background-color: #f0f8ff; text-align: center; }
            .title { text-align: center; font-size: 18px; font-weight: bold; margin-bottom: 20px; text-decoration: underline;}
            .total-row td { font-weight: bold; background-color: #f9f9f9; }
            @media print { body { padding: 0; } }
        </style>
    </head>
    <body>
        <div style="display:flex; justify-content: space-between; align-items:center; border-bottom: 2px solid #ea580c; padding-bottom: 10px; margin-bottom: 20px;">
           <h2 style="color: #ea580c; margin:0;">IndianOil / HPCL</h2>
           <h2 style="margin:0;">Claim for Reimbursement of Toll Charges</h2>
        </div>

        <table class="header-table">
            <tr>
                <td style="width: 15%;"><b>Vendor Name:</b></td>
                <td style="width: 35%; color: #dc2626;"><b>PRASAD TRANSPORT</b></td>
                <td style="width: 15%;"><b>Date:</b></td>
                <td style="width: 35%;">${new Date().toLocaleDateString('en-GB')}</td>
            </tr>
            <tr>
                <td><b>Plant Name:</b></td>
                <td>LPG BP-North Guwahati / Champaran</td>
                <td><b>Claim Type:</b></td>
                <td>FASTag</td>
            </tr>
        </table>

        <div style="margin-top: 20px; margin-bottom: 20px; text-align: justify; font-size: 11px;">
            <b>Declaration:</b><br/>
            ☑ I/we hereby declare that claimed toll charges have been incurred during the assigned journey of the following vehicles on the designated route demarcated by the Corporation. No other claim pertaining to Toll Reimbursement for the period is pending on behalf of the company. I/We certify that the claimed amount(s) are true to the best of my/our knowledge and belief.
        </div>

        <table class="claim-table">
            <thead>
                <tr>
                    <th>SN</th>
                    <th>Truck No</th>
                    <th>Invoice No</th>
                    <th>Invoice Date</th>
                    <th>Loading Location</th>
                    <th>Destination Name</th>
                    <th>Transaction Ref No</th>
                    <th>Txn Date</th>
                    <th>Toll Amount</th>
                    <th>Amount Payable</th>
                    <th>Remarks</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
                <tr class="total-row">
                    <td colspan="8" style="text-align: right; font-size: 14px;">TOTAL:</td>
                    <td style="text-align: right; font-size: 14px;">${totalAmount.toFixed(2)}</td>
                    <td style="text-align: right; font-size: 14px;">${totalAmount.toFixed(2)}</td>
                    <td></td>
                </tr>
            </tbody>
        </table>

        <div style="margin-top: 50px; text-align: right; width: 100%;">
            <b>Signature & Stamp (Transporter)</b><br/><br/><br/>
            ------------------------------------------------
        </div>

        <script>
            window.onload = function() { setTimeout(function() { window.print(); }, 500); }
        </script>
    </body>
    </html>
    `;

    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  // 📥 EXPORT CSV DATA FOR IOCL e-TRP PORTAL UPLOAD
  const handleExportCSV = () => {
    const billableTolls = transactions.filter(t => t.is_billable || t.billing_type === 'Reimbursable (Bill to Co.)');
    if (billableTolls.length === 0) return alert("⚠️ No billable toll records found to export!");

    let csvContent = "Invoice No,Vehicle No,Loading Location,Destination,Toll Plaza Name,Toll Txn Id (Ref No),Toll Date & Time,Txn Amount\n";

    billableTolls.forEach(t => {
      const inv = (t.invoice_no || '').replace(/,/g, '');
      const veh = (t.Vehicle_No || t.vehicle_no || '').replace(/,/g, '');
      const load = (t.loading_loc || 'IOCL/BPCL').replace(/,/g, ' ');
      const dest = (t.dest_loc || '').replace(/,/g, ' ');
      const plaza = (t.Toll_Plaza_Name || t.Plaza || '').replace(/,/g, ' ');
      const ref = (t.Transaction_Ref || t.txn_ref || t.Ref_No || '').replace(/,/g, '');
      const date = (t.Txn_Date || t.txn_date || '').replace(/,/g, ' ');
      const amt = parseFloat(t.Amount || t.amount || t.toll_amount || 0).toFixed(2);

      csvContent += `${inv},${veh},${load},${dest},${plaza},${ref},${date},${amt}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `IOCL_eTRP_Toll_Data_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleBillable = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "TOLL_TRANSACTIONS", id), { 
        is_billable: !currentStatus, 
        billing_type: !currentStatus ? 'Reimbursable (Bill to Co.)' : 'Company Paid (Direct)' 
      });
      fetchData();
    } catch (error) { alert("Error updating status"); }
  };

  const totalTollAmount = transactions.reduce((acc, curr) => acc + (parseFloat(curr.Amount || curr.amount || curr.toll_amount || '0')), 0);
  const totalRechargeAmount = recharges.reduce((acc, curr) => acc + (parseFloat(curr.recharge_amount || '0')), 0);
  const estimatedBalance = totalRechargeAmount - totalTollAmount;

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: 'sans-serif' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; backdrop-filter: blur(10px); }
        .glow-btn { background: #3b82f6; color: white; border: none; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; }
        .glow-btn:hover { background: #2563eb; transform: translateY(-2px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; }
        .modern-input:focus { border-color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 15px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 12px 15px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '36px', fontWeight: '900' }}>Fastag & Toll Central</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Trip-Wise Billing & Oil Company Reimbursements</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #8b5cf6, #7e22ce)' }} onClick={handleExportCSV}>
             📥 Download e-TRP Excel (CSV)
          </button>
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #ea580c)' }} onClick={handlePrintClaim}>
             🖨️ Print Toll Claim Bill
          </button>
          <label className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }}>
            {loading ? '⏳ Syncing...' : '📤 Upload Bank CSV (Auto-Map)'}
            <input type="file" hidden accept=".csv" onChange={handleBulkUpload} disabled={loading} />
          </label>
        </div>
      </div>

      {/* 📊 Fastag Dashboard Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '30px' }}>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #10b981' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Wallet Recharges</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#10b981' }}>₹{totalRechargeAmount.toLocaleString()}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #ef4444' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Toll Deductions</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#ef4444' }}>₹{totalTollAmount.toLocaleString()}</div>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #38bdf8' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Estimated Wallet Balance</div>
          <div style={{ fontSize: '28px', fontWeight: '900', color: '#38bdf8' }}>₹{estimatedBalance.toLocaleString()}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'TRIP_ENTRY' ? 'active' : ''}`} onClick={() => setActiveTab('TRIP_ENTRY')}>🛣️ TRIP-WISE TOLL ENTRY</button>
        <button className={`tab-btn ${activeTab === 'TRANSACTIONS' ? 'active' : ''}`} onClick={() => setActiveTab('TRANSACTIONS')}>📋 ALL TOLL LOGS</button>
        <button className={`tab-btn ${activeTab === 'RECHARGE' ? 'active' : ''}`} onClick={() => setActiveTab('RECHARGE')}>💳 WALLET RECHARGES</button>
      </div>

      {/* 🛣️ NEW TAB: TRIP-WISE TOLL ENTRY (MANUAL & BILLABLE) */}
      {activeTab === 'TRIP_ENTRY' && (
        <div className="glass-card" style={{ padding: '30px', borderTop: '4px solid #38bdf8' }}>
           <h2 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '20px', fontSize: '20px' }}>Record Trip-Wise Toll (For Billing/Claim)</h2>
           
           <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '20px' }}>
              <div style={{ gridColumn: 'span 2' }}>
                 <label style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 'bold' }}>1. Select Link Trip (Auto-fills details) *</label>
                 <select className="modern-input" value={tripToll.trip_id} onChange={(e) => handleTripSelect(e.target.value)} style={{ border: '1px solid #38bdf8' }}>
                    <option value="">-- Custom Manual Entry (No Trip Link) --</option>
                    {trips.map(t => (
                       <option key={t.id} value={t.id}>
                         {t.trip_id || t.Trip_ID || 'TRIP'} | {t.vehicle_no || t.vehical_no} | Inv: {t.invoice_no || t.challan_no} | Route: {t.loading_point} to {t.unloading_point}
                       </option>
                    ))}
                 </select>
              </div>
              <div>
                 <label style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 'bold' }}>2. Billing Type (Imp for Claim) *</label>
                 <select className="modern-input" value={tripToll.billing_type} onChange={e=>setTripToll({...tripToll, billing_type: e.target.value})} style={{ border: '1px solid #f59e0b', color: '#f59e0b', fontWeight: 'bold' }}>
                    <option value="Reimbursable (Bill to Co.)">🟢 Reimbursable (Bill to Oil Co.)</option>
                    <option value="Company Paid (Direct)">🔴 Company Paid Direct (No Bill)</option>
                 </select>
              </div>
           </div>

           <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '15px', padding: '20px', background: 'rgba(0,0,0,0.2)', borderRadius: '10px', border: '1px dashed #475569' }}>
              <div><label style={{ fontSize: '11px', color: '#cbd5e1' }}>Vehicle No *</label><input className="modern-input" value={tripToll.vehicle_no} onChange={e=>setTripToll({...tripToll, vehicle_no: e.target.value})} /></div>
              <div><label style={{ fontSize: '11px', color: '#cbd5e1' }}>Invoice / Challan No</label><input className="modern-input" value={tripToll.invoice_no} onChange={e=>setTripToll({...tripToll, invoice_no: e.target.value})} /></div>
              <div><label style={{ fontSize: '11px', color: '#cbd5e1' }}>Invoice Date</label><input type="date" className="modern-input" value={tripToll.invoice_date} onChange={e=>setTripToll({...tripToll, invoice_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div><label style={{ fontSize: '11px', color: '#cbd5e1' }}>Loading Location</label><input className="modern-input" value={tripToll.loading_loc} onChange={e=>setTripToll({...tripToll, loading_loc: e.target.value})} /></div>
              <div><label style={{ fontSize: '11px', color: '#cbd5e1' }}>Destination Name</label><input className="modern-input" value={tripToll.dest_loc} onChange={e=>setTripToll({...tripToll, dest_loc: e.target.value})} /></div>
           </div>

           <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '15px', marginTop: '20px' }}>
              <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Toll Txn Date</label><input type="date" className="modern-input" value={tripToll.txn_date} onChange={e=>setTripToll({...tripToll, txn_date: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Transaction Ref No (Tag)</label><input className="modern-input" value={tripToll.txn_ref} onChange={e=>setTripToll({...tripToll, txn_ref: e.target.value})} /></div>
              <div><label style={{ fontSize: '12px', color: '#ef4444', fontWeight: 'bold' }}>Toll Amount (₹) *</label><input type="number" className="modern-input" style={{ borderColor: '#ef4444', color: '#ef4444', fontWeight: 'bold' }} value={tripToll.toll_amount} onChange={e=>setTripToll({...tripToll, toll_amount: e.target.value})} /></div>
              <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Remarks</label><input className="modern-input" value={tripToll.remarks} onChange={e=>setTripToll({...tripToll, remarks: e.target.value})} /></div>
           </div>

           <button className="glow-btn" style={{ width: '100%', justifyContent: 'center', marginTop: '25px', padding: '15px', fontSize: '16px' }} onClick={handleSaveTripToll} disabled={loading}>
              {loading ? '⏳ Saving...' : '💾 Save Trip Toll Data'}
           </button>
        </div>
      )}

      {/* 📋 TOLL TRANSACTIONS LOG TAB */}
      {activeTab === 'TRANSACTIONS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#38bdf8', textAlign: 'center', padding: '20px' }}>Syncing Database...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Vehicle No & Invoice</th>
                  <th>Route (Load ➔ Dest)</th>
                  <th>Txn Details</th>
                  <th>Amount (₹)</th>
                  <th style={{ textAlign: 'center' }}>Billing Type (Claim Status)</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: '30px' }}>No transactions found.</td></tr>
                ) : (
                  transactions.map((t, i) => (
                    <tr key={i}>
                      <td>
                         <b style={{ color: '#fff', fontSize: '14px' }}>{t.Vehicle_No || t.vehicle_no}</b><br/>
                         <span style={{ fontSize: '11px', color: '#38bdf8' }}>Inv: {t.invoice_no || t.Invoice_No || '-'}</span>
                      </td>
                      <td>
                         <span style={{ color: '#94a3b8', fontSize: '12px' }}>{t.loading_loc || 'IOCL/BPCL'} ➔ <br/>{t.dest_loc || t.Toll_Plaza_Name || t.Plaza || 'Unknown'}</span>
                      </td>
                      <td>
                         <span style={{ color: '#cbd5e1', fontSize: '11px' }}>Date: {t.Txn_Date || t.txn_date || t.date}</span><br/>
                         <span style={{ color: '#64748b', fontSize: '10px' }}>Ref: {t.Transaction_Ref || t.txn_ref || t.Ref_No || '-'}</span>
                      </td>
                      <td style={{ color: '#ef4444', fontWeight: '900', fontSize: '15px' }}>₹{parseFloat(t.Amount || t.amount || t.toll_amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                      
                      <td style={{ textAlign: 'center' }}>
                         <button 
                           onClick={() => toggleBillable(t.id, t.is_billable)}
                           style={{ 
                             background: (t.is_billable || t.billing_type?.includes('Reimbursable')) ? 'rgba(16, 185, 129, 0.1)' : 'rgba(71, 85, 105, 0.3)', 
                             color: (t.is_billable || t.billing_type?.includes('Reimbursable')) ? '#10b981' : '#94a3b8', 
                             border: `1px solid ${(t.is_billable || t.billing_type?.includes('Reimbursable')) ? '#10b981' : '#475569'}`, 
                             padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', transition: '0.3s' 
                           }}
                         >
                            {(t.is_billable || t.billing_type?.includes('Reimbursable')) ? '✅ BILLABLE (CLAIM)' : '❌ NO (Direct Co. Paid)'}
                         </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 💳 WALLET RECHARGE TAB */}
      {activeTab === 'RECHARGE' && (
         <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
            
            {/* Recharge Entry Form */}
            <div className="glass-card" style={{ padding: '30px', borderTop: '4px solid #10b981' }}>
              <h2 style={{ color: '#10b981', marginTop: 0, marginBottom: '20px', fontSize: '20px' }}>Add Fastag Recharge</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Recharge Date</label><input type="date" className="modern-input" value={rechargeData.date} onChange={e=>setRechargeData({...rechargeData, date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                <div><label style={{ fontSize: '12px', color: '#38bdf8', fontWeight: 'bold' }}>Amount (₹) *</label><input type="number" className="modern-input" style={{ border: '1px solid #38bdf8', fontSize: '18px', fontWeight: 'bold', color: '#38bdf8' }} value={rechargeData.recharge_amount} onChange={e=>setRechargeData({...rechargeData, recharge_amount: e.target.value})} /></div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Payment Source</label>
                  <select className="modern-input" value={rechargeData.payment_source} onChange={e=>setRechargeData({...rechargeData, payment_source: e.target.value})}>
                    <option value="Bank Transfer">Bank Transfer (HDFC/SBI etc)</option>
                    <option value="Credit Card">Credit Card</option>
                    <option value="UPI">UPI</option>
                  </select>
                </div>
                <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Bank Ref / UTR No</label><input className="modern-input" value={rechargeData.transaction_id} onChange={e=>setRechargeData({...rechargeData, transaction_id: e.target.value})} /></div>
                <div><label style={{ fontSize: '12px', color: '#94a3b8' }}>Remarks</label><input className="modern-input" placeholder="e.g. Monthly Topup" value={rechargeData.remarks} onChange={e=>setRechargeData({...rechargeData, remarks: e.target.value})} /></div>
                
                <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', justifyContent: 'center', marginTop: '10px' }} onClick={handleSaveRecharge} disabled={loading}>
                    ✅ Add Funds to Wallet
                </button>
              </div>
            </div>

            {/* Recharge History Table */}
            <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
              <h2 style={{ color: '#fff', marginTop: 0, marginBottom: '20px', fontSize: '20px' }}>Recharge History</h2>
              <table>
                <thead>
                  <tr><th>Date</th><th>Amount (₹)</th><th>Payment Mode</th><th>Ref No</th><th>Remarks</th></tr>
                </thead>
                <tbody>
                  {recharges.length === 0 ? <tr><td colSpan={5} style={{textAlign: 'center', padding: '30px'}}>No recharges recorded.</td></tr> : 
                    recharges.map((r, i) => (
                      <tr key={i}>
                        <td>{r.date}</td>
                        <td style={{ color: '#10b981', fontWeight: 'bold', fontSize: '16px' }}>+ ₹{parseFloat(r.recharge_amount).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td><span className="badge" style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8' }}>{r.payment_source}</span></td>
                        <td>{r.transaction_id || '-'}</td>
                        <td>{r.remarks || '-'}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>

         </div>
      )}

    </div>
  );
}