// 📋 Phase 14.2 — Mamta AI daily self-analysis. 100% local, READ-ONLY: gathers
// the day's operational + financial signals, then Gemma 4 writes a concise
// report (summary + anomalies + suggestions). Never changes operational data.

import { API_BASE } from '../apiBase';
const API = API_BASE;

// A failed source degrades the summary rather than throwing it away — the
// briefing is advisory, and half a briefing beats an error screen.
const get = async (url: string, key: string): Promise<any[]> => {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json())[key] ?? [];
  } catch { return []; }
};
import { llmComplete } from '../llm';
import { reconcile } from '../accounting/journal';
import { scopeCurrent } from '../rbac';
import { etaFlags, fuelAnomalies, paymentRisks, type EtaFlag, type FuelAlert, type PaymentRisk } from './predictors';

const g = (o: any, keys: string[]): string => {
  for (const k of keys) { const h = Object.keys(o || {}).find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, '')); if (h && o[h] != null && String(o[h]).trim() !== '') return String(o[h]); }
  return '';
};
const daysTo = (s: string): number | null => {
  if (!s) return null; const t = String(s).trim(); let d: Date | null = null;
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
  else { m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); if (m) d = new Date(+m[3], +m[2] - 1, +m[1]); }
  if (!d || isNaN(d.getTime())) { const p = new Date(t); if (!isNaN(p.getTime())) d = p; }
  if (!d || isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
};

export interface DailySignals {
  trips: { total: number; inTransit: number; pendingLoad: number; pendingUnload: number; completed: number };
  dlExpiring: { name: string; days: number }[];
  docExpiring: { vehicle: string; doc: string; days: number }[];
  journal: { count: number; balanced: boolean; flagged: number };
  // 🔮 Predictive (computed in JS; Gemma only narrates)
  lateTrips: EtaFlag[];
  fuelAlerts: FuelAlert[];
  paymentRisks: PaymentRisk[];
}

/** Read-only gather of today's signals (RBAC-scoped to the current user). */
export async function buildDailySummary(): Promise<DailySignals> {
  const [tRows, dRows, vRows, fRows, rec] = await Promise.all([
    get(`${API}/api/v1/ops/trips?limit=1000`, 'trips'),
    get(`${API}/api/v1/masters/drivers`, 'drivers'),
    get(`${API}/api/v1/masters/vehicles`, 'vehicles'),
    get(`${API}/api/v1/queues/fuel-entries?limit=1000`, 'entries'),
    reconcile().catch(() => ({ count: 0, balanced: true, findings: [] })),
  ]);
  const trips = scopeCurrent(tRows);
  const drivers = dRows;
  const vehicles = scopeCurrent(vRows);

  const st = (t: any) => String(g(t, ['trip_status', 'Trip_Status'])).toUpperCase();
  const trCounts = {
    total: trips.length,
    inTransit: trips.filter(t => ['IN_TRANSIT', 'DISPATCHED'].includes(st(t))).length,
    pendingLoad: trips.filter(t => ['PENDING', 'LOADED'].includes(st(t))).length,
    pendingUnload: trips.filter(t => ['UNLOADED', 'ARRIVED_DESTINATION'].includes(st(t))).length,
    completed: trips.filter(t => st(t) === 'COMPLETED').length,
  };

  const dlExpiring = drivers.map(d => ({ name: g(d, ['name', 'driver_name']), days: daysTo(g(d, ['license_expiry', 'dl_expiry_date', 'dl_validity'])) }))
    .filter(x => x.days !== null && x.days <= 15).sort((a, b) => (a.days! - b.days!)).slice(0, 10) as any;

  const docFields = [['insurance_validity', 'Insurance'], ['national_permit_validity', 'Permit'], ['pollution_validity', 'PUC'], ['tax_validity', 'Tax'], ['fitness_validity', 'Fitness']];
  const docExpiring: any[] = [];
  vehicles.forEach(v => { docFields.forEach(([f, label]) => { const days = daysTo(g(v, [f])); if (days !== null && days <= 30) docExpiring.push({ vehicle: g(v, ['Vehicle_No', 'vehicle_no']), doc: label, days }); }); });
  docExpiring.sort((a, b) => a.days - b.days);

  const fuelEntries = fRows;
  return {
    trips: trCounts, dlExpiring, docExpiring: docExpiring.slice(0, 12),
    journal: { count: rec.count, balanced: rec.balanced, flagged: rec.findings?.length || 0 },
    lateTrips: etaFlags(trips),
    fuelAlerts: fuelAnomalies(fuelEntries),
    paymentRisks: paymentRisks(trips),
  };
}

/** Gemma 4 writes the daily report from the gathered signals (read-only). */
export async function generateDailyReport(onToken?: (t: string) => void): Promise<{ report: string; signals: DailySignals }> {
  const s = await buildDailySummary();
  const facts = [
    `Trips — total ${s.trips.total}: in-transit ${s.trips.inTransit}, pending-load ${s.trips.pendingLoad}, pending-unload ${s.trips.pendingUnload}, completed ${s.trips.completed}.`,
    s.lateTrips.length
      ? `⏰ LATE TRIPS (route norm se zyada din bahar): ${s.lateTrips.map(f => `${f.vehicle} (${f.trip_id}) ${f.route} — ${f.daysOut}d out vs usual ${f.expectedDays}d`).join('; ')}.`
      : 'Koi trip route-norm se late nahi.',
    s.fuelAlerts.length
      ? `⛽ FUEL ANOMALIES (vehicle ke usual fill se bahut zyada): ${s.fuelAlerts.map(a => `${a.vehicle} ${a.date} — ${a.liters}L vs usual ~${a.usualLiters}L (${a.pump})`).join('; ')}.`
      : 'Koi unusual diesel fill nahi.',
    s.paymentRisks.length
      ? `💰 PAYMENT CHASE LIST (outstanding × ageing): ${s.paymentRisks.map(p => `${p.customer} ₹${p.outstanding.toLocaleString('en-IN')} (${p.trips} trips, oldest ${p.oldestDays}d)`).join('; ')}.`
      : 'Koi bada outstanding nahi.',
    s.dlExpiring.length ? `Driver licences expiring (≤15d): ${s.dlExpiring.map((d: any) => `${d.name} in ${d.days}d`).join(', ')}.` : 'No driver licences expiring soon.',
    s.docExpiring.length ? `Vehicle docs expiring (≤30d): ${s.docExpiring.map((d: any) => `${d.vehicle} ${d.doc} in ${d.days}d`).join(', ')}.` : 'No vehicle docs expiring soon.',
    `Accounts journal: ${s.journal.count} entries, ${s.journal.balanced ? 'balanced' : `${s.journal.flagged} flagged`}.`,
  ].join('\n');

  const report = await llmComplete([
    { role: 'system', content: 'You are MAMTA AI, the assistant for PRASAD Transport ERP. Write a SHORT daily review in simple Hinglish for the boss: (1) one-line summary, (2) anomalies/risks (bullets — LATE TRIPS, FUEL ANOMALIES and PAYMENT CHASE LIST are pre-computed facts, highlight them first), (3) 3-5 concrete action suggestions (bullets). Be specific to the data. Do not invent anything, do not recalculate numbers.' },
    { role: 'user', content: `Aaj ke ERP signals:\n${facts}\n\nDaily report likho.` },
  ], { temperature: 0.4, think: false, numCtx: 8192 } as any, onToken);

  return { report, signals: s };
}
