// server/lib/freightRate.js
// ─────────────────────────────────────────────────────────────────────────────
// Provisional freight for a trip, from the rate schedule in master_iocl_rates.
//
// ONE FORMULA, TWO UNITS, AND A SHORT-HAUL EXCEPTION
//
//     billed = billable_rtkm * rate * qty      LPG in MT, POL in KL
//
// An earlier version of this file claimed LPG had NO distance term and billed a
// flat per-MT lane rate. That was wrong. The evidence came from two lanes, 86 km
// and 341 km, where per-MT was identical across loads -- but rtd is constant
// within a lane, so per-MT is constant there under any formula. A fixed-distance
// artefact was read as a fixed-rate rule.
//
// Across all LPG lanes, 1075 km to 2864 km:
//     >= 400 km   n=61   3.0067 .. 3.4325   median 3.3135   sd 0.094
//     <  400 km   n=19   3.5040 .. 10.6487  median 4.2304   sd 1.490
// An sd of 0.094 across a 2.7x spread of distances is a per-km rate.
//
// BILLABLE RTKM IS NOT ALWAYS ACTUAL RTKM. The wide short-haul band is the
// contract regime, not a different formula:
//
//   is_fixed_freight     bill fixed_trip_rate flat; distance and quantity do
//                        not enter the arithmetic at all
//   min_rtkm_guarantee   bill GREATEST(actual, floor) -- every short LPG lane
//                        measured bills as if it ran further than it did
//                        (86 -> 276, 341 -> 435, 344 -> 364, 391 -> 483)
//
// The unit rule is the one that still cannot be crossed: LPG is MT, POL is KL,
// enforced by CHECK constraint. Billing 17 MT as 17 KL is the error that unit
// separation exists to prevent.
//
// EVERY ANSWER IS PROVISIONAL. 441 of 1,061 POL bill lines do not fit the
// formula and the misses are large. This computes an estimate to reconcile
// against the real bill, not a replacement for it.
import { query } from '../db/pool.js';

// Product text as it appears on an AC5 -> category. The AC5 prints things like
// "JET A-1 (ATF)", "HSD-BSVI", "EBMS", "LPG BULK".
const LPG_PAT = /\bLPG\b|LIQUEFIED|PROPANE|BUTANE/i;
const POL_PAT = /HSD|DIESEL|BSVI|EBMS|\bMS\b|PETROL|ATF|JET|SKO|KEROSENE|NAPHTHA/i;

/** Decide POL vs LPG from a material code, a product name, or both. */
export async function categoryOf({ material = null, product = null } = {}) {
  if (material) {
    const { rows } = await query(
      'SELECT product_category, unit, product_name FROM iocl_material_map WHERE material_code = $1',
      [String(material)],
    );
    if (rows.length) return { ...rows[0], via: 'material_code' };
  }
  const text = String(product ?? '');
  // LPG is tested first: "LPG Bulk" must not be caught by a loose POL pattern.
  if (LPG_PAT.test(text)) return { product_category: 'LPG', unit: 'MT', via: 'product_name' };
  if (POL_PAT.test(text)) return { product_category: 'POL', unit: 'KL', via: 'product_name' };
  return { product_category: null, unit: null, via: 'unknown' };
}

/**
 * Resolve the active rate and compute a provisional freight.
 *
 * @returns {object} always -- an unresolvable rate is a reported reason, not a throw.
 */
export async function computeFreight({
  material = null, product = null, rtkm = null, qty = null,
  shipToCode = null, onDate = null,
} = {}) {
  const cat = await categoryOf({ material, product });
  const out = {
    product_category: cat.product_category, unit: cat.unit, detected_via: cat.via,
    rtkm: rtkm == null ? null : Number(rtkm),
    qty: qty == null ? null : Number(qty),
    rate: null, basis: null, amount: null,
    rule: null, billable_rtkm: null, min_rtkm_guarantee: null, fixed_trip_rate: null,
    rate_source: null, rate_id: null, sample_loads: null,
    provisional: true, reason: null,
  };

  if (!cat.product_category) { out.reason = `product not recognised: ${product ?? material ?? '(none)'}`; return out; }
  if (!(Number(qty) > 0))    { out.reason = 'no loaded quantity'; return out; }
  // Distance is required for POL and irrelevant for LPG -- checking it
  // unconditionally would reject every LPG load for missing something its
  // formula does not use.
  if (cat.product_category === 'POL' && !(Number(rtkm) > 0)) { out.reason = 'no rtkm'; return out; }

  // Lane rate first, slab second. A rate measured on this very lane beats a
  // median taken across every lane in the fleet.
  const { rows } = await query(
    `SELECT id, rate, basis, unit, source, sample_loads, ship_to_code,
            is_fixed_freight, min_rtkm_guarantee, fixed_trip_rate,
            (ship_to_code IS NOT NULL) AS is_lane
       FROM master_iocl_rates
      WHERE status = 'ACTIVE'
        AND product_category = $1
        AND ($2::text IS NULL OR ship_to_code IS NULL OR ship_to_code = $2::text)
        AND ($3::numeric IS NULL OR (
              min_rtkm <= $3::numeric AND (max_rtkm IS NULL OR $3::numeric < max_rtkm)))
        AND ($4::date IS NULL OR effective_from <= $4::date)
        AND ($4::date IS NULL OR effective_to IS NULL OR effective_to >= $4::date)
      ORDER BY is_lane DESC,                       -- this lane beats a slab
               (source = 'IOCL_CIRCULAR') DESC,    -- published beats derived
               sample_loads DESC,                  -- more evidence beats less
               effective_from DESC
      LIMIT 1`,
    [cat.product_category, shipToCode, rtkm == null ? null : Number(rtkm), onDate],
  );

  if (!rows.length) { out.reason = `no active ${cat.product_category} rate for this lane/distance/date`; return out; }

  const r = rows[0];
  out.rate = Number(r.rate);
  out.basis = r.basis;
  out.rate_source = r.source;
  out.rate_id = r.id;
  out.sample_loads = r.sample_loads;

  // ── Fixed freight: distance and quantity do not enter it ──────────────────
  if (r.is_fixed_freight) {
    out.rule = 'FIXED_TRIP_RATE';
    out.billable_rtkm = null;
    out.amount = Math.round(Number(r.fixed_trip_rate) * 100) / 100;
    out.fixed_trip_rate = Number(r.fixed_trip_rate);
    return out;
  }

  // ── Minimum guarantee: bill the floor when the run is shorter than it ─────
  const actual = Number(rtkm) || 0;
  const floor = r.min_rtkm_guarantee == null ? null : Number(r.min_rtkm_guarantee);
  const billable = floor != null && floor > actual ? floor : actual;
  out.billable_rtkm = billable;
  out.min_rtkm_guarantee = floor;
  out.rule = floor != null && floor > actual ? 'MIN_RTKM_GUARANTEE' : 'STANDARD';

  if (r.basis === 'PER_UNIT_FLAT') {
    // Retired basis, kept readable rather than silently mis-billed: a
    // PER_UNIT_FLAT row is a lane TOTAL, not a rate, so it must not be
    // multiplied by anything.
    out.reason = 'rate row uses the superseded PER_UNIT_FLAT basis; re-seed it';
    out.amount = null;
    return out;
  }

  // Rounded to paise for display; the authoritative arithmetic happens in SQL
  // numeric when the figure is written.
  out.amount = Math.round(billable * Number(r.rate) * Number(qty) * 100) / 100;
  return out;
}

/**
 * Rate variance between what was billed provisionally and a revised rate.
 * variance = (revised - provisional) * (rtkm * qty)  for POL
 *          = (revised - provisional) * qty           for LPG
 */
export function rateVariance({ basis, provisionalRate, revisedRate, rtkm, qty, billableRtkm = null }) {
  const delta = Number(revisedRate) - Number(provisionalRate);
  // The variance rides on the distance that was BILLED, not the one driven --
  // on a lane with a minimum guarantee those differ, and using the actual
  // distance would under-state every adjustment on exactly the short lanes
  // where the rate is least certain.
  const km = billableRtkm != null ? Number(billableRtkm) : Number(rtkm);
  const units = basis === 'PER_UNIT_KM' ? km * Number(qty) : Number(qty);
  const amount = Math.round(delta * units * 100) / 100;
  return {
    delta_rate: Math.round(delta * 1e6) / 1e6,
    units,
    amount,
    // Which way the adjustment goes. A revised rate above the provisional one
    // means we under-billed and are owed more: a DEBIT to the party.
    direction: amount > 0 ? 'DEBIT_PARTY' : amount < 0 ? 'CREDIT_PARTY' : 'NONE',
  };
}
