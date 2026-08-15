// Prove the amortiser reproduces each lender's own printed figures.
import { buildSchedule, positionAt, dueBetween } from '../server/lib/loanAmortiser.js';

const CASES = [
  { name: 'TATA chassis 46,00,000 / 58',
    principal: 4600000, firstDue: '2022-09-11',
    slabs: [{from_month:1,to_month:1,amount:30301},{from_month:2,to_month:6,amount:30285},{from_month:7,to_month:58,amount:112987}],
    contract_value: 6057050, stated_interest: 1457050 },
  { name: 'TATA body 10,00,000 / 47',
    principal: 1000000, firstDue: '2022-09-02',
    slabs: [{from_month:1,to_month:1,amount:10372},{from_month:2,to_month:6,amount:10373},{from_month:7,to_month:47,amount:28843}],
    contract_value: 1244800, stated_interest: 244800 },
];

let fail = 0;
for (const c of CASES) {
  const s = buildSchedule({ principal: c.principal, slabs: c.slabs, firstDue: c.firstDue });
  const okTotal = Math.abs(Number(s.total_emi) - c.contract_value) < 1;
  const okInt   = Math.abs(Number(s.total_interest) - c.stated_interest) < 1;
  const okClose = Math.abs(Number(s.closing_balance)) < 1;
  if (!(okTotal && okInt && okClose)) fail++;
  const pos = positionAt(s, '2026-04-01');
  console.log(`\n${c.name}`);
  console.log(`   solved rate        ${s.annual_rate}% p.a.`);
  console.log(`   instalments total  ${Number(s.total_emi).toLocaleString('en-IN')}   contract says ${c.contract_value.toLocaleString('en-IN')}   ${okTotal?'MATCH':'*** MISMATCH ***'}`);
  console.log(`   interest total     ${Number(s.total_interest).toLocaleString('en-IN')}   contract says ${c.stated_interest.toLocaleString('en-IN')}   ${okInt?'MATCH':'*** MISMATCH ***'}`);
  console.log(`   closing balance    ${s.closing_balance}   ${okClose?'closes':'*** DOES NOT CLOSE ***'}`);
  console.log(`   at 01-04-2026      ${pos.emis_completed} EMIs paid, principal outstanding ${pos.principal_outstanding.toLocaleString('en-IN')}`);
  const win = dueBetween(s, '2026-04-01', '2026-08-31');
  console.log(`   Apr-Aug 2026: ${win.length} instalments, principal ${win.reduce((a,x)=>a+x.principal_paise,0)/100}, interest ${win.reduce((a,x)=>a+x.interest_paise,0)/100}`);
}
console.log(fail ? `\n${fail} CASE(S) FAILED` : '\nall cases reproduce the lender figures exactly');
process.exit(fail ? 1 : 0);
