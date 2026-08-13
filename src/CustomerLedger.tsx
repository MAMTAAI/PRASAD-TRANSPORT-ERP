// @ts-nocheck
// 📖 CUSTOMER KHATA (Party Ledger) — CA-ready receivables statement. Live PostgreSQL.
//
// Convention (the owner's, not an accountant's): CREDIT column = bill banya
// (due / lena baki), DEBIT column = paisa aaya (receipt), Running Balance =
// live outstanding. That is the exact inverse of the debtor account's own
// Dr/Cr, so the flip happens once on the server (`/masters/customers/:id/
// ledger` returns `dr`/`cr` already in this screen's sense, and `gl_dr_cr`
// carries the unflipped truth) instead of being re-derived in four places here.
//
// WHY THIS FILE CHANGED. It read MONTHLY_INVOICES and CUSTOMER_PAYMENTS from
// Firestore while COMPANY_BILLS and BANK_TRANSACTIONS had already moved to
// PostgreSQL — so a bill raised in Bill Management and the receipt that settled
// it were invisible in the statement the customer actually gets shown. One
// endpoint now returns both, from the bill register and the general ledger.
//
// AND WHY THERE IS NO CUSTOMER_PAYMENTS ANY MORE. The old save wrote its own
// payment document AND a journal — two records of one rupee, which is exactly
// how BANK_TRANSACTIONS came to disagree with the ledger. A receipt is now a
// RECEIPT voucher through TARA and nothing else. Migration 026 refused the
// table for this reason and 029 refused it again.
//
// 🏢 The Operating-Company filter still applies to every row, KPI and the
// payment form — companies kabhi mix nahi hote.
import React, { useState, useEffect, useMemo } from 'react';
import { toISODate } from './lib/accounting/tripMath';
import { currentUser } from './lib/rbac';
import { logAudit } from './lib/audit';
import BottomSheet from './ui/BottomSheet';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const MASTERS = `${API}/api/v1/masters`;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const inr = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso) => { const d = toISODate(iso); return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : ''; };

const EMPTY = { rows: [], opening: 0, billed: 0, received: 0, outstanding: 0, companies: [] };

export default function CustomerLedger() {
  const user = currentUser();
  const [customers, setCustomers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [ledger, setLedger] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Filters. `cust` is the customer UUID now, not the name — the khata is
  // fetched by id, so two customers with similar names can never merge.
  const [company, setCompany] = useState('ALL');
  const [cust, setCust] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // ➕ Add Payment sheet
  const [showPay, setShowPay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pay, setPay] = useState({ date: new Date().toISOString().slice(0, 10), amount: '', account: '', ref: '', remarks: '' });

  const custName = useMemo(
    () => customers.find((c: any) => c.id === cust)?.customer_name || '',
    [customers, cust]);

  useEffect(() => {
    fetchJson(`${MASTERS}/customers?limit=1000`)
      .then(j => setCustomers(j.customers ?? []))
      .catch(e => setErr(e?.message || 'customer list unavailable'));
    fetchJson(`${FIN}/accounts`).then(j => setAccounts(j.accounts ?? [])).catch(() => {});
  }, []);

  // The statement is refetched on every filter change: the date window decides
  // the opening balance, and computing that in the browser from a partial set
  // is how the old version could show an opening that did not tie to anything.
  const loadLedger = async () => {
    if (!cust) { setLedger(EMPTY); return; }
    setLoading(true); setErr(null);
    try {
      const qs = new URLSearchParams();
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', toDate);
      if (company !== 'ALL') qs.set('company', company);
      setLedger(await fetchJson(`${MASTERS}/customers/${cust}/ledger?${qs}`));
    } catch (e: any) { setErr(e?.message || 'khata load failed'); setLedger(EMPTY); }
    setLoading(false);
  };
  useEffect(() => { loadLedger(); }, [cust, company, fromDate, toDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // The company list comes from the selected customer's own records, computed
  // server-side without the company filter applied so the dropdown stays
  // two-way. Before a customer is chosen there is nothing to offer.
  const companies = ledger.companies ?? [];

  // 💾 Save receipt: ONE RECEIPT voucher. No second store of the same cash.
  const savePayment = async () => {
    const amount = parseFloat(pay.amount) || 0;
    if (!cust) return alert('⚠️ Pehle customer chunein!');
    if (amount <= 0) return alert('⚠️ Amount daalein!');
    if (company === 'ALL') return alert('🏢 Payment kis company ke khate mein aayi — upar Operating Company chunein (ALL par entry nahi ho sakti).');
    if (!pay.account) return alert('🏦 Paisa kis account me aaya? Bank ya cash account chunein — koi account apne aap maan nahi liya jata.');
    setSaving(true);
    try {
      await fetchJson(`${MASTERS}/customers/${cust}/receipt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: pay.account,
          amount,
          entry_date: pay.date,
          ref_no: pay.ref || null,
          company,
          remarks: pay.remarks || null,
          created_by: user?.full_name || user?.name || user?.email || 'staff',
        }),
      });
      logAudit({ action: 'CUSTOMER_RECEIPT', target: custName, details: `₹${amount} into ${pay.account} (${company})` });
      alert(`✅ ₹${inr(amount)} receipt post ho gayi — ${custName} ka khata + ledger voucher.`);
      setPay({ date: new Date().toISOString().slice(0, 10), amount: '', account: '', ref: '', remarks: '' });
      setShowPay(false);
      loadLedger();
    } catch (e: any) {
      const said = {
        DUPLICATE_REF: 'Yeh UTR/reference pehle hi post ho chuka hai — dobara nahi hoga.',
        OVERDRAFT: 'Us account par yeh entry balance se aage nikal jati hai.',
        NO_ACCOUNT: 'Account chunein.',
      }[e?.code];
      alert('❌ Save fail: ' + (said || e?.message || ''));
    }
    setSaving(false);
  };

  // 📥 CSV export (CA ko dene ke liye)
  const exportCsv = () => {
    if (!ledger.rows.length) return alert('⚠️ Export ke liye data nahi hai.');
    let csv = `Customer Khata,${custName},Company,${company}\nDate,Particulars,Debit (Received),Credit (Billed),Balance (Lena Baki)\n`;
    if (ledger.opening) csv += `,Opening Balance,,,${ledger.opening}\n`;
    ledger.rows.forEach(r => { csv += `${r.date},"${String(r.particulars).replace(/"/g, "'")}",${r.dr || ''},${r.cr || ''},${r.balance}\n`; });
    csv += `,TOTALS,${ledger.received},${ledger.billed},${ledger.outstanding}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `Khata_${custName}_${company}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="pt-anim-fade" style={{ padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '18px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: 0, color: '#38bdf8' }}>📖 Customer Khata (Party Ledger)</h1>
          <p style={{ color: '#94a3b8', margin: '4px 0 0', fontSize: '13px' }}>SAB bills ek statement mein — bill register + general ledger. Bill = Cr (lena baki), Receipt = Dr, Balance = Live Outstanding. Har receipt ek RECEIPT voucher hai.</p>
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
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
          <div><label className="pt-label">From Date</label><input type="date" className="pt-input" value={fromDate} onChange={e => setFromDate(e.target.value)} /></div>
          <div><label className="pt-label">To Date</label><input type="date" className="pt-input" value={toDate} onChange={e => setToDate(e.target.value)} /></div>
        </div>
      </div>

      {err && (
        <div className="pt-anim-up" style={{ padding: '14px 18px', marginBottom: '14px', borderRadius: '12px', border: '1px solid #ef4444', background: 'rgba(239,68,68,0.08)', color: '#fca5a5', fontSize: '13px' }}>
          ⚠️ {err}
        </div>
      )}

      {!cust ? (
        <div className="pt-anim-up" style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b', border: '1px dashed #334155', borderRadius: '16px' }}>
          👆 Customer chunein — uska poora khata (bills, receipts, live outstanding) yahan aa jayega.
        </div>
      ) : loading ? (
        <div className="pt-anim-up" style={{ textAlign: 'center', padding: '60px 20px', color: '#38bdf8', border: '1px dashed #334155', borderRadius: '16px' }}>
          ⏳ Khata load ho raha hai…
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
      <BottomSheet open={showPay} onClose={() => setShowPay(false)} title={`💰 Receipt Entry — ${custName || 'select customer'}`} accent="#10b981" maxWidth={640}>
        <div className="pt-anim-fade">
          <div style={{ marginBottom: '14px', fontSize: '13px', color: '#94a3b8' }}>
            Khata: <b style={{ color: '#38bdf8' }}>{custName || '—'}</b> · Company: <b style={{ color: '#f59e0b' }}>{company === 'ALL' ? '⚠ chunein (required)' : company}</b>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
            <div><label className="pt-label" style={{ color: '#10b981' }}>Amount (₹) *</label><input type="number" inputMode="decimal" className="pt-input" style={{ borderColor: '#10b981', fontSize: '18px', fontWeight: 'bold' }} value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} placeholder="0.00" /></div>
            <div><label className="pt-label">Date</label><input type="date" className="pt-input" value={pay.date} onChange={e => setPay({ ...pay, date: e.target.value })} /></div>
          </div>
          {/* The receipt is a RECEIPT voucher: Dr <account> / Cr the debtor. So
              the account is a real ledger, chosen from the chart — a typed
              bank name could not be posted against anything. */}
          <div style={{ marginTop: '14px' }}>
            <label className="pt-label" style={{ color: '#10b981' }}>Paisa kis account me aaya? *</label>
            <select className="pt-input" style={{ borderColor: '#10b981' }} value={pay.account} onChange={e => setPay({ ...pay, account: e.target.value })}>
              <option value="">— Select the bank / cash account —</option>
              {accounts.map((a: any) => (
                <option key={a.ledger_name} value={a.ledger_name}>
                  {a.ledger_name} — ₹{inr(a.balance)}
                </option>
              ))}
            </select>
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#94a3b8' }}>
              Posts <b style={{ color: '#34d399' }}>Dr {pay.account || 'the account you select'}</b>
              {' / '}<b style={{ color: '#f87171' }}>Cr Debtors: {custName || 'customer'}</b>
            </div>
          </div>
          <div style={{ marginTop: '14px' }}>
            <label className="pt-label">UTR / Ref No</label>
            <input className="pt-input" value={pay.ref} onChange={e => setPay({ ...pay, ref: e.target.value })} placeholder="UTR123456" />
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#64748b' }}>
              Optional, but a reference is what stops the same receipt being posted twice.
            </div>
          </div>
          <div style={{ marginTop: '14px' }}><label className="pt-label">Remarks</label><input className="pt-input" value={pay.remarks} onChange={e => setPay({ ...pay, remarks: e.target.value })} placeholder="e.g. June bill part payment" /></div>
          <button className={`pt-btn pt-btn--success ${saving ? 'is-loading' : ''}`} disabled={saving} onClick={savePayment} style={{ width: '100%', marginTop: '20px', minHeight: '52px', fontWeight: 900, fontSize: '15px' }}>
            {saving ? 'Posting…' : '💾 Post Receipt (RECEIPT voucher)'}
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}
