// src/lib/tripPlaces.ts
// ─────────────────────────────────────────────────────────────────────────────
// TURNING WHAT THE REGISTER STORES INTO SOMETHING GOOGLE CAN FIND.
//
// "Route Tracking" opened on a map of the entire planet. Not a styling bug and
// not a missing API key: the embed is built as
// `maps.google.com/maps?saddr=<origin>&daddr=<destination>&output=embed`, and
// on the trips imported from IOCL the origin is the literal string "7T04".
// Google cannot geocode that, the directions request fails, and a failed
// directions embed falls back to the whole world. The destination resolved fine
// — that is why the screenshot showed a pin on Chabua and an ocean around it.
//
// THE NAME WAS NEVER MISSING, IT WAS DISCARDED. iocl_ac5_parser.py reads BOTH
// `loading_point_code` ("7T04") and `loading_point` ("Lumding Terminal ...")
// off the invoice; iocl_ac5_loading.py then posts the CODE and drops the name.
// Fixed there too, but that only helps trips imported from now on.
//
// SO THE RESOLUTION LIVES HERE, ON THE READ SIDE, and every trip ever imported
// gets a working map the moment this ships — no migration, no rewriting of
// forty-seven rows of history. It also means the register keeps storing exactly
// what IOCL printed, which is what a register is for.
//
// EVERY NAME BELOW COMES FROM THE COMPANY'S OWN RECORDS. Each code is one that
// appears BOTH bare and named in `trips.loading_point` — "7D18" on the imported
// rows and "MOINARBAND DEPOT (7D18)" on the older typed ones — or is named in
// the parser's own output for that code. Nothing here is a guess at where a
// depot might be. Two codes are deliberately absent for that reason (see below)
// and the caller is told rather than shown a plausible wrong place.
// ─────────────────────────────────────────────────────────────────────────────

/** IOCL depot code -> the name this company already uses for it.
 *
 *  Provenance, so the next person does not have to re-derive it:
 *    7D17  IMPHAL DEPOT        · 61 trips typed as "IMPHAL DEPOT (7D17)"
 *    7D18  MOINARBAND DEPOT    · 105 typed as "MOINARBAND DEPOT (7D18)"
 *    7R01  BONGAIGAON RC OFFICE· 357 typed as "BONGAIGAON  RC  OFFICE  (7R01)"
 *    7T04  LUMDING TERMINAL    · 76 typed as "LUMDING TERMINAL (7T04)"
 *    7R02  GUWAHATI RC OFFICE  · parser reads "Guwahati RC Office" for 7R02,
 *                                and 18 trips are typed "GUWAHATI RC OFFICE"
 *
 *  NOT LISTED, ON PURPOSE: 7B10 and 2377. Both appear only as bare codes — 3
 *  and 6 trips — and nothing in the register or on the invoices says what they
 *  are. Inventing a depot for them would put a confident pin on the wrong town,
 *  which is worse than the honest "could not place this" the UI now shows. Add
 *  them here the day somebody who knows says what they are.
 */
export const DEPOT_BY_CODE: Record<string, string> = {
  '7D17': 'Imphal Depot',
  '7D18': 'Moinarband Depot',
  '7R01': 'Bongaigaon RC Office',
  '7R02': 'Guwahati RC Office',
  '7T04': 'Lumding Terminal',
};

/** A bare IOCL location code: digit, letter, two digits — "7T04", "7D18". */
const BARE_CODE = /^[0-9][A-Z][0-9]{2}$/i;
/** The consignee form the register stores: "ZC7A01 -Agartala AFS 7A01". */
const ZC_PREFIX = /^ZC[0-9A-Z]{4}\s*-?\s*/i;
/** A trailing "(7T04)" on an already-named depot. */
const TRAILING_CODE = /\s*\(\s*[0-9][A-Z][0-9]{2}\s*\)?\s*$/i;

export type Place = {
  /** What to hand Google. Null when we refuse to guess. */
  query: string | null;
  /** What to show a person — always something, even when query is null. */
  label: string;
  /** True when the raw value was a code we could not resolve. */
  unresolved: boolean;
};

/**
 * Turn a stored loading_point / consignee_name / unloading_location into
 * something a map can find.
 *
 * Region-biased with ", India" because several of these names are not unique on
 * a planet — "Lumding Terminal" is safe, "Guwahati RC Office" less so, and a
 * geocoder with no bias has been known to answer with the other hemisphere.
 */
export function placeOf(raw: unknown): Place {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { query: null, label: '—', unresolved: false };

  // A bare code is the whole reason this file exists.
  if (BARE_CODE.test(s)) {
    const name = DEPOT_BY_CODE[s.toUpperCase()];
    if (!name) return { query: null, label: s, unresolved: true };
    return { query: `${name}, India`, label: `${name} (${s.toUpperCase()})`, unresolved: false };
  }

  // "ZC7A01 -Agartala AFS 7A01" -> "Agartala AFS 7A01". The ZC code is an SAP
  // consignee id and geocodes to nothing; dropping it is what lets the rest of
  // the string be found.
  let cleaned = s.replace(ZC_PREFIX, '').trim();

  // THE CODE IN BRACKETS OUTRANKS THE PROSE IN FRONT OF IT.
  //
  // The same depot is not named the same way twice. 7D18 is "MOINARBAND DEPOT"
  // on 105 rows the office typed and "Rail fed POL Storage Depot" on the AC5
  // invoices — both correct, only one findable. Where a trailing code is one we
  // know, its name wins for the QUERY; the label still shows what is stored, so
  // nobody has to wonder why the map said something else.
  const codeMatch = s.match(/\(\s*([0-9][A-Z][0-9]{2})\s*\)?\s*$/i);
  if (codeMatch) {
    const known = DEPOT_BY_CODE[codeMatch[1].toUpperCase()];
    if (known) return { query: `${known}, India`, label: s, unresolved: false };
  }

  // "MOINARBAND DEPOT (7D18)" -> "MOINARBAND DEPOT". Kept in the label so the
  // operator still sees the code they know the depot by.
  const named = cleaned.replace(TRAILING_CODE, '').trim();
  if (named) cleaned = named;

  if (!cleaned) return { query: null, label: s, unresolved: true };
  return { query: `${cleaned}, India`, label: s, unresolved: false };
}

/** The embed URL for a route, or null when either end cannot be placed.
 *  Null is the point: a directions embed with an unfindable end does not show
 *  an error, it shows the Atlantic. */
export function routeEmbedUrl(from: unknown, to: unknown): string | null {
  const a = placeOf(from);
  const b = placeOf(to);
  if (!a.query || !b.query) return null;
  return `https://maps.google.com/maps?saddr=${encodeURIComponent(a.query)}`
       + `&daddr=${encodeURIComponent(b.query)}&z=7&output=embed`;
}

/** The same route in the real Google Maps app / site. */
export function routeAppUrl(from: unknown, to: unknown): string | null {
  const a = placeOf(from);
  const b = placeOf(to);
  if (!a.query || !b.query) return null;
  return 'https://www.google.com/maps/dir/?api=1'
       + `&origin=${encodeURIComponent(a.query)}`
       + `&destination=${encodeURIComponent(b.query)}`
       + '&travelmode=driving';
}

/** One end only — used when there is a place but no pair to route between. */
export function placeEmbedUrl(raw: unknown): string | null {
  const p = placeOf(raw);
  if (!p.query) return null;
  return `https://maps.google.com/maps?q=${encodeURIComponent(p.query)}&z=11&output=embed`;
}
