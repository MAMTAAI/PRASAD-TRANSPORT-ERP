// server/lib/fleetCardImport.selftest.mjs
// ─────────────────────────────────────────────────────────────────────────────
//   npm run fleetcard:selftest
//
// The fixtures below are cut from the REAL exports pulled on 4-Sep-2026 — the
// same preamble, the same column names including the double space BPCL puts
// inside "Product Volume /  Quantity (Litres)", the same date formats, and the
// same four IOCL transaction types. Two of the cases here are bugs this file
// caught before anything was imported:
//
//   · "CCMS Sale Completion" was being read as diesel. It is a wallet
//     settlement — no vehicle, no litres, round amounts — and counting it would
//     have added 82,90,290 of fuel that never entered a tank.
//   · Every BPCL sale imported with ZERO litres, because the column lookup
//     collapsed whitespace in the header and not in the search term.
//
// Neither would have thrown. Both would have produced a confident wrong number.
// ─────────────────────────────────────────────────────────────────────────────
import { parseFleetCardCsv, toISO, regKey } from './fleetCardImport.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// ── IOCL ────────────────────────────────────────────────────────────────────
const IOCL = `Customer Transaction Details Report
Period:01/04/2026 To 04/09/2026

Customer ID: 1001774381

Transaction Summary (CCMS)
Sale,860008.91
CCMS Recharge,9641310.01
CCMS Sale Auth,9672599.50
CCMS Sale Complete,8290290.00




SNo., Terminal ID, Merchant ID, Merchant Name , Merchant PAN, State, Location, Customer ID/Card PAN, Vehicle No. (Card), Txn ID, Txn Date, Settlement Date, Txn Type, Txn Mode, Txn Mode Value, Product, Currency, RSP, Quantity,Deduction, Amount, Balance, Odometer (User Entry), Status, ITPSTxnID, NozzleNumber,Merchant SAPCode, FuelTimeStamp, DUNumber, FCCTransactionId,VehicleNo (User Entry),OfflineFlag,DUReceiptNumber,TagsDescription,Incentive Approved Date, Incentive Award Date
1,4000510558,M1,HIGHWAY SERVICE CENTRE,ABC,Assam,DIST : CHIRANG,7113010439890938,AS26C5103,1396116491,04/09/2026 10:00:13,,CCMS Sale Auth,CARD,,DIESEL,CCMS_Auth,97.20,80.00,,7776.00,0.00,,UT,166485639,1,,,,300095173,,,,,,
2,4000519195,M2,INDANE BOTTLING PLANT NORTH GUWAHATI,ABC,Assam,NORTH GUWAHATI,1001774381,-,1396117256,04/09/2026 10:04:06,04/09/2026 12:00:10,Recharge,,,750000041137472026,CCMS,0.00,0,,462941.50,493805.37,,PT,,,,,,,,,,,,
3,4000000001,M3,IOCL HO,ABC,Assam,HO,1001774381,-,1393987851,25/08/2026 11:24:14,25/08/2026 12:00:10,CCMS Sale Completion,,,,CCMS,0.00,-,,20000.00,0.00,,PT,-,,,,,0,,,,,,
4,4000000002,M4,IOCL HO - LOYALTY,ABC,Assam,HO,1001774381,-,1390000001,20/08/2026 09:00:00,,Loyalty Award,,,,XTRA,0.00,0,,15000.00,0.00,,PT,,,,,,,,,,,,
5,4000510558,M1,ALAM FUEL STATION,ABC,WB,KANKI,7113010439890995,AS26C7319,1390000002,02/04/2026 08:00:00,,Sale,CARD,,DIESEL,CCMS,92.72,200.00,,18544.00,0.00,,PT,,,,,,,,,,,,
`;

console.log('\nIOCL — WHAT IS DIESEL AND WHAT IS NOT');
const iocl = parseFleetCardCsv(IOCL);
check('provider recognised from the content', iocl.provider, 'IOCL');
check('account read off the preamble', iocl.account_no, '1001774381');
check('period read off the preamble', [iocl.period_from, iocl.period_to], ['2026-04-01', '2026-09-04']);
check('all five rows kept', iocl.rows.length, 5);

const byKind = {};
for (const r of iocl.rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.amount;
check('Sale Auth and Sale are the diesel', byKind.SALE, 7776 + 18544);
check('Completion is NOT counted as diesel', byKind.OTHER, 20000);
check('recharge is its own bucket', byKind.RECHARGE, 462941.5);
check('loyalty is money-shaped but not money', byKind.LOYALTY_AWARD, 15000);

const auth = iocl.rows.find((r) => r.provider_txn_id === '1396116491');
check('a fill keeps its lorry', auth.vehicle_raw, 'AS26C5103');
check('its litres', auth.quantity, 80);
check('its rate', auth.rate, 97.2);
check('its pump', auth.merchant_name, 'HIGHWAY SERVICE CENTRE');
check('and drains the wallet', auth.direction, 'DR');

const rech = iocl.rows.find((r) => r.kind === 'RECHARGE');
check('a recharge fills the wallet', rech.direction, 'CR');
// IOCL puts the freight invoice number in the Product column on a recharge —
// the only thread from a top-up back to the bill it was deducted from.
check('and carries the oil company document it came from', rech.source_doc_no, '750000041137472026');
check('which is not mistaken for a product', rech.product, null);

// ── BPCL sales ──────────────────────────────────────────────────────────────
const BPCL_SALES = `Report Name,Sales Transaction Report,Bharat Petroleum,
Report Generation Date and Time,04 Sep 2026 12:15 PM,,,,,,,
Period,01 Apr 2026 - 04 Sep 2026,,,,,,
Organization Name ,JAISWAL ENTERPRISE,,,,,
Account Number,FA2004812523,,,,,,
,,,,
S.No.,Transaction ID,Transaction Date,Transaction Time,Transaction mode,Name of Card,Card Number,Custom Card Name,Vehicle Number,Mobile Number,Fuel Station ID (Retail Outlet SAP CC No.),Fuel Station Name (Retail Outlet Name),Fuel Station PAN (Retail Outlet PAN),Fuel Station (Retail Outlet) Contact Number,Fuel Station (Retail Outlet) Location,Fuel Station (Retail Outlet) City,Fuel Station (Retail Outlet) District,Fuel Station (Retail Outlet) State,Transaction Type,Transaction Category,Product Name,Product Volume /  Quantity (Litres),Rate (Rs. / Litre),Purchase Amount(Rs.),TCS Amount(Rs.),Total Transaction Amount (Rs.),Credit / Debit,Transaction Remarks,Cash Back Amount (Rs.),Opening CMS Balance,Closing CMS Balance,Settlement Status
1.0,TXN100163560961,03-Apr-2026,09:24:21 PM,OTP,AS19N8333,FC3450729805,,AS19N8333,9395672010,0000121874,SHARMA SERVICE STATION BHARAT PETROLEUM DEALERS,ABPFS4549G,9038023923,"29A, RAMESH MITRA ROAD, KOLKATA, KOLKATA, 700025, India",KOLKATA,KOLKATA,West Bengal,CMS,SALE,Diesel,10.87,91.97,1000.0,,1000.0,Debit,,,15251.8,14251.8,SAP_POSTING_SETTLED
2.0,TXN100163560962,09-Jun-2026,02:41:21 PM,OTP,NL01Q4470,FC8000262542,,NL01Q4470,8099156668,0000121875,BN FILLING STATION BHARAT PETROLEUM DEALERS,ABPFS4549G,9038023923,"KANAIGHAT",KANAIGHAT,GOLAGHAT,Assam,CMS,SALE,Diesel,150.0,97.20,14580.0,,14580.0,Debit,,,15251.8,14251.8,SAP_POSTING_SETTLED
`;

console.log('\nBPCL SALES — THE LITRES THAT WENT MISSING');
const sales = parseFleetCardCsv(BPCL_SALES);
check('provider', sales.provider, 'BPCL');
check('account', sales.account_no, 'FA2004812523');
check('organisation — this card is Jaiswal, not Prasad', sales.account_name, 'JAISWAL ENTERPRISE');
check('rows', sales.rows.length, 2);
// The bug: the header has a double space inside the column name and the search
// term did too, but only the header was being collapsed.
check('litres are read, not silently zero', sales.rows.map((r) => r.quantity), [10.87, 150]);
check('rate', sales.rows.map((r) => r.rate), [91.97, 97.2]);
check('amount', sales.rows.map((r) => r.amount), [1000, 14580]);
check('the lorry', sales.rows.map((r) => r.vehicle_raw), ['AS19N8333', 'NL01Q4470']);
check('the pump', sales.rows[1].merchant_name, 'BN FILLING STATION BHARAT PETROLEUM DEALERS');
// DD-MMM-YYYY, and the second row is 9 JUNE — not 6 September.
check('dates are day-first', sales.rows.map((r) => r.txn_date), ['2026-04-03', '2026-06-09']);
// An address with commas inside quotes must not shift every later column.
check('a quoted address does not shift the columns', sales.rows[0].merchant_name,
      'SHARMA SERVICE STATION BHARAT PETROLEUM DEALERS');

// ── BPCL recharges ──────────────────────────────────────────────────────────
const BPCL_CMS = `Report Name,CMS Recharge Report,Bharat Petroleum,
Report Generation Date and Time,04 Sep 2026 12:13 PM,,,,,,,
Period,01 Apr 2026 - 04 Sep 2026,,,,,,
Organization Name ,JAISWAL ENTERPRISE,,,,,
Account Number,FA2004812523,,,,,,
,,,,
S.No.,Transaction ID,Transaction Date,Transaction Time,Fuel Station ID,Fuel Station Name,Fuel Station PAN,Contact,Location,City,District,State,Transaction Type,Transaction Category,Transaction Amount (Rs.),Credit / Debit,X,Y,Opening CMS Balance (Rs.),Closing CMS Balance (Rs.),Settlement Status
1.0,TXN100164487132,08-Apr-2026,08:42:57 PM,,,,,,,,,PCVO,RECHARGE,211052.11,Credit,,,8755.3,219807.41,Paid
2.0,TXN100164874461,10-Apr-2026,08:39:32 PM,,,,,,,,,Net Banking,RECHARGE,180000,Credit,,,219807.41,399807.41,SAP_POSTING_SETTLED
`;

console.log('\nBPCL RECHARGES — THE OIL COMPANY VS OUR OWN BANK');
const cms = parseFleetCardCsv(BPCL_CMS);
check('recognised as the recharge report, not the sales one', cms.rows.length, 2);
check('both are credits to the wallet', cms.rows.map((r) => r.direction), ['CR', 'CR']);
check('both are recharges', cms.rows.map((r) => r.kind), ['RECHARGE', 'RECHARGE']);
// PCVO is the oil company deducting from freight it owes us. Net Banking is our
// own money going in. Netting them together would hide a receivable.
check('PCVO is marked as the freight deduction', cms.rows[0].source_doc_no, 'PCVO');
check('our own bank transfer is not', cms.rows[1].source_doc_no, null);
check('closing balance is kept', cms.rows[0].balance_after, 219807.41);

console.log('\nDATES, AND WHY DAY-FIRST IS NOT A PREFERENCE');
check('08/06/2026 is 8 June, not 6 August', toISO('08/06/2026'), '2026-06-08');
check('DD-MMM-YYYY', toISO('23-Jul-2026'), '2026-07-23');
check('DD-MM-YYYY', toISO('04-09-2026'), '2026-09-04');
check('already ISO passes through', toISO('2026-09-04'), '2026-09-04');
check('rubbish is null, not today', toISO('n/a'), null);

console.log('\nREGISTRATIONS');
check('spacing and case are noise', regKey('AS 26C 9804'), 'AS26C9804');
check('and match the database rule', regKey('as26c9804'), regKey('AS-26C-9804'));
check('empty is null, not an empty string', regKey('  '), null);

console.log('\nAN UNKNOWN FILE IS REFUSED, NOT GUESSED AT');
let refused = null;
try { parseFleetCardCsv('name,amount\nfoo,1\n'); } catch (e) { refused = e.code; }
check('a stray CSV does not import as fuel', refused, 'UNKNOWN_FORMAT');
let hpcl = null;
try { parseFleetCardCsv('DriveTrack Plus Statement\nsomething,else\n'); } catch (e) { hpcl = e.code; }
check('HPCL refuses until a real file is seen', hpcl, 'HPCL_UNSUPPORTED');

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
