// @ts-nocheck
// ============================================================================
// FEE APPROVAL QUEUE — the ₹10.66 lakh that never reached the cashbook
//
// 75 vehicle documents carry a fee and a scanned certificate, and not one has a
// voucher. The 2026-08 Firestore import wrote vehicle_documents directly and so
// skipped POST /vehicle-documents, which is the call that queues the expense for
// approval. Until now that money was a chip on the vault panel — a fine way to
// be reminded and no way to act.
//
// IT POSTS NOTHING ITSELF. Two existing, audited routes do the work and this
// only chains them:
//
//   1. POST /masters/vehicle-documents  — re-saves the SAME document with its
//      own amount plus the chosen account, which creates the expense_approvals
//      row on the deterministic VEHDOC- reference. Re-running converges on one
//      queued expense instead of a second copy.
//   2. POST /approvals/expense_approvals/:id/approve — runs postOnApproval,
//      which re-derives whose cost it is, posts the double entry through TARA
//      and locks the row.
//
// Writing a third money path here would mean a second opinion about who owes
// what, and the attached-vehicle rule is exactly where that goes wrong: a fee
// on somebody else's lorry belongs in his khata, not the company P&L. Step 2
// already knows that. This screen must not learn it separately.
//
// THE ACCOUNT IS MANDATORY, and not merely as a form rule. postOnApproval
// throws NO_ACCOUNT without one, because a payment that does not say which bank
// or cash it left is half an entry. The button stays disabled until one is
// picked, so the refusal never has to be shown.
// ============================================================================
import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { IndianRupee, ShieldAlert, Loader2, CheckCircle2, FileWarning, ExternalLink } from 'lucide-react';
import { GlassPanel, PanelHeader, PANEL_SHELL, SCROLL_PANE, ROW_CLS, chipCls, TONE_CHIP } from './shared';
import { API_BASE } from '../lib/apiBase';

const MASTERS = `${API_BASE}/api/v1/masters`;
const FIN = `${API_BASE}/api/v1/finance`;
const GOV = `${API_BASE}/api/v1`;

const rs = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const dayLabel = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`)
  .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');

/** `embedded` renders the list and its sheet WITHOUT the panel shell, so the
 *  Fleet Document Vault can show it under a tab. The paperwork and the money it
 *  cost are the same subject seen twice, and two stacked panels made you scroll
 *  between them; a tab keeps both a click apart in the same box. */
export default function FeeApprovalQueue({ fees, onDone, embedded = false }) {
  const payload = Array.isArray(fees) ? { rows: fees } : (fees ?? {});
  const [rows, setRows] = useState(payload.rows ?? []);
  useEffect(() => { setRows(payload.rows ?? []); }, [payload.rows]);

  const [open, setOpen] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const auth = () => ({ Authorization: `Bearer ${localStorage.getItem('prasad_token') || ''}` });

  const loadAccounts = useCallback(async () => {
    try {
      const j = await fetch(`${FIN}/accounts`, { headers: auth() }).then((r) => r.json());
      setAccounts(j.accounts ?? []);
    } catch { setAccounts([]); }
  }, []);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  function openSheet(f) { setOpen(f); setAccount(''); setNote(null); }

  async function approve() {
    if (!open || !account) return;
    setBusy(true);
    setNote(null);
    try {
      // 1 — queue it, by re-saving the document with the account named. Sending
      // the amount it already carries, never a new one: this screen approves a
      // recorded fee, it does not get to change what was spent.
      const queued = await fetch(`${MASTERS}/vehicle-documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({
          vehicle_id: open.vehicle_id,
          doc_type: open.doc_type,
          doc_name: open.doc_name,
          amount: open.amount,
          account,
          receipt_no: open.receipt_no ?? null,
          application_no: open.application_no ?? null,
          inspected_on: open.inspected_on ? String(open.inspected_on).slice(0, 10) : null,
          next_due_date: open.next_due_date ? String(open.next_due_date).slice(0, 10) : null,
        }),
      });
      const qj = await queued.json().catch(() => ({}));
      if (!queued.ok) throw new Error(qj.detail || qj.error || `queue failed (HTTP ${queued.status})`);
      const expenseId = qj.pending_expense_id;
      if (!expenseId) {
        // Already posted is a success, not a failure — say which happened.
        if (qj.voucher_id) { setNote({ tone: 'ok', text: 'Ye fee pehle se ledger mein post ho chuki hai.' }); setBusy(false); return; }
        throw new Error('no expense was queued — nothing to approve');
      }

      // 2 — approve it. postOnApproval re-derives company vs attached owner and
      // posts through TARA; the account rides as an edit so the value that gets
      // locked is the one just chosen.
      const appr = await fetch(`${GOV}/approvals/expense_approvals/${expenseId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({ edits: { pay_account: account } }),
      });
      const aj = await appr.json().catch(() => ({}));
      if (!appr.ok) throw new Error(aj.detail || aj.error || `approve failed (HTTP ${appr.status})`);

      setNote({ tone: 'ok', text: `${rs(open.amount)} ledger mein post ho gaya — ${account}.` });
      setRows((r) => r.filter((x) => x.id !== open.id));
      setTimeout(() => { setOpen(null); onDone?.(); }, 1200);
    } catch (e) {
      setNote({ tone: 'bad', text: e.message });
    }
    setBusy(false);
  }

  const total = rows.reduce((n, r) => n + Number(r.amount || 0), 0);

  const body = (
    <>
      {!embedded && <PanelHeader
        icon={IndianRupee}
        title="Fee Approval Queue"
        accent="text-amber-400"
        sub="document fees waiting for the cashbook"
        right={
          <a href="?module=ACCOUNTS&screen=ACCT_DECK" target="_blank" rel="noopener noreferrer"
            title="Accounts deck nayi tab mein"
            className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5
                       text-[9px] font-black text-amber-300 transition-colors hover:bg-amber-500/20">
            <ExternalLink size={10} /> LEDGER
          </a>
        }
      />}

      <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 shrink-0">
        <div className={`rounded-lg border px-2 py-1.5 ${rows.length ? 'border-amber-500/45 bg-amber-500/10' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-300">
            <IndianRupee size={10} /> Ledger baaki
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{rs(total)}</p>
          <p className="text-[9px] text-slate-500">{rows.length} fees</p>
        </div>
        <div className="rounded-lg border border-slate-700/60 bg-white/[0.02] px-2 py-1.5">
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-300">
            <CheckCircle2 size={10} /> Kagaz ke saath
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">
            {rows.filter((r) => r.has_file).length}
          </p>
          <p className="text-[9px] text-slate-500">scan file lagi hui</p>
        </div>
      </div>

      <div className={SCROLL_PANE}>
        {rows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            Koi fee baaki nahi — sab ledger mein ja chuki hain.
          </p>
        ) : rows.map((f) => (
          <button key={f.id} type="button" onClick={() => openSheet(f)}
            title={`${f.vehicle_no} — ${f.doc_name} — approve karein`}
            className={`${ROW_CLS} items-center w-full text-left hover:border-amber-500/40`}>
            <span className={`shrink-0 grid place-items-center w-5 h-5 rounded-md border ${TONE_CHIP[f.has_file ? 'amber' : 'slate']}`}>
              <FileWarning size={11} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-bold text-slate-200">
                {f.vehicle_no} <span className="font-normal text-slate-400">· {f.doc_name}</span>
              </p>
              <p className="truncate text-[9px] text-slate-500">
                {dayLabel(f.inspected_on)}
                {f.receipt_no && <> · receipt {f.receipt_no}</>}
                {!f.has_file && <span className="text-slate-600"> · koi file nahi</span>}
              </p>
            </div>
            <span className={`${chipCls('amber')} shrink-0`}>{rs(f.amount)}</span>
          </button>
        ))}
      </div>

    </>
  );

  const sheet = (
    <>
      {open && createPortal(
        <div onClick={() => !busy && setOpen(null)}
          className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
          <div onClick={(e) => e.stopPropagation()}
            className="w-[min(480px,100%)] max-h-[calc(100vh-48px)] flex flex-col rounded-2xl border border-slate-700/60
                       bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-black text-slate-100">{open.vehicle_no}</p>
                <p className="text-[10px] text-slate-500">{open.doc_name}</p>
              </div>
              <button onClick={() => !busy && setOpen(null)}
                className="text-slate-500 hover:text-slate-300 leading-none text-xl">×</button>
            </div>

            <div className="px-4 pb-2">
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2.5">
                <p className="text-[9px] font-black uppercase tracking-wider text-amber-300">Fee</p>
                <p className="text-[24px] font-black leading-tight text-slate-100">{rs(open.amount)}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9.5px] text-slate-400">
                  <span>date {dayLabel(open.inspected_on)}</span>
                  {open.receipt_no && <span>receipt {open.receipt_no}</span>}
                  <span className={open.has_file ? 'text-emerald-400' : 'text-slate-600'}>
                    {open.has_file ? 'scan file lagi hui hai' : 'koi file nahi'}
                  </span>
                </p>
              </div>
            </div>

            {/* Attached lorries are the case that goes wrong quietly, so it is
                said before the button rather than discovered in the P&L. */}
            {!open.is_company_owned && (
              <p className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5
                            text-[10.5px] leading-snug text-cyan-200">
                <ShieldAlert size={13} className="mt-px shrink-0 text-cyan-400" />
                Ye attached gaadi hai — kharcha maalik ke khata mein jayega, company P&amp;L mein nahi.
              </p>
            )}

            <div className="px-4 pb-2">
              <label className="mb-1 block text-[9px] font-black uppercase tracking-wider text-slate-400">
                Paisa kahan se gaya? <span className="text-red-400">*</span>
              </label>
              <select value={account} onChange={(e) => setAccount(e.target.value)} disabled={busy}
                className="w-full rounded-lg border border-slate-700/60 bg-slate-950/60 px-2.5 py-2 text-[12px] text-slate-200 outline-none
                           focus:border-amber-500/60">
                <option value="">— account chunein —</option>
                {accounts.map((a) => (
                  <option key={a.ledger_name} value={a.ledger_name}>
                    {a.ledger_name} ({a.group_head}) — {rs(a.balance)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[9px] leading-snug text-slate-500">
                Bina account ke entry aadhi rehti hai, isliye ye zaroori hai — koi default nahi lagaya jaata.
              </p>
            </div>

            {note && (
              <p className={`mx-4 mb-2 rounded-lg border px-2.5 py-1.5 text-[10.5px] leading-snug ${
                note.tone === 'ok' ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200'
                  : 'border-red-500/45 bg-red-500/10 text-red-200'}`}>{note.text}</p>
            )}

            <div className="border-t border-slate-700/60 px-4 py-3">
              <button onClick={approve} disabled={!account || busy}
                className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-[11.5px] font-black transition-colors
                  ${!account || busy
                    ? 'cursor-not-allowed border-slate-700/60 bg-slate-800/40 text-slate-500'
                    : 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'}`}>
                {busy ? <><Loader2 size={13} className="animate-spin" /> post ho raha hai…</>
                  : <><CheckCircle2 size={13} /> Approve &amp; Post to Ledger</>}
              </button>
              <p className="mt-1.5 text-center text-[9px] leading-snug text-slate-500">
                Double entry TARA se post hoti hai aur row lock ho jaati hai. Badalna ho to
                reversing entry karni padegi — isliye account theek se chunein.
              </p>
            </div>
          </div>
        </div>, document.body)}
    </>
  );

  if (embedded) return (<>{body}{sheet}</>);

  return (
    <GlassPanel className={`${PANEL_SHELL} border-amber-500/25 shadow-[0_0_30px_rgba(245,158,11,0.06)]`}>
      {body}{sheet}
    </GlassPanel>
  );
}
