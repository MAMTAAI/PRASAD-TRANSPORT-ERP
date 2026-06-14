// Pure unit test for RBAC (no Firestore, quota-safe).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'rbac', 'index.ts'), 'utf8');
const js = esbuild.transformSync(code, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const R = mod.exports;

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); cond ? pass++ : fail++; };

const admin = { role: 'Admin', full_name: 'Boss' };
const accounts = { role: 'Accounts' };
const manager = { role: 'Manager' };
const vendor = { role: 'Vendor', vendor_name: 'Singh Transport' };
const customer = { role: 'Customer', customer_name: 'IOCL' };
const driver = { role: 'Driver', driver_name: 'RAMESH DAS' };

// Module access
ok('Admin can access LEDGER', R.canAccessModule(admin, 'LEDGER'));
ok('Manager CANNOT access LEDGER (financials)', !R.canAccessModule(manager, 'LEDGER'));
ok('Accounts can access PNL', R.canAccessModule(accounts, 'PNL'));
ok('Vendor CANNOT access DRIVER master', !R.canAccessModule(vendor, 'DRIVER'));
ok('Driver can access FUEL', R.canAccessModule(driver, 'FUEL'));

// Financial visibility
ok('Admin sees financials', R.canSeeFinancials(admin));
ok('Accounts sees financials', R.canSeeFinancials(accounts));
ok('Manager does NOT see financials', !R.canSeeFinancials(manager));
ok('Driver does NOT see financials', !R.canSeeFinancials(driver));

// Scope filtering
const trips = [
  { trip_id: 'T1', customer_name: 'IOCL', driver_name: 'RAMESH DAS', owner_name: 'Singh Transport' },
  { trip_id: 'T2', customer_name: 'HPCL', driver_name: 'KARU YADAV', owner_name: 'Self' },
  { trip_id: 'T3', customer_name: 'IOCL', driver_name: 'BHOLA', owner_name: 'Other Vendor' },
];
ok('Admin sees all trips', R.scopeFilter(admin, trips).length === 3);
ok('Vendor sees only own (Singh Transport) → 1', R.scopeFilter(vendor, trips).length === 1 && R.scopeFilter(vendor, trips)[0].trip_id === 'T1');
ok('Customer IOCL sees only their loads → 2', R.scopeFilter(customer, trips).length === 2);
ok('Driver RAMESH sees only own trip → 1', R.scopeFilter(driver, trips).length === 1 && R.scopeFilter(driver, trips)[0].trip_id === 'T1');
ok('Scoped role with no value sees NOTHING', R.scopeFilter({ role: 'Vendor' }, trips).length === 0);

// Mamta AI financial refusal
ok('Driver asking "is mahine ka profit" → REFUSE', R.shouldRefuseFinancial(driver, 'is mahine ka profit kitna hai'));
ok('Vendor asking "ledger balance" → REFUSE', R.shouldRefuseFinancial(vendor, 'mera ledger balance dikhao'));
ok('Driver asking "mere trips" → allowed', !R.shouldRefuseFinancial(driver, 'mere kitne trips hain'));
ok('Admin asking "profit" → allowed', !R.shouldRefuseFinancial(admin, 'profit kitna hai'));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log('scope describe (vendor):', R.describeScope(vendor));
process.exit(fail ? 1 : 0);
