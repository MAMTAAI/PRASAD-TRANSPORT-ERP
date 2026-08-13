// server/agents/bhairavi.js
// AGENT 05 — BHAIRAVI · Compliance Guard & Risk Shield
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';

/**
 * Bhairavi is the only agent that can be fully ACTIVE today, because every
 * table it needs (`vehicles`, `drivers`, `vehicle_assignments`) exists in
 * migration 001. It is therefore the reference implementation for a real guard.
 *
 * The rules are not arbitrary. Dispatching a petroleum tanker on an expired
 * licence or hazardous-goods certificate is an RTO offence that voids the
 * insurance on the load, and an overloaded tanker is both illegal and a safety
 * risk. These halts must be structural, not advisory — which is why Kali asks
 * for clearance and refuses to move without it, rather than checking itself.
 */
export default defineAgent({
  id: 'AGENT_05',
  codename: 'BHAIRAVI',
  title: 'Compliance Guard & Risk Shield',
  domain: 'compliance',
  mandate:
    'Holds veto power over dispatch. Bhairavi verifies driver licence and hazardous-goods ' +
    'validity, vehicle document currency (insurance, fitness, permit, PUC, tax), and load ' +
    'weight against tanker capacity before any trip may leave PENDING. A denial from ' +
    'Bhairavi cannot be overridden by any other agent, including the orchestrator.',

  subscribes: [
    'compliance.clearance.requested',
    'vehicle.document.updated',
    'driver.document.updated',
    'compliance.sweep.requested',
  ],
  emits: [
    'compliance.clearance.granted',
    'compliance.clearance.denied',
    'compliance.expiry.warning',
    'compliance.violation.recorded',
  ],

  owns: {
    tables: ['compliance_checks', 'compliance_violations'],
    modules: ['VehicleDocs.tsx'],
  },
  reads: ['vehicles', 'drivers', 'vehicle_assignments', 'trips', 'toll_transactions'],

  mustNot: [
    'grant clearance on incomplete data — a missing expiry date is a denial, never an assumption of validity',
    'modify a vehicle or driver record to make it compliant; it reports, the master-data owner fixes',
    'be overridden by KAMALA or KALI',
  ],

  guards: [
    { name: 'driver_licence_valid',
      description: 'Licence must exist and expire strictly after the loading date.' },
    { name: 'hazmat_certificate_valid',
      description: 'Petroleum/ATF loads require a non-expired hazardous-goods endorsement.' },
    { name: 'vehicle_documents_current',
      description: 'Insurance, fitness, permit, PUC and tax must all be unexpired on the loading date.' },
    { name: 'overload_prevention',
      description: 'Load quantity must not exceed the tanker capacity_kl on record.' },
    { name: 'driver_actually_assigned',
      description: 'The driver must hold a live vehicle_assignments row for that vehicle.' },
  ],

  requires: ['vehicles', 'drivers', 'vehicle_assignments'],

  async handle(event, ctx) {
    if (event.event_type !== 'compliance.clearance.requested') {
      if (event.event_type === 'compliance.sweep.requested') return runSweep(ctx, event);
      return skipped(`no compliance rule for ${event.event_type}`);
    }

    const { vehicle_id, driver_id, load } = event.payload ?? {};
    if (!vehicle_id || !driver_id) return failed('clearance request missing vehicle_id or driver_id');

    // One round trip for every rule. Doing this as five separate queries would
    // let the fleet change between checks and produce a clearance for a state
    // that never existed at one instant.
    const row = await queryOne(
      `SELECT v.vehicle_no, v.capacity_kl, v.status AS vehicle_status,
              v.insurance_expiry, v.fitness_expiry, v.permit_expiry,
              v.puc_expiry, v.tax_expiry,
              d.name AS driver_name, d.status AS driver_status,
              d.license_no, d.license_expiry, d.hzd_cert_no, d.hzd_expiry,
              d.approval_status,
              a.id AS assignment_id
         FROM vehicles v
         CROSS JOIN drivers d
         LEFT JOIN vehicle_assignments a
                ON a.vehicle_id = v.id AND a.driver_id = d.id AND a.state = 'ACTIVE'
        WHERE v.id = $1 AND d.id = $2`,
      [vehicle_id, driver_id]
    );
    if (!row) return failed(`vehicle ${vehicle_id} or driver ${driver_id} not found`);

    // Compliance is judged against the loading date, not today — a trip booked
    // for next week must be legal *then*.
    const asOf = load?.loading_date ?? new Date().toISOString().slice(0, 10);
    const isPetroleum = /HSD|MS |ATF|PETROL|DIESEL|SKO|NAPHTHA/i.test(
      `${load?.product_type ?? ''} ${load?.item_type ?? ''}`
    );

    const denials = [];
    const expired = (date) => date && date < asOf;

    if (row.vehicle_status !== 'ACTIVE') denials.push(`vehicle is ${row.vehicle_status}`);
    if (row.driver_status !== 'ACTIVE') denials.push(`driver is ${row.driver_status}`);
    if (row.approval_status !== 'APPROVED') denials.push(`driver approval is ${row.approval_status}`);
    if (!row.assignment_id) denials.push(`driver ${row.driver_name} is not assigned to ${row.vehicle_no}`);

    // A missing expiry is a denial, not a pass. Unverifiable is not compliant.
    if (!row.license_expiry) denials.push('driver licence expiry not on record');
    else if (expired(row.license_expiry)) denials.push(`licence expired ${row.license_expiry}`);

    if (isPetroleum) {
      if (!row.hzd_cert_no || !row.hzd_expiry) denials.push('hazardous-goods certificate not on record for a petroleum load');
      else if (expired(row.hzd_expiry)) denials.push(`hazmat certificate expired ${row.hzd_expiry}`);
    }

    for (const [label, date] of [
      ['insurance', row.insurance_expiry], ['fitness', row.fitness_expiry],
      ['permit', row.permit_expiry], ['PUC', row.puc_expiry], ['road tax', row.tax_expiry],
    ]) {
      if (!date) denials.push(`${label} expiry not on record`);
      else if (expired(date)) denials.push(`${label} expired ${date}`);
    }

    const qty = Number(load?.loaded_qty ?? 0);
    const cap = Number(row.capacity_kl ?? 0);
    if (qty && cap && qty > cap) denials.push(`overload: ${qty} KL exceeds capacity ${cap} KL`);

    if (denials.length) {
      await ctx.emit('compliance.clearance.denied', {
        aggregate: 'trip', aggregateId: event.aggregate_id,
        payload: { vehicle_no: row.vehicle_no, driver_name: row.driver_name, reason: denials.join('; '), denials },
        correlationId: event.correlation_id,
      });
      return blocked(denials.join('; '));
    }

    await ctx.emit('compliance.clearance.granted', {
      aggregate: 'trip', aggregateId: event.aggregate_id,
      payload: { vehicle_no: row.vehicle_no, driver_name: row.driver_name, as_of: asOf, hazmat_checked: isPetroleum },
      correlationId: event.correlation_id,
    });
    return ok(`cleared ${row.vehicle_no} / ${row.driver_name}`);
  },
});

/** Proactive sweep: warn before something expires, rather than at the gate. */
async function runSweep(ctx, event) {
  const days = Number(event.payload?.days ?? 30);
  const row = await queryOne(
    `SELECT
       (SELECT count(*) FROM vehicles
         WHERE status = 'ACTIVE'
           AND LEAST(insurance_expiry, fitness_expiry, permit_expiry, puc_expiry)
               <= CURRENT_DATE + make_interval(days => $1)) AS vehicles_due,
       (SELECT count(*) FROM drivers
         WHERE status = 'ACTIVE'
           AND LEAST(license_expiry, hzd_expiry)
               <= CURRENT_DATE + make_interval(days => $1)) AS drivers_due`,
    [days]
  );
  const total = Number(row?.vehicles_due ?? 0) + Number(row?.drivers_due ?? 0);
  if (total > 0) {
    await ctx.emit('compliance.expiry.warning', {
      aggregate: 'fleet',
      payload: { window_days: days, ...row },
      correlationId: event.correlation_id,
    });
  }
  return ok(`sweep: ${row?.vehicles_due ?? 0} vehicles, ${row?.drivers_due ?? 0} drivers due within ${days}d`);
}
