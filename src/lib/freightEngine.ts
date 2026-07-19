// 💰 DYNAMIC SMART FREIGHT ENGINE — date-effective quarterly rates + oil-company
// formulas. Pure module (no firebase imports) => Node me unit-testable
// (scripts/freight-engine-test.cjs). Real IOCL Transportation Bill se verify:
//   17.510 TO × RTD 1,660 km × ₹3.432495/tonne-km = ₹99,770.96 ✓ (bill 7B03, June 2026)
// Oil companies har quarter rate revise karti hain — isliye route par ek fixed
// rate nahi, `rate_history` array hota hai jisme se trip ki LOADING DATE ke
// hisaab se sahi rate uthta hai.

export type BillingType = 'PER_KL' | 'PER_TON' | 'RTKM_QTY' | 'RTKM_CAPACITY' | 'FIXED';

export interface RateEntry {
  valid_from: string;   // YYYY-MM-DD (inclusive)
  valid_to: string;     // YYYY-MM-DD (inclusive) — '' = open-ended (current)
  rate_value: number;
}

export const BILLING_TYPES: { key: BillingType; label: string; formula: string }[] = [
  { key: 'PER_KL',        label: 'Per KL',        formula: 'Qty (KL) × Rate' },
  { key: 'PER_TON',       label: 'Per Ton',       formula: 'Weight (TO) × Rate' },
  { key: 'RTKM_QTY',      label: 'RTKM × Qty (IOCL bill format)', formula: 'Qty × RTKM × Rate/t-km' },
  { key: 'RTKM_CAPACITY', label: 'RTKM × Capacity', formula: 'RTKM × Capacity (KL) × Rate' },
  { key: 'FIXED',         label: 'Fixed Rate',    formula: 'Flat ₹ per trip' },
];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** '40 KL (18 Wheeler)' → 40 ; '18 MT (LPG Bulk)' → 18 ; junk → 0 */
export const parseCapacity = (cap: any): number => {
  const m = String(cap || '').match(/(\d+(?:\.\d+)?)\s*(KL|MT|TO|TON)/i);
  return m ? parseFloat(m[1]) : 0;
};

/** Trip ki loading date ke liye applicable quarterly rate resolve karo.
 *  Overlap ho to LATEST valid_from jeet-ta hai; kuch na mile to legacy
 *  Rate_Per_Unit field; warna 0 (caller apna default use kare). */
export function resolveRate(route: any, dateISO: string): { rate: number; source: 'history' | 'legacy' | 'none'; entry?: RateEntry } {
  const d = String(dateISO || '').slice(0, 10);
  const hist: RateEntry[] = Array.isArray(route?.rate_history) ? route.rate_history : [];
  const applicable = hist
    .filter(e => e && Number(e.rate_value) > 0 && e.valid_from && String(e.valid_from) <= d && (!e.valid_to || d <= String(e.valid_to)))
    .sort((a, b) => String(b.valid_from).localeCompare(String(a.valid_from)));
  if (applicable.length) return { rate: Number(applicable[0].rate_value), source: 'history', entry: applicable[0] };
  const legacy = parseFloat(route?.Rate_Per_Unit || route?.rate_per_unit || 0) || 0;
  if (legacy > 0) return { rate: legacy, source: 'legacy' };
  return { rate: 0, source: 'none' };
}

/** Formula engine — arithmetic hamesha code me, kabhi AI/user assumptions me nahi. */
export function computeFreight(bt: BillingType | string, p: { qty?: number; rate?: number; rtkm?: number; capacityKl?: number }): number {
  const qty = Number(p.qty) || 0, rate = Number(p.rate) || 0, rtkm = Number(p.rtkm) || 0, cap = Number(p.capacityKl) || 0;
  switch (bt) {
    case 'PER_TON':       return r2(qty * rate);
    case 'RTKM_QTY':      return r2(qty * rtkm * rate);        // IOCL: Qty(TO) × RTD × Rate/t-km
    case 'RTKM_CAPACITY': return r2(rtkm * cap * rate);        // RTKM × Capacity(KL) × Rate
    case 'FIXED':         return r2(rate);                     // flat per trip
    case 'PER_KL':
    default:              return r2(qty * rate);
  }
}

/** Trip ↔ Route master matching (normalized): customer + consignee, depot
 *  bonus. Best-scoring single route milta hai; kuch na mile to null. */
export function findRouteForTrip(routes: any[], trip: any): any | null {
  const tCust = norm(trip?.customer_name || trip?.Customer || trip?.Registered_Assessee);
  const tCons = norm(trip?.consignee_name || trip?.Consignee_Name || trip?.unloading_point);
  const tDepot = norm(trip?.loading_point || trip?.Loading_Point || trip?.depot);
  if (!tCons) return null;
  let best: any = null, bestScore = 0;
  for (const r of routes) {
    if (String(r?.Status || 'Active') === 'Inactive') continue;
    const rCons = norm(r?.Consignee_Name || r?.consignee_name);
    if (!rCons) continue;
    // consignee: exact ya contains (IOCL names me codes/prefixes aage-piche hote hain)
    let score = rCons === tCons ? 60 : (rCons.includes(tCons) || tCons.includes(rCons)) ? 40 : 0;
    if (!score) continue;
    const rCust = norm(r?.Customer || r?.customer_name);
    if (tCust && rCust && (rCust === tCust || rCust.includes(tCust) || tCust.includes(rCust))) score += 25;
    const rDepot = norm(r?.Depot_Link || r?.depot_link);
    if (tDepot && rDepot && (rDepot === tDepot || rDepot.includes(tDepot) || tDepot.includes(rDepot))) score += 15;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 60 ? best : null; // consignee-match ke bina kabhi nahi
}

export interface FreightMeta {
  billing_type: BillingType;
  rate: number;
  rate_source: 'history' | 'legacy' | 'none';
  rtkm: number;
  capacityKl: number;
  route_id: string;
}

/** Ek trip ke liye poora freight-context: route match + date-effective rate. */
export function tripFreightMeta(routes: any[], trip: any, loadingDateISO: string): FreightMeta | null {
  const route = findRouteForTrip(routes, trip);
  if (!route) return null;
  const { rate, source } = resolveRate(route, loadingDateISO);
  return {
    billing_type: (route.Billing_Type || 'PER_KL') as BillingType,
    rate, rate_source: source,
    rtkm: parseFloat(route.RTKM_Distance || route.rtkm_distance || 0) || 0,
    capacityKl: parseCapacity(route.Vehicle_Capacity),
    route_id: route.id || '',
  };
}
