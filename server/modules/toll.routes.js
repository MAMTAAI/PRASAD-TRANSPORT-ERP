// server/modules/toll.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/toll — FASTag tolls, reimbursement claims, wallet recharges, fleet
// cards, and the GST/TDS registers. Cluster 3.
//
//   GET/POST/PATCH  /transactions            toll_transactions
//   POST            /transactions/import     bulk statement import (idempotent)
//   GET             /claimable               billable, unclaimed, grouped
//   GET/POST        /claims                  toll_claims
//   GET/POST        /recharges               wallet top-ups
//   GET/POST/PATCH  /cards  + /cards/:id/txns
//   GET/POST/PATCH  /gst    /tds             the two registers
//
// ONE RULE RUNS THROUGH ALL OF IT: a toll is billed once. The Firestore version
// tracked that with a `claim_status` string set by the browser after the fact,
// so a re-run, a second tab or a crashed print could bill the same toll twice —
// and an oil company that spots a double-claimed toll disputes the whole
// fortnight. Here the claim is written and the tolls are stamped in ONE
// transaction, guarded by a real foreign key and a CHECK.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const money = (v) => Number(v ?? 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const pgErr = (reply, err) => {
  if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
  if (err.code === '23503') return reply.code(409).send({ error: 'IN_USE', detail: err.detail ?? err.message });
  throw err;
};

// A prepaid FASTag or fuel-card balance is money handed to a provider that we
// draw down against — an advance, not cash. WALLET_GROUP is NOT a group in
// this chart: account_groups is a closed list behind a foreign key, and passing
// a name that is not in it made every wallet voucher fail with an FK error that
// surfaced only in the response's ledger_note. Taken from account_groups.
const WALLET_GROUP = 'Loans & Advances (Asset)';

// Which firm's money is moving? The per-firm wallets name it after the colon
// ('FASTag Wallet: Jaiswal Enterprise', 039), and a recharge may name it in
// free text instead. Resolved through norm_company_name so the eight historic
// spellings of three firms (053) collapse to one id — no match means NULL,
// never a guess (owner rule agreed 2026-08-31, same review as migration 111).
async function companyIdByName(name) {
  const t = String(name ?? '').trim();
  if (!t || /^all$/i.test(t)) return null;
  const { rows: [c] } = await query(
    `SELECT id FROM companies
      WHERE norm_company_name(company_name) = norm_company_name($1) LIMIT 1`, [t]);
  return c?.id ?? null;
}
const walletCompanyId = (ledgerName) => {
  const s = String(ledgerName ?? '');
  return s.includes(':') ? companyIdByName(s.slice(s.indexOf(':') + 1)) : Promise.resolve(null);
};

const JSONB = new Set(['groups']);
const enc = (col, v) => (JSONB.has(col) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

const buildUpdate = (table, allowed, body) => {
  const cols = allowed.filter((c) => body[c] !== undefined);
  if (!cols.length) return null;
  return {
    sql: `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
           WHERE id = $1::uuid RETURNING *`,
    args: [null, ...cols.map((c) => enc(c, body[c]))],
  };
};

export async function registerTollRoutes(app) {
  // ═══ TOLL TRANSACTIONS ════════════════════════════════════════════════════
  const TXN_COLS = ['ext_txn_id', 'txn_ref', 'vehicle_no', 'vehicle_id', 'trip_id', 'txn_datetime',
    'txn_date', 'amount', 'plaza_name', 'lat', 'lng', 'provider', 'invoice_no', 'invoice_date',
    'loading_loc', 'dest_loc', 'billing_type', 'is_billable', 'claim_status', 'remarks',
    'company', 'branch', 'tag_id'];

  app.get(
    '/transactions',
    { schema: { querystring: { type: 'object', properties: {
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      vehicle_no: { type: ['string', 'null'], maxLength: 20 },
      claim_status: { type: ['string', 'null'], maxLength: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query;
      const { rows } = await query(
        `SELECT t.*, c.claim_no AS claim_ref
           FROM toll_transactions t
           LEFT JOIN toll_claims c ON c.id = t.claim_id
          WHERE ($1::date IS NULL OR t.txn_date >= $1)
            AND ($2::date IS NULL OR t.txn_date <= $2)
            AND ($3::text IS NULL OR t.vehicle_no = upper($3))
            AND ($4::text IS NULL OR t.claim_status = $4)
          ORDER BY t.txn_date DESC NULLS LAST, t.created_at DESC
          LIMIT $5`,
        [q.from || null, q.to || null, q.vehicle_no || null, q.claim_status || null, q.limit ?? 1000]);
      return { count: rows.length, transactions: rows };
    }
  );

  app.post('/transactions', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.vehicle_no) return reply.code(400).send({ error: 'NO_VEHICLE' });
    if (!(Number(b.amount) > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT' });
    const cols = TXN_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO toll_transactions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING *`, cols.map((c) => (c === 'vehicle_no' ? String(b[c]).toUpperCase() : enc(c, b[c]))));
      reply.code(201);
      return { created: true, transaction: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  // Statement import. The provider's own txn id is the natural key, so a
  // re-uploaded statement converges instead of duplicating — the single most
  // common operator action on this screen is uploading the same file twice.
  app.post(
    '/transactions/import',
    { schema: { body: { type: 'object', required: ['transactions'], properties: {
      transactions: { type: 'array', maxItems: 5000, items: { type: 'object' } },
      provider: { type: ['string', 'null'], maxLength: 40 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const list = req.body.transactions ?? [];
      let inserted = 0, skipped = 0, rejected = 0;
      const problems = [];
      await withTransaction(async (tx) => {
        for (const [i, t] of list.entries()) {
          if (!t.vehicle_no || !(Number(t.amount) > 0)) {
            rejected++;
            if (problems.length < 20) problems.push({ row: i, reason: 'missing vehicle_no or amount' });
            continue;
          }
          const cols = TXN_COLS.filter((c) => t[c] !== undefined);
          const res = await tx.query(
            `INSERT INTO toll_transactions (${cols.join(', ')})
             VALUES (${cols.map((_, k) => `$${k + 1}`).join(', ')})
             ON CONFLICT (ext_txn_id) WHERE ext_txn_id IS NOT NULL DO NOTHING
             RETURNING id`,
            cols.map((c) => (c === 'vehicle_no' ? String(t[c]).toUpperCase() : enc(c, t[c]))));
          if (res.rows.length) inserted++; else skipped++;
        }
      });
      return { inserted, skipped_already_present: skipped, rejected, problems };
    }
  );

  app.patch('/transactions/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    // claim_id is not patchable: a toll joins a claim only through
    // POST /claims, which does it in the same transaction as the claim itself.
    const u = buildUpdate('toll_transactions', TXN_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, transaction: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  // ═══ CLAIMABLE ════════════════════════════════════════════════════════════
  // Billable, not yet on any claim, in the fortnight — grouped by trip the way
  // the printed IOCL claim is laid out.
  app.get(
    '/claimable',
    { schema: { querystring: { type: 'object', required: ['from', 'to'], properties: {
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
      company: { type: ['string', 'null'], maxLength: 120 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT t.*, tr.trip_code, tr.loading_point, tr.unloading_location
           FROM toll_transactions t
           LEFT JOIN trips tr ON tr.id = t.trip_id
          WHERE t.is_billable
            AND t.claim_id IS NULL
            AND t.txn_date BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR t.company IS NULL OR upper(t.company) = upper($3))
          ORDER BY t.trip_id NULLS LAST, t.txn_datetime, t.txn_date`,
        [req.query.from, req.query.to, req.query.company || null]);

      const groups = new Map();
      for (const t of rows) {
        const key = t.trip_id ?? `NO_TRIP:${t.vehicle_no}:${t.invoice_no ?? ''}`;
        if (!groups.has(key)) {
          groups.set(key, {
            trip_id: t.trip_id, trip_code: t.trip_code ?? null, vehicle_no: t.vehicle_no,
            invoice_no: t.invoice_no, invoice_date: t.invoice_date,
            loading_loc: t.loading_loc ?? t.loading_point, dest_loc: t.dest_loc ?? t.unloading_location,
            txns: [], total: 0,
          });
        }
        const g = groups.get(key);
        g.txns.push(t);
        g.total = round2(g.total + money(t.amount));
      }
      const list = [...groups.values()];
      return {
        count: rows.length,
        groups: list,
        total: round2(list.reduce((s, g) => s + g.total, 0)),
      };
    }
  );

  // ═══ CLAIMS ═══════════════════════════════════════════════════════════════
  app.get('/claims', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT c.*, (SELECT count(*) FROM toll_transactions t WHERE t.claim_id = c.id)::int AS linked_txns
         FROM toll_claims c ORDER BY c.claim_date DESC, c.claim_no DESC LIMIT 500`);
    return { count: rows.length, claims: rows };
  });

  // The next sequence number within the claim month, so two operators cannot
  // mint the same claim_no. The UNIQUE on claim_no is the real guard; this just
  // makes the common case not collide.
  app.get('/claims/next-seq', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const month = String(req.query.date ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
    const { rows: [r] } = await query(
      `SELECT count(*)::int AS n FROM toll_claims WHERE to_char(claim_date,'YYYY-MM') = $1`, [month]);
    return { month, next_seq: (r?.n ?? 0) + 1 };
  });

  // THE IMPORTANT ONE. Claim row and toll stamps in a single transaction: the
  // UPDATE only touches tolls that are still unclaimed, so two operators
  // generating the same fortnight cannot both bill the same toll — the second
  // gets fewer rows and is told so, rather than silently double-claiming.
  app.post(
    '/claims',
    { schema: { body: { type: 'object', required: ['claim_no', 'vendor_name', 'period_from', 'period_to', 'toll_ids'], properties: {
      claim_no: { type: 'string', minLength: 3, maxLength: 60 },
      claim_date: { type: ['string', 'null'], format: 'date' },
      vendor_name: { type: 'string', minLength: 1, maxLength: 200 },
      vendor_code: { type: ['string', 'null'], maxLength: 40 },
      plant_name: { type: ['string', 'null'], maxLength: 200 },
      plant_code: { type: ['string', 'null'], maxLength: 40 },
      period_from: { type: 'string', format: 'date' },
      period_to: { type: 'string', format: 'date' },
      fortnight_label: { type: ['string', 'null'], maxLength: 20 },
      groups: { type: 'array' },
      company: { type: ['string', 'null'], maxLength: 120 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      toll_ids: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'string' } },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      try {
        const out = await withTransaction(async (tx) => {
          const stamped = await tx.query(
            `UPDATE toll_transactions
                SET claim_status = 'CLAIMED', claim_no = $2, updated_at = now()
              WHERE id = ANY($1::uuid[]) AND claim_id IS NULL AND is_billable
              RETURNING id, amount`,
            [b.toll_ids, b.claim_no]);

          if (!stamped.rows.length) {
            const err = new Error('every toll in this claim has already been billed');
            err.code = 'ALREADY_CLAIMED';
            throw err;
          }

          const total = round2(stamped.rows.reduce((s, r) => s + money(r.amount), 0));
          const { rows: [claim] } = await tx.query(
            `INSERT INTO toll_claims (claim_no, claim_date, vendor_name, vendor_code, plant_name,
                                      plant_code, period_from, period_to, fortnight_label, groups,
                                      txn_count, total, company, created_by)
             VALUES ($1,$2::date,$3,$4,$5,$6,$7::date,$8::date,$9,$10::jsonb,$11,$12,$13,$14)
             RETURNING *`,
            [b.claim_no, b.claim_date ?? new Date().toISOString().slice(0, 10), b.vendor_name,
             b.vendor_code ?? null, b.plant_name ?? null, b.plant_code ?? null, b.period_from,
             b.period_to, b.fortnight_label ?? null, JSON.stringify(b.groups ?? []),
             stamped.rows.length, total, b.company ?? null, b.created_by ?? null]);

          // Link second: claim_id has a FK, so it can only be set once the row
          // exists, and the CHECK requires claim_status='CLAIMED' — already set.
          await tx.query(
            `UPDATE toll_transactions SET claim_id = $1::uuid WHERE id = ANY($2::uuid[])`,
            [claim.id, stamped.rows.map((r) => r.id)]);

          return { claim, stamped: stamped.rows.length, total };
        });

        reply.code(201);
        return {
          created: true,
          claim: out.claim,
          tolls_claimed: out.stamped,
          // Said plainly rather than hidden: the caller asked for N and got M.
          tolls_requested: b.toll_ids.length,
          skipped_already_claimed: b.toll_ids.length - out.stamped,
          total: out.total,
        };
      } catch (err) {
        if (err.code === 'ALREADY_CLAIMED') return reply.code(409).send({ error: err.code, detail: err.message });
        return pgErr(reply, err);
      }
    }
  );

  app.patch('/claims/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('toll_claims', ['status', 'plant_name', 'plant_code', 'vendor_code'], req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, claim: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  // ═══ RECHARGES ════════════════════════════════════════════════════════════
  app.get('/recharges', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM toll_recharges ORDER BY recharge_date DESC, created_at DESC LIMIT 500`);
    return {
      count: rows.length,
      recharges: rows,
      total: round2(rows.reduce((s, r) => s + money(r.amount), 0)),
    };
  });

  // A wallet top-up is real money leaving a real bank account, so it posts a
  // PAYMENT voucher when an account is named. `post_to_ledger:false` records it
  // in the subsidiary only — stated, never assumed.
  app.post(
    '/recharges',
    { schema: { body: { type: 'object', required: ['amount'], additionalProperties: false, properties: {
      amount: { type: 'number', exclusiveMinimum: 0 },
      recharge_date: { type: ['string', 'null'], format: 'date' },
      payment_source: { type: ['string', 'null'], maxLength: 60 },
      transaction_id: { type: ['string', 'null'], maxLength: 80 },
      vehicle_group: { type: ['string', 'null'], maxLength: 60 },
      provider: { type: ['string', 'null'], maxLength: 40 },
      account: { type: ['string', 'null'], maxLength: 120 },
      remarks: { type: ['string', 'null'], maxLength: 300 },
      company: { type: ['string', 'null'], maxLength: 120 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      post_to_ledger: { type: 'boolean', default: true },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const date = b.recharge_date ?? new Date().toISOString().slice(0, 10);

      let voucher = null, ledgerNote = null;
      if (b.post_to_ledger !== false) {
        if (!b.account) {
          return reply.code(400).send({
            error: 'NO_ACCOUNT',
            detail: 'a wallet recharge needs the bank/cash account it left, or post_to_ledger=false to record it in the subsidiary only',
          });
        }
        try {
          voucher = await postVoucher({
            type: 'PAYMENT',
            account: b.account,
            party_ledger: 'FASTag Wallet',
            party_group: WALLET_GROUP,
            amount: b.amount,
            ref_no: b.transaction_id || null,
            entry_date: date,
            narration: `FASTag wallet recharge${b.provider ? ` (${b.provider})` : ''}${b.remarks ? ` — ${b.remarks}` : ''}`,
            source_type: 'TOLL_RECHARGE',
            company: b.company ?? null,
            company_id: await companyIdByName(b.company),
            created_by: b.created_by ?? null,
          });
          await drain().catch(() => {});
        } catch (err) {
          const map = { OVERDRAFT: 422, DUPLICATE_REF: 409, NO_ACCOUNT: 400 };
          if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
          ledgerNote = err.message;
        }
      }

      try {
        const { rows } = await query(
          `INSERT INTO toll_recharges (recharge_date, amount, payment_source, transaction_id,
                                       vehicle_group, provider, voucher_id, remarks, company, created_by)
           VALUES ($1::date,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10) RETURNING *`,
          [date, b.amount, b.payment_source ?? null, b.transaction_id ?? null, b.vehicle_group ?? null,
           b.provider ?? null, voucher?.voucher_id ?? null, b.remarks ?? null, b.company ?? null, b.created_by ?? null]);
        reply.code(201);
        return { created: true, recharge: rows[0], voucher_id: voucher?.voucher_id ?? null, ledger_note: ledgerNote };
      } catch (err) { return pgErr(reply, err); }
    }
  );

  // ═══ FLEET CARDS ══════════════════════════════════════════════════════════
  const CARD_COLS = ['name', 'provider', 'card_no_last4', 'vehicle_id', 'vehicle_no',
    'opening_balance', 'status', 'remarks', 'wallet_ledger'];

  app.get('/cards', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`SELECT * FROM v_fleet_card_balance ORDER BY name`);
    return { count: rows.length, cards: rows };
  });

  app.post('/cards', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.name || !b.provider) return reply.code(400).send({ error: 'NO_NAME_OR_PROVIDER' });
    const cols = CARD_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO fleet_cards (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, card: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/cards/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('fleet_cards', CARD_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, card: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.get('/cards/:id/txns', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM card_transactions WHERE card_id = $1::uuid
        ORDER BY txn_date DESC, created_at DESC LIMIT 500`, [req.params.id]);
    return { count: rows.length, transactions: rows };
  });

  // A card settlement clears a pump's credit against the card wallet. Both legs
  // are real accounts, so it is a JOURNAL — the Firestore version posted this
  // through its own journal helper and separately rewrote two stored counters.
  app.post(
    '/cards/:id/txns',
    { schema: { body: { type: 'object', required: ['txn_type', 'amount'], additionalProperties: false, properties: {
      txn_type: { type: 'string', enum: ['LOAD', 'SETTLEMENT', 'FEE', 'REFUND', 'ADJUSTMENT'] },
      amount: { type: 'number', exclusiveMinimum: 0 },
      txn_date: { type: ['string', 'null'], format: 'date' },
      party: { type: ['string', 'null'], maxLength: 200 },
      vendor_id: { type: ['string', 'null'], format: 'uuid' },
      narration: { type: ['string', 'null'], maxLength: 300 },
      ref: { type: ['string', 'null'], maxLength: 80 },
      account: { type: ['string', 'null'], maxLength: 120 },
      wallet_ledger: { type: ['string', 'null'], maxLength: 120 },
      funded_by: { type: ['string', 'null'], enum: ['BANK', 'DEDUCTION', null] },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      post_to_ledger: { type: 'boolean', default: true },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [card] } = await query('SELECT * FROM fleet_cards WHERE id = $1::uuid', [req.params.id]);
      if (!card) return reply.code(404).send({ error: 'NOT_FOUND' });
      const date = b.txn_date ?? new Date().toISOString().slice(0, 10);
      // The card's own mapping wins (031). The derived name is a LAST resort —
      // the chart already carries a real account per physical card, and
      // inventing a second one would split the card's balance across two.
      const wallet = card.wallet_ledger || b.wallet_ledger || `${card.provider} Card Wallet`;
      // The wallet the money moves through names the firm; a generic card
      // wallet resolves to NULL and the entry stays visibly unattributed.
      const walletCo = await walletCompanyId(wallet);

      let voucher = null, ledgerNote = null;
      if (b.post_to_ledger !== false) {
        try {
          if (b.txn_type === 'SETTLEMENT') {
            if (!b.party) return reply.code(400).send({ error: 'NO_PARTY', detail: 'a settlement clears a specific pump — name it' });
            voucher = await postVoucher({
              type: 'JOURNAL',
              entry_date: date,
              narration: b.narration || `Pump credit settled via ${card.name} — ${b.party}`,
              source_type: 'CARD_SETTLEMENT',
              ref_no: b.ref || null,
              company_id: walletCo,
              created_by: b.created_by ?? null,
              lines: [
                { ledger: `Creditors: ${b.party}`, dr_cr: 'DR', amount: b.amount, group: 'Sundry Creditors (Fuel Pumps)' },
                { ledger: wallet, dr_cr: 'CR', amount: b.amount, group: WALLET_GROUP },
              ],
            });
          } else if (b.txn_type === 'LOAD') {
            // A card is loaded two different ways and they are NOT the same
            // entry. Paying the provider from a bank account is a PAYMENT.
            // But the common case here is a freight deduction: the oil company
            // keeps part of our bill and credits the card instead — no bank
            // account moves, and what falls is the receivable from THEM. The
            // Firestore screen called both "RECHARGE" and posted the second
            // shape only, so a genuinely bank-funded load never hit the bank.
            if (b.funded_by === 'DEDUCTION' || (!b.account && b.party)) {
              if (!b.party) {
                return reply.code(400).send({
                  error: 'NO_PARTY',
                  detail: 'a freight-deduction load reduces a specific customer receivable — name the customer',
                });
              }
              voucher = await postVoucher({
                type: 'JOURNAL',
                entry_date: date,
                narration: b.narration || `Fleet card loaded by freight deduction — ${card.name} (${b.party})`,
                source_type: 'CARD_RECHARGE',
                ref_no: b.ref || null,
                company_id: walletCo,
                created_by: b.created_by ?? null,
                lines: [
                  { ledger: wallet, dr_cr: 'DR', amount: b.amount, group: WALLET_GROUP },
                  { ledger: `Debtors: ${b.party}`, dr_cr: 'CR', amount: b.amount, group: 'Sundry Debtors (Customers)' },
                ],
              });
            } else {
              if (!b.account) {
                return reply.code(400).send({
                  error: 'NO_ACCOUNT',
                  detail: 'a bank-funded card load needs the account it left; for a freight deduction send funded_by=DEDUCTION and the customer as party',
                });
              }
              voucher = await postVoucher({
                type: 'PAYMENT',
                account: b.account,
                party_ledger: wallet,
                party_group: WALLET_GROUP,
                amount: b.amount,
                ref_no: b.ref || null,
                entry_date: date,
                narration: b.narration || `Card load — ${card.name}`,
                source_type: 'CARD_LOAD',
                company_id: walletCo,
                created_by: b.created_by ?? null,
              });
            }
          }
          if (voucher) await drain().catch(() => {});
        } catch (err) {
          const map = { OVERDRAFT: 422, DUPLICATE_REF: 409, NO_ACCOUNT: 400, UNBALANCED: 400 };
          if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
          ledgerNote = err.message;
        }
      }

      try {
        const { rows } = await query(
          `INSERT INTO card_transactions (card_id, provider, txn_type, amount, txn_date, party,
                                          vendor_id, narration, ref, voucher_id, created_by)
           VALUES ($1::uuid,$2,$3,$4,$5::date,$6,$7::uuid,$8,$9,$10::uuid,$11) RETURNING *`,
          [card.id, card.provider, b.txn_type, b.amount, date, b.party ?? null, b.vendor_id ?? null,
           b.narration ?? null, b.ref ?? null, voucher?.voucher_id ?? null, b.created_by ?? null]);
        const { rows: [bal] } = await query('SELECT * FROM v_fleet_card_balance WHERE id = $1::uuid', [card.id]);
        reply.code(201);
        return { created: true, transaction: rows[0], card: bal, voucher_id: voucher?.voucher_id ?? null, ledger_note: ledgerNote };
      } catch (err) { return pgErr(reply, err); }
    }
  );

  // ═══ FASTAG PROVIDERS ═════════════════════════════════════════════════════
  // Provider API credentials. THE MASK IS THE POINT: auth_token and password
  // never leave this process. Every read replaces them with a sentinel, and a
  // write that sends the sentinel back is ignored rather than storing it — so
  // the UI can round-trip a provider without ever holding, or erasing, a
  // secret it was not given.
  const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  const SECRETS = ['auth_token', 'password'];
  const maskProvider = (r) => {
    const out = { ...r };
    for (const f of SECRETS) out[f] = r[f] ? MASK : '';
    return out;
  };

  // Users paste whole curl URLs. The runner appends its own start_time /
  // end_index parameters, so a leftover query string produces duplicate keys
  // and the provider answers 500 — strip to origin + path.
  const cleanUrl = (u) => {
    const raw = String(u ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (!raw) return '';
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return raw; }
  };
  const cleanToken = (t) =>
    String(t ?? '').trim().replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '').trim();

  app.get('/providers', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM fastag_providers ORDER BY lower(name)`);
    return { count: rows.length, providers: rows.map(maskProvider) };
  });

  app.post(
    '/providers',
    { schema: { body: { type: 'object', required: ['name', 'base_url'], additionalProperties: false, properties: {
      id: { type: ['string', 'null'], format: 'uuid' },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      type: { type: ['string', 'null'], maxLength: 40 },
      base_url: { type: 'string', minLength: 1, maxLength: 500 },
      auth_token: { type: ['string', 'null'], maxLength: 2000 },
      username: { type: ['string', 'null'], maxLength: 120 },
      password: { type: ['string', 'null'], maxLength: 200 },
      company: { type: ['string', 'null'], maxLength: 120 },
      active: { type: 'boolean', default: false },
      sync_window_days: { type: 'integer', minimum: 1, maximum: 90, default: 2 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const base = {
        name: b.name.trim(),
        type: (b.type || 'gtropy').toLowerCase(),
        base_url: cleanUrl(b.base_url),
        username: (b.username ?? '').trim(),
        company: b.company || 'PRASAD TRANSPORT',
        active: !!b.active,
        sync_window_days: b.sync_window_days ?? 2,
      };
      // Only a freshly typed secret is written; the mask means "unchanged".
      const secrets = {};
      if (b.auth_token && b.auth_token !== MASK) secrets.auth_token = cleanToken(b.auth_token);
      if (b.password && b.password !== MASK) secrets.password = b.password;

      const cols = [...Object.keys(base), ...Object.keys(secrets)];
      const vals = [...Object.values(base), ...Object.values(secrets)];
      try {
        if (b.id) {
          const sets = cols.map((c, i) => `${c} = $${i + 2}`);
          const { rows } = await query(
            `UPDATE fastag_providers SET ${sets.join(', ')}, updated_at = now()
              WHERE id = $1::uuid RETURNING *`, [b.id, ...vals]);
          if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
          return { updated: true, provider: maskProvider(rows[0]) };
        }
        const { rows } = await query(
          `INSERT INTO fastag_providers (${cols.join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
        reply.code(201);
        return { created: true, provider: maskProvider(rows[0]) };
      } catch (err) { return pgErr(reply, err); }
    }
  );

  app.patch('/providers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (typeof b.active !== 'boolean') return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const { rows } = await query(
      `UPDATE fastag_providers SET active = $2, updated_at = now() WHERE id = $1::uuid RETURNING *`,
      [req.params.id, b.active]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { updated: true, provider: maskProvider(rows[0]) };
  });

  app.delete('/providers/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('DELETE FROM fastag_providers WHERE id = $1::uuid RETURNING name', [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { deleted: true, name: rows[0].name };
  });

  app.get('/accounts', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM fastag_accounts ORDER BY COALESCE(vehicle_number, account_id)`);
    return {
      count: rows.length,
      accounts: rows,
      total_balance: round2(rows.reduce((a, r) => a + money(r.balance), 0)),
    };
  });

  // ═══ SETTINGS ═════════════════════════════════════════════════════════════
  // One row of jsonb. The runner polls force_sync_requested and clears it; the
  // screen sets it. Secrets in here are masked on the same rule as providers.
  const SETTING_SECRETS = ['portal_password'];
  const maskSettings = (v) => {
    const out = { ...(v ?? {}) };
    for (const f of SETTING_SECRETS) out[f] = out[f] ? MASK : '';
    return out;
  };

  app.get('/settings/:key', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [r] } = await query('SELECT value FROM toll_settings WHERE key = $1', [req.params.key]);
    return { key: req.params.key, value: maskSettings(r?.value) };
  });

  app.patch('/settings/:key', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const patch = { ...(req.body ?? {}) };
    // A masked password must never be written back over the real one.
    for (const f of SETTING_SECRETS) if (patch[f] === MASK) delete patch[f];
    const { rows } = await query(
      `INSERT INTO toll_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = toll_settings.value || EXCLUDED.value, updated_at = now()
       RETURNING value`,
      [req.params.key, JSON.stringify(patch)]);
    return { updated: true, key: req.params.key, value: maskSettings(rows[0].value) };
  });

  // ═══ GST REGISTER ═════════════════════════════════════════════════════════
  const GST_COLS = ['entry_date', 'customer_id', 'customer_name', 'invoice_no', 'gst_type',
    'taxable_amt', 'gst_rate', 'total_gst', 'reverse_charge', 'is_submitted', 'return_period',
    'company', 'created_by'];

  app.get('/gst', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM gst_returns
        WHERE ($1::date IS NULL OR entry_date >= $1) AND ($2::date IS NULL OR entry_date <= $2)
        ORDER BY entry_date DESC, created_at DESC LIMIT 2000`,
      [req.query.from || null, req.query.to || null]);
    return {
      count: rows.length,
      records: rows,
      total_taxable: round2(rows.reduce((s, r) => s + money(r.taxable_amt), 0)),
      total_gst: round2(rows.reduce((s, r) => s + money(r.total_gst), 0)),
      pending_gst: round2(rows.filter((r) => !r.is_submitted).reduce((s, r) => s + money(r.total_gst), 0)),
    };
  });

  app.post('/gst', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.customer_name) return reply.code(400).send({ error: 'NO_CUSTOMER' });
    const cols = GST_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO gst_returns (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, record: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/gst/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('gst_returns', GST_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, record: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/gst/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `DELETE FROM gst_returns WHERE id = $1::uuid AND NOT is_submitted RETURNING id`, [req.params.id]);
    // A filed return is not deletable — the filing is a fact about the past.
    if (!rows.length) return reply.code(409).send({ error: 'SUBMITTED_OR_MISSING', detail: 'a submitted return cannot be deleted' });
    return { deleted: true };
  });

  // ═══ TDS REGISTER ═════════════════════════════════════════════════════════
  const TDS_COLS = ['entry_date', 'consignee_name', 'customer_id', 'section', 'gross_freight',
    'tds_rate', 'tds_deducted', 'certificate_no', 'quarter', 'status', 'company', 'created_by'];

  app.get('/tds', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM tds_entries
        WHERE ($1::date IS NULL OR entry_date >= $1) AND ($2::date IS NULL OR entry_date <= $2)
        ORDER BY entry_date DESC, created_at DESC LIMIT 2000`,
      [req.query.from || null, req.query.to || null]);
    return {
      count: rows.length,
      records: rows,
      total_gross: round2(rows.reduce((s, r) => s + money(r.gross_freight), 0)),
      total_tds: round2(rows.reduce((s, r) => s + money(r.tds_deducted), 0)),
      pending_tds: round2(rows.filter((r) => r.status === 'PENDING').reduce((s, r) => s + money(r.tds_deducted), 0)),
    };
  });

  app.post('/tds', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.consignee_name) return reply.code(400).send({ error: 'NO_CONSIGNEE' });
    const cols = TDS_COLS.filter((c) => b[c] !== undefined);
    try {
      const { rows } = await query(
        `INSERT INTO tds_entries (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => b[c]));
      reply.code(201);
      return { created: true, record: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/tds/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('tds_entries', TDS_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, record: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/tds/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `DELETE FROM tds_entries WHERE id = $1::uuid AND status = 'PENDING' RETURNING id`, [req.params.id]);
    if (!rows.length) return reply.code(409).send({ error: 'FILED_OR_MISSING', detail: 'a filed TDS entry cannot be deleted' });
    return { deleted: true };
  });

  // ═══ TOLL PLAZA MASTER ════════════════════════════════════════════════════
  //
  // The gates themselves — where they are and what one crossing costs us — so
  // the trip route map can draw them and add them up (owner, 4-Sep-2026).
  //
  // The table LEARNS from toll_transactions by trigger (migration 148), so this
  // is mostly a read. The write below exists for the gap the history cannot
  // close on its own: a plaza on a lane this fleet has crossed but whose rate
  // never came through the FASTag feed, or a new gate somebody knows about
  // because they drove past it this morning. Typed once, known for ever — and a
  // MANUAL rate is never overwritten by a later median.

  app.get(
    '/plazas',
    { schema: { querystring: { type: 'object', properties: {
      // The map only needs the ones it can place. Everything else is the
      // "rate missing / no coordinates" worklist, asked for explicitly.
      located: { type: ['boolean', 'null'] },
      priced: { type: ['boolean', 'null'] },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { located, priced } = req.query ?? {};
      const { rows } = await query(
        `SELECT id, name_key, plaza_name, lat, lng, rate, rate_source, observations,
                rate_min, rate_max, first_seen, last_seen, highway, notes,
                verified_by, verified_at
           FROM toll_plazas
          WHERE ($1::boolean IS NULL
                 OR ($1 AND lat IS NOT NULL AND lng IS NOT NULL)
                 OR (NOT $1 AND (lat IS NULL OR lng IS NULL)))
            AND ($2::boolean IS NULL
                 OR ($2 AND rate IS NOT NULL)
                 OR (NOT $2 AND rate IS NULL))
          ORDER BY plaza_name`,
        [located ?? null, priced ?? null]);
      return {
        count: rows.length,
        plazas: rows,
        // Said out loud so a screen can explain a small number rather than
        // present it as the whole truth. These gates are the ones OUR trucks
        // have paid at; a corridor we have never run has none.
        basis: 'learned from this fleet\'s own FASTag crossings, plus rates entered by hand',
      };
    }
  );

  // Add or correct one gate by hand. `rate` here outranks the median for good:
  // somebody read the board at the plaza.
  app.post(
    '/plazas',
    { schema: { body: { type: 'object', required: ['plaza_name'], properties: {
      plaza_name: { type: 'string', minLength: 2, maxLength: 120 },
      lat: { type: ['number', 'null'], minimum: -90, maximum: 90 },
      lng: { type: ['number', 'null'], minimum: -180, maximum: 180 },
      rate: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
      highway: { type: ['string', 'null'], maxLength: 40 },
      notes: { type: ['string', 'null'], maxLength: 400 },
      verified_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body ?? {};
      // The name key is what makes one gate one row, and a name with no letters
      // or digits ("---", "??") produces no key at all. The column is NOT NULL,
      // so without this the insert dies as a 23502 and the operator gets a 500
      // for a typo. Verified against a real PostgreSQL before this guard existed.
      if (!String(b.plaza_name).toUpperCase().replace(/[^A-Z0-9]+/g, '')) {
        return reply.code(400).send({ error: 'BAD_NAME', detail: 'plaza name needs at least one letter or digit' });
      }
      // A rate with no coordinates cannot be drawn, but it is still worth
      // keeping: the next FASTag crossing at that gate supplies the point and
      // the rate is already there.
      try {
        const { rows } = await query(
          `INSERT INTO toll_plazas (name_key, plaza_name, lat, lng, rate, rate_source,
                                    highway, notes, verified_by, verified_at)
           VALUES (toll_plaza_key($1), $1, $2, $3, $4,
                   CASE WHEN $4::numeric IS NULL THEN 'FASTAG_HISTORY' ELSE 'MANUAL' END,
                   $5, $6, $7, CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() END)
           ON CONFLICT (name_key) DO UPDATE SET
             plaza_name  = EXCLUDED.plaza_name,
             lat         = COALESCE(EXCLUDED.lat, toll_plazas.lat),
             lng         = COALESCE(EXCLUDED.lng, toll_plazas.lng),
             rate        = COALESCE(EXCLUDED.rate, toll_plazas.rate),
             rate_source = CASE WHEN EXCLUDED.rate IS NULL THEN toll_plazas.rate_source ELSE 'MANUAL' END,
             highway     = COALESCE(EXCLUDED.highway, toll_plazas.highway),
             notes       = COALESCE(EXCLUDED.notes, toll_plazas.notes),
             verified_by = COALESCE(EXCLUDED.verified_by, toll_plazas.verified_by),
             verified_at = COALESCE(EXCLUDED.verified_at, toll_plazas.verified_at)
           RETURNING *`,
          [String(b.plaza_name).trim(), b.lat ?? null, b.lng ?? null, b.rate ?? null,
           b.highway ?? null, b.notes ?? null, b.verified_by ?? null]);
        if (!rows.length) return reply.code(400).send({ error: 'BAD_NAME', detail: 'plaza name has no letters or digits' });
        reply.code(201);
        return { saved: true, plaza: rows[0] };
      } catch (err) { return pgErr(reply, err); }
    }
  );

  // Re-derive every learned rate from the crossings. The trigger keeps this
  // current on its own; the button exists for after a bulk correction, and
  // because "recompute it and show me" is the first thing anyone asks when a
  // rate looks wrong. MANUAL rates are left alone by toll_plaza_learn itself.
  app.post('/plazas/relearn', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    await query(`
      DO $do$
      DECLARE k text;
      BEGIN
        FOR k IN SELECT DISTINCT toll_plaza_key(plaza_name) FROM toll_transactions
                  WHERE toll_plaza_key(plaza_name) IS NOT NULL
        LOOP PERFORM toll_plaza_learn(k); END LOOP;
      END $do$;`);
    const { rows } = await query(
      `SELECT count(*)::int AS plazas,
              count(*) FILTER (WHERE rate IS NOT NULL)::int AS priced,
              count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int AS located
         FROM toll_plazas`);
    return { relearned: true, ...rows[0] };
  });
}
