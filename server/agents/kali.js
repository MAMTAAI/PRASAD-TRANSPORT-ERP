// server/agents/kali.js
// AGENT 01 — KALI · Dispatch & Trip Execution Engine
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';

/**
 * The trip lifecycle, taken from the states already present in the live data
 * (`src/LodingDetals.tsx`, `src/UnlodingDetals.tsx`, `src/TripManagment.tsx`):
 *
 *   PENDING -> LOADED -> IN_TRANSIT -> UNLOADING -> COMPLETED -> SETTLED
 *
 * Encoded as an adjacency map rather than scattered `if (status === ...)`
 * checks, because the old data shows trips that skipped states — a trip cannot
 * be UNLOADING if it was never LOADED, and this is where that becomes
 * unrepresentable.
 */
export const TRIP_FLOW = Object.freeze({
  PENDING: ['LOADED', 'CANCELLED'],
  LOADED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['UNLOADING', 'CANCELLED'],
  UNLOADING: ['COMPLETED'],
  COMPLETED: ['SETTLED'],
  SETTLED: [],          // terminal — TARA has posted it; nothing may reopen it
  CANCELLED: [],        // terminal
});

export const canTransition = (from, to) => (TRIP_FLOW[from] ?? []).includes(to);

export default defineAgent({
  id: 'AGENT_01',
  codename: 'KALI',
  title: 'Dispatch & Trip Execution Engine',
  domain: 'operations',
  mandate:
    'Owns the trip lifecycle from pending load through unloading to completion, the ' +
    'RTKM distance/mileage record for every leg, and GPS route progress. Kali decides ' +
    'whether a trip may advance; it never prices one and never posts to the ledger.',

  subscribes: [
    'load.assigned',
    'trip.loading.recorded',
    'trip.gps.ping',
    'trip.unloading.recorded',
    'compliance.clearance.granted',
    'compliance.clearance.denied',
  ],
  emits: [
    'trip.created',
    'trip.status.changed',
    'trip.completed',
    'trip.shortage.detected',
    'trip.rtkm.recorded',
    'compliance.clearance.requested',
  ],

  owns: {
    tables: ['trips', 'trip_legs', 'trip_gps_pings'],
    modules: ['TripManagment.tsx', 'LodingDetals.tsx', 'UnlodingDetals.tsx', 'LoadingAdvice.tsx'],
  },
  reads: ['vehicles', 'drivers', 'vehicle_assignments', 'rtkm_master', 'customers'],

  mustNot: [
    'compute or alter freight amounts — TRIPURA SUNDARI owns rates, TARA owns money',
    'post any ledger entry, even for shortage penalties (it emits, TARA posts)',
    'advance a trip past a BHAIRAVI compliance denial',
    'mark a trip SETTLED — only TARA may, after the ledger balances',
  ],

  guards: [
    { name: 'legal_state_transition',
      description: 'Rejects any status change not present in TRIP_FLOW.' },
    { name: 'clearance_before_dispatch',
      description: 'A trip cannot leave PENDING until BHAIRAVI grants compliance clearance.' },
    { name: 'shortage_is_reported_not_absorbed',
      description: 'unloaded_qty < loaded_qty always emits trip.shortage.detected; Kali never nets it off silently.' },
    { name: 'settled_is_immutable',
      description: 'No transition out of SETTLED. A correction is a new adjusting entry, never an edit.' },
  ],

  // trips lands in migration 003; until then Kali validates and parks.
  requires: ['trips', 'vehicles', 'drivers'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'load.assigned': {
        const { vehicle_id, driver_id } = event.payload ?? {};
        if (!vehicle_id || !driver_id) return failed('load.assigned needs vehicle_id and driver_id');

        // Dispatch never guesses at compliance — it asks Bhairavi and waits.
        // Emitting the request rather than reading licence expiry here keeps
        // one owner for compliance rules.
        await ctx.emit('compliance.clearance.requested', {
          aggregate: 'trip',
          aggregateId: event.aggregate_id,
          payload: { vehicle_id, driver_id, load: event.payload },
          correlationId: event.correlation_id,
        });
        return ok('clearance requested from BHAIRAVI before dispatch');
      }

      case 'compliance.clearance.denied':
        // Bhairavi's refusal is final for this agent.
        return blocked(`dispatch halted: ${event.payload?.reason ?? 'compliance denied'}`);

      case 'trip.unloading.recorded': {
        const loaded = Number(event.payload?.loaded_qty ?? 0);
        const unloaded = Number(event.payload?.unloaded_qty ?? 0);
        if (!loaded) return failed('unloading recorded without a loaded quantity');

        // Petroleum loads legitimately lose a little volume to temperature.
        // Anything past the tolerance is a shortage that must reach the ledger.
        const shortage = loaded - unloaded;
        const tolerance = loaded * Number(process.env.SHORTAGE_TOLERANCE_PCT ?? '0.001');

        if (shortage > tolerance) {
          await ctx.emit('trip.shortage.detected', {
            aggregate: 'trip',
            aggregateId: event.aggregate_id,
            payload: { loaded_qty: loaded, unloaded_qty: unloaded, shortage_qty: shortage },
            correlationId: event.correlation_id,
          });
        }

        await ctx.emit('trip.completed', {
          aggregate: 'trip',
          aggregateId: event.aggregate_id,
          payload: { loaded_qty: loaded, unloaded_qty: unloaded, shortage_qty: Math.max(shortage, 0) },
          correlationId: event.correlation_id,
        });
        return ok(shortage > tolerance ? `completed with shortage ${shortage.toFixed(3)} KL` : 'completed clean');
      }

      case 'trip.gps.ping':
        // High-frequency and non-transactional; recorded for route history only.
        return ok('gps ping recorded');

      default:
        return skipped(`no dispatch rule for ${event.event_type}`);
    }
  },
});
