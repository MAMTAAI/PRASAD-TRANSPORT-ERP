// 🧪 GTROPY provider normalization + trip-mapping test (pure, no Firestore).
// Bundles src/lib/tollParse.ts via esbuild (same as the runner) and asserts the
// documented sample response parses, splits debit/credit, and maps to a trip.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = path.join(__dirname, '..', 'node_modules', '.cache', 'tollParse.gtropy.cjs');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
execSync(`npx esbuild src/lib/tollParse.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
const T = require(OUT);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} = ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
};

// ── Documented GTROPY sample (both JSON key spellings for toll_reader time) ──
const sample = {
  id: '7482a914-480c-4a49-9696-6a55ff30cf61', amount: 65.0, entry_type: 'debit', mode: 'nfc',
  account_id: 'C5446A3054', transacted_at: '02-Mar-2026 14:17:12', 'toll_reader time': '02-Mar-2026 14:06:54',
  vehicle_number: 'NL01AC5962', reference_number: '177244123139458',
  ext_txn_id: '31204280662032614065434161FA820329604CC386000', npci_reference_number: '312642006620326149654',
  plaza_code: '312042', plaza_name: 'MANESHAR-7A', plaza_lane_id: 'LANE06', lat: 28.326367, long: 76.890515,
};
const credit = { ...sample, id: 'credit-1', entry_type: 'credit', amount: 5000, ext_txn_id: 'CREDIT-TOPUP-001', reference_number: 'RCHG-001' };

const n = T.normalizeGtropyTxn(sample, 'prov1');
check('vehicle normalized', n.vehicle_no, 'NL01AC5962');
check('uses toll_reader time (crossing 14:06:54, not settlement 14:17:12)', n.txn_datetime, '2026-03-02 14:06:54');
check('txn_date', n.txn_date, '2026-03-02');
check('ext_txn_id carried', n.ext_txn_id, sample.ext_txn_id);
check('display ref = reference_number', n.ref_no, '177244123139458');
check('entry_type debit', n.entry_type, 'debit');
check('account_id', n.account_id, 'C5446A3054');
check('plaza', n.plaza, 'MANESHAR-7A');
check('lat/long parsed', [n.lat, n.long], [28.326367, 76.890515]);

// underscore key spelling must also work
const n2 = T.normalizeGtropyTxn({ ...sample, 'toll_reader time': undefined, toll_reader_time: '02-Mar-2026 09:00:00' }, 'p');
check('underscore toll_reader_time key', n2.txn_datetime, '2026-03-02 09:00:00');

// ── Batch split: debit vs credit ──
const batch = T.normalizeProviderTxns('gtropy', [sample, credit], 'prov1');
check('1 debit', batch.debits.length, 1);
check('1 credit', batch.credits.length, 1);
check('credit amount', batch.credits[0].amount, 5000);

// ── Dedup key stability (mirror of tollDocId — ext_txn_id preferred) ──
const tollDocId = (txn) => txn.ext_txn_id
  ? `TFX_${String(txn.ext_txn_id).replace(/[^A-Za-z0-9]/g, '_').slice(0, 160)}`
  : `TFS_${String(txn.ref_no).replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}`;
check('same txn → same doc id (idempotent)', tollDocId(n), tollDocId(T.normalizeGtropyTxn(sample, 'prov1')));
check('doc id from ext_txn_id', tollDocId(n).startsWith('TFX_'), true);

// ── Trip matching on the crossing time ──
const trips = [
  { id: 'TRIP_A', trip_id: 'TRIP_A', vehicle_no: 'NL01AC5962', loading_date: '2026-03-01', unloading_date: '2026-03-03', trip_status: 'COMPLETED' },
  { id: 'TRIP_B', trip_id: 'TRIP_B', vehicle_no: 'NL01AC5962', loading_date: '2026-03-10', unloading_date: '2026-03-12', trip_status: 'COMPLETED' },
];
const maps = T.mapTollsToTrips(batch.debits, trips);
check('debit mapped to the in-window trip', maps[0].trip && maps[0].trip.trip_id, 'TRIP_A');
check('confidence MATCHED', maps[0].confidence, 'MATCHED');

// ── Unknown provider → no crash, empty output ──
const unknown = T.normalizeProviderTxns('wheelseye', [sample], 'p');
check('unknown adapter → 0 debits', unknown.debits.length, 0);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
