// server/modules/ops.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/ops — the operational core: trips from advice through unloading to
// settlement. This is the server-side surface for the four screens KALI already
// declares in `owns.modules` (TripManagment, LodingDetals, UnlodingDetals,
// LoadingAdvice) plus MasterTripSettlement, so writing `trips` here is that
// agent's ownership expressed over HTTP, not a second writer competing with it.
//
//   GET    /masters                  every dropdown the cluster needs, one call
//   GET    /trips                    filtered, paginated, with fuel/advance rollups
//   GET    /trips/:id                one trip + its fuel slips, advances, tolls
//   POST   /trips                    create (loading advice or a loaded trip)
//   PATCH  /trips/:id                edit trip fields
//   POST   /trips/:id/unload         record unloading + shortage
//   POST   /trips/:id/driver-txn     advance / payment to the driver
//   POST   /trips/:id/fuel-slip      pump memo (+ optional cash from pump)
//   DELETE /trips/:id                cancel — refused once money is attached
//   GET    /tolls/latest             newest toll per trip, for a set of trips
//   GET    /settlements              freight settlements (TARA's, one per trip)
//   POST   /settlements              ask TARA to authorise one; returns its verdict
//   GET    /driver-settlements       bhatta reconciliations, one driver × many trips
//   GET    /driver-settlements/candidates  settleable trips + live carry-forwards
//   POST   /driver-settlements       post or carry forward a driver's balance
//
// Money boundary: nothing here writes `ledger_entries`. Cash movements are
// recorded in the subsidiary tables (`driver_transactions`, `fuel_entries`) and
// the general ledger is TARA's alone, reached by emitting events.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { emit, drain } from '../agents/bus.js';
import { postVoucher } from '../agents/tara.js';
import { put, safeKey } from '../lib/storage.js';
import { buildLrPdf } from '../lib/lrPdf.js';
import { mintShareLink } from '../lib/shareLinks.js';
import { sendViaEngine } from '../lib/waSend.js';
import { last10 } from '../lib/contactDirectory.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

// PG's own status vocabulary (trips_status_check). Firestore used a `trip_status`
// field whose 'ADVICE' value has no equivalent here — a loading advice is a trip
// that exists but is not yet loaded, which is exactly PENDING. The mapping is
// declared once, here, rather than guessed at each call site.
const STATUS = Object.freeze(['PENDING', 'LOADED', 'IN_TRANSIT', 'UNLOADING', 'COMPLETED', 'SETTLED', 'CANCELLED']);
const LEGACY_STATUS = Object.freeze({ ADVICE: 'PENDING', UNLOADED: 'COMPLETED' });
const toStatus = (s) => LEGACY_STATUS[String(s ?? '').toUpperCase()] ?? String(s ?? '').toUpperCase();

const money = (v) => Number(v ?? 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function registerOpsRoutes(app) {
  // ── The staff boundary ─────────────────────────────────────────────────────
  // Every route in this module is office work: the masters call alone returns
  // vendor bank accounts and IFSC codes, and unload / driver-settlements post
  // vouchers. apiGuard no longer routes any external role here (2026-08-31
  // audit), and this hook is the second lock so a future allow-list edit cannot
  // silently reopen it. The driver app's scoped surface is /portal/driver/.
  const EXTERNAL = new Set(['DRIVER', 'VENDOR', 'CUSTOMER']);
  app.addHook('preHandler', async (req, reply) => {
    if (EXTERNAL.has(req.user?.role)) {
      return reply.code(403).send({ error: 'STAFF_ONLY', detail: 'ops is an office surface — the driver app uses /portal/driver' });
    }
  });

  // ── Masters ────────────────────────────────────────────────────────────────
  // All five screens open by loading the same seven master sets. Firestore did
  // that as seven round trips per screen; one call here, and the client caches it.
  app.get('/masters', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const [vehicles, drivers, vendors, customers, lanes, companies, links] = await Promise.all([
      query(`SELECT id, vehicle_no, vehicle_type, ownership, owner_name, make_model,
                    capacity_kl, payload_mt, tyre_count, fastag_id, gps_imei, status,
                    insurance_expiry, fitness_expiry, permit_expiry, puc_expiry, tax_expiry,
                    national_permit_expiry, company_id
               FROM vehicles WHERE status <> 'INACTIVE' ORDER BY vehicle_no`),
      query(`SELECT id, name, mobile, alt_mobile, license_no, license_expiry,
                    hzd_expiry, account_no, ifsc_code, bank_name, approval_status, status
               FROM drivers WHERE status = 'ACTIVE' ORDER BY name`),
      query(`SELECT id, vendor_name, vendor_type, contact_person, mobile_no,
                    gst_no::text AS gst_no, bank_account, ifsc_code, current_balance, status
               FROM vendors WHERE status = 'ACTIVE' ORDER BY vendor_name`),
      query(`SELECT id, customer_name, current_outstanding, payment_terms, status,
                    gst_no::text AS gst_no
               FROM customers WHERE status = 'ACTIVE' ORDER BY customer_name`),
      // Field names match src/lib/freightEngine.ts so the one tested freight
      // implementation can consume this untouched.
      query(`SELECT id, customer_name AS "Customer_Name", registered_assessee AS "Registered_Assessee",
                    depot_link AS "Depot_Link", consignee_name AS "Consignee_Name",
                    consignee_id AS "Consignee_Id", vehicle_capacity AS "Vehicle_Capacity",
                    item_type AS "Item_Type", rtkm_distance AS "RTKM_Distance",
                    fixed_hsd_qty, fixed_cash_amt, toll_amt
               FROM rtkm_master WHERE COALESCE(status,'ACTIVE') = 'ACTIVE'
              ORDER BY customer_name, consignee_name`),
      query(`SELECT id, company_name, gstin::text AS gstin, pan_no::text AS pan_no, tds_tan,
                    address, city, state, pincode
               FROM companies WHERE status = 'ACTIVE' ORDER BY company_name`),
      // Only live links: a released assignment is history, not a current pairing.
      query(`SELECT a.vehicle_id, a.driver_id, v.vehicle_no, d.name AS driver_name,
                    d.mobile AS driver_mobile, a.assigned_at
               FROM vehicle_assignments a
               JOIN vehicles v ON v.id = a.vehicle_id
               JOIN drivers  d ON d.id = a.driver_id
              WHERE a.released_at IS NULL
              ORDER BY v.vehicle_no`),
    ]);
    return {
      vehicles: vehicles.rows,
      drivers: drivers.rows,
      vendors: vendors.rows,
      customers: customers.rows,
      routes: lanes.rows,
      companies: companies.rows,
      vehicle_links: links.rows,
    };
  });

  // ── Trip list ──────────────────────────────────────────────────────────────
  // Firestore needed one query per status plus a composite index, and its
  // `!=` filter silently dropped every trip whose status field was missing.
  // Here status is a bounded set and absent means absent.
  app.get(
    '/trips',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: ['string', 'null'], maxLength: 120 },   // CSV
            exclude_status: { type: ['string', 'null'], maxLength: 120 },
            from: { type: ['string', 'null'], format: 'date' },
            to: { type: ['string', 'null'], format: 'date' },
            company: { type: ['string', 'null'], maxLength: 120 },
            vehicle_no: { type: ['string', 'null'], maxLength: 20 },
            driver_id: { type: ['string', 'null'], format: 'uuid' },
            q: { type: ['string', 'null'], maxLength: 60 },
            limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const csv = (s) => (s ? String(s).split(',').map((x) => toStatus(x.trim())).filter(Boolean) : null);
      const inc = csv(req.query.status);
      const exc = csv(req.query.exclude_status);
      const args = [
        inc, exc, req.query.from || null, req.query.to || null,
        req.query.company || null, req.query.vehicle_no || null,
        req.query.driver_id || null, req.query.q || null,
        req.query.limit ?? 500, req.query.offset ?? 0,
      ];

      // Rollups come from SQL because the client used to fetch every fuel entry
      // and every driver transaction just to total them per trip.
      const SQL = `
        SELECT t.*,
               COALESCE(f.fuel_amount, 0)::numeric(14,2)  AS fuel_amount,
               COALESCE(f.fuel_liters, 0)::numeric(14,3)  AS fuel_liters,
               COALESCE(f.slips, 0)::int                  AS fuel_slips,
               COALESCE(d.given, 0)::numeric(14,2)        AS driver_advances,
               COALESCE(d.net, 0)::numeric(14,2)          AS driver_net,
               COALESCE(tl.toll_amount, 0)::numeric(14,2) AS toll_amount,
               -- ROUND TRIP OR ONE SIDE, ANSWERED BY THE REGISTER (owner, 4-Sep).
               -- Oil-company work returns and pays its tolls twice; a MARKET
               -- vehicle runs the owner's side once. Leaving that to a switch
               -- somebody remembers to flip on every market trip is the same as
               -- not implementing the rule, so it is derived here and
               -- trips.trip_leg_kind stays the OVERRIDE rather than the input.
               --
               -- Matched on the registration with spacing and case removed:
               -- "AS 26C 9804" and "AS26C9804" are one lorry, and the two
               -- tables are typed by different people.
               EXISTS (
                 SELECT 1 FROM market_vehicles mv
                  WHERE regexp_replace(upper(mv.registration_no), '[^A-Z0-9]', '', 'g')
                      = regexp_replace(upper(COALESCE(t.vehicle_no, '')), '[^A-Z0-9]', '', 'g')
                    AND COALESCE(t.vehicle_no, '') <> ''
               )                                          AS is_market_vehicle,
               b.bill_no
          FROM trips t
          LEFT JOIN LATERAL (
            SELECT SUM(amount) AS fuel_amount, SUM(liters) AS fuel_liters, count(*) AS slips
              FROM fuel_entries WHERE trip_id = t.id) f ON true
          -- Two figures, because they answer different questions: driver_advances
          -- is what the trip actually cost in driver cash, driver_net is what is
          -- still outstanding after recoveries. A single netted column goes
          -- negative on a recovered trip and reads as a negative advance.
          LEFT JOIN LATERAL (
            SELECT SUM(amount) FILTER (WHERE txn_type = 'ADVANCE_GIVEN') AS given,
                   SUM(CASE WHEN txn_type = 'ADVANCE_GIVEN' THEN amount ELSE -amount END) AS net
              FROM driver_transactions WHERE trip_id = t.id) d ON true
          LEFT JOIN LATERAL (
            SELECT SUM(amount) AS toll_amount FROM toll_transactions WHERE trip_id = t.id) tl ON true
          LEFT JOIN LATERAL (
            SELECT bl.bill_no FROM company_bill_trips bt
              JOIN company_bills bl ON bl.id = bt.bill_id
             WHERE bt.trip_id = t.id AND bl.status <> 'CANCELLED' LIMIT 1) b ON true
         WHERE ($1::text[] IS NULL OR t.status = ANY($1::text[]))
           AND ($2::text[] IS NULL OR t.status <> ALL($2::text[]))
           AND ($3::date  IS NULL OR t.loading_date >= $3::date)
           AND ($4::date  IS NULL OR t.loading_date <= $4::date)
           AND ($5::text  IS NULL OR company_matches(t.operating_company, $5::text))
           AND ($6::text  IS NULL OR t.vehicle_no = $6::text)
           AND ($7::uuid  IS NULL OR t.driver_id = $7::uuid)
           AND ($8::text  IS NULL OR t.trip_code ILIKE '%'||$8||'%'
                                  OR t.vehicle_no ILIKE '%'||$8||'%'
                                  OR t.driver_name ILIKE '%'||$8||'%'
                                  OR t.customer_name ILIKE '%'||$8||'%'
                                  OR t.consignee_name ILIKE '%'||$8||'%'
                                  OR t.challan_no ILIKE '%'||$8||'%')
         ORDER BY t.loading_date DESC NULLS LAST, t.created_at DESC
         LIMIT $9 OFFSET $10`;

      const COUNT = `
        SELECT count(*)::int AS total FROM trips t
         WHERE ($1::text[] IS NULL OR t.status = ANY($1::text[]))
           AND ($2::text[] IS NULL OR t.status <> ALL($2::text[]))
           AND ($3::date  IS NULL OR t.loading_date >= $3::date)
           AND ($4::date  IS NULL OR t.loading_date <= $4::date)
           AND ($5::text  IS NULL OR company_matches(t.operating_company, $5::text))
           AND ($6::text  IS NULL OR t.vehicle_no = $6::text)
           AND ($7::uuid  IS NULL OR t.driver_id = $7::uuid)
           AND ($8::text  IS NULL OR t.trip_code ILIKE '%'||$8||'%'
                                  OR t.vehicle_no ILIKE '%'||$8||'%'
                                  OR t.driver_name ILIKE '%'||$8||'%'
                                  OR t.customer_name ILIKE '%'||$8||'%'
                                  OR t.consignee_name ILIKE '%'||$8||'%'
                                  OR t.challan_no ILIKE '%'||$8||'%')`;

      const [rows, cnt] = await Promise.all([query(SQL, args), query(COUNT, args.slice(0, 8))]);
      return {
        total: cnt.rows[0].total,
        count: rows.rows.length,
        offset: req.query.offset ?? 0,
        has_more: (req.query.offset ?? 0) + rows.rows.length < cnt.rows[0].total,
        trips: rows.rows,
      };
    }
  );

  // ── One trip, in full ──────────────────────────────────────────────────────
  app.get(
    '/trips/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const [trip, fuel, txns, tolls] = await Promise.all([
        // is_market_vehicle mirrors the list query above — the tracking sheet
        // re-reads one trip after a GPS refresh and would otherwise lose the
        // flag, silently flipping a market trip back to ROUND and doubling its
        // toll on screen.
        query(`SELECT t.*,
                      EXISTS (
                        SELECT 1 FROM market_vehicles mv
                         WHERE regexp_replace(upper(mv.registration_no), '[^A-Z0-9]', '', 'g')
                             = regexp_replace(upper(COALESCE(t.vehicle_no, '')), '[^A-Z0-9]', '', 'g')
                           AND COALESCE(t.vehicle_no, '') <> ''
                      ) AS is_market_vehicle
                 FROM trips t WHERE t.id = $1::uuid`, [req.params.id]),
        query(`SELECT id, entry_date, vehicle_no, memo_no, fuel_type, liters, rate, amount,
                      cash_given_to_pump, vendor_name, vendor_id, bill_status
                 FROM fuel_entries WHERE trip_id = $1::uuid ORDER BY entry_date, created_at`, [req.params.id]),
        query(`SELECT id, txn_date, txn_type, amount, mode, remarks, driver_name
                 FROM driver_transactions WHERE trip_id = $1::uuid ORDER BY txn_date, created_at`, [req.params.id]),
        query(`SELECT id, txn_datetime, txn_date, amount, plaza_name, lat, lng,
                      ext_txn_id, txn_ref, vehicle_no, is_billable, claim_status
                 FROM toll_transactions WHERE trip_id = $1::uuid
                ORDER BY txn_datetime DESC NULLS LAST`, [req.params.id]),
      ]);
      if (!trip.rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { trip: trip.rows[0], fuel_entries: fuel.rows, driver_transactions: txns.rows, tolls: tolls.rows };
    }
  );

  // ── ONE TRIP'S PROFIT AND LOSS, BY TYPE ───────────────────────────────────
  //
  // Owner, 4-Sep-2026: "type wise expense management ho — HSD / toll tax / trip
  // expenses — trip ke saath map kiya jaye taaki us trip ka profit-loss pata
  // lag sake aur account mein bhi clean rahe."
  //
  // READ FROM THE REGISTERS, NOT FROM THE COUNTER. `trips.total_expense` is an
  // accumulator four routes add to and nothing subtracts from: a driver ADVANCE
  // was being added to it as though it were an expense, the pump cash was being
  // counted as both, an edited fuel slip never moved it back down, and the
  // tolls never reached it at all. v_trip_pnl (migration 149) derives all of it
  // from the rows that actually carry this trip's id, so it cannot drift.
  //
  // The stored number is still returned, next to what the registers say and the
  // difference between them, because a screen that silently starts showing a
  // different figure is how nobody notices which one was wrong.
  app.get(
    '/trips/:id/pnl',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const [pnl, lines] = await Promise.all([
        query('SELECT * FROM v_trip_pnl WHERE trip_id = $1::uuid', [req.params.id]),
        // Every rupee, openable. A total nobody can drill into is a total
        // nobody argues with, and the ones worth arguing with are the wrong ones.
        query(`SELECT kind, expense_type, source, source_id, dated, vehicle_no,
                      amount, ref, party
                 FROM v_trip_expense_lines
                WHERE trip_id = $1::uuid
                ORDER BY kind, dated NULLS LAST, expense_type`, [req.params.id]),
      ]);
      if (!pnl.rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });

      const { rows: flags } = await query(
        `SELECT finding, source, source_id, expense_type, amount, dated, detail
           FROM v_trip_expense_audit WHERE trip_id = $1::uuid
          ORDER BY finding`, [req.params.id]);

      return {
        pnl: pnl.rows[0],
        lines: lines.rows,
        // What is doubtful about this trip's money, on the same response as the
        // money. Empty is the normal answer and says so.
        audit: flags,
        basis: 'derived from fuel_entries, toll_transactions, approved expense_approvals '
             + 'and driver_transactions carrying this trip_id (migration 149)',
      };
    }
  );

  // ── THE AUDIT, ACROSS THE WHOLE REGISTER ──────────────────────────────────
  //
  // "koi trip ka expense dusray trip may na jaye" — this is the report that
  // says where it already has. Nothing here is corrected automatically; each
  // row is a task for a person, which is the standing rule for data faults in
  // this system.
  app.get(
    '/trip-expense-audit',
    { schema: { querystring: { type: 'object', properties: {
      finding: { type: ['string', 'null'], maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { finding, limit } = req.query ?? {};
      const [rows, summary] = await Promise.all([
        query(`SELECT * FROM v_trip_expense_audit
                WHERE ($1::text IS NULL OR finding = $1)
                ORDER BY abs(amount) DESC NULLS LAST
                LIMIT $2`, [finding || null, limit ?? 500]),
        // The money at stake per kind of fault, so the desk knows which pile to
        // start on rather than working down a list in id order.
        query(`SELECT finding, count(*)::int AS rows,
                      sum(abs(amount))::numeric(16,2) AS amount
                 FROM v_trip_expense_audit GROUP BY finding ORDER BY 3 DESC NULLS LAST`),
      ]);
      return {
        count: rows.rows.length,
        findings: rows.rows,
        summary: summary.rows,
        legend: {
          ORPHAN_BILL: 'approved bill with no trip — in the ledger, in no trip P&L',
          ORPHAN_FUEL: 'fuel slip with no trip',
          ORPHAN_TOLL: 'toll crossing not linked to a trip',
          WRONG_VEHICLE: "expense filed on a trip that ran a different lorry",
          DATE_OUTSIDE_TRIP: 'bill dated outside the trip it is attached to',
          FUEL_TWICE: 'an approved FUEL bill on a trip that also has fuel slips',
          AMBIGUOUS_TRIP_WINDOW: 'the same lorry had two trips open that day — the match was automatic, check it went to the right one',
          STORED_DRIFT: 'trips.total_expense disagrees with the registers',
        },
      };
    }
  );

  // The writable surface of a trip. Listed explicitly so a client cannot patch
  // billing or settlement columns through this route — those belong to the
  // billing and settlement paths, which have their own guards.
  const TRIP_FIELDS = {
    operating_company: { type: ['string', 'null'], maxLength: 120 },
    customer_id: { type: ['string', 'null'], format: 'uuid' },
    customer_name: { type: ['string', 'null'], maxLength: 160 },
    registered_assessee: { type: ['string', 'null'], maxLength: 160 },
    consignee_name: { type: ['string', 'null'], maxLength: 160 },
    vehicle_id: { type: ['string', 'null'], format: 'uuid' },
    vehicle_no: { type: ['string', 'null'], maxLength: 20 },
    driver_id: { type: ['string', 'null'], format: 'uuid' },
    driver_name: { type: ['string', 'null'], maxLength: 120 },
    driver_mobile: { type: ['string', 'null'], maxLength: 20 },
    loading_date: { type: ['string', 'null'], format: 'date' },
    loading_point: { type: ['string', 'null'], maxLength: 160 },
    challan_no: { type: ['string', 'null'], maxLength: 60 },
    // The IOCL AC5 dispatch invoice number. Absent from this list until
    // 2026-08-16, which mattered more than it looks: the body schema is
    // additionalProperties:false, and Fastify STRIPS unknown properties rather
    // than rejecting them. So the AC5 importer posted iocl_invoice_no, got a
    // 200 back, and 26 trips landed with the field null -- silently losing the
    // one column the import deduplicates on. A re-run would then have inserted
    // all 26 again. A dropped field is louder as a 400 than as a success.
    iocl_invoice_no: { type: ['string', 'null'], maxLength: 40 },
    product_type: { type: ['string', 'null'], maxLength: 60 },
    loaded_qty: { type: ['number', 'null'], minimum: 0 },
    rtkm: { type: ['number', 'null'], minimum: 0 },
    rate: { type: ['number', 'null'], minimum: 0 },
    freight_amount: { type: ['number', 'null'], minimum: 0 },
    unloading_date: { type: ['string', 'null'], format: 'date' },
    unloading_location: { type: ['string', 'null'], maxLength: 160 },
    unloaded_qty: { type: ['number', 'null'], minimum: 0 },
    shortage_qty: { type: ['number', 'null'] },
    shortage_penalty: { type: ['number', 'null'], minimum: 0 },
    unloading_remarks: { type: ['string', 'null'], maxLength: 500 },
    fixed_cash: { type: ['number', 'null'], minimum: 0 },
    fixed_hsd: { type: ['number', 'null'], minimum: 0 },
    remarks: { type: ['string', 'null'], maxLength: 500 },
    office_approved_loading: { type: ['boolean', 'null'] },
    office_approved_unloading: { type: ['boolean', 'null'] },
    status: { type: ['string', 'null'], maxLength: 20 },
    // ROUND = loaded out and back (oil company work; rtkm is round-trip km and
    // the trip closes on return). ONE_WAY = one side only (market vehicle).
    // NULL means "derive from the vehicle" — see legKindOf() in tollRoute.mjs.
    // It is here because the toll a trip pays is doubled or not on this word.
    trip_leg_kind: { type: ['string', 'null'], enum: ['ROUND', 'ONE_WAY', null] },
    // Loading advice: a trip that exists before it is loaded, holding a reserved
    // LR number so early advances never need re-linking (migration 025).
    advice_no: { type: ['string', 'null'], maxLength: 60 },
    advice_date: { type: ['string', 'null'], format: 'date' },
    advice_valid_till: { type: ['string', 'null'], format: 'date' },
    sync_to_customer_portal: { type: ['boolean', 'null'] },
    invoice_url: { type: ['string', 'null'], maxLength: 500 },
    freight_set_by: { type: ['string', 'null'], maxLength: 40 },
    // driver_loaded_qty / driver_unloaded_qty are deliberately NOT here. They are
    // what the driver submitted, and the office approves them by writing
    // loaded_qty / unloaded_qty — never by editing the driver's own figure. The
    // driver app gets its own endpoint when that cluster moves.
  };
  const FIELD_NAMES = Object.keys(TRIP_FIELDS);


  // ── LORRY RECEIPT ─────────────────────────────────────────────────────────
  // SEND LR COPY was a drawn button with no onClick — the same fault as the
  // send arrow beside it, which is why wa_chats held 165 incoming messages and
  // no outgoing ones. This is the route behind it.
  //
  // THE LAYOUT IS PROVISIONAL AND THE DOCUMENT SAYS SO, in a red band across
  // the top. The owner is sending the firm's printed LR format; until it
  // arrives, a button that produces a plausible-looking lorry receipt is a
  // liability, because somebody will hand one to a consignee. The figures on it
  // are real — read from this trip row — so replacing the layout later changes
  // the paper, not the data path.
  //
  // ?preview=1 returns the bytes and files nothing: that is the office looking
  // at what it is about to send. Without it the PDF is stored in the vault, a
  // share link is minted against it, and the link is WhatsApp'd to `phone`
  // (default: the trip's own driver). Two different actions, deliberately not
  // one endpoint that guesses.
  app.get(
    '/trips/:id/lr',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query('SELECT * FROM trips WHERE id = $1::uuid', [req.params.id]);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such trip' });
      const trip = rows[0];
      const { rows: co } = trip.company_id
        ? await query('SELECT * FROM companies WHERE id = $1::uuid', [trip.company_id])
        : { rows: [] };

      // The LR number is the trip code. The firm has no separate LR series in
      // this database — inventing one here would create a second identifier for
      // the same movement, and reconciling two series afterwards is somebody's
      // week. When the real format arrives with its own numbering, that is the
      // line to change.
      const lrNo = trip.trip_code || `TRIP-${String(trip.id).slice(0, 8)}`;
      const pdf = await buildLrPdf({
        trip, company: co[0] ?? null, lrNo, issuedBy: req.user?.name ?? '',
      });
      const filename = `LR-${String(lrNo).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;

      if (req.query?.preview === '1' || req.query?.preview === 'true') {
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `inline; filename="${filename}"`)
          .send(Buffer.from(pdf));
      }
      return reply.code(400).send({
        error: 'USE_POST',
        detail: 'sending an LR is a POST; add ?preview=1 to look at one',
      });
    });

  app.post(
    '/trips/:id/lr',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query('SELECT * FROM trips WHERE id = $1::uuid', [req.params.id]);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such trip' });
      const trip = rows[0];

      // Who it goes to: whoever the caller named, else the number on the trip,
      // else the driver master. A trip with no reachable driver is a real state
      // and it is reported as one — not silently sent to nobody.
      const asked = last10(req.body?.phone ?? '');
      let phone = asked.length === 10 ? asked : last10(trip.driver_mobile ?? '');
      if (phone.length !== 10 && trip.driver_id) {
        const { rows: d } = await query('SELECT mobile FROM drivers WHERE id = $1::uuid', [trip.driver_id]);
        phone = last10(d[0]?.mobile ?? '');
      }
      if (phone.length !== 10) {
        return reply.code(422).send({
          error: 'NO_NUMBER',
          detail: 'is trip par driver ka koi mobile number darj nahi hai — Driver Master mein number daalein',
        });
      }

      const { rows: co } = trip.company_id
        ? await query('SELECT * FROM companies WHERE id = $1::uuid', [trip.company_id])
        : { rows: [] };
      const lrNo = trip.trip_code || `TRIP-${String(trip.id).slice(0, 8)}`;
      const pdf = await buildLrPdf({ trip, company: co[0] ?? null, lrNo, issuedBy: req.user?.name ?? '' });
      const filename = `LR-${String(lrNo).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;

      // Filed against the TRIP, not against the phone: the same LR may go to a
      // driver today and a consignee tomorrow, and it is one document.
      const key = safeKey(`trips/${trip.id}/lr/${Date.now()}-${filename}`);
      const stored = await put(key, Buffer.from(pdf), 'application/pdf');
      const link = await mintShareLink({
        storageKey: stored.key, filename, contentType: 'application/pdf',
        purpose: 'LR_COPY', phone, tripId: trip.id,
        createdBy: req.user?.sub ?? null,
        // A month: an LR is filed by whoever receives it, and being asked to
        // re-send one a fortnight later is the normal case.
        hours: 720,
      });

      const text = [
        `LR ${lrNo}${trip.vehicle_no ? ` · ${trip.vehicle_no}` : ''}`,
        [trip.loading_point, trip.unloading_location || trip.consignee_name].filter(Boolean).join(' → '),
        link.url,
        'Yeh link 30 din tak chalega. — Prasad Transport',
      ].filter(Boolean).join('\n');

      let sent = true, sendError = null;
      try {
        await sendViaEngine({ phone, text, user: req.user, tripId: trip.id, role: 'DRIVER',
                            media: { key: stored.key, type: 'application/pdf', filename } });
      } catch (e) { sent = false; sendError = e.message; }

      // 201 with sent:false when WhatsApp is down — the LR exists and is
      // linkable, which is a different outcome from "nothing happened".
      return reply.code(201).send({
        ok: sent, sent, error: sent ? null : 'SEND_FAILED', detail: sendError,
        lr_no: lrNo, key: stored.key, bytes: stored.bytes, filename,
        url: link.url, absolute: link.absolute, expires_at: link.expires_at,
        phone, text,
        provisional: true,
        note: 'Provisional LR layout — the office format is awaited. Figures are read from the trip record.',
      });
    });

  // ── Create ─────────────────────────────────────────────────────────────────
  app.post(
    '/trips',
    { schema: { body: { type: 'object', additionalProperties: false, properties: TRIP_FIELDS } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = { ...req.body };
      const status = b.status ? toStatus(b.status) : 'PENDING';
      if (!STATUS.includes(status)) {
        return reply.code(400).send({ error: 'BAD_STATUS', detail: `status must be one of ${STATUS.join(', ')}` });
      }
      b.status = status;

      // ── STAMP THE OPERATING COMPANY AS AN FK, NOT A REGEX ──────────────────
      // trips.company_id is the partition key (054); until now this route never
      // set it, so every IOCL-imported trip landed company_id NULL and bled
      // across all three firms downstream. Resolve the free text to a real
      // company row and carry the id. A name that is present but matches nothing
      // is refused rather than defaulted — a trip in the wrong entity is a rupee
      // in the wrong set of books. A trip with no company named at all (a manual
      // entry) is still allowed through with company_id NULL, exactly as before.
      const coText = String(b.operating_company ?? '').trim();
      let companyRow = null;
      if (coText) {
        companyRow = await query(
          `SELECT id, company_name FROM companies
            WHERE norm_company_name(company_name) = norm_company_name($1)
            LIMIT 1`, [coText]).then((r) => r.rows[0] ?? null);
        if (!companyRow) {
          return reply.code(400).send({
            error: 'UNKNOWN_COMPANY',
            detail: `operating company '${coText}' matches no company master — create it first or fix the spelling`,
          });
        }
        // Canonicalise so the text and the FK can never drift apart.
        b.operating_company = companyRow.company_name;
        b.company_id = companyRow.id;
      }

      // Trip code: <company prefix><5-digit sequence>, matching the live data
      // (PT00689, JE00105). The prefix now comes from the RESOLVED company name,
      // so an unrecognised firm no longer silently mints a PRASAD TRANSPORT LR.
      const prefixSource = companyRow?.company_name ?? b.operating_company ?? '';
      const prefix = /jaiswal/i.test(prefixSource) ? 'JE'
        : /gautam/i.test(prefixSource) ? 'GP' : 'PT';

      try {
        const created = await withTransaction(async (t) => {
          await t.query('LOCK TABLE trips IN SHARE ROW EXCLUSIVE MODE');
          const { rows: [seq] } = await t.query(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(trip_code, '^[A-Z]+', ''), '')::int), 0) + 1 AS n
               FROM trips WHERE trip_code ~ ('^' || $1 || '[0-9]+$')`, [prefix]);
          const tripCode = `${prefix}${String(seq.n).padStart(5, '0')}`;

          const cols = FIELD_NAMES.filter((f) => b[f] !== undefined);
          // company_id is resolved server-side above, not a client field, so it
          // is not in FIELD_NAMES — add it explicitly when we have one.
          if (b.company_id && !cols.includes('company_id')) cols.push('company_id');
          const vals = cols.map((f) => b[f]);
          const ph = cols.map((_, i) => `$${i + 2}`);
          const { rows } = await t.query(
            `INSERT INTO trips (trip_code, ${cols.join(', ')})
             VALUES ($1, ${ph.join(', ')}) RETURNING *`, [tripCode, ...vals]);
          return rows[0];
        });

        // KALI's own event, so the swarm sees a trip it did not itself create —
        // unless the caller IS an agent (TARA posting an AC5 into the trip
        // ledger sends X-Agent-Id), in which case the audit trail names it.
        const agentHeader = String(req.headers['x-agent-id'] ?? '');
        await emit('trip.created', {
          aggregate: 'trip', aggregateId: created.id,
          payload: { trip_code: created.trip_code, status: created.status, vehicle_no: created.vehicle_no },
          emittedBy: /^AGENT_\d{2}$/.test(agentHeader) ? agentHeader : 'AGENT_01',
        }).catch(() => {});
        await drain().catch(() => {});

        reply.code(201);
        return { created: true, trip: created };
      } catch (err) {
        if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
        if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
        throw err;
      }
    }
  );

  // ── Update ─────────────────────────────────────────────────────────────────
  app.patch(
    '/trips/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: TRIP_FIELDS },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = { ...req.body };
      if (b.status !== undefined && b.status !== null) {
        b.status = toStatus(b.status);
        if (!STATUS.includes(b.status)) {
          return reply.code(400).send({ error: 'BAD_STATUS', detail: `status must be one of ${STATUS.join(', ')}` });
        }
      }

      // A trip on a live bill is frozen: its quantities and rate are what the
      // customer was actually invoiced, and editing them behind the bill is how
      // the two quietly stop agreeing.
      const { rows: [billed] } = await query(
        `SELECT bl.bill_no FROM company_bill_trips bt
           JOIN company_bills bl ON bl.id = bt.bill_id
          WHERE bt.trip_id = $1::uuid AND bl.status <> 'CANCELLED' LIMIT 1`, [req.params.id]);
      const FROZEN = ['loaded_qty', 'rate', 'freight_amount', 'rtkm', 'shortage_penalty'];
      if (billed) {
        const touched = FROZEN.filter((f) => b[f] !== undefined);
        if (touched.length) {
          return reply.code(409).send({
            error: 'TRIP_BILLED',
            detail: `trip is on bill ${billed.bill_no}; ${touched.join(', ')} cannot change while that bill stands`,
          });
        }
      }

      const cols = FIELD_NAMES.filter((f) => b[f] !== undefined);
      if (!cols.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
      const sets = cols.map((f, i) => `${f} = $${i + 2}`);
      try {
        const { rows } = await query(
          `UPDATE trips SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1::uuid RETURNING *`, [req.params.id, ...cols.map((f) => b[f])]);
        if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
        return { updated: true, trip: rows[0] };
      } catch (err) {
        if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
        throw err;
      }
    }
  );

  // ── Unloading ──────────────────────────────────────────────────────────────
  // Shortage is computed here, never accepted from the client: it is the
  // difference the driver may be charged for, so it must come from the two
  // quantities on record.
  app.post(
    '/trips/:id/unload',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['unloading_date', 'unloaded_qty'], additionalProperties: false,
          properties: {
            unloading_date: { type: 'string', format: 'date' },
            unloading_location: { type: ['string', 'null'], maxLength: 160 },
            unloaded_qty: { type: 'number', minimum: 0 },
            shortage_rate: { type: ['number', 'null'], minimum: 0 },   // ₹ per unit short
            shortage_penalty: { type: ['number', 'null'], minimum: 0 }, // explicit override
            unloading_remarks: { type: ['string', 'null'], maxLength: 500 },
            complete: { type: 'boolean', default: true },
            // Charge the penalty to the driver's account. Default true, matching
            // the Firestore screen, which always debited the khata on save.
            recover_from_driver: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [trip] } = await query('SELECT * FROM trips WHERE id = $1::uuid', [req.params.id]);
      if (!trip) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (trip.status === 'SETTLED') {
        return reply.code(409).send({ error: 'TRIP_SETTLED', detail: 'a settled trip cannot be re-unloaded' });
      }

      const loaded = money(trip.loaded_qty);
      const shortageQty = r2(Math.max(0, loaded - b.unloaded_qty));
      const penalty = b.shortage_penalty != null
        ? r2(b.shortage_penalty)
        : b.shortage_rate != null ? r2(shortageQty * b.shortage_rate) : money(trip.shortage_penalty);

      const { rows } = await query(
        // office_approved_unloading is what takes a trip out of the driver-app
        // approval queue. Without it an approved trip reappears there and a
        // second approval would overwrite the quantities already recovered on.
        `UPDATE trips SET unloading_date = $2::date, unloading_location = COALESCE($3, unloading_location),
                          unloaded_qty = $4, shortage_qty = $5, shortage_penalty = $6,
                          unloading_remarks = COALESCE($7, unloading_remarks),
                          status = CASE WHEN $8 THEN 'COMPLETED' ELSE 'UNLOADING' END,
                          completed_at = CASE WHEN $8 THEN now() ELSE completed_at END,
                          office_approved_unloading = CASE WHEN $8 THEN true ELSE office_approved_unloading END,
                          updated_at = now()
          WHERE id = $1::uuid RETURNING *`,
        [req.params.id, b.unloading_date, b.unloading_location ?? null, b.unloaded_qty,
         shortageQty, penalty, b.unloading_remarks ?? null, b.complete !== false]);

      // CHHINNAMASTA's mileage check and TARA's settlement path both hang off
      // trip.completed; the shortage event is what lets a penalty be recovered.
      if (b.complete !== false) {
        await emit('trip.completed', {
          aggregate: 'trip', aggregateId: req.params.id,
          payload: { trip_code: trip.trip_code, unloaded_qty: b.unloaded_qty, shortage_qty: shortageQty },
          emittedBy: 'AGENT_01',
        }).catch(() => {});
      }
      if (shortageQty > 0) {
        await emit('trip.shortage.detected', {
          aggregate: 'trip', aggregateId: req.params.id,
          payload: {
            trip_code: trip.trip_code, customer_name: trip.customer_name,
            driver_name: trip.driver_name, shortage_qty: shortageQty, penalty,
          },
          emittedBy: 'AGENT_01',
        }).catch(() => {});
      }

      // Charge the driver, if asked. The Firestore screen debited the khata the
      // moment unloading was saved, and dropping that would quietly stop every
      // shortage recovery in the business. The subsidiary row is keyed on the
      // trip so a re-save converges instead of charging twice, and — unlike the
      // Firestore original — the matching GL journal is posted too.
      let recovery = null;
      if (penalty > 0 && b.recover_from_driver !== false && trip.driver_name) {
        const recRef = `UNLOADREC-${req.params.id}`;
        await query(
          `INSERT INTO driver_transactions
             (legacy_id, driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks)
           VALUES ($1, $2::uuid, $3, $4::uuid, $5::date, 'SHORTAGE_RECOVERY', $6, 'Unloading Shortage', $7)
           ON CONFLICT (legacy_id) DO UPDATE
             SET amount = EXCLUDED.amount, txn_date = EXCLUDED.txn_date, remarks = EXCLUDED.remarks`,
          [recRef, trip.driver_id, trip.driver_name, req.params.id, b.unloading_date, penalty,
           `Trip: ${trip.trip_code} - shortage ${shortageQty} unit(s) recovered from driver`]);
        try {
          const j = await postVoucher({
            type: 'JOURNAL',
            lines: [
              { ledger: `Driver Advance: ${trip.driver_name}`, dr_cr: 'DR', amount: penalty, group: 'Current Assets - Driver Advances' },
              { ledger: 'Shortage & Penalty', dr_cr: 'CR', amount: penalty, group: 'Shortage & Penalty' },
            ],
            source_type: 'UNLOADING_SHORTAGE_RECOVERY',
            ref_no: recRef,
            entry_date: b.unloading_date,
            narration: `Shortage recovered from ${trip.driver_name} — trip ${trip.trip_code}, ${shortageQty} unit(s) short`,
            company: trip.operating_company,
            company_id: trip.company_id ?? null,
            branch_id: trip.branch_id ?? null,
          });
          recovery = { amount: penalty, driver: trip.driver_name, voucher_id: j.voucher_id };
        } catch (err) {
          // A replay is expected and fine; anything else is reported, not hidden.
          recovery = err.code === 'DUPLICATE_REF'
            ? { amount: penalty, driver: trip.driver_name, already_posted: true }
            : { amount: penalty, driver: trip.driver_name, ledger_note: err.message };
        }
      }
      // ── ACCRUE THE FREIGHT ────────────────────────────────────────────────
      // The truck has delivered, so the revenue is earned — whether or not the
      // customer's invoice turns up this month. Santosh Prasad read as a 5.33
      // lakh liability for months on exactly this gap: real trips, real costs,
      // no revenue recognised until the IOCL bills arrived weeks later.
      //
      // The estimate lands on provisional_trips_ledger, NEVER on ledger_entries.
      // It is not a posting and does not touch the P&L; it is cleared against
      // the real figure when the invoice is reconciled.
      //
      // Failure here must not fail the unload. Recording that the truck emptied
      // is the operational fact and the reason the driver is waiting; an
      // accrual that could not be estimated is a bookkeeping gap the cycle-end
      // sweep will pick up anyway.
      let accrual = null;
      if (b.complete !== false) {
        try {
          const { rows: acc } = await query(
            `SELECT p.id, p.est_freight, p.est_fuel, p.est_toll, p.basis, p.status
               FROM provisional_trips_ledger p
              WHERE p.id = accrue_trip($1::uuid, 'UNLOAD')`, [req.params.id]);
          accrual = acc[0] ?? null;
        } catch (err) {
          req.log.warn({ err: err.message, trip: req.params.id }, 'accrual skipped on unload');
          accrual = { error: err.message };
        }
      }

      await drain().catch(() => {});

      return {
        unloaded: true, trip: rows[0],
        shortage_qty: shortageQty, shortage_penalty: penalty,
        driver_recovery: recovery,
        accrual,
      };
    }
  );

  // ── Driver advance / payment ────────────────────────────────────────────────
  app.post(
    '/trips/:id/driver-txn',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['txn_type', 'amount'], additionalProperties: false,
          properties: {
            txn_type: { type: 'string', enum: ['ADVANCE_GIVEN', 'PAYMENT_GIVEN', 'FINAL_PAYMENT', 'SHORTAGE_RECOVERY', 'FUEL_EXPENSE'] },
            amount: { type: 'number', exclusiveMinimum: 0 },
            txn_date: { type: ['string', 'null'], format: 'date' },
            mode: { type: ['string', 'null'], maxLength: 40 },
            remarks: { type: ['string', 'null'], maxLength: 300 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [trip] } = await query(
        'SELECT trip_code, driver_id, driver_name, vehicle_no FROM trips WHERE id = $1::uuid', [req.params.id]);
      if (!trip) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (!trip.driver_name) {
        return reply.code(400).send({ error: 'NO_DRIVER', detail: 'this trip has no driver to charge' });
      }

      const date = b.txn_date ?? new Date().toISOString().slice(0, 10);
      const out = await withTransaction(async (t) => {
        const { rows } = await t.query(
          `INSERT INTO driver_transactions
             (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks)
           VALUES ($1::uuid, $2, $3::uuid, $4::date, $5, $6, $7, $8)
           RETURNING *`,
          [trip.driver_id, trip.driver_name, req.params.id, date, b.txn_type, b.amount,
           b.mode ?? null, b.remarks ?? `Trip ${trip.trip_code}`]);

        // The trip's own cash columns are what the settlement screen totals, so
        // they move with the subsidiary row rather than being recomputed later.
        const col = b.mode && /bank/i.test(b.mode) ? 'bank_paid' : 'office_cash_paid';
        await t.query(
          `UPDATE trips SET ${col} = COALESCE(${col},0) + $2,
                            total_expense = COALESCE(total_expense,0) + $2,
                            updated_at = now()
            WHERE id = $1::uuid`, [req.params.id, b.amount]);
        return rows[0];
      });

      await emit('driver.advance.paid', {
        aggregate: 'driver', aggregateId: trip.driver_id,
        payload: {
          driver_name: trip.driver_name, trip_code: trip.trip_code, amount: b.amount,
          mode: b.mode && /bank/i.test(b.mode) ? 'BANK' : 'CASH', txn_type: b.txn_type,
        },
        emittedBy: 'AGENT_01',
      }).catch(() => {});
      await drain().catch(() => {});

      reply.code(201);
      return { created: true, transaction: out };
    }
  );

  // ── Fuel slip ──────────────────────────────────────────────────────────────
  // `fuel_entries` is CHHINNAMASTA's table, and its two guards — the slip's own
  // arithmetic and one-memo-per-pump — are re-applied here rather than skipped,
  // because the agent validates a submitted slip but never inserts one. The
  // insert happens here and `fuel.slip.recorded` is emitted for the downstream
  // chain, so no guard is bypassed and nothing writes the table twice.
  app.post(
    '/trips/:id/fuel-slip',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['vendor_id', 'liters', 'rate'], additionalProperties: false,
          properties: {
            vendor_id: { type: 'string', format: 'uuid' },
            memo_no: { type: ['string', 'null'], maxLength: 60 },
            entry_date: { type: ['string', 'null'], format: 'date' },
            fuel_type: { type: ['string', 'null'], maxLength: 20 },
            liters: { type: 'number', exclusiveMinimum: 0 },
            rate: { type: 'number', exclusiveMinimum: 0 },
            amount: { type: ['number', 'null'], minimum: 0 },
            cash_given_to_pump: { type: 'number', minimum: 0, default: 0 },
            pump_mobile: { type: ['string', 'null'], maxLength: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [trip] } = await query(
        `SELECT t.trip_code, t.vehicle_id, t.vehicle_no, t.driver_id, t.driver_name,
                t.loading_point, t.consignee_name
           FROM trips t WHERE t.id = $1::uuid`, [req.params.id]);
      if (!trip) return reply.code(404).send({ error: 'NOT_FOUND' });

      const { rows: [vendor] } = await query('SELECT vendor_name FROM vendors WHERE id = $1::uuid', [b.vendor_id]);
      if (!vendor) return reply.code(400).send({ error: 'NO_VENDOR', detail: 'unknown pump/vendor' });

      // Guard 1 — the slip's own arithmetic (CHHINNAMASTA's tolerance).
      const expected = r2(b.liters * b.rate);
      const amount = b.amount != null ? r2(b.amount) : expected;
      const tolerance = Number(process.env.FUEL_ROUNDING_TOLERANCE ?? '1');
      if (Math.abs(amount - expected) > tolerance) {
        return reply.code(422).send({
          error: 'SLIP_ARITHMETIC',
          detail: `slip says ₹${amount.toFixed(2)} but ${b.liters} L × ₹${b.rate} = ₹${expected.toFixed(2)}`,
        });
      }
      // Guard 2 — the same memo submitted twice by two people.
      if (b.memo_no) {
        const dup = await query(
          'SELECT id FROM fuel_entries WHERE vendor_id = $1::uuid AND memo_no = $2 LIMIT 1',
          [b.vendor_id, b.memo_no]);
        if (dup.rows.length) {
          return reply.code(409).send({
            error: 'DUPLICATE_MEMO',
            detail: `memo ${b.memo_no} is already recorded for this pump (entry ${dup.rows[0].id})`,
          });
        }
      }

      const date = b.entry_date ?? new Date().toISOString().slice(0, 10);
      const cash = money(b.cash_given_to_pump);

      const out = await withTransaction(async (t) => {
        const { rows: [slip] } = await t.query(
          `INSERT INTO fuel_entries
             (entry_date, vehicle_id, vehicle_no, trip_id, route_name, driver_name,
              vendor_id, vendor_name, memo_no, fuel_type, liters, rate, amount,
              cash_given_to_pump, pump_mobile, bill_status)
           VALUES ($1::date,$2::uuid,$3,$4::uuid,$5,$6,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15,'PENDING')
           RETURNING *`,
          [date, trip.vehicle_id, trip.vehicle_no, req.params.id,
           `${trip.loading_point ?? ''} - ${trip.consignee_name ?? ''}`.trim(), trip.driver_name,
           b.vendor_id, vendor.vendor_name, b.memo_no ?? null, b.fuel_type ?? 'DIESEL',
           b.liters, b.rate, amount, cash, b.pump_mobile ?? null]);

        await t.query(
          `UPDATE trips SET hsd_issued = COALESCE(hsd_issued,0) + $2,
                            pump_cash_advance = COALESCE(pump_cash_advance,0) + $3,
                            total_expense = COALESCE(total_expense,0) + $4 + $3,
                            updated_at = now()
            WHERE id = $1::uuid`, [req.params.id, b.liters, cash, amount]);

        // Cash handed over at the pump is money the driver received, so it lands
        // in the driver's subsidiary account too — otherwise it is invisible on
        // the settlement screen.
        if (cash > 0 && trip.driver_name) {
          await t.query(
            `INSERT INTO driver_transactions
               (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks)
             VALUES ($1::uuid,$2,$3::uuid,$4::date,'ADVANCE_GIVEN',$5,'Pump Cash',$6)`,
            [trip.driver_id, trip.driver_name, req.params.id, date, cash,
             `Trip ${trip.trip_code} cash from ${vendor.vendor_name}`]);
        }
        return slip;
      });

      await emit('fuel.slip.recorded', {
        aggregate: 'fuel_entry', aggregateId: out.id,
        payload: {
          liters: b.liters, rate: b.rate, amount, vendor_id: b.vendor_id,
          vendor_name: vendor.vendor_name, vehicle_no: trip.vehicle_no, trip_code: trip.trip_code,
        },
        emittedBy: 'AGENT_01',
      }).catch(() => {});
      await drain().catch(() => {});

      reply.code(201);
      return { created: true, fuel_entry: out, driver_advance: cash > 0 ? cash : null };
    }
  );

  // ── Cancel a trip ──────────────────────────────────────────────────────────
  // Not a hard delete. A trip with fuel, advances or a bill against it is part
  // of the money record; CANCELLED keeps the history and takes it out of the
  // operational lists. A trip with nothing attached is removed outright, which
  // is what "cancel this advice" should mean.
  app.delete(
    '/trips/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [t] } = await query(
        `SELECT tr.trip_code, tr.status,
                (SELECT count(*) FROM fuel_entries WHERE trip_id = tr.id)::int AS fuel,
                (SELECT count(*) FROM driver_transactions WHERE trip_id = tr.id)::int AS txns,
                (SELECT count(*) FROM toll_transactions WHERE trip_id = tr.id)::int AS tolls,
                (SELECT bl.bill_no FROM company_bill_trips bt
                   JOIN company_bills bl ON bl.id = bt.bill_id
                  WHERE bt.trip_id = tr.id AND bl.status <> 'CANCELLED' LIMIT 1) AS bill_no
           FROM trips tr WHERE tr.id = $1::uuid`, [req.params.id]);
      if (!t) return reply.code(404).send({ error: 'NOT_FOUND' });

      if (t.bill_no) {
        return reply.code(409).send({
          error: 'TRIP_BILLED',
          detail: `trip is on bill ${t.bill_no} — cancel that bill first`,
        });
      }
      if (t.status === 'SETTLED') {
        return reply.code(409).send({ error: 'TRIP_SETTLED', detail: 'a settled trip cannot be cancelled' });
      }

      const attached = t.fuel + t.txns + t.tolls;
      if (attached > 0) {
        const { rows } = await query(
          `UPDATE trips SET status = 'CANCELLED', updated_at = now()
            WHERE id = $1::uuid RETURNING trip_code, status`, [req.params.id]);
        return {
          cancelled: true, hard_deleted: false, trip: rows[0],
          detail: `${t.fuel} fuel slip(s), ${t.txns} driver txn(s) and ${t.tolls} toll(s) are attached, so the trip is marked CANCELLED rather than deleted`,
        };
      }
      await query('DELETE FROM trips WHERE id = $1::uuid', [req.params.id]);
      return { cancelled: true, hard_deleted: true, trip_code: t.trip_code };
    }
  );

  // ── Latest toll per trip ───────────────────────────────────────────────────
  // Trip Management used to fire one Firestore query per active trip and sort in
  // the browser. One query, newest-per-trip picked by the index.
  app.get(
    '/tolls/latest',
    {
      schema: {
        querystring: {
          type: 'object', required: ['trip_ids'],
          properties: { trip_ids: { type: 'string', maxLength: 20000 } },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const ids = String(req.query.trip_ids).split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return { tolls: {} };
      if (ids.length > 400) return reply.code(400).send({ error: 'TOO_MANY', detail: 'at most 400 trip ids per call' });
      const bad = ids.filter((i) => !/^[0-9a-f-]{36}$/i.test(i));
      if (bad.length) return reply.code(400).send({ error: 'BAD_UUID', detail: `not a uuid: ${bad[0]}` });

      const { rows } = await query(
        `SELECT DISTINCT ON (trip_id)
                trip_id, txn_datetime, txn_date, amount, plaza_name, lat, lng,
                COALESCE(ext_txn_id, txn_ref) AS ref, vehicle_no
           FROM toll_transactions
          WHERE trip_id = ANY($1::uuid[])
          ORDER BY trip_id, txn_datetime DESC NULLS LAST, txn_date DESC NULLS LAST`, [ids]);
      return { tolls: Object.fromEntries(rows.map((r) => [r.trip_id, r])) };
    }
  );

  // ── Settlements ────────────────────────────────────────────────────────────
  app.get(
    '/settlements',
    { schema: { querystring: { type: 'object', properties: { trip_id: { type: ['string', 'null'], format: 'uuid' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT s.*, t.trip_code, t.vehicle_no, t.driver_name, t.customer_name,
                t.loading_date, t.unloading_date, t.status AS trip_status
           FROM trip_settlements s
           LEFT JOIN trips t ON t.id = s.trip_id
          WHERE ($1::uuid IS NULL OR s.trip_id = $1::uuid)
          ORDER BY s.settled_at DESC NULLS LAST
          LIMIT $2`, [req.query.trip_id || null, req.query.limit ?? 200]);
      return { count: rows.length, settlements: rows };
    }
  );

  // ── Authorise a settlement ─────────────────────────────────────────────────
  // This route does NOT write `trip_settlements`. That table is TARA's, is
  // NOT NULL on voucher_id, and is written in the same transaction as the ledger
  // posting — a settlement literally cannot exist without the voucher that paid
  // it. So the UI asks for authorisation and TARA decides.
  //
  // The event is drained synchronously so the caller gets the verdict now rather
  // than a hopeful 202: TARA's own refusals ("trip has no freight_amount",
  // "trip is IN_TRANSIT, not COMPLETED") are the useful answer, and they are read
  // back off agent_runs and returned verbatim.
  app.post(
    '/settlements',
    {
      schema: {
        body: {
          type: 'object', required: ['trip_id'], additionalProperties: false,
          properties: {
            trip_id: { type: 'string', format: 'uuid' },
            requested_by: { type: ['string', 'null'], maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { trip_id: tripId } = req.body;
      const { rows: [trip] } = await query(
        'SELECT trip_code, status, freight_amount FROM trips WHERE id = $1::uuid', [tripId]);
      if (!trip) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such trip' });

      // Pre-flight checks duplicate TARA's, deliberately: they turn a refusal
      // into an immediate, specific 4xx instead of a queued event that quietly
      // gets blocked and leaves the user staring at an unchanged screen.
      const dup = await query('SELECT id, voucher_id FROM trip_settlements WHERE trip_id = $1::uuid LIMIT 1', [tripId]);
      if (dup.rows.length) {
        return reply.code(409).send({
          error: 'ALREADY_SETTLED',
          detail: `trip ${trip.trip_code} is already settled under voucher ${dup.rows[0].voucher_id}`,
        });
      }
      if (trip.status !== 'COMPLETED') {
        return reply.code(409).send({
          error: 'TRIP_NOT_COMPLETE',
          detail: `trip ${trip.trip_code} is ${trip.status}; only a COMPLETED trip can be settled`,
        });
      }
      if (trip.freight_amount === null || Number(trip.freight_amount) <= 0) {
        return reply.code(422).send({
          error: 'NO_FREIGHT',
          detail: `trip ${trip.trip_code} has no freight amount — price it in Bill Management before settling`,
        });
      }

      const ev = await emit('trip.settlement.authorised', {
        aggregate: 'trip', aggregateId: tripId,
        payload: { trip_code: trip.trip_code, requested_by: req.body.requested_by ?? null },
        emittedBy: 'AGENT_01',
      });
      await drain().catch(() => {});

      const [settled, runs] = await Promise.all([
        query('SELECT * FROM trip_settlements WHERE trip_id = $1::uuid LIMIT 1', [tripId]),
        query(`SELECT agent_code, outcome, reason FROM agent_runs
                WHERE event_id = $1 ORDER BY id DESC`, [ev?.id ?? null]),
      ]);

      if (!settled.rows.length) {
        // TARA declined. Its reason is the answer worth showing.
        const blocked = runs.rows.find((r) => r.outcome !== 'ok');
        return reply.code(422).send({
          error: 'SETTLEMENT_REFUSED',
          detail: blocked?.reason ?? 'TARA did not post this settlement',
          agent_runs: runs.rows,
        });
      }
      reply.code(201);
      return { settled: true, settlement: settled.rows[0], agent_runs: runs.rows };
    }
  );

  // -- Driver settlements (bhatta / cash reconciliation) ----------------------
  // Not the same thing as /settlements above. That closes ONE trip's freight
  // through TARA; this reconciles ONE DRIVER over MANY trips - bhatta earned
  // against cash and HSD already advanced - and may carry the balance forward
  // instead of posting it. See migration 024 for why they are separate tables.
  app.get(
    '/driver-settlements',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            driver_name: { type: ['string', 'null'], maxLength: 120 },
            status: { type: ['string', 'null'], enum: ['OPEN', 'CLOSED', 'CONSUMED', null] },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT s.*,
                COALESCE(array_agg(st.trip_id) FILTER (WHERE st.trip_id IS NOT NULL), '{}') AS trip_ids
           FROM driver_settlements s
           LEFT JOIN driver_settlement_trips st ON st.settlement_id = s.id
          WHERE ($1::text IS NULL OR s.driver_name = $1::text)
            AND ($2::text IS NULL OR s.status = $2::text)
          GROUP BY s.id
          ORDER BY s.created_at DESC
          LIMIT $3`,
        [req.query.driver_name || null, req.query.status || null, req.query.limit ?? 200]);
      return { count: rows.length, settlements: rows };
    }
  );

  // Trips available to settle for a driver: completed, and not already on a live
  // driver settlement. The rollups ARE the settlement's inputs, so they are
  // computed here rather than re-totalled from raw rows in the browser.
  app.get(
    '/driver-settlements/candidates',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            driver_name: { type: ['string', 'null'], maxLength: 120 },
            vehicle_no: { type: ['string', 'null'], maxLength: 20 },
            from: { type: ['string', 'null'], format: 'date' },
            to: { type: ['string', 'null'], format: 'date' },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const args = [req.query.driver_name || null, req.query.vehicle_no || null,
                    req.query.from || null, req.query.to || null];
      const [trips, open] = await Promise.all([
        query(
          `SELECT t.id, t.trip_code, t.vehicle_no, t.driver_id, t.driver_name,
                  t.customer_name, t.consignee_name, t.loading_date, t.unloading_date,
                  t.loaded_qty, t.unloaded_qty, t.shortage_qty, t.shortage_penalty,
                  t.freight_amount, t.fixed_cash, t.fixed_hsd,
                  t.office_cash_paid, t.bank_paid, t.pump_cash_advance, t.hsd_issued,
                  t.total_expense, t.settlement_status, t.settlement_no,
                  COALESCE(f.hsd_amt, 0)::numeric(14,2) AS hsd_amt,
                  COALESCE(f.hsd_ltr, 0)::numeric(14,3) AS hsd_ltr,
                  COALESCE(d.cash, 0)::numeric(14,2)    AS cash_advanced
             FROM trips t
             LEFT JOIN LATERAL (
               SELECT SUM(amount) AS hsd_amt, SUM(liters) AS hsd_ltr
                 FROM fuel_entries WHERE trip_id = t.id) f ON true
             LEFT JOIN LATERAL (
               SELECT SUM(amount) FILTER (WHERE txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN')) AS cash
                 FROM driver_transactions WHERE trip_id = t.id) d ON true
            WHERE t.status IN ('COMPLETED','SETTLED')
              AND NOT EXISTS (
                SELECT 1 FROM driver_settlement_trips st
                  JOIN driver_settlements s ON s.id = st.settlement_id
                 WHERE st.trip_id = t.id AND s.status <> 'CONSUMED')
              AND ($1::text IS NULL OR t.driver_name = $1::text)
              AND ($2::text IS NULL OR t.vehicle_no = $2::text)
              AND ($3::date IS NULL OR t.loading_date >= $3::date)
              AND ($4::date IS NULL OR t.loading_date <= $4::date)
            ORDER BY t.loading_date DESC NULLS LAST
            LIMIT $5`, [...args, Number(req.query.limit ?? 500)]),
        // Live carry-forwards for this driver roll into the next settlement as an
        // opening balance, so the screen must see them before it totals anything.
        query(
          `SELECT id, settlement_no, net_balance, earned_total, to_date
             FROM driver_settlements
            WHERE status = 'OPEN' AND mode = 'CARRY_FORWARD'
              AND ($1::text IS NULL OR driver_name = $1::text)
            ORDER BY created_at`, [req.query.driver_name || null]),
      ]);
      return { count: trips.rows.length, trips: trips.rows, open_carry_forwards: open.rows };
    }
  );

  app.post(
    '/driver-settlements',
    {
      schema: {
        body: {
          type: 'object',
          required: ['mode', 'driver_name', 'trip_ids'],
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: ['POSTED', 'CARRY_FORWARD'] },
            driver_id: { type: ['string', 'null'], format: 'uuid' },
            driver_name: { type: 'string', minLength: 1, maxLength: 120 },
            vehicle_no: { type: ['string', 'null'], maxLength: 20 },
            from_date: { type: ['string', 'null'], format: 'date' },
            to_date: { type: ['string', 'null'], format: 'date' },
            trip_ids: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', format: 'uuid' } },
            total_cash: { type: 'number', default: 0 },
            total_hsd_amt: { type: 'number', default: 0 },
            total_hsd_ltr: { type: 'number', default: 0 },
            total_allowance: { type: 'number', default: 0 },
            total_extra: { type: 'number', default: 0 },
            total_freight: { type: 'number', default: 0 },
            earned_total: { type: 'number', default: 0 },
            net_balance: { type: 'number', default: 0 },
            include_hsd_in_recovery: { type: 'boolean', default: false },
            extra_expenses: {
              type: 'array', maxItems: 100,
              items: {
                type: 'object', required: ['name', 'amount'], additionalProperties: false,
                properties: { name: { type: 'string', maxLength: 120 }, amount: { type: 'number' } },
              },
            },
            consume_carry_forward_ids: { type: 'array', maxItems: 100, items: { type: 'string', format: 'uuid' } },
            created_by: { type: ['string', 'null'], maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;

      // Every trip must be real, this driver's, and not already settled.
      const { rows: checked } = await query(
        `SELECT t.id, t.trip_code, t.driver_name, t.status, t.company_id, t.branch_id,
                (SELECT s.settlement_no FROM driver_settlement_trips st
                   JOIN driver_settlements s ON s.id = st.settlement_id
                  WHERE st.trip_id = t.id AND s.status <> 'CONSUMED' LIMIT 1) AS existing
           FROM trips t WHERE t.id = ANY($1::uuid[])`, [b.trip_ids]);
      if (checked.length !== b.trip_ids.length) {
        const found = new Set(checked.map((t) => t.id));
        return reply.code(404).send({
          error: 'TRIP_NOT_FOUND',
          detail: `unknown trip(s): ${b.trip_ids.filter((i) => !found.has(i)).join(', ')}`,
        });
      }
      const taken = checked.filter((t) => t.existing);
      if (taken.length) {
        return reply.code(409).send({
          error: 'ALREADY_SETTLED',
          detail: taken.map((t) => `${t.trip_code} is on ${t.existing}`).join('; '),
        });
      }
      const wrongDriver = checked.filter((t) => t.driver_name && t.driver_name !== b.driver_name);
      if (wrongDriver.length) {
        return reply.code(400).send({
          error: 'MIXED_DRIVER',
          detail: `a settlement covers one driver; ${wrongDriver.map((t) => `${t.trip_code} ran ${t.driver_name}`).join('; ')}`,
        });
      }
      // One settlement, one operating company — otherwise its bhatta voucher has
      // no single set of books to post into (F8). The company is the trip's FK,
      // not free text. Trips still awaiting a company are refused rather than
      // posted unscoped.
      const stlCompanies = [...new Set(checked.map((t) => t.company_id))];
      if (stlCompanies.includes(null)) {
        return reply.code(400).send({
          error: 'TRIP_COMPANY_UNSET',
          detail: `these trips carry no operating company: ${checked.filter((t) => !t.company_id).map((t) => t.trip_code).join(', ')}`,
        });
      }
      if (stlCompanies.length !== 1) {
        return reply.code(400).send({
          error: 'MIXED_COMPANY',
          detail: `a settlement posts into one company's books; these trips span ${stlCompanies.length}. Settle per company.`,
        });
      }
      const stlCompanyId = stlCompanies[0];
      const stlBranchId = checked[0].branch_id ?? null;

      // Settlement number comes from a sequence, not a timestamp. The Firestore
      // original used Date.now(), which two clicks in the same millisecond
      // collide on and which sorts oddly across a clock change.
      const created = await withTransaction(async (t) => {
        await t.query('LOCK TABLE driver_settlements IN SHARE ROW EXCLUSIVE MODE');
        const { rows: [seq] } = await t.query(
          `SELECT COALESCE(MAX(NULLIF(regexp_replace(settlement_no, '^STL-', ''), '')::bigint), 0) + 1 AS n
             FROM driver_settlements WHERE settlement_no ~ '^STL-[0-9]+$'`);
        const stlNo = `STL-${String(seq.n).padStart(6, '0')}`;

        const { rows: [headRow] } = await t.query(
          `INSERT INTO driver_settlements
             (settlement_no, mode, status, driver_id, driver_name, vehicle_no,
              from_date, to_date, trip_count, total_cash, total_hsd_amt, total_hsd_ltr,
              total_allowance, total_extra, total_freight, earned_total, net_balance,
              include_hsd_in_recovery, extra_expenses, created_by)
           VALUES ($1,$2,$3,$4::uuid,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)
           RETURNING *`,
          [stlNo, b.mode, b.mode === 'CARRY_FORWARD' ? 'OPEN' : 'CLOSED',
           b.driver_id ?? null, b.driver_name, b.vehicle_no ?? null,
           b.from_date ?? null, b.to_date ?? null, b.trip_ids.length,
           b.total_cash ?? 0, b.total_hsd_amt ?? 0, b.total_hsd_ltr ?? 0,
           b.total_allowance ?? 0, b.total_extra ?? 0, b.total_freight ?? 0,
           b.earned_total ?? 0, b.net_balance ?? 0, b.include_hsd_in_recovery ?? false,
           JSON.stringify(b.extra_expenses ?? []), b.created_by ?? null]);

        for (const id of b.trip_ids) {
          await t.query(
            'INSERT INTO driver_settlement_trips (settlement_id, trip_id) VALUES ($1::uuid, $2::uuid)',
            [headRow.id, id]);
        }
        await t.query(
          `UPDATE trips SET settlement_status = $2, settlement_no = $3, settled_at = now(), updated_at = now()
            WHERE id = ANY($1::uuid[])`,
          [b.trip_ids, b.mode === 'CARRY_FORWARD' ? 'CARRIED_FORWARD' : 'SETTLED', stlNo]);

        // Old carry-forwards roll into this one and stop being live.
        if (b.consume_carry_forward_ids && b.consume_carry_forward_ids.length) {
          await t.query(
            `UPDATE driver_settlements SET status = 'CONSUMED', consumed_by = $2, updated_at = now()
              WHERE id = ANY($1::uuid[]) AND status = 'OPEN'`,
            [b.consume_carry_forward_ids, stlNo]);
        }
        return headRow;
      });

      // A carry-forward moves no money, so it posts nothing. Only a POSTED
      // settlement credits the driver what they earned.
      let voucher = null;
      let ledgerNote = null;
      const earned = Number(b.earned_total ?? 0);
      if (b.mode === 'POSTED' && earned > 0) {
        await query(
          `INSERT INTO driver_transactions
             (driver_id, driver_name, txn_date, txn_type, amount, mode, remarks)
           VALUES ($1::uuid, $2, CURRENT_DATE, 'SALARY_CREDIT', $3, 'Settlement', $4)`,
          [b.driver_id ?? null, b.driver_name, earned,
           `[${created.settlement_no}] ${b.trip_ids.length} trip(s) - bhatta ${(b.total_allowance ?? 0).toFixed(2)} + extra ${(b.total_extra ?? 0).toFixed(2)}`]);

        // Dr the expense, Cr the driver - the bhatta is now owed to them. Posted
        // through TARA so the deferred balance constraint applies. A failure here
        // leaves the settlement recorded and SAYS SO, rather than silently
        // dropping the ledger leg the way the Firestore version did.
        try {
          voucher = await postVoucher({
            type: 'JOURNAL',
            company_id: stlCompanyId,
            branch_id: stlBranchId,
            lines: [
              { ledger: 'Trip Allowance & Bhatta', dr_cr: 'DR', amount: earned, group: 'Direct Expenses - Driver & Trip' },
              { ledger: `Driver Advance: ${b.driver_name}`, dr_cr: 'CR', amount: earned, group: 'Current Assets - Driver Advances' },
            ],
            source_type: 'DRIVER_SETTLEMENT',
            ref_no: created.settlement_no,
            narration: `Driver settlement ${created.settlement_no}: ${b.trip_ids.length} trip(s) of ${b.vehicle_no ?? b.driver_name} (bhatta + extra)`,
            created_by: b.created_by ?? null,
          });
          await query('UPDATE driver_settlements SET voucher_id = $2::uuid WHERE id = $1::uuid',
            [created.id, voucher.voucher_id]);
        } catch (err) {
          ledgerNote = err.code === 'DUPLICATE_REF'
            ? 'a journal for this settlement number is already posted'
            : `journal not posted: ${err.message}`;
        }
        await drain().catch(() => {});
      }

      reply.code(201);
      return {
        created: true,
        settlement: { ...created, voucher_id: voucher ? voucher.voucher_id : created.voucher_id },
        voucher_id: voucher ? voucher.voucher_id : null,
        ledger_note: ledgerNote,
      };
    }
  );

}
