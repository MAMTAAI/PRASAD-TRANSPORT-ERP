// @ts-nocheck
// ============================================================================
// UNLOADING ACTIVITY — the other half of the trip, and the half nobody watched
//
// Loading got a panel; unloading got a number. The v5 header has carried
// "PENDING UNLOADING 137 · Awaiting unload" for as long as it has existed, with
// no way to ask what those 137 ARE or how long they have been that way.
//
// The answer turns out to matter far more than the count. Of the 137, eighty
// were loaded MORE THAN THIRTY DAYS ago; the oldest is 01-04, a hundred and
// forty-nine days; and the newest unloading recorded anywhere in the table is
// 30-07. Trucks are not standing full since April. Unloading ENTRY stopped, and
// nothing closes a trip on its own, so every one of them is still IN_TRANSIT.
//
// SO THIS PANEL LEADS WITH AGE, NOT WITH A TOTAL. "137" reads as busy. "80
// trips over 30 days, 2,088 KL" reads as what it is — and that difference is
// the entire reason the panel exists rather than a second number beside the
// first.
//
// IT IS DELIBERATELY THE MIRROR OF LoadingActivity: same panel shell, same tile
// pair, same company chips, same portalled 7-day dialog with tabs. Somebody who
// has learned one has learned the other, and the two sit in the same column.
// ============================================================================
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { PackageCheck, PackageX, AlertTriangle, CalendarDays, Clock } from 'lucide-react';
import { GlassPanel, PanelHeader } from './shared';

/** Same shortening as the loading panel — display only, never for matching. */
function shortCompany(name) {
  const n = String(name || '').replace(/^M\/S\s+/i, '').trim();
  if (/PRASAD TRANSPORT/i.test(n)) return 'Prasad';
  if (/JAISWAL/i.test(n)) return 'Jaiswal';
  if (/GAUTAM/i.test(n)) return 'Gautam';
  return n || 'Anjaan';
}

const COMPANY_TONE = {
  Prasad:  'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  Jaiswal: 'text-violet-300 border-violet-500/40 bg-violet-500/10',
  Gautam:  'text-amber-300 border-amber-500/40 bg-amber-500/10',
};
const NEUTRAL_TONE = 'text-slate-400 border-slate-600/50 bg-slate-700/20';

/** Age bands, coldest to hottest. Fixed edges rather than quantiles so a trip
 *  does not change colour because a different one was closed. */
const BUCKET_TONE = {
  '0-2 din':   'bg-emerald-500/70',
  '3-7 din':   'bg-lime-500/70',
  '8-15 din':  'bg-amber-500/70',
  '16-30 din': 'bg-orange-500/70',
  '30+ din':   'bg-red-500/70',
};
const BUCKET_TEXT = {
  '0-2 din':   'text-emerald-300',
  '3-7 din':   'text-lime-300',
  '8-15 din':  'text-amber-300',
  '16-30 din': 'text-orange-300',
  '30+ din':   'text-red-300',
};

const dayLabel = (d) => (d
  ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  : '');

const kl = (n) => `${Number(n || 0).toFixed(1)} KL`;

export default function UnloadingActivity({ activity, offline }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('pending');
  const u = activity ?? null;

  const buckets = u?.pending_buckets ?? [];
  const pendingRows = u?.pending_rows ?? [];
  const byCompany = u?.pending_by_company ?? [];
  const week = u?.last7_unloading ?? [];
  const weekUnloads = u?.week_unloads ?? [];
  const pendingTotal = buckets.reduce((s, b) => s + b.trips, 0);

  // The week totals, so the second tile can say what the first cannot: whether
  // anything is being CLOSED, as opposed to how much is open.
  const weekTrips = week.reduce((s, d) => s + d.trips, 0);
  const weekQty = week.reduce((s, d) => s + d.qty, 0);

  // Seven days is the threshold because a tanker turns around in two or three.
  // Anything past a week without a single unloading recorded anywhere is an
  // entry problem, not a slow route, and it is worth saying so in red.
  const gap = u?.days_since_unload ?? null;
  const entryStopped = gap != null && gap > 7;

  return (
    <GlassPanel className="flex flex-col overflow-hidden max-h-[340px] border-amber-500/25 shadow-[0_0_30px_rgba(245,158,11,0.06)]">
      <PanelHeader
        icon={PackageCheck}
        title="Unloading Activity"
        accent="text-amber-400"
        right={
          <div className="flex items-center gap-2">
            <span className="text-[9.5px] font-bold text-slate-500 tracking-wide">
              {u?.last_unload_day ? dayLabel(u.last_unload_day) : ''}
            </span>
            <button
              onClick={() => setOpen(true)}
              disabled={!u}
              title="Pending list aur 7 din ka hisaab"
              className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-black text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 transition-colors"
            >
              <CalendarDays size={10} /> DETAILS
            </button>
          </div>
        }
      />

      {entryStopped && (
        <div className="mx-2.5 mt-1.5 flex items-start gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-2 py-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0 text-red-400" />
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wide text-red-300">
              Unloading entry band hai
            </p>
            <p className="text-[10px] leading-snug text-red-200">
              Aakhri unloading <b>{dayLabel(u.last_unload_day)}</b> ki hai — {gap} din pehle.
              Tab se {pendingTotal} trip khuli padi hain; koi trip apne aap band nahi hoti.
            </p>
          </div>
        </div>
      )}

      {/* THE PAIR: what is open, and whether anything is being closed. Two
          tiles rather than one number, because the count alone cannot tell a
          busy week from a stalled one. */}
      <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 shrink-0">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-300">
            <PackageX size={11} /> Pending — Unload
          </div>
          <div className="mt-0.5 text-[17px] font-black leading-none text-amber-200">
            {u ? u.pending_count : '--'}
          </div>
          <div className="text-[9.5px] text-amber-400/70">{u ? kl(u.pending_qty) : ''}</div>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5">
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-300">
            <PackageCheck size={11} /> Unloaded — 7 din
          </div>
          <div className="mt-0.5 text-[17px] font-black leading-none text-emerald-200">
            {u ? weekTrips : '--'}
          </div>
          <div className="text-[9.5px] text-emerald-400/70">{u ? kl(weekQty) : ''}</div>
        </div>
      </div>

      {/* THE AGE BAR — the whole argument of this panel in one row. A stacked
          bar rather than five numbers, because the shape is the point: when the
          red segment is most of the width, the backlog is old, not big. */}
      {!!buckets.length && (
        <div className="px-2.5 pt-2 shrink-0">
          <div className="flex h-2 rounded overflow-hidden bg-slate-800/60">
            {buckets.map((b) => (
              <div key={b.label} className={BUCKET_TONE[b.label] || 'bg-slate-600'}
                style={{ width: `${(b.trips / Math.max(1, pendingTotal)) * 100}%` }}
                title={`${b.label} — ${b.trips} trips · ${kl(b.qty)}`} />
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            {buckets.map((b) => (
              <span key={b.label} className="text-[9px] tabular-nums text-slate-500">
                <span className={BUCKET_TEXT[b.label] || 'text-slate-400'}>■</span> {b.label}
                <span className="ml-0.5 font-bold text-slate-300">{b.trips}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Company chips, same as loading — three firms share this register. */}
      {!!byCompany.length && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 shrink-0">
          {byCompany.map((c) => {
            const short = shortCompany(c.company);
            return (
              <span key={c.company}
                title={`${c.company} · ${c.trips} pending · sabse purani ${c.oldest_days} din`}
                className={`rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                {short} <span className="font-black">{c.trips}</span>
                <span className="ml-1 font-normal opacity-70">{kl(c.qty)}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* OLDEST FIRST. The top of this list is the work — a trip open since
          April is not the same problem as one open since Tuesday, and sorting
          newest-first would bury the ones that matter under the ones that do
          not. */}
      <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-2 py-1.5 flex flex-col gap-1">
        {!u || offline ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            {offline ? 'Live data unavailable — API not reachable.' : 'Loading…'}
          </p>
        ) : pendingRows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            Ek bhi trip unloading ke liye pending nahi — sab band hain.
          </p>
        ) : pendingRows.slice(0, 12).map((t) => {
          const short = shortCompany(t.company);
          const hot = t.age_days > 30;
          return (
            <div key={t.id}
              className="flex items-start gap-2 rounded-lg border border-transparent px-1.5 py-1 hover:border-slate-700/60 hover:bg-white/5 transition-colors">
              <span className={`mt-px shrink-0 grid place-items-center w-5 h-5 rounded-md border
                ${hot ? 'border-red-500/40 bg-red-500/10 text-red-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}
                title={`${t.age_days} din se pending`}>
                <Clock size={11} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-[11px] font-bold text-slate-200 truncate">
                    {t.trip_code || '(no LR)'}
                  </p>
                  <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase tracking-wide border ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                    {short}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 truncate">
                  {t.vehicle_no || 'gaadi —'}
                  {t.product_type ? ` · ${t.product_type}` : ''}
                  {t.loaded_qty ? ` · ${kl(t.loaded_qty)}` : ''}
                </p>
                <p className="text-[9.5px] text-slate-600 truncate" title={`${t.from || '—'} → ${t.to || '—'}`}>
                  {t.from || '—'} <span className="text-amber-500/70">→</span> {t.to || '—'}
                </p>
              </div>
              <span className={`shrink-0 text-[10px] font-black tabular-nums ${hot ? 'text-red-300' : 'text-amber-300'}`}>
                {t.age_days}d
              </span>
            </div>
          );
        })}
        {pendingRows.length > 12 && (
          <button onClick={() => { setTab('pending'); setOpen(true); }}
            className="mt-0.5 rounded-lg border border-slate-700/60 py-1 text-[10px] font-bold text-slate-400 hover:text-slate-200 hover:border-slate-600">
            + {u.pending_count - 12} aur pending — poori list dekhein
          </button>
        )}
      </div>

      {/* ── THE DIALOG ────────────────────────────────────────────────────────
          Portalled for the same reason every dialog here is: the shell header
          carries a backdrop-filter, which makes it the containing block for
          `position: fixed`, so an in-place overlay resolves inset:0 against a
          75px strip. */}
      {open && createPortal(
        <div onClick={() => setOpen(false)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className="w-[min(720px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60 bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
              <div>
                <p className="text-[13px] font-black text-slate-100">Unloading — pending aur pichhle 7 din</p>
                <p className="text-[10px] text-slate-500">
                  {u?.week_from && u?.week_to
                    ? <>Unloading ki taarikh se · {dayLabel(u.week_from)} – {dayLabel(u.week_to)}</>
                    : 'Jo abhi baaki hai, aur jo band hui'}
                </p>
              </div>
              <button onClick={() => setOpen(false)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            <div className="flex gap-1 px-4 pb-2">
              {[['pending', `Pending (${u?.pending_count ?? 0})`],
                ['days', 'Roz ka hisaab'],
                ['company', 'Transport-wise']].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`rounded-lg border px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
                    tab === id
                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-200'
                      : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>
                  {label}
                </button>
              ))}
            </div>

            {entryStopped && (
              <p className="mx-4 mb-2 rounded-lg border border-red-500/50 bg-red-500/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-red-200">
                <b>Unloading entry band hai</b> — aakhri unloading {dayLabel(u.last_unload_day)} ({gap} din pehle).
                Neeche ke zero isi wajah se hain, gaadi na chalne ki wajah se nahi.
              </p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-4 pb-4">
              {tab === 'pending' ? (
                pendingRows.length === 0 ? (
                  <p className="py-4 text-[11.5px] text-slate-500">Kuch pending nahi hai.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {pendingRows.map((t) => {
                      const short = shortCompany(t.company);
                      const hot = t.age_days > 30;
                      return (
                        <div key={t.id}
                          className={`rounded-lg border px-2.5 py-1.5 ${
                            hot ? 'border-red-500/25 bg-red-500/[0.04]' : 'border-slate-700/50 bg-slate-800/30'}`}>
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[11px] font-black text-slate-100">{t.trip_code || '(no LR)'}</span>
                              <span className={`shrink-0 rounded px-1 py-[1px] text-[8px] font-black uppercase border ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                                {short}
                              </span>
                            </div>
                            <span className={`shrink-0 text-[12px] font-black tabular-nums ${hot ? 'text-red-300' : 'text-amber-300'}`}>
                              {t.age_days} din
                            </span>
                          </div>
                          <p className="mt-0.5 text-[10.5px] font-bold text-slate-300">
                            {t.vehicle_no || 'gaadi —'}
                            {t.product_type && <span className="ml-1.5 font-normal text-slate-500">{t.product_type}</span>}
                            {t.loaded_qty ? <span className="ml-1.5 font-normal text-slate-500">{kl(t.loaded_qty)}</span> : null}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate" title={`${t.from || '—'} → ${t.to || '—'}`}>
                            <span className="text-slate-500">from</span> {t.from || '—'}
                            <span className="mx-1 text-amber-500/70">→</span>
                            <span className="text-slate-500">to</span> {t.to || '—'}
                          </p>
                          <p className="text-[9.5px] text-slate-500 tabular-nums">
                            loaded {dayLabel(t.loading_date)}
                            {t.rtkm != null && <><span className="mx-1 text-slate-700">|</span>RTKM {t.rtkm.toFixed(0)}</>}
                            {t.driver_name && <><span className="mx-1 text-slate-700">|</span>{t.driver_name}</>}
                          </p>
                        </div>
                      );
                    })}
                    {u.pending_count > pendingRows.length && (
                      <p className="pt-1 text-[9.5px] text-slate-600">
                        Sabse purani {pendingRows.length} dikha rahe hain (kul {u.pending_count}) — poori list Trip Management mein.
                      </p>
                    )}
                  </div>
                )
              ) : tab === 'company' ? (
                byCompany.length === 0 ? (
                  <p className="py-4 text-[11.5px] text-slate-500">Kisi transport ka kuch pending nahi.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {(() => {
                      const top = Math.max(1, ...byCompany.map((c) => c.trips));
                      return byCompany.map((c) => {
                        const short = shortCompany(c.company);
                        return (
                          <div key={c.company} className="rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-black ${COMPANY_TONE[short] || NEUTRAL_TONE}`}>
                                {short}
                              </span>
                              <span className="text-[15px] font-black tabular-nums text-slate-100">
                                {c.trips} pending
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 rounded bg-slate-900/70 overflow-hidden">
                              <div className="h-full rounded bg-amber-500/60" style={{ width: `${(c.trips / top) * 100}%` }} />
                            </div>
                            <p className="mt-1.5 text-[10px] text-slate-400 tabular-nums">
                              {kl(c.qty)}
                              <span className="text-slate-600"> · </span>
                              sabse purani <span className="font-bold text-amber-300">{c.oldest_days} din</span>
                              <span className="text-slate-600"> ({dayLabel(c.oldest)})</span>
                            </p>
                            <p className="mt-0.5 text-[9px] text-slate-600 truncate" title={c.company}>{c.company}</p>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-1">
                  {week.length === 0 ? (
                    <p className="py-4 text-[11.5px] text-slate-500">7 din ka data nahi mila.</p>
                  ) : (() => {
                    const peak = Math.max(1, ...week.map((d) => d.trips));
                    return week.map((d) => (
                      <div key={d.day} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5">
                        <span className="w-[46px] shrink-0 text-[10.5px] font-bold text-slate-400">
                          {dayLabel(d.day)}
                        </span>
                        <div className="flex-1 min-w-0 h-4 rounded bg-slate-800/60 overflow-hidden flex">
                          {d.trips > 0 && (
                            <div className="h-full bg-emerald-500/70"
                              style={{ width: `${(d.trips / peak) * 100}%` }}
                              title={`${d.trips} unloaded · ${kl(d.qty)}`} />
                          )}
                        </div>
                        <span className="w-[92px] shrink-0 text-right text-[10px] tabular-nums">
                          {d.trips === 0 ? (
                            <span className="text-slate-600">koi entry nahi</span>
                          ) : (
                            <>
                              <span className="font-bold text-emerald-300">{d.trips}</span>
                              {d.qty > 0 && <span className="ml-1 text-slate-500">{kl(d.qty)}</span>}
                            </>
                          )}
                        </span>
                      </div>
                    ));
                  })()}

                  {/* The closed trips themselves, when there are any. Empty
                      today for the reason stated in red above, and an empty
                      list under a stated reason is honest where a hidden one
                      would not be. */}
                  {!!weekUnloads.length && (
                    <div className="mt-2 flex flex-col gap-1">
                      <p className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                        Jo unload huin
                      </p>
                      {weekUnloads.map((t) => (
                        <div key={t.id} className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-2.5 py-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[11px] font-black text-slate-100">{t.trip_code || '(no LR)'}</span>
                            <span className="text-[11px] font-bold tabular-nums text-slate-200">
                              {t.unloaded_qty != null ? kl(t.unloaded_qty) : kl(t.loaded_qty)}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-400 truncate">
                            {t.vehicle_no} · {t.from || '—'} <span className="text-amber-500/70">→</span> {t.to || '—'}
                          </p>
                          <p className="text-[9.5px] text-slate-500 tabular-nums">
                            unloaded {dayLabel(t.unloading_date)}
                            {t.transit_days != null && <><span className="mx-1 text-slate-700">|</span>{t.transit_days} din transit</>}
                            {t.shortage_qty != null && t.shortage_qty > 0 && (
                              <><span className="mx-1 text-slate-700">|</span>
                                <span className="font-bold text-amber-300">short {kl(t.shortage_qty)}</span></>
                            )}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </GlassPanel>
  );
}
