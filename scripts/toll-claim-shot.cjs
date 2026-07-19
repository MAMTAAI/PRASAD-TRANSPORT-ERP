// Render the IOCL claim HTML from REAL ICICI statement data and screenshot it.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const T = require(path.join(__dirname, '..', 'node_modules', '.cache', 'tollParse.test.cjs'));

(async () => {
  // Parse the real statement text (re-extract).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync('c:/Users/JAISWAL CAPITAL/Desktop/Software Update PT/Fatstag/ICICI FASTag - Statement7914578563920260718193818533.pdf'));
  const pdf = await pdfjs.getDocument({ data }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    text += tc.items.map(i => i.str).join(' ') + '\n';
  }
  const st = T.parseIciciText(text);

  // Map onto two synthetic trips (JE runs Haldia→Purnea routes per the ERP).
  const trips = [
    { id: 'T1', vehicle_no: 'NL01AA3054', loading_date: '2026-06-01', unloading_date: '2026-06-05', trip_status: 'COMPLETED', trip_id: 'JE001', challan_no: '0193640001', loading_point: '2701- HALL HALDIA LPG', consignee_name: 'P12660- PURNEA LPG PLANT', customer_name: 'INDIAN OIL CORPORATION LTD' },
    { id: 'T2', vehicle_no: 'NL01AA3054', loading_date: '2026-06-06', unloading_date: '2026-06-30', trip_status: 'COMPLETED', trip_id: 'JE002', challan_no: '0193640077', loading_point: '2701- HALL HALDIA LPG', consignee_name: 'P12660- PURNEA LPG PLANT', customer_name: 'INDIAN OIL CORPORATION LTD' },
  ];
  const maps = T.mapTollsToTrips(st.txns, trips);
  // Simulate the saved TOLL_TRANSACTIONS docs
  const docs = maps.filter(m => m.trip).map((m, i) => ({
    id: 'd' + i, Vehicle_No: m.txn.vehicle_no, Amount: m.txn.amount, Txn_Date: m.txn.txn_date,
    txn_datetime: m.txn.txn_datetime, Toll_Plaza_Name: m.txn.plaza, Transaction_Ref: m.txn.ref_no,
    trip_db_id: m.trip.id, invoice_no: m.trip.challan_no, invoice_date: m.trip.loading_date,
    loading_loc: m.trip.loading_point, dest_loc: m.trip.consignee_name,
  }));
  const groups = T.groupTollsForClaim(docs);
  const total = Math.round(groups.reduce((s, g) => s + g.total, 0) * 100) / 100;
  const html = T.renderIoclClaimHtml({
    claim_no: T.generateClaimNo('0011024699', '2026-07-19', 13), claim_date: '2026-07-19',
    vendor_name: 'JAISWAL ENTERPRISE', vendor_code: '0011024699',
    plant_name: 'LPG BP-North Guwahati', plant_code: '7B03',
    period_from: '2026-06-01', period_to: '2026-06-30', fortnight_label: '1st',
    groups, total,
  }).replace(/<script>[\s\S]*?<\/script>/, ''); // no auto-print in the shot
  const out = path.join(__dirname, '..', 'mobile-shots', 'toll-claim.html');
  fs.writeFileSync(out, html);
  console.log(`groups=${groups.length} tolls=${docs.length} total=${total} words="${T.amountInWordsINR(total)}"`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto('file:///' + out.split(String.fromCharCode(92)).join('/'));
  await page.screenshot({ path: path.join(__dirname, '..', 'mobile-shots', 'toll-claim-page1.png') });
  await page.evaluate(() => window.scrollTo(0, document.querySelector('.page-break').offsetTop));
  await page.screenshot({ path: path.join(__dirname, '..', 'mobile-shots', 'toll-claim-annexure.png') });
  await browser.close();
  console.log('screenshots saved');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
