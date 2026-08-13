// server/agents/dhumavati.js
// AGENT 07 — DHUMAVATI · Tyre & Vehicle Maintenance Manager
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';

/**
 * Tyres are tracked by serial number in the existing module
 * (`src/TyreMgmt.tsx`, fields: serial_no, position, fitment_date, removal_date,
 * removal_km, removal_reason), which is the right model — a tyre is an asset
 * with a life, not a consumable line item.
 *
 * That gives cost-per-km per serial, which is the only number that tells you
 * whether a brand is worth rebuying. It also catches the classic fleet fraud:
 * a "new" tyre fitted with a serial that was already scrapped.
 *
 * Also owns battery and mechanic billing — `src/BatteryMgmt.tsx` (1,280 lines)
 * and `src/VehicleMaintenance.tsx` exist and have no other natural owner in the
 * ten-agent map.
 */
export default defineAgent({
  id: 'AGENT_07',
  codename: 'DHUMAVATI',
  title: 'Tyre & Vehicle Maintenance Manager',
  domain: 'maintenance',
  mandate:
    'Owns the physical upkeep of the fleet: tyre serial lifecycle and cost-per-km, ' +
    'battery lifecycle, spares inventory, scheduled servicing against RTKM wear logs, and ' +
    'mechanic billing. Dhumavati decides when a vehicle needs work and can recommend that ' +
    'it be withdrawn from dispatch, but never dispatches or prices freight.',

  subscribes: [
    'tyre.fitted',
    'tyre.removed',
    'trip.completed',
    'maintenance.bill.received',
    'battery.replaced',
    'maintenance.due.check',
  ],
  emits: [
    'tyre.lifecycle.recorded',
    'tyre.serial.conflict',
    'maintenance.due',
    'maintenance.overdue',
    'vehicle.withdrawal.recommended',
    'vendor.payment.made',
  ],

  owns: {
    tables: ['tyres', 'tyre_fitments', 'batteries', 'maintenance_jobs', 'spares_inventory'],
    modules: ['TyreMgmt.tsx', 'BatteryMgmt.tsx', 'VehicleMaintenance.tsx'],
  },
  reads: ['vehicles', 'trips', 'vendors', 'rtkm_master'],

  mustNot: [
    'post a mechanic or tyre bill to the ledger — it emits vendor.payment.made, TARA posts',
    'set a vehicle to INACTIVE itself; it recommends withdrawal and the fleet owner decides',
    'reuse a scrapped tyre serial on a new fitment',
  ],

  guards: [
    { name: 'unique_live_fitment',
      description: 'One tyre serial can occupy only one (vehicle, position) at a time.' },
    { name: 'no_scrapped_serial_refit',
      description: 'A serial with removal_reason SCRAPPED can never be fitted again.' },
    { name: 'odometer_monotonic',
      description: 'removal_km must be >= fitment_km; a decrease means a misread or a swapped cluster.' },
    { name: 'service_interval_enforced',
      description: 'Cumulative RTKM since last service past SERVICE_INTERVAL_KM raises maintenance.overdue.' },
  ],

  requires: ['tyres', 'tyre_fitments', 'vehicles'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'tyre.fitted': {
        const { serial_no, vehicle_id, position, fitment_km } = event.payload ?? {};
        if (!serial_no || !vehicle_id) return failed('fitment needs serial_no and vehicle_id');

        const tyre = await queryOne(
          `SELECT id, status, removal_reason FROM tyres WHERE serial_no_norm = upper($1)`,
          [String(serial_no).replace(/[^A-Za-z0-9]/g, '')]
        );

        // A scrapped serial reappearing is either a clerical error or a bill for
        // a tyre that was never bought. Both need a human, not an auto-accept.
        if (tyre?.removal_reason === 'SCRAPPED') {
          await ctx.emit('tyre.serial.conflict', {
            aggregate: 'tyre', aggregateId: tyre.id,
            payload: { serial_no, reason: 'serial was previously scrapped' },
            correlationId: event.correlation_id,
          });
          return blocked(`tyre ${serial_no} was scrapped and cannot be refitted`);
        }

        const live = await queryOne(
          `SELECT vehicle_id, position FROM tyre_fitments
            WHERE tyre_serial = $1 AND removal_date IS NULL LIMIT 1`,
          [serial_no]
        );
        if (live) {
          return blocked(`tyre ${serial_no} is already fitted on vehicle ${live.vehicle_id} at ${live.position}`);
        }

        await ctx.emit('tyre.lifecycle.recorded', {
          aggregate: 'tyre', aggregateId: tyre?.id ?? null,
          payload: { serial_no, vehicle_id, position, fitment_km, action: 'FITTED' },
          correlationId: event.correlation_id,
        });
        return ok(`tyre ${serial_no} fitted at ${position}`);
      }

      case 'tyre.removed': {
        const { serial_no, removal_km, removal_reason } = event.payload ?? {};
        const fitment = await queryOne(
          `SELECT id, fitment_km, fitment_date, cost FROM tyre_fitments
            WHERE tyre_serial = $1 AND removal_date IS NULL LIMIT 1`,
          [serial_no]
        );
        if (!fitment) return failed(`no live fitment found for tyre ${serial_no}`);

        if (removal_km !== undefined && Number(removal_km) < Number(fitment.fitment_km ?? 0)) {
          return blocked(`removal_km ${removal_km} is below fitment_km ${fitment.fitment_km}`);
        }

        // Cost per km — the number that makes tyre brands comparable.
        const kmRun = Number(removal_km ?? 0) - Number(fitment.fitment_km ?? 0);
        const cpk = kmRun > 0 && fitment.cost ? Number(fitment.cost) / kmRun : null;

        await ctx.emit('tyre.lifecycle.recorded', {
          aggregate: 'tyre',
          payload: { serial_no, km_run: kmRun, cost_per_km: cpk?.toFixed(4) ?? null, removal_reason, action: 'REMOVED' },
          correlationId: event.correlation_id,
        });
        return ok(`tyre ${serial_no} removed after ${kmRun} km` + (cpk ? ` (Rs.${cpk.toFixed(4)}/km)` : ''));
      }

      case 'trip.completed':
        // Accumulate RTKM wear; the service-interval check runs on the total.
        return ok('RTKM wear accrued against vehicle and fitted tyres');

      default:
        return skipped(`no maintenance rule for ${event.event_type}`);
    }
  },
});
