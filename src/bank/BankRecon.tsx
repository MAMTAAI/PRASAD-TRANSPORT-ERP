// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// BANK & CASH RECONCILIATION — the statement is the spine, the book hangs on it.
//
// Owner, 5-Sep-2026 (mock v1 approved with four answers): upload the SBI
// statement, TARA tallies every line against what the ERP expects, an exact
// match posts itself and clears the due, everything else waits on the Staff
// Action desk where a person links it to the party / bill / trip and the
// decision becomes a rule. Book entries the bank does not know are flagged,
// never reversed.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useRef } from 'react';
import GlobalPagination, { usePagination } from '../components/GlobalPagination';
import { API_BASE } from '../lib/apiBase';
import { useIsMobile } from '../hooks/useIsMobile';

const API = `${API_BASE}/api/v1/bank-recon`;
const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.detail || j.error || `HTTP ${res.status}`), { code: j.error, body: j });
  return j;
};
const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => (d ? String(d).slice(0, 10) : '');
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');
const C = { ink: '#eef2fd', ink2: '#c4d1ea', mut: '#9aadd4', dim: '#5d7196', line: '#27395f', raised: '#18244a', panel: '#121c38', cyan: '#22d3ee', good: '#2fe39b', crit: '#ff6b81', warn: '#ffb224', ai: '#a78bfa', cust: '#38bdf8' };
const STATUS = { NEW: ['NEW', C.mut], AUTO_POSTED: ['AUTO-POSTED', C.good], LINKED: ['LINKED', C.cyan], REVIEW: ['STAFF REVIEW', C.warn], PARKED: ['PARKED', C.ai], NOT_OURS: ['NOT OURS', C.dim], IGNORED: ['IGNORED', C.dim] };
const CAT = { CUSTOMER_RECEIPT: ['Customer receipt', C.good], OWNER_PAYMENT: ['Owner payment', C.warn], PARTNER_PAYMENT: ['Partner payment', C.warn], VENDOR_PAYMENT: ['Vendor payment', C.warn], DRIVER_ADVANCE: ['Driver advance', C.warn], LOAN_EMI: ['Loan EMI', C.ai],
  INTER_FIRM: ['Inter-firm', C.cust], FASTAG_RECHARGE: ['FASTag recharge', C.cyan], FLEET_CARD_LOAD: ['Fleet card load', C.cyan], BANK_CHARGE: ['Bank charge', C.mut], BANK_INTEREST: ['Interest', C.good], CASH: ['Cash', C.warn], LEDGER: ['Ledger', C.mut], BOOK_VOUCHER: ['Book voucher', C.cyan], OTHER_RECEIPT: ['Unclassified receipt', C.crit], OTHER_PAYMENT: ['Unclassified payment', C.crit] };
const Pill = ({ s }) => { const x = STATUS[s] ?? [s, C.dim]; return <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', borderRadius: '999px', padding: '2px 9px', border: `1px solid ${x[1]}`, color: x[1], whiteSpace: 'nowrap' }}>{x[0]}</span>; };
const Chip = ({ c }) => { const x = CAT[c] ?? [c ?? '—', C.dim]; return <span style={{ fontSize: '10px', fontWeight: 800, borderRadius: '6px', padding: '1px 7px', border: `1px solid ${x[1]}`, color: x[1], whiteSpace: 'nowrap' }}>{x[0]}</span>; };
const btn = (kind, on = true) => ({ font: 'inherit', fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 13px', border: `1px solid ${C.line}`, background: 'transparent', color: C.mut, cursor: on ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap', opacity: on ? 1 : 0.5,
  ...({ good: { background: 'rgba(47,227,155,.10)', borderColor: 'rgba(47,227,155,.55)', color: C.good }, solid: { background: C.good, borderColor: C.good, color: '#0a1024' }, cyan: { background: 'rgba(34,211,238,.12)', borderColor: 'rgba(34,211,238,.5)', color: C.cyan },
        warn: { background: 'rgba(255,178,36,.12)', borderColor: 'rgba(255,178,36,.5)', color: C.warn }, ai: { background: 'rgba(167,139,250,.14)', borderColor: 'rgba(167,139,250,.5)', color: '#c4b5fd' }, crit: { background: 'rgba(255,107,129,.12)', borderColor: 'rgba(255,107,129,.5)', color: C.crit } }[kind] ?? {}) });
const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', cursor: 'pointer', border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut, background: on ? 'rgba(34,211,238,.12)' : 'transparent', whiteSpace: 'nowrap' });
const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.08em', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,.5)' };
const td = { padding: '8px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px' };

export default function BankRecon({ onLegacy }) {
  const { isPhone } = useIsMobile();
  const [sum, setSum] = useState(null);
  const [tab, setTab] = useState('DESK');        // BOOK | UPLOAD | DESK | FLAGGED | RULES
  const [account, setAccount] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadSummary = useCallback(async () => { try { setSum(await apiJson(`${API}/summary`)); } catch (e) { setErr(e.message); } }, []);
  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(); if (account) qs.set('account', account); if (q.trim()) qs.set('q', q.trim());
      const st = tab === 'DESK' ? (status || 'NEW,REVIEW,PARKED') : status; if (st) qs.set('status', st); qs.set('limit', '600');
      setRows((await apiJson(`${API}/lines?${qs}`)).rows);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [account, q, status, tab]);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { if (['BOOK', 'DESK'].includes(tab)) loadRows(); }, [loadRows, tab]);
  // Newest first, 10 / 20 / 30 / 40 / 50 per page (owner, 5-Sep) — the server
  // already orders waiting lines first, then by date descending.
  const pg = usePagination(rows, { defaultSize: 10 });
  useEffect(() => { pg.setPage(1); }, [account, q, status, tab]);
  const refreshAll = async () => { await loadSummary(); await loadRows(); };

  const retally = async () => { setBusy(true); try { const t = await apiJson(`${API}/tally`, { method: 'POST', body: JSON.stringify({ account_id: account || null }) }); alert(`🤖 TARA: ${t.lines} lines · posted ${t.auto_posted} · linked ${t.linked} · for the desk ${t.review} · not ours ${t.not_ours}${t.errors ? ` · errors ${t.errors}` : ''}`); await refreshAll(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false); };
  const accts = sum?.accounts ?? []; const T = sum?.totals ?? {};
  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #121c38, #0a1024)', padding: isPhone ? '12px' : '20px 24px 50px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>Accounts &amp; Admin · Bank &amp; Cash Book</div>
          <h2 style={{ margin: 0, fontSize: isPhone ? '22px' : '28px', color: '#fff' }}>🏦 Bank &amp; Cash Reconciliation</h2>
          {!isPhone && <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '4px', maxWidth: '96ch' }}>Every statement line is tallied by TARA against customer bills, IOCL advices, owner and partner bills, vendors, drivers, loan EMIs, wallets and our own firms. An exact match posts itself; the rest waits here for a person, and each decision becomes a rule.</div>}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={() => setTab('UPLOAD')} style={btn(tab === 'UPLOAD' ? 'good' : 'plain')}>📎 Upload statement</button>
          <button onClick={retally} disabled={busy} style={btn('ai', !busy)}>🤖 Run auto-tally</button>
          {onLegacy && <button onClick={onLegacy} style={btn('plain')}>📒 Legacy book &amp; vouchers</button>}
        </div>
      </div>

      {/* accounts */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isPhone ? '240px' : '300px'}, 1fr))`, gap: '10px', marginBottom: '14px' }}>
        {accts.map((a) => { const gap = a.bank_closing !== null && a.bank_closing !== undefined ? n2(a.book_balance) - n2(a.bank_closing) : null;
          return (<div key={a.id} onClick={() => setAccount(account === a.id ? '' : a.id)} style={{ background: account === a.id ? 'rgba(56,189,248,.10)' : C.panel, border: `1px solid ${account === a.id ? C.cust : C.line}`, borderRadius: '12px', padding: '12px 14px', cursor: 'pointer', minWidth: 0 }}>
            <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>{a.company_name ?? 'firm not set'}</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: C.ink }}>{a.ledger_name} <span style={{ color: C.dim, fontWeight: 500, fontSize: '12px' }}>· {a.account_kind === 'SAVINGS' ? 'Savings' : 'Current'} ····{a.account_tail}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '6px', marginTop: '8px', fontSize: '12px' }}>
              <div><div style={{ fontSize: '10px', color: C.dim, textTransform: 'uppercase' }}>Statement</div><b>{a.first_txn ? `${dmy(a.first_txn)} → ${dmy(a.last_txn)}` : '—'}</b><div style={{ color: C.dim, fontSize: '10.5px' }}>{a.lines} lines</div></div>
              <div><div style={{ fontSize: '10px', color: C.dim, textTransform: 'uppercase' }}>Bank closing</div><b>{a.bank_closing !== null && a.bank_closing !== undefined ? inr(a.bank_closing) : '—'}</b></div>
              <div><div style={{ fontSize: '10px', color: C.dim, textTransform: 'uppercase' }}>Book</div><b style={{ color: gap === null ? C.ink : Math.abs(gap) > 1000 ? C.crit : C.good }}>{inr(a.book_balance)}</b><div style={{ color: C.dim, fontSize: '10.5px' }}>{a.book_not_in_bank ? `${a.book_not_in_bank} not in bank` : ''}</div></div>
            </div>
            <div style={{ display: 'flex', height: '6px', borderRadius: '4px', overflow: 'hidden', background: '#1b2a4e', marginTop: '8px' }}>
              <span style={{ width: `${(100 * (n2(a.auto_posted) + n2(a.linked))) / (n2(a.lines) || 1)}%`, background: C.good }} /><span style={{ width: `${(100 * n2(a.waiting)) / (n2(a.lines) || 1)}%`, background: C.warn }} /><span style={{ width: `${(100 * n2(a.not_ours)) / (n2(a.lines) || 1)}%`, background: C.dim }} />
            </div>
            <div style={{ fontSize: '11px', color: C.mut, marginTop: '5px' }}>posted {a.auto_posted} · linked {a.linked} · <span style={{ color: n2(a.waiting) ? C.warn : C.mut }}>waiting {a.waiting}</span> · parked {a.parked} · not ours {a.not_ours}</div>
          </div>); })}
        {accts.length === 0 && <div style={{ color: C.dim, fontSize: '12.5px' }}>{err || 'No bank accounts on file yet.'}</div>}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'center' }}>
        {[['DESK', `⚠️ Staff Action${T.waiting ? ` (${T.waiting})` : ''}`], ['BOOK', '🏦 Bank book'], ['FLAGGED', `🚩 In book, not in bank${sum?.book_not_in_bank?.n ? ` (${sum.book_not_in_bank.n})` : ''}`], ['RULES', `📐 Rules${sum?.rules?.n ? ` (${sum.rules.n})` : ''}`], ['UPLOAD', '📎 Statements']].map((t) => (
          <span key={t[0]} onClick={() => setTab(t[0])} style={chip(tab === t[0])}>{t[1]}</span>))}
        {['BOOK', 'DESK'].includes(tab) && (<>
          <span style={{ width: '6px' }} />
          {(tab === 'DESK' ? [['', 'Waiting'], ['REVIEW', 'Review'], ['NEW', 'New'], ['PARKED', 'Parked']] : [['', 'All'], ['AUTO_POSTED', 'Auto-posted'], ['LINKED', 'Linked'], ['REVIEW', 'Review'], ['NOT_OURS', 'Not ours'], ['IGNORED', 'Ignored']]).map((s) => (
            <span key={s[0]} onClick={() => setStatus(s[0])} style={chip(status === s[0])}>{s[1]}</span>))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Counterparty / UTR / narration" style={{ ...inp, width: isPhone ? '100%' : '220px' }} />
        </>)}
      </div>

      {tab === 'UPLOAD' && <Upload onDone={refreshAll} />}
      {tab === 'RULES' && <Rules />}
      {tab === 'FLAGGED' && <Flagged account={account} />}
      {['BOOK', 'DESK'].includes(tab) && (
        <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
          {loading ? <p style={{ color: C.warn, textAlign: 'center', padding: '24px' }}>Loading…</p>
          : rows.length === 0 ? <p style={{ color: tab === 'DESK' ? C.good : C.dim, textAlign: 'center', padding: '24px', fontSize: '13px' }}>{tab === 'DESK' ? '✅ Nothing waiting — every statement line is posted, linked or decided.' : 'No statement lines yet — upload a statement.'}</p>
          : (<table style={{ width: '100%', minWidth: '1100px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Account</th><th style={th}>Counterparty · narration · UTR</th><th style={{ ...th, textAlign: 'right' }}>Withdrawal</th><th style={{ ...th, textAlign: 'right' }}>Deposit</th><th style={{ ...th, textAlign: 'right' }}>Balance</th><th style={th}>TARA · target</th><th style={th}>State</th></tr></thead>
              <tbody>{pg.slice.map((l) => (
                <tr key={l.id} onClick={() => setOpenId(l.id)} style={{ cursor: 'pointer' }}>
                  <td style={td}>{dmy(l.txn_date)}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.channel}</div></td>
                  <td style={td}>{l.ledger_name}<div style={{ fontSize: '10.5px', color: C.dim }}>{(l.company_name ?? '').replace(/^M\/S\s+/i, '')}</div></td>
                  <td style={{ ...td, whiteSpace: 'normal', minWidth: '260px' }}><b style={{ color: C.ink }}>{l.counterparty || (l.description || '').replace(/^(TO|BY) TRANSFER-\s*/, '').slice(0, 28)}</b><div style={{ fontSize: '10.5px', color: C.dim }}>{(l.description || '').slice(0, 70)}{l.utr ? <> · <span style={{ fontFamily: 'monospace', color: C.cust }}>{l.utr}</span></> : null}</div></td>
                  <td style={{ ...tdR, color: n2(l.debit) ? C.crit : C.dim }}>{n2(l.debit) ? inr2(l.debit) : ''}</td>
                  <td style={{ ...tdR, color: n2(l.credit) ? C.good : C.dim }}>{n2(l.credit) ? inr2(l.credit) : ''}</td>
                  <td style={{ ...tdR, color: C.mut }}>{l.balance !== null ? inr2(l.balance) : ''}</td>
                  <td style={{ ...td, whiteSpace: 'normal', minWidth: '220px' }}><Chip c={l.category} />{l.target_label && <div style={{ fontSize: '11px', color: C.ink2 }}>{l.target_label}</div>}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.why}</div></td>
                  <td style={td}><Pill s={l.status} />{l.linked_by && <div style={{ fontSize: '10px', color: C.dim }}>{l.linked_by} · {day(l.linked_at)}</div>}</td>
                </tr>))}</tbody>
            </table>)}
        </div>)}
      {['BOOK', 'DESK'].includes(tab) && rows.length > 0 && <GlobalPagination {...pg} label="lines" />}
      {openId && <LineDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refreshAll} />}
    </div>
  );
}

// ══ UPLOAD ══════════════════════════════════════════════════════════════════
function Upload({ onDone }) {
  const [file, setFile] = useState(null); const [password, setPassword] = useState(''); const [accountNo, setAccountNo] = useState(''); const [busy, setBusy] = useState(false); const [res, setRes] = useState(null);
  const send = async () => {
    if (!file) return alert('Choose the statement file first.');
    setBusy(true); setRes(null);
    try { const fd = new FormData(); fd.append('file', file); if (password) fd.append('password', password); if (accountNo) fd.append('account', accountNo);
      const j = await apiJson(`${API}/statements/upload`, { method: 'POST', body: fd }); setRes(j); onDone?.(); }
    catch (e) { setRes({ error: e.message, body: e.body }); }
    setBusy(false);
  };
  return (
    <div style={{ border: '1px solid rgba(47,227,155,.45)', background: 'rgba(47,227,155,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.good, fontSize: '14px' }}>📎 Upload a bank statement</b>
      <div style={{ color: C.mut, fontSize: '12px', margin: '4px 0 10px', maxWidth: '92ch' }}>SBI PDF as the bank e-mails it (current or savings layout, password accepted), or a CSV / XLSX export. The account is read from the document. Lines already held are skipped, so re-uploading a month is harmless. TARA tallies the new lines at once.</div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="file" accept=".pdf,.csv,.xlsx,.xls,application/pdf,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ color: C.ink2, fontSize: '12px' }} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="PDF password (if any)" style={{ ...inp, width: '170px' }} autoComplete="off" />
        <input value={accountNo} onChange={(e) => setAccountNo(e.target.value)} placeholder="Account no (only if not in the file)" style={{ ...inp, width: '230px' }} />
        <button onClick={send} disabled={busy || !file} style={btn('good', !busy && !!file)}>{busy ? '⏳ Reading & tallying…' : '📥 Read & tally'}</button>
      </div>
      {res && <div style={{ marginTop: '10px', fontSize: '12.5px', color: res.error ? C.crit : C.ink2, whiteSpace: 'pre-wrap', background: 'rgba(10,16,36,.55)', borderRadius: '8px', padding: '10px 12px' }}>{res.error ? `❌ ${res.error}${res.body?.meta?.account_name ? ` (${res.body.meta.account_name})` : ''}` : `✅ ${res.summary}`}</div>}
    </div>
  );
}

// ══ ONE LINE — what it could be, what a person decides ══════════════════════
function LineDrawer({ id, onClose, onChanged }) {
  const { isPhone } = useIsMobile();
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ category: '', party_kind: '', party_id: '', party_name: '', ledger_name: '', bill_id: '', trip_id: '', other_firm: '', other_ledger: '', book_entry_id: '', remember: true, auto_next_time: false, note: '' });
  const load = useCallback(async () => { try { const j = await apiJson(`${API}/lines/${id}`); setD(j); const l = j.line; setF((x) => ({ ...x, category: l.category && CAT[l.category] ? l.category : '', party_id: l.target_kind === 'CUSTOMER' || l.target_kind === 'VENDOR' || l.target_kind === 'DRIVER' ? (l.target_id ?? '') : '', party_name: ['CUSTOMER', 'OWNER', 'VENDOR', 'DRIVER'].includes(l.target_kind) ? (l.target_label ?? '') : '', bill_id: ['CUSTOMER_BILL', 'OWNER_BILL'].includes(l.target_kind) ? (l.target_id ?? '') : '' })); } catch (e) { setErr(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  const l = d?.line; const isCredit = l && n2(l.credit) > 0;
  const act = async (decision) => {
    setBusy(true); setErr('');
    try { const r = await apiJson(`${API}/lines/${id}/link`, { method: 'POST', body: JSON.stringify(decision) }); await onChanged?.(); if (r.rule) alert(`📐 Rule saved: "${r.rule.match_text}" → ${r.rule.category}${r.rule.auto ? ' (auto next time)' : ' (suggested next time)'}`); onClose(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const submit = () => {
    const c = f.category; if (!c) return setErr('Choose what this line is.');
    const dec = { category: c, remember: f.remember, auto_next_time: f.auto_next_time, note: f.note || null };
    if (c === 'CUSTOMER_RECEIPT') { const b = d.customer_bills.find((x) => x.id === f.bill_id); const name = b?.customer_name || f.party_name; if (!name) return setErr('Choose the customer (or a bill).'); Object.assign(dec, { party_kind: 'CUSTOMER', party_id: b?.customer_id ?? f.party_id ?? null, party_name: name, bill_id: f.bill_id || null }); }
    else if (c === 'OWNER_PAYMENT') { const b = d.owner_bills.find((x) => x.id === f.bill_id); const name = b?.owner_name || f.party_name; if (!name) return setErr('Choose the owner (or a bill).'); Object.assign(dec, { party_kind: 'OWNER', party_name: name, bill_id: f.bill_id || null }); }
    else if (c === 'VENDOR_PAYMENT') { const v = d.vendors.find((x) => x.id === f.party_id); if (!v && !f.party_name) return setErr('Choose the vendor.'); Object.assign(dec, { party_kind: 'VENDOR', party_id: v?.id ?? null, party_name: v?.vendor_name ?? f.party_name }); }
    else if (c === 'DRIVER_ADVANCE') { const v = d.drivers.find((x) => x.id === f.party_id); if (!v) return setErr('Choose the driver.'); Object.assign(dec, { party_kind: 'DRIVER', party_id: v.id, party_name: v.name, trip_id: f.trip_id || null }); }
    else if (c === 'LOAN_EMI') { const ln = d.loans.find((x) => x.id === f.party_id); if (!ln && !f.ledger_name) return setErr('Choose the loan.'); Object.assign(dec, { party_kind: 'LOAN', party_id: ln?.id ?? null, ledger_name: f.ledger_name || ln?.financier_ledger || `Loan: ${ln.bank_name} (${ln.vehicle_no})` }); }
    else if (c === 'INTER_FIRM') { if (!f.other_firm) return setErr('Which firm?'); Object.assign(dec, { party_kind: 'FIRM', other_firm: f.other_firm, other_ledger: f.other_ledger || null, party_name: f.other_firm }); }
    else if (['FASTAG_RECHARGE', 'FLEET_CARD_LOAD', 'CASH', 'LEDGER'].includes(c)) { if (!f.ledger_name && c !== 'CASH') return setErr('Choose the ledger.'); Object.assign(dec, { party_kind: 'LEDGER', ledger_name: f.ledger_name || 'Cash in Hand (HQ)' }); }
    else if (c === 'BOOK_ENTRY') { if (!f.book_entry_id) return setErr('Choose the book entry.'); Object.assign(dec, { book_entry_id: Number(f.book_entry_id), remember: false }); }
    act(dec);
  };
  const sel = { ...inp, width: '100%' };
  const Row = ({ k, children }) => (<div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '140px 1fr', gap: '8px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1b2a4e' }}><span style={{ fontSize: '10.5px', color: C.dim, textTransform: 'uppercase', letterSpacing: '.08em' }}>{k}</span><div>{children}</div></div>);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,.84)', zIndex: 900, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: isPhone ? '6px' : '20px 12px', overflowY: 'auto', backdropFilter: 'blur(3px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1100px, 100%)', background: '#0d1530', border: `1px solid ${C.line}`, borderTop: `3px solid ${C.cust}`, borderRadius: '14px', padding: isPhone ? '12px' : '18px 22px' }}>
        {!l ? <p style={{ color: C.mut }}>{err || 'Loading…'}</p> : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div><div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>Bank line · {l.ledger_name} · {(l.company_name ?? '').replace(/^M\/S\s+/i, '')}</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: C.ink }}>{dmy(l.txn_date)} · {isCredit ? <span style={{ color: C.good }}>+{inr2(l.credit)}</span> : <span style={{ color: C.crit }}>−{inr2(l.debit)}</span>} · {l.counterparty || '—'}</div>
              <div style={{ fontSize: '12px', color: C.mut, marginTop: '2px' }}>{l.description}{l.utr ? <> · UTR <span style={{ fontFamily: 'monospace', color: C.cust }}>{l.utr}</span></> : null} · balance {inr2(l.balance)}</div>
              <div style={{ marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}><Pill s={l.status} /><Chip c={l.category} /><span style={{ fontSize: '11px', color: C.dim }}>{l.why}</span>{l.target_label && <span style={{ fontSize: '11px', color: C.ink2 }}>→ {l.target_label}</span>}</div>
            </div>
            <button onClick={onClose} style={btn('plain')}>✕ Close</button>
          </div>
          {err && <div style={{ color: C.crit, fontSize: '12.5px', marginTop: '8px' }}>{err}</div>}
          {['AUTO_POSTED', 'LINKED'].includes(l.status) ? (
            <div style={{ marginTop: '12px', fontSize: '12.5px', color: C.ink2 }}>This line is {l.status === 'AUTO_POSTED' ? 'posted' : 'linked'}{l.voucher_id ? ` (voucher ${String(l.voucher_id).slice(0, 8)}…)` : ''} by {l.linked_by} on {day(l.linked_at)}. To change it, reverse the voucher from the legacy book and re-tally.
              <div style={{ marginTop: '10px' }}><button onClick={() => act({ category: 'PARK', note: 'parked after posting for review' })} disabled={busy} style={btn('warn', !busy)}>Park for review</button></div></div>
          ) : (<>
            <Row k="This is a">
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {[isCredit ? 'CUSTOMER_RECEIPT' : 'OWNER_PAYMENT', isCredit ? null : 'VENDOR_PAYMENT', isCredit ? null : 'DRIVER_ADVANCE', isCredit ? null : 'LOAN_EMI', 'INTER_FIRM', isCredit ? 'BANK_INTEREST' : 'BANK_CHARGE', isCredit ? null : 'FASTAG_RECHARGE', isCredit ? null : 'FLEET_CARD_LOAD', 'CASH', 'LEDGER', 'BOOK_ENTRY'].filter(Boolean).map((c) => (
                  <span key={c} onClick={() => setF({ ...f, category: c })} style={chip(f.category === c)}>{c === 'BOOK_ENTRY' ? 'Already in the book' : (CAT[c]?.[0] ?? c)}</span>))}
              </div>
            </Row>
            {f.category === 'CUSTOMER_RECEIPT' && (<>
              <Row k="Open bill"><select value={f.bill_id} onChange={(e) => setF({ ...f, bill_id: e.target.value })} style={sel}><option value="">— on account (no bill) —</option>{d.customer_bills.map((b) => <option key={b.id} value={b.id}>{b.bill_no} · {b.customer_name} · balance {inr(b.balance)} · {b.company_name ?? ''}</option>)}</select></Row>
              {!f.bill_id && <Row k="Customer"><input value={f.party_name} onChange={(e) => setF({ ...f, party_name: e.target.value })} placeholder="Customer name as in the master" style={sel} /></Row>}
            </>)}
            {f.category === 'OWNER_PAYMENT' && (<>
              <Row k="Approved bill"><select value={f.bill_id} onChange={(e) => setF({ ...f, bill_id: e.target.value })} style={sel}><option value="">— on account (no bill) —</option>{d.owner_bills.map((b) => <option key={b.id} value={b.id}>{b.bill_no} · {b.owner_name} · payable {inr(b.payable)}</option>)}</select></Row>
              {!f.bill_id && <Row k="Owner"><input value={f.party_name} onChange={(e) => setF({ ...f, party_name: e.target.value })} placeholder="Owner name as in the vehicle master" style={sel} /></Row>}
            </>)}
            {f.category === 'VENDOR_PAYMENT' && <Row k="Vendor"><select value={f.party_id} onChange={(e) => setF({ ...f, party_id: e.target.value })} style={sel}><option value="">— choose —</option>{d.vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}{v.vendor_kind ? ` · ${v.vendor_kind}` : ''}</option>)}</select></Row>}
            {f.category === 'DRIVER_ADVANCE' && (<>
              <Row k="Driver"><select value={f.party_id} onChange={(e) => setF({ ...f, party_id: e.target.value, trip_id: '' })} style={sel}><option value="">— choose —</option>{d.drivers.map((v) => <option key={v.id} value={v.id}>{v.name}{v.mobile ? ` · ${v.mobile}` : ''}</option>)}</select></Row>
              <Row k="Trip"><select value={f.trip_id} onChange={(e) => setF({ ...f, trip_id: e.target.value })} style={sel}><option value="">— no trip —</option>{(d.drivers.find((v) => v.id === f.party_id)?.trips ?? []).map((t) => <option key={t.id} value={t.id}>{t.trip_code} · {t.vehicle_no} · {day(t.loading_date)} · {t.status}</option>)}</select></Row>
            </>)}
            {f.category === 'LOAN_EMI' && <Row k="Loan"><select value={f.party_id} onChange={(e) => setF({ ...f, party_id: e.target.value })} style={sel}><option value="">— choose —</option>{d.loans.map((v) => <option key={v.id} value={v.id}>{v.bank_name} · {v.vehicle_no} · EMI {inr(v.emi_amount)} · {v.company_name ?? ''}</option>)}</select></Row>}
            {f.category === 'INTER_FIRM' && (<>
              <Row k="Other firm"><select value={f.other_firm} onChange={(e) => setF({ ...f, other_firm: e.target.value })} style={sel}><option value="">— choose —</option>{d.firms.map((x) => <option key={x} value={x}>{x}</option>)}</select></Row>
              <Row k="Own account"><select value={f.other_ledger} onChange={(e) => setF({ ...f, other_ledger: e.target.value })} style={sel}><option value="">— only for a transfer within the same firm —</option>{d.accounts.filter((a) => a.ledger_name !== l.ledger_name).map((a) => <option key={a.id} value={a.ledger_name}>{a.ledger_name} · {a.company_name}</option>)}</select></Row>
            </>)}
            {['FASTAG_RECHARGE', 'FLEET_CARD_LOAD', 'CASH', 'LEDGER'].includes(f.category) && <Row k="Ledger"><select value={f.ledger_name} onChange={(e) => setF({ ...f, ledger_name: e.target.value })} style={sel}><option value="">{f.category === 'CASH' ? 'Cash in Hand (HQ)' : '— choose —'}</option>{d.ledgers.map((x) => <option key={x.ledger_name} value={x.ledger_name}>{x.ledger_name} · {x.group_head}</option>)}</select></Row>}
            {f.category === 'BOOK_ENTRY' && <Row k="Book entry"><select value={f.book_entry_id} onChange={(e) => setF({ ...f, book_entry_id: e.target.value })} style={sel}><option value="">— choose (same amount, ±45 days) —</option>{d.book_entries.map((e) => <option key={e.id} value={e.id}>{day(e.entry_date)} · {inr2(e.amount)} · {e.source_type} {e.source_ref ?? ''} · {(e.particulars ?? '').slice(0, 40)}</option>)}</select></Row>}
            <Row k="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={sel} placeholder="optional" /></Row>
            <Row k="Remember"><label style={{ fontSize: '12px', color: C.ink2 }}><input type="checkbox" checked={f.remember} onChange={(e) => setF({ ...f, remember: e.target.checked })} /> Next time "{l.counterparty || 'this counterparty'}" appears, suggest the same</label>
              {f.remember && !['CUSTOMER_RECEIPT', 'OWNER_PAYMENT', 'VENDOR_PAYMENT', 'DRIVER_ADVANCE', 'LOAN_EMI', 'BOOK_ENTRY'].includes(f.category) && <label style={{ fontSize: '12px', color: C.ink2, marginLeft: '14px' }}><input type="checkbox" checked={f.auto_next_time} onChange={(e) => setF({ ...f, auto_next_time: e.target.checked })} /> …and post it without asking</label>}</Row>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
              <button onClick={submit} disabled={busy} style={btn('solid', !busy)}>✅ Link &amp; post</button>
              <button onClick={() => act({ category: 'PARK', note: f.note || 'parked' })} disabled={busy} style={btn('warn', !busy)}>Park</button>
              <button onClick={() => act({ category: 'NOT_OURS', note: f.note || null, remember: f.remember })} disabled={busy} style={btn('plain', !busy)}>Not ours</button>
              <button onClick={() => act({ category: 'IGNORE', note: f.note || null })} disabled={busy} style={btn('plain', !busy)}>Ignore</button>
            </div>
            <div style={{ color: C.dim, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>Nothing reaches the ledger until you press Link &amp; post. A customer receipt linked to a bill is spread over that bill's trips; an owner payment linked to a bill marks it paid; a driver advance is recorded on the trip; a payment to a vendor is recorded on the vendor. Money between our firms posts as capital (owner's rule, 5-Sep).</div>
          </>)}
        </>)}
      </div>
    </div>
  );
}

function Flagged({ account }) {
  const [d, setD] = useState(null);
  useEffect(() => { apiJson(`${API}/book-unmatched${account ? `?account=${account}` : ''}`).then(setD).catch((e) => setD({ error: e.message })); }, [account]);
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  return (
    <div>
      <div style={{ color: C.mut, fontSize: '12.5px', marginBottom: '8px' }}>Book entries on a bank ledger that no statement line accounts for — assumed receipts, schedule-posted EMIs, historical wallet loads. Flagged only (owner's decision, 5-Sep); reverse from the legacy book if a person decides so.</div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>{(d.by_source ?? []).map((b, i) => <span key={i} style={{ ...chip(false), cursor: 'default' }}>{b.ledger_name} · {b.source_type} · {b.n} · {inr(b.amount)}</span>)}</div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}><table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
        <thead><tr><th style={th}>Date</th><th style={th}>Ledger</th><th style={th}>Side</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Source · ref</th><th style={th}>Particulars</th></tr></thead>
        <tbody>{(d.rows ?? []).map((r) => (<tr key={r.entry_id}><td style={td}>{dmy(r.entry_date)}</td><td style={td}>{r.ledger_name}</td><td style={td}>{r.side}</td><td style={tdR}>{inr2(r.amount)}</td><td style={td}>{r.source_type} <span style={{ color: C.dim }}>{r.source_ref}</span></td><td style={{ ...td, whiteSpace: 'normal' }}>{(r.particulars ?? '').slice(0, 90)}</td></tr>))}</tbody></table></div>
    </div>
  );
}

function Rules() {
  const [d, setD] = useState(null);
  const load = useCallback(() => apiJson(`${API}/rules`).then(setD).catch((e) => setD({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const del = async (id) => { if (!window.confirm('Delete this rule? TARA will ask again next time.')) return; try { await apiJson(`${API}/rules/${id}`, { method: 'DELETE' }); load(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only' : e.message}`); } };
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}><table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
      <thead><tr><th style={th}>When the line says</th><th style={th}>Direction</th><th style={th}>Account</th><th style={th}>Post as</th><th style={th}>Party / ledger</th><th style={th}>Auto</th><th style={{ ...th, textAlign: 'right' }}>Hits</th><th style={th}>Taught by</th><th style={th}></th></tr></thead>
      <tbody>{(d.rules ?? []).length === 0 && <tr><td colSpan={9} style={{ ...td, color: C.dim, textAlign: 'center' }}>No rules yet — every decision on the desk with "Remember" ticked lands here.</td></tr>}
        {(d.rules ?? []).map((r) => (<tr key={r.id}><td style={td}><span style={{ color: C.dim, fontSize: '10.5px' }}>{r.match_kind}</span> <b style={{ color: C.ink }}>{r.match_text}</b></td><td style={td}>{r.direction}</td><td style={td}>{r.ledger_name ?? 'all'}</td><td style={td}><Chip c={r.category} /></td><td style={td}>{r.party_name ?? r.ledger_name ?? '—'}</td><td style={td}>{r.auto ? <span style={{ color: C.good }}>posts</span> : <span style={{ color: C.warn }}>suggests</span>}</td><td style={tdR}>{r.hits}</td><td style={td}>{r.created_by} · {day(r.created_at)}</td><td style={td}><button onClick={() => del(r.id)} style={{ ...btn('crit'), padding: '2px 8px' }}>×</button></td></tr>))}
      </tbody></table></div>
  );
}
