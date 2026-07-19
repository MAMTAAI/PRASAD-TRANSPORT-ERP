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

// ── effectiveBillingType safety net (owner-reported: 40 × 3.4324 = ₹137 bug) ──
check('rtkm+small rate => RTKM_QTY', F.effectiveBillingType('PER_KL', 3.4324, 618.3), 'RTKM_QTY');
check('owner case: 618.3 × 40 × 3.4324', F.computeFreight(F.effectiveBillingType('PER_KL', 3.4324, 618.3), { qty: 40, rate: 3.4324, rtkm: 618.3 }), 84890.12);
check('normal per-KL rate untouched', F.effectiveBillingType('PER_KL', 1500, 618.3), 'PER_KL');
check('no rtkm => per-KL stays', F.effectiveBillingType('PER_KL', 3.43, 0), 'PER_KL');
check('explicit FIXED never overridden', F.effectiveBillingType('FIXED', 3.43, 618.3), 'FIXED');

// ── 💹 Dynamic Rate Master: strict Customer + Source + Destination + Effective window ──
const rm = [
  { id: 'a', Customer: 'INDIAN OIL CORPORATION LTD', Source: 'BONGAIGAON RC OFFICE (7R01)', Destination: '364075 BROTHERHOOD FUEL STATION',
    Calc_Type: 'RTKM_KL', Rate_Value: 3.432495, RTKM_Distance: 1660, Effective_From: '2026-04-01', Effective_To: '2026-06-30', Status: 'Active' },
  { id: 'b', Customer: 'INDIAN OIL CORPORATION LTD', Source: 'BONGAIGAON RC OFFICE (7R01)', Destination: '364075 BROTHERHOOD FUEL STATION',
    Calc_Type: 'RTKM_KL', Rate_Value: 3.61, RTKM_Distance: 1660, Effective_From: '2026-07-01', Effective_To: '', Status: 'Active' },
  { id: 'c', Customer: 'AADHAR GREEN INDUSTRIES LLP', Source: 'PATGAON', Destination: 'GUWAHATI PLANT',
    Calc_Type: 'PER_UNIT', Rate_Value: 1500, Effective_From: '2026-01-01', Effective_To: '', Status: 'Active' },
  { id: 'd', Customer: 'AADHAR GREEN INDUSTRIES LLP', Source: 'PATGAON', Destination: 'SILIGURI PLANT',
    Calc_Type: 'FIXED_RATE', Rate_Value: 25000, Effective_From: '2026-01-01', Effective_To: '', Status: 'Inactive' },
];
const ioclTrip = { customer_name: 'INDIAN OIL CORPORATION LTD', loading_point: 'BONGAIGAON RC OFFICE (7R01)', consignee_name: '364075 BROTHERHOOD FUEL STATION' };
check('RM: Q2 window rule (June)', F.findRateMasterEntry(rm, ioclTrip, '2026-06-18')?.id, 'a');
check('RM: open-ended rule (Aug)', F.findRateMasterEntry(rm, ioclTrip, '2026-08-15')?.id, 'b');
check('RM: date before all windows', F.findRateMasterEntry(rm, ioclTrip, '2026-03-15'), null);
check('RM: inactive rule skipped', F.findRateMasterEntry(rm, { customer_name: 'AADHAR GREEN INDUSTRIES LLP', loading_point: 'PATGAON', consignee_name: 'SILIGURI PLANT' }, '2026-06-01'), null);
check('RM: wrong destination no match', F.findRateMasterEntry(rm, { customer_name: 'INDIAN OIL CORPORATION LTD', loading_point: 'BONGAIGAON RC OFFICE (7R01)', consignee_name: 'SOMEWHERE ELSE' }, '2026-06-18'), null);
check('RM: calc type mapping RTKM_KL', F.calcToBillingType('RTKM_KL'), 'RTKM_QTY');
check('RM: calc type mapping RTKM_MT', F.calcToBillingType('RTKM_MT'), 'RTKM_QTY');
check('RM: calc type mapping PER_UNIT', F.calcToBillingType('PER_UNIT'), 'PER_KL');
check('RM: calc type mapping FIXED_RATE', F.calcToBillingType('FIXED_RATE'), 'FIXED');

// resolveTripBilling: Rate Master route-master se PEHLE lagta hai
const meta1 = F.resolveTripBilling(rm, routes, ioclTrip, '2026-06-18');
check('resolve: engine = RATE_MASTER', meta1?.engine, 'RATE_MASTER');
check('resolve: rate from RM rule', meta1?.rate, 3.432495);
check('resolve: freight = real IOCL bill row', F.computeFreight(meta1.billing_type, { qty: 17.510, rtkm: meta1.rtkm, rate: meta1.rate }), 99770.96);
// RM rule bina apne RTKM ke → route master ke RTKM se bharta hai
const rmNoRtkm = [{ Customer: 'INDIAN OIL CORPORATION LTD', Source: 'BONGAIGAON RC OFFICE (7R01)', Destination: '364075 BROTHERHOOD FUEL STATION',
  Calc_Type: 'RTKM_KL', Rate_Value: 3.61, Effective_From: '2026-01-01', Effective_To: '', Status: 'Active' }];
const routesWithRtkm = [{ ...routes[0], RTKM_Distance: '618.3' }];
check('resolve: RTKM fallback from route master', F.resolveTripBilling(rmNoRtkm, routesWithRtkm, ioclTrip, '2026-06-18')?.rtkm, 618.3);
// Koi RM rule na mile → legacy route-master path
const meta2 = F.resolveTripBilling([], [{ ...routes[0], Billing_Type: 'RTKM_QTY', RTKM_Distance: '618.3', rate_history: [{ valid_from: '2026-04-01', valid_to: '', rate_value: 3.432495 }] }], ioclTrip, '2026-06-18');
check('resolve: fallback engine = ROUTE_MASTER', meta2?.engine, 'ROUTE_MASTER');
check('resolve: fallback rate from route history', meta2?.rate, 3.432495);
check('resolve: nothing matches = null', F.resolveTripBilling([], [], ioclTrip, '2026-06-18'), null);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
