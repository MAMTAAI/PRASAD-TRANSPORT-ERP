// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import {
  parseFastagStatement, mapTollsToTrips, saveTollBatch, resolveVehiclesByTag,
  groupTollsForClaim, generateClaimNo, nextClaimSeq, renderIoclClaimHtml,
  saveClaim, amountInWordsINR,
} from './lib/tollEngine';

const KNOWN_COMPANIES = ['PRASAD TRANSPORT', 'JAISWAL ENTERPRISE', 'M/S GAUTAM PRASAD'];
// Per-company claim defaults remembered on this machine (vendor/plant codes).
const claimDefaults = (company: string) => {
  try { return JSON.parse(localStorage.getItem(`pt_claim_defaults_${company}`) || 'null') || {}; } catch { return {}; }
};
const rememberClaimDefaults = (company: string, d: any) => {
  try { localStorage.setItem(`pt_claim_defaults_${company}`, JSON.stringify(d)); } catch { /* best-effort */ }
};

export default function TollFastagMgmt() {
  const [activeTab, setActiveTab] = useState('STATEMENT');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [recharges, setRecharges] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [claims, setClaims] = useState<any[]>([]);

  // 🏷️ Vehicle Master — fastag_id se tag-only statement rows ki plate resolve hoti hai
  const [vehiclesMaster, setVehiclesMaster] = useState<any[]>([]);
  // 📄 STATEMENT SYNC state (multi-bank FASTag statement → parsed + mapped preview)
  const [stmt, setStmt] = useState<any>(null);           // ParsedStatement
  const [stmtMaps, setStmtMaps] = useState<any[]>([]);   // TollMap[]
  const [stmtCompany, setStmtCompany] = useState('PRASAD TRANSPORT');
  const [stmtFileName, setStmtFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // 🧾 IOCL CLAIM builder state
  const today = new Date().toISOString().split('T')[0];
  const [claimForm, setClaimForm] = useState({
    company: 'PRASAD TRANSPORT', vendor_code: '0011024699',
    plant_name: 'LPG BP-North Guwahati', plant_code: '7B03',
    month: today.slice(0, 7), fortnight: '1st',
  });
  const [claimGroups, setClaimGroups] = useState<any[]>([]);
  const [claimLoaded, setClaimLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);

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

      // 🏷️ Vehicle Master (fastag_id ↔ plate cross-reference ke liye)
      const vSnap = await getDocs(collection(db, "VEHICLES")).catch(() => ({docs:[]}));
      setVehiclesMaster(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const txSnap = await getDocs(collection(db, "TOLL_TRANSACTIONS")).catch(() => ({docs:[]}));
      setTransactions(txSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.Txn_Date || b.createdAt).getTime() - new Date(a.Txn_Date || a.createdAt).getTime()));

      const rcSnap = await getDocs(collection(db, "TOLL_RECHARGES")).catch(() => ({docs:[]}));
      setRecharges(rcSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));

      const clSnap = await getDocs(collection(db, "TOLL_CLAIMS")).catch(() => ({docs:[]}));
      setClaims(clSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.claim_date).localeCompare(String(a.claim_date))));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // ═══════════ 📄 STATEMENT SYNC: parse (PDF/CSV/Excel) → auto trip-map ═══════════
  const handleStatementFile = async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    setParsing(true); setStmt(null); setStmtMaps([]);
    try {
      const parsed = await parseFastagStatement(file);
      if (!parsed.txns.length) {
        alert('⚠️ Statement se koi toll transaction nahi mila. ICICI PDF e-statement ya bank CSV/Excel format check karein.');
        setParsing(false); return;
      }
      // 🏷️ CROSS-REFERENCE: jis row me sirf Tag ID hai (plate nahi), uski
      // vehicle Vehicle Master ke fastag_id mapping se resolve hoti hai.
      const tagResolved = resolveVehiclesByTag(parsed.txns, vehiclesMaster);
      const stillNoVehicle = parsed.txns.filter(t => !t.vehicle_no).length;
      if (tagResolved > 0 || stillNoVehicle > 0) {
        alert(`🏷️ FASTag Cross-Reference:\n\n✅ ${tagResolved} txns ki vehicle Tag ID se resolve hui (Vehicle Master mapping)${stillNoVehicle ? `\n⚠️ ${stillNoVehicle} txns me vehicle abhi bhi unknown — Vehicle Master me un Tags ka "FASTag ID (Auto-Toll Map)" bharein, phir dobara upload karein.` : ''}`);
      }
      const maps = mapTollsToTrips(parsed.txns, trips);
      setStmt(parsed);
      setStmtMaps(maps);
      setStmtFileName(file.name);
      // Multi-company: auto-detect from the statement's Corporate Name.
      if (parsed.company) {
        const hit = KNOWN_COMPANIES.find(c => c.toUpperCase() === parsed.company.toUpperCase());
        setStmtCompany(hit || parsed.company);
      }
    } catch (err: any) {
      alert('❌ Statement parse nahi hui: ' + (err?.message || 'unknown error'));
    }
    setParsing(false);
  };

  const handleSaveStatement = async () => {
    if (!stmtMaps.length) return;
    const unmatched = stmtMaps.filter(m => !m.trip).length;
    if (!window.confirm(`💾 Save ${stmtMaps.length} tolls under ${stmtCompany}?\n\n🎯 ${stmtMaps.length - unmatched} trip-mapped · ⚠️ ${unmatched} unmapped (baad mein Trip Entry se link kar sakte hain)\n\nDuplicate transactions auto-skip honge (safe re-upload).`)) return;
    setSyncing(true);
    try {
      const res = await saveTollBatch(stmtMaps, { company: stmtCompany, source_file: stmtFileName });
      alert(`✅ FASTag Sync Complete (${stmtCompany})!\n\n📥 New saved: ${res.saved}\n🎯 Trip-mapped: ${res.mapped}\n⚠️ Unmapped: ${res.unmatched}\n↺ Duplicates skipped: ${res.duplicates}\n\nJournal + trip P&L update ho gaye.`);
      setStmt(null); setStmtMaps([]);
      fetchData();
    } catch (err: any) { alert('❌ Save failed: ' + (err?.message || '')); }
    setSyncing(false);
  };

  // ═══════════ 🧾 IOCL CLAIM: gather eligible tolls → exact-format PDF ═══════════
  const claimPeriod = () => {
    const [y, m] = claimForm.month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return claimForm.fortnight === '1st'
      ? { from: `${claimForm.month}-01`, to: `${claimForm.month}-15` }
      : { from: `${claimForm.month}-16`, to: `${claimForm.month}-${String(lastDay).padStart(2, '0')}` };
  };

  const handleLoadClaimTolls = () => {
    const { from, to } = claimPeriod();
    const eligible = transactions.filter(t =>
      (t.claim_status || 'UNCLAIMED') !== 'CLAIMED' &&
      (t.is_billable !== false) &&
      t.linked_trip_id && t.linked_trip_id !== 'UNMAPPED' &&
      (!t.company || !claimForm.company || String(t.company).toUpperCase() === claimForm.company.toUpperCase()) &&
      t.Txn_Date >= from && t.Txn_Date <= to
    );
    setClaimGroups(groupTollsForClaim(eligible));
    setClaimLoaded(true);
  };

  const handleGenerateClaim = async () => {
    if (!claimGroups.length) return alert('⚠️ Pehle eligible tolls load karein.');
    setGenerating(true);
    try {
      const { from, to } = claimPeriod();
      const seq = await nextClaimSeq(today);
      const total = Math.round(claimGroups.reduce((s, g) => s + g.total, 0) * 100) / 100;
      const claim = {
        claim_no: generateClaimNo(claimForm.vendor_code, today, seq),
        claim_date: today,
        vendor_name: claimForm.company, vendor_code: claimForm.vendor_code,
        plant_name: claimForm.plant_name, plant_code: claimForm.plant_code,
        period_from: from, period_to: to,
        fortnight_label: claimForm.fortnight,
        groups: claimGroups, total,
      };
      const w = window.open('', '_blank');
      if (!w) { alert('Popup allow karein — claim print window khulti hai.'); setGenerating(false); return; }
      w.document.write(renderIoclClaimHtml(claim));
      w.document.close();
      const ids = claimGroups.flatMap(g => g.txns.map(t => t.id));
      await saveClaim(claim, ids);
      rememberClaimDefaults(claimForm.company, { vendor_code: claimForm.vendor_code, plant_name: claimForm.plant_name, plant_code: claimForm.plant_code });
      alert(`✅ Claim ${claim.claim_no} generated & saved!\n\n₹${total.toLocaleString('en-IN')} (${ids.length} tolls, ${claimGroups.length} trips)\nINR ${amountInWordsINR(total)}\n\nTolls ab CLAIMED mark ho gaye — dobara bill nahi banega.`);
      setClaimGroups([]); setClaimLoaded(false);
      fetchData();
    } catch (err: any) { alert('❌ Claim generate failed: ' + (err?.message || '')); }
    setGenerating(false);
  };

  const handleReprintClaim = (cl: any) => {
    // Rehydrate stored txn ids from the live register.
    const byId = new Map(transactions.map(t => [t.id, t]));
    const groups = (cl.groups || []).map(g => ({ ...g, txns: (g.txns || []).map(id => byId.get(id)).filter(Boolean) }));
    const w = window.open('', '_blank');
    if (!w) return alert('Popup allow karein.');
    w.document.write(renderIoclClaimHtml({ ...cl, groups }));
    w.document.close();
  };

  const handleCompanyChange = (company: string) => {
    const d = claimDefaults(company);
    setClaimForm(f => ({
      ...f, company,
      vendor_code: d.vendor_code || (company === 'PRASAD TRANSPORT' ? '0011024699' : ''),
      plant_name: d.plant_name || f.plant_name, plant_code: d.plant_code || f.plant_code,
    }));
    setClaimGroups([]); setClaimLoaded(false);
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

  // (old naive CSV auto-mapper removed — Statement Sync tab supersedes it)

  const handleSaveRecharge = async () => { 
    if (!rechargeData.recharge_amount) return alert("⚠️ Please enter recharge amount!");
    try {
      await addDoc(collection(db, "TOLL_RECHARGES"), { ...rechargeData, createdAt: serverTimestamp() });
      alert("✅ Wallet Recharge Saved Successfully!");
      setRechargeData({ date: new Date().toISOString().split('T')[0], recharge_amount: '', payment_source: 'Bank Transfer', transaction_id: '', vehicle_group: 'All Fleet', remarks: '' });
      fetchData();
    } catch (e) { alert("❌ Error saving recharge data."); }
  };

  // (old flat claim print removed — IOCL Claims tab renders the exact format)

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
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }} onClick={() => setActiveTab('STATEMENT')}>
             📄 Upload FASTag Statement
          </button>
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

      <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        <button className={`pt-tab ${activeTab === 'STATEMENT' ? 'is-active is-active--success' : ''}`} onClick={() => setActiveTab('STATEMENT')}>📄 STATEMENT SYNC</button>
        <button className={`pt-tab ${activeTab === 'CLAIMS' ? 'is-active is-active--warning' : ''}`} onClick={() => setActiveTab('CLAIMS')}>🧾 IOCL TOLL CLAIMS {claims.length > 0 && <span className="pt-tab__count" style={{ background: '#f59e0b', color: '#0f172a' }}>{claims.length}</span>}</button>
        <button className={`pt-tab ${activeTab === 'TRIP_ENTRY' ? 'is-active' : ''}`} onClick={() => setActiveTab('TRIP_ENTRY')}>🛣️ MANUAL TOLL ENTRY</button>
        <button className={`pt-tab ${activeTab === 'TRANSACTIONS' ? 'is-active' : ''}`} onClick={() => setActiveTab('TRANSACTIONS')}>📋 ALL TOLL LOGS</button>
        <button className={`pt-tab ${activeTab === 'RECHARGE' ? 'is-active' : ''}`} onClick={() => setActiveTab('RECHARGE')}>💳 WALLET RECHARGES</button>
      </div>

      {/* ═══════════ 📄 TAB: STATEMENT SYNC (Multi-bank FASTag upload) ═══════════ */}
      {activeTab === 'STATEMENT' && (
        <div className="glass-card pt-anim-up" style={{ padding: 'clamp(16px, 3vw, 30px)', borderTop: '4px solid #10b981' }}>
          <h2 style={{ color: '#10b981', marginTop: 0, marginBottom: '5px', fontSize: '20px' }}>📄 FASTag Statement Sync — Multi-Bank, Offline</h2>
          <p style={{ color: '#94a3b8', fontSize: '13px', margin: '0 0 20px' }}>ICICI PDF e-statement, ya kisi bhi bank ka CSV/Excel upload karein. Har toll <b style={{ color: '#38bdf8' }}>vehicle + date/time window</b> se sahi trip par auto-map hota hai (Loading → Unloading ke beech). Duplicate kabhi save nahi hote.</p>

          {!stmt && (
            <label className="pt-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '40px', border: '2px dashed #10b981', cursor: parsing ? 'wait' : 'pointer', textAlign: 'center' }}>
              <div style={{ fontSize: '42px' }}>{parsing ? '⏳' : '📤'}</div>
              <div style={{ fontWeight: 900, fontSize: '17px', color: '#10b981' }}>{parsing ? 'Parsing statement…' : 'Upload FASTag Statement'}</div>
              <div style={{ color: '#94a3b8', fontSize: '12px' }}>PDF (ICICI e-statement) · CSV · Excel (.xlsx/.xls)</div>
              <input type="file" hidden accept=".pdf,.csv,.xlsx,.xls" onChange={handleStatementFile} disabled={parsing} />
            </label>
          )}

          {stmt && (
            <div className="pt-anim-fade">
              {/* Parse summary + company selector */}
              <div className="pt-stagger" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '18px' }}>
                <div className="pt-kpi"><div className="pt-kpi__label" style={{ color: '#10b981' }}>Tolls Parsed</div><div className="pt-kpi__value">{stmtMaps.length}</div><div className="pt-kpi__sub">{stmt.bank || 'statement'} · {stmt.period_from || '?'} → {stmt.period_to || '?'}</div></div>
                <div className="pt-kpi"><div className="pt-kpi__label" style={{ color: '#38bdf8' }}>Trip-Mapped</div><div className="pt-kpi__value" style={{ color: '#38bdf8' }}>{stmtMaps.filter(m => m.confidence === 'MATCHED').length}</div><div className="pt-kpi__sub">+ {stmtMaps.filter(m => m.confidence === 'AMBIGUOUS').length} ambiguous (best-guess)</div></div>
                <div className="pt-kpi"><div className="pt-kpi__label" style={{ color: '#ef4444' }}>Unmapped</div><div className="pt-kpi__value" style={{ color: '#ef4444' }}>{stmtMaps.filter(m => !m.trip).length}</div><div className="pt-kpi__sub">koi trip window match nahi</div></div>
                <div className="pt-kpi"><div className="pt-kpi__label" style={{ color: '#f59e0b' }}>Total Toll ₹</div><div className="pt-kpi__value" style={{ color: '#f59e0b' }}>₹{stmtMaps.reduce((s, m) => s + m.txn.amount, 0).toLocaleString('en-IN')}</div><div className="pt-kpi__sub">{stmtFileName}</div></div>
              </div>

              <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '18px', background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '12px', padding: '15px' }}>
                <div style={{ flex: '1 1 260px' }}>
                  <label className="pt-label" style={{ color: '#10b981' }}>🏢 Corporate Account (Company Ledger) {stmt.company && <span className="pt-badge pt-badge--success" style={{ marginLeft: '6px' }}>auto-detected</span>}</label>
                  <select className="pt-input" value={stmtCompany} onChange={e => setStmtCompany(e.target.value)}>
                    {[...new Set([stmtCompany, ...KNOWN_COMPANIES, ...(stmt.company ? [stmt.company] : [])])].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <button className={`pt-btn pt-btn--success ${syncing ? 'is-loading' : ''}`} disabled={syncing} onClick={handleSaveStatement} style={{ minHeight: '48px', flex: '1 1 220px', fontWeight: 900 }}>
                  {syncing ? 'Saving…' : `💾 Save ${stmtMaps.length} Tolls → ${stmtCompany.split(' ')[0]}`}
                </button>
                <button className="pt-btn pt-btn--ghost" onClick={() => { setStmt(null); setStmtMaps([]); }} style={{ minHeight: '48px' }}>✕ Discard</button>
              </div>

              {/* Mapped preview */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ minWidth: '860px' }}>
                  <thead><tr><th>Vehicle</th><th>Date & Time</th><th>Plaza</th><th>Ref No</th><th style={{ textAlign: 'right' }}>₹</th><th>Mapped Trip</th></tr></thead>
                  <tbody>
                    {stmtMaps.map((m, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 900, color: '#fff' }}>{m.txn.vehicle_no}</td>
                        <td style={{ fontSize: '12px' }}>{m.txn.txn_datetime}</td>
                        <td style={{ fontSize: '12px' }}>{m.txn.plaza}</td>
                        <td style={{ fontSize: '10px', color: '#94a3b8', maxWidth: '180px', wordBreak: 'break-all' }}>{m.txn.ref_no}</td>
                        <td style={{ textAlign: 'right', color: '#f59e0b', fontWeight: 'bold' }}>{m.txn.amount.toLocaleString('en-IN')}</td>
                        <td>
                          {m.trip
                            ? <span className={`pt-badge ${m.confidence === 'MATCHED' ? 'pt-badge--success' : 'pt-badge--warning'}`}>{m.confidence === 'MATCHED' ? '🎯' : '⚠'} {m.trip.trip_id || m.trip.Trip_ID || m.trip.id}</span>
                            : <span className="pt-badge pt-badge--danger">UNMAPPED</span>}
                          {m.trip && <span style={{ fontSize: '10px', color: '#64748b', marginLeft: '6px' }}>{m.trip.loading_point || ''} ➔ {m.trip.consignee_name || ''}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════ 🧾 TAB: IOCL TOLL CLAIMS (Auto-generate exact format) ═══════════ */}
      {activeTab === 'CLAIMS' && (
        <div className="pt-anim-up">
          <div className="glass-card" style={{ padding: 'clamp(16px, 3vw, 30px)', borderTop: '4px solid #f59e0b', marginBottom: '20px' }}>
            <h2 style={{ color: '#f59e0b', marginTop: 0, marginBottom: '5px', fontSize: '20px' }}>🧾 Auto-Generate IOCL Toll Claim (Exact Format)</h2>
            <p style={{ color: '#94a3b8', fontSize: '13px', margin: '0 0 20px' }}>Mapped tolls se Summary + Annexure-I wala hubahu IOCL "Claim for Reimbursement of Toll" PDF banta hai — trip ke challan/loading/destination details auto-fill.</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '15px', marginBottom: '15px' }}>
              <div>
                <label className="pt-label" style={{ color: '#f59e0b' }}>Company (Vendor) *</label>
                <select className="pt-input" value={claimForm.company} onChange={e => handleCompanyChange(e.target.value)}>
                  {KNOWN_COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div><label className="pt-label">Vendor Code (IOCL)</label><input className="pt-input" value={claimForm.vendor_code} onChange={e => setClaimForm({ ...claimForm, vendor_code: e.target.value })} placeholder="0011024699" /></div>
              <div><label className="pt-label">Plant Name</label><input className="pt-input" value={claimForm.plant_name} onChange={e => setClaimForm({ ...claimForm, plant_name: e.target.value })} /></div>
              <div><label className="pt-label">Plant Code</label><input className="pt-input" value={claimForm.plant_code} onChange={e => setClaimForm({ ...claimForm, plant_code: e.target.value })} placeholder="7B03" /></div>
              <div><label className="pt-label">Claim Month</label><input type="month" className="pt-input" style={{ colorScheme: 'dark' }} value={claimForm.month} onChange={e => setClaimForm({ ...claimForm, month: e.target.value })} /></div>
              <div>
                <label className="pt-label">Fortnight</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['1st', '2nd'].map(f => (
                    <button key={f} className={`pt-chip ${claimForm.fortnight === f ? 'is-on is-on--warning' : ''}`} style={{ flex: 1 }} onClick={() => setClaimForm({ ...claimForm, fortnight: f })}>{f === '1st' ? '1st (1–15)' : '2nd (16–end)'}</button>
                  ))}
                </div>
              </div>
            </div>
            <button className="pt-btn pt-btn--primary" style={{ minHeight: '48px', width: '100%', fontWeight: 900 }} onClick={handleLoadClaimTolls}>
              🔍 Load Eligible Tolls ({claimPeriod().from} → {claimPeriod().to})
            </button>

            {claimLoaded && (
              claimGroups.length === 0 ? (
                <div className="pt-anim-pop" style={{ marginTop: '18px', textAlign: 'center', padding: '25px', color: '#64748b', border: '1px dashed #334155', borderRadius: '12px' }}>
                  Is period mein {claimForm.company} ka koi unclaimed trip-mapped toll nahi mila. Pehle Statement Sync se tolls upload karein.
                </div>
              ) : (
                <div className="pt-anim-up" style={{ marginTop: '20px' }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ minWidth: '760px' }}>
                      <thead><tr><th>SN</th><th>Truck No</th><th>Invoice (Challan)</th><th>Inv Date</th><th>Loading Location</th><th>Loc Code (edit)</th><th>Destination</th><th style={{ textAlign: 'center' }}>Tolls</th><th style={{ textAlign: 'right' }}>Net Payable ₹</th></tr></thead>
                      <tbody>
                        {claimGroups.map((g, i) => (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            <td style={{ fontWeight: 900, color: '#fff' }}>{g.truck_no}</td>
                            <td>{g.invoice_no || <span style={{ color: '#ef4444' }}>challan missing</span>}</td>
                            <td style={{ fontSize: '12px' }}>{g.invoice_date}</td>
                            <td style={{ fontSize: '12px' }}>{g.loading_loc}</td>
                            <td><input className="pt-input" style={{ minHeight: '38px', padding: '6px 10px', width: '90px' }} value={g.loading_code} placeholder="2377" onChange={e => setClaimGroups(gs => gs.map((x, xi) => xi === i ? { ...x, loading_code: e.target.value } : x))} /></td>
                            <td style={{ fontSize: '12px' }}>{g.dest_name}</td>
                            <td style={{ textAlign: 'center' }}><span className="pt-badge pt-badge--info">{g.txns.length}</span></td>
                            <td style={{ textAlign: 'right', color: '#10b981', fontWeight: 900 }}>{g.total.toLocaleString('en-IN')}</td>
                          </tr>
                        ))}
                        <tr style={{ background: 'rgba(245,158,11,0.08)', fontWeight: 900 }}>
                          <td colSpan={8} style={{ textAlign: 'right' }}>TOTAL CLAIM ({claimGroups.reduce((s, g) => s + g.txns.length, 0)} tolls):</td>
                          <td style={{ textAlign: 'right', color: '#f59e0b', fontSize: '16px' }}>₹{claimGroups.reduce((s, g) => s + g.total, 0).toLocaleString('en-IN')}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <button className={`pt-btn ${generating ? 'is-loading' : ''}`} disabled={generating} onClick={handleGenerateClaim}
                    style={{ minHeight: '52px', width: '100%', marginTop: '18px', fontWeight: 900, fontSize: '15px', background: 'linear-gradient(135deg, #f59e0b, #ea580c)', color: '#fff', border: 'none' }}>
                    {generating ? 'Generating…' : '🖨️ Generate Claim — Summary + Annexure-I (Print & Save)'}
                  </button>
                </div>
              )
            )}
          </div>

          {/* Claims register */}
          <div className="glass-card" style={{ padding: 'clamp(16px, 3vw, 25px)' }}>
            <h3 style={{ color: '#38bdf8', marginTop: 0 }}>📚 Generated Claims Register</h3>
            {claims.length === 0 ? <div style={{ color: '#64748b', padding: '15px' }}>Abhi tak koi claim generate nahi hua.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ minWidth: '640px' }}>
                  <thead><tr><th>Claim No</th><th>Company</th><th>Plant</th><th>Period</th><th style={{ textAlign: 'center' }}>Tolls</th><th style={{ textAlign: 'right' }}>Amount ₹</th><th style={{ textAlign: 'center' }}>Action</th></tr></thead>
                  <tbody>
                    {claims.map(cl => (
                      <tr key={cl.id}>
                        <td style={{ fontWeight: 900, color: '#fff' }}>{cl.claim_no}</td>
                        <td style={{ fontSize: '12px' }}>{cl.vendor_name}</td>
                        <td style={{ fontSize: '12px' }}>{cl.plant_name}</td>
                        <td style={{ fontSize: '12px' }}>{cl.period_from} → {cl.period_to}</td>
                        <td style={{ textAlign: 'center' }}><span className="pt-badge pt-badge--info">{cl.txn_count}</span></td>
                        <td style={{ textAlign: 'right', color: '#10b981', fontWeight: 900 }}>{Number(cl.total || 0).toLocaleString('en-IN')}</td>
                        <td style={{ textAlign: 'center' }}><button className="pt-btn pt-btn--ghost" style={{ minHeight: '40px', padding: '6px 14px' }} onClick={() => handleReprintClaim(cl)}>🖨️ Reprint</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

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