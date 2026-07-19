// @ts-nocheck
// 📧 EMAIL BILL PARSER — Multi-account settings (Accounts & Admin, ADMIN ONLY).
// "Email Auto-Fetch Mode" master switch + "Managed Email Accounts": har email
// account ek ERP customer/company se mapped hota hai. Background parser
// (email-parser.cjs) Master Switch ON hone par EMAIL_ACCOUNTS ke saare Active
// rows par loop karta hai — har account ki mails se PDF bills utha kar us
// customer ke billing rules (RATE_MASTER) ke context me Claude se extract
// karta hai. Data ADMIN-ONLY hai (app passwords) — firestore.rules enforced.
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, getDoc, setDoc, serverTimestamp, query, orderBy, limit } from 'firebase/firestore';
import { db } from './firebase';

const fmtINR = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

export default function EmailParserSettings() {
  const [accounts, setAccounts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [parsed, setParsed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [loadError, setLoadError] = useState('');

  // 🔘 Master switch (EMAIL_SETTINGS/master)
  const [masterOn, setMasterOn] = useState(false);
  const [pollMinutes, setPollMinutes] = useState('10');

  const emptyForm = { email: '', app_password: '', imap_host: 'imap.gmail.com', imap_port: '993', customer: '', status: 'Active' };
  const [formData, setFormData] = useState(emptyForm);

  useEffect(() => { fetchAll(); }, []);
  const fetchAll = async () => {
    setLoading(true);
    try {
      const [aSnap, cSnap, sDoc, pSnap] = await Promise.all([
        getDocs(collection(db, 'EMAIL_ACCOUNTS')),
        getDocs(collection(db, 'CUSTOMERS')),
        getDoc(doc(db, 'EMAIL_SETTINGS', 'master')),
        getDocs(query(collection(db, 'EMAIL_PARSED_BILLS'), orderBy('createdAt', 'desc'), limit(10))).catch(() => ({ docs: [] })),
      ]);
      setAccounts(aSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setCustomers(cSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      const s = sDoc.exists() ? sDoc.data() : {};
      setMasterOn(!!s.master_switch);
      setPollMinutes(String(s.poll_minutes || 10));
      setParsed(pSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoadError('');
    } catch (e) {
      console.error('EmailParser fetch:', e);
      // Non-admin staff par rules read block karte hain — clear message
      setLoadError(/permission/i.test(e?.message || '') ? '🔒 Ye section sirf ADMIN ke liye hai (email passwords yahan store hote hain).' : 'Data load nahi hua — network check karein.');
    }
    setLoading(false);
  };

  const saveMaster = async (on, mins = pollMinutes) => {
    try {
      await setDoc(doc(db, 'EMAIL_SETTINGS', 'master'), {
        master_switch: on, poll_minutes: Math.max(2, parseInt(mins) || 10), updatedAt: serverTimestamp(),
      }, { merge: true });
      setMasterOn(on);
    } catch { alert('❌ Master switch save nahi hua!'); }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.email || !formData.imap_host || !formData.customer) {
      return alert('⚠️ Email, IMAP Host aur Associated Customer zaroor bharein!');
    }
    if (!editingId && !formData.app_password) return alert('⚠️ App Password bharein (Gmail: Google Account → Security → App Passwords).');
    const dup = accounts.find(a => a.id !== editingId && a.email.toLowerCase() === formData.email.toLowerCase());
    if (dup) return alert('⚠️ Ye email account pehle se added hai.');

    setSaving(true);
    try {
      const payload = {
        email: formData.email.trim().toLowerCase(),
        imap_host: formData.imap_host.trim(),
        imap_port: parseInt(formData.imap_port) || 993,
        customer: formData.customer,
        status: formData.status,
      };
      // Password: edit me khali chhoda => purana password rakha jata hai
      if (formData.app_password) payload.app_password = formData.app_password;
      if (editingId) {
        await updateDoc(doc(db, 'EMAIL_ACCOUNTS', editingId), { ...payload, updatedAt: serverTimestamp() });
        alert('✅ Email account update ho gaya!');
      } else {
        await addDoc(collection(db, 'EMAIL_ACCOUNTS'), { ...payload, createdAt: serverTimestamp(), last_result: '', last_error: '' });
        alert('✅ Email account add ho gaya — Master Switch ON hote hi parser isse check karega.');
      }
      setEditingId(null); setFormData(emptyForm);
      fetchAll();
    } catch (err) {
      console.error(err);
      alert('❌ Save nahi hua — admin login + network check karein.');
    }
    setSaving(false);
  };

  const handleEdit = (a) => {
    setEditingId(a.id);
    setFormData({ email: a.email, app_password: '', imap_host: a.imap_host || 'imap.gmail.com', imap_port: String(a.imap_port || 993), customer: a.customer || '', status: a.status || 'Active' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const toggleStatus = async (a) => {
    try { await updateDoc(doc(db, 'EMAIL_ACCOUNTS', a.id), { status: a.status === 'Active' ? 'Inactive' : 'Active' }); fetchAll(); }
    catch { alert('❌ Status change nahi hua!'); }
  };
  const handleDelete = async (a) => {
    if (!window.confirm(`⚠️ ${a.email} ko hamesha ke liye remove karein? (Parsed bills delete nahi honge)`)) return;
    try { await deleteDoc(doc(db, 'EMAIL_ACCOUNTS', a.id)); fetchAll(); }
    catch { alert('❌ Delete nahi hua!'); }
  };

  const inputStyle = { width: '100%', padding: '12px 15px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '14px', boxSizing: 'border-box' };
  const labelStyle = { color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '6px' };
  const card = { background: 'rgba(30, 41, 59, 0.4)', backdropFilter: 'blur(12px)', border: '1px solid #1e293b', borderRadius: '15px', padding: '25px', marginBottom: '25px' };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#38bdf8', fontSize: '32px', margin: '0 0 10px 0' }}>📧 Email Bill Parser</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>Customer-mapped email accounts se bills auto-fetch hokar AI extraction ke baad review queue me aati hain</p>
      </div>

      {loadError && (
        <div style={{ ...card, border: '1px solid #ef4444', color: '#fca5a5', textAlign: 'center', fontWeight: 'bold' }}>{loadError}</div>
      )}

      {/* 🔘 EMAIL AUTO-FETCH MODE (Master Switch) */}
      <div style={{ ...card, border: masterOn ? '1px solid #10b981' : '1px solid #334155', display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '240px' }}>
          <b style={{ color: masterOn ? '#10b981' : '#94a3b8', fontSize: '16px' }}>⚡ Email Auto-Fetch Mode</b>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b' }}>
            ON hone par background parser (email-parser.cjs) neeche ke SAARE Active accounts par loop karta hai — har account ki PDF bills us account ke mapped customer ke billing rules ke saath extract hoti hain.
          </p>
        </div>
        <button onClick={() => saveMaster(!masterOn)}
          style={{ background: masterOn ? 'linear-gradient(135deg, #10b981, #059669)' : '#334155', color: 'white', border: 'none', borderRadius: '999px', padding: '12px 26px', fontWeight: '900', fontSize: '15px', cursor: 'pointer', minWidth: '150px' }}>
          {masterOn ? '🟢 MASTER ON' : '⚪ MASTER OFF'}
        </button>
        <div>
          <label style={{ ...labelStyle, marginBottom: '3px' }}>Check every (min)</label>
          <input type="number" min="2" style={{ ...inputStyle, width: '90px', padding: '8px' }} value={pollMinutes}
            onChange={e => setPollMinutes(e.target.value)} onBlur={() => saveMaster(masterOn)} />
        </div>
      </div>

      {/* ➕ ADD / EDIT EMAIL FORM */}
      <div style={{ ...card, border: editingId ? '2px solid #f59e0b' : '1px solid #1e293b' }}>
        <b style={{ color: editingId ? '#f59e0b' : '#38bdf8' }}>{editingId ? '✏️ Edit Email Account' : '➕ Add New Email'}</b>
        <form onSubmit={handleSave} style={{ marginTop: '15px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '18px', marginBottom: '18px' }}>
            <div>
              <label style={labelStyle}>Email Address *</label>
              <input type="email" placeholder="bills@company.com" style={inputStyle} value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })} required autoComplete="off" />
            </div>
            <div>
              <label style={labelStyle}>App Password / Secret {editingId ? '(khaali = unchanged)' : '*'}</label>
              <input type="password" placeholder={editingId ? '•••••••• (saved)' : 'xxxx xxxx xxxx xxxx'} style={inputStyle} value={formData.app_password}
                onChange={e => setFormData({ ...formData, app_password: e.target.value })} autoComplete="new-password" />
            </div>
            <div>
              <label style={labelStyle}>IMAP Host *</label>
              <input placeholder="imap.gmail.com" style={inputStyle} value={formData.imap_host}
                onChange={e => setFormData({ ...formData, imap_host: e.target.value })} required autoComplete="off" />
            </div>
            <div>
              <label style={labelStyle}>IMAP Port *</label>
              <input type="number" placeholder="993" style={inputStyle} value={formData.imap_port}
                onChange={e => setFormData({ ...formData, imap_port: e.target.value })} required />
            </div>
            <div>
              <label style={{ ...labelStyle, color: '#f59e0b' }}>Associated Customer / Company *</label>
              <select style={{ ...inputStyle, borderColor: '#f59e0b' }} value={formData.customer}
                onChange={e => setFormData({ ...formData, customer: e.target.value })} required>
                <option value="">-- Select Customer --</option>
                {customers.map(c => {
                  const cName = c.customer_name || c.name || c.company_name || c.Customer_Name || c.id;
                  return <option key={c.id} value={cName}>{cName}</option>;
                })}
              </select>
              <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginTop: '4px' }}>
                Is account ki bills IS customer ke billing/loading rules ke context me extract hongi.
              </small>
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <select style={inputStyle} value={formData.status} onChange={e => setFormData({ ...formData, status: e.target.value })}>
                <option value="Active">🟢 Active</option>
                <option value="Inactive">🔴 Inactive</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            {editingId && (
              <button type="button" onClick={() => { setEditingId(null); setFormData(emptyForm); }}
                style={{ flex: 1, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '13px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer' }}>❌ CANCEL</button>
            )}
            <button type="submit" disabled={saving}
              style={{ flex: 2, background: editingId ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #38bdf8, #3b82f6)', color: '#0f172a', border: 'none', padding: '13px', borderRadius: '8px', fontWeight: '900', fontSize: '15px', cursor: 'pointer' }}>
              {saving ? '⏳ SAVING…' : (editingId ? '💾 UPDATE ACCOUNT' : '💾 ADD EMAIL ACCOUNT')}
            </button>
          </div>
        </form>
      </div>

      {/* 📋 MANAGED EMAIL ACCOUNTS */}
      <div style={{ ...card, padding: '20px', overflowX: 'auto' }}>
        <b style={{ color: '#38bdf8' }}>📋 Managed Email Accounts ({accounts.length})</b>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap', marginTop: '12px' }}>
          <thead style={{ color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase', borderBottom: '2px solid #334155' }}>
            <tr>
              <th style={{ padding: '12px 10px' }}>EMAIL</th>
              <th style={{ padding: '12px 10px' }}>IMAP</th>
              <th style={{ padding: '12px 10px', color: '#f59e0b' }}>CUSTOMER / COMPANY</th>
              <th style={{ padding: '12px 10px' }}>LAST CHECK</th>
              <th style={{ padding: '12px 10px', textAlign: 'center' }}>STATUS</th>
              <th style={{ padding: '12px 10px', textAlign: 'center' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding: '25px', textAlign: 'center', color: '#38bdf8' }}>Loading…</td></tr>
            ) : accounts.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: '25px', textAlign: 'center', color: '#64748b' }}>Koi email account nahi — upar "Add New Email" se pehla account jodein.</td></tr>
            ) : accounts.map(a => {
              const active = a.status === 'Active';
              return (
                <tr key={a.id} style={{ borderBottom: '1px solid #1e293b', color: active ? '#cbd5e1' : '#64748b', fontSize: '13px', opacity: active ? 1 : 0.6 }}>
                  <td style={{ padding: '12px 10px', fontWeight: 'bold' }}>{a.email}<div style={{ fontSize: '10px', color: '#64748b', fontWeight: 'normal' }}>🔑 ••••••••</div></td>
                  <td style={{ padding: '12px 10px', color: '#94a3b8' }}>{a.imap_host}:{a.imap_port}</td>
                  <td style={{ padding: '12px 10px', color: '#f59e0b', fontWeight: 'bold' }}>{a.customer || '—'}</td>
                  <td style={{ padding: '12px 10px', fontSize: '11px' }}>
                    {a.last_checked_at?.seconds ? new Date(a.last_checked_at.seconds * 1000).toLocaleString('en-IN') : 'never'}
                    {a.last_result && <div style={{ color: /FAIL/.test(a.last_result) ? '#ef4444' : '#10b981', fontSize: '10px' }}>{a.last_result}</div>}
                    {a.last_error && <div style={{ color: '#ef4444', fontSize: '10px', maxWidth: '220px', whiteSpace: 'normal' }} title={a.last_error}>⚠ {a.last_error.slice(0, 80)}</div>}
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    <button onClick={() => toggleStatus(a)}
                      style={{ background: active ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: active ? '#10b981' : '#ef4444', border: `1px solid ${active ? '#10b981' : '#ef4444'}`, padding: '4px 12px', borderRadius: '20px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}>
                      {active ? '🟢 ACTIVE' : '🔴 INACTIVE'}
                    </button>
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                      <button onClick={() => handleEdit(a)} style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '5px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }}>✏️ Edit</button>
                      <button onClick={() => handleDelete(a)} style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '5px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }}>🗑️</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 📄 RECENTLY PARSED BILLS */}
      <div style={{ ...card, padding: '20px' }}>
        <b style={{ color: '#10b981' }}>📄 Recently Parsed Bills (latest {parsed.length})</b>
        {parsed.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '13px', margin: '12px 0 0' }}>Abhi koi parsed bill nahi. Master ON + Active account hone par yahan aayengi (status PENDING_REVIEW).</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {parsed.map(p => (
              <div key={p.id} style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid #334155', borderRadius: '10px', padding: '10px 14px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px' }}>
                <b style={{ color: '#10b981' }}>Bill {p.bill_no || '?'}</b>
                <span style={{ color: '#f59e0b' }}>{p.customer}</span>
                <span style={{ color: '#94a3b8' }}>{p.rows?.length || 0} rows · {fmtINR(p.row_sum)}</span>
                <span style={{ color: '#64748b', fontSize: '11px' }}>📎 {p.attachment} · via {p.source_email}</span>
                <span style={{ marginLeft: 'auto', fontSize: '10px', fontWeight: 'bold', color: p.status === 'PENDING_REVIEW' ? '#f59e0b' : '#10b981', border: `1px solid ${p.status === 'PENDING_REVIEW' ? '#f59e0b' : '#10b981'}`, borderRadius: '10px', padding: '2px 8px' }}>{p.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
