// Types for ./tripPlaces.core.mjs — the module itself is plain ESM so the API
// box can import the identical rule (see the header there). Hand-written rather
// than switching the whole app to allowJs for one file.

export declare const DEPOT_BY_CODE: Record<string, string>;

export declare function placeOf(raw: unknown): {
  query: string | null;
  label: string;
  unresolved: boolean;
};

export declare function routeAppUrl(from: unknown, to: unknown): string | null;
export declare function placeAppUrl(raw: unknown): string | null;

/** @deprecated The legacy directions iframe renders the world, not the route. */
export declare function routeEmbedUrl(from: unknown, to: unknown): string | null;
/** @deprecated */
export declare function placeEmbedUrl(raw: unknown): string | null;
