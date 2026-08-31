// ═══════════════════════════════════════════════════════════════════════════
// bazaarSettlement.routes.js — award → deposit → advance → POD → balance
//
// The office half of the Load Bazaar money lifecycle (Phase 2). Registered
// under /api/v1/bazaar, admin-only like the rest of the bazaar desk.
//
// THE 0%-ERROR RULE, APPLIED FOUR WAYS:
//   1. EVERY rupee goes through TARA (postVoucher). There is no INSERT into
//      ledger_entries here and no side wallet — this module writes workflow
//      state and asks TARA to move the money, so DR=CR balance checking, the
//      append-only guard and company isolation all apply automatically.
//   2. Deterministic ref_no per money event (BZADV-<id>, BZBAL-<id>,
//      BZDEP-<id>-V …) — TARA's duplicate guard makes double-posting a 409,
//      whatever the screen does.
//   3. The BALANCE cannot release before POD_VERIFIED. Checked here, where
//      the voucher is created — not in a UI that can be bypassed.
//   4. Vendor money also lands a vendor_txns subsidiary row WITH the
//      voucher_id, the same pairing masters.routes' vendor payment uses, so
//      the partner's portal khata and the GL can never tell two stories.
//
// Deposits use the party's own khata (Creditors:<vendor> / Debtors:<customer>)
// rather than a new ledger group — account_groups is a closed FK list, and a
// refundable trip-lock deposit IS money we owe back to that party. The
// narration and ref_no mark it as the deposit; the khata shows it plainly.
// ═══════════════════════════════════════════════════════════════════════════
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { requireAdminRole } from './auth.routes.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';
import { notifyWhatsApp } from '../lib/notify.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

const vErr = (reply, err) => {
  const map = { DUPLICATE_REF: 409, OVERDRAFT: 422, NO_ACCOUNT: 400, NO_PARTY: 400, BAD_AMOUNT: 400, UNBALANCED: 400 };
  if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
  throw err;
};

/**
 * Open the money lifecycle for a load that was just awarded. Runs INSIDE the
 * award's own transaction (both the customer accept-bid and the admin award) so
 * an award without a settlement row cannot exist.
 *
 * A load can be re-awarded after a cancel: the settlement's UNIQUE(load_id)
 * then upserts the SAME row back to AWAITING_CONFIRM — but only over a
 * CANCELLED one, and the voucher receipt columns are deliberately left alone:
 * money that moved is a fact, and the deposit-refund route is how it returns.
 */
export async function openSettlementInTx(c, load, bid) {
  const amount = Number(bid.bid_amount);
  if (!(amount > 0)) return null; // a ₹0 award has no money lifecycle to run
  const { rows } = await c.query(
    `INSERT INTO bazaar_settlements
       (load_id, bid_id, vendor_id, customer_id, awarded_amount, confirm_deadline)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, now() + interval '24 hours')
     ON CONFLICT (load_id) DO UPDATE SET
       bid_id = EXCLUDED.bid_id, vendor_id = EXCLUDED.vendor_id,
       customer_id = EXCLUDED.customer_id, awarded_amount = EXCLUDED.awarded_amount,
       status = 'AWAITING_CONFIRM', confirm_deadline = EXCLUDED.confirm_deadline,
       vendor_confirmed_at = NULL, market_vehicle_id = NULL, market_driver_id = NULL,
       cancel_reason = NULL, updated_at = now()
     WHERE bazaar_settlements.status = 'CANCELLED'
     RETURNING *`,
    [load.load_id, bid.id, bid.vendor_id ?? null, load.customer_id ?? null, amount]);
  return rows[0] ?? null;
}

// One row, with everything a desk screen needs to say about it.
const FULL = `
  SELECT s.*, l.origin, l.destination, l.material, l.weight, l.loading_date,
         l.customer_name, b.vendor_name, b.bid_amount,
         v.mobile_no AS vendor_mobile,
         mv.registration_no AS vehicle_reg, md.name AS driver_name_assigned
    FROM bazaar_settlements s
    JOIN bazaar_loads l ON l.load_id = s.load_id
    JOIN bazaar_bids b ON b.id = s.bid_id
    LEFT JOIN vendors v ON v.id = s.vendor_id
    LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
    LEFT JOIN market_drivers md ON md.id = s.market_driver_id`;

const getFull = async (id) => {
  const { rows } = await query(`${FULL} WHERE s.id = $1::uuid`, [id]);
  return rows[0] ?? null;
};

export function registerBazaarSettlementRoutes(app) {
  app.get('/settlements', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { status } = req.query ?? {};
    const args = [];
    let where = '';
    if (status) { args.push(String(status).toUpperCase()); where = 'WHERE s.status = $1'; }
    const { rows } = await query(`${FULL} ${where} ORDER BY s.created_at DESC LIMIT 200`, args);
    return { count: rows.length, settlements: rows };
  });

  app.get('/settlements/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const s = await getFull(req.params.id);
    if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { settlement: s };
  });

  // ── Set the firm / advance % before money moves ──────────────────────────
  app.patch('/settlements/:id', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const sets = [], args = [req.params.id];
    if (b.company_id !== undefined) {
      args.push(UUID_RE.test(String(b.company_id ?? '')) ? b.company_id : null);
      sets.push(`company_id = $${args.length}::uuid`);
    }
    if (b.advance_pct !== undefined) {
      const pct = Number(b.advance_pct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return reply.code(400).send({ error: 'BAD_PCT', detail: 'advance_pct must be 0–100' });
      }
      args.push(pct);
      sets.push(`advance_pct = $${args.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_SET' });
    const { rows } = await query(
      `UPDATE bazaar_settlements SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1::uuid AND status NOT IN ('SETTLED','CANCELLED') RETURNING *`, args);
    if (!rows.length) return reply.code(409).send({ error: 'LOCKED', detail: 'no such open settlement' });
    return { settlement: rows[0] };
  });

  // ── Refundable trip-lock deposit, either side ────────────────────────────
  // Money RECEIVED into our bank, owed back on completion — so it credits the
  // party's own khata. Vahak's anti-no-show mechanic, recorded honestly.
  app.post('/settlements/:id/deposit', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const side = String(b.side ?? '').toUpperCase();
    if (!['VENDOR', 'CUSTOMER'].includes(side)) {
      return reply.code(400).send({ error: 'BAD_SIDE', detail: 'side must be VENDOR or CUSTOMER' });
    }
    const amount = r2(b.amount);
    if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'a deposit needs a positive amount' });
    if (!b.account) return reply.code(400).send({ error: 'NO_ACCOUNT', detail: 'name the bank/cash account the deposit arrived in' });

    const s = await getFull(req.params.id);
    if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (['SETTLED', 'CANCELLED'].includes(s.status)) {
      return reply.code(409).send({ error: 'LOCKED', detail: `settlement is ${s.status}` });
    }
    const col = side === 'VENDOR' ? 'vendor_deposit_voucher_id' : 'customer_deposit_voucher_id';
    if (s[col]) return reply.code(409).send({ error: 'ALREADY_POSTED', detail: `${side.toLowerCase()} deposit already recorded` });

    try {
      const voucher = await postVoucher({
        type: 'RECEIPT',
        account: b.account,
        party_ledger: side === 'VENDOR' ? `Creditors: ${s.vendor_name}` : `Debtors: ${s.customer_name}`,
        party_group: side === 'VENDOR' ? 'Sundry Creditors (Vendors)' : 'Sundry Debtors (Customers)',
        amount,
        ref_no: `BZDEP-${s.id}-${side[0]}`,
        entry_date: b.entry_date ?? today(),
        narration: `Refundable trip-lock deposit (${side.toLowerCase()}) — load ${s.load_id} ${s.origin} → ${s.destination}`,
        source_type: 'BAZAAR_DEPOSIT',
        company_id: s.company_id ?? null,
        created_by: b.created_by ?? null,
      });
      await drain().catch(() => {});
      const { rows } = await query(
        `UPDATE bazaar_settlements SET ${col} = $2::uuid, deposit_amount = COALESCE(deposit_amount, $3),
                updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [s.id, voucher.voucher_id, amount]);
      return reply.code(201).send({ settlement: rows[0], voucher_id: voucher.voucher_id });
    } catch (err) { return vErr(reply, err); }
  });

  // The deposit goes back — on completion or a legitimate cancel.
  app.post('/settlements/:id/deposit-refund', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const side = String(b.side ?? '').toUpperCase();
    if (!['VENDOR', 'CUSTOMER'].includes(side)) {
      return reply.code(400).send({ error: 'BAD_SIDE', detail: 'side must be VENDOR or CUSTOMER' });
    }
    if (!b.account) return reply.code(400).send({ error: 'NO_ACCOUNT', detail: 'name the account the refund leaves' });
    const s = await getFull(req.params.id);
    if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    const paidCol = side === 'VENDOR' ? 'vendor_deposit_voucher_id' : 'customer_deposit_voucher_id';
    const refCol = side === 'VENDOR' ? 'vendor_deposit_refund_voucher_id' : 'customer_deposit_refund_voucher_id';
    if (!s[paidCol]) return reply.code(409).send({ error: 'NO_DEPOSIT', detail: `no ${side.toLowerCase()} deposit on record` });
    if (s[refCol]) return reply.code(409).send({ error: 'ALREADY_POSTED', detail: 'this deposit is already refunded' });
    const amount = r2(b.amount ?? s.deposit_amount);
    if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT' });

    try {
      const voucher = await postVoucher({
        type: 'PAYMENT',
        account: b.account,
        party_ledger: side === 'VENDOR' ? `Creditors: ${s.vendor_name}` : `Debtors: ${s.customer_name}`,
        party_group: side === 'VENDOR' ? 'Sundry Creditors (Vendors)' : 'Sundry Debtors (Customers)',
        amount,
        ref_no: `BZDEPREF-${s.id}-${side[0]}`,
        entry_date: b.entry_date ?? today(),
        narration: `Trip-lock deposit refunded (${side.toLowerCase()}) — load ${s.load_id}`,
        source_type: 'BAZAAR_DEPOSIT_REFUND',
        company_id: s.company_id ?? null,
        created_by: b.created_by ?? null,
      });
      await drain().catch(() => {});
      const { rows } = await query(
        `UPDATE bazaar_settlements SET ${refCol} = $2::uuid, updated_at = now()
          WHERE id = $1::uuid RETURNING *`, [s.id, voucher.voucher_id]);
      return reply.code(201).send({ settlement: rows[0], voucher_id: voucher.voucher_id });
    } catch (err) { return vErr(reply, err); }
  });

  // ── The advance (~90%) at loading ────────────────────────────────────────
  app.post('/settlements/:id/advance', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.account) return reply.code(400).send({ error: 'NO_ACCOUNT', detail: 'name the bank/cash account the advance leaves' });
    const s = await getFull(req.params.id);
    if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (s.status !== 'VEHICLE_ASSIGNED') {
      return reply.code(409).send({
        error: 'NOT_READY',
        detail: `advance releases only after the vendor confirms and a verified truck is assigned (settlement is ${s.status})`,
      });
    }
    if (s.advance_voucher_id) return reply.code(409).send({ error: 'ALREADY_POSTED', detail: 'advance already recorded' });
    const amount = r2(b.amount ?? (Number(s.awarded_amount) * Number(s.advance_pct) / 100));
    if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT' });
    if (amount > Number(s.awarded_amount)) {
      return reply.code(400).send({ error: 'BAD_AMOUNT', detail: `advance ₹${amount} exceeds the awarded ₹${s.awarded_amount}` });
    }

    try {
      const voucher = await postVoucher({
        type: 'PAYMENT',
        account: b.account,
        party_ledger: `Creditors: ${s.vendor_name}`,
        party_group: 'Sundry Creditors (Vendors)',
        amount,
        ref_no: `BZADV-${s.id}`,
        entry_date: b.entry_date ?? today(),
        narration: `Advance ${s.advance_pct}% — load ${s.load_id} ${s.origin} → ${s.destination} (${s.vehicle_reg ?? 'vehicle TBD'})`,
        source_type: 'BAZAAR_ADVANCE',
        company_id: s.company_id ?? null,
        created_by: b.created_by ?? null,
      });
      await drain().catch(() => {});
      // The subsidiary row the partner's portal khata reads — same pairing as
      // masters' vendor payment, so the two books cannot drift.
      await query(
        `INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount,
                                  payment_mode, remarks, voucher_id, created_by)
         VALUES ($1::uuid, $2, $3::date, 'PAYMENT_GIVEN', $4, $5, $6, $7::uuid, $8)`,
        [s.vendor_id, s.vendor_name, b.entry_date ?? today(), amount, b.payment_mode ?? null,
         `Bazaar advance — load ${s.load_id}`, voucher.voucher_id, b.created_by ?? null]);
      const { rows } = await query(
        `UPDATE bazaar_settlements SET status = 'ADVANCE_PAID', advance_voucher_id = $2::uuid,
                advance_amount = $3, updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [s.id, voucher.voucher_id, amount]);
      if (s.vendor_mobile) {
        notifyWhatsApp(s.vendor_mobile,
          `💰 Load Bazaar: load ${s.load_id} ka advance ₹${amount.toLocaleString('en-IN')} record ho gaya. `
          + `Balance POD verify hone ke baad milega.`);
      }
      return reply.code(201).send({ settlement: rows[0], voucher_id: voucher.voucher_id });
    } catch (err) { return vErr(reply, err); }
  });

  // ── POD check ────────────────────────────────────────────────────────────
  app.post('/settlements/:id/pod/verify', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const s = await getFull(req.params.id);
    if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!s.pod_file) return reply.code(409).send({ error: 'NO_POD', detail: 'nothing to verify — no POD has been uploaded' });
    if (!['POD_SUBMITTED', 'ADVANCE_PAID'].includes(s.status)) {
      return reply.code(409).send({ error: 'NOT_READY', detail: `settlement is ${s.status}` });
    }
    const { rows } = await query(
      `UPDATE bazaar_settlements SET status = 'POD_VERIFIED', pod_verified_at = now(),
              pod_verified_by = $2, pod_note = $3, updated_at = now()
        WHERE id = $1::uuid RETURNING *`,
      [s.id, req.body?.verified_by ?? null, req.body?.note ?? null]);
    return { settlement: rows[0] };
  });

  // ── The balance — ONLY after the POD is verified ─────────────────────────
  app.post('/settlements/:id/balance', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.account) return reply.code(400).send({ error: 'NO_ACCOUNT', detail: 'name the bank/cash account the balance leaves' });
    const s = await getFull(req.params.id);
    if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    // THE GATE. The whole point of Phase 2: no verified delivery proof, no
    // final rupee. Enforced where the voucher is created.
    if (s.status !== 'POD_VERIFIED') {
      return reply.code(409).send({
        error: 'POD_NOT_VERIFIED',
        detail: `the balance releases only after the POD is checked (settlement is ${s.status})`,
      });
    }
    if (s.balance_voucher_id) return reply.code(409).send({ error: 'ALREADY_POSTED', detail: 'balance already recorded' });
    const due = r2(Number(s.awarded_amount) - Number(s.advance_amount ?? 0));
    const amount = r2(b.amount ?? due);
    if (!(amount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'nothing left to pay' });
    if (amount > due + 0.005) {
      return reply.code(400).send({ error: 'BAD_AMOUNT', detail: `₹${amount} exceeds the ₹${due} still due on this load` });
    }

    try {
      const voucher = await postVoucher({
        type: 'PAYMENT',
        account: b.account,
        party_ledger: `Creditors: ${s.vendor_name}`,
        party_group: 'Sundry Creditors (Vendors)',
        amount,
        ref_no: `BZBAL-${s.id}`,
        entry_date: b.entry_date ?? today(),
        narration: `Balance after POD — load ${s.load_id} ${s.origin} → ${s.destination}`,
        source_type: 'BAZAAR_BALANCE',
        company_id: s.company_id ?? null,
        created_by: b.created_by ?? null,
      });
      await drain().catch(() => {});
      await query(
        `INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount,
                                  payment_mode, remarks, voucher_id, created_by)
         VALUES ($1::uuid, $2, $3::date, 'PAYMENT_GIVEN', $4, $5, $6, $7::uuid, $8)`,
        [s.vendor_id, s.vendor_name, b.entry_date ?? today(), amount, b.payment_mode ?? null,
         `Bazaar balance — load ${s.load_id}`, voucher.voucher_id, b.created_by ?? null]);
      const { rows } = await query(
        `UPDATE bazaar_settlements SET status = 'SETTLED', balance_voucher_id = $2::uuid,
                balance_amount = $3, updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [s.id, voucher.voucher_id, amount]);
      if (s.vendor_mobile) {
        notifyWhatsApp(s.vendor_mobile,
          `✅ Load Bazaar: load ${s.load_id} SETTLE ho gaya — balance ₹${amount.toLocaleString('en-IN')} record hua. `
          + `Kaam ke liye dhanyavaad!`);
      }
      return reply.code(201).send({ settlement: rows[0], voucher_id: voucher.voucher_id });
    } catch (err) { return vErr(reply, err); }
  });

  // ── Cancel (the workflow, never the books) ───────────────────────────────
  // Vouchers already posted stay posted — money that moved is a fact. The
  // deposit-refund route above is how it comes back, visibly.
  app.post('/settlements/:id/cancel', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'reason is required' });
    const { rows } = await query(
      `UPDATE bazaar_settlements SET status = 'CANCELLED', cancel_reason = $2, updated_at = now()
        WHERE id = $1::uuid AND status NOT IN ('SETTLED','CANCELLED') RETURNING *`,
      [req.params.id, reason]);
    if (!rows.length) return reply.code(409).send({ error: 'LOCKED', detail: 'no such open settlement' });
    // The load reopens for fresh bids so the freight itself is not lost.
    await query(`UPDATE bazaar_loads SET status = 'OPEN', updated_at = now() WHERE load_id = $1`, [rows[0].load_id]);
    await query(`UPDATE bazaar_bids SET status = 'REJECTED', updated_at = now()
                  WHERE id = $1::uuid AND status = 'ACCEPTED'`, [rows[0].bid_id]);
    return { settlement: rows[0] };
  });
}
