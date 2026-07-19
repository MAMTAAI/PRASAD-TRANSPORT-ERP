// 🧪 Toll engine parser test — runs src/lib/tollParse.ts against the owner's
// REAL ICICI FASTag statement PDF and checks the parse against the statement's
// own Vehicle Summary figures (Trip Count 67, Debit 39305.00).
// Usage: node scripts/toll-parse-test.cjs "<path-to-icici-pdf>"
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const PDF = process.argv[2] || 'c:\\Users\\JAISWAL CAPITAL\\Desktop\\Software Update PT\\Fatstag\\ICICI FASTag - Statement7914578563920260718193818533.pdf';
const OUT = path.join(__dirname, '..', 'node_modules', '.cache', 'tollParse.test.cjs');

(async () => {
  // 1. Bundle the pure parser for Node (esbuild ships with Vite).
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execSync(`npx esbuild src/lib/tollParse.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  const T = require(OUT);

  // 2. Extract the PDF text with pdf.js (legacy build works in Node).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(PDF));
  const pdf = await pdfjs.getDocument({ data }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    text += tc.items.map(i => i.str).join(' ') + '\n';
  }

  // 3. Parse + assert.
  const st = T.parseIciciText(text);
  const sum = Math.round(st.txns.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  const plates = [...new Set(st.txns.map(t => t.vehicle_no))];
  const bad = st.txns.filter(t => !t.plaza || !t.ref_no || !t.txn_datetime);
  const checks = [
    ['company detected', st.company, 'JAISWAL ENTERPRISE'],
    ['period from', st.period_from, '2026-06-01'],
    ['period to', st.period_to, '2026-06-30'],
    ['toll txn count (statement says Trip Count 67)', st.txns.length, 67],
    ['total debits (statement says 39305)', sum, 39305],
    ['vehicles', plates.join(','), 'NL01AA3054'],
    ['rows missing plaza/ref/datetime', bad.length, 0],
    ['bank', st.bank, 'ICICI'],
  ];
  let pass = 0;
  for (const [label, got, want] of checks) {
    const ok = String(got) === String(want);
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(want)})`}`);
  }
  console.log(`\nSample txn:`, JSON.stringify(st.txns[0], null, 1));

  // 4. Words + claim-no formats (from the real IOCL claim).
  const words = T.amountInWordsINR(23320);
  const wOk = words === 'Twenty Three Thousand Three Hundred Twenty';
  console.log(`${wOk ? 'PASS' : 'FAIL'}  amountInWords(23320) = "${words}"`);
  const cn = T.generateClaimNo('0011024699', '2026-07-15', 12);
  const cnOk = cn === '110246990726012';
  console.log(`${cnOk ? 'PASS' : 'FAIL'}  claimNo(0011024699, 2026-07-15, 12) = ${cn} (real: 110246990726012)`);

  // 5. Trip mapping smoke: txn on 16-06 must map to a 15..17-06 trip, not 20..22-06.
  const trips = [
    { id: 'A', vehicle_no: 'NL01AA3054', loading_date: '2026-06-15', unloading_date: '2026-06-17', trip_status: 'COMPLETED', trip_id: 'PT1' },
    { id: 'B', vehicle_no: 'NL01AA3054', loading_date: '2026-06-20', unloading_date: '2026-06-22', trip_status: 'COMPLETED', trip_id: 'PT2' },
  ];
  const m = T.mapTollsToTrips([{ vehicle_no: 'NL01AA3054', txn_datetime: '2026-06-16 09:43:29', txn_date: '2026-06-16', plaza: 'Paithna', lane: '7', ref_no: 'X', amount: 1145, tag_account: '' }], trips);
  const mOk = m[0].confidence === 'MATCHED' && m[0].trip?.id === 'A';
  console.log(`${mOk ? 'PASS' : 'FAIL'}  date-window mapping → ${m[0].confidence} trip=${m[0].trip?.trip_id}`);

  const total = checks.length + 3;
  const passed = pass + (wOk ? 1 : 0) + (cnOk ? 1 : 0) + (mOk ? 1 : 0);
  console.log(`\n${passed}/${total} checks passed`);
  process.exit(passed === total ? 0 : 1);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
