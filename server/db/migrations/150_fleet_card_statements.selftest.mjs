// server/db/migrations/150_fleet_card_statements.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   MIGTEST_PG=postgres://testu@127.0.0.1:5433/postgres npm run migrate:selftest150
//
// Runs migrations 149 and 150 against a throwaway database and then imports the
// REAL exports through the real parser, so what is asserted here is what will
// land on production — not a hand-written fixture that agrees with the code.
//
// The two figures that matter most are the ones a wrong import would quietly
// change: the diesel total (IOCL's "Sale Completion" is not fuel) and the
// litres (BPCL hides a double space in a column name).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { parseFleetCardCsv } from '../../lib/fleetCardImport.js';

const ADMIN = process.env.MIGTEST_PG;
if (!ADMIN) {
  console.log('\n⏭  MIGTEST_PG not set — skipping the migration 150 selftest.\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const sql149 = readFileSync(path.join(here, '149_trip_expense_truth.sql'), 'utf8');
const sql150 = readFileSync(path.join(here, '150_fleet_card_statements.sql'), 'utf8');
const DB = 'pt_mig150_test';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const db = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${DB}`) });
await db.connect();

try {
  // Only what 149 and 150 actually touch.
  await db.query(`
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $fn$;
    CREATE TABLE vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_no text);
    CREATE TABLE vendors  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_name text);
    CREATE TABLE trips (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_code text, vehicle_no text,
      driver_name text, customer_name text, operating_company text, status text,
      loading_date date, unloading_date date, freight_amount numeric(14,2),
      shortage_penalty numeric(14,2), total_expense numeric(14,2));
    CREATE TABLE fuel_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_date date,
      trip_id uuid REFERENCES trips(id), vehicle_no text, vendor_name text, memo_no text,
      liters numeric(10,3), amount numeric(14,2), cash_given_to_pump numeric(14,2));
    CREATE TABLE toll_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid REFERENCES trips(id),
      vehicle_no text, plaza_name text, amount numeric(12,2), txn_date date,
      txn_datetime timestamptz);
    CREATE TABLE driver_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid REFERENCES trips(id),
      driver_name text, txn_date date, txn_type text, amount numeric(12,2), mode text);
    CREATE TABLE expense_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id uuid REFERENCES trips(id),
      trip_ref text, vehicle_no text, vendor_name text, expense_type text, bill_no text,
      bill_date date, amount numeric(14,2), status text DEFAULT 'PENDING',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE fleet_cards (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), legacy_id text UNIQUE, name text NOT NULL,
      provider text NOT NULL, card_no_last4 text, vehicle_id uuid REFERENCES vehicles(id),
      vehicle_no text, opening_balance numeric(14,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'ACTIVE', remarks text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  `);

  console.log('\nTHE MIGRATIONS');
  await db.query(sql149);
  await db.query(sql150);
  check('149 and 150 apply together', true, true);

  console.log('\nTHE THREE ACCOUNTS, EACH ON ITS OWN COMPANY');
  const acct = async (p, no, name, company, bal) => (await db.query(
    `INSERT INTO fleet_card_accounts (provider, account_no, account_name, operating_company, portal_balance, portal_balance_at)
     VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`, [p, no, name, company, bal])).rows[0].id;
  const iocl = await acct('IOCL', '1001774381', 'PRASAD TRANSPORT', 'PRASAD TRANSPORT', 493805.37);
  const bpcl = await acct('BPCL', 'FA2004812523', 'JAISWAL ENTERPRISE', 'JAISWAL ENTERPRISE', null);
  await acct('HPCL', 'HP-UNKNOWN', 'JAISWAL ENTERPRISE', 'JAISWAL ENTERPRISE', 56343.97);
  const { rows: comp } = await db.query(
    `SELECT operating_company, count(*)::int n FROM fleet_card_accounts GROUP BY 1 ORDER BY 1`);
  check('company-wise, as the owner asked', comp.map((r) => [r.operating_company, r.n]),
        [['JAISWAL ENTERPRISE', 2], ['PRASAD TRANSPORT', 1]]);

  let dupe = null;
  try { await acct('IOCL', '1001774381', 'X', 'X', null); } catch (e) { dupe = e.code; }
  check('one account per provider per number', dupe, '23505');

  // ── Import the REAL files, through the REAL parser ────────────────────────
  const load = async (accountId, file) => {
    const p = parseFleetCardCsv(readFileSync(file, 'utf8'));
    let n = 0;
    for (const r of p.rows) {
      if (!r.txn_date || !r.provider_txn_id) continue;
      const res = await db.query(`
        INSERT INTO fleet_card_statement_txns
          (account_id, provider, provider_txn_id, txn_date, settlement_date, kind,
           provider_txn_type, direction, card_pan, vehicle_raw, vehicle_no, merchant_name,
           merchant_code, location, product, quantity, rate, amount, unit, balance_after,
           status, source_doc_no, raw, source_file)
        VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,
                -- The lorry as OUR fleet spells it. Resolved here, against the
                -- same reg_key the database uses, so an unresolvable
                -- registration stays NULL and shows up as a finding.
                (SELECT v.vehicle_no FROM vehicles v WHERE reg_key(v.vehicle_no) = reg_key($10) LIMIT 1),
                $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23)
        ON CONFLICT (account_id, provider_txn_id, kind) DO NOTHING RETURNING id`,
        [accountId, p.provider, r.provider_txn_id, r.txn_date, r.settlement_date, r.kind,
         r.provider_txn_type, r.direction, r.card_pan, r.vehicle_raw, r.merchant_name,
         r.merchant_code, r.location, r.product, r.quantity, r.rate, r.amount, r.unit ?? 'INR',
         r.balance_after, r.status, r.source_doc_no, JSON.stringify(r.raw), path.basename(file)]);
      n += res.rows.length;
    }
    return { read: p.rows.length, inserted: n };
  };

  const real = {
    iocl: path.join(repo, '.iocl_txn.tmp.csv'),
    sales: path.join(repo, '.bpcl_sales.tmp.csv'),
    cms: path.join(repo, '.bpcl_cms.tmp.csv'),
  };
  const haveReal = Object.values(real).every(existsSync);

  if (!haveReal) {
    console.log('\n⏭  the downloaded exports are not in the repo — skipping the real-file load');
  } else {
    console.log('\nLOADING THE REAL EXPORTS (1-Apr to 4-Sep-2026)');
    const a = await load(iocl, real.iocl);
    const b = await load(bpcl, real.sales);
    const c = await load(bpcl, real.cms);
    check('IOCL rows land', [a.read, a.inserted], [996, 996]);
    check('BPCL sales land', [b.read, b.inserted], [324, 324]);
    check('BPCL recharges land', [c.read, c.inserted], [16, 16]);

    console.log('\nRE-IMPORTING THE SAME FILE CHANGES NOTHING');
    // Operators re-pull these exports whenever they want a fresher number.
    const again = await load(iocl, real.iocl);
    check('every row is recognised, none duplicated', [again.read, again.inserted], [996, 0]);

    console.log('\nWHAT THE CARDS SAY, PER COMPANY');
    const { rows: pos } = await db.query(
      `SELECT provider, operating_company, recharged::float8 r, spent::float8 s,
              loyalty_points_award::float8 la, txns
         FROM v_fleet_card_position WHERE txns > 0 ORDER BY provider`);
    const io = pos.find((x) => x.provider === 'IOCL');
    const bp = pos.find((x) => x.provider === 'BPCL');
    check('IOCL diesel is Sale Auth + Sale, NOT Completion', Math.round(io.s), 10532606);
    check('IOCL recharge', Math.round(io.r), 9641310);
    // 36.6 LAKH POINTS, not rupees — worth roughly 36,601 at the 100:1 the
    // redemption legs show. Reported under a name that cannot be added to money.
    check('IOCL loyalty is POINTS, named so', Math.round(io.la), 3660116);
    check('BPCL diesel', Math.round(bp.s), 3770051);
    check('BPCL recharge', Math.round(bp.r), 3706088);
    check('and each account carries its own company',
          [io.operating_company, bp.operating_company], ['PRASAD TRANSPORT', 'JAISWAL ENTERPRISE']);

    const { rows: [other] } = await db.query(
      `SELECT COALESCE(sum(amount),0)::float8 v FROM fleet_card_statement_txns
        WHERE kind = 'OTHER' AND account_id = $1`, [iocl]);
    check('the wallet settlements are kept, just not as fuel', Math.round(other.v), 8290290);

    console.log('\nTHE GAP AGAINST THE PORTAL IS REPORTED, NOT HIDDEN');
    const { rows: [gap] } = await db.query(
      `SELECT unexplained::float8 u FROM v_fleet_card_position WHERE account_id = $1`, [iocl]);
    check('a difference from the portal balance is surfaced', typeof gap.u, 'number');

    console.log('\nA CARD ROW ONLY FINDS ITS LORRY IF THE LORRY IS IN THE FLEET');
    // Until now `vehicles` was empty, so every swipe resolved to NULL and read
    // as NO_VEHICLE. That is the honest answer, and it is also the real-world
    // failure mode: a registration the fleet master has never heard of cannot
    // be matched to anything and must be visible rather than guessed at.
    const { rows: [before] } = await db.query(
      `SELECT count(*) FILTER (WHERE milan = 'NO_VEHICLE')::int n FROM v_fleet_card_fuel_match`);
    check('an unknown registration is flagged, not guessed', before.n > 700, true);

    // Register the fleet as the cards spell it, then re-resolve.
    await db.query(`
      INSERT INTO vehicles (vehicle_no)
      SELECT DISTINCT vehicle_raw FROM fleet_card_statement_txns
       WHERE vehicle_raw IS NOT NULL AND vehicle_raw <> '-'`);
    await db.query(`
      UPDATE fleet_card_statement_txns x
         SET vehicle_no = v.vehicle_no
        FROM vehicles v
       WHERE reg_key(v.vehicle_no) = reg_key(x.vehicle_raw) AND x.vehicle_no IS NULL`);
    const { rows: [resolved] } = await db.query(
      `SELECT count(*) FILTER (WHERE vehicle_no IS NOT NULL)::int n
         FROM fleet_card_statement_txns WHERE kind = 'SALE'`);
    check('once the fleet is known, the swipes resolve', resolved.n > 700, true);

    console.log('\nTHE MILAN — A SWIPE WITH NO FUEL MEMO BEHIND IT');
    // Nothing is in fuel_entries yet, so every swipe must read NO_MEMO. That is
    // the honest answer, and it is the size of the problem: this much diesel is
    // on the cards and none of it is in the fuel register.
    const { rows: [m] } = await db.query(
      `SELECT count(*)::int n, count(*) FILTER (WHERE milan = 'NO_MEMO')::int nomemo
         FROM v_fleet_card_fuel_match`);
    check('every card sale is checked against the register', m.n > 700, true);
    check('and with an empty register, all of them are unexplained', m.nomemo, m.n);

    // ONE MEMO, ONE SWIPE — the ordinary case.
    // Built rather than fished out of the export, so the assertion does not
    // depend on which pairs happen to exist in a particular month's download.
    const { rows: [swipe] } = await db.query(
      `SELECT x.vehicle_no, x.txn_date, x.quantity::float8 q
         FROM fleet_card_statement_txns x
        WHERE x.kind = 'SALE' AND x.vehicle_no IS NOT NULL AND x.quantity > 0
          AND NOT EXISTS (
            SELECT 1 FROM fleet_card_statement_txns y
             WHERE y.id <> x.id AND y.kind = 'SALE'
               AND y.vehicle_no = x.vehicle_no
               AND y.txn_date BETWEEN x.txn_date - 1 AND x.txn_date + 1
               AND abs(y.quantity - x.quantity) <= GREATEST(x.quantity * 0.02, 1))
        LIMIT 1`);
    await db.query(
      `INSERT INTO fuel_entries (entry_date, vehicle_no, liters, amount)
       VALUES ($1::date, $2, $3, 0)`, [swipe.txn_date, swipe.vehicle_no, swipe.q]);
    const { rows: [m2] } = await db.query(
      `SELECT count(*) FILTER (WHERE milan = 'MATCHED')::int matched,
              count(*) FILTER (WHERE milan = 'AMBIGUOUS')::int amb
         FROM v_fleet_card_fuel_match`);
    check('a memo for the same lorry, day and litres is matched', m2.matched, 1);
    check('and nothing is ambiguous yet', m2.amb, 0);

    // ONE MEMO, TWO SWIPES — the case that must NOT read as two matches.
    // A second identical fill arrives on the card. The register still holds one
    // memo, so neither swipe is accounted for until a person says which. A view
    // that called both MATCHED would report two fills as covered on the
    // strength of a single register entry — the quiet double-count this whole
    // exercise exists to prevent.
    const { rows: [twin] } = await db.query(`
      INSERT INTO fleet_card_statement_txns
        (account_id, provider, provider_txn_id, txn_date, kind, direction, amount, unit,
         vehicle_no, vehicle_raw, quantity, merchant_name)
      VALUES ($1, 'IOCL', 'TWIN-TEST-1', $2::date, 'SALE', 'DR', 9999, 'INR', $3, $3, $4, 'TEST PUMP')
      RETURNING id`, [iocl, swipe.txn_date, swipe.vehicle_no, swipe.q]);
    check('a second identical fill lands', !!twin.id, true);

    const { rows: [m3] } = await db.query(
      `SELECT count(*) FILTER (WHERE milan = 'MATCHED')::int matched,
              count(*) FILTER (WHERE milan = 'AMBIGUOUS')::int amb,
              max(memo_claimed_by)::int most FROM v_fleet_card_fuel_match`);
    check('one memo claimed by two swipes is not two matches', m3.matched, 0);
    check('both are raised as ambiguous instead', m3.amb, 2);
    check('and the view says how many claimed it', m3.most, 2);
  }

  console.log('\nRE-RUNNABLE');
  await db.query(sql150);
  check('applying it twice changes nothing', true, true);
} catch (err) {
  failures += 1;
  console.log(`\n  FAIL  threw: ${err.message}`);
  if (err.position) console.log(`        at character ${err.position}`);
} finally {
  await db.end();
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB}`);
  await c.end();
}

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
