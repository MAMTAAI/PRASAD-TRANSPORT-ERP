// server/lib/partyFormats.js
// ─────────────────────────────────────────────────────────────────────────────
// INDIAN COMPLIANCE FORMATS, SERVER SIDE.
//
// src/lib/validators.ts has held these patterns since Phase A, but it is a
// browser module — so every check it ran was a courtesy the caller could skip.
// The customer registration form (2026-09-03) is reachable with no session at
// all, which makes it the first place where a malformed GSTIN can arrive from
// something that is not our UI. These are the same expressions, applied where
// they cannot be bypassed.
//
// Keep the two files in step: a pattern loosened here must be loosened there,
// or the phone will accept what the server then rejects.
// ─────────────────────────────────────────────────────────────────────────────
export const RX = {
  mobileIN: /^[6-9]\d{9}$/,
  pan:      /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/,
  gstin:    /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  ifsc:     /^[A-Z]{4}0[A-Z0-9]{6}$/,
  pincode:  /^[1-9]\d{5}$/,
  accountNo:/^\d{9,18}$/,
  email:    /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/,
};

/** Last ten digits, so +91 / 0 prefixes and spacing all land the same way. */
export const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);
export const upper  = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().toUpperCase());
export const trimOrNull = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

/** GSTIN carries the PAN in characters 3-12; a pair that disagrees is a typo
 *  on one of them, and it is the single most useful check on this form. */
export const gstinHoldsPan = (gstin, pan) => {
  const g = upper(gstin), p = upper(pan);
  if (!g || !p || g.length !== 15) return true; // nothing to contradict
  return g.slice(2, 12) === p;
};

/** Returns [] when everything given is well formed, else a list of
 *  { field, message } the form can paint under the offending input. */
/** `requireGst` demands GSTIN **and** PAN — a firm we bill against has both.
 *  `requirePan` demands PAN alone, which is the fleet-partner case (owner,
 *  3-Sep): a single-lorry operator often has no GST registration, but the
 *  office cannot pay one without a PAN. */
export function checkParty(b, { requireGst = false, requirePan = false, requireBank = false } = {}) {
  const bad = [];
  const test = (field, value, rx, message, required) => {
    const s = value == null ? '' : String(value).trim();
    if (!s) { if (required) bad.push({ field, message: message + ' (required)' }); return; }
    if (!rx.test(s.toUpperCase())) bad.push({ field, message });
  };
  test('mobile_no',  last10(b.mobile_no), RX.mobileIN, 'Enter a valid 10-digit mobile number', true);
  test('gst_no',     upper(b.gst_no),     RX.gstin,    'GSTIN must be 15 characters, e.g. 18ABCDE1234F1Z5', requireGst);
  // The 4th character is the holder type (P individual, C company, F firm, …),
  // so a made-up example like ABCDE1234F is itself invalid — the sample shown
  // to the applicant has to be one the pattern actually accepts.
  test('pan_no',     upper(b.pan_no),     RX.pan,      'PAN must look like AAAPA1234A (10 characters)', requireGst || requirePan);
  test('pincode',    b.pincode,           RX.pincode,  'Pincode must be 6 digits', false);
  test('email',      b.email,             RX.email,    'Enter a valid email address', false);
  test('ifsc_code',  upper(b.ifsc_code),  RX.ifsc,     'IFSC must look like SBIN0001234', requireBank);
  test('account_no', String(b.account_no ?? '').replace(/\s/g, ''), RX.accountNo, 'Bank account number must be 9-18 digits', requireBank);
  if (requireBank && !trimOrNull(b.bank_name)) bad.push({ field: 'bank_name', message: 'Bank name is required' });
  if (b.gst_no && b.pan_no && !gstinHoldsPan(b.gst_no, b.pan_no)) {
    bad.push({ field: 'pan_no', message: 'PAN does not match the PAN inside the GSTIN — check both' });
  }
  return bad;
}
