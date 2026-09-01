// @ts-nocheck
// ============================================================================
// DRIVER COMMAND CENTER — whose papers are missing, and what to do about it
//
// WHY THIS WAS REBUILT, because the mistake is easy to repeat. The first
// version printed one chip per missing document, so a driver missing six
// papers rendered six pills and the row wrapped to three lines. Fifty-four
// drivers of that produced a wall of identically-sized tags in which
// "DL expired 407d" — a truck that must not roll today — sat at exactly the
// same visual weight as "PAN", a piece of filing. Everything was shown and
// therefore nothing was legible, and every row was a different height.
//
// THE RULE HERE: a row answers WHO and HOW BAD in one line, at one height.
// WHAT EXACTLY is missing is a second question, and it is answered in the
// overlay — the same split Today's Loading Activity makes between its panel
// and its "7 DIN" sheet.
//
// AND CLICKING A ROW DOES NOT LEAVE THE DASHBOARD. Jumping straight to the
// Driver Master page threw away the context somebody was working in and made
// them find their place again on the way back. The overlay shows the whole
// checklist in place; opening the KYC form is then a deliberate second step,
// because that is the only screen that can actually take an upload.
// ============================================================================
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Users, ExternalLink, ShieldAlert, CheckCircle2, CircleSlash } from 'lucide-react';
import { GlassPanel, PanelHeader, PANEL_SHELL, SCROLL_PANE, ROW_CLS, chipCls, TONE_CHIP } from './shared';
import { expiryTone, expiryLabel } from './useDashboardData';

/** Every paper a driver is expected to have, in the order the KYC form asks
 *  for them. `missing` from the API is a subset of these labels, so present =
 *  this list minus that one — the panel never has to ask the server twice. */
const PAPERS = ['Photo', 'DL', 'DL-expiry', 'Aadhaar', 'PAN', 'Bank', 'HZD'];

const initialsOf = (name) => String(name || '?').trim().split(/\s+/)
  .map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** The single worst thing about this driver, which is what the row leads with.
 *  An expired document outranks any amount of missing filing: one stops a
 *  truck at the first check, the other is a folder to complete. */
function worstOf(d) {
  const dl = expiryTone(d.dl_days);
  const hzd = expiryTone(d.hzd_days);
  if (dl === 'red' || hzd === 'red') return 'red';
  if (dl === 'amber' || hzd === 'amber') return 'amber';
  return d.missing?.length ? 'amber' : 'green';
}

/** The one expiry chip a row is allowed. Two expiry chips per row is what made
 *  the old rows wrap; the overlay shows both. */
function headlineExpiry(d) {
  const dl = expiryTone(d.dl_days);
  const hzd = expiryTone(d.hzd_days);
  const rank = { red: 0, amber: 1, green: 2, slate: 3 };
  const worseIsHzd = rank[hzd] < rank[dl];
  const tone = worseIsHzd ? hzd : dl;
  if (tone === 'green' || tone === 'slate') return null;   // nothing urgent to say
  return { tone, label: `${worseIsHzd ? 'HZD' : 'DL'} ${expiryLabel(worseIsHzd ? d.hzd_days : d.dl_days)}` };
}

export default function DriverCommandCenter({ drivers }) {
  // The array form is still accepted so a cached older payload renders rather
  // than blanking the panel while the API restarts.
  const payload = Array.isArray(drivers) ? { rows: drivers } : (drivers ?? {});
  const rows = payload.rows ?? [];
  const [open, setOpen] = useState(null);   // the driver whose sheet is showing

  return (
    <GlassPanel className={`${PANEL_SHELL} border-cyan-500/25 shadow-[0_0_30px_rgba(34,211,238,0.06)]`}>
      <PanelHeader
        icon={Users}
        title="Driver Command Center"
        accent="text-cyan-400"
        sub={`${payload.total_active ?? 0} active drivers`}
        right={
          // A BUTTON, NOT A CLICKABLE PANEL — the rule Loading Activity states
          // out loud. The panel shows the worst few; this is the way to the rest
          // and it says so, rather than ending a scroll without explanation.
          <a
            href="?module=OPERATION&screen=DRIVER"
            target="_blank" rel="noopener noreferrer"
            title="Poori driver list nayi tab mein"
            className="flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5
                       text-[9px] font-black text-cyan-300 transition-colors hover:bg-cyan-500/20"
          >
            <ExternalLink size={10} /> SAB
          </a>
        }
      />

      <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 shrink-0">
        <span className={chipCls(payload.expired ? 'red' : 'green')}>
          {payload.expired ?? 0} <span className="font-normal opacity-70">expired</span>
        </span>
        <span className={chipCls(payload.with_gaps ? 'amber' : 'green')}>
          {payload.with_gaps ?? 0} <span className="font-normal opacity-70">papers pending</span>
        </span>
        {rows.length < (payload.with_gaps ?? 0) && (
          <span className="text-[9px] font-semibold text-slate-500">worst {rows.length} shown</span>
        )}
      </div>

      <div className={SCROLL_PANE}>
        {rows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">No active drivers on file.</p>
        ) : rows.map((d) => {
          const worst = worstOf(d);
          const head = headlineExpiry(d);
          const pending = d.missing?.length ?? 0;
          return (
            // ONE LINE, ONE HEIGHT. items-center rather than items-start, and
            // nothing here is allowed to wrap.
            <button
              key={d.id || d.name}
              type="button"
              onClick={() => setOpen(d)}
              title={`${d.name} — poori list dekhein`}
              className={`${ROW_CLS} items-center w-full text-left hover:border-cyan-500/40`}
            >
              <span className={`shrink-0 grid place-items-center w-5 h-5 rounded-md border text-[8px] font-black ${TONE_CHIP[worst]}`}>
                {initialsOf(d.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-200">{d.name}</span>
              {head && <span className={`${chipCls(head.tone)} shrink-0`}>{head.label}</span>}
              {pending > 0 && (
                <span className={`${chipCls('amber')} shrink-0`}>
                  {pending} <span className="font-normal opacity-70">pending</span>
                </span>
              )}
              {!head && pending === 0 && <span className={`${chipCls('green')} shrink-0`}>complete</span>}
            </button>
          );
        })}
      </div>

      {open && createPortal(
        <div onClick={() => setOpen(null)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className="w-[min(460px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60
                       bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-black text-slate-100">{open.name}</p>
                <p className="text-[10px] text-slate-500">
                  {open.mobile ? `+91 ${open.mobile}` : 'mobile number nahi hai'}
                </p>
              </div>
              <button onClick={() => setOpen(null)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            {/* Expiries first: these are the ones that stop a vehicle. */}
            <div className="flex flex-wrap gap-1 px-4 pb-2">
              <span className={chipCls(expiryTone(open.dl_days))}>DL {expiryLabel(open.dl_days)}</span>
              <span className={chipCls(expiryTone(open.hzd_days))}>HZD {expiryLabel(open.hzd_days)}</span>
            </div>

            {(expiryTone(open.dl_days) === 'red' || expiryTone(open.hzd_days) === 'red') && (
              <p className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-2.5 py-1.5
                            text-[10.5px] leading-snug text-red-200">
                <ShieldAlert size={13} className="mt-px shrink-0 text-red-400" />
                Ye document expire ho chuka hai — check par gaadi rok di jayegi. Pehle isi ko renew karayein.
              </p>
            )}

            {/* The whole checklist, present AND missing. Showing only what is
                missing leaves you unable to tell a driver with nothing on file
                from one whose folder is complete. */}
            <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-4 pb-2">
              <p className="mb-1.5 text-[9.5px] font-black uppercase tracking-wider text-slate-500">Kaagaz</p>
              <div className="flex flex-col gap-0.5">
                {PAPERS.map((p) => {
                  const missing = (open.missing ?? []).includes(p);
                  return (
                    <div key={p} className="flex items-center gap-2 rounded-md px-1.5 py-1 odd:bg-white/[0.02]">
                      {missing
                        ? <CircleSlash size={13} className="shrink-0 text-amber-400" />
                        : <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />}
                      <span className={`flex-1 text-[11px] ${missing ? 'font-bold text-amber-200' : 'text-slate-400'}`}>{p}</span>
                      <span className={`text-[9px] font-black uppercase tracking-wider ${missing ? 'text-amber-400' : 'text-emerald-500/80'}`}>
                        {missing ? 'pending' : 'ok'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* The upload lives on the KYC form and nowhere else, so this is a
                deliberate step out rather than a half-copy of that screen. */}
            <div className="border-t border-slate-700/60 px-4 py-2.5">
              <a
                href={`?module=OPERATION&screen=DRIVER&driver=${encodeURIComponent(open.id ?? '')}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10
                           px-3 py-2 text-[11px] font-black text-cyan-200 transition-colors hover:bg-cyan-500/20"
              >
                <ExternalLink size={12} /> KYC form kholein — file upload karein
              </a>
              <p className="mt-1.5 text-center text-[9px] leading-snug text-slate-500">
                Nayi tab mein khulega. Upload karte hi file save ho jaati hai — scan number aur date bhar deta hai.
              </p>
            </div>
          </div>
        </div>, document.body)}
    </GlassPanel>
  );
}
