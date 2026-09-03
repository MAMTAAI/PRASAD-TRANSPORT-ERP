// ═════════════════════════════════════════════════════════════════════════════
// driverLedger.js — one driver's Trip Allowance & Balance, computed once,
// served to both screens (owner, 2026-09-03: "instantly syncs to the Driver's
// App Live Ledger"). The driver app reads it under /portal/driver/ledger; the
// Driver Control drawer reads the same function, so the office and the phone
// can never disagree about a balance.
//
// Targets are the trip's own fixed_hsd / fixed_cash. Issued is trips.hsd_issued;
// paid is the three cash columns the settlement already sums. A balance below
// zero is reported as such — the screens paint it red; nothing here clamps it.
// A trip with no target reports null, so no screen invents a number.
// ═════════════════════════════════════════════════════════════════════════════
import { query } from '../db/pool.js';

const num = (v) => (v == null ? null : Number(v));

export async function driverLedger(driverId, { limitTrips = 5 } = {}) {
  const { rows: trips } = await query(
    `SELECT id, trip_code, status, vehicle_no, loading_point,
            COALESCE(unloading_location, consignee_name) AS destination,
            loading_date, rtkm,
            fixed_hsd, hsd_issued, fixed_cash,
            pump_cash_advance, office_cash_paid, bank_paid
       FROM trips
      WHERE driver_id = $1::uuid
        AND status NOT IN ('COMPLETED','SETTLED','CANCELLED')
      ORDER BY loading_date DESC NULLS LAST, created_at DESC LIMIT $2`, [driverId, limitTrips]);
  const ids = trips.map((t) => t.id);
  const { rows: hsd } = ids.length ? await query(
    `SELECT id, trip_id, litres, rate, amount, pump_name, slip_no, issued_by, issued_at
       FROM trip_hsd_issues WHERE trip_id = ANY($1::uuid[])
      ORDER BY issued_at DESC LIMIT 100`, [ids]) : { rows: [] };
  const { rows: cash } = ids.length ? await query(
    `SELECT id, trip_id, txn_date, txn_type, amount, mode, remarks, created_at
       FROM driver_transactions
      WHERE trip_id = ANY($1::uuid[]) AND txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN','FUEL_EXPENSE')
      ORDER BY txn_date DESC, created_at DESC LIMIT 100`, [ids]) : { rows: [] };
  const out = trips.map((t) => {
    const hsdTarget = num(t.fixed_hsd), hsdIssued = num(t.hsd_issued) ?? 0;
    const cashTarget = num(t.fixed_cash);
    const cashPaid = (num(t.pump_cash_advance) ?? 0) + (num(t.office_cash_paid) ?? 0) + (num(t.bank_paid) ?? 0);
    return {
      trip_id: t.id, trip_code: t.trip_code, status: t.status, vehicle_no: t.vehicle_no,
      loading_point: t.loading_point, destination: t.destination, loading_date: t.loading_date, rtkm: num(t.rtkm),
      hsd: {
        target_l: hsdTarget, issued_l: +hsdIssued.toFixed(3),
        balance_l: hsdTarget == null ? null : +(hsdTarget - hsdIssued).toFixed(3),
        over: hsdTarget != null && hsdIssued > hsdTarget,
      },
      cash: {
        target: cashTarget, paid: +cashPaid.toFixed(2),
        balance: cashTarget == null ? null : +(cashTarget - cashPaid).toFixed(2),
        over: cashTarget != null && cashPaid > cashTarget,
      },
      hsd_lines: hsd.filter((h) => h.trip_id === t.id),
      cash_lines: cash.filter((c) => c.trip_id === t.id),
    };
  });
  return { count: out.length, trips: out, as_of: new Date().toISOString() };
}
