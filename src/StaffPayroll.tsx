// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// STAFF & PARTNER PAYROLL — Accounts & Admin. Office staff salaries and
// partner remuneration / drawings, kept apart from drivers on purpose
// (owner, 5-Sep-2026: "do not mix managers/partners with drivers"). Monthly
// runs per firm: build → check → Approve & Post (liability per person) → Pay
// from a cash or bank ledger. Drivers on a fixed salary run here too (kind
// DRIVER) — their trips never touch this page.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useIsMobile } from './hooks/useIsMobile';
import { API, apiJson, n2, inr, inr2, dmy, C, btn, chip, th, td, tdR, inp, sel, panel, wrap, Pill, SSTAT, RSTAT, fail, ask, PayDialog, AccountPicker } from './payroll/payrollShared';

const KIND = { STAFF: ['STAFF', C.cyan], PARTNER: ['PARTNER', C.gold], DRIVER: ['DRIVER', C.ai] };
const monthNow = () => { const d = new Date(); d.setMonth(d.getMonth() - (d.getDate() < 5 ? 1 : 0)); return d.toISOString().slice(0, 7); };

export default function StaffPayroll() {
  const { isPhone } = useIsMobile();
  const [ov, setOv] = useState(null); const [firm, setFirm] = useState(''); const [tab, setTab] = useState('RUNS'); const [err, setErr] = useState('');
  const load = useCallback(async () => { try { const o = await apiJson(`${API}/overview`); setOv(o); setFirm((f) => f || o.firms?.[0]?.company_id || ''); } catch (e) { setErr(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const firms = ov?.firms ?? []; const F = firms.find((f) => f.company_id === firm);
  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", padding: isPhone ? '12px' : '20px 24px 50px', background: 'radial-gradient(circle at top right, #121c38, #0a1024)', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>Accounts &amp; Admin · Payroll</div>
          <h2 style={{ margin: 0, fontSize: isPhone ? '22px' : '28px', color: '#fff' }}>🧑‍💼 Staff &amp; Partner Payroll</h2>
          {!isPhone && <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '4px', maxWidth: '96ch' }}>Office salaries, partner remuneration and drawings, and the monthly run for salaried drivers. Build the month, check each line, Approve &amp; Post to put the liability in the books, then Pay from a cash or bank ledger — every rupee moves through a voucher, and the Cash &amp; Bank Book shows what is ready for disbursal.</div>}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={firm} onChange={(e) => setFirm(e.target.value)} style={sel}>{firms.map((f) => <option key={f.company_id} value={f.company_id}>{f.company_name}</option>)}</select>
        </div>
      </div>
      {err && <p style={{ color: C.crit, fontSize: '12.5px' }}>{err}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '12px' }}>
        {[['Office staff', F?.staff_active ?? 0, C.cyan], ['Partners', F?.partners_active ?? 0, C.gold], ['Salaried drivers', F?.drivers_monthly ?? 0, C.ai], ['Monthly commitment', inr(F?.staff_monthly_total), C.ink], ['Ready for disbursal', inr(F?.ready_for_disbursal), n2(F?.ready_for_disbursal) ? C.good : C.dim]].map(([l, v, c]) => (
          <div key={l} style={panel}><div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>{l}</div><div style={{ fontSize: '22px', fontWeight: 900, color: c }}>{v}</div></div>))}
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {[['RUNS', '📅 Monthly runs'], ['PEOPLE', '👥 Staff & partners'], ['DISBURSAL', '💸 Ready for disbursal']].map((t) => <span key={t[0]} onClick={() => setTab(t[0])} style={chip(tab === t[0])}>{t[1]}</span>)}
      </div>
      {tab === 'RUNS' && <Runs firm={firm} isPhone={isPhone} onChanged={load} />}
      {tab === 'PEOPLE' && <People firm={firm} firms={firms} isPhone={isPhone} onChanged={load} />}
      {tab === 'DISBURSAL' && <Disbursal firm={firm} onChanged={load} />}
    </div>
  );
}

function Runs({ firm, isPhone, onChanged }) {
  const [rows, setRows] = useState([]); const [period, setPeriod] = useState(monthNow()); const [open, setOpen] = useState(null); const [busy, setBusy] = useState(false); const [payAll, setPayAll] = useState(null); const [payOne, setPayOne] = useState(null);
  const load = useCallback(async () => { if (!firm) return; try { const r = await apiJson(`${API}/runs?firm=${firm}`); setRows(r.rows ?? []); if (open) { const o = await apiJson(`${API}/runs/${open.run.id}`); setOpen(o); } } catch (e) { fail(e); } }, [firm]);
  useEffect(() => { load(); }, [load]);
  const build = async (kind) => { setBusy(true); try { const r = await apiJson(`${API}/runs/build`, { method: 'POST', body: JSON.stringify({ firm, period, kind }) }); setOpen(r); await load(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const openRun = async (id) => { try { setOpen(await apiJson(`${API}/runs/${id}`)); } catch (e) { fail(e); } };
  const editLine = async (l, patch) => { try { setOpen(await apiJson(`${API}/runs/${open.run.id}/lines/${l.id}`, { method: 'PATCH', body: JSON.stringify(patch) })); } catch (e) { fail(e); } };
  const post = async () => {
    const r = open.run; if (!ask(`Approve & Post ${r.run_no}?\n\n${r.persons} people · gross ${inr2(r.gross_total)} · deductions ${inr2(r.deductions_total)} · net ${inr2(r.net_total)}.\nOne journal per person puts the net in "Salary / Remuneration / Driver Payable". Cash leaves when you press Pay.`)) return;
    setBusy(true); try { const o = await apiJson(`${API}/runs/${r.id}/post`, { method: 'POST', body: JSON.stringify({}) }); setOpen(o); if (o.failed?.length) alert(`⚠️ ${o.failed.length} line(s) did not post:\n${o.failed.map((f) => `${f.line}: ${f.detail}`).join('\n')}`); await load(); onChanged?.(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const R = open?.run; const L = open?.lines ?? [];
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ ...panel, display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: '11px', color: C.mut }}>Month <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={inp} /></label>
        <button onClick={() => build('STAFF')} disabled={busy} style={btn('cyan', !busy)}>Build staff &amp; partner run</button>
        <button onClick={() => build('DRIVER')} disabled={busy} style={btn('ai', !busy)}>Build salaried-driver run</button>
        <span style={{ fontSize: '11.5px', color: C.dim }}>A build reads the masters and the advances as of month end; lines a person edited are kept.</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'minmax(260px, 1fr) 2.4fr', gap: '12px' }}>
        <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
          <thead><tr><th style={th}>Run</th><th style={th}>Kind</th><th style={{ ...th, textAlign: 'right' }}>Net</th><th style={th}>Status</th></tr></thead>
          <tbody>{rows.length === 0 && <tr><td style={td} colSpan={4}>No runs for this firm yet.</td></tr>}
            {rows.map((r) => <tr key={r.id} onClick={() => openRun(r.id)} style={{ cursor: 'pointer', background: R?.id === r.id ? 'rgba(34,211,238,.08)' : 'transparent' }}><td style={{ ...td, color: C.ink, fontWeight: 700 }}>{r.period}<div style={{ fontSize: '10px', color: C.dim, fontFamily: 'monospace' }}>{r.run_no}</div></td><td style={td}>{r.kind === 'DRIVER' ? 'salaried drivers' : 'staff & partners'}<div style={{ fontSize: '10px', color: C.dim }}>{r.persons} people</div></td><td style={{ ...tdR, fontWeight: 800 }}>{inr(r.net_total)}</td><td style={td}><Pill s={r.status} map={RSTAT} /></td></tr>)}
          </tbody></table></div>
        <div style={{ display: 'grid', gap: '10px', alignContent: 'start' }}>
          {!R && <div style={{ ...panel, color: C.mut, padding: '30px', textAlign: 'center' }}>Build a month or pick a run.</div>}
          {R && (<>
            <div style={{ ...panel, display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div><div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>{R.company_name} · {R.kind === 'DRIVER' ? 'salaried drivers' : 'staff & partners'}</div><div style={{ fontSize: '18px', fontWeight: 800, color: C.ink }}>{R.period} <span style={{ fontFamily: 'monospace', fontSize: '12px', color: C.dim }}>{R.run_no}</span> <Pill s={R.status} map={RSTAT} /></div>
                <div style={{ fontSize: '12px', color: C.mut }}>gross {inr2(R.gross_total)} · deductions {inr2(R.deductions_total)} · <b style={{ color: C.good }}>net {inr2(R.net_total)}</b>{R.posted_at ? ` · posted ${dmy(R.posted_at)} by ${R.posted_by}` : ''}</div></div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {R.status === 'DRAFT' && <button onClick={post} disabled={busy || !L.some((l) => l.status === 'DRAFT' && n2(l.gross) > 0)} style={btn('good', !busy)}>✅ Approve &amp; Post</button>}
                {L.some((l) => l.status === 'POSTED' && n2(l.net_payable) > 0) && <button onClick={() => setPayAll(R)} style={btn('solid')}>💸 Pay all posted</button>}
              </div>
            </div>
            <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
              <thead><tr><th style={th}>Person</th><th style={{ ...th, textAlign: 'right' }}>Gross</th><th style={{ ...th, textAlign: 'right' }}>Advances</th><th style={{ ...th, textAlign: 'right' }}>Shortage · challans</th><th style={{ ...th, textAlign: 'right' }}>Other</th><th style={{ ...th, textAlign: 'right' }}>Net payable</th><th style={th}>Status</th><th style={th}></th></tr></thead>
              <tbody>{L.length === 0 && <tr><td style={td} colSpan={8}>Nobody on this run — add people under Staff &amp; partners, or set drivers to Fixed Salary in Driver Master.</td></tr>}
                {L.map((l) => (<tr key={l.id} style={{ opacity: l.status === 'SKIPPED' ? 0.45 : 1 }}>
                  <td style={{ ...td, color: C.ink, fontWeight: 700 }}><Pill s={l.person_kind} map={KIND} /> {l.person_name}{l.note ? <div style={{ fontSize: '10px', color: C.crit, whiteSpace: 'normal' }}>{l.note}</div> : null}{n2(l.carry_forward) ? <div style={{ fontSize: '10px', color: C.warn }}>{inr(l.carry_forward)} of deductions carry forward</div> : null}</td>
                  <td style={tdR}>{l.status === 'DRAFT' ? <input type="number" defaultValue={l.gross} onBlur={(e) => { if (n2(e.target.value) !== n2(l.gross)) editLine(l, { gross: n2(e.target.value) }); }} style={{ ...inp, width: '110px', textAlign: 'right' }} /> : inr2(l.gross)}</td>
                  <td style={tdR}>{inr2(l.deduct_advances)}</td><td style={tdR}>{inr2(n2(l.deduct_shortage) + n2(l.deduct_challans))}</td>
                  <td style={tdR}>{l.status === 'DRAFT' ? <input type="number" defaultValue={l.deduct_other} onBlur={(e) => { if (n2(e.target.value) !== n2(l.deduct_other)) editLine(l, { deduct_other: n2(e.target.value) }); }} style={{ ...inp, width: '90px', textAlign: 'right' }} /> : inr2(l.deduct_other)}</td>
                  <td style={{ ...tdR, fontWeight: 800, color: C.ink }}>{inr2(l.net_payable)}</td>
                  <td style={td}><Pill s={l.status} map={SSTAT} />{l.paid_on ? <div style={{ fontSize: '10px', color: C.dim }}>{dmy(l.paid_on)} · {l.paid_via}</div> : null}</td>
                  <td style={td}>{l.status === 'DRAFT' && <button onClick={() => editLine(l, { skip: true })} style={btn()}>skip</button>}{l.status === 'SKIPPED' && <button onClick={() => editLine(l, { skip: false })} style={btn('cyan')}>include</button>}{l.status === 'POSTED' && n2(l.net_payable) > 0 && <button onClick={() => setPayOne(l)} style={btn('solid')}>💸 Pay</button>}</td>
                </tr>))}
              </tbody></table></div>
          </>)}
        </div>
      </div>
      {payAll && <PayDialog firm={firm} title={`${payAll.run_no} · every posted line`} amount={L.filter((l) => l.status === 'POSTED').reduce((s, l) => s + n2(l.net_payable), 0)} onClose={() => setPayAll(null)} onPay={async (account, day) => { const o = await apiJson(`${API}/runs/${payAll.id}/pay`, { method: 'POST', body: JSON.stringify({ account, paid_on: day }) }); setOpen(o); const bad = (o.results ?? []).filter((r) => !r.ok); if (bad.length) alert(`⚠️ ${bad.length} not paid:\n${bad.map((b) => `${b.line}: ${b.detail}`).join('\n')}`); await load(); onChanged?.(); }} />}
      {payOne && <PayDialog firm={firm} title={`${payOne.person_name} · ${R?.period}`} amount={payOne.net_payable} onClose={() => setPayOne(null)} onPay={async (account, day) => { await apiJson(`${API}/disbursal/pay`, { method: 'POST', body: JSON.stringify({ source: 'MONTHLY', ref_id: payOne.id, account, paid_on: day }) }); setOpen(await apiJson(`${API}/runs/${R.id}`)); await load(); onChanged?.(); }} />}
    </div>
  );
}

function People({ firm, firms, isPhone, onChanged }) {
  const [rows, setRows] = useState([]); const [form, setForm] = useState(null); const [txn, setTxn] = useState(null); const [account, setAccount] = useState('');
  const load = useCallback(async () => { if (!firm) return; try { setRows((await apiJson(`${API}/staff?firm=${firm}`)).rows ?? []); } catch (e) { fail(e); } }, [firm]);
  useEffect(() => { load(); }, [load]);
  const blank = { kind: 'STAFF', name: '', role_title: '', mobile: '', pan_no: '', bank_name: '', account_no: '', ifsc_code: '', monthly_amount: '', join_date: '' };
  const save = async () => {
    try {
      if (form.id) await apiJson(`${API}/staff/${form.id}`, { method: 'PATCH', body: JSON.stringify(form) });
      else await apiJson(`${API}/staff`, { method: 'POST', body: JSON.stringify({ ...form, company_id: firm }) });
      setForm(null); await load(); onChanged?.();
    } catch (e) { fail(e); }
  };
  const leave = async (s) => { if (!ask(`${s.name} has left? The row stays for history; no new runs include them.`)) return; try { await apiJson(`${API}/staff/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'LEFT' }) }); await load(); onChanged?.(); } catch (e) { fail(e); } };
  const postTxn = async () => {
    const t = txn; if (!(n2(t.amount) > 0)) return alert('amount?');
    if (t.txn_type !== 'OTHER_DEDUCTION' && !account) return alert('pick the account the cash leaves from');
    try { await apiJson(`${API}/staff/${t.staff.id}/txn`, { method: 'POST', body: JSON.stringify({ txn_type: t.txn_type, amount: n2(t.amount), account: account || undefined, remarks: t.remarks, txn_date: t.txn_date }) }); setTxn(null); await load(); onChanged?.(); } catch (e) { fail(e); }
  };
  const L = ({ l, children }) => <label style={{ fontSize: '11px', color: C.mut, display: 'grid', gap: '3px' }}>{l}{children}</label>;
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}><button onClick={() => setForm({ ...blank })} style={btn('cyan')}>＋ Add staff member</button><button onClick={() => setForm({ ...blank, kind: 'PARTNER', role_title: 'Partner' })} style={btn('gold')}>＋ Add partner</button></div>
      {form && (<div style={{ ...panel, borderColor: C.cyan }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px' }}>
          <L l="Kind"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={sel} disabled={!!form.id}><option value="STAFF">Office staff</option><option value="PARTNER">Partner</option></select></L>
          <L l="Name *"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inp} /></L>
          <L l="Role / designation"><input value={form.role_title ?? ''} onChange={(e) => setForm({ ...form, role_title: e.target.value })} style={inp} /></L>
          <L l={form.kind === 'PARTNER' ? 'Monthly remuneration (₹)' : 'Monthly salary (₹)'}><input type="number" value={form.monthly_amount} onChange={(e) => setForm({ ...form, monthly_amount: e.target.value })} style={inp} /></L>
          <L l="Mobile"><input value={form.mobile ?? ''} onChange={(e) => setForm({ ...form, mobile: e.target.value })} style={inp} /></L>
          <L l="PAN"><input value={form.pan_no ?? ''} onChange={(e) => setForm({ ...form, pan_no: e.target.value.toUpperCase() })} style={{ ...inp, fontFamily: 'monospace' }} /></L>
          <L l="Bank"><input value={form.bank_name ?? ''} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} style={inp} /></L>
          <L l="Account no"><input value={form.account_no ?? ''} onChange={(e) => setForm({ ...form, account_no: e.target.value })} style={inp} /></L>
          <L l="IFSC"><input value={form.ifsc_code ?? ''} onChange={(e) => setForm({ ...form, ifsc_code: e.target.value.toUpperCase() })} style={{ ...inp, fontFamily: 'monospace' }} /></L>
          <L l="Joined"><input type="date" value={form.join_date ?? ''} onChange={(e) => setForm({ ...form, join_date: e.target.value })} style={inp} /></L>
        </div>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '8px' }}><button onClick={() => setForm(null)} style={btn()}>cancel</button><button onClick={save} style={btn('solid')}>Save</button></div>
      </div>)}
      {txn && (<div style={{ ...panel, borderColor: C.warn }}>
        <b style={{ color: C.ink }}>{txn.staff.name} · {txn.txn_type === 'DRAWING' ? 'Drawings (Dr Partner Capital / Cr cash or bank)' : txn.txn_type === 'ADVANCE_GIVEN' ? 'Advance (recovered from the next salary)' : 'Other deduction this month'}</b>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px', marginTop: '8px' }}>
          <L l="Amount (₹)"><input type="number" value={txn.amount} onChange={(e) => setTxn({ ...txn, amount: e.target.value })} style={inp} /></L>
          <L l="Date"><input type="date" value={txn.txn_date} onChange={(e) => setTxn({ ...txn, txn_date: e.target.value })} style={inp} /></L>
          {txn.txn_type !== 'OTHER_DEDUCTION' && <L l="From account"><AccountPicker firm={firm} value={account} onChange={setAccount} /></L>}
          <L l="Remarks"><input value={txn.remarks} onChange={(e) => setTxn({ ...txn, remarks: e.target.value })} style={inp} /></L>
        </div>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '8px' }}><button onClick={() => setTxn(null)} style={btn()}>cancel</button><button onClick={postTxn} style={btn('solid')}>Post</button></div>
      </div>)}
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Person</th><th style={th}>Role</th><th style={{ ...th, textAlign: 'right' }}>Monthly</th><th style={{ ...th, textAlign: 'right' }}>Advance balance</th><th style={{ ...th, textAlign: 'right' }}>Drawings</th><th style={th}>Bank</th><th style={th}>Status</th><th style={th}></th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td style={td} colSpan={8}>Nobody yet for this firm. Add the office staff and the partners.</td></tr>}
          {rows.map((s) => (<tr key={s.id} style={{ opacity: s.status === 'LEFT' ? 0.5 : 1 }}>
            <td style={{ ...td, color: C.ink, fontWeight: 700 }}><Pill s={s.kind} map={KIND} /> {s.name}<div style={{ fontSize: '10px', color: C.dim }}>{s.mobile ?? ''}{s.pan_no ? ` · ${s.pan_no}` : ''}</div></td>
            <td style={td}>{s.role_title ?? '—'}</td><td style={tdR}>{inr(s.monthly_amount)}</td><td style={{ ...tdR, color: n2(s.balance) > 0 ? C.warn : C.ink2 }}>{inr(s.balance)}</td><td style={tdR}>{s.kind === 'PARTNER' ? inr(s.drawings_total) : '—'}</td>
            <td style={{ ...td, fontSize: '11px', color: C.mut }}>{s.bank_name ?? '—'}{s.account_no ? ` · ${s.account_no}` : ''}{s.ifsc_code ? ` · ${s.ifsc_code}` : ''}</td>
            <td style={td}><Pill s={s.status} map={{ ACTIVE: ['ACTIVE', C.good], LEFT: ['LEFT', C.dim] }} /></td>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{s.status === 'ACTIVE' && (<>
              <button onClick={() => setForm({ ...s })} style={btn('cyan')}>✎</button> <button onClick={() => setTxn({ staff: s, txn_type: 'ADVANCE_GIVEN', amount: '', remarks: '', txn_date: new Date().toISOString().slice(0, 10) })} style={btn('warn')}>advance</button> {s.kind === 'PARTNER' && <button onClick={() => setTxn({ staff: s, txn_type: 'DRAWING', amount: '', remarks: '', txn_date: new Date().toISOString().slice(0, 10) })} style={btn('gold')}>drawing</button>} <button onClick={() => setTxn({ staff: s, txn_type: 'OTHER_DEDUCTION', amount: '', remarks: '', txn_date: new Date().toISOString().slice(0, 10) })} style={btn()}>deduction</button> <button onClick={() => leave(s)} style={btn('crit')}>left</button>
            </>)}</td>
          </tr>))}
        </tbody></table></div>
    </div>
  );
}

export function Disbursal({ firm, onChanged, compact = false }) {
  const [d, setD] = useState(null); const [pay, setPay] = useState(null);
  const load = useCallback(async () => { try { setD(await apiJson(`${API}/disbursal${firm ? `?firm=${firm}` : ''}`)); } catch (e) { setD({ error: e.message }); } }, [firm]);
  useEffect(() => { load(); }, [load]);
  const rows = d?.rows ?? [];
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <b style={{ color: C.ink }}>💸 Ready for disbursal · {rows.length} payable{rows.length === 1 ? '' : 's'} · <span style={{ color: C.good }}>{inr2(d?.total)}</span></b>
        <span style={{ fontSize: '11px', color: C.dim }}>Approved &amp; posted, not yet paid. Paying posts the PAYMENT voucher from the account you pick.</span>
      </div>
      {rows.length > 0 && (<div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>For</th><th style={th}>Person</th><th style={th}>Firm</th><th style={th}>Payable ledger</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Posted</th><th style={th}></th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.ref_id}><td style={{ ...td, fontFamily: 'monospace' }}>{r.source === 'TRIP' ? `trip ${r.about}` : r.about}<div style={{ fontSize: '10px', color: C.dim, fontFamily: 'inherit' }}>{r.ref_no}</div></td><td style={{ ...td, color: C.ink, fontWeight: 700 }}>{r.person_name}</td><td style={{ ...td, color: C.mut }}>{r.company_name ?? '—'}</td><td style={{ ...td, color: C.mut }}>{r.payable_ledger}</td><td style={{ ...tdR, fontWeight: 800, color: C.good }}>{inr2(r.amount)}</td><td style={td}>{dmy(r.posted_at)}</td><td style={td}><button onClick={() => setPay(r)} style={btn('solid')}>💸 Pay</button></td></tr>))}</tbody></table></div>)}
      {pay && <PayDialog firm={pay.company_id} title={`${pay.person_name} · ${pay.source === 'TRIP' ? `trip ${pay.about}` : pay.about}`} amount={pay.amount} onClose={() => setPay(null)} onPay={async (account, day) => { await apiJson(`${API}/disbursal/pay`, { method: 'POST', body: JSON.stringify({ source: pay.source, ref_id: pay.ref_id, account, paid_on: day }) }); await load(); onChanged?.(); }} />}
    </div>
  );
}
