// src/LedgerMgmt.tsx — Master Ledgers & Accounts
// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL only, via /api/v1/finance/ledgers.
//
// The previous version read Firestore and showed "Receivable: None" while the
// ledger held ₹1.75 Cr in the bank and a live IOCL balance — it was reporting a
// database the backend had already moved off. Balances are now computed in SQL
// (opening + ΣDr − ΣCr, resolved through ledger_aliases so one party with two
// spellings appears once) rather than summed in the browser.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';

type Ledger = {
  ledger_name: string; group_head: string; company: string | null; branch: string | null;
  opening_balance: string; total_dr: string; total_cr: string; balance: string;
  entries: number; last_entry: string | null;
};
type Entry = {
  entry_date: string; particulars: string | null; dr_cr: 'DR' | 'CR';
  amount: string; source_type: string | null; source_ref: string | null;
};

const C = {
  card: '#1e293b', line: '#334155', text: '#e2e8f0', dim: '#94a3b8', faint: '#64748b',
  emerald: '#10b981', ruby: '#ef4444', amber: '#f59e0b', sky: '#38bdf8',
};
const n = (v: any) => Number(v ?? 0);
const inr = (v: any) =>
  '₹' + Math.abs(n(v)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// A ledger balance is meaningless without its side; Dr/Cr is shown, never a
// bare signed number that the reader has to interpret.
const side = (v: any) => (n(v) >= 0 ? 'Dr' : 'Cr');

const card: React.CSSProperties = {
  background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16,
};

export default function LedgerMgmt() {
  const [rows, setRows] = useState<Ledger[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('ALL');
  const [open, setOpen] = useState<string | null>(null);
  const [stmt, setStmt] = useState<{ rows: Entry[]; closing: string } | null>(null);
  const [stmtLoading, setStmtLoading] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/v1/finance/ledgers?q=`, { signal });
      if (!res.ok) throw new Error(res.status === 503
        ? 'Database unreachable — balances cannot be shown.'
        : `API responded ${res.status}`);
      const body = await res.json();
      setRows(body.data ?? []);
      setErr(null);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? 'Could not reach the finance API');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const openStatement = useCallback(async (name: string) => {
    setOpen(name); setStmt(null); setStmtLoading(true);
    try {
      const res = await fetch(`${API}/api/v1/finance/ledgers/statement?name=${encodeURIComponent(name)}`);
      const body = await res.json();
      setStmt({ rows: body.entries ?? body.rows ?? [], closing: body.closing ?? body.balance ?? '0' });
    } catch {
      setStmt({ rows: [], closing: '0' });
    } finally { setStmtLoading(false); }
  }, []);

  const groups = useMemo(
    () => ['ALL', ...Array.from(new Set(rows.map((r) => r.group_head).filter(Boolean))).sort()],
    [rows]);

  const view = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) =>
      (group === 'ALL' || r.group_head === group) &&
      (!t || r.ledger_name.toLowerCase().includes(t) || (r.group_head ?? '').toLowerCase().includes(t)));
  }, [rows, q, group]);

  const totals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const r of view) (n(r.balance) >= 0 ? (dr += n(r.balance)) : (cr += -n(r.balance)));
    return { dr, cr };
  }, [view]);

  if (loading) return <div style={{ padding: 40, color: C.dim }}>Loading ledgers from PostgreSQL…</div>;

  if (err) return (
    <div style={{ padding: 28 }}>
      <div style={{ ...card, borderLeft: `4px solid ${C.ruby}`, maxWidth: 620 }}>
        <h3 style={{ margin: '0 0 8px', color: C.ruby }}>Ledgers unavailable</h3>
        <p style={{ color: C.dim, lineHeight: 1.6 }}>{err}</p>
        <p style={{ color: C.faint, fontSize: 13 }}>
          Reads <code>{API}/api/v1/finance/ledgers</code>.
        </p>
        <button onClick={() => { setLoading(true); load(); }}
          style={{ background: C.sky, border: 'none', color: '#04263a', padding: '9px 16px',
                   borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>Retry</button>
      </div>
    </div>
  );

  return (
    <div style={{ padding: '20px 22px 60px', color: C.text, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ margin: 0, fontSize: 'clamp(21px,3vw,28px)' }}>⚖️ Master Ledgers &amp; Accounts</h1>
      <div style={{ color: C.emerald, fontSize: 13, marginTop: 4, marginBottom: 18 }}>
        Live from PostgreSQL · {rows.length} ledgers · balances resolved through party aliases
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ledger or group…"
          style={{ flex: '1 1 260px', padding: '9px 12px', borderRadius: 8, background: C.card,
                   border: `1px solid ${C.line}`, color: C.text, font: 'inherit' }} />
        <select value={group} onChange={(e) => setGroup(e.target.value)}
          style={{ padding: '9px 12px', borderRadius: 8, background: C.card,
                   border: `1px solid ${C.line}`, color: C.text, font: 'inherit' }}>
          {groups.map((g) => <option key={g} value={g}>{g === 'ALL' ? '— All groups —' : g}</option>)}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))',
                    gap: 12, marginBottom: 18 }}>
        <div style={{ ...card, borderLeft: `5px solid ${C.emerald}` }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.faint, letterSpacing: '.08em' }}>Total Debit</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.emerald, fontVariantNumeric: 'tabular-nums' }}>{inr(totals.dr)}</div>
        </div>
        <div style={{ ...card, borderLeft: `5px solid ${C.amber}` }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.faint, letterSpacing: '.08em' }}>Total Credit</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.amber, fontVariantNumeric: 'tabular-nums' }}>{inr(totals.cr)}</div>
        </div>
        <div style={{ ...card, borderLeft: `5px solid ${C.sky}` }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.faint, letterSpacing: '.08em' }}>Ledgers shown</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.sky, fontVariantNumeric: 'tabular-nums' }}>{view.length}</div>
        </div>
      </div>

      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr>
              {['Ledger', 'Group', 'Entries', 'Debit', 'Credit', 'Balance'].map((h, i) => (
                <th key={h} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '11px 14px',
                                     borderBottom: `1px solid ${C.line}`, color: C.faint,
                                     fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em',
                                     whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 28, textAlign: 'center', color: C.faint }}>
                No ledger matches that filter.</td></tr>
            )}
            {view.map((r) => (
              <tr key={r.ledger_name} onClick={() => openStatement(r.ledger_name)}
                  style={{ cursor: 'pointer' }}
                  title="Open statement">
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.line}` }}>{r.ledger_name}</td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.line}`, color: C.dim }}>{r.group_head}</td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.line}`, textAlign: 'right',
                             color: C.faint, fontVariantNumeric: 'tabular-nums' }}>{r.entries}</td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.line}`, textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}>{inr(r.total_dr)}</td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.line}`, textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}>{inr(r.total_cr)}</td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.line}`, textAlign: 'right',
                             fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                             color: n(r.balance) >= 0 ? C.emerald : C.amber }}>
                  {inr(r.balance)} <span style={{ color: C.faint, fontWeight: 400 }}>{side(r.balance)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <div onClick={() => setOpen(null)}
             style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,.75)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()}
               style={{ ...card, maxWidth: 900, width: '100%', maxHeight: '82vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <h3 style={{ margin: 0, color: C.sky }}>{open}</h3>
              <button onClick={() => setOpen(null)}
                style={{ background: 'transparent', border: `1px solid ${C.line}`, color: C.dim,
                         padding: '4px 12px', borderRadius: 6, cursor: 'pointer' }}>Close</button>
            </div>
            {stmtLoading ? <p style={{ color: C.dim }}>Loading statement…</p> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr>
                  {['Date', 'Particulars', 'Ref', 'Dr', 'Cr'].map((h, i) => (
                    <th key={h} style={{ textAlign: i >= 3 ? 'right' : 'left', padding: '8px 10px',
                                         borderBottom: `1px solid ${C.line}`, color: C.faint,
                                         fontSize: 11, textTransform: 'uppercase' }}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {(stmt?.rows ?? []).length === 0 && (
                    <tr><td colSpan={5} style={{ padding: 22, textAlign: 'center', color: C.faint }}>
                      No entries.</td></tr>)}
                  {(stmt?.rows ?? []).map((e, i) => (
                    <tr key={i}>
                      <td style={{ padding: '7px 10px', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' }}>{e.entry_date}</td>
                      <td style={{ padding: '7px 10px', borderBottom: `1px solid ${C.line}`, color: C.dim }}>{e.particulars}</td>
                      <td style={{ padding: '7px 10px', borderBottom: `1px solid ${C.line}`, color: C.faint, fontSize: 11.5 }}>{e.source_ref}</td>
                      <td style={{ padding: '7px 10px', borderBottom: `1px solid ${C.line}`, textAlign: 'right',
                                   fontVariantNumeric: 'tabular-nums', color: C.emerald }}>
                        {e.dr_cr === 'DR' ? inr(e.amount) : ''}</td>
                      <td style={{ padding: '7px 10px', borderBottom: `1px solid ${C.line}`, textAlign: 'right',
                                   fontVariantNumeric: 'tabular-nums', color: C.amber }}>
                        {e.dr_cr === 'CR' ? inr(e.amount) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
