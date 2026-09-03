// @ts-nocheck
import React, { useState, useEffect } from 'react';
import GlobalPagination, { usePagination } from './components/GlobalPagination';
import { extractDocument } from './lib/aiScanner';
import { uploadMedia, slug } from './lib/uploadMedia';
import { scopeCurrent } from './lib/rbac';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const MASTERS = `${API}/api/v1/masters`;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

// ── Form ⇄ column mapping ──────────────────────────────────────────────────
// The fleet form grew its own vocabulary over years of use ('Own'/'Attached',
// 'System Active', '10+1' tyres, veh_class as free text). PostgreSQL has enums
// and typed columns. Both directions are mapped here, at the data boundary, so
// the form keeps the words the office uses and the database keeps its integrity.
const VEHICLE_KINDS = ['TANKER', 'TRUCK', 'TRAILER', 'TIPPER', 'CONTAINER', 'OTHER'];

// Free-text class -> the vehicle_kind enum. Unrecognised text becomes OTHER
// rather than failing the save: refusing a vehicle because its class was typed
// unusually would be worse than recording it as OTHER.
const toKind = (txt: any) => {
  const t = String(txt ?? '').toUpperCase();
  return VEHICLE_KINDS.find((k) => t.includes(k)) ?? (t ? 'OTHER' : null);
};
const toOwnership = (v: any) => {
  const t = String(v ?? '').toUpperCase();
  if (t.startsWith('ATTACH')) return 'ATTACHED';
  if (t.startsWith('LEAS')) return 'LEASED';
  return 'OWNED';
};
const fromOwnership = (v: any) => (String(v ?? '') === 'ATTACHED' ? 'Attached' : String(v ?? '') === 'LEASED' ? 'Leased' : 'Own');
// record_status is ACTIVE | INACTIVE | BLACKLISTED | ARCHIVED; the form says
// 'System Active' / 'Blocked'.
const toStatus = (v: any) => {
  const t = String(v ?? '').toUpperCase();
  if (t.includes('BLOCK') || t.includes('BLACKLIST')) return 'BLACKLISTED';
  if (t.includes('INACTIVE') || t.includes('SOLD') || t.includes('ARCHIV')) return 'INACTIVE';
  return 'ACTIVE';
};
const fromStatus = (v: any) => (String(v ?? '') === 'ACTIVE' ? 'System Active' : String(v ?? '') === 'BLACKLISTED' ? 'Blocked' : 'Inactive');
// '10+1' means ten wheels plus a spare — the count for arithmetic is the sum.
const tyreCountOf = (cfg: any) => {
  const parts = String(cfg ?? '').match(/\d+/g);
  if (!parts) return null;
  const n = parts.reduce((a, x) => a + parseInt(x, 10), 0);
  return n > 0 && n < 100 ? n : null;
};
const num = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
const dt = (v: any) => (v ? String(v).slice(0, 10) : null);

// Resolve a company either way round — by id when the row carries one, else by
// name. Names are compared trimmed and case-folded on purpose: the master holds
// 'M/S JAISWAL ENTERPRISE  ' with trailing spaces, and an exact === against a
// value that has been through a form control is one stray space from silently
// unlinking a lorry from its operating company.
const sameName = (a: any, b: any) =>
  String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();

const findCompany = (companies: any[], id: any, name: any) =>
  (id ? companies.find((c: any) => String(c.id) === String(id)) : null)
  ?? (name ? companies.find((c: any) => sameName(c.company_name, name)) : null)
  ?? null;

const vehicleFromApi = (v: any, companies: any[]) => ({
  ...v,
  own_attach: fromOwnership(v.ownership),
  veh_class: v.vehicle_type ?? '',
  modal_no: v.make_model ?? '',
  reg_date: v.registration_date ?? '',
  fuel: v.fuel_type ?? 'Diesel',
  g_v_w: v.gross_weight ?? '',
  unladen_wt: v.unladen_weight ?? '',
  no_of_tyres: v.tyre_config ?? (v.tyre_count ? String(v.tyre_count) : '10+1'),
  branch_name: v.branch ?? '',
  company_name: findCompany(companies, v.company_id, v.company_name)?.company_name ?? '',
  status: fromStatus(v.status),
  approval: v.approval_status === 'APPROVED' ? 'Approved' : v.approval_status === 'REJECTED' ? 'Rejected' : 'Pending',
  driver_name: v.linked_driver ?? '',
  vehicle_value: v.vehicle_value ?? '0',
});

const vehicleToApi = (f: any, companies: any[]) => {
  const body: any = {
    vehicle_no: String(f.vehicle_no ?? '').toUpperCase().replace(/\s+/g, ''),
    owner_name: f.owner_name || null,
    ownership: toOwnership(f.own_attach),
    chassis_no: f.chassis_no || null,
    engine_no: f.engine_no || null,
    capacity_kl: num(f.capacity_kl),
    make_model: f.modal_no || null,
    registration_date: dt(f.reg_date),
    mfg_date: dt(f.mfg_date),
    fuel_type: f.fuel || null,
    gross_weight: num(f.g_v_w),
    unladen_weight: num(f.unladen_wt),
    hypothecated_to: f.hypothecated_to || null,
    vehicle_value: num(f.vehicle_value),
    rc_photo_url: f.rc_photo_url || null,
    fastag_id: f.fastag_id || null,
    branch: f.branch_name || null,
    vehicle_category: f.vehicle_category || null,
    plant_attached: f.plant_attached || null,
    contract_ref: f.contract_ref || null,
    contract_validity: dt(f.contract_validity),
    tyre_config: f.no_of_tyres || null,
    tyre_count: tyreCountOf(f.no_of_tyres),
    status: toStatus(f.status),
    approval_status: String(f.approval ?? '').toUpperCase().startsWith('APPROV') ? 'APPROVED'
      : String(f.approval ?? '').toUpperCase().startsWith('REJECT') ? 'REJECTED' : 'PENDING',
  };
  const kind = toKind(f.veh_class);
  if (kind) body.vehicle_type = kind;
  // ALWAYS SEND company_id, INCLUDING null.
  //
  // The old line only assigned when a company matched, so clearing the dropdown
  // back to "-- Select Company --" left the previous owner on the lorry: the key
  // never reached the PATCH, and a PATCH only writes the keys it is given.
  const co = findCompany(companies, null, f.company_name);
  body.company_id = co ? co.id : null;
  return body;
};

export default function Vehical() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [activeVehSet, setActiveVehSet] = useState<Set<string>>(new Set()); // vehicles currently on a trip
  
  // 🔍 स्मार्ट फिल्टर्स के स्टेट्स
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  
  const [editingId, setEditingId] = useState<string | null>(null);

  // 🚀 RC Upload States
  const [rcFile, setRcFile] = useState<File | null>(null);
  const [uploadingRC, setUploadingRC] = useState(false);

  // 🌟 MERGED STATE: Old Fields + New IOCL e-TRP Fields + 🛞 TYRE CONFIG
  const [formData, setFormData] = useState({
    vehicle_no: '', company_name: '', branch_name: '', owner_name: '', own_attach: 'Own', 
    veh_class: '', capacity_kl: '', chassis_no: '', engine_no: '', 
    mfg_date: '', reg_date: '', modal_no: '', fuel: 'Diesel', 
    g_v_w: '', unladen_wt: '', hypothecated_to: '', 
    driver_name: '', driver_mobile: '', rc_photo_url: '', vehicle_value: '0', 
    status: 'System Active', approval: 'Pending',
    
    // 🛢️ NEW IOCL e-TRP FIELDS
    vehicle_category: 'Bulk Trucks',
    plant_attached: '', 
    contract_ref: '', 
    contract_validity: '', 
    fastag_id: '',
    
    // 🛞 NEW: TYRE MANAGEMENT LINK FIELD
    no_of_tyres: '10+1' // Default
  });

  useEffect(() => { 
    fetchVehicles(); 
    fetchMasters(); 
  }, []);

  const [fetchError, setFetchError] = useState('');

  // 🧱 OLD-DATA FALLBACK: purani vehicles me naye fields nahi hote — defaults
  // bhar kar normalize karte hain taaki HAR historical vehicle render ho,
  // search/filters kaam karein, aur FASTag mapping stable rahe.
  const normalizeVehicle = (v: any) => ({
    ...v,
    vehicle_no: v.vehicle_no || v.Vehicle_No || v.vehical_no || v.Vehical_No || '',
    own_attach: v.own_attach || v.asset_type || 'Own',
    owner_name: v.owner_name || v.Owner_Name || v.asset_owner_name || '',
    company_name: v.company_name || v.Company_Name || v.operating_company || '',
    status: v.status || 'System Active',
    fastag_id: v.fastag_id || '',
    no_of_tyres: v.no_of_tyres || v.No_of_Tyres || '10+1',
    vehicle_category: v.vehicle_category || 'Bulk Trucks',
  });

  const fetchVehicles = async () => {
    setLoading(true);
    setFetchError('');
    try {
      // Trip counts, the soonest expiry and the currently-linked driver arrive
      // computed with each row. The old screen read every trip in the business
      // just to work out which trucks were on the road.
      const [v, m] = await Promise.all([
        fetchJson(`${MASTERS}/vehicles?limit=1000`),
        fetchJson(`${FIN}/masters/companies`),
      ]);
      setCompanies(m.companies ?? []);
      setBranches((m.branches ?? []).map((b: string) => ({ id: b, branch_name: b })));
      // 🔐 RBAC: scoped roles see only their own vehicles.
      setVehicles(scopeCurrent((v.vehicles ?? []).map((x: any) => vehicleFromApi(x, m.companies ?? []))));
      // 🔴 On-trip set, from the trip rollup the API already returns.
      const norm = (x: any) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const active = await fetchJson(`${API}/api/v1/ops/trips?exclude_status=COMPLETED,SETTLED,CANCELLED&limit=1000`)
        .catch(() => ({ trips: [] }));
      setActiveVehSet(new Set((active.trips ?? []).map((t: any) => norm(t.vehicle_no)).filter(Boolean)));
    } catch (e: any) {
      setVehicles([]);
      setFetchError(`Fleet could not load from ${API} — ${e.message}. Check that the ERP API is running.`);
    }
    setLoading(false);
  };

  // Masters now arrive with the vehicles in one call; kept as a no-op so the
  // existing mount effect and any refresh buttons keep working.
  const fetchMasters = async () => {};

  const handleInputChange = (e: any) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: name === 'vehicle_no' ? value.toUpperCase().replace(/\s+/g, '') : value });
  };

  // 🌍 LIVE SERVER LINK & MAMTA AI AUTO-FILL
  // The RC file is STORED first (POST /api/v1/files via uploadMedia) and its
  // permanent URL kept in rc_photo_url — this button used to run only the OCR
  // and discard the file, which is why almost no vehicle had an RC on record.
  // OCR stays a best-effort bonus: a dead Ollama must not lose the document.
  const handleRCUpload = async () => {
    if (!rcFile) return alert("⚠️ Please select an RC photo first!");

    setUploadingRC(true);
    const vKey = slug(formData.vehicle_no || 'new-vehicle');
    const uploadPromise = uploadMedia(rcFile, `vehicle-docs/${vKey}/rc_${Date.now()}.jpg`);

    try {
      const { url } = await uploadPromise;
      setFormData(prev => ({ ...prev, rc_photo_url: url }));
    } catch (err) {
      console.error(err);
      alert('❌ RC upload nahi hui — network check karke dobara try karein.');
      setUploadingRC(false);
      return;
    }

    try {
      // 🤖 100% LOCAL extraction via Gemma 4 vision (no cloud).
      const ex = await extractDocument(rcFile, 'Vehicle Registration Certificate (RC)');
      setFormData(prev => ({
        ...prev,
        vehicle_no: (ex.document_number || '').toUpperCase().replace(/\s+/g, '') || prev.vehicle_no,
        reg_date: ex.issue_date || prev.reg_date,
      }));
      alert("✅ RC file save ho gayi + Mamta AI (local Gemma 4) ne padh liya. Vehicle No & Reg date auto-fill — verify karke SAVE dabayen.");
    } catch (error: any) {
      const offline = error?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(error?.message || '');
      alert(`✅ RC file save ho gayi.\n${offline ? '⚠️ Local AI engine (Ollama) band hai — scan nahi hua, fields manually bharein.' : '⚠️ RC scan nahi ho payi (file phir bhi save hai) — fields manually bharein.'}\n\nSAVE dabana na bhulein.`);
    }
    setUploadingRC(false);
  };

  const handleSave = async () => {
    if (!formData.vehicle_no) return alert('⚠️ Vehicle number is required.');
    if (formData.own_attach === 'Attached' && !formData.owner_name) {
      return alert('⚠️ Owner name is required for an attached vehicle.');
    }
    try {
      const body = vehicleToApi(formData, companies);
      if (editingId) {
        await fetchJson(`${MASTERS}/vehicles/${editingId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        alert('✅ Vehicle updated.');
      } else {
        const out = await fetchJson(`${MASTERS}/vehicles`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        // No companion LEDGERS row is created here. An owned truck's asset
        // account and an attached owner's creditor account are created by TARA on
        // first posting, under the canonical name; creating one now left an empty
        // duplicate that never received an entry.
        alert(`✅ ${out.vehicle.vehicle_no} registered.`);
      }
      resetForm();
      fetchVehicles();
    } catch (err: any) {
      const hint = {
        DUPLICATE: 'A vehicle with that number already exists.',
        CONSTRAINT: 'A value was rejected by the database — check the class, status or dates.',
      }[err.code];
      alert(`❌ ${hint ?? 'Vehicle not saved.'}\n\n${err.message}`);
    }
  };

  const handleEdit = (v: any) => {
    // Rows arrive pre-mapped by vehicleFromApi, so the form reads them directly.
    setFormData({
      ...v,
      capacity_kl: v.capacity_kl ?? '',
      vehicle_category: v.vehicle_category || 'Bulk Trucks',
      plant_attached: v.plant_attached || '',
      contract_ref: v.contract_ref || '',
      contract_validity: v.contract_validity || '',
      hypothecated_to: v.hypothecated_to || '',
      mfg_date: v.mfg_date || '',
      fastag_id: v.fastag_id || '',
      rc_photo_url: v.rc_photo_url || '',
      vehicle_value: v.vehicle_value ?? '0',
    });
    setEditingId(v.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name}?\n\nIf it has run trips the record is marked INACTIVE instead of deleted, so those trips stay resolvable.`)) return;
    try {
      const out = await fetchJson(`${MASTERS}/vehicles/${id}`, { method: 'DELETE' });
      alert(out.hard_deleted ? `✅ ${name} deleted.` : `✅ ${name} marked INACTIVE.\n\n${out.detail ?? ''}`);
      fetchVehicles();
    } catch (e: any) { alert(`❌ Not removed.\n\n${e.message}`); }
  };

  const resetForm = () => {
    setFormData({ 
      vehicle_no: '', company_name: '', branch_name: '', owner_name: '', own_attach: 'Own', 
      veh_class: '', capacity_kl: '', chassis_no: '', engine_no: '', 
      mfg_date: '', reg_date: '', modal_no: '', fuel: 'Diesel', 
      g_v_w: '', unladen_wt: '', hypothecated_to: '', 
      driver_name: '', driver_mobile: '', rc_photo_url: '', vehicle_value: '0', 
      status: 'System Active', approval: 'Pending',
      vehicle_category: 'Bulk Trucks', plant_attached: '', contract_ref: '', contract_validity: '', fastag_id: '',
      no_of_tyres: '10+1' 
    });
    setRcFile(null);
    setShowForm(false); setEditingId(null);
  };

  const uniqueOwners = Array.from(new Set(vehicles.filter(v => v.own_attach === 'Attached' && (v.owner_name || v.asset_owner_name)).map(v => v.owner_name || v.asset_owner_name)));

  const filteredVehicles = vehicles.filter(v => {
    const vNo = String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').toLowerCase();
    const fId = String(v.fastag_id || '').toLowerCase();
    const dName = String(v.driver_name || '').toLowerCase();
    
    const matchesSearch = vNo.includes(searchTerm.toLowerCase()) || dName.includes(searchTerm.toLowerCase()) || fId.includes(searchTerm.toLowerCase());
    
    const compName = String(v.company_name || v.operating_company || '');
    const matchesCompany = filterCompany ? compName === filterCompany : true;
    
    const ownerName = String(v.owner_name || v.asset_owner_name || '');
    const matchesOwner = filterOwner ? (filterOwner === 'Own' ? (v.own_attach === 'Own' || !ownerName) : ownerName === filterOwner) : true;
    
    return matchesSearch && matchesCompany && matchesOwner;
  });
  const pgFilteredVehicles = usePagination(filteredVehicles);

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #121c38, #0a1024)' }}>
      <style>{`
        .glass-card { background: rgba(24, 36, 74, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; transition: all 0.4s; }
        .glass-card:hover { transform: translateY(-5px); box-shadow: 0 15px 30px -10px rgba(34, 211, 238, 0.25); border: 1px solid rgba(34, 211, 238, 0.4); }
        .gradient-text { background: linear-gradient(135deg, #22d3ee, #818cf8, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #7c8cff); box-shadow: 0 0 20px rgba(124, 140, 255, 0.4); color: white; border: none; font-weight: bold; cursor: pointer; transition: all 0.3s; padding: 12px 25px; border-radius: 8px; }
        .glow-btn:hover { box-shadow: 0 0 35px rgba(124, 140, 255, 0.8); transform: scale(1.05); }
        .modern-input { background: rgba(18, 28, 56, 0.6); border: 1px solid rgba(39, 57, 95, 0.8); border-radius: 10px; color: white; padding: 10px 14px; outline: none; width: 100%; box-sizing: border-box; font-size: 13px;}
        .modern-input:focus { border-color: #22d3ee; box-shadow: 0 0 15px rgba(34, 211, 238, 0.3); background: rgba(18, 28, 56, 0.9); }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(10, 16, 36, 0.85); backdrop-filter: blur(10px); display: flex; justify-content: center; align-items: center; z-index: 9999; }
        .modal-content { background: #121c38; border: 1px solid #22d3ee; width: 95%; max-width: 1300px; max-height: 90vh; overflow-y: auto; padding: 30px; border-radius: 20px; box-shadow: 0 0 50px rgba(34, 211, 238, 0.2); }
        label { font-size: 11px; color: #9aadd4; display: block; margin-bottom: 4px; font-weight: bold; text-transform: uppercase; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900', letterSpacing: '-1px' }}>Prasad Fleet AI</h1>
          <p style={{ color: '#9aadd4', margin: '5px 0' }}>Vehicle Data, Owner Mapping & IOCL e-TRP Integration</p>
        </div>
        <button className="glow-btn" onClick={() => { resetForm(); setShowForm(true); }} style={{ borderRadius: '50px', fontSize: '15px' }}>
          + Initialize Vehicle
        </button>
      </div>

      {/* 🔍 स्मार्ट फ़िल्टरिंग सेक्शन */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '30px', flexWrap: 'wrap', background: 'rgba(24, 36, 74, 0.3)', padding: '15px', borderRadius: '15px', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ flex: 1, minWidth: '250px', position: 'relative' }}>
          <input placeholder="Search Vehicle, Driver or FASTag..." className="modern-input" style={{ paddingLeft: '40px' }} onChange={(e) => setSearchTerm(e.target.value)} />
          <span style={{ position: 'absolute', left: '12px', top: '10px', fontSize: '16px' }}>🔍</span>
        </div>
        
        <div style={{ flex: 1, minWidth: '200px' }}>
          <select className="modern-input" value={filterCompany} onChange={(e) => setFilterCompany(e.target.value)} style={{ color: filterCompany ? '#22d3ee' : 'white', fontWeight: filterCompany ? 'bold' : 'normal' }}>
            <option value="">🏢 All Companies</option>
            {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
          </select>
        </div>

        <div style={{ flex: 1, minWidth: '200px' }}>
          <select className="modern-input" value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)} style={{ color: filterOwner ? '#a78bfa' : 'white', fontWeight: filterOwner ? 'bold' : 'normal' }}>
            <option value="">👤 All Owners (Own + Attached)</option>
            <option value="Own" style={{ color: '#2fe39b', fontWeight: 'bold' }}>⭐ Only Own Assets (Prasad)</option>
            {uniqueOwners.map((owner: any, i) => <option key={i} value={owner}>🤝 {owner}</option>)}
          </select>
        </div>
      </div>

      {/* 🚨 FETCH ERROR BANNER — khali list ka reason ab hamesha dikhta hai */}
      {fetchError && (
        <div style={{ background: 'rgba(255, 107, 129,0.1)', border: '2px dashed #ff6b81', borderRadius: '15px', padding: '20px', marginBottom: '25px', color: '#fca5a5', fontWeight: 'bold', fontSize: '14px', lineHeight: 1.6 }}>
          {fetchError}
          <div style={{ marginTop: '12px' }}>
            <button onClick={fetchVehicles} style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>🔄 Retry</button>
          </div>
        </div>
      )}

      {/* 🚛 Grid List */}
      {loading ? <p style={{ color: '#22d3ee', textAlign: 'center', fontSize: '18px' }}>🔄 Syncing with Global Database...</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '30px' }}>
          {!fetchError && filteredVehicles.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '50px', color: '#9aadd4', fontSize: '15px' }}>
              {vehicles.length === 0
                ? '🚛 Database me abhi koi vehicle nahi mili. "+ Initialize Vehicle" se pehli vehicle add karein.'
                : `🔍 ${vehicles.length} vehicles me se koi filter/search se match nahi hui — filters clear karke dekhein.`}
            </div>
          )}
          {pgFilteredVehicles.slice.map((v) => {
            const isActive = String(v.status || 'Active').toLowerCase().includes('active');
            return (
            <div key={v.id} className="glass-card" style={{ padding: '25px', position: 'relative' }}>
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px', marginBottom: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span className="gradient-text" style={{ fontSize: '24px', fontWeight: '900' }}>{v.vehicle_no || v.Vehicle_No || v.vehical_no}</span>
                  <p style={{ margin: '5px 0 0 0', color: v.own_attach === 'Own' ? '#2fe39b' : '#ffb224', fontSize: '13px', fontWeight: 'bold' }}>
                    {v.own_attach} Asset {(v.owner_name || v.asset_owner_name) ? `• ${v.owner_name || v.asset_owner_name}` : ''}
                  </p>
                </div>
                <span style={{ fontSize: '10px', background: 'rgba(255, 178, 36,0.1)', color: '#ffb224', padding: '4px 8px', borderRadius: '12px', border: '1px solid #ffb224' }}>
                  {v.vehicle_category || 'Truck'}
                </span>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', color: '#dde5f4', fontSize: '12px' }}>
                <div>🏢 <b>{v.company_name || v.operating_company || 'N/A'}</b></div>
                <div>👤 <b>{v.driver_name || 'No Driver'}</b></div>
                
                {/* 🛞 TYRE CONFIG DISPLAY */}
                <div style={{ color: '#c4d1ea' }}>🛞 Tyres: <b style={{color: '#ffb224'}}>{v.no_of_tyres || '10+1'}</b></div>
                <div>📑 {v.rc_photo_url ? <a href={v.rc_photo_url} target="_blank" rel="noreferrer" style={{ color: '#2fe39b' }}>RC Attached ✓</a> : <span style={{ color: '#ff6b81' }}>No RC</span>}</div>
                
                <div style={{ gridColumn: 'span 2', color: '#c4d1ea' }}>🏷️ FASTag: <b style={{color: '#22d3ee'}}>{v.fastag_id || 'Not Set'}</b></div>
                
                <div style={{ gridColumn: 'span 2', borderTop: '1px dashed #27395f', paddingTop: '10px', marginTop: '5px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {(() => {
                    const norm = String(v.vehicle_no || v.Vehicle_No || v.vehical_no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                    const isMaint = /maint|offline|repair/i.test(String(v.status || ''));
                    const live = isMaint ? 'maintenance' : (activeVehSet.has(norm) ? 'transit' : 'available');
                    const cls = live === 'transit' ? 'pt-pill--transit' : live === 'maintenance' ? 'pt-pill--pending-unload' : 'pt-pill--completed';
                    const label = live === 'transit' ? 'In Transit' : live === 'maintenance' ? 'Maintenance' : 'Available';
                    return <span className={`pt-pill ${cls}`}>{label}</span>;
                  })()}
                  <span style={{ fontSize: '11px', color: '#5d7196' }}>Live status</span>
                </div>
              </div>
              
              <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
                <button onClick={() => handleEdit(v)} style={{ background: 'rgba(34, 211, 238, 0.1)', border: '1px solid #22d3ee', color: '#22d3ee', padding: '6px 15px', borderRadius: '50px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>✏️ Configure</button>
                <button onClick={() => handleDelete(v.id, v.vehicle_no)} style={{ background: 'transparent', border: '1px solid #ff6b81', color: '#ff6b81', padding: '6px 15px', borderRadius: '50px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>🗑️ Erase</button>
              </div>
            </div>
          )})}
        </div>
      )}
      {/* Cards, not a table -- the control is markup-agnostic on purpose. */}
      <GlobalPagination {...pgFilteredVehicles} label="vehicles" />

      {/* 🛸 MODAL FORM */}
      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 className="gradient-text" style={{ margin: 0, fontSize: '24px' }}>{editingId ? 'System Update: Asset Data' : 'Initialize New Asset & Ledger'}</h2>
              <button onClick={resetForm} style={{ background: 'transparent', color: '#ff6b81', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 768 ? 'repeat(3, 1fr)' : '1fr', gap: '25px' }}>
              
              {/* 1️⃣ COLUMN 1: CORE IDENTITY & e-TRP DATA */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                
                {/* Core Block */}
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '12px', border: '1px solid #27395f' }}>
                  <h4 style={{ color: '#22d3ee', margin: '0 0 15px 0' }}>1️⃣ CORE IDENTITY & OWNERSHIP</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div><label style={{color: '#22d3ee'}}>Vehicle Registration No. *</label><input className="modern-input" name="vehicle_no" style={{borderColor: '#22d3ee', fontWeight: 'bold', fontSize: '16px', textTransform: 'uppercase'}} value={formData.vehicle_no} onChange={handleInputChange} placeholder="e.g. AS 26C 5106" /></div>
                    
                    <div><label>Asset Type</label>
                      <select className="modern-input" name="own_attach" value={formData.own_attach} onChange={handleInputChange}>
                        <option value="Own">Own Asset (Fixed Asset)</option>
                        <option value="Attached">Attached Fleet (Sundry Creditor)</option>
                      </select>
                    </div>

                    {formData.own_attach === 'Attached' ? (
                      <div><label style={{ color: '#ffb224', fontWeight: 'bold' }}>Asset Owner Name (For Ledger) *</label><input className="modern-input" name="owner_name" style={{border: '1px solid #ffb224', background: 'rgba(255, 178, 36,0.05)'}} value={formData.owner_name} onChange={handleInputChange} placeholder="e.g. SANDEEP KUMAR PRASAD" /></div>
                    ) : (
                      <div><label style={{ color: '#22d3ee', fontWeight: 'bold' }}>Vehicle Value (₹) - For Asset Ledger</label><input type="number" className="modern-input" name="vehicle_value" style={{ border: '1px solid #22d3ee' }} value={formData.vehicle_value} onChange={handleInputChange} /></div>
                    )}

                    <div><label>Operating Company</label>
                      <select className="modern-input" name="company_name" value={formData.company_name} onChange={handleInputChange}>
                        <option value="">-- Select Company --</option>
                        {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
                      </select>
                    </div>

                    <div><label>Operating Branch</label>
                      <select className="modern-input" name="branch_name" value={formData.branch_name} onChange={handleInputChange}>
                        <option value="">-- Select Branch --</option>
                        {branches.map(b => <option key={b.id} value={b.branch_name}>{b.branch_name}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                {/* 🛢️ Oil Company / e-TRP Block */}
                <div style={{ background: 'rgba(255, 178, 36,0.05)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255, 178, 36,0.3)' }}>
                  <h4 style={{ color: '#ffb224', margin: '0 0 15px 0' }}>🛢️ IOCL e-TRP / FASTAG DATA</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div><label style={{color: '#ffb224'}}>Vehicle Category (e-TRP) *</label>
                      <select className="modern-input" name="vehicle_category" style={{borderColor: '#ffb224', fontWeight: 'bold', color: '#ffb224'}} value={formData.vehicle_category} onChange={handleInputChange}>
                        <option value="Bulk Trucks">Bulk Trucks</option>
                        <option value="Packed Trucks">Packed Trucks</option>
                        <option value="Others">Others</option>
                      </select>
                    </div>
                    <div><label>FASTag ID (Auto-Toll Map)</label><input className="modern-input" name="fastag_id" value={formData.fastag_id} onChange={handleInputChange} placeholder="e.g. 34161FA8203290D4CDCCB960" /></div>
                    <div><label>Plant Attached</label><input className="modern-input" name="plant_attached" value={formData.plant_attached} onChange={handleInputChange} placeholder="e.g. Indian Oil AOD / 7B03" /></div>
                    <div><label>Contract Ref No.</label><input className="modern-input" name="contract_ref" value={formData.contract_ref} onChange={handleInputChange} placeholder="e.g. LPG/BULK/TT/IOC/AS/2025-30/281" /></div>
                    <div><label>Contract Validity</label><input type="date" className="modern-input" name="contract_validity" value={formData.contract_validity} onChange={handleInputChange} style={{colorScheme:'dark'}}/></div>
                  </div>
                </div>

              </div>

              {/* 2️⃣ COLUMN 2: HARDWARE SPECS & 🛞 TYRE CONFIG */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '12px', border: '1px solid #27395f' }}>
                <h4 style={{ color: '#a78bfa', margin: '0 0 15px 0' }}>2️⃣ HARDWARE SPECS</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  
                  <div style={{ gridColumn: 'span 2' }}><label>Vehicle Class</label><input className="modern-input" name="veh_class" placeholder="e.g. Tanker / Trailer" value={formData.veh_class} onChange={handleInputChange} /></div>

                  {/* 🌟 SMART TYRE CONFIGURATION DATALIST 🌟 */}
                  <div style={{ gridColumn: 'span 2', background: 'rgba(255, 178, 36, 0.1)', padding: '10px', borderRadius: '8px', border: '1px dashed #ffb224' }}>
                    <label style={{color: '#ffb224'}}>🛞 Total Tyres (Wheel Config) *</label>
                    <input 
                      className="modern-input" 
                      list="tyre-config-options"
                      name="no_of_tyres" 
                      value={formData.no_of_tyres} 
                      onChange={handleInputChange} 
                      placeholder="Select or type (e.g. 16+1)"
                      style={{borderColor: '#ffb224', fontWeight: 'bold', color: '#ffb224'}}
                    />
                    <datalist id="tyre-config-options">
                      <option value="4+1" />
                      <option value="6+1" />
                      <option value="10+1" />
                      <option value="12+1" />
                      <option value="14+1" />
                      <option value="16+1" />
                      <option value="18+1" />
                      <option value="22+1" />
                    </datalist>
                    <small style={{color: '#c4d1ea', fontSize: '10px'}}>Type custom config (e.g. '16+1') if not in list. Links to Tyre Mgmt.</small>
                  </div>

                  <div><label>Capacity (KL/Ton)</label><input type="number" className="modern-input" name="capacity_kl" value={formData.capacity_kl} onChange={handleInputChange} placeholder="e.g. 18" /></div>
                  <div><label>Fuel Core</label>
                    <select className="modern-input" name="fuel" value={formData.fuel} onChange={handleInputChange}>
                      <option value="Diesel">Diesel</option><option value="CNG">CNG</option><option value="EV">EV</option>
                    </select>
                  </div>

                  <div style={{ gridColumn: 'span 2' }}><label>Chassis Code</label><input className="modern-input" name="chassis_no" value={formData.chassis_no} onChange={e => setFormData({...formData, chassis_no: e.target.value.toUpperCase()})} placeholder="MAT..." /></div>
                  <div style={{ gridColumn: 'span 2' }}><label>Engine Serial Code</label><input className="modern-input" name="engine_no" value={formData.engine_no} onChange={e => setFormData({...formData, engine_no: e.target.value.toUpperCase()})} /></div>
                  
                  <div><label>Mfg Date</label><input type="date" className="modern-input" name="mfg_date" value={formData.mfg_date} onChange={handleInputChange} style={{colorScheme:'dark'}}/></div>
                  <div><label>Modal No</label><input className="modern-input" name="modal_no" value={formData.modal_no} onChange={handleInputChange} /></div>

                  <div><label>Gross Wt (GVW)</label><input type="number" className="modern-input" name="g_v_w" value={formData.g_v_w} onChange={handleInputChange} /></div>
                  <div><label>Unladen Wt</label><input type="number" className="modern-input" name="unladen_wt" value={formData.unladen_wt} onChange={handleInputChange} /></div>
                </div>
              </div>

              {/* 3️⃣ COLUMN 3: LEGAL, PILOT & RC UPLOAD */}
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '12px', border: '1px solid #27395f' }}>
                <h4 style={{ color: '#2fe39b', margin: '0 0 15px 0' }}>3️⃣ LEGAL & PILOT</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  
                  <div><label>Registration Date</label><input type="date" className="modern-input" name="reg_date" value={formData.reg_date} onChange={handleInputChange} style={{colorScheme:'dark'}}/></div>
                  <div><label>Hypothecated To (Bank/Financer)</label><input className="modern-input" name="hypothecated_to" value={formData.hypothecated_to} onChange={handleInputChange} placeholder="e.g. AXIS BANK LTD" /></div>
                  
                  <div style={{ display: 'flex', gap: '10px' }}>
                      <div style={{ flex: 1 }}><label>Assigned Pilot</label><input className="modern-input" name="driver_name" value={formData.driver_name} onChange={handleInputChange} /></div>
                      <div style={{ flex: 1 }}><label>Pilot Mobile</label><input className="modern-input" name="driver_mobile" value={formData.driver_mobile} onChange={handleInputChange} /></div>
                  </div>

                  <div>
                    <label>System Status</label>
                    <select className="modern-input" name="status" value={formData.status} onChange={handleInputChange} style={{ color: formData.status.includes('Active') ? '#2fe39b' : '#ff6b81', fontWeight: 'bold' }}>
                      <option value="System Active">🟢 System Active</option>
                      <option value="Offline / Maintenance">🔴 Offline / Maintenance</option>
                      <option value="Sold / Blacklisted">⚫ Sold / Blacklisted</option>
                    </select>
                  </div>

                  {/* 🌟 DOCUMENT SCANNER (RC UPLOAD) */}
                  <div style={{ background: 'rgba(34, 211, 238, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #22d3ee', marginTop: '10px', textAlign: 'center' }}>
                    <label style={{ color: '#22d3ee', fontWeight: 'bold', marginBottom: '10px', fontSize: '13px' }}>📎 Upload Original RC (2TB Drive)</label>
                    <input type="file" accept="image/*,.pdf" onChange={(e) => setRcFile(e.target.files ? e.target.files[0] : null)} style={{ color: '#9aadd4', marginBottom: '15px', fontSize: '12px', width: '100%', background: '#121c38', padding: '10px', borderRadius: '8px' }} />
                    
                    <button onClick={handleRCUpload} disabled={!rcFile || uploadingRC} style={{ width: '100%', padding: '12px', background: rcFile ? 'linear-gradient(135deg, #3b82f6, #2563eb)' : '#27395f', color: 'white', border: 'none', borderRadius: '8px', cursor: rcFile ? 'pointer' : 'not-allowed', fontWeight: 'bold', transition: '0.3s' }}>
                      {uploadingRC ? '🚀 SCANNING AI...' : '🤖 SCAN TO DRIVE & AUTO-FILL'}
                    </button>
                    
                    {formData.rc_photo_url && (
                        <div style={{ marginTop: '15px', fontSize: '13px', color: '#2fe39b', fontWeight: 'bold' }}>✅ RC Verified & Attached</div>
                    )}
                  </div>

                </div>
              </div>

            </div>

            <div style={{ marginTop: '30px', display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '20px' }}>
              <button className="glow-btn" onClick={handleSave} disabled={loading} style={{ padding: '15px 40px', fontSize: '16px' }}>
                 {loading ? '⏳ SAVING ASSET...' : (editingId ? '💾 UPDATE ASSET DATA' : '🚀 INITIALIZE VEHICLE')}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}