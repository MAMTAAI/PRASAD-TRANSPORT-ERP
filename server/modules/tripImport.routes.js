// server/modules/tripImport.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Bulk trip entry, and the freight posting that follows it.
//
// WHY IT REFUSES TO WRITE BY DEFAULT. This creates trips, and trips are what
// every downstream figure is derived from — freight income, owner payables, the
// P&L. A spreadsheet with a shifted column would post hundreds of wrong loads,
// and ledger_entries is append-only, so unwinding that means a reversing entry
// per voucher. The importer therefore VALIDATES by default and writes only when
// the caller passes commit:true, mirroring the IOCL pipeline's dry-run-first
// rule for exactly the same reason.
//
// WHY UNKNOWN VEHICLES ARE REJECTED, NOT CREATED. Auto-creating a master from
// an import is how a fleet ends up with "AS 26C 5104", "AS26C5104" and
// "AS-26C-5104" as three trucks, each holding part of the history. A row whose
// vehicle is not already in the master is returned as an error for a human to
// resolve — the fleet is 49 trucks, not a moving target.
//
// IDEMPOTENCY. The natural key is vehicle + loading date + LR/challan number.
// Re-uploading the same file reports every row as DUPLICATE and writes nothing,
// so a half-finished import can simply be run again.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { getVehicleAccounting, buildTripLegs, FleetAccountingError } from '../lib/fleetAccounting.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Accept the date shapes the office actually types: 2026-04-01, 01-04-2026,
 *  01/04/2026, 01.04.2026. Ambiguity is resolved as DAY-first, because that is
 *  what every bill and every person in this office uses. */
function toIsoDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (ISO.test(s)) return s;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = `20${y}`;
  const dd = Number(d), mm = Number(mo);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const num = (v) => {
  if (v == null || v === '') return null;
  // Strip rupee signs, commas and stray spaces — pump and customer sheets carry
  // all three.
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function registerTripImportRoutes(app) {
  // ── POST /trips/bulk-entry ────────────────────────────────────────────────
  app.post('/trips/bulk-entry', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const body = req.body ?? {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) {
      return reply.code(400).send({ error: 'NO_ROWS', detail: 'send { rows: [...] }' });
    }
    if (rows.length > 5000) {
      return reply.code(413).send({ error: 'TOO_MANY_ROWS', detail: 'split the file — 5000 rows per call' });
    }
    const commit = body.commit === true;

    // Resolve the masters ONCE rather than per row: 800 rows would otherwise be
    // 2400 lookups of a table with 49 entries.
    const [veh, cos, drv, cust] = await Promise.all([
      query('SELECT id, vehicle_no, vehicle_no_norm, is_company_owned FROM vehicles'),
      query('SELECT id, btrim(company_name) AS name FROM companies'),
      query('SELECT id, name FROM drivers'),
      query('SELECT id, customer_name FROM customers'),
    ]);
    const byNorm = new Map(veh.rows.map((v) => [v.vehicle_no_norm, v]));
    const normReg = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normName = (s) => String(s ?? '').toLowerCase().replace(/^\s*m\/?s\.?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const coByName = new Map(cos.rows.map((c) => [normName(c.name), c]));

    // ── COMPANY ALIASES ─────────────────────────────────────────────────────
    // Sheets from the office write "Jaiswal Capital" on loads that are booked in
    // M/S JAISWAL ENTERPRISE. Jaiswal Capital Pvt Ltd is a SEPARATE trading
    // business with its own books and is deliberately not an entity here (God,
    // twice) — but rejecting the spelling would stall the import on rows that
    // are perfectly valid, so the name is resolved to Enterprise on the way in.
    //
    // This is an INPUT alias only. No Jaiswal Capital company is created, and
    // nothing anywhere offers it as a choice; the trip lands, correctly, in
    // Jaiswal Enterprise.
    const ALIASES = {
      'jaiswal capital': 'jaiswal enterprise',
      'jaiswal capital pvt ltd': 'jaiswal enterprise',
      'jaiswal': 'jaiswal enterprise',
      'prasad': 'prasad transport',
      'gautam': 'gautam prasad',
    };
    const resolveCompany = (raw) => {
      const k = normName(raw);
      if (!k) return null;
      return coByName.get(k) ?? coByName.get(ALIASES[k] ?? '') ?? null;
    };
    const drvByName = new Map(drv.rows.map((d) => [normName(d.name), d]));
    const custByName = new Map(cust.rows.map((c) => [normName(c.customer_name), c]));

    const results = [];
    const toInsert = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const line = i + 1;
      const err = (code, detail) => results.push({ line, status: 'ERROR', code, detail, lr_no: r.lr_no ?? null });

      const date = toIsoDate(r.date ?? r.loading_date);
      if (!date) { err('BAD_DATE', `unreadable date: ${JSON.stringify(r.date ?? r.loading_date ?? null)}`); continue; }

      const vNorm = normReg(r.vehicle_no);
      if (!vNorm) { err('MISSING_VEHICLE', 'vehicle no is blank'); continue; }
      const vehicle = byNorm.get(vNorm);
      if (!vehicle) {
        err('UNKNOWN_VEHICLE', `${r.vehicle_no} is not in the vehicle master — add it there first`);
        continue;
      }

      // The billing entity. Only the three transport companies exist in these
      // books; anything else is refused rather than silently defaulted, because
      // a trip in the wrong entity is a rupee in the wrong set of books.
      const rawCo = r.company ?? r.billed_company ?? r.operating_company;
      const coKey = normName(rawCo);
      const company = resolveCompany(rawCo);
      if (coKey && !company) {
        err('UNKNOWN_COMPANY', `"${r.company ?? r.billed_company}" is not one of: ${cos.rows.map((c) => c.name).join(', ')}`);
        continue;
      }

      const gross = num(r.gross_freight ?? r.freight);
      const rate = num(r.rate ?? r.freight_rate);
      const qty = num(r.qty ?? r.weight ?? r.quantity);
      if (gross != null && gross < 0) { err('BAD_FREIGHT', 'gross freight is negative'); continue; }

      const lr = String(r.lr_no ?? r.challan_no ?? '').trim() || null;
      const driver = drvByName.get(normName(r.driver_name));
      const customer = custByName.get(normName(r.customer ?? r.customer_name));

      toInsert.push({
        line, date, vehicle, company, lr, gross, rate, qty, driver, customer,
        from: String(r.from ?? r.loading_point ?? r.route_from ?? '').trim() || null,
        to: String(r.to ?? r.unloading_location ?? r.route_to ?? '').trim() || null,
        advance: num(r.advance ?? r.advance_paid) ?? 0,
        driver_name: String(r.driver_name ?? '').trim() || null,
        product: String(r.product ?? r.product_type ?? '').trim() || null,
      });
    }

    // ── duplicate check against what is already in the books ────────────────
    for (const t of toInsert) {
      const { rows: dup } = await query(
        `SELECT id, trip_code FROM trips
          WHERE vehicle_id = $1::uuid AND loading_date = $2::date
            AND ($3::text IS NULL OR challan_no = $3::text)
          LIMIT 1`, [t.vehicle.id, t.date, t.lr]);
      if (dup.length) {
        results.push({ line: t.line, status: 'DUPLICATE', lr_no: t.lr,
                       detail: `already recorded as ${dup[0].trip_code ?? dup[0].id}` });
        t.skip = true;
      }
    }

    const insertable = toInsert.filter((t) => !t.skip);

    if (!commit) {
      return {
        ok: true,
        dry_run: true,
        detail: 'Nothing was written. Re-send with commit:true to import.',
        summary: {
          received: rows.length,
          importable: insertable.length,
          duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
          errors: results.filter((r) => r.status === 'ERROR').length,
        },
        errors: results.filter((r) => r.status === 'ERROR'),
        duplicates: results.filter((r) => r.status === 'DUPLICATE'),
        preview: insertable.slice(0, 20).map((t) => ({
          line: t.line, date: t.date, vehicle: t.vehicle.vehicle_no,
          company: t.company?.name ?? null, lr: t.lr, gross: t.gross,
          fleet: t.vehicle.is_company_owned ? 'OWNED' : 'ATTACHED',
        })),
      };
    }

    // ── write ───────────────────────────────────────────────────────────────
    let created = 0;
    for (const t of insertable) {
      try {
        const { rows: ins } = await query(
          `INSERT INTO trips
             (trip_code, vehicle_id, vehicle_no, driver_id, driver_name,
              customer_id, customer_name, company_id, operating_company,
              loading_date, loading_point, unloading_location, product_type,
              loaded_qty, rate, freight_amount, office_cash_paid, challan_no, status)
           VALUES ($1,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7,$8::uuid,$9,
                   $10::date,$11,$12,$13,$14,$15,$16,$17,$18,'IN_TRANSIT')
           RETURNING id, trip_code`,
          [t.lr, t.vehicle.id, t.vehicle.vehicle_no, t.driver?.id ?? null, t.driver_name,
           t.customer?.id ?? null, t.customer?.customer_name ?? null,
           t.company?.id ?? null, t.company?.name ?? null,
           t.date, t.from, t.to, t.product,
           t.qty, t.rate, t.gross, t.advance, t.lr]);
        created++;
        results.push({ line: t.line, status: 'CREATED', trip_id: ins[0].id, lr_no: t.lr });
      } catch (e) {
        results.push({ line: t.line, status: 'ERROR', code: e.code ?? 'INSERT_FAILED', detail: e.message, lr_no: t.lr });
      }
    }

    return {
      ok: true,
      dry_run: false,
      summary: {
        received: rows.length,
        created,
        duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
        errors: results.filter((r) => r.status === 'ERROR').length,
      },
      results,
    };
  });

  // ── POST /trips/:id/post-freight ──────────────────────────────────────────
  // Books the freight for one trip, choosing the entry shape from the vehicle:
  // company-owned freight is OUR revenue; an attached truck's freight belongs to
  // its owner and only the commission is ours. buildTripLegs decides; TARA
  // refuses anything that would put an attached truck's costs in company P&L.
  app.post('/trips/:id/post-freight', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const { rows } = await query(
      `SELECT t.*, c.customer_name FROM trips t
         LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.id = $1::uuid`, [req.params.id]);
    const trip = rows[0];
    if (!trip) return reply.code(404).send({ error: 'TRIP_NOT_FOUND' });
    if (!trip.vehicle_id) return reply.code(422).send({ error: 'TRIP_HAS_NO_VEHICLE' });

    const customerLedger = b.customer_ledger || trip.customer_name;
    if (!customerLedger) {
      return reply.code(422).send({
        error: 'NO_CUSTOMER',
        detail: 'this trip has no customer, so there is nobody to debit the freight to',
      });
    }
    const gross = Number(b.gross_freight ?? trip.billed_amount ?? trip.freight_amount ?? 0);
    if (!(gross > 0)) {
      return reply.code(422).send({ error: 'NO_FREIGHT', detail: 'trip has no freight amount to post' });
    }

    try {
      const vehicle = await getVehicleAccounting((sql, p) => query(sql, p), trip.vehicle_id);
      const built = buildTripLegs({
        vehicle,
        customerLedger,
        grossFreight: gross,
        cashLedger: b.paid_from ?? null,
        costs: b.costs ?? {},
      });

      const voucher = await postVoucher({
        type: 'JOURNAL',
        source_type: 'TRIP_FREIGHT',
        ref_no: `TRIP-${trip.trip_code ?? trip.id}`,
        entry_date: b.entry_date ?? (trip.loading_date ? String(trip.loading_date).slice(0, 10) : undefined),
        narration: b.narration ?? `Freight — ${trip.vehicle_no} ${trip.trip_code ?? ''}`.trim(),
        vehicle_id: trip.vehicle_id,
        company_id: trip.company_id,
        branch_id: trip.branch_id,
        created_by: b.created_by ?? null,
        dry_run: b.dry_run !== false,     // safe by default, same as the importer
        lines: built.lines.map((l) => ({ ...l, vehicle_id: trip.vehicle_id })),
      });

      return {
        ok: true,
        dry_run: b.dry_run !== false,
        mode: built.mode,
        commission: built.commission,
        lines: built.lines,
        voucher_id: voucher?.voucher_id ?? null,
      };
    } catch (e) {
      if (e instanceof FleetAccountingError) return reply.code(422).send({ error: e.code, detail: e.message });
      if (e.code === 'DUPLICATE_REF') return reply.code(409).send({ error: 'DUPLICATE_REF', detail: e.message });
      if (e.code === 'ATTACHED_COST_IN_PNL') return reply.code(422).send({ error: e.code, detail: e.message });
      throw e;
    }
  });

  // ── GET /trips/ready-for-invoice ──────────────────────────────────────────
  // Completed loads with freight agreed and no invoice raised. This is the
  // queue the billing desk works from, and the same rows the dashboard counts
  // as unbilled — one definition, so the number and the list agree.
  app.get('/trips/ready-for-invoice', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const companyId = req.query?.company_id || null;
    const { rows } = await query(
      `SELECT t.id, t.trip_code, t.challan_no, t.vehicle_no, t.loading_date,
              t.unloading_date, t.loading_point,
              COALESCE(t.unloading_location, t.consignee_name) AS destination,
              t.customer_name, btrim(c.company_name) AS company,
              COALESCE(NULLIF(t.freight_amount,0), 0)::numeric(14,2) AS freight,
              t.loaded_qty, t.unloaded_qty, t.shortage_qty,
              -- COALESCE because the join below is now LEFT: a trip whose vehicle
              -- row never resolved has no ownership flag, and defaulting it to
              -- "not attached" is the conservative answer -- it withholds a
              -- commission payout to an owner we cannot actually identify,
              -- rather than inventing one.
              COALESCE(NOT v.is_company_owned, false) AS is_attached
         FROM trips t
         -- LEFT, not INNER. This query builds the BILLING CANDIDATE list, and an
         -- inner join meant a completed unbilled trip whose vehicle_id was never
         -- resolved could never be billed at all -- it was absent from the list
         -- rather than flagged on it. Silently unbillable revenue is the worst
         -- shape this bug can take.
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         LEFT JOIN companies c ON c.id = t.company_id
        WHERE COALESCE(t.billed_amount,0) = 0
          AND t.status = 'COMPLETED'
          AND ($1::uuid IS NULL OR t.company_id = $1::uuid)
        ORDER BY t.loading_date ASC NULLS LAST
        LIMIT 500`, [companyId]);

    const withRate = rows.filter((r) => Number(r.freight) > 0);
    return {
      count: rows.length,
      // Split deliberately: a load with no agreed rate cannot be invoiced at
      // all, and lumping it in makes the queue look actionable when part of it
      // is blocked on a rate nobody has set.
      ready: withRate,
      blocked_no_rate: rows.filter((r) => !(Number(r.freight) > 0)),
      ready_value: withRate.reduce((n, r) => n + Number(r.freight), 0),
    };
  });
}
