// server/lib/kycExtract.js
// ─────────────────────────────────────────────────────────────────────────────
// KYC fields out of OCR text — driving licence, Aadhaar, PAN, bank passbook,
// hazardous-goods certificate. Deterministic: patterns plus the checksums the
// documents carry (Aadhaar = Verhoeff, PAN = format), so a phone number is
// never mistaken for an Aadhaar and a mis-read digit is caught instead of
// filed. Every value comes back with a confidence the desk can show; nothing
// here writes to the driver row — the form fills EMPTY fields only and the
// person saves.
// ─────────────────────────────────────────────────────────────────────────────

const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
const BANKS = { SBIN: 'State Bank of India', HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', PUNB: 'Punjab National Bank', UBIN: 'Union Bank of India', BARB: 'Bank of Baroda', CNRB: 'Canara Bank', IDIB: 'Indian Bank', IOBA: 'Indian Overseas Bank', UCBA: 'UCO Bank', BKID: 'Bank of India', CBIN: 'Central Bank of India', MAHB: 'Bank of Maharashtra', KKBK: 'Kotak Mahindra Bank', UTIB: 'Axis Bank', YESB: 'Yes Bank', INDB: 'IndusInd Bank', FDRL: 'Federal Bank', IDFB: 'IDFC First Bank', BDBL: 'Bandhan Bank', AUBL: 'AU Small Finance Bank', PSIB: 'Punjab & Sind Bank', KARB: 'Karnataka Bank', SIBL: 'South Indian Bank', ASBL: 'Assam Gramin Vikash Bank', APGB: 'Assam Gramin Vikash Bank', PYTM: 'Paytm Payments Bank', AIRP: 'Airtel Payments Bank', IPOS: 'India Post Payments Bank' };

// Verhoeff — the check digit Aadhaar carries.
const V_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const V_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeffValid(num) {
  const s = String(num).replace(/\D/g, ''); if (s.length !== 12 || s[0] === '0' || s[0] === '1') return false;
  let c = 0; const rev = s.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = V_D[c][V_P[i % 8][rev[i]]];
  return c === 0;
}
export const panValid = (p) => /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(String(p ?? '').toUpperCase());
export const ifscValid = (i) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(i ?? '').toUpperCase());

const clean = (t) => String(t ?? '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');
const upper = (t) => clean(t).toUpperCase();

/** DD-MM-YYYY / DD/MM/YYYY / DD MON YYYY / YYYY-MM-DD → YYYY-MM-DD or null. */
export function toIsoDate(s) {
  if (!s) return null; const x = String(s).trim();
  let m = x.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = x.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = x.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,4})[-/. ](\d{4})$/); if (m && MON[m[2].toLowerCase()]) return `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  return null;
}
const DATE_RE = /(\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{4}[-/.]\d{2}[-/.]\d{2}|\d{1,2}[-/. ](?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*[-/. ]\d{4})/gi;
const allDates = (t) => [...String(t).matchAll(DATE_RE)].map((m) => ({ raw: m[1], iso: toIsoDate(m[1].replace(/([A-Za-z]{3})[A-Za-z]*/, '$1')), at: m.index })).filter((d) => d.iso);

/** The expiry a transport driver's licence lives by: the TR (transport) validity
 *  first, then a generic "valid till", then NT; without any cue, the latest
 *  future date on the paper (flagged low-confidence). */
function expiryOf(text) {
  const T = upper(text);
  const D = /(\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{4}[-/.]\d{2}[-/.]\d{2}|\d{1,2}[-/. ](?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*[-/. ]\d{4})/.source;
  const grab = (cue) => [...T.matchAll(new RegExp(cue.source + '[^0-9A-Z]{0,25}' + D, 'g'))].map((m) => toIsoDate(m[m.length - 1].replace(/([A-Z]{3})[A-Z]*/, '$1'))).filter(Boolean).sort();
  const tr = grab(/(?:VALIDITY\s*\(?TR\)?|\(TR\)|\bTR\b\s*[:\-]?|TRANSPORT\s*VALID(?:ITY|\s*TILL)?)/);
  if (tr.length) return { value: tr[tr.length - 1], confidence: 0.92, cued: true };
  const gen = grab(/(?:VALID\s*(?:TILL|UPTO|UP\s*TO|TO|THRU|THROUGH)|EXPIR(?:Y|ES|ATION)|DATE\s*OF\s*EXPIRY|VALIDITY)/);
  if (gen.length) return { value: gen[gen.length - 1], confidence: 0.88, cued: true };
  const nt = grab(/(?:\(NT\)|\bNT\b\s*[:\-]?)/);
  if (nt.length) return { value: nt[nt.length - 1], confidence: 0.8, cued: true };
  const today = new Date().toISOString().slice(0, 10);
  const future = allDates(T).map((d) => d.iso).filter((d) => d > today).sort();
  if (future.length) return { value: future[future.length - 1], confidence: 0.55, cued: false };
  return { value: null, confidence: 0, cued: false };
}

function holderOf(text) {
  const lines = clean(text).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:NAME|HOLDER'?S?\s*NAME|ACCOUNT\s*HOLDER|CUSTOMER\s*NAME)\s*[:\-]?\s*(.+)$/i);
    if (m && /[A-Za-z]{2,}/.test(m[1]) && !/S\/O|D\/O|W\/O|ADDRESS/i.test(m[1])) return { value: m[1].replace(/[^A-Za-z .]/g, '').trim().toUpperCase(), confidence: 0.75 };
    if (/^(?:NAME|HOLDER'?S?\s*NAME)\s*[:\-]?$/i.test(lines[i]) && lines[i + 1] && /^[A-Za-z .]{3,}$/.test(lines[i + 1])) return { value: lines[i + 1].trim().toUpperCase(), confidence: 0.7 };
  }
  return { value: null, confidence: 0 };
}

/**
 * @param {string} text  OCR text
 * @param {string} docType  DL | AADHAAR | PAN | BANK | HZD | AUTO
 * @returns {{ fields: object, confidence: object, doc_type: string, notes: string[] }}
 */
export function extractKyc(text, docType = 'AUTO') {
  const T = upper(text); const fields = {}; const confidence = {}; const notes = [];
  const kind = docType === 'AUTO' ? detectKind(T) : docType;

  // Driving licence: SS-RR-YYYY-NNNNNNN in any spacing (WB20 20040034423, AS-01 2020 0001234)
  const dl = [...T.matchAll(/\b([A-Z]{2})[-\s]?(\d{2})[-\s]?(\d{4})[-\s]?(\d{7})\b/g)].map((m) => `${m[1]}${m[2]}${m[3]}${m[4]}`);
  if (dl.length && (kind === 'DL' || kind === 'AUTO')) { fields.license_no = dl[0]; confidence.license_no = 0.9; }
  // PAN: 5 letters, 4 digits, letter; the 4th letter is the holder type (P = person)
  const pans = [...T.matchAll(/\b([A-Z]{5}\d{4}[A-Z])\b/g)].map((m) => m[1]).filter(panValid);
  if (pans.length && kind !== 'DL') { fields.pan_no = pans[0]; confidence.pan_no = pans[0][3] === 'P' ? 0.92 : 0.7; if (pans[0][3] !== 'P') notes.push(`PAN ${pans[0]} is not an individual's PAN (4th letter ${pans[0][3]})`); }
  // Aadhaar: 12 digits in 4-4-4 (or run together), Verhoeff-valid only
  const aad = [...T.matchAll(/\b(\d{4})\s?(\d{4})\s?(\d{4})\b/g)].map((m) => `${m[1]}${m[2]}${m[3]}`);
  const aadValid = aad.filter(verhoeffValid);
  if (aadValid.length && kind !== 'DL' && kind !== 'PAN') { fields.aadhar_no = aadValid[0]; confidence.aadhar_no = 0.95; }
  else if (aad.length && kind === 'AADHAAR') notes.push('a 12-digit number was read but its check digit fails — re-scan or type it');
  // IFSC + account (passbook)
  const ifsc = [...T.matchAll(/\b([A-Z]{4}0[A-Z0-9]{6})\b/g)].map((m) => m[1]).filter(ifscValid);
  if (ifsc.length) { fields.ifsc_code = ifsc[0]; confidence.ifsc_code = 0.9; const b = BANKS[ifsc[0].slice(0, 4)]; if (b) { fields.bank_name = b; confidence.bank_name = 0.85; } }
  const acc = T.match(/(?:A\/?C|ACCOUNT|ACCT)\.?\s*(?:NO|NUMBER|#)?\.?\s*[:\-]?\s*(\d[\d\s]{8,20}\d)/);
  if (acc) { const n = acc[1].replace(/\s/g, ''); if (n.length >= 9 && n.length <= 18 && !verhoeffValid(n)) { fields.account_no = n; confidence.account_no = 0.8; } }
  if (!fields.account_no && (kind === 'BANK')) {
    const longs = [...T.matchAll(/\b(\d{11,18})\b/g)].map((m) => m[1]).filter((n) => !verhoeffValid(n) && !/^(19|20)\d{2}/.test(n));
    if (longs.length) { fields.account_no = longs[0]; confidence.account_no = 0.5; notes.push('account number taken from the longest digit run — verify against the passbook'); }
  }
  if (!fields.bank_name) { const bm = T.match(/\b(STATE BANK OF INDIA|PUNJAB NATIONAL BANK|UNION BANK OF INDIA|BANK OF BARODA|CANARA BANK|HDFC BANK|ICICI BANK|AXIS BANK|INDIAN BANK|UCO BANK|BANK OF INDIA|CENTRAL BANK OF INDIA|ASSAM GRAMIN VIKASH BANK|INDIA POST PAYMENTS BANK|KOTAK MAHINDRA BANK|IDBI BANK|FEDERAL BANK|BANDHAN BANK)\b/); if (bm) { fields.bank_name = bm[1].replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()).replace(/\bOf\b/g, 'of'); confidence.bank_name = 0.8; } }
  // HZD certificate: "Certificate No" / "Licence No" that is not the DL
  if (kind === 'HZD' || kind === 'AUTO') {
    const h = T.match(/(?:CERT(?:IFICATE)?|LICEN[CS]E|REG(?:ISTRATION)?)\.?\s*(?:NO|NUMBER|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{3,24})/);
    if (h && !dl.includes(h[1].replace(/[-\s]/g, '')) && kind === 'HZD') { fields.hzd_cert_no = h[1]; confidence.hzd_cert_no = 0.7; }
  }
  // Expiry: DL and HZD carry one; a PAN and Aadhaar never do.
  if (kind === 'DL' || kind === 'HZD' || kind === 'AUTO') {
    const ex = expiryOf(T);
    if (ex.value) { const key = kind === 'HZD' ? 'hzd_expiry' : 'license_expiry'; fields[key] = ex.value; confidence[key] = ex.confidence; if (!ex.cued) notes.push('expiry taken as the latest future date on the paper — check it'); }
  }
  const who = holderOf(text); if (who.value) { fields.holder_name = who.value; confidence.holder_name = who.confidence; }
  return { doc_type: kind, fields, confidence, notes };
}

export function detectKind(T) {
  if (/DRIVING\s*LICEN[CS]E|\bDL\s*NO|TRANSPORT\s*VEHICLE|NON[- ]?TRANSPORT|MCWG|LMV|HMV|\bMOTOR\s*VEHICLES?\b/.test(T)) return 'DL';
  if (/HAZARD|HAZMAT|DANGEROUS\s*GOODS|PETROLEUM\s*CLASS|\bHZD\b/.test(T)) return 'HZD';
  if (/PERMANENT\s*ACCOUNT\s*NUMBER|INCOME\s*TAX\s*DEPARTMENT|\bPAN\b/.test(T)) return 'PAN';
  if (/AADHA{1,2}R|UNIQUE\s*IDENTIFICATION|\bUIDAI\b|MERA\s*AADHAAR|\bUID\b/.test(T)) return 'AADHAAR';
  if (/IFSC|PASSBOOK|BRANCH|\bA\/C\b|ACCOUNT\s*NO|SAVINGS|CIF/.test(T)) return 'BANK';
  return 'AUTO';
}
