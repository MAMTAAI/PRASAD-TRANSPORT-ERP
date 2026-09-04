// Types for ./mapSymbols.mjs — the one symbol vocabulary every map in the
// system draws with. See the header there for what each symbol means.

export interface MapIcon {
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

export declare function loadingPin(scale?: number): MapIcon;
export declare function unloadingPin(scale?: number): MapIcon;
export declare function truckIcon(heading?: number, scale?: number): MapIcon;
export declare function truckLabel(vehicleNo?: string | null): MapLabel | undefined;
export declare function gateIcon(crossed: boolean, known: boolean): MapIcon;
export declare function gateLabel(rate: number | string | null | undefined): MapLabel;
export declare function pingIcon(color: string, best?: boolean): MapIcon;

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
