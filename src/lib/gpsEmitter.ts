// 🛰️ GPS emitter — the driver device's fixes, persisted.
//
// THE GAP THIS CLOSES. useGeoPolling has always produced a fix every 5s and
// handed it to useLiveTracking, which broadcasts it onto an in-memory bus that
// dies with the tab. POST /api/v1/tracking/ping and trip_gps_pings have existed
// the whole time and the table has zero rows — the dispatch board reads real
// trips and finds no position for any of them, because nothing was ever written.
// This is the missing wire between the emitter and the store.
//
// SIMULATED FIXES ARE NEVER POSTED. useGeoPolling falls back to a synthetic
// NH-27 drift when the device denies location, so the driver screen still moves
// on a desktop preview. That fallback is a UI convenience; writing it to
// trip_gps_pings would put invented coordinates into the table dispatch trusts,
// permanently and indistinguishably from real ones. `simulated` fixes are
// dropped here, and the caller is told they were.
import { API_BASE } from './apiBase';

export interface GpsFix {
  lat: number;
  lng: number;
  speedKmh?: number | null;
  accuracy?: number | null;
  at?: number;
  simulated?: boolean;
}

export type EmitResult =
  | { posted: true }
  | { posted: false; reason: 'simulated' | 'no-trip' | 'not-moving' | 'throttled' | 'error'; detail?: string };

// The device polls every 5s; the server does not need more than that, and a
// retry storm on a flaky truck connection should not become a write storm.
const MIN_INTERVAL_MS = 4500;

const lastSentAt = new Map<string, number>();

/** Post one real fix for a trip. Never throws — a failed ping must not break
 *  the duty screen the driver is working from. */
export async function emitGpsFix(tripId: string | null | undefined, fix: GpsFix): Promise<EmitResult> {
  if (!tripId) return { posted: false, reason: 'no-trip' };
  if (fix?.simulated) return { posted: false, reason: 'simulated' };
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lng)) {
    return { posted: false, reason: 'error', detail: 'fix has no coordinates' };
  }

  const now = Date.now();
  const last = lastSentAt.get(tripId) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return { posted: false, reason: 'throttled' };
  lastSentAt.set(tripId, now);

  try {
    const token = localStorage.getItem('prasad_token');
    const res = await fetch(`${API_BASE}/api/v1/tracking/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // keepalive: a driver locking the phone mid-post should still land the fix.
      keepalive: true,
      body: JSON.stringify({
        trip_id: tripId,
        source: 'DRIVER_APP',
        lat: Number(fix.lat),
        lng: Number(fix.lng),
        // The endpoint's schema rejects unknown/!null-typed fields, so send
        // explicit nulls rather than omitting or sending undefined.
        speed_kmh: Number.isFinite(fix.speedKmh as number) ? Number(fix.speedKmh) : null,
        accuracy_m: Number.isFinite(fix.accuracy as number) ? Number(fix.accuracy) : null,
        recorded_at: new Date(fix.at ?? now).toISOString(),
      }),
    });

    if (res.status === 201) return { posted: true };
    // 422 = the trip is settled/cancelled. That is the server correctly
    // refusing a stale device, not an error to retry — stop pinging for it.
    if (res.status === 422) return { posted: false, reason: 'not-moving' };
    if (res.status === 404) return { posted: false, reason: 'no-trip' };
    return { posted: false, reason: 'error', detail: `HTTP ${res.status}` };
  } catch (e: any) {
    // Out of coverage. The next poll in 5s tries again; nothing is queued,
    // because a stale position delivered later is worse than a gap.
    return { posted: false, reason: 'error', detail: e?.message ?? 'network' };
  }
}
