// @ts-nocheck
// 🧾 MASTER TRIP SETTLEMENT — consolidated driver/vehicle hisaab. Live PostgreSQL.
//
// Flow unchanged: pick vehicle/driver + a date window → every unsettled trip lists
// with its HSD and cash advances → tick trips → add en-route expenses → Net
// Balance → either carry the balance forward or post it to the driver's ledger.
//
// What changed underneath:
//   • The per-trip HSD and cash totals are computed in SQL by
//     /ops/driver-settlements/candidates. The Firestore screen downloaded every
//     fuel entry and every driver transaction in the business and totalled them
//     in the browser, matching on a trip-code STRING because the tables had no
//     trip_id. Migration 023 gave driver_transactions that column.
//   • A settlement is its own table now (driver_settlements), not a document in
//     TRIP_SETTLEMENTS — that name in PostgreSQL belongs to TARA's per-trip
//     freight settlement, which is a different thing entirely. See migration 024.
//   • The settlement number comes from a sequence, not Date.now().
//   • Posting to the ledger goes through TARA, so an unbalanced journal cannot
//     land. The Firestore version swallowed journal failures in a catch and left
//     the settlement saved with no ledger entry.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sendWhatsApp, waResultText } from './lib/waSend';
import UnloadingDetails from './UnlodingDetals';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const OPS = `${API}/api/v1/ops`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const num = (v: any) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: any) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const inr = (n: any) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const normV = (s: any) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function MasterTripSettlement() {
  const [activeTab, setActiveTab] = useState('SETTLEMENT');
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  const [masters, setMasters] = useState<any>({ vehicles: [], drivers: [] });
  const [candidates, setCandidates] = useState<any[]>([]);
  const [openCarryForwards, setOpenCarryForwards] = useState<any[]>([]);
  const [settlements, setSettlements] = useState<any[]>([]);

  const [vehicleFilter, setVehicleFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState('');
  const [detail, setDetail] = useState<any>({});      // trip_id → {fuel_entries, driver_transactions}
  const [includeHsd, setIncludeHsd] = useState(false);

  const [extraExpenses, setExtraExpenses] = useState<any[]>([]);
  const [newExpName, setNewExpName] = useState('');
  const [newExpAmt, setNewExpAmt] = useState('');

  useEffect(() => {
    fetchJson(`${OPS}/masters`).then(setMasters).catch(() => {});
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const j = await fetchJson(`${OPS}/driver-settlements?limit=300`);
      setSettlements(j.settlements || []);
    } catch { setSettlements([]); }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const filterReady = !!(vehicleFilter || driverFilter);

  // Candidates come pre-totalled and pre-filtered: the server already excludes
  // trips on a live settlement, so the screen cannot offer one twice.
  const loadCandidates = useCallback(async () => {
    if (!filterReady) { setCandidates([]); setOpenCarryForwards([]); return; }
    setLoading(true);
    setErr('');
    try {
      const p = new URLSearchParams({ limit: '500' });
      if (driverFilter) p.set('driver_name', driverFilter);
      if (vehicleFilter) p.set('vehicle_no', vehicleFilter);
      if (fromDate) p.set('from', fromDate);
      if (toDate) p.set('to', toDate);
      const j = await fetchJson(`${OPS}/driver-settlements/candidates?${p}`);
      setCandidates(j.trips || []);
      setOpenCarryForwards(j.open_carry_forwards || []);
    } catch (e: any) {
      setCandidates([]);
      setErr(`Settleable trips could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  }, [filterReady, driverFilter, vehicleFilter, fromDate, toDate]);

  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  const unsettledTrips = candidates;
  const selectedTrips = useMemo(() => unsettledTrips.filter((t) => selectedIds.has(t.id)), [unsettledTrips, selectedIds]);

  // ── Totals ────────────────────────────────────────────────────────────────
  const tripHsd = (t: any) => ({ ltr: round2(t.hsd_ltr), amt: round2(t.hsd_amt) });
  const tripCash = (t: any) => round2(
    Math.max(num(t.cash_advanced), num(t.office_cash_paid) + num(t.bank_paid) + num(t.pump_cash_advance)));
  const tripAllowance = (t: any) => round2(t.fixed_cash);

  const totCash = round2(selectedTrips.reduce((s, t) => s + tripCash(t), 0));
  const totHsdAmt = round2(selectedTrips.reduce((s, t) => s + tripHsd(t).amt, 0));
  const totHsdLtr = round2(selectedTrips.reduce((s, t) => s + tripHsd(t).ltr, 0));
  const totAllowance = round2(selectedTrips.reduce((s, t) => s + tripAllowance(t), 0));
  const totFreight = round2(selectedTrips.reduce((s, t) => s + num(t.freight_amount), 0));
  const totExtra = round2(extraExpenses.reduce((s, x) => s + num(x.amount), 0));
  const cfEarned = round2(openCarryForwards.reduce((s, c) => s + num(c.earned_total), 0));
  const cfNet = round2(openCarryForwards.reduce((s, c) => s + num(c.net_balance), 0));
  const netBalance = round2(totAllowance + totExtra + cfNet - totCash - (includeHsd ? totHsdAmt : 0));

  const toggleTrip = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds((prev) =>
    prev.size === unsettledTrips.length ? new Set() : new Set(unsettledTrips.map((t) => t.id)));

  const resetSelection = () => { setSelectedIds(new Set()); setExtraExpenses([]); setExpandedId(''); };

  const addExtraExpense = () => {
    if (!newExpName.trim() || !num(newExpAmt)) return alert('⚠️ Enter both an expense name and an amount.');
    setExtraExpenses((prev) => [...prev, { id: `x_${prev.length}_${newExpName.trim().slice(0, 8)}`, name: newExpName.trim(), amount: num(newExpAmt) }]);
    setNewExpName(''); setNewExpAmt('');
  };

  // Detail rows are fetched per trip on expand, not bulk-downloaded up front.
  const expandTrip = async (t: any) => {
    if (expandedId === t.id) { setExpandedId(''); return; }
    setExpandedId(t.id);
    if (detail[t.id]) return;
    try {
      const j = await fetchJson(`${OPS}/trips/${t.id}`);
      setDetail((d: any) => ({ ...d, [t.id]: j }));
    } catch { setDetail((d: any) => ({ ...d, [t.id]: { fuel_entries: [], driver_transactions: [] } })); }
  };

  const submitSettlement = async (mode: 'POSTED' | 'CARRY_FORWARD') => {
    if (!selectedTrips.length) return alert('⚠️ Select at least one trip.');
    const driverName = driverFilter || selectedTrips[0].driver_name;
    if (!driverName) return alert('⚠️ No driver on these trips — pick a driver filter.');
    const earned = round2(totAllowance + totExtra + cfEarned);

    const confirmText = mode === 'CARRY_FORWARD'
      ? `🔁 Carry ${inr(netBalance)} forward to the next settlement?\n\n${selectedTrips.length} trip(s). Nothing is posted to the khata now.`
      : `📓 Settle ${selectedTrips.length} trip(s) and post to the driver ledger?\n\n`
        + `Driver: ${driverName}\nBhatta + extra (credited): ${inr(earned)}\n`
        + `Cash advances (already debited when handed over): ${inr(totCash)}\n`
        + `Net balance: ${inr(netBalance)} ${netBalance >= 0 ? '(payable to driver)' : '(recover from driver)'}`;
    if (!window.confirm(confirmText)) return;

    setPosting(true);
    try {
      const drv = masters.drivers.find((d: any) => String(d.name).toUpperCase() === String(driverName).toUpperCase());
      const out = await fetchJson(`${OPS}/driver-settlements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          driver_id: drv?.id ?? null,
          driver_name: driverName,
          vehicle_no: vehicleFilter || selectedTrips[0].vehicle_no || null,
          from_date: fromDate || null,
          to_date: toDate || null,
          trip_ids: selectedTrips.map((t) => t.id),
          total_cash: totCash,
          total_hsd_amt: totHsdAmt,
          total_hsd_ltr: totHsdLtr,
          total_allowance: totAllowance,
          total_extra: totExtra,
          total_freight: totFreight,
          earned_total: earned,
          net_balance: netBalance,
          include_hsd_in_recovery: includeHsd,
          extra_expenses: extraExpenses.map((x) => ({ name: x.name, amount: num(x.amount) })),
          consume_carry_forward_ids: openCarryForwards.map((c) => c.id),
        }),
      });
      const s = out.settlement;
      alert(mode === 'CARRY_FORWARD'
        ? `✅ ${inr(netBalance)} carried forward as ${s.settlement_no}.\n\nIt joins the next settlement as an opening balance.`
        : `✅ Settlement ${s.settlement_no} posted.\n\n`
          + `💰 ${inr(earned)} credited to ${driverName}'s khata.\n`
          + (out.voucher_id ? `📓 Ledger journal posted (voucher ${String(out.voucher_id).slice(0, 8)}…).\n` : '')
          + (out.ledger_note ? `⚠️ ${out.ledger_note}\n` : '')
          + `\nNet balance ${inr(netBalance)} ${netBalance >= 0 ? '— payable to the driver' : '— recoverable from the driver'}. Make the final payment in Driver Master.`);
      resetSelection();
      loadCandidates();
      loadHistory();
    } catch (e: any) {
      const hint = {
        ALREADY_SETTLED: 'One or more of these trips is already on a settlement.',
        MIXED_DRIVER: 'A settlement covers one driver.',
        TRIP_NOT_FOUND: 'One of the selected trips no longer exists.',
      }[e.code];
      alert(`❌ ${hint ?? 'Settlement not saved.'}\n\n${e.message}`);
    }
    setPosting(false);
  };

  const sendSettlementWhatsApp = async () => {
    if (!selectedTrips.length) return alert('⚠️ Select trips first.');
    const driverName = driverFilter || selectedTrips[0].driver_name;
    const drv = masters.drivers.find((d: any) => String(d.name).toUpperCase() === String(driverName ?? '').toUpperCase());
    const mobile = drv?.mobile;
    if (!mobile) return alert(`⚠️ No mobile number for ${driverName || 'this driver'} in Driver Master.`);
    const lines = selectedTrips.map((t) => `• ${t.loading_date ?? '—'} ${t.trip_code} — Cash ${inr(tripCash(t))}, HSD ${inr(tripHsd(t).amt)}`).join('\n');
    const message = `🧾 *TRIP SETTLEMENT SUMMARY*\n\nDear ${driverName},\n\n${selectedTrips.length} trips ka hisaab:\n${lines}\n\n`
      + `(+) Bhatta: ${inr(totAllowance)}\n(+) Extra Kharcha: ${inr(totExtra)}\n(−) Cash Advances: ${inr(totCash)}`
      + `${includeHsd ? `\n(−) HSD: ${inr(totHsdAmt)}` : ''}${cfNet ? `\n(±) Purana Balance: ${inr(cfNet)}` : ''}\n\n`
      + `*NET BALANCE: ${inr(Math.abs(netBalance))} ${netBalance >= 0 ? '(aapko milega)' : '(aapse recovery hogi)'}*\n\nRegards,\nPrasad Transport ERP`;
    alert(waResultText(await sendWhatsApp({ phone: mobile, message, role: 'Driver' })));
  };

  const inputStyle = { width: '100%', padding: '12px 14px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '10px', fontSize: '14px', boxSizing: 'border-box' as const, outline: 'none', colorScheme: 'dark' as const };
  const vehicleOptions = useMemo(() => [...new Set(masters.vehicles.map((v: any) => v.vehicle_no).filter(Boolean))].sort(), [masters.vehicles]);
  const driverOptions = useMemo(() => [...new Set(masters.drivers.map((d: any) => d.name).filter(Boolean))].sort(), [masters.drivers]);
  const settlementHistory = settlements;

  return (
    <div className="pt-anim-fade" style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      <div style={{ marginBottom: '25px' }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 28px)', color: '#fff' }}>🧾 Master Trip Settlement</h2>
        <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>
          Consolidated multi-trip driver hisaab — HSD, cash advances, bhatta &amp; extra expenses · live PostgreSQL
        </p>
      </div>

      {err && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', color: '#fca5a5', padding: '14px 18px', borderRadius: 12, marginBottom: 18, fontSize: 14 }}>
          ⚠️ {err}
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', marginBottom: '25px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        <button className={`pt-tab ${activeTab === 'SETTLEMENT' ? 'is-active is-active--success' : ''}`} onClick={() => setActiveTab('SETTLEMENT')}>💰 TRIP SETTLEMENT</button>
        <button className={`pt-tab ${activeTab === 'UNLOADING' ? 'is-active' : ''}`} onClick={() => setActiveTab('UNLOADING')}>🏁 UNLOADING / CLOSE TRIP</button>
        <button className={`pt-tab ${activeTab === 'HISTORY' ? 'is-active is-active--warning' : ''}`} onClick={() => setActiveTab('HISTORY')}>📋 SETTLEMENT HISTORY</button>
      </div>

      {activeTab === 'UNLOADING' && <UnloadingDetails />}

      {/* 📋 HISTORY */}
      {activeTab === 'HISTORY' && (
        <div className="pt-anim-up" style={{ background: '#1e293b', borderRadius: '16px', overflowX: 'auto', border: '1px solid #334155' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap', fontSize: '13px' }}>
            <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
              <tr>
                <th style={{ padding: '14px' }}>Settlement No</th><th style={{ padding: '14px' }}>Vehicle / Driver</th>
                <th style={{ padding: '14px' }}>Period</th><th style={{ padding: '14px' }}>Trips</th>
                <th style={{ padding: '14px', textAlign: 'right' }}>Cash</th><th style={{ padding: '14px', textAlign: 'right' }}>HSD ₹</th>
                <th style={{ padding: '14px', textAlign: 'right' }}>Bhatta+Extra</th><th style={{ padding: '14px', textAlign: 'right' }}>Net</th>
                <th style={{ padding: '14px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {settlementHistory.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>No settlements yet.</td></tr>
              ) : settlementHistory.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1' }}>
                  <td style={{ padding: '12px 14px', fontWeight: 'bold', color: '#38bdf8' }}>{s.settlement_no}</td>
                  <td style={{ padding: '12px 14px' }}>{s.vehicle_no || '—'}<br /><small style={{ color: '#94a3b8' }}>{s.driver_name || '—'}</small></td>
                  <td style={{ padding: '12px 14px', color: '#94a3b8' }}>{s.from_date || '…'} → {s.to_date || '…'}</td>
                  <td style={{ padding: '12px 14px' }}>{s.trip_count}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#f59e0b' }}>{inr(s.total_cash)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#38bdf8' }}>{inr(s.total_hsd_amt)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#10b981' }}>{inr(num(s.total_allowance) + num(s.total_extra))}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: '900', color: num(s.net_balance) >= 0 ? '#10b981' : '#ef4444' }}>{inr(s.net_balance)}</td>
                  <td style={{ padding: '12px 14px' }}>
                    {s.mode === 'POSTED' ? <span className="pt-badge pt-badge--success">📓 Posted{s.voucher_id ? '' : ' (no journal)'}</span>
                      : s.status === 'CONSUMED' ? <span className="pt-badge pt-badge--info">🔁 CF → {s.consumed_by}</span>
                        : <span className="pt-badge pt-badge--warning">🔁 Carry-Fwd OPEN</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 💰 SETTLEMENT BUILDER */}
      {activeTab === 'SETTLEMENT' && (
        <>
          <div className="pt-anim-up" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '14px', padding: '20px', marginBottom: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
              <div>
                <label style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>🚛 VEHICLE</label>
                <select value={vehicleFilter} onChange={(e) => { setVehicleFilter(e.target.value); resetSelection(); }} style={{ ...inputStyle, borderColor: '#10b981' }}>
                  <option value="">-- All / Choose Vehicle --</option>
                  {vehicleOptions.map((v: any) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>👨‍✈️ DRIVER</label>
                <select value={driverFilter} onChange={(e) => { setDriverFilter(e.target.value); resetSelection(); }} style={{ ...inputStyle, borderColor: '#38bdf8' }}>
                  <option value="">-- All / Choose Driver --</option>
                  {driverOptions.map((d: any) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>📅 FROM DATE</label>
                <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); resetSelection(); }} style={inputStyle} />
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>📅 TO DATE</label>
                <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); resetSelection(); }} style={inputStyle} />
              </div>
            </div>
            {openCarryForwards.length > 0 && (
              <div style={{ marginTop: '12px', background: 'rgba(245,158,11,0.1)', border: '1px dashed #f59e0b', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', color: '#f59e0b' }}>
                🔁 Opening balance (carry-forward): <b>{inr(cfNet)}</b> from {openCarryForwards.map((c) => c.settlement_no).join(', ')} — auto-adjusted into this settlement.
              </div>
            )}
          </div>

          {!filterReady ? (
            <div style={{ color: '#64748b', padding: '50px', textAlign: 'center', background: 'rgba(30,41,59,0.3)', borderRadius: '16px', border: '1px dashed #334155' }}>
              👆 Choose a vehicle or driver — every <b>unsettled trip</b> for them appears here.
            </div>
          ) : loading ? (
            <div style={{ color: '#38bdf8', textAlign: 'center', padding: '40px' }}>Loading trips from PostgreSQL…</div>
          ) : (
            <>
              <div className="pt-anim-up" style={{ background: '#1e293b', borderRadius: '16px', border: '1px solid #334155', overflowX: 'auto', marginBottom: '20px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead style={{ background: '#0f172a', color: '#38bdf8', fontSize: '11px', textTransform: 'uppercase' }}>
                    <tr>
                      <th style={{ padding: '14px', width: '40px' }}>
                        <input type="checkbox" checked={unsettledTrips.length > 0 && selectedIds.size === unsettledTrips.length} onChange={toggleAll} style={{ width: '18px', height: '18px', accentColor: '#10b981', cursor: 'pointer' }} />
                      </th>
                      <th style={{ padding: '14px' }}>Date &amp; Trip</th>
                      <th style={{ padding: '14px' }}>Challan / Route</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>HSD (Fuel)</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>Cash Advances</th>
                      <th style={{ padding: '14px', textAlign: 'right' }}>Bhatta</th>
                      <th style={{ padding: '14px', width: '60px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {unsettledTrips.length === 0 ? (
                      <tr><td colSpan={7} style={{ padding: '35px', textAlign: 'center', color: '#64748b' }}>🎉 No unsettled trips for this filter.</td></tr>
                    ) : unsettledTrips.map((t) => {
                      const hsd = tripHsd(t);
                      const cash = tripCash(t);
                      const isOpen = expandedId === t.id;
                      const d = detail[t.id];
                      return (
                        <React.Fragment key={t.id}>
                          <tr style={{ borderBottom: isOpen ? 'none' : '1px solid #334155', color: '#cbd5e1', background: selectedIds.has(t.id) ? 'rgba(16,185,129,0.06)' : 'transparent' }}>
                            <td style={{ padding: '12px 14px' }}>
                              <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleTrip(t.id)} style={{ width: '18px', height: '18px', accentColor: '#10b981', cursor: 'pointer' }} />
                            </td>
                            <td style={{ padding: '12px 14px' }}>
                              <b style={{ color: '#fff' }}>{t.loading_date || '—'}</b> · <span style={{ color: '#38bdf8' }}>{t.trip_code}</span><br />
                              <small style={{ color: '#94a3b8' }}>📍 {t.loading_point ?? '?'} ➔ {t.consignee_name ?? '?'}</small><br />
                              <span className={`pt-pill ${t.status === 'COMPLETED' ? 'pt-pill--completed' : 'pt-pill--pending-unload'}`} style={{ marginTop: '4px' }}>{t.status}</span>
                            </td>
                            <td style={{ padding: '12px 14px', color: '#f59e0b' }}>{t.customer_name ?? '—'}</td>
                            <td style={{ padding: '12px 14px', textAlign: 'right', color: '#38bdf8', fontWeight: 'bold' }}>
                              {hsd.ltr > 0 && <small>{hsd.ltr} L<br /></small>}{inr(hsd.amt)}
                            </td>
                            <td style={{ padding: '12px 14px', textAlign: 'right', color: '#f59e0b', fontWeight: 'bold' }}>{inr(cash)}</td>
                            <td style={{ padding: '12px 14px', textAlign: 'right', color: '#10b981', fontWeight: 'bold' }}>{inr(tripAllowance(t))}</td>
                            <td style={{ padding: '12px 14px' }}>
                              <button onClick={() => expandTrip(t)} style={{ background: 'none', border: '1px solid #475569', color: '#94a3b8', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px' }}>
                                {isOpen ? '▲' : '▼ Detail'}
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr style={{ borderBottom: '1px solid #334155', background: 'rgba(15,23,42,0.6)' }}>
                              <td />
                              <td colSpan={6} style={{ padding: '5px 14px 15px' }}>
                                {!d ? <small style={{ color: '#38bdf8' }}>Loading detail…</small> : (
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '15px' }}>
                                    <div>
                                      <div style={{ fontSize: '11px', color: '#c084fc', fontWeight: 'bold', marginBottom: '6px' }}>🎯 FIXED EXPENSES (TRIP TARGET)</div>
                                      {num(t.fixed_hsd) <= 0 && num(t.fixed_cash) <= 0
                                        ? <small style={{ color: '#64748b' }}>No fixed target set on this trip or route.</small>
                                        : <>
                                          {num(t.fixed_hsd) > 0 && (
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '4px 0', borderBottom: '1px dotted #334155' }}>
                                              <span style={{ color: '#94a3b8' }}>⛽ Fixed HSD</span>
                                              <span>Target <b style={{ color: '#c084fc' }}>{num(t.fixed_hsd)} L</b> · Actual <b style={{ color: '#38bdf8' }}>{num(t.hsd_issued)} L</b> · Bal <b style={{ color: round2(num(t.fixed_hsd) - num(t.hsd_issued)) < 0 ? '#ef4444' : '#10b981' }}>{round2(num(t.fixed_hsd) - num(t.hsd_issued))} L</b></span>
                                            </div>
                                          )}
                                          {num(t.fixed_cash) > 0 && (
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '4px 0', borderBottom: '1px dotted #334155' }}>
                                              <span style={{ color: '#94a3b8' }}>💵 Fixed Cash (Bhatta)</span>
                                              <span>Target <b style={{ color: '#c084fc' }}>{num(t.fixed_cash)} ₹</b> · Actual <b style={{ color: '#38bdf8' }}>{cash} ₹</b> · Bal <b style={{ color: round2(num(t.fixed_cash) - cash) < 0 ? '#ef4444' : '#10b981' }}>{round2(num(t.fixed_cash) - cash)} ₹</b></span>
                                            </div>
                                          )}
                                        </>}
                                    </div>
                                    <div>
                                      <div style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 'bold', marginBottom: '6px' }}>⛽ DATE-WISE HSD ISSUED</div>
                                      {(d.fuel_entries ?? []).length === 0
                                        ? <small style={{ color: '#64748b' }}>No fuel entries{hsd.amt > 0 ? ` (₹${hsd.amt} recorded on the trip)` : ''}.</small>
                                        : d.fuel_entries.map((f: any) => (
                                          <div key={f.id} style={{ fontSize: '12px', color: '#cbd5e1', padding: '3px 0', borderBottom: '1px dotted #334155' }}>
                                            {f.entry_date} · {f.vendor_name || f.memo_no || 'Pump'} — <b style={{ color: '#38bdf8' }}>{num(f.liters) ? `${f.liters} L / ` : ''}{inr(f.amount)}</b>
                                          </div>
                                        ))}
                                    </div>
                                    <div>
                                      <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', marginBottom: '6px' }}>💵 TRIP CASH ADVANCES</div>
                                      {(d.driver_transactions ?? []).length === 0
                                        ? <small style={{ color: '#64748b' }}>No khata rows{cash > 0 ? ` (trip roll-up ${inr(cash)})` : ''}.</small>
                                        : d.driver_transactions.map((x: any) => (
                                          <div key={x.id} style={{ fontSize: '12px', color: '#cbd5e1', padding: '3px 0', borderBottom: '1px dotted #334155' }}>
                                            {x.txn_date} · {x.remarks || x.txn_type} — <b style={{ color: x.txn_type === 'ADVANCE_GIVEN' || x.txn_type === 'PAYMENT_GIVEN' ? '#f59e0b' : '#10b981' }}>{inr(x.amount)}</b>
                                          </div>
                                        ))}
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ➕ EXTRA EXPENSES + 🧮 SUMMARY */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
                <div className="pt-card" style={{ borderTop: '3px solid #c084fc' }}>
                  <h4 style={{ color: '#c084fc', margin: '0 0 12px 0' }}>➕ Add Extra Expense (en-route / maintenance)</h4>
                  {extraExpenses.map((x, i) => (
                    <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px dotted #334155', fontSize: '13px' }}>
                      <span style={{ color: '#cbd5e1' }}>{i + 1}. {x.name}</span>
                      <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <b style={{ color: '#c084fc' }}>{inr(x.amount)}</b>
                        <button onClick={() => setExtraExpenses((prev) => prev.filter((p) => p.id !== x.id))} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>✕</button>
                      </span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                    <input placeholder="e.g. Tyre Puncture / Dhaba" value={newExpName} onChange={(e) => setNewExpName(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                    <input type="number" placeholder="₹" value={newExpAmt} onChange={(e) => setNewExpAmt(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                    <button onClick={addExtraExpense} style={{ background: '#c084fc', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>+ Add</button>
                  </div>
                </div>

                <div className="pt-card" style={{ borderTop: '3px solid #10b981' }}>
                  <h4 style={{ color: '#10b981', margin: '0 0 12px 0' }}>🧮 Settlement Summary ({selectedTrips.length} trips selected)</h4>
                  {[
                    ['(+) Trip Bhatta / Allowance', totAllowance, '#10b981'],
                    ['(+) Extra Expenses', totExtra, '#c084fc'],
                    ...(openCarryForwards.length ? [['(±) Opening Carry-Forward', cfNet, '#f59e0b']] : []),
                    ['(−) Cash Advances Taken', -totCash, '#f59e0b'],
                    [`(${includeHsd ? '−' : 'ℹ️'}) HSD Issued ${totHsdLtr ? `(${totHsdLtr} L)` : ''}`, includeHsd ? -totHsdAmt : totHsdAmt, '#38bdf8'],
                    ['ℹ️ Freight (company side)', totFreight, '#64748b'],
                  ].map(([lbl, val, col]: any, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dotted #334155', fontSize: '13px' }}>
                      <span style={{ color: '#94a3b8' }}>{lbl}</span>
                      <b style={{ color: col }}>{inr(Math.abs(num(val)))}{num(val) < 0 ? ' −' : ''}</b>
                    </div>
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0', fontSize: '12px', color: '#94a3b8', cursor: 'pointer' }}>
                    <input type="checkbox" checked={includeHsd} onChange={(e) => setIncludeHsd(e.target.checked)} style={{ accentColor: '#38bdf8' }} />
                    Recover the HSD amount from the driver too (subtracted from Net)
                  </label>
                  <div style={{ background: netBalance >= 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)', border: `2px dashed ${netBalance >= 0 ? '#10b981' : '#ef4444'}`, borderRadius: '12px', padding: '15px', textAlign: 'center', margin: '10px 0' }}>
                    <div style={{ fontSize: '11px', fontWeight: 'bold', color: netBalance >= 0 ? '#10b981' : '#ef4444', textTransform: 'uppercase' }}>
                      {netBalance >= 0 ? '💰 Net Payable to Driver' : '⚠️ Recover from Driver'}
                    </div>
                    <div style={{ fontSize: '30px', fontWeight: '900', color: netBalance >= 0 ? '#10b981' : '#ef4444' }}>{inr(Math.abs(netBalance))}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <button disabled={posting || !selectedTrips.length} onClick={() => submitSettlement('CARRY_FORWARD')}
                      style={{ flex: 1, minWidth: '150px', minHeight: '48px', background: 'rgba(245,158,11,0.15)', border: '1px solid #f59e0b', color: '#f59e0b', padding: '13px', borderRadius: '12px', fontWeight: '900', cursor: posting ? 'wait' : 'pointer', fontSize: '13px', opacity: !selectedTrips.length ? 0.4 : 1 }}>
                      🔁 Carry Forward Balance
                    </button>
                    <button disabled={posting || !selectedTrips.length} onClick={() => submitSettlement('POSTED')}
                      style={{ flex: 1, minWidth: '150px', minHeight: '48px', background: 'linear-gradient(135deg, #10b981, #059669)', border: 'none', color: '#fff', padding: '13px', borderRadius: '12px', fontWeight: '900', cursor: posting ? 'wait' : 'pointer', fontSize: '13px', boxShadow: '0 5px 18px rgba(16,185,129,0.35)', opacity: !selectedTrips.length ? 0.4 : 1 }}>
                      {posting ? '⏳ Posting…' : '📓 Post to Driver Ledger'}
                    </button>
                  </div>
                  <button disabled={!selectedTrips.length} onClick={sendSettlementWhatsApp}
                    style={{ width: '100%', marginTop: '10px', minHeight: '48px', background: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e', color: '#22c55e', padding: '12px', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', fontSize: '13px', opacity: !selectedTrips.length ? 0.4 : 1 }}>
                    💬 WhatsApp Hisaab to Driver
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
