// server/agents/chhinnamasta.js
// AGENT 06 — CHHINNAMASTA · Fuel/HSD & Pump Settlement Engine
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';

/**
 * Fuel is the largest controllable cost in a tanker fleet and the easiest place
 * for leakage, so this agent exists to make that leakage visible.
 *
 * The live data gives it everything it needs. FUEL_ENTRIES carries
 * (vehicle_no, liters, rate, amount, cash_given_to_pump, vendor_name, trip_id)
 * and RTKM_MASTER carries the lane distance and its Fixed_HSD allowance — for
 * example 280 L budgeted for an 838.3 km lane, i.e. ~2.99 km/L expected.
 *
 * Two independent checks fall out of that:
 *   1. amount vs liters x rate  — arithmetic on the slip itself
 *   2. actual km/L vs the lane's implied km/L — pilferage or a leaking tank
 *
 * The second is the one that catches theft, because a slip can be internally
 * perfect and still represent fuel that never entered the vehicle.
 */
export default defineAgent({
  id: 'AGENT_06',
  codename: 'CHHINNAMASTA',
  title: 'Fuel/HSD & Pump Settlement Engine',
  domain: 'fuel',
  mandate:
    'Owns HSD consumption and pump settlement: fuel slip auditing, petrol pump ledger ' +
    'reconciliation, and mileage-versus-RTKM anomaly detection. Chhinnamasta verifies that ' +
    'every litre billed was plausibly consumed, and reconciles cash advanced to pumps ' +
    'against bills actually received.',

  subscribes: [
    'fuel.slip.submitted',
    'trip.completed',
    'pump.statement.received',
    'fuel.reconciliation.requested',
  ],
  emits: [
    'fuel.slip.recorded',
    'fuel.slip.rejected',
    'fuel.mileage.anomaly',
    'pump.balance.reconciled',
    'pump.balance.mismatch',
    'fuel.price.changed',
  ],

  owns: {
    tables: ['fuel_entries', 'pump_settlements', 'fuel_price_history'],
    modules: ['FuelMgmt.tsx'],
  },
  reads: ['trips', 'vehicles', 'vendors', 'rtkm_master', 'ledger_entries'],

  mustNot: [
    'post the fuel expense to the ledger itself — it emits fuel.slip.recorded, TARA posts',
    'adjust a recorded litre quantity to make mileage look acceptable',
    'settle a pump account while a slip for that pump is still in dispute',
  ],

  guards: [
    { name: 'slip_arithmetic',
      description: 'amount must equal liters x rate within FUEL_ROUNDING_TOLERANCE (default Rs.1).' },
    { name: 'mileage_within_band',
      description: 'Actual km/L must be within MILEAGE_TOLERANCE_PCT (default 15%) of the lane RTKM allowance.' },
    { name: 'no_duplicate_memo',
      description: 'One (vendor, memo_no) pair posts once — the same pump bill cannot be claimed twice.' },
    { name: 'cash_advance_reconciles',
      description: 'cash_given_to_pump must net against bills received; a drift raises pump.balance.mismatch.' },
  ],

  requires: ['fuel_entries', 'vendors', 'rtkm_master'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'fuel.slip.submitted': {
        const { liters, rate, amount, vendor_id, memo_no, vehicle_no } = event.payload ?? {};
        if (!liters || !rate) return failed('fuel slip needs liters and rate');

        // 1. Arithmetic on the slip.
        const tolerance = Number(process.env.FUEL_ROUNDING_TOLERANCE ?? '1');
        const expected = Number(liters) * Number(rate);
        if (amount !== undefined && Math.abs(Number(amount) - expected) > tolerance) {
          await ctx.emit('fuel.slip.rejected', {
            aggregate: 'fuel_entry', aggregateId: event.aggregate_id,
            payload: { reason: 'arithmetic mismatch', billed: amount, computed: expected.toFixed(2) },
            correlationId: event.correlation_id,
          });
          return blocked(`slip arithmetic: billed Rs.${amount} vs computed Rs.${expected.toFixed(2)}`);
        }

        // 2. Duplicate memo — the same bill submitted twice by two people.
        if (vendor_id && memo_no) {
          const dup = await queryOne(
            `SELECT id FROM fuel_entries WHERE vendor_id = $1 AND memo_no = $2 LIMIT 1`,
            [vendor_id, memo_no]
          );
          if (dup) return blocked(`duplicate memo ${memo_no} for this pump (existing entry ${dup.id})`);
        }

        await ctx.emit('fuel.slip.recorded', {
          aggregate: 'fuel_entry', aggregateId: event.aggregate_id,
          payload: { liters, rate, amount: amount ?? expected.toFixed(2), vendor_id, vehicle_no },
          correlationId: event.correlation_id,
        });
        return ok(`slip accepted: ${liters} L @ Rs.${rate}`);
      }

      case 'trip.completed': {
        // Mileage check against the lane's own HSD allowance.
        const tripId = event.aggregate_id;
        if (!tripId) return skipped('no trip id');

        const row = await queryOne(
          `SELECT t.vehicle_no,
                  r.rtkm_distance,
                  r.fixed_hsd_qty,
                  COALESCE(SUM(f.liters), 0) AS actual_liters
             FROM trips t
             LEFT JOIN rtkm_master r
                    ON r.customer_name = t.customer_name
                   AND r.consignee_name = t.consignee_name
             LEFT JOIN fuel_entries f ON f.trip_id = t.id
            WHERE t.id = $1
            GROUP BY t.vehicle_no, r.rtkm_distance, r.fixed_hsd_qty`,
          [tripId]
        );
        if (!row?.rtkm_distance || !row?.fixed_hsd_qty) return skipped('lane has no RTKM/HSD allowance to compare against');

        const actual = Number(row.actual_liters);
        if (!actual) return skipped('no fuel recorded against this trip');

        const expectedKmpl = Number(row.rtkm_distance) / Number(row.fixed_hsd_qty);
        const actualKmpl = Number(row.rtkm_distance) / actual;
        const drift = Math.abs(actualKmpl - expectedKmpl) / expectedKmpl;
        const band = Number(process.env.MILEAGE_TOLERANCE_PCT ?? '15') / 100;

        if (drift > band) {
          await ctx.emit('fuel.mileage.anomaly', {
            aggregate: 'trip', aggregateId: tripId,
            payload: {
              vehicle_no: row.vehicle_no,
              rtkm: row.rtkm_distance,
              allowance_liters: row.fixed_hsd_qty,
              actual_liters: actual,
              expected_kmpl: expectedKmpl.toFixed(2),
              actual_kmpl: actualKmpl.toFixed(2),
              drift_pct: (drift * 100).toFixed(1),
            },
            correlationId: event.correlation_id,
          });
          return ok(`mileage anomaly flagged: ${actualKmpl.toFixed(2)} vs expected ${expectedKmpl.toFixed(2)} km/L`);
        }
        return ok(`mileage within band (${actualKmpl.toFixed(2)} km/L)`);
      }

      default:
        return skipped(`no fuel rule for ${event.event_type}`);
    }
  },
});
