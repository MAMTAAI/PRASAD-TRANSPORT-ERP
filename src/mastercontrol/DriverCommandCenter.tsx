// @ts-nocheck
// ============================================================================
// DRIVER COMMAND CENTER — whose papers are missing, and filing them in place
//
// WHY THIS WAS REBUILT TWICE, because both mistakes are easy to repeat.
//
// FIRST: it printed one chip per missing document, so a driver missing six
// papers rendered six pills and the row wrapped to three lines. Fifty-four
// drivers of that is a wall of identically-sized tags in which "DL expired
// 407d" — a truck that must not roll today — carried the same visual weight as
// "PAN", which is filing. Everything shown, nothing legible, no two rows the
// same height. A row now answers WHO and HOW BAD in one line at one height;
// WHAT exactly is missing is the sheet's job.
//
// SECOND: the sheet's only action was a link to the KYC form in another tab.
// That is a page jump wearing a button, and it threw away whatever the person
// was in the middle of. The Unloading sheet is the pattern that works here —
// every card carries its own action and the work happens where you are
// looking. So each missing paper has an UPLOAD button, and pressing it does
// the whole job in place:
//
//     file → vault → PATCH the URL column → OCR → PATCH number/date
//
// Both writes are real Postgres writes, so the row is correct the moment the
// upload finishes rather than when somebody remembers to press Save on another
// screen. Nothing navigates.
//
// ONLY BLANK FIELDS GET THE SCAN. Overwriting a number somebody typed with an
// OCR guess is how a correct licence quietly becomes a wrong one, and OCR is
// confident even when it misreads.
// ============================================================================
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Users, ExternalLink, ShieldAlert, CheckCircle2, CircleSlash, Paperclip, Loader2, CalendarClock } from 'lucide-react';
import { GlassPanel, PanelHeader, PANEL_SHELL, SCROLL_PANE, ROW_CLS, chipCls, TONE_CHIP } from './shared';
import { expiryTone, expiryLabel } from './useDashboardData';
import { uploadMedia, slug } from '../lib/uploadMedia';
import { extractDocument } from '../lib/aiScanner';
import { API_BASE } from '../lib/apiBase';
import { openDriverControl } from '../components/DriverControlDrawer';

const MASTERS = `${API_BASE}/api/v1/masters`;

/** Every paper a driver is expected to have, in the order the KYC form asks for
 *  them, mapped to the columns each one fills.
 *
 *  `DL-expiry` carries no file of its own — it is a date that the licence scan
 *  produces — so it renders as a status line with no upload button rather than
 *  a button that could not do anything. */
const PAPERS = [
  { key: 'Photo', label: 'Passport photo', col: 'profile_pic_url', accept: 'image/*' },
  { key: 'DL', label: 'Driving licence', col: 'dl_photo_url', doc: 'Driving Licence', num: 'license_no', exp: 'license_expiry' },
  { key: 'DL-expiry', label: 'Licence expiry date', derived: 'DL' },
  { key: 'Aadhaar', label: 'Aadhaar card', col: 'aadhar_photo_url', doc: 'Aadhaar', num: 'aadhar_no' },
  { key: 'PAN', label: 'PAN card', col: 'pan_photo_url', doc: 'PAN Card', num: 'pan_no' },
  { key: 'Bank', label: 'Bank passbook', col: 'bank_photo_url', doc: 'Bank Passbook', num: 'account_no' },
  { key: 'HZD', label: 'Hazardous certificate', col: 'hzd_photo_url', doc: 'Hazardous Certificate', num: 'hzd_cert_no', exp: 'hzd_expiry' },
];

const initialsOf = (name) => String(name || '?').trim().split(/\s+/)
  .map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** The single worst thing about this driver, which is what the row leads with.
 *  An expired document outranks any amount of missing filing: one stops a truck
 *  at the first check, the other is a folder to complete. */
function worstOf(d) {
  const dl = expiryTone(d.dl_days);
  const hzd = expiryTone(d.hzd_days);
  if (dl === 'red' || hzd === 'red') return 'red';
  if (dl === 'amber' || hzd === 'amber') return 'amber';
  return d.missing?.length ? 'amber' : 'green';
}

/** The one expiry chip a row is allowed. Two per row is what made them wrap. */
function headlineExpiry(d) {
  const rank = { red: 0, amber: 1, green: 2, slate: 3 };
  const dl = expiryTone(d.dl_days);
  const hzd = expiryTone(d.hzd_days);
  const worseIsHzd = rank[hzd] < rank[dl];
  const tone = worseIsHzd ? hzd : dl;
  if (tone === 'green' || tone === 'slate') return null;
  return { tone, label: `${worseIsHzd ? 'HZD' : 'DL'} ${expiryLabel(worseIsHzd ? d.hzd_days : d.dl_days)}` };
}

/** OCR hands back DD-MM-YYYY or ISO; the column wants ISO. Anything else is
 *  dropped rather than guessed at — a wrong expiry date is worse than none. */
function isoDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

export default function DriverCommandCenter({ drivers, alerts }) {
  const payload = Array.isArray(drivers) ? { rows: drivers } : (drivers ?? {});
  const rows = payload.rows ?? [];

  // DRIVER-ONLY, deliberately. The compliance feed carries lorries too, and
  // counting the whole feed here would repeat the mistake the Fleet vault made
  // in the other direction — a driver panel announcing vehicle fitness
  // certificates. Counted in SQL, not from the LIMIT 60 array.
  const counts = alerts?.counts ?? {};
  const drvExpired = counts.driver_expired ?? 0;
  const drvExpiring = counts.driver_expiring ?? 0;
  const [open, setOpen] = useState(null);
  // Papers filed during this sheet's life. The dashboard polls on its own
  // schedule, and waiting for that to come round would leave a document the
  // user just uploaded still showing as pending.
  const [filed, setFiled] = useState({});      // { [driverId]: { [paperKey]: 'ok' } }
  const [busy, setBusy] = useState(null);      // paper key currently uploading
  const [note, setNote] = useState(null);      // { tone, text }

  const isMissing = (d, key) =>
    !(filed[d.id]?.[key]) && (d.missing ?? []).includes(key);

  async function patchDriver(id, body) {
    const res = await fetch(`${MASTERS}/drivers/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('prasad_token') || ''}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`save failed (HTTP ${res.status})`);
    return res.json().catch(() => ({}));
  }

  async function onPick(e, d, paper) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(paper.key);
    setNote(null);
    try {
      // 1 — the file itself. uploadMedia compresses and re-extensions the path
      // to whatever it actually encoded, so a PDF stays a PDF.
      const ext = (file.name?.match(/\.([A-Za-z0-9]+)$/)?.[1]
        || (file.type === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase();
      const { url } = await uploadMedia(file, `drivers/${slug(d.mobile || d.name || d.id)}/${slug(paper.col)}_${Date.now()}.${ext}`);

      // 2 — the pointer, written immediately. This is the step whose absence
      // made uploads look like they had not saved.
      await patchDriver(d.id, { [paper.col]: url });
      setFiled((f) => ({ ...f, [d.id]: { ...(f[d.id] ?? {}), [paper.key]: 'ok' } }));
      setNote({ tone: 'ok', text: `${paper.label} save ho gaya.` });

      // 3 — the reading, best effort. A dead scanner must never lose the file
      // that is already safely stored, so this cannot throw past here.
      if (paper.doc) {
        try {
          const ex = await extractDocument(file, paper.doc);
          const body = {};
          const num = ex?.document_number ? String(ex.document_number).replace(/[^A-Za-z0-9/-]/g, '').trim() : '';
          const exp = isoDate(ex?.expiry_date);
          if (paper.num && num) body[paper.num] = num;
          if (paper.exp && exp) body[paper.exp] = exp;
          if (Object.keys(body).length) {
            await patchDriver(d.id, body);
            if (paper.exp && exp) {
              setFiled((f) => ({ ...f, [d.id]: { ...(f[d.id] ?? {}), 'DL-expiry': 'ok' } }));
            }
            setNote({ tone: 'ok', text: `${paper.label} save + scan: ${Object.values(body).join(', ')}` });
          } else {
            setNote({ tone: 'warn', text: `${paper.label} save ho gaya — scan se number nahi nikla, KYC form mein haath se daal dein.` });
          }
        } catch {
          setNote({ tone: 'warn', text: `${paper.label} save ho gaya — scan nahi ho paya (file surakshit hai).` });
        }
      }
    } catch (err) {
      setNote({ tone: 'bad', text: `Upload nahi hua: ${err.message}` });
    }
    setBusy(null);
  }

  return (
    <GlassPanel className={`${PANEL_SHELL} border-cyan-500/25 shadow-[0_0_30px_rgba(34,211,238,0.06)]`}>
      <PanelHeader
        icon={Users}
        title="Driver Command Center"
        accent="text-cyan-400"
        sub={`${payload.total_active ?? 0} active drivers`}
        right={
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

      {/* Same two tiles as the Fleet vault, so the stacked pair reads as one
          dashboard rather than two widgets — but counting DRIVER licences,
          never lorries. */}
      <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 shrink-0">
        <div className={`rounded-lg border px-2 py-1.5 ${drvExpired ? 'border-red-500/45 bg-red-500/10' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-red-300">
            <ShieldAlert size={10} /> Expired
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{drvExpired}</p>
          <p className="text-[9px] text-slate-500">DL / HZD licence</p>
        </div>
        <div className={`rounded-lg border px-2 py-1.5 ${payload.with_gaps ? 'border-amber-500/45 bg-amber-500/10' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-300">
            <CalendarClock size={10} /> Kaagaz baaki
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{payload.with_gaps ?? 0}</p>
          <p className="text-[9px] text-slate-500">
            {drvExpiring > 0 ? `${drvExpiring} agle 10 din mein` : 'driver files adhoori'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 shrink-0">
        <span className={chipCls('slate')}>
          {payload.total_active ?? 0} <span className="font-normal opacity-70">active</span>
        </span>
        {rows.length < (payload.with_gaps ?? 0) && (
          <span className="text-[9px] font-semibold text-slate-500">worst {rows.length} shown</span>
        )}
      </div>

      <div className={SCROLL_PANE}>
        {rows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">No active drivers on file.</p>
        ) : rows.map((d) => {
          const head = headlineExpiry(d);
          const pending = PAPERS.filter((p) => isMissing(d, p.key)).length;
          return (
            <button
              key={d.id || d.name}
              type="button"
              // A row opens the Driver Control Dashboard — the slide-out with
              // status, ledger, locker, map (owner, 2026-09-03). The old
              // upload-only modal remains for a row that carries no id.
              onClick={() => { if (d.id) openDriverControl(d.id, d.name); else { setOpen(d); setNote(null); } }}
              data-driver-link={d.id || undefined}
              title={`${d.name} — Driver Control Dashboard`}
              className={`${ROW_CLS} items-center w-full text-left hover:border-cyan-500/40`}
            >
              <span className={`shrink-0 grid place-items-center w-5 h-5 rounded-md border text-[8px] font-black ${TONE_CHIP[worstOf(d)]}`}>
                {initialsOf(d.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-200">{d.name}</span>
              {head && <span className={`${chipCls(head.tone)} shrink-0`}>{head.label}</span>}
              {pending > 0
                ? <span className={`${chipCls('amber')} shrink-0`}>{pending} <span className="font-normal opacity-70">pending</span></span>
                : !head && <span className={`${chipCls('green')} shrink-0`}>complete</span>}
            </button>
          );
        })}
      </div>

      {open && createPortal(
        <div onClick={() => setOpen(null)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className="w-[min(520px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60
                       bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-black text-slate-100">{open.name}</p>
                <p className="text-[10px] text-slate-500">
                  {open.mobile ? `+91 ${open.mobile}` : 'mobile number nahi hai'}
                  <span className="mx-1 text-slate-700">|</span>
                  upload yahin hota hai — page nahi badlega
                </p>
              </div>
              <button onClick={() => setOpen(null)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            <div className="flex flex-wrap gap-1 px-4 pb-2">
              <span className={chipCls(expiryTone(open.dl_days))}>DL {expiryLabel(open.dl_days)}</span>
              <span className={chipCls(expiryTone(open.hzd_days))}>HZD {expiryLabel(open.hzd_days)}</span>
            </div>

            {(expiryTone(open.dl_days) === 'red' || expiryTone(open.hzd_days) === 'red') && (
              <p className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-2.5 py-1.5
                            text-[10.5px] leading-snug text-red-200">
                <ShieldAlert size={13} className="mt-px shrink-0 text-red-400" />
                Ye document expire ho chuka hai — check par gaadi rok di jayegi. Naya kaagaz upload karein.
              </p>
            )}

            {note && (
              <p className={`mx-4 mb-2 rounded-lg border px-2.5 py-1.5 text-[10.5px] leading-snug ${
                note.tone === 'ok' ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200'
                  : note.tone === 'warn' ? 'border-amber-500/45 bg-amber-500/10 text-amber-200'
                    : 'border-red-500/45 bg-red-500/10 text-red-200'}`}>
                {note.text}
              </p>
            )}

            {/* Present AND missing, because a list of only the gaps cannot tell
                a driver with nothing on file from one whose folder is done. */}
            <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-4 pb-3">
              <div className="flex flex-col gap-1.5">
                {PAPERS.map((p) => {
                  const missing = p.derived
                    ? isMissing(open, p.key)
                    : isMissing(open, p.key);
                  const uploading = busy === p.key;
                  return (
                    <div key={p.key}
                      className={`rounded-xl border px-3 py-2 ${missing
                        ? 'border-amber-500/40 bg-amber-500/[0.06]'
                        : 'border-slate-700/60 bg-white/[0.02]'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {missing
                            ? <CircleSlash size={14} className="shrink-0 text-amber-400" />
                            : <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />}
                          <div className="min-w-0">
                            <p className={`truncate text-[11.5px] font-bold ${missing ? 'text-amber-100' : 'text-slate-300'}`}>{p.label}</p>
                            <p className="text-[9px] uppercase tracking-wider text-slate-500">
                              {p.derived
                                ? (missing ? `${p.derived} scan se bhar jayega` : 'bhara hua')
                                : (missing ? 'pending' : 'file lagi hui hai')}
                            </p>
                          </div>
                        </div>

                        {/* The action sits on the card, exactly as the Unloading
                            sheet does it. `derived` rows get none because there
                            is no file to attach to a date. */}
                        {!p.derived && (
                          <label className={`shrink-0 cursor-pointer rounded-md border px-2 py-1 text-[9.5px] font-black transition-colors
                            ${uploading
                              ? 'border-slate-600 bg-slate-700/40 text-slate-400 cursor-wait'
                              : missing
                                ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                                : 'border-slate-600/60 bg-slate-700/20 text-slate-400 hover:text-slate-200'}`}>
                            {uploading
                              ? <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> ...</span>
                              : <span className="flex items-center gap-1"><Paperclip size={11} /> {missing ? 'UPLOAD KAREIN' : 'BADLEIN'}</span>}
                            <input type="file" className="hidden" disabled={!!busy}
                              accept={p.accept || 'image/*,.pdf'}
                              onChange={(e) => onPick(e, open, p)} />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-slate-700/60 px-4 py-2">
              <p className="text-center text-[9px] leading-snug text-slate-500">
                File turant database mein save hoti hai. Scan number aur date khud bhar deta hai —
                sirf khaali field, taaki haath se likha hua kuch mite nahi.
              </p>
            </div>
          </div>
        </div>, document.body)}
    </GlassPanel>
  );
}
