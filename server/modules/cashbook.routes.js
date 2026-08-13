// server/modules/cashbook.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/finance — Cash & Bank Book, bank master, filter-bar masters, and
// voucher reversal. Mounted on the same prefix as finance.routes.js; kept in a
// separate file because these are the book-and-master routes rather than the
// voucher/party-hub ones.
//
//   GET  /cashbook              bank & cash book: ledger legs + counter-party,
//                               opening/closing balance, totals over the FULL
//                               filtered set (not just the returned page)
//   POST /accounts              create a bank/cash ledger (the "bank master")
//   GET  /masters/companies     companies + the branch list actually in use
//   POST /vouchers/:id/reverse  append a mirror-image JOURNAL; there is no delete
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

export async function registerCashbookRoutes(app) {
  // ── Cash & Bank Book ────────────────────────────────────────────────────────
  // The book is a projection of the ledger, not a second store. Firestore kept
  // BANK_TRANSACTIONS as its own collection, which is why its totals could
  // disagree with the ledger; here a row IS the bank/cash leg of a voucher and
  // the party is read off the opposite leg of the same voucher.
  //
  // Type is derived, never stored: DR on a bank account is money in, CR is money
  // out, and a leg whose counter-leg is also a bank/cash account is a transfer.
  // Legacy imported rows have no voucher and so no counter-leg — they surface
  // with the particulars they were imported with rather than being dropped.
  app.get(
    '/cashbook',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            account: { type: ['string', 'null'], maxLength: 120 },
            company: { type: ['string', 'null'], maxLength: 120 },
            branch: { type: ['string', 'null'], maxLength: 60 },
            from: { type: ['string', 'null'], format: 'date' },
            to: { type: ['string', 'null'], format: 'date' },
            q: { type: ['string', 'null'], maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const account = req.query.account || null;
      const company = req.query.company || null;
      const branch = req.query.branch || null;
      const from = req.query.from || null;
      const to = req.query.to || null;
      const q = req.query.q || null;
      const limit = req.query.limit ?? 500;
      const args = [account, company, branch, from, to, q];

      // Bank/cash legs in range, each tagged with its counter-party. The counter
      // leg is chosen by opposite dr_cr within the same voucher, which is what
      // makes a CONTRA name the other account rather than itself.
      const ENTRIES = `
        WITH cashacc AS (
          SELECT ledger_name, group_head
            FROM ledgers
           WHERE group_head IN ('Bank Accounts','Cash-in-Hand')
             AND ($1::text IS NULL OR ledger_name = $1::text)
        ),
        legs AS (
          SELECT e.id, e.entry_date, e.ledger_name AS account, a.group_head,
                 e.dr_cr, e.amount, e.particulars, e.source_type, e.source_ref,
                 e.voucher_id, e.company, e.branch
            FROM ledger_entries e
            JOIN cashacc a ON lower(a.ledger_name) = lower(e.ledger_name)
           WHERE ($4::date IS NULL OR e.entry_date >= $4::date)
             AND ($5::date IS NULL OR e.entry_date <= $5::date)
             AND ($2::text IS NULL OR company_matches(e.company, $2::text))
             AND ($3::text IS NULL OR $3::text = 'ALL'
                  OR e.branch IS NULL OR e.branch IN ('ALL', $3::text))
        )
        SELECT l.*, cp.party_name, cp.party_group,
               COALESCE(cp.party_group IN ('Bank Accounts','Cash-in-Hand'), false) AS is_transfer
          FROM legs l
          LEFT JOIN LATERAL (
            SELECT string_agg(DISTINCT c.ledger_name, ', ') AS party_name,
                   min(g.group_head) AS party_group
              FROM ledger_entries c
              LEFT JOIN ledger_aliases al ON al.alias_name = c.ledger_name::citext
              LEFT JOIN ledgers cl ON cl.id = al.canonical_id
              LEFT JOIN account_groups g ON g.group_head = cl.group_head
             WHERE l.voucher_id IS NOT NULL
               AND c.voucher_id = l.voucher_id
               AND c.dr_cr <> l.dr_cr
          ) cp ON true
         WHERE ($6::text IS NULL
                OR cp.party_name ILIKE '%'||$6::text||'%'
                OR l.particulars ILIKE '%'||$6::text||'%'
                OR l.source_ref ILIKE '%'||$6::text||'%'
                OR l.account ILIKE '%'||$6::text||'%')
         ORDER BY l.entry_date DESC, l.id DESC
         LIMIT $7`;

      // Totals and opening balance are computed over the FULL filtered set in
      // SQL, never over the page of rows returned — a row limit must not
      // silently change the closing balance the screen prints.
      const TOTALS = `
        WITH cashacc AS (
          SELECT ledger_name FROM ledgers
           WHERE group_head IN ('Bank Accounts','Cash-in-Hand')
             AND ($1::text IS NULL OR ledger_name = $1::text)
        ),
        scoped AS (
          SELECT e.* FROM ledger_entries e
            JOIN cashacc a ON lower(a.ledger_name) = lower(e.ledger_name)
           WHERE ($2::text IS NULL OR company_matches(e.company, $2::text))
             AND ($3::text IS NULL OR $3::text = 'ALL'
                  OR e.branch IS NULL OR e.branch IN ('ALL', $3::text))
        )
        SELECT
          (SELECT COALESCE(SUM(opening_balance),0)::numeric(14,2) FROM ledgers
            WHERE group_head IN ('Bank Accounts','Cash-in-Hand')
              AND ($1::text IS NULL OR ledger_name = $1::text)) AS opening_master,
          COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END)
                   FILTER (WHERE $4::date IS NOT NULL AND entry_date < $4::date),
                   0)::numeric(14,2) AS movement_before,
          COALESCE(SUM(amount) FILTER (WHERE dr_cr='DR'
                     AND ($4::date IS NULL OR entry_date >= $4::date)
                     AND ($5::date IS NULL OR entry_date <= $5::date)),
                   0)::numeric(14,2) AS total_in,
          COALESCE(SUM(amount) FILTER (WHERE dr_cr='CR'
                     AND ($4::date IS NULL OR entry_date >= $4::date)
                     AND ($5::date IS NULL OR entry_date <= $5::date)),
                   0)::numeric(14,2) AS total_out,
          count(*) FILTER (WHERE ($4::date IS NULL OR entry_date >= $4::date)
                             AND ($5::date IS NULL OR entry_date <= $5::date))::int AS entry_count
          FROM scoped`;

      const ACCOUNTS = `
        SELECT l.ledger_name, l.group_head, l.company, l.branch, l.account_no, l.ifsc_code,
               (l.opening_balance
                + COALESCE((SELECT SUM(CASE WHEN e.dr_cr='DR' THEN e.amount ELSE -e.amount END)
                              FROM ledger_entries e
                             WHERE lower(e.ledger_name)=lower(l.ledger_name)), 0)
               )::numeric(14,2) AS balance
          FROM ledgers l
         WHERE l.group_head IN ('Bank Accounts','Cash-in-Hand')
           AND ($1::text IS NULL OR company_matches(l.company, $1::text))
         ORDER BY l.group_head, l.ledger_name`;

      const [rows, tot, accounts] = await Promise.all([
        query(ENTRIES, [...args, limit]),
        query(TOTALS, args.slice(0, 5)),
        query(ACCOUNTS, [company]),
      ]);

      const t = tot.rows[0];
      const opening = Number(t.opening_master) + Number(t.movement_before);
      const closing = opening + Number(t.total_in) - Number(t.total_out);

      return {
        filters: { account, company, branch, from, to, q },
        accounts: accounts.rows,
        opening_balance: opening.toFixed(2),
        total_in: t.total_in,
        total_out: t.total_out,
        closing_balance: closing.toFixed(2),
        entry_count: t.entry_count,
        returned: rows.rows.length,
        truncated: rows.rows.length >= limit,
        entries: rows.rows.map((r) => ({
          id: r.id,
          date: r.entry_date,
          account: r.account,
          account_group: r.group_head,
          type: r.is_transfer ? 'CONTRA' : r.dr_cr === 'DR' ? 'RECEIPT' : 'PAYMENT',
          dr_cr: r.dr_cr,
          amount: r.amount,
          party_name: r.party_name ?? null,
          party_group: r.party_group ?? null,
          particulars: r.particulars,
          ref_no: r.source_ref,
          source_type: r.source_type,
          voucher_id: r.voucher_id,
          company: r.company,
          branch: r.branch,
          is_legacy: r.voucher_id === null,
        })),
      };
    }
  );

  // ── Bank/cash account master ────────────────────────────────────────────────
  // A bank account IS a ledger under 'Bank Accounts' — there is no separate bank
  // table to fall out of step with the chart of accounts. The opening balance is
  // written to the ledger master, not posted as an entry: TARA owns entries, and
  // a one-sided opening entry would unbalance the books.
  app.post(
    '/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ledger_name'],
          additionalProperties: false,
          properties: {
            ledger_name: { type: 'string', minLength: 2, maxLength: 120 },
            group_head: { type: 'string', enum: ['Bank Accounts', 'Cash-in-Hand'], default: 'Bank Accounts' },
            company: { type: ['string', 'null'], maxLength: 120 },
            branch: { type: ['string', 'null'], maxLength: 60 },
            account_no: { type: ['string', 'null'], maxLength: 40 },
            ifsc_code: { type: ['string', 'null'], maxLength: 15 },
            opening_balance: { type: 'number', default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const ifsc = b.ifsc_code ? String(b.ifsc_code).toUpperCase().trim() : null;
      // Refuse a malformed IFSC rather than storing it: a payment against a bad
      // code fails at the bank, long after anyone remembers typing it.
      if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
        return reply.code(400).send({
          error: 'BAD_IFSC',
          detail: `'${b.ifsc_code}' is not a valid IFSC (4 letters, 0, then 6 alphanumerics)`,
        });
      }

      const dup = await query('SELECT id FROM ledgers WHERE lower(ledger_name) = lower($1)', [b.ledger_name]);
      if (dup.rows.length) {
        return reply.code(409).send({ error: 'DUPLICATE_LEDGER', detail: `ledger '${b.ledger_name}' already exists` });
      }

      const { rows } = await query(
        `INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, current_balance,
                              company, branch, account_no, ifsc_code, creation_type, status)
         VALUES ($1, $2, 'DR', $3, $3, $4, $5, $6, $7, 'MANUAL', 'ACTIVE')
         RETURNING id, ledger_name, group_head, company, branch, account_no, ifsc_code, opening_balance`,
        [
          b.ledger_name.trim(),
          b.group_head ?? 'Bank Accounts',
          b.opening_balance ?? 0,
          b.company ?? null,
          b.branch ?? null,
          b.account_no ?? null,
          ifsc,
        ]
      );
      reply.code(201);
      return { created: true, account: rows[0] };
    }
  );

  // ── Master data for the filter bars ─────────────────────────────────────────
  // Branches have no table of their own; the distinct values already carried by
  // ledgers and ledger entries are the real list, so the dropdown can never
  // offer a branch that no record uses.
  // ── Ledger entries by account GROUP ────────────────────────────────────────
  // The operating P&L needs "every Direct Expenses posting in this window",
  // which is a question about a GROUP, not an account — /cashbook filters by a
  // single account and could not answer it. Kept narrow: read-only, grouped,
  // date- and company-bounded.
  app.get(
    '/entries-by-group',
    { schema: { querystring: { type: 'object', required: ['group_like'], properties: {
      group_like: { type: 'string', maxLength: 80 },
      company: { type: ['string', 'null'], maxLength: 120 },
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 20000, default: 5000 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query;
      const { rows } = await query(
        `SELECT e.id, e.ledger_name, e.entry_date, e.dr_cr, e.amount, e.company,
                e.branch, e.source_type, l.group_head
           FROM ledger_entries e
           JOIN ledgers l ON lower(l.ledger_name) = lower(e.ledger_name)
          WHERE l.group_head ILIKE '%' || $1 || '%'
            AND ($2::text IS NULL OR e.company = $2)
            AND ($3::date IS NULL OR e.entry_date >= $3)
            AND ($4::date IS NULL OR e.entry_date <= $4)
          ORDER BY e.entry_date DESC
          LIMIT $5`,
        [q.group_like, q.company || null, q.from || null, q.to || null, q.limit ?? 5000]);
      const net = rows.reduce((a, r) => a + (r.dr_cr === 'DR' ? Number(r.amount) : -Number(r.amount)), 0);
      return { count: rows.length, entries: rows, net_dr: Math.round((net + Number.EPSILON) * 100) / 100 };
    }
  );

  app.get('/masters/companies', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const [companies, branches] = await Promise.all([
      query(`SELECT company_name, gstin::text AS gstin, pan_no::text AS pan_no, tds_tan,
                    address, city, state, pincode, bank_name, account_no, ifsc_code
               FROM companies WHERE status = 'ACTIVE' ORDER BY company_name`),
      query(`SELECT DISTINCT branch FROM (
                 SELECT branch FROM ledgers        WHERE branch IS NOT NULL AND branch <> ''
                 UNION
                 SELECT branch FROM ledger_entries WHERE branch IS NOT NULL AND branch <> ''
               ) b
              WHERE branch <> 'ALL' ORDER BY branch`),
    ]);
    return { companies: companies.rows, branches: branches.rows.map((r) => r.branch) };
  });

  // ── Generic journal post ────────────────────────────────────────────────────
  // The replacement for src/lib/accounting/journal.postEntry(), which wrote a
  // Firestore JOURNAL collection — a SECOND ledger, separate from
  // ledger_entries, that nothing ever reconciled against the books the balance
  // sheet is built from. Every caller now lands here, so there is one book.
  //
  // ⚠️ IDEMPOTENCE CHANGED SHAPE, and callers must know how.
  // Firestore keyed the entry on (source_type, source_ref) as a document id, so
  // re-posting OVERWROTE — posting the same event again with different amounts
  // silently corrected it. ledger_entries is append-only by trigger and cannot
  // do that. Here a repeat post is a NO-OP: it returns already:true and changes
  // nothing. That preserves the contract callers actually rely on ("re-running
  // a sync never duplicates") and refuses the one they should never have had
  // ("posting again quietly rewrites history"). A correction is a reversal plus
  // a new entry, which is the rule everywhere else in this system.
  app.post(
    '/journal',
    { schema: { body: { type: 'object', required: ['source_type', 'source_ref', 'lines'], additionalProperties: false, properties: {
      source_type: { type: 'string', minLength: 1, maxLength: 60 },
      source_ref: { type: 'string', minLength: 1, maxLength: 200 },
      date: { type: ['string', 'null'], format: 'date' },
      narration: { type: ['string', 'null'], maxLength: 400 },
      company: { type: ['string', 'null'], maxLength: 120 },
      branch: { type: ['string', 'null'], maxLength: 60 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      lines: {
        type: 'array', minItems: 2, maxItems: 100,
        items: {
          type: 'object', required: ['ledger', 'dr_cr', 'amount'], additionalProperties: false,
          properties: {
            ledger: { type: 'string', minLength: 1, maxLength: 160 },
            // Accepts the browser's 'Dr'/'Cr' as well as the table's 'DR'/'CR'.
            dr_cr: { type: 'string', pattern: '^([Dd][Rr]|[Cc][Rr])$' },
            amount: { type: 'number', exclusiveMinimum: 0 },
            group: { type: ['string', 'null'], maxLength: 80 },
          },
        },
      },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      try {
        const out = await postVoucher({
          type: 'JOURNAL',
          entry_date: b.date ?? new Date().toISOString().slice(0, 10),
          narration: b.narration || `${b.source_type} ${b.source_ref}`,
          source_type: b.source_type,
          ref_no: b.source_ref,
          company: b.company ?? null,
          branch: b.branch ?? null,
          created_by: b.created_by ?? null,
          lines: b.lines.map((l) => ({
            ledger: l.ledger,
            dr_cr: l.dr_cr.toUpperCase(),
            amount: l.amount,
            group: l.group ?? null,
          })),
        });
        if (out.posted) await drain().catch(() => {});
        reply.code(201);
        return { posted: true, already: false, voucher_id: out.voucher_id };
      } catch (err) {
        if (err.code === 'DUPLICATE_REF') {
          // Already posted under this reference — the caller's re-run is a no-op.
          const { rows: [prior] } = await query(
            `SELECT voucher_id FROM ledger_entries
              WHERE source_type = $1 AND source_ref = $2 AND voucher_id IS NOT NULL LIMIT 1`,
            [b.source_type, b.source_ref]);
          return { posted: false, already: true, voucher_id: prior?.voucher_id ?? null };
        }
        const map = { UNBALANCED: 422, BAD_LINES: 400, BAD_AMOUNT: 400, BAD_TYPE: 400 };
        if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message });
        throw err;
      }
    }
  );

  // What the old getJournal()/ledgerBalances()/reconcile() answered, from the
  // real ledger. `reconcile` is trivially true here — voucher_must_balance is a
  // deferred database constraint, so an unbalanced voucher cannot be committed;
  // the view is reported anyway so a caller sees the same shape.
  app.get('/journal', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT voucher_id, min(entry_date) AS date, min(source_type) AS source_type,
              min(source_ref) AS source_ref, min(particulars) AS narration, min(company) AS company,
              SUM(amount) FILTER (WHERE dr_cr = 'DR')::numeric(14,2) AS total,
              json_agg(json_build_object('ledger', ledger_name, 'dr_cr', dr_cr, 'amount', amount)
                       ORDER BY dr_cr DESC, id) AS lines
         FROM ledger_entries
        WHERE voucher_id IS NOT NULL
          AND ($1::date IS NULL OR entry_date >= $1)
          AND ($2::date IS NULL OR entry_date <= $2)
        GROUP BY voucher_id
        ORDER BY min(entry_date) DESC
        LIMIT $3`,
      [req.query.from || null, req.query.to || null, req.query.limit ?? 2000]);
    return { count: rows.length, entries: rows };
  });

  // ── Voucher reversal ────────────────────────────────────────────────────────
  // The book has no delete. ledger_entries is append-only by trigger, so a wrong
  // voucher is corrected by posting its mirror image and leaving both in the
  // audit trail — which is also what a statutory audit expects to find.
  app.post(
    '/vouchers/:id/reverse',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 300 },
            entry_date: { type: ['string', 'null'], format: 'date' },
            created_by: { type: ['string', 'null'], maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: legs } = await query(
        `SELECT ledger_name, dr_cr, amount, company, branch
           FROM ledger_entries WHERE voucher_id = $1::uuid ORDER BY id`,
        [req.params.id]
      );
      if (!legs.length) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'no such voucher' });

      const ref = `REV-${req.params.id}`;
      const already = await query(
        `SELECT 1 FROM ledger_entries WHERE source_type = 'REVERSAL' AND source_ref = $1 LIMIT 1`,
        [ref]
      );
      if (already.rows.length) {
        return reply.code(409).send({ error: 'ALREADY_REVERSED', detail: 'this voucher already has a reversal' });
      }

      try {
        const out = await postVoucher({
          type: 'JOURNAL',
          lines: legs.map((l) => ({
            ledger: l.ledger_name,
            dr_cr: l.dr_cr === 'DR' ? 'CR' : 'DR', // mirror image
            amount: Number(l.amount),
          })),
          source_type: 'REVERSAL',
          ref_no: ref,
          entry_date: req.body.entry_date ?? new Date().toISOString().slice(0, 10),
          narration: `Reversal of voucher ${req.params.id} — ${req.body.reason}`,
          company: legs[0].company,
          branch: legs[0].branch,
          created_by: req.body.created_by ?? null,
        });
        if (out.posted) await drain().catch(() => {});
        reply.code(201);
        return { reversed: req.params.id, ...out };
      } catch (err) {
        const map = { DUPLICATE_REF: 409, UNBALANCED: 422, BAD_LINES: 400, BAD_TYPE: 400 };
        if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message });
        throw err;
      }
    }
  );
}
