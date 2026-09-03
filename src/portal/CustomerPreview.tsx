// @ts-nocheck
// ============================================================================
// CUSTOMER APP — STAFF PREVIEW
//
// "What a customer sees", for real. Until 2026-09-02 the Preview Portal menu
// opened the legacy CustomerPortal.tsx — hardcoded numbers, dead buttons —
// while the actual signed-in app (CustomerApp.tsx) was only reachable with a
// customer login. This wrapper mounts the real app under a staff session,
// scoped to one customer through the X-View-As-Customer header that
// server/modules/portal.routes.js honours for ADMIN / SUPER_ADMIN, read-only:
// every write is refused by the server (405 VIEW_AS_READ_ONLY), so nothing
// can be posted, accepted or uploaded in a customer's name from here.
//
// The chosen customer lives in localStorage under prasad_view_as_customer;
// CustomerApp's api() helper adds the header when that key is present and
// the wrapper clears it on exit, so a staff tab cannot keep speaking as a
// customer by accident.
// ============================================================================
import React, { useEffect, useState, lazy, Suspense } from 'react';
import { API_BASE } from '../lib/apiBase';

const CustomerApp = lazy(() => import('./CustomerApp'));
export const VIEW_AS_KEY = 'prasad_view_as_customer';

export default function CustomerPreview({ onExit }) {
  const [parties, setParties] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [viewAs, setViewAs] = useState(() => {
    try { return localStorage.getItem(VIEW_AS_KEY) || ''; } catch { return ''; }
  });

  useEffect(() => {
    const token = localStorage.getItem('prasad_token');
    fetch(`${API_BASE}/api/v1/masters/customers?limit=500`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`customers list: HTTP ${r.status}`))))
      .then((j) => setParties(j.customers ?? []))
      .catch((e) => { setErr(e.message); setParties([]); });
  }, []);

  const choose = (id) => {
    try { if (id) localStorage.setItem(VIEW_AS_KEY, id); else localStorage.removeItem(VIEW_AS_KEY); } catch { /* private mode */ }
    setViewAs(id);
  };
  const exit = () => { choose(''); onExit?.(); };

  const list = (parties ?? []).filter((c) => !q || String(c.customer_name ?? '').toLowerCase().includes(q.toLowerCase()));
  const current = (parties ?? []).find((c) => c.id === viewAs);

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(rgba(154,173,212,0.07) 1px, transparent 1px) 0 0/22px 22px, radial-gradient(1100px 700px at 50% 0%, rgba(34,211,238,0.06) 0%, transparent 60%), #05070e', color: '#dde5f4', fontFamily: 'system-ui, sans-serif' }} /* THE DESK, not the app. The app column is navy with its own frame, so
                 this has to sit a step BELOW it: same tone on both sides and the
                 app reads as a strip in a void on a monitor, which is the owner's
                 3-Sep complaint. It used to be a light grey because the app used
                 to be light; both went dark on 3-Sep and only one of them was
                 re-thought. Keep them one step apart. old comment: near-black around it
               read as a strip in a void on a monitor (owner, 3-Sep) */>
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
                    padding: '8px 14px', background: '#0a1024', borderBottom: '1px solid #18244a', fontSize: 12 }}>
        <b style={{ fontSize: 13 }}>Customer App — preview</b>
        <span style={{ color: '#9aadd4' }}>read-only · the real signed-in app, as this customer sees it</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter customers…"
          style={{ background: '#121c38', border: '1px solid #18244a', color: '#dde5f4', borderRadius: 8, padding: '6px 10px', fontSize: 12, width: 160 }} />
        <select value={viewAs} onChange={(e) => choose(e.target.value)}
          style={{ background: '#121c38', border: '1px solid #27395f', color: '#dde5f4', borderRadius: 8, padding: '6px 10px', fontSize: 12, maxWidth: 360 }}>
          <option value="">— choose a customer —</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.customer_name}{c.is_approved_for_portal ? '' : '  (portal not approved)'}
            </option>
          ))}
        </select>
        {parties === null && <span style={{ color: '#9aadd4' }}>loading customers…</span>}
        {err && <span style={{ color: '#ff8b9c' }}>{err}</span>}
        {current && !current.is_approved_for_portal && (
          <span style={{ color: '#ffc03d' }}>not portal-approved: a customer login would be refused; staff preview still shows the app</span>
        )}
        <button onClick={exit}
          style={{ marginLeft: 'auto', background: '#18244a', color: '#dde5f4', border: '1px solid #27395f', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
          Exit preview
        </button>
      </div>

      {!viewAs ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9aadd4', maxWidth: 560, margin: '0 auto', lineHeight: 1.6 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏢</div>
          <div style={{ fontSize: 15, color: '#dde5f4', fontWeight: 700 }}>Choose a customer above</div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            You will see the real Customer App — loads, bids, shipment tracker, bills — scoped to that party.
            Any button that would write is refused by the server while previewing.
          </div>
        </div>
      ) : (
        <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#9aadd4' }}>Opening the app…</div>}>
          {/* key = party id: choosing another customer remounts the app cleanly */}
          <CustomerApp key={viewAs} />
        </Suspense>
      )}
    </div>
  );
}
