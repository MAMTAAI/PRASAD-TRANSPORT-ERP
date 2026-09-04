// server/modules/fleetCard.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/fleet-card — the three oil companies' cards, as they keep them.
//
// There is no API at any of IOCL, BPCL or HPCL. A person exports a CSV from the
// portal, so this module's job is to take that file and make it countable:
// parse it per provider, store every row as exported under the provider's own
// id, and report the position per company. The file reaches us two ways — an
// upload here, or a watched folder the 02:00 job reads (see /sources below and
// server/lib/nightlyFuelSync.js) — and both go through the same importer,
// server/lib/fleetCardIngest.js.
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
import { query, isDegraded } from '../db/pool.js';
import { ingestFleetCardCsv, IngestError } from '../lib/fleetCardIngest.js';
import { registerFleetCardAllocationRoutes } from './fleetCardAlloc.routes.js';

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

      try {
        // The same code path the 02:00 nightly job uses. Two importers is how a
        // file uploaded by hand ends up counted differently from the same file
        // picked up overnight.
        return await ingestFleetCardCsv({
          csv: b.csv,
          source_file: b.source_file ?? null,
          account_no: b.account_no ?? null,
          created_by: b.created_by ?? null,
        });
      } catch (err) {
        if (err instanceof IngestError) {
          return reply.code(err.status).send({ error: err.code, detail: err.message });
        }
        throw err;
      }
    }
  );

  // ── Where the nightly job looks ──────────────────────────────────────────
  //
  // A source is a folder a statement is dropped into. There is no portal login
  // here and no stored password — see migration 151 for why. Point this at
  // wherever the download lands and the 02:00 job picks it up unattended.
  app.get('/sources', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT s.*, a.provider, a.account_no AS account_number, a.operating_company,
             (SELECT max(b.created_at) FROM fleet_card_import_batches b
               WHERE b.source_id = s.id) AS last_import_at
        FROM fleet_card_sources s
        LEFT JOIN fleet_card_accounts a ON a.id = s.account_id
       ORDER BY s.active DESC, a.provider NULLS LAST, s.locator`);
    return { sources: rows };
  });

  app.post(
    '/sources',
    { schema: { body: { type: 'object', required: ['kind', 'locator'], properties: {
      account_id: { type: ['string', 'null'], format: 'uuid' },
      kind:       { type: 'string', enum: ['FOLDER', 'EMAIL'] },
      locator:    { type: 'string', minLength: 2, maxLength: 500 },
      file_glob:  { type: ['string', 'null'], maxLength: 60 },
      account_no: { type: ['string', 'null'], maxLength: 40 },
      active:     { type: 'boolean', default: true },
      notes:      { type: ['string', 'null'], maxLength: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows } = await query(`
        INSERT INTO fleet_card_sources
          (account_id, kind, locator, file_glob, account_no, active, notes)
        VALUES ($1::uuid,$2,$3,COALESCE($4,'*.csv'),$5,COALESCE($6,true),$7)
        RETURNING *`,
        [b.account_id ?? null, b.kind, b.locator.trim(), b.file_glob ?? null,
         b.account_no ?? null, b.active, b.notes ?? null]);
      reply.code(201);
      return {
        source: rows[0],
        // Said plainly at the moment of configuring, not buried in a doc: an
        // EMAIL source is stored but nothing reads it yet. Refusing it would
        // lose the configuration; pretending it works would lose the statement.
        fetched_by: b.kind === 'EMAIL'
          ? 'not yet — no IMAP reader is installed; see migration 151'
          : 'the 02:00 IST nightly fuel sync',
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

  // Allocation lives in its own module — same prefix, separate file, because
  // "what a swipe was for" is a different subject from "what the card did".
  await registerFleetCardAllocationRoutes(app);
}
