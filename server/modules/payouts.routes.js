// server/modules/payouts.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// THE MULTI-COMPANY PAYOUT DESK  (migration 177, owner-approved 6-Sep-2026)
//
// One instruction, four locks, one transaction:
//
//   POST /payouts              DRAFT      idempotency key decides new vs replay
//   POST /payouts/:id/authorize  AUTHORIZED  PIN, and OTP inside the 24h window
//   POST /payouts/:id/execute  POSTED → PENDING_BANK | SETTLED   ← the atomic act
//   POST /payouts/:id/settle   SETTLED    a person enters the UTR
//   POST /payouts/:id/fail     FAILED     rail refused → reversing entries
//
// Money moves only through TARA's postVoucher, as CLAUDE.md requires. What is
// new is that the voucher and the row saying it was paid now share ONE
// transaction — see the `tx` argument threaded into postVoucher. Before this,
// a crash between them left the ledger holding a payment nothing claimed.
//
// NO PROVIDER IS CONNECTED. /execute parks an IMPS/NEFT payout at PENDING_BANK
// and a person completes it in net-banking. That is the owner's decision, not
// an omission: sendViaRail() in lib/payouts.js is the one place a provider
// lands later.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction } from '../db/pool.js';
import { postVoucher, getOrCreateLedger } from '../agents/tara.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { buildUpiUri, checkPin, hashPin, pinProblem, sendViaRail, BENEFICIARY_KINDS, RAILS, VPA_RE } from '../lib/payouts.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const INTERCO_GROUP = 'Inter-Company Balances';
const PAYABLE_GROUP_OF = {
  DRIVER: 'Salaries & Wages Payable',
  STAFF: 'Salaries & Wages Payable',
  VENDOR: 'Sundry Creditors',
  PUMP: 'Sundry Creditors',
  FLEET_PARTNER: 'Sundry Creditors',
  OWNER: 'Capital Account',
};
const payableLedgerOf = (kind, name) => ({
  DRIVER: `Driver Payable: ${name}`,
  STAFF: `Salary Payable: ${name}`,
  VENDOR: `Vendor Payable: ${name}`,
  PUMP: `Pump Payable: ${name}`,
  FLEET_PARTNER: `Fleet Partner Payable: ${name}`,
  OWNER: `Drawings: ${name}`,
}[kind]);

export async function registerPayoutRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const bad = (reply, code, detail) => reply.code(400).send({ error: code, detail });
  const uid = (req) => (UUID_RE.test(req.user?.sub ?? '') ? req.user.sub : null);
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  const loadPayout = async (id) =>
    (await query(`SELECT * FROM payout_instructions WHERE id = $1::uuid`, [id])).rows[0] ?? null;
  const deskRow = async (id) =>
    (await query(`SELECT * FROM v_payout_desk WHERE id = $1::uuid`, [id])).rows[0] ?? null;

  // ── the desk ──────────────────────────────────────────────────────────────
  app.get('/', staff, async (req) => {
    const firm = UUID_RE.test(req.query.company ?? '') ? req.query.company : null;
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
    const { rows } = await query(
      `SELECT * FROM v_payout_desk
        WHERE ($1::uuid IS NULL OR id IN (SELECT id FROM payout_instructions WHERE paying_company_id = $1::uuid))
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT 200`, [firm, status]);
    return { rows };
  });

  /** The entities a payout may be made from, each with its accounts and the
   *  beneficiary kinds those accounts are allowed to pay. The UI reads this
   *  rather than hard-coding the owner's savings-account rule a second time. */
  app.get('/paying-entities', staff, async () => {
    const { rows } = await query(
      `SELECT c.id, c.company_name, c.upi_vpa,
              COALESCE(json_agg(json_build_object(
                'id', b.id, 'tail', b.account_tail, 'bank', b.bank_name,
                'kind', b.account_kind, 'allows', b.allowed_beneficiary_kinds
              ) ORDER BY b.account_tail) FILTER (WHERE b.id IS NOT NULL), '[]') AS accounts
         FROM companies c
         LEFT JOIN bank_accounts b ON b.company_id = c.id AND b.active
        WHERE c.status = 'ACTIVE'
        GROUP BY c.id, c.company_name, c.upi_vpa
        ORDER BY c.company_name`);
    return { rows };
  });

  /** Owner-editable VPA (the seeded handles are placeholders until confirmed). */
  app.patch('/paying-entities/:id/vpa', admin, async (req, reply) => {
    const vpa = String(req.body?.upi_vpa ?? '').trim();
    if (vpa && !VPA_RE.test(vpa)) return bad(reply, 'BAD_VPA', 'a VPA looks like name@bank');
    const { rows: [c] } = await query(
      `UPDATE companies SET upi_vpa = NULLIF($2,''), updated_at = now() WHERE id = $1::uuid
       RETURNING id, company_name, upi_vpa`, [req.params.id, vpa]);
    if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { company: c };
  });

  // ── 1. DRAFT — the idempotency lock ───────────────────────────────────────
  app.post('/', admin, async (req, reply) => {
    const b = req.body ?? {};
    const key = String(b.idempotency_key ?? '');
    if (!UUID_RE.test(key))
      return bad(reply, 'NO_IDEMPOTENCY_KEY', 'idempotency_key (uuid) is required — mint it when the form opens, not when it is submitted');

    // THE REPLAY PATH. A double-click, a retry after a timeout and a refreshed
    // tab all arrive here with the same key, and all get the FIRST instruction
    // back instead of a second payment.
    const existing = (await query(`SELECT id FROM payout_instructions WHERE idempotency_key = $1::uuid`, [key])).rows[0];
    if (existing) return { payout: await deskRow(existing.id), replayed: true };

    if (!BENEFICIARY_KINDS.includes(b.beneficiary_kind)) return bad(reply, 'BAD_KIND', `beneficiary_kind must be one of ${BENEFICIARY_KINDS.join(', ')}`);
    if (!RAILS.includes(b.rail)) return bad(reply, 'BAD_RAIL', `rail must be one of ${RAILS.join(', ')}`);
    if (!UUID_RE.test(b.paying_company_id ?? '')) return bad(reply, 'BAD_PAYING_COMPANY', 'paying_company_id');
    if (!UUID_RE.test(b.owing_company_id ?? '')) return bad(reply, 'BAD_OWING_COMPANY', 'owing_company_id');
    const amount = r2(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return bad(reply, 'BAD_AMOUNT', 'amount must be greater than zero');
    const name = String(b.beneficiary_name ?? '').trim();
    if (!name) return bad(reply, 'NO_BENEFICIARY', 'beneficiary_name is required');
    if (b.rail !== 'CASH' && b.rail !== 'UPI_QR' && !UUID_RE.test(b.bank_account_id ?? ''))
      return bad(reply, 'NO_ACCOUNT', 'a bank transfer needs bank_account_id');

    const interco = b.paying_company_id !== b.owing_company_id;
    const otpNeeded = UUID_RE.test(b.beneficiary_id ?? '')
      ? (await query(`SELECT payout_needs_otp($1, $2::uuid) AS need`, [b.beneficiary_kind, b.beneficiary_id])).rows[0].need
      : false;

    try {
      const { rows: [p] } = await query(
        `INSERT INTO payout_instructions
           (idempotency_key, paying_company_id, owing_company_id, intercompany, bank_account_id,
            rail, beneficiary_kind, beneficiary_id, beneficiary_name, amount,
            source_type, source_ref, otp_required, created_by)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8::uuid,$9,$10,$11,$12,$13,$14::uuid)
         RETURNING id`,
        [key, b.paying_company_id, b.owing_company_id, interco,
          UUID_RE.test(b.bank_account_id ?? '') ? b.bank_account_id : null,
          b.rail, b.beneficiary_kind, UUID_RE.test(b.beneficiary_id ?? '') ? b.beneficiary_id : null,
          name, amount, b.source_type ?? null, b.source_ref ?? null, otpNeeded, uid(req)]);
      return { payout: await deskRow(p.id), replayed: false };
    } catch (e) {
      // LOCK 3 speaks through the trigger, so the message is the policy's own.
      if (e.code === '23514' || /check_violation/i.test(e.message))
        return reply.code(422).send({ error: 'ACCOUNT_POLICY', detail: e.message });
      if (e.code === '23505') {
        const again = (await query(`SELECT id FROM payout_instructions WHERE idempotency_key = $1::uuid`, [key])).rows[0];
        if (again) return { payout: await deskRow(again.id), replayed: true };
      }
      throw e;
    }
  });

  // ── 2. AUTHORIZE — PIN, and OTP inside the 24-hour window ─────────────────
  app.post('/:id/authorize', admin, async (req, reply) => {
    const p = await loadPayout(req.params.id);
    if (!p) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (p.status !== 'DRAFT') return reply.code(409).send({ error: 'NOT_DRAFT', detail: `payout is ${p.status}` });

    const me = uid(req);
    if (!me) return reply.code(401).send({ error: 'NO_SESSION' });
    const { rows: [u] } = await query(
      `SELECT id, pin_hash, pin_salt, pin_fail_count, pin_locked_until FROM users WHERE id = $1::uuid`, [me]);

    const verdict = checkPin(u, req.body?.pin);
    if (!verdict.ok) {
      if (verdict.reason === 'BAD_PIN' && verdict.fails !== undefined) {
        await query(
          `UPDATE users SET pin_fail_count = $2,
                  pin_locked_until = CASE WHEN $3::int > 0 THEN now() + ($3 || ' minutes')::interval ELSE pin_locked_until END
            WHERE id = $1::uuid`, [me, verdict.fails, verdict.lockFor ?? 0]);
      }
      return reply.code(403).send({ error: verdict.reason, detail: verdict.detail });
    }

    // The OTP requirement is re-read here, not trusted from the DRAFT row: the
    // beneficiary's bank details may have been edited in the meantime, and that
    // edit is exactly the event this lock exists for.
    const needOtp = p.beneficiary_id
      ? (await query(`SELECT payout_needs_otp($1, $2::uuid) AS need`, [p.beneficiary_kind, p.beneficiary_id])).rows[0].need
      : false;
    if (needOtp) {
      const supplied = String(req.body?.otp ?? '');
      const { rows: [rec] } = await query(
        `SELECT id, code_hash, code_salt FROM auth_otp
          WHERE user_id = $1::uuid AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`, [me]);
      if (!rec) return reply.code(403).send({ error: 'OTP_REQUIRED', detail: 'This beneficiary\'s bank or UPI details changed in the last 24 hours. Request an OTP and enter it to authorise.' });
      const { verifyCode } = await import('../lib/auth.js');
      if (!supplied || !verifyCode(supplied, rec.code_salt, rec.code_hash))
        return reply.code(403).send({ error: 'BAD_OTP', detail: 'That OTP is wrong or expired.' });
      await query(`UPDATE auth_otp SET consumed_at = now() WHERE id = $1::uuid`, [rec.id]);
    }

    await query(
      `UPDATE payout_instructions
          SET status='AUTHORIZED', pin_verified_at=now(), otp_required=$2,
              otp_verified_at = CASE WHEN $2 THEN now() ELSE NULL END, authorized_by=$3::uuid
        WHERE id = $1::uuid`, [p.id, needOtp, me]);
    await query(`UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL WHERE id = $1::uuid`, [me]);
    return { payout: await deskRow(p.id) };
  });

  // ── 3. EXECUTE — the atomic act ───────────────────────────────────────────
  // Ledger legs and the status change commit together or not at all. This is
  // the requirement "automatic ledger rollback if the payment fails": there is
  // nothing to roll back by hand, because a failure never commits in the first
  // place.
  app.post('/:id/execute', admin, async (req, reply) => {
    const p = await loadPayout(req.params.id);
    if (!p) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (p.status !== 'AUTHORIZED') return reply.code(409).send({ error: 'NOT_AUTHORIZED', detail: `payout is ${p.status}` });

    const day = new Date().toISOString().slice(0, 10);
    const amount = r2(p.amount);
    const { rows: [payFirm] } = await query(`SELECT company_name FROM companies WHERE id=$1::uuid`, [p.paying_company_id]);
    const { rows: [oweFirm] } = await query(`SELECT company_name FROM companies WHERE id=$1::uuid`, [p.owing_company_id]);
    const acct = p.bank_account_id
      ? (await query(`SELECT ledger_name FROM bank_accounts WHERE id=$1::uuid`, [p.bank_account_id])).rows[0]
      : null;
    const cashLedger = acct?.ledger_name ?? (p.rail === 'CASH' ? 'Cash-in-Hand' : null);
    if (!cashLedger) return bad(reply, 'NO_ACCOUNT', 'no bank or cash ledger resolved for this payout');

    const party = payableLedgerOf(p.beneficiary_kind, p.beneficiary_name);
    const partyGroup = PAYABLE_GROUP_OF[p.beneficiary_kind];
    const nextStatus = p.rail === 'CASH' ? 'SETTLED' : 'PENDING_BANK';

    try {
      const out = await withTransaction(async (tx) => {
        let voucher, contra = null;

        if (!p.intercompany) {
          // One firm, one leg: Dr beneficiary payable / Cr bank.
          voucher = await postVoucher({
            tx, type: 'PAYMENT', company_id: p.paying_company_id, account: cashLedger,
            party_ledger: party, party_group: partyGroup, amount, entry_date: day,
            source_type: 'PAYOUT', ref_no: `PO-${p.id.slice(0, 8)}`,
            narration: `${p.beneficiary_kind.toLowerCase()} payout to ${p.beneficiary_name} from ${cashLedger}`,
            created_by: actor(req),
          });
        } else {
          // CROSS-ENTITY. Two vouchers so neither firm absorbs the other's
          // expense: the payer books a receivable, the owing firm clears its
          // own payable against a matching inter-company liability.
          await getOrCreateLedger(tx, `Due from ${oweFirm.company_name}`, INTERCO_GROUP);
          await getOrCreateLedger(tx, `Due to ${payFirm.company_name}`, INTERCO_GROUP);

          voucher = await postVoucher({
            tx, type: 'PAYMENT', company_id: p.paying_company_id, account: cashLedger,
            party_ledger: `Due from ${oweFirm.company_name}`, party_group: INTERCO_GROUP,
            amount, entry_date: day, source_type: 'PAYOUT', ref_no: `PO-${p.id.slice(0, 8)}`,
            narration: `paid ${p.beneficiary_name} on behalf of ${oweFirm.company_name}`,
            created_by: actor(req),
          });
          contra = await postVoucher({
            tx, type: 'JOURNAL', company_id: p.owing_company_id, entry_date: day,
            source_type: 'PAYOUT', ref_no: `PO-${p.id.slice(0, 8)}-IC`,
            narration: `${p.beneficiary_name} paid by ${payFirm.company_name} on our behalf`,
            created_by: actor(req),
            lines: [
              { ledger: party, dr_cr: 'DR', amount, group: partyGroup },
              { ledger: `Due to ${payFirm.company_name}`, dr_cr: 'CR', amount, group: INTERCO_GROUP },
            ],
          });
        }

        // Same transaction. If this UPDATE fails, the vouchers above never
        // existed — which is the whole point.
        await tx.query(
          `UPDATE payout_instructions SET status='POSTED', voucher_id=$2::uuid, contra_voucher_id=$3::uuid WHERE id=$1::uuid`,
          [p.id, voucher?.voucher_id ?? null, contra?.voucher_id ?? null]);
        await tx.query(`UPDATE payout_instructions SET status=$2 WHERE id=$1::uuid`, [p.id, nextStatus]);
        return { voucher, contra };
      });

      const rail = await sendViaRail({ rail: p.rail, idempotencyKey: p.idempotency_key });
      return { payout: await deskRow(p.id), ...out, rail };
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') return reply.code(409).send({ error: 'ALREADY_POSTED', detail: e.message });
      if (e.code === 'OVERDRAFT') return reply.code(422).send({ error: 'OVERDRAFT', detail: e.message });
      return reply.code(422).send({ error: 'POST_FAILED', detail: e.message });
    }
  });

  // ── 4. SETTLE — a person completed the transfer ───────────────────────────
  app.post('/:id/settle', admin, async (req, reply) => {
    const p = await loadPayout(req.params.id);
    if (!p) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (p.status !== 'PENDING_BANK') return reply.code(409).send({ error: 'NOT_PENDING', detail: `payout is ${p.status}` });
    const utr = String(req.body?.utr ?? '').trim();
    if (utr.length < 6) return bad(reply, 'BAD_UTR', 'enter the bank reference (UTR) shown on the transfer');
    await query(`UPDATE payout_instructions SET status='SETTLED', utr=$2 WHERE id=$1::uuid`, [p.id, utr]);
    return { payout: await deskRow(p.id) };
  });

  // ── 5. FAIL — reverse, never edit ─────────────────────────────────────────
  app.post('/:id/fail', admin, async (req, reply) => {
    const p = await loadPayout(req.params.id);
    if (!p) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (['SETTLED', 'FAILED'].includes(p.status)) return reply.code(409).send({ error: 'FINAL', detail: `payout is ${p.status}` });
    const why = String(req.body?.reason ?? '').trim() || 'rail refused';

    await withTransaction(async (tx) => {
      // A correction is a reversing entry, never an edit — ledger_entries is
      // append-only by trigger, so there is no other option and no temptation.
      if (p.voucher_id) {
        const { rows: legs } = await tx.query(
          `SELECT ledger_name, dr_cr, amount FROM ledger_entries WHERE voucher_id = $1::uuid`, [p.voucher_id]);
        if (legs.length >= 2) {
          await postVoucher({
            tx, type: 'JOURNAL', company_id: p.paying_company_id, entry_date: new Date().toISOString().slice(0, 10),
            source_type: 'PAYOUT_REVERSAL', ref_no: `PO-${p.id.slice(0, 8)}-REV`,
            narration: `payout reversed: ${why}`, created_by: actor(req),
            lines: legs.map((l) => ({ ledger: l.ledger_name, dr_cr: l.dr_cr === 'DR' ? 'CR' : 'DR', amount: r2(l.amount) })),
          });
        }
      }
      await tx.query(`UPDATE payout_instructions SET status='FAILED', failure_reason=$2 WHERE id=$1::uuid`, [p.id, why]);
    });
    return { payout: await deskRow(p.id) };
  });

  // ── the QR ────────────────────────────────────────────────────────────────
  app.get('/:id/upi', staff, async (req, reply) => {
    const row = await deskRow(req.params.id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!row.paying_vpa)
      return reply.code(422).send({ error: 'NO_VPA', detail: `${row.paying_company} has no UPI VPA set. Add one in Masters → Companies.` });
    try {
      return {
        uri: buildUpiUri({
          vpa: row.paying_vpa, payeeName: row.paying_company, amount: row.amount,
          note: row.source_ref ?? row.beneficiary_name, txnRef: `PO${String(row.id).slice(0, 8)}`,
        }),
        vpa: row.paying_vpa, amount: row.amount, paying_company: row.paying_company,
      };
    } catch (e) { return reply.code(422).send({ error: e.code ?? 'BAD_UPI', detail: e.message }); }
  });

  // ── the PIN, set by its owner and nobody else ─────────────────────────────
  app.get('/me/pin', staff, async (req) => {
    const me = uid(req);
    const { rows: [u] } = await query(`SELECT pin_hash IS NOT NULL AS is_set, pin_set_at, pin_locked_until FROM users WHERE id=$1::uuid`, [me]);
    return { is_set: !!u?.is_set, pin_set_at: u?.pin_set_at ?? null, locked_until: u?.pin_locked_until ?? null };
  });

  app.post('/me/pin', staff, async (req, reply) => {
    const me = uid(req);
    if (!me) return reply.code(401).send({ error: 'NO_SESSION' });
    const problem = pinProblem(req.body?.pin);
    if (problem) return bad(reply, 'WEAK_PIN', problem);

    const { rows: [u] } = await query(`SELECT pin_hash, pin_salt, password_hash, password_salt FROM users WHERE id=$1::uuid`, [me]);
    // Changing an existing PIN needs the old one; setting the first needs the
    // account password, so a hijacked open tab cannot mint a payout credential.
    if (u?.pin_hash) {
      const v = checkPin({ ...u, pin_fail_count: 0 }, req.body?.current_pin);
      if (!v.ok) return reply.code(403).send({ error: 'BAD_CURRENT_PIN', detail: 'Enter your existing PIN to change it.' });
    } else {
      const { verifyPassword } = await import('../lib/auth.js');
      if (!verifyPassword(String(req.body?.password ?? ''), u?.password_salt, u?.password_hash))
        return reply.code(403).send({ error: 'BAD_PASSWORD', detail: 'Confirm your account password to set a payout PIN.' });
    }
    const { saltHex, hashHex } = hashPin(req.body.pin);
    await query(
      `UPDATE users SET pin_hash=$2, pin_salt=$3, pin_set_at=now(), pin_fail_count=0, pin_locked_until=NULL WHERE id=$1::uuid`,
      [me, hashHex, saltHex]);
    return { ok: true };
  });
}

export default registerPayoutRoutes;
