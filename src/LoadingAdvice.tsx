// @ts-nocheck
// 📋 LOADING ADVICE — pre-trip register. Live PostgreSQL, zero Firestore.
//
// An advice IS a trip that exists before it is loaded: PG status PENDING, with
// the LR/trip code reserved at advice time so advances issued now never have to
// be re-linked when the loading entry is finally made three days later. That is
// the whole point of the screen, and it survived the move intact — see migration
// 025 for the advice columns.
//
// Two things the server now does that the browser used to:
//   • the trip code is minted inside the insert transaction under a table lock,
//     so two clicks cannot reserve the same LR number. The Firestore version
//     scanned for the max and raced.
//   • advances go through /trips/:id/driver-txn and /trips/:id/fuel-slip, the
//     same endpoints Trip Command Center uses, so settlement sees identical data
//     however the advance was issued. The fuel slip's arithmetic and duplicate-
//     memo guards are applied server-side and cannot be skipped.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sendWhatsApp, waResultText } from './lib/waSend';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const OPS = `${API}/api/v1/ops`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const round2 = (n: any) => Math.round(((parseFloat(n) || 0) + Number.EPSILON) * 100) / 100;
const num = (v: any) => Number(v) || 0;
const inr = (n: any) => num(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const norm = (v: any) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function LoadingAdvice({ onChanged }: { onChanged?: () => void }) {
  const [adviceTrips, setAdviceTrips] = useState<any[]>([]);
  const [masters, setMasters] = useState<any>({ vehicles: [], drivers: [], vendors: [], routes: [], vehicle_links: [] });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [f, setF] = useState({
    advice_no: '', advice_date: today(), advice_valid_till: '',
    vehicle_no: '', vehicle_id: '', driver_name: '', driver_id: '', driver_mobile: '',
    loading_point: '', consignee_name: '', customer_name: '', customer_id: '',
    operating_company: '', fixed_hsd: '', fixed_cash: '', rtkm: '',
  });

  const [payFor, setPayFor] = useState<any>(null);
  const [pay, setPay] = useState({ amount: '', mode: 'Office Cash', date: today(), remarks: '' });
  const [fuelFor, setFuelFor] = useState<any>(null);
  const [fuel, setFuel] = useState({ vendor_id: '', fuel_type: 'FIXED', qty: '', rate: '', cash_advance: '', date: today() });

  const fetchAll = useCallback(async () => {
    setErr('');
    try {
      const [m, t] = await Promise.all([
        fetchJson(`${OPS}/masters`),
        // An advice is a PENDING trip carrying an advice number. Filtering on the
        // number rather than the status alone keeps ordinary pending trips out.
        fetchJson(`${OPS}/trips?status=PENDING&limit=500`),
      ]);
      setMasters(m);
      setAdviceTrips((t.trips || []).filter((x: any) => x.advice_no)
        .sort((a: any, b: any) => String(b.advice_date ?? '').localeCompare(String(a.advice_date ?? ''))));
    } catch (e: any) {
      setErr(`Loading advice could not load from ${API} — ${e.message}`);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  const refresh = () => { fetchAll(); onChanged && onChanged(); };

  const fuelVendors = useMemo(
    () => masters.vendors.filter((v: any) => /fuel|pump|petrol|diesel|hsd|oil/i.test(v.vendor_type ?? '') ) || [],
    [masters.vendors]);
  const vendorList = fuelVendors.length ? fuelVendors : masters.vendors;

  // Picking a vehicle pulls its live driver link. `vehicle_links` is only the
  // unreleased assignments, so this cannot resurrect a driver who moved trucks.
  const handleVehicleChange = (vNo: string) => {
    const veh = masters.vehicles.find((v: any) => norm(v.vehicle_no) === norm(vNo));
    const link = masters.vehicle_links.find((l: any) => norm(l.vehicle_no) === norm(vNo));
    const company = veh
      ? (masters.companies?.find((c: any) => c.id === veh.company_id)?.company_name ?? veh.owner_name ?? '')
      : '';
    setF((prev) => ({
      ...prev,
      vehicle_no: vNo.toUpperCase(),
      vehicle_id: veh?.id ?? '',
      driver_name: link?.driver_name ?? prev.driver_name,
      driver_id: link?.driver_id ?? prev.driver_id,
      driver_mobile: link?.driver_mobile ?? prev.driver_mobile,
      operating_company: company || prev.operating_company,
    }));
  };

  const handleRouteSelect = (consignee: string) => {
    const route = masters.routes.find((r: any) => norm(r.Consignee_Name) === norm(consignee)) ?? {};
    const cust = masters.customers?.find((c: any) => norm(c.customer_name) === norm(route.Registered_Assessee ?? route.Customer_Name));
    setF((prev) => ({
      ...prev,
      consignee_name: consignee,
      loading_point: route.Depot_Link ?? prev.loading_point,
      customer_name: route.Registered_Assessee ?? route.Customer_Name ?? prev.customer_name,
      customer_id: cust?.id ?? '',
      fixed_hsd: String(route.fixed_hsd_qty ?? ''),
      fixed_cash: String(route.fixed_cash_amt ?? ''),
      rtkm: String(route.RTKM_Distance ?? ''),
    }));
  };

  const advances = (t: any) => round2(num(t.office_cash_paid) + num(t.bank_paid) + num(t.pump_cash_advance));

  const handleSave = async () => {
    if (saving) return;
    if (!f.advice_no.trim() || !f.vehicle_no) return alert('⚠️ Advise No and Vehicle No are both required.');
    const open = adviceTrips.find((t) => norm(t.vehicle_no) === norm(f.vehicle_no));
    if (open && !window.confirm(`⚠️ ${f.vehicle_no} already has an open advice #${open.advice_no} (LR ${open.trip_code}).\n\nRegister another one anyway?`)) return;

    setSaving(true);
    try {
      const out = await fetchJson(`${OPS}/trips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'PENDING',
          advice_no: f.advice_no.trim(),
          advice_date: f.advice_date || null,
          advice_valid_till: f.advice_valid_till || null,
          vehicle_id: f.vehicle_id || null,
          vehicle_no: f.vehicle_no,
          driver_id: f.driver_id || null,
          driver_name: f.driver_name || null,
          driver_mobile: f.driver_mobile || null,
          loading_point: f.loading_point || null,
          consignee_name: f.consignee_name || null,
          customer_id: f.customer_id || null,
          customer_name: f.customer_name || null,
          operating_company: f.operating_company || null,
          loading_date: f.advice_date || null,
          rtkm: f.rtkm ? num(f.rtkm) : null,
          fixed_hsd: f.fixed_hsd ? num(f.fixed_hsd) : null,
          fixed_cash: f.fixed_cash ? num(f.fixed_cash) : null,
          office_approved_loading: false,
        }),
      });
      alert(`✅ Loading advice registered.\n\nLR / Trip code reserved: ${out.trip.trip_code}\n\n`
        + `You can issue 💸 cash and ⛽ HSD advances against it now. Making the loading entry converts this same trip to IN_TRANSIT — the advances carry over.`);
      setF({
        advice_no: '', advice_date: today(), advice_valid_till: '', vehicle_no: '', vehicle_id: '',
        driver_name: '', driver_id: '', driver_mobile: '', loading_point: '', consignee_name: '',
        customer_name: '', customer_id: '', operating_company: '', fixed_hsd: '', fixed_cash: '', rtkm: '',
      });
      refresh();
    } catch (e: any) {
      alert(`❌ ${e.code === 'DUPLICATE' ? `Advice number '${f.advice_no}' is already registered.` : 'Advice not saved.'}\n\n${e.message}`);
    }
    setSaving(false);
  };

  // Cancelling is the server's decision, not the screen's: it refuses outright
  // if money is attached, and soft-cancels rather than deleting when there is
  // history worth keeping.
  const handleCancel = async (t: any) => {
    const spent = advances(t);
    if (spent > 0 || num(t.hsd_issued) > 0) {
      return alert(`❌ This advice already carries advances (₹${inr(spent)} cash / ${num(t.hsd_issued)} L HSD).\n\n`
        + `Make the loading entry to turn it into a trip, or recover from the driver and settle it — it cannot simply be deleted.`);
    }
    if (!window.confirm(`Cancel advice #${t.advice_no} (${t.vehicle_no})?\n\nNo advances issued, so this is a safe delete.`)) return;
    try {
      const out = await fetchJson(`${OPS}/trips/${t.id}`, { method: 'DELETE' });
      alert(out.hard_deleted ? '🗑️ Advice deleted.' : `Advice marked CANCELLED.\n\n${out.detail ?? ''}`);
      refresh();
    } catch (e: any) {
      alert(`❌ Not cancelled.\n\n${e.message}`);
    }
  };

  const handlePay = async () => {
    const amt = round2(pay.amount);
    if (!payFor || busy) return;
    if (!(amt > 0)) return alert('⚠️ Enter a valid amount.');
    if (!pay.date) return alert('⚠️ Pick a date.');
    setBusy(true);
    try {
      await fetchJson(`${OPS}/trips/${payFor.id}/driver-txn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_type: 'PAYMENT_GIVEN',
          amount: amt,
          txn_date: pay.date,
          mode: pay.mode,
          remarks: `[ADVICE ${payFor.advice_no ?? ''}] ${pay.remarks || 'Pre-trip advance'}`,
        }),
      });
      alert(`✅ ₹${inr(amt)} advance issued (${pay.mode}) and recorded in the driver's khata.`);
      setPayFor(null);
      setPay({ amount: '', mode: 'Office Cash', date: today(), remarks: '' });
      refresh();
    } catch (e: any) {
      alert(`❌ ${e.code === 'NO_DRIVER' ? 'This advice has no driver assigned yet.' : 'Advance not issued.'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  const handleFuel = async () => {
    if (!fuelFor || busy) return;
    const qty = num(fuel.qty);
    const rate = num(fuel.rate);
    const cashAmt = round2(fuel.cash_advance || 0);
    if (!fuel.vendor_id) return alert('⚠️ Select the pump.');
    if (!qty && !cashAmt) return alert('⚠️ Enter litres or a cash amount.');
    if (qty > 0 && !(rate > 0)) return alert('⚠️ Rate (₹/L) is required — without it the diesel cost saves as ₹0.');

    setBusy(true);
    try {
      const ven = vendorList.find((v: any) => v.id === fuel.vendor_id) ?? {};
      // A pure cash advance (no litres) is a driver transaction, not a fuel slip:
      // there is no memo to validate and nothing was fuelled.
      if (!qty && cashAmt > 0) {
        await fetchJson(`${OPS}/trips/${fuelFor.id}/driver-txn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txn_type: 'ADVANCE_GIVEN', amount: cashAmt, txn_date: fuel.date, mode: 'Pump Cash',
            remarks: `[ADVICE ${fuelFor.advice_no ?? ''}] Cash from ${ven.vendor_name ?? 'pump'}`,
          }),
        });
        alert(`✅ ₹${inr(cashAmt)} pump cash recorded against the advice.`);
      } else {
        const out = await fetchJson(`${OPS}/trips/${fuelFor.id}/fuel-slip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendor_id: fuel.vendor_id,
            memo_no: `ADV-${String(fuelFor.advice_no ?? fuelFor.trip_code ?? '').slice(-8)}`,
            entry_date: fuel.date,
            fuel_type: fuel.fuel_type,
            liters: qty,
            rate,
            amount: round2(qty * rate),
            cash_given_to_pump: cashAmt,
            pump_mobile: ven.mobile_no ?? null,
          }),
        });
        const mobile = ven.mobile_no;
        if (mobile && window.confirm('✅ Slip saved. Send the memo to the pump on WhatsApp?')) {
          const msg = `*⛽ FUEL MEMO (ADVANCE / LOADING ADVICE)*\n\nDear ${ven.vendor_name},\n\n`
            + `🚛 *Vehicle:* ${fuelFor.vehicle_no}\n👤 *Driver:* ${fuelFor.driver_name || 'N/A'}\n`
            + `📍 *Route:* ${fuelFor.loading_point ?? '?'} To ${fuelFor.consignee_name ?? '?'}\n`
            + `💧 *Qty:* ${qty} L (${fuel.fuel_type})\n💵 *Cash Adv:* ₹${inr(cashAmt)}\n`
            + `📝 *Memo:* ${out.fuel_entry.memo_no}\n📅 *Date:* ${fuel.date}`;
          alert(waResultText(await sendWhatsApp({ phone: mobile, message: msg, tripId: fuelFor.trip_code })));
        } else {
          alert(`✅ Fuel slip saved against the advice.${cashAmt > 0 ? `\n💵 ₹${inr(cashAmt)} pump cash also recorded in the driver's khata.` : ''}`);
        }
      }
      setFuelFor(null);
      setFuel({ vendor_id: '', fuel_type: 'FIXED', qty: '', rate: '', cash_advance: '', date: today() });
      refresh();
    } catch (e: any) {
      const hint = {
        SLIP_ARITHMETIC: 'The amount does not match litres × rate.',
        DUPLICATE_MEMO: 'This memo is already recorded for this pump.',
        NO_VENDOR: 'That pump is not in the vendor master.',
      }[e.code];
      alert(`❌ ${hint ?? 'Fuel slip not saved.'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  const input = { width: '100%', padding: '12px', minHeight: '46px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' as const, outline: 'none', colorScheme: 'dark' as const };
  const modalWrap = { position: 'fixed' as const, inset: 0, background: 'rgba(2,6,23,0.85)', backdropFilter: 'blur(6px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999, padding: '15px' };
  const modalBox = { background: '#0f172a', border: '1px solid #f59e0b', width: '100%', maxWidth: '440px', padding: '25px', borderRadius: '16px' };

  return (
    <div>
      {err && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', color: '#fca5a5', padding: '14px 18px', borderRadius: 12, marginBottom: 18, fontSize: 14 }}>
          ⚠️ {err}
        </div>
      )}

      {/* 📋 FORM */}
      <div style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '12px', padding: '20px', marginBottom: '20px' }}>
        <h3 style={{ margin: '0 0 5px 0', color: '#f59e0b', fontSize: '17px' }}>📋 New Loading Advice (Pre-Trip)</h3>
        <p style={{ margin: '0 0 18px 0', color: '#94a3b8', fontSize: '12px' }}>
          Register the oil company's Safety Checklist-cum-Loading Advise as it arrives — the LR/Trip code is reserved and advance HSD/cash is issued against it.
          <b style={{ color: '#10b981' }}> Optional</b> — Direct Entry still works without an advice.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' }}>
          <div><label style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Advise No *</label>
            <input style={{ ...input, borderColor: '#f59e0b' }} value={f.advice_no} onChange={(e) => setF({ ...f, advice_no: e.target.value })} placeholder="e.g. 7B03…LA0033" /></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Advise Date</label>
            <input type="date" style={input} value={f.advice_date} onChange={(e) => setF({ ...f, advice_date: e.target.value })} /></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Valid Till</label>
            <input type="date" style={input} value={f.advice_valid_till} onChange={(e) => setF({ ...f, advice_valid_till: e.target.value })} /></div>
          <div><label style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Vehicle (TT) No *</label>
            <input list="la-vehicle-list" style={{ ...input, borderColor: '#38bdf8' }} value={f.vehicle_no} onChange={(e) => handleVehicleChange(e.target.value)} placeholder="AS 26C 5108" />
            <datalist id="la-vehicle-list">{masters.vehicles.map((v: any) => <option key={v.id} value={v.vehicle_no} />)}</datalist></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Driver</label>
            <select style={input} value={f.driver_name} onChange={(e) => {
              const d = masters.drivers.find((x: any) => x.name === e.target.value);
              setF({ ...f, driver_name: e.target.value, driver_id: d?.id ?? '', driver_mobile: d?.mobile ?? f.driver_mobile });
            }}>
              <option value="">-- Select Driver --</option>
              {masters.drivers.map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Target Route / Terminal</label>
            <select style={input} value={f.consignee_name} onChange={(e) => handleRouteSelect(e.target.value)}>
              <option value="">-- Route from RTKM Master --</option>
              {masters.routes.map((r: any) => (
                <option key={r.id} value={r.Consignee_Name}>{r.Depot_Link} ➔ {r.Consignee_Name}</option>
              ))}
            </select></div>
          <div><label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Operating Company</label>
            <input style={input} value={f.operating_company} onChange={(e) => setF({ ...f, operating_company: e.target.value })} placeholder="PRASAD / GAUTAM / JAISWAL…" /></div>
          <div style={{ alignSelf: 'end', fontSize: '11px', color: '#94a3b8', paddingBottom: '8px' }}>
            {(f.fixed_hsd || f.fixed_cash) && <>🎯 Route targets: <b style={{ color: '#38bdf8' }}>{f.fixed_hsd || 0} L</b> · <b style={{ color: '#10b981' }}>₹{f.fixed_cash || 0}</b></>}
          </div>
        </div>
        <button onClick={handleSave} disabled={saving} style={{ marginTop: '16px', padding: '13px 30px', minHeight: '48px', background: saving ? '#64748b' : 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '15px', width: '100%', maxWidth: '400px' }}>
          {saving ? '⌛ Saving…' : '📋 Register Advice & Reserve LR No'}
        </button>
      </div>

      {/* 📄 OPEN ADVICE LIST */}
      <div style={{ background: '#1e293b', borderRadius: '12px', overflowX: 'auto', border: '1px solid #334155' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap', fontSize: '13px' }}>
          <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
            <tr>
              <th style={{ padding: '13px' }}>Advise No / LR</th>
              <th style={{ padding: '13px' }}>Vehicle / Driver</th>
              <th style={{ padding: '13px' }}>Route</th>
              <th style={{ padding: '13px' }}>Validity</th>
              <th style={{ padding: '13px', textAlign: 'right' }}>Advances So Far</th>
              <th style={{ padding: '13px', textAlign: 'center' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {adviceTrips.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: '28px', textAlign: 'center', color: '#64748b' }}>
                No open loading advice. (Direct Entry is always available — an advice is optional.)
              </td></tr>
            ) : adviceTrips.map((t) => {
              const daysLeft = t.advice_valid_till ? Math.ceil((+new Date(t.advice_valid_till) - Date.now()) / 86400000) : null;
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1' }}>
                  <td style={{ padding: '11px 13px' }}>
                    <b style={{ color: '#f59e0b' }}>{t.advice_no || '—'}</b><br />
                    <small style={{ color: '#38bdf8' }}>LR: {t.trip_code}</small><br />
                    <small style={{ color: '#94a3b8' }}>{t.advice_date ?? ''}</small>
                  </td>
                  <td style={{ padding: '11px 13px' }}>
                    <b style={{ color: '#fff' }}>{t.vehicle_no}</b><br />
                    <small style={{ color: '#94a3b8' }}>{t.driver_name || '—'}</small>
                  </td>
                  <td style={{ padding: '11px 13px', fontSize: '12px' }}>{t.loading_point ?? '?'} ➔ {t.consignee_name ?? '?'}</td>
                  <td style={{ padding: '11px 13px' }}>
                    {daysLeft === null ? <span style={{ color: '#64748b' }}>—</span>
                      : daysLeft < 0 ? <span style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid #ef4444', padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 'bold' }}>⛔ EXPIRED</span>
                      : <span style={{ color: daysLeft <= 3 ? '#f59e0b' : '#10b981', fontWeight: 'bold', fontSize: '12px' }}>{daysLeft}d left</span>}
                  </td>
                  <td style={{ padding: '11px 13px', textAlign: 'right' }}>
                    <b style={{ color: '#f59e0b' }}>₹{inr(advances(t))}</b><br />
                    <small style={{ color: '#38bdf8' }}>{num(t.hsd_issued)} L HSD</small>
                  </td>
                  <td style={{ padding: '11px 13px', textAlign: 'center' }}>
                    <button onClick={() => { setPayFor(t); setPay({ amount: '', mode: 'Office Cash', date: today(), remarks: '' }); }}
                      style={{ background: '#8b5cf6', color: '#fff', border: 'none', padding: '9px 13px', minHeight: '40px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginRight: '5px', fontSize: '12px' }}>💸 Pay</button>
                    <button onClick={() => { setFuelFor(t); setFuel({ vendor_id: '', fuel_type: 'FIXED', qty: '', rate: '', cash_advance: '', date: today() }); }}
                      style={{ background: '#f59e0b', color: '#fff', border: 'none', padding: '9px 13px', minHeight: '40px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginRight: '5px', fontSize: '12px' }}>⛽ Fuel</button>
                    <button onClick={() => handleCancel(t)}
                      style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '9px 12px', minHeight: '40px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ color: '#64748b', fontSize: '12px', marginTop: '10px' }}>
        💡 Selecting this vehicle in the Direct Entry tab attaches the open advice automatically — every advance carries over with the trip.
      </p>

      {/* 💸 PAY MODAL */}
      {payFor && (
        <div style={modalWrap} onClick={() => setPayFor(null)}>
          <div style={{ ...modalBox, borderColor: '#8b5cf6' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 5px 0', color: '#8b5cf6' }}>💸 Advance Cash — {payFor.vehicle_no}</h3>
            <p style={{ margin: '0 0 15px 0', color: '#94a3b8', fontSize: '12px' }}>Advice #{payFor.advice_no} · LR {payFor.trip_code} · {payFor.driver_name || 'no driver'}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <select style={{ ...input, borderColor: '#8b5cf6' }} value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })}>
                <option value="Office Cash">🏢 Office Cash</option>
                <option value="Bank Transfer">🏦 Bank / UPI Transfer</option>
              </select>
              <input type="date" style={input} value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
              <input type="number" inputMode="decimal" style={input} placeholder="Amount (₹)" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              <input style={input} placeholder="Remarks / Ref No." value={pay.remarks} onChange={(e) => setPay({ ...pay, remarks: e.target.value })} />
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => setPayFor(null)} style={{ flex: 1, minHeight: '48px', background: '#334155', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
                <button onClick={handlePay} disabled={busy} style={{ flex: 1, minHeight: '48px', background: busy ? '#64748b' : '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>{busy ? '⌛…' : 'Confirm Advance'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ⛽ FUEL MODAL */}
      {fuelFor && (
        <div style={modalWrap} onClick={() => setFuelFor(null)}>
          <div style={modalBox} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 5px 0', color: '#f59e0b' }}>⛽ Advance HSD / Pump Cash — {fuelFor.vehicle_no}</h3>
            <p style={{ margin: '0 0 15px 0', color: '#94a3b8', fontSize: '12px' }}>Advice #{fuelFor.advice_no} · LR {fuelFor.trip_code}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <select style={{ ...input, borderColor: '#f59e0b' }} value={fuel.vendor_id} onChange={(e) => setFuel({ ...fuel, vendor_id: e.target.value })}>
                <option value="">-- Petrol Pump --</option>
                {vendorList.map((v: any) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: '10px' }}>
                <select style={{ ...input, flex: 1 }} value={fuel.fuel_type} onChange={(e) => setFuel({ ...fuel, fuel_type: e.target.value })}>
                  <option value="FIXED">Fixed</option><option value="ADVANCE">Advance</option>
                </select>
                <input type="date" style={{ ...input, flex: 1 }} value={fuel.date} onChange={(e) => setFuel({ ...fuel, date: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input type="number" inputMode="decimal" style={{ ...input, flex: 1 }} placeholder="Liters" value={fuel.qty} onChange={(e) => setFuel({ ...fuel, qty: e.target.value })} />
                <input type="number" inputMode="decimal" style={{ ...input, flex: 1 }} placeholder="Rate ₹/L" value={fuel.rate} onChange={(e) => setFuel({ ...fuel, rate: e.target.value })} />
              </div>
              <div style={{ fontSize: '13px', color: '#f59e0b', fontWeight: 'bold' }}>Diesel Value: ₹{inr(round2(num(fuel.qty) * num(fuel.rate)))}</div>
              <input type="number" inputMode="decimal" style={input} placeholder="Cash to Driver via Pump (₹, optional)" value={fuel.cash_advance} onChange={(e) => setFuel({ ...fuel, cash_advance: e.target.value })} />
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => setFuelFor(null)} style={{ flex: 1, minHeight: '48px', background: '#334155', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
                <button onClick={handleFuel} disabled={busy} style={{ flex: 1, minHeight: '48px', background: busy ? '#64748b' : '#f59e0b', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>{busy ? '⌛…' : '🚀 Save & WA Slip'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
