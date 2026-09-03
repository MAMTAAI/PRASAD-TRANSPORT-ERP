// @ts-nocheck
// src/components/ConnectedApps.tsx
// ─────────────────────────────────────────────────────────────────────────────
// 📡 CONNECTED APPS — who is on the system right now, and what they are doing.
//
// Reads GET /api/v1/monitoring/connected (admin-only, migration 105).
//
// WHAT THIS ANSWERS THAT LiveStaffTracker COULD NOT. That board reads
// v_user_sessions, which resolves a session to a NAME. A name is not an
// identity when the person is outside the company: a VENDOR login showed
// "AGARWAL TRADING" only because the account's full_name happened to repeat the
// firm, and a customer login could never say which customer. This one joins
// through to the party — drivers, customers, vendors — so every row says
// exactly WHO is connected, on WHICH app, and what they are carrying.
//
// IT SHOWS WHO IS *NOT* HERE, TOO, AND THAT IS THE POINT.
// An empty presence board reads as "nobody is working". The truth in this
// database is different and needs the opposite response: 54 drivers have a
// mobile number on file and can sign in today, and not one ever has. The Reach
// strip carries that number, because "nobody has been onboarded" and "everyone
// is offline right now" look identical and are not the same problem.
//
// A POSITION IS NEVER INVENTED. trip_gps_pings is written only by the driver
// app, and gpsEmitter drops the simulated NH-27 fallback rather than post it. So
// a coordinate shown here was really reported by a phone. A driver with no fix
// shows "no signal" — not the depot, not the last trip's destination.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1`;
const REFRESH_MS = 20_000;   // a presence view, not the books

const C = {
  card: '#18244a', line: '#27395f', text: '#dde5f4',
  dim: '#9aadd4', faint: '#5d7196',
  emerald: '#2fe39b', amber: '#ffb224', ruby: '#ff6b81', sky: '#22d3ee', violet: '#8b5cf6',
};

const KIND = {
  DRIVER:   { icon: '🚚', label: 'Driver',        colour: C.sky },
  CUSTOMER: { icon: '🏭', label: 'Customer',      colour: C.violet },
  PARTNER:  { icon: '🤝', label: 'Fleet Partner', colour: C.amber },
  STAFF:    { icon: '🧑‍💼', label: 'Staff',         colour: C.emerald },
  UNKNOWN:  { icon: '❓', label: 'Unknown',       colour: C.faint },
};

const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, color: C.text };

/** "just now" / "4m idle" / "2h idle" — same vocabulary as LiveStaffTracker. */
const idleLabel = (s) => {
  if (s == null) return '—';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m idle`;
  if (s < 86400) return `${Math.floor(s / 3600)}h idle`;
  return `${Math.floor(s / 86400)}d idle`;
};
const fixAge = (s) => (s == null ? null : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`);

export default function ConnectedApps() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [restricted, setRestricted] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal) => {
    try {
      const res = await fetch(`${API}/monitoring/connected`, { signal });
      // 403 is the correct answer for a non-admin, not a fault. Showing it as an
      // error card trains people to ignore error cards.
      if (res.status === 403 || res.status === 401) { setRestricted(true); setErr(null); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setData(j); setErr(null); setRestricted(false);
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    const t = setInterval(() => load(), REFRESH_MS);
    return () => { ac.abort(); clearInterval(t); };
  }, [load]);

  const parties = data?.parties ?? [];
  const totals = data?.totals ?? {};
  const ch = data?.login_channel ?? null;
  // Memoised because neverUsed derives from it: `data?.reach ?? []` builds a new
  // array every render, which would re-run that useMemo on every tick.
  const reach = useMemo(() => data?.reach ?? [], [data]);

  // People with a working way in who have never used it — the onboarding gap.
  const neverUsed = useMemo(
    () => reach.filter((r) => r.never_used > 0).sort((a, b) => b.never_used - a.never_used),
    [reach],
  );

  if (loading) {
    return <div style={{ ...card, marginBottom: 20 }}><span style={{ color: C.dim }}>Loading connected apps…</span></div>;
  }
  if (restricted) {
    return (
      <div style={{ ...card, marginBottom: 20, borderStyle: 'dashed' }}>
        <span style={{ color: C.faint, fontSize: 12.5 }}>
          📡 Connected Apps — admin only. Ye view logon ke naam, mobile number aur location dikhata hai.
        </span>
      </div>
    );
  }

  return (
    <div style={{ ...card, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>📡 Connected Apps — live</h3>
        <span style={{
          background: totals.online_now ? 'rgba(47, 227, 155,.15)' : 'rgba(100,116,139,.18)',
          color: totals.online_now ? C.emerald : C.faint,
          borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 700,
        }}>
          {totals.online_now ?? 0} online
        </span>
        {totals.tracking > 0 && (
          <span style={{ background: 'rgba(34, 211, 238,.15)', color: C.sky, borderRadius: 999,
                         padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
            {totals.tracking} tracking
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: C.faint, fontSize: 11.5 }}>
          auto-refresh {REFRESH_MS / 1000}s
        </span>
      </div>

      {err && (
        <div style={{ background: 'rgba(255, 107, 129,.12)', border: `1px solid ${C.ruby}`, color: '#fecaca',
                      borderRadius: 8, padding: '8px 12px', fontSize: 13, margin: '10px 0' }}>{err}</div>
      )}

      {/* ── who is on right now ──────────────────────────────────────────── */}
      {parties.length === 0 ? (
        <p style={{ color: C.faint, fontSize: 13, margin: '12px 0' }}>
          Abhi koi app se connected nahi hai.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
          {parties.map((p) => {
            const k = KIND[p.kind] ?? KIND.UNKNOWN;
            return (
              <div key={`${p.kind}-${p.id}-${p.since}`}
                   style={{ border: `1px solid ${C.line}`, borderLeft: `3px solid ${k.colour}`,
                            borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 17 }}>{k.icon}</span>
                  <b style={{ fontSize: 13.5 }}>{p.name}</b>
                  {p.person && <span style={{ color: C.dim, fontSize: 12 }}>({p.person})</span>}
                  <span style={{ background: 'rgba(148,163,184,.14)', color: C.dim, borderRadius: 4,
                                 padding: '1px 7px', fontSize: 10.5, fontWeight: 700 }}>
                    {p.app}
                  </span>
                  <span style={{ color: C.faint, fontSize: 11 }}>{p.device}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%',
                                   background: p.online ? C.emerald : C.faint, display: 'inline-block' }} />
                    <span style={{ color: p.online ? C.emerald : C.faint, fontSize: 11.5 }}>
                      {p.online ? 'online' : idleLabel(p.idle_seconds)}
                    </span>
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6,
                              fontSize: 11.5, color: C.faint }}>
                  {p.mobile && <span>📞 {p.mobile}</span>}
                  {p.activity && <span style={{ color: p.trip ? C.text : C.faint }}>{p.activity}</span>}
                  {p.trip?.from && <span>{p.trip.from} → {p.trip.to ?? '?'}</span>}
                  {p.kind === 'DRIVER' && (
                    p.position ? (
                      <span style={{ color: C.sky }}>
                        📍 {p.position.lat.toFixed(4)}, {p.position.lng.toFixed(4)}
                        {p.position.speed_kmh != null ? ` · ${p.position.speed_kmh} km/h` : ''}
                        {` · ${fixAge(p.position.age_seconds)}`}
                      </span>
                    ) : (
                      <span style={{ color: C.amber }}>📍 no signal</span>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── reach: who could connect and never has ───────────────────────── */}
      <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 12, marginTop: 4 }}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11.5, color: C.faint }}>
          {reach.map((r) => {
            const k = KIND[r.kind] ?? KIND.UNKNOWN;
            return (
              <span key={r.kind}>
                {k.icon} {k.label}: <b style={{ color: C.text }}>{r.ever_signed_in}</b>
                <span style={{ color: C.faint }}> / {r.can_sign_in} onboarded</span>
                <span style={{ color: C.faint }}> ({r.eligible} total)</span>
              </span>
            );
          })}
        </div>

        {/* The reason the driver app is empty, when there is one. Shown ABOVE the
            onboarding gap: if the login channel is down, onboarding is not the
            next action — re-linking WhatsApp is. */}
        {ch && !ch.ok && (
          <div style={{ background: 'rgba(255, 107, 129,.12)', border: `1px solid ${C.ruby}`,
                        borderRadius: 8, padding: '9px 12px', fontSize: 12, color: '#fecaca',
                        marginTop: 10, lineHeight: 1.6 }}>
            🚫 <b>Driver login band hai.</b> Driver OTP se login karta hai aur OTP {ch.name} se jaata hai —
            abhi wo channel down hai ({ch.reason}). Jab tak ye theek nahi hota, koi bhi driver app me
            ghus hi nahi sakta, is liye tracking bhi khaali rahega.
            {' '}<b>PRASAD PRO → Link WhatsApp</b> se QR scan karein.
          </div>
        )}

        {neverUsed.length > 0 && (
          <div style={{ background: 'rgba(255, 178, 36,.12)', border: `1px solid ${C.amber}`,
                        borderRadius: 8, padding: '9px 12px', fontSize: 12, color: '#fde68a',
                        marginTop: 10, lineHeight: 1.6 }}>
            ⚠️ {neverUsed.map((r) => `${r.never_used} ${(KIND[r.kind] ?? KIND.UNKNOWN).label.toLowerCase()}s`).join(', ')}
            {' '}ke paas login ka rasta hai lekin unhone kabhi app use nahi kiya. Isi liye tracking khaali
            dikhta hai — system band nahi hai, log abhi tak jude nahi hain.
          </div>
        )}
      </div>
    </div>
  );
}
