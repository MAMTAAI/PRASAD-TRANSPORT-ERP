// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// MONTH-END SETTLEMENT — one button for the month (migration 175).
// Shows the gate (what blocks the closing), runs the month for a firm, backfills
// April onwards, and lists the settlement slips (PDF) it produced.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../lib/apiBase';
import { API, apiJson, n2, inr, inr2, dmy, C, btn, th, td, tdR, inp, sel, panel, wrap, Pill, fail, ask } from './payrollShared';

const monthPrev = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const SEV = { HIGH: ['BLOCKS CLOSING', C.crit], MEDIUM: ['BLOCKS CLOSING', C.warn] };
const MSTAT = { DRAFT: ['DRAFTED · IN APPROVAL QUEUE', C.warn], BLOCKED: ['BLOCKED', C.crit], CLOSED: ['CLOSED · ALL POSTED', C.good] };

export default function MonthEndPanel({ firm, firms, onChanged, compact = false }) {
  const [period, setPeriod] = useState(monthPrev());
  const [d, setD] = useState(null); const [busy, setBusy] = useState(''); const [hist, setHist] = useState([]); const [routing, setRouting] = useState(null); const [open, setOpen] = useState(!compact);
  const load = useCallback(async () => { if (!firm || !period) return; try { setD(await apiJson(`${API}/month-end?firm=${firm}&period=${period}`)); } catch (e) { setD({ error: e.message }); } try { setHist((await apiJson(`${API}/month-end/history?firm=${firm}`)).rows ?? []); } catch { /* optional */ } try { setRouting(await apiJson(`${API}/routing?status=NEEDS_VOUCHER`)); } catch { /* optional */ } }, [firm, period]);
  useEffect(() => { load(); }, [load]);
  const firmName = (firms ?? []).find((f) => (f.company_id ?? f.id) === firm)?.company_name ?? '';
  const run = async (force = false) => {
    let reason = null;
    if (force) { reason = window.prompt('Override the open blockers? Type the reason (8+ characters). It is recorded on the run and raised on the Exception Desk.'); if (!reason || reason.trim().length < 8) return; }
    else if (!ask(`Draft the monthly settlement for ${firmName} · ${period}?\n\n• every completed trip of the month settled under its driver's model\n• fixed-salary drivers: salary − advances − shortages − challans\n• staff & partners: the month's run\n• driver cash on attached lorries charged to the owners\n• a settlement slip (PDF) for every person\n\nEverything lands in the Approval Queue as DRAFT. Nothing posts until a manager presses Approve & Post.`)) return;
    setBusy('run');
    try {
      const r = await apiJson(`${API}/month-end/run`, { method: 'POST', body: JSON.stringify({ firm, period, force, reason }) });
      const s = r.summary ?? {};
      alert(`📝 ${period} drafted for ${firmName} — open the Approval Queue.\n\nSlips: ${r.slips?.length ?? 0} (${s.pdfs?.rendered ?? 0} PDF)\nAttached-lorry cash routed to owners: ${s.routing?.routed ?? 0}${s.routing?.needs_voucher ? ` (${s.routing.needs_voucher} need a cash voucher first)` : ''}${s.forced ? '\n⚠ drafted with blockers overridden' : ''}`);
      await load(); onChanged?.();
    } catch (e) {
      if (e.code === 'GATE_OPEN') { alert(`⛔ ${e.message}\n\nClear the items below (or override with a reason).`); await load(); }
      else fail(e);
    } finally { setBusy(''); }
  };
  const backfill = async () => {
    if (!ask(`Backfill April 2026 → last month for EVERY firm?\n\nEach month is prepared, gated and closed in turn (a closed month is skipped). Months with open blockers stay BLOCKED for you to clear.`)) return;
    setBusy('backfill');
    try { const r = await apiJson(`${API}/month-end/backfill`, { method: 'POST', body: JSON.stringify({ from: '2026-04' }) }); const c = r.results.filter((x) => x.drafted).length; const b = r.results.filter((x) => x.blocked).length; alert(`📅 ${r.from} → ${r.to}: ${c} month-firm drafts ready for approval, ${b} blocked, ${r.results.filter((x) => x.already_closed).length} already closed.\n\n${r.results.map((x) => `${x.period} ${x.firm}: ${x.drafted ? `drafted (${x.slips} slips)` : x.blocked ? `blocked (${x.blockers})` : x.already_closed ? 'already closed' : x.error ?? '?'}`).join('\n')}`); await load(); onChanged?.(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const routeNow = async () => { setBusy('route'); try { const r = await apiJson(`${API}/routing/run`, { method: 'POST', body: JSON.stringify({}) }); alert(`🔀 ${r.candidates} attached-lorry driver payments looked at: ${r.routed} charged to owners, ${r.needs_voucher} need a cash voucher first, ${r.failed} failed.`); await load(); } catch (e) { fail(e); } finally { setBusy(''); } };
  const R = d?.run; const gate = d?.gate ?? []; const slips = d?.slips ?? [];
  return (
    <div style={{ ...panel, borderColor: R?.status === 'CLOSED' ? 'rgba(47,227,155,.5)' : gate.length ? 'rgba(255,107,129,.5)' : C.line }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ color: C.ink, fontSize: '14px' }}>📅 Month-end settlement</b>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={inp} />
          {R && <Pill s={R.status} map={MSTAT} />}
          {R?.closed_at && <span style={{ fontSize: '11px', color: C.dim }}>closed {dmy(R.closed_at)} by {R.closed_by}{R.forced ? ' · overridden' : ''}</span>}
          {compact && <button onClick={() => setOpen((x) => !x)} style={btn()}>{open ? 'hide' : 'show'}</button>}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button onClick={routeNow} disabled={!!busy} style={btn('cyan', !busy)}>🔀 Route attached-lorry cash{routing?.pending?.n ? ` (${routing.pending.n})` : ''}</button>
          <button onClick={() => run(false)} disabled={!!busy || R?.status === 'CLOSED'} style={btn('solid', !busy && R?.status !== 'CLOSED')}>{busy === 'run' ? '⏳ Drafting…' : '▶ Run Monthly Settlement (draft)'}</button>
          {gate.length > 0 && R?.status !== 'CLOSED' && <button onClick={() => run(true)} disabled={!!busy} style={btn('warn', !busy)}>override with reason</button>}
          <button onClick={backfill} disabled={!!busy} style={btn('ai', !busy)}>{busy === 'backfill' ? '⏳ Backfilling…' : '⏮ Backfill Apr 2026 → last month'}</button>
        </div>
      </div>
      {open && (<>
        {d?.error && <div style={{ color: C.crit, fontSize: '12px', marginTop: '8px' }}>{d.error}</div>}
        {gate.length > 0 && (<div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.crit }}>Exception Desk · {gate.length} blocker{gate.length === 1 ? '' : 's'} before {period} can close</div>
          {gate.map((g, i) => (<div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px', alignItems: 'start', fontSize: '12px', padding: '8px 10px', border: `1px solid ${g.severity === 'HIGH' ? 'rgba(255,107,129,.4)' : 'rgba(255,178,36,.4)'}`, borderRadius: '10px' }}>
            <Pill s={g.severity} map={SEV} /><div><b style={{ color: C.ink }}>{g.title}</b>{g.amount ? <span style={{ color: C.warn }}> · {inr(g.amount)}</span> : null}<div style={{ color: C.mut, marginTop: '2px' }}>Fix: {g.fix}</div></div>
          </div>))}
        </div>)}
        {gate.length === 0 && R?.status !== 'CLOSED' && <div style={{ fontSize: '12px', color: C.good, marginTop: '8px' }}>✓ No blockers — the agent drafts every firm on the 1st at 00:01 IST; Run drafts it now. Approve each slip in the queue below.</div>}
        {R?.status === 'CLOSED' && (<div style={{ fontSize: '12px', color: C.mut, marginTop: '8px' }}>Trips posted {R.settlements_posted} · attached cash routed {R.routed} · slips {R.slips}{R.summary?.runs_posted ? ` · runs: drivers ${R.summary.runs_posted.DRIVER ?? '—'}, staff ${R.summary.runs_posted.STAFF ?? '—'}` : ''}{R.force_reason ? ` · override: ${R.force_reason}` : ''}</div>)}
        {slips.length > 0 && (<div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim, marginBottom: '6px' }}>Settlement slips · {period}</div>
          <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
            <thead><tr><th style={th}>Person</th><th style={th}>Slip</th><th style={{ ...th, textAlign: 'right' }}>Opening</th><th style={{ ...th, textAlign: 'right' }}>Earned</th><th style={{ ...th, textAlign: 'right' }}>Korki</th><th style={{ ...th, textAlign: 'right' }}>Advances</th><th style={{ ...th, textAlign: 'right' }}>Paid</th><th style={{ ...th, textAlign: 'right' }}>Closing</th><th style={th}>PDF</th></tr></thead>
            <tbody>{slips.map((s) => (<tr key={s.id}><td style={{ ...td, color: C.ink, fontWeight: 700 }}>{s.person_name}<div style={{ fontSize: '10px', color: C.dim }}>{s.person_kind}</div></td><td style={td}>{s.kind === 'TRIP' ? `Trip basis · ${s.trips} trips` : s.kind === 'MONTHLY' ? 'Fixed salary' : 'Salary / remuneration'}</td><td style={tdR}>{inr2(s.opening)}</td><td style={{ ...tdR, color: C.good }}>{inr2(s.earned)}</td><td style={tdR}>{inr2(s.korki)}</td><td style={tdR}>{inr2(s.advances)}</td><td style={tdR}>{inr2(s.paid)}</td><td style={{ ...tdR, fontWeight: 800, color: n2(s.closing) === 0 ? C.good : n2(s.closing) > 0 ? C.warn : C.cyan }}>{inr2(s.closing)}{n2(s.closing) === 0 && s.kind === 'TRIP' ? <div style={{ fontSize: '10px', color: C.good, fontWeight: 400 }}>zero balance</div> : null}</td><td style={td}>{s.file_key ? <a href={`${API_BASE}/api/v1/files/${s.file_key}`} target="_blank" rel="noopener" style={{ color: C.cyan }}>⬇ slip</a> : <span style={{ color: C.dim }}>—</span>}</td></tr>))}</tbody></table></div>
        </div>)}
        {hist.length > 0 && (<div style={{ marginTop: '10px', fontSize: '11.5px', color: C.mut }}>History: {hist.map((h) => `${h.period} ${h.status.toLowerCase()}`).join(' · ')}</div>)}
      </>)}
    </div>
  );
}
