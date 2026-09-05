// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// DRIVER PAYROLL DESK — the "Salary & Settlement" tab of Driver Master.
//
// Owner, 5-Sep-2026: two models per driver. Trip Basis settles the moment a
// trip completes (earning − korki = net, one voucher when approved, paid from
// cash or bank right then); Fixed Salary accumulates deductions and settles
// in the monthly run. Nothing here types an earning: the trip, the route
// master and the driver's configured basis produce it; a person approves.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import { API, apiJson, n2, inr, inr2, dmy, C, btn, chip, th, td, tdR, sel, panel, wrap, Pill, SSTAT, MODEL, BASIS, fail, ask, PayDialog, PayConfigForm } from './payrollShared';

export default function DriverPayrollDesk({ drivers, firms, selectedId, onSelect, children }) {
  const [ov, setOv] = useState(null);
  const [desk, setDesk] = useState(null);
  const [tab, setTab] = useState('INSTANT');
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState('');
  const loadOv = useCallback(async () => { try { setOv(await apiJson(`${API}/overview`)); } catch (e) { setOv({ error: e.message }); } }, []);
  const loadDesk = useCallback(async () => { if (!selectedId) { setDesk(null); return; } try { setDesk(await apiJson(`${API}/drivers/${selectedId}/desk`)); } catch (e) { setDesk({ error: e.message }); } }, [selectedId]);
  useEffect(() => { loadOv(); }, [loadOv]);
  useEffect(() => { loadDesk(); }, [loadDesk]);
  const refresh = async () => { await Promise.all([loadOv(), loadDesk()]); };
  const post = async (s) => {
    if (!ask(`Approve & Post ${s.settlement_no} (${s.trip_code})?\n\nDr Driver Wages ${inr2(s.earning)} · korki ${inr2(n2(s.applied_shortage) + n2(s.applied_challans) + n2(s.applied_advances))} · Cr Driver Payable ${inr2(s.net_payable)}.\nThe liability goes to the books now; the cash leaves when you press Pay.`)) return;
    setBusy(s.id); try { await apiJson(`${API}/trip-settlements/${s.id}/post`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const recompute = async (s) => { setBusy(s.id); try { await apiJson(`${API}/trip-settlements/${s.id}/recompute`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); } catch (e) { fail(e); } finally { setBusy(''); } };
  const cancel = async (s) => { if (!ask(`Cancel ${s.settlement_no}? The trip keeps its data; no pay is created for it.`)) return; setBusy(s.id); try { await apiJson(`${API}/trip-settlements/${s.id}/cancel`, { method: 'POST', body: JSON.stringify({}) }); await refresh(); } catch (e) { fail(e); } finally { setBusy(''); } };
  const audit = async () => { if (!ask('Run the payroll deep audit? It settles every open completed trip under its driver’s model and compares each khata with the ledger. Nothing is posted.')) return; setBusy('audit'); try { const r = await apiJson(`${API}/audit`, { method: 'POST', body: JSON.stringify({}) }); const s = r.summary; alert(`🔎 ${s.trips_settled_now} trips settled · ${s.open?.blocked ?? 0} blocked · ${s.drivers?.unconfigured ?? 0} drivers without a model · ${(s.khata_vs_ledger ?? []).length} khata/ledger differences`); await refresh(); } catch (e) { fail(e); } finally { setBusy(''); } };
  const d = desk?.driver; const S = desk?.settlements ?? []; const T = desk?.totals ?? {};
  const firmRows = ov?.firms ?? [];
  const tot = (k) => firmRows.reduce((a, f) => a + n2(f[k]), 0);

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {/* firm-wide strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
        {[['Drivers on trip basis', tot('drivers_trip'), C.cyan], ['On monthly salary', tot('drivers_monthly'), C.ai], ['No model yet', tot('drivers_unconfigured'), tot('drivers_unconfigured') ? C.crit : C.good], ['Blocked settlements', tot('trip_blocked'), tot('trip_blocked') ? C.crit : C.good], ['Ready to post', inr(tot('trip_draft_net')), C.warn], ['Ready for disbursal', inr(tot('ready_for_disbursal')), C.good]].map(([l, v, c]) => (
          <div key={l} style={panel}><div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>{l}</div><div style={{ fontSize: '22px', fontWeight: 900, color: c }}>{v}</div></div>))}
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value)} style={{ ...sel, minWidth: '260px' }}><option value="">— choose a driver —</option>{drivers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.pay_model ? ` · ${x.pay_model === 'TRIP' ? 'trip basis' : 'monthly'}` : ' · no model'}</option>)}</select>
        <button onClick={audit} disabled={busy === 'audit'} style={btn('ai', busy !== 'audit')}>🔎 Deep audit (settle all open trips)</button>
        {(ov?.unconfigured ?? []).length > 0 && <span style={{ fontSize: '11.5px', color: C.crit }}>⚠ {ov.unconfigured.length} active drivers have no compensation model — {ov.unconfigured.slice(0, 4).map((u) => u.name).join(', ')}{ov.unconfigured.length > 4 ? '…' : ''}</span>}
      </div>

      {!d && <div style={{ ...panel, color: C.mut, fontSize: '13px', padding: '30px', textAlign: 'center' }}>Pick a driver to see the pay model, instant settlements, monthly lines and the khata.</div>}
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 2.2fr', gap: '12px' }}>
          <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
            <div style={{ ...panel, borderColor: d.pay_model ? C.line : C.crit }}>
              <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>Compensation model</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: C.ink, margin: '2px 0 6px' }}>{d.name}</div>
              <div style={{ fontSize: '12.5px', color: d.pay_model ? C.good : C.crit, marginBottom: '8px' }}>{d.pay_model ? MODEL[d.pay_model] : 'Not configured — trips stay BLOCKED'}{d.pay_model === 'TRIP' ? ` · ${BASIS[d.trip_rate_mode]}${d.trip_rate ? ` ${n2(d.trip_rate)}` : ''}` : d.pay_model === 'MONTHLY' ? ` · ${inr(d.monthly_salary)}/month` : ''}{d.pay_company ? ` · pays from ${d.pay_company}` : ''}</div>
              <PayConfigForm driver={d} firms={firmRows} compact onSaved={refresh} />
            </div>
            <div style={panel}>
              <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>Khata</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', fontSize: '12.5px', marginTop: '6px' }}>
                <span style={{ color: C.mut }}>{n2(d.khata_balance) >= 0 ? 'Driver owes (advances not yet recovered)' : 'We owe the driver (earned, not yet paid)'}</span><b style={{ color: n2(d.khata_balance) > 0 ? C.warn : n2(d.khata_balance) < 0 ? C.cyan : C.good }}>{inr2(Math.abs(n2(d.khata_balance)))}</b>
                <span style={{ color: C.mut }}>Settlements blocked</span><b style={{ color: T.blocked ? C.crit : C.ink }}>{T.blocked ?? 0}</b>
                <span style={{ color: C.mut }}>Ready to post (net)</span><b style={{ color: C.warn }}>{inr2(T.draft_net)}</b>
                <span style={{ color: C.mut }}>Posted, waiting for cash</span><b style={{ color: C.cyan }}>{inr2(T.posted_unpaid)}</b>
                <span style={{ color: C.mut }}>Paid</span><b style={{ color: C.good }}>{inr2(T.paid)}</b>
              </div>
            </div>
            {children}
          </div>
          <div style={{ display: 'grid', gap: '10px', alignContent: 'start' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[['INSTANT', `⚡ Instant trip settlements (${S.length})`], ['MONTHLY', `📅 Monthly lines (${(desk?.monthly_lines ?? []).length})`], ['KHATA', `📓 Khata entries (${(desk?.transactions ?? []).length})`]].map((t) => <span key={t[0]} onClick={() => setTab(t[0])} style={chip(tab === t[0])}>{t[1]}</span>)}
            </div>
            {tab === 'INSTANT' && (
              <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
                <thead><tr><th style={th}>Trip</th><th style={th}>Completed</th><th style={th}>Basis</th><th style={{ ...th, textAlign: 'right' }}>Earning</th><th style={{ ...th, textAlign: 'right' }}>Korki</th><th style={{ ...th, textAlign: 'right' }}>Net payable</th><th style={th}>Status</th><th style={th}></th></tr></thead>
                <tbody>
                  {S.length === 0 && <tr><td style={td} colSpan={8}>No completed trips settled for this driver yet.</td></tr>}
                  {S.map((s) => (<tr key={s.id}>
                    <td style={{ ...td, fontFamily: 'monospace', color: C.ink }}>{s.trip_code}<div style={{ fontSize: '10px', color: C.dim, fontFamily: 'inherit' }}>{s.settlement_no} · {s.vehicle_no ?? ''}</div></td>
                    <td style={td}>{dmy(s.completed_at)}</td>
                    <td style={td}>{s.basis ? `${BASIS[s.basis] ?? s.basis}${s.rate ? ` ${n2(s.rate)}` : ''}` : '—'}{s.freight ? <div style={{ fontSize: '10px', color: C.dim }}>freight {inr(s.freight)}{s.rtkm ? ` · ${n2(s.rtkm)} km` : ''}</div> : null}</td>
                    <td style={{ ...tdR, color: C.good }}>{inr2(s.earning)}</td>
                    <td style={tdR}>{inr2(n2(s.applied_shortage) + n2(s.applied_challans) + n2(s.applied_advances))}
                      <div style={{ fontSize: '10px', color: C.dim, textAlign: 'right' }}>{n2(s.korki_advances) ? `adv ${inr(s.korki_advances)} ` : ''}{n2(s.korki_shortage) ? `short ${inr(s.korki_shortage)} ` : ''}{n2(s.korki_challans) ? `challan ${inr(s.korki_challans)} ` : ''}{n2(s.carry_forward) ? <span style={{ color: C.warn }}>· {inr(s.carry_forward)} stays in khata</span> : null}</div></td>
                    <td style={{ ...tdR, color: C.ink, fontWeight: 800 }}>{inr2(s.net_payable)}</td>
                    <td style={td}><Pill s={s.status} map={SSTAT} />{s.status === 'BLOCKED' && <div style={{ fontSize: '10px', color: C.crit, whiteSpace: 'normal', maxWidth: '220px' }}>{s.block_reason}</div>}{s.status === 'PAID' && <div style={{ fontSize: '10px', color: C.dim }}>{dmy(s.paid_on)} · {s.paid_via}</div>}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {s.status === 'DRAFT' && <button disabled={busy === s.id} onClick={() => post(s)} style={btn('good', busy !== s.id)}>✅ Approve &amp; Post</button>}
                      {s.status === 'POSTED' && n2(s.net_payable) > 0 && <button onClick={() => setPay(s)} style={btn('solid')}>💸 Pay</button>}
                      {['DRAFT', 'BLOCKED'].includes(s.status) && <> <button disabled={busy === s.id} onClick={() => recompute(s)} style={btn('cyan')}>↻</button> <button disabled={busy === s.id} onClick={() => cancel(s)} style={btn('crit')}>✕</button></>}
                    </td>
                  </tr>))}
                </tbody></table></div>
            )}
            {tab === 'MONTHLY' && (
              <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
                <thead><tr><th style={th}>Month</th><th style={th}>Run</th><th style={{ ...th, textAlign: 'right' }}>Salary</th><th style={{ ...th, textAlign: 'right' }}>Advances</th><th style={{ ...th, textAlign: 'right' }}>Shortage</th><th style={{ ...th, textAlign: 'right' }}>Challans</th><th style={{ ...th, textAlign: 'right' }}>Net</th><th style={th}>Status</th></tr></thead>
                <tbody>{(desk?.monthly_lines ?? []).length === 0 && <tr><td style={td} colSpan={8}>{d.pay_model === 'MONTHLY' ? 'No monthly run built yet — Accounts & Admin → Staff & Partner Payroll → build the month.' : 'Not on a monthly salary.'}</td></tr>}
                  {(desk?.monthly_lines ?? []).map((l) => <tr key={l.id}><td style={{ ...td, color: C.ink, fontWeight: 700 }}>{l.period}</td><td style={{ ...td, fontFamily: 'monospace' }}>{l.run_no}</td><td style={tdR}>{inr2(l.gross)}</td><td style={tdR}>{inr2(l.deduct_advances)}</td><td style={tdR}>{inr2(l.deduct_shortage)}</td><td style={tdR}>{inr2(l.deduct_challans)}</td><td style={{ ...tdR, fontWeight: 800, color: C.ink }}>{inr2(l.net_payable)}</td><td style={td}><Pill s={l.status} map={SSTAT} /></td></tr>)}
                </tbody></table></div>
            )}
            {tab === 'KHATA' && (
              <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
                <thead><tr><th style={th}>Date</th><th style={th}>Type</th><th style={th}>Trip</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Mode</th><th style={th}>Remarks</th></tr></thead>
                <tbody>{(desk?.transactions ?? []).map((t) => <tr key={t.id}><td style={td}>{dmy(t.txn_date)}</td><td style={td}><span style={{ color: /SALARY/.test(t.txn_type) ? C.good : /SHORTAGE/.test(t.txn_type) ? C.crit : /ADVANCE|PAYMENT_GIVEN|FUEL/.test(t.txn_type) ? C.warn : C.cyan, fontWeight: 700 }}>{t.txn_type}</span></td><td style={{ ...td, fontFamily: 'monospace' }}>{t.trip_code ?? '—'}</td><td style={{ ...tdR, color: /SALARY/.test(t.txn_type) ? C.good : C.ink2 }}>{/SALARY/.test(t.txn_type) ? '+' : '−'}{inr2(t.amount)}</td><td style={td}>{t.mode ?? '—'}</td><td style={{ ...td, whiteSpace: 'normal', color: C.mut, minWidth: '220px' }}>{t.remarks}</td></tr>)}</tbody></table></div>
            )}
          </div>
        </div>
      )}
      {pay && <PayDialog firm={pay.company_id} title={`${pay.trip_code} · ${pay.driver_name}`} amount={pay.net_payable} onClose={() => setPay(null)} onPay={async (account, day) => { await apiJson(`${API}/trip-settlements/${pay.id}/pay`, { method: 'POST', body: JSON.stringify({ account, paid_on: day }) }); await refresh(); }} />}
    </div>
  );
}
