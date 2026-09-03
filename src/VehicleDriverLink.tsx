// @ts-nocheck
// 🔗 LINK VEHICLE & DRIVER — live PostgreSQL.
//
// One live link per vehicle and per driver, enforced server-side: POST
// /masters/assignments releases whatever either side was on and creates the new
// link in a single transaction. The Firestore version only appended a row and
// warned about clashes in a confirm dialog, so a truck could end up with two
// live drivers and the readers had to sort by date and hope.
//
// Unlinking is a RELEASE, not a delete. Who drove what, and when, is history the
// settlement and shortage screens still refer to.
import React, { useState, useEffect, useCallback, useMemo } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const MASTERS = `${API}/api/v1/masters`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const up = (s: any) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function VehicleDriverLink() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const [selectedVehicleName, setSelectedVehicleName] = useState('');
  const [selectedDriverName, setSelectedDriverName] = useState('');
  const [assignDate, setAssignDate] = useState(new Date().toISOString().split('T')[0]);
  const [listSearch, setListSearch] = useState('');
  const [showReleased, setShowReleased] = useState(false);

  const fetchData = useCallback(async () => {
    setErr('');
    try {
      const [v, d, a] = await Promise.all([
        fetchJson(`${MASTERS}/vehicles?limit=1000`),
        fetchJson(`${MASTERS}/drivers?limit=1000`),
        fetchJson(`${MASTERS}/assignments`),
      ]);
      setVehicles(v.vehicles ?? []);
      setDrivers(d.drivers ?? []);
      setRecords(a.assignments ?? []);
    } catch (e: any) {
      setErr(`Link data could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVehicleName || !selectedDriverName) return alert('⚠️ कृपया गाड़ी और ड्राइवर दोनों चुनें!');

    const vObj = vehicles.find((v) => up(v.vehicle_no) === up(selectedVehicleName));
    // The driver datalist shows "NAME (mobile)", so the name is the part before '('.
    const rawDriverName = selectedDriverName.split('(')[0].trim();
    const dObj = drivers.find((d) => up(d.name) === up(rawDriverName));

    // Both sides must exist in the master: the link is a foreign key now, not a
    // pair of free-text names, so a typo cannot create a phantom assignment.
    if (!vObj) return alert(`⚠️ "${selectedVehicleName}" is not in the vehicle master.\n\nAdd it in Our Vehicle Fleet first.`);
    if (!dObj) return alert(`⚠️ "${rawDriverName}" is not in the driver master.\n\nAdd them in Driver Master first.`);

    // The server will release these anyway; warning first means the operator is
    // not surprised by it.
    const live = records.filter((r) => !r.released_at);
    const vClash = live.find((r) => r.vehicle_id === vObj.id);
    const dClash = live.find((r) => r.driver_id === dObj.id);
    if (vClash && !window.confirm(`⚠️ ${vObj.vehicle_no} is currently linked to ${vClash.driver_name}.\n\nRe-linking releases that pairing (the history is kept). Continue?`)) return;
    if (dClash && !window.confirm(`⚠️ ${dObj.name} is currently linked to ${dClash.vehicle_no}.\n\nRe-linking releases that pairing. Continue?`)) return;

    setIsSubmitting(true);
    try {
      await fetchJson(`${MASTERS}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicle_id: vObj.id,
          driver_id: dObj.id,
          remarks: assignDate ? `assigned ${assignDate}` : null,
        }),
      });
      setSelectedVehicleName('');
      setSelectedDriverName('');
      alert(`✅ ${vObj.vehicle_no} → ${dObj.name} linked.\n\nAny previous link on either side has been released.`);
      fetchData();
    } catch (e: any) {
      alert(`❌ Link not saved.\n\n${e.message}`);
    }
    setIsSubmitting(false);
  };

  const handleRelease = async (r: any) => {
    if (!window.confirm(`Release ${r.vehicle_no} from ${r.driver_name}?\n\nThe record stays as history — it is marked released, not deleted.`)) return;
    try {
      await fetchJson(`${MASTERS}/assignments/${r.id}`, { method: 'DELETE' });
      fetchData();
    } catch (e: any) {
      alert(`❌ ${e.code === 'NOT_LINKED' ? 'That link is already released.' : 'Release failed.'}\n\n${e.message}`);
    }
  };

  const filteredRecords = useMemo(() => {
    const q = listSearch.toLowerCase();
    return records
      .filter((r) => showReleased || !r.released_at)
      .filter((r) => !q
        || String(r.vehicle_no ?? '').toLowerCase().includes(q)
        || String(r.driver_name ?? '').toLowerCase().includes(q)
        || String(r.driver_mobile ?? '').toLowerCase().includes(q));
  }, [records, listSearch, showReleased]);

  const liveCount = records.filter((r) => !r.released_at).length;

  if (loading) {
    return <div style={{ color: '#22d3ee', padding: '40px', textAlign: 'center', fontSize: '20px', background: 'radial-gradient(circle at top left, #121c38, #0a1024)', height: '100vh' }}>Loading from PostgreSQL…</div>;
  }

  const inputStyle = { background: 'rgba(18, 28, 56, 0.6)', color: '#fff', border: '1px solid rgba(39, 57, 95, 0.8)', padding: '12px 16px', borderRadius: '10px', outline: 'none', fontSize: '14px', width: '100%', boxSizing: 'border-box' as const };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #121c38, #0a1024)' }}>

      <div style={{ marginBottom: '25px' }}>
        <h1 style={{ margin: 0, color: '#f6f8fd', fontSize: 'clamp(22px,4vw,30px)', fontWeight: 900 }}>🔗 Link Vehicle &amp; Driver</h1>
        <p style={{ color: '#9aadd4', margin: '6px 0 0', fontSize: 14 }}>
          Live PostgreSQL · one live link per vehicle and per driver, enforced server-side
          {liveCount ? ` · ${liveCount} active` : ''}
        </p>
      </div>

      {err && (
        <div style={{ background: 'rgba(255, 107, 129,0.1)', border: '1px solid #ff6b81', color: '#fca5a5', padding: '14px 18px', borderRadius: 12, marginBottom: 20, fontSize: 14 }}>
          ⚠️ {err}
          <div style={{ color: '#9aadd4', marginTop: 6, fontSize: 12 }}>Reads <code>{MASTERS}/assignments</code>. Check that the ERP API is running.</div>
        </div>
      )}

      {/* 🛸 FORM */}
      <div style={{ background: 'rgba(24, 36, 74, 0.4)', backdropFilter: 'blur(12px)', border: '1px solid rgba(34, 211, 238, 0.4)', borderRadius: '20px', padding: '25px', marginBottom: '30px', boxShadow: '0 10px 30px -10px rgba(34, 211, 238, 0.25)' }}>
        <form onSubmit={handleLinkSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '25px', alignItems: 'end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ color: '#22d3ee', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Search &amp; Select Vehicle *</label>
            <input list="vehicle-search-list" placeholder="Type vehicle no…" value={selectedVehicleName}
              onChange={(e) => setSelectedVehicleName(e.target.value.toUpperCase())} required
              style={{ ...inputStyle, borderColor: '#22d3ee' }} autoComplete="off" />
            <datalist id="vehicle-search-list">
              {vehicles.map((v) => v.vehicle_no ? <option key={v.id} value={v.vehicle_no} /> : null)}
            </datalist>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ color: '#2fe39b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Search &amp; Select Driver *</label>
            <input list="driver-search-list" placeholder="Type driver name or mobile…" value={selectedDriverName}
              onChange={(e) => setSelectedDriverName(e.target.value)} required
              style={{ ...inputStyle, borderColor: '#2fe39b' }} autoComplete="off" />
            <datalist id="driver-search-list">
              {drivers.filter((d) => d.status === 'ACTIVE').map((d) => (
                <option key={d.id} value={`${d.name} (${d.mobile || 'No Mobile'})`} />
              ))}
            </datalist>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ color: '#ffb224', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Assignment Date</label>
            <input type="date" value={assignDate} onChange={(e) => setAssignDate(e.target.value)}
              style={{ ...inputStyle, borderColor: '#ffb224', colorScheme: 'dark' }} />
          </div>

          <button type="submit" disabled={isSubmitting}
            style={{ background: isSubmitting ? '#27395f' : 'linear-gradient(135deg, #3b82f6, #7c8cff)', color: 'white', border: 'none', padding: '12px 25px', borderRadius: '10px', fontWeight: 'bold', cursor: isSubmitting ? 'not-allowed' : 'pointer', boxShadow: '0 0 15px rgba(59, 130, 246, 0.3)', height: '46px', fontSize: '14px' }}>
            {isSubmitting ? '⌛ Linking…' : '🔗 Link Them'}
          </button>
        </form>
      </div>

      {/* 📋 RECORDS */}
      <div style={{ background: 'rgba(24, 36, 74, 0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', overflow: 'hidden' }}>
        <div style={{ padding: '18px 25px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <input placeholder="🔍 Search vehicle, driver or mobile…" value={listSearch} onChange={(e) => setListSearch(e.target.value)}
            style={{ ...inputStyle, flex: 2, minWidth: 220 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#9aadd4', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={showReleased} onChange={(e) => setShowReleased(e.target.checked)} style={{ accentColor: '#ffb224' }} />
            Show released links (history)
          </label>
          <button onClick={fetchData} style={{ background: '#18244a', color: '#22d3ee', border: '1px solid #22d3ee', padding: '10px 16px', borderRadius: 8, fontWeight: 'bold', cursor: 'pointer', fontSize: 13 }}>🔄 Refresh</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.5fr 1fr 1fr', padding: '15px 25px', background: 'rgba(0,0,0,0.3)', borderBottom: '2px solid #27395f', color: '#ffb224', fontSize: '11px', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '1px' }}>
          <div>Vehicle Identity</div>
          <div>Assigned Driver</div>
          <div>Assigned On</div>
          <div style={{ textAlign: 'right' }}>Status</div>
        </div>

        {filteredRecords.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#5d7196' }}>
            {records.length === 0 ? 'No links yet — create one above.' : 'No matching records.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {filteredRecords.map((r, index) => {
              const isLive = !r.released_at;
              return (
                <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.5fr 1fr 1fr', padding: '20px 25px', borderBottom: index === filteredRecords.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)', alignItems: 'center', opacity: isLive ? 1 : 0.55 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                    <div style={{ width: '45px', height: '45px', borderRadius: '50%', border: '2px solid #22d3ee', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#22d3ee', background: '#18244a', fontSize: '20px' }}>🚛</div>
                    <div>
                      <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '16px' }}>{r.vehicle_no}</div>
                      <div style={{ color: '#9aadd4', fontSize: '12px', marginTop: '2px' }}>Asset attached</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                    <div style={{ width: '45px', height: '45px', borderRadius: '50%', border: '2px solid #2fe39b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2fe39b', background: '#18244a', fontSize: '20px' }}>👨‍✈️</div>
                    <div>
                      <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '16px' }}>{r.driver_name}</div>
                      <div style={{ color: '#9aadd4', fontSize: '12px', marginTop: '2px' }}>📞 {r.driver_mobile || 'N/A'}</div>
                    </div>
                  </div>

                  <div style={{ color: '#c4d1ea', fontSize: '14px', fontWeight: 'bold' }}>
                    {r.assigned_at ? new Date(r.assigned_at).toLocaleDateString('en-GB') : '—'}
                    {!isLive && (
                      <div style={{ color: '#5d7196', fontSize: 11, fontWeight: 'normal' }}>
                        released {new Date(r.released_at).toLocaleDateString('en-GB')}
                      </div>
                    )}
                  </div>

                  <div style={{ textAlign: 'right', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {isLive ? (
                      <>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(47, 227, 155, 0.1)', color: '#2fe39b', padding: '6px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', border: '1px solid #2fe39b' }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 5px #2fe39b' }} />
                          LINKED
                        </span>
                        <button onClick={() => handleRelease(r)} title="Release this pairing"
                          style={{ background: 'rgba(255, 107, 129,.12)', border: '1px solid #ff6b81', color: '#ff6b81', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}>
                          ✕
                        </button>
                      </>
                    ) : (
                      <span style={{ background: 'rgba(100,116,139,0.15)', color: '#9aadd4', padding: '6px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', border: '1px solid #3d548a' }}>
                        RELEASED
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
