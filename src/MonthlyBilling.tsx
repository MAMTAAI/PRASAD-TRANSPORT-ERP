// @ts-nocheck
// 🧾 CUSTOMER-WISE MONTHLY AUTO-BILLING DASHBOARD — multi-transport-company.
// The group runs several transport companies (PRASAD TRANSPORT, JAISWAL
// ENTERPRISE, …); every bill MUST go out under the company that actually ran
// the trips. The engine auto-detects the operating company from the selected
// trips, bills under that company's letterhead/GSTIN/bank/invoice-series, and
// blocks mixed-company billing.
// Formats reproduced from the owner's real signed bills (AADHAR June 2026):
//   • Tax Invoice (Transportation Bill RCM) — numbered CN lines, HSN 996791,
//     CGST 2.5% + SGST 2.5% table, tax-in-words, RCM + MSME remarks, bank.
//   • Tax Invoice (Detention Charge RCM) — same skeleton.
//   • Detention Annexure — per-vehicle groups with Loading/Reporting/Unloading
//     date-times, detention start/end, days, rate, subtotals + grand total.
// Detention rule (from the real annexure): start = plant-reporting + FREE
// days (default 4); days counted INCLUSIVE of start and end.
import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { postEntry } from './lib/accounting/journal';
import { round2, toISODate } from './lib/accounting/tripMath';
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
const addDays = (iso, n) => { const d = toISODate(iso); return d ? new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10) : ''; };
/** Detention days INCLUSIVE of both ends (real annexure: 08.06→08.06 = 1 day). */
const detDaysInclusive = (start, end) => {
  const ta = new Date(toISODate(start)).getTime(), tb = new Date(toISODate(end)).getTime();
  if (isNaN(ta) || isNaN(tb) || tb < ta) return 0;
  return Math.round((tb - ta) / 86400000) + 1;
};
/** Fiscal-year token for invoice series: 2026-06 → '26-27' (Apr–Mar). */
const fyToken = (monthISO) => {
  const [y, m] = monthISO.split('-').map(Number);
  const startY = m >= 4 ? y : y - 1;
  return `${String(startY).slice(2)}-${String(startY + 1).slice(2)}`;
};
const companyInitials = (name) => String(name || '').replace(/^M\/S\.?\s*/i, '').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 3) || 'CO';

// Per customer+company billing defaults remembered on this machine.
const billDefaults = (cust, comp) => {
  try { return JSON.parse(localStorage.getItem(`pt_bill_defaults_${comp}__${cust}`) || 'null') || {}; } catch { return {}; }
};
const rememberBillDefaults = (cust, comp, d) => {
  try { localStorage.setItem(`pt_bill_defaults_${comp}__${cust}`, JSON.stringify(d)); } catch { /* best-effort */ }
};

export default function MonthlyBilling() {
  const { isMobile } = useIsMobile();
  const [trips, setTrips] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [companiesList, setCompaniesList] = useState([]);
  const [loading, setLoading] = useState(true);

  const [cust, setCust] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [freightRate, setFreightRate] = useState('1500');
  const [detRate, setDetRate] = useState('2500');
  const [freeDays, setFreeDays] = useState('4');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [detInvoiceNo, setDetInvoiceNo] = useState('');
  const [rows, setRows] = useState([]);        // freight rows (editable)
  const [detRows, setDetRows] = useState([]);  // detention rows (editable)
  const [generated, setGenerated] = useState(false);
  const [saving, setSaving] = useState(false);

  // 🏢 MULTI-COMPANY: which transport company is this bill going out under?
  const [opCompany, setOpCompany] = useState('');
  const [detectedCompanies, setDetectedCompanies] = useState([]); // [{name, count}]

  // 🗓️ CUSTOMER BILLING CYCLE: '15_days' (fortnightly, Oil Cos) | '30_days'.
  // Read from the customer master the moment a customer is picked; drives the
  // period chips + validation below.
  const [period, setPeriod] = useState('FULL'); // FULL | H1 (1–15) | H2 (16–end)

  // ➖ DEDUCTIONS & ADJUSTMENTS: TDS (on freight only) + shortage + advance.
  const [tdsPct, setTdsPct] = useState('2');
  const [shortageAmt, setShortageAmt] = useState('');
  const [advanceAmt, setAdvanceAmt] = useState('');

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
      setCompaniesList([...coSnap1.docs, ...coSnap2.docs].map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const tripCust = (t) => String(t.customer_name || t.Customer || t.Registered_Assessee || '').trim();
  const tripCompany = (t) => String(t.operating_company || t.Operating_Company || t.company || '').trim();
  const customerOptions = useMemo(() => {
    const set = new Set(customers.map(c => c.customer_name).filter(Boolean));
    trips.forEach(t => { const c = tripCust(t); if (c) set.add(c); });
    return [...set].sort();
  }, [customers, trips]);
  // Operating-company options for the TOP filter: company master ∪ trips.
  const companyOptions = useMemo(() => {
    const set = new Set(companiesList.map(c => c.company_name || c.name).filter(Boolean));
    trips.forEach(t => { const c = tripCompany(t); if (c) set.add(c); });
    return [...set].sort();
  }, [companiesList, trips]);
  const [companyFilterSel, setCompanyFilterSel] = useState('AUTO'); // AUTO = detect from trips

  // The picked customer's configured cycle (from CUSTOMERS master).
  const custCycle = useMemo(() => {
    const rec = customers.find(c => String(c.customer_name || '').toLowerCase() === cust.toLowerCase());
    return rec?.billing_cycle === '15_days' ? '15_days' : rec?.billing_cycle === '30_days' ? '30_days' : '';
  }, [customers, cust]);
  // Smart default: 15-day customer → 1st Half auto-selected; 30-day → full month.
  useEffect(() => {
    if (custCycle === '15_days') setPeriod(p => p === 'FULL' ? 'H1' : p);
    else setPeriod('FULL');
  }, [custCycle]);

  // 🧹 STRICT STATE RESET (anti-leakage): customer / company-filter / month /
  // period mein SE KUCH BHI badalte hi poora bill-in-progress turant zero —
  // purane customer/company ki trips, TDS, shortage, advance naye bill mein
  // kabhi leak nahi ho sakte. User ko dobara Fetch karna padta hai.
  useEffect(() => {
    setRows([]); setDetRows([]); setGenerated(false);
    setDetectedCompanies([]); setOpCompany('');
    setShortageAmt(''); setAdvanceAmt(''); setTdsPct('2');
    setInvoiceNo(''); setDetInvoiceNo('');
  }, [cust, companyFilterSel, month, period]);
  // Company chip switch (post-fetch) = alag bill → bill-specific deductions reset.
  useEffect(() => { setShortageAmt(''); setAdvanceAmt(''); }, [opCompany]);

  // Period → concrete date range for the chosen month.
  const periodRange = () => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    if (period === 'H1') return { from: `${month}-01`, to: `${month}-15` };
    if (period === 'H2') return { from: `${month}-16`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
  };
  const periodLabel = () => {
    const ml = month ? new Date(month + '-01').toLocaleString('en-GB', { month: 'long', year: 'numeric' }) : '';
    if (period === 'H1') return `1st Fortnight (01–15) ${ml}`;
    if (period === 'H2') return `2nd Fortnight (16–End) ${ml}`;
    return ml;
  };

  // 1️⃣ FETCH TRIPS: customer + month + operating company → UNBILLED completed trips
  const loadMonth = () => {
    if (!cust || !month) return alert('⚠️ Customer aur month dono chunein!');
    // 🗓️ CYCLE VALIDATION: 15-day customer ka full-month bill galti se na bane.
    if (custCycle === '15_days' && period === 'FULL') {
      if (!window.confirm(`⚠️ WARNING: ${cust} ki billing cycle 15 DIN (Fortnightly) set hai — Oil Company pattern.\n\nAap pura mahina (1–${month.slice(0, 7)} end) bill karne ja rahe hain. Normally iske do alag fortnight bills bante hain.\n\nPhir bhi FULL MONTH ka bill banayein?`)) return;
    }
    const { from, to } = periodRange();
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    let picked = trips.filter(t => {
      if (norm(tripCust(t)) !== norm(cust)) return false;
      const d = toISODate(t.start_date || t.Loading_Date || t.loading_date);
      if (!d || d < from || d > to) return false;
      if ((t.billing_status || '') === 'BILLED') return false; // unbilled only
      // 🏢 Top-bar company filter: sirf chuni hui company ke trips.
      if (companyFilterSel !== 'AUTO' && tripCompany(t) && norm(tripCompany(t)) !== norm(companyFilterSel)) return false;
      return (t.trip_status || t.Trip_Status) === 'COMPLETED' || t.unloading_date; // completed LRs
    }).sort((a, b) => toISODate(a.start_date || a.Loading_Date).localeCompare(toISODate(b.start_date || b.Loading_Date)));

    if (!picked.length) { alert('⚠️ Is customer + month' + (companyFilterSel !== 'AUTO' ? ` + ${companyFilterSel}` : '') + ' ke liye koi UNBILLED completed trip nahi mili.'); return; }

    // 🧹 Dedupe by CN number — the trip DB can hold double entries for one
    // movement (known data issue); a bill must list each CN exactly once.
    const seenCn = new Set(); const dupes = [];
    picked = picked.filter(t => {
      const cn = String(t.challan_no || t.Challan_No || '').trim();
      if (!cn) return true;
      if (seenCn.has(cn)) { dupes.push(cn); return false; }
      seenCn.add(cn); return true;
    });
    if (dupes.length) alert(`🧹 ${dupes.length} duplicate CN hata diye (DB me double entry): ${[...new Set(dupes)].join(', ')}`);

    // 🏢 MULTI-COMPANY CHECK: kaun si transport company ne ye trips chalayi?
    const compCount = new Map();
    picked.forEach(t => { const c = tripCompany(t) || '(company not set)'; compCount.set(c, (compCount.get(c) || 0) + 1); });
    const detected = [...compCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    setDetectedCompanies(detected);
    const mainCompany = companyFilterSel !== 'AUTO' ? companyFilterSel
      : detected[0]?.name !== '(company not set)' ? detected[0].name
        : (companiesList[0]?.company_name || companiesList[0]?.name || '');
    setOpCompany(mainCompany);
    if (detected.filter(d => d.name !== '(company not set)').length > 1) {
      alert(`🏢 SAVDHAN: Is month ki trips ${detected.length} alag transport companies ki hain:\n${detected.map(d => `• ${d.name}: ${d.count} trips`).join('\n')}\n\nBill sirf chuni hui company ki trips ka banega — company selector se badal kar dusri company ka bill alag banayein.`);
    }

    const defaults = billDefaults(cust, mainCompany);
    if (defaults.freightRate) setFreightRate(String(defaults.freightRate));
    if (defaults.detRate) setDetRate(String(defaults.detRate));
    if (defaults.freeDays !== undefined) setFreeDays(String(defaults.freeDays));
    const fd = parseInt(defaults.freeDays !== undefined ? defaults.freeDays : freeDays) || 0;

    setRows(picked.map(t => ({
      tripId: t.id,
      company: tripCompany(t),
      date: toISODate(t.start_date || t.Loading_Date || t.loading_date),
      cn: String(t.challan_no || t.Challan_No || t.trip_id || t.Trip_ID || '').trim(),
      vehicle: String(t.vehicle_no || t.Vehical_No || '').replace(/\s+/g, ''),
      qty: parseFloat(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || 0) || 0,
      unloadDate: toISODate(t.unloading_date || (t.completed_at || '').slice(0, 10)),
      include: true,
    })));
    // ⏱️ Detention (real rule): reporting + FREE days = detention start;
    // days counted inclusive. Best reporting source: driver's 🏭 plant stamp.
    setDetRows(picked.map(t => {
      const load = toISODate(t.start_date || t.Loading_Date || t.loading_date);
      const report = toISODate(t.plant_reported_at) || (load ? addDays(load, 1) : '');
      const end = toISODate(t.unloading_date || (t.completed_at || '').slice(0, 10)) || '';
      const start = report ? addDays(report, fd) : '';
      const days = detDaysInclusive(start, end);
      return {
        tripId: t.id,
        company: tripCompany(t),
        vehicle: String(t.vehicle_no || t.Vehical_No || '').replace(/\s+/g, ''),
        cn: String(t.challan_no || t.Challan_No || t.trip_id || t.Trip_ID || '').trim(),
        consignee: String(t.consignee_name || t.Consignee_Name || '').trim(),
        loadDate: load, reportDate: report, unloadDate: end,
        startDate: days > 0 ? start : '', endDate: days > 0 ? end : '',
        days, include: days > 0,
      };
    }));
    setGenerated(true);
  };

  // 🏢 Active company master record — 100% DYNAMIC, no hardcoded company
  // details. Jo field Company Master mein nahi hai wo '—' dikhega aur upar
  // warning aayegi; kisi ek company ka data doosri par kabhi print nahi hota.
  const coRec = useMemo(() =>
    companiesList.find(c => String(c.company_name || c.name || '').toUpperCase() === String(opCompany).toUpperCase()) || {},
    [companiesList, opCompany]);
  const co = {
    name: opCompany || '—',
    address: coRec.address || coRec.Address || '',
    gstin: coRec.gst_no || coRec.GSTIN || coRec.gstin || '',
    pan: coRec.pan_no || coRec.pan || '',
    state: coRec.state || 'Assam, Code : 18',
    email: coRec.email || '',
    udyam: coRec.udyam_no || coRec.udyam || '',
    bank_name: coRec.bank_name || '',
    account_no: coRec.account_no || coRec.bank_account || '',
    ifsc: coRec.ifsc_code || '',
    branch: coRec.bank_branch || '',
  };
  const missingCoFields = ['gstin', 'pan', 'bank_name', 'account_no', 'ifsc'].filter(f => !co[f]);
  // Auto invoice series per company: PT/26-27/____ (editable)
  useEffect(() => {
    if (!opCompany) return;
    const prefix = `${companyInitials(opCompany)}/${fyToken(month)}/`;
    setInvoiceNo(p => (!p || !p.startsWith(prefix)) ? prefix : p);
    setDetInvoiceNo(p => (!p || !p.startsWith(prefix)) ? prefix : p);
  }, [opCompany, month]);

  // Rows restricted to the chosen operating company (unset-company trips ride along with a badge)
  const companyFilter = (r) => !r.company || !opCompany || r.company.toUpperCase() === opCompany.toUpperCase();
  const visRows = rows.filter(companyFilter);
  const visDetRows = detRows.filter(companyFilter);
  const excludedCount = rows.length - visRows.length;

  // 💰 LIVE TOTALS (recompute on every selection change)
  // 🎯 PRECISION RULE: freight is rounded PER TRIP first, then summed — so the
  // invoice total ALWAYS equals the sum of the per-trip journal entries to the
  // paisa (totalQty×rate can drift by paise on fractional KL).
  const fRows = visRows.filter(r => r.include);
  const tripFreightOf = (r) => round2((parseFloat(r.qty) || 0) * (parseFloat(freightRate) || 0));
  const totalQty = round2(fRows.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0));
  const freightTotal = round2(fRows.reduce((s, r) => s + tripFreightOf(r), 0));
  const dRows = visDetRows.filter(r => r.include && r.days > 0);
  const totalDetDays = dRows.reduce((s, r) => s + r.days, 0);
  const detTotal = round2(totalDetDays * (parseFloat(detRate) || 0));
  const taxable = round2(freightTotal + detTotal);
  const cgst = round2(taxable * 0.025);
  const sgst = round2(taxable * 0.025);
  const grandWithGst = round2(taxable + cgst + sgst);
  // ➖ Deductions: TDS sirf Freight par; shortage/advance manual.
  const tdsAmt = round2(freightTotal * ((parseFloat(tdsPct) || 0) / 100));
  const shortageDed = round2(parseFloat(shortageAmt) || 0);
  const advanceDed = round2(parseFloat(advanceAmt) || 0);
  const totalDeductions = round2(tdsAmt + shortageDed + advanceDed);
  // Sub Total = Freight + Detention + GST (RCM); Net Payable = Sub − Deductions.
  const netPayable = round2(grandWithGst - totalDeductions);

  const editRow = (i, f, v) => setRows(p => p.map((r) => r.tripId === i ? { ...r, [f]: f === 'qty' ? (parseFloat(v) || 0) : v } : r));
  const editDet = (i, f, v) => setDetRows(p => p.map((r) => {
    if (r.tripId !== i) return r;
    const nr = { ...r, [f]: v };
    if (f === 'startDate' || f === 'endDate') nr.days = detDaysInclusive(nr.startDate, nr.endDate);
    if (f === 'days') nr.days = Math.max(0, parseInt(v) || 0);
    return nr;
  }));

  const monthLabel = month ? new Date(month + '-01').toLocaleString('en-GB', { month: 'long', year: 'numeric' }) : '';

  // 🖨️ EXACT TAX-INVOICE PRINT (reproduced from the real signed bills)
  const printInvoices = () => {
    if (missingCoFields.length) {
      if (!window.confirm(`⚠️ ${co.name} ke Company Master mein ye fields khali hain: ${missingCoFields.join(', ').toUpperCase()}.\n\nBill mein ye '—'/blank print honge. Phir bhi preview karein?\n(CRM → Company Master mein bhar dein to hamesha sahi aayega.)`)) return;
    }
    const custMaster = customers.find(c => (c.customer_name || '').toLowerCase() === cust.toLowerCase()) || {};
    const custAddr = custMaster.address || custMaster.billing_address || '';
    const custGstin = custMaster.gst_no || '';
    const invDate = dmy(new Date().toISOString()).replace(/\./g, '-');

    // Boxed Tax Invoice skeleton — company block, invoice meta, buyer block.
    const invoiceShell = (title, invNo, particularsHtml, taxableAmt, note, extraHtml) => {
      const cg = round2(taxableAmt * 0.025), sg = round2(taxableAmt * 0.025);
      return `
      <div class="inv">
        <h2 class="title">${title}</h2>
        <table class="frame"><tr>
          <td class="co-block" rowspan="2">
            <b class="co-name">${co.name}</b><br/>${co.address}<br/>
            GSTIN/UIN: ${co.gstin}<br/>State Name : ${co.state}${co.email ? `<br/>E-Mail : ${co.email}` : ''}
          </td>
          <td class="w25"><span class="k">Invoice No.</span><br/><b>${invNo}</b></td>
          <td class="w25"><span class="k">Dated</span><br/><b>${invDate}</b></td>
        </tr><tr>
          <td><span class="k">Delivery Note</span></td>
          <td><span class="k">Mode/Terms of Payment</span><br/><b>15 Days</b></td>
        </tr><tr>
          <td rowspan="2" class="buyer">
            <span class="k">Buyer (Bill to)</span><br/><b>${cust}</b><br/>${custAddr}
            ${custGstin ? `<br/>GSTIN/UIN&nbsp;&nbsp;: ${custGstin}` : ''}
            <br/>State Name&nbsp;: Assam, Code : 18<br/>Place of Supply : Assam
          </td>
          <td><span class="k">Bill of Lading/LR-RR No.</span><br/><b>Multiple</b></td>
          <td><span class="k">Motor Vehicle No.</span><br/><b>Multiple</b></td>
        </tr><tr>
          <td colspan="2"><span class="k">Terms of Delivery</span><br/>
            <b>1.Freight to Be Credited in Our Bank Account Only<br/>2.Deduct TDS As Applicable</b></td>
        </tr></table>

        <table class="parts"><thead><tr><th>Particulars</th><th class="w12">HSN/SAC</th><th class="w15">Amount</th></tr></thead>
          <tbody><tr><td class="pcell">${particularsHtml}</td><td class="c v-top">996791</td><td class="r v-top"><b>${inr(taxableAmt)}</b></td></tr>
          <tr><td class="r"><b>Total</b></td><td></td><td class="r total-amt"><b>₹ ${inr(taxableAmt)}</b></td></tr></tbody>
        </table>

        <div class="words-row"><span class="k">Amount Chargeable (in words)</span><span class="eoe">E. & O.E</span><br/><b>${amountInWords(taxableAmt)}</b></div>
        <table class="gst"><thead>
          <tr><th rowspan="2">HSN/SAC</th><th rowspan="2">Taxable<br/>Value</th><th colspan="2">CGST</th><th colspan="2">SGST/UTGST</th><th rowspan="2">Total<br/>Tax Amount</th></tr>
          <tr><th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th></tr></thead>
          <tbody>
            <tr><td>996791</td><td class="r">${inr(taxableAmt)}</td><td class="c">2.50%</td><td class="r">${inr(cg)}</td><td class="c">2.50%</td><td class="r">${inr(sg)}</td><td class="r">${inr(cg + sg)}</td></tr>
            <tr class="b"><td class="r">Total</td><td class="r">${inr(taxableAmt)}</td><td></td><td class="r">${inr(cg)}</td><td></td><td class="r">${inr(sg)}</td><td class="r">${inr(cg + sg)}</td></tr>
          </tbody>
        </table>
        <p class="taxwords"><span class="k">Tax Amount (in words) :</span> <b>${amountInWords(cg + sg).replace('INR', 'INR')}</b><br/><span class="k">Amount of tax subject to Reverse Charge</span></p>
        ${extraHtml || ''}

        <table class="foot-t"><tr>
          <td class="remarks">
            <i>Remarks:</i><br/>1.Taxes and Duties GST @ 5% under reverse charge mechanism (RCM) payable by ${cust} to the concerned authorities.${co.udyam ? ` 2. We are MSME registered enterprise ${co.udyam} and providing transportation services to your company.` : ''}<br/>
            Company's PAN&nbsp;&nbsp;&nbsp;: <b>${co.pan || '—'}</b>
          </td>
          <td class="bank">
            <span class="k">Company's Bank Details</span><br/>
            A/c Holder's Name: <b>${co.name}</b><br/>
            Bank Name&nbsp;&nbsp;&nbsp;&nbsp;: <b>${co.bank_name}</b><br/>
            A/c No.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: <b>${co.account_no}</b><br/>
            Branch & IFS Code: <b>${co.branch} & ${co.ifsc}</b>
            <div class="sig">for <b>${co.name}</b><br/><br/><br/>Authorised Signatory</div>
          </td>
        </tr></table>
        ${note ? `<p class="note">${note}</p>` : ''}
        <p class="foot">SUBJECT TO BONGAIGAON JURISDICTION<br/>This is a Computer Generated Invoice</p>
      </div>`;
    };

    // Freight particulars: numbered CN lines exactly like the real bill.
    const freightLines = fRows.map((r, i) => `${i + 1}.Dt-${dmy(r.date)},CN-${r.cn},${r.vehicle},Qty-${r.qty} KL`).join('<br/>');
    const freightParticulars = `<b>Transportion Bills (RCM)</b><br/><i>Bill for the Period: ${periodLabel()}</i><br/>${freightLines}<br/><br/><b>Total Freight = ${totalQty} KL Qty*Rate ${freightRate} KL</b>`;

    // Detention annexure grouped per vehicle with subtotals (real layout).
    const byVeh = {};
    dRows.forEach(r => { (byVeh[r.vehicle] ||= []).push(r); });
    const annexRows = Object.entries(byVeh).map(([veh, list]) => {
      const sub = round2(list.reduce((s, r) => s + r.days * (parseFloat(detRate) || 0), 0));
      const subDays = list.reduce((s, r) => s + r.days, 0);
      const trs = list.map((r, i) => `<tr>
        <td class="c">${i + 1}</td><td>${veh}</td><td class="c">${r.cn}</td><td>${cust}</td><td>${r.consignee}</td><td class="c">Nil</td>
        <td class="c">${dmy(r.loadDate)}</td><td class="c">${dmy(r.reportDate)}</td><td class="c">${dmy(r.unloadDate)}</td>
        <td class="c">${r.days > 0 ? dmy(r.startDate) : ''}</td><td class="c">${r.days > 0 ? dmy(r.endDate) : ''}</td>
        <td class="c">${r.days}</td><td class="r">${inr(detRate)}</td><td class="r">${r.days > 0 ? inr(r.days * (parseFloat(detRate) || 0)) : '-'}</td>
      </tr>`).join('');
      return `${trs}<tr class="sub"><td colspan="11"></td><td class="c"><b>${subDays}</b></td><td><b>Total</b></td><td class="r"><b>${inr(sub)}</b></td></tr>`;
    }).join('');
    const annexHtml = `
      <div class="inv">
        <div class="annex-head"><b class="co-name">${co.name}</b><span>Details Regarding Detention Charge @ Unloading Point — ${periodLabel()}</span></div>
        <table class="annex"><thead><tr>
          <th>Sl No</th><th>Tanker No</th><th>CN No.</th><th>Consignor</th><th>Consignee</th><th>Shortage</th>
          <th>Loading Date</th><th>Reporting Date at Plant</th><th>Unloading Date</th>
          <th>Detention Start</th><th>Detention End</th><th>No. Days</th><th>Rate/Day</th><th>Detention Amount</th>
        </tr></thead><tbody>
          ${annexRows}
          <tr class="grand"><td colspan="13" class="r"><b>Grand Total =</b></td><td class="r"><b>${inr(detTotal)}</b></td></tr>
        </tbody></table>
        <p><b>In words : ${amountInWords(detTotal).replace('INR ', '')}</b></p>
        <div class="sig-r">For ${co.name}</div>
      </div>`;

    const w = window.open('', '_blank');
    if (!w) return alert('Popup allow karein — print window khulti hai.');
    w.document.write(`<!doctype html><html><head><title>${cust} — ${periodLabel()} Bills (${co.name})</title><style>
      * { box-sizing: border-box; } body { font-family: Arial, sans-serif; color: #111; margin: 0; padding: 18px; font-size: 12px; }
      .title { text-align: center; font-size: 16px; margin: 0 0 8px; }
      .frame, .parts, .gst, .foot-t, .annex { width: 100%; border-collapse: collapse; }
      .frame td { border: 1px solid #111; padding: 5px 8px; vertical-align: top; }
      .co-block { width: 46%; } .co-name { font-size: 14px; }
      .k { font-size: 10px; color: #333; } .w25 { width: 27%; } .buyer { }
      .parts { margin-top: -1px; } .parts th, .parts td { border: 1px solid #111; padding: 6px 8px; }
      .parts th { font-size: 11px; } .pcell { font-size: 11.5px; line-height: 1.55; }
      .w12 { width: 12%; } .w15 { width: 15%; } .v-top { vertical-align: top; }
      .total-amt { font-size: 14px; }
      .words-row { border: 1px solid #111; border-top: none; padding: 5px 8px; position: relative; }
      .eoe { position: absolute; right: 8px; top: 4px; font-style: italic; font-size: 10px; }
      .gst { margin-top: 6px; } .gst th, .gst td { border: 1px solid #111; padding: 4px 6px; font-size: 11px; }
      .gst .b td { font-weight: bold; }
      .taxwords { margin: 6px 0; }
      .foot-t td { border: 1px solid #111; padding: 6px 8px; vertical-align: top; width: 50%; }
      .remarks { font-size: 10.5px; } .bank { font-size: 11px; }
      .sig { text-align: right; margin-top: 14px; font-size: 11px; }
      .sig-r { text-align: right; margin-top: 25px; font-weight: bold; }
      .c { text-align: center; } .r { text-align: right; }
      .foot { text-align: center; font-size: 10px; margin-top: 10px; }
      .note { font-size: 10px; }
      .annex-head { display: flex; justify-content: space-between; align-items: center; border: 1px solid #111; padding: 8px; margin-bottom: -1px; font-size: 12px; }
      .annex th, .annex td { border: 1px solid #111; padding: 3px 4px; font-size: 9.5px; }
      .annex .sub td { background: #f3f3f3; } .annex .grand td { background: #e8e8e8; }
      .pagebreak { page-break-after: always; }
      @media print { body { padding: 6mm; } .annex-page { size: landscape; } }
    </style></head><body>
      ${invoiceShell('Tax Invoice', invoiceNo, freightParticulars, freightTotal, '', totalDeductions > 0 ? `
        <table class="gst" style="margin-top:8px;"><thead><tr><th colspan="2">Deductions & Net Payable Settlement</th></tr></thead><tbody>
          <tr><td>Sub Total (Freight ₹${inr(freightTotal)} + Detention ₹${inr(detTotal)} + GST RCM ₹${inr(cgst + sgst)})</td><td class="r">₹ ${inr(grandWithGst)}</td></tr>
          ${tdsAmt > 0 ? `<tr><td>Less: TDS @ ${tdsPct}% on Freight (Sec 194C)</td><td class="r">− ₹ ${inr(tdsAmt)}</td></tr>` : ''}
          ${shortageDed > 0 ? `<tr><td>Less: Shortage Deduction</td><td class="r">− ₹ ${inr(shortageDed)}</td></tr>` : ''}
          ${advanceDed > 0 ? `<tr><td>Less: Advance Already Paid</td><td class="r">− ₹ ${inr(advanceDed)}</td></tr>` : ''}
          <tr class="b"><td><b>Total Deductions</b></td><td class="r"><b>− ₹ ${inr(totalDeductions)}</b></td></tr>
          <tr class="b" style="background:#eee;"><td><b>NET PAYABLE AMOUNT</b></td><td class="r"><b>₹ ${inr(netPayable)}</b></td></tr>
          <tr><td colspan="2"><b>${amountInWords(netPayable)}</b> (Net Payable)</td></tr>
        </tbody></table>` : '')}
      <div class="pagebreak"></div>
      ${detTotal > 0 ? `${invoiceShell('Tax Invoice', detInvoiceNo, `<b>Detention Charge (RCM)</b><br/><i>${periodLabel()} — as per enclosed Annexure</i>`, detTotal)}<div class="pagebreak"></div>${annexHtml}` : ''}
      <script>window.onload = () => setTimeout(() => window.print(), 400);</script>
    </body></html>`);
    w.document.close();
  };

  // 💾 SAVE & MARK BILLED: transaction-style batch + idempotent journal (company-tagged)
  const saveAndPost = async () => {
    if (!fRows.length || saving) return;
    // 🛡️ MULTI-COMPANY VERIFICATION (backend-side guard): ek invoice mein
    // sirf EK operating company ke trips ja sakte hain — mixed batch reject.
    const foreign = fRows.filter(r => r.company && r.company.toUpperCase() !== String(opCompany).toUpperCase());
    if (foreign.length) {
      return alert(`🚫 BLOCKED: ${foreign.length} selected trips ${co.name} ki nahi hain (${[...new Set(foreign.map(r => r.company))].join(', ')}).\n\nEk bill mein alag-alag companies ke trips mix nahi ho sakte. Company selector se sahi company chunein ya un trips ko untick karein.`);
    }
    if (!opCompany) return alert('🚫 Pehle operating company chunein — bill bina company ke save nahi hoga.');
    if (!window.confirm(`🏢 ${co.name} ke naam se:\n\n${fRows.length} trips BILLED mark hongi\nFreight ₹${inr(freightTotal)} + Detention ₹${inr(detTotal)}\nGST (RCM 2.5+2.5): ₹${inr(cgst + sgst)}\n\nJournal me post karein?`)) return;
    setSaving(true);
    try {
      // 🛡️ FINAL PRE-COMMIT VERIFICATION against the SOURCE data (not UI row
      // state): (a) 100% company isolation via .every(), (b) no trip already
      // BILLED (double-billing guard). Mismatch = hard stop, nothing writes.
      const tripById = new Map(trips.map(t => [t.id, t]));
      const companyOk = fRows.every(r => {
        const src = tripById.get(r.tripId);
        const tc = src ? tripCompany(src) : r.company;
        return !tc || tc.toUpperCase() === String(opCompany).toUpperCase();
      });
      if (!companyOk) throw new Error(`COMPANY MISMATCH: kuch selected trips ${co.name} ki nahi hain (source data cross-check fail). Bill cancel — dobara Fetch karke sahi company chunein.`);
      const dblBilled = fRows.filter(r => (tripById.get(r.tripId)?.billing_status || '') === 'BILLED');
      if (dblBilled.length) throw new Error(`DOUBLE-BILLING BLOCKED: ${dblBilled.length} trips (CN ${dblBilled.map(r => r.cn).join(', ')}) pehle se BILLED hain. Screen refresh karke dobara Fetch karein.`);

      const perTripFreight = {};
      fRows.forEach(r => { perTripFreight[r.tripId] = tripFreightOf(r); });
      // Atomic batch: all trips flip BILLED together with the invoice record.
      const batch = writeBatch(db);
      fRows.forEach(r => {
        batch.update(doc(db, 'TRIPS', r.tripId), {
          gross_freight: perTripFreight[r.tripId], rate: parseFloat(freightRate) || 0,
          billing_status: 'BILLED', billed_bill_no: invoiceNo, billed_at: new Date().toISOString(),
          billed_company: co.name,
        });
      });
      batch.set(doc(collection(db, 'MONTHLY_INVOICES')), {
        customer: cust, month, company: co.name,
        billing_cycle: custCycle || '30_days', billing_period: period, period_from: periodRange().from, period_to: periodRange().to,
        invoice_no: invoiceNo, det_invoice_no: detInvoiceNo,
        total_qty: totalQty, freight_rate: parseFloat(freightRate) || 0, freight_total: freightTotal,
        detention_total: detTotal, det_rate: parseFloat(detRate) || 0, det_days: totalDetDays, free_days: parseInt(freeDays) || 0,
        taxable, cgst, sgst, grand_with_gst: grandWithGst,
        // ➖ Deductions snapshot (future ledger/settlement accuracy)
        tds_pct: parseFloat(tdsPct) || 0, tds_amount: tdsAmt,
        shortage_amount: shortageDed, advance_deduction: advanceDed,
        total_deductions: totalDeductions, net_payable: netPayable,
        trip_ids: fRows.map(r => r.tripId), createdAt: serverTimestamp(),
      });
      await batch.commit();

      let jOk = 0; const errs = [];
      for (const r of fRows) {
        try {
          await postEntry({
            source_type: 'TRIP_FREIGHT', source_ref: r.cn || r.tripId, date: r.date,
            narration: `Freight — CN ${r.cn} (${r.vehicle}) bill ${invoiceNo}`,
            company: co.name,
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
            narration: `Detention charges ${periodLabel()} — ${cust} (${totalDetDays} days @ ₹${detRate})`,
            company: co.name,
            lines: [
              { ledger: `Debtors: ${cust}`, dr_cr: 'Dr', amount: detTotal },
              { ledger: 'Direct Incomes (Detention Charges)', dr_cr: 'Cr', amount: detTotal },
            ],
          }); jOk++;
        } catch (e) { errs.push(`Detention: ${e.message}`); }
      }
      rememberBillDefaults(cust, co.name, { freightRate, detRate, freeDays });
      alert(`✅ ${co.name}: ${fRows.length} trips BILLED + ${jOk} journal entries post ho gayi.${errs.length ? '\n⚠️ ' + errs.join('\n') : ''}`);
      fetchAll();
    } catch (e) { console.error(e); alert('❌ Save fail: ' + (e.message || 'error')); }
    setSaving(false);
  };

  const S = {
    page: { padding: 'clamp(12px, 3vw, 30px)', paddingBottom: '170px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif" },
    card: { background: 'rgba(30,41,59,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: 'clamp(14px,3vw,25px)', marginBottom: '18px' },
    input: { background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: '10px', color: 'white', padding: '11px', width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: '44px', colorScheme: 'dark' },
    btn: (bg, dis) => ({ background: dis ? '#475569' : bg, color: 'white', border: 'none', borderRadius: '10px', padding: '13px 20px', fontWeight: 'bold', cursor: dis ? 'default' : 'pointer', minHeight: '48px' }),
    label: { display: 'block', fontSize: '11px', color: '#94a3b8', fontWeight: 'bold', marginBottom: '5px' },
    cell: { background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: '6px', color: 'white', padding: '6px', minHeight: '32px', boxSizing: 'border-box', colorScheme: 'dark' },
  };

  return (
    <div style={S.page} className="pt-anim-fade">
      <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: '0 0 4px 0', color: '#38bdf8' }}>🧾 Customer-Wise Auto-Billing</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 18px 0', fontSize: '13px' }}>Multi-company: bill hamesha usi transport company ke naam se banta hai jiski trips hain — letterhead, GSTIN, bank aur invoice series sab us company ki.</p>

      {/* Step 1: selection */}
      <div style={S.card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: '12px' }}>
          <div style={{ gridColumn: isMobile ? 'auto' : 'span 2' }}><label style={S.label}>Customer *</label>
            <input list="mb-cust" style={S.input} value={cust} onChange={e => setCust(e.target.value)} placeholder="e.g. Aadhar Green Industries LLP" />
            <datalist id="mb-cust">{customerOptions.map(c => <option key={c} value={c} />)}</datalist>
          </div>
          <div><label style={{ ...S.label, color: '#f59e0b' }}>🏢 Operating Company</label>
            <select style={{ ...S.input, borderColor: '#f59e0b' }} value={companyFilterSel} onChange={e => setCompanyFilterSel(e.target.value)}>
              <option value="AUTO">🔍 Auto-detect from trips</option>
              {companyOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label style={S.label}>Month *</label><input type="month" style={S.input} value={month} onChange={e => setMonth(e.target.value)} /></div>
          <div style={{ gridColumn: isMobile ? 'auto' : 'span 2' }}>
            <label style={{ ...S.label, color: custCycle === '15_days' ? '#c084fc' : '#94a3b8' }}>
              🗓️ Billing Period {custCycle === '15_days' ? '— customer cycle: 15 DIN (Fortnightly)' : custCycle === '30_days' ? '— customer cycle: 30 DIN (Monthly)' : ''}
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {custCycle === '15_days' ? (
                <>
                  <button type="button" className={`pt-chip ${period === 'H1' ? 'is-on' : ''}`} onClick={() => setPeriod('H1')}>1st Half (1–15)</button>
                  <button type="button" className={`pt-chip ${period === 'H2' ? 'is-on' : ''}`} onClick={() => setPeriod('H2')}>2nd Half (16–End)</button>
                  <button type="button" className={`pt-chip ${period === 'FULL' ? 'is-on is-on--warning' : ''}`} title="15-din cycle customer — full month par warning aayegi" onClick={() => setPeriod('FULL')}>⚠ Full Month</button>
                </>
              ) : (
                <>
                  <button type="button" className={`pt-chip ${period === 'FULL' ? 'is-on is-on--success' : ''}`} onClick={() => setPeriod('FULL')}>Full Month (1–End)</button>
                  <button type="button" className={`pt-chip ${period === 'H1' ? 'is-on' : ''}`} onClick={() => setPeriod('H1')}>1st Half</button>
                  <button type="button" className={`pt-chip ${period === 'H2' ? 'is-on' : ''}`} onClick={() => setPeriod('H2')}>2nd Half</button>
                </>
              )}
            </div>
            {custCycle === '15_days' && period === 'FULL' && (
              <div className="pt-anim-pop" style={{ marginTop: '6px', fontSize: '11px', color: '#f59e0b', fontWeight: 'bold' }}>⚠️ Is customer ke bill 15-din ke bante hain — Full Month chunne par confirm poocha jayega.</div>
            )}
          </div>
          <div><label style={S.label}>Freight Rate (₹/KL)</label><input type="number" inputMode="decimal" style={S.input} value={freightRate} onChange={e => setFreightRate(e.target.value)} /></div>
          <div><label style={S.label}>Detention ₹/Day</label><input type="number" inputMode="decimal" style={S.input} value={detRate} onChange={e => setDetRate(e.target.value)} /></div>
          <div><label style={S.label}>Free Days (Transit)</label><input type="number" style={S.input} value={freeDays} onChange={e => setFreeDays(e.target.value)} /></div>
        </div>
        <button onClick={loadMonth} disabled={loading} style={{ ...S.btn('#2563eb', loading), width: isMobile ? '100%' : 'auto', marginTop: '14px' }}>
          {loading ? '⌛ Loading…' : '⚡ Fetch Trips'}
        </button>
      </div>

      {generated && (
        <>
          {/* 🏢 OPERATING COMPANY — bill kis transport company ke naam se? */}
          <div style={{ ...S.card, border: '1px solid #f59e0b' }} className="pt-anim-up">
            <label style={{ ...S.label, color: '#f59e0b' }}>🏢 BILL BANEGA IS COMPANY KE NAAM SE (auto-detected from trips)</label>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              {detectedCompanies.map(d => (
                <button key={d.name} className={`pt-chip ${opCompany === d.name ? 'is-on is-on--warning' : ''}`}
                  disabled={d.name === '(company not set)'}
                  onClick={() => setOpCompany(d.name)}>
                  {d.name} · {d.count} trips
                </button>
              ))}
              {companiesList.filter(c => !detectedCompanies.some(d => d.name === (c.company_name || c.name))).map(c => (
                <button key={c.id} className={`pt-chip ${opCompany === (c.company_name || c.name) ? 'is-on is-on--warning' : ''}`} onClick={() => setOpCompany(c.company_name || c.name)}>{c.company_name || c.name}</button>
              ))}
            </div>
            <p style={{ fontSize: '12px', color: '#94a3b8', margin: '10px 0 0' }}>
              Selected: <b style={{ color: '#f59e0b' }}>{co.name}</b> · GSTIN {co.gstin || '—'} · Series {companyInitials(opCompany)}/{fyToken(month)}/…
              {excludedCount > 0 && <span style={{ color: '#ef4444', fontWeight: 'bold' }}> · ⚠ {excludedCount} trips dusri company ki hain — is bill se bahar (company badal kar unka bill alag banayein)</span>}
            </p>
            {missingCoFields.length > 0 && (
              <div className="pt-anim-pop" style={{ marginTop: '10px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px dashed #ef4444', fontSize: '12px', color: '#fca5a5' }}>
                ⚠️ <b>{co.name}</b> ke Company Master mein missing: <b>{missingCoFields.join(', ').toUpperCase()}</b> — bill par ye blank print honge. CRM → Company Master mein bharein (kisi doosri company ka data kabhi use NahI hoga).
              </div>
            )}
          </div>

          {/* Freight rows */}
          <div style={S.card} className="pt-anim-up">
            <b style={{ color: '#10b981' }}>🚛 Transportation Bill — {fRows.length}/{visRows.length} LR/CN selected</b>
            <div style={{ overflowX: 'auto', marginTop: '10px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '640px' }}>
                <thead><tr style={{ color: '#38bdf8', textAlign: 'left' }}>{['✓', 'Loading Date', 'CN No', 'Vehicle', 'Unloading', 'Qty (KL)', 'Freight ₹'].map(h => <th key={h} style={{ padding: '6px', borderBottom: '2px solid #334155' }}>{h}</th>)}</tr></thead>
                <tbody>{visRows.map((r) => (
                  <tr key={r.tripId} style={{ borderBottom: '1px solid #1e293b', opacity: r.include ? 1 : 0.4 }}>
                    <td style={{ padding: '4px' }}><input type="checkbox" style={{ width: '20px', height: '20px', accentColor: '#10b981' }} checked={r.include} onChange={e => editRow(r.tripId, 'include', e.target.checked)} /></td>
                    <td style={{ padding: '4px' }}><input type="date" style={{ ...S.cell, width: '135px' }} value={r.date} onChange={e => editRow(r.tripId, 'date', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input style={{ ...S.cell, width: '100px' }} value={r.cn} onChange={e => editRow(r.tripId, 'cn', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input style={{ ...S.cell, width: '115px' }} value={r.vehicle} onChange={e => editRow(r.tripId, 'vehicle', e.target.value)} /></td>
                    <td style={{ padding: '4px', color: '#94a3b8', fontSize: '12px' }}>{dmy(r.unloadDate) || '—'}</td>
                    <td style={{ padding: '4px' }}><input type="number" inputMode="decimal" style={{ ...S.cell, width: '80px' }} value={r.qty} onChange={e => editRow(r.tripId, 'qty', e.target.value)} /></td>
                    <td style={{ padding: '4px', color: '#10b981', fontWeight: 'bold' }}>₹{inr((parseFloat(r.qty) || 0) * (parseFloat(freightRate) || 0))}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Detention rows */}
          <div style={S.card} className="pt-anim-up">
            <b style={{ color: '#f59e0b' }}>⏱️ Detention — {dRows.length} chargeable · rule: reporting + {freeDays} free days, days inclusive</b>
            <p style={{ fontSize: '11px', color: '#64748b', margin: '4px 0 8px' }}>Reporting = driver ka 🏭 plant stamp (fallback loading+1). Start/End/Days sab editable.</p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '860px' }}>
                <thead><tr style={{ color: '#f59e0b', textAlign: 'left' }}>{['✓', 'Vehicle', 'CN', 'Reported', 'Unloaded', 'Det. Start', 'Det. End', 'Days', 'Amount'].map(h => <th key={h} style={{ padding: '6px', borderBottom: '2px solid #334155' }}>{h}</th>)}</tr></thead>
                <tbody>{visDetRows.map((r) => (
                  <tr key={r.tripId} style={{ borderBottom: '1px solid #1e293b', opacity: r.include ? 1 : 0.4 }}>
                    <td style={{ padding: '4px' }}><input type="checkbox" style={{ width: '20px', height: '20px', accentColor: '#f59e0b' }} checked={r.include} onChange={e => editDet(r.tripId, 'include', e.target.checked)} /></td>
                    <td style={{ padding: '4px', fontWeight: 'bold' }}>{r.vehicle}</td>
                    <td style={{ padding: '4px' }}>{r.cn}</td>
                    <td style={{ padding: '4px', color: '#94a3b8', fontSize: '12px' }}>{dmy(r.reportDate)}</td>
                    <td style={{ padding: '4px', color: '#94a3b8', fontSize: '12px' }}>{dmy(r.unloadDate)}</td>
                    <td style={{ padding: '4px' }}><input type="date" style={{ ...S.cell, width: '135px' }} value={r.startDate} onChange={e => editDet(r.tripId, 'startDate', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input type="date" style={{ ...S.cell, width: '135px' }} value={r.endDate} onChange={e => editDet(r.tripId, 'endDate', e.target.value)} /></td>
                    <td style={{ padding: '4px' }}><input type="number" style={{ ...S.cell, width: '55px', fontWeight: 'bold' }} value={r.days} onChange={e => editDet(r.tripId, 'days', e.target.value)} /></td>
                    <td style={{ padding: '4px', color: '#f59e0b', fontWeight: 'bold' }}>₹{inr(r.days * (parseFloat(detRate) || 0))}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Invoice numbers + actions */}
          <div style={S.card} className="pt-anim-up">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '12px', marginBottom: '14px' }}>
              <div><label style={S.label}>Freight Invoice No ({co.name})</label><input style={S.input} value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} /></div>
              <div><label style={S.label}>Detention Invoice No</label><input style={S.input} value={detInvoiceNo} onChange={e => setDetInvoiceNo(e.target.value)} /></div>
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button onClick={printInvoices} style={{ ...S.btn('#8b5cf6', false), flex: isMobile ? 1 : 'none' }}>🖨️ Preview PDF — Tax Invoice + Detention + Annexure</button>
              <button onClick={saveAndPost} disabled={saving} style={{ ...S.btn('#10b981', saving), flex: isMobile ? 1 : 'none' }}>{saving ? '⌛ Saving…' : '💾 Save & Mark as Billed (+ Journal)'}</button>
            </div>
          </div>

          {/* ➖ DEDUCTIONS & ADJUSTMENTS panel */}
          <div style={{ ...S.card, border: '1px solid #ef4444' }} className="pt-anim-up">
            <b style={{ color: '#ef4444' }}>➖ Deductions & Adjustments</b>
            <p style={{ fontSize: '11px', color: '#64748b', margin: '4px 0 12px' }}>TDS sirf Freight amount par lagta hai · Shortage/Advance manual entry. Net Payable neeche footer mein live dikh raha hai.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: '12px' }}>
              <div>
                <label style={S.label}>TDS (%) — on Freight only</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {['1', '2'].map(p => <button key={p} type="button" className={`pt-chip ${tdsPct === p ? 'is-on' : ''}`} onClick={() => setTdsPct(p)}>{p}%</button>)}
                  <input type="number" inputMode="decimal" style={{ ...S.input, width: '90px' }} value={tdsPct} onChange={e => setTdsPct(e.target.value)} />
                </div>
                <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '4px' }}>= ₹{inr(tdsAmt)}</div>
              </div>
              <div><label style={S.label}>Shortage Amount (₹)</label><input type="number" inputMode="decimal" style={{ ...S.input, borderColor: '#ef4444' }} value={shortageAmt} onChange={e => setShortageAmt(e.target.value)} placeholder="0.00" /></div>
              <div><label style={S.label}>Advance Deduction (₹)</label><input type="number" inputMode="decimal" style={{ ...S.input, borderColor: '#ef4444' }} value={advanceAmt} onChange={e => setAdvanceAmt(e.target.value)} placeholder="0.00" /></div>
              <div style={{ alignSelf: 'end', textAlign: 'right' }}>
                <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 'bold' }}>TOTAL DEDUCTIONS</div>
                <div style={{ fontSize: '20px', fontWeight: 900, color: '#ef4444' }}>− ₹{inr(totalDeductions)}</div>
              </div>
            </div>
          </div>

          {/* 💰 LIVE SUMMARY — sticky footer, updates with every checkbox */}
          <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 500, background: 'rgba(2,6,23,0.97)', borderTop: '2px solid #10b981', backdropFilter: 'blur(8px)', padding: '10px clamp(12px, 3vw, 30px)', boxShadow: '0 -8px 30px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', gap: 'clamp(8px, 2vw, 22px)', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 900 }}>🏢 {co.name}</div>
              <div><div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 'bold' }}>FREIGHT ({totalQty} KL)</div><div style={{ fontSize: '15px', fontWeight: 900, color: '#10b981' }}>₹{inr(freightTotal)}</div></div>
              <div><div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 'bold' }}>DETENTION ({totalDetDays}d)</div><div style={{ fontSize: '15px', fontWeight: 900, color: '#f59e0b' }}>₹{inr(detTotal)}</div></div>
              <div><div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 'bold' }}>CGST+SGST 5% <span style={{ color: '#64748b' }}>(RCM)</span></div><div style={{ fontSize: '13px', fontWeight: 'bold', color: '#38bdf8' }}>₹{inr(cgst)} + ₹{inr(sgst)}</div></div>
              <div><div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 'bold' }}>SUB TOTAL</div><div style={{ fontSize: '14px', fontWeight: 'bold', color: '#cbd5e1' }}>₹{inr(grandWithGst)}</div></div>
              <div><div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 'bold' }}>DEDUCTIONS (TDS+Short+Adv)</div><div style={{ fontSize: '14px', fontWeight: 'bold', color: '#ef4444' }}>− ₹{inr(totalDeductions)}</div></div>
              <div style={{ textAlign: 'right', background: 'rgba(16,185,129,0.12)', border: '1px solid #10b981', borderRadius: '10px', padding: '5px 14px' }}>
                <div style={{ fontSize: '10px', color: '#10b981', fontWeight: 900 }}>💰 NET PAYABLE AMOUNT</div>
                <div style={{ fontSize: 'clamp(17px, 3vw, 23px)', fontWeight: 900, color: '#10b981' }}>₹{inr(netPayable)}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
