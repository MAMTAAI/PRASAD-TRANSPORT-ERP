// @ts-nocheck
// src/components/GlobalPagination.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The one pagination control for the whole ERP, plus the hook that drives it.
//
// WHY A HOOK AND A COMPONENT RATHER THAN A <DataTable>. There is no base table
// in this codebase to inject a footer into -- 111 <table> elements across 45
// files, every one hand-rolled with its own columns, its own inline styles and
// its own filter state. A shared DataTable would mean rewriting all 45 screens
// against one column API, which is a far larger and riskier change than the one
// being asked for, and it would touch screens nobody has a reason to retest
// today. usePagination() slots into a screen in two lines and leaves its markup
// alone.
//
// WHAT THIS DOES AND DOES NOT PROTECT AGAINST. Slicing an array that is already
// in memory makes RENDERING cheap: 20 <tr> instead of 3,883, which is the
// difference between a screen that scrolls and one that janks. It does NOT make
// the app "crash-proof no matter how much data" -- if a screen fetches 100,000
// rows, it has already fetched, parsed and retained 100,000 rows before this
// component ever sees them. The fetch is the cost; the render is what this
// fixes. Real protection at that scale is a LIMIT in the query, which is why
// the drill-down API pages server-side and this control drives its offset
// rather than slicing a array the browser had to download in full.
//
// The page size is remembered per browser, not per screen. Someone who wants 50
// rows wants 50 rows everywhere, and re-choosing it on each screen is the kind
// of small friction that makes people stop using a control entirely.
import { useCallback, useEffect, useMemo, useState } from 'react';

export const PAGE_SIZES = [10, 20, 30, 40, 50];
export const DEFAULT_PAGE_SIZE = 20;

const STORE_KEY = 'pt_rows_per_page';

function storedSize(fallback = DEFAULT_PAGE_SIZE) {
  try {
    const v = Number(localStorage.getItem(STORE_KEY));
    return PAGE_SIZES.includes(v) ? v : fallback;
  } catch { return fallback; }
}

/**
 * Client-side pagination over an array already in memory.
 *
 *   const p = usePagination(filteredRows);
 *   ...p.slice.map(...)
 *   <GlobalPagination {...p} />
 */
export function usePagination(rows, { defaultSize = DEFAULT_PAGE_SIZE } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const [size, setSizeRaw] = useState(() => storedSize(defaultSize));
  const [page, setPage] = useState(1);

  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));

  // A filter that shrinks the list under you must not leave you stranded on
  // page 9 of 3 looking at an empty table and concluding the data is gone.
  useEffect(() => { if (page > pages) setPage(pages); }, [pages, page]);

  const setSize = useCallback((n) => {
    const v = Number(n);
    setSizeRaw(PAGE_SIZES.includes(v) ? v : DEFAULT_PAGE_SIZE);
    // Changing the size while deep in the list would land you somewhere
    // arbitrary; page 1 is the only non-surprising answer.
    setPage(1);
    try { localStorage.setItem(STORE_KEY, String(v)); } catch { /* private mode */ }
  }, []);

  const slice = useMemo(
    () => list.slice((page - 1) * size, (page - 1) * size + size),
    [list, page, size],
  );

  return {
    page, setPage, size, setSize, pages, total, slice,
    from: total === 0 ? 0 : (page - 1) * size + 1,
    to: Math.min(page * size, total),
  };
}

/**
 * The footer. Works for the hook above and, unchanged, for server-side paging:
 * pass total/page/pages from the API and an onPage that refetches.
 */
export default function GlobalPagination({
  page, pages, size, total, from, to,
  setPage, setSize, onPage = null, onSize = null,
  label = 'rows', dense = false, className = '',
}) {
  const goto = onPage || setPage;
  const resize = onSize || setSize;
  if (!total) return null;

  const btn = `grid place-items-center rounded-lg border border-slate-700 bg-slate-800/60 text-slate-300
               transition-colors hover:bg-slate-700 hover:text-white
               disabled:cursor-not-allowed disabled:opacity-35 ${dense ? 'h-6 w-6 text-[11px]' : 'h-7 w-7 text-xs'}`;

  // Window the page numbers: 400 pages must not render 400 buttons, which would
  // be a performance bug inside the performance fix.
  const win = [];
  const span = 2;
  for (let p = Math.max(1, page - span); p <= Math.min(pages, page + span); p += 1) win.push(p);

  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 border-t border-slate-700/60 px-3 py-2 ${className}`}>
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <span>
          Showing <b className="text-slate-200">{from.toLocaleString('en-IN')}</b>
          –<b className="text-slate-200">{to.toLocaleString('en-IN')}</b>
          {' of '}<b className="text-slate-200">{total.toLocaleString('en-IN')}</b> {label}
        </span>
        <label className="flex items-center gap-1">
          <span className="sr-only">Rows per page</span>
          <select
            value={size}
            onChange={(e) => resize(Number(e.target.value))}
            title="Rows per page"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-1.5 py-0.5 text-[11px]
                       text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </label>
      </div>

      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => goto(1)} disabled={page === 1} aria-label="First page">«</button>
          <button className={btn} onClick={() => goto(page - 1)} disabled={page === 1} aria-label="Previous page">‹</button>
          {win[0] > 1 && <span className="px-1 text-[11px] text-slate-600">…</span>}
          {win.map((p) => (
            <button
              key={p}
              onClick={() => goto(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`${btn} ${p === page ? '!border-cyan-500/60 !bg-cyan-500/20 !text-cyan-200 font-black' : ''}`}
            >
              {p}
            </button>
          ))}
          {win[win.length - 1] < pages && <span className="px-1 text-[11px] text-slate-600">…</span>}
          <button className={btn} onClick={() => goto(page + 1)} disabled={page === pages} aria-label="Next page">›</button>
          <button className={btn} onClick={() => goto(pages)} disabled={page === pages} aria-label="Last page">»</button>
        </div>
      )}
    </div>
  );
}
