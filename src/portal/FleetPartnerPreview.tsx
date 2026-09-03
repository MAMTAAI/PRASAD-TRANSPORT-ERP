// @ts-nocheck
// ============================================================================
// FLEET PARTNER PORTAL — STAFF PREVIEW
//
// Until 2026-09-02 "View As → Vendor Portal" opened FleetPartnerPortal.tsx,
// the legacy pre-login screen with a hardcoded KYC form. This mounts the REAL
// signed-in partner app (FleetPartnerApp.tsx) under the staff session,
// scoped to one FLEET_PARTNER vendor through X-View-As-Vendor — read-only,
// every write refused by the server (405 VIEW_AS_READ_ONLY).
// ============================================================================
import React, { useEffect, useState, lazy, Suspense } from 'react';
import { API_BASE } from '../lib/apiBase';

const FleetPartnerApp = lazy(() => import('./FleetPartnerApp'));
const KEY = 'prasad_view_as_vendor';

export default function FleetPartnerPreview({ onExit }) {
  const [vendors, setVendors] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [viewAs, setViewAs] = useState(() => {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  });

  useEffect(() => {
    const token = localStorage.getItem('prasad_token');
    fetch(`${API_BASE}/api/v1/masters/vendors?limit=500`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`vendor list: HTTP ${r.status}`))))
      .then((j) => setVendors((j.vendors ?? []).filter((v) => v.vendor_kind === 'FLEET_PARTNER')))
      .catch((e) => { setErr(e.message); setVendors([]); });
  }, []);

  const choose = (id) => {
    try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private mode */ }
    setViewAs(id);
  };
  const exit = () => { choose(''); onExit?.(); };
  const list = (vendors ?? []).filter((v) => !q || String(v.vendor_name ?? '').toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ minHeight: '100vh', background: '#dfe3ea', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' }} /* neutral ground: the app inside is light, and near-black around it
               read as a strip in a void on a monitor (owner, 3-Sep) */>
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
                    padding: '8px 14px', background: '#0b1220', borderBottom: '1px solid #1e293b', fontSize: 12 }}>
        <b style={{ fontSize: 13 }}>Fleet Partner Portal — preview</b>
        <span style={{ color: '#94a3b8' }}>read-only · the real partner app: load feed, bids, trips, fleet, earnings</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter partners…"
          style={{ background: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0', borderRadius: 8, padding: '6px 10px', fontSize: 12, width: 160 }} />
        <select value={viewAs} onChange={(e) => choose(e.target.value)}
          style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 8, padding: '6px 10px', fontSize: 12, maxWidth: 360 }}>
          <option value="">— choose a fleet partner —</option>
          {list.map((v) => (
            <option key={v.id} value={v.id}>{v.vendor_name}{v.is_approved_for_portal ? '' : '  (portal not approved)'}</option>
          ))}
        </select>
        {vendors === null && <span style={{ color: '#94a3b8' }}>loading partners…</span>}
        {vendors !== null && vendors.length === 0 && !err && (
          <span style={{ color: '#fbbf24' }}>no fleet partner exists yet — one appears when a bazaar KYC is approved or a partner is set up under Market Vehicles</span>
        )}
        {err && <span style={{ color: '#f87171' }}>{err}</span>}
        <button onClick={exit}
          style={{ marginLeft: 'auto', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
          Exit preview
        </button>
      </div>
      {!viewAs ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: '#94a3b8', maxWidth: 560, margin: '0 auto', lineHeight: 1.6 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🚚</div>
          <div style={{ fontSize: 15, color: '#e2e8f0', fontWeight: 700 }}>Choose a fleet partner above</div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            You will see the real partner app — blind bidding, Book-Now, My Trips, fleet and driver registration, earnings —
            scoped to that partner. Every button that would write is refused by the server while previewing.
          </div>
        </div>
      ) : (
        <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>Opening the app…</div>}>
          <FleetPartnerApp key={viewAs} />
        </Suspense>
      )}
    </div>
  );
}
