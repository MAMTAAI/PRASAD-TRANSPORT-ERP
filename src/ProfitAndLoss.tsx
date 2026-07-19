// @ts-nocheck
// 📊 COMPANY P&L (LIVE, CA-READY) — real-time profit & loss from the billing
// engine's own data. 🏢 STRICT MULTI-COMPANY: the top Operating-Company filter
// applies to revenue AND every expense line.
// Revenue  = MONTHLY_INVOICES freight_total + detention_total (GST excluded —
//            RCM tax goes to the government, it is NOT our revenue).
// Expenses = Toll (TOLL_TRANSACTIONS, company-tagged)
//          + Fuel & other trip kharcha (TRIPS.total_expense MINUS the trip's
//            toll_amt — tolls are shown on their own line, never double-counted)
//          + Shortage deductions (invoices' shortage_amount — business loss)
//          + Driver Advance (placeholder: advances are recoverable khata, not
//            expense — row shown at ₹0 for the CA to adjust later if needed).
// NOTE: The journal-driven Balance Sheet/P&L (FinancialReports) remains the
// full statutory view; this page is the fast billing-side operating P&L.
import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { toISODate, round2, isDateInRange, getField } from './lib/accounting/tripMath';

const inr = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ProfitAndLoss() {
  const [invoices, setInvoices] = useState([]);
  const [tolls, setTolls] = useState([]);
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);

  const [company, setCompany] = useState('ALL');
  const [fromDate, setFromDate] = useState(() => { const d = new Date(); return `${d.toISOString().slice(0, 7)}-01`; });
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [iSnap, tSnap, trSnap] = await Promise.all([
        getDocs(collection(db, 'MONTHLY_INVOICES')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'TOLL_TRANSACTIONS')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'TRIPS')).catch(() => ({ docs: [] })),
      ]);
      setInvoices(iSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setTolls(tSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setTrips(trSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    })();
  }, []);

  const companies = useMemo(() => [...new Set([
    ...invoices.map(i => i.company),
    ...tolls.map(t => t.company),
    ...trips.map(t => t.operating_company || t.Operating_Company || t.company),
  ].filter(Boolean).map(s => String(s).trim()))].sort(), [invoices, tolls, trips]);

  const matchCo = (v) => company === 'ALL' || String(v || '').trim().toUpperCase() === company.toUpperCase();

  // 💰 P&L computation — every figure round2'd, company + date filtered.
  const pl = useMemo(() => {
    const invDate = (i) => toISODate(i.period_to) || (i.month ? `${i.month}-28` : toISODate(i.createdAt?.toDate?.()));
    const invs = invoices.filter(i => matchCo(i.company) && isDateInRange(invDate(i), fromDate || undefined, toDate || undefined));
    const freight = round2(invs.reduce((s, i) => s + (Number(i.freight_total) || 0), 0));
    const detention = round2(invs.reduce((s, i) => s + (Number(i.detention_total) || 0), 0));
    const shortage = round2(invs.reduce((s, i) => s + (Number(i.shortage_amount) || 0), 0));
    const gstRcm = round2(invs.reduce((s, i) => s + (Number(i.cgst) || 0) + (Number(i.sgst) || 0), 0));

    const tollRows = tolls.filter(t => matchCo(t.company) && isDateInRange(t.Txn_Date, fromDate || undefined, toDate || undefined));
    const toll = round2(tollRows.reduce((s, t) => s + (Number(t.Amount) || 0), 0));

    // Fuel & other trip kharcha: trips in range for the company; per trip
    // total_expense minus that trip's toll_amt (toll has its own line above).
    const tripRows = trips.filter(t => {
      const co = t.operating_company || t.Operating_Company || t.company;
      if (!matchCo(co)) return false;
      return isDateInRange(getField(t, ['loading_date', 'Loading_Date', 'start_date', 'date']), fromDate || undefined, toDate || undefined);
    });
    const fuelOther = round2(tripRows.reduce((s, t) => {
      const total = Number(getField(t, ['total_expense'])) || 0;
      const tripToll = Number(getField(t, ['toll_amt', 'toll_amount'])) || 0;
      return s + Math.max(0, total - tripToll);
    }, 0));
    const penalties = round2(tripRows.reduce((s, t) => s + (Number(getField(t, ['shortage_penalty'])) || 0), 0));

    const revenue = round2(freight + detention);
    const expenses = round2(toll + fuelOther + shortage);
    const recovery = penalties; // driver-se-vasooli (shortage loss ki bharpai)
    const netProfit = round2(revenue - expenses + recovery);
    return {
      invCount: invs.length, tripCount: tripRows.length, tollCount: tollRows.length,
      freight, detention, revenue, gstRcm,
      toll, fuelOther, shortage, expenses, recovery,
      netProfit, margin: revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
    };
  }, [invoices, tolls, trips, company, fromDate, toDate]);

  const exportCsv = () => {
    const L = [
      ['COMPANY P&L', company, `${fromDate} to ${toDate}`],
      [], ['REVENUE (GST excluded — RCM govt ko jata hai)'],
      ['Freight Income', pl.freight], ['Detention Income', pl.detention], ['TOTAL REVENUE', pl.revenue],
      [], ['DIRECT EXPENSES'],
      ['Toll Taxes (FASTag)', pl.toll], ['Fuel & Trip Kharcha (ex-toll)', pl.fuelOther],
      ['Shortage Deductions (loss)', pl.shortage], ['Driver Advance (khata — not expense)', 0],
      ['TOTAL EXPENSES', pl.expenses],
      [], ['Shortage Recovery from Drivers (+)', pl.recovery],
      ['NET PROFIT', pl.netProfit], ['Margin %', pl.margin],
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + L.map(r => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' }));
    a.download = `PL_${company}_${fromDate}_${toDate}.csv`;
    a.click();
  };

  const Row = ({ icon, label, value, sub, color = '#cbd5e1', bold = false, minus = false }) => (
    <tr style={{ borderBottom: '1px solid #1e293b', background: bold ? 'rgba(255,255,255,0.03)' : 'transparent' }}>
      <td style={{ padding: '12px 10px', fontWeight: bold ? 900 : 600, color: bold ? '#fff' : '#cbd5e1' }}>{icon} {label}{sub && <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 400 }}>{sub}</div>}</td>
      <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: bold ? 900 : 700, fontSize: bold ? '16px' : '14px', color }}>{minus ? '− ' : ''}₹{inr(value)}</td>
    </tr>
  );

  return (
    <div className="pt-anim-fade" style={{ padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '18px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: 0, color: '#38bdf8' }}>📊 Company P&L (Live)</h1>
          <p style={{ color: '#94a3b8', margin: '4px 0 0', fontSize: '13px' }}>Billing-engine se seedha operating P&L — GST revenue mein nahi (RCM govt ko). CA-ready.</p>
        </div>
        <button className="pt-btn pt-btn--ghost" style={{ minHeight: '48px' }} onClick={exportCsv}>📥 Export CSV</button>
      </div>

      {/* Filters */}
      <div className="pt-card pt-anim-up" style={{ marginBottom: '18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '12px' }}>
          <div>
            <label className="pt-label" style={{ color: '#f59e0b' }}>🏢 Operating Company</label>
            <select className="pt-input" style={{ borderColor: '#f59e0b' }} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="ALL">— All Companies (Group) —</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label className="pt-label">From Date</label><input type="date" className="pt-input" value={fromDate} onChange={e => setFromDate(e.target.value)} /></div>
          <div><label className="pt-label">To Date</label><input type="date" className="pt-input" value={toDate} onChange={e => setToDate(e.target.value)} /></div>
        </div>
      </div>

      {loading ? <div style={{ textAlign: 'center', padding: '50px', color: '#38bdf8' }}>⌛ Loading books…</div> : (
        <>
          {/* 🏆 NET PROFIT hero card — green profit / red loss */}
          <div className="pt-anim-pop" style={{
            borderRadius: '20px', padding: 'clamp(20px, 4vw, 32px)', marginBottom: '18px',
            background: pl.netProfit >= 0 ? 'linear-gradient(135deg, rgba(16,185,129,0.18), rgba(5,150,105,0.08))' : 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(185,28,28,0.08))',
            border: `2px solid ${pl.netProfit >= 0 ? '#10b981' : '#ef4444'}`,
            boxShadow: `0 12px 40px ${pl.netProfit >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px',
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 900, letterSpacing: '1px', color: pl.netProfit >= 0 ? '#10b981' : '#ef4444' }}>
                {pl.netProfit >= 0 ? '📈 NET PROFIT' : '📉 NET LOSS'} — {company === 'ALL' ? 'GROUP (ALL COMPANIES)' : company}
              </div>
              <div style={{ fontSize: 'clamp(30px, 7vw, 46px)', fontWeight: 900, color: pl.netProfit >= 0 ? '#10b981' : '#ef4444' }}>₹{inr(Math.abs(pl.netProfit))}</div>
              <div style={{ fontSize: '12px', color: '#94a3b8' }}>{fromDate} → {toDate} · {pl.invCount} invoices · {pl.tripCount} trips · margin {pl.margin}%</div>
            </div>
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              <div style={{ textAlign: 'right' }}><div style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 800 }}>REVENUE</div><div style={{ fontSize: '22px', fontWeight: 900, color: '#38bdf8' }}>₹{inr(pl.revenue)}</div></div>
              <div style={{ textAlign: 'right' }}><div style={{ fontSize: '11px', color: '#ef4444', fontWeight: 800 }}>EXPENSES</div><div style={{ fontSize: '22px', fontWeight: 900, color: '#ef4444' }}>₹{inr(pl.expenses)}</div></div>
            </div>
          </div>

          {/* Statement table */}
          <div className="pt-card pt-anim-up" style={{ padding: 'clamp(10px, 2vw, 20px)', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', minWidth: '460px' }}>
              <tbody>
                <tr><td colSpan={2} style={{ padding: '10px', color: '#38bdf8', fontWeight: 900, fontSize: '12px', letterSpacing: '1px', borderBottom: '2px solid #334155' }}>💵 REVENUE (INCOME)</td></tr>
                <Row icon="🚛" label="Freight Income" sub={`${pl.invCount} invoices (Transportation Bills RCM)`} value={pl.freight} color="#38bdf8" />
                <Row icon="⏱️" label="Detention Income" value={pl.detention} color="#38bdf8" />
                <Row icon="" label="TOTAL REVENUE" sub={`GST ₹${inr(pl.gstRcm)} excluded — RCM me buyer govt ko deta hai`} value={pl.revenue} color="#38bdf8" bold />

                <tr><td colSpan={2} style={{ padding: '16px 10px 10px', color: '#ef4444', fontWeight: 900, fontSize: '12px', letterSpacing: '1px', borderBottom: '2px solid #334155' }}>💸 DIRECT EXPENSES</td></tr>
                <Row icon="🛣️" label="Toll Taxes (FASTag)" sub={`${pl.tollCount} toll transactions`} value={pl.toll} color="#ef4444" minus />
                <Row icon="⛽" label="Fuel & Trip Kharcha" sub="trips ka total_expense minus toll (double-count nahi)" value={pl.fuelOther} color="#ef4444" minus />
                <Row icon="📉" label="Shortage Deductions" sub="party ne bill se kata — business loss" value={pl.shortage} color="#ef4444" minus />
                <Row icon="🤝" label="Driver Advance" sub="placeholder — advance recoverable khata hai, expense nahi (CA adjust kare to yahan judega)" value={0} color="#64748b" />
                <Row icon="" label="TOTAL EXPENSES" value={pl.expenses} color="#ef4444" bold minus />

                {pl.recovery > 0 && <Row icon="💪" label="Add: Shortage Recovery (Driver Khata Debit)" sub="shortage loss ki driver-se bharpai" value={pl.recovery} color="#10b981" />}
                <tr style={{ background: pl.netProfit >= 0 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)' }}>
                  <td style={{ padding: '16px 10px', fontWeight: 900, fontSize: '16px' }}>{pl.netProfit >= 0 ? '📈 NET PROFIT' : '📉 NET LOSS'}</td>
                  <td style={{ padding: '16px 10px', textAlign: 'right', fontWeight: 900, fontSize: '20px', color: pl.netProfit >= 0 ? '#10b981' : '#ef4444' }}>₹{inr(pl.netProfit)}</td>
                </tr>
              </tbody>
            </table>
            <p style={{ fontSize: '11px', color: '#64748b', margin: '12px 0 0' }}>ℹ️ Statutory Balance Sheet / full journal P&L ke liye "Balance Sheet/P&L" module dekhein — ye page billing-side ka fast operating view hai. Dono ek hi journal se milte hain.</p>
          </div>
        </>
      )}
    </div>
  );
}
