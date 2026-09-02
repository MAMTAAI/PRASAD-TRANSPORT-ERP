// @ts-nocheck
// ============================================================================
// FLEET MAINTENANCE HUB — the odometer this fleet does not have
//
// WHAT THE DATA ACTUALLY SAID, checked before a line of this was written:
//   · `vehicles` has NO odometer column — not one, anywhere;
//   · `maintenance_logs` held ZERO rows. All 49 lorries, no service history;
//   · but `trips` know: 825 of 998 carry rtkm, 3,63,892 km of it.
//
// So the reading is computed, never typed:
//
//     effective odometer = reading at the last logged service
//                        + Σ rtkm of every trip loaded since that date
//
// and the ⚡ badge on every row says so, because a kilometre figure nobody
// entered has to admit where it came from.
//
// THE FIRST TERM IS THE ONE THING THIS SCREEN CANNOT COMPUTE. With no service
// log there is no baseline, and inventing one would put a servicing schedule
// for 49 trucks on top of a number nobody measured. So the panel opens as a
// WORKLIST: it shows the lorry, the distance it has run inside the ERP, and a
// SET BASELINE button. One reading per lorry and that lorry tracks itself for
// ever after. That is the same "surface it, do not fix it quietly" rule the
// document vault follows with its unposted fees.
//
// THE READING IS A FLOOR, NOT A TOTAL, wherever a trip in the window has no
// rtkm — 173 of them do not. Rows say "+N trips ka km darj nahi" rather than
// letting a truck drift towards its service behind an under-count.
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Wrench, Zap, AlertTriangle, Gauge, Loader2, ExternalLink,
  CheckCircle2, CalendarClock, Settings2,
} from 'lucide-react';
import { GlassPanel, PanelHeader, PANEL_SHELL, SCROLL_PANE, ROW_CLS, chipCls } from './shared';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1/assets`;
const authHeaders = () => {
  const token = localStorage.getItem('prasad_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Three services, three clocks — the owner's own intervals (migration 124):
// oil 40,000 km, greasing 10,000 km, tyre rotation 15,000 km. Greasing came out
// of the engine bucket when it got its own cadence; at 10,000 km it comes round
// four times per oil change, and sharing a bucket would let one greasing log
// reset the oil clock.
const TABS = [
  ['ENGINE_OIL', 'Engine / Oil'],
  ['GREASING', 'Greasing'],
  ['TYRES_SPARES', 'Tyres'],
];

const STATE = {
  CRITICAL:    { tone: 'red',    dot: '🔴', label: 'CRITICAL',    hint: 'interval paar ho chuka' },
  DUE_SOON:    { tone: 'amber',  dot: '🟡', label: 'DUE SOON',    hint: 'limit ke paas' },
  HEALTHY:     { tone: 'green',  dot: '🟢', label: 'HEALTHY',     hint: 'abhi theek' },
  NO_BASELINE: { tone: 'slate',  dot: '⚪', label: 'NO BASELINE', hint: 'koi service log nahi' },
  NO_ODOMETER: { tone: 'slate',  dot: '⚪', label: 'NO READING',  hint: 'log hai, odometer nahi' },
  NO_INTERVAL: { tone: 'slate',  dot: '⚪', label: 'NO INTERVAL', hint: 'interval set nahi' },
};

const km = (v) => (v === null || v === undefined || v === ''
  ? '—'
  : Math.round(Number(v)).toLocaleString('en-IN'));
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');

export default function FleetMaintenanceHub({ filter }) {
  const [group, setGroup] = useState('ENGINE_OIL');
  const [data, setData] = useState(null);      // null = not loaded
  const [err, setErr] = useState(null);
  const [sheet, setSheet] = useState(null);    // a vehicle row
  const [planOpen, setPlanOpen] = useState(false);

  const companyId = filter?.filters?.companyId || '';

  const load = useCallback(async () => {
    setErr(null);
    try {
      const p = new URLSearchParams({ group });
      // DIRECTIVE 3'S ARCHITECTURE, APPLIED HERE TOO. The server resolves this
      // through company_at(vehicle, TODAY) — the firm that operates the lorry
      // now — not vehicles.company_id, which is a single current value that
      // would hand a transferred truck's whole history to whoever holds it.
      if (companyId) p.set('company_id', companyId);
      const r = await fetch(`${API}/maintenance/fleet-status?${p}`, { headers: authHeaders() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      // Named, not swallowed: an empty fleet and a broken fetch look identical.
      setData(null);
      setErr(e.message || 'maintenance status load failed');
    }
  }, [group, companyId]);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('erp:data-changed', onChange);
    return () => window.removeEventListener('erp:data-changed', onChange);
  }, [load]);

  const rows = data?.vehicles ?? [];
  const critical = data?.critical ?? 0;
  const dueSoon = data?.due_soon ?? 0;
  const baseline = data?.needs_baseline ?? 0;

  return (
    <GlassPanel className={`${PANEL_SHELL} border-orange-500/25 shadow-[0_0_30px_rgba(251,146,60,0.06)]`}>
      <PanelHeader
        icon={Wrench}
        title="Fleet Maintenance Hub"
        accent="text-orange-400"
        sub={data ? `${data.total} lorries · odometer trips se` : 'loading…'}
        right={
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPlanOpen(true)}
              title="Service interval set karein"
              className="flex items-center gap-1 rounded-md border border-slate-600/60 bg-white/5 px-1.5 py-0.5
                         text-[9px] font-black text-slate-300 transition-colors hover:bg-white/10">
              <Settings2 size={10} /> INTERVAL
            </button>
            <a href="?module=OPERATION&screen=TYRE" target="_blank" rel="noopener noreferrer"
              title="Poora tyre / service screen nayi tab mein"
              className="flex items-center gap-1 rounded-md border border-orange-500/40 bg-orange-500/10 px-1.5 py-0.5
                         text-[9px] font-black text-orange-300 transition-colors hover:bg-orange-500/20">
              <ExternalLink size={10} /> SAB
            </a>
          </div>
        }
      />

      {/* The two counts that decide the day, tiles not chips — same shape the
          Document Vault uses, for the same reason. */}
      <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 shrink-0">
        <div className={`rounded-lg border px-2 py-1.5 text-left
          ${critical ? 'border-red-500/45 bg-red-500/10' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-red-300">
            <AlertTriangle size={10} /> Critical
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{critical}</p>
          <p className="text-[9px] text-slate-500">interval paar</p>
        </div>
        <div className={`rounded-lg border px-2 py-1.5 text-left
          ${dueSoon ? 'border-amber-500/45 bg-amber-500/10' : 'border-slate-700/60 bg-white/[0.02]'}`}>
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-300">
            <CalendarClock size={10} /> Due soon
          </p>
          <p className="text-[19px] font-black leading-tight text-slate-100">{dueSoon}</p>
          <p className="text-[9px] text-slate-500">limit ke paas</p>
        </div>
      </div>

      <div className="flex gap-1 px-2.5 pt-1.5 shrink-0">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setGroup(id)}
            className={`rounded-lg border px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
              group === id ? 'border-orange-500/50 bg-orange-500/15 text-orange-200'
                : 'border-slate-700/60 text-slate-400 hover:text-slate-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── THE HONESTY LINE. This panel's numbers are derived, and every way
             they can be incomplete is stated before the rows, not after. */}
      <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 shrink-0">
        <span className="flex items-center gap-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-[1px]
                         text-[9px] font-black uppercase tracking-wide text-cyan-300"
              title="Odometer kisi ne likha nahi — last service ki reading + us ke baad ke trips ka RTKM jod kar banaya gaya hai">
          <Zap size={9} /> Auto-calculated via Trips
        </span>
        {baseline > 0 && (
          <span className={chipCls('slate')} title="In lorries ka koi service log hi nahi — pehli reading daalni hai">
            {baseline} <span className="font-normal opacity-70">baseline baaki</span>
          </span>
        )}
        {data?.plan_is_default && (
          <span className={chipCls('amber')}
                title="Yeh interval humne rakha hai, firm ne confirm nahi kiya — INTERVAL button se apna daalein">
            interval default hai
          </span>
        )}
        {data?.trips_missing_rtkm > 0 && (
          <span className={chipCls('slate')} title="In trips ka RTKM darj nahi, isliye km kam dikh sakta hai">
            {data.trips_missing_rtkm} trips ka km nahi
          </span>
        )}
      </div>

      <div className={SCROLL_PANE}>
        {err ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-red-400">
            Maintenance status nahi aaya — {err}
          </p>
        ) : data === null ? (
          <p className="flex items-center gap-1.5 px-1 py-3 text-[11px] text-slate-500">
            <Loader2 size={11} className="animate-spin" /> fleet ka hisaab lag raha hai…
          </p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            {companyId
              ? 'Is company ke naam par abhi koi active lorry nahi hai.'
              : 'Koi active lorry nahi mili.'}
          </p>
        ) : rows.map((v) => {
          const st = STATE[v.state] ?? STATE.NO_BASELINE;
          const pct = v.pct_of_interval === null ? null : Number(v.pct_of_interval);
          return (
            <button key={v.vehicle_id} type="button" onClick={() => setSheet(v)}
              title={`${v.vehicle_no} — ${st.hint}`}
              className={`${ROW_CLS} w-full items-center text-left hover:border-orange-500/40`}>
              <span className="shrink-0 text-[11px]" aria-hidden>{st.dot}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-[11.5px] font-black text-slate-100">{v.vehicle_no}</p>
                  <span className={`${chipCls(st.tone)} shrink-0`}>{st.label}</span>
                </div>
                {/* THE KM READING, and where it came from. */}
                <p className="truncate text-[10px] text-slate-400">
                  {v.state === 'NO_BASELINE' ? (
                    <>
                      <span className="text-slate-500">ERP mein chala:</span>{' '}
                      <span className="font-bold text-slate-300">{km(v.rtkm_since)} km</span>
                      <span className="text-slate-600"> · {v.trips_since} trips</span>
                    </>
                  ) : v.state === 'NO_ODOMETER' ? (
                    <>
                      <span className="text-slate-500">service {dmy(v.last_service_date)} — us par odometer nahi likha</span>
                    </>
                  ) : (
                    <>
                      <span className="font-bold text-slate-200">{km(v.effective_odo_km)} km</span>
                      <span className="text-slate-600"> / {km(v.limit_km)}</span>
                      {v.km_remaining !== null && (
                        <span className={Number(v.km_remaining) < 0 ? 'text-red-400' : 'text-slate-500'}>
                          {' · '}{Number(v.km_remaining) < 0
                            ? `${km(Math.abs(v.km_remaining))} km zyada chal chuki`
                            : `${km(v.km_remaining)} km baaki`}
                        </span>
                      )}
                    </>
                  )}
                </p>
                {/* A progress bar only where there is a real interval to be a
                    fraction of. */}
                {pct !== null && (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
                    />
                  </div>
                )}
              </div>
              {pct !== null && (
                <span className={`shrink-0 text-[10px] font-black tabular-nums
                  ${pct >= 100 ? 'text-red-400' : pct >= 90 ? 'text-amber-300' : 'text-slate-500'}`}>
                  {pct}%
                </span>
              )}
            </button>
          );
        })}
      </div>

      {sheet && createPortal(
        <VehicleSheet v={sheet} group={group} onClose={() => setSheet(null)}
                      onSaved={() => { setSheet(null); load(); window.dispatchEvent(new Event('erp:data-changed')); }} />,
        document.body)}

      {planOpen && createPortal(
        <PlanSheet group={group} plan={data?.plan} onClose={() => setPlanOpen(false)}
                   onSaved={() => { setPlanOpen(false); load(); }} />,
        document.body)}
    </GlassPanel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One lorry: how its reading was arrived at, and the form that gives it a
// baseline. PORTALLED for the same reason the vault's sheet is — the shell
// header carries a backdrop-filter, and an ancestor with one becomes the
// containing block for `position: fixed`.
// ─────────────────────────────────────────────────────────────────────────────
function VehicleSheet({ v, group, onClose, onSaved }) {
  const st = STATE[v.state] ?? STATE.NO_BASELINE;
  const [odo, setOdo] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [nextKm, setNextKm] = useState('');
  const [garage, setGarage] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const save = async () => {
    const reading = Number(odo);
    if (!Number.isFinite(reading) || reading <= 0) { setSaveErr('Odometer reading daalein.'); return; }
    setSaving(true); setSaveErr(null);
    try {
      const r = await fetch(`${API}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          vehicle_id: v.vehicle_id,
          vehicle_no: v.vehicle_no,
          service_date: date,
          // The service_type is what puts the log in a tab — maintenance_group()
          // reads these words. Sent explicitly rather than left to the operator
          // to phrase, or the log lands in OTHER and the tab stays empty.
          // maintenance_group() reads these words to decide the tab. Sent
          // explicitly rather than left to the operator to phrase, or the log
          // lands in OTHER and the tab it was entered from stays empty.
          service_type: group === 'ENGINE_OIL' ? 'Engine Oil & Filter'
            : group === 'GREASING' ? 'Greasing & Checkup'
            : 'Tyre Rotation & Alignment',
          odometer_km: reading,
          next_due_km: nextKm ? Number(nextKm) : null,
          garage_name: garage || null,
          // NO bill_amount and NO account: this is a baseline reading, not a
          // bill. Sending an amount here would post a voucher through TARA for
          // money nobody spent today.
          remarks: 'Baseline reading — Fleet Maintenance Hub',
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      setSaveErr(e.message || 'save nahi hua');
    } finally { setSaving(false); }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
      <div onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-48px)] w-[min(470px,100%)] flex-col overflow-hidden rounded-2xl
                   border border-slate-700/60 bg-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
        <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-black text-slate-100">{v.vehicle_no}</p>
            <p className="text-[10.5px] text-slate-500">{v.owner_name || 'owner darj nahi'}</p>
          </div>
          <span className={chipCls(st.tone)}>{st.dot} {st.label}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto mc-thin-scrollbar px-4 pb-4">
          {/* THE SUM, SHOWN AS A SUM. The whole point of the ⚡ badge is that
              this number was derived; anybody should be able to see the working
              rather than take it on trust. */}
          <div className="rounded-xl border border-slate-700/60 bg-slate-950/60 p-3">
            <p className="mb-2 flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider text-cyan-300">
              <Gauge size={11} /> Odometer kaise nikla
            </p>
            <Row k="Last service" v={v.last_service_date ? `${dmy(v.last_service_date)}${v.last_garage ? ` · ${v.last_garage}` : ''}` : 'kabhi darj nahi hua'} />
            <Row k="Us waqt odometer" v={v.last_odometer_km === null ? 'darj nahi' : `${km(v.last_odometer_km)} km`} />
            <Row k={`+ ${v.trips_since} trips ka RTKM`} v={`${km(v.rtkm_since)} km`} />
            <div className="my-1.5 border-t border-slate-800" />
            <Row k="= Abhi ka odometer" v={v.effective_odo_km === null ? 'nikal nahi sakte' : `${km(v.effective_odo_km)} km`} strong />
            <Row k="Service limit" v={v.limit_km === null ? 'set nahi' : `${km(v.limit_km)} km`} />
            {v.limit_source && v.limit_source !== 'none' && (
              <p className="mt-1 text-[9.5px] text-slate-600">
                {v.limit_source === 'log'
                  ? 'Limit us service log par garage ne likhi thi.'
                  : 'Limit default interval se hai — garage ne next-due nahi likha tha.'}
              </p>
            )}
            {v.next_due_date && (
              <p className="mt-1 text-[9.5px] text-slate-500">
                Date se due: {dmy(v.next_due_date)}
                {v.days_to_due !== null && (
                  <span className={Number(v.days_to_due) < 0 ? ' text-red-400' : ' text-slate-600'}>
                    {' '}({Number(v.days_to_due) < 0 ? `${Math.abs(v.days_to_due)} din late` : `${v.days_to_due} din baaki`})
                  </span>
                )}
              </p>
            )}
            {v.trips_missing_rtkm > 0 && (
              <p className="mt-1.5 text-[9.5px] leading-snug text-amber-400/90">
                In {v.trips_since} trips mein se {v.trips_missing_rtkm} ka RTKM darj nahi hai — asli km isse{' '}
                <strong>zyada</strong> hoga, kam nahi.
              </p>
            )}
          </div>

          {v.state === 'NO_BASELINE' && (
            <p className="mt-3 rounded-lg border border-slate-700/60 bg-white/[0.02] p-2.5 text-[10.5px] leading-relaxed text-slate-400">
              Is lorry ka koi service log nahi hai, isliye odometer ki shuruaat kahan se ho — yeh system nahi jaanta.
              Ek baar aaj ka meter reading daal dein; uske baad har trip ka RTKM apne aap jud jayega aur dobara
              likhne ki zarurat nahi padegi.
            </p>
          )}

          {/* Recording a service IS the baseline. One form for both. */}
          <div className="mt-3 rounded-xl border border-orange-500/30 bg-orange-500/[0.06] p-3">
            <p className="mb-2 text-[9.5px] font-black uppercase tracking-wider text-orange-300">
              {v.state === 'NO_BASELINE' ? 'Baseline reading daalein' : 'Nayi service darj karein'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Odometer (km)" value={odo} onChange={setOdo} placeholder="jaise 248500" type="number" />
              <Field label="Service date" value={date} onChange={setDate} type="date" />
              <Field label="Agli service par (km)" value={nextKm} onChange={setNextKm} placeholder="optional" type="number" />
              <Field label="Garage" value={garage} onChange={setGarage} placeholder="optional" />
            </div>
            {saveErr && <p className="mt-1.5 text-[10.5px] text-red-400">{saveErr}</p>}
            <p className="mt-1.5 text-[9px] leading-snug text-slate-500">
              Sirf reading save hogi — koi bill ya kharcha ledger mein nahi jayega. Bill daalna ho to poore
              Maintenance screen se karein.
            </p>
            <button onClick={save} disabled={saving}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2
                         text-[12px] font-black text-white transition-colors hover:bg-orange-500
                         disabled:bg-slate-700 disabled:text-slate-500">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} SAVE
            </button>
          </div>
        </div>

        <button onClick={onClose}
          className="border-t border-slate-800 px-4 py-2 text-[11px] font-bold text-slate-400 hover:text-slate-200">
          Band karein
        </button>
      </div>
    </div>
  );
}

function PlanSheet({ group, plan, onClose, onSaved }) {
  const [kmv, setKmv] = useState(plan?.interval_km ?? '');
  const [days, setDays] = useState(plan?.interval_days ?? '');
  const [pct, setPct] = useState(plan?.due_soon_pct ?? 10);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`${API}/maintenance/plans/${group}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          interval_km: kmv === '' ? null : Number(kmv),
          interval_days: days === '' ? null : Number(days),
          due_soon_pct: Number(pct),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) { setErr(e.message || 'save nahi hua'); }
    finally { setSaving(false); }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[1400] grid place-items-center bg-slate-950/85 p-5">
      <div onClick={(e) => e.stopPropagation()}
        className="w-[min(420px,100%)] rounded-2xl border border-slate-700/60 bg-slate-900 p-4
                   shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[13px] font-black text-slate-100">
            {TABS.find(([id]) => id === group)?.[1]} — service interval
          </p>
          <button onClick={onClose} className="text-xl leading-none text-slate-500 hover:text-slate-300">×</button>
        </div>
        {plan?.is_default && (
          <p className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[10.5px] leading-relaxed text-amber-200">
            Abhi jo interval lag raha hai woh <strong>humne rakha hai</strong>, firm ne confirm nahi kiya. Apna
            asli interval daal dein — uske baad yeh chetavni hat jayegi.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Har kitne km par" value={kmv} onChange={setKmv} type="number" placeholder="jaise 20000" />
          <Field label="Ya kitne din par" value={days} onChange={setDays} type="number" placeholder="jaise 180" />
          <Field label="“Due soon” kitne % par" value={pct} onChange={setPct} type="number" placeholder="10" />
        </div>
        {err && <p className="mt-1.5 text-[10.5px] text-red-400">{err}</p>}
        <button onClick={save} disabled={saving}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2
                     text-[12px] font-black text-white hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} SAVE
        </button>
      </div>
    </div>
  );
}

const Row = ({ k, v, strong = false }) => (
  <div className="flex items-baseline justify-between gap-3 py-[2px]">
    <span className="text-[10px] text-slate-500">{k}</span>
    <span className={`shrink-0 tabular-nums ${strong ? 'text-[12px] font-black text-cyan-300' : 'text-[11px] font-bold text-slate-200'}`}>{v}</span>
  </div>
);

function Field({ label, value, onChange, placeholder = '', type = 'text' }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-700/60 bg-slate-950/70 px-2 py-1.5 text-[11.5px]
                   text-slate-200 placeholder-slate-600 outline-none focus:border-orange-500/60"
        style={type === 'date' ? { colorScheme: 'dark' } : undefined}
      />
    </label>
  );
}
