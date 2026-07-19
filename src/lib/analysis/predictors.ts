// 🔮 Predictive signals — computed in PLAIN JS from data the ERP already has,
// with Gemma only narrating the results (never doing the math). Three
// predictors, all robust-statistics based (median + MAD, not mean — outliers
// in messy transport data would poison averages):
//   1. ETA/delay flags  — in-transit trips running beyond their route's norm
//   2. Fuel anomalies   — fills far above the vehicle's own usual fill size
//   3. Payment risk     — customers ranked by outstanding × ageing
import { toISODate, getTripFreight, round2 } from '../accounting/tripMath';

const g = (o: any, keys: string[]): string => {
  for (const k of keys) { const h = Object.keys(o || {}).find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, '')); if (h && o[h] != null && String(o[h]).trim() !== '') return String(o[h]); }
  return '';
};
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = (a: number[], med: number) => median(a.map(x => Math.abs(x - med)));
const daysBetween = (a: string, b: string) => {
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  return isNaN(ta) || isNaN(tb) ? null : Math.round((tb - ta) / 86400000);
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const routeKey = (t: any) => `${g(t, ['loading_point', 'Loading_Point'])}→${g(t, ['consignee_name', 'Consignee_Name'])}`.toLowerCase().replace(/[^a-z0-9→]/g, '');

export interface EtaFlag { trip_id: string; vehicle: string; route: string; daysOut: number; expectedDays: number; }
export interface FuelAlert { vehicle: string; date: string; liters: number; usualLiters: number; pump: string; }
export interface PaymentRisk { customer: string; outstanding: number; oldestDays: number; trips: number; }

/** In-transit trips running LONGER than their route's historical norm. */
export function etaFlags(trips: any[]): EtaFlag[] {
  // Learn per-route transit-day norms from completed trips
  const routeDays = new Map<string, number[]>();
  trips.forEach(t => {
    if (String(g(t, ['trip_status'])).toUpperCase() !== 'COMPLETED') return;
    const start = toISODate(g(t, ['sort_date', 'start_date', 'Loading_Date']));
    const end = toISODate(g(t, ['unloading_date', 'completed_at']));
    if (!start || !end) return;
    const d = daysBetween(start, end);
    if (d === null || d < 0 || d > 60) return;
    const k = routeKey(t);
    (routeDays.get(k) || routeDays.set(k, []).get(k)!).push(d);
  });

  const flags: EtaFlag[] = [];
  trips.forEach(t => {
    const st = String(g(t, ['trip_status'])).toUpperCase();
    if (st === 'COMPLETED') return;
    const start = toISODate(g(t, ['sort_date', 'start_date', 'Loading_Date']));
    if (!start) return;
    const out = daysBetween(start, todayISO());
    if (out === null || out <= 1) return;
    const hist = routeDays.get(routeKey(t)) || [];
    const med = hist.length >= 3 ? median(hist) : 3;                 // 3-day default norm
    const spread = hist.length >= 3 ? Math.max(1, mad(hist, med)) : 2;
    if (out > med + 2 * spread) {
      flags.push({
        trip_id: g(t, ['trip_id', 'Trip_ID']) || t.id,
        vehicle: g(t, ['vehicle_no', 'Vehical_No']),
        route: `${g(t, ['loading_point', 'Loading_Point'])} → ${g(t, ['consignee_name', 'Consignee_Name'])}`,
        daysOut: out,
        expectedDays: round2(med),
      });
    }
  });
  return flags.sort((a, b) => b.daysOut - a.daysOut).slice(0, 8);
}

/** Fills far above the vehicle's OWN usual fill size (possible pilferage/leak/typo). */
export function fuelAnomalies(fuelEntries: any[]): FuelAlert[] {
  const byVeh = new Map<string, any[]>();
  fuelEntries.forEach(f => {
    const v = String(g(f, ['vehicle_no'])).replace(/\s+/g, '').toUpperCase();
    const l = parseFloat(g(f, ['liters'])) || 0;
    if (!v || l <= 0) return;
    (byVeh.get(v) || byVeh.set(v, []).get(v)!).push({ ...f, _v: v, _l: l });
  });

  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const alerts: FuelAlert[] = [];
  byVeh.forEach((list, veh) => {
    if (list.length < 4) return; // need history to define "usual"
    const liters = list.map(x => x._l);
    const med = median(liters);
    const spread = Math.max(15, 2.5 * mad(liters, med)); // ≥15L slack — pumps round
    list.forEach(f => {
      const d = toISODate(g(f, ['date']));
      if (!d || d < cutoff) return; // only recent fills alert
      if (f._l > med + spread) {
        alerts.push({ vehicle: veh, date: d, liters: f._l, usualLiters: round2(med), pump: g(f, ['vendor_name']) });
      }
    });
  });
  return alerts.sort((a, b) => (b.liters - b.usualLiters) - (a.liters - a.usualLiters)).slice(0, 6);
}

/** Customers ranked by outstanding × ageing (who to chase first). */
export function paymentRisks(trips: any[]): PaymentRisk[] {
  const byCust = new Map<string, { outstanding: number; oldest: string; trips: number }>();
  trips.forEach(t => {
    if (String(g(t, ['trip_status'])).toUpperCase() !== 'COMPLETED') return;
    if (String(g(t, ['billing_status'])).toUpperCase() === 'PAID') return;
    const freight = getTripFreight(t);
    if (freight <= 0) return;
    const cust = g(t, ['customer_name', 'Customer', 'Registered_Assessee']) || 'Unknown';
    const d = toISODate(g(t, ['unloading_date', 'sort_date', 'start_date'])) || todayISO();
    const cur = byCust.get(cust) || { outstanding: 0, oldest: d, trips: 0 };
    cur.outstanding = round2(cur.outstanding + freight);
    if (d < cur.oldest) cur.oldest = d;
    cur.trips++;
    byCust.set(cust, cur);
  });
  return [...byCust.entries()]
    .map(([customer, v]) => ({ customer, outstanding: v.outstanding, oldestDays: daysBetween(v.oldest, todayISO()) || 0, trips: v.trips }))
    .sort((a, b) => (b.outstanding * Math.max(1, b.oldestDays)) - (a.outstanding * Math.max(1, a.oldestDays)))
    .slice(0, 5);
}
