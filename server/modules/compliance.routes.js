// server/modules/compliance.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// What is about to expire, and the compliance fees that were never posted.
//
// THE ALERT FEED IS NOT ONLY ABOUT LORRIES. vehicle_documents is empty — not
// one row for 49 trucks — so a compliance screen reading it alone truthfully
// reports nothing while six driver licences are already expired, three of them
// hazardous-goods endorsements. A driver whose HZD lapsed cannot legally take a
// petroleum load, which stops the lorry exactly as a lapsed fitness would. So
// the feed covers vehicle documents, the denormalised expiry columns, and
// driver licences together, at one threshold: v_compliance_alerts.
//
// THE RETROSPECTIVE POSTER HAS A HARD FLOOR. It posts compliance fees that were
// recorded without an accounting entry, but only for documents dated on or
// after the cut-off. Anything older is left alone deliberately: those costs
// belong to a closed year whose opening balances already absorb them, and
// posting them now would charge FY26-27 with expenses it did not incur. The
// floor is a parameter with no default that reaches the ledger — a caller has
// to say which year it means.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const COMPLIANCE_LEDGER = 'Vehicle Compliance & Docs';
const COMPLIANCE_GROUP = 'Direct Expenses (Vehicle Compliance & Docs)';
const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';

export async function registerComplianceRoutes(app) {
  // ── the dashboard feed ───────────────────────────────────────────────────
  app.get(
    '/alerts',
    { schema: { querystring: { type: 'object', properties: {
      within_days: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
      subject_kind: { type: ['string', 'null'], enum: ['VEHICLE', 'DRIVER', null] },
      include_valid: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query;
      const { rows } = await query(
        `SELECT subject_kind, subject_id, subject, ownership, owner_name, branch,
                doc_type, doc_name, expires_on, days_left, status, amount,
                receipt_no, voucher_id, source
           FROM v_compliance_alerts
          WHERE ($1::int IS NULL OR days_left <= $1)
            AND ($2::text IS NULL OR subject_kind = $2)
            AND ($3::boolean OR status <> 'VALID')
          ORDER BY days_left ASC, subject
          LIMIT $4`,
        [q.within_days ?? null, q.subject_kind ?? null, q.include_valid === true, q.limit ?? 500]);

      // The window the view itself judges 'EXPIRING' by, so the dashboard can
      // say "10 days" without hardcoding a number the database might disagree
      // with later.
      const { rows: [{ days }] } = await query(`SELECT compliance_alert_days() AS days`);

      const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
      return {
        alert_window_days: Number(days),
        as_of: new Date().toISOString().slice(0, 10),
        counts: { EXPIRED: counts.EXPIRED ?? 0, EXPIRING: counts.EXPIRING ?? 0, VALID: counts.VALID ?? 0 },
        total: rows.length,
        alerts: rows,
      };
    }
  );

  // ── fees recorded but never posted ───────────────────────────────────────
  app.post(
    '/post-missing-expenses',
    { schema: { body: { type: 'object', required: ['from_date'], properties: {
      from_date: { type: 'string', format: 'date' },
      to_date: { type: ['string', 'null'], format: 'date' },
      account: { type: ['string', 'null'], maxLength: 120 },
      commit: { type: 'boolean', default: false },
      created_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { from_date, to_date = null, account = null, commit = false } = req.body ?? {};

      // inspected_on is this table's issue/payment date — the day the fee was
      // actually incurred. A document with no date at all cannot be placed in a
      // financial year, so it is reported rather than guessed into one.
      const { rows: docs } = await query(
        `SELECT d.id, d.doc_type, d.doc_name, d.inspected_on, d.amount, d.receipt_no,
                d.payment_mode, d.voucher_id,
                v.id AS vehicle_id, v.vehicle_no, v.branch, v.is_company_owned,
                l.ledger_name AS owner_ledger
           FROM vehicle_documents d
           JOIN vehicles v ON v.id = d.vehicle_id
           LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
          WHERE d.amount IS NOT NULL AND d.amount > 0
            AND d.voucher_id IS NULL
          ORDER BY d.inspected_on NULLS LAST, v.vehicle_no`);

      const posted = [], skipped = [], problems = [];
      for (const d of docs) {
        if (!d.inspected_on) {
          skipped.push({ vehicle: d.vehicle_no, doc: d.doc_type, why: 'no document date — cannot place it in a financial year' });
          continue;
        }
        const on = String(d.inspected_on).slice(0, 10);
        if (on < from_date) {
          skipped.push({ vehicle: d.vehicle_no, doc: d.doc_type, on,
                         why: `before the ${from_date} cut-off — belongs to a closed year` });
          continue;
        }
        if (to_date && on > to_date) {
          skipped.push({ vehicle: d.vehicle_no, doc: d.doc_type, on, why: `after ${to_date}` });
          continue;
        }

        const attached = !d.is_company_owned;
        if (attached && !d.owner_ledger) {
          problems.push({ vehicle: d.vehicle_no, doc: d.doc_type,
                          why: 'attached vehicle with no owner ledger — its cost has nowhere to go but P&L' });
          continue;
        }
        const debit = attached
          ? { ledger: d.owner_ledger, group: OWNER_GROUP }
          : { ledger: COMPLIANCE_LEDGER, group: COMPLIANCE_GROUP };

        const rec = { vehicle: d.vehicle_no, doc_type: d.doc_type, on,
                      amount: Number(d.amount), mode: attached ? 'ATTACHED' : 'OWNED',
                      debit: debit.ledger };
        if (!commit) { posted.push(rec); continue; }

        if (!account) {
          problems.push({ vehicle: d.vehicle_no, doc: d.doc_type,
                          why: 'a fee moves real money — name the bank or cash account it was paid from' });
          continue;
        }

        try {
          // Same reference shape the live hook uses, so a fee posted here and
          // the same fee re-saved through the document screen collide on TARA's
          // duplicate guard instead of being charged twice.
          const ref = `VEHDOC-${d.vehicle_id}-${d.doc_type}-${Number(d.amount).toFixed(2)}-${d.receipt_no ?? 'noref'}`;
          const voucher = await postVoucher({
            type: 'PAYMENT', account,
            party_ledger: debit.ledger, party_group: debit.group,
            amount: Number(d.amount), ref_no: ref, entry_date: on,
            narration: `${d.doc_name ?? d.doc_type} for ${d.vehicle_no}`
                     + `${d.receipt_no ? ` — receipt ${d.receipt_no}` : ''}`
                     + `${attached ? ' (attached — owner khata)' : ''}`,
            source_type: 'VEHICLE_COMPLIANCE',
            vehicle_id: d.vehicle_id, branch: d.branch,
            created_by: req.body.created_by ?? 'compliance-backfill',
          });
          await query(`UPDATE vehicle_documents SET voucher_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
            [d.id, voucher?.voucher_id ?? null]);
          posted.push({ ...rec, voucher_id: voucher?.voucher_id ?? null });
        } catch (e) {
          if (e.code === 'DUPLICATE_REF') { skipped.push({ ...rec, why: 'this exact fee is already posted' }); continue; }
          problems.push({ vehicle: d.vehicle_no, doc: d.doc_type, why: `${e.code ?? 'POST_FAILED'}: ${e.message}` });
        }
      }

      const sum = (l) => Number(l.reduce((a, x) => a + Number(x.amount || 0), 0).toFixed(2));
      return {
        ok: true, dry_run: !commit, cut_off: from_date,
        summary: {
          documents_with_unposted_fees: docs.length,
          postable: posted.length, posted_value: sum(posted),
          skipped: skipped.length, problems: problems.length,
          by_fleet: posted.reduce((a, p) => { a[p.mode] = (a[p.mode] ?? 0) + 1; return a; }, {}),
        },
        posted, skipped: skipped.slice(0, 50), problems: problems.slice(0, 50),
      };
    }
  );
}
