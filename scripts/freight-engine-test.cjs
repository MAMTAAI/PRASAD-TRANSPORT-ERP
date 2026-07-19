// 🧪 Freight engine test — REAL IOCL bill rows (7B03, 16-30.06.2026) as truth.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = path.join(__dirname, '..', 'node_modules', '.cache', 'freightEngine.test.cjs');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execSync(`npx esbuild src/lib/freightEngine.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
const F = require(OUT);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} = ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
};

// ── computeFreight vs REAL IOCL bill rows ──
check('IOCL row1: 17.510TO × 1660km × 3.432495', F.computeFreight('RTKM_QTY', { qty: 17.510, rtkm: 1660, rate: 3.432495 }), 99770.96);
check('IOCL row2: 17.150TO × 1900km × 3.432495', F.computeFreight('RTKM_QTY', { qty: 17.150, rtkm: 1900, rate: 3.432495 }), 111847.85);
check('IOCL row: 17.660TO × 1900km × 3.432495', F.computeFreight('RTKM_QTY', { qty: 17.660, rtkm: 1900, rate: 3.432495 }), 115173.94);
check('PER_KL: 20 × 1500', F.computeFreight('PER_KL', { qty: 20, rate: 1500 }), 30000);
check('PER_TON: 17.5 × 800', F.computeFreight('PER_TON', { qty: 17.5, rate: 800 }), 14000);
check('RTKM_CAPACITY: 838.3 × 40KL × 1.2', F.computeFreight('RTKM_CAPACITY', { rtkm: 838.3, capacityKl: 40, rate: 1.2 }), 40238.4);
check('FIXED: flat 25000', F.computeFreight('FIXED', { rate: 25000, qty: 99 }), 25000);

// ── resolveRate: date-effective quarterly rates ──
const route = { rate_history: [
  { valid_from: '2026-04-01', valid_to: '2026-06-30', rate_value: 3.432495 },
  { valid_from: '2026-07-01', valid_to: '', rate_value: 3.61 },
  { valid_from: '2026-01-01', valid_to: '2026-03-31', rate_value: 3.30 },
]};
check('Q1 rate (Feb loading)', F.resolveRate(route, '2026-02-10').rate, 3.30);
check('Q2 rate (June loading)', F.resolveRate(route, '2026-06-18').rate, 3.432495);
check('Q2 boundary (Jun 30)', F.resolveRate(route, '2026-06-30').rate, 3.432495);
check('open-ended current (Aug)', F.resolveRate(route, '2026-08-15').rate, 3.61);
check('legacy fallback', F.resolveRate({ Rate_Per_Unit: '1500' }, '2026-06-01'), { rate: 1500, source: 'legacy' });
check('none', F.resolveRate({}, '2026-06-01').source, 'none');

// ── parseCapacity ──
check('40 KL (18 Wheeler)', F.parseCapacity('40 KL (18 Wheeler)'), 40);
check('18 MT (LPG Bulk)', F.parseCapacity('18 MT (LPG Bulk)'), 18);
check('ALL (Standard)', F.parseCapacity('ALL (Standard)'), 0);

// ── findRouteForTrip ──
const routes = [
  { id: 'r1', Customer: 'INDIAN OIL CORPORATION LTD', Depot_Link: 'BONGAIGAON RC OFFICE (7R01)', Consignee_Name: '364075 BROTHERHOOD FUEL STATION', Status: 'Active' },
  { id: 'r2', Customer: 'INDIAN OIL CORPORATION LTD', Depot_Link: 'LUMDING TERMINAL (7T04)', Consignee_Name: 'ZC7A09 - MOHANBARI AFS 7A09', Status: 'Active' },
  { id: 'r3', Customer: 'BPCL', Consignee_Name: 'MISSAMARI AFS', Status: 'Inactive' },
];
const trip = { customer_name: 'INDIAN OIL CORPORATION LTD', loading_point: 'BONGAIGAON RC OFFICE (7R01)', consignee_name: '364075 BROTHERHOOD FUEL STATION' };
check('exact route match', F.findRouteForTrip(routes, trip)?.id, 'r1');
check('inactive route skipped', F.findRouteForTrip(routes, { customer_name: 'BPCL', consignee_name: 'MISSAMARI AFS' }), null);
check('no consignee = no match', F.findRouteForTrip(routes, { customer_name: 'IOCL' }), null);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
