// Pure unit test for the journal posting rules — NO Firestore (quota-safe).
// Transpiles posting.ts in-memory via esbuild and asserts every builder emits
// a balanced double-entry with the right ledgers + a deterministic source_ref.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'accounting', 'posting.ts'), 'utf8');
const js = esbuild.transformSync(code, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const P = mod.exports;

const bal = (e) => {
  const dr = e.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
  const cr = e.lines.filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0);
  return { dr, cr, balanced: Math.round((dr - cr) * 100) === 0 };
};

let pass = 0, fail = 0;
const check = (name, entry, wantRef, wantDrLedger, wantCrLedger) => {
  if (!entry) { console.log(`❌ ${name}: returned null`); fail++; return; }
  const b = bal(entry);
  const drL = entry.lines.find(l => l.dr_cr === 'Dr')?.ledger || '';
  const crL = entry.lines.find(l => l.dr_cr === 'Cr')?.ledger || '';
  const ok = b.balanced && entry.source_ref === wantRef && drL.includes(wantDrLedger) && crL.includes(wantCrLedger);
  console.log(`${ok ? '✅' : '❌'} ${name}: ref=${entry.source_ref} | Dr ${b.dr}=${b.cr} Cr | ${drL} / ${crL}`);
  ok ? pass++ : fail++;
};

check('Trip freight', P.tripFreightEntry({ trip_id: 'PT00042', gross_freight: '25000', customer_name: 'IOCL' }), 'PT00042', 'Debtors', 'Freight');
check('Trip freight (Rate=0)', P.tripFreightEntry({ trip_id: 'PT00043', Rate: '0' }) || { lines: [{ dr_cr: 'Dr', amount: 0, ledger: '-' }, { dr_cr: 'Cr', amount: 0, ledger: '-' }], source_ref: 'NULL_OK' }, 'NULL_OK', '-', '-');
check('Customer payment (bank)', P.customerPaymentEntry({ id: 'PAY1', amount: '10000', customer_name: 'HPCL', mode: 'NEFT' }), 'PAY1', 'Bank', 'Debtors');
check('Fuel (pump)', P.fuelEntry({ memo_no: 'MEMO9', amount: '5000', vendor_name: 'HP Pump', vehicle_no: 'AS01' }), 'MEMO9', 'Diesel', 'Creditors');
check('Market hire', P.hireEntry({ trip_id: 'PT00050', hire_amount: '18000', vendor_name: 'Singh Transport' }), 'PT00050', 'Hire', 'Creditors');
check('Vendor payment', P.vendorPaymentEntry({ id: 'VP1', amount: '12000', vendor_name: 'Singh Transport', mode: 'Bank' }), 'VP1', 'Creditors', 'Bank');
check('Toll', P.tollEntry({ id: 'TL1', toll_amt: '800', vehicle_no: 'AS01' }), 'TL1', 'Toll', 'Fastag');
check('EMI (split)', P.emiEntry({ id: 'EMI1', principal: '40000', interest: '10000', lender: 'HDFC' }), 'EMI1', 'Loan', 'Bank');

const emi = P.emiEntry({ id: 'EMI1', principal: '40000', interest: '10000', lender: 'HDFC' });
const hasInterest = emi.lines.some(l => l.ledger.includes('Interest') && l.amount === 10000);
console.log(`${hasInterest ? '✅' : '❌'} EMI splits principal+interest correctly`);
hasInterest ? pass++ : fail++;

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
