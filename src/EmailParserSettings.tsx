// @ts-nocheck
// 📧 EMAIL BILL PARSER — Multi-account settings (Accounts & Admin, ADMIN ONLY).
// "Email Auto-Fetch Mode" master switch + "Managed Email Accounts": har email
// account ek ERP customer/company se mapped hota hai. Background parser
// (email-parser.cjs) Master Switch ON hone par EMAIL_ACCOUNTS ke saare Active
// rows par loop karta hai — har account ki mails se PDF bills utha kar us
// customer ke billing rules (RATE_MASTER) ke context me Claude se extract
// karta hai. Data ADMIN-ONLY hai (app passwords) — firestore.rules enforced.
import React, { useState, useEffect } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const QUEUES = `${API}/api/v1/queues`;
const CRM = `${API}/api/v1/crm`;
const MASTERS = `${API}/api/v1/masters`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

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
      const [a, c, st, p] = await Promise.all([
        fetchJson(`${QUEUES}/email-accounts`),
        fetchJson(`${MASTERS}/customers`),
        fetchJson(`${CRM}/settings/email_parser`),
        fetchJson(`${QUEUES}/parsed-bills?limit=10`).catch(() => ({ bills: [] })),
      ]);
      // app_password comes back masked — the real value never leaves the server.
      setAccounts(a.accounts ?? []);
      setCustomers(c.customers ?? []);
      const cfg = st.value ?? {};
      setMasterOn(!!cfg.master_switch);
      setPollMinutes(String(cfg.poll_minutes || 10));
      setParsed((p.bills ?? []).map((b: any) => ({ ...b, createdAt: b.created_at })));
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
      await fetchJson(`${CRM}/settings/email_parser`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { master_switch: on, poll_minutes: Math.max(2, parseInt(mins) || 10) } }),
      });
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
        await fetchJson(`${QUEUES}/email-accounts/${editingId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        alert('✅ Email account update ho gaya!');
      } else {
        await fetchJson(`${QUEUES}/email-accounts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
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
    try {
      await fetchJson(`${QUEUES}/email-accounts/${a.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: a.status === 'Active' ? 'Inactive' : 'Active' }),
      });
      fetchAll();
    } catch { alert('❌ Status change nahi hua!'); }
  };
  const handleDelete = async (a) => {
    if (!window.confirm(`⚠️ ${a.email} ko hamesha ke liye remove karein? (Parsed bills delete nahi honge)`)) return;
    try { await fetchJson(`${QUEUES}/email-accounts/${a.id}`, { method: 'DELETE' }); fetchAll(); }
    catch { alert('❌ Delete nahi hua!'); }
  };

  const inputStyle = { width: '100%', padding: '12px 15px', background: '#121c38', border: '1px solid #27395f', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '14px', boxSizing: 'border-box' };
  const labelStyle = { color: '#22d3ee', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '6px' };
  const card = { background: 'rgba(24, 36, 74, 0.4)', backdropFilter: 'blur(12px)', border: '1px solid #18244a', borderRadius: '15px', padding: '25px', marginBottom: '25px' };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #121c38, #0a1024)', fontFamily: "'Inter', sans-serif" }}>
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#22d3ee', fontSize: '32px', margin: '0 0 10px 0' }}>📧 Email Bill Parser</h1>
        <p style={{ color: '#9aadd4', margin: 0 }}>Customer-mapped email accounts se bills auto-fetch hokar AI extraction ke baad review queue me aati hain</p>
      </div>

      {loadError && (
        <div style={{ ...card, border: '1px solid #ff6b81', color: '#fca5a5', textAlign: 'center', fontWeight: 'bold' }}>{loadError}</div>
      )}

      {/* 🔘 EMAIL AUTO-FETCH MODE (Master Switch) */}
      <div style={{ ...card, border: masterOn ? '1px solid #2fe39b' : '1px solid #27395f', display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '240px' }}>
          <b style={{ color: masterOn ? '#2fe39b' : '#9aadd4', fontSize: '16px' }}>⚡ Email Auto-Fetch Mode</b>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#5d7196' }}>
            ON hone par background parser (email-parser.cjs) neeche ke SAARE Active accounts par loop karta hai — har account ki PDF bills us account ke mapped customer ke billing rules ke saath extract hoti hain.
          </p>
        </div>
        <button onClick={() => saveMaster(!masterOn)}
          style={{ background: masterOn ? 'linear-gradient(135deg, #2fe39b, #2fe39b)' : '#27395f', color: 'white', border: 'none', borderRadius: '999px', padding: '12px 26px', fontWeight: '900', fontSize: '15px', cursor: 'pointer', minWidth: '150px' }}>
          {masterOn ? '🟢 MASTER ON' : '⚪ MASTER OFF'}
        </button>
        <div>
          <label style={{ ...labelStyle, marginBottom: '3px' }}>Check every (min)</label>
          <input type="number" min="2" style={{ ...inputStyle, width: '90px', padding: '8px' }} value={pollMinutes}
            onChange={e => setPollMinutes(e.target.value)} onBlur={() => saveMaster(masterOn)} />
        </div>
      </div>

      {/* ➕ ADD / EDIT EMAIL FORM */}
      <div style={{ ...card, border: editingId ? '2px solid #ffb224' : '1px solid #18244a' }}>
        <b style={{ color: editingId ? '#ffb224' : '#22d3ee' }}>{editingId ? '✏️ Edit Email Account' : '➕ Add New Email'}</b>
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
              <label style={{ ...labelStyle, color: '#ffb224' }}>Associated Customer / Company *</label>
              <select style={{ ...inputStyle, borderColor: '#ffb224' }} value={formData.customer}
                onChange={e => setFormData({ ...formData, customer: e.target.value })} required>
                <option value="">-- Select Customer --</option>
                {customers.map(c => {
                  const cName = c.customer_name || c.name || c.company_name || c.Customer_Name || c.id;
                  return <option key={c.id} value={cName}>{cName}</option>;
                })}
              </select>
              <small style={{ color: '#9aadd4', fontSize: '11px', display: 'block', marginTop: '4px' }}>
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
                style={{ flex: 1, background: 'transparent', color: '#ff6b81', border: '1px solid #ff6b81', padding: '13px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer' }}>❌ CANCEL</button>
            )}
            <button type="submit" disabled={saving}
              style={{ flex: 2, background: editingId ? 'linear-gradient(135deg, #ffb224, #d97706)' : 'linear-gradient(135deg, #22d3ee, #3b82f6)', color: '#121c38', border: 'none', padding: '13px', borderRadius: '8px', fontWeight: '900', fontSize: '15px', cursor: 'pointer' }}>
              {saving ? '⏳ SAVING…' : (editingId ? '💾 UPDATE ACCOUNT' : '💾 ADD EMAIL ACCOUNT')}
            </button>
          </div>
        </form>
      </div>

      {/* 📋 MANAGED EMAIL ACCOUNTS */}
      <div style={{ ...card, padding: '20px', overflowX: 'auto' }}>
        <b style={{ color: '#22d3ee' }}>📋 Managed Email Accounts ({accounts.length})</b>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap', marginTop: '12px' }}>
          <thead style={{ color: '#ffb224', fontSize: '11px', textTransform: 'uppercase', borderBottom: '2px solid #27395f' }}>
            <tr>
              <th style={{ padding: '12px 10px' }}>EMAIL</th>
              <th style={{ padding: '12px 10px' }}>IMAP</th>
              <th style={{ padding: '12px 10px', color: '#ffb224' }}>CUSTOMER / COMPANY</th>
              <th style={{ padding: '12px 10px' }}>LAST CHECK</th>
              <th style={{ padding: '12px 10px', textAlign: 'center' }}>STATUS</th>
              <th style={{ padding: '12px 10px', textAlign: 'center' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding: '25px', textAlign: 'center', color: '#22d3ee' }}>Loading…</td></tr>
            ) : accounts.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: '25px', textAlign: 'center', color: '#5d7196' }}>Koi email account nahi — upar "Add New Email" se pehla account jodein.</td></tr>
            ) : accounts.map(a => {
              const active = a.status === 'Active';
              return (
                <tr key={a.id} style={{ borderBottom: '1px solid #18244a', color: active ? '#c4d1ea' : '#5d7196', fontSize: '13px', opacity: active ? 1 : 0.6 }}>
                  <td style={{ padding: '12px 10px', fontWeight: 'bold' }}>{a.email}<div style={{ fontSize: '10px', color: '#5d7196', fontWeight: 'normal' }}>🔑 ••••••••</div></td>
                  <td style={{ padding: '12px 10px', color: '#9aadd4' }}>{a.imap_host}:{a.imap_port}</td>
                  <td style={{ padding: '12px 10px', color: '#ffb224', fontWeight: 'bold' }}>{a.customer || '—'}</td>
                  <td style={{ padding: '12px 10px', fontSize: '11px' }}>
                    {a.last_checked_at?.seconds ? new Date(a.last_checked_at.seconds * 1000).toLocaleString('en-IN') : 'never'}
                    {a.last_result && <div style={{ color: /FAIL/.test(a.last_result) ? '#ff6b81' : '#2fe39b', fontSize: '10px' }}>{a.last_result}</div>}
                    {a.last_error && <div style={{ color: '#ff6b81', fontSize: '10px', maxWidth: '220px', whiteSpace: 'normal' }} title={a.last_error}>⚠ {a.last_error.slice(0, 80)}</div>}
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    <button onClick={() => toggleStatus(a)}
                      style={{ background: active ? 'rgba(47, 227, 155,0.1)' : 'rgba(255, 107, 129,0.1)', color: active ? '#2fe39b' : '#ff6b81', border: `1px solid ${active ? '#2fe39b' : '#ff6b81'}`, padding: '4px 12px', borderRadius: '20px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}>
                      {active ? '🟢 ACTIVE' : '🔴 INACTIVE'}
                    </button>
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                      <button onClick={() => handleEdit(a)} style={{ background: 'rgba(34, 211, 238,0.1)', border: '1px solid #22d3ee', color: '#22d3ee', padding: '5px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }}>✏️ Edit</button>
                      <button onClick={() => handleDelete(a)} style={{ background: 'rgba(255, 107, 129,0.1)', border: '1px solid #ff6b81', color: '#ff6b81', padding: '5px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }}>🗑️</button>
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
        <b style={{ color: '#2fe39b' }}>📄 Recently Parsed Bills (latest {parsed.length})</b>
        {parsed.length === 0 ? (
          <p style={{ color: '#5d7196', fontSize: '13px', margin: '12px 0 0' }}>Abhi koi parsed bill nahi. Master ON + Active account hone par yahan aayengi (status PENDING_REVIEW).</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {parsed.map(p => (
              <div key={p.id} style={{ background: 'rgba(18, 28, 56,0.6)', border: '1px solid #27395f', borderRadius: '10px', padding: '10px 14px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px' }}>
                <b style={{ color: '#2fe39b' }}>Bill {p.bill_no || '?'}</b>
                <span style={{ color: '#ffb224' }}>{p.customer}</span>
                <span style={{ color: '#9aadd4' }}>{p.rows?.length || 0} rows · {fmtINR(p.row_sum)}</span>
                <span style={{ color: '#5d7196', fontSize: '11px' }}>📎 {p.attachment} · via {p.source_email}</span>
                <span style={{ marginLeft: 'auto', fontSize: '10px', fontWeight: 'bold', color: p.status === 'PENDING_REVIEW' ? '#ffb224' : '#2fe39b', border: `1px solid ${p.status === 'PENDING_REVIEW' ? '#ffb224' : '#2fe39b'}`, borderRadius: '10px', padding: '2px 8px' }}>{p.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
