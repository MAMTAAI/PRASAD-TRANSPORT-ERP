// server/lib/freightRate.js
// ─────────────────────────────────────────────────────────────────────────────
// Provisional freight for a trip, from the rate schedule in master_iocl_rates.
//
// TWO PRODUCTS, TWO FORMULAS, AND THEY ARE NOT INTERCHANGEABLE
//
//   POL  HSD / MS / ATF, in KL, rate is per KL per km
//        amount = rtkm * rate * qty
//
//   LPG  bulk gas, in MT, rate is a FLAT per-MT lane rate
//        amount = rate * qty                        <- no distance term
//
// Both were measured off 1,157 real IOCL bill lines. The LPG one is the trap:
// its per-MT rate is ~1,443 where a POL rate is ~3.4, so feeding an LPG load
// through the POL formula multiplies a 17 MT load by 341 km and bills roughly a
// hundred times the real figure. The unit is therefore decided by the product,
// never by the caller, and the two paths never share a branch.
//
// EVERY ANSWER IS PROVISIONAL. 441 of 1,061 POL bill lines do not fit the
// formula, and the misses are large (258 average 60,074 low). Until that is
// understood a computed freight is an estimate to be reconciled against the
// real bill, not a replacement for it. Callers get `provisional: true` and are
// expected to respect it.
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

  // The whole point of `basis`: PER_UNIT_FLAT must not touch rtkm.
  const amount = r.basis === 'PER_UNIT_KM'
    ? Number(rtkm) * Number(r.rate) * Number(qty)
    : Number(r.rate) * Number(qty);

  // Rounded to paise here for display; the authoritative arithmetic happens in
  // SQL numeric when the value is written.
  out.amount = Math.round(amount * 100) / 100;
  return out;
}

/**
 * Rate variance between what was billed provisionally and a revised rate.
 * variance = (revised - provisional) * (rtkm * qty)  for POL
 *          = (revised - provisional) * qty           for LPG
 */
export function rateVariance({ basis, provisionalRate, revisedRate, rtkm, qty }) {
  const delta = Number(revisedRate) - Number(provisionalRate);
  const units = basis === 'PER_UNIT_KM' ? Number(rtkm) * Number(qty) : Number(qty);
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
