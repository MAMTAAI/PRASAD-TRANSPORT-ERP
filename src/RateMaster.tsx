// @ts-nocheck
// 💹 DYNAMIC RATE MASTER — Accounts & Admin ka dedicated rate-rule setup.
// Live PostgreSQL (`rate_master`, migration 029).
//
// Har rule strictly Customer + Source (loading point) + Destination par mapped
// hai; Calculation Type batata hai freight ka formula (RTKM-based, Per Unit ya
// Fixed) aur Effective From/To quarterly tender revisions handle karta hai.
// Auto-billing engine (MonthlyBilling) trips fetch karte waqt SABSE PEHLE isi
// master ko query karta hai — resolveTripBilling() in lib/freightEngine.ts.
//
// THE OVERLAP GUARD IS NOW IN TWO PLACES, on purpose. Two ACTIVE rules on one
// lane with overlapping windows make billing ambiguous. This screen has always
// checked for that in JS, but a guard that only lives in the browser is not a
// guard — a second tab, a second user or a direct API call walks straight past
// it. Migration 029 added a partial unique index, so the database refuses the
// clash as well and the screen reports the 409 rather than pretending it saved.
//
// The list also carries rows this screen did not write: `derived_rate_card` is
// the evidence-backed rate card built from bills IOCL actually paid
// (v_iocl_lane_rate). It is shown for comparison, never edited here.
import React, { useState, useEffect, useMemo } from 'react';
import { CALC_TYPES } from './lib/freightEngine';
import { fetchRates, fetchLanes } from './lib/masters/rateApi';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const MASTERS = `${API}/api/v1/masters`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isRtkmType = (ct) => ct === 'RTKM_KL' || ct === 'RTKM_MT';
/** Do effective windows overlap karti hain? ('' valid_to = open-ended) */
const windowsOverlap = (aFrom, aTo, bFrom, bTo) =>
  (!aTo || !bFrom || bFrom <= aTo) && (!bTo || !aFrom || aFrom <= bTo);

// The PascalCase adapter lives in lib/masters/rateApi.ts — MonthlyBilling
// prices trips off the same rows through the same mapping, and two copies of it
// would let the billing engine and this screen disagree about a rule.
const toApi = (f: any) => ({
  customer_name: f.Customer,
  source: f.Source,
  destination: f.Destination,
  calc_type: f.Calc_Type,
  rate: parseFloat(f.Rate_Value),
  rtkm_distance: parseFloat(f.RTKM_Distance) || null,
  valid_from: f.Effective_From,
  // '' would fail the date cast; an open-ended rule is genuinely NULL.
  valid_to: f.Effective_To || null,
  status: f.Status === 'Inactive' ? 'INACTIVE' : 'ACTIVE',
});


export default function RateMaster() {
  const [rates, setRates] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [routes, setRoutes] = useState([]); // RTKM_MASTER — Source/Destination suggestions + RTKM auto-fill
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');

  const [formData, setFormData] = useState({
    Customer: '',
    Source: '',
    Destination: '',
    Calc_Type: 'PER_UNIT',
    Rate_Value: '',
    RTKM_Distance: '',
    Effective_From: todayISO(),
    Effective_To: '',
    Status: 'Active',
  });

  const [derivedCard, setDerivedCard] = useState([]);

  useEffect(() => { fetchAll(); }, []);
  const fetchAll = async () => {
    setLoading(true);
    try {
      const [r, c, lanes] = await Promise.all([
        fetchRates(),
        fetchJson(`${MASTERS}/customers?limit=1000`).catch(() => ({ customers: [] })),
        fetchLanes().catch(() => []),
      ]);
      setRates(r.rates);
      setDerivedCard(r.derived);
      setCustomers(c.customers ?? []);
      setRoutes(lanes);
    } catch (e) { console.error('RateMaster fetch:', e); }
    setLoading(false);
  };

  // Source/Destination suggestions: RTKM route master + pehle save hui rate entries
  const uniqueSources = useMemo(() => [...new Set([
    ...routes.map(r => r.Depot_Link || r.depot_link),
    ...rates.map(r => r.Source),
  ].filter(Boolean))].sort(), [routes, rates]);
  const uniqueDestinations = useMemo(() => [...new Set([
    ...routes.map(r => r.Consignee_Name || r.consignee_name),
    ...rates.map(r => r.Destination),
  ].filter(Boolean))].sort(), [routes, rates]);

  // 🗺️ RTKM auto-suggest: Customer+Source+Destination RTKM route master me mile
  // to uska RTKM Distance yahan bhi auto-bhar do (user overwrite kar sakta hai).
  const suggestedRtkm = useMemo(() => {
    const hit = routes.find(r =>
      normKey(r.Customer || r.customer_name) === normKey(formData.Customer) &&
      normKey(r.Depot_Link || r.depot_link) === normKey(formData.Source) &&
      normKey(r.Consignee_Name || r.consignee_name) === normKey(formData.Destination)
    );
    return parseFloat(hit?.RTKM_Distance || hit?.rtkm_distance || 0) || 0;
  }, [routes, formData.Customer, formData.Source, formData.Destination]);
  useEffect(() => {
    if (isRtkmType(formData.Calc_Type) && !formData.RTKM_Distance && suggestedRtkm > 0) {
      setFormData(prev => ({ ...prev, RTKM_Distance: String(suggestedRtkm) }));
    }
  }, [suggestedRtkm, formData.Calc_Type]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.Customer || !formData.Source || !formData.Destination || !formData.Rate_Value || !formData.Effective_From) {
      alert('⚠️ Customer, Source, Destination, Rate Value aur Effective From zaroor bharein!');
      return;
    }
    if (!(parseFloat(formData.Rate_Value) > 0)) { alert('⚠️ Rate Value 0 se bada hona chahiye!'); return; }
    if (formData.Effective_To && formData.Effective_To < formData.Effective_From) {
      alert(`⚠️ Effective To (${formData.Effective_To}) Effective From (${formData.Effective_From}) se pehle nahi ho sakta!`);
      return;
    }
    if (isRtkmType(formData.Calc_Type) && !(parseFloat(formData.RTKM_Distance) > 0)) {
      if (!window.confirm('⚠️ RTKM-based Calculation Type chuna hai par RTKM Distance khali hai.\n\nBilling ke waqt RTKM route master se distance uthaya jayega — wahan bhi na mila to freight 0 aayega.\n\nPhir bhi save karein?')) return;
    }

    // 🚫 OVERLAP GUARD: same Customer + Source + Destination par do rules ki
    // effective windows overlap nahi ho sakti — warna billing me ambiguity.
    const clash = rates.find(r =>
      r.id !== editingId &&
      String(r.Status || 'Active') !== 'Inactive' &&
      normKey(r.Customer) === normKey(formData.Customer) &&
      normKey(r.Source) === normKey(formData.Source) &&
      normKey(r.Destination) === normKey(formData.Destination) &&
      windowsOverlap(formData.Effective_From, formData.Effective_To, r.Effective_From, r.Effective_To)
    );
    if (clash) {
      alert(`🚫 OVERLAP: Is route par pehle se ek ACTIVE rate rule hai jiska period takrata hai:\n\n₹${clash.Rate_Value} (${CALC_TYPES.find(c => c.key === clash.Calc_Type)?.label || clash.Calc_Type})\n${clash.Effective_From} → ${clash.Effective_To || 'open'}\n\nNaya quarterly rate lagane ke liye purane rule ka Effective To pehle band karein (ya usay edit karein).`);
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = toApi(formData);
      payload.source = String(payload.source || '').toUpperCase().trim();
      payload.destination = String(payload.destination || '').toUpperCase().trim();
      if (editingId) {
        await fetchJson(`${MASTERS}/rates/${editingId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        alert('✅ Rate rule update ho gaya!');
      } else {
        await fetchJson(`${MASTERS}/rates`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        alert('✅ Naya rate rule save ho gaya — auto-billing ab isi se freight lagayegi!');
      }
      resetForm();
      fetchAll();
    } catch (err: any) {
      console.error('RateMaster save:', err);
      // The database enforces the same one-rule-per-lane-window rule the JS
      // guard above checks. Reaching here means the guard could not see the
      // clash — a stale list, another tab, another user.
      alert(err?.code === 'DUPLICATE'
        ? '🚫 Is lane par isi date se ek ACTIVE rule pehle se hai (database ne roka). List refresh karke purane rule ka Effective To band karein.'
        : '❌ Save nahi ho paya: ' + (err?.message || ''));
    }
    setIsSubmitting(false);
  };

  const handleEdit = (r) => {
    setEditingId(r.id);
    setFormData({
      Customer: r.Customer || '',
      Source: r.Source || '',
      Destination: r.Destination || '',
      Calc_Type: r.Calc_Type || 'PER_UNIT',
      Rate_Value: String(r.Rate_Value ?? ''),
      RTKM_Distance: r.RTKM_Distance ? String(r.RTKM_Distance) : '',
      Effective_From: r.Effective_From || todayISO(),
      Effective_To: r.Effective_To || '',
      Status: r.Status || 'Active',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleToggleStatus = async (id, cur) => {
    try {
      await fetchJson(`${MASTERS}/rates/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: cur === 'Active' ? 'INACTIVE' : 'ACTIVE' }),
      });
      fetchAll();
    } catch (e: any) { alert('❌ Status change nahi hua: ' + (e?.message || '')); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('⚠️ Ye rate rule hamesha ke liye delete ho jayega. Purane periods ka record chahiye to DELETE ki jagah Effective To bhar kar band karein.\n\nPhir bhi delete karein?')) return;
    try {
      await fetchJson(`${MASTERS}/rates/${id}`, { method: 'DELETE' });
      fetchAll();
    } catch (e: any) { alert('❌ Delete nahi hua: ' + (e?.message || '')); }
  };

  const resetForm = () => {
    setEditingId(null);
    setFormData(prev => ({
      ...prev,
      Source: '', Destination: '', Rate_Value: '', RTKM_Distance: '',
      Effective_From: todayISO(), Effective_To: '', Status: 'Active',
    }));
  };

  let filtered = rates;
  if (customerFilter) filtered = filtered.filter(r => (r.Customer || '').toUpperCase() === customerFilter.toUpperCase());
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(r =>
      (r.Customer || '').toLowerCase().includes(q) ||
      (r.Source || '').toLowerCase().includes(q) ||
      (r.Destination || '').toLowerCase().includes(q)
    );
  }

  /** Rule aaj effective hai? → LIVE badge; future window → UPCOMING; beet gaya → EXPIRED */
  const windowState = (r) => {
    const d = todayISO();
    if (r.Effective_From && d < r.Effective_From) return 'UPCOMING';
    if (r.Effective_To && d > r.Effective_To) return 'EXPIRED';
    return 'LIVE';
  };

  const inputStyle = { width: '100%', padding: '12px 15px', background: '#121c38', border: '1px solid #27395f', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '14px', boxSizing: 'border-box' };
  const labelStyle = { color: '#22d3ee', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '6px' };
  const selectedCalc = CALC_TYPES.find(c => c.key === formData.Calc_Type);

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #121c38, #0a1024)', fontFamily: "'Inter', sans-serif" }}>

      {/* HEADER */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#22d3ee', fontSize: '32px', margin: '0 0 10px 0' }}>💹 Dynamic Rate Master</h1>
        <p style={{ color: '#9aadd4', margin: 0 }}>Customer + Source ➔ Destination wise billing rules — auto-billing engine yahi se formula + rate uthata hai</p>
      </div>

      {/* FORM CARD */}
      <div style={{ background: 'rgba(24, 36, 74, 0.4)', backdropFilter: 'blur(12px)', border: editingId ? '2px solid #ffb224' : '1px solid #18244a', borderRadius: '15px', padding: '30px', marginBottom: '40px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
        {editingId && (
          <div style={{ background: 'rgba(255, 178, 36, 0.1)', color: '#ffb224', padding: '10px', borderRadius: '8px', marginBottom: '20px', fontWeight: 'bold', textAlign: 'center', border: '1px dashed #ffb224' }}>
            ✏️ EDITING MODE: You are updating an existing rate rule.
          </div>
        )}

        <form onSubmit={handleSave}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            <div>
              <label style={labelStyle}>Customer *</label>
              <select style={inputStyle} value={formData.Customer} onChange={e => setFormData({ ...formData, Customer: e.target.value })} required>
                <option value="">-- Select Customer --</option>
                {customers.map(c => {
                  const cName = c.customer_name || c.name || c.company_name || c.Customer_Name || c.id;
                  return <option key={c.id} value={cName}>{cName}</option>;
                })}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Source Depot / Loading Point *</label>
              <input list="rm-source-list" placeholder="Type or Select Source" style={inputStyle} value={formData.Source}
                onChange={e => setFormData({ ...formData, Source: e.target.value.toUpperCase() })} required autoComplete="off" />
              <datalist id="rm-source-list">{uniqueSources.map((s, i) => <option key={i} value={s} />)}</datalist>
            </div>
            <div>
              <label style={labelStyle}>Destination / Unloading Point *</label>
              <input list="rm-dest-list" placeholder="Type or Select Destination" style={inputStyle} value={formData.Destination}
                onChange={e => setFormData({ ...formData, Destination: e.target.value.toUpperCase() })} required autoComplete="off" />
              <datalist id="rm-dest-list">{uniqueDestinations.map((s, i) => <option key={i} value={s} />)}</datalist>
            </div>
          </div>

          {/* 💰 FORMULA + RATE */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '20px', padding: '20px', background: 'rgba(47, 227, 155, 0.05)', borderRadius: '10px', border: '1px dashed #2fe39b' }}>
            <div>
              <label style={{ ...labelStyle, color: '#2fe39b' }}>Calculation Type / Formula *</label>
              <select style={{ ...inputStyle, borderColor: '#2fe39b', color: '#2fe39b', fontWeight: 'bold' }} value={formData.Calc_Type}
                onChange={e => setFormData({ ...formData, Calc_Type: e.target.value })}>
                {CALC_TYPES.map(ct => <option key={ct.key} value={ct.key}>{ct.label} — {ct.formula}</option>)}
              </select>
              <small style={{ color: '#9aadd4', fontSize: '11px', display: 'block', marginTop: '5px' }}>
                Formula: <b style={{ color: '#2fe39b' }}>{selectedCalc?.formula}</b>
              </small>
            </div>
            <div>
              <label style={{ ...labelStyle, color: '#2fe39b' }}>Rate Value (₹) *</label>
              <input type="number" step="any" placeholder={isRtkmType(formData.Calc_Type) ? 'e.g. 3.432495 (per tonne-km)' : formData.Calc_Type === 'FIXED_RATE' ? 'e.g. 25000 (flat per trip)' : 'e.g. 1500 (per KL/MT/Ton)'}
                style={{ ...inputStyle, borderColor: '#2fe39b', color: '#2fe39b', fontWeight: 'bold' }} value={formData.Rate_Value}
                onChange={e => setFormData({ ...formData, Rate_Value: e.target.value })} required />
            </div>
            {isRtkmType(formData.Calc_Type) && (
              <div>
                <label style={{ ...labelStyle, color: '#ffb224' }}>RTKM Distance (km)</label>
                <input type="number" step="any" placeholder="e.g. 1660" style={{ ...inputStyle, borderColor: '#ffb224' }} value={formData.RTKM_Distance}
                  onChange={e => setFormData({ ...formData, RTKM_Distance: e.target.value })} />
                <small style={{ color: '#9aadd4', fontSize: '11px', display: 'block', marginTop: '5px' }}>
                  {suggestedRtkm > 0 ? <>📍 RTKM route master me is route ka distance: <b style={{ color: '#ffb224' }}>{suggestedRtkm} km</b></> : 'Khali chhodne par billing RTKM route master se distance uthayegi.'}
                </small>
              </div>
            )}
          </div>

          {/* 🗓️ EFFECTIVE WINDOW (quarterly tender revisions) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '30px', padding: '20px', background: 'rgba(167, 139, 250, 0.05)', borderRadius: '10px', border: '1px dashed #a78bfa' }}>
            <div>
              <label style={{ ...labelStyle, color: '#a78bfa' }}>Effective From *</label>
              <input type="date" style={{ ...inputStyle, colorScheme: 'dark' }} value={formData.Effective_From}
                onChange={e => setFormData({ ...formData, Effective_From: e.target.value })} required />
            </div>
            <div>
              <label style={{ ...labelStyle, color: '#a78bfa' }}>Effective To (khaali = current/open)</label>
              <input type="date" style={{ ...inputStyle, colorScheme: 'dark' }} value={formData.Effective_To}
                onChange={e => setFormData({ ...formData, Effective_To: e.target.value })} />
            </div>
            <div style={{ alignSelf: 'end', color: '#9aadd4', fontSize: '11px', lineHeight: 1.5 }}>
              🗓️ Quarterly tender revision: naya rate aane par purane rule ka Effective To band karein aur naya rule add karein — trip ki LOADING DATE se sahi period ka rate auto-lagta hai.
            </div>
          </div>

          <div style={{ display: 'flex', gap: '15px' }}>
            {editingId && (
              <button type="button" onClick={resetForm} style={{ flex: 1, background: 'transparent', color: '#ff6b81', border: '1px solid #ff6b81', padding: '15px', borderRadius: '8px', fontWeight: '900', fontSize: '16px', cursor: 'pointer' }}>
                ❌ CANCEL EDIT
              </button>
            )}
            <button type="submit" disabled={isSubmitting} style={{ flex: 2, background: editingId ? 'linear-gradient(135deg, #ffb224, #d97706)' : 'linear-gradient(135deg, #2fe39b, #2fe39b)', color: '#121c38', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', fontSize: '16px', cursor: 'pointer', boxShadow: '0 5px 15px rgba(47, 227, 155, 0.4)' }}>
              {isSubmitting ? '⏳ SAVING...' : (editingId ? '💾 UPDATE RATE RULE' : '💾 SAVE RATE RULE')}
            </button>
          </div>
        </form>
      </div>

      {/* SEARCH BAR */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#18244a', padding: '15px', borderRadius: '10px', border: '1px solid #27395f' }}>
        <input type="text" placeholder="🔍 Search Customer, Source, Destination..." value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: 2, borderColor: '#22d3ee' }} />
        <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} style={{ ...inputStyle, flex: 1, borderColor: '#ffb224', color: '#ffb224' }}>
          <option value="">🏢 All Customers</option>
          {[...new Set(rates.map(r => r.Customer).filter(Boolean))].sort().map((c, i) => <option key={i} value={c}>{c}</option>)}
        </select>
      </div>

      {/* DATA TABLE */}
      <div style={{ background: '#121c38', border: '1px solid #18244a', borderRadius: '15px', overflowX: 'auto', padding: '20px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ color: '#ffb224', fontSize: '11px', textTransform: 'uppercase', borderBottom: '2px solid #27395f' }}>
            <tr>
              <th style={{ padding: '15px 10px' }}>CUSTOMER</th>
              <th style={{ padding: '15px 10px', color: '#2fe39b' }}>SOURCE</th>
              <th style={{ padding: '15px 10px' }}>DESTINATION</th>
              <th style={{ padding: '15px 10px', color: '#2fe39b' }}>CALC TYPE / FORMULA</th>
              <th style={{ padding: '15px 10px', color: '#2fe39b' }}>RATE ₹</th>
              <th style={{ padding: '15px 10px', color: '#ffb224' }}>RTKM</th>
              <th style={{ padding: '15px 10px', color: '#a78bfa' }}>EFFECTIVE PERIOD</th>
              <th style={{ padding: '15px 10px', textAlign: 'center' }}>STATUS</th>
              <th style={{ padding: '15px 10px', textAlign: 'center' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: '30px', textAlign: 'center', color: '#22d3ee' }}>Loading Data...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: '30px', textAlign: 'center', color: '#ff6b81' }}>No rate rules found — pehla rule upar ke form se add karein!</td></tr>
            ) : (
              filtered.map(r => {
                const isActive = r.Status !== 'Inactive';
                const ct = CALC_TYPES.find(c => c.key === r.Calc_Type);
                const ws = windowState(r);
                const wsColor = ws === 'LIVE' ? '#2fe39b' : ws === 'UPCOMING' ? '#22d3ee' : '#5d7196';
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #18244a', color: isActive ? '#c4d1ea' : '#5d7196', fontSize: '13px', opacity: isActive ? 1 : 0.6 }}
                    onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '15px 10px' }}>{r.Customer}</td>
                    <td style={{ padding: '15px 10px', color: isActive ? '#2fe39b' : '#5d7196', fontWeight: 'bold' }}>{r.Source}</td>
                    <td style={{ padding: '15px 10px' }}>{r.Destination}</td>
                    <td style={{ padding: '15px 10px' }} title={ct?.formula}>
                      <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#2fe39b', border: '1px solid #2fe39b', borderRadius: '10px', padding: '1px 8px' }}>{ct?.label || r.Calc_Type}</span>
                      <div style={{ fontSize: '10px', color: '#5d7196', marginTop: '3px' }}>{ct?.formula}</div>
                    </td>
                    <td style={{ padding: '15px 10px', color: isActive ? '#2fe39b' : '#5d7196', fontWeight: 'bold' }}>₹{r.Rate_Value}</td>
                    <td style={{ padding: '15px 10px', color: '#ffb224' }}>{isRtkmType(r.Calc_Type) ? (r.RTKM_Distance > 0 ? `${r.RTKM_Distance} km` : <span style={{ color: '#5d7196' }} title="Billing me RTKM route master se aayega">route master</span>) : '—'}</td>
                    <td style={{ padding: '15px 10px' }}>
                      <span style={{ color: '#a78bfa' }}>{r.Effective_From} → {r.Effective_To || 'open'}</span>
                      <span style={{ marginLeft: '8px', fontSize: '9px', fontWeight: 'bold', color: wsColor, border: `1px solid ${wsColor}`, borderRadius: '10px', padding: '1px 6px' }}>{ws}</span>
                    </td>
                    <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                      <button onClick={() => handleToggleStatus(r.id, r.Status || 'Active')}
                        style={{ background: isActive ? 'rgba(47, 227, 155, 0.1)' : 'rgba(255, 107, 129, 0.1)', color: isActive ? '#2fe39b' : '#ff6b81', border: `1px solid ${isActive ? '#2fe39b' : '#ff6b81'}`, padding: '4px 10px', borderRadius: '20px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}>
                        {isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
                      </button>
                    </td>
                    <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                        <button onClick={() => handleEdit(r)} style={{ background: 'rgba(34, 211, 238, 0.1)', border: '1px solid #22d3ee', color: '#22d3ee', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }} title="Edit">✏️ Edit</button>
                        <button onClick={() => handleDelete(r.id)} style={{ background: 'rgba(255, 107, 129, 0.1)', border: '1px solid #ff6b81', color: '#ff6b81', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }} title="Delete">🗑️ Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
