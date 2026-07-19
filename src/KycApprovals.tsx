// @ts-nocheck
// 🪪 KYC APPROVALS — the admin review queue for portal onboarding submissions.
// Phase A made portal KYC real (validated ONBOARDING_APPLICATIONS docs);
// this screen is where staff finally SEE and action them: auto-checks re-run
// on every application, Approve creates the canonical CUSTOMERS/VENDORS master
// + auto-ledger in one batch, Reject requires a reason the applicant can fix.
import React, { useState, useEffect } from 'react';
import { collection, onSnapshot, doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { vGstin, vPan, vMobile, gstinPanMatch, runChecks } from './lib/validators';
import { logAudit } from './lib/audit';
import { useIsMobile } from './hooks/useIsMobile';

const STATUS_META = {
  SUBMITTED: { label: '📨 Pending Review', color: '#f59e0b' },
  APPROVED: { label: '✅ Approved', color: '#10b981' },
  REJECTED: { label: '❌ Rejected', color: '#ef4444' },
};

export default function KycApprovals() {
  const { isMobile } = useIsMobile();
  const [apps, setApps] = useState([]);
  const [filter, setFilter] = useState('SUBMITTED');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'ONBOARDING_APPLICATIONS'), snap => {
      setApps(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(b.submitted_at?.seconds || '').toString().localeCompare(String(a.submitted_at?.seconds || ''))));
    }, e => console.error(e));
    return () => unsub();
  }, []);

  const checksFor = (a) => {
    const list = [
      { name: 'Mobile format', c: vMobile(a.mobile_no, true) },
      { name: 'GSTIN format', c: vGstin(a.gst_no, a.type === 'CUSTOMER') },
      { name: 'PAN format', c: vPan(a.pan_no, a.type === 'FLEET_PARTNER') },
      { name: 'GSTIN ↔ PAN match', c: gstinPanMatch(a.gst_no, a.pan_no) },
    ];
    return list.map(x => ({ name: x.name, ok: x.c.ok, msg: x.c.message }));
  };

  const approve = async (a) => {
    if (busy) return;
    const name = a.type === 'CUSTOMER' ? a.corporate_name : a.agency_name;
    if (!window.confirm(`✅ "${name}" ko approve karke ${a.type === 'CUSTOMER' ? 'CUSTOMER' : 'VENDOR (Fleet Partner)'} master + ledger banayein?`)) return;
    setBusy(true);
    try {
      const user = JSON.parse(localStorage.getItem('prasad_user') || '{}');
      const batch = writeBatch(db);
      const masterRef = doc(collection(db, a.type === 'CUSTOMER' ? 'CUSTOMERS' : 'VENDORS'));
      if (a.type === 'CUSTOMER') {
        batch.set(masterRef, {
          customer_name: (a.corporate_name || '').toUpperCase(), gst_no: a.gst_no || '', pan_no: a.pan_no || '',
          mobile_no: a.mobile_no || '', address: a.address || '', contact_person: a.contact_person || '',
          status: 'ACTIVE', portal_access: true, source: 'PORTAL_KYC', application_id: a.id, createdAt: serverTimestamp(),
        });
        batch.set(doc(collection(db, 'LEDGERS')), {
          ledger_name: (a.corporate_name || '').toUpperCase(), group: 'Sundry Debtors', group_head: 'Sundry Debtors',
          opening_balance: 0, current_balance: 0, creation_type: 'AUTO_SYSTEM', linked_module: 'CUSTOMER',
          linked_id: masterRef.id, created_at: serverTimestamp(),
        });
      } else {
        batch.set(masterRef, {
          vendor_name: a.agency_name || '', vendor_type: 'FLEET PARTNER', contact_person: a.owner_name || '',
          mobile_no: a.mobile_no || '', gst_no: a.gst_no || '', pan_no: a.pan_no || '',
          aadhaar_last4: a.aadhaar_last4 || '', status: 'Active', opening_balance: 0, current_balance: 0,
          source: 'PORTAL_KYC', application_id: a.id, createdAt: serverTimestamp(),
        });
        batch.set(doc(collection(db, 'LEDGERS')), {
          ledger_name: a.agency_name || '', group: 'Sundry Creditors (Vendors)', group_head: 'Sundry Creditors (Vendors)',
          op_balance: 0, dr_cr: 'Cr (Credit)', creation_type: 'AUTO_SYSTEM', linked_module: 'VENDOR',
          linked_id: masterRef.id, created_at: serverTimestamp(),
        });
      }
      batch.update(doc(db, 'ONBOARDING_APPLICATIONS', a.id), {
        status: 'APPROVED', approved_at: serverTimestamp(), approved_by: user.full_name || user.email || 'admin', master_id: masterRef.id,
      });
      await batch.commit();
      logAudit({ action: 'KYC_APPROVE', target: name, details: `${a.type} approved → master ${masterRef.id}` });
      alert(`✅ ${name} approved — master + ledger ban gaye.`);
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
      const batch = writeBatch(db);
      batch.update(doc(db, 'ONBOARDING_APPLICATIONS', a.id), {
        status: 'REJECTED', reject_reason: reason, rejected_at: serverTimestamp(), rejected_by: user.full_name || user.email || 'admin',
      });
      await batch.commit();
      logAudit({ action: 'KYC_REJECT', target: a.corporate_name || a.agency_name, details: reason });
    } catch (e) { console.error(e); alert('❌ Reject fail: ' + (e.message || 'error')); }
    setBusy(false);
  };

  const shown = apps.filter(a => filter === 'ALL' || (a.status || 'SUBMITTED') === filter);
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

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {['SUBMITTED', 'APPROVED', 'REJECTED', 'ALL'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ ...S.btn(filter === f ? '#2563eb' : '#1e293b', false), padding: '9px 16px', minHeight: '40px', fontSize: '13px' }}>
            {f === 'SUBMITTED' ? `📨 Pending (${apps.filter(a => (a.status || 'SUBMITTED') === 'SUBMITTED').length})` : f}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', color: '#64748b', padding: '40px' }}>
          {filter === 'SUBMITTED' ? '✨ Koi pending application nahi. Portal se submissions yahan live aayengi.' : 'Kuch nahi mila.'}
        </div>
      ) : shown.map(a => {
        const name = a.type === 'CUSTOMER' ? a.corporate_name : a.agency_name;
        const st = STATUS_META[a.status || 'SUBMITTED'] || STATUS_META.SUBMITTED;
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
                  {a.reject_reason ? <div style={{ gridColumn: '1 / -1', color: '#ef4444' }}>Reject reason: {a.reject_reason}</div> : null}
                </div>
                <div style={{ marginTop: '10px' }}>
                  {checks.map((c, i) => (
                    <div key={i} style={{ fontSize: '12px', color: c.ok ? '#10b981' : '#ef4444', padding: '2px 0' }}>
                      {c.ok ? '✔' : '✖'} {c.name}{!c.ok && c.msg ? ` — ${c.msg}` : ''}
                    </div>
                  ))}
                </div>
                {(a.status || 'SUBMITTED') === 'SUBMITTED' && (
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
