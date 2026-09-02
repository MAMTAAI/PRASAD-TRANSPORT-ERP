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
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, UserRound, PackageOpen, AlertTriangle, CalendarDays } from 'lucide-react';
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('days');
  const a = activity ?? null;
  // THE WEEK DIALOG IS ON THE LOADING-DATE AXIS, and the panel behind it is on
  // the entry-date one. That is deliberate, not an inconsistency: the panel
  // exists to show whether the sync RAN (created_at), and the dialog is opened
  // by somebody asking what the fleet DID (loading_date). On 28-08 the two
  // differed by a whole screen — a week's loadings were all recovered in one
  // morning, so every row carried the same created_at and the old chart drew
  // six empty days over a week that had eleven trips in it.
  const weekDays = a?.last7_loading ?? [];
  const weekFrom = a?.load_week_from ?? null;
  const weekTo = a?.load_week_to ?? null;
  const weekCompanies = a?.by_company_week ?? [];
  const weekTrips = a?.week_trips ?? [];
  // Grouped here rather than in SQL: the server already sorts by date, so this
  // is a single pass, and a flat list keeps the payload one array instead of a
  // nested shape the other two tabs have no use for.
  const tripsByDay = weekTrips.reduce((acc, t) => {
    (acc[t.loading_date] ||= []).push(t);
    return acc;
  }, {});
  const rows = a?.rows ?? [];
  const stale = !!a && !a.is_today && !!a.day;
  const gap = stale ? daysBetween(a.day) : 0;
  // THE MAILBOX BANNER OUTRANKS THE STALE-DATE ONE, because it is the CAUSE of
  // it. "Showing 21 Aug" is a symptom; "neither mailbox can be read" is the
  // thing somebody has to go and fix, and only a person can fix it — an expired
  // OAuth token needs a human to sign in again.
  const deadBoxes = a?.sync?.mailboxes_failed ?? [];
  // ── AND THE THIRD WAY THIS PANEL CAN LIE ────────────────────────────────
  // syncState().last_run lives in the API process's MEMORY. Every restart —
  // every deploy, and there were four on 2026-09-02 — wipes it back to null,
  // and null renders as no dead boxes, no refused inserts and no timestamp:
  // an all-clear from a check that has not run once. On 2-Sep that is exactly
  // what the owner was looking at when he concluded the parser had died; the
  // parser was fine, the panel simply had nothing to say and said it silently.
  //
  // Not knowing is a third state and it gets its own line. The cron ticks
  // every 10 minutes, so this clears itself — the point is that it is VISIBLE
  // while it lasts instead of looking like health.
  const neverChecked = !!a && !a.sync?.checked_at && !a.sync?.running;
  // Neither broken nor imported: an invoice the importer matched to an existing
  // trip by truck+date+quantity, where that trip carries no invoice number.
  // It refuses to attach it — that is a person's judgement — so it waits, and
  // until 2026-09-02 it waited where nobody could see it.
  const held = a?.sync?.held_for_review ?? 0;
  // AND THE OTHER HALF OF THE CHAIN. A readable mailbox whose invoices cannot be
  // WRITTEN looks identical from here: zero auto entries, no dead box, panel
  // green. That is what happened from 21-08 — every insert answered 401 and the
  // banner above had nothing to say, so the frozen register read as a quiet
  // fortnight. Kept separate from deadBoxes because the two send you to
  // different places: one needs a Google login, the other needs the box.
  const refused = a?.sync?.insert_failed ?? 0;

  return (
    <GlassPanel className="flex flex-col overflow-hidden max-h-[340px] border-cyan-500/25 shadow-[0_0_30px_rgba(34,211,238,0.06)]">
      <PanelHeader
        icon={PackageOpen}
        title="Today's Loading Activity"
        accent="text-cyan-400"
        right={
          <div className="flex items-center gap-2">
            <span className="text-[9.5px] font-bold text-slate-500 tracking-wide">
              {a?.day ? dayLabel(a.day) : ''}
            </span>
            {/* A BUTTON, NOT A CLICKABLE PANEL. Making the whole card a click
                target would swallow the row hovers and give no hint that
                anything happens — this says what it opens. */}
            <button
              onClick={() => setOpen(true)}
              disabled={!a}
              title="Pichhle 7 din ka hisaab"
              className="flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors"
            >
              <CalendarDays size={10} /> 7 DIN
            </button>
          </div>
        }
      />

      {/* THE DATE WARNING COMES FIRST, ABOVE THE NUMBERS IT QUALIFIES. Read in
          the other order, the counts look like today's. */}
      {!!deadBoxes.length && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-red-400" />
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wide text-red-300">
              Email sync band hai
            </p>
            <p className="text-[10px] leading-snug text-red-200">
              {deadBoxes.join(' aur ')} ka Gmail token expire ho gaya hai — inbox padha hi nahi ja raha.
              Jab tak dobara login nahi hoga, koi auto entry nahi aayegi.
            </p>
          </div>
        </div>
      )}

      {!deadBoxes.length && refused > 0 && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-red-400" />
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wide text-red-300">
              Inbox padha gaya, entry nahi ban paayi
            </p>
            <p className="text-[10px] leading-snug text-red-200">
              {refused} loading {refused === 1 ? 'invoice' : 'invoices'} mail se mil gayi thi lekin
              register mein likhi nahi ja saki. Ye Gmail ka nahi, server ka masla hai.
            </p>
          </div>
        </div>
      )}

      {/* SILENCE IS NOT HEALTH. Shown only when the two banners above have
          nothing to report, because "we have not looked" is weaker news than
          "we looked and it is broken". */}
      {!deadBoxes.length && !refused && neverChecked && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-slate-600/60 bg-white/[0.03] px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-slate-400" />
          <p className="text-[10px] leading-snug text-slate-300">
            Server abhi restart hua hai — mailbox sync is ke baad ek baar bhi nahi chala, isliye
            neeche ka “sab theek hai” abhi <b>jaanch ke bina</b> hai. Har 10 minute par apne aap
            chalta hai; agli baar chalte hi yahan uska waqt dikhne lagega.
          </p>
        </div>
      )}

      {/* NOT AN ERROR, SO IT DOES NOT GET A RED BOX — but it is work, and work
          nobody can see is work nobody does. */}
      {held > 0 && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-cyan-400" />
          <p className="text-[10px] leading-snug text-cyan-200">
            <b>{held} invoice{held === 1 ? '' : 's'} aadmi ke faisle ka intezaar kar rahi {held === 1 ? 'hai' : 'hain'}.</b>{' '}
            Gaadi, date aur quantity to ek trip se mil gayi, par us trip par invoice number likha hi nahi hai —
            isliye system ne khud nahi joda. Jodna hai ya nahi, yeh aap tay karein.
          </p>
        </div>
      )}

      {stale && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-amber-400" />
          <p className="text-[10px] leading-snug text-amber-200">
            Aaj koi loading entry nahi aayi. Neeche <b>{dayLabel(a.day)}</b> ka din dikha rahe hain
            {gap ? ` — ${gap} din purana` : ''}.
            {a.last_7d_count <= 1 && ' Poore hafte mein bhi lagbhag kuch nahi aaya — Gmail sync check karein.'}
            {!neverChecked && !deadBoxes.length && !refused
              && ' Dono mailbox padhe ja chuke hain aur unmein nayi koi loading nahi thi — yeh sync ki kharabi nahi hai.'}
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

      {/* ── SEVEN DAYS ────────────────────────────────────────────────────────
          PORTALLED, for the reason every dialog in this app is: the shell
          header carries a backdrop-filter, and an ancestor with one becomes the
          containing block for `position: fixed`, so an in-place overlay
          resolves `inset: 0` against a 75px strip.

          The bar chart is two stacked segments per day on a shared scale, so
          the comparison that matters — how much of each day was automatic —
          survives days of very different sizes. Empty days are drawn as empty
          rows rather than skipped, because a week with a hole in it is the
          whole point: this is the view that shows a sync stopping. */}
      {open && createPortal(
        <div onClick={() => setOpen(false)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className={`${tab === 'trips' ? 'w-[min(720px,100%)]' : 'w-[min(560px,100%)]'} max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60 bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)] transition-[width]`}>
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
              <div>
                <p className="text-[13px] font-black text-slate-100">Pichhle 7 din — Loading Activity</p>
                <p className="text-[10px] text-slate-500">
                  {weekFrom && weekTo
                    ? <>Loading ki taarikh se · {dayLabel(weekFrom)} – {dayLabel(weekTo)}</>
                    : 'Auto (email) aur Manual (staff) ka roz ka hisaab'}
                </p>
              </div>
              <button onClick={() => setOpen(false)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            {/* TWO QUESTIONS, NOT ONE. "Kis din kitni loading hui" and "kiski
                loading thi" are asked by the same person seconds apart, and the
                register is shared by three companies — so the second one had no
                answer here at all until it was asked for out loud. */}
            <div className="flex gap-1 px-4 pb-2">
              {[['days', 'Roz ka hisaab'], ['company', 'Transport-wise'], ['trips', 'Trip details']].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`rounded-lg border px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
                    tab === id
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>
                  {label}
                </button>
              ))}
            </div>

            {!!deadBoxes.length && (
              <p className="mx-4 mb-2 rounded-lg border border-red-500/50 bg-red-500/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-red-200">
                <b>Email sync band hai</b> — {deadBoxes.join(' aur ')} ka Gmail token expire ho chuka hai.
                Neeche ke auto-column ke zero isi wajah se hain, kaam na hone ki wajah se nahi.
              </p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-4 pb-4">
              {tab === 'trips' ? (
                weekTrips.length === 0 ? (
                  <p className="py-4 text-[11.5px] text-slate-500">
                    Is hafte ki koi trip nahi mili.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {Object.keys(tripsByDay).map((day) => (
                      <div key={day}>
                        {/* Sticky so the date stays readable while a long day
                            scrolls past it — the whole point of grouping. */}
                        <div className="sticky top-0 z-10 -mx-1 mb-1 bg-slate-900/95 px-1 py-1 backdrop-blur-sm">
                          <span className="text-[10.5px] font-black text-cyan-300">{dayLabel(day)}</span>
                          <span className="ml-1.5 text-[9.5px] text-slate-500">
                            {tripsByDay[day].length} trip{tripsByDay[day].length === 1 ? '' : 's'}
                            <span className="text-slate-600"> · </span>
                            {kl(tripsByDay[day].reduce((s, t) => s + t.loaded_qty, 0))}
                          </span>
                        </div>
                        <div className="flex flex-col gap-1">
                          {tripsByDay[day].map((t) => {
                            const short = shortCompany(t.company);
                            return (
                              <div key={t.id}
                                className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-2.5 py-1.5">
                                <div className="flex items-baseline justify-between gap-2">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="text-[11px] font-black text-slate-100">
                                      {t.trip_code || '(no LR)'}
                                    </span>
                                    <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase border ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                                      {short}
                                    </span>
                                    <span className={`shrink-0 grid place-items-center w-4 h-4 rounded border ${
                                      t.source === 'EMAIL'
                                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                        : 'border-sky-500/40 bg-sky-500/10 text-sky-300'}`}
                                      title={t.source === 'EMAIL' ? 'Email se apne aap' : 'Staff ne bhari'}>
                                      {t.source === 'EMAIL' ? <Bot size={9} /> : <UserRound size={9} />}
                                    </span>
                                  </div>
                                  <span className="shrink-0 text-[12px] font-black tabular-nums text-slate-100">
                                    {kl(t.loaded_qty)}
                                  </span>
                                </div>

                                <p className="mt-0.5 text-[10.5px] font-bold text-slate-300">
                                  {t.vehicle_no || 'gaadi —'}
                                  {t.product_type && (
                                    <span className="ml-1.5 font-normal text-slate-500">{t.product_type}</span>
                                  )}
                                </p>

                                {/* FROM -> TO on its own line: it is the thing
                                    being asked for and it is the longest field,
                                    so it gets the width rather than a column. */}
                                <p className="text-[10px] text-slate-400 truncate"
                                  title={`${t.from || '—'} → ${t.to || '—'}`}>
                                  <span className="text-slate-500">from</span> {t.from || '—'}
                                  <span className="mx-1 text-cyan-500/70">→</span>
                                  <span className="text-slate-500">to</span> {t.to || '—'}
                                </p>

                                <p className="text-[9.5px] text-slate-500 tabular-nums">
                                  {t.rtkm != null && <>RTKM {t.rtkm.toFixed(0)}</>}
                                  {t.unloaded_qty != null && (
                                    <><span className="mx-1 text-slate-700">|</span>unloaded {kl(t.unloaded_qty)}</>
                                  )}
                                  {/* Shortage is the number somebody is looking
                                      for when they look at all, so it is the one
                                      thing here allowed a colour. */}
                                  {t.shortage_qty != null && t.shortage_qty > 0 && (
                                    <><span className="mx-1 text-slate-700">|</span>
                                      <span className="text-amber-300 font-bold">short {kl(t.shortage_qty)}</span></>
                                  )}
                                  {t.driver_name && (
                                    <><span className="mx-1 text-slate-700">|</span>{t.driver_name}</>
                                  )}
                                  {t.status && (
                                    <><span className="mx-1 text-slate-700">|</span>{String(t.status).replace(/_/g, ' ').toLowerCase()}</>
                                  )}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {weekTrips.length >= 200 && (
                      <p className="pt-1 text-[9.5px] text-slate-600">
                        Sirf pehli 200 trips dikha rahe hain — poori list Loading Register mein.
                      </p>
                    )}
                  </div>
                )
              ) : tab === 'company' ? (
                weekCompanies.length === 0 ? (
                  <p className="py-4 text-[11.5px] text-slate-500">
                    Is hafte kisi bhi transport ki koi loading nahi mili.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {(() => {
                      const top = Math.max(1, ...weekCompanies.map((c) => c.qty));
                      return weekCompanies.map((c) => {
                        const short = shortCompany(c.company);
                        return (
                          <div key={c.company}
                            className="rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-black ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                                {short}
                              </span>
                              <span className="text-[15px] font-black tabular-nums text-slate-100">
                                {kl(c.qty)}
                              </span>
                            </div>
                            {/* The bar is share-of-week by volume, which is the
                                comparison somebody opens this tab to make. */}
                            <div className="mt-1.5 h-1.5 rounded bg-slate-900/70 overflow-hidden">
                              <div className="h-full rounded bg-cyan-500/60"
                                style={{ width: `${(c.qty / top) * 100}%` }} />
                            </div>
                            <p className="mt-1.5 text-[10px] text-slate-400 tabular-nums">
                              {c.trips} trip{c.trips === 1 ? '' : 's'}
                              <span className="text-slate-600"> · </span>
                              {c.vehicles} gaadi
                              <span className="text-slate-600"> · </span>
                              <span className="text-emerald-300">{c.email_count} auto</span>
                              <span className="text-slate-600"> / </span>
                              <span className="text-sky-300">{c.manual_count} manual</span>
                            </p>
                            {c.first_day && (
                              <p className="text-[9.5px] text-slate-600">
                                {c.first_day === c.last_day
                                  ? dayLabel(c.first_day)
                                  : `${dayLabel(c.first_day)} – ${dayLabel(c.last_day)}`}
                              </p>
                            )}
                            {/* The full registered name, because "Prasad" is a
                                display shortening and two of the three firms
                                share that word. */}
                            <p className="mt-0.5 text-[9px] text-slate-600 truncate" title={c.company}>
                              {c.company}
                            </p>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )
              ) : (() => {
                const days = weekDays;
                const peak = Math.max(1, ...days.map((d) => d.email_count + d.manual_count));
                const tot = days.reduce((acc, d) => ({
                  e: acc.e + d.email_count, m: acc.m + d.manual_count,
                  eq: acc.eq + d.email_qty, mq: acc.mq + d.manual_qty,
                }), { e: 0, m: 0, eq: 0, mq: 0 });
                return (
                  <>
                    <div className="grid grid-cols-2 gap-2 pb-3">
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2">
                        <div className="flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider text-emerald-300">
                          <Bot size={11} /> Auto — Email · 7 din
                        </div>
                        <div className="mt-0.5 text-[20px] font-black leading-none text-emerald-200">{tot.e}</div>
                        <div className="text-[10px] text-emerald-400/70">{kl(tot.eq)}</div>
                      </div>
                      <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-2">
                        <div className="flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider text-sky-300">
                          <UserRound size={11} /> Manual — Staff · 7 din
                        </div>
                        <div className="mt-0.5 text-[20px] font-black leading-none text-sky-200">{tot.m}</div>
                        <div className="text-[10px] text-sky-400/70">{kl(tot.mq)}</div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      {days.length === 0 ? (
                        <p className="py-4 text-[11.5px] text-slate-500">7 din ka data nahi mila.</p>
                      ) : days.map((d) => {
                        const total = d.email_count + d.manual_count;
                        return (
                          <div key={d.day} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5">
                            <span className="w-[46px] shrink-0 text-[10.5px] font-bold text-slate-400">
                              {dayLabel(d.day)}
                            </span>
                            <div className="flex-1 min-w-0 h-4 rounded bg-slate-800/60 overflow-hidden flex">
                              {d.email_count > 0 && (
                                <div className="h-full bg-emerald-500/70"
                                  style={{ width: `${(d.email_count / peak) * 100}%` }}
                                  title={`${d.email_count} auto · ${kl(d.email_qty)}`} />
                              )}
                              {d.manual_count > 0 && (
                                <div className="h-full bg-sky-500/70"
                                  style={{ width: `${(d.manual_count / peak) * 100}%` }}
                                  title={`${d.manual_count} manual · ${kl(d.manual_qty)}`} />
                              )}
                            </div>
                            <span className="w-[92px] shrink-0 text-right text-[10px] tabular-nums">
                              {total === 0 ? (
                                <span className="text-slate-600">koi entry nahi</span>
                              ) : (
                                <>
                                  <span className="text-emerald-300 font-bold">{d.email_count}</span>
                                  <span className="text-slate-600"> / </span>
                                  <span className="text-sky-300 font-bold">{d.manual_count}</span>
                                  <span className="ml-1 text-slate-500">{kl(d.email_qty + d.manual_qty)}</span>
                                </>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <p className="mt-3 text-[10px] leading-snug text-slate-500">
                      <span className="text-emerald-400">■</span> Auto — IOCL AC5 invoice email se apne aap padhi gayi.
                      <span className="ml-2 text-sky-400">■</span> Manual — kisi ne Loading Register mein khud bhari.
                      {a?.sync?.checked_at && (
                        <> Aakhri sync check: {new Date(a.sync.checked_at).toLocaleString('en-IN')}.</>
                      )}
                    </p>
                  </>
                );
              })()}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </GlassPanel>
  );
}
