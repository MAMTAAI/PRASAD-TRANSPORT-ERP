// src/lib/tollRoute.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   node src/lib/tollRoute.selftest.mjs
//
// This file decides a number that goes in front of the owner as "is trip par
// itna toll lagega", and every failure mode here is silent: a gate matched to
// the wrong highway, a gate counted twice because the route loops, a missing
// rate quietly treated as zero. None of those look wrong on a map.
//
// The coordinates below are real: the NH-27 corridor Bongaigaon → Guwahati that
// this fleet runs weekly, and plaza points in the shape FASTag readers report.
// ─────────────────────────────────────────────────────────────────────────────
import { haversineM, plazasOnRoute, tollTotals, legKindOf } from './tollRoute.mjs';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// A straight-ish run west→east along NH-27, roughly Bongaigaon to Guwahati.
const path = [];
for (let i = 0; i <= 100; i += 1) {
  path.push({ lat: 26.48 + (26.14 - 26.48) * (i / 100), lng: 90.55 + (91.75 - 90.55) * (i / 100) });
}
const at = (f) => path[Math.round(f * 100)];

console.log('\nDISTANCE — the one thing everything else rests on');
// Bongaigaon → Guwahati as the crow flies. Road distance is ~180 km; the
// straight line is shorter, and that is the number this must return.
const crow = Math.round(haversineM({ lat: 26.48, lng: 90.55 }, { lat: 26.14, lng: 91.75 }) / 1000);
check('crow-flies km is in the right decade', crow > 110 && crow < 140, true);
check('a point is zero from itself', Math.round(haversineM(at(0.5), at(0.5))), 0);

console.log('\nGATES ON THE ROUTE, IN CROSSING ORDER');
const MASTER = [
  // On the road, in order. Offsets are the kind of scatter a FASTag reader
  // reports: a few hundred metres off the drawn line.
  { name_key: 'GATEA', plaza_name: 'Gate A', lat: at(0.20).lat + 0.002, lng: at(0.20).lng, rate: 210 },
  { name_key: 'GATEB', plaza_name: 'Gate B', lat: at(0.55).lat, lng: at(0.55).lng - 0.003, rate: 165 },
  { name_key: 'GATEC', plaza_name: 'Gate C', lat: at(0.85).lat, lng: at(0.85).lng, rate: null },
  // Far away — a plaza in Gujarat must never be added to an Assam lane.
  { name_key: 'FARAWAY', plaza_name: 'Far Away Plaza', lat: 22.3, lng: 72.6, rate: 500 },
  // Near the corridor but ~20 km off it: the parallel-highway case.
  { name_key: 'OTHERNH', plaza_name: 'Other Highway', lat: at(0.5).lat + 0.20, lng: at(0.5).lng, rate: 300 },
  // No coordinates at all — known rate, unplaceable. Must not appear.
  { name_key: 'NOCOORD', plaza_name: 'No Coordinates', lat: null, lng: null, rate: 120 },
];

const gates = plazasOnRoute(path, MASTER);
check('only the gates actually on the road', gates.map((g) => g.plaza_name), ['Gate A', 'Gate B', 'Gate C']);
check('in the order the lorry meets them', gates.map((g) => g.at).every((v, i, a) => i === 0 || v >= a[i - 1]), true);
check('and each says how far off the line it sits', gates.every((g) => g.distance_m >= 0 && g.distance_m < 1200), true);

console.log('\nTHE SAME GATE TWICE IS STILL ONE GATE');
// An out-and-back stub passes the same plaza on the way out and the way in.
// Counting it twice here would double it AGAIN on a round trip.
const loop = [...path, ...path.slice().reverse()];
check('a route that doubles back lists it once', plazasOnRoute(loop, MASTER).length, 3);

console.log('\nTHE MONEY');
const one = tollTotals(gates, { roundTrip: false });
check('one way adds the priced gates only', one.one_way, 375);      // 210 + 165
check('and counts the unpriced one', one.unknown, 1);
check('and says the figure is short', one.incomplete, true);
check('gates counted include the unpriced', one.gates, 3);

const both = tollTotals(gates, { roundTrip: true });
check('round trip doubles it', both.total, 750);
check('one_way stays the single-leg figure', both.one_way, 375);
check('and the flag travels with it', both.round_trip, true);

console.log('\nA MISSING RATE IS NOT A ZERO');
// The whole point. Two gates, one priced: the total must be the one rate, and
// the caller must be able to tell it is not the whole bill.
const half = tollTotals([{ rate: 100 }, { rate: null }], {});
check('total is what we know', half.total, 100);
check('and it is flagged incomplete', half.incomplete, true);
const full = tollTotals([{ rate: 100 }, { rate: 60 }], {});
check('nothing missing, nothing flagged', [full.total, full.incomplete], [160, false]);
check('a lane with no gates at all is zero, not incomplete',
      [tollTotals([], {}).total, tollTotals([], {}).incomplete], [0, false]);

console.log('\nROUND TRIP OR ONE SIDE');
check('oil company work defaults to round', legKindOf({}), { kind: 'ROUND', source: 'OIL_COMPANY_DEFAULT' });
check('a market vehicle runs one side',
      legKindOf({ is_market_vehicle: true }), { kind: 'ONE_WAY', source: 'MARKET_VEHICLE' });
check('what dispatch saved outranks both',
      legKindOf({ trip_leg_kind: 'ONE_WAY', is_market_vehicle: false }), { kind: 'ONE_WAY', source: 'SAVED' });
check('and rubbish in the column does not win',
      legKindOf({ trip_leg_kind: 'MAYBE' }), { kind: 'ROUND', source: 'OIL_COMPANY_DEFAULT' });

console.log('\nDEGENERATE INPUT MUST NOT THROW');
check('no path', plazasOnRoute([], MASTER), []);
check('one point is not a route', plazasOnRoute([at(0.5)], MASTER), []);
check('no plazas', plazasOnRoute(path, []), []);
check('null everywhere', plazasOnRoute(null, null), []);
check('rates that are strings still add up', tollTotals([{ rate: '210' }, { rate: '165' }], {}).total, 375);

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
