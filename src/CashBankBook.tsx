// @ts-nocheck
// 🏦 CASH & BANK BOOK — live PostgreSQL (zero Firestore).
//
// The book is a projection of the general ledger, not a store of its own. Every
// row here IS the bank/cash leg of a voucher, with the party read off the
// opposite leg — so this screen and the ledger cannot disagree. Firestore kept
// BANK_TRANSACTIONS as a separate collection, which is exactly why its totals
// used to drift from the accounts.
//
// Three behaviours changed with the move, deliberately:
//   • Delete → REVERSE. ledger_entries is append-only by trigger; a wrong
//     voucher is corrected by posting its mirror image, and both stay in the
//     audit trail. Trip advances and legacy imports have no voucher to reverse.
//   • Filters and totals are computed server-side over the WHOLE filtered set,
//     so a row limit can never change the closing balance shown.
//   • Reconciliation reads a real CSV bank statement and matches it against
//     these live entries. The old screen invented its statement rows.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error, body: json });
  return json;
};

const inr = (n: any) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d: any) => (d ? new Date(d).toLocaleDateString('en-GB') : '-');
const today = () => new Date().toISOString().slice(0, 10);

// Voucher-type presentation. The API returns RECEIPT / PAYMENT / CONTRA; these
// are the labels and colours the screen has always used for them.
const TYPE_UI: Record<string, { label: string; color: string; sign: string }> = {
  RECEIPT: { label: 'Receipt (IN)', color: '#10b981', sign: '+' },
  PAYMENT: { label: 'Payment (OUT)', color: '#ef4444', sign: '-' },
  CONTRA: { label: 'Contra (TRANSFER)', color: '#f59e0b', sign: '🔄' },
};

export default function CashBankBook() {
  const [book, setBook] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // 🪟 MODALS
  const [showModal, setShowModal] = useState(false);
  const [showBankMaster, setShowBankMaster] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showReconcileModal, setShowReconcileModal] = useState(false);

  // 🔍 FILTERS — all pushed to the server
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedCompany, setSelectedCompany] = useState('ALL');
  const [selectedBranch, setSelectedBranch] = useState('ALL');
  const [selectedAccount, setSelectedAccount] = useState('ALL');

  // 🏢 MASTERS
  const [companies, setCompanies] = useState<any[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [newBank, setNewBank] = useState({ ledger_name: '', group_head: 'Bank Accounts', company: '', account_no: '', ifsc_code: '', opening_balance: '' });

  // 📝 VOUCHER FORM
  const [formData, setFormData] = useState<any>({
    date: today(), type: 'RECEIPT', party_ledger: '', party_group: '', party_kind: '',
    amount: '', particulars: '', account: '', to_account: '', ref_no: '', branch: '',
    tds_amount: '',
  });
  const [partyQuery, setPartyQuery] = useState('');
  const [partyHits, setPartyHits] = useState<any[]>([]);
  const [partyCtx, setPartyCtx] = useState<any>(null);
  const partyTimer = useRef<any>(null);

  const [paymentLink, setPaymentLink] = useState('');

  // 🔄 RECONCILIATION (real CSV, no fabricated rows)
  const [statementRows, setStatementRows] = useState<any[]>([]);
  const [reconNote, setReconNote] = useState('');

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 350);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const loadMasters = useCallback(async () => {
    try {
      const m = await fetchJson(`${FIN}/masters/companies`);
      setCompanies(m.companies || []);
      setBranches(m.branches || []);
      if (m.companies?.length) setNewBank((p) => ({ ...p, company: m.companies[0].company_name }));
    } catch (e: any) {
      // Masters failing is not fatal — the book still reads. Say so rather than
      // silently showing an empty company list.
      setErr((prev) => prev || `Company master unavailable: ${e.message}`);
    }
  }, []);

  const loadBook = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const p = new URLSearchParams();
      if (selectedAccount !== 'ALL') p.set('account', selectedAccount);
      if (selectedCompany !== 'ALL') p.set('company', selectedCompany);
      if (selectedBranch !== 'ALL') p.set('branch', selectedBranch);
      if (fromDate) p.set('from', fromDate);
      if (toDate) p.set('to', toDate);
      if (debouncedSearch) p.set('q', debouncedSearch);
      p.set('limit', '1000');
      setBook(await fetchJson(`${FIN}/cashbook?${p}`));
    } catch (e: any) {
      setBook(null);
      setErr(`Cash & Bank Book could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  }, [selectedAccount, selectedCompany, selectedBranch, fromDate, toDate, debouncedSearch]);

  useEffect(() => { loadMasters(); }, [loadMasters]);
  useEffect(() => { loadBook(); }, [loadBook]);

  // Predictive party search for the voucher modal — customers ∪ vendors ∪
  // drivers ∪ bank/cash ledgers, with live balances, straight from the ledger.
  useEffect(() => {
    if (!partyQuery || partyQuery.length < 2) { setPartyHits([]); return; }
    clearTimeout(partyTimer.current);
    partyTimer.current = setTimeout(() => {
      fetchJson(`${FIN}/parties/search?q=${encodeURIComponent(partyQuery)}`)
        .then((j) => setPartyHits(j.results || []))
        .catch(() => setPartyHits([]));
    }, 250);
    return () => clearTimeout(partyTimer.current);
  }, [partyQuery]);

  const accounts = book?.accounts ?? [];
  const entries = book?.entries ?? [];
  const totalIn = Number(book?.total_in ?? 0);
  const totalOut = Number(book?.total_out ?? 0);
  const opening = Number(book?.opening_balance ?? 0);
  const closing = Number(book?.closing_balance ?? 0);

  const pickParty = async (hit: any) => {
    setFormData((f: any) => ({
      ...f,
      party_ledger: hit.kind === 'CUSTOMER' ? `Debtors: ${hit.name}`
        : hit.kind === 'VENDOR' ? `Creditors: ${hit.name}`
        : hit.kind === 'DRIVER' ? `Driver Advance: ${hit.name}`
        : hit.name,
      party_group: hit.ledger_group,
      party_kind: hit.kind,
    }));
    setPartyQuery(hit.name);
    setPartyHits([]);
    setPartyCtx(null);
    try {
      setPartyCtx(await fetchJson(`${FIN}/party-context?kind=${hit.kind}&id=${hit.id}`));
    } catch { /* context is a convenience, never a blocker */ }
  };

  const handleSaveVoucher = async () => {
    const amt = parseFloat(formData.amount);
    if (!amt || amt <= 0) return alert('⚠️ Enter a valid amount.');
    if (formData.type === 'CONTRA') {
      if (!formData.account || !formData.to_account) return alert("⚠️ Select both 'From' and 'To' accounts.");
      if (formData.account === formData.to_account) return alert("⚠️ 'From' and 'To' cannot be the same account.");
    } else {
      if (!formData.party_ledger) return alert('⚠️ Select a party.');
      if (!formData.account) return alert('⚠️ Select the bank/cash account.');
    }

    const tds = parseFloat(formData.tds_amount) || 0;
    setBusy(true);
    try {
      const out = await fetchJson(`${FIN}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: formData.type,
          account: formData.account,
          ...(formData.type === 'CONTRA'
            ? { to_account: formData.to_account }
            : { party_ledger: formData.party_ledger, party_group: formData.party_group || undefined }),
          amount: amt,
          ...(tds > 0 && formData.type !== 'CONTRA'
            ? { tds: { ledger: formData.type === 'RECEIPT' ? 'TDS Receivable 194C' : 'TDS Payable 194C', amount: tds } }
            : {}),
          ref_no: formData.ref_no || null,
          entry_date: formData.date,
          narration: formData.particulars || null,
          company: selectedCompany !== 'ALL' ? selectedCompany : null,
          branch: formData.branch || (selectedBranch !== 'ALL' ? selectedBranch : null),
          source_type: 'CASH_BANK_BOOK',
        }),
      });
      alert(`✅ Voucher posted.\nVoucher ID: ${out.voucher_id}`);
      setShowModal(false);
      setFormData((f: any) => ({ ...f, amount: '', party_ledger: '', party_group: '', particulars: '', ref_no: '', to_account: '', tds_amount: '' }));
      setPartyQuery(''); setPartyCtx(null);
      loadBook();
    } catch (e: any) {
      // TARA's guards are shown as-is: an overdraft or a duplicate cheque number
      // is a real answer the user needs to read, not a generic failure.
      alert(`❌ ${e.code === 'OVERDRAFT' ? 'Insufficient balance' : e.code === 'DUPLICATE_REF' ? 'This reference is already posted' : 'Could not post'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  // Delete does not exist in a ledger. This posts the mirror image.
  const handleReverse = async (t: any) => {
    if (!t.voucher_id) {
      return alert('⚠️ This row has no voucher behind it.\n\nIt is a legacy imported entry (pre-double-entry migration), so there is nothing to reverse. Correct it with a fresh voucher instead.');
    }
    const reason = window.prompt(
      `Reverse this ${TYPE_UI[t.type]?.label ?? t.type} of ₹${inr(t.amount)}?\n\n`
      + `Party: ${t.party_name || '-'}\nAccount: ${t.account}\n\n`
      + 'A ledger is append-only: this posts an equal and opposite voucher and keeps both in the audit trail.\n\n'
      + 'Reason (required):');
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    try {
      const out = await fetchJson(`${FIN}/vouchers/${t.voucher_id}/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      alert(`✅ Reversed.\nReversing voucher: ${out.voucher_id}`);
      loadBook();
    } catch (e: any) {
      alert(`❌ ${e.code === 'ALREADY_REVERSED' ? 'This voucher was already reversed.' : 'Reversal failed.'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  const handleSaveBank = async () => {
    if (!newBank.ledger_name.trim()) return alert('⚠️ Enter the account name.');
    setBusy(true);
    try {
      await fetchJson(`${FIN}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ledger_name: newBank.ledger_name.trim(),
          group_head: newBank.group_head,
          company: newBank.company || null,
          account_no: newBank.account_no || null,
          ifsc_code: newBank.ifsc_code || null,
          opening_balance: parseFloat(newBank.opening_balance) || 0,
        }),
      });
      alert(`✅ '${newBank.ledger_name}' added to the chart of accounts under ${newBank.group_head}.`);
      setNewBank({ ledger_name: '', group_head: 'Bank Accounts', company: newBank.company, account_no: '', ifsc_code: '', opening_balance: '' });
      loadBook();
    } catch (e: any) {
      alert(`❌ ${e.code === 'BAD_IFSC' ? 'That IFSC is not valid.' : e.code === 'DUPLICATE_LEDGER' ? 'An account with that name already exists.' : 'Could not add the account.'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  const generatePaymentLink = () => {
    const randomId = Math.random().toString(36).slice(2, 11).toUpperCase();
    setPaymentLink(`upi://pay?pa=prasadtransport@upi&pn=PrasadTransport&tr=${randomId}&cu=INR`);
    setShowLinkModal(true);
  };

  // ── Real statement reconciliation ─────────────────────────────────────────
  // Reads a CSV exported from net banking and matches each line against the
  // entries above by amount and a ±4-day date window. It writes nothing: the
  // point is to show what the bank has that the book does not, and vice versa.
  const handleStatementUpload = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { setReconNote('That file has no data rows.'); setStatementRows([]); return; }

      const split = (l: string) => l.match(/("[^"]*"|[^,]+)/g)?.map((c) => c.replace(/^"|"$/g, '').trim()) ?? [];
      const header = split(lines[0]).map((h) => h.toLowerCase());
      const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const iDate = col('date', 'txn date', 'value date');
      const iDesc = col('narration', 'description', 'particular', 'remark');
      const iDeb = col('withdraw', 'debit', 'dr');
      const iCr = col('deposit', 'credit', 'cr');
      const iAmt = col('amount');

      if (iDate < 0 || (iAmt < 0 && iDeb < 0 && iCr < 0)) {
        setReconNote('Could not find a date and amount column. Expected headers like Date, Narration, Withdrawal, Deposit.');
        setStatementRows([]);
        return;
      }

      const num = (v: any) => parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
      const iso = (v: string) => {
        const s = String(v || '').trim();
        const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
        if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
        const d = new Date(s);
        return isNaN(+d) ? '' : d.toISOString().slice(0, 10);
      };

      const used = new Set<number>();
      const rows = lines.slice(1).map((l) => {
        const c = split(l);
        const dr = iDeb >= 0 ? num(c[iDeb]) : 0;
        const cr = iCr >= 0 ? num(c[iCr]) : 0;
        const amt = dr || cr || (iAmt >= 0 ? Math.abs(num(c[iAmt])) : 0);
        const dir = dr > 0 ? 'PAYMENT' : cr > 0 ? 'RECEIPT' : null;
        const date = iso(c[iDate]);

        // Match on amount to the paisa, same direction, within four days —
        // banks and vouchers routinely disagree about the exact posting day.
        const hit = entries.findIndex((en: any, idx: number) => {
          if (used.has(idx)) return false;
          if (Math.abs(Number(en.amount) - amt) > 0.01) return false;
          if (dir && en.type !== 'CONTRA' && en.type !== dir) return false;
          if (!date || !en.date) return true;
          return Math.abs((+new Date(en.date) - +new Date(date)) / 86400000) <= 4;
        });
        if (hit >= 0) used.add(hit);
        return {
          date, desc: iDesc >= 0 ? c[iDesc] : '', amount: amt, dir,
          matched: hit >= 0 ? entries[hit] : null,
          status: hit >= 0 ? 'matched' : 'unmatched',
        };
      }).filter((r) => r.amount > 0);

      const unmatchedBook = entries.filter((_: any, i: number) => !used.has(i));
      setStatementRows(rows);
      setReconNote(
        `${rows.filter((r) => r.status === 'matched').length} of ${rows.length} statement lines matched. `
        + `${rows.filter((r) => r.status === 'unmatched').length} not in the book; `
        + `${unmatchedBook.length} book entr${unmatchedBook.length === 1 ? 'y' : 'ies'} not on the statement.`
      );
    };
    reader.readAsText(file);
  };

  const clearDates = () => { setFromDate(''); setToDate(''); };

  const downloadStatement = () => {
    let csv = 'Date,Account,Party/Ledger,Type,Ref No,Particulars,Amount,Company,Branch,Source\n';
    entries.forEach((t: any) => {
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      csv += [t.date ?? '', esc(t.account), esc(t.party_name ?? '-'), t.type,
        esc(t.ref_no ?? '-'), esc(t.particulars ?? '-'), t.amount,
        esc(t.company ?? '-'), esc(t.branch ?? '-'), t.is_legacy ? 'LEGACY' : t.source_type].join(',') + '\n';
    });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `CashBank_${(selectedAccount === 'ALL' ? 'AllAccounts' : selectedAccount).replace(/[^A-Za-z0-9]/g, '_')}_${today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintVoucher = (t: any) => {
    const w = window.open('', '_blank');
    if (!w) return alert('Please allow popups to print.');
    const ui = TYPE_UI[t.type] ?? { label: t.type, color: '#334155' };
    const isContra = t.type === 'CONTRA';
    const vTitle = isContra ? 'CONTRA VOUCHER' : t.type === 'RECEIPT' ? 'RECEIPT VOUCHER' : 'PAYMENT VOUCHER';
    const partyName = isContra ? `${t.account} ➔ ${t.party_name ?? '-'}` : (t.party_name ?? '-');
    w.document.write(`<html><head><title>${vTitle}_${t.ref_no || t.voucher_id || 'VCH'}</title><style>
      body{font-family:'Segoe UI',Arial,sans-serif;padding:40px;color:#000;margin:0}
      .wrapper{max-width:800px;margin:0 auto;border:2px solid #000;padding:30px;border-radius:10px}
      .header{text-align:center;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:30px}
      .company{font-size:32px;font-weight:900;margin:0;text-transform:uppercase;letter-spacing:2px;color:#1e3a8a}
      .v-type{font-size:20px;font-weight:bold;background:${ui.color};color:#fff;padding:8px 20px;display:inline-block;margin-top:15px;border-radius:5px}
      .top-info{display:flex;justify-content:space-between;margin-bottom:30px;font-size:16px;font-weight:bold}
      table{width:100%;border-collapse:collapse;margin-bottom:40px;font-size:16px}
      th,td{border:1px solid #000;padding:15px;text-align:left}th{background:#f0f0f0;width:35%}
      .amount-box{text-align:center;margin:30px 0;border:2px dashed ${ui.color};padding:15px;border-radius:10px;background:#fafafa}
      .amount-text{font-size:32px;font-weight:900;color:${ui.color};margin:0}
      .footer{margin-top:80px;display:flex;justify-content:space-between;font-weight:bold;padding:0 20px;text-align:center}
      .sign-box{border-top:1px solid #000;padding-top:10px;width:200px}
      @media print{body{padding:0}.wrapper{border:none;padding:10px}
        .v-type{color:#000!important;background:transparent!important;border:2px solid #000}
        .amount-box{border:2px solid #000}.amount-text{color:#000!important}}
    </style></head><body><div class="wrapper">
      <div class="header"><h1 class="company">${selectedCompany === 'ALL' ? 'PRASAD TRANSPORT' : selectedCompany}</h1>
        <div style="font-size:14px;margin-top:5px">ACCOUNTING VOUCHER</div>
        <div class="v-type">${vTitle}</div></div>
      <div class="top-info"><div>Voucher Ref: <span style="color:${ui.color}">${t.ref_no || t.voucher_id || 'SYS-GEN'}</span></div>
        <div>Date: ${dmy(t.date)}</div></div>
      <table>
        <tr><th>${t.type === 'RECEIPT' ? 'Received From' : isContra ? 'Transfer' : 'Paid To'}</th>
            <td style="font-weight:900;font-size:18px;text-transform:uppercase">${partyName}</td></tr>
        <tr><th>Account / Source</th><td>${t.account}${t.account_group ? ` (${t.account_group})` : ''}</td></tr>
        <tr><th>Particulars</th><td>${t.particulars || 'As per accounting records.'}</td></tr>
      </table>
      <div class="amount-box"><p style="margin:0 0 5px;font-size:14px;color:#666;text-transform:uppercase">
        Total Amount ${t.type === 'RECEIPT' ? 'Received' : 'Paid'}</p>
        <h2 class="amount-text">₹ ${inr(t.amount)}</h2></div>
      <div class="footer"><div class="sign-box">Receiver's Signature</div>
        <div class="sign-box">Authorized Signatory</div></div>
    </div><script>window.onload=function(){setTimeout(function(){window.print()},400)}</script></body></html>`);
    w.document.close();
  };

  const companyBanks = accounts;

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>

      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>🏦 Cash & Bank Book</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>
            Live from the general ledger · PostgreSQL
            {book?.entry_count != null && <> · {book.entry_count} entr{book.entry_count === 1 ? 'y' : 'ies'} in range</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={generatePaymentLink} style={btn('#ec4899', '#fff')}>🔗 Gen UPI Link</button>
          <button onClick={() => setShowBankMaster(true)} style={{ ...btn('#1e293b', '#38bdf8'), border: '1px solid #38bdf8' }}>⚙️ Manage Accounts</button>
          <button onClick={() => { setShowReconcileModal(true); setStatementRows([]); setReconNote(''); }} style={btn('linear-gradient(135deg,#f59e0b,#d97706)', '#0f172a')}>🔄 Reconcile</button>
          <button onClick={() => setShowModal(true)} style={btn('linear-gradient(135deg,#10b981,#059669)', '#fff')}>+ Create Voucher</button>
          <button onClick={downloadStatement} style={{ ...btn('#334155', '#fff'), border: '1px solid #475569' }}>📥 CSV</button>
        </div>
      </div>

      {err && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', color: '#fca5a5', padding: '16px 20px', borderRadius: '12px', marginBottom: '20px', fontSize: '14px' }}>
          ⚠️ {err}
          <div style={{ color: '#94a3b8', marginTop: 6, fontSize: 12 }}>
            The book reads <code>{FIN}/cashbook</code>. Check that the ERP API is running.
          </div>
          <button onClick={loadBook} style={{ ...btn('#ef4444', '#fff'), marginTop: 10, padding: '8px 14px' }}>Retry</button>
        </div>
      )}

      {/* FILTERS */}
      <div style={{ background: 'rgba(30,41,59,0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label style={lbl('#94a3b8')}>Operating Company</label>
          <select value={selectedCompany} onChange={(e) => setSelectedCompany(e.target.value)} style={sel('#334155', '#fff')}>
            <option value="ALL">-- All Companies --</option>
            {companies.map((c) => <option key={c.company_name} value={c.company_name}>{c.company_name}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 250px' }}>
          <label style={lbl('#38bdf8')}>Bank Account / Cash Source</label>
          <select value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)} style={sel('#38bdf8', '#38bdf8')}>
            <option value="ALL">-- All Accounts & Cash --</option>
            {companyBanks.map((b: any) => (
              <option key={b.ledger_name} value={b.ledger_name}>
                {b.ledger_name}{b.account_no ? ` (${b.account_no})` : ''} — ₹{inr(b.balance)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <label style={lbl('#94a3b8')}>Branch</label>
          <select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)} style={sel('#334155', '#fff')}>
            <option value="ALL">-- All Branches --</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <label style={lbl('#94a3b8')}>From Date</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...sel('#334155', '#fff'), colorScheme: 'dark' }} />
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <label style={lbl('#94a3b8')}>To Date</label>
            {(fromDate || toDate) && <span onClick={clearDates} style={{ color: '#ef4444', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>❌ Clear</span>}
          </div>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...sel('#334155', '#fff'), colorScheme: 'dark' }} />
        </div>
        <div style={{ flex: '2 1 250px' }}>
          <label style={lbl('#f59e0b')}>Search</label>
          <input type="text" placeholder="🔍 Party, ref/UTR, narration…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} style={sel('#f59e0b', '#fff')} />
        </div>
      </div>

      {/* SUMMARY */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px' }}>
        {card('#94a3b8', 'Opening Balance', opening, '#cbd5e1')}
        {card('#10b981', 'Total In (Receipts)', totalIn)}
        {card('#ef4444', 'Total Out (Payments)', totalOut)}
        {card('#38bdf8', closing >= 0 ? 'Closing Balance' : 'Closing Balance (Overdrawn)', Math.abs(closing))}
      </div>

      {book?.truncated && (
        <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', color: '#fcd34d', padding: '12px 16px', borderRadius: '10px', marginBottom: '18px', fontSize: '13px' }}>
          Showing the most recent {book.returned} of {book.entry_count} entries. The balances above cover all {book.entry_count} — narrow the dates to list the rest.
        </div>
      )}

      {/* LEDGER TABLE */}
      <div style={{ background: '#1e293b', borderRadius: '15px', overflowX: 'auto', border: '1px solid #334155' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ background: '#0f172a', color: '#94a3b8', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Party / Contra Account</th>
              <th style={th}>Ref / UTR</th>
              <th style={th}>Account</th>
              <th style={th}>Voucher Type</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount (₹)</th>
              <th style={{ ...th, textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8', fontWeight: 'bold' }}>Loading from PostgreSQL…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>
                {err ? 'Could not load — see the message above.' : 'No entries for these filters.'}
              </td></tr>
            ) : entries.map((t: any) => {
              const ui = TYPE_UI[t.type] ?? { label: t.type, color: '#94a3b8', sign: '' };
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px' }}>
                  <td style={td}>{dmy(t.date)}</td>
                  <td style={{ ...td, fontWeight: 'bold', color: '#fff' }}>
                    {t.party_name || (t.is_legacy ? '—' : 'Unknown')}
                    {t.is_legacy ? (
                      <span title="Imported before double-entry; no voucher behind it" style={tag('#78350f', '#fcd34d')}>Legacy</span>
                    ) : t.party_group ? (
                      <span style={tag('#334155', '#cbd5e1')}>{t.party_group}</span>
                    ) : null}
                    <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 'normal', marginTop: '4px', whiteSpace: 'normal', maxWidth: 420 }}>{t.particulars || '-'}</div>
                  </td>
                  <td style={{ ...td, color: '#38bdf8', fontFamily: 'monospace', fontWeight: 'bold' }}>{t.ref_no || '-'}</td>
                  <td style={{ ...td, fontWeight: 'bold' }}>
                    {t.account}
                    {t.account_group === 'Cash-in-Hand' && <span style={tag('#1e3a8a', '#93c5fd')}>Cash</span>}
                  </td>
                  <td style={td}>
                    <span style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', background: `${ui.color}1a`, color: ui.color, border: `1px solid ${ui.color}` }}>
                      {ui.label}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 'bold', fontSize: '16px', color: ui.color }}>
                    {t.type === 'CONTRA' ? '🔄 ' : t.dr_cr === 'DR' ? '+ ' : '- '}{inr(t.amount)}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                      <button onClick={() => handlePrintVoucher(t)} title="Print voucher" style={iconBtn('#38bdf8')}>🖨️</button>
                      <button onClick={() => handleReverse(t)} disabled={busy || t.is_legacy} title={t.is_legacy ? 'Legacy entry — no voucher to reverse' : 'Post a reversing voucher'} style={{ ...iconBtn('#ef4444'), opacity: t.is_legacy ? 0.35 : 1, cursor: t.is_legacy ? 'not-allowed' : 'pointer' }}>↩️</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* VOUCHER MODAL */}
      {showModal && (
        <div style={overlay}>
          <div style={{ width: '100%', maxWidth: '750px', background: '#0f172a', borderRadius: '24px', border: '1px solid rgba(56,189,248,0.3)', padding: '35px', boxShadow: '0 30px 60px rgba(0,0,0,0.9)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1e293b', paddingBottom: '15px', marginBottom: '25px' }}>
              <div>
                <h3 style={{ color: '#fff', margin: 0, fontSize: '22px' }}>
                  {formData.type === 'PAYMENT' ? '💸 Pay' : formData.type === 'RECEIPT' ? '📥 Receive' : '🔄 Transfer'}
                </h3>
                <p style={{ color: '#64748b', fontSize: '13px', margin: '5px 0 0 0' }}>Posted through TARA — double-entry, guarded, append-only</p>
              </div>
              <button onClick={() => setShowModal(false)} style={{ ...btn('transparent', '#94a3b8'), fontSize: 22, padding: '2px 10px' }}>✕</button>
            </div>

            <div style={{ display: 'flex', background: '#1e293b', padding: '6px', borderRadius: '12px', marginBottom: '25px' }}>
              {(['RECEIPT', 'PAYMENT', 'CONTRA'] as const).map((tp) => (
                <button key={tp} onClick={() => setFormData({ ...formData, type: tp })} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: formData.type === tp ? TYPE_UI[tp].color : 'transparent', color: formData.type === tp ? '#fff' : '#94a3b8' }}>
                  {TYPE_UI[tp].label}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
              <div style={box('#1e293b', '#334155')}>
                <label style={lbl('#94a3b8')}>📅 Voucher Date *</label>
                <input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} style={{ ...sel('#475569', '#fff'), colorScheme: 'dark' }} />
              </div>
              <div style={box('rgba(16,185,129,0.05)', 'rgba(16,185,129,0.2)')}>
                <label style={lbl('#10b981')}>💰 Amount (₹) *</label>
                <input type="number" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: e.target.value })} placeholder="0.00" style={{ ...sel('#10b981', '#10b981'), fontSize: 20, fontWeight: 900 }} />
                {formData.type !== 'CONTRA' && <div style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>Gross, before TDS.</div>}
              </div>
            </div>

            {formData.type !== 'CONTRA' && (
              <div style={{ ...box('#1e293b', '#334155'), marginBottom: 20 }}>
                <label style={lbl('#38bdf8')}>👤 Party *</label>
                <input type="text" value={partyQuery} onChange={(e) => { setPartyQuery(e.target.value); setFormData({ ...formData, party_ledger: '', party_group: '' }); }} placeholder="Type 2+ letters — customers, vendors, drivers, accounts…" style={sel('#38bdf8', '#fff')} />
                {partyHits.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 190, overflowY: 'auto', border: '1px solid #334155', borderRadius: 8 }}>
                    {partyHits.map((h) => (
                      <div key={`${h.kind}-${h.id}`} onClick={() => pickParty(h)} style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ color: '#e2e8f0', fontSize: 13 }}>
                          <span style={tag('#334155', '#93c5fd')}>{h.kind}</span> {h.name}
                        </span>
                        <span style={{ color: Number(h.balance) >= 0 ? '#10b981' : '#f43f5e', fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                          ₹{inr(h.balance)} {h.balance_side}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {formData.party_ledger && (
                  <div style={{ marginTop: 12, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.35)', padding: 12, borderRadius: 8 }}>
                    <div style={{ color: '#10b981', fontSize: 13, fontWeight: 'bold' }}>Posting to: {formData.party_ledger}</div>
                    {formData.party_group && <div style={{ color: '#64748b', fontSize: 11, marginTop: 3 }}>{formData.party_group}</div>}
                    {partyCtx?.warnings?.map((w: string, i: number) => (
                      <div key={i} style={{ color: '#fcd34d', fontSize: 11, marginTop: 6 }}>⚠️ {w}</div>
                    ))}
                    {partyCtx?.pending_advance != null && (
                      <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 6 }}>Pending advance: ₹{inr(partyCtx.pending_advance)}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              <div style={box('#1e293b', '#334155')}>
                <label style={lbl('#38bdf8')}>{formData.type === 'CONTRA' ? '🏦 From Account *' : '🏦 Bank / Cash Account *'}</label>
                <select value={formData.account} onChange={(e) => setFormData({ ...formData, account: e.target.value })} style={sel('#38bdf8', '#fff')}>
                  <option value="">-- Select --</option>
                  {accounts.map((a: any) => <option key={a.ledger_name} value={a.ledger_name}>{a.ledger_name} — ₹{inr(a.balance)}</option>)}
                </select>
              </div>
              {formData.type === 'CONTRA' ? (
                <div style={box('#1e293b', '#334155')}>
                  <label style={lbl('#f59e0b')}>🏦 To Account *</label>
                  <select value={formData.to_account} onChange={(e) => setFormData({ ...formData, to_account: e.target.value })} style={sel('#f59e0b', '#fff')}>
                    <option value="">-- Select --</option>
                    {accounts.filter((a: any) => a.ledger_name !== formData.account).map((a: any) => (
                      <option key={a.ledger_name} value={a.ledger_name}>{a.ledger_name} — ₹{inr(a.balance)}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div style={box('#1e293b', '#334155')}>
                  <label style={lbl('#c084fc')}>✂️ TDS withheld (₹)</label>
                  <input type="number" value={formData.tds_amount} onChange={(e) => setFormData({ ...formData, tds_amount: e.target.value })} placeholder="0.00" style={sel('#c084fc', '#fff')} />
                  <div style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>
                    {formData.type === 'RECEIPT' ? 'Withheld from us — booked as an asset.' : 'Withheld by us — booked as a liability.'}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              <div style={box('#1e293b', '#334155')}>
                <label style={lbl('#94a3b8')}>🔖 Ref / Cheque / UTR</label>
                <input type="text" value={formData.ref_no} onChange={(e) => setFormData({ ...formData, ref_no: e.target.value })} placeholder="Posts once, ever" style={sel('#475569', '#fff')} />
              </div>
              <div style={box('#1e293b', '#334155')}>
                <label style={lbl('#94a3b8')}>🏢 Branch</label>
                <select value={formData.branch} onChange={(e) => setFormData({ ...formData, branch: e.target.value })} style={sel('#475569', '#fff')}>
                  <option value="">-- None --</option>
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>

            <div style={{ ...box('#1e293b', '#334155'), marginBottom: 25 }}>
              <label style={lbl('#94a3b8')}>📝 Narration</label>
              <textarea value={formData.particulars} onChange={(e) => setFormData({ ...formData, particulars: e.target.value })} rows={2} placeholder="What this voucher is for" style={{ ...sel('#475569', '#fff'), resize: 'vertical', fontFamily: 'inherit' }} />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={() => setShowModal(false)} style={{ ...btn('#334155', '#fff'), flex: 1, padding: 14 }}>Cancel</button>
              <button onClick={handleSaveVoucher} disabled={busy} style={{ ...btn(busy ? '#334155' : TYPE_UI[formData.type].color, '#fff'), flex: 2, padding: 14, fontSize: 15 }}>
                {busy ? 'Posting…' : `Post ${TYPE_UI[formData.type].label}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BANK MASTER MODAL */}
      {showBankMaster && (
        <div style={overlay}>
          <div style={{ width: '100%', maxWidth: 700, background: '#0f172a', borderRadius: 20, border: '1px solid #334155', padding: 30, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ color: '#fff', margin: 0 }}>⚙️ Bank & Cash Accounts</h3>
              <button onClick={() => setShowBankMaster(false)} style={{ ...btn('transparent', '#94a3b8'), fontSize: 22, padding: '2px 10px' }}>✕</button>
            </div>
            <p style={{ color: '#64748b', fontSize: 12, marginTop: 0 }}>
              An account is a ledger under Bank Accounts or Cash-in-Hand — there is no separate bank table to drift from the chart of accounts.
              The opening balance is set on the master; it is not posted as an entry.
            </p>

            <div style={{ background: '#1e293b', borderRadius: 12, overflow: 'hidden', marginBottom: 25, border: '1px solid #334155' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ background: '#0f172a', color: '#94a3b8' }}>
                  <tr><th style={th2}>Account</th><th style={th2}>Group</th><th style={th2}>A/c No</th><th style={th2}>IFSC</th><th style={{ ...th2, textAlign: 'right' }}>Balance</th></tr>
                </thead>
                <tbody>
                  {accounts.map((a: any) => (
                    <tr key={a.ledger_name} style={{ borderTop: '1px solid #334155', color: '#cbd5e1' }}>
                      <td style={td2}>{a.ledger_name}</td>
                      <td style={{ ...td2, color: '#64748b' }}>{a.group_head}</td>
                      <td style={{ ...td2, fontFamily: 'monospace' }}>{a.account_no || '-'}</td>
                      <td style={{ ...td2, fontFamily: 'monospace' }}>{a.ifsc_code || '-'}</td>
                      <td style={{ ...td2, textAlign: 'right', fontWeight: 'bold', color: Number(a.balance) >= 0 ? '#10b981' : '#f43f5e' }}>₹{inr(a.balance)}</td>
                    </tr>
                  ))}
                  {accounts.length === 0 && <tr><td colSpan={5} style={{ ...td2, textAlign: 'center', color: '#64748b' }}>No accounts yet.</td></tr>}
                </tbody>
              </table>
            </div>

            <h4 style={{ color: '#38bdf8', margin: '0 0 12px' }}>➕ Add an account</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><label style={lbl('#94a3b8')}>Account name *</label>
                <input value={newBank.ledger_name} onChange={(e) => setNewBank({ ...newBank, ledger_name: e.target.value })} placeholder="e.g. SBI (1234)" style={sel('#475569', '#fff')} /></div>
              <div><label style={lbl('#94a3b8')}>Group *</label>
                <select value={newBank.group_head} onChange={(e) => setNewBank({ ...newBank, group_head: e.target.value })} style={sel('#475569', '#fff')}>
                  <option value="Bank Accounts">Bank Accounts</option>
                  <option value="Cash-in-Hand">Cash-in-Hand</option>
                </select></div>
              <div><label style={lbl('#94a3b8')}>Company</label>
                <select value={newBank.company} onChange={(e) => setNewBank({ ...newBank, company: e.target.value })} style={sel('#475569', '#fff')}>
                  <option value="">-- None --</option>
                  {companies.map((c) => <option key={c.company_name} value={c.company_name}>{c.company_name}</option>)}
                </select></div>
              <div><label style={lbl('#94a3b8')}>Opening balance (₹)</label>
                <input type="number" value={newBank.opening_balance} onChange={(e) => setNewBank({ ...newBank, opening_balance: e.target.value })} placeholder="0.00" style={sel('#475569', '#fff')} /></div>
              <div><label style={lbl('#94a3b8')}>Account number</label>
                <input value={newBank.account_no} onChange={(e) => setNewBank({ ...newBank, account_no: e.target.value })} style={sel('#475569', '#fff')} /></div>
              <div><label style={lbl('#94a3b8')}>IFSC</label>
                <input value={newBank.ifsc_code} onChange={(e) => setNewBank({ ...newBank, ifsc_code: e.target.value.toUpperCase() })} placeholder="SBIN0001234" style={sel('#475569', '#fff')} />
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>Validated server-side — a wrong code fails at the bank, not here.</div></div>
            </div>
            <button onClick={handleSaveBank} disabled={busy} style={{ ...btn('#10b981', '#fff'), marginTop: 18, width: '100%', padding: 13 }}>
              {busy ? 'Saving…' : '✅ Add Account'}
            </button>
          </div>
        </div>
      )}

      {/* RECONCILE MODAL */}
      {showReconcileModal && (
        <div style={overlay}>
          <div style={{ width: '100%', maxWidth: 900, background: '#0f172a', borderRadius: 20, border: '1px solid #f59e0b', padding: 30, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ color: '#f59e0b', margin: 0 }}>🔄 Statement Reconciliation</h3>
              <button onClick={() => setShowReconcileModal(false)} style={{ ...btn('transparent', '#94a3b8'), fontSize: 22, padding: '2px 10px' }}>✕</button>
            </div>
            <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
              Upload the CSV your bank exports. Each line is matched against the {entries.length} book entr{entries.length === 1 ? 'y' : 'ies'} currently
              listed — same amount, same direction, within four days. Nothing is written; this only shows where the two disagree.
            </p>
            <input type="file" accept=".csv,text/csv" onChange={handleStatementUpload} style={{ ...sel('#475569', '#fff'), padding: 10, marginBottom: 14 }} />
            {reconNote && (
              <div style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid #38bdf8', color: '#bae6fd', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{reconNote}</div>
            )}
            {statementRows.length > 0 && (
              <div style={{ background: '#1e293b', borderRadius: 12, overflow: 'hidden', border: '1px solid #334155' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead style={{ background: '#0f172a', color: '#94a3b8' }}>
                    <tr><th style={th2}>Stmt Date</th><th style={th2}>Description</th><th style={{ ...th2, textAlign: 'right' }}>Amount</th><th style={th2}>Dir</th><th style={th2}>Matched book entry</th></tr>
                  </thead>
                  <tbody>
                    {statementRows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #334155', color: '#cbd5e1', background: r.status === 'matched' ? 'transparent' : 'rgba(239,68,68,0.07)' }}>
                        <td style={td2}>{r.date ? dmy(r.date) : '?'}</td>
                        <td style={{ ...td2, maxWidth: 280, whiteSpace: 'normal' }}>{r.desc || '-'}</td>
                        <td style={{ ...td2, textAlign: 'right', fontWeight: 'bold' }}>₹{inr(r.amount)}</td>
                        <td style={td2}>{r.dir ? TYPE_UI[r.dir]?.label ?? r.dir : '?'}</td>
                        <td style={td2}>
                          {r.matched
                            ? <span style={{ color: '#10b981' }}>✅ {dmy(r.matched.date)} · {r.matched.party_name || r.matched.account}</span>
                            : <span style={{ color: '#f87171' }}>⚠️ not in the book</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* UPI LINK MODAL */}
      {showLinkModal && (
        <div style={overlay}>
          <div style={{ width: '100%', maxWidth: 480, background: '#0f172a', borderRadius: 20, border: '1px solid #ec4899', padding: 30 }}>
            <h3 style={{ color: '#ec4899', marginTop: 0 }}>🔗 UPI Collect Link</h3>
            <p style={{ color: '#94a3b8', fontSize: 13 }}>Share this with the payer. Money received still has to be entered as a RECEIPT voucher — the link does not post anything.</p>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 12, color: '#38bdf8', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{paymentLink}</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => { navigator.clipboard?.writeText(paymentLink); alert('Copied.'); }} style={{ ...btn('#38bdf8', '#0f172a'), flex: 1, padding: 12 }}>Copy</button>
              <button onClick={() => setShowLinkModal(false)} style={{ ...btn('#334155', '#fff'), flex: 1, padding: 12 }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── small style helpers, kept local so the screen stays self-contained ───────
const btn = (bg: string, color: string): React.CSSProperties => ({ background: bg, color, border: 'none', padding: '10px 15px', borderRadius: 8, fontWeight: 'bold', cursor: 'pointer' });
const lbl = (color: string): React.CSSProperties => ({ color, fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase', display: 'block', marginBottom: 6 });
const sel = (border: string, color: string): React.CSSProperties => ({ width: '100%', padding: 12, background: '#0f172a', border: `1px solid ${border}`, color, borderRadius: 8, outline: 'none', boxSizing: 'border-box', fontWeight: 'bold' });
const box = (bg: string, border: string): React.CSSProperties => ({ background: bg, padding: 15, borderRadius: 12, border: `1px solid ${border}` });
const th: React.CSSProperties = { padding: '15px 20px' };
const td: React.CSSProperties = { padding: '15px 20px' };
const th2: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontSize: 11, textTransform: 'uppercase' };
const td2: React.CSSProperties = { padding: '10px 12px' };
const overlay: React.CSSProperties = { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2,6,23,0.92)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' };
const tag = (bg: string, color: string): React.CSSProperties => ({ fontSize: 10, background: bg, color, padding: '3px 8px', borderRadius: 10, marginLeft: 6, fontWeight: 'bold' });
const iconBtn = (color: string): React.CSSProperties => ({ background: `${color}1a`, color, border: `1px solid ${color}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 12 });

function card(color: string, label: string, value: number, valueColor = '#fff') {
  return (
    <div key={label} style={{ background: `linear-gradient(135deg, ${color}1a, ${color}0d)`, border: `1px solid ${color}4d`, padding: 25, borderRadius: 15 }}>
      <div style={{ color, fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 900, color: valueColor, marginTop: 5 }}>₹ {inr(value)}</div>
    </div>
  );
}
