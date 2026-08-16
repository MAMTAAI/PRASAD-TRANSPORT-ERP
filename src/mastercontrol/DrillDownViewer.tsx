// @ts-nocheck
// src/mastercontrol/DrillDownViewer.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The drawer behind every number on Master Control.
//
// It shows the rows the server used to compute the headline, because the server
// computes that headline BY COUNTING THESE ROWS (see lib/drilldownRegistry.js).
// The drawer is therefore not a second opinion about the number -- it is the
// number, itemised.
//
// THE HONESTY RULE HERE. When the row count and the card disagree, this says so
// in red rather than quietly showing whichever it fetched. A drill-down that
// papers over a mismatch is worse than none: it turns a wrong figure into an
// audited one.
//
// CSV IS THE WHOLE SET, NOT THE PAGE. The server streams every matching row for
// format=csv. Exporting only the 100 on screen is how somebody reconciles a
// page against a total of 3,883 and concludes the books are wrong.
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, ExternalLink, AlertTriangle, Loader2, Table2 } from 'lucide-react';
import { API_BASE } from '../lib/apiBase';
import { inrFull } from './useDashboardData';
import GlobalPagination, { DEFAULT_PAGE_SIZE } from '../components/GlobalPagination';

// SERVER-SIDE PAGING, not a slice of a downloaded array. finance.toll_spent is
// 3,883 rows; fetching all of them to show 20 would make the drawer slow in
// exactly the case pagination exists for. The control drives the API's OFFSET.

/** Column names are raw SQL identifiers; make them readable without a mapping table. */
const humanise = (c) =>
  String(c).replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\bId\b/, 'ID');

const MONEYISH = /(amount|freight|total|value|balance|principal|emi|spent|paid)/i;
const DATEISH = /(date|_at|expiry|ts)$/i;

function renderCell(col, v) {
  if (v === null || v === undefined || v === '') return <span className="text-slate-600">—</span>;
  if (DATEISH.test(col)) {
    const s = String(v);
    // Dates arrive as ISO; show the calendar day without dragging a tz library in.
    return <span className="tabular-nums">{s.length > 10 ? s.slice(0, 16).replace('T', ' ') : s}</span>;
  }
  if (MONEYISH.test(col) && !Number.isNaN(Number(v))) {
    return <span className="tabular-nums text-emerald-300">{inrFull(v)}</span>;
  }
  const s = String(v);
  return <span title={s.length > 60 ? s : undefined}>{s.length > 60 ? `${s.slice(0, 60)}…` : s}</span>;
}

export default function DrillDownViewer({ metric, expected = null, filterQs = '', onClose }) {
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [state, setState] = useState('loading');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const closeRef = useRef(null);

  const load = useCallback(async (p, n) => {
    setState('loading');
    try {
      const sep = filterQs ? '&' : '';
      const r = await fetch(
        `${API_BASE}/api/v1/dashboard/drilldown/${encodeURIComponent(metric)}?limit=${n}&offset=${(p - 1) * n}${sep}${filterQs}`,
        { headers: { Authorization: `Bearer ${localStorage.getItem('prasad_token') || ''}` } },
      );
      if (!r.ok) { setState('error'); return; }
      const j = await r.json();
      setData(j);
      setRows(j.rows);
      setState('ok');
    } catch { setState('error'); }
  }, [metric, filterQs]);

  useEffect(() => { load(page, size); }, [load, page, size]);
  // A different metric restarts at page 1; staying on page 7 of the last one
  // would open the drawer somewhere arbitrary in a set you have not seen.
  useEffect(() => { setPage(1); }, [metric]);

  // Escape closes, and focus lands on the close button so the drawer is usable
  // without a mouse.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const exportCsv = () => {
    const sep = filterQs ? '&' : '';
    // A plain navigation, so the browser's own download UI handles it and a
    // 3,883-row export never has to be held in a JS string first.
    window.open(
      `${API_BASE}/api/v1/dashboard/drilldown/${encodeURIComponent(metric)}?format=csv${sep}${filterQs}`,
      '_blank',
    );
  };

  const jump = (row) => {
    const link = data?.link;
    if (!link) return;
    window.dispatchEvent(new CustomEvent('pt:navigate', {
      detail: {
        module: link.module,
        screen: link.screen,
        focusId: row[link.idField] ?? null,
        focusLabel: row[link.labelField] ?? null,
      },
    }));
    onClose();
  };

  const total = data?.total ?? null;
  // The card's figure vs the rows behind it. Money compares on the measure,
  // counts on the row count.
  const mismatch =
    expected !== null && total !== null && data
      ? (data.money_total !== null
        ? Math.abs(Number(data.money_total) - Number(expected)) >= 0.005
        : Number(total) !== Number(expected))
      : false;

  const columns = data?.columns ?? [];
  const linkable = !!data?.link;

  return (
    <div className="fixed inset-0 z-[9000] flex justify-end" role="dialog" aria-modal="true">
      <button
        aria-label="Close drill-down"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
      />
      <aside
        className="relative flex h-full w-full max-w-[min(1180px,94vw)] flex-col border-l border-slate-700/60
                   bg-slate-950/95 shadow-2xl"
        style={{ animation: 'ptSlideIn .18s ease-out' }}
      >
        <style>{'@keyframes ptSlideIn{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}'}</style>

        {/* header */}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-cyan-400">
              <Table2 size={12} /> Drill-down · {data?.hub ?? ''}
            </p>
            <h2 className="mt-0.5 truncate text-lg font-black text-slate-100">
              {data?.label ?? metric}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {total === null ? 'loading…' : (
                <>
                  <span className="font-bold text-slate-200">{total.toLocaleString('en-IN')}</span> rows
                  {data?.money_total !== null && data?.money_total !== undefined && (
                    <> · <span className="font-bold text-emerald-300">₹{inrFull(data.money_total)}</span></>
                  )}
                  
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={exportCsv}
              disabled={!data || total === 0}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-600/50 bg-emerald-500/10 px-2.5 py-1.5
                         text-[10px] font-bold text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
            >
              <Download size={12} /> EXPORT CSV
            </button>
            <button
              ref={closeRef}
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors
                         hover:bg-white/10 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* The one thing this component must never hide. */}
        {mismatch && (
          <div className="flex shrink-0 items-start gap-2 border-b border-red-800/60 bg-red-950/50 px-4 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-[11px] leading-relaxed text-red-200">
              <b>These rows do not add up to the card.</b> The card showed{' '}
              <b>{typeof expected === 'number' ? expected.toLocaleString('en-IN') : String(expected)}</b>{' '}
              and this query returns{' '}
              <b>{data?.money_total !== null ? `₹${inrFull(data.money_total)}` : total?.toLocaleString('en-IN')}</b>.
              Trust neither until the difference is explained.
            </p>
          </div>
        )}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {state === 'loading' && (
            <div className="flex h-40 items-center justify-center gap-2 text-slate-500">
              <Loader2 size={16} className="animate-spin" /> <span className="text-[12px]">fetching rows…</span>
            </div>
          )}
          {state === 'error' && (
            <p className="px-4 py-10 text-center text-[12px] text-amber-400/90">
              Could not load the rows for this metric.
            </p>
          )}
          {state !== 'loading' && state !== 'error' && rows.length === 0 && (
            <p className="px-4 py-10 text-center text-[12px] text-slate-500">
              This metric matches no rows at all — the number on the card is a real zero.
            </p>
          )}

          {rows.length > 0 && (
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 z-10 bg-slate-900">
                <tr>
                  <th className="border-b border-slate-700 px-2 py-2 text-right font-black text-slate-500">#</th>
                  {columns.map((c) => (
                    <th key={c} className="whitespace-nowrap border-b border-slate-700 px-2 py-2 text-left
                                           font-black uppercase tracking-wider text-slate-400">
                      {humanise(c)}
                    </th>
                  ))}
                  {linkable && <th className="border-b border-slate-700 px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.id ?? i}
                    className={`border-b border-slate-800/60 transition-colors hover:bg-cyan-500/5
                                ${linkable ? 'cursor-pointer' : ''}`}
                    onClick={linkable ? () => jump(r) : undefined}
                  >
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{i + 1}</td>
                    {columns.map((c) => (
                      <td key={c} className="whitespace-nowrap px-2 py-1.5 text-slate-300">
                        {renderCell(c, r[c])}
                      </td>
                    ))}
                    {linkable && (
                      <td className="px-2 py-1.5">
                        <span className="flex items-center gap-1 text-[10px] font-bold text-cyan-400">
                          OPEN <ExternalLink size={10} />
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}


        </div>

        {total > 0 && (
          <GlobalPagination
            page={page}
            pages={Math.max(1, Math.ceil(total / size))}
            size={size}
            total={total}
            from={total === 0 ? 0 : (page - 1) * size + 1}
            to={Math.min(page * size, total)}
            onPage={setPage}
            onSize={(n) => { setSize(n); setPage(1); }}
            className="shrink-0 bg-slate-900/60"
          />
        )}

        <footer className="shrink-0 border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
          {linkable
            ? 'Click any row to open that record. Export sends the complete set, not this page.'
            : 'Export sends the complete set, not this page.'}
        </footer>
      </aside>
    </div>
  );
}
