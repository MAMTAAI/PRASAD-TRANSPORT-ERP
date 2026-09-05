// server/modules/tollImport.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Import toll rows read off the banks' FASTag wallet statements, and post them.
//
// THE WHOLE POINT OF THIS FILE IS NOT TO CHARGE A TOLL TWICE. The GTROPY API
// already pulls these same transactions: 2,870 of them, 14,55,900, and they are
// already in the ledger. The spreadsheets overlap that period heavily — of 3,539
// rows read off 84 workbooks, 2,526 are transactions the API had already
// fetched. Importing the file naively would bill the fleet for them a second
// time, and because a toll is small and plausible nobody would notice.
//
// So every row is checked twice before it can reach the books:
//
//   1. The bank's own transaction id. Both the API and the statement carry it,
//      and it is exact. This catches 2,526.
//   2. Same truck, same amount, within five minutes. A weaker rule, kept
//      because the ids could diverge between two feeds of the same event.
//
// The second rule is not decoration and it is not sufficient on its own — both
// facts were measured rather than assumed. Run against rows the id check
// already condemns, it independently catches 2,197 of 2,526, so it demonstrably
// fires; but it MISSES 329, because for those the two feeds disagree about when
// the transaction happened by more than five minutes. Relying on time and amount
// alone, as it is tempting to do when the ids look untrustworthy, would have let
// 329 duplicate tolls through.
//
// WHERE THE TOLL LANDS depends on who owns the truck, exactly as fuel does:
//
//   company-owned   Dr  Direct Expenses - Toll & FASTag     (our cost)
//                       Cr  FASTag Wallet: <company>        (prepaid, consumed)
//   attached        Dr  <vehicle owner's khata>             (recoverable)
//                       Cr  FASTag Wallet: <company>
//
// The credit is the wallet, not a payable: this money is already gone. It was
// loaded into the FASTag account before the truck ever reached the plaza, so the
// deduction consumes a prepaid asset rather than creating a liability. Crediting
// a payable here would invent a debt that nobody is owed.
//
// NOTHING WRITES WITHOUT commit:true, and every voucher's reference is the
// bank's transaction id, so TARA's duplicate guard is a third line of defence
// behind the two above.
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '../db/pool.js';
import { isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const TOLL_EXPENSE = 'Direct Expenses - Toll & FASTag';
const TOLL_GROUP = 'Direct Expenses - Toll & FASTag';
const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';
const WALLET_GROUP = 'Prepaid Cards & Wallets (Asset)';

// Which FASTag account the money actually left. The folder a statement came
// from IS that account — these vehicles carry no company_id, so the wallet
// cannot be derived from the truck, and guessing it would credit the wrong
// company's prepaid balance.
const WALLETS = {
  'JAISWAL ENTERPRISE': 'FASTag Wallet: Jaiswal Enterprise',
  'PRASAD TRANSPORT': 'FASTag Wallet: Prasad Transport',
};

const DUP_WINDOW_MINUTES = 5;

export async function registerTollImportRoutes(app) {
  app.post(
    '/bulk-import',
    { schema: { body: { type: 'object', required: ['rows'], properties: {
      rows: { type: 'array', maxItems: 20000, items: { type: 'object' } },
      commit: { type: 'boolean', default: false },
      created_by: { type: ['string', 'null'], maxLength: 60 },
      dup_window_minutes: { type: 'integer', minimum: 0, maximum: 120, default: DUP_WINDOW_MINUTES },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const body = req.body ?? {};
      const rows = body.rows ?? [];
      if (!rows.length) return reply.code(400).send({ error: 'NO_ROWS' });
      const commit = body.commit === true;
      const win = body.dup_window_minutes ?? DUP_WINDOW_MINUTES;

      const veh = await query(
        `SELECT v.id, v.vehicle_no, v.vehicle_no_norm, v.ownership, v.company_id, v.branch_id,
                l.ledger_name AS owner_ledger
           FROM vehicles v LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id`);
      const byNorm = new Map(veh.rows.map((v) => [v.vehicle_no_norm, v]));

      const posted = [];
      const skipped = [];      // already ours — the whole reason this file exists
      const review = [];
      const errors = [];

      for (const r of rows) {
        const flags = [];
        const park = (reason) => review.push({ ...r, reasons: [...flags, reason] });

        if (!r.vehicle_norm || !r.txn_datetime || !(Number(r.amount) > 0)) { park('INCOMPLETE_ROW'); continue; }

        const vehicle = byNorm.get(r.vehicle_norm);
        if (!vehicle) { park('VEHICLE_NOT_IN_MASTER'); continue; }

        // ── 1. the bank's own id, exact ───────────────────────────────────────
        if (r.ext_txn_id) {
          const hit = await query(
            `SELECT id FROM toll_transactions WHERE ext_txn_id = $1 LIMIT 1`, [String(r.ext_txn_id)]);
          if (hit.rows.length) {
            skipped.push({ ...r, matched_by: 'EXT_TXN_ID', existing_id: hit.rows[0].id });
            continue;
          }
        }

        // ── 2. same truck, same amount, within the window ────────────────────
        // Matched through norm_reg() on vehicle_no, not vehicle_id: every one
        // of the 2,870 rows the API wrote has a NULL vehicle_id, so joining on
        // it would compare against nothing and quietly find no duplicates.
        // The txn_date bound is not redundant with the timestamp bound — it is
        // what lets the planner use idx_toll_vehicle_date instead of scanning
        // the table once per imported row. It spans a day either side because
        // a five-minute window can straddle midnight.
        //
        // Deliberately NOT wrapped in a catch: if this query is ever broken by
        // a schema change, the import must fail loudly. Swallowing the error
        // would turn the duplicate check into a no-op that still looks like it
        // ran, which is the one outcome worse than not having it.
        const near = await query(
          `SELECT id, txn_datetime FROM toll_transactions
            WHERE norm_reg(vehicle_no) = $1
              AND amount = $2::numeric
              AND txn_date BETWEEN ($3::timestamptz - interval '1 day')::date
                               AND ($3::timestamptz + interval '1 day')::date
              AND txn_datetime BETWEEN $3::timestamptz - ($4 || ' minutes')::interval
                                   AND $3::timestamptz + ($4 || ' minutes')::interval
            LIMIT 1`,
          [r.vehicle_norm, r.amount, r.txn_datetime, String(win)]);
        if (near.rows.length) {
          skipped.push({ ...r, matched_by: `VEHICLE_TIME_AMOUNT_${win}MIN`, existing_id: near.rows[0].id });
          continue;
        }

        // ── 3. which trip was this truck running that day ────────────────────
        const trip = await query(
          `SELECT id, trip_code FROM trips
            WHERE vehicle_id = $1::uuid
              AND $2::date BETWEEN loading_date AND COALESCE(unloading_date, loading_date + 15)
            ORDER BY loading_date DESC LIMIT 1`,
          [vehicle.id, String(r.txn_datetime).slice(0, 10)]);
        const tripId = trip.rows[0]?.id ?? null;
        if (!tripId) flags.push('STANDALONE_NO_TRIP');

        const wallet = WALLETS[r.company_hint];
        if (!wallet) { park('NO_WALLET_FOR_COMPANY'); continue; }

        // Informational only since 5-Sep-2026 (migration 161): the toll is
        // the company's expense on every lorry and the 15-day bill recovers it
        // from an attached owner. See the debit below.
        const attached = vehicle.ownership === 'ATTACHED';

        const rec = {
          ext_txn_id: r.ext_txn_id, vehicle: vehicle.vehicle_no, vehicle_id: vehicle.id,
          trip_id: tripId, trip_code: trip.rows[0]?.trip_code ?? null,
          txn_datetime: r.txn_datetime, amount: Number(r.amount), plaza: r.plaza_name,
          wallet, flags, mode: attached ? 'ATTACHED' : 'OWNED',
        };

        if (!commit) { posted.push(rec); continue; }

        try {
          // ── ONE rule for toll (owner, 5-Sep-2026; migration 161) ──────────
          // Company expense on every lorry; recovered from an attached owner on
          // the 15-day bill (Vehicle Expense Recovery, migration 160). Debiting
          // his khata here as well would charge the same crossing twice.
          const debit = { ledger: TOLL_EXPENSE, group: TOLL_GROUP };

          const ref = `TOLL-${r.ext_txn_id ?? `${vehicle.vehicle_no_norm}-${r.txn_datetime}-${r.amount}`}`;
          const voucher = await postVoucher({
            type: 'JOURNAL',
            source_type: 'TOLL_STATEMENT',
            ref_no: ref,
            entry_date: String(r.txn_datetime).slice(0, 10),
            narration: `Toll ${r.plaza_name ?? ''} — ${vehicle.vehicle_no} (${r.bank ?? 'FASTag'})`
              .replace(/\s+/g, ' ').trim(),
            vehicle_id: vehicle.id,
            company_id: vehicle.company_id,
            branch_id: vehicle.branch_id,
            created_by: body.created_by ?? 'toll-import',
            lines: [
              { ledger: debit.ledger, dr_cr: 'DR', amount: Number(r.amount), group: debit.group, vehicle_id: vehicle.id },
              { ledger: wallet, dr_cr: 'CR', amount: Number(r.amount), group: WALLET_GROUP },
            ],
          });

          // The toll is booked as a cost the moment it is posted above, so it is
          // NOT also a receivable waiting to be claimed. Marking it billable
          // here would let the claim screen invoice a customer for money the
          // P&L has already absorbed, and the same rupee would be counted twice.
          const ins = await query(
            `INSERT INTO toll_transactions
               (ext_txn_id, txn_ref, vehicle_id, vehicle_no, trip_id, txn_datetime, txn_date,
                amount, plaza_name, provider, tag_id, is_billable, billing_type, claim_status,
                company, remarks)
             VALUES ($1,$2,$3::uuid,$4,$5::uuid,$6::timestamptz,$6::date,$7::numeric,$8,$9,$10,
                     false,'Company Cost (Statement Import)','UNCLAIMED',$11,$12)
             ON CONFLICT (ext_txn_id) WHERE ext_txn_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [r.ext_txn_id ?? null, r.txn_ref ?? null, vehicle.id, vehicle.vehicle_no, tripId,
             r.txn_datetime, r.amount, r.plaza_name ?? null, r.bank ?? null, r.tag_id ?? null,
             r.company_hint ?? null, r.source_file ?? null]);

          posted.push({ ...rec, toll_txn_id: ins.rows[0]?.id ?? null, voucher_id: voucher?.voucher_id ?? null });
        } catch (e) {
          if (e.code === 'DUPLICATE_REF') {
            skipped.push({ ...r, matched_by: 'VOUCHER_REF_ALREADY_POSTED' });
            continue;
          }
          errors.push({ vehicle: r.vehicle_norm, at: r.txn_datetime, code: e.code ?? 'POST_FAILED', detail: e.message });
        }
      }

      const sum = (list, k = 'amount') => Number(list.reduce((n, x) => n + Number(x[k] || 0), 0).toFixed(2));
      const byMatch = skipped.reduce((a, s) => { a[s.matched_by] = (a[s.matched_by] ?? 0) + 1; return a; }, {});

      return {
        ok: true,
        dry_run: !commit,
        summary: {
          total_rows_processed: rows.length,
          duplicates_skipped_api_matched: skipped.length,
          duplicates_value: sum(skipped),
          new_toll_rows_posted: posted.length,
          new_toll_amount_posted: sum(posted),
          to_review: review.length,
          errors: errors.length,
          by_fleet: posted.reduce((a, p) => { a[p.mode] = (a[p.mode] ?? 0) + 1; return a; }, {}),
          matched_to_trip: posted.filter((p) => p.trip_id).length,
          standalone: posted.filter((p) => !p.trip_id).length,
          dup_window_minutes: win,
        },
        skipped_by_rule: byMatch,
        review_reasons: review.reduce((a, q) => {
          for (const x of (q.reasons ?? [])) a[x] = (a[x] ?? 0) + 1;
          return a;
        }, {}),
        errors: errors.slice(0, 20),
        sample: posted.slice(0, 10),
      };
    }
  );
}
