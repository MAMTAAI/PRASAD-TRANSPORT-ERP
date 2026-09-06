// server/lib/fastagStatement.selftest.mjs
// Proves the statement reader on the shapes providers actually send: a title
// block above the header, day-first dates, "Txn Date/Time" vs "Date", rupee
// signs and commas, credit lines that are NOT tolls, and unspaced registrations.
//
//   node server/lib/fastagStatement.selftest.mjs
import XLSX from 'xlsx';
import { parseFastagStatement, looksLikeFastagStatement, toDateTime, normReg } from './fastagStatement.js';

let fail = 0;
const ck = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const toBuf = (aoa) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Statement');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

console.log('recognising the mail');
ck('fastag csv attachment', looksLikeFastagStatement({ from: 'alerts@bank.in', subject: 'FASTag Statement', filename: 'stmt.csv' }), true);
ck('toll xlsx by filename alone', looksLikeFastagStatement({ from: 'x@y.com', subject: 'monthly', filename: 'TOLL_TXN_AUG.xlsx' }), true);
ck('a pdf invoice is not a statement', looksLikeFastagStatement({ from: 'a@b.c', subject: 'FASTag', filename: 'bill.pdf' }), false);

console.log('\nday-first dates (Date.parse gets these WRONG)');
ck('14-08-2026 is 14 August, not 8 Feb', toDateTime('14-08-2026 23:47:11').slice(0, 10), '2026-08-14');
ck('two-digit year', toDateTime('05/09/26 10:00').slice(0, 10), '2026-09-05');
ck('ISO passes through', toDateTime('2026-08-14T18:17:11Z').slice(0, 10), '2026-08-14');
ck('junk is null, not an epoch', toDateTime('not a date'), null);

console.log('\nregistration normalisation');
ck('unspaced matches spaced', normReg('AS26C5107'), normReg('AS 26C 5107'));

console.log('\na real-shaped statement');
const buf = toBuf([
  ['ICICI BANK FASTag — Transaction Statement'],          // title block
  ['Account: 1234567890', null, null],                    // summary
  [],                                                     // blank
  ['Vehicle No', 'Txn Date/Time', 'Toll Plaza', 'Txn Ref No', 'Type', 'Amount'],
  ['AS26C5107', '14-08-2026 23:47:11', 'Jorabat Plaza', '178688539570726', 'Debit', '₹385.00'],
  ['AS 26C 9803', '15-08-2026 06:12:00', 'Sonapur Plaza', '178688539570727', 'Debit', '1,240.50'],
  ['AS26C5107', '15-08-2026 09:00:00', 'Wallet Recharge', 'RCH-99', 'Credit', '5,000.00'],
  ['', '', '', '', '', ''],                               // padding
  ['AS26C5107', '', 'Broken Row', 'X-1', 'Debit', '100'], // no date
]);
const out = parseFastagStatement(buf, 'icici_fastag_aug.xlsx', { bank: 'ICICI', companyHint: 'PRASAD TRANSPORT' });

ck('header found under the title block', out.headerMap != null, true);
ck('two real tolls parsed', out.rows.length, 2);
ck('  registration normalised', out.rows[0].vehicle_norm, 'AS26C5107');
ck('  spaced registration normalises the same way', out.rows[1].vehicle_norm, 'AS26C9803');
ck('  rupee sign and decimals', out.rows[0].amount, 385);
ck('  thousands separator', out.rows[1].amount, 1240.5);
ck('  provider ref becomes the dedup key', out.rows[0].ext_txn_id, '178688539570726');
ck('  plaza carried', out.rows[0].plaza_name, 'Jorabat Plaza');
ck('  day-first date read correctly', out.rows[0].txn_datetime.slice(0, 10), '2026-08-14');
ck('  bank + company hint attached', [out.rows[0].bank, out.rows[0].company_hint], ['ICICI', 'PRASAD TRANSPORT']);
ck('  source file recorded', out.rows[0].source_file, 'icici_fastag_aug.xlsx');

console.log('\nwhat it refuses');
ck('a CREDIT is not booked as a toll', out.skipped.some((s) => s.reason === 'CREDIT_NOT_A_TOLL'), true);
ck('a row with no date is parked, not guessed', out.skipped.some((s) => s.reason === 'INCOMPLETE_ROW'), true);
ck('no credit leaked into rows', out.rows.some((r) => r.amount === 5000), false);

console.log('\nan unreadable file says so');
const bad = parseFastagStatement(toBuf([['Hello'], ['World']]), 'notes.xlsx');
ck('no header row -> explicit error, zero rows', [bad.rows.length, /NO_HEADER_ROW/.test(bad.error ?? '')], [0, true]);

console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL FASTag PARSER CHECKS PASSED');
process.exit(fail ? 1 : 0);
