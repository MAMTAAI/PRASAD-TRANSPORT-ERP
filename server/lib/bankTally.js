// server/lib/bankTally.js
// ─────────────────────────────────────────────────────────────────────────────
// THE BANK TALLY ENGINE — every statement line against what the ERP expects.
//
// Owner, 5-Sep-2026: "bank statement upload karo, TARA auto-tally kare;
// exact match ledger me post ho aur dues clear; jo match na ho staff ke
// dashboard par." Four answers: SBI 5913 is Prasad's; inter-firm money is
// CAPITAL; Gautam's savings defaults to "not ours"; book entries the bank
// does not know are FLAGGED, never reversed.
//
// ORDER OF PROOF for one line (the first that fits decides):
//   0. already in the book        same bank ledger, same amount, same side,
//                                 ±4 days, not yet linked      → LINKED
//   1. UTR = IOCL advice          bank_ref of iocl_payment_advices; the
//                                 advice voucher exists          → LINKED
//   2. a rule staff taught        bank_party_rules (counterparty / pattern /
//                                 UTR prefix)                    → AUTO_POSTED or REVIEW
//   3. our own firms              JAISWAL / PRASAD / GAUTAM in the narration:
//                                 same firm → contra (posted from the paying
//                                 side only); other firm → capital  → AUTO_POSTED
//   4. bank charges / interest    pattern, small                 → AUTO_POSTED
//   5. FASTag / fleet card loads  pattern → the firm's wallet     → AUTO_POSTED
//   6. loan EMI debits            lender pattern → REVIEW with the schedule's
//                                 nearby entries as candidates (decision 4)
//   7. a customer paying          payer name → customer master; ONE open bill
//                                 whose balance equals the amount → AUTO_POSTED
//                                 (receipt + trip settlements), else REVIEW
//   8. paying an owner            payee ≈ attached owner; ONE approved bill
//                                 whose payable equals the amount → AUTO_POSTED
//   9. paying a vendor / driver   payee ≈ vendor or driver name  → REVIEW
//  10. cash                       ATM / self / cash deposit      → REVIEW
//  11. personal account default   nothing claimed it            → NOT_OURS
//  12. otherwise                                                 → REVIEW (unmatched)
//
// NOTHING IS GUESSED INTO THE LEDGER. Auto-posting needs an exact, unique
// proof; every voucher carries ref BANK-<tail>-<uid> so a second run is a
// DUPLICATE_REF no-op; every decision (TARA's or a person's) is on the line.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FIRMS = [
  { key: 'JAISWAL', name: 'M/S JAISWAL ENTERPRISE', re: /JAISWAL ENTERPRISE|JAISWAL ENT|\bJAISWAL\b/ },
  { key: 'PRASAD', name: 'M/S PRASAD TRANSPORT', re: /PRASAD TRANSPORT|MS PRASA|M S PRASA|\bPRASAD TRANS/ },
  { key: 'GAUTAM', name: 'M/S GAUTAM PRASAD', re: /GAUTAM PRASAD|\bGAUTAM\b/ },
];
const SOURCE_CAT = { ADVICE_SETTLEMENT: 'CUSTOMER_RECEIPT', LOAN_EMI: 'LOAN_EMI', FASTAG_RECHARGE: 'FASTAG_RECHARGE', TYRE_PURCHASE: 'VENDOR_PAYMENT', VEHICLE_COMPLIANCE: 'VENDOR_PAYMENT', OWNER_EXPENSE: 'OWNER_PAYMENT', VOUCHER: 'BOOK_VOUCHER', RECEIPT_REVERSAL: 'BOOK_VOUCHER', BANK_RECON: 'BOOK_VOUCHER' };
export const CATEGORIES = ['CUSTOMER_RECEIPT', 'OWNER_PAYMENT', 'PARTNER_PAYMENT', 'VENDOR_PAYMENT', 'DRIVER_ADVANCE', 'LOAN_EMI', 'INTER_FIRM', 'FASTAG_RECHARGE', 'FLEET_CARD_LOAD', 'BANK_CHARGE', 'BANK_INTEREST', 'CASH', 'LEDGER', 'BOOK_VOUCHER', 'OTHER_RECEIPT', 'OTHER_PAYMENT'];

const refFor = (acct, line) => `BANK-${acct.account_tail}-${String(line.line_uid).slice(0, 12)}`;
const dirOf = (line) => (num(line.credit) > 0 ? 'CR' : 'DR');           // statement side
const amtOf = (line) => r2(num(line.credit) || num(line.debit));
const bookSide = (line) => (num(line.credit) > 0 ? 'DR' : 'CR');         // the bank ledger's side

// ── ledgers the engine may need to create ────────────────────────────────────
async function ensureGroup(t, group, type, side, statement) {
  await t.query(`INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
                 SELECT $1, $2, $3, $4, 300, false WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE group_head = $1)`, [group, type, statement, side]);
}
async function ensureLedger(t, name, group, company = null, side = 'DR') {
  await t.query(`INSERT INTO ledgers (ledger_name, group_head, company, dr_cr, branch, status, creation_type)
                 SELECT $1, $2, $3, $4, 'ALL', 'ACTIVE', 'SYSTEM' WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = $1)`, [name, group, company, side]);
  return name;
}
const GROUP_OF = { 'Sundry Debtors (Customers)': ['ASSET', 'DR', 'BALANCE_SHEET'], 'Sundry Creditors (Vehicle Owners)': ['LIABILITY', 'CR', 'BALANCE_SHEET'], 'Sundry Creditors (Vendors)': ['LIABILITY', 'CR', 'BALANCE_SHEET'],
  'Current Assets - Driver Advances': ['ASSET', 'DR', 'BALANCE_SHEET'], 'Secured Loans': ['LIABILITY', 'CR', 'BALANCE_SHEET'], 'Prepaid Cards & Wallets (Asset)': ['ASSET', 'DR', 'BALANCE_SHEET'],
  'Cash-in-Hand': ['ASSET', 'DR', 'BALANCE_SHEET'], 'Indirect Expenses': ['EXPENSE', 'DR', 'PROFIT_AND_LOSS'], 'Other Income': ['INCOME', 'CR', 'PROFIT_AND_LOSS'], 'Capital Account': ['EQUITY', 'CR', 'BALANCE_SHEET'], 'Bank Accounts': ['ASSET', 'DR', 'BALANCE_SHEET'] };

// ── what the engine knows about the account ──────────────────────────────────
export async function accountById(id) { return (await query('SELECT * FROM bank_accounts WHERE id = $1::uuid', [id])).rows[0] ?? null; }
export async function accountByNo(no) { return (await query('SELECT * FROM bank_accounts WHERE account_no = $1 OR account_no LIKE $2', [String(no), '%' + String(no).slice(-11)])).rows[0] ?? null; }

async function loadContext(acct) {
  const firm = acct.company_name || '';
  const firmKey = FIRMS.find((f) => f.re.test(norm(firm)))?.key ?? null;
  const [customers, owners, vendors, drivers, loans, rules, cards, wallets] = await Promise.all([
    query(`SELECT id, customer_name FROM customers WHERE status = 'ACTIVE'`).then((r) => r.rows),
    query(`SELECT DISTINCT regexp_replace(ledger_name, '^Vehicle Owner: ', '') AS owner_name FROM ledgers WHERE ledger_name LIKE 'Vehicle Owner: %'`).then((r) => r.rows.map((x) => x.owner_name)),
    query(`SELECT id, vendor_name, vendor_kind, mobile_no FROM vendors`).then((r) => r.rows),
    query(`SELECT id, name, mobile FROM drivers WHERE COALESCE(status, 'ACTIVE') <> 'INACTIVE'`).then((r) => r.rows),
    query(`SELECT id, bank_name, vehicle_no, emi_amount, company_name, financier_ledger, loan_account_no FROM loan_master`).then((r) => r.rows),
    query(`SELECT * FROM bank_party_rules WHERE account_id IS NULL OR account_id = $1::uuid ORDER BY account_id NULLS LAST, created_at`, [acct.id]).then((r) => r.rows),
    query(`SELECT provider, wallet_ledger, operating_company FROM fleet_card_accounts WHERE active AND wallet_ledger IS NOT NULL`).then((r) => r.rows),
    query(`SELECT ledger_name, company FROM ledgers WHERE ledger_name LIKE 'FASTag Wallet%'`).then((r) => r.rows),
  ]);
  const short = firm.replace(/^M\/S\s+/i, '').replace(/\s+/g, ' ').trim();
  const fastag = wallets.find((w) => norm(w.ledger_name).includes(norm(short).split(' ')[0]))?.ledger_name ?? null;
  return { acct, firm, firmKey, customers, owners, vendors, drivers, loans, rules, cards, fastag, short };
}

// name ≈ name: the statement truncates and drops vowels ("SHAHIDUL", "RATI KAN")
function nameHit(cp, names) {
  const c = norm(cp); if (c.length < 4) return null;
  const c1 = c.split(' ')[0];
  let best = null;
  for (const n of names) {
    const nn = norm(n); if (!nn) continue;
    const n1 = nn.split(' ')[0];
    if (nn === c || nn.startsWith(c) || c.startsWith(nn)) return n;
    if (c1.length >= 5 && n1.startsWith(c1)) best = best ?? n;
    if (c1.length >= 5 && nn.includes(c1)) best = best ?? n;
  }
  return best;
}

// ── posting ──────────────────────────────────────────────────────────────────
async function postLines(ctx, line, lines, narration, by, sourceType = 'BANK_RECON') {
  const ref = refFor(ctx.acct, line);
  try {
    const v = await postVoucher({ type: 'JOURNAL', source_type: sourceType, company_id: ctx.acct.company_id, ref_no: ref, entry_date: line.txn_date, narration, created_by: by, lines });
    return v?.voucher_id ?? null;
  } catch (e) {
    if (e.code === 'DUPLICATE_REF') {
      const { rows: [x] } = await query(`SELECT voucher_id FROM ledger_entries WHERE source_ref = $1 LIMIT 1`, [ref]);
      return x?.voucher_id ?? null;
    }
    throw e;
  }
}
const bankLine = (ctx, line, side) => ({ ledger: ctx.acct.ledger_name, dr_cr: side, amount: amtOf(line), group: 'Bank Accounts' });
const otherLine = (ledger, side, amt, group) => ({ ledger, dr_cr: side, amount: amt, group });

/**
 * Post a decision for a line and return {voucher_id, target_kind, target_id, target_label, trip_id}.
 * d = { category, party_kind, party_id, party_name, ledger_name, bill_id, trip_id, other_firm, other_ledger }
 */
export async function postDecision(ctx, line, d, by) {
  const amt = amtOf(line); const side = bookSide(line); const contra = side === 'DR' ? 'CR' : 'DR';
  const nar = (what) => `Bank ${ctx.acct.ledger_name} ${line.txn_date}: ${what} — ${String(line.description).slice(0, 80)}${line.utr ? ' · UTR ' + line.utr : ''}`;
  let voucher = null, target_kind = null, target_id = null, target_label = null, trip_id = d.trip_id ?? null;
  switch (d.category) {
    case 'CUSTOMER_RECEIPT': {
      const name = d.party_name; if (!name) throw new Error('customer needed');
      const ledger = `Debtors: ${name}`;
      await withTransaction((t) => ensureLedger(t, ledger, 'Sundry Debtors (Customers)', null, 'DR'));
      voucher = await postLines(ctx, line, [bankLine(ctx, line, 'DR'), otherLine(ledger, 'CR', amt, 'Sundry Debtors (Customers)')], nar(`receipt from ${name}`), by);
      target_kind = 'CUSTOMER'; target_id = d.party_id ?? null; target_label = name;
      if (d.bill_id) {
        // spread the money over the bill's trips (gross − penalty basis) as
        // manual settlements — the same road a person takes on the bill
        const { rows: trips } = await query(`SELECT trip_id, trip_code, gross, penalty, received FROM v_customer_trip_recon WHERE customer_bill_id = $1::uuid ORDER BY bill_date, trip_code`, [d.bill_id]);
        const open = trips.map((t) => ({ ...t, due: r2(num(t.gross) - num(t.penalty) - num(t.received)) })).filter((t) => t.due > 0.5);
        const total = open.reduce((n, t) => n + t.due, 0);
        let left = amt;
        for (let i = 0; i < open.length && left > 0.005; i++) {
          const t = open[i]; const share = i === open.length - 1 ? r2(Math.min(left, t.due)) : r2(Math.min(left, t.due * Math.min(1, amt / (total || 1))));
          if (share <= 0) continue;
          await query(`INSERT INTO customer_trip_settlements (trip_id, received, settled_on, reference, note, updated_by)
                       VALUES ($1::uuid, $2, $3::date, $4, $5, $6)
                       ON CONFLICT (trip_id) DO UPDATE SET received = LEAST(customer_trip_settlements.received + EXCLUDED.received, $7), settled_on = EXCLUDED.settled_on, reference = EXCLUDED.reference, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [t.trip_id, r2(num(t.received) + share), line.txn_date, line.utr ?? refFor(ctx.acct, line), `bank line ${line.txn_date} ${inr(amt)} spread over the bill`, by, r2(num(t.gross) - num(t.penalty))]);
          left = r2(left - share);
        }
        await query('SELECT customer_bill_refresh($1::uuid)', [d.bill_id]);
        const { rows: [b] } = await query('SELECT bill_no FROM customer_bills WHERE id = $1::uuid', [d.bill_id]);
        target_kind = 'CUSTOMER_BILL'; target_id = d.bill_id; target_label = `${name} · ${b?.bill_no ?? ''}`;
      }
      break;
    }
    case 'OWNER_PAYMENT': case 'PARTNER_PAYMENT': {
      const name = d.party_name; if (!name) throw new Error('owner needed');
      const { rows: [ln] } = await query('SELECT vehicle_owner_ledger_name($1) AS l', [name]).catch(() => ({ rows: [{ l: `Vehicle Owner: ${name}` }] }));
      const ledger = ln?.l ?? `Vehicle Owner: ${name}`;
      await withTransaction((t) => ensureLedger(t, ledger, 'Sundry Creditors (Vehicle Owners)', null, 'CR'));
      voucher = await postLines(ctx, line, [otherLine(ledger, 'DR', amt, 'Sundry Creditors (Vehicle Owners)'), bankLine(ctx, line, 'CR')], nar(`paid to ${name}`), by);
      target_kind = 'OWNER'; target_label = name;
      if (d.bill_id) {
        await query(`UPDATE vehicle_owner_bills SET pay_voucher_id = COALESCE(pay_voucher_id, $2::uuid), paid_amount = COALESCE(paid_amount, 0) + $3, paid_at = COALESCE(paid_at, $4::timestamptz), paid_by = COALESCE(paid_by, $5) WHERE id = $1::uuid`, [d.bill_id, voucher, amt, line.txn_date, by]).catch(() => {});
        const { rows: [b] } = await query('SELECT bill_no FROM vehicle_owner_bills WHERE id = $1::uuid', [d.bill_id]);
        target_kind = 'OWNER_BILL'; target_id = d.bill_id; target_label = `${name} · ${b?.bill_no ?? ''}`;
      }
      break;
    }
    case 'VENDOR_PAYMENT': {
      const name = d.party_name; if (!name) throw new Error('vendor needed');
      const { rows: [ex] } = await query(`SELECT ledger_name, group_head FROM ledgers WHERE ledger_name = $1 OR ledger_name = $2 LIMIT 1`, [name, `Vendor: ${name}`]);
      const ledger = ex?.ledger_name ?? name; const group = ex?.group_head ?? 'Sundry Creditors (Vendors)';
      await withTransaction(async (t) => { await ensureGroup(t, group, ...(GROUP_OF[group] ?? ['LIABILITY', 'CR', 'BALANCE_SHEET'])); await ensureLedger(t, ledger, group, null, 'CR'); });
      voucher = await postLines(ctx, line, [otherLine(ledger, 'DR', amt, group), bankLine(ctx, line, 'CR')], nar(`paid to vendor ${name}`), by);
      if (d.party_id) await query(`INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount, payment_mode, remarks, voucher_id, created_by, approval_status)
                                    VALUES ($1::uuid, $2, $3::date, 'PAYMENT_GIVEN', $4, 'BANK', $5, $6::uuid, $7, 'DRAFT')`, [d.party_id, name, line.txn_date, amt, `bank line ${line.txn_date} ${line.utr ?? ''}`, voucher, by]).catch(() => {});
      target_kind = 'VENDOR'; target_id = d.party_id ?? null; target_label = name;
      break;
    }
    case 'DRIVER_ADVANCE': {
      const name = d.party_name; if (!name) throw new Error('driver needed');
      await withTransaction((t) => ensureLedger(t, name, 'Current Assets - Driver Advances', null, 'DR'));
      voucher = await postLines(ctx, line, [otherLine(name, 'DR', amt, 'Current Assets - Driver Advances'), bankLine(ctx, line, 'CR')], nar(`advance to driver ${name}`), by);
      await query(`INSERT INTO driver_transactions (driver_id, driver_name, txn_date, txn_type, amount, mode, remarks, trip_id, approval_status)
                   VALUES ($1::uuid, $2, $3::date, 'ADVANCE_GIVEN', $4, 'Bank/UPI', $5, $6::uuid, 'DRAFT')`, [d.party_id ?? null, name, line.txn_date, amt, `bank line ${line.txn_date} ${line.utr ?? ''} — linked on the reconciliation desk`, trip_id]).catch(() => {});
      target_kind = 'DRIVER'; target_id = d.party_id ?? null; target_label = name;
      break;
    }
    case 'LOAN_EMI': {
      const ledger = d.ledger_name; if (!ledger) throw new Error('loan ledger needed');
      await withTransaction((t) => ensureLedger(t, ledger, 'Secured Loans', null, 'CR'));
      voucher = await postLines(ctx, line, [otherLine(ledger, 'DR', amt, 'Secured Loans'), bankLine(ctx, line, 'CR')], nar(`loan instalment ${ledger}`), by);
      target_kind = 'LOAN'; target_id = d.party_id ?? null; target_label = ledger;
      break;
    }
    case 'INTER_FIRM': {
      const other = d.other_firm; if (!other) throw new Error('other firm needed');
      if (norm(other) === norm(ctx.firm)) {
        // our own two accounts of the same firm: post from the paying side only
        if (side === 'CR') {
          const otherLedger = d.other_ledger; if (!otherLedger) throw new Error('other bank ledger needed');
          voucher = await postLines(ctx, line, [otherLine(otherLedger, 'DR', amt, 'Bank Accounts'), bankLine(ctx, line, 'CR')], nar(`transfer to ${otherLedger}`), by);
          target_kind = 'BANK'; target_label = otherLedger;
        } else {
          const { rows: [v] } = await query(`SELECT voucher_id FROM ledger_entries WHERE ledger_name = $1 AND dr_cr = 'DR' AND amount = $2 AND abs(entry_date - $3::date) <= 4 AND source_type = 'BANK_RECON' ORDER BY abs(entry_date - $3::date) LIMIT 1`, [ctx.acct.ledger_name, amt, line.txn_date]);
          voucher = v?.voucher_id ?? null; target_kind = 'BANK'; target_label = d.other_ledger ?? 'own account';
          if (!voucher) return { pending: 'waiting for the paying account\'s statement' };
        }
      } else {
        const { rows: [c] } = await query('SELECT interfirm_capital_ledger($1, $2) AS l', [ctx.firm, other]);
        const cap = c.l;
        voucher = side === 'DR'
          ? await postLines(ctx, line, [bankLine(ctx, line, 'DR'), otherLine(cap, 'CR', amt, 'Capital Account')], nar(`capital in from ${other}`), by)
          : await postLines(ctx, line, [otherLine(cap, 'DR', amt, 'Capital Account'), bankLine(ctx, line, 'CR')], nar(`capital out to ${other}`), by);
        target_kind = 'FIRM'; target_label = other;
      }
      break;
    }
    case 'FASTAG_RECHARGE': {
      const ledger = d.ledger_name || ctx.fastag; if (!ledger) throw new Error('FASTag wallet ledger needed');
      voucher = await postLines(ctx, line, [otherLine(ledger, 'DR', amt, 'Prepaid Cards & Wallets (Asset)'), bankLine(ctx, line, 'CR')], nar('FASTag recharge'), by);
      target_kind = 'LEDGER'; target_label = ledger; break;
    }
    case 'FLEET_CARD_LOAD': {
      const ledger = d.ledger_name; if (!ledger) throw new Error('card wallet ledger needed');
      voucher = await postLines(ctx, line, [otherLine(ledger, 'DR', amt, 'Prepaid Cards & Wallets (Asset)'), bankLine(ctx, line, 'CR')], nar('fleet card load'), by);
      target_kind = 'LEDGER'; target_label = ledger; break;
    }
    case 'BANK_CHARGE': voucher = await postLines(ctx, line, [otherLine('Bank Charges', 'DR', amt, 'Indirect Expenses'), bankLine(ctx, line, 'CR')], nar('bank charges'), by); target_kind = 'LEDGER'; target_label = 'Bank Charges'; break;
    case 'BANK_INTEREST': voucher = await postLines(ctx, line, [bankLine(ctx, line, 'DR'), otherLine('Bank Interest Income', 'CR', amt, 'Other Income')], nar('bank interest'), by); target_kind = 'LEDGER'; target_label = 'Bank Interest Income'; break;
    case 'CASH': {
      const cash = d.ledger_name || 'Cash in Hand (HQ)';
      await withTransaction((t) => ensureLedger(t, cash, 'Cash-in-Hand', null, 'DR'));
      voucher = side === 'CR' ? await postLines(ctx, line, [otherLine(cash, 'DR', amt, 'Cash-in-Hand'), bankLine(ctx, line, 'CR')], nar('cash withdrawn'), by)
                              : await postLines(ctx, line, [bankLine(ctx, line, 'DR'), otherLine(cash, 'CR', amt, 'Cash-in-Hand')], nar('cash deposited'), by);
      target_kind = 'LEDGER'; target_label = cash; break;
    }
    case 'LEDGER': case 'OTHER_RECEIPT': case 'OTHER_PAYMENT': {
      const ledger = d.ledger_name; if (!ledger) throw new Error('ledger needed');
      const { rows: [g] } = await query('SELECT group_head FROM ledgers WHERE ledger_name = $1', [ledger]);
      const group = g?.group_head ?? (side === 'DR' ? 'Other Income' : 'Indirect Expenses');
      voucher = await postLines(ctx, line, side === 'DR' ? [bankLine(ctx, line, 'DR'), otherLine(ledger, 'CR', amt, group)] : [otherLine(ledger, 'DR', amt, group), bankLine(ctx, line, 'CR')], nar(`${ledger}`), by);
      target_kind = 'LEDGER'; target_label = ledger; break;
    }
    default: throw new Error(`cannot post category ${d.category}`);
  }
  return { voucher_id: voucher, target_kind, target_id, target_label, trip_id };
}

// ── the decision for one line ────────────────────────────────────────────────
async function decide(ctx, line) {
  const amt = amtOf(line); const dir = dirOf(line); const side = bookSide(line);
  const text = norm(`${line.description} ${line.ref_no}`); const cp = line.counterparty || ''; const cpn = norm(cp);
  const D = (o) => ({ status: 'REVIEW', confidence: 'REVIEW', ...o });

  // 0. already in the book
  const { rows: [bk] } = await query(`
    SELECT e.id, e.voucher_id, e.source_type, e.source_ref, e.particulars FROM ledger_entries e
     WHERE e.ledger_name = $1 AND e.dr_cr = $2 AND e.amount = $3 AND abs(e.entry_date - $4::date) <= 4
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.book_entry_id = e.id)
     ORDER BY abs(e.entry_date - $4::date), e.id LIMIT 1`, [ctx.acct.ledger_name, side, amt, line.txn_date]);
  if (bk) return D({ status: 'LINKED', confidence: 'AUTO', category: SOURCE_CAT[bk.source_type] ?? 'BOOK_VOUCHER', why: `already in the book (${bk.source_type} ${bk.source_ref ?? ''})`, book_entry_id: bk.id, voucher_id: bk.voucher_id, target_kind: 'BOOK_ENTRY', target_label: (bk.particulars ?? bk.source_ref ?? '').slice(0, 80) });

  // 1. IOCL advice by UTR
  if (line.utr) {
    const { rows: [adv] } = await query(`SELECT advice_id, odn, remitted, advice_date FROM iocl_payment_advices WHERE bank_ref = $1`, [line.utr]);
    if (adv) {
      const { rows: [v] } = await query(`SELECT voucher_id FROM ledger_entries WHERE source_ref = $1 LIMIT 1`, [`ADV-${adv.odn}`]);
      const exact = Math.abs(num(adv.remitted) - amt) < 1;
      if (v?.voucher_id && exact) return D({ status: 'LINKED', confidence: 'AUTO', category: 'CUSTOMER_RECEIPT', why: `UTR = IOCL advice ${adv.odn}, amount exact, advice journal posted`, voucher_id: v.voucher_id, target_kind: 'ADVICE', target_id: adv.advice_id, target_label: `IOCL advice ${adv.odn}` });
      return D({ category: 'CUSTOMER_RECEIPT', why: exact ? `UTR = IOCL advice ${adv.odn} — advice not yet posted (the advice run posts it, then this links itself)` : `UTR = IOCL advice ${adv.odn} but amount differs (${inr(adv.remitted)})`, target_kind: 'ADVICE', target_id: adv.advice_id, target_label: `IOCL advice ${adv.odn}` });
    }
  }

  // 2. a rule staff taught
  for (const r of ctx.rules) {
    if (r.direction !== 'ANY' && r.direction !== dir) continue;
    const hit = r.match_kind === 'COUNTERPARTY' ? (cpn && (cpn === norm(r.match_text) || cpn.startsWith(norm(r.match_text))))
      : r.match_kind === 'UTR_PREFIX' ? (line.utr && line.utr.startsWith(r.match_text))
      : (() => { try { return new RegExp(r.match_text, 'i').test(`${line.description} ${line.ref_no}`); } catch { return false; } })();
    if (!hit) continue;
    return D({ status: r.auto ? 'AUTO' : 'REVIEW', confidence: r.auto ? 'AUTO' : 'REVIEW', category: r.category, why: `${r.auto ? 'rule' : 'suggested by rule'}: ${r.match_kind.toLowerCase()} "${r.match_text}"`, rule_id: r.id,
      decision: { category: r.category, party_kind: r.party_kind, party_id: r.party_id, party_name: r.party_name, ledger_name: r.ledger_name, other_firm: r.party_kind === 'FIRM' ? r.party_name : null } });
  }

  // 3. our own firms
  const other = FIRMS.find((f) => f.re.test(text) || f.re.test(cpn));
  if (other) {
    const sameFirm = other.key === ctx.firmKey;
    if (sameFirm) {
      const { rows: others } = await query(`SELECT ledger_name FROM bank_accounts WHERE company_id = $1::uuid AND id <> $2::uuid`, [ctx.acct.company_id, ctx.acct.id]);
      const otherLedger = others.length === 1 ? others[0].ledger_name : null;
      if (!otherLedger) return D({ category: 'INTER_FIRM', why: 'transfer within the firm — which of our accounts?', target_kind: 'BANK' });
      return D({ status: 'AUTO', confidence: 'AUTO', category: 'INTER_FIRM', why: side === 'CR' ? `transfer to our own ${otherLedger}` : `transfer from our own ${otherLedger}`, decision: { category: 'INTER_FIRM', other_firm: ctx.firm, other_ledger: otherLedger } });
    }
    return D({ status: 'AUTO', confidence: 'AUTO', category: 'INTER_FIRM', why: `${side === 'DR' ? 'from' : 'to'} ${other.name} — capital movement between our firms (owner, 5-Sep)`, decision: { category: 'INTER_FIRM', other_firm: other.name } });
  }

  // 4. charges / interest
  if (dir === 'DR' && amt < 5000 && /CHARGE|CHRG|SMS CHG|GST|COMMISSION|CHEQUE BOOK|AMB CHG|MIN BAL|ANNUAL FEE|DEBIT CARD/.test(text)) return D({ status: 'AUTO', confidence: 'AUTO', category: 'BANK_CHARGE', why: 'bank charge pattern', decision: { category: 'BANK_CHARGE' } });
  if (dir === 'CR' && /INTEREST|INT\.? CR|INT CREDIT|CREDIT INTEREST/.test(text)) return D({ status: 'AUTO', confidence: 'AUTO', category: 'BANK_INTEREST', why: 'interest credit', decision: { category: 'BANK_INTEREST' } });

  // 5. wallets
  if (dir === 'DR' && /IHMCL|FASTAG|FAST TAG|NETC|PAYTM FASTAG/.test(text)) {
    if (ctx.fastag) return D({ status: 'AUTO', confidence: 'AUTO', category: 'FASTAG_RECHARGE', why: `FASTag recharge → ${ctx.fastag}`, decision: { category: 'FASTAG_RECHARGE', ledger_name: ctx.fastag } });
    return D({ category: 'FASTAG_RECHARGE', why: 'FASTag recharge — no FASTag wallet ledger for this firm' });
  }
  if (dir === 'DR' && /XTRAPOWER|XTRA POWER|IOCL.*(CARD|FLEET)|INDIANOIL.*(CARD|FLEET)|SMARTFLEET|SMART FLEET|HELLO BPCL|DRIVETRACK|DRIVE TRACK/.test(text)) {
    const prov = /XTRAPOWER|XTRA POWER|IOCL|INDIANOIL/.test(text) ? 'IOCL' : /BPCL|SMARTFLEET|HELLO/.test(text) ? 'BPCL' : 'HPCL';
    const card = ctx.cards.find((c) => c.provider === prov && norm(c.operating_company) === norm(ctx.firm)) ?? ctx.cards.find((c) => c.provider === prov);
    if (card) return D({ status: 'AUTO', confidence: 'AUTO', category: 'FLEET_CARD_LOAD', why: `${prov} card load → ${card.wallet_ledger}`, decision: { category: 'FLEET_CARD_LOAD', ledger_name: card.wallet_ledger } });
    return D({ category: 'FLEET_CARD_LOAD', why: `${prov} card load — no wallet ledger on file` });
  }

  // 6. loan EMIs (decision 4: the schedule already posted them → review, link to the schedule entry)
  if (dir === 'DR' && /STGT POOLING|SBI LOAN|\bLOAN\b|\bEMI\b|\bECS\b|\bNACH\b|ACH-DR|ACHDR|TATA CAPITAL|SUNDARAM|CHOLA|SHRIRAM|KOTAK|INDUSIND|HDFC BANK LTD|BAJAJ FIN|MAHINDRA FIN/.test(text)) {
    const loan = ctx.loans.filter((l) => Math.abs(num(l.emi_amount) - amt) < 1 && (!l.company_name || norm(l.company_name) === norm(ctx.short)));
    return D({ category: 'LOAN_EMI', why: loan.length === 1 ? `lender pattern; EMI amount = ${loan[0].bank_name} (${loan[0].vehicle_no}) — link to the schedule entry or post` : loan.length > 1 ? `lender pattern; ${loan.length} loans share this EMI amount` : 'lender pattern; amount is not a scheduled EMI (instalment split?)', target_kind: 'LOAN', target_id: loan.length === 1 ? loan[0].id : null, target_label: loan.length === 1 ? `${loan[0].bank_name} (${loan[0].vehicle_no})` : null });
  }

  // 7. a customer paying
  if (dir === 'CR') {
    const cust = nameHit(cp, ctx.customers.map((c) => c.customer_name)) || (/INDIAN OIL|IOCL|INDIANOIL/.test(text) ? ctx.customers.find((c) => /INDIAN OIL/i.test(c.customer_name))?.customer_name : /AADHAR/.test(text) ? ctx.customers.find((c) => /AADHAR/i.test(c.customer_name))?.customer_name : /BHARAT PETRO|BPCL/.test(text) ? ctx.customers.find((c) => /BHARAT PETROLEUM/i.test(c.customer_name))?.customer_name : /HINDUSTAN PETRO|HPCL/.test(text) ? ctx.customers.find((c) => /HINDUSTAN PETROLEUM/i.test(c.customer_name))?.customer_name : null);
    if (cust) {
      const c = ctx.customers.find((x) => x.customer_name === cust);
      const { rows: bills } = await query(`SELECT id, bill_no, balance, period_from FROM customer_bills WHERE customer_id = $1::uuid AND status IN ('RAISED','PART_PAID','DISPUTED') AND balance > 0.5 AND (company_id = $2::uuid OR $2::uuid IS NULL) ORDER BY period_from`, [c.id, ctx.acct.company_id]);
      const exact = bills.filter((b) => Math.abs(num(b.balance) - amt) < 2);
      if (exact.length === 1) return D({ status: 'AUTO', confidence: 'AUTO', category: 'CUSTOMER_RECEIPT', why: `${cust}: one open bill (${exact[0].bill_no}) with exactly this balance`, target_kind: 'CUSTOMER_BILL', target_id: exact[0].id, target_label: `${cust} · ${exact[0].bill_no}`, decision: { category: 'CUSTOMER_RECEIPT', party_kind: 'CUSTOMER', party_id: c.id, party_name: cust, bill_id: exact[0].id } });
      return D({ category: 'CUSTOMER_RECEIPT', why: bills.length ? `${cust}: ${bills.length} open bill(s), none equals this amount — which one(s)?` : `${cust}: no open raised bill in these books — receipt on account, or a bill still in draft`, target_kind: 'CUSTOMER', target_id: c.id, target_label: cust, decision: { category: 'CUSTOMER_RECEIPT', party_kind: 'CUSTOMER', party_id: c.id, party_name: cust } });
    }
  }

  // 8. paying an attached owner
  if (dir === 'DR') {
    const own = nameHit(cp, ctx.owners);
    if (own) {
      const { rows: bills } = await query(`SELECT id, bill_no, payable FROM vehicle_owner_bills WHERE upper(owner_name) = upper($1) AND status = 'APPROVED' AND pay_voucher_id IS NULL AND payable IS NOT NULL ORDER BY period_from`, [own]);
      const exact = bills.filter((b) => Math.abs(num(b.payable) - amt) < 2);
      if (exact.length === 1) return D({ status: 'AUTO', confidence: 'AUTO', category: 'OWNER_PAYMENT', why: `${own}: one approved 15-day bill with exactly this payable (${exact[0].bill_no})`, target_kind: 'OWNER_BILL', target_id: exact[0].id, target_label: `${own} · ${exact[0].bill_no}`, decision: { category: 'OWNER_PAYMENT', party_kind: 'OWNER', party_name: own, bill_id: exact[0].id } });
      return D({ category: 'OWNER_PAYMENT', why: `${own}: ${bills.length} approved unpaid bill(s) — which?`, target_kind: 'OWNER', target_label: own, decision: { category: 'OWNER_PAYMENT', party_kind: 'OWNER', party_name: own } });
    }
    // 9. vendor / driver
    const ven = nameHit(cp, ctx.vendors.map((v) => v.vendor_name));
    if (ven) { const v = ctx.vendors.find((x) => x.vendor_name === ven); return D({ category: 'VENDOR_PAYMENT', why: `payee ≈ vendor ${ven}${v?.vendor_kind ? ' (' + v.vendor_kind + ')' : ''} — which bill?`, target_kind: 'VENDOR', target_id: v?.id, target_label: ven, decision: { category: 'VENDOR_PAYMENT', party_kind: 'VENDOR', party_id: v?.id, party_name: ven } }); }
    const upiMobile = (String(line.description).match(/\/(\d{10})[/@]/) || [])[1];
    const drv = nameHit(cp, ctx.drivers.map((d) => d.name)) || (upiMobile ? ctx.drivers.find((d) => String(d.mobile || '').replace(/\D/g, '').endsWith(upiMobile))?.name : null);
    if (drv) { const d = ctx.drivers.find((x) => x.name === drv); return D({ category: 'DRIVER_ADVANCE', why: `payee ≈ driver ${drv} — which trip?`, target_kind: 'DRIVER', target_id: d?.id, target_label: drv, decision: { category: 'DRIVER_ADVANCE', party_kind: 'DRIVER', party_id: d?.id, party_name: drv } }); }
    if (/PETROL|FUEL|DIESEL|SERVICE STATION|FILLING|ENERGY STATION|SERVICE CENTRE|TYRE|TYRES|AUTO SPARE|MOTORS|GARAGE/.test(text)) return D({ category: 'VENDOR_PAYMENT', why: 'looks like a pump / garage not in the vendor master — add the vendor, then link', target_kind: 'VENDOR' });
  }

  // 10. cash
  if (/\bATM\b|CASH WITHDRAWAL|\bSELF\b|CASH DEP|BY CASH|TO CASH|CSH DEP|CASH WDL/.test(text)) return D({ category: 'CASH', why: 'cash movement — confirm against the cash book', target_kind: 'LEDGER', decision: { category: 'CASH', ledger_name: 'Cash in Hand (HQ)' } });

  // 11. personal account default
  if (ctx.acct.personal_default_not_ours) return D({ status: 'NOT_OURS', confidence: 'UNMATCHED', category: dir === 'CR' ? 'OTHER_RECEIPT' : 'OTHER_PAYMENT', why: 'personal account: no rule claimed this line — not ours by default (owner, 5-Sep); one click makes it ours' });

  // 12. unmatched
  return D({ confidence: 'UNMATCHED', category: dir === 'CR' ? 'OTHER_RECEIPT' : 'OTHER_PAYMENT', why: 'no rule and no known name — a person decides' });
}

async function applyDecision(ctx, line, dec, by, post) {
  const set = { category: dec.category ?? null, confidence: dec.confidence ?? null, why: dec.why ?? null, target_kind: dec.target_kind ?? null, target_id: dec.target_id ?? null, target_label: dec.target_label ?? null, rule_id: dec.rule_id ?? null, book_entry_id: dec.book_entry_id ?? null, voucher_id: dec.voucher_id ?? null, status: dec.status === 'AUTO' ? 'REVIEW' : dec.status };
  if (dec.status === 'AUTO' && post && dec.decision) {
    try {
      const p = await postDecision(ctx, line, dec.decision, by);
      if (p.pending) { set.status = 'REVIEW'; set.why = `${dec.why} — ${p.pending}`; }
      else { set.status = 'AUTO_POSTED'; set.voucher_id = p.voucher_id; set.target_kind = p.target_kind ?? set.target_kind; set.target_id = p.target_id ?? set.target_id; set.target_label = p.target_label ?? set.target_label; set.linked_by = by; }
      if (dec.rule_id) await query('UPDATE bank_party_rules SET hits = hits + 1 WHERE id = $1::uuid', [dec.rule_id]);
    } catch (e) { set.status = 'REVIEW'; set.confidence = 'REVIEW'; set.why = `${dec.why} — posting refused: ${String(e.message).slice(0, 160)}`; }
  }
  if (dec.status === 'LINKED') { set.status = 'LINKED'; set.linked_by = by; }
  await query(`UPDATE bank_statement_lines SET status = $2, category = $3, confidence = $4, why = $5, target_kind = $6, target_id = $7, target_label = $8, rule_id = $9,
                 book_entry_id = $10, voucher_id = $11, linked_by = CASE WHEN $2 IN ('AUTO_POSTED','LINKED') THEN $12 ELSE linked_by END, linked_at = CASE WHEN $2 IN ('AUTO_POSTED','LINKED') THEN now() ELSE linked_at END
               WHERE id = $1::uuid`,
    [line.id, set.status, set.category, set.confidence, set.why, set.target_kind, set.target_id, set.target_label, set.rule_id, set.book_entry_id, set.voucher_id, by]);
  return set.status;
}

/** Tally every NEW / REVIEW line of an account (or all accounts). */
export async function tallyAccount({ accountId = null, statuses = ['NEW', 'REVIEW'], by = 'agent:TARA', post = true, log = null, limit = 5000 } = {}) {
  const { rows: accts } = await query(`SELECT * FROM bank_accounts WHERE active AND ($1::uuid IS NULL OR id = $1::uuid)`, [accountId]);
  const out = { accounts: 0, lines: 0, auto_posted: 0, linked: 0, review: 0, not_ours: 0, errors: 0 };
  for (const acct of accts) {
    const ctx = await loadContext(acct);
    const { rows: lines } = await query(`SELECT * FROM bank_statement_lines WHERE account_id = $1::uuid AND status = ANY($2) ORDER BY txn_date, created_at LIMIT $3`, [acct.id, statuses, limit]);
    out.accounts += 1;
    for (const line of lines) {
      out.lines += 1;
      try {
        const dec = await decide(ctx, line);
        const st = await applyDecision(ctx, line, dec, by, post);
        if (st === 'AUTO_POSTED') out.auto_posted += 1; else if (st === 'LINKED') out.linked += 1; else if (st === 'NOT_OURS') out.not_ours += 1; else out.review += 1;
      } catch (e) { out.errors += 1; log?.warn?.({ line: line.id, err: e.message }, '[bank] tally failed'); }
    }
  }
  return out;
}

/** Import parsed lines (from tools/bank/parse_sbi_statement.py) for one account. */
export async function importParsed({ accountNo, meta = {}, lines = [], sourceFile = null, format = 'PDF', by = 'desk' }) {
  const acct = await accountByNo(accountNo || meta.account_no);
  if (!acct) throw Object.assign(new Error(`Bank account ${accountNo || meta.account_no || '?'} is not on file — add it under Accounts first`), { code: 'NO_ACCOUNT' });
  const sha = String(meta.content_sha ?? '') || null;
  const { rows: [imp] } = await query(`
    INSERT INTO bank_statement_imports (account_id, source_file, source_format, period_from, period_to, opening_balance, closing_balance, rows_read, content_sha, created_by)
    VALUES ($1::uuid, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10) RETURNING id`,
    [acct.id, sourceFile ?? meta.file ?? null, format, meta.period_from ?? null, meta.period_to ?? null, meta.opening_balance ?? null, lines.length ? lines[lines.length - 1].balance ?? null : null, lines.length, sha, by]);
  let rowsNew = 0, rowsSeen = 0;
  for (const l of lines) {
    if (!l.txn_date) continue;
    const uid = l.line_uid || (await query('SELECT bank_line_uid($1,$2::date,$3,$4,$5,$6) AS u', [acct.account_no, l.txn_date, num(l.debit), num(l.credit), l.balance ?? null, l.ref_no ?? ''])).rows[0].u;
    const { rowCount } = await query(`
      INSERT INTO bank_statement_lines (account_id, import_id, line_uid, txn_date, value_date, description, ref_no, utr, branch_code, debit, credit, balance, counterparty, channel, raw)
      VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
      ON CONFLICT (account_id, line_uid) DO NOTHING`,
      [acct.id, imp.id, uid, l.txn_date, l.value_date ?? l.txn_date, String(l.description ?? '').slice(0, 600), String(l.ref_no ?? '').slice(0, 200) || null, l.utr ?? null, l.branch_code ?? null, r2(num(l.debit)), r2(num(l.credit)), l.balance ?? null, l.counterparty ?? null, l.channel ?? null, JSON.stringify({ page: l.page ?? null })]);
    if (rowCount) rowsNew += 1; else rowsSeen += 1;
  }
  await query('UPDATE bank_statement_imports SET rows_new = $2, rows_seen = $3 WHERE id = $1::uuid', [imp.id, rowsNew, rowsSeen]);
  return { account: acct, import_id: imp.id, rows_read: lines.length, rows_new: rowsNew, rows_seen: rowsSeen };
}

/** What a person can link a line to. */
export async function candidatesFor(lineId) {
  const { rows: [line] } = await query('SELECT l.*, a.ledger_name, a.company_id, a.company_name FROM bank_statement_lines l JOIN bank_accounts a ON a.id = l.account_id WHERE l.id = $1::uuid', [lineId]);
  if (!line) return null;
  const amt = amtOf(line); const side = bookSide(line);
  const [bills, owner_bills, vendors, drivers, loans, book, ledgers, accounts] = await Promise.all([
    query(`SELECT b.id, b.bill_no, b.customer_name, b.customer_id, b.balance, b.period_from, b.status, co.company_name FROM customer_bills b LEFT JOIN companies co ON co.id = b.company_id WHERE b.status IN ('RAISED','PART_PAID','DISPUTED') AND b.balance > 0.5 ORDER BY abs(b.balance - $1) LIMIT 12`, [amt]).then((r) => r.rows),
    query(`SELECT id, bill_no, owner_name, payable, period_from, status FROM vehicle_owner_bills WHERE status = 'APPROVED' AND pay_voucher_id IS NULL AND payable IS NOT NULL ORDER BY abs(payable - $1) LIMIT 12`, [amt]).then((r) => r.rows),
    query(`SELECT id, vendor_name, vendor_kind FROM vendors ORDER BY vendor_name LIMIT 200`).then((r) => r.rows),
    query(`SELECT d.id, d.name, d.mobile, (SELECT json_agg(json_build_object('id', t.id, 'trip_code', t.trip_code, 'vehicle_no', t.vehicle_no, 'loading_date', t.loading_date, 'status', t.status)) FROM (SELECT * FROM trips t WHERE t.driver_name = d.name ORDER BY t.loading_date DESC LIMIT 5) t) AS trips FROM drivers d WHERE COALESCE(d.status,'ACTIVE') <> 'INACTIVE' ORDER BY d.name LIMIT 200`).then((r) => r.rows),
    query(`SELECT id, bank_name, vehicle_no, emi_amount, company_name, financier_ledger FROM loan_master ORDER BY abs(emi_amount - $1) LIMIT 12`, [amt]).then((r) => r.rows),
    query(`SELECT e.id, e.voucher_id, e.entry_date, e.dr_cr, e.amount, e.source_type, e.source_ref, e.particulars FROM ledger_entries e WHERE e.ledger_name = $1 AND e.dr_cr = $2 AND abs(e.amount - $3) <= GREATEST(2, $3 * 0.02) AND abs(e.entry_date - $4::date) <= 45 AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.book_entry_id = e.id) ORDER BY abs(e.entry_date - $4::date) LIMIT 12`, [line.ledger_name, side, amt, line.txn_date]).then((r) => r.rows),
    query(`SELECT ledger_name, group_head FROM ledgers WHERE status = 'ACTIVE' AND group_head NOT IN ('Bank Accounts') ORDER BY group_head, ledger_name LIMIT 600`).then((r) => r.rows),
    query(`SELECT id, ledger_name, company_name FROM bank_accounts WHERE active ORDER BY ledger_name`).then((r) => r.rows),
  ]);
  return { line, customer_bills: bills, owner_bills, vendors, drivers, loans, book_entries: book, ledgers, accounts, firms: FIRMS.map((f) => f.name) };
}

/**
 * A person decides. decision = { category, party_kind, party_id, party_name, ledger_name, bill_id, trip_id, other_firm, other_ledger, book_entry_id, remember, note }
 * category NOT_OURS / IGNORE / PARK change the status only.
 */
export async function linkLine({ lineId, decision: d, by = 'desk' }) {
  const { rows: [line] } = await query('SELECT * FROM bank_statement_lines WHERE id = $1::uuid', [lineId]);
  if (!line) throw Object.assign(new Error('line not found'), { code: 'NOT_FOUND' });
  if (line.status === 'AUTO_POSTED' && d.category !== 'PARK') throw Object.assign(new Error('this line is already posted — reverse the voucher first'), { code: 'ALREADY_POSTED' });
  const acct = await accountById(line.account_id);
  const ctx = await loadContext(acct);
  let status = 'LINKED', posted = null;
  if (['NOT_OURS', 'IGNORE', 'PARK'].includes(d.category)) {
    status = d.category === 'IGNORE' ? 'IGNORED' : d.category === 'PARK' ? 'PARKED' : 'NOT_OURS';
    await query(`UPDATE bank_statement_lines SET status = $2, note = $3, linked_by = $4, linked_at = now(), why = COALESCE($3, why) WHERE id = $1::uuid`, [lineId, status, d.note ?? null, by]);
  } else if (d.category === 'BOOK_ENTRY') {
    if (!d.book_entry_id) throw new Error('book entry needed');
    const { rows: [e] } = await query('SELECT id, voucher_id, source_type, source_ref FROM ledger_entries WHERE id = $1', [d.book_entry_id]);
    if (!e) throw new Error('book entry not found');
    await query(`UPDATE bank_statement_lines SET status = 'LINKED', category = $2, confidence = 'REVIEW', why = $3, book_entry_id = $4, voucher_id = $5, target_kind = 'BOOK_ENTRY', target_label = $6, note = $7, linked_by = $8, linked_at = now() WHERE id = $1::uuid`,
      [lineId, SOURCE_CAT[e.source_type] ?? 'BOOK_VOUCHER', `linked to the book entry by ${by}`, e.id, e.voucher_id, `${e.source_type} ${e.source_ref ?? ''}`.trim(), d.note ?? null, by]);
  } else {
    posted = await postDecision(ctx, line, d, by);
    if (posted.pending) throw Object.assign(new Error(posted.pending), { code: 'PENDING' });
    await query(`UPDATE bank_statement_lines SET status = 'LINKED', category = $2, confidence = 'REVIEW', why = $3, voucher_id = $4, target_kind = $5, target_id = $6, target_label = $7, trip_id = $8, note = $9, linked_by = $10, linked_at = now() WHERE id = $1::uuid`,
      [lineId, d.category, `linked and posted by ${by}`, posted.voucher_id, posted.target_kind, posted.target_id, posted.target_label, posted.trip_id ?? null, d.note ?? null, by]);
  }
  // learn
  let rule = null;
  if (d.remember && line.counterparty && !['PARK', 'BOOK_ENTRY'].includes(d.category)) {
    const cat = d.category === 'IGNORE' || d.category === 'NOT_OURS' ? 'NOT_OURS' : d.category;
    const { rows: [r] } = await query(`
      INSERT INTO bank_party_rules (account_id, match_kind, match_text, direction, category, party_kind, party_id, party_name, ledger_name, auto, learned_from, created_by)
      VALUES ($1::uuid, 'COUNTERPARTY', $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10::uuid, $11)
      ON CONFLICT (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), match_kind, upper(match_text), direction)
      DO UPDATE SET category = EXCLUDED.category, party_kind = EXCLUDED.party_kind, party_id = EXCLUDED.party_id, party_name = EXCLUDED.party_name, ledger_name = EXCLUDED.ledger_name, auto = EXCLUDED.auto, learned_from = EXCLUDED.learned_from, created_by = EXCLUDED.created_by
      RETURNING *`,
      [d.rule_all_accounts ? null : line.account_id, line.counterparty.trim(), dirOf(line), cat, d.party_kind ?? (cat === 'INTER_FIRM' ? 'FIRM' : cat === 'NOT_OURS' ? 'NONE' : d.ledger_name ? 'LEDGER' : 'NONE'), d.party_id ?? null, d.party_name ?? d.other_firm ?? null, d.ledger_name ?? d.other_ledger ?? null,
       !!d.auto_next_time && !['CUSTOMER_RECEIPT', 'OWNER_PAYMENT', 'VENDOR_PAYMENT', 'DRIVER_ADVANCE', 'LOAN_EMI'].includes(cat) ? true : !!d.auto_next_time && !!(d.ledger_name || d.party_name), lineId, by]);
    rule = r;
  }
  const { rows: [fresh] } = await query('SELECT * FROM bank_statement_lines WHERE id = $1::uuid', [lineId]);
  return { line: fresh, posted, rule };
}

/** The desk's counts for the dashboard. */
export async function bankSummary() {
  const { rows: accounts } = await query('SELECT * FROM v_bank_account_summary ORDER BY company_name, ledger_name');
  const { rows: [t] } = await query(`SELECT count(*)::int AS lines, count(*) FILTER (WHERE status IN ('NEW','REVIEW'))::int AS waiting, count(*) FILTER (WHERE status = 'AUTO_POSTED')::int AS auto_posted,
                                            count(*) FILTER (WHERE status = 'LINKED')::int AS linked, count(*) FILTER (WHERE status = 'PARKED')::int AS parked, count(*) FILTER (WHERE status IN ('NOT_OURS','IGNORED'))::int AS not_ours,
                                            COALESCE(sum(credit + debit) FILTER (WHERE status IN ('NEW','REVIEW')), 0)::numeric(14,2) AS waiting_amount FROM bank_statement_lines`);
  const { rows: [u] } = await query('SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::numeric(14,2) AS amount FROM v_bank_book_unmatched');
  const { rows: rules } = await query('SELECT count(*)::int AS n, count(*) FILTER (WHERE auto)::int AS auto FROM bank_party_rules');
  return { accounts, totals: t, book_not_in_bank: u, rules: rules[0] };
}
