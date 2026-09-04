// Types for ./tollRoute.mjs — plain ESM so the selftest and (later) the API box
// can import the same arithmetic the browser uses. See the header there.

export interface TollPlaza {
  id?: string;
  name_key?: string;
  plaza_name: string;
  lat: number | string | null;
  lng: number | string | null;
  rate: number | string | null;
  rate_source?: 'FASTAG_HISTORY' | 'MANUAL';
  observations?: number;
  rate_min?: number | string | null;
  rate_max?: number | string | null;
  last_seen?: string | null;
  highway?: string | null;
}

export interface GateOnRoute extends TollPlaza {
  /** How far the gate sits off the drawn road, in metres. */
  distance_m: number;
  /** Index of the nearest polyline vertex — the ordering key. */
  at: number;
}

export interface TollTotals {
  gates: number;
  priced: number;
  unknown: number;
  one_way: number;
  total: number;
  round_trip: boolean;
  /** True when some gate on the route has no known rate. */
  incomplete: boolean;
}

export declare function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number;

export declare function plazasOnRoute(
  path: Array<{ lat: number; lng: number }>,
  plazas: TollPlaza[],
  opts?: { toleranceM?: number },
): GateOnRoute[];

export declare function tollTotals(
  gates: GateOnRoute[],
  opts?: { roundTrip?: boolean },
): TollTotals;

export declare function legKindOf(trip: unknown): {
  kind: 'ROUND' | 'ONE_WAY';
  source: 'SAVED' | 'MARKET_VEHICLE' | 'OIL_COMPANY_DEFAULT';
};
