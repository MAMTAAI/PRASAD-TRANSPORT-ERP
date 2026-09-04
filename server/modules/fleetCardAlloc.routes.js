// server/modules/fleetCardAlloc.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Allocation — mounted under /api/v1/fleet-card by fleetCard.routes.js.
//
// A SWIPE IS ALLOCATED, NOT MATCHED. The owner's rule (4-Sep-2026): a card
// swipe is often used to pay off an accumulated 15-day pump credit bill, not a
// single trip memo. So one swipe may be spread across a fortnight of bills, and
// forcing it onto the nearest memo would put the diesel on the wrong lorry AND
// count it twice — the memo already recorded the expense when the pump gave
// credit; the swipe that later settles that bill is a payment, not a purchase.
//
// What a machine may do is therefore small and exact, and everything else waits
// in a queue for a person. Nothing here posts to a ledger; see migration 152.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { emit } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

export async function registerFleetCardAllocationRoutes(app) {
  /** The Pending Manual Match queue. */
  app.get(
    '/unallocated',
    { schema: { querystring: { type: 'object', properties: {
      provider: { type: ['string', 'null'], maxLength: 8 },
      company:  { type: ['string', 'null'], maxLength: 120 },
      reason:   { type: ['string', 'null'], maxLength: 30 },
      vehicle:  { type: ['string', 'null'], maxLength: 20 },
      cycle:    { type: ['string', 'null'], maxLength: 12 },
      from:     { type: ['string', 'null'], format: 'date' },
      to:       { type: ['string', 'null'], format: 'date' },
      limit:    { type: 'integer', minimum: 1, maximum: 1000, default: 10 },
      offset:   { type: 'integer', minimum: 0, default: 0 },
      search:   { type: ['string', 'null'], maxLength: 60 },
      sort:     { type: ['string', 'null'], maxLength: 20 },
      dir:      { type: ['string', 'null'], enum: ['asc', 'desc', null] },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query;
      const where = [];
      const p = [];
      const add = (sql, val) => { p.push(val); where.push(sql.replace('?', `$${p.length}`)); };
      if (q.provider) add('provider = ?', q.provider);
      if (q.company)  add('operating_company = ?', q.company);
      if (q.reason)   add('reason = ?', q.reason);
      if (q.vehicle)  add('reg_key(COALESCE(vehicle_no, vehicle_raw)) = reg_key(?)', q.vehicle);
      if (q.from)     add('txn_date >= ?::date', q.from);
      if (q.to)       add('txn_date <= ?::date', q.to);
      // "HAR BIL KA SYKEL 15 DAY KA HAY" — the pump bills 1–15 and 16–end, so
      // the queue can be worked one billing cycle at a time.
      if (q.cycle)    add('cycle = ?', q.cycle);
      // Free text over the columns a clerk actually squints at. Server-side so
      // it searches the whole queue, not the ten rows the page is holding.
      if (q.search) {
        p.push(`%${q.search.trim()}%`);
        where.push(`(COALESCE(vehicle_no,'') ILIKE $${p.length}
                  OR COALESCE(vehicle_raw,'') ILIKE $${p.length}
                  OR COALESCE(merchant_name,'') ILIKE $${p.length}
                  OR COALESCE(account_no,'') ILIKE $${p.length})`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // SORT COLUMNS ARE WHITELISTED, never interpolated from the request. The
      // sort key arrives from a clickable header, and a header is still user
      // input — an ORDER BY built from a string is a SQL injection with extra
      // steps.
      const SORTABLE = {
        txn_date: 'txn_date', amount: 'amount', unallocated: 'unallocated', cycle: 'cycle',
        quantity: 'quantity', vehicle: 'COALESCE(vehicle_no, vehicle_raw)',
        merchant: 'merchant_name', reason: 'reason',
      };
      const col = SORTABLE[q.sort] ?? 'txn_date';
      const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
      // Newest first is the default the owner asked for, and the second key
      // keeps paging stable when many swipes share a date — without it, rows
      // shuffle between page 1 and page 2 and a clerk sees the same swipe twice.
      const order = `${col} ${dir} NULLS LAST, txn_date DESC, txn_id`;

      const { rows } = await query(
        `SELECT * FROM v_fleet_card_unallocated ${clause}
          ORDER BY ${order}
          LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
        [...p, q.limit ?? 10, q.offset ?? 0]);

      // The totals cover the WHOLE filtered set, not the page. A queue that
      // says "200 waiting" when 995 are waiting is worse than no number.
      const { rows: [tot] } = await query(
        `SELECT count(*)::int rows, COALESCE(sum(unallocated),0)::numeric(16,2) amount
           FROM v_fleet_card_unallocated ${clause}`, p);

      // The reason chips count the queue WITHOUT the reason filter — otherwise
      // clicking "15-din bill settlement" makes every other chip read (0) and
      // the clerk cannot see what else is waiting or click back out to it.
      const chipWhere = [];
      const cp = [];
      const cadd = (sql, val) => { cp.push(val); chipWhere.push(sql.replace('?', `$${cp.length}`)); };
      if (q.provider) cadd('provider = ?', q.provider);
      if (q.company)  cadd('operating_company = ?', q.company);
      if (q.vehicle)  cadd('reg_key(COALESCE(vehicle_no, vehicle_raw)) = reg_key(?)', q.vehicle);
      if (q.cycle)    cadd('cycle = ?', q.cycle);
      if (q.from)     cadd('txn_date >= ?::date', q.from);
      if (q.to)       cadd('txn_date <= ?::date', q.to);
      if (q.search) {
        cp.push(`%${q.search.trim()}%`);
        chipWhere.push(`(COALESCE(vehicle_no,'') ILIKE $${cp.length}
                      OR COALESCE(vehicle_raw,'') ILIKE $${cp.length}
                      OR COALESCE(merchant_name,'') ILIKE $${cp.length}
                      OR COALESCE(account_no,'') ILIKE $${cp.length})`);
      }
      const chipClause = chipWhere.length ? `WHERE ${chipWhere.join(' AND ')}` : '';

      const { rows: byReason } = await query(
        `SELECT reason, count(*)::int rows, sum(unallocated)::numeric(16,2) amount
           FROM v_fleet_card_unallocated ${chipClause}
          GROUP BY reason ORDER BY 3 DESC`, cp);

      const { rows: [all] } = await query(
        `SELECT count(*)::int rows, COALESCE(sum(unallocated),0)::numeric(16,2) amount
           FROM v_fleet_card_unallocated ${chipClause}`, cp);

      return {
        queue: rows,
        total: tot,            // matches the filters actually applied
        unfiltered: all,       // the same set before the reason chip
        by_reason: byReason,
        shown: rows.length,
        page: {
          limit: q.limit ?? 10,
          offset: q.offset ?? 0,
          pages: Math.max(1, Math.ceil(Number(tot.rows) / (q.limit ?? 10))),
          sort: q.sort ?? 'txn_date',
          dir: q.dir ?? 'desc',
        },
      };
    }
  );

  /**
   * Vehicle-wise and card-wise, over a date range.
   *
   * Both cuts come from ONE query each rather than the screen adding up rows it
   * happens to have fetched — a page showing 300 of 1,086 swipes would
   * otherwise report a lorry's diesel as a third of what it was.
   *
   * A lorry the card names but the fleet master does not know still gets a row,
   * keyed on the raw registration. Dropping it would hide ₹29.7 lakh of the
   * BPCL pooled card, which is the largest single thing on this screen.
   */
  app.get(
    '/breakdown',
    { schema: { querystring: { type: 'object', properties: {
      from:     { type: ['string', 'null'], format: 'date' },
      to:       { type: ['string', 'null'], format: 'date' },
      provider: { type: ['string', 'null'], maxLength: 8 },
      limit:    { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const from = req.query.from ?? '2026-04-01';
      const to   = req.query.to   ?? '2026-09-01';
      const prov = req.query.provider || null;

      const { rows: vehicles } = await query(`
        SELECT COALESCE(x.vehicle_no, x.vehicle_raw)        AS vehicle,
               (x.vehicle_no IS NOT NULL)                   AS in_fleet,
               count(*)::int                                AS swipes,
               COALESCE(sum(x.quantity), 0)::numeric(14,3)  AS litres,
               COALESCE(sum(x.amount), 0)::numeric(16,2)    AS amount,
               COALESCE(sum(al.placed), 0)::numeric(16,2)   AS allocated,
               (COALESCE(sum(x.amount), 0) - COALESCE(sum(al.placed), 0))::numeric(16,2)
                                                            AS pending,
               min(x.txn_date)                              AS first_swipe,
               max(x.txn_date)                              AS last_swipe,
               count(DISTINCT x.merchant_name)::int         AS pumps,
               -- Rate the lorry actually paid across the window. A lorry well
               -- off the fleet average is either a different fuel or a
               -- different story, and either is worth a look.
               CASE WHEN sum(x.quantity) > 0
                    THEN (sum(x.amount) / sum(x.quantity))::numeric(10,2) END AS avg_rate,
               string_agg(DISTINCT a.provider, '/' ORDER BY a.provider) AS providers
          FROM fleet_card_statement_txns x
          JOIN fleet_card_accounts a ON a.id = x.account_id
          LEFT JOIN LATERAL (
            SELECT sum(al2.amount) AS placed FROM fleet_card_allocations al2
             WHERE al2.txn_id = x.id) al ON true
         WHERE x.kind = 'SALE' AND x.unit = 'INR'
           AND x.txn_date BETWEEN $1::date AND $2::date
           AND ($3::text IS NULL OR a.provider = $3)
         GROUP BY 1, 2
         ORDER BY amount DESC
         LIMIT $4`, [from, to, prov, req.query.limit ?? 200]);

      const { rows: cards } = await query(`
        SELECT a.id AS account_id, a.provider, a.account_no, a.account_name,
               a.operating_company, a.clearing_ledger,
               COALESCE(sum(x.amount) FILTER (WHERE x.kind='SALE'  AND x.unit='INR'), 0)::numeric(16,2) AS diesel,
               COALESCE(sum(x.quantity) FILTER (WHERE x.kind='SALE' AND x.unit='INR'), 0)::numeric(14,3) AS litres,
               count(*) FILTER (WHERE x.kind='SALE' AND x.unit='INR')::int                              AS swipes,
               COALESCE(sum(x.amount) FILTER (WHERE x.kind='RECHARGE' AND x.unit='INR'), 0)::numeric(16,2) AS recharged,
               COALESCE(sum(x.amount) FILTER (WHERE x.kind='OTHER' AND x.unit='INR'), 0)::numeric(16,2)  AS wallet_settlement,
               count(DISTINCT COALESCE(x.vehicle_no, x.vehicle_raw))::int                               AS vehicles
          FROM fleet_card_accounts a
          LEFT JOIN fleet_card_statement_txns x
            ON x.account_id = a.id AND x.txn_date BETWEEN $1::date AND $2::date
         WHERE ($3::text IS NULL OR a.provider = $3)
         GROUP BY a.id, a.provider, a.account_no, a.account_name,
                  a.operating_company, a.clearing_ledger
         ORDER BY diesel DESC`, [from, to, prov]);

      // Allocation state per card, over the same window.
      const { rows: placed } = await query(`
        SELECT x.account_id,
               COALESCE(sum(al.placed), 0)::numeric(16,2) AS allocated
          FROM fleet_card_statement_txns x
          LEFT JOIN LATERAL (
            SELECT sum(al2.amount) AS placed FROM fleet_card_allocations al2
             WHERE al2.txn_id = x.id) al ON true
         WHERE x.kind = 'SALE' AND x.unit = 'INR'
           AND x.txn_date BETWEEN $1::date AND $2::date
         GROUP BY 1`, [from, to]);
      const placedBy = new Map(placed.map((p) => [p.account_id, Number(p.allocated)]));
      for (const c of cards) {
        c.allocated = placedBy.get(c.account_id) ?? 0;
        c.pending = Number(c.diesel) - c.allocated;
      }

      return {
        period: { from, to },
        vehicles,
        cards,
        totals: {
          vehicles: vehicles.length,
          swipes: vehicles.reduce((s, v) => s + Number(v.swipes), 0),
          litres: vehicles.reduce((s, v) => s + Number(v.litres), 0),
          amount: vehicles.reduce((s, v) => s + Number(v.amount), 0),
          pending: vehicles.reduce((s, v) => s + Number(v.pending), 0),
        },
      };
    }
  );

  /**
   * The 15-day cycles that still have money waiting, for the filter.
   *
   * Each carries what the pumps are owed for the SAME cycle beside it, so the
   * dropdown is not just a date list — it says "Aug 1–15: 84 swipes waiting,
   * ₹6.2L, and 3 open bills worth ₹4.1L", which is the whole decision.
   */
  app.get('/cycles', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM v_fleet_card_cycles ORDER BY cycle DESC`);
    return { cycles: rows };
  });

  /**
   * Every pump bill that still has something due, newest cycle first.
   *
   * Independent of any swipe, because "what do we still owe the pumps" is a
   * question on its own — and because the answer (₹54.4 lakh over 49 bills)
   * frames every allocation made on this screen.
   */
  app.get(
    '/pump-bills',
    { schema: { querystring: { type: 'object', properties: {
      cycle:  { type: ['string', 'null'], maxLength: 12 },
      vendor: { type: ['string', 'null'], maxLength: 120 },
      open:   { type: 'boolean', default: true },
      limit:  { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query;
      const { rows } = await query(`
        SELECT * FROM v_pump_bill_outstanding
         WHERE ($1::text IS NULL OR cycle = $1)
           AND ($2::text IS NULL OR vendor_key = pump_key($2))
           AND ($3::boolean IS NOT TRUE OR due > 0.005)
         ORDER BY period_to DESC, vendor_name
         LIMIT $4`, [q.cycle ?? null, q.vendor ?? null, q.open !== false, q.limit ?? 100]);
      const { rows: [tot] } = await query(`
        SELECT count(*)::int bills,
               COALESCE(sum(billed),0)::numeric(16,2) billed,
               COALESCE(sum(paid),0)::numeric(16,2)   paid,
               COALESCE(sum(due),0)::numeric(16,2)    due
          FROM v_pump_bill_outstanding WHERE due > 0.005`);
      return { bills: rows, outstanding: tot };
    }
  );

  /**
   * Settle a pump's whole cycle: apply every swipe still waiting at that pump
   * in that bill's window against the bill, oldest first, up to the due.
   *
   * THIS IS THE ONE THAT CLEARS THE BACKLOG, and it is deliberately two calls.
   * `commit: false` (the default) returns exactly what it would do and writes
   * nothing; a person reads that list and calls again with commit: true. A
   * button that moves ₹6 lakh of creditor balance on one click, with no
   * preview, is not a button — it is an accident waiting for a slow afternoon.
   */
  app.post(
    '/settle-cycle',
    { schema: { body: { type: 'object', required: ['bill_id'], properties: {
      bill_id: { type: 'string', format: 'uuid' },
      commit:  { type: 'boolean', default: false },
      by:      { type: ['string', 'null'], maxLength: 80 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [bill] } = await query(
        `SELECT * FROM v_pump_bill_outstanding WHERE id = $1::uuid`, [b.bill_id]);
      if (!bill) return reply.code(404).send({ error: 'NO_SUCH_BILL' });
      if (Number(bill.due) <= 0.005) {
        return reply.code(409).send({
          error: 'ALREADY_SETTLED',
          detail: `${bill.vendor_name} ${bill.ref_no} is already fully settled`,
        });
      }

      const by = b.by ?? req.user?.name ?? 'desk';
      const { rows: plan } = await query(
        `SELECT *, to_char(txn_date, 'YYYY-MM-DD') AS date_text
           FROM fleet_card_settle_cycle($1::uuid, $2, $3)`,
        [b.bill_id, by, !b.commit]);

      const applied = plan.reduce((s, r) => s + Number(r.applied), 0);

      if (b.commit) {
        const { rows: [after] } = await query(
          `SELECT due FROM v_pump_bill_outstanding WHERE id = $1::uuid`, [b.bill_id]);
        try {
          await emit('pump.balance.reconciled', {
            aggregate: 'pump_bill',
            aggregateId: b.bill_id,
            emittedBy: null,
            payload: {
              source: 'fleet_card_settle_cycle',
              vendor: bill.vendor_name,
              cycle: bill.cycle,
              swipes: plan.length,
              applied,
              still_due: Number(after?.due ?? 0),
              settled_by: by,
            },
          });
        } catch (e) {
          req.log.warn({ err: e.message, bill: b.bill_id }, 'cycle settled, event not emitted');
        }
        return {
          committed: true,
          bill: { ...bill, due: Number(after?.due ?? 0) },
          swipes: plan.length,
          applied,
          lines: plan,
          posted_to_ledger: false,
          posting_note: 'handed to TARA — the voucher appears on the approval desk',
        };
      }

      return {
        committed: false,
        bill,
        swipes: plan.length,
        applied,
        would_leave_due: Number(bill.due) - applied,
        lines: plan,
        note: plan.length === 0
          ? 'no swipe is waiting at this pump inside this bill\'s window'
          : `${plan.length} swipe(s) would be applied, oldest first`,
      };
    }
  );

  /**
   * The exact-match pass for bills: a swipe that equals a bill's outstanding
   * to the paisa, at the same pump, inside its window.
   */
  app.post('/auto-settle-bills', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [r] } = await query(`SELECT * FROM fleet_card_auto_settle_bills()`);
    const { rows: [out] } = await query(
      `SELECT count(*)::int bills, COALESCE(sum(due),0)::numeric(16,2) due
         FROM v_pump_bill_outstanding WHERE due > 0.005`);
    return {
      settled: Number(r.settled),
      skipped_ambiguous: Number(r.skipped_ambiguous),
      still_outstanding: out,
      rule: 'swipe equals the bill\'s outstanding exactly, same pump, inside the bill window',
      note: Number(r.settled) === 0
        ? 'nothing matched to the paisa — a fortnight\'s bill is usually settled by '
        + 'several swipes, not one, so this rule places little. Use Settle cycle.'
        : null,
    };
  });

  /** What is sitting in clearing, per firm. */
  app.get('/clearing', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM v_fleet_card_clearing ORDER BY operating_company`);
    return { clearing: rows };
  });

  /**
   * What this swipe could be put against.
   *
   * Ranked, never chosen. Three kinds of candidate, because there are three
   * real answers: a fortnightly pump bill whose window the swipe falls in (the
   * settlement case), a memo on that lorry around that date, and a slip still
   * parked in the fuel import review — which is where 454 of this firm's memos
   * are sitting, and a large part of why so many swipes look memo-less when the
   * memo does in fact exist.
   */
  app.get(
    '/candidates/:txnId',
    { schema: { params: { type: 'object', required: ['txnId'],
      properties: { txnId: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [txn] } = await query(
        `SELECT * FROM v_fleet_card_unallocated WHERE txn_id = $1::uuid`, [req.params.txnId]);
      if (!txn) {
        return reply.code(404).send({
          error: 'NOT_IN_QUEUE',
          detail: 'this swipe is either fully allocated already or is not a diesel sale',
        });
      }

      // OUTSTANDING PUMP BILLS FOR THIS PUMP — the section the owner asked to be
      // prominent, and the one that answers what this swipe most likely is.
      //
      // Matched on pump_key, so "BN FILLING STATION BHARAT PETROLEUM DEALERS"
      // on the card meets "B N FILLING STATION" on the bill. The window runs to
      // period_to + 25 because a bill is settled AFTER its fortnight closes,
      // not during it.
      //
      // `same_pump` separates the two kinds of row: this pump's bills first,
      // then other pumps' bills in the same window, because a clerk sometimes
      // needs the second and should never be shown it as if it were the first.
      const { rows: bills } = await query(`
        SELECT b.id, b.vendor_name, b.ref_no, b.period_from, b.period_to, b.half, b.status,
               b.cycle, b.cycle_label, b.slip_count,
               b.billed, b.paid AS already_paid, b.due AS still_due,
               (b.vendor_key = pump_key($2)) AS same_pump
          FROM v_pump_bill_outstanding b
         WHERE $1::date BETWEEN b.period_from AND b.period_to + 25
           AND b.due > 0.005
         ORDER BY (b.vendor_key = pump_key($2)) DESC, b.period_to DESC
         LIMIT 25`, [txn.txn_date, txn.merchant_name ?? '']);

      const { rows: memos } = txn.vehicle_no ? await query(`
        SELECT f.id, f.entry_date, f.memo_no, f.vendor_name, f.liters, f.amount, f.trip_id,
               t.trip_code,
               (f.liters = $2 AND f.amount = $3) AS exact,
               EXISTS (SELECT 1 FROM fleet_card_allocations a
                        WHERE a.target_kind IN ('FUEL_ENTRY','TRIP')
                          AND a.target_id IN (f.id, f.trip_id)) AS already_claimed
          FROM fuel_entries f
          LEFT JOIN trips t ON t.id = f.trip_id
         WHERE reg_key(f.vehicle_no) = reg_key($1)
           AND f.entry_date BETWEEN $4::date - 7 AND $4::date + 7
         ORDER BY abs(f.entry_date - $4::date), f.entry_date
         LIMIT 25`, [txn.vehicle_no, txn.quantity, txn.amount, txn.txn_date])
        : { rows: [] };

      const { rows: parked } = await query(`
        SELECT r.id, r.entry_date, r.memo_no, r.pump, r.vehicle_raw, r.qty, r.amount, r.reasons
          FROM fuel_import_review r
         WHERE r.status = 'PENDING'
           AND r.entry_date BETWEEN $1::date - 7 AND $1::date + 7
           AND ($2::text IS NULL OR reg_key(r.vehicle_raw) = reg_key($2))
         ORDER BY abs(r.entry_date - $1::date)
         LIMIT 25`, [txn.txn_date, txn.vehicle_no]);

      // ── THE CYCLE THIS SWIPE BELONGS TO ──────────────────────────────────
      //
      // Everything else still waiting at the SAME pump in the SAME fortnight.
      // This is the context that makes a bulk settlement obvious: a clerk
      // looking at one ₹7,776 swipe cannot tell it is one of 34 that together
      // make up a ₹2.1 lakh bill. Shown as a total and a short list, not all of
      // them — the point is the size of the pile, not every row in it.
      const { rows: [sib] } = await query(`
        SELECT count(*)::int swipes,
               COALESCE(sum(unallocated), 0)::numeric(16,2) AS unallocated,
               count(DISTINCT COALESCE(vehicle_no, vehicle_raw))::int AS lorries
          FROM v_fleet_card_unallocated
         WHERE cycle = $1
           AND merchant_key = pump_key($2)
           AND txn_id <> $3::uuid`, [txn.cycle, txn.merchant_name ?? '', txn.txn_id]);

      const { rows: siblings } = await query(`
        SELECT txn_id, txn_date, COALESCE(vehicle_no, vehicle_raw) AS vehicle,
               quantity, unallocated, reason
          FROM v_fleet_card_unallocated
         WHERE cycle = $1
           AND merchant_key = pump_key($2)
           AND txn_id <> $3::uuid
         ORDER BY txn_date
         LIMIT 8`, [txn.cycle, txn.merchant_name ?? '', txn.txn_id]);

      // Memos at that pump in the same cycle that no swipe has claimed — the
      // diesel side of the same fortnight.
      const { rows: cycleMemos } = await query(`
        SELECT f.id, f.entry_date, f.memo_no, f.vehicle_no, f.liters, f.amount
          FROM fuel_entries f
         WHERE pump_key(f.vendor_name) = pump_key($2)
           AND f.entry_date BETWEEN $3::date AND $4::date
           AND NOT EXISTS (SELECT 1 FROM fleet_card_allocations a
                            WHERE a.target_kind IN ('FUEL_ENTRY','TRIP')
                              AND a.target_id IN (f.id, f.trip_id))
         ORDER BY f.entry_date
         LIMIT 10`, [txn.cycle, txn.merchant_name ?? '', txn.cycle_from, txn.cycle_to]);

      return {
        txn,
        candidates: { pump_bills: bills, memos, parked_slips: parked },
        cycle: {
          code: txn.cycle,
          label: txn.cycle_label,
          from: txn.cycle_from,
          to: txn.cycle_to,
          other_swipes: sib,
          swipes: siblings,
          unbilled_memos: cycleMemos,
        },
      };
    }
  );

  /** What a swipe has already been put against. */
  app.get(
    '/allocations',
    { schema: { querystring: { type: 'object', properties: {
      txn_id: { type: ['string', 'null'], format: 'uuid' },
      limit:  { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT * FROM v_fleet_card_allocation_detail
           WHERE ($1::uuid IS NULL OR txn_id = $1::uuid)
           ORDER BY created_at DESC LIMIT $2`,
        [req.query.txn_id ?? null, req.query.limit ?? 100]);
      return { allocations: rows };
    }
  );

  /**
   * Place a swipe, or part of one.
   *
   * The over-allocation guard is in the database, not here: two clerks working
   * the same swipe is the ordinary case and only the database sees both. A
   * refusal returns 409 OVER_ALLOCATION carrying how much room is actually
   * left, so the screen can say it.
   */
  app.post(
    '/allocations',
    { schema: { body: { type: 'object', required: ['txn_id', 'target_kind', 'amount'], properties: {
      txn_id:       { type: 'string', format: 'uuid' },
      target_kind:  { type: 'string', enum: ['TRIP','FUEL_ENTRY','PUMP_BILL','REVIEW_SLIP','WRITE_OFF'] },
      target_id:    { type: ['string', 'null'], format: 'uuid' },
      amount:       { type: 'number', exclusiveMinimum: 0 },
      note:         { type: ['string', 'null'], maxLength: 400 },
      allocated_by: { type: ['string', 'null'], maxLength: 80 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      if (b.target_kind === 'WRITE_OFF' && !b.note) {
        // A write-off with no reason is an unexplained hole in the books, and
        // nobody will ever chase it again. The reason is the whole record.
        return reply.code(400).send({
          error: 'REASON_REQUIRED',
          detail: 'a write-off has to say why — nobody will chase this money again',
        });
      }
      if (b.target_kind !== 'WRITE_OFF' && !b.target_id) {
        return reply.code(400).send({
          error: 'TARGET_REQUIRED',
          detail: `a ${b.target_kind} allocation must name what it is being put against`,
        });
      }

      const { rows } = await query(`
        INSERT INTO fleet_card_allocations
          (txn_id, target_kind, target_id, amount, method, allocated_by, note)
        VALUES ($1::uuid, $2, $3::uuid, $4, 'MANUAL', $5, $6)
        RETURNING *`,
        [b.txn_id, b.target_kind, b.target_kind === 'WRITE_OFF' ? null : b.target_id,
         b.amount, b.allocated_by ?? req.user?.name ?? 'desk', b.note ?? null]);

      const { rows: [left] } = await query(
        `SELECT unallocated FROM v_fleet_card_unallocated WHERE txn_id = $1::uuid`, [b.txn_id]);
      const stillUnallocated = Number(left?.unallocated ?? 0);

      // ── the hand-off ──────────────────────────────────────────────────────
      //
      // The allocation is recorded; the VOUCHER is not written here. Posting
      // needs one thing this endpoint cannot supply without guessing: which
      // ledger to debit. Dr Clearing / Cr Card Wallet is the same for every
      // swipe, but the second leg is not — a PUMP_BILL settles that pump's
      // creditor account, a TRIP debits that trip's fuel expense, and naming
      // the wrong one is how migration 031's second wallet happened.
      //
      // So the event goes out and TARA posts it under approval, like every
      // other rupee in this system. A swipe placed here shows as cleared on
      // this screen and as a pending voucher on the approval desk — never as a
      // ledger entry nobody reviewed.
      if (stillUnallocated <= 0.005) {
        try {
          await emit('pump.balance.reconciled', {
            aggregate: 'fleet_card_txn',
            aggregateId: b.txn_id,
            emittedBy: null,          // raised by the desk, not by an agent
            payload: {
              source: 'fleet_card_allocation',
              target_kind: b.target_kind,
              target_id: b.target_kind === 'WRITE_OFF' ? null : b.target_id,
              amount: b.amount,
              allocated_by: rows[0].allocated_by,
              note: b.note ?? null,
            },
          });
        } catch (e) {
          // The allocation is already saved and is the record that matters. A
          // failed event is reported, not rolled back — losing the clerk's work
          // because a queue insert failed would be the worse outcome.
          req.log.warn({ err: e.message, txn: b.txn_id }, 'allocation saved, event not emitted');
        }
      }

      reply.code(201);
      // No row left in the queue means the swipe is fully placed — say 0
      // rather than null, so the screen does not have to guess.
      return {
        allocation: rows[0],
        still_unallocated: stillUnallocated,
        posted_to_ledger: false,
        posting_note: stillUnallocated <= 0.005
          ? 'handed to TARA — the voucher appears on the approval desk, not straight in the ledger'
          : null,
      };
    }
  );

  /** Undo one. The swipe returns to the queue with that much put back. */
  app.delete(
    '/allocations/:id',
    { schema: { params: { type: 'object', required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `DELETE FROM fleet_card_allocations WHERE id = $1::uuid
          RETURNING txn_id, amount, target_kind`, [req.params.id]);
      if (!rows.length) return reply.code(404).send({ error: 'NO_SUCH_ALLOCATION' });
      return { removed: rows[0] };
    }
  );

  /**
   * Run the exact-match pass.
   *
   * The only allocation a machine makes here: same lorry, date within a day,
   * litres AND rupees exactly equal, and the memo claimed by nobody else.
   * Anything short of that stays in the queue by design — a 2% tolerance is a
   * machine guessing, and it produced 277 "nearly" matches a person still had
   * to look at.
   */
  app.post(
    '/auto-allocate',
    { schema: { body: { type: ['object', 'null'], properties: {
      account_id: { type: ['string', 'null'], format: 'uuid' },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [r] } = await query(
        `SELECT * FROM fleet_card_auto_allocate($1::uuid)`, [req.body?.account_id ?? null]);
      const { rows: [left] } = await query(
        `SELECT count(*)::int rows, COALESCE(sum(unallocated),0)::numeric(16,2) amount
           FROM v_fleet_card_unallocated`);
      return {
        allocated: Number(r.allocated),
        skipped_ambiguous: Number(r.skipped_ambiguous),
        still_waiting: left,
        rule: 'same lorry, date within a day, litres and amount exactly equal, memo unclaimed',
      };
    }
  );
}
