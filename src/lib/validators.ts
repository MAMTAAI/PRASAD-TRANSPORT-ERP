// ✅ Shared field validators (Phase A). One home for every Indian-compliance
// format check — used by staff masters and the portals. Each returns
// { ok, message } with a bilingual message the UI can show directly.

export const RX = {
  mobileIN: /^[6-9]\d{9}$/,
  aadhaar: /^[2-9]\d{11}$/,
  pan: /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/,
  gstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  pincode: /^[1-9]\d{5}$/,
  vehicleNo: /^[A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{4}$/,
  accountNo: /^\d{9,18}$/,
};

export interface Check { ok: boolean; message: string; }
const pass: Check = { ok: true, message: '' };
const fail = (message: string): Check => ({ ok: false, message });

const clean = (v: any) => String(v ?? '').trim();

/** Empty values pass unless required=true — callers decide mandatory-ness. */
function check(v: any, rx: RegExp, required: boolean, msg: string, transform?: (s: string) => string): Check {
  let s = clean(v);
  if (transform) s = transform(s);
  if (!s) return required ? fail(msg + ' (required / ज़रूरी है)') : pass;
  return rx.test(s) ? pass : fail(msg);
}

export const vMobile = (v: any, required = false) =>
  check(v, RX.mobileIN, required, 'Enter a valid 10-digit mobile number / सही 10 अंकों का मोबाइल नंबर डालें', s => s.replace(/[^\d]/g, '').replace(/^(91|0)(?=[6-9]\d{9}$)/, ''));

export const vGstin = (v: any, required = false) =>
  check(v, RX.gstin, required, 'Invalid GSTIN format (15 chars, e.g. 18ABCDE1234F1Z5) / GSTIN सही नहीं है', s => s.toUpperCase());

export const vPan = (v: any, required = false) =>
  check(v, RX.pan, required, 'Invalid PAN format (e.g. ABCDE1234F) / PAN सही नहीं है', s => s.toUpperCase());

export const vIfsc = (v: any, required = false) =>
  check(v, RX.ifsc, required, 'Invalid IFSC code (e.g. SBIN0001234) / IFSC सही नहीं है', s => s.toUpperCase());

export const vPincode = (v: any, required = false) =>
  check(v, RX.pincode, required, 'Invalid pincode (6 digits) / पिनकोड सही नहीं है');

export const vAccountNo = (v: any, required = false) =>
  check(v, RX.accountNo, required, 'Invalid bank account number (9-18 digits) / खाता नंबर सही नहीं है', s => s.replace(/\s/g, ''));

export const vVehicleNo = (v: any, required = false) =>
  check(v, RX.vehicleNo, required, 'Invalid vehicle number (e.g. AS01AB1234) / गाड़ी नंबर सही नहीं है', s => s.toUpperCase());

/** Aadhaar: format + Verhoeff checksum (the real check — catches typos). */
export function vAadhaar(v: any, required = false): Check {
  const s = clean(v).replace(/[\s-]/g, '');
  if (!s) return required ? fail('Aadhaar is required / आधार ज़रूरी है') : pass;
  if (!RX.aadhaar.test(s)) return fail('Aadhaar must be 12 digits (not starting 0/1) / आधार 12 अंकों का होता है');
  return verhoeff(s) ? pass : fail('Aadhaar checksum failed — please re-check the digits / आधार नंबर में गलती है');
}

// Verhoeff tables
const dTab = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const pTab = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function verhoeff(numStr: string): boolean {
  let c = 0;
  const digits = numStr.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = dTab[c][pTab[i % 8][digits[i]]];
  return c === 0;
}

/** GSTIN embeds the PAN at positions 3-12 — cross-check when both provided. */
export function gstinPanMatch(gstin: any, pan: any): Check {
  const g = clean(gstin).toUpperCase(), p = clean(pan).toUpperCase();
  if (!g || !p) return pass;
  return g.slice(2, 12) === p ? pass : fail('GSTIN and PAN do not match each other / GSTIN और PAN आपस में मेल नहीं खाते');
}

/** Run a set of checks; returns all failure messages (empty array = valid). */
export function runChecks(checks: Check[]): string[] {
  return checks.filter(c => !c.ok).map(c => c.message);
}
