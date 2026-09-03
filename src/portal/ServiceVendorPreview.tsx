// @ts-nocheck
// ============================================================================
// SERVICE VENDOR PORTAL — STAFF PREVIEW
//
// The read-only "what a service vendor sees", the same way CustomerPreview
// shows the customer app: a picker over vendors of kind SERVICE (pumps, tyre
// shops, spares), the real ServiceVendorApp mounted under the staff session,
// scoped through X-View-As-Vendor — which portal.routes.js honours for
// ADMIN / SUPER_ADMIN and refuses every write on (405 VIEW_AS_READ_ONLY).
// ============================================================================
import React, { useEffect, useState, lazy, Suspense } from 'react';
import { API_BASE } from '../lib/apiBase';

const ServiceVendorApp = lazy(() => import('./ServiceVendorApp'));
export const VIEW_AS_VENDOR_KEY = 'prasad_view_as_vendor';

export default function ServiceVendorPreview({ onExit }) {
  const [vendors, setVendors] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [viewAs, setViewAs] = useState(() => {
    try { return localStorage.getItem(VIEW_AS_VENDOR_KEY) || ''; } catch { return ''; }
  });

  useEffect(() => {
    const token = localStorage.getItem('prasad_token');
    fetch(`${API_BASE}/api/v1/masters/vendors?limit=500`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`vendor list: HTTP ${r.status}`))))
      .then((j) => setVendors((j.vendors ?? []).filter((v) => (v.vendor_kind ?? 'SERVICE') === 'SERVICE')))
      .catch((e) => { setErr(e.message); setVendors([]); });
  }, []);

  const choose = (id) => {
    try { if (id) localStorage.setItem(VIEW_AS_VENDOR_KEY, id); else localStorage.removeItem(VIEW_AS_VENDOR_KEY); } catch { /* private mode */ }
    setViewAs(id);
  };
  const exit = () => { choose(''); onExit?.(); };
  const list = (vendors ?? []).filter((v) => !q || String(v.vendor_name ?? '').toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ minHeight: '100vh', background: '#0a1024', color: '#dde5f4', fontFamily: 'system-ui, sans-serif' }} /* neutral ground: the app inside is light, and near-black around it
               read as a strip in a void on a monitor (owner, 3-Sep) */>
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
                    padding: '8px 14px', background: '#0a1024', borderBottom: '1px solid #18244a', fontSize: 12 }}>
        <b style={{ fontSize: 13 }}>Service Vendor Portal — preview</b>
        <span style={{ color: '#9aadd4' }}>read-only · pumps, tyre shops, spares · bill uploads</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter vendors…"
          style={{ background: '#121c38', border: '1px solid #18244a', color: '#dde5f4', borderRadius: 8, padding: '6px 10px', fontSize: 12, width: 160 }} />
        <select value={viewAs} onChange={(e) => choose(e.target.value)}
          style={{ background: '#121c38', border: '1px solid #27395f', color: '#dde5f4', borderRadius: 8, padding: '6px 10px', fontSize: 12, maxWidth: 360 }}>
          <option value="">— choose a service vendor —</option>
          {list.map((v) => (
            <option key={v.id} value={v.id}>{v.vendor_name}{v.vendor_type ? ` · ${v.vendor_type}` : ''}{v.is_approved_for_portal ? '' : '  (portal not approved)'}</option>
          ))}
        </select>
        {vendors === null && <span style={{ color: '#9aadd4' }}>loading vendors…</span>}
        {err && <span style={{ color: '#ff8b9c' }}>{err}</span>}
        <button onClick={exit}
          style={{ marginLeft: 'auto', background: '#18244a', color: '#dde5f4', border: '1px solid #27395f', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
          Exit preview
        </button>
      </div>
      {!viewAs ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9aadd4', maxWidth: 560, margin: '0 auto', lineHeight: 1.6 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏪</div>
          <div style={{ fontSize: 15, color: '#dde5f4', fontWeight: 700 }}>Choose a service vendor above</div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            You will see the real portal a pump or a tyre shop uses to send its bills straight into the Expenses queue.
            Every button that would write is refused by the server while previewing.
          </div>
        </div>
      ) : (
        <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#9aadd4' }}>Opening the portal…</div>}>
          <ServiceVendorApp key={viewAs} />
        </Suspense>
      )}
    </div>
  );
}
