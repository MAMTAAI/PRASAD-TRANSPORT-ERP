// src/lib/tripPlaces.ts
// ─────────────────────────────────────────────────────────────────────────────
// TYPES FOR THE APP, RULE FROM ONE PLACE.
//
// The rule that turns "7D18" into something Google can find lives in
// ./tripPlaces.core.mjs — plain ESM, because the API box imports the SAME file
// to geocode the driver app's map and the two must never drift. Read the long
// explanation there; this file only puts TypeScript's clothes on it.
// ─────────────────────────────────────────────────────────────────────────────
export {
  DEPOT_BY_CODE,
  placeOf,
  routeAppUrl,
  placeAppUrl,
  // Deprecated — the legacy directions iframe renders the world, not the route.
  // See the note in the core module. No new callers.
  routeEmbedUrl,
  placeEmbedUrl,
} from './tripPlaces.core.mjs';

export type Place = {
  /** What to hand Google. Null when we refuse to guess. */
  query: string | null;
  /** What to show a person — always something, even when query is null. */
  label: string;
  /** True when the raw value was a code we could not resolve. */
  unresolved: boolean;
};
