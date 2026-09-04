// src/lib/pumpBillAudit.selftest.mjs — npm run audit:selftest
// ─────────────────────────────────────────────────────────────────────────────
// The cases that decide whether a pump gets paid for diesel nobody issued.
// ─────────────────────────────────────────────────────────────────────────────
import { auditBill, settlementGate, VERDICTS } from './pumpBillAudit.mjs';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const line = (o) => ({ sno: 1, date: '2026-04-08', vehicle_raw: 'NL-01AA-3054',
                       qty: 350, rate: 92.37, amount: 32329.5, ...o });
const slip = (o) => ({ id: 's1', vehicle_no: 'NL01AA3054', entry_date: '2026-04-08',
                       liters: 350, rate: 92.37, amount: 32329.5, memo_no: 'M-1', ...o });

console.log('\nWHEN EVERYTHING AGREES');
let a = auditBill([line()], [slip()]);
check('the line settles itself', a.lines[0].verdict, 'MATCHED');
check('and pairs to the memo', a.lines[0].slip_id, 's1');
check('nothing is left unbilled', a.summary.unbilled_slips, 0);
check('nothing blocks', a.summary.blocking, 0);

console.log('\nRATE');
a = auditBill([line({ rate: 92.72, amount: 32452 })], [slip({ rate: 90.00, amount: 31500 })]);
check('a rate difference is caught', a.lines[0].verdict, 'RATE_MISMATCH');
check('…and is stated the way the office reads it',
  a.lines[0].notes[0], 'Pump billed ₹92.72, Slip authorized ₹90.00 (+2.72 per litre, ₹952.00 on this line)');
// The lorry number is written differently on the two papers and must still meet.
a = auditBill([line({ vehicle_raw: 'NL 01AA 3054' })], [slip({ vehicle_no: 'nl-01aa-3054' })]);
check('the lorry meets however it is written', a.lines[0].verdict, 'MATCHED');

console.log('\nQUANTITY');
a = auditBill([line({ qty: 200, amount: 18544, rate: 92.72 })],
              [slip({ liters: 150, amount: 13908, rate: 92.72 })]);
check('a quantity difference is caught', a.lines[0].verdict, 'QTY_MISMATCH');
check('…and says both figures',
  a.lines[0].notes[0], 'Pump billed 200L, Slip authorized 150L (+50L)');
check('…and drags the amount difference with it',
  a.lines[0].notes.some((n) => /Pump billed ₹18,544\.00, Slip authorized ₹13,908\.00/.test(n)), true);

console.log('\nA CHARGE NOBODY AUTHORISED');
a = auditBill([line({ vehicle_raw: 'AS26C9999' })], [slip()]);
check('a ghost line is caught', a.lines[0].verdict, 'GHOST');
check('…and names the truck and the day',
  a.lines[0].notes[0],
  'Pump billed this truck AS26C9999 on 2026-04-08, but no WhatsApp memo exists in the system.');
check('…and the untouched memo is reported back', a.summary.unbilled_slips, 1);
check('…as diesel the pump has not billed',
  /is not on this bill/.test(a.unbilled_slips[0].note), true);

console.log('\nONE MEMO CANNOT PAY FOR TWO FILLS');
a = auditBill([line({ sno: 1 }), line({ sno: 2 })], [slip()]);
check('the first line takes the memo', a.lines[0].verdict, 'MATCHED');
check('the second becomes a ghost', a.lines[1].verdict, 'GHOST');

console.log('\nTWO MEMOS, ONE LINE');
a = auditBill([line()], [slip({ id: 's1' }), slip({ id: 's2' })]);
check('the machine steps back', a.lines[0].verdict, 'AMBIGUOUS');
check('…and hands over both candidates', a.lines[0].candidates, ['s1', 's2']);

console.log('\nA DAY EITHER SIDE');
a = auditBill([line({ date: '2026-04-09' })], [slip({ entry_date: '2026-04-08' })]);
check('one day apart still pairs', a.lines[0].verdict, 'MATCHED');
a = auditBill([line({ date: '2026-04-12' })], [slip({ entry_date: '2026-04-08' })]);
check('four days apart does not', a.lines[0].verdict, 'GHOST');

console.log('\nWHAT CANNOT BE READ IS NOT GUESSED');
a = auditBill([line({ qty: null })], [slip()]);
check('an unreadable line says so', a.lines[0].verdict, 'UNREADABLE');
check('…and blocks', VERDICTS[a.lines[0].verdict].blocks, true);

console.log('\nPAISA AND TENTHS');
a = auditBill([line({ amount: 32330.0 })], [slip({ amount: 32329.5 })]);
check('half a rupee is round-off, not a dispute', a.lines[0].verdict, 'MATCHED');
a = auditBill([line({ qty: 350.02 })], [slip({ liters: 350 })]);
check('two hundredths of a litre is not a dispute', a.lines[0].verdict, 'MATCHED');
a = auditBill([line({ rate: 92.38 })], [slip({ rate: 92.37 })]);
check('but a paisa on the rate is', a.lines[0].verdict, 'RATE_MISMATCH');

console.log('\nTHE GATE');
const mixed = auditBill(
  [line({ sno: 1 }), line({ sno: 2, vehicle_raw: 'AS26C9999' }),
   line({ sno: 3, rate: 99, amount: 34650 })],
  [slip({ id: 's1' })]);
check('two of the three block', mixed.summary.blocking, 2);
let g = settlementGate(mixed, {});
check('the bill cannot be settled', g.ok, false);
check('…and says how many are open', g.open, 2);
g = settlementGate(mixed, { 1: 'ACCEPTED' });
check('accepting one is not enough', g.ok, false);
g = settlementGate(mixed, { 1: 'ACCEPTED', 2: 'LINKED' });
check('resolving both opens the gate', g.ok, true);
// A disputed line is decided, but it must not be paid.
g = settlementGate(mixed, { 1: 'DISPUTED', 2: 'ACCEPTED' });
check('a dispute still opens the gate', g.ok, true);
check('…but its money is held back',
  g.settleable_amount, Number((32329.5 + 34650).toFixed(2)));

console.log('\nTHE TOTALS EACH SIDE CLAIMS');
const both = auditBill(
  [line({ sno: 1, amount: 1000 }), line({ sno: 2, vehicle_raw: 'X1', amount: 500 })],
  [slip({ id: 's1', amount: 900 }), slip({ id: 's9', vehicle_no: 'ZZ9', entry_date: '2026-04-20' })]);
check('the pump\'s total', both.summary.billed_amount, 1500);
// Only what actually paired counts as authorised — a ghost authorises nothing.
check('what we authorised against it', both.summary.authorised_amount, 900);
check('and the gap between them', both.summary.difference, 600);
check('the memo the pump forgot is still reported', both.summary.unbilled_slips, 1);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
