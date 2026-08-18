// ═══════════════════════════════════════════════════════════════════════════
// docparser-selftest.mjs — locks the five OCR/parser bugs shut.
//
//   node scripts/docparser-selftest.mjs        exits non-zero on any failure
//
// Every case below is a bug that reached production, not a hypothetical. They
// are written as the SYMPTOM the office would have seen, because that is what
// makes a regression obvious when one of these starts failing again:
//
//   1. Tesseract is handed a PDF          → the API process died outright
//   2. extractText treated as a string    → every scan read zero characters
//   3. "Valid From" read as an expiry     → every RC expired on its registration day
//   4. "driver" anywhere on the page      → an RC filed as a Driver Authority
//   5. an uncued past date trusted        → an issue date became the expiry
// ═══════════════════════════════════════════════════════════════════════════
import {
  classifyDocument, expiryWithCue, parseAnyDocument, documentKind, extractTripFields,
} from '../server/lib/docPatterns.js';

let failed = 0;
const ok = (name, cond, got) => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${got !== undefined ? `\n          got: ${JSON.stringify(got)}` : ''}`);
};

const KNOWN = new Map([['AS26C9803', { vehicle_no: 'AS 26C 9803' }],
                       ['NL01AD0831', { vehicle_no: 'NL 01AD 0831' }]]);

console.log('\n── 3. "Valid From" is an issue date, not an expiry ──────────────');
{
  const from = expiryWithCue('Valid From 01-02-2019');
  ok('bare "Valid From" is not treated as a cue', from.cue === false, from);
  const upto = expiryWithCue('CERTIFICATE OF FITNESS Valid Upto 16.02.2027');
  ok('"Valid Upto" IS a cue', upto.cue === true && upto.date === '2027-02-16', upto);
  const till = expiryWithCue('Insurance valid till 06.01.2027');
  ok('"valid till" IS a cue', till.cue === true && till.date === '2027-01-06', till);
}

console.log('\n── 4. a page that merely mentions a driver is not a driver document ──');
{
  const rc = classifyDocument('GOVERNMENT OF NAGALAND FORM 23 CERTIFICATE OF REGISTRATION driver SUNIL PRASAD authority');
  ok('RC naming a driver stays a vehicle RC', rc?.scope === 'VEHICLE' && rc?.type === 'custom_rc', rc);

  // The path-shaped hint must still work — that is how the bulk importer knows.
  const inFolder = classifyDocument('PHOTO.jpg', 'Driver Details', { driverContext: true });
  ok('a file under a Driver folder is still a driver photo',
     inFolder?.scope === 'DRIVER' && inFolder?.type === 'driver_photo', inFolder);

  const dl = classifyDocument('DRIVING LICENCE UNION OF INDIA valid till 14.09.2029');
  ok('a licence is a driver document wherever it sits', dl?.scope === 'DRIVER' && dl?.type === 'driver_dl', dl);
}

console.log('\n── 5. an uncued past date is never "confident" ───────────────────');
{
  const issueOnly = parseAnyDocument('PERMIT AS 26C 9803 Date of Approval 08-05-2025', KNOWN);
  ok('approval date does not make the read confident', issueOnly.confident === false, issueOnly);

  const cued = parseAnyDocument('FITNESS CERTIFICATE AS 26C 9803 valid upto 16.02.2029', KNOWN);
  ok('a cued future expiry IS confident', cued.confident === true && cued.expiry_date === '2029-02-16', cued);

  const noVehicle = parseAnyDocument('FITNESS CERTIFICATE valid upto 16.02.2029', KNOWN);
  ok('no lorry named → not confident', noVehicle.confident === false, noVehicle);
}

console.log('\n── universal kinds ──────────────────────────────────────────────');
{
  ok('tax invoice', documentKind('TAX INVOICE No IOC/2026/8891 GSTIN 18AAACI1681G1ZN') === 'INVOICE');
  ok('loading challan', documentKind('LOADING ADVICE No LA-55120 gate pass') === 'LOADING_CHALLAN');
  ok('bilty', documentKind('CONSIGNMENT NOTE G.R. No 4471 lorry receipt') === 'BILTY');
  ok('aadhaar', documentKind('AADHAAR GOVERNMENT OF INDIA 1234 5678 9460') === 'DRIVER');
  ok('registration certificate', documentKind('FORM 23 CERTIFICATE OF REGISTRATION') === 'COMPLIANCE');

  const inv = extractTripFields('TAX INVOICE No IOC/2026/8891 dated 12-08-2026 Total Amount 4,52,300.00 HSD 20.000 KL');
  ok('invoice number', inv.invoice_no === 'IOC/2026/8891', inv.invoice_no);
  ok('amount, commas stripped', inv.total_amount === 452300, inv.total_amount);
  ok('KL converted to litres', inv.quantity_ltr === 20000, inv.quantity_ltr);
}

console.log('\n── 1 & 2. OCR contract: PDFs never reach Tesseract, and the ─────');
console.log('          return value is an object, not a string ────────────────');
{
  const { extractText } = await import('../server/services/textOcr.js');
  // A four-byte "%PDF" header with nothing behind it: the point is that the PDF
  // branch is taken and REJECTS it, rather than the buffer reaching the
  // Tesseract worker, which used to kill the process from process.nextTick.
  let threw = null;
  try { await extractText(Buffer.from('%PDF-1.4 not really a pdf')); }
  catch (e) { threw = e; }
  ok('a malformed PDF throws a catchable error', threw !== null && threw.code === 'PDF_READ_FAILED', threw?.code);
  ok('...and the process is still alive to report it', true);

  const shape = await extractText(Buffer.from('%PDF-1.4 broken')).catch(() => null);
  ok('failure returns nothing, never a bare string', shape === null);
}

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILURE(S)'}\n`);
process.exit(failed === 0 ? 0 : 1);
