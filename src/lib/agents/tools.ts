// 🛠️ Agent tools. Phase 8 starts READ-ONLY (no Firestore writes).
// Each tool declares its JSON-schema definition + an executor + owning agent.

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
import { retrieve } from '../rag';
import { scopeFilter, type AppUser } from '../rbac';
import { logAudit } from '../audit';
import type { ToolDefinition } from '../llm/types';

export interface ToolCtx { user?: AppUser; }

export interface AgentTool {
  agent: string;
  write: boolean;               // true => requires user confirmation (Phase 8 later)
  definition: ToolDefinition;
  run: (args: any, ctx?: ToolCtx) => Promise<string>;
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
  const { trips } = await fetchJson(`${API}/api/v1/ops/trips?limit=1000`);
  return trips ?? [];
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
    run: async ({ query }, ctx) => {
      let hits = await retrieve(String(query || ''), 8);
      // 🔐 RBAC: scoped roles only see chunks mentioning their own scope value.
      const u: any = ctx?.user; const r = String(u?.role || '').toLowerCase();
      if (['vendor', 'customer', 'driver'].includes(r)) {
        const val = String(u.vendor_name || u.customer_name || u.driver_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (val) hits = hits.filter(h => h.text.toLowerCase().replace(/[^a-z0-9]/g, '').includes(val));
        else hits = [];
      }
      return hits.length ? hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n') : 'No matching ERP records (within your access).';
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
    run: async (_args, ctx) => {
      const trips = scopeFilter(ctx?.user as any, await fetchTrips());
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
    run: async ({ period_days }, ctx) => {
      const trips = scopeFilter(ctx?.user as any, await fetchTrips());
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

// ── Write tools (gated: orchestrator never auto-runs these; they require
//    explicit user confirmation, then commitWrite() performs the insert).
//    ADD-ONLY: these create new records — never update or delete (Section 0),
//    and never post to the ledger (see the note where add_ledger_entry was).
export const WRITE_TOOLS: AgentTool[] = [
  {
    agent: 'Operations',
    write: true,
    definition: {
      type: 'function',
      function: {
        name: 'create_trip',
        description: 'Create a NEW trip record. Requires user confirmation before saving. Provide as many fields as known.',
        parameters: {
          type: 'object',
          properties: {
            vehicle_no: { type: 'string' },
            driver_name: { type: 'string' },
            loading_point: { type: 'string' },
            consignee_name: { type: 'string' },
            customer_name: { type: 'string' },
            product_type: { type: 'string' },
            loaded_qty: { type: 'string' },
            rtkm: { type: 'string' },
          },
          required: ['vehicle_no', 'consignee_name'],
        },
      },
    },
    run: async (args) => {
      // The trip code is minted server-side inside the insert transaction
      // (LOCK TABLE trips), so the agent no longer invents a random TRP-#####
      // that could collide with a real one.
      const { trip } = await fetchJson(`${API}/api/v1/ops/trips`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicle_no: args.vehicle_no || '', driver_name: args.driver_name || '',
          loading_point: args.loading_point || '', consignee_name: args.consignee_name || '',
          customer_name: args.customer_name || '', product_type: args.product_type || '',
          loaded_qty: args.loaded_qty || '', rtkm: args.rtkm || '',
          status: 'PENDING', created_by: 'MAMTA AI Agent',
        }),
      });
      return `Trip created with id ${trip?.trip_code ?? trip?.id}`;
    },
  },
  // ⛔ `add_ledger_entry` WAS HERE, AND IS NOT COMING BACK.
  //
  // It let the assistant append a one-sided row to LEDGER_ENTRIES —
  // {party_name, amount, DEBIT|CREDIT} with no counter-account. Firestore
  // accepted that; PostgreSQL cannot. `ledger_entries` is TARA's, append-only
  // by trigger, and a deferred constraint checks ΣDr = ΣCr per voucher at
  // COMMIT, so a single-legged entry is rejected by the database itself.
  //
  // The deeper reason is not the schema. A ledger posting needs BOTH accounts,
  // and nothing in that tool told the model which the other one was — so the
  // only way to make it work would be to let an LLM choose where the
  // contra-entry lands. On a live double-entry book that is not a feature.
  //
  // Money is posted by the screens that know the counter-account (cash book,
  // bill settlement, expense approval), each going through TARA's postVoucher.
  // If the assistant should be able to start one of those, give it a tool that
  // files a PROPOSAL for a human to approve — not one that writes the book.
];

/** Tools currently enabled (modular — extend per agent rollout). */
export function enabledTools(): AgentTool[] {
  return [...TOOLS, ...WRITE_TOOLS];
}

/** Execute a write tool AFTER user confirmation. */
export async function commitWrite(name: string, args: any): Promise<string> {
  const tool = WRITE_TOOLS.find(t => t.definition.function.name === name);
  if (!tool) throw new Error(`Unknown write tool: ${name}`);
  const result = await tool.run(args);
  logAudit({ action: `AI_${name.toUpperCase()}`, details: `${result} | args: ${JSON.stringify(args).slice(0, 200)}` });
  return result;
}
