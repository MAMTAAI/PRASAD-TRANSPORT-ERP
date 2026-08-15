// src/lib/masters/rateApi.ts
// ─────────────────────────────────────────────────────────────────────────────
// The rate and lane masters, read from PostgreSQL and shaped for the freight
// engine.
//
// WHY THIS MODULE EXISTS. Three screens use this data and each needs it in the
// same shape: RateMaster.tsx and LocationRtkmMaster.tsx edit it, and
// MonthlyBilling.tsx prices every trip off it through
// `resolveTripBilling()`. That function is written against the Firestore-era
// PascalCase field names (`Customer`, `Source`, `Effective_From`, …) which the
// PostgreSQL columns do not use. Three private copies of that mapping is three
// chances for the billing engine to disagree with the screen that wrote the
// rule — so there is exactly one copy, here.
//
// The mapping is deliberate debt, not an accident: the alternative is renaming
// ~40 identifiers through freightEngine.ts and every screen that reads a
// FreightMeta. Delete this file when that rename happens.
// ─────────────────────────────────────────────────────────────────────────────
import { API_BASE } from '../apiBase';
const API = API_BASE;
const MASTERS = `${API}/api/v1/masters`;

const fetchJson = async (url: string) => {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

/** A `rate_master` row in the shape `findRateMasterEntry()` matches on. */
export const rateFromApi = (r: any) => ({
  id: r.id,
  Customer: r.customer_name ?? '',
  Source: r.source ?? '',
  // The 134 derived IOCL rows name a ship-to in `route` and have no separate
  // destination column filled; falling back keeps them matchable.
  Destination: r.destination ?? r.route ?? '',
  Calc_Type: r.calc_type ?? 'PER_UNIT',
  Rate_Value: Number(r.rate ?? 0),
  RTKM_Distance: Number(r.rtkm_distance ?? 0),
  Effective_From: r.valid_from ?? '',
  // The engine treats '' as open-ended; the column is NULL for that.
  Effective_To: r.valid_to ?? '',
  Status: r.status === 'INACTIVE' ? 'Inactive' : 'Active',
  rate_type: r.rate_type ?? null,
  unit: r.unit ?? null,
});

/** An `rtkm_master` row in the shape `findRouteForTrip()` / `resolveRate()` want. */
export const laneFromApi = (r: any) => ({
  ...r,
  Customer: r.customer_name ?? '',
  Depot_Link: r.depot_link ?? '',
  Consignee_Name: r.consignee_name ?? '',
  Item_Type: r.item_type ?? '',
  Vehicle_Capacity: r.vehicle_capacity ?? '',
  RTKM_Distance: r.rtkm_distance ?? '',
  Fixed_HSD: r.fixed_hsd_qty ?? '',
  Fixed_Cash: r.fixed_cash_amt ?? '',
  Billing_Type: r.billing_type ?? 'PER_KL',
  rate_history: Array.isArray(r.rate_history) ? r.rate_history : [],
  Status: r.status === 'INACTIVE' ? 'Inactive' : 'Active',
});

/** Rules typed by Accounts, plus the evidence-backed card derived from bills. */
export async function fetchRates(): Promise<{ rates: any[]; derived: any[] }> {
  const j = await fetchJson(`${MASTERS}/rates`);
  return { rates: (j.rates ?? []).map(rateFromApi), derived: j.derived_rate_card ?? [] };
}

/** Lanes, already joined to `v_iocl_lane_rate` (current_rate / rtd_variance). */
export async function fetchLanes(): Promise<any[]> {
  const j = await fetchJson(`${MASTERS}/lanes`);
  return (j.lanes ?? []).map(laneFromApi);
}
