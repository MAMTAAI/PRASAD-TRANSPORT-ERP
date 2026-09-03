// @ts-nocheck
// 🪪 KYC APPROVALS — the admin review queue for portal onboarding submissions.
// Phase A made portal KYC real (validated onboarding applications); this screen
// is where staff finally SEE and action them: auto-checks re-run on every
// application, Approve creates the canonical customers/vendors master and then
// stamps the application, Reject requires a reason the applicant can fix.
//
// No auto-ledger: TARA opens the party account on the first real posting, so an
// approval no longer leaves two empty ledgers behind (migration 026).
import React, { useState, useEffect } from 'react';
import { API_BASE } from './lib/apiBase';
const MASTERS_API = API_BASE + '/api/v1/masters';
const BAZAAR_API = API_BASE + '/api/v1/bazaar';
const mastersFetch = async (path: string, opts?: RequestInit) => {
  const res = await fetch(`${MASTERS_API}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
const bazaarFetch = async (path: string, opts?: RequestInit) => {
  // /bazaar is admin-guarded now — those routes hand out competitors' bid
  // amounts and the office's target rate, readable by any vendor token while
  // they were open. This screen carries the admin session.
  const token = localStorage.getItem('prasad_token');
  const res = await fetch(`${BAZAAR_API}${path}`, {
    ...opts,
    headers: { ...(opts?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

import { vGstin, vPan, vMobile, vIfsc, vAccountNo, gstinPanMatch, runChecks } from './lib/validators';
import { logAudit } from './lib/audit';
import { useIsMobile } from './hooks/useIsMobile';

// The waiting state is PENDING_KYC since migration 134 (the owner's name for
// it, 3-Sep). SUBMITTED is kept so a row written before the deploy still paints.
const WAITING = 'PENDING_KYC';
const isWaiting = (st) => st === 'PENDING_KYC' || st === 'SUBMITTED' || !st;
const STATUS_META = {
  PENDING_KYC: { label: '📨 Pending KYC', color: '#f59e0b' },
  SUBMITTED: { label: '📨 Pending KYC', color: '#f59e0b' },
  APPROVED: { label: '✅ Approved', color: '#10b981' },
  REJECTED: { label: '❌ Rejected', color: '#ef4444' },
};

export default function KycApprovals() {
  const { isMobile } = useIsMobile();
  const [apps, setApps] = useState([]);
  const [filter, setFilter] = useState(WAITING);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  // The second queue on this desk (migration 134): a LIVE customer asking to
  // change the bank account already on its master. Same screen because it is
  // the same job — a human comparing a claimed account with the one on file.
  const [bankReqs, setBankReqs] = useState([]);

  // Firestore's onSnapshot pushed changes; PostgreSQL has no browser socket
  // here, so the queue refreshes on mount, after every decision, and on a slow
  // interval while the tab is visible. A KYC queue is reviewed in minutes, not
  // milliseconds — polling at 30s costs one small query and avoids standing up
  // a websocket for one screen.
  const loadApps = async () => {
    try {
      const { applications } = await bazaarFetch('/onboarding');   // already newest-first
      setApps(applications ?? []);
    } catch (e) { console.error(e); }
  };

  const loadBankReqs = async () => {
    try { setBankReqs((await bazaarFetch('/bank-changes?status=PENDING')).requests ?? []); }
    catch (e) { console.error(e); }
  };

  const refreshAll = () => { loadApps(); loadBankReqs(); };

  useEffect(() => {
    refreshAll();
    const t = setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 30000);
    return () => clearInterval(t);
  }, []);

  const decideBank = async (r, ok) => {
    if (busy) return;
    let reason = '';
    if (!ok) {
      reason = (window.prompt(`❌ "${r.party_name}" ka bank change kyun reject kar rahe hain? (customer ko yahi dikhega)`) || '').trim();
      if (!reason) return;
    } else if (!window.confirm(`✅ "${r.party_name}" ka bank account badal kar
${r.bank_name} · ${r.account_no} · ${r.ifsc_code}
kar dein? Yeh master par turant lag jayega.`)) return;
    setBusy(true);
    try {
      await bazaarFetch(`/bank-changes/${r.id}/${ok ? 'approve' : 'reject'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ok ? {} : { reason }),
      });
      logAudit({ action: ok ? 'BANK_CHANGE_APPROVE' : 'BANK_CHANGE_REJECT', target: r.party_name,
                 details: ok ? `${r.bank_name} ${r.account_no} ${r.ifsc_code}` : reason });
      await loadBankReqs();
    } catch (e) { alert('❌ ' + e.message); }
    setBusy(false);
  };

  const checksFor = (a) => {
    const list = [
      { name: 'Mobile format', c: vMobile(a.mobile_no, true) },
      { name: 'GSTIN format', c: vGstin(a.gst_no, a.type === 'CUSTOMER') },
      { name: 'PAN format', c: vPan(a.pan_no, a.type === 'FLEET_PARTNER') },
      { name: 'GSTIN ↔ PAN match', c: gstinPanMatch(a.gst_no, a.pan_no) },
    ];
    // The bank account is only asked of a customer (migration 134), so the
    // fleet-partner queue is not suddenly shown three checks it must fail.
    if (a.type === 'CUSTOMER') {
      list.push({ name: 'IFSC format', c: vIfsc(a.ifsc_code, true) });
      list.push({ name: 'Account number', c: vAccountNo(a.account_no, true) });
    }
    return list.map(x => ({ name: x.name, ok: x.c.ok, msg: x.c.message }));
  };

  const approve = async (a) => {
    if (busy) return;
    const name = a.type === 'CUSTOMER' ? a.corporate_name : a.agency_name;
    if (!window.confirm(`✅ "${name}" ko approve karke ${a.type === 'CUSTOMER' ? 'CUSTOMER' : 'VENDOR (Fleet Partner)'} master banayein?`)) return;
    setBusy(true);
    try {
      const user = JSON.parse(localStorage.getItem('prasad_user') || '{}');

      // The approved master goes to PostgreSQL — that is where Customer Master
      // and Vendor Master read from now, so a Firestore record here would
      // approve an applicant into a table nobody looks at. A customer
      // approved from the portal is created as customer_source = 'PORTAL',
      // which is exactly what the External B2B tab lists.
      //
      // The auto-LEDGERS rows are gone: TARA opens the party account on the
      // first real posting, so an approval no longer leaves two empty ledgers.
      let masterId = '';
      if (a.type === 'CUSTOMER') {
        const j = await mastersFetch('/customers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_name: (a.corporate_name || '').toUpperCase(),
            gst_no: a.gst_no || null,
            pan_no: a.pan_no || null,
            mobile_no: a.mobile_no || '',
            address: a.address || '',
            contact_person: a.contact_person || '',
            email: a.email || null,
            // migration 134 — the account the applicant gave on the form. If
            // it did not land here, an approved customer would arrive on the
            // master with no bank details and the office would have to chase
            // the applicant for something they already sent.
            bank_name: a.bank_name || null,
            account_no: a.account_no || null,
            ifsc_code: a.ifsc_code || null,
            status: 'ACTIVE',
            customer_source: 'PORTAL',
            approval_status: 'APPROVED',
            portal_enabled: true,
          }),
        });
        masterId = j.customer?.id || '';
      } else {
        const j = await mastersFetch('/vendors', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendor_name: a.agency_name || '',
            vendor_type: 'FLEET PARTNER',
            contact_person: a.owner_name || '',
            mobile_no: a.mobile_no || '',
            gst_no: a.gst_no || null,
            opening_balance: 0,
            status: 'ACTIVE',
          }),
        });
        masterId = j.vendor?.id || '';
      }

      // The endpoint refuses an application that is already decided (409), so a
      // double-click cannot create a second master for the same applicant.
      await bazaarFetch(`/onboarding/${a.id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master_id: masterId, approved_by: user.full_name || user.email || 'admin' }),
      });
      await loadApps();
      logAudit({ action: 'KYC_APPROVE', target: name, details: `${a.type} approved → master ${masterId}` });
      alert(`✅ ${name} approved — ${a.type === 'CUSTOMER' ? 'Customer' : 'Vendor'} Master me ban gaya.`);
    } catch (e) { console.error(e); alert('❌ Approve fail: ' + (e.message || 'error')); }
    setBusy(false);
  };

  const reject = async (a) => {
    if (busy) return;
    const reason = window.prompt('❌ Reject reason (applicant ko dikhega):', 'Documents/details unclear — please re-submit');
    if (!reason) return;
    setBusy(true);
    try {
      const user = JSON.parse(localStorage.getItem('prasad_user') || '{}');
      await bazaarFetch(`/onboarding/${a.id}/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, rejected_by: user.full_name || user.email || 'admin' }),
      });
      await loadApps();
      logAudit({ action: 'KYC_REJECT', target: a.corporate_name || a.agency_name, details: reason });
    } catch (e) { console.error(e); alert('❌ Reject fail: ' + (e.message || 'error')); }
    setBusy(false);
  };

  const shown = apps.filter(a => filter === 'ALL' || (filter === WAITING ? isWaiting(a.status) : a.status === filter));
  const S = {
    page: { padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif" },
    card: { background: 'rgba(30,41,59,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: 'clamp(14px,3vw,22px)', marginBottom: '14px' },
    chip: (c) => ({ background: c + '22', color: c, border: `1px solid ${c}`, borderRadius: '999px', padding: '4px 12px', fontSize: '12px', fontWeight: 'bold', whiteSpace: 'nowrap' }),
    btn: (bg, dis) => ({ background: dis ? '#475569' : bg, color: 'white', border: 'none', borderRadius: '10px', padding: '12px 18px', fontWeight: 'bold', cursor: dis ? 'default' : 'pointer', minHeight: '46px' }),
  };

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: '0 0 4px 0', color: '#38bdf8' }}>🪪 KYC Approvals</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 16px 0', fontSize: '13px' }}>Portal se aayi customer/fleet-partner applications — approve par master + ledger apne aap banta hai. Live updates.</p>

      {bankReqs.length > 0 && (
        <div style={{ ...S.card, borderLeft: '4px solid #a855f7' }}>
          <b style={{ fontSize: '15px' }}>🏦 Bank account change requests ({bankReqs.length})</b>
          <div style={{ color: '#94a3b8', fontSize: '12px', margin: '4px 0 12px 0' }}>
            Live customers ne apne app se bheja hai. Approve karte hi master par lag jayega — pehle account verify karein.
          </div>
          {bankReqs.map(r => (
            <div key={r.id} style={{ borderTop: '1px solid #1e293b', paddingTop: '10px', marginTop: '10px' }}>
              <b style={{ fontSize: '14px' }}>🏢 {r.party_name || '—'}</b>
              <span style={{ color: '#64748b', fontSize: '12px' }}> · {r.party_code || ''} · 📱 {r.party_mobile || '—'}</span>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '4px 20px', fontSize: '13px', marginTop: '6px' }}>
                <div><span style={{ color: '#64748b' }}>New:</span> <b style={{ fontFamily: 'monospace' }}>{r.bank_name} · {r.account_no} · {r.ifsc_code}</b></div>
                <div><span style={{ color: '#64748b' }}>Old:</span> <span style={{ fontFamily: 'monospace' }}>{r.prev_account_no ? `${r.prev_bank_name || ''} · ${r.prev_account_no} · ${r.prev_ifsc_code || ''}` : 'kuch darj nahi tha'}</span></div>
                {r.note ? <div style={{ gridColumn: '1 / -1', color: '#94a3b8' }}>Note: {r.note}</div> : null}
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
                <button onClick={() => decideBank(r, true)} disabled={busy} style={S.btn('#10b981', busy)}>✅ Approve &amp; update master</button>
                <button onClick={() => decideBank(r, false)} disabled={busy} style={S.btn('#ef4444', busy)}>❌ Reject (reason ke saath)</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[WAITING, 'APPROVED', 'REJECTED', 'ALL'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ ...S.btn(filter === f ? '#2563eb' : '#1e293b', false), padding: '9px 16px', minHeight: '40px', fontSize: '13px' }}>
            {f === WAITING ? `📨 Pending KYC (${apps.filter(a => isWaiting(a.status)).length})` : f}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', color: '#64748b', padding: '40px' }}>
          {filter === WAITING ? '✨ Koi pending application nahi. Portal se submissions yahan live aayengi.' : 'Kuch nahi mila.'}
        </div>
      ) : shown.map(a => {
        const name = a.type === 'CUSTOMER' ? a.corporate_name : a.agency_name;
        const st = STATUS_META[a.status || WAITING] || STATUS_META[WAITING];
        const checks = checksFor(a);
        const passed = checks.filter(c => c.ok).length;
        const open = openId === a.id;
        return (
          <div key={a.id} style={{ ...S.card, borderLeft: `4px solid ${st.color}` }}>
            <div onClick={() => setOpenId(open ? null : a.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', cursor: 'pointer', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: '15px' }}>{a.type === 'CUSTOMER' ? '🏢' : '🚛'} {name || '—'}</b>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
                  {a.type === 'CUSTOMER' ? 'Customer' : 'Fleet Partner'} · 📱 {a.mobile_no || '—'} · Checks: <span style={{ color: passed === checks.length ? '#10b981' : '#f59e0b', fontWeight: 'bold' }}>{passed}/{checks.length}</span>
                </div>
              </div>
              <span style={S.chip(st.color)}>{st.label}</span>
            </div>

            {open && (
              <div style={{ marginTop: '14px', borderTop: '1px solid #1e293b', paddingTop: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '6px 20px', fontSize: '13px' }}>
                  {a.gst_no ? <div><span style={{ color: '#64748b' }}>GSTIN:</span> <b>{a.gst_no}</b></div> : null}
                  {a.pan_no ? <div><span style={{ color: '#64748b' }}>PAN:</span> <b>{a.pan_no}</b></div> : null}
                  {a.owner_name ? <div><span style={{ color: '#64748b' }}>Owner:</span> {a.owner_name}</div> : null}
                  {a.contact_person ? <div><span style={{ color: '#64748b' }}>Contact:</span> {a.contact_person}</div> : null}
                  {a.address ? <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#64748b' }}>Address:</span> {a.address}</div> : null}
                  {a.aadhaar_last4 ? <div><span style={{ color: '#64748b' }}>Aadhaar:</span> XXXX-XXXX-{a.aadhaar_last4}</div> : null}
                  {a.email ? <div><span style={{ color: '#64748b' }}>Email:</span> {a.email}</div> : null}
                  {/* The bank account the applicant gave (migration 134) — the
                      thing the desk is being asked to verify, so it is shown in
                      full rather than masked. */}
                  {a.bank_name ? <div><span style={{ color: '#64748b' }}>Bank:</span> <b>{a.bank_name}</b></div> : null}
                  {a.account_no ? <div><span style={{ color: '#64748b' }}>A/c:</span> <b style={{ fontFamily: 'monospace' }}>{a.account_no}</b></div> : null}
                  {a.ifsc_code ? <div><span style={{ color: '#64748b' }}>IFSC:</span> <b style={{ fontFamily: 'monospace' }}>{a.ifsc_code}</b></div> : null}
                  {a.reject_reason ? <div style={{ gridColumn: '1 / -1', color: '#ef4444' }}>Reject reason: {a.reject_reason}</div> : null}
                </div>
                <div style={{ marginTop: '10px' }}>
                  {checks.map((c, i) => (
                    <div key={i} style={{ fontSize: '12px', color: c.ok ? '#10b981' : '#ef4444', padding: '2px 0' }}>
                      {c.ok ? '✔' : '✖'} {c.name}{!c.ok && c.msg ? ` — ${c.msg}` : ''}
                    </div>
                  ))}
                </div>
                {isWaiting(a.status) && (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexWrap: 'wrap' }}>
                    <button onClick={() => approve(a)} disabled={busy} style={{ ...S.btn('#10b981', busy), flex: isMobile ? 1 : 'none' }}>✅ Approve → Master + Ledger</button>
                    <button onClick={() => reject(a)} disabled={busy} style={{ ...S.btn('#ef4444', busy), flex: isMobile ? 1 : 'none' }}>❌ Reject (reason ke saath)</button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
