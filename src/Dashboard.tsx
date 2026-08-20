// src/Dashboard.tsx — Master Finance Hub
// ─────────────────────────────────────────────────────────────────────────────
// Reads PostgreSQL only, through /api/v1/finance/dashboard.
//
// The previous version pulled seven Firestore collections and summed them in
// the browser. After the backend moved to Postgres those collections stopped
// being the source of truth, so the screen kept reporting ₹8.39 L of revenue
// while the ledger held ₹1.42 Cr — not a rounding error, a different database.
// Client-side aggregation was the deeper fault: totals belong next to the data,
// derived from the same ledger the books are closed from, not re-derived from
// documents by whichever screen happens to be open.
//
// Every figure here is voucher-era double entry. Legacy migrated rows are
// deliberately excluded from the P&L and surfaced separately under Ledger
// health, because they predate double entry and blending them would misstate
// the accounts.
//
// The old file is kept as Dashboard.firestore.bak.tsx until the remaining
// Firestore screens are migrated.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import SecurityRadar from './SecurityRadar';
import ActionRequired from './components/ActionRequired';
import ConnectedApps from './components/ConnectedApps';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const REFRESH_MS = 60_000;

interface DashboardProps {
  activeModule: string;
  currentUser?: any;
}

type Kpi = {
  revenue: number; expenses: number; net_profit: number;
  receivable: number; payable: number; cash_and_bank: number;
};
type Snapshot = {
  generated_at: string;
  source: string;
  kpi: Kpi;
  pl_groups: { group_head: string; account_type: string; amount: string }[];
  accounts: { ledger_name: string; group_head: string; balance: string }[];
  top_debtors: { ledger_name: string; balance: string }[];
  top_creditors: { ledger_name: string; balance: string }[];
  trend: { month: string; income: string; expense: string }[];
  operations: Record<string, any>;
  health: Record<string, string>;
};

// ── Formatting ───────────────────────────────────────────────────────────────
// Indian grouping throughout; compact only where space forces it, and never in
// a figure someone might key into a return.
const n = (v: any) => Number(v ?? 0);
const inr = (v: any) =>
  '₹' + n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (v: any) => {
  const x = Math.abs(n(v));
  const sign = n(v) < 0 ? '-' : '';
  if (x >= 1e7) return `${sign}₹${(x / 1e7).toFixed(2)} Cr`;
  if (x >= 1e5) return `${sign}₹${(x / 1e5).toFixed(2)} L`;
  return sign + '₹' + x.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
};

const C = {
  bg: '#0f172a', card: '#1e293b', line: '#334155',
  text: '#e2e8f0', dim: '#94a3b8', faint: '#64748b',
  emerald: '#10b981', ruby: '#ef4444', amber: '#f59e0b',
  violet: '#8b5cf6', sky: '#38bdf8',
};

const card: React.CSSProperties = {
  background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18,
};

// activeModule is still part of DashboardProps (App.tsx passes it) but this
// screen renders the same books whichever module is selected, so it is not
// destructured here.
export default function Dashboard({ currentUser }: DashboardProps) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/v1/finance/dashboard?months=6`, { signal });
      if (!res.ok) {
        // A 503 here means the database is unreachable. Say so — the old screen
        // fell back to zeros, which is indistinguishable from a company that
        // earned nothing.
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error === 'DB_UNAVAILABLE'
          ? 'Database unreachable — figures cannot be shown.'
          : `API responded ${res.status}`);
      }
      setData(await res.json());
      setErr(null);
      setFetchedAt(new Date());
      setLoading(false);
    } catch (e: any) {
      // An aborted request has been SUPERSEDED, not failed — its replacement is
      // already in flight. Clearing `loading` here (as the old `finally` did)
      // left loading=false, err=null and data=null all at once, which slipped
      // past both guards below and white-screened the hub on `data!.kpi`.
      // React StrictMode reproduces it on every dev mount; in production any
      // quick navigate-away-and-back does.
      if (e?.name === 'AbortError') return;
      setErr(e?.message ?? 'Could not reach the finance API');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    const t = setInterval(() => load(), REFRESH_MS);
    return () => { ac.abort(); clearInterval(t); };
  }, [load]);

  const health = data?.health;
  const healthFailures = useMemo(() => {
    if (!health) return [];
    return Object.entries(health)
      .filter(([k, v]) => k !== 'merged_aliases' && Number(v) !== 0)
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  }, [health]);

  const trendMax = useMemo(() => {
    if (!data?.trend?.length) return 1;
    return Math.max(1, ...data.trend.flatMap((t) => [Math.abs(n(t.income)), Math.abs(n(t.expense))]));
  }, [data]);

  // ── States ─────────────────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div style={{ padding: 40, color: C.dim, fontFamily: 'system-ui' }}>
        Loading finance data from PostgreSQL…
      </div>
    );
  }

  if (err && !data) {
    return (
      <div style={{ padding: 28, fontFamily: 'system-ui' }}>
        <div style={{ ...card, borderLeft: `4px solid ${C.ruby}`, maxWidth: 620 }}>
          <h3 style={{ margin: '0 0 8px', color: C.ruby }}>Finance data unavailable</h3>
          <p style={{ margin: '0 0 12px', color: C.dim, lineHeight: 1.6 }}>{err}</p>
          <p style={{ margin: '0 0 14px', color: C.faint, fontSize: 13 }}>
            The hub reads <code>{API}/api/v1/finance/dashboard</code>. Check that the ERP API is
            running (<code>node server/index.js</code>) and that PostgreSQL is reachable.
          </p>
          <button onClick={() => { setLoading(true); load(); }}
            style={{ background: C.sky, border: 'none', color: '#04263a', padding: '9px 16px',
                     borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Belt and braces: whatever state combination gets here, no render path may
  // dereference a null payload. A blank hub with a retry beats a white screen.
  if (!data) {
    return (
      <div style={{ padding: 40, color: C.dim, fontFamily: 'system-ui' }}>
        No finance data yet.{' '}
        <button onClick={() => { setLoading(true); load(); }}
          style={{ background: 'transparent', border: `1px solid ${C.line}`, color: C.sky,
                   padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
  }

  const k = data.kpi;
  const ops = data.operations ?? {};

  return (
    <div style={{ padding: '20px 22px 60px', fontFamily: 'system-ui, -apple-system, sans-serif', color: C.text }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end',
                    justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 'clamp(22px,3vw,30px)', letterSpacing: '-0.02em' }}>
            Master Finance Hub
          </h1>
          <div style={{ color: C.emerald, fontSize: 13, marginTop: 4 }}>
            Live from PostgreSQL · double-entry ledger
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, color: C.faint, lineHeight: 1.7 }}>
          {fetchedAt && <>updated {fetchedAt.toLocaleTimeString('en-GB')}<br /></>}
          <span style={{ color: err ? C.amber : C.faint }}>
            {err ? `stale — ${err}` : `auto-refresh ${REFRESH_MS / 1000}s`}
          </span>
          <br />
          <button onClick={() => load()}
            style={{ marginTop: 6, background: 'transparent', border: `1px solid ${C.line}`,
                     color: C.dim, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
            Refresh now
          </button>
        </div>
      </div>

      {/* ── Staff pending tasks ────────────────────────────────────────── */}
      {/* Above the money on purpose. These are the rows that make the money
          wrong, and a board nobody scrolls to is the log it replaced. */}
      <ActionRequired />

      {/* ── Connected apps ─────────────────────────────────────────────── */}
      {/* Who is on the driver / customer / partner app right now, and what they
          are carrying. Admin-only server-side; renders a "restricted" note for
          anyone else rather than an error. */}
      <ConnectedApps />

      {/* ── Ledger health ──────────────────────────────────────────────── */}
      <div style={{ ...card, borderLeft: `4px solid ${healthFailures.length ? C.ruby : C.emerald}`,
                    marginBottom: 18, padding: '13px 16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <strong style={{ color: healthFailures.length ? C.ruby : C.emerald }}>
            {healthFailures.length ? 'Ledger health: attention needed' : 'Ledger health: balanced'}
          </strong>
          <span style={{ color: C.dim, fontSize: 13 }}>
            {healthFailures.length
              ? healthFailures.join(' · ')
              : `every voucher balances · imbalance ${inr(0)} · ${health?.merged_aliases ?? 0} duplicate parties merged`}
          </span>
        </div>
      </div>

      {/* ── KPI row ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))',
                    gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Revenue (posted)', value: k.revenue, colour: C.emerald,
            note: 'Freight income in the ledger' },
          { label: 'Expenses (posted)', value: k.expenses, colour: C.ruby,
            note: k.expenses === 0 ? 'no expense vouchers posted yet' : 'direct + indirect' },
          { label: 'Net Profit', value: k.net_profit, colour: k.net_profit >= 0 ? C.emerald : C.ruby,
            note: 'Revenue − Expenses' },
          { label: 'Receivable', value: k.receivable, colour: C.amber,
            note: k.receivable < 0 ? 'net credit — we owe the customer' : 'owed by customers' },
          { label: 'Payable', value: k.payable, colour: '#ec4899', note: 'owed to vendors' },
          { label: 'Cash & Bank', value: k.cash_and_bank, colour: C.violet, note: 'live ledger balance' },
        ].map((t) => (
          <div key={t.label} style={{ ...card, borderLeft: `5px solid ${t.colour}` }}>
            <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: C.faint }}>
              {t.label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: t.colour, marginTop: 6,
                          fontVariantNumeric: 'tabular-nums' }}>
              {compact(t.value)}
            </div>
            <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>{t.note}</div>
          </div>
        ))}
      </div>

      {/* ── Trend + accounts ───────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)',
                    gap: 16, marginBottom: 20 }}>
        <div style={card}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>Income vs Expense — last 6 months</h3>
          {data!.trend.length === 0 ? (
            <p style={{ color: C.faint, margin: 0 }}>No postings in this window.</p>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 190, overflowX: 'auto' }}>
              {data!.trend.map((t) => {
                const inc = n(t.income), exp = n(t.expense);
                return (
                  <div key={t.month} style={{ flex: '1 0 62px', display: 'flex', flexDirection: 'column',
                                              alignItems: 'center', gap: 6 }}>
                    <div style={{ fontSize: 10.5, color: C.emerald, fontVariantNumeric: 'tabular-nums' }}>
                      {compact(inc)}
                    </div>
                    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 120 }}>
                      <div title={`Income ${inr(inc)}`}
                           style={{ width: 18, background: C.emerald, borderRadius: '3px 3px 0 0',
                                    height: `${Math.max(2, (Math.abs(inc) / trendMax) * 118)}px` }} />
                      <div title={`Expense ${inr(exp)}`}
                           style={{ width: 18, background: C.ruby, borderRadius: '3px 3px 0 0',
                                    height: `${Math.max(2, (Math.abs(exp) / trendMax) * 118)}px` }} />
                    </div>
                    <div style={{ fontSize: 11, color: C.dim }}>{monthLabel(t.month)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={card}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Bank &amp; Cash</h3>
          {data!.accounts.map((a) => (
            <div key={a.ledger_name}
                 style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                          padding: '8px 0', borderBottom: `1px solid ${C.line}` }}>
              <span style={{ color: C.dim, fontSize: 13.5 }}>{a.ledger_name}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13.5,
                             color: n(a.balance) ? C.text : C.faint }}>{inr(a.balance)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Parties ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))',
                    gap: 16, marginBottom: 20 }}>
        {[
          { title: 'Receivable by customer', rows: data!.top_debtors, colour: C.amber },
          { title: 'Payable by vendor', rows: data!.top_creditors, colour: '#ec4899' },
        ].map((panel) => (
          <div key={panel.title} style={card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, color: panel.colour }}>{panel.title}</h3>
            {panel.rows.length === 0 ? (
              <p style={{ color: C.faint, margin: 0, fontSize: 13.5 }}>Nothing outstanding.</p>
            ) : panel.rows.map((r: any) => (
              <div key={r.ledger_name}
                   style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                            padding: '7px 0', borderBottom: `1px solid ${C.line}` }}>
                <span style={{ color: C.dim, fontSize: 13.5 }}>{r.ledger_name}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13.5 }}>{inr(r.balance)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* ── Operations ─────────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>Operations</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14 }}>
          {[
            ['Trips running', ops.trips_running],
            ['Trips unbilled', ops.trips_unbilled],
            ['Active vehicles', ops.vehicles_active],
            ['Active drivers', ops.drivers_active],
            ['Unreconciled loads', ops.unreconciled_loads],
            ['Unreconciled freight', compact(ops.unreconciled_freight)],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: C.faint }}>
                {label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 650, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                {value ?? '—'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── P&L breakdown ──────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Profit &amp; Loss by head</h3>
        {data!.pl_groups.length === 0 ? (
          <p style={{ color: C.faint, margin: 0 }}>No P&amp;L postings yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <tbody>
                {data!.pl_groups.map((g) => (
                  <tr key={g.group_head}>
                    <td style={{ padding: '8px 0', borderBottom: `1px solid ${C.line}`, color: C.dim }}>
                      {g.group_head}
                    </td>
                    <td style={{ padding: '8px 0', borderBottom: `1px solid ${C.line}`,
                                 textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 color: g.account_type === 'INCOME' ? C.emerald : C.ruby }}>
                      {inr(g.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {k.expenses === 0 && (
          <p style={{ color: C.amber, fontSize: 12.5, marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
            Expenses read zero because fuel, toll and driver costs are still held in their own
            tables and have not been posted to the ledger. Net profit above is therefore
            revenue only, not a result — treat it as such until those postings exist.
          </p>
        )}
      </div>

      {currentUser?.role === 'ADMIN' && <SecurityRadar />}
    </div>
  );
}
