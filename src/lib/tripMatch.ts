// 🎯 TRIP MATCHING — pure, dependency-free helpers for mapping a scanned
// document (bill / advice row) onto the right trip.
//
// These lived in postTripEngine.ts, which imports the Firestore SDK for its
// write paths. Screens that read from PostgreSQL need the matching logic and
// nothing else, so it is extracted here rather than copied — one implementation,
// no data layer attached. postTripEngine re-exports these names, so existing
// callers are unaffected.
import { getField, toISODate } from './accounting/tripMath';

export interface TripMatch {
  trip: any | null;
  confidence: 'MATCHED' | 'AMBIGUOUS' | 'NONE';
  candidates: any[];
}

export const normalizeVehicleNo = (v: any): string =>
  String(v || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

// The vision model is asked for DD-MM-YYYY but real bills come back as
// DD/MM/YY, DD.MM.YYYY (IOCL SAP), YYYY-MM-DD, or with a month>12 swap.
// Returns 'YYYY-MM-DD' or '' — never a guess that silently shifts a month.
export function parseDocDate(raw: any): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const parts = s.match(/\d+/g);
  if (parts && parts.length >= 3) {
    const [a, b] = parts;
    let c = parts[2];
    // 2-digit year → 20xx (bills are never from the 1900s here)
    if (a.length <= 2 && b.length <= 2 && c.length === 2) c = `20${c}`;
    if (c.length === 4) {                       // DD-MM-YYYY family
      let d = parseInt(a, 10), m = parseInt(b, 10);
      if (m > 12 && d <= 12) [d, m] = [m, d];   // model swapped day/month
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12)
        return `${c}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (a.length === 4) {                       // YYYY-MM-DD family
      let m = parseInt(b, 10), d = parseInt(c, 10);
      if (m > 12 && d <= 12) [m, d] = [d, m];
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12)
        return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    // Numeric shape but impossible day/month (e.g. 32-13-2026): refuse rather
    // than let a lenient fallback fabricate a corrupt date.
    return '';
  }
  return toISODate(s);
}

/** Match a bill (vehicle + date) to the right trip. The same vehicle runs many
 *  trips; the bill date must sit inside loading→unloading (+graceDays for bills
 *  raised a few days after unloading). Falls back to the nearest trip by loading
 *  date when nothing brackets the date. */
export function matchTripForBill(trips: any[], billVehicle: any, billDateISO: string, graceDays = 5): TripMatch {
  const veh = normalizeVehicleNo(billVehicle);
  if (!veh) return { trip: null, confidence: 'NONE', candidates: [] };
  const vehicleTrips = trips.filter((t) =>
    normalizeVehicleNo(getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no'])) === veh);
  if (!vehicleTrips.length) return { trip: null, confidence: 'NONE', candidates: [] };
  if (!billDateISO) {
    return vehicleTrips.length === 1
      ? { trip: vehicleTrips[0], confidence: 'MATCHED', candidates: vehicleTrips }
      : { trip: null, confidence: 'AMBIGUOUS', candidates: vehicleTrips };
  }
  const billT = new Date(billDateISO).getTime();
  const grace = graceDays * 86400000;
  const inWindow = vehicleTrips.filter((t) => {
    const ld = toISODate(getField(t, ['loading_date', 'Loading_Date', 'start_date', 'date']));
    const ud = toISODate(getField(t, ['unloading_date', 'Unloading_Date']));
    const from = ld ? new Date(ld).getTime() - grace : -Infinity;
    const to = ud ? new Date(ud).getTime() + grace : Infinity;
    return billT >= from && billT <= to;
  });
  if (inWindow.length === 1) return { trip: inWindow[0], confidence: 'MATCHED', candidates: inWindow };
  if (inWindow.length > 1) {
    // Prefer the trip whose loading date is closest to the bill date.
    const scored = [...inWindow].sort((a, b) => {
      const da = Math.abs(billT - new Date(toISODate(getField(a, ['loading_date', 'Loading_Date', 'start_date', 'date'])) || billDateISO).getTime());
      const dbb = Math.abs(billT - new Date(toISODate(getField(b, ['loading_date', 'Loading_Date', 'start_date', 'date'])) || billDateISO).getTime());
      return da - dbb;
    });
    return { trip: scored[0], confidence: 'AMBIGUOUS', candidates: scored };
  }
  return { trip: null, confidence: 'NONE', candidates: vehicleTrips };
}
