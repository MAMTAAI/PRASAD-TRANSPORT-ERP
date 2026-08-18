// ═══════════════════════════════════════════════════════════════════════════
// docPatterns.js — one place that knows what a compliance document looks like.
//
// Three callers read a document and must agree about it:
//   scripts/import-vehicle-documents.mjs   reads FILENAMES from the vault tree
//   compliance.routes.js  /unmapped/parse  reads OCR TEXT from a scanned page
//   the Mamta AI Scan button in the browser sends that text here
//
// They used to be able to disagree. A filename-driven bulk import that says
// "PESO, expires 2031" and an on-screen scan of the same page that says
// "unclassified" is not two opinions, it is one register nobody trusts. So the
// patterns live here and the three callers import them.
//
// The tables are deliberately data, not code: adding a document type the
// operator starts issuing is a one-line edit here, and both the importer and
// the scanner pick it up with no other change.
// ═══════════════════════════════════════════════════════════════════════════

// Ordered — first match wins, so specific patterns precede generic ones
// ("permit receipt" and "national permit" before a bare "permit").
// The ids MUST match the Vault screen tabs: it renders eleven fixed ids and
// anything prefixed `custom_`, reading the display name off the row. An id the
// screen does not know is a document filed where no tab will ever look for it.
export const DOC_TYPES = [
  [/permit\s*receipt|receipt.*permit/i, 'custom_permit_receipt', 'Permit Receipt'],
  [/national\s*permit/i, 'national_permit', 'National Permit'],
  [/home\s*permit/i, 'home_permit', 'Home Permit'],
  [/assam\s*permit/i, 'custom_assam_permit', 'Assam Permit'],
  [/\bpermit\b/i, 'custom_permit', 'Permit'],
  [/insurance|policy\s*no|insured\s*declared/i, 'insurance', 'Insurance'],
  [/fitness|certificate\s*of\s*fitness/i, 'fitness', 'Fitness Certificate'],
  // "9809 PUCValid 21.08.2026.pdf" has no word boundary after PUC.
  [/\bpuc|pollution\s*under\s*control|pollution/i, 'pollution', 'PUC'],
  [/peso|peco|explosive|petroleum\s*and\s*explosives/i, 'explosive', 'PESO / Explosive Licence'],
  // Typed by hand over years: "Cal;ibration", "calibation".
  [/cal[a-z;]{0,3}bration|calibation/i, 'calibration', 'Calibration'],
  [/fire\s*bottle|fire\s*extinguish/i, 'custom_fire_bottle', 'Fire Bottle'],
  [/\bcll\b/i, 'custom_cll', 'CLL'],
  [/road\s*tax|danta\s*tax|\bmv\s*tax|motor\s*vehicle\s*tax/i, 'mv_tax', 'Road Tax'],
  [/harzard|hazard|\bhzd\b/i, 'custom_hazardous', 'Hazardous Licence'],
  [/certificate\s*of\s*cont?ral|certificate\s*of\s*control/i, 'custom_certificate_of_control', 'Certificate of Control'],
  [/hydro\s*test|rule\s*18/i, 'rule18', 'Rule 18 Hydro Test'],
  [/rule\s*19\s*a/i, 'custom_rule_19a', 'Rule 19A'],
  [/vltd|fitment\s*cert/i, 'custom_vltd', 'VLTD Fitment Certificate'],
  [/\br\.?\s*c\b|registration\s*cert|certificate\s*of\s*registration/i, 'custom_rc', 'RC'],
  [/\bg\s*certificate/i, 'custom_g_certificate', 'G Certificate'],
  [/\bh\s*certificate/i, 'custom_h_certificate', 'H Certificate'],
  [/photo/i, 'custom_vehicle_photo', 'Vehicle Photo'],
];

// Driver paperwork. Kept as its own list rather than folded into DOC_TYPES:
// these belong to a person, not a lorry, and `drivers` already has columns for
// them (dl_photo_url, aadhar_photo_url, pan_photo_url, bank_photo_url).
// Filing a driver's PAN against a vehicle would put a permanent no-expiry row
// in the compliance register.
// Split in two, because "photo" and "hazardous" are the only words in this
// vocabulary that belong to BOTH a lorry and a person. Everything in
// DRIVER_ONLY identifies a human document no matter where the file sits and so
// outranks the vehicle table; the contextual ones are decided by which folder
// the file is in. Without that split, "DL,HZD.pdf" matched \bhzd\b in the
// vehicle table first and a driver's endorsement got filed as lorry compliance.
export const DRIVER_ONLY_TYPES = [
  [/driving\s*licen[cs]e|\bdl\b/i, 'driver_dl', 'Driving Licence'],
  [/aadhar|aadhaar/i, 'driver_aadhar', 'Aadhaar'],
  [/\bpan\b/i, 'driver_pan', 'PAN'],
  [/voter/i, 'driver_voter', 'Voter ID'],
  [/bank\s*(pass\s*book|pasbook|passbook)|\bbank\s*a\/?c\b/i, 'driver_bank', 'Bank Passbook'],
  [/police(\s*report|\s*verification)?/i, 'driver_police', 'Police Verification'],
  [/eye\s*ta?st|eye\s*test/i, 'driver_eye_test', 'Eye Test'],
  [/signature|\bsig\b/i, 'driver_signature', 'Signature'],
];

export const DRIVER_CONTEXTUAL_TYPES = [
  [/harzard|hazard|\bhzd\b/i, 'driver_hzd', 'Hazardous Endorsement'],
  [/authority/i, 'driver_authority', 'Driver Authority'],
  [/photo|\bpho\b/i, 'driver_photo', 'Photograph'],
];

export const DRIVER_DOC_TYPES = [...DRIVER_ONLY_TYPES, ...DRIVER_CONTEXTUAL_TYPES];

/** True when a path segment says this file was filed under a driver folder. */
export const DRIVER_FOLDER_RE = /driver|pilot|khalasi/i;

// Trip paperwork that lands in the same folders. A challan is not statutory;
// filing it as compliance puts a permanent "expired" row on the dashboard.
export const NOT_COMPLIANCE = /challan|loading\s*advice|invoice|bilty|bilti/i;

// ── document KIND, one level above type ────────────────────────────────────
// A scanner pointed at a phone camera gets whatever is on the desk: a fitness
// certificate, a driver's Aadhaar, an IOCL invoice, a loading challan, a bilty.
// Deciding the KIND first is what lets one endpoint serve all of them — the
// extraction rules for an invoice have nothing in common with those for a
// permit, and a parser that tries one set on the other returns confident
// nonsense.
//
// Ordered most-specific first. Trip paperwork precedes compliance because a
// loading challan names a lorry and a date too, and would otherwise read as a
// permit for that lorry.
export const DOC_KINDS = [
  ['LOADING_CHALLAN', /loading\s*(advice|challan|slip)|\bl\.?a\.?\s*no|invoice\s*cum\s*(gate|loading)|gate\s*pass/i],
  ['BILTY',           /\bbilty\b|\bbilti\b|consignment\s*note|goods\s*receipt|\bg\.?r\.?\s*no\b|lorry\s*receipt|\bl\.?r\.?\s*no\b/i],
  ['INVOICE',         /tax\s*invoice|\binvoice\b|\bgstin\b|\bhsn\b|bill\s*of\s*supply|debit\s*note|credit\s*note/i],
  ['DRIVER',          /driving\s*licen[cs]e|aadhaar|aadhar|permanent\s*account\s*number|\bpan\s*card|voter|passbook|police\s*verification/i],
  ['COMPLIANCE',      /permit|insurance|fitness|pollution|\bpuc\b|explosive|peso|calibration|hydro|road\s*tax|mv\s*tax|registration\s*cert|certificate\s*of\s*registration|form\s*23\b/i],
];

export function documentKind(text) {
  const t = String(text || '');
  for (const [kind, re] of DOC_KINDS) if (re.test(t)) return kind;
  return 'UNKNOWN';
}

// Fields that only exist on trip and billing paperwork. Kept as labelled
// patterns rather than an LLM prompt so the AWS fallback — which has no model —
// extracts exactly what the local path does.
const MONEY = String.raw`(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)`;
export const FIELD_PATTERNS = {
  invoice_no:   /(?:tax\s*invoice|invoice|bill)\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{2,24})/i,
  challan_no:   /(?:challan|l\.?a\.?|loading\s*advice)\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{2,24})/i,
  gr_no:        /(?:g\.?r\.?|lorry\s*receipt|l\.?r\.?|consignment)\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{2,24})/i,
  gstin:        /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/i,
  total_amount: new RegExp(String.raw`(?:grand\s*total|net\s*(?:amount|payable)|total\s*(?:amount|value|invoice)?)\s*[:\-]?\s*` + MONEY, 'i'),
  quantity_kl:  /([0-9][0-9,]*(?:\.[0-9]{1,3})?)\s*(?:kl|kilo\s*litre|kilolitre)\b/i,
  quantity_ltr: /([0-9][0-9,]*(?:\.[0-9]{1,3})?)\s*(?:ltr|litre|liters?|l)\b/i,
  product:      /\b(hsd|high\s*speed\s*diesel|\bms\b|motor\s*spirit|petrol|\batf\b|aviation\s*turbine|\blpg\b|ethanol)\b/i,
};

const num = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Trip/billing fields. Absent fields are simply absent — never zero. */
export function extractTripFields(text) {
  const t = String(text || '');
  const grab = (k) => { const m = t.match(FIELD_PATTERNS[k]); return m ? m[1] : null; };
  const kl = grab('quantity_kl');
  const ltr = grab('quantity_ltr');
  return {
    invoice_no: grab('invoice_no'),
    challan_no: grab('challan_no'),
    gr_no: grab('gr_no'),
    gstin: grab('gstin') ? grab('gstin').toUpperCase() : null,
    total_amount: num(grab('total_amount')),
    // One quantity, in litres. A KL figure is the one printed on Indian
    // petroleum paperwork; converting here means downstream never has to ask
    // which unit it received.
    quantity_ltr: kl != null ? Math.round(num(kl) * 1000) : (ltr != null ? Math.round(num(ltr)) : null),
    product: grab('product') ? grab('product').toUpperCase().replace(/\s+/g, ' ') : null,
    document_date: findDates(t)[0] ?? null,
  };
}

// Indian commercial plates in this fleet: AS 26C 9803, NL 01AD 0831, AS26C5101.
export const REG_RE = /\b([A-Z]{2})[ \-]?(\d{1,2})[ \-]?([A-Z]{1,3})[ \-]?(\d{4})\b/gi;

export const normReg = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Full registrations found in `text` that exist in `known` (a Set/Map of normalised regs). */
export function findRegistrations(text, known) {
  const out = new Set();
  for (const m of String(text).matchAll(REG_RE)) {
    const key = normReg(m[1] + m[2] + m[3] + m[4]);
    if (!known || known.has(key)) out.add(key);
  }
  return [...out];
}

function buildDate(d, mo, y) {
  d = +d; mo = +mo; y = +y;
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2000 || y > 2099) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== d) return null;
  return iso;
}

/** All parseable dates in a string, in order of appearance. */
export function findDates(s) {
  if (!s) return [];
  const out = [];
  for (const m of String(s).matchAll(/(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{2,4})\b/g)) {
    const v = buildDate(m[1], m[2], m[3]);
    if (v) out.push(v);
  }
  // Run together: "valid -16102027". Four-digit year required, so a serial like
  // EXPLOSIVE0001 cannot match.
  for (const m of String(s).matchAll(/(?<!\d)(\d{2})(\d{2})(20\d{2})(?!\d)/g)) {
    const v = buildDate(m[1], m[2], m[3]);
    if (v) out.push(v);
  }
  return out;
}

export function firstDate(...sources) {
  for (const s of sources) { const d = findDates(s); if (d.length) return d[0]; }
  return null;
}

/**
 * Pick the EXPIRY out of a scanned page. A government certificate prints an
 * issue date and a validity date side by side; the later one is the expiry, and
 * a word like "valid upto" next to it settles it when both are in the future.
 */
// "Valid From 01-02-2019" is an ISSUE date. An earlier version accepted a bare
// "valid" as the cue, so every RC in the fleet read as having expired the day it
// was registered. The upto/till/until word is now required — a cue is only a cue
// when it actually says the document ENDS there.
const EXPIRY_CUE = /(?:valid(?:ity)?\s*(?:up\s*?to|upto|till|until|thru|through)|expir\w*|due\s*(?:on|date)?)\D{0,20}((?:\d{1,2}[.\-/\s]\d{1,2}[.\-/\s]\d{2,4})|(?:\d{8}))/i;

/**
 * Returns { date, cue } — `cue` is true only when a validity keyword sat next
 * to the date.
 *
 * Every certificate prints at least two dates and the wrong one is always
 * plausible. A permit read as expiring on its DATE OF APPROVAL lands in the
 * register as long-expired and buries the genuine alerts under noise; an RC
 * read as expiring on its registration date does the same. So: a cued date
 * wins, otherwise the furthest date in the FUTURE, and only if neither exists
 * does the latest date on the page get used — reported with cue false, which is
 * what stops the caller calling it confident.
 */
export function expiryWithCue(text, today = new Date().toISOString().slice(0, 10)) {
  const t = String(text || '');
  const near = t.match(EXPIRY_CUE);
  if (near) { const d = findDates(near[1]); if (d.length) return { date: d[0], cue: true }; }
  const all = findDates(t).sort();
  if (!all.length) return { date: null, cue: false };
  const future = all.filter((d) => d >= today);
  if (future.length) return { date: future.at(-1), cue: false };
  return { date: all.at(-1), cue: false };
}

export function expiryFrom(text) {
  return expiryWithCue(text).date;
}

/** The bare 4-digit fleet number, with dates stripped so a year is not read as a truck. */
export function fleetNumberIn(text) {
  const cleaned = String(text)
    .replace(/\d{1,2}[.\-/\s]\d{1,2}[.\-/\s]\d{2,4}/g, ' ')
    .replace(/(?<!\d)\d{2}\d{2}(?:19|20)\d{2}(?!\d)/g, ' ');
  for (const m of cleaned.matchAll(/(?:^|[^0-9A-Za-z])(\d{4})(?![0-9])/g)) {
    const n = +m[1];
    if (n >= 1900 && n <= 2099) continue;
    return m[1];
  }
  return null;
}

/**
 * Classify a document from any text — a filename, a folder name, or a page of
 * OCR. Returns { scope: 'VEHICLE'|'DRIVER', type, label } or null.
 * Sources are tried in order, so the more specific one should come first.
 */
export function classifyDocument(...sources) {
  // Last argument may be an options object: { driverContext: boolean }.
  let opts = {};
  if (sources.length && typeof sources.at(-1) === 'object' && sources.at(-1) !== null) opts = sources.pop();
  const texts = sources.filter(Boolean);
  // NEVER INFERRED. Sniffing the word `driver` out of the text was the bug: a
  // registration certificate names its driver, so the whole page flipped to
  // driver mode and an RC came back as a Driver Authority. Guarding it by
  // length did not help either — a short OCR snippet and a folder name are the
  // same shape, and only the caller can tell them apart. So the caller says.
  // Default false: a document is a vehicle document unless someone knows better.
  const driverContext = opts.driverContext === true;

  for (const src of texts) if (NOT_COMPLIANCE.test(src)) return null;

  const tryTable = (table, scope) => {
    for (const src of texts) {
      for (const [re, type, label] of table) if (re.test(src)) return { scope, type, label };
    }
    return null;
  };

  // A human document is a human document wherever it was filed.
  const only = tryTable(DRIVER_ONLY_TYPES, 'DRIVER');
  if (only) return only;

  // "photo" and "hazardous" go to whichever owner the folder says.
  if (driverContext) {
    return tryTable(DRIVER_CONTEXTUAL_TYPES, 'DRIVER') ?? tryTable(DOC_TYPES, 'VEHICLE');
  }
  return tryTable(DOC_TYPES, 'VEHICLE') ?? tryTable(DRIVER_CONTEXTUAL_TYPES, 'DRIVER');
}

/**
 * Everything the scanner can say about a page of extracted text.
 * `known` is a Set of normalised registrations from the vehicle master.
 */
export function parseDocumentText(text, known) {
  const cls = classifyDocument(text);
  const regs = findRegistrations(text, known);
  return {
    scope: cls?.scope ?? null,
    doc_type: cls?.type ?? null,
    doc_name: cls?.label ?? null,
    vehicle_regs: regs,
    fleet_number: regs.length ? null : fleetNumberIn(text),
    expiry_date: expiryFrom(text),
    all_dates: findDates(text),
    confident: Boolean(cls && regs.length === 1 && expiryFrom(text)),
  };
}

/**
 * The universal entry point: decide the KIND first, then apply only the rules
 * that make sense for it.
 *
 * This function is the AWS fallback in its entirety. It needs no model, no GPU
 * and no network — Tesseract hands it text and it hands back structure. That is
 * deliberate: the lightweight path must be the SAME code the local path runs,
 * or a phone scanning at 2am while the office PC is off would get answers the
 * office would not recognise in the morning.
 */
export function parseAnyDocument(text, known) {
  const kind = documentKind(text);
  const regs = findRegistrations(text, known);
  const base = {
    kind,
    vehicle_regs: regs,
    fleet_number: regs.length ? null : fleetNumberIn(text),
    all_dates: findDates(text),
  };

  if (kind === 'INVOICE' || kind === 'LOADING_CHALLAN' || kind === 'BILTY') {
    const f = extractTripFields(text);
    return {
      ...base, ...f,
      // A trip document is usable once it names a lorry, a reference and a date.
      confident: Boolean(regs.length === 1 && (f.invoice_no || f.challan_no || f.gr_no) && f.document_date),
    };
  }

  // COMPLIANCE, DRIVER and UNKNOWN all go through the document-type tables:
  // an unrecognised page is still worth classifying if a keyword lands.
  // The KIND already decided whose document this is; pass it rather than
  // letting the type tables re-guess from the same page.
  const cls = classifyDocument(text, { driverContext: kind === 'DRIVER' });
  const { date: expiry, cue } = expiryWithCue(text);
  const today = new Date().toISOString().slice(0, 10);
  // An uncued date already in the past is far more likely the issue date than
  // the expiry. The value is still reported — it is the best reading available —
  // but it must not be called confident, or a misread issue date walks into the
  // register as an expiry and shows the lorry as long overdue.
  const expiryTrusted = Boolean(expiry) && (cue || expiry >= today);
  return {
    ...base,
    scope: cls?.scope ?? null,
    doc_type: cls?.type ?? null,
    doc_name: cls?.label ?? null,
    expiry_date: expiry,
    expiry_cued: cue,
    confident: Boolean(cls && expiryTrusted && (cls.scope === 'DRIVER' || regs.length === 1)),
  };
}
