// server/agents/kali.js
// AGENT 01 — KALI · Dispatch & Trip Execution Engine
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';
import { runIoclSync, SyncBusyError } from '../lib/ioclSyncRunner.js';
import { stmSet } from '../memory/okf.js';

const LIVE_TTL_MS = 15 * 60 * 1000;

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
    // THE DAILY LOADING CYCLE (owner's rule, 2-Sep-2026): every 10 minutes
    // the graph asks Kali to poll both IOCL mailboxes for the AC4 — the
    // consignee's tax invoice, mailed within the hour of the truck leaving
    // the bay — and write the loading register. Daily dispatch operations.
    'loading.mail.sweep.requested',
  ],
  emits: [
    'trip.created',
    'trip.status.changed',
    'trip.completed',
    'trip.shortage.detected',
    'trip.rtkm.recorded',
    'compliance.clearance.requested',
    'loading.registered',
  ],

  owns: {
    // iocl_ac4_loads is the loading register: one row per AC4 document.
    tables: ['trips', 'trip_legs', 'trip_gps_pings', 'iocl_ac4_loads'],
    modules: ['TripManagment.tsx', 'LodingDetals.tsx', 'UnlodingDetals.tsx', 'LoadingAdvice.tsx'],
  },
  reads: ['vehicles', 'drivers', 'vehicle_assignments', 'rtkm_master', 'customers'],

  mustNot: [
    'compute or alter freight amounts — TRIPURA SUNDARI owns rates, TARA owns money',
    'post any ledger entry, even for shortage penalties (it emits, TARA posts)',
    'advance a trip past a BHAIRAVI compliance denial',
    'mark a trip SETTLED — only TARA may, after the ledger balances',
    'turn an AC4 loading into a trip or give it a freight figure — the AC4 is daily loading; the AC5 (BHUVANESHWARI parses, TARA posts) is billing',
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

      case 'loading.mail.sweep.requested': {
        // THE DAILY LOADING CYCLE. Both IOCL mailboxes, AC4 mail only, into
        // iocl_ac4_loads through the shared sync runner (one lock, one log:
        // /var/lib/prasad/logs/cron_sync.log, trigger 'kali', stage 'ac4').
        // The AC5 — billing — is BHUVANESHWARI's and TARA's; this stage never
        // opens one. A lock collision with their pass is BLOCKED, not an
        // error: the next graph cycle that is due will simply try again.
        let r;
        try {
          r = await runIoclSync({ stage: 'ac4', apply: true, trigger: 'kali' });
        } catch (err) {
          if (err instanceof SyncBusyError) return blocked(`mail sync busy: ${err.message}`);
          const why = String(err.message).slice(0, 200);
          stmSet('AGENT_01', 'live_action', `AC4 sweep failed: ${why.slice(0, 80)}`, LIVE_TTL_MS);
          return failed(`AC4 sweep failed: ${why}`);
        }
        const dead = r.mailboxes_failed ?? [];
        const line = `AC4 sweep: ${r.ac4_new ?? 0} new, ${r.ac4_already ?? 0} already, ${r.ac4_failed ?? 0} failed`
          + (dead.length ? ` · mailbox down: ${dead.join(', ')}` : '')
          + (r.ac4_error ? ` · ${String(r.ac4_error).slice(0, 80)}` : '')
          + ` (${r.seconds}s)`;
        stmSet('AGENT_01', 'live_action', line, LIVE_TTL_MS);
        await ctx.emit('loading.registered', {
          aggregate: 'loading',
          payload: {
            new: r.ac4_new ?? 0, already: r.ac4_already ?? 0, failed: r.ac4_failed ?? 0,
            mailboxes_failed: dead, error: r.ac4_error ?? null, seconds: r.seconds,
          },
          correlationId: event.correlation_id,
        });
        // A dead mailbox needs a person (a Google login), so it is a guard
        // outcome, not a retry. A refused row or a sweep error is ours.
        if (dead.length) return blocked(line);
        if ((r.ac4_failed ?? 0) > 0 || r.ac4_error) return failed(line);
        return ok(line);
      }

      default:
        return skipped(`no dispatch rule for ${event.event_type}`);
    }
  },
});
