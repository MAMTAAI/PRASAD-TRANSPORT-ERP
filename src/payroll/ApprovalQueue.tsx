// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// MANAGER APPROVAL QUEUE — the month's draft settlements, one per person.
// The 1st-of-month agent (and "Run Monthly Settlement") fills it; a manager
// EDITS (manual korki per trip, missed advances, a wrong name), SAVES, PRINTS
// the slip, sends it on WHATSAPP, then APPROVE & POST locks it and posts that
// person's vouchers. Nothing reaches the ledger before that click.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../lib/apiBase';
import { API, apiJson, n2, inr, inr2, dmy, C, btn, th, td, tdR, inp, sel, panel, wrap, Pill, SSTAT, BASIS, fail, ask, AccountPicker } from './payrollShared';

const QSTAT = { DRAFT: ['DRAFT · AWAITING APPROVAL', C.warn], APPROVED: ['APPROVED', C.cyan], POSTED: ['POSTED · LOCKED', C.good], BLOCKED: ['NEEDS ATTENTION', C.crit] };
const monthPrev = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };

export default function ApprovalQueue({ firm, firms, onChanged }) {
  const [period, setPeriod] = useState(monthPrev());
  const [q, setQ] = useState(null); const [open, setOpen] = useState(null); const [busy, setBusy] = useState('');
  const load = useCallback(async () => { if (!firm || !period) return; try { setQ(await apiJson(`${API}/approval-queue?firm=${firm}&period=${period}`)); } catch (e) { setQ({ error: e.message }); } }, [firm, period]);
  useEffect(() => { load(); }, [load]);
  const rows = q?.rows ?? []; const firmName = (firms ?? []).find((f) => (f.company_id ?? f.id) === firm)?.company_name ?? '';
  const approve = async (s) => {
    if (!ask(`Approve & Post ${s.person_name} · ${period}?\n\n${s.kind === 'TRIP' ? `${s.drafts} draft trip settlement(s), net ${inr2(s.net_month)}` : `net payable ${inr2(s.line_net)}`}.\nThe vouchers post now and the slip locks. Cash leaves when the cashier presses Pay.`)) return;
    setBusy(s.id); try { const r = await apiJson(`${API}/slips/${s.id}/approve`, { method: 'POST', body: JSON.stringify({}) }); if (!r.ok) alert(`⚠️ Some items did not post:\n${(r.results ?? []).filter((x) => !x.ok).map((x) => x.detail).join('\n')}`); await load(); onChanged?.(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const approveAll = async () => {
    const n = rows.filter((r) => r.status === 'DRAFT').length; if (!n) return;
    if (!ask(`Approve & Post all ${n} draft slips for ${firmName} · ${period}? Each person's vouchers post and lock.`)) return;
    setBusy('all'); try { const r = await apiJson(`${API}/month-end/approve-all`, { method: 'POST', body: JSON.stringify({ firm, period }) }); alert(`✅ ${r.approved} approved & posted${r.failed.length ? `\n⚠ ${r.failed.length} not posted: ${r.failed.map((f) => `${f.person}: ${f.detail}`).join('; ')}` : ''}`); await load(); onChanged?.(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const print = async (s) => { setBusy(s.id); try { const r = await apiJson(`${API}/slips/${s.id}/render`, { method: 'POST', body: JSON.stringify({}) }); const key = r.slip?.file_key; if (key) window.open(`${API_BASE}/api/v1/files/${key}`, '_blank', 'noopener'); else alert('PDF could not be rendered'); await load(); } catch (e) { fail(e); } finally { setBusy(''); } };
  const wa = async (s) => {
    let mobile = s.mobile; if (!mobile) { mobile = window.prompt(`${s.person_name} has no registered mobile. Enter the WhatsApp number:`); if (!mobile) return; }
    setBusy(s.id); try { const r = await apiJson(`${API}/slips/${s.id}/whatsapp`, { method: 'POST', body: JSON.stringify({ mobile }) }); alert(`📲 Slip sent to ${r.mobile}`); await load(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ ...panel, display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ color: C.ink, fontSize: '14px' }}>✅ Manager Approval Queue</b>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={inp} />
          <span style={{ fontSize: '11.5px', color: C.mut }}>{rows.length} slips · {q?.totals?.drafts ?? 0} awaiting approval · month net {inr(q?.totals?.net)}{q?.run ? ` · drafted ${dmy(q.run.prepared_at)} by ${q.run.prepared_by ?? '—'}` : ' · not drafted yet — run the month or wait for the 1st'}</span>
        </div>
        <button onClick={approveAll} disabled={!!busy || !(q?.totals?.drafts)} style={btn('solid', !busy && !!q?.totals?.drafts)}>{busy === 'all' ? '⏳ Posting…' : '✅ Approve & Post all drafts'}</button>
      </div>
      {q?.error && <div style={{ color: C.crit, fontSize: '12px' }}>{q.error}</div>}
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Person</th><th style={th}>Slip</th><th style={{ ...th, textAlign: 'right' }}>Earned</th><th style={{ ...th, textAlign: 'right' }}>Korki</th><th style={{ ...th, textAlign: 'right' }}>Advances</th><th style={{ ...th, textAlign: 'right' }}>Net</th><th style={th}>Status</th><th style={th}>Actions</th></tr></thead>
        <tbody>
          {rows.length === 0 && !q?.error && <tr><td style={td} colSpan={8}>Nothing in the queue for {period}. The agent drafts every firm on the 1st at 00:01; "Run Monthly Settlement" drafts it now.</td></tr>}
          {rows.map((s) => (<React.Fragment key={s.id}>
            <tr style={{ opacity: s.status === 'POSTED' ? 0.75 : 1 }}>
              <td style={{ ...td, color: C.ink, fontWeight: 700 }}>{s.person_name}<div style={{ fontSize: '10px', color: C.dim }}>{s.person_kind}{s.mobile ? ` · ${s.mobile}` : ' · no mobile'}{s.wa_sent_at ? ` · 📲 sent ${dmy(s.wa_sent_at)}` : ''}</div></td>
              <td style={td}>{s.kind === 'TRIP' ? `Trip basis · ${s.trips} trips${s.blocked ? ` · ${s.blocked} blocked` : ''}` : s.kind === 'MONTHLY' ? 'Fixed salary' : 'Salary / remuneration'}</td>
              <td style={{ ...tdR, color: C.good }}>{inr2(s.earned)}</td><td style={tdR}>{inr2(s.korki)}</td><td style={tdR}>{inr2(s.advances)}</td>
              <td style={{ ...tdR, fontWeight: 800, color: C.ink }}>{inr2(s.kind === 'TRIP' ? s.net_month : s.line_net)}</td>
              <td style={td}><Pill s={s.status} map={QSTAT} />{s.approved_at ? <div style={{ fontSize: '10px', color: C.dim }}>{dmy(s.approved_at)} · {s.approved_by}</div> : null}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                {s.status !== 'POSTED' && <button onClick={() => setOpen(open?.slip?.id === s.id ? null : { loading: true, slip: s })} style={btn('cyan')}>✎ Edit</button>}{' '}
                <button disabled={busy === s.id} onClick={() => print(s)} style={btn()}>🖨 Print</button>{' '}
                <button disabled={busy === s.id} onClick={() => wa(s)} style={btn('good')}>📲 WhatsApp</button>{' '}
                {s.status !== 'POSTED' && <button disabled={busy === s.id || (s.kind === 'TRIP' ? !s.drafts : s.line_status !== 'DRAFT')} onClick={() => approve(s)} style={btn('solid', busy !== s.id && (s.kind === 'TRIP' ? !!s.drafts : s.line_status === 'DRAFT'))}>✅ Approve &amp; Post</button>}
              </td>
            </tr>
            {open?.slip?.id === s.id && <tr><td colSpan={8} style={{ padding: 0 }}><SlipEditor slipId={s.id} firm={firm} onClose={() => setOpen(null)} onChanged={async () => { await load(); onChanged?.(); }} /></td></tr>}
          </React.Fragment>))}
        </tbody></table></div>
    </div>
  );
}

function SlipEditor({ slipId, firm, onClose, onChanged }) {
  const [d, setD] = useState(null); const [name, setName] = useState(''); const [note, setNote] = useState(''); const [mobile, setMobile] = useState(''); const [adv, setAdv] = useState({ amount: '', txn_date: new Date().toISOString().slice(0, 10), trip_id: '', remarks: '', account: '' }); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const r = await apiJson(`${API}/slips/${slipId}`); setD(r); setName(r.slip.person_name); setNote(r.slip.note ?? ''); setMobile(r.slip.mobile ?? ''); } catch (e) { setD({ error: e.message }); } }, [slipId]);
  useEffect(() => { load(); }, [load]);
  const s = d?.slip;
  const save = async () => { setBusy(true); try { await apiJson(`${API}/slips/${slipId}`, { method: 'PATCH', body: JSON.stringify({ note, mobile, person_name: name }) }); await load(); await onChanged(); alert('💾 Saved — the draft stays open until you Approve & Post.'); } catch (e) { fail(e); } finally { setBusy(false); } };
  const saveKorki = async (x, mk, mn) => { setBusy(true); try { await apiJson(`${API}/trip-settlements/${x.id}`, { method: 'PATCH', body: JSON.stringify({ manual_korki: n2(mk), manual_note: mn }) }); await load(); await onChanged(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const addAdvance = async () => {
    if (!(n2(adv.amount) > 0)) return alert('amount?');
    if (!ask(`Add a missed advance of ${inr2(adv.amount)} to ${s.person_name}'s khata dated ${adv.txn_date}${adv.account ? ` and pay it now from ${adv.account}` : ' (khata only — no cash voucher)'}?`)) return;
    setBusy(true); try { await apiJson(`${API}/drivers/${s.person_id}/advance`, { method: 'POST', body: JSON.stringify({ ...adv, trip_id: adv.trip_id || undefined, account: adv.account || undefined }) }); setAdv({ ...adv, amount: '', remarks: '' }); await load(); await onChanged(); } catch (e) { fail(e); } finally { setBusy(false); } };
  if (!d) return <div style={{ padding: '12px', color: C.mut }}>loading…</div>;
  if (d.error) return <div style={{ padding: '12px', color: C.crit }}>{d.error}</div>;
  return (
    <div style={{ ...panel, margin: '6px 10px 10px', borderColor: C.cyan }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px' }}>
        <label style={{ fontSize: '11px', color: C.mut, display: 'grid', gap: '3px' }}>Name (fix a spelling error on the master)<input value={name} onChange={(e) => setName(e.target.value)} style={inp} disabled={s.person_kind !== 'DRIVER'} /></label>
        <label style={{ fontSize: '11px', color: C.mut, display: 'grid', gap: '3px' }}>WhatsApp mobile<input value={mobile} onChange={(e) => setMobile(e.target.value)} style={inp} placeholder="10 digits" /></label>
        <label style={{ fontSize: '11px', color: C.mut, display: 'grid', gap: '3px', gridColumn: 'span 2' }}>Note on the slip<input value={note} onChange={(e) => setNote(e.target.value)} style={inp} placeholder="e.g. Diwali advance recovered in two parts" /></label>
      </div>
      {s.kind === 'TRIP' && (<>
        <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim, margin: '10px 0 6px' }}>Trips of the month · adjust korki per trip</div>
        <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
          <thead><tr><th style={th}>Trip</th><th style={th}>Basis</th><th style={{ ...th, textAlign: 'right' }}>Earning</th><th style={{ ...th, textAlign: 'right' }}>Adv · short · challan</th><th style={{ ...th, textAlign: 'right' }}>Manual korki</th><th style={th}>Why</th><th style={{ ...th, textAlign: 'right' }}>Net</th><th style={th}>Status</th></tr></thead>
          <tbody>{(d.settlements ?? []).map((x) => (<KorkiRow key={x.id} x={x} busy={busy} onSave={saveKorki} />))}</tbody></table></div>
        <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim, margin: '10px 0 6px' }}>Add a missed advance</div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="number" placeholder="₹ amount" value={adv.amount} onChange={(e) => setAdv({ ...adv, amount: e.target.value })} style={{ ...inp, width: '110px' }} />
          <input type="date" value={adv.txn_date} onChange={(e) => setAdv({ ...adv, txn_date: e.target.value })} style={inp} />
          <select value={adv.trip_id} onChange={(e) => setAdv({ ...adv, trip_id: e.target.value })} style={sel}><option value="">— against no particular trip —</option>{(d.settlements ?? []).map((x) => <option key={x.id} value={x.trip_id}>{x.trip_code}</option>)}</select>
          <input placeholder="remarks" value={adv.remarks} onChange={(e) => setAdv({ ...adv, remarks: e.target.value })} style={{ ...inp, width: '200px' }} />
          <AccountPicker firm={firm} value={adv.account} onChange={(v) => setAdv({ ...adv, account: v })} />
          <button disabled={busy} onClick={addAdvance} style={btn('warn', !busy)}>＋ add advance</button>
          <span style={{ fontSize: '11px', color: C.dim }}>with an account it also posts the cash voucher; without, only the khata is corrected</span>
        </div>
        {(d.transactions ?? []).length > 0 && <div style={{ fontSize: '11px', color: C.mut, marginTop: '8px' }}>Khata this month: {(d.transactions ?? []).map((t) => `${dmy(t.txn_date)} ${t.txn_type} ${inr(t.amount)}`).join(' · ')}</div>}
      </>)}
      {s.kind !== 'TRIP' && d.line && (<div style={{ fontSize: '12px', color: C.mut, marginTop: '10px' }}>Run line {d.line.run_no}: gross {inr2(d.line.gross)} − advances {inr2(d.line.deduct_advances)} − shortage/challans {inr2(n2(d.line.deduct_shortage) + n2(d.line.deduct_challans))} − other {inr2(d.line.deduct_other)} = <b style={{ color: C.ink }}>{inr2(d.line.net_payable)}</b> · {d.line.status}. Edit gross / other under Monthly runs.</div>)}
      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '10px' }}><button onClick={onClose} style={btn()}>close</button><button disabled={busy} onClick={save} style={btn('cyan', !busy)}>💾 Save draft</button></div>
    </div>
  );
}

function KorkiRow({ x, busy, onSave }) {
  const [mk, setMk] = useState(x.manual_korki ?? 0); const [mn, setMn] = useState(x.manual_note ?? '');
  const openRow = ['DRAFT', 'BLOCKED'].includes(x.status);
  return (
    <tr>
      <td style={{ ...td, fontFamily: 'monospace', color: C.ink }}>{x.trip_code}<div style={{ fontSize: '10px', color: C.dim, fontFamily: 'inherit' }}>{x.vehicle_no}{x.vehicle_ownership === 'ATTACHED' ? ` · ⚠ attached → owner ${x.owner_name}` : ''}</div></td>
      <td style={td}>{x.basis ? `${BASIS[x.basis] ?? x.basis}${x.rate ? ` ${n2(x.rate)}` : ''}` : '—'}{x.block_reason ? <div style={{ fontSize: '10px', color: C.crit, whiteSpace: 'normal', maxWidth: '200px' }}>{x.block_reason}</div> : null}</td>
      <td style={{ ...tdR, color: C.good }}>{inr2(x.earning)}</td>
      <td style={tdR}>{inr2(n2(x.applied_advances) + n2(x.applied_shortage) + n2(x.applied_challans))}</td>
      <td style={tdR}>{openRow ? <input type="number" value={mk} onChange={(e) => setMk(e.target.value)} style={{ ...inp, width: '90px', textAlign: 'right' }} /> : inr2(x.applied_manual)}</td>
      <td style={td}>{openRow ? <input value={mn} onChange={(e) => setMn(e.target.value)} placeholder="reason" style={{ ...inp, width: '160px' }} /> : (x.manual_note ?? '')}{openRow && (n2(mk) !== n2(x.manual_korki) || mn !== (x.manual_note ?? '')) && <button disabled={busy} onClick={() => onSave(x, mk, mn)} style={{ ...btn('cyan'), marginLeft: '4px' }}>save</button>}</td>
      <td style={{ ...tdR, fontWeight: 800, color: C.ink }}>{inr2(x.net_payable)}</td>
      <td style={td}><Pill s={x.status} map={SSTAT} /></td>
    </tr>
  );
}
