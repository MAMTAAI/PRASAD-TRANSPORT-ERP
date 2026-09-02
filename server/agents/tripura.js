// server/agents/tripura.js
// AGENT 03 — TRIPURA SUNDARI · Bazaar Admin & Freight Rate Engine
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';

/**
 * The rate engine's inputs come straight from the live RTKM_MASTER, which
 * carries per-lane commercial terms — for example:
 *
 *   Customer   INDIAN OIL CORPORATION LTD
 *   Depot      LUMDING TERMINAL (7T04)  ->  MOHANBARI AFS 7A09
 *   Capacity   40 KL (18 Wheeler)   Item  ATF (Aviation)
 *   RTKM       838.3 km   Fixed_HSD 280 L   Fixed_Cash Rs.2000   Toll Rs.-
 *
 * So a lane's cost floor is computable: HSD litres x pump rate + fixed cash +
 * toll. Tripura Sundari's job is to never let a bid or a rate go out below that
 * floor, which is the single most common way a transport firm loses money on a
 * load that looked profitable.
 */
export default defineAgent({
  id: 'AGENT_03',
  codename: 'TRIPURA_SUNDARI',
  title: 'Bazaar Admin & Freight Rate Engine',
  domain: 'commercial',
  mandate:
    'Owns commercial pricing: the RTKM lane masters, customer rate cards, market-vehicle ' +
    'KYC and bidding, and freight margin optimisation. Tripura Sundari is the only agent ' +
    'that may set or change a freight rate, and it must refuse any rate that prices a lane ' +
    'below its computed cost floor.',

  subscribes: [
    'load.posted',
    'bid.submitted',
    'rate.quote.requested',
    'market.vehicle.registered',
    'fuel.price.changed',
  ],
  emits: [
    'rate.quoted',
    'rate.rejected.below_floor',
    'bid.accepted',
    'bid.rejected',
    'load.assigned',
    'margin.alert.raised',
  ],

  owns: {
    tables: ['rtkm_master', 'rate_master', 'bazaar_loads', 'bazaar_bids', 'market_vehicles'],
    modules: ['RateMaster.tsx', 'LocationRtkmMaster.tsx', 'BazaarAdmin.tsx',
              'MarketVehicles.tsx', 'FleetPartnerPortal.tsx'],
  },
  reads: ['customers', 'vehicles', 'fuel_entries', 'trips', 'vendors'],

  mustNot: [
    'post to any ledger — it prices, TARA accounts',
    'dispatch a load directly; it emits load.assigned and KALI decides whether the trip may run',
    'accept a bid below the lane cost floor, even on an operator override',
    'grant compliance clearance to a market vehicle — that is BHAIRAVI',
  ],

  guards: [
    { name: 'never_below_cost_floor',
      description: 'Rate must cover fixed HSD litres x current pump rate + fixed cash + toll for the lane.' },
    { name: 'rate_requires_known_lane',
      description: 'A quote needs an rtkm_master row; an unknown lane is quoted manually, never guessed.' },
    { name: 'market_vehicle_kyc_complete',
      description: 'A market vehicle cannot win a bid until its KYC documents are on file and unexpired.' },
    { name: 'margin_floor_alert',
      description: 'Margin under MIN_MARGIN_PCT (default 8%) raises margin.alert.raised rather than passing silently.' },
  ],

  requires: ['rtkm_master', 'rate_master', 'customers'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'rate.quote.requested': {
        const { customer_name, consignee_name, vehicle_capacity, offered_rate } = event.payload ?? {};
        if (!customer_name || !consignee_name) return failed('quote needs customer_name and consignee_name');

        const lane = await queryOne(
          `SELECT rtkm_distance, fixed_hsd_qty, fixed_cash_amt, toll_amt, item_type
             FROM rtkm_master
            WHERE customer_name = $1 AND consignee_name = $2
              AND ($3::text IS NULL OR vehicle_capacity = $3)
              AND status = 'ACTIVE'
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1`,
          [customer_name, consignee_name, vehicle_capacity ?? null]
        );
        if (!lane) return blocked(`no active rtkm_master lane for ${customer_name} -> ${consignee_name}`);

        // Cost floor from the lane's own fixed terms. The pump rate is the one
        // volatile input, so it comes from the latest recorded fuel entry
        // rather than a hard-coded constant.
        const pump = await queryOne(
          `SELECT rate FROM fuel_entries WHERE rate > 0 ORDER BY entry_date DESC LIMIT 1`
        );
        const hsdRate = Number(pump?.rate ?? process.env.FALLBACK_HSD_RATE ?? 0);
        if (!hsdRate) return blocked('no HSD pump rate available — cannot compute a cost floor');

        const floor =
          Number(lane.fixed_hsd_qty ?? 0) * hsdRate +
          Number(lane.fixed_cash_amt ?? 0) +
          Number(lane.toll_amt ?? 0);

        if (offered_rate !== undefined && Number(offered_rate) < floor) {
          await ctx.emit('rate.rejected.below_floor', {
            aggregate: 'lane',
            payload: { customer_name, consignee_name, offered_rate, cost_floor: floor, hsd_rate: hsdRate },
            correlationId: event.correlation_id,
          });
          return blocked(`offered Rs.${offered_rate} is below cost floor Rs.${floor.toFixed(2)}`);
        }

        const minMargin = Number(process.env.MIN_MARGIN_PCT ?? '8') / 100;
        const quoted = Number(offered_rate ?? floor * (1 + minMargin));
        const margin = (quoted - floor) / quoted;

        if (margin < minMargin) {
          await ctx.emit('margin.alert.raised', {
            aggregate: 'lane',
            payload: { customer_name, consignee_name, quoted, cost_floor: floor, margin_pct: (margin * 100).toFixed(2) },
            correlationId: event.correlation_id,
          });
        }

        await ctx.emit('rate.quoted', {
          aggregate: 'lane',
          payload: { customer_name, consignee_name, rtkm: lane.rtkm_distance, quoted, cost_floor: floor, margin_pct: (margin * 100).toFixed(2) },
          correlationId: event.correlation_id,
        });
        return ok(`quoted Rs.${quoted.toFixed(2)} on ${lane.rtkm_distance} km (floor Rs.${floor.toFixed(2)})`);
      }

      case 'fuel.price.changed':
        // Every lane's cost floor just moved. Re-pricing is a bulk operation
        // and belongs in a scheduled sweep, not in this event handler.
        return ok('pump rate change noted — lane floors recompute on next quote');

      default:
        return skipped(`no commercial rule for ${event.event_type}`);
    }
  },
});
