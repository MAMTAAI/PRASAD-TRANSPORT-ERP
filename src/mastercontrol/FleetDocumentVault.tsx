// @ts-nocheck
// ============================================================================
// FLEET DOCUMENT VAULT — one lorry per row, its whole file in the sheet
//
// THIS REPLACES TWO PANELS THAT EACH ANSWERED HALF A QUESTION.
//
//   Master Document Vault      — soonest expiry per document TYPE across the
//                                fleet. Its own source comment admits it:
//                                "useful as a summary, useless for acting,
//                                because it never names the lorry."
//   Compliance Expiry 10-Day   — named the lorry, but only for the one paper
//                                inside the window, and said nothing about the
//                                rest of that vehicle's file.
//
// Stacked, they cost twice the height to still leave you opening another screen
// to act. One row per LORRY makes the thing you read and the thing you act on
// the same object: what is expired, what is due, what has no file at all.
//
// THE FEE IS SHOWN AND NEVER POSTED FROM HERE. 79 document fees totalling
// ₹11,11,030 sit in vehicle_documents with voucher_id NULL — the 2026-08
// Firestore import wrote that table directly and so bypassed
// POST /vehicle-documents, which is the thing that queues the expense_approvals
// row. That money has never reached the cashbook or the P&L. Surfacing it is
// this panel's job; posting eleven lakh of historical expense is the owner's
// decision and belongs in the approval queue, not in a dashboard click.
// ============================================================================
import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FileWarning, ExternalLink, ShieldAlert, CheckCircle2, CircleSlash, Paperclip, Loader2, IndianRupee, CalendarClock } from 'lucide-react';
import { GlassPanel, PanelHeader, PANEL_SHELL, SCROLL_PANE, ROW_CLS, chipCls, TONE_CHIP } from './shared';
import { uploadMedia, slug } from '../lib/uploadMedia';
import { extractDocument } from '../lib/aiScanner';
import { API_BASE } from '../lib/apiBase';

const MASTERS = `${API_BASE}/api/v1/masters`;

/** The six types that also keep a denormalised expiry column on `vehicles`
 *  (DOC_EXPIRY_COL in masters.routes.js). A vehicle missing one of these is
 *  missing something the compliance sweep watches, so they are listed even when
 *  no row exists yet — otherwise "no record" is invisible and reads as "fine". */
const CORE_DOCS = [
  { type: 'fitness', name: 'Fitness Certificate' },
  { type: 'insurance', name: 'Insurance' },
  { type: 'pollution', name: 'PUC' },
  { type: 'home_permit', name: 'Home State Permit' },
  { type: 'national_permit', name: 'National Permit' },
  { type: 'mv_tax', name: 'Road Tax' },
];

const rs = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const dayLabel = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '');

const stateTone = (s) => (s === 'EXPIRED' ? 'red' : s === 'EXPIRING' ? 'amber' : s === 'VALID' ? 'green' : 'slate');
const stateLabel = (d) => {
  if (!d.next_due_date) return 'date nahi hai';
  const n = Number(d.days_to_expiry);
  if (Number.isNaN(n)) return dayLabel(d.next_due_date);
  return n < 0 ? `expired ${Math.abs(n)}d` : n === 0 ? 'aaj expire' : `${n}d left`;
};

/** OCR gives DD-MM-YYYY or ISO; the column wants ISO. Anything else is dropped
 *  rather than guessed at — a wrong expiry date is worse than an empty one. */
function isoDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

export default function FleetDocumentVault({ vault, alerts, history }) {
  const payload = Array.isArray(vault) ? { rows: vault } : (vault ?? {});
  const rows = payload.rows ?? [];

  // The 10-day watch covers LORRIES AND DRIVERS in one feed. That is why the
  // old Compliance panel could be deleted without losing anything: a driver's
  // lapsed licence stops a truck exactly as a lapsed fitness certificate does,
  // and splitting them across two panels only made you check twice.
  const expired = alerts?.expired ?? [];
  const expiring = alerts?.expiring ?? [];
  const hist = history ?? [];

  const [open, setOpen] = useState(null);       // vehicle whose sheet is showing
  const [docs, setDocs] = useState(null);       // its documents, fetched on open
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [watch, setWatch] = useState(null);     // '10din' | 'history' — the overview sheet

  const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('prasad_token') || ''}` });

  const loadDocs = useCallback(async (v) => {
    setDocs(null);
    try {
      const r = await fetch(`${MASTERS}/vehicle-documents?vehicle_id=${encodeURIComponent(v.id)}&limit=200`,
        { headers: authHeaders() });
      const j = await r.json().catch(() => ({}));
      setDocs(j.documents ?? []);
    } catch { setDocs([]); }
  }, []);

  function openSheet(v) { setOpen(v); setNote(null); loadDocs(v); }

  async function onPick(e, v, doc) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(doc.doc_type);
    setNote(null);
    try {
      const ext = (file.name?.match(/\.([A-Za-z0-9]+)$/)?.[1]
        || (file.type === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase();
      const { url } = await uploadMedia(file, `vehicle-docs/${slug(v.vehicle_no)}/${slug(doc.doc_type)}_${Date.now()}.${ext}`);

      // Read BEFORE saving, unlike the driver sheet, because here one POST
      // writes the file and the expiry together — vehicle_documents upserts on
      // (vehicle_id, doc_type), so a second call would be a second write of the
      // same row rather than an addition to it.
      let next_due_date = doc.next_due_date ? String(doc.next_due_date).slice(0, 10) : null;
      let application_no = doc.application_no ?? null;
      let scanned = '';
      try {
        const ex = await extractDocument(file, doc.doc_name || doc.doc_type);
        const iso = isoDate(ex?.expiry_date);
        // Never overwrite a date already on file with an OCR guess.
        if (iso && !next_due_date) { next_due_date = iso; scanned = `expiry ${dayLabel(iso)}`; }
        const num = ex?.document_number ? String(ex.document_number).replace(/[^A-Za-z0-9/-]/g, '').trim() : '';
        if (num && !application_no) { application_no = num; scanned += `${scanned ? ', ' : ''}no. ${num}`; }
      } catch { /* a dead scanner must not cost the upload */ }

      // No `amount` and no `account` are sent, so the route's fee branch never
      // runs and nothing is posted to the ledger from this screen. Deliberate.
      const res = await fetch(`${MASTERS}/vehicle-documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          vehicle_id: v.id, doc_type: doc.doc_type, doc_name: doc.doc_name,
          document_url: url, next_due_date, application_no,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || j.error || `save failed (HTTP ${res.status})`);
      }
      setNote({ tone: 'ok', text: `${doc.doc_name} save ho gaya${scanned ? ` — scan: ${scanned}` : ' — scan se date nahi mili, haath se daal dein'}.` });
      await loadDocs(v);
    } catch (err) {
      setNote({ tone: 'bad', text: `Upload nahi hua: ${err.message}` });
    }
    setBusy(null);
  }

  // Existing rows, plus any core type with no row at all so "no record" is
  // visible rather than absent.
  const sheetDocs = () => {
    const have = docs ?? [];
    const seen = new Set(have.map((d) => d.doc_type));
    const gaps = CORE_DOCS.filter((c) => !seen.has(c.type))
      .map((c) => ({ doc_type: c.type, doc_name: c.name, compliance_state: 'MISSING', next_due_date: null, document_url: null }));
    return [...have, ...gaps];
  };

  return (
    <GlassPanel className={`${PANEL_SHELL} border-red-500/25 shadow-[0_0_30px_rgba(248,113,113,0.06)]`}>
      <PanelHeader
        icon={FileWarning}
        title="Fleet Document Vault"
        accent="text-red-400"
        sub={`${payload.total_vehicles ?? 0} lorries · vehicle-wise`}
        right={
          <div className="flex items-center gap-1.5">
            {/* Same affordance as Loading Activity's 7 DIN: a button that names
                what it opens, rather than a panel that silently is a link. */}
            <button
              onClick={() => setWatch('10din')}
              title="Agle 10 din — gaadi aur driver, dono ke kaagaz"
              className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5
                         text-[9px] font-black text-amber-300 transition-colors hover:bg-amber-500/20">
              <CalendarClock size={10} /> 10 DIN
            </button>
            <a href="?module=OPERATION&screen=DOCS" target="_blank" rel="noopener noreferrer"
              title="Poora Vehicle Documents screen nayi tab mein"
              className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5
                         text-[9px] font-black text-red-300 transition-colors hover:bg-red-500/20">
              <ExternalLink size={10} /> SAB
            </a>
          </div>
        }
      />

      {/* The two numbers that decide the day, as tiles rather than chips — the
          shape Today's Loading Activity uses for exactly the same reason: a
          count you act on should not be the same size as a label. Both count
          LORRIES AND DRIVERS, so nothing is hidden by being the other kind. */}
      <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 shrink-0">
        <button onClick={() => setWatch('10din')}
          className={`rounded-lg border px-2 py-1.5 text-left transition-colors
            ${expired.length ? 'border-red-500/45 bg-red-500/10 hover:bg-red-500/15' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-red-300">
            <ShieldAlert size={10} /> Expired
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{expired.length}</p>
          <p className="text-[9px] text-slate-500">gaadi + driver</p>
        </button>
        <button onClick={() => setWatch('10din')}
          className={`rounded-lg border px-2 py-1.5 text-left transition-colors
            ${expiring.length ? 'border-amber-500/45 bg-amber-500/10 hover:bg-amber-500/15' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-300">
            <CalendarClock size={10} /> Agle 10 din
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{expiring.length}</p>
          <p className="text-[9px] text-slate-500">renew karne hain</p>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 shrink-0">
        <span className={chipCls(payload.with_expired ? 'red' : 'green')}>
          {payload.with_expired ?? 0} <span className="font-normal opacity-70">lorries</span>
        </span>
        {payload.unposted_fees > 0 && (
          <span className={chipCls('amber')} title="Document fees recorded against vehicles that never reached the ledger">
            {rs(payload.unposted_rs)} <span className="font-normal opacity-70">ledger baaki</span>
          </span>
        )}
        {hist.length > 0 && (
          <button onClick={() => setWatch('history')}
            className="text-[9px] font-semibold text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
            history
          </button>
        )}
      </div>

      <div className={SCROLL_PANE}>
        {rows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">No active vehicles on file.</p>
        ) : rows.map((v) => {
          const tone = v.expired ? 'red' : v.expiring ? 'amber' : v.docs === 0 ? 'slate' : 'green';
          return (
            <button key={v.id} type="button" onClick={() => openSheet(v)}
              title={`${v.vehicle_no} — poori file dekhein aur upload karein`}
              className={`${ROW_CLS} items-center w-full text-left hover:border-red-500/40`}>
              <span className={`shrink-0 grid place-items-center w-5 h-5 rounded-md border ${TONE_CHIP[tone]}`}>
                <FileWarning size={11} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-200">{v.vehicle_no}</span>
              {v.expired > 0 && <span className={`${chipCls('red')} shrink-0`}>{v.expired} expired</span>}
              {v.expired === 0 && v.expiring > 0 && <span className={`${chipCls('amber')} shrink-0`}>{v.expiring} due</span>}
              {v.docs === 0 && <span className={`${chipCls('slate')} shrink-0`}>koi file nahi</span>}
              {v.expired === 0 && v.expiring === 0 && v.docs > 0 && <span className={`${chipCls('green')} shrink-0`}>current</span>}
            </button>
          );
        })}
      </div>

      {open && createPortal(
        <div onClick={() => setOpen(null)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className="w-[min(560px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60
                       bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-black text-slate-100">{open.vehicle_no}</p>
                <p className="text-[10px] text-slate-500">
                  {open.docs} document{open.docs === 1 ? '' : 's'} on file
                  <span className="mx-1 text-slate-700">|</span>
                  upload yahin hota hai — page nahi badlega
                </p>
              </div>
              <button onClick={() => setOpen(null)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            {open.unposted_fees > 0 && (
              <p className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/45 bg-amber-500/10 px-2.5 py-1.5
                            text-[10.5px] leading-snug text-amber-200">
                <IndianRupee size={13} className="mt-px shrink-0 text-amber-400" />
                <span>
                  <b>{rs(open.unposted_rs)}</b> ki {open.unposted_fees} fee is gaadi par darj hai par ledger mein nahi gayi.
                  Ye purane (Firestore) record hain — posting approval queue se hogi, yahan se nahi.
                </span>
              </p>
            )}

            {note && (
              <p className={`mx-4 mb-2 rounded-lg border px-2.5 py-1.5 text-[10.5px] leading-snug ${
                note.tone === 'ok' ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200'
                  : 'border-red-500/45 bg-red-500/10 text-red-200'}`}>{note.text}</p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-4 pb-3">
              {docs === null ? (
                <p className="py-4 text-[11px] text-slate-500">Loading…</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {sheetDocs().map((d) => {
                    const missing = d.compliance_state === 'MISSING';
                    const bad = d.compliance_state === 'EXPIRED';
                    const uploading = busy === d.doc_type;
                    return (
                      <div key={d.doc_type}
                        className={`rounded-xl border px-3 py-2 ${bad ? 'border-red-500/45 bg-red-500/[0.07]'
                          : missing ? 'border-slate-700/60 bg-white/[0.02]'
                            : 'border-slate-700/60 bg-white/[0.02]'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {d.document_url
                              ? <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
                              : <CircleSlash size={14} className="shrink-0 text-amber-400" />}
                            <div className="min-w-0">
                              <p className="truncate text-[11.5px] font-bold text-slate-200">{d.doc_name || d.doc_type}</p>
                              <p className="flex flex-wrap items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
                                <span className={chipCls(missing ? 'slate' : stateTone(d.compliance_state))}>
                                  {missing ? 'koi record nahi' : stateLabel(d)}
                                </span>
                                {!d.document_url && !missing && <span className="text-amber-400">file nahi lagi</span>}
                                {d.amount > 0 && (
                                  <span className={d.voucher_id ? 'text-emerald-500/80' : 'text-amber-400'}>
                                    {rs(d.amount)} {d.voucher_id ? 'posted' : 'ledger baaki'}
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {d.document_url && (
                              <a href={d.document_url} target="_blank" rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="rounded-md border border-slate-600/60 bg-slate-700/20 px-2 py-1 text-[9.5px] font-black text-slate-300 hover:text-white">
                                DEKHEIN
                              </a>
                            )}
                            <label className={`cursor-pointer rounded-md border px-2 py-1 text-[9.5px] font-black transition-colors
                              ${uploading ? 'border-slate-600 bg-slate-700/40 text-slate-400 cursor-wait'
                                : 'border-emerald-500/45 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'}`}>
                              {uploading
                                ? <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> ...</span>
                                : <span className="flex items-center gap-1"><Paperclip size={11} /> {d.document_url ? 'BADLEIN' : 'UPLOAD'}</span>}
                              <input type="file" className="hidden" disabled={!!busy}
                                accept="image/*,.pdf" onChange={(e) => onPick(e, open, d)} />
                            </label>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-slate-700/60 px-4 py-2">
              <p className="text-center text-[9px] leading-snug text-slate-500">
                File turant database mein save hoti hai aur expiry date scan se bhar jaati hai — sirf tab jab
                pehle se koi date na ho. Fee aur payment mode poore Vehicle Documents screen se, kyunki wahan
                account chunna padta hai.
              </p>
            </div>
          </div>
        </div>, document.body)}

      {/* ── 10 DIN / History — the fleet-wide view ───────────────────────────
          Two questions asked seconds apart by the same person: "kya expire ho
          raha hai" and "kya hua hai abhi tak". The first is the deleted
          Compliance panel, restored as a sheet and now covering LORRIES AND
          DRIVERS together instead of one panel each. The second had no answer
          anywhere: every panel showed current state, so a document renewed this
          morning looked identical to one untouched since the import. */}
      {watch && createPortal(
        <div onClick={() => setWatch(null)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className="w-[min(620px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60
                       bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
              <div>
                <p className="text-[13px] font-black text-slate-100">Document Watch</p>
                <p className="text-[10px] text-slate-500">
                  {alerts?.threshold_days ?? 10} din ki window · gaadi aur driver dono
                </p>
              </div>
              <button onClick={() => setWatch(null)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            <div className="flex gap-1 px-4 pb-2">
              {[['10din', `Expiry (${expired.length + expiring.length})`], ['history', `History (${hist.length})`]].map(([id, label]) => (
                <button key={id} onClick={() => setWatch(id)}
                  className={`rounded-lg border px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
                    watch === id ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>
                  {label}
                </button>
              ))}
            </div>

            {/* The sweep line: an empty list means "nothing expires soon" AND
                "the background check died three weeks ago", and only its date
                tells them apart. */}
            {watch === '10din' && alerts?.last_sweep && (
              <p className="mx-4 mb-2 text-[9px] text-slate-600">
                Background sweep last ran {String(alerts.last_sweep.ran_on).slice(0, 10)} —
                checked {alerts.last_sweep.checked}, {alerts.last_sweep.expired} expired.
              </p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-4 pb-4">
              {watch === '10din' ? (
                (expired.length + expiring.length) === 0 ? (
                  <p className="py-4 text-[11.5px] text-slate-500">
                    Agle {alerts?.threshold_days ?? 10} din mein kuch expire nahi ho raha.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {[...expired, ...expiring].map((a, i) => {
                      const gone = a.days < 0;
                      return (
                        <div key={`${a.kind}-${a.subject}-${a.doc_type}-${i}`}
                          className={`${ROW_CLS} items-center ${gone ? 'border-red-500/40 bg-red-500/10' : ''}`}>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider
                            ${a.kind === 'DRIVER' ? 'bg-violet-500/20 text-violet-300' : 'bg-cyan-500/20 text-cyan-300'}`}>
                            {a.kind === 'DRIVER' ? 'DRV' : 'VEH'}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[11px] font-bold text-slate-100">{a.subject}</p>
                            <p className="truncate text-[9px] text-slate-500">{a.doc_name}</p>
                          </div>
                          <span className={`${chipCls(gone ? 'red' : 'amber')} shrink-0`}>
                            {gone ? `${Math.abs(a.days)}d expired` : `${a.days}d left`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : hist.length === 0 ? (
                <p className="py-4 text-[11.5px] text-slate-500">Abhi tak koi document update nahi hua.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {hist.map((h, i) => (
                    <div key={`${h.subject}-${h.doc_name}-${i}`} className={`${ROW_CLS} items-center`}>
                      <span className="shrink-0 grid place-items-center w-5 h-5 rounded-md border border-slate-600/50 bg-slate-700/20">
                        {h.has_file ? <CheckCircle2 size={11} className="text-emerald-400" />
                          : <CircleSlash size={11} className="text-amber-400" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-bold text-slate-100">
                          {h.subject} <span className="font-normal text-slate-400">· {h.doc_name}</span>
                        </p>
                        <p className="truncate text-[9px] text-slate-500">
                          {new Date(h.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          {h.next_due_date && <> · valid tak {dayLabel(h.next_due_date)}</>}
                        </p>
                      </div>
                      {h.amount > 0 && (
                        <span className={`${chipCls(h.fee_posted ? 'green' : 'amber')} shrink-0`}>
                          {rs(h.amount)} {h.fee_posted ? '' : 'baaki'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>, document.body)}
    </GlassPanel>
  );
}
