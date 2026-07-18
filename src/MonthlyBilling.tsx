// @ts-nocheck
// 🧾 AUTOMATED MONTHLY BILLING ENGINE — one-click customer+month aggregation
// from TRIPS into print-ready Tax Invoices matching the real Prasad Transport
// formats: Transportation Bill (RCM), Detention Charge Bill (RCM) and the
// per-vehicle Detention Annexure. GST 5% under RCM (payable by consignee),
// MSME UDYAM text, bank details. Every figure is editable before printing —
// the engine proposes, the human verifies, then Save posts to trips + journal.
import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { postEntry } from './lib/accounting/journal';
import { round2, toISODate, getTripFreight } from './lib/accounting/tripMath';
import { scopeCurrent } from './lib/rbac';
import { useIsMobile } from './hooks/useIsMobile';

const inr = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Indian number-to-words (rupees) ──────────────────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n) { return n < 20 ? ONES[n] : (TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')); }
function three(n) { return (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? two(n % 100) : ''); }
export function amountInWords(amount) {
  let n = Math.round(Number(amount) || 0);
  if (n === 0) return 'INR Zero Only';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  let out = '';
  if (crore) out += three(crore) + ' Crore ';
  if (lakh) out += two(lakh) + ' Lakh ';
  if (thousand) out += two(thousand) + ' Thousand ';
  if (n) out += three(n) + ' ';
  return 'INR ' + out.trim() + ' Only';
}

const dmy = (iso) => { const d = toISODate(iso); return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : ''; };
const daysBetween = (a, b) => {
  const ta = new Date(toISODate(a)).getTime(), tb = new Date(toISODate(b)).getTime();
  if (isNaN(ta) || isNaN(tb)) return 0;
  return Math.max(0, Math.round((tb - ta) / 86400000));
};

export default function MonthlyBilling() {
  const { isMobile } = useIsMobile();
  const [trips, setTrips] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [company, setCompany] = useState({});
  const [loading, setLoading] = useState(true);

  const [cust, setCust] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [freightRate, setFreightRate] = useState('1500');
  const [detRate, setDetRate] = useState('2500');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [detInvoiceNo, setDetInvoiceNo] = useState('');
  const [rows, setRows] = useState([]);        // freight rows (editable)
  const [detRows, setDetRows] = useState([]);  // detention rows (editable)
  const [generated, setGenerated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchAll(); }, []);
  const fetchAll = async () => {
    setLoading(true);
    try {
      const [tSnap, cSnap, coSnap1, coSnap2] = await Promise.all([
        getDocs(collection(db, 'TRIPS')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'CUSTOMERS')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'COMPANY')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'COMPANIES')).catch(() => ({ docs: [] })),
      ]);
      setTrips(scopeCurrent(tSnap.docs.map(d => ({ id: d.id, ...d.data() }))) || []);
      setCustomers(cSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      const co = [...coSnap1.docs, ...coSnap2.docs].map(d => d.data())[0] || {};
      setCompany(co);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const tripCust = (t) => String(t.customer_name || t.Customer || t.Registered_Assessee || '').trim();
  const customerOptions = useMemo(() => {
    const set = new Set(customers.map(c => c.customer_name).filter(Boolean));
    trips.forEach(t => { const c = tripCust(t); if (c) set.add(c); });
    return [...set].sort();
  }, [customers, trips]);

  // 1️⃣ ONE-CLICK AGGREGATION: customer + month → completed trips
  const loadMonth = () => {
    if (!cust || !month) return alert('⚠️ Customer aur month dono chunein!');
    const from = `${month}-01`, to = `${month}-31`;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    let picked = trips.filter(t => {
      if (norm(tripCust(t)) !== norm(cust)) return false;
      const d = toISODate(t.start_date || t.Loading_Date || t.loading_date);
      if (!d || d < from || d > to) return false;
      return (t.trip_status || t.Trip_Status) === 'COMPLETED' || t.unloading_date; // completed LRs
    }).sort((a, b) => toISODate(a.start_date || a.Loading_Date).localeCompare(toISODate(b.start_date || b.Loading_Date)));

    if (!picked.length) { alert('⚠️ Is customer + month ke liye koi completed trip nahi mili.'); return; }

    // 🧹 Dedupe by CN number — the trip DB can hold double entries for one
    // movement (known data issue); a bill must list each CN exactly once.
    const seenCn = new Set(); const dupes = [];
    const deduped = picked.filter(t => {
      const cn = String(t.challan_no || t.Challan_No || '').trim();
      if (!cn) return true;
      if (seenCn.has(cn)) { dupes.push(cn); return false; }
      seenCn.add(cn); return true;
    });
    if (dupes.length) alert(`🧹 ${dupes.length} duplicate CN hata diye (DB me double entry): ${[...new Set(dupes)].join(', ')}`);
    picked = deduped;

    setRows(picked.map(t => ({
      tripId: t.id,
      date: toISODate(t.start_date || t.Loading_Date || t.loading_date),
      cn: String(t.challan_no || t.Challan_No || t.trip_id || t.Trip_ID || '').trim(),
      vehicle: String(t.vehicle_no || t.Vehical_No || '').replace(/\s+/g, ''),
      qty: parseFloat(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || 0) || 0,
      include: true,
    })));
    // Detention: start = unloading-report day (default loading+1), end = actual unloading/completion.
    // Sab editable hai — data me exact reporting time na ho to user theek kare.
    setDetRows(picked.map(t => {
      const load = toISODate(t.start_date || t.Loading_Date || t.loading_date);
      const start = load ? toISODate(new Date(new Date(load).getTime() + 86400000)) : '';
      const end = toISODate(t.unloading_date || (t.completed_at || '').slice(0, 10)) || start;
      const days = daysBetween(start, end);
      return {
        tripId: t.id,
        vehicle: String(t.vehicle_no || t.Vehical_No || '').replace(/\s+/g, ''),
        cn: String(t.challan_no || t.Challan_No || t.trip_id || t.Trip_ID || '').trim(),
        consignee: String(t.consignee_name || t.Consignee_Name || '').trim(),
        loadDate: load, startDate: start, endDate: end,
        days, include: days > 0,
      };
    }));
    setGenerated(true);
    const ym = month.replace('-', '/');
    if (!invoiceNo) setInvoiceNo(`PT/${ym}/F`);
    if (!detInvoiceNo) setDetInvoiceNo(`PT/${ym}/D`);
  };

  // Totals (code-side, live)
  const fRows = rows.filter(r => r.include);
  const totalQty = round2(fRows.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0));
  const freightTotal = round2(totalQty * (parseFloat(freightRate) || 0));
  const freightGst = round2(freightTotal * 0.05);
  const dRows = detRows.filter(r => r.include && r.days > 0);
  const detTotal = round2(dRows.reduce((s, r) => s + r.days * (parseFloat(detRate) || 0), 0));
  const detGst = round2(detTotal * 0.05);

  const editRow = (i, f, v) => setRows(p => p.map((r, idx) => idx === i ? { ...r, [f]: f === 'qty' ? (parseFloat(v) || 0) : v } : r));
  const editDet = (i, f, v) => setDetRows(p => p.map((r, idx) => {
    if (idx !== i) return r;
    const nr = { ...r, [f]: v };
    if (f === 'startDate' || f === 'endDate') nr.days = daysBetween(nr.startDate, nr.endDate);
    if (f === 'days') nr.days = Math.max(0, parseInt(v) || 0);
    return nr;
  }));

  // ── Company header fields (from COMPANY master, with real-format fallbacks) ──
  const co = {
    name: company.company_name || company.Company_Name || 'PRASAD TRANSPORT',
    address: company.address || company.Address || 'Bongaigaon, Assam - 783380',
    gstin: company.gst_no || company.GSTIN || '18AAKFP2339R2ZG',
    pan: company.pan_no || 'AAKFP2339R',
    udyam: company.udyam_no || 'UDYAM-AS-06-0002225',
    bank_name: company.bank_name || 'STATE BANK OF INDIA (SBI)',
    account_no: company.account_no || company.bank_account || '—',
    ifsc: company.ifsc_code || '—',
    branch: company.bank_branch || 'Bongaigaon',
  };
  const monthLabel = month ? new Date(month + '-01').toLocaleString('en-GB', { month: 'long', year: 'numeric' }) : '';

  // 4️⃣ PRINT-READY TEMPLATE (matches the physical format)
  const printInvoices = () => {
    const custMaster = customers.find(c => (c.customer_name || '').toLowerCase() === cust.toLowerCase()) || {};
    const custAddr = custMaster.address || custMaster.billing_address || '';
    const custGstin = custMaster.gst_no || '';

    const headerHtml = (title, invNo) => `
      <div class="head">
        <h1>${co.name}</h1>
        <p class="addr">${co.address}</p>
        <p class="meta">GSTIN: ${co.gstin} · PAN: ${co.pan}</p>
        <p class="msme">MSME Registered — UDYAM Regn. No: ${co.udyam}</p>
        <h2>${title}</h2>
        <table class="meta-t"><tr>
          <td><b>Invoice No:</b> ${invNo}</td>
          <td><b>Date:</b> ${dmy(new Date().toISOString())}</td>
          <td><b>Period:</b> ${monthLabel}</td>
        </tr><tr>
          <td colspan="3"><b>To:</b> ${cust}${custAddr ? ', ' + custAddr : ''}${custGstin ? ' · GSTIN: ' + custGstin : ''}</td>
        </tr></table>
      </div>`;

    const gstBlock = (taxable, gst) => `
      <table class="tot">
        <tr><td>Total Amount (Taxable Value)</td><td class="r">₹ ${inr(taxable)}</td></tr>
        <tr><td>GST @ 5% — Payable by recipient under REVERSE CHARGE MECHANISM (RCM), Notification 13/2017-CT(R) (GTA)</td><td class="r">₹ ${inr(gst)}</td></tr>
        <tr class="grand"><td>Invoice Value (excl. GST — RCM)</td><td class="r">₹ ${inr(taxable)}</td></tr>
      </table>
      <p class="words"><b>${amountInWords(taxable)}</b><br/><span class="gstw">GST (RCM): ${amountInWords(gst)}</span></p>`;

    const footHtml = `
      <div class="bank">
        <b>Bank Details:</b> ${co.bank_name} · A/C No: ${co.account_no} · IFSC: ${co.ifsc} · Branch: ${co.branch}
      </div>
      <div class="sign">
        <p>For <b>${co.name}</b></p><br/><br/>
        <p>Authorised Signatory</p>
      </div>
      <p class="foot">SUBJECT TO BONGAIGAON JURISDICTION · This is a Computer Generated Invoice</p>`;

    // Freight bill: numbered trip lines exactly like the physical bill
    const freightLines = fRows.map((r, i) => `<div class="ln">${i + 1}. Dt-${dmy(r.date)}, CN-${r.cn}, ${r.vehicle}, Qty-${r.qty} KL</div>`).join('');
    const freightHtml = `
      ${headerHtml('TRANSPORTATION BILL (Tax Invoice — RCM)', invoiceNo)}
      <p class="billmonth"><b>Bill for the Month of ${monthLabel}</b></p>
      ${freightLines}
      <p class="calc"><b>Total Freight = ${totalQty} KL Qty × Rate ₹${freightRate}/KL = ₹ ${inr(freightTotal)}</b></p>
      ${gstBlock(freightTotal, freightGst)}
      ${footHtml}`;

    // Detention annexure grouped by vehicle with subtotals — like the physical annexure
    const byVeh = {};
    dRows.forEach(r => { (byVeh[r.vehicle] ||= []).push(r); });
    const annexHtml = Object.entries(byVeh).map(([veh, list]) => {
      const sub = round2(list.reduce((s, r) => s + r.days * (parseFloat(detRate) || 0), 0));
      const trs = list.map((r, i) => `<tr>
        <td>${i + 1}</td><td>${veh}</td><td>${r.cn}</td><td>${cust}</td><td>${r.consignee}</td><td>Nil</td>
        <td>${dmy(r.loadDate)}</td><td>${dmy(r.startDate)}</td><td>${dmy(r.endDate)}</td>
        <td class="r">${r.days}</td><td class="r">${inr(detRate)}</td><td class="r">${inr(r.days * (parseFloat(detRate) || 0))}</td>
      </tr>`).join('');
      return `${trs}<tr class="sub"><td colspan="9"></td><td class="r"><b>${list.reduce((s, r) => s + r.days, 0)}</b></td><td><b>Total</b></td><td class="r"><b>${inr(sub)}</b></td></tr>`;
    }).join('');
    const detHtml = `
      ${headerHtml('DETENTION CHARGE BILL (Tax Invoice — RCM)', detInvoiceNo)}
      <p class="billmonth"><b>Detention Charges @ Unloading Point — ${monthLabel}</b></p>
      <p class="calc"><b>Total Detention Days = ${dRows.reduce((s, r) => s + r.days, 0)} × Rate ₹${detRate}/Day = ₹ ${inr(detTotal)}</b></p>
      ${gstBlock(detTotal, detGst)}
      ${footHtml}
      <div class="pagebreak"></div>
      ${headerHtml('ANNEXURE — Details Regarding Detention Charge @ Unloading Point', detInvoiceNo)}
      <table class="annex">
        <thead><tr><th>Sl</th><th>Tanker No</th><th>CN No.</th><th>Consignor</th><th>Consignee</th><th>Shortage</th><th>Loading Date</th><th>Detention Start</th><th>Detention End</th><th>Days</th><th>Rate/Day</th><th>Amount</th></tr></thead>
        <tbody>${annexHtml}
        <tr class="grand"><td colspan="11"><b>Grand Total — Total Detention Charge</b></td><td class="r"><b>₹ ${inr(detTotal)}</b></td></tr></tbody>
      </table>
      <p class="words"><b>In words: ${amountInWords(detTotal)}</b></p>
      <div class="sign"><p>For <b>${co.name}</b></p><br/><p>Authorised Signatory</p></div>`;

    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><html><head><title>${cust} — ${monthLabel} Bills</title><style>
      * { box-sizing: border-box; } body { font-family: Arial, sans-serif; color: #111; margin: 0; padding: 24px; font-size: 13px; }
      .head h1 { margin: 0; font-size: 26px; letter-spacing: 1px; text-align: center; }
      .addr, .meta, .msme { text-align: center; margin: 2px 0; font-size: 12px; }
      .msme { font-weight: bold; }
      .head h2 { text-align: center; font-size: 15px; border: 2px solid #111; padding: 6px; margin: 10px 0; }
      .meta-t { width: 100%; border-collapse: collapse; margin-bottom: 10px; } .meta-t td { border: 1px solid #111; padding: 5px 8px; }
      .billmonth { font-size: 14px; text-decoration: underline; }
      .ln { padding: 2px 0; font-size: 13px; }
      .calc { margin-top: 12px; font-size: 14px; }
      .tot { width: 100%; border-collapse: collapse; margin-top: 10px; } .tot td { border: 1px solid #111; padding: 6px 8px; }
      .tot .grand td { font-weight: bold; background: #eee; }
      .r { text-align: right; }
      .words { margin: 10px 0; font-size: 13px; } .gstw { font-size: 12px; }
      .bank { border: 1px solid #111; padding: 8px; margin-top: 14px; font-size: 12px; }
      .sign { margin-top: 30px; text-align: right; } .sign p { margin: 2px 0; }
      .foot { text-align: center; margin-top: 20px; font-size: 11px; border-top: 1px solid #999; padding-top: 6px; }
      .annex { width: 100%; border-collapse: collapse; font-size: 10.5px; } .annex th, .annex td { border: 1px solid #111; padding: 4px; }
      .annex .sub td { background: #f3f3f3; } .annex .grand td { background: #e8e8e8; font-weight: bold; }
      .pagebreak { page-break-after: always; }
      @media print { body { padding: 8mm; } }
    </style></head><body>
      ${freightHtml}
      <div class="pagebreak"></div>
      ${detHtml}
      <script>window.onload = () => setTimeout(() => window.print(), 400);</script>
    </body></html>`);
    w.document.close();
  };

  // 💾 Save: mark trips billed + set freight + post journal (idempotent)
  const saveAndPost = async () => {
    if (!fRows.length || saving) return;
    if (!window.confirm(`${fRows.length} trips ko BILLED mark karein, freight ₹${inr(freightTotal)} + detention ₹${inr(detTotal)} journal me post ho?`)) return;
    setSaving(true);
    try {
      const perTripFreight = {};
      fRows.forEach(r => { perTripFreight[r.tripId] = round2((parseFloat(r.qty) || 0) * (parseFloat(freightRate) || 0)); });
      const batch = writeBatch(db);
      fRows.forEach(r => {
        batch.update(doc(db, 'TRIPS', r.tripId), {
          gross_freight: perTripFreight[r.tripId], rate: parseFloat(freightRate) || 0,
          billing_status: 'BILLED', billed_bill_no: invoiceNo, billed_at: new Date().toISOString(),
        });
      });
      batch.set(doc(collection(db, 'MONTHLY_INVOICES')), {
        customer: cust, month, invoice_no: invoiceNo, det_invoice_no: detInvoiceNo,
        total_qty: totalQty, freight_rate: parseFloat(freightRate) || 0, freight_total: freightTotal, freight_gst_rcm: freightGst,
        detention_total: detTotal, detention_gst_rcm: detGst, det_rate: parseFloat(detRate) || 0,
        trip_ids: fRows.map(r => r.tripId), createdAt: serverTimestamp(),
      });
      await batch.commit();

      let jOk = 0; const errs = [];
      for (const r of fRows) {
        try {
          await postEntry({
            source_type: 'TRIP_FREIGHT', source_ref: r.cn || r.tripId, date: r.date,
            narration: `Freight — CN ${r.cn} (${r.vehicle}) bill ${invoiceNo}`,
            lines: [
              { ledger: `Debtors: ${cust}`, dr_cr: 'Dr', amount: perTripFreight[r.tripId] },
              { ledger: 'Direct Incomes (Freight/Trip Revenue)', dr_cr: 'Cr', amount: perTripFreight[r.tripId] },
            ],
          }); jOk++;
        } catch (e) { errs.push(`CN ${r.cn}: ${e.message}`); }
      }
      if (detTotal > 0) {
        try {
          await postEntry({
            source_type: 'DETENTION', source_ref: detInvoiceNo, date: `${month}-28`,
            narration: `Detention charges ${monthLabel} — ${cust} (${dRows.reduce((s, r) => s + r.days, 0)} days @ ₹${detRate})`,
            lines: [
              { ledger: `Debtors: ${cust}`, dr_cr: 'Dr', amount: detTotal },
              { ledger: 'Direct Incomes (Detention Charges)', dr_cr: 'Cr', amount: detTotal },
            ],
          }); jOk++;
        } catch (e) { errs.push(`Detention: ${e.message}`); }
      }
      alert(`✅ ${fRows.length} trips BILLED + ${jOk} journal entries post ho gayi.${errs.length ? '\n⚠️ ' + errs.join('\n') : ''}`);
      fetchAll();
    } catch (e) { console.error(e); alert('❌ Save fail: ' + (e.message || 'error')); }
    setSaving(false);
  };

  const S = {
    page: { padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif" },
    card: { background: 'rgba(30,41,59,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: 'clamp(14px,3vw,25px)', marginBottom: '18px' },
    input: { background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: '10px', color: 'white', padding: '11px', width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: '44px', colorScheme: 'dark' },
    btn: (bg, dis) => ({ background: dis ? '#475569' : bg, color: 'white', border: 'none', borderRadius: '10px', padding: '13px 20px', fontWeight: 'bold', cursor: dis ? 'default' : 'pointer', minHeight: '48px' }),
    label: { display: 'block', fontSize: '11px', color: '#94a3b8', fontWeight: 'bold', marginBottom: '5px' },
    cell: { background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: '6px', color: 'white', padding: '6px', minHeight: '32px', boxSizing: 'border-box' },
  };

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: '0 0 4px 0', color: '#38bdf8' }}>🧾 Auto Billing (Monthly)</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 18px 0', fontSize: '13px' }}>Customer + month chunein — completed trips se Transportation Bill (RCM) + Detention Bill + Annexure ready.</p>

      {/* Step 1: selection */}
      <div style={S.card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '12px' }}>
          <div><label style={S.label}>Customer *</label>
            <input list="mb-cust" style={S.input} value={cust} onChange={e => setCust(e.target.value)} placeholder="e.g. Aadhar Green Industries LLP" />
            <datalist id="mb-cust">{customerOptions.map(c => <option key={c} value={c} />)}</datalist>
          </div>
          <div><label style={S.label}>Month *</label><input type="month" style={S.input} value={month} onChange={e => setMonth(e.target.value)} /></div>
          <div><label style={S.label}>Freight Rate (₹/KL)</label><input type="number" inputMode="decimal" style={S.input} value={freightRate} onChange={e => setFreightRate(e.target.value)} /></div>
          <div><label style={S.label}>Detention Rate (₹/Day)</label><input type="number" inputMode="decimal" style={S.input} value={detRate} onChange={e => setDetRate(e.target.value)} /></div>
        </div>
        <button onClick={loadMonth} disabled={loading} style={{ ...S.btn('#2563eb', loading), width: isMobile ? '100%' : 'auto', marginTop: '14px' }}>
          {loading ? '⌛ Loading…' : '⚡ Load Month Trips'}
        </button>
      </div>

      {generated && (
        <>
          {/* Freight rows */}
          <div style={S.card}>
            <b style={{ color: '#10b981' }}>🚛 Transportation Bill — {rows.filter(r => r.include).length} LR/CN</b>
            <div style={{ overflowX: 'auto', marginTop: '10px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '560px' }}>
                <thead><tr style={{ color: '#38bdf8', textAlign: 'left' }}>{['✓', 'Date', 'CN No', 'Vehicle', 'Qty (KL)'].map(h => <th key={h} style={{ padding: '6px', borderBottom: '2px solid #334155' }}>{h}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => (
                  <tr key={r.tripId} style={{ borderBottom: '1px solid #1e293b', opacity: r.include ? 1 : 0.4 }}>
                    <td style={{ padding: '4px' }}><input type="checkbox" style={{ width: '18px', height: '18px' }} checked={r.include} onChange={e => editRow(i, 'include', e.target.checked)} /></td>
                    <td style={{ padding: '4px' }}><input type="date" style={{ ...S.cell, width: '135px' }} value={r.date} onChange={e => editRow(i, 'date', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input style={{ ...S.cell, width: '110px' }} value={r.cn} onChange={e => editRow(i, 'cn', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input style={{ ...S.cell, width: '120px' }} value={r.vehicle} onChange={e => editRow(i, 'vehicle', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input type="number" inputMode="decimal" style={{ ...S.cell, width: '85px' }} value={r.qty} onChange={e => editRow(i, 'qty', e.target.value)} /></td>
                  </tr>))}
                </tbody>
              </table>
            </div>
            <p style={{ margin: '12px 0 0', fontSize: '14px' }}>
              <b style={{ color: '#10b981' }}>Total Freight = {totalQty} KL × ₹{freightRate} = ₹ {inr(freightTotal)}</b>
              <span style={{ color: '#94a3b8', marginLeft: '12px' }}>+ GST 5% (RCM, consignee payable): ₹ {inr(freightGst)}</span>
            </p>
          </div>

          {/* Detention rows */}
          <div style={S.card}>
            <b style={{ color: '#f59e0b' }}>⏱️ Detention Annexure — {dRows.length} chargeable</b>
            <p style={{ fontSize: '11px', color: '#64748b', margin: '4px 0 8px' }}>Start = plant-reporting ke baad ka din (auto: loading+1) · End = unloading/completion. Dono editable — days apne aap recalc.</p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '720px' }}>
                <thead><tr style={{ color: '#f59e0b', textAlign: 'left' }}>{['✓', 'Vehicle', 'CN', 'Loading', 'Detention Start', 'Detention End', 'Days', 'Amount'].map(h => <th key={h} style={{ padding: '6px', borderBottom: '2px solid #334155' }}>{h}</th>)}</tr></thead>
                <tbody>{detRows.map((r, i) => (
                  <tr key={r.tripId} style={{ borderBottom: '1px solid #1e293b', opacity: r.include ? 1 : 0.4 }}>
                    <td style={{ padding: '4px' }}><input type="checkbox" style={{ width: '18px', height: '18px' }} checked={r.include} onChange={e => editDet(i, 'include', e.target.checked)} /></td>
                    <td style={{ padding: '4px', fontWeight: 'bold' }}>{r.vehicle}</td>
                    <td style={{ padding: '4px' }}>{r.cn}</td>
                    <td style={{ padding: '4px', color: '#94a3b8' }}>{dmy(r.loadDate)}</td>
                    <td style={{ padding: '4px' }}><input type="date" style={{ ...S.cell, width: '135px' }} value={r.startDate} onChange={e => editDet(i, 'startDate', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input type="date" style={{ ...S.cell, width: '135px' }} value={r.endDate} onChange={e => editDet(i, 'endDate', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input type="number" style={{ ...S.cell, width: '60px', fontWeight: 'bold' }} value={r.days} onChange={e => editDet(i, 'days', e.target.value)} /></td>
                    <td style={{ padding: '4px', color: '#f59e0b', fontWeight: 'bold' }}>₹{inr(r.days * (parseFloat(detRate) || 0))}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
            <p style={{ margin: '12px 0 0', fontSize: '14px' }}>
              <b style={{ color: '#f59e0b' }}>Total Detention = {dRows.reduce((s, r) => s + r.days, 0)} days × ₹{detRate} = ₹ {inr(detTotal)}</b>
              <span style={{ color: '#94a3b8', marginLeft: '12px' }}>+ GST 5% (RCM): ₹ {inr(detGst)}</span>
            </p>
          </div>

          {/* Invoice numbers + actions */}
          <div style={S.card}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '12px', marginBottom: '14px' }}>
              <div><label style={S.label}>Freight Invoice No</label><input style={S.input} value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} /></div>
              <div><label style={S.label}>Detention Invoice No</label><input style={S.input} value={detInvoiceNo} onChange={e => setDetInvoiceNo(e.target.value)} /></div>
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button onClick={printInvoices} style={{ ...S.btn('#8b5cf6', false), flex: isMobile ? 1 : 'none' }}>🖨️ Print / PDF — Bill + Detention + Annexure</button>
              <button onClick={saveAndPost} disabled={saving} style={{ ...S.btn('#10b981', saving), flex: isMobile ? 1 : 'none' }}>{saving ? '⌛ Saving…' : '💾 Save & Mark Trips BILLED (+ Journal)'}</button>
            </div>
            <p style={{ fontSize: '11px', color: '#64748b', marginTop: '10px' }}>Print browser ke "Save as PDF" se — format: numbered LR lines, RCM GST note, UDYAM ({co.udyam}), bank details ({co.bank_name}). Journal posting idempotent hai (CN-wise) — dobara save par duplicate nahi.</p>
          </div>
        </>
      )}
    </div>
  );
}
