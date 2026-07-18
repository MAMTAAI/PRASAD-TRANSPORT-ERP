// 💰 Canonical trip money math — THE single source for Revenue/Expense/Advance
// figures. Dashboard (Finance Hub), FinancialReports, and TripManagment must
// all read trip amounts through these helpers so every screen shows the same
// number for the same trip. (Phase A "Truth Sprint": fixes the two-truths bug
// where Dashboard used Rate-before-Freight and Reports used Freight-before-Rate.)

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** First non-empty value among candidate field names, tolerant of the mixed
 *  casing in TRIPS docs (gross_freight / Gross_Freight / GROSS_FREIGHT ...). */
export function getField(obj: any, keys: string[]): any {
  if (!obj) return undefined;
  const map: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    const nk = normKey(k);
    if (!(nk in map) || map[nk] === '' || map[nk] === null || map[nk] === undefined) map[nk] = obj[k];
  }
  for (const key of keys) {
    const v = map[normKey(key)];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const num = (v: any): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Revenue for one trip. Canonical fallback order:
 *  gross_freight → total_freight → freight → rate (rate is last resort — it can
 *  be a per-unit figure on some legacy rows). */
export function getTripFreight(t: any): number {
  return round2(num(getField(t, ['gross_freight', 'total_freight', 'freight', 'rate'])));
}

/** True P&L expense for one trip: fuel value + tolls + bhatta etc.
 *  NEVER includes recoverable cash advances (driver/pump cash) — those are
 *  driver-khata assets, not expenses. Historical docs are normalized by
 *  scripts/migrate-trip-expenses.cjs; component fallback covers rows where
 *  total_expense was never written. */
export function getTripExpense(t: any): number {
  const total = num(getField(t, ['total_expense']));
  if (total > 0) return round2(total);
  return round2(
    num(getField(t, ['fuel_amount', 'hsd_amount', 'fuel_expense'])) +
    num(getField(t, ['toll_amt', 'toll_amount', 'toll_expense']))
  );
}

/** Recoverable cash-out to driver/pump for one trip (khata, not expense). */
export function getTripAdvances(t: any): number {
  const stored = getField(t, ['total_advances']);
  if (stored !== undefined) return round2(num(stored));
  return round2(
    num(getField(t, ['office_cash_paid'])) +
    num(getField(t, ['bank_paid'])) +
    num(getField(t, ['pump_cash_advance']))
  );
}

/** Trip settlement: freight − true expenses − shortage penalty. */
export function getTripSettlement(t: any, penaltyOverride?: number): number {
  const penalty = penaltyOverride !== undefined ? penaltyOverride : num(getField(t, ['shortage_penalty', 'Shortage_Penalty']));
  return round2(getTripFreight(t) - getTripExpense(t) - penalty);
}

/** Normalize any stored date shape to 'YYYY-MM-DD' for comparisons.
 *  Handles: ISO strings, DD-MM-YYYY, DD/MM/YYYY, Firestore Timestamp, Date.
 *  Returns '' when unparseable — callers must treat '' as "no date", never
 *  compare it lexically. (Fixes the lexical string-compare date filters.) */
export function toISODate(v: any): string {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (typeof v.toDate === 'function') return toISODate(v.toDate());
    if (typeof v.seconds === 'number') return toISODate(new Date(v.seconds * 1000));
    return '';
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);          // YYYY-MM-DD...
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);   // DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY (IOCL SAP bills use dots)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Inclusive range check on normalized dates. Rows with unparseable dates are
 *  INCLUDED when no bound is set, EXCLUDED when a bound exists (a filtered
 *  report must not silently absorb undateable rows). */
export function isDateInRange(dateVal: any, fromISO?: string, toISO?: string): boolean {
  const d = toISODate(dateVal);
  if (!fromISO && !toISO) return true;
  if (!d) return false;
  if (fromISO && d < fromISO) return false;
  if (toISO && d > toISO) return false;
  return true;
}
