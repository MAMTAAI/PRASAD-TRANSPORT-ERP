// src/lib/tripPlaces.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   node src/lib/tripPlaces.selftest.mjs
//
// The rule under test decides what string a map is asked to find, and when it
// gets it wrong there is no error anywhere — Google simply answers with the
// whole planet, which is exactly how this went unnoticed until somebody opened
// Route Tracking and screenshotted an ocean.
//
// Every input below is a real value taken from trips.loading_point or
// trips.unloading_location on the production register, with its row count.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The module is TypeScript for the app's benefit; the logic is plain JS. Rather
// than pull a compiler in, strip the few type annotations it uses. If this ever
// stops being enough, that is the signal to give the file a real build step.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, 'tripPlaces.ts'), 'utf8')
  .replace(/^export type Place = \{[\s\S]*?\};$/m, '')
  .replace(/: Record<string, string>/g, '')
  .replace(/\(raw: unknown\)/g, '(raw)')
  .replace(/\(from: unknown, to: unknown\)/g, '(from, to)')
  .replace(/\): Place \{/g, ') {')
  .replace(/: string \| null/g, '')
  .replace(/^export /gm, '');
const mod = await import(`data:text/javascript;base64,${Buffer.from(
  `${src}\nexport { DEPOT_BY_CODE, placeOf, routeEmbedUrl, routeAppUrl, placeEmbedUrl };`
).toString('base64')}`);
const { placeOf, routeEmbedUrl } = mod;

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('\nTHE BUG ITSELF — a bare IOCL code must never reach a map');
// 7T04 · 10 trips, 7D18 · 25, 7R02 · 3. These are what the AC5 importer stored.
check('7T04', placeOf('7T04').query, 'Lumding Terminal, India');
check('7D18', placeOf('7D18').query, 'Moinarband Depot, India');
check('7R02', placeOf('7R02').query, 'Guwahati RC Office, India');
check('7T04 keeps the code in the label', placeOf('7T04').label, 'Lumding Terminal (7T04)');

console.log('\nWHAT WE DO NOT KNOW, WE DO NOT GUESS');
// 7B10 · 3 trips and 2377 · 6 appear only as bare codes anywhere in the ERP.
// A confident pin on the wrong town is worse than none: it gets believed.
check('7B10 refuses to guess', placeOf('7B10'), { query: null, label: '7B10', unresolved: true });
check('unknown code is flagged, not blanked', placeOf('9Z99').label, '9Z99');
check('and a route with one is not drawn', routeEmbedUrl('7B10', 'Chabua AFS 7A04'), null);

console.log('\nTHE CODE IN BRACKETS OUTRANKS THE PROSE');
// The same depot, named two ways in the same table. Only one is findable, and
// it is not the one the invoice prints.
check('office spelling',  placeOf('MOINARBAND DEPOT (7D18)').query, 'Moinarband Depot, India');
check('invoice spelling', placeOf('Rail fed POL Storage Depot (7D18)').query, 'Moinarband Depot, India');
check('label still shows what is stored',
      placeOf('Rail fed POL Storage Depot (7D18)').label, 'Rail fed POL Storage Depot (7D18)');

console.log('\nDESTINATIONS — the ZC id is an SAP key, not a place');
check('ZC prefix stripped', placeOf('ZC7A01 -Agartala AFS 7A01').query, 'Agartala AFS 7A01, India');
check('spacing variant',   placeOf('ZC7A04 - Chabua AFS').query, 'Chabua AFS, India');
check('no-space variant',  placeOf('ZC7A07-Jorhat Aviation Fuel Station').query,
      'Jorhat Aviation Fuel Station, India');
check('plain destination', placeOf('IMPHAL DEPOT').query, 'IMPHAL DEPOT, India');

console.log('\nNAMES WITH A CODE THE TABLE DOES NOT HAVE STILL WORK');
// 357 rows. Double spaces and all — the trailing code comes off, the rest goes
// to the map as typed.
check('unknown-code suffix trimmed',
      placeOf('BONGAIGAON  RC  OFFICE  (7R01)').query, 'Bongaigaon RC Office, India');
check('a name with no code at all',
      placeOf('Aadhar Green Sonapur Ethanol Plant').query,
      'Aadhar Green Sonapur Ethanol Plant, India');

console.log('\nEMPTY IS NOT UNRESOLVED — it is a trip nobody filled in');
check('empty string', placeOf(''), { query: null, label: '—', unresolved: false });
check('null',  placeOf(null),  { query: null, label: '—', unresolved: false });
check('spaces', placeOf('   '), { query: null, label: '—', unresolved: false });

console.log('\nTHE EMBED URL');
const url = routeEmbedUrl('7T04', 'ZC7A04 - Chabua AFS');
check('origin is the resolved name, not the code',
      url.includes(encodeURIComponent('Lumding Terminal, India')), true);
check('destination lost its SAP id',
      url.includes(encodeURIComponent('Chabua AFS, India')), true);
check('and it is an embed', url.includes('output=embed'), true);

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
