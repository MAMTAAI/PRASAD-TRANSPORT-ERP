// Types for ./mapSymbols.mjs — the one symbol vocabulary every map in the
// system draws with. See the header there for what each symbol means.

/** A google.maps.Symbol — one path, one fill. Still right for a telemetry dot. */
export interface MapSymbol {
  path: string | number;
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWeight?: number;
  strokeOpacity?: number;
  scale?: number;
  rotation?: number;
  anchor?: { x: number; y: number };
  labelOrigin?: { x: number; y: number };
}

/** A google.maps.Icon backed by an inline SVG data: URI — multi-colour artwork
 *  with gradients, shadows and text. `scaledSize`/`anchor`/`labelOrigin` are
 *  real google.maps.Size / Point once the SDK is loaded. */
export interface MapImageIcon {
  url: string;
  scaledSize: unknown;
  anchor: unknown;
  labelOrigin?: unknown;
}

export type MapIcon = MapSymbol | MapImageIcon;

export interface MapLabel {
  text: string;
  color?: string;
  fontSize?: string;
  fontWeight?: string;
  className?: string;
}

export declare const INK: Record<
  'loading' | 'unloading' | 'truck' | 'gate' | 'gateCrossed' | 'gateUnknown' | 'outline' | 'outlineLight',
  string
>;

/** The loading end — a refinery/terminal glyph in a green hub pin. */
export declare function loadingPin(): MapImageIcon;
/** The unloading end — a warehouse/AFS glyph in a pink hub pin. */
export declare function unloadingPin(): MapImageIcon;
/** The lorry, drawn from above and rotated to `heading` (degrees, 0 = north). */
export declare function truckIcon(heading?: number, scale?: number): MapImageIcon;
/** The registration plate, passed to the Marker as its `label`. */
export declare function truckLabel(vehicleNo?: string | null): MapLabel | undefined;
/** A fix reported by the driver's PHONE — a person, not a device. */
export declare function driverIcon(best?: boolean): MapImageIcon;
/** A toll booth with its barrier arm and the rate on a plate. Arm is up and
 *  green once crossed, down and amber while pending, slate "?" when unpriced. */
export declare function gateIcon(
  crossed: boolean, known: boolean, rate?: number | string | null,
): MapImageIcon;
/** @deprecated The rate is drawn inside gateIcon() now. Always undefined. */
export declare function gateLabel(): undefined;
/** A raw telemetry ping. Deliberately still a small dot. */
export declare function pingIcon(color: string, best?: boolean): MapSymbol;

export declare function plazaKey(s: unknown): string | null;
export declare function inr(n: number | string): string;

interface InfoCard {
  (head: string, colour: string, rows: Array<string | false | null | undefined>): string;
  esc(s: unknown): string;
}
export declare const infoCard: InfoCard;

export declare function fitTo(
  map: unknown,
  points: Array<unknown>,
  opts?: { padding?: number; maxZoom?: number; pointZoom?: number },
): boolean;

export declare function observeAndRefit(el: Element | null, fit: () => void): () => void;
