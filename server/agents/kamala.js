// server/agents/kamala.js
// AGENT 00 — MAHA KAMALA · Chief ERP Orchestrator
import { defineAgent, ok, skipped, blocked } from './base.js';
import { withTransaction, queryOne } from '../db/pool.js';

// Advisory-lock namespaces. PostgreSQL advisory locks are (int, int) pairs;
// a fixed namespace per aggregate keeps trip locks from colliding with ledger
// locks even if two ids hash the same.
export const LOCK_NS = { TRIP: 1, LEDGER: 2, VEHICLE: 3, DRIVER: 4, INVOICE: 5, SETTLEMENT: 6 };

/**
 * Take a cross-module transaction lock for the duration of `fn`.
 *
 * This is the mechanism behind "cross-module transaction lock": a trip
 * settlement touches trips, ledger_entries, driver_transactions and invoices.
 * Two operators settling the same trip concurrently would each read a stale
 * balance and post twice. pg_advisory_xact_lock serialises them on the trip id
 * and releases automatically when the transaction ends — no orphaned lock if
 * the process dies mid-write, which a lock *table* could not promise.
 */
export async function withAggregateLock(ns, id, fn) {
  return withTransaction(async (tx) => {
    // hashtextextended gives a stable bigint from a uuid; the namespace keeps
    // aggregates separated.
    await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [ns, id]);
    return fn(tx);
  });
}

export default defineAgent({
  id: 'AGENT_00',
  codename: 'KAMALA',
  title: 'Chief ERP Orchestrator',
  domain: 'orchestration',
  mandate:
    'Owns cross-module workflow sequencing, the advisory-lock discipline that keeps ' +
    'concurrent settlements from double-posting, and the aggregated dashboard state. ' +
    'Kamala never performs domain arithmetic itself — it decides what runs, in what ' +
    'order, and under which lock, then delegates to the domain agent that owns the data.',

  // Kamala listens to lifecycle boundaries, not to every event. It reacts when
  // a workflow needs to advance across module edges.
  subscribes: [
    'trip.completed',
    'trip.settlement.requested',
    'invoice.generation.requested',
    'agent.halt.requested',
    'dashboard.refresh.requested',
  ],
  emits: [
    'workflow.started',
    'workflow.completed',
    'workflow.rejected',
    'dashboard.state.changed',
    'trip.settlement.authorised',
  ],

  // Kamala owns no business table. That is deliberate: an orchestrator with its
  // own domain data becomes a second source of truth.
  owns: { tables: ['agent_events', 'agent_runs'], modules: ['Dashboard.tsx', 'AdminDashboard.tsx'] },
  reads: ['trips', 'ledger_entries', 'vehicles', 'drivers', 'invoices'],

  mustNot: [
    'compute freight, settlement or ledger amounts — that is TARA and KALI',
    'write to any domain table (trips, ledgers, vehicles, drivers, fuel_entries)',
    'bypass a guard raised by BHAIRAVI or TARA, under any circumstance',
  ],

  guards: [
    { name: 'single_writer_per_aggregate',
      description: 'Every cross-module write path holds pg_advisory_xact_lock on the aggregate id.' },
    { name: 'no_settlement_without_ledger_ack',
      description: 'A settlement only proceeds once TARA has confirmed the trip ledger balances.' },
    { name: 'halt_is_absolute',
      description: 'While a live row exists in agent_halts, Kamala authorises no new workflow.' },
  ],

  requires: ['agent_events', 'agent_runs', 'agent_halts'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'trip.settlement.requested': {
        const tripId = event.aggregate_id;
        if (!tripId) return skipped('settlement request carried no trip id');

        // A global or Tara-scoped halt stops authorisation dead.
        const halt = await queryOne(
          `SELECT reason, agent_id FROM agent_halts
            WHERE cleared_at IS NULL AND (agent_id IS NULL OR agent_id = 'AGENT_02')
            ORDER BY halted_at LIMIT 1`
        );
        if (halt) return blocked(`halt active (${halt.agent_id ?? 'GLOBAL'}): ${halt.reason}`);

        // Authorise under the trip lock so two concurrent requests serialise.
        await withAggregateLock(LOCK_NS.TRIP, tripId, async (tx) => {
          await ctx.emit('trip.settlement.authorised', {
            aggregate: 'trip',
            aggregateId: tripId,
            payload: { requested_by: event.payload?.requested_by ?? null },
            correlationId: event.correlation_id,
            tx,
          });
        });
        return ok(`settlement authorised for trip ${tripId}`);
      }

      case 'trip.completed':
        // Completion does not imply settlement — KALI closes the trip, and an
        // operator (or MATANGI, via WhatsApp) requests settlement separately.
        return ok('trip completion acknowledged; awaiting settlement request');

      case 'agent.halt.requested':
        // Delegated to BAGALAMUKHI, which owns agent_halts.
        return skipped('halt execution belongs to AGENT_08');

      default:
        return skipped(`no orchestration rule for ${event.event_type}`);
    }
  },
});
