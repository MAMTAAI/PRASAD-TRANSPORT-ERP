// server/lib/fleetAccounting.js
// ─────────────────────────────────────────────────────────────────────────────
// The dual-accounting rule engine: company-owned fleet vs attached fleet.
//
// THE BUSINESS FACT THIS ENCODES. When Prasad Transport moves a load on its own
// truck, the freight is Prasad's revenue and the diesel is Prasad's expense.
// When it moves a load on somebody else's truck, the freight is NOT Prasad's
// revenue — it belongs to the vehicle owner and is merely passing through.
// Prasad earns only the commission. Booking the gross freight as turnover in
// that case would inflate revenue by the whole value of other people's
// business, and booking the owner's diesel as a company expense would inflate
// costs to match: two large errors that happen to net off at the profit line,
// so nothing looks wrong until somebody reads the P&L or files a return.
//
// HOW THE RULE IS ENFORCED. Not by filtering the P&L — a filter is a thing you
// can forget, and every new report would have to remember it. Instead the
// entries never reach a P&L expense group at all: an attached vehicle's costs
// are debited to the OWNER'S LEDGER, which is a balance-sheet creditor. The
// company P&L is then correct because there is nothing to exclude.
//
// assertAttachedCostIsolation() below is the backstop for that: TARA calls it
// on every journal, so a future caller that tries to debit an attached
// vehicle's diesel to 'Direct Expenses - Fuel & HSD' is refused at the only
// door into ledger_entries, rather than quietly corrupting the books.
// ─────────────────────────────────────────────────────────────────────────────

/** Groups that ARE the company's own profit and loss. Debiting one of these
 *  for an attached vehicle is the exact mistake this module exists to stop. */
const PNL_EXPENSE_SQL = `
  SELECT group_head FROM account_groups
   WHERE statement = 'PROFIT_AND_LOSS' AND account_type = 'EXPENSE'`;

export class FleetAccountingError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'FleetAccountingError';
  }
}

/** Read everything the engine needs about one vehicle, in one query. */
export async function getVehicleAccounting(q, vehicleId) {
  const { rows } = await q(
    `SELECT v.id, v.vehicle_no, v.is_company_owned, v.vehicle_owner_ledger_id,
            v.commission_pct, v.commission_flat, v.company_id, v.branch_id,
            l.ledger_name AS owner_ledger_name, l.group_head AS owner_group
       FROM vehicles v
       LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
      WHERE v.id = $1::uuid`, [vehicleId]);
  const v = rows[0];
  if (!v) throw new FleetAccountingError(`vehicle ${vehicleId} not found`, 'VEHICLE_NOT_FOUND');

  // The DB CHECK already forbids this combination, so reaching it means the
  // constraint was dropped or bypassed — fail loudly rather than post into a
  // void.
  if (!v.is_company_owned && !v.vehicle_owner_ledger_id) {
    throw new FleetAccountingError(
      `${v.vehicle_no} is an attached vehicle with no owner ledger — every rupee it earns needs a khata to land in`,
      'ATTACHED_WITHOUT_OWNER');
  }
  return v;
}

/** Commission the company keeps on an attached load.
 *
 *  Percentage and flat are mutually exclusive by CHECK constraint. Neither set
 *  means zero, which is a legitimate arrangement (a family vehicle run at
 *  cost) — but it is returned explicitly so a caller can tell "no commission
 *  agreed" from "commission of nil". */
export function computeCommission(vehicle, grossFreight) {
  const gross = Number(grossFreight);
  if (!Number.isFinite(gross) || gross < 0) {
    throw new FleetAccountingError('gross freight must be a non-negative number', 'BAD_FREIGHT');
  }
  if (vehicle.commission_flat != null) {
    const flat = Number(vehicle.commission_flat);
    // A flat commission larger than the freight would push the owner's khata
    // negative on a load they were supposed to earn from.
    if (flat > gross) {
      throw new FleetAccountingError(
        `flat commission ₹${flat} exceeds gross freight ₹${gross} on ${vehicle.vehicle_no}`,
        'COMMISSION_EXCEEDS_FREIGHT');
    }
    return { amount: round2(flat), basis: 'FLAT', rate: flat };
  }
  if (vehicle.commission_pct != null) {
    const pct = Number(vehicle.commission_pct);
    return { amount: round2((gross * pct) / 100), basis: 'PCT', rate: pct };
  }
  return { amount: 0, basis: 'NONE', rate: 0 };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Build the journal legs for one trip.
 *
 * `costs` are amounts the COMPANY paid out on this trip (diesel, toll, cash
 * advance, maintenance, shortage). Who they are debited to is the entire
 * difference between the two branches below.
 */
export function buildTripLegs({ vehicle, customerLedger, grossFreight, costs = {}, cashLedger }) {
  const gross = round2(grossFreight);
  if (gross <= 0) throw new FleetAccountingError('gross freight must be > 0', 'BAD_FREIGHT');
  if (!customerLedger) throw new FleetAccountingError('customer ledger required', 'NO_CUSTOMER');

  const costLines = Object.entries(costs)
    .map(([k, val]) => ({ kind: k, amount: round2(val ?? 0) }))
    .filter((c) => c.amount > 0);
  const costTotal = round2(costLines.reduce((n, c) => n + c.amount, 0));
  if (costTotal > 0 && !cashLedger) {
    throw new FleetAccountingError('a cash/bank ledger is required to post trip costs', 'NO_CASH_LEDGER');
  }

  const lines = [];

  if (vehicle.is_company_owned) {
    // ── COMPANY FLEET ──────────────────────────────────────────────────────
    // The freight is ours and so are the costs.
    lines.push({ ledger: customerLedger, dr_cr: 'DR', amount: gross, group: 'Sundry Debtors (Customers)' });
    lines.push({ ledger: 'Freight Income', dr_cr: 'CR', amount: gross, group: 'Freight Income' });

    for (const c of costLines) {
      lines.push({ ledger: EXPENSE_LEDGER[c.kind] ?? 'Trip Expenses', dr_cr: 'DR', amount: c.amount,
                   group: EXPENSE_GROUP[c.kind] ?? 'Direct Expenses - Driver & Trip' });
      lines.push({ ledger: cashLedger, dr_cr: 'CR', amount: c.amount, group: null });
    }
    return { mode: 'OWNED', commission: null, lines };
  }

  // ── ATTACHED FLEET ───────────────────────────────────────────────────────
  const owner = vehicle.owner_ledger_name;
  if (!owner) throw new FleetAccountingError('attached vehicle has no owner ledger', 'ATTACHED_WITHOUT_OWNER');
  const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';

  // 1. Gross freight belongs to the owner, not to us. The customer still owes
  //    US — we billed them — so the debit is unchanged; only the credit moves
  //    from our income to the owner's khata.
  lines.push({ ledger: customerLedger, dr_cr: 'DR', amount: gross, group: 'Sundry Debtors (Customers)' });
  lines.push({ ledger: owner, dr_cr: 'CR', amount: gross, group: OWNER_GROUP });

  // 2. Our commission, taken out of the owner's khata. THIS is the company's
  //    revenue on an attached load — and the only part of it that is.
  const commission = computeCommission(vehicle, gross);
  if (commission.amount > 0) {
    lines.push({ ledger: owner, dr_cr: 'DR', amount: commission.amount, group: OWNER_GROUP });
    lines.push({ ledger: 'Commission Income', dr_cr: 'CR', amount: commission.amount, group: 'Commission Income' });
  }

  // 3. Costs we paid on the owner's behalf are recoverable from the owner, so
  //    they reduce the khata — they are NOT company expenses. This is the
  //    STRICT rule: no P&L expense group appears anywhere in this branch.
  for (const c of costLines) {
    lines.push({ ledger: owner, dr_cr: 'DR', amount: c.amount, group: OWNER_GROUP });
    lines.push({ ledger: cashLedger, dr_cr: 'CR', amount: c.amount, group: null });
  }

  return { mode: 'ATTACHED', commission, lines };
}

const EXPENSE_LEDGER = {
  fuel: 'Diesel / Fuel Expense',
  toll: 'Toll & Fastag Expense',
  maintenance: 'Vehicle Repairs & Maintenance',
  driver_advance: 'Driver & Trip Expense',
  shortage: 'Shortage & Penalty',
};
const EXPENSE_GROUP = {
  fuel: 'Direct Expenses - Fuel & HSD',
  toll: 'Direct Expenses - Toll & FASTag',
  maintenance: 'Direct Expenses - Repairs & Tyres',
  driver_advance: 'Direct Expenses - Driver & Trip',
  shortage: 'Shortage & Penalty',
};

/**
 * THE BACKSTOP. Refuse any journal that debits a company P&L expense group for
 * an attached vehicle.
 *
 * Called by TARA on every journal that carries a vehicle_id, so it holds for
 * code that does not use buildTripLegs() at all — an ad-hoc voucher typed into
 * Voucher Entry, a future importer, a script. The rule lives at the door into
 * ledger_entries because that is the only place it cannot be routed around.
 */
export async function assertAttachedCostIsolation(q, vehicleId, lines) {
  if (!vehicleId) return;                       // office overhead, not a trip
  const { rows } = await q(
    `SELECT is_company_owned, vehicle_no FROM vehicles WHERE id = $1::uuid`, [vehicleId]);
  const v = rows[0];
  if (!v || v.is_company_owned) return;         // company fleet: normal rules

  const { rows: pnl } = await q(PNL_EXPENSE_SQL);
  const banned = new Set(pnl.map((r) => r.group_head));

  // Check the group each line actually resolves to, not the one the caller
  // claimed: an existing ledger keeps its own group_head, so a caller passing
  // group:null or a wrong group must not slip past.
  const names = lines.filter((l) => l.dr_cr === 'DR').map((l) => l.ledger);
  if (!names.length) return;
  const { rows: resolved } = await q(
    `SELECT ledger_name, group_head FROM ledgers WHERE ledger_name = ANY($1::text[])`, [names]);
  const groupOf = new Map(resolved.map((r) => [r.ledger_name, r.group_head]));

  for (const l of lines) {
    if (l.dr_cr !== 'DR') continue;
    const group = groupOf.get(l.ledger) ?? l.group;
    if (group && banned.has(group)) {
      throw new FleetAccountingError(
        `${v.vehicle_no} is an attached vehicle: its costs belong to the owner's khata, `
        + `not to company P&L. Refusing to debit '${l.ledger}' (${group}).`,
        'ATTACHED_COST_IN_PNL');
    }
  }
}
