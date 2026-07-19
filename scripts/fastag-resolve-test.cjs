// 🧪 resolveVehiclesByTag + tag-only rowsToTxns test (pure, no Firestore).
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = path.join(__dirname, '..', 'node_modules', '.cache', 'tollParse.test.cjs');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
execSync(`npx esbuild src/lib/tollParse.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
const T = require(OUT);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} = ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
};

// 1. CSV with TAG-ONLY rows (no vehicle column) must NOT be skipped anymore.
const rows = [
  ['Tag Account', 'Transaction Date', 'Plaza', 'Ref No', 'Debit'],
  ['34161FA820329000123', '01-07-2026 10:15:00', 'Jorabat Plaza', 'RRN001', '295.00'],
  ['34161FA820329000456', '02-07-2026 11:00:00', 'Sonapur Plaza', 'RRN002', '150.00'],
  ['', '03-07-2026 12:00:00', 'NoTag Plaza', 'RRN003', '100.00'], // no plate & no tag => skip
];
const { txns, skipped } = T.rowsToTxns(rows);
check('tag-only rows kept', txns.length, 2);
check('no-plate-no-tag skipped', skipped, 1);
check('vehicle_no empty before resolve', txns.map(t => t.vehicle_no), ['', '']);

// 2. Vehicle Master cross-reference fills the plate from fastag_id.
const vehicles = [
  { vehicle_no: 'AS 26C 5106', fastag_id: '34161FA820329000123' },     // spaced plate, exact tag
  { Vehicle_No: 'NL01AD0831', fastag_id: '34161-fa8203290-00456' },    // legacy field, messy tag
  { vehicle_no: 'AS 26C 9801', fastag_id: '' },                         // no tag mapped
];
const resolved = T.resolveVehiclesByTag(txns, vehicles);
check('resolved count', resolved, 2);
check('plate from exact tag', txns[0].vehicle_no, 'AS26C5106');
check('plate from messy legacy tag', txns[1].vehicle_no, 'NL01AD0831');

// 3. Statement's own plate must never be overwritten.
const t3 = [{ vehicle_no: 'AS26C9999', tag_account: '34161FA820329000123', txn_datetime: '', txn_date: '', plaza: '', lane: '', ref_no: 'X', amount: 1 }];
T.resolveVehiclesByTag(t3, vehicles);
check('existing plate untouched', t3[0].vehicle_no, 'AS26C9999');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
