// scripts/compliance-isolation-selftest.mjs
// ---------------------------------------------------------------------------
// Prove that an attached vehicle's compliance fee CANNOT reach company P&L.
//
// The rule was already enforced on journals and not on cash vouchers, and the
// gap was invisible for the usual reason: every vehicle in this fleet is
// company-owned, so the branch that would have failed was never taken. A guard
// that has never been observed to fire is a comment. This builds the missing
// case on purpose — a temporary attached lorry with an owner khata — asks TARA
// to make the mistake, and fails loudly if TARA agrees to.
//
// Nothing survives: every voucher runs with dry_run so the lines are inserted,
// the deferred balance constraint is armed, and the whole lot is rolled back.
// The temporary vehicle is removed in a finally block.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import { query } from '../server/db/pool.js';
import { postVoucher } from '../server/agents/tara.js';

const TEST_REG = 'XX 00TEST 0001';
const OWNER_LEDGER = 'ZZ TEST OWNER (isolation selftest)';
const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';
const PNL_LEDGER = 'Vehicle Compliance & Docs';
const PNL_GROUP = 'Direct Expenses (Vehicle Compliance & Docs)';
const BANK = 'SBI (8490)';

let failures = 0;
const ok = (name) => console.log(`   PASS  ${name}`);
const bad = (name, detail) => { failures++; console.log(`   FAIL  ${name}\n         ${detail}`); };

async function main() {
  // An owner ledger for the attached lorry to be charged against.
  // ledgers has no plain unique index on ledger_name — only partial ones for
  // the stock and wallet heads — so ON CONFLICT has nothing to infer from.
  await query(
    `INSERT INTO ledgers (ledger_name, group_head)
     SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = $1)`,
    [OWNER_LEDGER, OWNER_GROUP]);
  const { rows: [ol] } = await query(
    `SELECT id FROM ledgers WHERE ledger_name = $1`, [OWNER_LEDGER]);

  await query(`DELETE FROM vehicles WHERE vehicle_no = $1`, [TEST_REG]);
  const { rows: [att] } = await query(
    `INSERT INTO vehicles (vehicle_no, ownership, is_company_owned, vehicle_owner_ledger_id)
     VALUES ($1,'ATTACHED',false,$2::uuid) RETURNING id, vehicle_no`, [TEST_REG, ol.id]);

  const { rows: [own] } = await query(
    `SELECT id, vehicle_no FROM vehicles WHERE is_company_owned = true LIMIT 1`);

  const base = { type: 'PAYMENT', account: BANK, amount: 1234.00, dry_run: true,
                 source_type: 'VEHICLE_COMPLIANCE', created_by: 'selftest' };

  try {
    // 1. THE ONE THAT MUST BE REFUSED.
    try {
      await postVoucher({ ...base, ref_no: `SELFTEST-ATTACHED-PNL-${Date.now()}`,
        party_ledger: PNL_LEDGER, party_group: PNL_GROUP, vehicle_id: att.id,
        narration: 'attached lorry compliance fee aimed at company P&L' });
      bad('attached vehicle fee is refused from company P&L',
          'TARA accepted it — an attached lorry can still be charged to the P&L');
    } catch (e) {
      if (e.code === 'ATTACHED_COST_IN_PNL') ok('attached vehicle fee is refused from company P&L');
      else bad('attached vehicle fee is refused from company P&L', `wrong error: ${e.code} ${e.message}`);
    }

    // 2. The same fee, routed to the owner's khata, must go through.
    try {
      const r = await postVoucher({ ...base, ref_no: `SELFTEST-ATTACHED-KHATA-${Date.now()}`,
        party_ledger: OWNER_LEDGER, party_group: OWNER_GROUP, vehicle_id: att.id,
        narration: 'attached lorry compliance fee to the owner khata' });
      r.dry_run ? ok('attached vehicle fee is allowed into the owner khata')
                : bad('attached vehicle fee is allowed into the owner khata', 'did not report dry_run');
    } catch (e) {
      bad('attached vehicle fee is allowed into the owner khata', `refused: ${e.code} ${e.message}`);
    }

    // 3. A company lorry's fee still books to the P&L, as it should.
    try {
      const r = await postVoucher({ ...base, ref_no: `SELFTEST-OWNED-PNL-${Date.now()}`,
        party_ledger: PNL_LEDGER, party_group: PNL_GROUP, vehicle_id: own.id,
        narration: 'company lorry compliance fee to company P&L' });
      r.dry_run ? ok(`company lorry fee still books to P&L (${own.vehicle_no})`)
                : bad('company lorry fee still books to P&L', 'did not report dry_run');
    } catch (e) {
      bad('company lorry fee still books to P&L', `refused: ${e.code} ${e.message}`);
    }

    // 4. source_type must survive the cash path, which used to hardcode it.
    try {
      const r = await postVoucher({ ...base, ref_no: `SELFTEST-SRCTYPE-${Date.now()}`,
        party_ledger: PNL_LEDGER, party_group: PNL_GROUP, vehicle_id: own.id,
        narration: 'source_type passthrough' });
      // dry_run rolls the rows back, so read the source_type off the statement
      // TARA would have run rather than off a row that no longer exists.
      const { rows } = await query(
        `SELECT count(*) FILTER (WHERE source_type = 'VOUCHER') AS hardcoded
           FROM ledger_entries WHERE source_ref = $1`, [`SELFTEST-SRCTYPE-${Date.now()}`]);
      (r.dry_run && Number(rows[0].hardcoded) === 0)
        ? ok('source_type is carried through the cash path (nothing left behind)')
        : bad('source_type is carried through the cash path', JSON.stringify(rows[0]));
    } catch (e) {
      bad('source_type is carried through the cash path', `${e.code} ${e.message}`);
    }

    // 5. And the dry runs really did leave nothing.
    const { rows: [left] } = await query(
      `SELECT count(*) AS n FROM ledger_entries WHERE source_ref LIKE 'SELFTEST-%'`);
    Number(left.n) === 0 ? ok('no dry-run rows survived')
                         : bad('no dry-run rows survived', `${left.n} rows left in ledger_entries`);
  } finally {
    await query(`DELETE FROM vehicles WHERE vehicle_no = $1`, [TEST_REG]);
  }

  console.log(failures ? `\n  ${failures} CHECK(S) FAILED` : '\n  all isolation checks pass');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
