// server/modules/fleetCard.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/fleet-card — the three oil companies' cards, as they keep them.
//
// There is no API at any of IOCL, BPCL or HPCL. A human logs into the portal and
// downloads a CSV, so this module's job is to take that file and make it
// countable: parse it per provider, store every row as exported under the
// provider's own id, and report the position per company.
//
// RE-IMPORTING IS THE NORMAL CASE, NOT THE EXCEPTION. The exports are re-pulled
// whenever anyone wants a fresher number, and the same fortnight will be in five
// different downloads. Every insert is ON CONFLICT DO NOTHING against
// (account, provider txn id, kind), so a re-import converges and reports how
// many rows it already had.
//
// NOTHING HERE POSTS TO A LEDGER. This is evidence: what the oil company says
// happened. Settling it against a pump's bill is a separate, deliberate act.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { parseFleetCardCsv } from '../lib/fleetCardImport.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

export async function registerFleetCardRoutes(app) {
  // ── The accounts ──────────────────────────────────────────────────────────
  app.get('/accounts', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM v_fleet_card_position ORDER BY operating_company, provider`);
    return { count: rows.length, accounts: rows };
  });

  // Creating an account is how a card portal is first connected. The operating
  // company is set HERE and inherited by every row imported under it — a swipe
  // on the wrong company's card is a swipe on the wrong company's P&L.
  app.post(
    '/accounts',
    { schema: { body: { type: 'object', required: ['provider', 'account_no', 'account_name'], properties: {
      provider: { type: 'string', enum: ['IOCL', 'BPCL', 'HPCL'] },
      account_no: { type: 'string', minLength: 3, maxLength: 40 },
      account_name: { type: 'string', minLength: 2, maxLength: 120 },
      operating_company: { type: ['string', 'null'], maxLength: 120 },
      wallet_ledger: { type: ['string', 'null'], maxLength: 160 },
      pan: { type: ['string', 'null'], maxLength: 20 },
      portal_balance: { type: ['number', 'null'] },
      notes: { type: ['string', 'null'], maxLength: 400 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows } = await query(`
        INSERT INTO fleet_card_accounts
          (provider, account_no, account_name, operating_company, wallet_ledger, pan,
           portal_balance, portal_balance_at, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::numeric IS NULL THEN NULL ELSE now() END, $8)
        ON CONFLICT (provider, account_no) DO UPDATE SET
          account_name      = EXCLUDED.account_name,
          operating_company = COALESCE(EXCLUDED.operating_company, fleet_card_accounts.operating_company),
          wallet_ledger     = COALESCE(EXCLUDED.wallet_ledger, fleet_card_accounts.wallet_ledger),
          pan               = COALESCE(EXCLUDED.pan, fleet_card_accounts.pan),
          portal_balance    = COALESCE(EXCLUDED.portal_balance, fleet_card_accounts.portal_balance),
          portal_balance_at = COALESCE(EXCLUDED.portal_balance_at, fleet_card_accounts.portal_balance_at),
          notes             = COALESCE(EXCLUDED.notes, fleet_card_accounts.notes)
        RETURNING *`,
        [b.provider, String(b.account_no).trim(), b.account_name, b.operating_company ?? null,
         b.wallet_ledger ?? null, b.pan ?? null, b.portal_balance ?? null, b.notes ?? null]);
      reply.code(201);
      return { saved: true, account: rows[0] };
    }
  );

  // ── The import ────────────────────────────────────────────────────────────
  //
  // The file decides which provider it is; the caller does not get to say. An
  // operator who picks the wrong provider in a dropdown would otherwise import
  // 324 sales as credits, and the money would flow the wrong way through the
  // card with nothing to show it had.
  app.post(
    '/import',
    { schema: { body: { type: 'object', required: ['csv'], properties: {
      csv: { type: 'string', minLength: 40, maxLength: 40_000_000 },
      source_file: { type: ['string', 'null'], maxLength: 200 },
      // Only used when the export's own preamble does not carry the account —
      // BPCL's sales file, for one, omits the period but names the account.
      account_no: { type: ['string', 'null'], maxLength: 40 },
      created_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;

      let parsed;
      try {
        parsed = parseFleetCardCsv(b.csv, { account_no: b.account_no ?? null });
      } catch (e) {
        // A file we cannot read is refused with the reason. Guessing at the
        // columns is how wrong money gets imported silently.
        return reply.code(400).send({ error: e.code ?? 'PARSE_FAILED', detail: e.message });
      }

      const accountNo = parsed.account_no ?? b.account_no;
      if (!accountNo) {
        return reply.code(400).send({
          error: 'NO_ACCOUNT',
          detail: 'this export does not name its account — pass account_no with the upload',
        });
      }
      const { rows: acc } = await query(
        `SELECT id, operating_company FROM fleet_card_accounts WHERE provider = $1 AND account_no = $2`,
        [parsed.provider, String(accountNo).trim()]);
      if (!acc.length) {
        return reply.code(404).send({
          error: 'ACCOUNT_NOT_SET_UP',
          detail: `${parsed.provider} account ${accountNo} is not connected yet — add it first, `
                + 'so its operating company is decided before any money lands under it',
        });
      }
      const accountId = acc[0].id;

      const out = await withTransaction(async (t) => {
        const { rows: [batch] } = await t.query(`
          INSERT INTO fleet_card_import_batches
            (account_id, provider, source_file, period_from, period_to, rows_read, created_by)
          VALUES ($1,$2,$3,$4::date,$5::date,$6,$7) RETURNING id`,
          [accountId, parsed.provider, b.source_file ?? null,
           parsed.period_from ?? null, parsed.period_to ?? null, parsed.rows.length,
           b.created_by ?? null]);

        let fresh = 0;
        let parked = 0;
        for (const r of parsed.rows) {
          if (!r.txn_date || !r.provider_txn_id) { parked += 1; continue; }
          const { rows } = await t.query(`
            INSERT INTO fleet_card_statement_txns
              (account_id, provider, provider_txn_id, txn_date, settlement_date, kind,
               provider_txn_type, direction, card_pan, vehicle_raw, vehicle_no, vehicle_id,
               merchant_name, merchant_code, location, product, quantity, rate, amount, unit,
               balance_after, status, source_doc_no, raw, import_batch_id, source_file)
            SELECT $1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,
                   -- The lorry as OUR fleet spells it, matched on the same
                   -- normalisation the database uses everywhere else. A
                   -- registration the fleet master has never heard of stays
                   -- NULL and shows up as a finding rather than a guess.
                   v.vehicle_no, v.id,
                   $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24
              FROM (SELECT 1) _
              LEFT JOIN LATERAL (
                SELECT id, vehicle_no FROM vehicles
                 WHERE reg_key(vehicle_no) = reg_key($10) LIMIT 1) v ON true
            ON CONFLICT (account_id, provider_txn_id, kind) DO NOTHING
            RETURNING id`,
            [accountId, parsed.provider, r.provider_txn_id, r.txn_date, r.settlement_date,
             r.kind, r.provider_txn_type, r.direction, r.card_pan, r.vehicle_raw,
             r.merchant_name, r.merchant_code, r.location, r.product, r.quantity, r.rate,
             r.amount, r.unit ?? 'INR', r.balance_after, r.status, r.source_doc_no,
             JSON.stringify(r.raw ?? {}), batch.id, b.source_file ?? null]);
          if (rows.length) fresh += 1;
        }

        await t.query(
          `UPDATE fleet_card_import_batches
              SET rows_new = $2, rows_seen = $3, rows_parked = $4 WHERE id = $1::uuid`,
          [batch.id, fresh, parsed.rows.length - fresh - parked, parked]);
        return { batch_id: batch.id, fresh, parked };
      });

      const { rows: pos } = await query(
        `SELECT * FROM v_fleet_card_position WHERE account_id = $1::uuid`, [accountId]);
      return {
        imported: true,
        provider: parsed.provider,
        account_no: accountNo,
        period: { from: parsed.period_from ?? null, to: parsed.period_to ?? null },
        rows_read: parsed.rows.length,
        rows_new: out.fresh,
        // Said explicitly: a second upload of the same statement is expected and
        // is not an error.
        rows_already_had: parsed.rows.length - out.fresh - out.parked,
        rows_skipped: out.parked,
        position: pos[0] ?? null,
      };
    }
  );

  // ── What the cards say ────────────────────────────────────────────────────
  app.get(
    '/transactions',
    { schema: { querystring: { type: 'object', properties: {
      account_id: { type: ['string', 'null'], format: 'uuid' },
      provider: { type: ['string', 'null'], maxLength: 8 },
      company: { type: ['string', 'null'], maxLength: 120 },
      vehicle_no: { type: ['string', 'null'], maxLength: 20 },
      merchant: { type: ['string', 'null'], maxLength: 120 },
      kind: { type: ['string', 'null'], maxLength: 20 },
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query ?? {};
      const { rows } = await query(`
        SELECT x.*, a.operating_company, a.account_no
          FROM fleet_card_statement_txns x
          JOIN fleet_card_accounts a ON a.id = x.account_id
         WHERE ($1::uuid IS NULL OR x.account_id = $1::uuid)
           AND ($2::text IS NULL OR x.provider = $2)
           AND ($3::text IS NULL OR a.operating_company = $3)
           AND ($4::text IS NULL OR reg_key(x.vehicle_no) = reg_key($4) OR reg_key(x.vehicle_raw) = reg_key($4))
           AND ($5::text IS NULL OR x.merchant_name ILIKE '%'||$5||'%')
           AND ($6::text IS NULL OR x.kind = $6)
           AND ($7::date IS NULL OR x.txn_date >= $7::date)
           AND ($8::date IS NULL OR x.txn_date <= $8::date)
         ORDER BY x.txn_date DESC, x.created_at DESC
         LIMIT $9`,
        [q.account_id || null, q.provider || null, q.company || null, q.vehicle_no || null,
         q.merchant || null, q.kind || null, q.from || null, q.to || null, q.limit ?? 500]);
      return { count: rows.length, transactions: rows };
    }
  );

  // ── The milan: a swipe against the diesel we recorded ────────────────────
  app.get(
    '/fuel-match',
    { schema: { querystring: { type: 'object', properties: {
      milan: { type: ['string', 'null'], maxLength: 20 },
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query ?? {};
      const [rows, summary] = await Promise.all([
        query(`SELECT * FROM v_fleet_card_fuel_match
                WHERE ($1::text IS NULL OR milan = $1)
                  AND ($2::date IS NULL OR txn_date >= $2::date)
                  AND ($3::date IS NULL OR txn_date <= $3::date)
                ORDER BY txn_date DESC LIMIT $4`,
          [q.milan || null, q.from || null, q.to || null, q.limit ?? 500]),
        // The money at stake per kind of gap, so the desk knows which pile to
        // start on rather than working down a list in date order.
        query(`SELECT milan, count(*)::int AS rows, sum(amount)::numeric(16,2) AS amount,
                      sum(quantity)::numeric(16,3) AS litres
                 FROM v_fleet_card_fuel_match GROUP BY milan ORDER BY 3 DESC NULLS LAST`),
      ]);
      return {
        count: rows.rows.length,
        rows: rows.rows,
        summary: summary.rows,
        legend: {
          MATCHED: 'a fuel memo exists for the same lorry, day and litres',
          AMBIGUOUS: 'more than one swipe found the same memo — a person must say which fill it was',
          NO_MEMO: 'diesel drawn on the card with nothing in the fuel register to account for it',
          NO_VEHICLE: 'the card row names a registration this fleet master does not have',
        },
      };
    }
  );
}
