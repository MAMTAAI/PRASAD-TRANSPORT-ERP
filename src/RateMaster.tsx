// @ts-nocheck
// 💹 DYNAMIC RATE MASTER — Accounts & Admin ka dedicated rate-rule setup.
// Har rule strictly Customer + Source (loading point) + Destination par mapped
// hai; Calculation Type batata hai freight ka formula (RTKM-based, Per Unit ya
// Fixed) aur Effective From/To quarterly tender revisions handle karta hai.
// Auto-billing engine (MonthlyBilling) trips fetch karte waqt SABSE PEHLE isi
// master ko query karta hai — resolveTripBilling() in lib/freightEngine.ts.
import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { CALC_TYPES } from './lib/freightEngine';

const todayISO = () => new Date().toISOString().slice(0, 10);
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isRtkmType = (ct) => ct === 'RTKM_KL' || ct === 'RTKM_MT';
/** Do effective windows overlap karti hain? ('' valid_to = open-ended) */
const windowsOverlap = (aFrom, aTo, bFrom, bTo) =>
  (!aTo || !bFrom || bFrom <= aTo) && (!bTo || !aFrom || aFrom <= bTo);

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

  useEffect(() => { fetchAll(); }, []);
  const fetchAll = async () => {
    setLoading(true);
    try {
      const [rSnap, cSnap, rtSnap] = await Promise.all([
        getDocs(collection(db, 'RATE_MASTER')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'CUSTOMERS')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'RTKM_MASTER')).catch(() => ({ docs: [] })),
      ]);
      const data = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setRates(data);
      setCustomers(cSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setRoutes(rtSnap.docs.map(d => ({ id: d.id, ...d.data() })));
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
      const payload = {
        Customer: formData.Customer,
        Source: formData.Source.toUpperCase().trim(),
        Destination: formData.Destination.toUpperCase().trim(),
        Calc_Type: formData.Calc_Type,
        Rate_Value: parseFloat(formData.Rate_Value),
        RTKM_Distance: parseFloat(formData.RTKM_Distance) || 0,
        Effective_From: formData.Effective_From,
        Effective_To: formData.Effective_To || '',
        Status: formData.Status,
      };
      if (editingId) {
        await updateDoc(doc(db, 'RATE_MASTER', editingId), { ...payload, updatedAt: serverTimestamp() });
        alert('✅ Rate rule update ho gaya!');
      } else {
        await addDoc(collection(db, 'RATE_MASTER'), { ...payload, createdAt: serverTimestamp() });
        alert('✅ Naya rate rule save ho gaya — auto-billing ab isi se freight lagayegi!');
      }
      resetForm();
      fetchAll();
    } catch (err) {
      console.error('RateMaster save:', err);
      alert('❌ Save nahi ho paya — network/permission check karein.');
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
      await updateDoc(doc(db, 'RATE_MASTER', id), { Status: cur === 'Active' ? 'Inactive' : 'Active' });
      fetchAll();
    } catch { alert('❌ Status change nahi hua!'); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('⚠️ Ye rate rule hamesha ke liye delete ho jayega. Purane periods ka record chahiye to DELETE ki jagah Effective To bhar kar band karein.\n\nPhir bhi delete karein?')) return;
    try { await deleteDoc(doc(db, 'RATE_MASTER', id)); fetchAll(); }
    catch { alert('❌ Delete nahi hua!'); }
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

  const inputStyle = { width: '100%', padding: '12px 15px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '14px', boxSizing: 'border-box' };
  const labelStyle = { color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '6px' };
  const selectedCalc = CALC_TYPES.find(c => c.key === formData.Calc_Type);

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>

      {/* HEADER */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#38bdf8', fontSize: '32px', margin: '0 0 10px 0' }}>💹 Dynamic Rate Master</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>Customer + Source ➔ Destination wise billing rules — auto-billing engine yahi se formula + rate uthata hai</p>
      </div>

      {/* FORM CARD */}
      <div style={{ background: 'rgba(30, 41, 59, 0.4)', backdropFilter: 'blur(12px)', border: editingId ? '2px solid #f59e0b' : '1px solid #1e293b', borderRadius: '15px', padding: '30px', marginBottom: '40px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
        {editingId && (
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', padding: '10px', borderRadius: '8px', marginBottom: '20px', fontWeight: 'bold', textAlign: 'center', border: '1px dashed #f59e0b' }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '20px', padding: '20px', background: 'rgba(16, 185, 129, 0.05)', borderRadius: '10px', border: '1px dashed #10b981' }}>
            <div>
              <label style={{ ...labelStyle, color: '#10b981' }}>Calculation Type / Formula *</label>
              <select style={{ ...inputStyle, borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={formData.Calc_Type}
                onChange={e => setFormData({ ...formData, Calc_Type: e.target.value })}>
                {CALC_TYPES.map(ct => <option key={ct.key} value={ct.key}>{ct.label} — {ct.formula}</option>)}
              </select>
              <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginTop: '5px' }}>
                Formula: <b style={{ color: '#10b981' }}>{selectedCalc?.formula}</b>
              </small>
            </div>
            <div>
              <label style={{ ...labelStyle, color: '#10b981' }}>Rate Value (₹) *</label>
              <input type="number" step="any" placeholder={isRtkmType(formData.Calc_Type) ? 'e.g. 3.432495 (per tonne-km)' : formData.Calc_Type === 'FIXED_RATE' ? 'e.g. 25000 (flat per trip)' : 'e.g. 1500 (per KL/MT/Ton)'}
                style={{ ...inputStyle, borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={formData.Rate_Value}
                onChange={e => setFormData({ ...formData, Rate_Value: e.target.value })} required />
            </div>
            {isRtkmType(formData.Calc_Type) && (
              <div>
                <label style={{ ...labelStyle, color: '#f59e0b' }}>RTKM Distance (km)</label>
                <input type="number" step="any" placeholder="e.g. 1660" style={{ ...inputStyle, borderColor: '#f59e0b' }} value={formData.RTKM_Distance}
                  onChange={e => setFormData({ ...formData, RTKM_Distance: e.target.value })} />
                <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginTop: '5px' }}>
                  {suggestedRtkm > 0 ? <>📍 RTKM route master me is route ka distance: <b style={{ color: '#f59e0b' }}>{suggestedRtkm} km</b></> : 'Khali chhodne par billing RTKM route master se distance uthayegi.'}
                </small>
              </div>
            )}
          </div>

          {/* 🗓️ EFFECTIVE WINDOW (quarterly tender revisions) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '30px', padding: '20px', background: 'rgba(192, 132, 252, 0.05)', borderRadius: '10px', border: '1px dashed #c084fc' }}>
            <div>
              <label style={{ ...labelStyle, color: '#c084fc' }}>Effective From *</label>
              <input type="date" style={{ ...inputStyle, colorScheme: 'dark' }} value={formData.Effective_From}
                onChange={e => setFormData({ ...formData, Effective_From: e.target.value })} required />
            </div>
            <div>
              <label style={{ ...labelStyle, color: '#c084fc' }}>Effective To (khaali = current/open)</label>
              <input type="date" style={{ ...inputStyle, colorScheme: 'dark' }} value={formData.Effective_To}
                onChange={e => setFormData({ ...formData, Effective_To: e.target.value })} />
            </div>
            <div style={{ alignSelf: 'end', color: '#94a3b8', fontSize: '11px', lineHeight: 1.5 }}>
              🗓️ Quarterly tender revision: naya rate aane par purane rule ka Effective To band karein aur naya rule add karein — trip ki LOADING DATE se sahi period ka rate auto-lagta hai.
            </div>
          </div>

          <div style={{ display: 'flex', gap: '15px' }}>
            {editingId && (
              <button type="button" onClick={resetForm} style={{ flex: 1, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '15px', borderRadius: '8px', fontWeight: '900', fontSize: '16px', cursor: 'pointer' }}>
                ❌ CANCEL EDIT
              </button>
            )}
            <button type="submit" disabled={isSubmitting} style={{ flex: 2, background: editingId ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #10b981, #059669)', color: '#0f172a', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', fontSize: '16px', cursor: 'pointer', boxShadow: '0 5px 15px rgba(16, 185, 129, 0.4)' }}>
              {isSubmitting ? '⏳ SAVING...' : (editingId ? '💾 UPDATE RATE RULE' : '💾 SAVE RATE RULE')}
            </button>
          </div>
        </form>
      </div>

      {/* SEARCH BAR */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#1e293b', padding: '15px', borderRadius: '10px', border: '1px solid #334155' }}>
        <input type="text" placeholder="🔍 Search Customer, Source, Destination..." value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: 2, borderColor: '#38bdf8' }} />
        <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} style={{ ...inputStyle, flex: 1, borderColor: '#f59e0b', color: '#f59e0b' }}>
          <option value="">🏢 All Customers</option>
          {[...new Set(rates.map(r => r.Customer).filter(Boolean))].sort().map((c, i) => <option key={i} value={c}>{c}</option>)}
        </select>
      </div>

      {/* DATA TABLE */}
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '15px', overflowX: 'auto', padding: '20px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase', borderBottom: '2px solid #334155' }}>
            <tr>
              <th style={{ padding: '15px 10px' }}>CUSTOMER</th>
              <th style={{ padding: '15px 10px', color: '#10b981' }}>SOURCE</th>
              <th style={{ padding: '15px 10px' }}>DESTINATION</th>
              <th style={{ padding: '15px 10px', color: '#10b981' }}>CALC TYPE / FORMULA</th>
              <th style={{ padding: '15px 10px', color: '#10b981' }}>RATE ₹</th>
              <th style={{ padding: '15px 10px', color: '#f59e0b' }}>RTKM</th>
              <th style={{ padding: '15px 10px', color: '#c084fc' }}>EFFECTIVE PERIOD</th>
              <th style={{ padding: '15px 10px', textAlign: 'center' }}>STATUS</th>
              <th style={{ padding: '15px 10px', textAlign: 'center' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: '30px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: '30px', textAlign: 'center', color: '#ef4444' }}>No rate rules found — pehla rule upar ke form se add karein!</td></tr>
            ) : (
              filtered.map(r => {
                const isActive = r.Status !== 'Inactive';
                const ct = CALC_TYPES.find(c => c.key === r.Calc_Type);
                const ws = windowState(r);
                const wsColor = ws === 'LIVE' ? '#10b981' : ws === 'UPCOMING' ? '#38bdf8' : '#64748b';
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #1e293b', color: isActive ? '#cbd5e1' : '#64748b', fontSize: '13px', opacity: isActive ? 1 : 0.6 }}
                    onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '15px 10px' }}>{r.Customer}</td>
                    <td style={{ padding: '15px 10px', color: isActive ? '#10b981' : '#64748b', fontWeight: 'bold' }}>{r.Source}</td>
                    <td style={{ padding: '15px 10px' }}>{r.Destination}</td>
                    <td style={{ padding: '15px 10px' }} title={ct?.formula}>
                      <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '1px 8px' }}>{ct?.label || r.Calc_Type}</span>
                      <div style={{ fontSize: '10px', color: '#64748b', marginTop: '3px' }}>{ct?.formula}</div>
                    </td>
                    <td style={{ padding: '15px 10px', color: isActive ? '#10b981' : '#64748b', fontWeight: 'bold' }}>₹{r.Rate_Value}</td>
                    <td style={{ padding: '15px 10px', color: '#f59e0b' }}>{isRtkmType(r.Calc_Type) ? (r.RTKM_Distance > 0 ? `${r.RTKM_Distance} km` : <span style={{ color: '#64748b' }} title="Billing me RTKM route master se aayega">route master</span>) : '—'}</td>
                    <td style={{ padding: '15px 10px' }}>
                      <span style={{ color: '#c084fc' }}>{r.Effective_From} → {r.Effective_To || 'open'}</span>
                      <span style={{ marginLeft: '8px', fontSize: '9px', fontWeight: 'bold', color: wsColor, border: `1px solid ${wsColor}`, borderRadius: '10px', padding: '1px 6px' }}>{ws}</span>
                    </td>
                    <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                      <button onClick={() => handleToggleStatus(r.id, r.Status || 'Active')}
                        style={{ background: isActive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: isActive ? '#10b981' : '#ef4444', border: `1px solid ${isActive ? '#10b981' : '#ef4444'}`, padding: '4px 10px', borderRadius: '20px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}>
                        {isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
                      </button>
                    </td>
                    <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                        <button onClick={() => handleEdit(r)} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }} title="Edit">✏️ Edit</button>
                        <button onClick={() => handleDelete(r.id)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }} title="Delete">🗑️ Delete</button>
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
