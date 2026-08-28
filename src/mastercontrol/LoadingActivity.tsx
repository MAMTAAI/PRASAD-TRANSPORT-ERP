// @ts-nocheck
// ============================================================================
// TODAY'S LOADING ACTIVITY — who put today's loadings in, the machine or a person
//
// Two doors lead into the loading register and the register itself shows no
// difference between them: the IOCL AC5 mailbox sync parses an invoice and
// inserts a trip, or somebody types one into the Loading Register by hand. So
// nobody could see which half of a day's work was automatic — and, far more
// useful, nobody could see the day the automatic half QUIETLY STOPPED.
//
// THE DAY THIS PANEL IS ABOUT IS NOT ALWAYS TODAY, AND IT SAYS SO. On the day
// this was written the newest row in the whole table was seven days old. A
// panel that renders an empty box on an empty day is indistinguishable from one
// that failed to load, so the server returns the last day that DID have entries
// and this falls back to it under its own date, with the gap stated. An empty
// register is either a quiet morning or a broken sync, and only the date tells
// you which.
//
// THREE COMPANIES SHARE THIS REGISTER, not two. M/S PRASAD TRANSPORT (746
// trips), M/S JAISWAL ENTERPRISE (188) and M/S GAUTAM PRASAD (84). The third
// arrives by the same two doors and had nowhere on this dashboard that named
// it, which is its own kind of invisible.
// ============================================================================
import React from 'react';
import { Bot, UserRound, PackageOpen, AlertTriangle } from 'lucide-react';
import { GlassPanel, PanelHeader } from './shared';

/** "M/S PRASAD TRANSPORT" is what the column holds and far too wide for a chip
 *  in a 340px column. Shortened for display only — never for matching. */
function shortCompany(name) {
  const n = String(name || '').replace(/^M\/S\s+/i, '').trim();
  if (/PRASAD TRANSPORT/i.test(n)) return 'Prasad';
  if (/JAISWAL/i.test(n)) return 'Jaiswal';
  if (/GAUTAM/i.test(n)) return 'Gautam';
  return n || 'Anjaan';
}

/** Fixed per company so the same firm keeps the same colour between refreshes.
 *  Anything unrecognised gets the neutral tone rather than a colour that would
 *  imply it is one of the three. */
const COMPANY_TONE = {
  Prasad:  'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  Jaiswal: 'text-violet-300 border-violet-500/40 bg-violet-500/10',
  Gautam:  'text-amber-300 border-amber-500/40 bg-amber-500/10',
};
const NEUTRAL_TONE = 'text-slate-400 border-slate-600/50 bg-slate-700/20';

const dayLabel = (d) => (d
  ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  : '');

const daysBetween = (d) => {
  if (!d) return null;
  const then = new Date(`${d}T00:00:00`).getTime();
  if (Number.isNaN(then)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then) / 86400000);
};

/** Quantities are kilolitres and arrive as numerics. One decimal is the
 *  precision the register itself uses; more would be false confidence. */
const kl = (n) => `${Number(n || 0).toFixed(1)} KL`;

export default function LoadingActivity({ activity, offline }) {
  const a = activity ?? null;
  const rows = a?.rows ?? [];
  const stale = !!a && !a.is_today && !!a.day;
  const gap = stale ? daysBetween(a.day) : 0;

  return (
    <GlassPanel className="flex flex-col overflow-hidden max-h-[340px] border-cyan-500/25 shadow-[0_0_30px_rgba(34,211,238,0.06)]">
      <PanelHeader
        icon={PackageOpen}
        title="Today's Loading Activity"
        accent="text-cyan-400"
        right={
          <span className="text-[9.5px] font-bold text-slate-500 tracking-wide">
            {a?.day ? dayLabel(a.day) : ''}
          </span>
        }
      />

      {/* THE DATE WARNING COMES FIRST, ABOVE THE NUMBERS IT QUALIFIES. Read in
          the other order, the counts look like today's. */}
      {stale && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-amber-400" />
          <p className="text-[10px] leading-snug text-amber-200">
            Aaj koi loading entry nahi aayi. Neeche <b>{dayLabel(a.day)}</b> ka din dikha rahe hain
            {gap ? ` — ${gap} din purana` : ''}.
            {a.last_7d_count <= 1 && ' Poore hafte mein bhi lagbhag kuch nahi aaya — Gmail sync check karein.'}
          </p>
        </div>
      )}

      {/* THE SPLIT — the whole reason the panel exists. Two tiles rather than a
          stacked list, because the comparison is the information. */}
      <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 shrink-0">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-300">
            <Bot size={11} /> Auto — Email
          </div>
          <div className="mt-0.5 text-[17px] font-black leading-none text-emerald-200">
            {a ? a.email_count : '--'}
          </div>
          <div className="text-[9.5px] text-emerald-400/70">{a ? kl(a.email_qty) : ''}</div>
        </div>
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-sky-300">
            <UserRound size={11} /> Manual — Staff
          </div>
          <div className="mt-0.5 text-[17px] font-black leading-none text-sky-200">
            {a ? a.manual_count : '--'}
          </div>
          <div className="text-[9.5px] text-sky-400/70">{a ? kl(a.manual_qty) : ''}</div>
        </div>
      </div>

      {/* Company chips. Only companies that actually have rows on this day are
          drawn — three empty chips would say "no work" three times over. */}
      {!!a?.by_company?.length && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 shrink-0">
          {a.by_company.map((c) => {
            const short = shortCompany(c.company);
            return (
              <span key={c.company}
                title={`${c.company} · ${c.email_count} auto · ${c.manual_count} manual`}
                className={`rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                {short} <span className="font-black">{c.trips}</span>
                <span className="ml-1 font-normal opacity-70">{kl(c.qty)}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* The rows. flex-1 + min-h-0 so this pane, and only this pane, absorbs
          the leftover height and scrolls instead of stretching the panel — the
          same rule the dispatch chat above it follows. */}
      <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-2 py-1.5 flex flex-col gap-1">
        {!a || offline ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            {offline ? 'Live data unavailable — API not reachable.' : 'Loading…'}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            Register mein abhi tak ek bhi loading entry nahi hai.
          </p>
        ) : rows.map((r) => {
          const auto = r.source === 'EMAIL';
          const short = shortCompany(r.company);
          return (
            <div key={r.id}
              className="flex items-start gap-2 rounded-lg border border-transparent px-1.5 py-1 hover:border-slate-700/60 hover:bg-white/5 transition-colors">
              {/* The badge is the point of the row, so it leads it. */}
              <span className={`mt-px shrink-0 grid place-items-center w-5 h-5 rounded-md border
                ${auto ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                       : 'border-sky-500/40 bg-sky-500/10 text-sky-300'}`}
                title={auto ? 'Email se apne aap aayi' : 'Staff ne khud bhari'}>
                {auto ? <Bot size={11} /> : <UserRound size={11} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-[11px] font-bold text-slate-200 truncate">
                    {r.trip_code || '(no LR)'}
                  </p>
                  <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                    {short}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 truncate">
                  {r.vehicle_no || 'vehicle —'}
                  {r.product_type ? ` · ${r.product_type}` : ''}
                  {r.loaded_qty ? ` · ${kl(r.loaded_qty)}` : ''}
                </p>
                {/* The loading date is shown only when it differs from the day
                    the panel is about — a mailbox sync routinely imports an
                    invoice days after the loading it describes, and that gap is
                    worth seeing where it exists and noise where it does not. */}
                {r.loading_date && r.loading_date !== a.day && (
                  <p className="text-[9.5px] text-slate-600 truncate">
                    loaded {dayLabel(r.loading_date)}
                  </p>
                )}
              </div>
              {auto && r.invoice_no && (
                <span className="shrink-0 text-[9px] text-slate-600 truncate max-w-[70px]" title={r.invoice_no}>
                  {r.invoice_no}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}
