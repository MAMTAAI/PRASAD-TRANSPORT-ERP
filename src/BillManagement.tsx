// @ts-nocheck
// 🧾 BILL MANAGEMENT — live PostgreSQL, zero Firestore.
//
// Pipeline: completed trips → priced → one bill per customer per plant → money
// received through TARA → printed in the oil company's own format.
//
// What the move to PostgreSQL changed, deliberately:
//   • Settlement posts a real RECEIPT voucher (Dr bank + Dr TDS receivable / Cr
//     debtor). Firestore wrote a BANK_TRANSACTIONS row that no ledger knew about.
//   • A driver shortage recovery now also posts a JOURNAL (Dr driver advance /
//     Cr shortage expense). Firestore only touched DRIVER_TRANSACTIONS, which is
//     why driver recoveries never reached the general ledger.
//   • Deleting a settled bill is refused. Money is undone by reversing its
//     voucher, not by removing the document that explains it.
//   • Rates come from the rate card derived from bills IOCL actually paid
//     (v_iocl_lane_rate), not from rtkm_master — whose distances disagree with
//     what is billed (242.400 stored vs 262.8 billed). Nothing is auto-priced:
//     an unpriced trip shows as unpriced.
//
// The freight formula is NOT reimplemented here. src/lib/freightEngine.ts is the
// single implementation, verified against a real IOCL bill, and the API returns
// lane data in the shape it already reads.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { extractJsonFromImage } from './lib/aiScanner';
import { logAudit } from './lib/audit';
import { matchTripForBill, parseDocDate } from './lib/tripMatch';
import { computeFreight, effectiveBillingType, findRouteForTrip, resolveRate, parseCapacity, BILLING_TYPES } from './lib/freightEngine';
import { useIsMobile } from './hooks/useIsMobile';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const BILLING = `${API}/api/v1/billing`;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error, body: json });
  return json;
};

const inr = (n: any) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = (n: any) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const normKey = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const TDS_PCT = 2;
const GST_PCT = 5;

export default function BillManagement() {
  const { isPhone } = useIsMobile();
  const [activeTab, setActiveTab] = useState('UNBILLED_TRIPS');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [payload, setPayload] = useState<any>(null);   // unbilled-trips response
  const [priced, setPriced] = useState<any[]>([]);     // trips + calc_* fields
  const [bills, setBills] = useState<any[]>([]);
  const [billTotals, setBillTotals] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);

  const [selectedTripsForBill, setSelectedTripsForBill] = useState<string[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  // Settle modal
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [selectedBill, setSelectedBill] = useState<any>(null);
  const [tripAdjustments, setTripAdjustments] = useState<any[]>([]);
  const [tripSearchTerm, setTripSearchTerm] = useState('');
  const [adjustmentData, setAdjustmentData] = useState({ received_amount: '', tds_deducted: '', remarks: '', deposit_bank: '' });

  // Filters
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadUnbilled = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const p = new URLSearchParams({ limit: '2000' });
      if (fromDate) p.set('from', fromDate);
      if (toDate) p.set('to', toDate);
      setPayload(await fetchJson(`${BILLING}/bills/unbilled-trips?${p}`));
    } catch (e: any) {
      setPayload(null);
      setErr(`Billable trips could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  }, [fromDate, toDate]);

  const loadBills = useCallback(async () => {
    try {
      const j = await fetchJson(`${BILLING}/bills?limit=500`);
      setBills(j.bills || []);
      setBillTotals(j.totals || null);
    } catch (e: any) {
      setBills([]);
      setErr((prev) => prev || `Generated bills could not load — ${e.message}`);
    }
  }, []);

  useEffect(() => { loadUnbilled(); }, [loadUnbilled]);
  useEffect(() => { loadBills(); }, [loadBills]);
  useEffect(() => {
    fetchJson(`${FIN}/accounts`)
      .then((j) => {
        setAccounts(j.accounts || []);
        if (j.accounts?.length) setAdjustmentData((p) => ({ ...p, deposit_bank: p.deposit_bank || j.accounts[0].ledger_name }));
      })
      .catch(() => setAccounts([]));
  }, []);

  // ── Pricing ────────────────────────────────────────────────────────────────
  // Lane rates are indexed by ship-to CODE first, because a trip's unloading
  // location carries it verbatim ('ZC7A01 -Agartala AFS 7A01'), and by
  // normalized name second. Name matching alone reached only 12 of 205 lanes.
  const laneIndex = useMemo(() => {
    const byCode = new Map<string, any>();
    const byName = new Map<string, any>();
    (payload?.lane_rates ?? []).forEach((l: any) => {
      if (l.ship_to_code) byCode.set(normKey(l.ship_to_code), l);
      if (l.ship_to_name) byName.set(normKey(l.ship_to_name), l);
    });
    return { byCode, byName };
  }, [payload]);

  const historyByMaterial = useMemo(() => {
    const m = new Map<string, any[]>();
    (payload?.rate_history ?? []).forEach((h: any) => {
      if (!m.has(h.material)) m.set(h.material, []);
      m.get(h.material)!.push(h);
    });
    return m;
  }, [payload]);

  const findLane = useCallback((t: any) => {
    const hay = `${t.unloading_location ?? ''} ${t.consignee_name ?? ''}`;
    for (const [code, lane] of laneIndex.byCode) {
      if (code && normKey(hay).includes(code)) return lane;
    }
    return laneIndex.byName.get(normKey(t.consignee_name)) || laneIndex.byName.get(normKey(t.unloading_location)) || null;
  }, [laneIndex]);

  useEffect(() => {
    if (!payload) { setPriced([]); return; }
    const routes = payload.routes ?? [];
    setPriced((payload.trips ?? []).map((t: any) => {
      const loadDate = String(t.loading_date ?? '').slice(0, 10);
      const route = findRouteForTrip(routes, t);
      const lane = findLane(t);

      // RTKM: the trip's own value wins (it was billed with it), then the lane
      // card derived from real bills, then the route master.
      const rtkm = Number(t.rtkm) || Number(lane?.current_rtd) || Number(route?.RTKM_Distance) || 0;
      const capacityKl = parseCapacity(route?.Vehicle_Capacity);
      const qty = Number(t.loaded_qty) || 0;

      // Rate: the trip's own, else the lane card. Never invented.
      const tripRate = Number(t.rate) || 0;
      const laneRate = Number(lane?.current_rate) || 0;
      const rate = tripRate > 0 ? tripRate : laneRate;
      const rateSource = tripRate > 0 ? 'trip' : laneRate > 0 ? 'lane' : 'none';

      const bt = rtkm > 0 && rate > 0 && rate <= 25 ? 'RTKM_QTY' : (route?.Billing_Type || 'PER_KL');
      const gross = Number(t.freight_amount) > 0
        ? Number(t.freight_amount)
        : computeFreight(effectiveBillingType(bt, rate, rtkm), { qty, rate, rtkm, capacityKl });
      const penalty = Number(t.shortage_penalty) || 0;
      const tds = r2(gross * (TDS_PCT / 100));

      const opts = new Set<number>();
      if (laneRate > 0) opts.add(Number(laneRate));
      (historyByMaterial.get(lane?.material) ?? []).forEach((h: any) => {
        if (Number(h.rate) > 0) opts.add(Number(h.rate));
      });
      const rr = route ? resolveRate(route, loadDate) : { rate: 0 };
      if (Number(rr.rate) > 0) opts.add(Number(rr.rate));

      return {
        ...t,
        calc_qty: qty,
        calc_rate: rate,
        calc_gross: gross,
        calc_penalty: penalty,
        calc_tds: tds,
        calc_net: r2(gross - penalty - tds),
        calc_bt: effectiveBillingType(bt, rate, rtkm),
        calc_rtkm: rtkm,
        calc_capacity: capacityKl,
        calc_rate_source: rateSource,
        calc_rate_options: [...opts].sort((a, b) => a - b),
        calc_lane: lane ? `${lane.ship_to_code} · ${lane.loads} load(s) billed` : '',
        calc_route_label: route
          ? `${route.Depot_Link ?? ''} ➔ ${route.Consignee_Name ?? ''}`.trim()
          : `${t.loading_point ?? ''} ➔ ${t.consignee_name ?? t.unloading_location ?? ''}`.trim(),
      };
    }));
  }, [payload, findLane, historyByMaterial]);

  const recalc = (t: any, patch: any) => {
    const n = { ...t, ...patch };
    const gross = computeFreight(effectiveBillingType(n.calc_bt, n.calc_rate, n.calc_rtkm), {
      qty: n.calc_qty, rate: n.calc_rate, rtkm: n.calc_rtkm, capacityKl: n.calc_capacity,
    });
    const tds = r2(gross * (TDS_PCT / 100));
    return { ...n, calc_gross: gross, calc_tds: tds, calc_net: r2(gross - n.calc_penalty - tds) };
  };

  const editTripQtyRate = (tripId: string, field: 'qty' | 'rate', value: string) => {
    setPriced((prev) => prev.map((t) => t.id !== tripId ? t
      : recalc(t, { [field === 'qty' ? 'calc_qty' : 'calc_rate']: parseFloat(value) || 0 })));
  };

  // Persisted so the figure survives a reload; the endpoint refuses a trip that
  // is already on a live bill rather than letting it drift from what was sent.
  const persistTripQtyRate = async (t: any) => {
    try {
      await fetchJson(`${BILLING}/trips/${t.id}/freight`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loaded_qty: t.calc_qty, rate: t.calc_rate, rtkm: t.calc_rtkm, freight_amount: t.calc_gross }),
      });
    } catch (e: any) {
      alert(`❌ ${t.vehicle_no || t.trip_code || ''}: qty/rate not saved — ${e.message}`);
    }
  };

  // ── Generate ───────────────────────────────────────────────────────────────
  const handleGenerateInvoice = async () => {
    const sel = priced.filter((t) => selectedTripsForBill.includes(t.id));
    if (!sel.length) return alert('⚠️ Select at least one trip.');
    const unpriced = sel.filter((t) => !(t.calc_gross > 0));
    if (unpriced.length) {
      return alert(`⚠️ ${unpriced.length} selected trip(s) have no freight figure yet.\n\n`
        + `${unpriced.slice(0, 6).map((t) => `• ${t.vehicle_no || t.trip_code} — qty ${t.calc_qty}, rate ${t.calc_rate}`).join('\n')}`
        + `\n\nFill qty × rate from the challan first — a bill of ₹0 will not reconcile.`);
    }

    setBusy(true);
    try {
      const out = await fetchJson(`${BILLING}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gst_rate_pct: GST_PCT,
          tds_rate_pct: TDS_PCT,
          company: sel[0].operating_company || null,
          trips: sel.map((t) => ({
            trip_id: t.id, qty: t.calc_qty, rate: t.calc_rate, rtkm: t.calc_rtkm,
            billing_type: t.calc_bt, gross_freight: t.calc_gross, shortage_amt: t.calc_penalty,
          })),
        }),
      });
      logAudit({ action: 'BILL_GENERATED', target: out.bill.bill_no, details: `${out.lines} trips, net ₹${out.bill.total_net}` });
      alert(`✅ Invoice ${out.bill.bill_no} raised.\n\n`
        + `Gross ₹${inr(out.bill.total_gross)}\nShortage −₹${inr(out.bill.total_shortage)}\n`
        + `TDS ${TDS_PCT}% −₹${inr(out.bill.total_tds)}\nNet expected ₹${inr(out.bill.total_net)}\n\n`
        + `GST ${GST_PCT}% (₹${inr(Number(out.bill.total_cgst) + Number(out.bill.total_sgst))}) is recorded as a reverse-charge memo — the customer discharges it, so it is not added to the net.`);
      setSelectedTripsForBill([]);
      setShowPreview(false);
      setActiveTab('GENERATED_BILLS');
      loadUnbilled();
      loadBills();
    } catch (e: any) {
      const hint = {
        MIXED_CUSTOMER: 'One bill covers one customer.',
        MIXED_LOCATION: 'Oil companies bill per plant — select one location.',
        CUSTOMER_UNLINKED: 'Some trips have no customer master.',
        ALREADY_BILLED: 'Some trips are already on a bill.',
      }[e.code];
      alert(`❌ ${hint ?? 'Invoice not raised.'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  const handleCancelBill = async (bill: any) => {
    const reason = window.prompt(
      `Cancel invoice ${bill.bill_no}?\n\nIts ${bill.trip_count} trip(s) go back to the pending list.\n\nReason (required):`);
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await fetchJson(`${BILLING}/bills/${bill.id}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      logAudit({ action: 'BILL_CANCELLED', target: bill.bill_no, details: reason.trim() });
      alert(`🗑️ ${bill.bill_no} cancelled. Its trips are billable again.`);
      loadBills(); loadUnbilled();
    } catch (e: any) {
      alert(`❌ Not cancelled.\n\n${e.message}${e.code === 'VOUCHER_POSTED' || e.code === 'BILL_SETTLED'
        ? '\n\nMoney has been received against this bill. Reverse the receipt in Cash & Bank Book first — the ledger keeps the history either way.' : ''}`);
    }
    setBusy(false);
  };

  // ── Settle ─────────────────────────────────────────────────────────────────
  const openAdjustmentModal = async (bill: any) => {
    setBusy(true);
    try {
      const full = await fetchJson(`${BILLING}/bills/${bill.id}`);
      setSelectedBill({ ...full.bill, company_master: full.company_master, customer_master: full.customer_master });
      setTripAdjustments(full.trips.map((t: any) => ({
        ...t,
        final_passed_amt: t.payment_status === 'SETTLED' ? t.final_passed_amt : t.net_payable,
        extra_shortage_amt: t.payment_status === 'SETTLED' ? t.extra_shortage_amt : 0,
        recover_from_driver: t.recover_from_driver !== false,
        selected_for_payment: false,
      })));
      setTripSearchTerm('');
      setAdjustmentData({ received_amount: '', tds_deducted: '', remarks: '', deposit_bank: accounts[0]?.ledger_name || '' });
      setIsAdjustModalOpen(true);
    } catch (e: any) {
      alert(`❌ Could not open the bill — ${e.message}`);
    }
    setBusy(false);
  };

  const recalculateTotals = (rows: any[]) => {
    let rcv = 0, tds = 0;
    rows.forEach((t) => {
      if (t.selected_for_payment && t.payment_status !== 'SETTLED') {
        rcv += Number(t.final_passed_amt) || 0;
        tds += Number(t.tds_amt) || 0;
      }
    });
    setAdjustmentData((p) => ({ ...p, received_amount: rcv.toFixed(2), tds_deducted: tds.toFixed(2) }));
  };

  const handleTripSelection = (idx: number, checked: boolean) => {
    const rows = [...tripAdjustments];
    rows[idx].selected_for_payment = checked;
    setTripAdjustments(rows);
    recalculateTotals(rows);
  };

  const handleTripShortageChange = (idx: number, field: string, value: any) => {
    const rows = [...tripAdjustments];
    rows[idx][field] = value;
    if (field === 'extra_shortage_amt') {
      rows[idx].final_passed_amt = r2((Number(rows[idx].net_payable) || 0) - (Number(value) || 0));
    }
    setTripAdjustments(rows);
    recalculateTotals(rows);
  };

  const submitSettlement = async (dryRun: boolean) => {
    const rows = tripAdjustments.filter((t) => t.selected_for_payment && t.payment_status !== 'SETTLED');
    if (!rows.length) return alert('⚠️ Select at least one pending trip.');
    if (!adjustmentData.deposit_bank) return alert('⚠️ Choose the bank/cash account the money landed in.');

    setBusy(true);
    try {
      const out = await fetchJson(`${BILLING}/bills/${selectedBill.id}/settle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: adjustmentData.deposit_bank,
          trip_ids: rows.map((t) => t.trip_id),
          received_amount: parseFloat(adjustmentData.received_amount) || undefined,
          tds_deducted: adjustmentData.tds_deducted === '' ? undefined : parseFloat(adjustmentData.tds_deducted),
          remarks: adjustmentData.remarks || null,
          dry_run: dryRun,
          adjustments: rows.map((t) => ({
            trip_id: t.trip_id,
            extra_shortage_amt: Number(t.extra_shortage_amt) || 0,
            recover_from_driver: t.recover_from_driver !== false,
            final_passed_amt: Number(t.final_passed_amt) || 0,
          })),
        }),
      });

      if (dryRun) {
        alert(`🧪 Dry run — nothing posted.\n\n`
          + `Gross credited to the debtor: ₹${inr(out.gross)}\nCash into ${adjustmentData.deposit_bank}: ₹${inr(out.cash)}\n`
          + `TDS receivable: ₹${inr(out.tds)}\n\n`
          + (out.driver_recoveries?.length
            ? `Driver recoveries:\n${out.driver_recoveries.map((r: any) => `• ${r.driver} — ₹${inr(r.amount)}`).join('\n')}`
            : 'No driver recovery.'));
      } else {
        logAudit({ action: 'BILL_SETTLED', target: out.bill.bill_no, details: `₹${out.cash} into ${adjustmentData.deposit_bank}, voucher ${out.voucher_id}` });
        alert(`✅ ₹${inr(out.cash)} received into ${adjustmentData.deposit_bank}.\n\n`
          + `Voucher: ${out.voucher_id}\nBill status: ${out.bill.status}\n`
          + (out.tds > 0 ? `TDS receivable booked: ₹${inr(out.tds)}\n` : '')
          + (out.driver_recoveries?.length
            ? `\nRecovered from drivers (posted to the ledger):\n${out.driver_recoveries.map((r: any) => `• ${r.driver} — ₹${inr(r.amount)}`).join('\n')}`
            : '')
          + (out.adopted_existing_voucher ? '\n\nNote: a receipt for this reference was already posted; this run completed the bookkeeping without charging again.' : ''));
        setIsAdjustModalOpen(false);
        loadBills(); loadUnbilled();
      }
    } catch (e: any) {
      const hint = {
        OVERDRAFT: 'That account does not hold enough for this entry.',
        ALREADY_SETTLED: 'Those trips are already settled.',
        DUPLICATE_REF: 'This exact receipt is already posted.',
      }[e.code];
      alert(`❌ ${hint ?? 'Settlement failed.'}\n\n${e.message}`);
    }
    setBusy(false);
  };

  // ── Company PDF reconciliation ─────────────────────────────────────────────
  // Reads the oil company's finalized bill and writes back the billed qty/rate
  // it states, trip by trip, through the freight endpoint. Payment stays pending
  // until money actually lands — reconciling a document is not receiving cash.
  const handleReconcileCompanyPdf = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setReconciling(true);
    try {
      const prompt = `This is a transporter freight bill / payment advice from an Indian oil company (IOCL/HPCL/BPCL). Extract every trip row and reply ONLY JSON:
{ "bill_no": "", "bill_date": "DD-MM-YYYY", "rows": [ { "vehicle_no": "", "date": "DD-MM-YYYY", "lr_no": "", "qty_kl": 0, "rate": 0, "amount": 0 } ] }
vehicle_no: Indian plate, uppercase, no spaces. date: the trip/loading date on that row.
qty_kl: the BILLED QUANTITY of that row in KL (kilolitres) — if printed in litres divide by 1000; plain number.
rate: the FREIGHT RATE of that row — the small per-unit figure, NOT the total; plain number, strip currency symbols and commas.
amount: the row's gross/total freight amount. Empty string / 0 if absent.`;
      const ai = await extractJsonFromImage(file, prompt);
      const rows = Array.isArray(ai.rows) ? ai.rows : [];
      if (!rows.length) {
        alert('⚠️ No trip rows could be read from that PDF. Try a clearer file, or enter qty/rate inline.');
        setReconciling(false);
        return;
      }

      let matched = 0;
      const missed: string[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const m = matchTripForBill(priced, r.vehicle_no, parseDocDate(r.date), 3);
        if (!m.trip || seen.has(m.trip.id)) { missed.push(r.vehicle_no || '?'); continue; }
        seen.add(m.trip.id);
        const qty = Number(r.qty_kl) || 0;
        const rate = Number(r.rate) || 0;
        const amount = Number(r.amount) || 0;
        const body: any = {};
        if (qty > 0) body.loaded_qty = qty;
        if (rate > 0) body.rate = rate;
        if (qty > 0 && rate > 0) {
          body.freight_amount = computeFreight(
            effectiveBillingType(m.trip.calc_bt, rate, m.trip.calc_rtkm),
            { qty, rate, rtkm: m.trip.calc_rtkm, capacityKl: m.trip.calc_capacity });
        } else if (amount > 0) {
          body.freight_amount = amount;
        }
        if (!Object.keys(body).length) { missed.push(r.vehicle_no || '?'); continue; }
        try {
          await fetchJson(`${BILLING}/trips/${m.trip.id}/freight`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          matched++;
        } catch { missed.push(r.vehicle_no || '?'); }
      }
      logAudit({ action: 'COMPANY_PDF_RECONCILE', target: ai.bill_no || file.name, details: `${matched} trips priced, ${missed.length} unmatched` });
      alert(`📄 ${ai.bill_no || 'Company bill'}\n\n✅ ${matched} trip(s) priced from the document`
        + (missed.length ? `\n⚠️ ${missed.length} row(s) unmatched (${[...new Set(missed)].slice(0, 5).join(', ')})` : '')
        + `\n\nPayment stays PENDING until the money is actually received.`);
      loadUnbilled();
    } catch (e: any) {
      const offline = e?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(e?.message || '');
      alert(offline ? '❌ The local AI engine (Ollama) is not reachable.' : `❌ Could not read that PDF — ${e.message}`);
    }
    setReconciling(false);
  };

  // ── Print (oil-company format) ─────────────────────────────────────────────
  const handlePrintInvoice = async (bill: any) => {
    const w = window.open('', '_blank');
    if (!w) return alert('Please allow popups to print invoices.');
    let full: any;
    try {
      full = await fetchJson(`${BILLING}/bills/${bill.id}`);
    } catch (e: any) {
      w.close();
      return alert(`❌ Could not load the bill — ${e.message}`);
    }
    const b = full.bill, trips = full.trips || [];
    const co = full.company_master || {}, cu = full.customer_master || {};
    const d = (x: any) => { const s = String(x || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : (s || '-'); };

    const grouped = trips.reduce((acc: any, t: any) => {
      (acc[t.vehicle_no || '-'] = acc[t.vehicle_no || '-'] || []).push(t);
      return acc;
    }, {});
    let rowsHTML = '', sNo = 1, tGross = 0, tPen = 0, tCg = 0, tSg = 0;
    Object.keys(grouped).sort().forEach((veh) => {
      rowsHTML += `<tr><td colspan="13" style="font-weight:bold;background:#f1f5f9;padding:6px;">${veh}</td></tr>`;
      let vG = 0, vP = 0, vCg = 0, vSg = 0;
      grouped[veh].forEach((t: any) => {
        const gross = Number(t.gross_freight) || 0;
        const cg = Number(t.cgst_amt) || 0, sg = Number(t.sgst_amt) || 0;
        vG += gross; vP += Number(t.shortage_amt) || 0; vCg += cg; vSg += sg;
        rowsHTML += `<tr style="font-size:11px;">
          <td style="text-align:center;">${sNo++}</td>
          <td>${t.lr_no || t.trip_code || ''}</td>
          <td>${d(t.loading_date)}</td>
          <td style="font-size:10px;">${b.location || b.customer_name || ''}</td>
          <td style="text-align:right;">${Number(t.qty) || 0}</td>
          <td style="text-align:right;">0.000</td>
          <td style="text-align:right;">${Number(t.rtkm) || '-'}</td>
          <td style="text-align:right;">${Number(t.rate) || 0}</td>
          <td style="text-align:right;">${inr(gross)}</td>
          <td style="text-align:right;">${inr(t.shortage_amt)}</td>
          <td style="text-align:right;">0.00</td>
          <td style="text-align:right;">${inr(cg)}</td>
          <td style="text-align:right;">${inr(sg)}</td></tr>`;
      });
      tGross += vG; tPen += vP; tCg += vCg; tSg += vSg;
      rowsHTML += `<tr style="font-weight:bold;font-size:11px;">
        <td colspan="8" style="text-align:right;padding:6px;">Subtotal for Vehicle:</td>
        <td style="text-align:right;">${inr(vG)}</td><td style="text-align:right;">${inr(vP)}</td>
        <td style="text-align:right;">0.00</td><td style="text-align:right;">${inr(vCg)}</td>
        <td style="text-align:right;">${inr(vSg)}</td></tr>`;
    });

    w.document.write(`<html><head><title>Transportation Bill - ${b.bill_no}</title><style>
      body{font-family:Arial,sans-serif;padding:16px;color:#000;font-size:12px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #000;padding:4px 5px}
      th{background:#eee;text-align:center;font-size:10px}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
      .hdr h2{margin:2px 0;font-size:15px}
      @media print{body{padding:0}th,tr{-webkit-print-color-adjust:exact}}
    </style></head><body>
      <div class="hdr">
        <div><h2>${b.location || b.customer_name}</h2>
          ${cu.gst_no ? `<div>(GSTIN:- ${cu.gst_no})</div>` : ''}
          <div>${b.customer_name}</div></div>
        <div style="text-align:center;align-self:center;"><h2 style="font-size:18px;text-decoration:underline;">Transportation Bill</h2></div>
        <div style="text-align:right;"><b>Tax Invoice issued by:-</b><br/>
          <b>${co.company_name || b.company || 'PRASAD TRANSPORT'}</b><br/>
          ${co.gstin ? `GSTIN:- ${co.gstin}<br/>` : ''}
          ${co.pan_no ? `PAN:- ${co.pan_no}<br/>` : ''}
          <b>Period: ${d(b.period_from || b.bill_date)} to ${d(b.period_to || b.bill_date)}</b></div>
      </div>
      <table><thead><tr>
        <th>SNo.</th><th>Invoice/LR No.</th><th>Date</th><th>Ship-to-party</th>
        <th>Quantity</th><th>Shortage</th><th>RTD</th><th>RATE</th>
        <th>Gross Amt.(Rs.)</th><th>PenaltyAmt.(Rs.)</th><th>IGST(Rs.)</th><th>CGST(Rs.)</th><th>S/UGST(Rs.)</th>
      </tr></thead><tbody>
        <tr><td colspan="8" style="font-weight:bold;padding:6px;">Reverse Charge</td>
            <td colspan="5" style="text-align:right;font-weight:bold;">Bill No. &amp; Date:- ${b.bill_no} ${d(b.bill_date)}</td></tr>
        ${rowsHTML}
        <tr style="font-weight:900;font-size:12px;background:#e2e8f0;">
          <td colspan="8" style="text-align:right;padding:8px;">Total for Bill:</td>
          <td style="text-align:right;">${inr(tGross)}</td><td style="text-align:right;">${inr(tPen)}</td>
          <td style="text-align:right;">0.00</td><td style="text-align:right;">${inr(tCg)}</td>
          <td style="text-align:right;">${inr(tSg)}</td></tr>
      </tbody></table>
      <div style="margin-top:10px;border:1px solid #000;padding:8px;width:340px;margin-left:auto;font-size:12px;">
        <div style="display:flex;justify-content:space-between;"><span>Gross Total:</span><b>₹${inr(b.total_gross)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span>Shortage/Penalty (−):</span><b>₹${inr(b.total_shortage)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span>TDS ${TDS_PCT}% (−):</span><b>₹${inr(b.total_tds)}</b></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid #000;margin-top:4px;padding-top:4px;"><span><b>NET EXPECTED:</b></span><b>₹${inr(b.total_net)}</b></div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>Received:</span><b>₹${inr(b.received_amount)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span>Outstanding:</span><b>₹${inr(b.outstanding)}</b></div>
      </div>
      <p style="font-size:10px;margin-top:12px;">* System generated document for vehicles acknowledged during the above period. | ** GST payable by ${b.customer_name || 'Consignee'} under Reverse Charge. | *** TDS deducted, as applicable.</p>
      <div style="margin-top:40px;text-align:right;"><p style="margin:0 0 40px 0;"><strong>for ${co.company_name || b.company || 'PRASAD TRANSPORT'}</strong></p>
        <p style="margin:0;">Authorised Signatory</p></div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  };

  // ── Derived views ──────────────────────────────────────────────────────────
  const customersList = useMemo(
    () => [...new Set(priced.map((t) => t.customer_name).filter(Boolean))].sort(),
    [priced]);

  const filteredUnbilledTrips = useMemo(() => priced.filter((t) => {
    if (selectedCustomer !== 'ALL' && t.customer_name !== selectedCustomer) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return [t.vehicle_no, t.trip_code, t.driver_name, t.customer_name, t.unloading_location, t.consignee_name]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  }), [priced, selectedCustomer, searchQuery]);

  const tripLocation = (t: any) =>
    String(t.unloading_location || t.consignee_name || '').replace(/\s+/g, ' ').trim().toUpperCase() || 'OTHER LOCATION';

  const groupedUnbilled = useMemo(() => filteredUnbilledTrips.reduce((acc: any, t: any) => {
    const c = t.customer_name || 'Unknown Customer';
    const l = tripLocation(t);
    acc[c] = acc[c] || {};
    (acc[c][l] = acc[c][l] || []).push(t);
    return acc;
  }, {}), [filteredUnbilledTrips]);

  const filteredGeneratedBills = useMemo(() => bills.filter((b) => {
    if (selectedCustomer !== 'ALL' && b.customer_name !== selectedCustomer) return false;
    if (fromDate && b.bill_date && b.bill_date < fromDate) return false;
    if (toDate && b.bill_date && b.bill_date > toDate) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return [b.bill_no, b.customer_name, b.location].some((v) => String(v ?? '').toLowerCase().includes(q));
  }), [bills, selectedCustomer, fromDate, toDate, searchQuery]);

  const selectedTripData = priced.filter((t) => selectedTripsForBill.includes(t.id));
  const previewCustomers = [...new Set(selectedTripData.map((t) => t.customer_name))];
  const previewLocations = [...new Set(selectedTripData.map((t) => tripLocation(t)))];
  const previewTotals = selectedTripData.reduce((a, t) => ({
    gross: a.gross + t.calc_gross, pen: a.pen + t.calc_penalty, tds: a.tds + t.calc_tds, net: a.net + t.calc_net,
  }), { gross: 0, pen: 0, tds: 0, net: 0 });

  const unpricedCount = filteredUnbilledTrips.filter((t) => !(t.calc_gross > 0)).length;
  const daysSince = (d: any) => (d ? Math.max(0, Math.floor((Date.now() - +new Date(d)) / 86400000)) : 0);

  const filteredTripAdjustments = tripAdjustments.filter((t) =>
    !tripSearchTerm
    || String(t.vehicle_no ?? '').toLowerCase().includes(tripSearchTerm.toLowerCase())
    || String(t.trip_code ?? '').toLowerCase().includes(tripSearchTerm.toLowerCase())
    || String(t.lr_no ?? '').toLowerCase().includes(tripSearchTerm.toLowerCase()));

  return (
    <div className="pt-anim-fade" style={{ padding: 'clamp(14px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .glass-card { background: rgba(30,41,59,0.4); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg,#10b981,#059669); color:#fff; border:none; padding:12px 25px; border-radius:8px; font-weight:bold; cursor:pointer; transition:.3s; box-shadow:0 4px 15px rgba(16,185,129,.4); }
        .glow-btn:hover { transform: translateY(-2px); }
        .glow-btn:disabled { opacity:.5; cursor:not-allowed; transform:none; }
        .tab-btn { padding:12px 25px; background:transparent; color:#94a3b8; border:none; border-bottom:3px solid transparent; cursor:pointer; font-weight:bold; font-size:14px; }
        .tab-btn.active { color:#38bdf8; border-bottom:3px solid #38bdf8; background:rgba(56,189,248,.1); border-radius:8px 8px 0 0; }
        .modern-input { background:rgba(15,23,42,.6); border:1px solid rgba(51,65,85,.8); border-radius:8px; color:#fff; padding:12px; width:100%; box-sizing:border-box; outline:none; color-scheme:dark; }
        .modern-input:focus { border-color:#38bdf8; }
        table { width:100%; border-collapse:collapse; margin-top:10px; color:#cbd5e1; font-size:13px; }
        th { background:rgba(0,0,0,.3); padding:12px; text-align:left; border-bottom:2px solid #334155; color:#38bdf8; text-transform:uppercase; font-size:11px; letter-spacing:1px; }
        td { padding:12px; border-bottom:1px solid #334155; }
        tr:hover { background:rgba(255,255,255,.02); }
        .badge { padding:4px 10px; border-radius:12px; font-size:10px; font-weight:bold; letter-spacing:1px; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 25, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: 32, fontWeight: 900, letterSpacing: '-0.5px' }}>Company Billing & Reconciliation</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Live PostgreSQL · money posted through TARA's double-entry ledger</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label className="glow-btn" style={{ background: 'linear-gradient(135deg,#8b5cf6,#6d28d9)', boxShadow: 'none', display: 'inline-block' }}>
            {reconciling ? '⏳ Reading…' : '📄 Reconcile Company PDF'}
            <input type="file" accept="application/pdf,image/*" onChange={handleReconcileCompanyPdf} disabled={reconciling} style={{ display: 'none' }} />
          </label>
          <button onClick={() => { loadUnbilled(); loadBills(); }} className="glow-btn" style={{ background: '#1e293b', color: '#38bdf8', boxShadow: 'none', border: '1px solid #38bdf8' }}>🔄 Refresh</button>
        </div>
      </div>

      {err && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', color: '#fca5a5', padding: '16px 20px', borderRadius: 12, marginBottom: 20, fontSize: 14 }}>
          ⚠️ {err}
          <div style={{ color: '#94a3b8', marginTop: 6, fontSize: 12 }}>Reads <code>{BILLING}</code>. Check that the ERP API is running.</div>
        </div>
      )}

      {/* DASHBOARD */}
      <div className="pt-stagger" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        {[
          { label: 'Pending billing', value: filteredUnbilledTrips.length, sub: 'completed, not billed', color: '#38bdf8' },
          { label: 'Unpriced trips', value: unpricedCount, sub: 'need qty × rate', color: unpricedCount ? '#ef4444' : '#10b981' },
          { label: 'Billable value', value: `₹${inr0(filteredUnbilledTrips.reduce((s, t) => s + t.calc_net, 0))}`, sub: 'net of TDS & shortage', color: '#10b981' },
          { label: 'Outstanding on bills', value: `₹${inr0(billTotals?.outstanding ?? 0)}`, sub: `${bills.filter((b) => b.status !== 'SETTLED' && b.status !== 'CANCELLED').length} open`, color: '#f59e0b' },
        ].map((c) => (
          <div key={c.label} className="glass-card" style={{ padding: '16px 20px', minWidth: 190, flex: '1 1 190px' }}>
            <div style={{ color: c.color, fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1 }}>{c.label}</div>
            <div style={{ color: '#fff', fontSize: 26, fontWeight: 900, marginTop: 4 }}>{c.value}</div>
            <div style={{ color: '#64748b', fontSize: 11 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* FILTERS */}
      <div className="glass-card" style={{ padding: 18, marginBottom: 20, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ color: '#94a3b8', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Customer</label>
          <select className="modern-input" value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} style={{ marginTop: 5 }}>
            <option value="ALL">-- All customers --</option>
            {customersList.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <label style={{ color: '#94a3b8', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>From</label>
          <input type="date" className="modern-input" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ marginTop: 5 }} />
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <label style={{ color: '#94a3b8', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>To</label>
          <input type="date" className="modern-input" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ marginTop: 5 }} />
        </div>
        <div style={{ flex: '2 1 240px' }}>
          <label style={{ color: '#f59e0b', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Search</label>
          <input className="modern-input" placeholder="🔍 Vehicle, trip, driver, bill no, location…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ marginTop: 5 }} />
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, borderBottom: '1px solid #334155', flexWrap: 'wrap' }}>
        <button className={`tab-btn ${activeTab === 'UNBILLED_TRIPS' ? 'active' : ''}`} onClick={() => setActiveTab('UNBILLED_TRIPS')}>
          🚚 PENDING BILLING {filteredUnbilledTrips.length > 0 && <span className="badge" style={{ background: '#10b981', color: '#04241a', marginLeft: 6 }}>{filteredUnbilledTrips.length}</span>}
        </button>
        <button className={`tab-btn ${activeTab === 'GENERATED_BILLS' ? 'active' : ''}`} onClick={() => setActiveTab('GENERATED_BILLS')}>
          🧾 GENERATED INVOICES {filteredGeneratedBills.length > 0 && <span className="badge" style={{ background: '#38bdf8', color: '#04222e', marginLeft: 6 }}>{filteredGeneratedBills.length}</span>}
        </button>
      </div>

      {/* ── PENDING BILLING ── */}
      {activeTab === 'UNBILLED_TRIPS' && (
        <div className="glass-card" style={{ padding: 18, overflowX: 'auto' }}>
          {selectedTripsForBill.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.35)', borderRadius: 10, padding: '12px 16px', marginBottom: 14 }}>
              <div style={{ color: '#cbd5e1', fontSize: 13 }}>
                <b style={{ color: '#10b981' }}>{selectedTripsForBill.length} trip(s)</b> selected · net ₹{inr(previewTotals.net)}
                {previewCustomers.length > 1 && <span style={{ color: '#f87171' }}> · ⚠️ {previewCustomers.length} customers</span>}
                {previewLocations.length > 1 && <span style={{ color: '#fbbf24' }}> · ⚠️ {previewLocations.length} locations</span>}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setSelectedTripsForBill([])} className="glow-btn" style={{ background: '#334155', boxShadow: 'none' }}>Clear</button>
                <button onClick={() => setShowPreview(true)} className="glow-btn" disabled={busy}>Preview & Raise Bill →</button>
              </div>
            </div>
          )}

          {loading ? (
            <div style={{ color: '#38bdf8', fontWeight: 'bold', padding: 30, textAlign: 'center' }}>Loading billable trips from PostgreSQL…</div>
          ) : isPhone ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {filteredUnbilledTrips.length === 0 && <div style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>No billable trips.</div>}
              {filteredUnbilledTrips.map((t) => (
                <div key={t.id} onClick={() => setSelectedTripsForBill((p) => p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id])}
                  style={{ background: selectedTripsForBill.includes(t.id) ? 'rgba(16,185,129,0.12)' : 'rgba(15,23,42,0.6)', border: `1px solid ${selectedTripsForBill.includes(t.id) ? '#10b981' : '#334155'}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <b style={{ color: '#fff' }}>{t.vehicle_no}</b>
                    <b style={{ color: t.calc_net > 0 ? '#10b981' : '#ef4444' }}>₹{inr(t.calc_net)}</b>
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>{t.customer_name}</div>
                  <div style={{ color: '#64748b', fontSize: 11 }}>{tripLocation(t)}</div>
                  <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>
                    Qty {t.calc_qty} × ₹{t.calc_rate} {t.calc_rtkm > 0 && `× ${t.calc_rtkm}km`}
                    {t.calc_rate_source === 'none' && <span style={{ color: '#ef4444', fontWeight: 'bold' }}> · no rate</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40, textAlign: 'center' }}>
                    <input type="checkbox" title="Select all listed" style={{ transform: 'scale(1.3)', cursor: 'pointer', accentColor: '#10b981' }}
                      checked={filteredUnbilledTrips.length > 0 && filteredUnbilledTrips.every((t) => selectedTripsForBill.includes(t.id))}
                      onChange={(e) => setSelectedTripsForBill(e.target.checked ? filteredUnbilledTrips.map((t) => t.id) : [])} />
                  </th>
                  <th>Dates</th>
                  <th>Trip / LR</th>
                  <th>Vehicle & Route</th>
                  <th>Qty × Rate</th>
                  <th style={{ textAlign: 'right' }}>Gross (₹)</th>
                  <th style={{ textAlign: 'right' }}>Short/Pen (₹)</th>
                  <th style={{ textAlign: 'right', color: '#f59e0b' }}>TDS ({TDS_PCT}%)</th>
                  <th style={{ textAlign: 'right', color: '#10b981' }}>Net Pay (₹)</th>
                </tr>
              </thead>
              <tbody>
                {filteredUnbilledTrips.length === 0 ? (
                  <tr><td colSpan={9} style={{ textAlign: 'center', padding: 30, color: '#64748b' }}>
                    No billable trips. Complete the unloads first, or clear the filters.
                  </td></tr>
                ) : Object.entries(groupedUnbilled).map(([cust, locMap]: any) => {
                  const custTrips: any[] = Object.values(locMap).flat();
                  return (
                    <React.Fragment key={cust}>
                      <tr style={{ background: 'rgba(56,189,248,0.07)' }}>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" title={`Select all ${cust} trips`} style={{ transform: 'scale(1.3)', cursor: 'pointer', accentColor: '#38bdf8' }}
                            checked={custTrips.every((t) => selectedTripsForBill.includes(t.id))}
                            onChange={(e) => setSelectedTripsForBill((prev) => e.target.checked
                              ? [...new Set([...prev, ...custTrips.map((t) => t.id)])]
                              : prev.filter((id) => !custTrips.some((t) => t.id === id)))} />
                        </td>
                        <td colSpan={4} style={{ fontWeight: 900, color: '#38bdf8', fontSize: 13 }}>
                          👤 {cust} <span style={{ color: '#94a3b8', fontWeight: 'normal' }}>· {custTrips.length} trip(s) · {Object.keys(locMap).length} location(s)</span>
                        </td>
                        <td colSpan={3} />
                        <td style={{ textAlign: 'right', color: '#38bdf8', fontWeight: 900 }}>₹{inr0(custTrips.reduce((s, t) => s + t.calc_net, 0))}</td>
                      </tr>
                      {Object.entries(locMap).map(([loc, locTrips]: any) => (
                        <React.Fragment key={cust + loc}>
                          <tr style={{ background: 'rgba(245,158,11,0.06)' }}>
                            <td style={{ textAlign: 'center' }}>
                              <input type="checkbox" title={`Select all ${loc} trips (one bill per location)`} style={{ transform: 'scale(1.2)', cursor: 'pointer', accentColor: '#f59e0b' }}
                                checked={locTrips.every((t: any) => selectedTripsForBill.includes(t.id))}
                                onChange={(e) => setSelectedTripsForBill((prev) => e.target.checked
                                  ? [...new Set([...prev, ...locTrips.map((t: any) => t.id)])]
                                  : prev.filter((id) => !locTrips.some((t: any) => t.id === id)))} />
                            </td>
                            <td colSpan={4} style={{ fontWeight: 'bold', color: '#f59e0b', fontSize: 12, paddingLeft: 28 }}>
                              🏭 {loc} <span style={{ color: '#94a3b8', fontWeight: 'normal' }}>· {locTrips.length} trip(s)</span>
                            </td>
                            <td colSpan={3} />
                            <td style={{ textAlign: 'right', color: '#f59e0b', fontWeight: 'bold', fontSize: 12 }}>₹{inr0(locTrips.reduce((s: number, t: any) => s + t.calc_net, 0))}</td>
                          </tr>
                          {locTrips.map((t: any) => {
                            const wait = daysSince(t.unloading_date);
                            return (
                              <tr key={t.id} style={{ background: selectedTripsForBill.includes(t.id) ? 'rgba(16,185,129,0.1)' : 'transparent' }}>
                                <td style={{ textAlign: 'center' }}>
                                  <input type="checkbox" style={{ transform: 'scale(1.5)', cursor: 'pointer', accentColor: '#10b981' }}
                                    checked={selectedTripsForBill.includes(t.id)}
                                    onChange={() => setSelectedTripsForBill((p) => p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id])} />
                                </td>
                                <td>
                                  <div style={{ fontSize: 11, color: '#94a3b8' }}>Ld: {t.loading_date || '-'}</div>
                                  <div style={{ fontSize: 12, fontWeight: 'bold', color: '#fff' }}>Un: {t.unloading_date || '-'}</div>
                                  {wait > 0 && <span style={{ fontSize: 9, fontWeight: 'bold', color: wait > 7 ? '#ef4444' : '#f59e0b', border: `1px solid ${wait > 7 ? '#ef4444' : '#f59e0b'}`, borderRadius: 8, padding: '1px 6px' }}>⏱ {wait}d waiting</span>}
                                </td>
                                <td style={{ color: '#94a3b8', fontSize: 11, fontWeight: 'bold' }}>
                                  {t.trip_code}<br /><span style={{ color: '#f59e0b' }}>{t.challan_no || ''}</span>
                                </td>
                                <td style={{ fontWeight: 900, color: '#fff', fontSize: 14 }}>
                                  {t.vehicle_no}<br />
                                  <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 'normal' }}>{t.driver_name || ''}</span>
                                  <div style={{ fontSize: 10, color: '#38bdf8', fontWeight: 'normal', maxWidth: 280, whiteSpace: 'normal' }}>
                                    {t.calc_route_label}
                                    {t.calc_rtkm > 0 && <b style={{ color: '#f59e0b' }}> · 📏 {t.calc_rtkm} km</b>}
                                    {t.calc_bt !== 'PER_KL' && <b style={{ color: '#c084fc' }}> · ⚙ {BILLING_TYPES.find((b) => b.key === t.calc_bt)?.label}</b>}
                                  </div>
                                  {t.calc_lane && <div style={{ fontSize: 9, color: '#64748b' }}>rate card: {t.calc_lane}</div>}
                                </td>
                                <td style={{ fontSize: 12 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <input type="number" inputMode="decimal" value={t.calc_qty} title="Billed qty, from the challan"
                                      onChange={(e) => editTripQtyRate(t.id, 'qty', e.target.value)} onBlur={() => persistTripQtyRate(t)}
                                      style={{ width: 70, background: 'rgba(15,23,42,0.7)', border: `1px solid ${t.calc_qty > 0 ? '#334155' : '#ef4444'}`, borderRadius: 6, color: '#fff', padding: 6, fontSize: 12 }} />
                                    <span style={{ color: '#64748b' }}>×</span>
                                    <input type="number" inputMode="decimal" value={t.calc_rate} title={`Freight rate (source: ${t.calc_rate_source})`}
                                      onChange={(e) => editTripQtyRate(t.id, 'rate', e.target.value)} onBlur={() => persistTripQtyRate(t)}
                                      style={{ width: 82, background: 'rgba(15,23,42,0.7)', border: `1px solid ${t.calc_rate > 0 ? '#334155' : '#ef4444'}`, borderRadius: 6, color: '#fff', padding: 6, fontSize: 12 }} />
                                    {t.calc_rate_options.length > 0 && (
                                      <select title="Rates seen on bills IOCL actually paid" value=""
                                        onChange={(e) => {
                                          if (!e.target.value) return;
                                          const rate = parseFloat(e.target.value) || 0;
                                          setPriced((prev) => prev.map((x) => x.id === t.id ? recalc(x, { calc_rate: rate }) : x));
                                          persistTripQtyRate(recalc(t, { calc_rate: rate }));
                                        }}
                                        style={{ width: 28, background: 'rgba(192,132,252,0.15)', border: '1px solid #c084fc', borderRadius: 6, color: '#c084fc', padding: '5px 2px', fontSize: 11, cursor: 'pointer' }}>
                                        <option value="">▾</option>
                                        {t.calc_rate_options.map((rv: number, i: number) => <option key={i} value={rv}>₹{rv}</option>)}
                                      </select>
                                    )}
                                  </div>
                                  {t.calc_rate_source === 'none' && <div style={{ color: '#ef4444', fontSize: 9, fontWeight: 'bold', marginTop: 3 }}>no rate known — enter it</div>}
                                  {t.calc_rate_source === 'lane' && <div style={{ color: '#34d399', fontSize: 9, marginTop: 3 }}>from the derived rate card</div>}
                                </td>
                                <td style={{ color: '#38bdf8', fontWeight: 'bold', textAlign: 'right' }}>{inr(t.calc_gross)}</td>
                                <td style={{ color: '#ef4444', fontWeight: 'bold', textAlign: 'right' }}>{inr(t.calc_penalty)}</td>
                                <td style={{ color: '#f59e0b', fontWeight: 'bold', textAlign: 'right' }}>{inr(t.calc_tds)}</td>
                                <td style={{ color: '#10b981', fontWeight: 'bold', textAlign: 'right', fontSize: 15 }}>{inr(t.calc_net)}</td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
          {payload?.truncated && (
            <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', color: '#fcd34d', padding: 12, borderRadius: 8, marginTop: 14, fontSize: 13 }}>
              Showing the first {payload.count} billable trips. Narrow the dates to see the rest.
            </div>
          )}
        </div>
      )}

      {/* ── GENERATED INVOICES ── */}
      {activeTab === 'GENERATED_BILLS' && (
        <div className="glass-card" style={{ padding: 18, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Bill No / Date</th>
                <th>Customer & Location</th>
                <th>Period</th>
                <th style={{ textAlign: 'right' }}>Gross (₹)</th>
                <th style={{ textAlign: 'right' }}>TDS (₹)</th>
                <th style={{ textAlign: 'right' }}>Net (₹)</th>
                <th style={{ textAlign: 'right' }}>Received (₹)</th>
                <th style={{ textAlign: 'right' }}>Outstanding (₹)</th>
                <th>Status</th>
                <th style={{ textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredGeneratedBills.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 30, color: '#64748b' }}>No invoices yet. Raise one from the Pending Billing tab.</td></tr>
              ) : filteredGeneratedBills.map((b) => {
                const sc = { SETTLED: '#10b981', PARTIALLY_PAID: '#f59e0b', PENDING_PAYMENT: '#38bdf8', CANCELLED: '#64748b' }[b.status] || '#94a3b8';
                return (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{b.bill_no}<br /><span style={{ color: '#64748b', fontSize: 11, fontWeight: 'normal' }}>{b.bill_date}</span></td>
                    <td>{b.customer_name}<br /><span style={{ color: '#f59e0b', fontSize: 11 }}>{b.location || '-'}</span></td>
                    <td style={{ fontSize: 11, color: '#94a3b8' }}>{b.period_from || '-'}<br />to {b.period_to || '-'}<br /><span style={{ color: '#64748b' }}>{b.trip_count} trip(s), {b.settled_trips} settled</span></td>
                    <td style={{ textAlign: 'right', color: '#38bdf8', fontWeight: 'bold' }}>{inr(b.total_gross)}</td>
                    <td style={{ textAlign: 'right', color: '#f59e0b' }}>{inr(b.total_tds)}</td>
                    <td style={{ textAlign: 'right', color: '#fff', fontWeight: 'bold' }}>{inr(b.total_net)}</td>
                    <td style={{ textAlign: 'right', color: '#10b981' }}>{inr(b.received_amount)}</td>
                    <td style={{ textAlign: 'right', color: Number(b.outstanding) > 0 ? '#ef4444' : '#10b981', fontWeight: 'bold' }}>{inr(b.outstanding)}</td>
                    <td><span className="badge" style={{ background: `${sc}22`, color: sc, border: `1px solid ${sc}` }}>{b.status.replace(/_/g, ' ')}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button onClick={() => handlePrintInvoice(b)} title="Print in the oil-company format" style={{ background: 'rgba(56,189,248,.12)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>🖨️</button>
                        {b.status !== 'SETTLED' && b.status !== 'CANCELLED' && (
                          <button onClick={() => openAdjustmentModal(b)} disabled={busy} title="Receive money" style={{ background: 'rgba(16,185,129,.12)', color: '#10b981', border: '1px solid #10b981', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>💰 Settle</button>
                        )}
                        {b.status !== 'CANCELLED' && (
                          <button onClick={() => handleCancelBill(b)} disabled={busy} title="Cancel this invoice" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid #ef4444', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>🗑️</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {billTotals && filteredGeneratedBills.length > 0 && (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 16, padding: '14px 18px', background: 'rgba(15,23,42,0.6)', borderRadius: 10, border: '1px solid #334155', fontSize: 13 }}>
              <span style={{ color: '#94a3b8' }}>All bills — gross <b style={{ color: '#38bdf8' }}>₹{inr(billTotals.gross)}</b></span>
              <span style={{ color: '#94a3b8' }}>TDS <b style={{ color: '#f59e0b' }}>₹{inr(billTotals.tds)}</b></span>
              <span style={{ color: '#94a3b8' }}>net <b style={{ color: '#fff' }}>₹{inr(billTotals.net)}</b></span>
              <span style={{ color: '#94a3b8' }}>received <b style={{ color: '#10b981' }}>₹{inr(billTotals.received)}</b></span>
              <span style={{ color: '#94a3b8' }}>outstanding <b style={{ color: '#ef4444' }}>₹{inr(billTotals.outstanding)}</b></span>
            </div>
          )}
        </div>
      )}

      {/* PREVIEW MODAL */}
      {showPreview && (
        <div style={overlay}>
          <div style={{ width: '100%', maxWidth: 960, background: '#0f172a', borderRadius: 18, border: '1px solid #10b981', padding: 26, maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ color: '#10b981', margin: 0 }}>🧾 Confirm the bill</h3>
              <button onClick={() => setShowPreview(false)} style={{ background: 'transparent', color: '#94a3b8', border: 'none', fontSize: 22, cursor: 'pointer' }}>✕</button>
            </div>
            {previewCustomers.length > 1 && (
              <div style={warn}>⚠️ {previewCustomers.length} customers selected ({previewCustomers.join(', ')}). One bill covers one customer — the server will refuse this.</div>
            )}
            {previewLocations.length > 1 && (
              <div style={warn}>⚠️ {previewLocations.length} locations selected. Oil companies bill per plant, so this will not match their document.</div>
            )}
            <div style={{ background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: 10, padding: 16, marginBottom: 16 }}>
              <div style={{ color: '#fff', fontWeight: 900, fontSize: 18 }}>{previewCustomers[0] ?? '—'}</div>
              <div style={{ color: '#f59e0b', fontSize: 13 }}>{previewLocations[0] ?? '—'}</div>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>{selectedTripData.length} trip(s)</div>
            </div>
            <table>
              <thead><tr><th>Trip</th><th>Vehicle</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Short</th><th style={{ textAlign: 'right' }}>TDS</th><th style={{ textAlign: 'right' }}>Net</th></tr></thead>
              <tbody>
                {selectedTripData.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontSize: 11 }}>{t.trip_code}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{t.vehicle_no}</td>
                    <td style={{ textAlign: 'right' }}>{t.calc_qty}</td>
                    <td style={{ textAlign: 'right' }}>{t.calc_rate}</td>
                    <td style={{ textAlign: 'right', color: '#38bdf8' }}>{inr(t.calc_gross)}</td>
                    <td style={{ textAlign: 'right', color: '#ef4444' }}>{inr(t.calc_penalty)}</td>
                    <td style={{ textAlign: 'right', color: '#f59e0b' }}>{inr(t.calc_tds)}</td>
                    <td style={{ textAlign: 'right', color: '#10b981', fontWeight: 'bold' }}>{inr(t.calc_net)}</td>
                  </tr>
                ))}
                <tr style={{ background: 'rgba(0,0,0,0.35)', fontWeight: 900 }}>
                  <td colSpan={4}>TOTAL</td>
                  <td style={{ textAlign: 'right' }}>{inr(previewTotals.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{inr(previewTotals.pen)}</td>
                  <td style={{ textAlign: 'right' }}>{inr(previewTotals.tds)}</td>
                  <td style={{ textAlign: 'right', color: '#10b981' }}>{inr(previewTotals.net)}</td>
                </tr>
              </tbody>
            </table>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 12 }}>
              GST {GST_PCT}% (₹{inr(previewTotals.gross * GST_PCT / 100)}) is recorded as a reverse-charge memo only — the customer discharges it, so it is not part of the net receivable.
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 18 }}>
              <button onClick={() => setShowPreview(false)} className="glow-btn" style={{ background: '#334155', boxShadow: 'none', flex: 1 }}>Back</button>
              <button onClick={handleGenerateInvoice} disabled={busy} className="glow-btn" style={{ flex: 2 }}>{busy ? 'Raising…' : '✅ Raise Invoice'}</button>
            </div>
          </div>
        </div>
      )}

      {/* SETTLE MODAL */}
      {isAdjustModalOpen && selectedBill && (
        <div style={overlay}>
          <div style={{ width: '100%', maxWidth: 1000, background: '#0f172a', borderRadius: 18, border: '1px solid #10b981', padding: 26, maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div>
                <h3 style={{ color: '#10b981', margin: 0 }}>💰 Receive payment — {selectedBill.bill_no}</h3>
                <p style={{ color: '#64748b', fontSize: 12, margin: '4px 0 0' }}>
                  Posts a RECEIPT through TARA: Dr bank + Dr TDS receivable / Cr {selectedBill.customer_name}
                </p>
              </div>
              <button onClick={() => setIsAdjustModalOpen(false)} style={{ background: 'transparent', color: '#94a3b8', border: 'none', fontSize: 22, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '14px 0', fontSize: 13 }}>
              <span style={{ color: '#94a3b8' }}>Net expected <b style={{ color: '#fff' }}>₹{inr(selectedBill.total_net)}</b></span>
              <span style={{ color: '#94a3b8' }}>Already received <b style={{ color: '#10b981' }}>₹{inr(selectedBill.received_amount)}</b></span>
              <span style={{ color: '#94a3b8' }}>Outstanding <b style={{ color: '#ef4444' }}>₹{inr(selectedBill.outstanding)}</b></span>
            </div>

            <input className="modern-input" placeholder="🔍 Filter by vehicle / trip / LR" value={tripSearchTerm} onChange={(e) => setTripSearchTerm(e.target.value)} style={{ marginBottom: 12 }} />

            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #334155', borderRadius: 10 }}>
              <table>
                <thead><tr>
                  <th style={{ width: 36 }} />
                  <th>Trip / Vehicle</th>
                  <th style={{ textAlign: 'right' }}>Net billed</th>
                  <th style={{ textAlign: 'right' }}>Party deducted extra</th>
                  <th>Recover from driver</th>
                  <th style={{ textAlign: 'right' }}>Passed amount</th>
                  <th>Status</th>
                </tr></thead>
                <tbody>
                  {filteredTripAdjustments.map((t) => {
                    const idx = tripAdjustments.findIndex((x) => x.id === t.id);
                    const done = t.payment_status === 'SETTLED';
                    return (
                      <tr key={t.id} style={{ opacity: done ? 0.55 : 1 }}>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" disabled={done} checked={!!t.selected_for_payment}
                            onChange={(e) => handleTripSelection(idx, e.target.checked)}
                            style={{ transform: 'scale(1.4)', cursor: done ? 'not-allowed' : 'pointer', accentColor: '#10b981' }} />
                        </td>
                        <td>
                          <b style={{ color: '#fff' }}>{t.vehicle_no}</b>
                          <div style={{ color: '#64748b', fontSize: 11 }}>{t.trip_code} · {t.driver_name || 'no driver'}</div>
                        </td>
                        <td style={{ textAlign: 'right', color: '#38bdf8' }}>{inr(t.net_payable)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" disabled={done} value={t.extra_shortage_amt ?? 0}
                            onChange={(e) => handleTripShortageChange(idx, 'extra_shortage_amt', e.target.value)}
                            style={{ width: 96, background: 'rgba(15,23,42,0.7)', border: '1px solid #ef4444', borderRadius: 6, color: '#fff', padding: 6, textAlign: 'right' }} />
                        </td>
                        <td>
                          <input type="checkbox" disabled={done || !(Number(t.extra_shortage_amt) > 0)} checked={t.recover_from_driver !== false}
                            onChange={(e) => handleTripShortageChange(idx, 'recover_from_driver', e.target.checked)}
                            style={{ transform: 'scale(1.25)', accentColor: '#f59e0b' }} />
                          {Number(t.extra_shortage_amt) > 0 && t.recover_from_driver !== false && (
                            <div style={{ color: '#fbbf24', fontSize: 10 }}>Dr {t.driver_name || 'driver'} / Cr shortage</div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', color: '#10b981', fontWeight: 'bold' }}>{inr(t.final_passed_amt)}</td>
                        <td>
                          <span className="badge" style={{ background: done ? '#10b98122' : '#38bdf822', color: done ? '#10b981' : '#38bdf8', border: `1px solid ${done ? '#10b981' : '#38bdf8'}` }}>
                            {done ? 'SETTLED' : 'PENDING'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14, marginTop: 16 }}>
              <div>
                <label style={{ color: '#10b981', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Received (₹)</label>
                <input type="number" className="modern-input" value={adjustmentData.received_amount} onChange={(e) => setAdjustmentData({ ...adjustmentData, received_amount: e.target.value })} style={{ marginTop: 5 }} />
              </div>
              <div>
                <label style={{ color: '#f59e0b', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>TDS deducted (₹)</label>
                <input type="number" className="modern-input" value={adjustmentData.tds_deducted} onChange={(e) => setAdjustmentData({ ...adjustmentData, tds_deducted: e.target.value })} style={{ marginTop: 5 }} />
              </div>
              <div>
                <label style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Deposited into *</label>
                <select className="modern-input" value={adjustmentData.deposit_bank} onChange={(e) => setAdjustmentData({ ...adjustmentData, deposit_bank: e.target.value })} style={{ marginTop: 5 }}>
                  <option value="">-- Select --</option>
                  {accounts.map((a) => <option key={a.ledger_name} value={a.ledger_name}>{a.ledger_name} — ₹{inr(a.balance)}</option>)}
                </select>
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Remarks / UTR</label>
                <input className="modern-input" value={adjustmentData.remarks} onChange={(e) => setAdjustmentData({ ...adjustmentData, remarks: e.target.value })} style={{ marginTop: 5 }} />
              </div>
            </div>

            <div style={{ color: '#64748b', fontSize: 12, marginTop: 12 }}>
              Gross credited to the debtor = received + TDS = <b style={{ color: '#cbd5e1' }}>₹{inr((parseFloat(adjustmentData.received_amount) || 0) + (parseFloat(adjustmentData.tds_deducted) || 0))}</b>.
              The debtor is cleared for the full gross, because the TDS was paid on our behalf.
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
              <button onClick={() => setIsAdjustModalOpen(false)} className="glow-btn" style={{ background: '#334155', boxShadow: 'none', flex: 1 }}>Cancel</button>
              <button onClick={() => submitSettlement(true)} disabled={busy} className="glow-btn" style={{ background: '#1e293b', color: '#c084fc', border: '1px solid #c084fc', boxShadow: 'none', flex: 1 }}>🧪 Dry run</button>
              <button onClick={() => submitSettlement(false)} disabled={busy} className="glow-btn" style={{ flex: 2 }}>{busy ? 'Posting…' : '✅ Post Receipt'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2,6,23,0.93)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' };
const warn: React.CSSProperties = { background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', color: '#fcd34d', padding: '12px 16px', borderRadius: 8, marginBottom: 12, fontSize: 13 };
