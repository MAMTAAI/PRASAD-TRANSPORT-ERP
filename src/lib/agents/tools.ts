// 🛠️ Agent tools. Phase 8 starts READ-ONLY (no Firestore writes).
// Each tool declares its JSON-schema definition + an executor + owning agent.
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { retrieve } from '../rag';
import type { ToolDefinition } from '../llm/types';

export interface AgentTool {
  agent: string;
  write: boolean;               // true => requires user confirmation (Phase 8 later)
  definition: ToolDefinition;
  run: (args: any) => Promise<string>;
}

const g = (o: any, keys: string[]): string => {
  for (const k of keys) {
    const hit = Object.keys(o || {}).find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit && o[hit] != null && String(o[hit]).trim() !== '') return String(o[hit]);
  }
  return '';
};

const LIFECYCLE: Record<string, string> = {
  PENDING: 'Pending Load', LOADED: 'Pending Load',
  IN_TRANSIT: 'In Transit', DISPATCHED: 'In Transit',
  UNLOADED: 'Pending Unload', ARRIVED_DESTINATION: 'Pending Unload',
  COMPLETED: 'Completed',
};

async function fetchTrips(): Promise<any[]> {
  const snap = await getDocs(collection(db, 'TRIPS'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export const TOOLS: AgentTool[] = [
  // ── Operations ──────────────────────────────────────────────
  {
    agent: 'Operations',
    write: false,
    definition: {
      type: 'function',
      function: {
        name: 'search_erp',
        description: 'Semantic search over ERP records (trips, vehicles, drivers, ledgers). Use for lookups like "vehicle AS01 owner", "Agartala trips", "driver X mobile".',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'natural language search' } }, required: ['query'] },
      },
    },
    run: async ({ query }) => {
      const hits = await retrieve(String(query || ''), 8);
      return hits.length ? hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n') : 'No matching ERP records.';
    },
  },
  {
    agent: 'Operations',
    write: false,
    definition: {
      type: 'function',
      function: {
        name: 'trip_status_counts',
        description: 'Counts of trips grouped by lifecycle status (Pending Load / In Transit / Pending Unload / Completed).',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    run: async () => {
      const trips = await fetchTrips();
      const counts: Record<string, number> = {};
      trips.forEach(t => {
        const label = LIFECYCLE[String(g(t, ['trip_status', 'Trip_Status'])).toUpperCase()] || 'Unknown';
        counts[label] = (counts[label] || 0) + 1;
      });
      return JSON.stringify({ total: trips.length, byStatus: counts });
    },
  },
  // ── Analytics ───────────────────────────────────────────────
  {
    agent: 'Analytics',
    write: false,
    definition: {
      type: 'function',
      function: {
        name: 'fleet_analytics',
        description: 'Fleet performance over a period: number of loadings, total RTKM run, and the top vehicles by trip count.',
        parameters: { type: 'object', properties: { period_days: { type: 'number', description: 'lookback window in days; 0 or omitted = all time' } }, required: [] },
      },
    },
    run: async ({ period_days }) => {
      const trips = await fetchTrips();
      const days = Number(period_days || 0);
      const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
      const inPeriod = trips.filter(t => {
        if (!cutoff) return true;
        const ds = g(t, ['start_date', 'Loading_Date', 'loading_date']);
        const ms = ds ? new Date(ds).getTime() : 0;
        return ms >= cutoff;
      });
      let rtkm = 0;
      const byVeh: Record<string, number> = {};
      inPeriod.forEach(t => {
        rtkm += parseFloat(g(t, ['rtkm', 'RTKM']) || '0') || 0;
        const v = g(t, ['vehicle_no', 'Vehical_No']);
        if (v) byVeh[v] = (byVeh[v] || 0) + 1;
      });
      const topVehicles = Object.entries(byVeh).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v}: ${n} trips`);
      return JSON.stringify({ period: days ? `${days} days` : 'all time', loadings: inPeriod.length, totalRTKM: Math.round(rtkm), topVehicles });
    },
  },
];

/** Tools currently enabled (modular — extend per agent rollout). */
export function enabledTools(): AgentTool[] {
  return TOOLS;
}
