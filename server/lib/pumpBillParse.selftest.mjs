// server/lib/pumpBillParse.selftest.mjs
//   PUMP_BILL_DIR="C:/…/Desktop/hsd bill pump ka" npm run pumpbill:selftest
// ─────────────────────────────────────────────────────────────────────────────
// Run against the REAL invoices, and the assertion that matters is the pump's
// own arithmetic: the rows this parser reads must add up to the total the pump
// printed on the paper. Nothing else proves a parse — a fixture only proves the
// parser agrees with whoever wrote the fixture.
//
// Where the real bills are not available the unit cases below still run, so
// this is never silently a no-op.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parsePumpBill, parsePumpBillPdf, money, toISO, pumpKey, regKey, wordsToNumber } from './pumpBillParse.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('\nREADING WHAT AN INDIAN INVOICE PRINTS');
check('lakh grouping',            money('1,98,595.50'), 198595.5);
check('a rupee sign is not a digit', money('₹ 32,329.50'), 32329.5);
check('an empty cell is not zero', money(''), null);
check('nor is a dash',            money('-'), null);
// A pump writes the day first. Reading 08.04.2026 as 4 August would put a
// fortnight of diesel in the wrong bill.
check('day comes first',          toISO('08.04.2026'), '2026-04-08');
check('two-digit years',          toISO('08.04.26'), '2026-04-08');
check('a nonsense date is null',  toISO('32.13.2026'), null);
check('pump names meet',          pumpKey('BN FILLING STATION (Bharat Petroleum Dealer)') === pumpKey('B N FILLING STATION'), true);
check('lorry keys meet',          regKey('NL-01AA-3054'), 'NL01AA3054');

console.log('\nAN AMOUNT WRITTEN IN WORDS');
// Some invoices print the total in words while the digits do not survive the
// scan. Words cannot be misread into a plausible DIFFERENT number the way
// digits can — 8 becomes 3, but "eight" does not become "three" — so they make
// a good independent check on a total.
check('lakh and thousand',  wordsToNumber('Two Lakh Ninety Nine Thousand One Hundred Fourty Five'), 299145);
check('…and again',         wordsToNumber('Six Lakh Sixty Five Thousand Eight Hundred Sixteen'), 665816);
check('a bare hundred',     wordsToNumber('One Hundred'), 100);
check('crore',              wordsToNumber('One Crore Twenty Thousand'), 10020000);
check('trailing words are ignored', wordsToNumber('Five Thousand Rupees Only'), 5000);
check('nothing is not zero', wordsToNumber(''), null);

console.log('\nA RUNNING ACCOUNT IS NOT A PERIOD BILL');
// B N prints the previous balance on the same page. Booking the grand total as
// the month's charge would bill 4.7 lakh of already-billed diesel twice.
const bnLines = [
  'INVOICE',
  'BN FILLING STATION (Bharat Petroleum Dealer)',
  'M/s Jaiswal Enterprise BNFS/16/2026-27',
  'Add:- Date:- 30.04.2026',
  'S.no. Date Slip No. Vehicle Number Item Name Qty(in ltr) Rate/Ltr Amount',
  '1 02.04.2026 xxxx NL01Q4470 Diesel 300 89.40 26820.00',
  '2 05.04.2026 xxxx AS26C9808 Diesel 160 89.40 14304.00',
  'B/f:- 471357.00',
  'Paid Amount -470216.00',
  'Grand Total:- 512282.00',
];
const bn = parsePumpBill(bnLines);
check('the format is read from the invoice, not the filename', bn.format, 'BN');
check('both rows are read', bn.rows.length, 2);
check('the rows add up', bn.computed.amount, 41124);
check('brought forward is kept apart', bn.totals.brought_forward, 471357);
// 512282 - 471357 + 470216 = 511141 … which is NOT what the rows say, so:
check('a bill whose arithmetic does not close is refused', bn.check.ok, false);

// Now with a grand total that agrees: 471357 - 470216 + 41124 = 42265
const bnGood = parsePumpBill(bnLines.map((l) =>
  l.startsWith('Grand Total') ? 'Grand Total:- 42265.00' : l));
check('…and accepted when it does', bnGood.check.ok, true);
check('the period charge is the rows, not the grand total',
  bnGood.check.stated_amount, 41124);
check('the period is the rows\' own span',
  [bnGood.period_from, bnGood.period_to], ['2026-04-02', '2026-04-05']);

console.log('\nROWS THAT WRAP, AND A PRODUCT CODE THAT MOVES');
const skLines = [
  'Invoice',
  'SREE KRISHNA SERVICE CENTRE',
  'JAISWAL Enterprise',
  'Invoice No. 16.04.2026',
  'Date Vehicle No Qnty/Ltr Rate Amount Cash Total Amount',
  '08.04.2026 NL-01AA-3054 350 ₹ 32,329.50',
  'HSD 92.37 ₹ 32,329.50',
  '09.04.2026 NL-01AA-3056 HSD 300 ₹ 27,711.00',
  '92.37 ₹ 27,711.00',
  'R/O',
  '₹ -0.50',
  'Total= 650 ₹ 60,040.50 0 ₹ 60,040.00',
];
const sk = parsePumpBill(skLines);
check('both wrapped rows are read', sk.rows.length, 2);
check('the rate is picked off the continuation line', sk.rows[0].rate, 92.37);
check('…and also when the product code sits on the first line', sk.rows[1].rate, 92.37);
check('the product is captured either way', [sk.rows[0].product, sk.rows[1].product], ['HSD', 'HSD']);
check('litres are read', [sk.rows[0].qty, sk.rows[1].qty], [350, 300]);
check('the rows meet the printed total', sk.check.ok, true);
check('round-off is kept', sk.totals.round_off, -0.5);

console.log('\nWHAT A BAD LINE DOES');
const bad = parsePumpBill([
  'BN FILLING STATION', 'S.no. Date Slip No. Vehicle Number Item Name Qty(in ltr) Rate/Ltr Amount',
  'Add:- Date:- 30.04.2026',
  '1 02.04.2026 xxxx NL01Q4470 Diesel 300 89.40 26820.00',
  '2 09.03.2026 xxxx NL01Q7315 Diesel 90 89.40 8046.00',
  '3 02.04.2026 xxxx AS26C9808 Diesel 100 89.40 26820.00',
  'B/f:- 0.00', 'Paid Amount -0.00', 'Grand Total:- 61686.00',
]);
// A March line inside an April invoice is real — B N's own April bill has one.
check('a line dated outside the bill is flagged',
  bad.anomalies.some((a) => a.kind === 'DATE_OUTSIDE_BILL'), true);
// 100 × 89.40 = 8,940, not 26,820.
check('a line whose own arithmetic fails is flagged',
  bad.anomalies.some((a) => a.kind === 'LINE_ARITHMETIC'), true);
check('…and the dates are NOT rewritten', bad.rows[1].date, '2026-03-09');

console.log('\nA PUMP WE HAVE NEVER SEEN');
let refused = null;
try { parsePumpBill(['Invoice', 'SOME OTHER PUMP', '1 01.01.2026 x AS01A0001 Diesel 1 1 1']); }
catch (e) { refused = e.code; }
check('an unknown layout is refused, not guessed at', refused, 'UNKNOWN_PUMP_FORMAT');

// ── the real invoices ───────────────────────────────────────────────────────
const DIR = process.env.PUMP_BILL_DIR;
if (!DIR || !existsSync(DIR)) {
  console.log('\n⏭  PUMP_BILL_DIR not set — skipping the real invoices.\n');
  console.log(`${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
  process.exit(failures ? 1 : 0);
}

console.log('\nTHE REAL INVOICES');
const pdfs = [];
for (const sub of readdirSync(DIR, { withFileTypes: true })) {
  if (!sub.isDirectory()) continue;
  const d = path.join(DIR, sub.name);
  for (const f of readdirSync(d)) {
    if (/\.pdf$/i.test(f) && !f.startsWith('~$')) pdfs.push({ pump: sub.name, file: f, full: path.join(d, f) });
  }
}
console.log(`  ${pdfs.length} invoice(s) found\n`);

let readable = 0;
for (const p of pdfs) {
  let bill;
  try {
    bill = await parsePumpBillPdf(readFileSync(p.full));
  } catch (e) {
    console.log(`  --   ${p.pump}/${p.file}: ${e.code ?? 'FAILED'} — ${e.message}`);
    continue;
  }
  readable += 1;
  const c = bill.check;
  const tag = c.ok ? '  ok  ' : '  FAIL';
  if (!c.ok) failures += 1;
  console.log(`${tag} ${(p.pump + '/' + p.file).padEnd(42)} `
    + `${String(bill.rows.length).padStart(3)} rows  `
    + `${String(bill.computed.qty).padStart(7)} L  `
    + `₹${bill.computed.amount.toLocaleString('en-IN').padStart(12)}  `
    + `${bill.period_from}→${bill.period_to}`
    + (c.ok ? '' : `\n         ↳ ${c.why}`)
    + (bill.anomalies.length ? `\n         ↳ ${bill.anomalies.length} anomaly: `
        + bill.anomalies.slice(0, 3).map((a) => `#${a.sno} ${a.kind}`).join(', ') : ''));
}
// The two pumps whose invoices carry embedded text must ALL be readable.
// Nirmala, Shivam and Hatsingimari are photographs — their PDFs have either no
// text layer or an OCR layer that already reads "PETROLBUM" and "JAISWAI", so
// refusing them is the correct behaviour, not a gap. They belong to the bill
// scanner with a person checking the figures.
const TEXT_PUMPS = /^(B N filling|Sree krishna)$/i;
const textPdfs = pdfs.filter((p) => TEXT_PUMPS.test(p.pump));
check('every text invoice was readable', readable, textPdfs.length);
console.log(`
  ${pdfs.length - textPdfs.length} scanned invoice(s) refused on purpose `
  + '(Highway, Alam, Nirmala, Shivam, Jon N Well, Pawan, Hatsingimari — '
  + 'photographs whose OCR loses the table, not text)');

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
