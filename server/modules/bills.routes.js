// server/modules/bills.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/billing — customer bills (sales invoices) for the Bill Management
// screen. Replaces the Firestore COMPANY_BILLS collection; see migration 019
// for why a bill is stored rather than derived from the trips it covers.
//
//   GET   /bills                    generated bills + outstanding
//   GET   /bills/:id                header + trip lines
//   GET   /bills/unbilled-trips     billable trips, rate card, lane metadata
//   PATCH /trips/:id/freight        persist an inline qty/rate correction
//   POST  /bills                    raise a bill over selected trips
//   POST  /bills/:id/settle         receive money — through TARA, never direct
//   POST  /bills/:id/cancel         void a bill, releasing its trips
//
// Money rule: nothing in this file writes ledger_entries. Settlement calls
// tara.postVoucher and stores only the voucher id it returns, so the ledger
// stays the single source of truth for cash and this table cannot contradict it.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

// Ledger heads. These strings are the chart of accounts as it stands in the
// live data — see `ledgers` — and must not be improvised per call site.
const TDS_LEDGER = 'TDS Receivable 194C';
const SHORTAGE_LEDGER = 'Shortage & Penalty';
const debtorLedger = (customer) => `Debtors: ${customer}`;
const driverLedger = (driver) => `Driver Advance: ${driver}`;

const money = (v) => Number(v ?? 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function registerBillRoutes(app) {
  // ── Generated bills ─────────────────────────────────────────────────────────
  app.get(
    '/bills',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: ['string', 'null'], enum: ['PENDING_PAYMENT', 'PARTIALLY_PAID', 'SETTLED', 'CANCELLED', null] },
            customer: { type: ['string', 'null'], maxLength: 120 },
            company: { type: ['string', 'null'], maxLength: 120 },
            q: { type: ['string', 'null'], maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT * FROM v_company_bill_summary
          WHERE ($1::text IS NULL OR status = $1::text)
            AND ($2::text IS NULL OR customer_name = $2::text)
            AND ($3::text IS NULL OR company_matches(company, $3::text))
            AND ($4::text IS NULL OR bill_no ILIKE '%'||$4::text||'%'
                                  OR customer_name ILIKE '%'||$4::text||'%'
                                  OR location ILIKE '%'||$4::text||'%')
          ORDER BY bill_date DESC, created_at DESC
          LIMIT $5`,
        [req.query.status || null, req.query.customer || null, req.query.company || null,
         req.query.q || null, req.query.limit ?? 200]
      );
      const total = (f) => rows.reduce((a, r) => a + money(r[f]), 0).toFixed(2);
      return {
        count: rows.length,
        bills: rows,
        totals: {
          gross: total('total_gross'),
          tds: total('total_tds'),
          net: total('total_net'),
          received: total('received_amount'),
          outstanding: total('outstanding'),
        },
      };
    }
  );

  app.get(
    '/bills/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const [bill, lines, company] = await Promise.all([
        query('SELECT * FROM v_company_bill_summary WHERE id = $1::uuid', [req.params.id]),
        query(`SELECT * FROM company_bill_trips WHERE bill_id = $1::uuid
                ORDER BY vehicle_no, loading_date, id`, [req.params.id]),
        // Print header needs our own GSTIN/PAN; looked up fresh so an old bill
        // reprints with correct masters rather than whatever was saved onto it.
        query(`SELECT c.company_name, c.gstin::text AS gstin, c.pan_no::text AS pan_no, c.tds_tan,
                      c.address, c.city, c.state, c.pincode
                 FROM companies c
                 JOIN company_bills b ON company_matches(b.company, c.company_name)
                WHERE b.id = $1::uuid LIMIT 1`, [req.params.id]),
      ]);
      if (!bill.rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      const customer = await query(
        `SELECT customer_name, gst_no::text AS gst_no, address, city, state
           FROM customers WHERE customer_name = $1 LIMIT 1`, [bill.rows[0].customer_name]);
      return {
        bill: bill.rows[0],
        trips: lines.rows,
        company_master: company.rows[0] ?? null,
        customer_master: customer.rows[0] ?? null,
      };
    }
  );

  // ── Billable trips ──────────────────────────────────────────────────────────
  // Completed trips not yet on a live bill. `routes` and `lane_rates` are shaped
  // for src/lib/freightEngine.ts so the formula has exactly one implementation —
  // the one already verified against real IOCL bills — and the server never
  // invents a rate. Where no rate is known the trip comes back with rate 0 and
  // rate_source 'none', which the screen shows as an unpriced row rather than as
  // a confident zero.
  app.get(
    '/bills/unbilled-trips',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            company: { type: ['string', 'null'], maxLength: 120 },
            customer: { type: ['string', 'null'], maxLength: 120 },
            from: { type: ['string', 'null'], format: 'date' },
            to: { type: ['string', 'null'], format: 'date' },
            limit: { type: 'integer', minimum: 1, maximum: 2000, default: 1000 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const args = [req.query.company || null, req.query.customer || null,
                    req.query.from || null, req.query.to || null];

      const [trips, routes, laneRates, rateHistory] = await Promise.all([
        query(
          `SELECT t.id, t.trip_code, t.operating_company, t.status,
                  t.customer_id, t.customer_name, t.registered_assessee, t.consignee_name,
                  t.vehicle_no, t.driver_id, t.driver_name,
                  t.loading_date, t.loading_point, t.challan_no, t.product_type,
                  t.loaded_qty, t.rtkm, t.rate, t.freight_amount,
                  t.unloading_date, t.unloading_location, t.unloaded_qty,
                  t.shortage_qty, t.shortage_penalty, t.billing_status
             FROM trips t
            WHERE COALESCE(t.billing_status,'') <> 'BILLED'
              AND NOT EXISTS (SELECT 1 FROM company_bill_trips bt
                               JOIN company_bills b ON b.id = bt.bill_id
                              WHERE bt.trip_id = t.id AND b.status <> 'CANCELLED')
              AND (t.status IN ('COMPLETED','UNLOADED') OR t.unloading_date IS NOT NULL)
              AND ($1::text IS NULL OR company_matches(t.operating_company, $1::text))
              AND ($2::text IS NULL OR t.customer_name = $2::text)
              AND ($3::date IS NULL OR t.loading_date >= $3::date)
              AND ($4::date IS NULL OR t.loading_date <= $4::date)
            ORDER BY t.loading_date DESC NULLS LAST, t.vehicle_no
            LIMIT ${Number(req.query.limit ?? 1000)}`,
          args
        ),
        // Lane master, in the field names freightEngine.ts already reads.
        query(
          `SELECT id, customer_name AS "Customer_Name", registered_assessee AS "Registered_Assessee",
                  depot_link AS "Depot_Link", consignee_name AS "Consignee_Name",
                  vehicle_capacity AS "Vehicle_Capacity", item_type AS "Item_Type",
                  rtkm_distance AS "RTKM_Distance", fixed_hsd_qty, fixed_cash_amt, toll_amt
             FROM rtkm_master WHERE COALESCE(status,'ACTIVE') = 'ACTIVE'`
        ),
        // The working rate card, derived from bills we were actually paid on —
        // `loads` and `rate_changes` travel with it so the screen can show how
        // much evidence a rate rests on before anyone bills against it.
        query(
          `SELECT ship_to_code, ship_to_name, material, current_rate, current_rtd,
                  rate_as_of, loads, rate_changes, distinct_rtd, avg_rtd, last_billed
             FROM v_iocl_lane_rate ORDER BY loads DESC`
        ),
        query(
          `SELECT material, rate, effective_from, effective_to, loads, lanes, quarter
             FROM v_iocl_rate_history ORDER BY material, effective_from`
        ),
      ]);

      return {
        count: trips.rows.length,
        truncated: trips.rows.length >= Number(req.query.limit ?? 1000),
        trips: trips.rows,
        routes: routes.rows,
        lane_rates: laneRates.rows,
        rate_history: rateHistory.rows,
      };
    }
  );

  // ── Inline qty/rate correction ──────────────────────────────────────────────
  // Dispatch does not know qty and rate; the admin fills them in when the party
  // challan arrives. Only these three columns are writable here — trip status,
  // dates and route stay KALI's, and a trip already on a live bill is frozen so
  // an edit cannot silently contradict a bill already sent.
  app.patch(
    '/trips/:id/freight',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            loaded_qty: { type: ['number', 'null'], minimum: 0 },
            rate: { type: ['number', 'null'], minimum: 0 },
            rtkm: { type: ['number', 'null'], minimum: 0 },
            freight_amount: { type: ['number', 'null'], minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const locked = await query(
        `SELECT b.bill_no FROM company_bill_trips bt
           JOIN company_bills b ON b.id = bt.bill_id
          WHERE bt.trip_id = $1::uuid AND b.status <> 'CANCELLED' LIMIT 1`, [req.params.id]);
      if (locked.rows.length) {
        return reply.code(409).send({
          error: 'TRIP_BILLED',
          detail: `trip is on bill ${locked.rows[0].bill_no}; cancel that bill before changing its figures`,
        });
      }
      const b = req.body;
      const { rows } = await query(
        `UPDATE trips SET
           loaded_qty     = COALESCE($2, loaded_qty),
           rate           = COALESCE($3, rate),
           rtkm           = COALESCE($4, rtkm),
           freight_amount = COALESCE($5, freight_amount),
           updated_at     = now()
         WHERE id = $1::uuid
         RETURNING id, trip_code, loaded_qty, rate, rtkm, freight_amount`,
        [req.params.id, b.loaded_qty ?? null, b.rate ?? null, b.rtkm ?? null, b.freight_amount ?? null]);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, trip: rows[0] };
    }
  );

  // ── Raise a bill ────────────────────────────────────────────────────────────
  // The client sends the figures it displayed, so the bill records what was
  // actually billed. Cross-trip invariants are re-checked here rather than
  // trusted: one customer, one location, and every trip still free.
  app.post(
    '/bills',
    {
      schema: {
        body: {
          type: 'object',
          required: ['trips'],
          additionalProperties: false,
          properties: {
            bill_no: { type: ['string', 'null'], maxLength: 60 },
            bill_date: { type: ['string', 'null'], format: 'date' },
            company: { type: ['string', 'null'], maxLength: 120 },
            branch: { type: ['string', 'null'], maxLength: 60 },
            location: { type: ['string', 'null'], maxLength: 160 },
            created_by: { type: ['string', 'null'], maxLength: 100 },
            gst_rate_pct: { type: 'number', minimum: 0, maximum: 28, default: 5 },
            tds_rate_pct: { type: 'number', minimum: 0, maximum: 10, default: 2 },
            trips: {
              type: 'array', minItems: 1, maxItems: 500,
              items: {
                type: 'object',
                required: ['trip_id', 'qty', 'rate', 'gross_freight'],
                additionalProperties: false,
                properties: {
                  trip_id: { type: 'string', format: 'uuid' },
                  qty: { type: 'number', minimum: 0 },
                  rate: { type: 'number', minimum: 0 },
                  rtkm: { type: 'number', minimum: 0, default: 0 },
                  billing_type: { type: 'string', maxLength: 20, default: 'PER_KL' },
                  gross_freight: { type: 'number', minimum: 0 },
                  shortage_amt: { type: 'number', minimum: 0, default: 0 },
                  lr_no: { type: ['string', 'null'], maxLength: 40 },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const ids = b.trips.map((t) => t.trip_id);
      if (new Set(ids).size !== ids.length) {
        return reply.code(400).send({ error: 'DUPLICATE_TRIP', detail: 'the same trip appears twice in this bill' });
      }

      const { rows: dbTrips } = await query(
        `SELECT t.id, t.trip_code, t.vehicle_no, t.driver_name, t.customer_id, t.customer_name,
                t.consignee_name, t.unloading_location, t.loading_date, t.unloading_date,
                t.operating_company, t.challan_no,
                (SELECT b2.bill_no FROM company_bill_trips bt
                   JOIN company_bills b2 ON b2.id = bt.bill_id
                  WHERE bt.trip_id = t.id AND b2.status <> 'CANCELLED' LIMIT 1) AS existing_bill
           FROM trips t WHERE t.id = ANY($1::uuid[])`, [ids]);

      if (dbTrips.length !== ids.length) {
        const found = new Set(dbTrips.map((t) => t.id));
        return reply.code(404).send({ error: 'TRIP_NOT_FOUND', detail: `unknown trip(s): ${ids.filter((i) => !found.has(i)).join(', ')}` });
      }
      const taken = dbTrips.filter((t) => t.existing_bill);
      if (taken.length) {
        return reply.code(409).send({
          error: 'ALREADY_BILLED',
          detail: taken.map((t) => `${t.trip_code ?? t.id} is on ${t.existing_bill}`).join('; '),
        });
      }

      // One bill, one customer — but "same customer" is decided by customer_id,
      // not by spelling. The same party is written five ways in the imported
      // trips ('IOCL', 'INDIAN OIL CORPORATION LTD', 'indian oil corporation
      // ltd'), so a string compare would refuse bills that are perfectly valid.
      // Trips with no customer master are the other half of that problem and are
      // named explicitly: which party they belong to is a data question, and
      // guessing it here would put the wrong name on a document we send out.
      const unlinked = dbTrips.filter((t) => !t.customer_id);
      if (unlinked.length) {
        return reply.code(400).send({
          error: 'CUSTOMER_UNLINKED',
          detail: `these trips have no customer master, so the bill's party is unknown: ${
            unlinked.map((t) => `${t.trip_code ?? t.id}${t.customer_name ? ` ('${t.customer_name}')` : ' (blank)'}`).join(', ')
          }. Set the customer on them in Trip Management first.`,
        });
      }
      const customerIds = [...new Set(dbTrips.map((t) => t.customer_id))];
      if (customerIds.length !== 1) {
        const names = [...new Set(dbTrips.map((t) => t.customer_name))];
        return reply.code(400).send({
          error: 'MIXED_CUSTOMER',
          detail: `one bill covers one customer; these trips span ${customerIds.length}: ${names.join(', ')}`,
        });
      }
      // Bill under the customer master's own spelling, so every bill for a party
      // carries one name however the trip happened to be typed.
      const { rows: [master] } = await query(
        'SELECT customer_name FROM customers WHERE id = $1::uuid', [customerIds[0]]);
      const customers = [master?.customer_name ?? dbTrips[0].customer_name];
      // Oil companies bill per plant/depot: a mixed-location bill will not
      // reconcile against the customer's own document, so it is refused rather
      // than raised and disputed later.
      const locations = [...new Set(dbTrips.map((t) => t.unloading_location || t.consignee_name).filter(Boolean))];
      if (!b.location && locations.length > 1) {
        return reply.code(400).send({
          error: 'MIXED_LOCATION',
          detail: `oil-company bills are per location; these trips span ${locations.length}: ${locations.join(' | ')}`,
        });
      }

      const customerName = customers[0];
      const byId = new Map(dbTrips.map((t) => [t.id, t]));
      const gstPct = b.gst_rate_pct ?? 5;
      const tdsPct = b.tds_rate_pct ?? 2;

      const lines = b.trips.map((line) => {
        const t = byId.get(line.trip_id);
        const gross = r2(line.gross_freight);
        const shortage = r2(line.shortage_amt ?? 0);
        const tds = r2(gross * (tdsPct / 100));
        // Reverse charge: IOCL discharges the GST. It is carried as a memo so
        // the bill can print it, and is deliberately NOT added to total_net —
        // treating it as our output tax would overstate both revenue and dues.
        const half = r2(gross * (gstPct / 2 / 100));
        return {
          trip_id: line.trip_id,
          trip_code: t.trip_code,
          lr_no: line.lr_no ?? t.challan_no ?? null,
          vehicle_no: t.vehicle_no,
          driver_name: t.driver_name,
          loading_date: t.loading_date,
          unloading_date: t.unloading_date,
          qty: line.qty,
          rate: line.rate,
          rtkm: line.rtkm ?? 0,
          billing_type: line.billing_type ?? 'PER_KL',
          gross_freight: gross,
          shortage_amt: shortage,
          tds_amt: tds,
          cgst_amt: half,
          sgst_amt: half,
          igst_amt: 0,
          net_payable: r2(gross - shortage - tds),
        };
      });

      const sum = (f) => r2(lines.reduce((a, l) => a + l[f], 0));
      const dates = dbTrips.map((t) => t.loading_date).filter(Boolean).sort();
      const location = b.location || locations[0] || null;
      const locCode = (String(location ?? '').match(/\(([A-Z0-9]{3,6})\)\s*$/) || [])[1]
        || (String(location ?? '').match(/\b(Z?C?7[A-Z]\d{2})\b/) || [])[1] || null;

      // Bill number: deterministic sequence per customer+location, so two
      // clicks cannot mint two bills with the same number the way a random
      // suffix could. The unique index on bill_no is the backstop.
      let billNo = b.bill_no;
      if (!billNo) {
        const prefix = `INV-${customerName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}${locCode ? '-' + locCode : ''}`;
        const { rows: [seq] } = await query(
          `SELECT COALESCE(MAX(NULLIF(regexp_replace(bill_no, '^.*-', ''), '')::int), 0) + 1 AS n
             FROM company_bills WHERE bill_no LIKE $1 || '-%'
               AND bill_no ~ ('^' || $1 || '-[0-9]+$')`, [prefix]);
        billNo = `${prefix}-${String(seq.n).padStart(4, '0')}`;
      }

      try {
        const created = await withTransaction(async (t) => {
          const { rows: [bill] } = await t.query(
            `INSERT INTO company_bills
               (bill_no, bill_date, customer_id, customer_name, company, branch, location, location_code,
                period_from, period_to, total_gross, total_shortage, total_tds,
                total_cgst, total_sgst, total_igst, total_net, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'PENDING_PAYMENT',$18)
             RETURNING *`,
            [billNo, b.bill_date ?? new Date().toISOString().slice(0, 10),
             dbTrips[0].customer_id, customerName, b.company ?? dbTrips[0].operating_company,
             b.branch ?? null, location, locCode,
             dates[0] ?? null, dates[dates.length - 1] ?? null,
             sum('gross_freight'), sum('shortage_amt'), sum('tds_amt'),
             sum('cgst_amt'), sum('sgst_amt'), sum('igst_amt'), sum('net_payable'),
             b.created_by ?? null]);

          for (const l of lines) {
            await t.query(
              `INSERT INTO company_bill_trips
                 (bill_id, trip_id, trip_code, lr_no, vehicle_no, driver_name, loading_date, unloading_date,
                  qty, rate, rtkm, billing_type, gross_freight, shortage_amt, tds_amt,
                  cgst_amt, sgst_amt, igst_amt, net_payable, final_passed_amt)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
              [bill.id, l.trip_id, l.trip_code, l.lr_no, l.vehicle_no, l.driver_name,
               l.loading_date, l.unloading_date, l.qty, l.rate, l.rtkm, l.billing_type,
               l.gross_freight, l.shortage_amt, l.tds_amt, l.cgst_amt, l.sgst_amt, l.igst_amt,
               l.net_payable]);
          }

          // Billing linkage only — see migration 019 on why these two columns
          // are the one exception to KALI's ownership of `trips`.
          await t.query(
            `UPDATE trips SET billing_status = 'BILLED', linked_bill_id = $2::uuid,
                             billed_amount = c.net, updated_at = now()
               FROM (SELECT unnest($1::uuid[]) AS id, unnest($3::numeric[]) AS net) c
              WHERE trips.id = c.id`,
            [lines.map((l) => l.trip_id), bill.id, lines.map((l) => l.net_payable)]);

          return bill;
        });

        reply.code(201);
        return { created: true, bill: created, lines: lines.length };
      } catch (err) {
        if (err.code === '23505' || /unique/i.test(err.message)) {
          return reply.code(409).send({ error: 'DUPLICATE_BILL', detail: err.detail ?? err.message });
        }
        throw err;
      }
    }
  );

  // ── Settle a bill ───────────────────────────────────────────────────────────
  // Money in goes through TARA. The RECEIPT credits the debtor the full gross
  // (cash + TDS withheld) so the receivable clears; TARA derives the legs and
  // the deferred DB constraint re-checks the balance at COMMIT.
  //
  // A party deduction beyond the billed shortage is recovered from the driver by
  // a JOURNAL — Dr the driver's advance account, Cr shortage expense. Firestore
  // wrote only a DRIVER_TRANSACTIONS row here, which is why driver recoveries
  // never reached the general ledger.
  app.post(
    '/bills/:id/settle',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['account', 'trip_ids'],
          additionalProperties: false,
          properties: {
            account: { type: 'string', minLength: 2, maxLength: 120 },
            received_amount: { type: ['number', 'null'], exclusiveMinimum: 0 },
            // No schema default: Fastify would coerce "not supplied" into 0 and
            // the per-line TDS fallback below could never fire, quietly billing
            // the party the gross as cash.
            tds_deducted: { type: ['number', 'null'], minimum: 0 },
            entry_date: { type: ['string', 'null'], format: 'date' },
            ref_no: { type: ['string', 'null'], maxLength: 60 },
            remarks: { type: ['string', 'null'], maxLength: 300 },
            created_by: { type: ['string', 'null'], maxLength: 100 },
            dry_run: { type: 'boolean', default: false },
            trip_ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', format: 'uuid' } },
            // Per-trip party deductions beyond what was billed.
            adjustments: {
              type: 'array', maxItems: 500,
              items: {
                type: 'object', required: ['trip_id'], additionalProperties: false,
                properties: {
                  trip_id: { type: 'string', format: 'uuid' },
                  extra_shortage_amt: { type: 'number', minimum: 0, default: 0 },
                  recover_from_driver: { type: 'boolean', default: true },
                  final_passed_amt: { type: ['number', 'null'], minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;

      const { rows: [bill] } = await query('SELECT * FROM company_bills WHERE id = $1::uuid', [req.params.id]);
      if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (bill.status === 'CANCELLED') {
        return reply.code(409).send({ error: 'BILL_CANCELLED', detail: 'a cancelled bill cannot be settled' });
      }

      // driver_id comes from the trip, not the bill line: the subsidiary driver
      // ledger keys on it, and a name alone cannot tell two drivers apart.
      const { rows: lines } = await query(
        `SELECT bt.*, t.driver_id
           FROM company_bill_trips bt
           LEFT JOIN trips t ON t.id = bt.trip_id
          WHERE bt.bill_id = $1::uuid AND bt.trip_id = ANY($2::uuid[])`,
        [req.params.id, b.trip_ids]);
      if (lines.length !== b.trip_ids.length) {
        return reply.code(400).send({ error: 'TRIP_NOT_ON_BILL', detail: 'one or more trips are not lines of this bill' });
      }
      const settled = lines.filter((l) => l.payment_status === 'SETTLED');
      if (settled.length) {
        return reply.code(409).send({
          error: 'ALREADY_SETTLED',
          detail: `already settled: ${settled.map((l) => l.trip_code ?? l.trip_id).join(', ')}`,
        });
      }

      const adj = new Map((b.adjustments ?? []).map((a) => [a.trip_id, a]));
      const perTrip = lines.map((l) => {
        const a = adj.get(l.trip_id) ?? {};
        const extra = r2(a.extra_shortage_amt ?? 0);
        const passed = a.final_passed_amt != null ? r2(a.final_passed_amt) : r2(money(l.net_payable) - extra);
        return { line: l, extra, passed, recover: a.recover_from_driver !== false };
      });

      const cash = b.received_amount != null ? r2(b.received_amount) : r2(perTrip.reduce((s, p) => s + p.passed, 0));
      const tds = b.tds_deducted != null
        ? r2(b.tds_deducted)
        : r2(perTrip.reduce((s, p) => s + money(p.line.tds_amt), 0));
      const gross = r2(cash + tds);
      if (gross <= 0) {
        return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'received amount plus TDS must be greater than zero' });
      }

      const entryDate = b.entry_date ?? new Date().toISOString().slice(0, 10);
      // Deterministic reference so a replayed click cannot post the money twice:
      // TARA's duplicate guard recognises it.
      const ref = b.ref_no || `BILL-${bill.bill_no}-${entryDate}-${cash.toFixed(2)}`;

      // The receipt is posted before the bookkeeping updates, because cash is the
      // fact that must not be lost. That leaves a window where the money is in
      // the ledger and the bill is not yet marked — so a replay does NOT simply
      // fail on DUPLICATE_REF. It adopts the voucher already posted under this
      // reference and finishes the bookkeeping, which is what makes retrying a
      // half-completed settlement converge instead of wedging the bill.
      let voucher;
      let adopted = false;
      try {
        voucher = await postVoucher({
          type: 'RECEIPT',
          account: b.account,
          party_ledger: debtorLedger(bill.customer_name),
          party_group: 'Sundry Debtors (Customers)',
          amount: gross,
          tds: tds > 0 ? { ledger: TDS_LEDGER, amount: tds } : null,
          ref_no: ref,
          entry_date: entryDate,
          narration: `Bill ${bill.bill_no} — ${perTrip.length} trip(s) received${b.remarks ? ` | ${b.remarks}` : ''}`,
          source_type: 'BILL_SETTLEMENT',
          company: bill.company,
          branch: bill.branch,
          created_by: b.created_by ?? null,
          dry_run: b.dry_run === true,
        });
      } catch (err) {
        if (err.code === 'DUPLICATE_REF' && !b.dry_run) {
          const { rows: [prior] } = await query(
            `SELECT voucher_id FROM ledger_entries
              WHERE source_type = 'VOUCHER' AND source_ref = $1 AND voucher_id IS NOT NULL
              LIMIT 1`, [ref]);
          if (!prior) {
            return reply.code(409).send({ error: 'DUPLICATE_REF', detail: err.message });
          }
          voucher = { posted: false, voucher_id: prior.voucher_id };
          adopted = true;
        } else {
          const map = { DUPLICATE_REF: 409, OVERDRAFT: 422, BAD_TDS: 400, BAD_AMOUNT: 400, NO_ACCOUNT: 400, NO_PARTY: 400 };
          if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
          throw err;
        }
      }

      if (b.dry_run) {
        return {
          dry_run: true, would_post: true, voucher,
          gross, cash, tds,
          driver_recoveries: perTrip.filter((p) => p.extra > 0 && p.recover)
            .map((p) => ({ driver: p.line.driver_name, trip: p.line.trip_code, amount: p.extra })),
        };
      }

      // Driver recovery: one JOURNAL per driver-recoverable deduction. Posted
      // after the receipt so a failure here cannot lose the cash entry; each is
      // separately keyed, so a retry converges instead of double-charging.
      const recoveries = [];
      for (const p of perTrip) {
        if (p.extra <= 0 || !p.recover || !p.line.driver_name) continue;
        const recRef = `BILLREC-${bill.bill_no}-${p.line.trip_id}`;
        try {
          const j = await postVoucher({
            type: 'JOURNAL',
            lines: [
              { ledger: driverLedger(p.line.driver_name), dr_cr: 'DR', amount: p.extra, group: 'Current Assets - Driver Advances' },
              { ledger: SHORTAGE_LEDGER, dr_cr: 'CR', amount: p.extra, group: 'Shortage & Penalty' },
            ],
            source_type: 'DRIVER_SHORTAGE_RECOVERY',
            ref_no: recRef,
            entry_date: entryDate,
            narration: `Party deduction recovered from ${p.line.driver_name} — bill ${bill.bill_no}, trip ${p.line.trip_code ?? p.line.trip_id}`,
            company: bill.company,
            branch: bill.branch,
            created_by: b.created_by ?? null,
          });
          recoveries.push({ trip: p.line.trip_code, driver: p.line.driver_name, amount: p.extra, voucher_id: j.voucher_id });
        } catch (err) {
          if (err.code === 'DUPLICATE_REF') {
            recoveries.push({ trip: p.line.trip_code, driver: p.line.driver_name, amount: p.extra, already_posted: true });
          } else {
            throw err;
          }
        }
      }

      const result = await withTransaction(async (t) => {
        for (const p of perTrip) {
          await t.query(
            `UPDATE company_bill_trips
                SET payment_status = 'SETTLED', extra_shortage_amt = $2, recover_from_driver = $3,
                    final_passed_amt = $4, settled_voucher_id = $5, settled_at = now()
              WHERE id = $1`,
            [p.line.id, p.extra, p.recover, p.passed, voucher.voucher_id]);

          // The driver's running account, kept for the driver-facing screens —
          // the JOURNAL above is the accounting record, this is its subsidiary.
          // txn_type, mode and the legacy_id idempotency key match what the IOCL
          // reconciler already writes (tools/iocl_recon), so the two producers of
          // driver recoveries leave identical-looking rows.
          if (p.extra > 0 && p.recover && p.line.driver_name) {
            await t.query(
              `INSERT INTO driver_transactions
                 (legacy_id, driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks)
               VALUES ($1, $2, $3, $7::uuid, $4, 'SHORTAGE_RECOVERY', $5, 'Bill Deduction', $6)
               ON CONFLICT (legacy_id) DO UPDATE
                 SET amount = EXCLUDED.amount, remarks = EXCLUDED.remarks,
                     txn_date = EXCLUDED.txn_date, trip_id = EXCLUDED.trip_id`,
              [`BILLREC-${bill.bill_no}-${p.line.trip_id}`, p.line.driver_id ?? null,
               p.line.driver_name, entryDate, p.extra,
               `Party deduction on bill ${bill.bill_no} (trip ${p.line.trip_code ?? ''}, vehicle ${p.line.vehicle_no ?? '-'})`,
               p.line.trip_id]);
          }

          // 'PAID'/'PART_PAID' — the values trips_payment_status_chk allows.
          // Anything else is rejected by the constraint, which is the point of
          // having it: a settlement cannot invent a status the rest of the ERP
          // does not understand.
          // net_payable is ALREADY net of TDS (gross - shortage - tds), so the
          // cash passed is compared to it directly. Adding TDS back made every
          // short-paid trip look PAID — including one the party had docked ₹500.
          const fullyPaid = r2(p.passed) >= r2(money(p.line.net_payable));
          await t.query(
            `UPDATE trips SET received_amount = COALESCE(received_amount,0) + $2,
                              tds_amount = COALESCE(tds_amount,0) + $3,
                              payment_status = $4, updated_at = now()
              WHERE id = $1::uuid`,
            [p.line.trip_id, p.passed, money(p.line.tds_amt), fullyPaid ? 'PAID' : 'PART_PAID']);
        }

        // Header derived from its own lines, never accumulated from the caller's
        // figure. Adding `cash` to the previous total would double-count the
        // moment a half-finished settlement is retried; summing the settled lines
        // gives the same answer however many times this runs.
        const { rows: [head] } = await t.query(
          `UPDATE company_bills b
              SET received_amount = COALESCE((SELECT SUM(x.final_passed_amt)
                                                FROM company_bill_trips x
                                               WHERE x.bill_id = b.id
                                                 AND x.payment_status = 'SETTLED'), 0),
                  status = CASE WHEN NOT EXISTS (
                                  SELECT 1 FROM company_bill_trips x
                                   WHERE x.bill_id = b.id AND x.payment_status <> 'SETTLED')
                                THEN 'SETTLED' ELSE 'PARTIALLY_PAID' END,
                  updated_at = now()
            WHERE b.id = $1::uuid
            RETURNING bill_no, status, total_net, received_amount`,
          [req.params.id]);
        return head;
      });

      await drain().catch(() => {});
      return {
        settled: true,
        bill: result,
        voucher_id: voucher.voucher_id,
        // true when this call finished a settlement whose receipt had already
        // posted — the caller sees a success, not a phantom second payment.
        adopted_existing_voucher: adopted,
        gross, cash, tds,
        trips_settled: perTrip.length,
        driver_recoveries: recoveries,
      };
    }
  );

  // ── Cancel a bill ───────────────────────────────────────────────────────────
  // A bill with money against it is not cancelled, it is credited: reverse the
  // receipt first (POST /finance/vouchers/:id/reverse) so the ledger keeps the
  // full history instead of losing a settled document.
  app.post(
    '/bills/:id/cancel',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['reason'], additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 3, maxLength: 300 }, created_by: { type: ['string', 'null'], maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [bill] } = await query(
        `SELECT b.*, (SELECT count(*) FROM company_bill_trips x
                       WHERE x.bill_id = b.id AND x.payment_status = 'SETTLED')::int AS settled_lines
           FROM company_bills b WHERE b.id = $1::uuid`, [req.params.id]);
      if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (bill.status === 'CANCELLED') return { cancelled: true, already: true, bill_no: bill.bill_no };
      if (bill.settled_lines > 0 || money(bill.received_amount) > 0) {
        return reply.code(409).send({
          error: 'BILL_SETTLED',
          detail: `bill ${bill.bill_no} has ₹${money(bill.received_amount).toFixed(2)} received against it — reverse the receipt voucher first`,
        });
      }
      // The bill's own columns are not sufficient evidence that no money moved. A
      // settlement posts the receipt before it marks the bill, so a run that died
      // in between leaves cash in the ledger against a bill that still looks
      // unpaid. Cancelling then would strand a receipt with no document behind
      // it, so the ledger is asked directly.
      const { rows: posted } = await query(
        `SELECT DISTINCT voucher_id FROM ledger_entries
          WHERE voucher_id IS NOT NULL
            AND (source_ref LIKE $1 || '-%' OR source_ref LIKE $2 || '-%')
            AND NOT EXISTS (SELECT 1 FROM ledger_entries r
                             WHERE r.source_type = 'REVERSAL'
                               AND r.source_ref = 'REV-' || ledger_entries.voucher_id::text)`,
        [`BILL-${bill.bill_no}`, `BILLREC-${bill.bill_no}`]);
      if (posted.length) {
        return reply.code(409).send({
          error: 'VOUCHER_POSTED',
          detail: `${posted.length} unreversed voucher(s) already posted against ${bill.bill_no}`
            + ` — reverse them first: ${posted.map((p) => p.voucher_id).join(', ')}`,
          voucher_ids: posted.map((p) => p.voucher_id),
        });
      }

      const out = await withTransaction(async (t) => {
        await t.query(
          `UPDATE trips SET billing_status = NULL, linked_bill_id = NULL, billed_amount = NULL, updated_at = now()
            WHERE linked_bill_id = $1::uuid`, [req.params.id]);
        // Lines go with the header (ON DELETE CASCADE), which also frees the
        // unique index so the trips can be billed again.
        await t.query('DELETE FROM company_bill_trips WHERE bill_id = $1::uuid', [req.params.id]);
        const { rows: [head] } = await t.query(
          `UPDATE company_bills SET status = 'CANCELLED', updated_at = now()
            WHERE id = $1::uuid RETURNING bill_no, status`, [req.params.id]);
        return head;
      });
      return { cancelled: true, bill: out, reason: req.body.reason };
    }
  );
}
