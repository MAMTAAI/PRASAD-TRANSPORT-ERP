// @ts-nocheck
// ============================================================================
// MODULE 2 — MASTER FINANCE HUB (Executive Command)
// Top: Unbilled Freight · Freight Income · Pending Expenses · Fleet Card Wallet
// Middle: Finance & EMI Command · FASTag & Toll · Tally Sync · Sales/Revenue charts
// Bottom: Master Ledgers & Cash/Bank Book (Dr ₹2.96 Cr / Cr ₹2.95 Cr)
// ============================================================================
import React, { useEffect } from 'react';
import {
  Fuel, Banknote, ReceiptText, Wallet, Landmark, CarFront, RefreshCcw,
  PieChart as PieIcon, BarChart3, BookOpenText, Search, ArrowUpRight,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, Legend,
} from 'recharts';
import {
  GlassPanel, PanelHeader, StatusPill, Dot, ProgressBar, chartTooltipStyle, axisStyle,
} from './shared';
import { inr, inrFull } from './useDashboardData';

// ---------------------------------------------------------------------------
// MOCK DATA — matches the approved v5.0 design numbers exactly
// ---------------------------------------------------------------------------
const fleetCards = [
  { brand: 'BPCL', balance: '₹45L', tone: 'from-amber-500/20 to-yellow-500/5', border: 'border-amber-500/40', text: 'text-amber-300' },
  { brand: 'HPCL', balance: '₹35L', tone: 'from-blue-500/20 to-indigo-500/5', border: 'border-blue-500/40', text: 'text-blue-300' },
  { brand: 'IOCL', balance: '₹35L', tone: 'from-orange-500/20 to-red-500/5', border: 'border-orange-500/40', text: 'text-orange-300' },
];

const EMI_GRADIENTS = [
  'from-fuchsia-500 to-amber-400',
  'from-sky-500 to-cyan-400',
  'from-rose-500 to-orange-400',
  'from-emerald-500 to-teal-400',
];

const emiBanks = [
  { bank: 'Axis Bank', amount: '₹1.25 Cr', note: 'Next payment in 30–60 days', pct: 62, gradient: 'from-fuchsia-500 to-amber-400' },
  { bank: 'SBI', amount: '₹85 Lakhs', note: 'EMI progress on schedule', pct: 48, gradient: 'from-sky-500 to-cyan-400' },
  { bank: 'HDFC', amount: '₹42 Lakhs', note: 'EMI liabilities · ₹20 Lakhs cleared', pct: 34, gradient: 'from-rose-500 to-orange-400' },
];

const customerSales = [
  { name: 'IOCL Refinery', value: 60, color: '#22d3ee' },
  { name: 'Haldia Petrochem', value: 25, color: '#34d399' },
  { name: 'Others', value: 15, color: '#fbbf24' },
];

const monthlyRevenue = [
  { month: 'Jan', revenue: 21.4 }, { month: 'Feb', revenue: 24.8 }, { month: 'Mar', revenue: 22.6 },
  { month: 'Apr', revenue: 27.9 }, { month: 'May', revenue: 25.3 }, { month: 'Jun', revenue: 31.2 },
  { month: 'Jul', revenue: 34.6 },
];

const ledgerRows = [
  { name: 'SBI Bank', date: '13/03/2026', type: 'Bank', debit: '₹85.0 L', credit: '₹72.5 L', receipts: '₹1,240', payments: '₹980' },
  { name: 'HPCL (Fuel)', date: '22/03/2026', type: 'Fuel Card', debit: '₹20.0 L', credit: '₹19.6 L', receipts: '—', payments: '₹1,000' },
  { name: 'BPCL (Fuel)', date: '25/03/2026', type: 'Fuel Card', debit: '₹20.0 L', credit: '₹19.4 L', receipts: '—', payments: '₹2,000' },
  { name: 'Driver Cash', date: '24/03/2026', type: 'Cash', debit: '₹8.0 L', credit: '₹7.9 L', receipts: '₹800', payments: '₹650' },
  { name: 'Customer Payments', date: '21/03/2026', type: 'Receivable', debit: '₹1.63 Cr', credit: '₹1.76 Cr', receipts: '₹3,550', payments: '—' },
];

// ---------------------------------------------------------------------------
export default function FinanceDashboard({ live }) {
  // LIVE from GET /api/v1/dashboard/v5
  const fin = live?.data?.finance ?? null;
  const offline = !!live?.error;

  const bookRows = fin?.ledger_book ?? [];
  const bankRows = fin?.banks ?? [];
  const emi = fin?.emi ?? null;
  const toll = fin?.toll ?? null;
  const monthlyLive = fin?.monthly?.length ? fin.monthly : monthlyRevenue;
  const custLive = fin?.customers?.length
    ? (() => {
        const palette = ['#22d3ee', '#34d399', '#fbbf24', '#a78bfa', '#f472b6'];
        const total = fin.customers.reduce((s, c) => s + Number(c.value || 0), 0) || 1;
        return fin.customers.map((c, i) => ({
          name: c.name, value: Math.round((Number(c.value) / total) * 100), color: palette[i % palette.length],
        }));
      })()
    : customerSales;

  return (
    <div className="flex flex-col gap-4">

      {/* ══════════════ TOP ROW ══════════════ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">

        {/* Unbilled Freight — Cyan */}
        <GlassPanel className="p-4 border-cyan-500/30 shadow-[0_0_25px_rgba(34,211,238,0.10)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Unbilled Freight</p>
              <p className="mt-1 text-3xl font-black text-cyan-300">{fin ? `₹ ${inr(fin.unbilled_freight)}` : '--'}</p>
            </div>
            <span className="grid place-items-center w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/40 text-cyan-300"><Fuel size={20} /></span>
          </div>
          <div className="mt-3">
            <ProgressBar pct={fin && fin.freight_income ? Math.min(100, (fin.unbilled_freight / fin.freight_income) * 100) : 0} gradient="from-cyan-500 to-cyan-300" />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-500">
            <span>Raised but unbilled</span>
            <span className="text-cyan-400 font-bold">₹{fin ? inrFull(fin.unbilled_freight) : '--'}</span>
          </div>
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Share of total freight</span>
            <span className="text-cyan-400 font-bold">
              {fin && fin.freight_income ? `${((fin.unbilled_freight / fin.freight_income) * 100).toFixed(2)}%` : '--'}
            </span>
          </div>
        </GlassPanel>

        {/* Freight Income — Green */}
        <GlassPanel className="p-4 border-emerald-500/30 shadow-[0_0_25px_rgba(52,211,153,0.10)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Freight Income</p>
              <p className="mt-1 text-3xl font-black text-emerald-300">{fin ? `₹ ${inr(fin.freight_income)}` : '--'}</p>
            </div>
            <span className="grid place-items-center w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-emerald-300"><Banknote size={20} /></span>
          </div>
          <div className="mt-3">
            <ProgressBar pct={fin && fin.freight_income ? Math.min(100, (fin.received / fin.freight_income) * 100) : 0} gradient="from-emerald-500 to-emerald-300" />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-500">
            <span>Received</span><span className="text-emerald-400 font-bold">₹{fin ? inrFull(fin.received) : '--'}</span>
          </div>
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Outstanding</span>
            <span className="text-amber-400 font-bold">₹{fin ? inrFull(fin.freight_income - fin.received) : '--'}</span>
          </div>
        </GlassPanel>

        {/* Pending Expenses */}
        <GlassPanel className="p-4 border-slate-500/30">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Trip Expenses</p>
              <p className="mt-1 text-3xl font-black text-slate-100">{fin ? `₹ ${inr(fin.total_expense)}` : '--'}</p>
            </div>
            <span className="grid place-items-center w-10 h-10 rounded-xl bg-white/5 border border-slate-600/40 text-slate-300"><ReceiptText size={20} /></span>
          </div>
          <div className="mt-3">
            <ProgressBar pct={fin && fin.freight_income ? Math.min(100, (fin.total_expense / fin.freight_income) * 100) : 0} gradient="from-slate-400 to-slate-200" />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-500">
            <span>TDS deducted</span><span className="text-slate-300 font-bold">₹{fin ? inrFull(fin.tds) : '--'}</span>
          </div>
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Expense vs freight</span>
            <span className="text-slate-300 font-bold">
              {fin && fin.freight_income ? `${((fin.total_expense / fin.freight_income) * 100).toFixed(1)}%` : '--'}
            </span>
          </div>
        </GlassPanel>

        {/* Fleet Card Wallet Balance */}
        <GlassPanel className="p-4 border-amber-500/40 shadow-[0_0_25px_rgba(251,191,36,0.10)]">
          <div className="flex items-center gap-2 mb-3">
            <span className="grid place-items-center w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300"><Wallet size={14} /></span>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Bank, Cash &amp; Wallets</p>
          </div>
          {bankRows.length === 0 ? (
            <p className="text-[11px] text-slate-500 py-3">
              {offline ? 'Live data unavailable.' : 'No bank / cash ledgers found.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto pr-1">
              {bankRows.map((b) => (
                <div key={b.name} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 border border-slate-700/50 px-2.5 py-1.5">
                  <span className="text-[10px] font-bold text-slate-300 truncate">{b.name}</span>
                  <span className={`text-[11px] font-black shrink-0 ${b.balance < 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                    ₹{inrFull(b.balance)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </GlassPanel>
      </div>

      {/* ══════════════ MIDDLE GRID ══════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">

        {/* Finance & EMI Command */}
        <GlassPanel className="xl:col-span-1 border-cyan-500/30">
          <PanelHeader
            icon={Landmark} title="Finance & EMI Command" accent="text-cyan-400"
            sub={emi ? `${emi.active_loans} active loans · ₹${inrFull(emi.total_monthly)}/month` : 'Bank Liabilities'}
          />
          <div className="px-4 pb-4 flex flex-col gap-3.5">
            {(!emi || emi.banks.length === 0) ? (
              <p className="text-[11px] text-slate-500 py-3">
                {offline ? 'Live data unavailable.' : 'No loans recorded in loan_master.'}
              </p>
            ) : (
              <>
                {emi.banks.map((b, i) => (
                  <div key={b.bank}>
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5 min-w-0">
                        <Dot color="bg-cyan-400" size="w-1.5 h-1.5" />
                        <span className="truncate">{b.bank}</span>
                        <span className="text-slate-600 shrink-0">({b.loans})</span>
                      </span>
                      <span className="text-[13px] font-black text-white shrink-0">₹{inr(b.outstanding)}</span>
                    </div>
                    <ProgressBar pct={b.pct} gradient={EMI_GRADIENTS[i % EMI_GRADIENTS.length]} />
                    <p className="mt-1 text-[9px] text-slate-500">
                      EMI ₹{inrFull(b.monthly_emi)}/month · {b.pct}% of tenure repaid
                    </p>
                  </div>
                ))}
                <div className="mt-1 pt-2 border-t border-slate-700/50 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Total outstanding</span>
                  <span className="text-[13px] font-black text-cyan-300">₹{inrFull(emi.total_outstanding)}</span>
                </div>
              </>
            )}
          </div>
        </GlassPanel>

        {/* FASTag & Toll Central */}
        <GlassPanel className="border-emerald-500/30">
          <PanelHeader
            icon={CarFront} title="FASTag & Toll Central" accent="text-emerald-400"
            sub={toll && toll.txns ? `${toll.txns.toLocaleString('en-IN')} toll crossings` : ''}
          />
          <div className="px-4 pb-4 flex flex-col gap-3">
            {(!toll || !toll.txns) ? (
              <p className="text-[11px] text-slate-500 py-3">
                {offline ? 'Live data unavailable.' : 'No toll transactions recorded.'}
              </p>
            ) : (
              <>
                <div>
                  <p className="text-[10px] font-semibold text-slate-500 uppercase">Toll Spent (all recorded)</p>
                  <p className="text-2xl font-black text-emerald-300">₹{inrFull(toll.spent_total)}</p>
                  {/* The mock showed a tag balance; fastag_accounts holds no
                      rows, so that number does not exist to show. Say so. */}
                  {!toll.balance_available && (
                    <p className="mt-1 text-[9px] text-slate-500 leading-relaxed">
                      Live tag balance not available — no FASTag account rows are synced yet.
                      These are the crossings actually charged.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-white/5 border border-slate-700/50 px-3 py-2">
                    <p className="text-[9px] font-semibold text-slate-500 uppercase">This Month</p>
                    <p className="text-base font-black text-slate-100">₹{inrFull(toll.this_month)}</p>
                  </div>
                  <div className="rounded-xl bg-white/5 border border-slate-700/50 px-3 py-2">
                    <p className="text-[9px] font-semibold text-slate-500 uppercase">Credits Loaded</p>
                    <p className="text-base font-black text-cyan-300">₹{inrFull(toll.credited)}</p>
                  </div>
                </div>
                {/* Unclaimed toll is money already spent that has not been
                    billed back to a customer — the number worth acting on. */}
                <div className={`rounded-xl px-3 py-2.5 border ${
                  toll.unclaimed > 0 ? 'bg-amber-500/10 border-amber-500/40' : 'bg-white/5 border-slate-700/50'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-amber-300">Unclaimed Toll</span>
                    <span className="text-base font-black text-amber-300">₹{inrFull(toll.unclaimed)}</span>
                  </div>
                  <ProgressBar
                    pct={toll.spent_total ? (toll.claimed / toll.spent_total) * 100 : 0}
                    gradient="from-emerald-500 to-teal-300"
                  />
                  <p className="mt-1 text-[9px] text-slate-500">
                    ₹{inrFull(toll.claimed)} claimed of ₹{inrFull(toll.spent_total)}
                    {toll.spent_total ? ` (${((toll.claimed / toll.spent_total) * 100).toFixed(1)}% recovered)` : ''}
                    {' '}— the rest is not yet billed to any customer.
                  </p>
                </div>
              </>
            )}
          </div>
        </GlassPanel>

        {/* Tally Prime Sync Status */}
        <GlassPanel className="border-emerald-500/40 shadow-[0_0_25px_rgba(52,211,153,0.08)]">
          <PanelHeader
            icon={RefreshCcw}
            title="Tally Prime Sync Status"
            accent="text-emerald-400"
            right={<span className="text-[10px] font-black italic text-slate-300">Tally · Port #9000</span>}
          />
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2.5 mb-3">
              <Dot color="bg-emerald-400" pulse size="w-3 h-3" />
              <span className="text-xl font-black text-emerald-300">Sync Active</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-white/5 border border-slate-700/50 px-2 py-2.5 text-center">
                <p className="text-sm font-black text-white">25,000</p>
                <p className="text-[8px] text-slate-500 uppercase">txs last sync</p>
              </div>
              <div className="rounded-xl bg-white/5 border border-slate-700/50 px-2 py-2.5 text-center">
                <p className="text-sm font-black text-white">25,000</p>
                <p className="text-[8px] text-slate-500 uppercase">txs synced</p>
              </div>
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/40 px-2 py-2.5 text-center">
                <p className="text-sm font-black text-emerald-300">100%</p>
                <p className="text-[8px] text-emerald-500/80 uppercase">Transactions</p>
              </div>
            </div>
          </div>
        </GlassPanel>

        {/* Customer Sales Donut */}
        <GlassPanel>
          <PanelHeader icon={PieIcon} title="Customer Sales Breakdown" accent="text-cyan-400" />
          <div className="px-2 pb-2 h-44 flex items-center">
            <div className="w-1/2 h-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={custLive} dataKey="value" nameKey="name"
                    innerRadius="55%" outerRadius="85%" paddingAngle={3} stroke="none"
                  >
                    {custLive.map((s) => <Cell key={s.name} fill={s.color} />)}
                  </Pie>
                  <Tooltip {...chartTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="w-1/2 flex flex-col gap-2 pr-3">
              {custLive.map((s) => (
                <div key={s.name} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[10px] text-slate-400 min-w-0">
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
                    <span className="truncate">{s.name}</span>
                  </span>
                  <span className="text-[11px] font-black text-slate-200">{s.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </GlassPanel>
      </div>

      {/* ══════════════ REVENUE CHART + LEDGER BOOK ══════════════ */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Monthly Revenue Breakdown */}
        <GlassPanel>
          <PanelHeader icon={BarChart3} title="Monthly Revenue Breakdown" accent="text-amber-400" sub="₹ in Lakhs" />
          <div className="px-2 pb-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyLive} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="rgba(51,65,85,0.25)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={axisStyle} axisLine={false} tickLine={false} />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} />
                <Tooltip {...chartTooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="revenue" name="Revenue (₹L)" radius={[6, 6, 0, 0]} fill="#22d3ee" maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </GlassPanel>

        {/* Master Ledgers & Cash/Bank Book */}
        <GlassPanel className="xl:col-span-2">
          <PanelHeader
            icon={BookOpenText}
            title="Master Ledgers & Cash/Bank Book"
            accent="text-emerald-400"
            right={
              <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-slate-950/60 border border-slate-700/50 px-2.5 py-1">
                <Search size={12} className="text-slate-500" />
                <input placeholder="Search…" className="w-24 bg-transparent text-[11px] text-slate-300 placeholder-slate-600 outline-none" />
              </div>
            }
          />
          <div className="px-4 pb-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700/50">
                  <th className="py-2 pr-3 font-bold">Ledger Name ▾</th>
                  <th className="py-2 pr-3 font-bold">Date</th>
                  <th className="py-2 pr-3 font-bold">Type</th>
                  <th className="py-2 pr-3 font-bold text-right">Total Debit (₹)</th>
                  <th className="py-2 pr-3 font-bold text-right">Total Credit (₹)</th>
                  <th className="py-2 pr-3 font-bold text-right">Receipts (₹)</th>
                  <th className="py-2 pr-3 font-bold text-right">Payments (₹)</th>
                  <th className="py-2 font-bold" />
                </tr>
              </thead>
              <tbody>
                {bookRows.length === 0 ? (
                  <tr><td colSpan={8} className="py-4 text-[11px] text-slate-500">
                    {offline ? 'Live data unavailable — API not reachable.' : 'No ledger entries found.'}
                  </td></tr>
                ) : bookRows.map((r) => (
                  <tr key={r.name} className="border-b border-slate-800/60 hover:bg-white/5 transition-colors">
                    <td className="py-2.5 pr-3 text-[12px] font-bold text-slate-100 whitespace-nowrap">{r.name}</td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-500 whitespace-nowrap">
                      {r.last_entry ? new Date(r.last_entry).toLocaleDateString('en-IN') : '-'}
                    </td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-400 whitespace-nowrap">{r.type || '-'}</td>
                    <td className="py-2.5 pr-3 text-[12px] font-bold text-slate-200 text-right whitespace-nowrap">₹{inrFull(r.debit)}</td>
                    <td className="py-2.5 pr-3 text-[12px] font-bold text-slate-200 text-right whitespace-nowrap">₹{inrFull(r.credit)}</td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-400 text-right whitespace-nowrap">
                      {inr(Math.abs(Number(r.debit) - Number(r.credit)))}
                    </td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-400 text-right whitespace-nowrap">
                      {Number(r.debit) >= Number(r.credit) ? 'Dr' : 'Cr'}
                    </td>
                    <td className="py-2.5 text-right">
                      <button className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[9px] font-black text-cyan-300 hover:bg-cyan-500/20 transition-colors whitespace-nowrap">
                        View Details <ArrowUpRight size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Book totals — exact figures from the design */}
          {/* Book totals come from the ledger itself; the balanced/unbalanced
              badge is v_accounting_health, the same view the house treats as
              the single source of truth for "do the books add up". */}
          <div className="mx-4 mb-4 mt-1 flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 rounded-xl bg-emerald-500/5 border border-emerald-500/30 px-4 py-2.5">
            <span className="text-[11px] font-black text-slate-300">
              Total Debit: <span className="text-emerald-300">₹{fin ? inrFull(fin.book_totals.debit) : '--'}</span>
            </span>
            <span className="hidden sm:inline text-slate-700">|</span>
            <span className="text-[11px] font-black text-slate-300">
              Total Credit: <span className="text-emerald-300">₹{fin ? inrFull(fin.book_totals.credit) : '--'}</span>
            </span>
            <span className="hidden sm:inline text-slate-700">|</span>
            <span className="text-[11px] font-bold text-slate-500">
              {fin ? `${fin.book_totals.vouchers} vouchers · ${fin.book_totals.entries} entries` : ''}
            </span>
            {fin?.health && (
              <StatusPill tone={Number(fin.health.total_imbalance) === 0 ? 'green' : 'red'}>
                {Number(fin.health.total_imbalance) === 0
                  ? 'BALANCED'
                  : `IMBALANCE ₹${inrFull(fin.health.total_imbalance)}`}
              </StatusPill>
            )}
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}
