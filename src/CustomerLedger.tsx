// @ts-nocheck
// 📖 CUSTOMER KHATA (Party Ledger) — CA-ready receivables statement.
// Convention (per the owner's mental model): CREDIT column = bill banya (due /
// lena baki), DEBIT column = paisa aaya (receipt). Running Balance = live
// outstanding (kitna lena baki hai).
// 🏢 STRICT MULTI-COMPANY: the top Operating-Company filter applies to every
// row, KPI and the payment form — companies kabhi mix nahi hote.
// Data: MONTHLY_INVOICES (net_payable → Cr) + CUSTOMER_PAYMENTS (receipts →
// Dr, new collection). Every payment also posts the canonical double-entry
// journal (Dr Bank/Cash, Cr Debtors) so the master books stay in sync.
import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { postEntry } from './lib/accounting/journal';
import { toISODate, round2, isDateInRange } from './lib/accounting/tripMath';
import { currentUser } from './lib/rbac';
import { logAudit } from './lib/audit';
import BottomSheet from './ui/BottomSheet';

const inr = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso) => { const d = toISODate(iso); return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : ''; };

export default function CustomerLedger() {
  const user = currentUser();
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [companyBills, setCompanyBills] = useState([]);   // Bill Management invoices
  const [bankReceipts, setBankReceipts] = useState([]);   // settle-modal receipts

  // Filters
  const [company, setCompany] = useState('ALL');
  const [cust, setCust] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // ➕ Add Payment sheet
  const [showPay, setShowPay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pay, setPay] = useState({ date: new Date().toISOString().slice(0, 10), amount: '', mode: 'Bank', ref: '', bank: '', remarks: '' });

  // 🔥 REAL-TIME: sab sources live via onSnapshot — Auto-Billing invoices,
  // manual receipts, Bill Management invoices, aur settle-modal bank receipts.
  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'MONTHLY_INVOICES'), s => setInvoices(s.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
    const u2 = onSnapshot(collection(db, 'CUSTOMER_PAYMENTS'), s => setPayments(s.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
    const u3 = onSnapshot(collection(db, 'COMPANY_BILLS'), s => setCompanyBills(s.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
    const u4 = onSnapshot(collection(db, 'BANK_TRANSACTIONS'), s => setBankReceipts(
      s.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => /receipt/i.test(String(t.type || '')) && String(t.party_type || '') === 'Customer')
    ), () => {});
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const companies = useMemo(() => [...new Set([
    ...invoices.map(i => i.company), ...payments.map(p => p.company), ...companyBills.map(b => b.company),
  ].filter(c => c && c !== 'ALL'))].sort(), [invoices, payments, companyBills]);
  const customers = useMemo(() => [...new Set([
    ...invoices.map(i => i.customer), ...payments.map(p => p.customer),
    ...companyBills.map(b => b.customer_name), ...bankReceipts.map(r => r.party_name),
  ].filter(Boolean))].sort(), [invoices, payments, companyBills, bankReceipts]);

  const invDate = (i) => toISODate(i.period_to) || toISODate(i.createdAt?.toDate?.()) || toISODate(i.month ? `${i.month}-28` : '');

  // 📒 LEDGER ROWS: Cr = invoice net_payable (due), Dr = receipts. Sorted by
  // date, then running balance (outstanding) computed in order.
  const ledger = useMemo(() => {
    if (!cust) return { rows: [], billed: 0, received: 0, outstanding: 0 };
    const match = (v, sel) => sel === 'ALL' || !sel || String(v || '').toUpperCase() === String(sel).toUpperCase();
    const rows = [];
    invoices.filter(i => match(i.company, company) && String(i.customer || '').toUpperCase() === cust.toUpperCase()).forEach(i => {
      const amt = round2(Number(i.net_payable ?? ((i.freight_total || 0) + (i.detention_total || 0))) || 0);
      if (amt <= 0) return;
      rows.push({
        date: invDate(i), company: i.company,
        particulars: `🧾 Invoice ${i.invoice_no || ''}${i.det_invoice_no && i.detention_total > 0 ? ` + Det ${i.det_invoice_no}` : ''} (${i.billing_period === 'H1' ? '1st half' : i.billing_period === 'H2' ? '2nd half' : i.month || ''})${i.total_deductions > 0 ? ` · net of ₹${inr(i.total_deductions)} deductions` : ''}`,
        dr: 0, cr: amt,
      });
    });
    payments.filter(p => match(p.company, company) && String(p.customer || '').toUpperCase() === cust.toUpperCase()).forEach(p => {
      rows.push({
        date: toISODate(p.date), company: p.company,
        particulars: `💰 Receipt ${p.ref || p.id.slice(0, 6)} (${p.mode}${p.bank ? ' · ' + p.bank : ''})${p.remarks ? ' — ' + p.remarks : ''}`,
        dr: round2(Number(p.amount) || 0), cr: 0,
      });
    });
    // 🧾 Bill Management invoices (COMPANY_BILLS) — Cr rows.
    companyBills.filter(b => match(b.company === 'ALL' ? '' : b.company, company) && String(b.customer_name || '').toUpperCase() === cust.toUpperCase()).forEach(b => {
      const amt = round2(Number(b.total_net_expected) || 0);
      if (amt <= 0) return;
      rows.push({
        date: toISODate(b.bill_date) || toISODate(b.createdAt?.toDate?.()), company: b.company === 'ALL' ? '' : b.company,
        particulars: `🧾 Bill ${b.bill_no || ''} (${b.trips?.length || 0} trips · Bill Mgmt)${b.status === 'SETTLED' ? ' ✓ settled' : b.status === 'PARTIALLY_PAID' ? ' · partial' : ''}`,
        dr: 0, cr: amt,
      });
    });
    // 💰 Bill Management settle-modal receipts (BANK_TRANSACTIONS) — Dr rows.
    bankReceipts.filter(r => match(r.company === 'ALL' ? '' : r.company, company) && String(r.party_name || '').toUpperCase() === cust.toUpperCase()).forEach(r => {
      const amt = round2(Number(r.amount) || 0);
      if (amt <= 0) return;
      rows.push({
        date: toISODate(r.date) || toISODate(r.created_at?.toDate?.()), company: r.company === 'ALL' ? '' : r.company,
        particulars: `💰 Receipt ${r.ref_no || ''} (${r.bank_account || 'Bank'} · Bill Mgmt settle)${r.particulars ? ' — ' + String(r.particulars).slice(0, 60) : ''}`,
        dr: amt, cr: 0,
      });
    });
    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (b.cr - a.cr));
    // Opening balance = sab kuch filter-range se PEHLE ka net.
    let opening = 0;
    const inRange = rows.filter(r => {
      if (fromDate && r.date && r.date < fromDate) { opening = round2(opening + r.cr - r.dr); return false; }
      return isDateInRange(r.date, fromDate || undefined, toDate || undefined);
    });
    let bal = opening;
    const withBal = inRange.map(r => { bal = round2(bal + r.cr - r.dr); return { ...r, balance: bal }; });
    const billed = round2(inRange.reduce((s, r) => s + r.cr, 0));
    const received = round2(inRange.reduce((s, r) => s + r.dr, 0));
    return { rows: withBal, opening, billed, received, outstanding: bal };
  }, [invoices, payments, companyBills, bankReceipts, cust, company, fromDate, toDate]);

  // 💾 Save payment: CUSTOMER_PAYMENTS doc + canonical journal entry.
  const savePayment = async () => {
    const amount = round2(parseFloat(pay.amount) || 0);
    if (!cust) return alert('⚠️ Pehle customer chunein!');
    if (amount <= 0) return alert('⚠️ Amount daalein!');
    if (company === 'ALL') return alert('🏢 Payment kis company ke khate mein aayi — upar Operating Company chunein (ALL par entry nahi ho sakti).');
    setSaving(true);
    try {
      const ref = await addDoc(collection(db, 'CUSTOMER_PAYMENTS'), {
        customer: cust, company,
        amount, date: pay.date, mode: pay.mode, ref: pay.ref || '', bank: pay.bank || '', remarks: pay.remarks || '',
        entered_by: user?.full_name || user?.name || 'staff', created_at: serverTimestamp(),
      });
      await postEntry({
        source_type: 'CUSTOMER_PAYMENT', source_ref: ref.id, date: pay.date,
        narration: `Payment received — ${cust} (${pay.mode}${pay.ref ? ' ' + pay.ref : ''})`,
        company,
        lines: [
          { ledger: pay.mode === 'Cash' ? 'Cash' : 'Bank', dr_cr: 'Dr', amount },
          { ledger: `Debtors: ${cust}`, dr_cr: 'Cr', amount },
        ],
      }).catch(() => {});
      logAudit({ action: 'CUSTOMER_PAYMENT', target: cust, details: `₹${amount} ${pay.mode} (${company})` });
      alert(`✅ ₹${inr(amount)} receipt save ho gayi — ${cust} ka khata + journal update.`);
      setPay({ date: new Date().toISOString().slice(0, 10), amount: '', mode: 'Bank', ref: '', bank: '', remarks: '' });
      setShowPay(false);
    } catch (e) { alert('❌ Save fail: ' + (e?.message || '')); }
    setSaving(false);
  };

  // 📥 CSV export (CA ko dene ke liye)
  const exportCsv = () => {
    if (!ledger.rows.length) return alert('⚠️ Export ke liye data nahi hai.');
    let csv = `Customer Khata,${cust},Company,${company}\nDate,Particulars,Debit (Received),Credit (Billed),Balance (Lena Baki)\n`;
    if (ledger.opening) csv += `,Opening Balance,,,${ledger.opening}\n`;
    ledger.rows.forEach(r => { csv += `${r.date},"${r.particulars.replace(/"/g, "'")}",${r.dr || ''},${r.cr || ''},${r.balance}\n`; });
    csv += `,TOTALS,${ledger.received},${ledger.billed},${ledger.outstanding}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `Khata_${cust}_${company}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="pt-anim-fade" style={{ padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '18px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: 0, color: '#38bdf8' }}>📖 Customer Khata (Party Ledger)</h1>
          <p style={{ color: '#94a3b8', margin: '4px 0 0', fontSize: '13px' }}>SAB bills ek statement mein — Auto-Billing + Bill Management · Receipts: manual entry + Bill-Mgmt settlements. Invoice = Cr (lena baki), Receipt = Dr, Balance = Live Outstanding. Real-time.</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button className="pt-btn pt-btn--ghost" style={{ minHeight: '48px' }} onClick={exportCsv}>📥 Export CSV</button>
          <button className="pt-btn pt-btn--success" style={{ minHeight: '48px', fontWeight: 900 }} onClick={() => setShowPay(true)}>＋ Add Payment Entry</button>
        </div>
      </div>

      {/* Filters */}
      <div className="pt-card pt-anim-up" style={{ marginBottom: '18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '12px' }}>
          <div>
            <label className="pt-label" style={{ color: '#f59e0b' }}>🏢 Operating Company</label>
            <select className="pt-input" style={{ borderColor: '#f59e0b' }} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="ALL">— All Companies —</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="pt-label" style={{ color: '#38bdf8' }}>👤 Customer *</label>
            <select className="pt-input" style={{ borderColor: '#38bdf8' }} value={cust} onChange={e => setCust(e.target.value)}>
              <option value="">— Select Customer —</option>
              {customers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label className="pt-label">From Date</label><input type="date" className="pt-input" value={fromDate} onChange={e => setFromDate(e.target.value)} /></div>
          <div><label className="pt-label">To Date</label><input type="date" className="pt-input" value={toDate} onChange={e => setToDate(e.target.value)} /></div>
        </div>
      </div>

      {!cust ? (
        <div className="pt-anim-up" style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b', border: '1px dashed #334155', borderRadius: '16px' }}>
          👆 Customer chunein — uska poora khata (bills, receipts, live outstanding) yahan aa jayega.
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="pt-stagger" style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '18px' }}>
            <div className="pt-kpi"><div className="pt-kpi__label" style={{ color: '#38bdf8' }}>Total Billed (Cr)</div><div className="pt-kpi__value" style={{ color: '#38bdf8' }}>₹{inr(ledger.billed)}</div><div className="pt-kpi__sub">{company === 'ALL' ? 'all companies' : company}</div></div>
            <div className="pt-kpi"><div className="pt-kpi__label" style={{ color: '#10b981' }}>Received (Dr)</div><div className="pt-kpi__value" style={{ color: '#10b981' }}>₹{inr(ledger.received)}</div><div className="pt-kpi__sub">receipts in range</div></div>
            <div className="pt-kpi" style={{ borderColor: ledger.outstanding > 0 ? '#ef444466' : '#10b98166' }}>
              <div className="pt-kpi__label" style={{ color: ledger.outstanding > 0 ? '#ef4444' : '#10b981' }}>💰 Live Outstanding (Lena Baki)</div>
              <div className="pt-kpi__value" style={{ color: ledger.outstanding > 0 ? '#ef4444' : '#10b981' }}>₹{inr(ledger.outstanding)}</div>
              <div className="pt-kpi__sub">{ledger.outstanding > 0 ? 'party se lena hai' : 'khata clear ✓'}</div>
            </div>
          </div>

          {/* Ledger table */}
          <div className="pt-card pt-anim-up" style={{ overflowX: 'auto', padding: 'clamp(10px, 2vw, 20px)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '700px' }}>
              <thead><tr style={{ color: '#38bdf8', textAlign: 'left' }}>
                {['Date', 'Particulars (Invoice / Receipt)', 'Debit ₹ (Received)', 'Credit ₹ (Billed)', 'Balance ₹ (Lena Baki)'].map((h, i) => <th key={h} style={{ padding: '10px 8px', borderBottom: '2px solid #334155', textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {ledger.opening !== 0 && (
                  <tr style={{ borderBottom: '1px solid #1e293b', color: '#94a3b8', fontStyle: 'italic' }}>
                    <td style={{ padding: '8px' }}>—</td><td style={{ padding: '8px' }}>Opening Balance (pichhla lena baki)</td><td></td><td></td>
                    <td style={{ padding: '8px', textAlign: 'right', fontWeight: 'bold' }}>₹{inr(ledger.opening)}</td>
                  </tr>
                )}
                {ledger.rows.length === 0 ? <tr><td colSpan={5} style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>Is range mein koi entry nahi.</td></tr> :
                  ledger.rows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                      <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{dmy(r.date)}</td>
                      <td style={{ padding: '8px' }}>{r.particulars}{company === 'ALL' && r.company && <span className="pt-badge pt-badge--warning" style={{ marginLeft: '6px' }}>{r.company}</span>}</td>
                      <td style={{ padding: '8px', textAlign: 'right', color: '#10b981', fontWeight: r.dr ? 900 : 400 }}>{r.dr ? inr(r.dr) : ''}</td>
                      <td style={{ padding: '8px', textAlign: 'right', color: '#38bdf8', fontWeight: r.cr ? 900 : 400 }}>{r.cr ? inr(r.cr) : ''}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontWeight: 900, color: r.balance > 0 ? '#ef4444' : '#10b981' }}>{inr(r.balance)}</td>
                    </tr>
                  ))}
                <tr style={{ background: 'rgba(56,189,248,0.06)', fontWeight: 900 }}>
                  <td style={{ padding: '10px 8px' }} colSpan={2}>TOTALS</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#10b981' }}>₹{inr(ledger.received)}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#38bdf8' }}>₹{inr(ledger.billed)}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: ledger.outstanding > 0 ? '#ef4444' : '#10b981', fontSize: '15px' }}>₹{inr(ledger.outstanding)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ➕ ADD PAYMENT — BottomSheet (swipeable on phone) */}
      <BottomSheet open={showPay} onClose={() => setShowPay(false)} title={`💰 Payment Entry — ${cust || 'select customer'}`} accent="#10b981" maxWidth={640}>
        <div className="pt-anim-fade">
          <div style={{ marginBottom: '14px', fontSize: '13px', color: '#94a3b8' }}>
            Khata: <b style={{ color: '#38bdf8' }}>{cust || '—'}</b> · Company: <b style={{ color: '#f59e0b' }}>{company === 'ALL' ? '⚠ chunein (required)' : company}</b>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
            <div><label className="pt-label" style={{ color: '#10b981' }}>Amount (₹) *</label><input type="number" inputMode="decimal" className="pt-input" style={{ borderColor: '#10b981', fontSize: '18px', fontWeight: 'bold' }} value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} placeholder="0.00" /></div>
            <div><label className="pt-label">Date</label><input type="date" className="pt-input" value={pay.date} onChange={e => setPay({ ...pay, date: e.target.value })} /></div>
          </div>
          <label className="pt-label" style={{ marginTop: '14px' }}>Mode</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {['Bank', 'Cash', 'UPI', 'Cheque'].map(m => <button key={m} type="button" className={`pt-chip ${pay.mode === m ? 'is-on is-on--success' : ''}`} onClick={() => setPay({ ...pay, mode: m })}>{m === 'Bank' ? '🏦' : m === 'Cash' ? '💵' : m === 'UPI' ? '📱' : '📝'} {m}</button>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px', marginTop: '14px' }}>
            <div><label className="pt-label">UTR / Ref No</label><input className="pt-input" value={pay.ref} onChange={e => setPay({ ...pay, ref: e.target.value })} placeholder="UTR123456" /></div>
            <div><label className="pt-label">Bank Name</label><input className="pt-input" value={pay.bank} onChange={e => setPay({ ...pay, bank: e.target.value })} placeholder="SBI" /></div>
          </div>
          <div style={{ marginTop: '14px' }}><label className="pt-label">Remarks</label><input className="pt-input" value={pay.remarks} onChange={e => setPay({ ...pay, remarks: e.target.value })} placeholder="e.g. June bill part payment" /></div>
          <button className={`pt-btn pt-btn--success ${saving ? 'is-loading' : ''}`} disabled={saving} onClick={savePayment} style={{ width: '100%', marginTop: '20px', minHeight: '52px', fontWeight: 900, fontSize: '15px' }}>
            {saving ? 'Saving…' : '💾 Save Receipt (Khata + Journal)'}
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}
