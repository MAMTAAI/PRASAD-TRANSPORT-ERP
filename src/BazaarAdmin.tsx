// @ts-nocheck
import React, { useState, useEffect } from 'react';

import { logAudit } from './lib/audit';

import { API_BASE } from './lib/apiBase';
import RouteMap from './lib/RouteMap';
import PlaceInput from './lib/PlaceInput';
import ApprovalDrawer from './components/ApprovalDrawer';
const API = API_BASE;
const BAZAAR = `${API}/api/v1/bazaar`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  // The /bazaar routes are admin-guarded now — they hand out competitors' bid
  // amounts and the office's target rate, which any vendor token could read
  // while they were open. Every call from this screen carries the admin session.
  const token = localStorage.getItem('prasad_token');
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

export default function BazaarAdmin() {
  const [activeTab, setActiveTab] = useState('LIVE_BOARD'); 
  const [loading, setLoading] = useState(false);
  const [loads, setLoads] = useState([]);
  // THE MARGIN DESK (owner, 3-Sep). Both sides of every open market deal, with
  // the spread computed per bid by the server so nobody does it in their head.
  const [desk, setDesk] = useState({ loads: [], floor_pct: 8 });
  const [deskBusy, setDeskBusy] = useState('');
  const [deal, setDeal] = useState({});      // per-load: { bid_id, customer_rate, partner_rate, margin_reason }
  // CONTRACT vs MARKET (owner, 3-Sep): one board, two engines, never mixed.
  const [boardKind, setBoardKind] = useState('MARKET');
  const [bids, setBids] = useState([]);
  
  const [marketTrucks, setMarketTrucks] = useState([]);
  const [mapStateFilter, setMapStateFilter] = useState('ALL');
  const [mapCityFilter, setMapCityFilter] = useState('');

  const loadDesk = async () => {
    try { setDesk(await fetchJson(`${BAZAAR}/margin-desk`)); }
    catch (e) { console.error(e); }
  };

  // One button style for every way of reaching a party.
  const contactBtn = (c) => ({
    display: 'inline-block', background: `${c}22`, color: c, border: `1px solid ${c}`,
    borderRadius: '8px', padding: '5px 10px', fontSize: '12px', fontWeight: 800, textDecoration: 'none',
  });

  /** A counter-offer: the desk asking one side to move. It does not edit their
   *  number — it records the ask and sends it, so the negotiation is on the
   *  record instead of in somebody's WhatsApp. */
  const counter = async (l, party, bid) => {
    const isCust = party === 'CUSTOMER';
    const from = isCust ? Number(l.target_rate) : Number(bid?.bid_amount);
    const ask = window.prompt(
      isCust
        ? `Customer ne ₹${from?.toLocaleString('en-IN')} kaha hai. Aap kitna maang rahe hain?`
        : `${bid?.vendor_name} ki bid ₹${from?.toLocaleString('en-IN')} hai. Aap kitne me chahte hain?`,
      String(isCust ? Math.round(from * 1.05) : Math.round(from * 0.95)));
    if (ask === null) return;
    const amount = Number(String(ask).replace(/[^0-9.]/g, ''));
    if (!(amount > 0)) return alert('Sahi rakam daalein.');
    const note = window.prompt('Ek line — kyun? (dono taraf yahi message jaayega)', '') ?? '';
    try {
      await fetchJson(`${BAZAAR}/loads/${l.load_id}/counter`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ party, bid_id: bid?.id ?? null, ask_amount: amount, note }),
      });
      alert(`↗ Counter bhej diya — ₹${amount.toLocaleString('en-IN')}`);
      await loadDesk();
    } catch (e) { alert('❌ ' + e.message); }
  };

  const [isPostModalOpen, setIsPostModalOpen] = useState(false);
  const [customVehicleType, setCustomVehicleType] = useState(''); 
  const [isAddingCustomVehicle, setIsAddingCustomVehicle] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [podView, setPodView] = useState(null);   // settlement whose POD is open in the approval drawer 

  const [loadForm, setLoadForm] = useState({
    customer_name: '', origin: '', destination: '', distance_km: '', toll_plazas: '', toll_amount: '', material: '', weight: '', target_rate: '', loading_date: '',
    vehicle_type: 'Open Body Truck', rate_type: 'Fixed Rate (Lumpsum)'
  });

  useEffect(() => {
    fetchLoadsAndBids();
    fetchMarketTrucks();
    loadDesk();
  }, []);

  const fetchLoadsAndBids = async () => {
    setLoading(true);
    try {
      const [l, b] = await Promise.all([
        fetchJson(`${BAZAAR}/loads`),
        fetchJson(`${BAZAAR}/bids`),
      ]);
      // `assigned_to` arrives derived from the accepted bid — see the API note.
      setLoads(l.loads ?? []);
      setBids(b.bids ?? []);
    } catch (e) { console.error("Error fetching bazaar data:", e); }
    setLoading(false);
  };

  const fetchMarketTrucks = async () => {
    try {
      const { vehicles } = await fetchJson(`${BAZAAR}/market-vehicles`);
      setMarketTrucks(vehicles ?? []);
    } catch (e) { console.error("Error fetching market trucks:", e); }
  };

  // ── SETTLEMENTS (Phase 2) — the money desk behind every award ────────────
  // Every button here asks the server to post a TARA voucher; this screen
  // holds no money state of its own. The gates (advance only after a truck,
  // balance only after the POD is verified) live server-side — a disabled
  // button is a courtesy, the 409 is the law.
  const [setts, setSetts] = useState([]);
  const [settLoading, setSettLoading] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [openSett, setOpenSett] = useState(null);        // id of the expanded card
  const [sf, setSf] = useState({});                      // the expanded card's action form

  const fetchSettlements = async () => {
    setSettLoading(true);
    try {
      const j = await fetchJson(`${BAZAAR}/settlements`);
      setSetts(j.settlements ?? []);
    } catch (e) { console.error('Error fetching settlements:', e); }
    setSettLoading(false);
  };
  const fetchCompanies = async () => {
    try {
      const j = await fetchJson(`${API}/api/v1/finance/masters/companies`);
      setCompanies(j.companies ?? j.rows ?? []);
    } catch { setCompanies([]); }
  };
  useEffect(() => {
    if (activeTab === 'ESCROW') { fetchSettlements(); fetchCompanies(); }
  }, [activeTab]);

  const settAction = async (id, path, body, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await fetchJson(`${BAZAAR}/settlements/${id}${path}`, {
        method: path === '' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      await fetchSettlements();
    } catch (e) {
      alert('❌ ' + ((e as any).message ?? 'failed'));
    }
  };

  const viewPod = async (podKey) => {
    try {
      const token = localStorage.getItem('prasad_token');
      const r = await fetch(`${API}/api/v1/files/${podKey}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) { alert(`Could not open POD (${r.status})`); return; }
      const blob = await r.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { alert('Could not open POD: ' + (e as any).message); }
  };

  // 📍 SMART ROUTE & TOLL CALCULATOR
  //
  // THIS USED TO MAKE THE NUMBERS UP. Distance was Math.random() between 150
  // and 1200 with four hardcoded lanes; the toll was distance/60 x 145. Both
  // went onto a real load that vendors then bid against, presented as the
  // output of an "analysis".
  //
  // Distance now comes from Google Directions through the server (the key for
  // it never reaches this bundle). Tolls come from what the fleet actually paid
  // on that corridor. When a lane has no history the toll is left BLANK and the
  // reason is shown — an operator who knows a figure is a guess can correct it,
  // one who believes it was computed cannot.
  const [analysis, setAnalysis] = useState(null);

  const handleCalculateRoute = async () => {
    if (!loadForm.origin || !loadForm.destination) {
      return alert('Please enter both Pickup and Drop locations first!');
    }
    setLoading(true);
    setShowMap(false);
    setAnalysis(null);
    try {
      const j = await fetchJson(`${API}/api/v1/maps/lane-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: loadForm.origin, destination: loadForm.destination }),
      });
      setAnalysis(j);
      setLoadForm((prev) => ({
        ...prev,
        // Only fill what was actually established. An empty box is a question;
        // a fabricated one is an answer nobody asked for.
        distance_km: j.distance?.km != null ? String(j.distance.km) : prev.distance_km,
        toll_amount: j.toll?.amount != null ? String(j.toll.amount) : prev.toll_amount,
        toll_plazas: j.toll?.plazas != null ? String(j.toll.plazas) : prev.toll_plazas,
      }));
      setShowMap(true);
    } catch (e) {
      setAnalysis({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  const handlePostLoad = async () => {
    if (!loadForm.origin || !loadForm.destination || !loadForm.weight) return alert("Please fill mandatory fields!");
    setLoading(true);
    try {
      const finalVehicleType = isAddingCustomVehicle && customVehicleType ? customVehicleType : loadForm.vehicle_type;

      // No client-minted load_id any more: two admins posting at the same
      // second could both draw the same random LD-#####, and load_id is what
      // every bid references. The server mints it inside the insert.
      await fetchJson(`${BAZAAR}/loads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...loadForm,
          vehicle_type: finalVehicleType,
          status: 'OPEN',
          posted_by: 'ADMIN',
        }),
      });
      alert("✅ Smart Load Posted to Bazaar Successfully!");
      setIsPostModalOpen(false);
      setLoadForm({ customer_name: '', origin: '', destination: '', distance_km: '', toll_plazas: '', toll_amount: '', material: '', weight: '', target_rate: '', loading_date: '', vehicle_type: 'Open Body Truck', rate_type: 'Fixed Rate (Lumpsum)' });
      setCustomVehicleType('');
      setIsAddingCustomVehicle(false);
      setShowMap(false);
      fetchLoadsAndBids();
    } catch (e) {
      alert("❌ Error posting load: " + (e as any).message);
    }
    setLoading(false);
  };

  const handleAwardBid = async (loadId, bidId, vendorName) => {
    if (window.confirm(`Are you sure you want to award this load to ${vendorName}?`)) {
      setLoading(true);
      try {
        // Was two separate writes: the load could end up assigned with no
        // accepted bid if the second failed, and two admins could each award a
        // different bid. Now one transaction, guarded by a unique index.
        await fetchJson(`${BAZAAR}/loads/${loadId}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bid_id: bidId }),
        });
        logAudit({ action: 'BAZAAR_BID_AWARD', target: loadId, details: `Awarded to ${vendorName}` });
        alert(`✅ Load successfully assigned to ${vendorName}!`);
        fetchLoadsAndBids();
      } catch (e) { alert("Error awarding bid: " + (e as any).message); }
      setLoading(false);
    }
  };

  // The desk's decision on a phone-side award request (customer accept-bid or
  // vendor Book-Now). APPROVE = the real award, one transaction, settlement
  // opened; REJECT = load back to OPEN, reason goes to the requester.
  const reviewAward = async (loadId, action, req) => {
    let reason = null;
    if (action === 'REJECT') {
      reason = window.prompt('Reopen kyon? (yeh kaaran request karne wale ko WhatsApp par jayega)');
      if (!reason) return;
    } else if (!window.confirm(`Award ${loadId} to ${req?.vendor_name ?? 'the requested bidder'} at ₹${Number(req?.bid_amount ?? 0).toLocaleString('en-IN')}? Baaki bids reject hongi aur settlement khulega.`)) return;
    setLoading(true);
    try {
      await fetchJson(`${BAZAAR}/loads/${loadId}/award-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      });
      logAudit({ action: `BAZAAR_AWARD_${action}`, target: loadId, details: reason ?? (req?.vendor_name ?? '') });
      fetchLoadsAndBids();
    } catch (e) { alert('❌ ' + (e as any).message); }
    setLoading(false);
  };

  // Maker-checker: a customer-posted load waits here until the office opens it.
  const reviewLoad = async (loadId, action) => {
    let reason = null;
    if (action === 'REJECT') {
      reason = window.prompt('Reject kyon? (yeh kaaran customer ko WhatsApp par jayega)');
      if (!reason) return;
    } else if (!window.confirm(`Approve ${loadId}? Vendors ko bidding ke liye khul jayega.`)) return;
    setLoading(true);
    try {
      await fetchJson(`${BAZAAR}/loads/${loadId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      });
      logAudit({ action: `BAZAAR_LOAD_${action}`, target: loadId, details: reason ?? '' });
      fetchLoadsAndBids();
    } catch (e) { alert('❌ ' + (e as any).message); }
    setLoading(false);
  };

  const getBidsForLoad = (loadIdStr) => bids.filter(b => b.load_id === loadIdStr);
  const availableTrucks = marketTrucks.filter(t => t.system_status === 'System Active');
  const filteredMapTrucks = availableTrucks.filter(t => {
    if (mapStateFilter !== 'ALL' && !t.registration_no.includes(mapStateFilter)) return false;
    return true; 
  });

  return (
    <div style={{ padding: '20px 30px', minHeight: '100vh', background: '#0a1024', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .glass-input { width: 100%; padding: 12px; background: rgba(18, 28, 56,0.6); border: 1px solid rgba(39, 57, 95,0.8); color: white; border-radius: 8px; font-size: 13px; outline: none; box-sizing: border-box;}
        .glass-input:focus { border-color: #ffb224; background: rgba(18, 28, 56,0.9); }
        .bid-card { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.05); padding: 10px 15px; border-radius: 8px; margin-top: 10px; display: flex; justify-content: space-between; alignItems: center; transition: 0.3s; }
        .bid-card:hover { border-color: #22d3ee; background: rgba(34, 211, 238,0.05); }
        .status-badge { font-size: 10px; font-weight: bold; padding: 5px 10px; border-radius: 10px; display: inline-block; }
        
        .radar-container { position: relative; width: 300px; height: 300px; border-radius: 50%; background: radial-gradient(circle, rgba(47, 227, 155, 0.1) 0%, rgba(10, 16, 36, 1) 70%); border: 2px solid rgba(47, 227, 155, 0.3); display: flex; justify-content: center; align-items: center; overflow: hidden; box-shadow: 0 0 50px rgba(47, 227, 155, 0.2); }
        .radar-sweep { position: absolute; width: 150px; height: 150px; background: linear-gradient(45deg, rgba(47, 227, 155, 0.8) 0%, transparent 50%); border-radius: 100% 0 0 0; transform-origin: bottom right; top: 0; left: 0; animation: sweep 3s infinite linear; }
        @keyframes sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .radar-dot { position: absolute; width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 10px #2fe39b; animation: blink 2s infinite ease-in-out; }
        @keyframes blink { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 1; transform: scale(1.5); } }

        /* 🔥 MAP DARK MODE TRICK 🔥 */
        .dark-map-iframe { filter: invert(90%) hue-rotate(180deg) brightness(105%) contrast(85%); border-radius: 12px; width: 100%; height: 100%; border: none; }
      `}</style>

      {/* HEADER & TABS */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '32px', fontWeight: '900', color: '#fff' }}>Load Bazaar Control Center</h1>
          <p style={{ color: '#9aadd4', margin: '5px 0 15px 0', fontSize: '13px' }}>Manage live bids, active loads, and locate available fleet via Radar.</p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setActiveTab('LIVE_BOARD')} style={{ background: activeTab === 'LIVE_BOARD' ? '#3b82f6' : '#18244a', color: activeTab === 'LIVE_BOARD' ? 'white' : '#9aadd4', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📦 Live Load Board</button>
            <button onClick={() => { setActiveTab('MARGIN'); loadDesk(); }} style={{ background: activeTab === 'MARGIN' ? '#7c3aed' : '#18244a', color: activeTab === 'MARGIN' ? 'white' : '#9aadd4', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>⚖️ Margin Desk{desk.loads?.length ? ` (${desk.loads.length})` : ''}</button>
            <button onClick={() => setActiveTab('RADAR_MAP')} style={{ background: activeTab === 'RADAR_MAP' ? '#10b981' : '#18244a', color: activeTab === 'RADAR_MAP' ? 'white' : '#9aadd4', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📡 Fleet Radar (Map)</button>
            <button onClick={() => setActiveTab('ESCROW')} style={{ background: activeTab === 'ESCROW' ? '#f59e0b' : '#18244a', color: activeTab === 'ESCROW' ? 'white' : '#9aadd4', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💰 Settlements & Finance</button>
          </div>
        </div>
        
        {activeTab === 'LIVE_BOARD' && (
           <button onClick={() => setIsPostModalOpen(true)} style={{ background: 'linear-gradient(135deg, #ffb224, #d97706)', color: 'white', padding: '12px 25px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(255, 178, 36,0.3)', display: 'flex', alignItems: 'center', gap: '8px' }}>
             <span>➕</span> Post Manual Load
           </button>
        )}
      </div>

      {/* TAB: MARGIN DESK — the office sits between two parties who never see
          each other's number. The spread is computed per bid by the server so
          nobody does it in their head at 9 p.m.; the desk may edit either side
          and locks what it can defend. */}
      {activeTab === 'MARGIN' && (
        <div style={{ display: 'grid', gap: '18px' }}>
          {(desk.loads ?? []).length === 0 && (
            <div style={{ background: 'rgba(24, 36, 74,0.5)', borderRadius: '14px', padding: '40px', textAlign: 'center', color: '#9aadd4' }}>
              No market load is waiting on a decision. One appears here the moment a customer posts a load.
            </div>
          )}
          {(desk.loads ?? []).map((l) => {
            const d = deal[l.load_id] ?? {};
            const chosen = (l.bids ?? []).find((b) => b.id === d.bid_id) ?? null;
            const cust = Number(d.customer_rate ?? l.target_rate ?? 0);
            const part = Number(d.partner_rate ?? chosen?.bid_amount ?? 0);
            const margin = cust && part ? cust - part : null;
            const pct = margin != null && cust ? Number(((margin / cust) * 100).toFixed(2)) : null;
            const set = (k, v) => setDeal((m) => ({ ...m, [l.load_id]: { ...(m[l.load_id] ?? {}), [k]: v } }));
            const lock = async (confirmFloor) => {
              if (!d.bid_id) return alert('Pehle ek bid chunein.');
              setDeskBusy(l.load_id);
              try {
                await fetchJson(`${BAZAAR}/loads/${l.load_id}/lock`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    bid_id: d.bid_id, customer_rate: cust, partner_rate: part,
                    margin_reason: d.margin_reason || null, confirm_below_floor: !!confirmFloor,
                  }),
                });
                alert(`🔒 Deal locked — margin ₹${Number(margin).toLocaleString('en-IN')} (${pct}%)`);
                await Promise.all([loadDesk(), fetchLoadsAndBids()]);
              } catch (e) {
                // The floor is a question, not a wall: asked once, then obeyed.
                if (e.code === 'BELOW_MARGIN_FLOOR' && window.confirm(`${e.message}\n\nLock it anyway?`)) {
                  setDeskBusy('');
                  return lock(true);
                }
                alert('❌ ' + e.message);
              }
              setDeskBusy('');
            };
            return (
              <div key={l.load_id} style={{ background: 'rgba(18, 28, 56,0.75)', border: '1px solid #18244a', borderRadius: '16px', padding: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <div style={{ fontSize: '19px', fontWeight: 800 }}>{l.origin} → {l.destination}</div>
                    <div style={{ color: '#9aadd4', fontSize: '13px' }}>
                      {l.load_id} · {l.material ?? '—'} · {l.weight ?? '—'} T · load {String(l.loading_date ?? '').slice(0, 10)} · {l.customer ?? l.customer_name}
                    </div>
                  </div>
                  <span style={{ background: 'rgba(59,130,246,.15)', color: '#93c5fd', border: '1px solid #3b82f6', borderRadius: '999px', padding: '4px 12px', fontSize: '12px', fontWeight: 800, height: 'fit-content' }}>
                    {l.bid_count} BID{l.bid_count === 1 ? '' : 'S'} IN
                  </span>
                </div>

                {/* REACH THE CUSTOMER FROM HERE. A desk that has to leave the
                    screen to find a phone number negotiates on WhatsApp and the
                    system learns about it later, if at all. */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' }}>
                  <span style={{ color: '#9aadd4', fontSize: '12px', fontWeight: 700 }}>Customer:</span>
                  {l.customer_mobile ? (
                    <>
                      <a href={`tel:+91${String(l.customer_mobile).slice(-10)}`} style={contactBtn('#22d3ee')}>📞 Call</a>
                      <a href={`https://wa.me/91${String(l.customer_mobile).slice(-10)}`} target="_blank" rel="noreferrer" style={contactBtn('#16a34a')}>💬 WhatsApp</a>
                    </>
                  ) : <span style={{ color: '#ffb224', fontSize: '12px' }}>no number on file</span>}
                  {l.customer_email
                    ? <a href={`mailto:${l.customer_email}`} style={contactBtn('#7c3aed')}>✉️ Email</a>
                    : <span style={{ color: '#5d7196', fontSize: '12px' }}>no email</span>}
                  <button onClick={() => counter(l, 'CUSTOMER')} style={{ ...contactBtn('#ffb224'), border: 'none', cursor: 'pointer' }} data-counter-cust={l.load_id}>
                    ↗ Ask for more
                  </button>
                  {l.customer_counter && (
                    <span style={{ color: '#fbbf24', fontSize: '12px' }}>
                      asked ₹{Number(l.customer_counter.ask_amount).toLocaleString('en-IN')} · {l.customer_counter.status}
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '10px', marginTop: '14px' }}>
                  <div style={{ background: '#111c33', borderRadius: '12px', padding: '11px' }}>
                    <div style={{ color: '#9aadd4', fontSize: '12px' }}>CUSTOMER TARGET</div>
                    <div style={{ fontFamily: 'monospace', fontSize: '21px', fontWeight: 800 }}>₹{Number(l.target_rate ?? 0).toLocaleString('en-IN')}</div>
                    <div style={{ color: '#5d7196', fontSize: '12px' }}>what they said they would pay</div>
                  </div>
                  <div style={{ background: '#111c33', borderRadius: '12px', padding: '11px' }}>
                    <div style={{ color: '#9aadd4', fontSize: '12px' }}>ROUTE · TOLL</div>
                    <div style={{ fontFamily: 'monospace', fontSize: '17px', fontWeight: 800 }}>
                      {l.lane?.km ? `${l.lane.km} km` : '— km'} · {l.lane?.toll != null ? `₹${Number(l.lane.toll).toLocaleString('en-IN')}` : '—'}
                    </div>
                    {/* The source is not decoration: a measured toll and an
                        estimate must not read the same on a money screen. */}
                    <div style={{ color: l.lane?.toll_source === 'OUR_TRIPS' ? '#4ade80' : '#ffb224', fontSize: '12px' }}>{l.lane?.toll_label ?? '—'}</div>
                  </div>
                </div>

                <div style={{ color: '#22d3ee', fontWeight: 800, fontSize: '14px', margin: '16px 0 8px' }}>Partner bids — blind to each other</div>
                {(l.bids ?? []).length === 0 && <div style={{ color: '#5d7196', fontSize: '13px' }}>No bids yet.</div>}
                {(l.bids ?? []).map((b) => {
                  const on = d.bid_id === b.id;
                  return (
                    <div key={b.id} onClick={() => { set('bid_id', b.id); set('partner_rate', b.bid_amount); }}
                      data-bid={b.id}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', cursor: 'pointer',
                               background: on ? '#0d2018' : '#111c33', border: `1px solid ${on ? '#16a34a' : '#24344f'}`,
                               borderRadius: '10px', padding: '10px 13px', marginTop: '7px' }}>
                      <div>
                        <b>{on ? '🔘' : '⚪'} {b.vendor_name}</b>
                        <div style={{ color: '#9aadd4', fontSize: '12px' }}>
                          L{b.l_rank} · {b.trips_done} trip{b.trips_done === 1 ? '' : 's'} done{b.is_approved_for_portal ? '' : ' · portal not open'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {/* Reach this partner, and push back on their number,
                            without leaving the deal. */}
                        <span style={{ display: 'flex', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                          {b.vendor_mobile && <a href={`tel:+91${String(b.vendor_mobile).slice(-10)}`} style={contactBtn('#22d3ee')}>📞</a>}
                          {b.vendor_mobile && <a href={`https://wa.me/91${String(b.vendor_mobile).slice(-10)}`} target="_blank" rel="noreferrer" style={contactBtn('#16a34a')}>💬</a>}
                          {b.vendor_email && <a href={`mailto:${b.vendor_email}`} style={contactBtn('#7c3aed')}>✉️</a>}
                          <button onClick={() => counter(l, 'PARTNER', b)} style={{ ...contactBtn('#ffb224'), border: 'none', cursor: 'pointer' }} data-counter-part={b.id}>↘ Ask less</button>
                        </span>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontFamily: 'monospace', fontWeight: 800 }}>₹{Number(b.bid_amount).toLocaleString('en-IN')}</div>
                          <div style={{ fontSize: '12px', color: b.margin_amount < 0 ? '#ff8b9c' : b.below_floor ? '#fbbf24' : '#4ade80' }}>
                            margin ₹{Number(b.margin_amount ?? 0).toLocaleString('en-IN')} ({b.margin_pct ?? '—'}%){b.below_floor && b.margin_amount >= 0 ? ' ⚠' : ''}
                          </div>
                          {b.last_counter && (
                            <div style={{ fontSize: '11.5px', color: '#fbbf24' }}>
                              asked ₹{Number(b.last_counter.ask).toLocaleString('en-IN')} · {b.last_counter.status}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div style={{ background: margin != null && margin < 0 ? '#2a1215' : '#0d2018',
                              border: `1px solid ${margin != null && margin < 0 ? '#ff6b81' : '#16a34a'}`,
                              borderRadius: '12px', padding: '13px', marginTop: '14px', display: 'grid', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                    <span>Customer pays</span>
                    <input type="number" value={d.customer_rate ?? l.target_rate ?? ''} data-cust={l.load_id}
                      onChange={(e) => set('customer_rate', e.target.value)}
                      style={{ width: '150px', textAlign: 'right', fontFamily: 'monospace', background: '#0a1024', color: '#dde5f4', border: '1px solid #27395f', borderRadius: '8px', padding: '7px 10px' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                    <span>Partner gets</span>
                    <input type="number" value={d.partner_rate ?? chosen?.bid_amount ?? ''} data-part={l.load_id}
                      onChange={(e) => set('partner_rate', e.target.value)}
                      style={{ width: '150px', textAlign: 'right', fontFamily: 'monospace', background: '#0a1024', color: '#dde5f4', border: '1px solid #27395f', borderRadius: '8px', padding: '7px 10px' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #1e4d33', paddingTop: '8px' }}>
                    <b>Company margin</b>
                    <b style={{ fontFamily: 'monospace', color: margin == null ? '#9aadd4' : margin < 0 ? '#ff8b9c' : '#4ade80' }}>
                      {margin == null ? '—' : `₹${margin.toLocaleString('en-IN')} · ${pct}%`}
                    </b>
                  </div>
                  {margin != null && margin < 0 && (
                    <input placeholder="Ghata kyun? (client retention / repositioning) — zaroori hai" data-reason={l.load_id}
                      value={d.margin_reason ?? ''} onChange={(e) => set('margin_reason', e.target.value)}
                      style={{ background: '#0a1024', color: '#dde5f4', border: '1px solid #ff6b81', borderRadius: '8px', padding: '9px 11px' }} />
                  )}
                </div>

                <button onClick={() => lock(false)} disabled={!d.bid_id || deskBusy === l.load_id} data-lock={l.load_id}
                  style={{ width: '100%', marginTop: '13px', background: !d.bid_id ? '#27395f' : 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff', border: 'none', borderRadius: '10px', padding: '13px', fontWeight: 800, cursor: d.bid_id ? 'pointer' : 'default' }}>
                  {deskBusy === l.load_id ? 'Locking…' : '🔒 Lock deal & award'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* TAB 1: LIVE LOAD BOARD & BIDS */}
      {activeTab === 'LIVE_BOARD' && (
        <>
          {loading ? ( <div style={{ color: '#22d3ee', fontSize: '18px', fontWeight: 'bold' }}>Loading Bazaar Data...</div> ) : loads.length === 0 ? (
            <div style={{ textAlign: 'center', marginTop: '100px' }}>
              <div style={{ fontSize: '50px', marginBottom: '15px' }}>🌍</div>
              <h2 style={{ color: '#fff', margin: 0 }}>Live Bidding Board Monitor</h2>
              <p style={{ color: '#9aadd4', maxWidth: '400px', margin: '10px auto' }}>No active loads currently. Click "Post Manual Load" to create a requirement.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '25px' }}>
              {loads.map(load => {
                const loadBids = getBidsForLoad(load.load_id);
                return (
                  <div key={load.id} style={{ background: '#121c38', border: load.status === 'OPEN' ? '1px solid #3b82f6' : load.status === 'AWARD_REQUESTED' ? '1px solid #f97316' : '1px solid #2fe39b', borderRadius: '15px', overflow: 'hidden', position: 'relative', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                    <div style={{ background: load.status === 'OPEN' ? 'rgba(59,130,246,0.1)' : 'rgba(47, 227, 155,0.1)', padding: '20px', borderBottom: '1px solid #18244a' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                        <div>
                          <div style={{ fontSize: '12px', color: '#9aadd4', fontWeight: 'bold' }}>LOAD ID: <span style={{color:'#fff'}}>{load.load_id}</span></div>
                          <div style={{ fontSize: '16px', fontWeight: '900', color: load.status === 'OPEN' ? '#22d3ee' : '#2fe39b', marginTop: '5px' }}>{load.customer_name || 'Direct Party'}</div>
                        </div>
                        <div className="status-badge" style={{
                          background: load.status === 'PENDING_REVIEW' ? 'rgba(255, 178, 36,0.2)' : load.status === 'AWARD_REQUESTED' ? 'rgba(249,115,22,0.2)' : load.status === 'OPEN' ? 'rgba(59,130,246,0.2)' : 'rgba(47, 227, 155,0.2)',
                          color: load.status === 'PENDING_REVIEW' ? '#ffb224' : load.status === 'AWARD_REQUESTED' ? '#fb923c' : load.status === 'OPEN' ? '#22d3ee' : '#2fe39b' }}>
                          {load.status === 'PENDING_REVIEW' ? '🟡 AWAITING REVIEW' : load.status === 'AWARD_REQUESTED' ? '🟠 AWARD REQUESTED' : load.status === 'OPEN' ? '🟢 ACCEPTING BIDS' : '✅ ASSIGNED'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '10px', color: '#9aadd4', textTransform: 'uppercase' }}>Origin</div>
                          <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', textTransform: 'uppercase' }}>{load.origin}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                           <div style={{ color: '#ffb224', fontSize: '16px', fontWeight:'bold' }}>➔</div>
                           {load.distance_km && <div style={{ fontSize: '10px', color: '#9aadd4', marginTop: '2px' }}>{load.distance_km} KM</div>}
                        </div>
                        <div style={{ flex: 1, textAlign: 'right' }}>
                          <div style={{ fontSize: '10px', color: '#9aadd4', textTransform: 'uppercase' }}>Destination</div>
                          <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', textTransform: 'uppercase' }}>{load.destination}</div>
                        </div>
                      </div>
                    </div>
                    <div style={{ padding: '15px 20px', borderBottom: '1px solid #18244a', background: '#0a1024' }}>
                      <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                        <span style={{ background: 'rgba(255, 178, 36, 0.2)', color: '#fcd34d', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', border: '1px solid rgba(255, 178, 36, 0.3)' }}>🚛 {load.vehicle_type}</span>
                        <span style={{ background: 'rgba(47, 227, 155, 0.2)', color: '#6ee7b7', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', border: '1px solid rgba(47, 227, 155, 0.3)' }}>💰 {load.rate_type}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '11px', color: '#9aadd4' }}>Material & Wt.</div>
                          <div style={{ fontSize: '13px', color: '#f6f8fd', fontWeight: 'bold' }}>{load.material} • {load.weight} Ton</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '11px', color: '#9aadd4' }}>Target Rate</div>
                          <div style={{ fontSize: '13px', color: '#ffb224', fontWeight: 'bold' }}>₹{load.target_rate || 'Open'}</div>
                        </div>
                      </div>
                      
                      {/* 🔥 TOLL DATA ON BOARD 🔥 */}
                      {load.toll_plazas && (
                         <div style={{ marginTop: '10px', background: 'rgba(34, 211, 238, 0.05)', padding: '8px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(34, 211, 238, 0.2)' }}>
                            <div style={{fontSize:'11px', color:'#9aadd4'}}>🚧 Toll Plazas: <span style={{color:'#fff', fontWeight:'bold'}}>{load.toll_plazas}</span></div>
                            <div style={{fontSize:'11px', color:'#9aadd4'}}>Est. Toll: <span style={{color:'#ff6b81', fontWeight:'bold'}}>₹{load.toll_amount}</span></div>
                         </div>
                      )}
                    </div>
                    {load.status === 'PENDING_REVIEW' && (
                      <div style={{ padding: '15px 20px', background: 'rgba(255, 178, 36,0.07)', borderBottom: '1px solid rgba(255, 178, 36,0.25)' }}>
                        <div style={{ fontSize: '11px', color: '#fcd34d', marginBottom: '10px', fontWeight: 'bold' }}>
                          📥 Customer ne post kiya hai — approve hone tak vendors ko nahi dikhega.
                        </div>
                        <div style={{ display: 'flex', gap: '10px' }}>
                          <button onClick={() => reviewLoad(load.load_id, 'APPROVE')}
                            style={{ flex: 1, background: 'linear-gradient(135deg,#2fe39b,#2fe39b)', color: '#fff', border: 'none', padding: '10px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>
                            ✅ Approve — open for bidding
                          </button>
                          <button onClick={() => reviewLoad(load.load_id, 'REJECT')}
                            style={{ flex: 1, background: '#18244a', color: '#ff6b81', border: '1px solid #ef444455', padding: '10px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>
                            ✖ Reject with reason
                          </button>
                        </div>
                      </div>
                    )}
                    {load.status === 'AWARD_REQUESTED' && (() => {
                      // THE DESK'S DECISION (2-Sep-2026). A customer's accept-bid or a
                      // vendor's Book-Now lands here; nothing is awarded until a person
                      // approves. Approve runs the same one-transaction award as the
                      // AWARD button; reject reopens the load with a reason the
                      // requester reads on WhatsApp.
                      const req = loadBids.find((b) => b.id === load.award_requested_bid_id);
                      return (
                        <div style={{ padding: '15px 20px', background: 'rgba(249,115,22,0.07)', borderBottom: '1px solid rgba(249,115,22,0.3)' }}>
                          <div style={{ fontSize: '11px', color: '#fdba74', marginBottom: '6px', fontWeight: 'bold' }}>
                            🟠 {load.award_requested_by === 'VENDOR' ? 'Vendor ne Book-Now maanga hai' : 'Customer ne bid chuni hai'} — award aapke approve ke baad hoga.
                          </div>
                          <div style={{ fontSize: '12px', color: '#f6f8fd', marginBottom: '10px' }}>
                            {req
                              ? <>Requested: <b>{req.vendor_name}</b> · <b>₹{Number(req.bid_amount).toLocaleString('en-IN')}</b>{req.remarks ? ` · ${req.remarks}` : ''}</>
                              : <span style={{ color: '#ff8b9c' }}>Requested bid not in the list — reopen the load.</span>}
                            {load.award_requested_at && <span style={{ color: '#9aadd4' }}> · {new Date(load.award_requested_at).toLocaleString('en-IN')}</span>}
                          </div>
                          <div style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={() => reviewAward(load.load_id, 'APPROVE', req)}
                              style={{ flex: 1, background: 'linear-gradient(135deg,#f97316,#ea580c)', color: '#fff', border: 'none', padding: '10px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>
                              ✅ Approve award{req ? ` — ${req.vendor_name}` : ''}
                            </button>
                            <button onClick={() => reviewAward(load.load_id, 'REJECT', req)}
                              style={{ flex: 1, background: '#18244a', color: '#ff6b81', border: '1px solid #ef444455', padding: '10px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>
                              ↩ Reopen for bidding (with reason)
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ padding: '20px' }}>
                      <div style={{ fontSize: '12px', color: '#c4d1ea', fontWeight: 'bold', marginBottom: '10px', display: 'flex', justifyContent: 'space-between' }}>
                        <span>LATEST BIDS ({loadBids.length})</span>
                        {load.status === 'AWARDED' && <span style={{color:'#2fe39b'}}>Awarded to: {load.assigned_to}</span>}
                      </div>
                      {loadBids.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: '#5d7196', fontSize: '12px' }}>No bids received yet.</div>
                      ) : (
                        loadBids.map(bid => (
                          <div key={bid.id} className="bid-card" style={{ borderColor: bid.status === 'ACCEPTED' ? '#2fe39b' : '' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>{bid.vendor_name}</div>
                              <div style={{ fontSize: '11px', color: '#9aadd4', marginTop: '2px' }}>Remarks: {bid.remarks || 'N/A'}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '16px', fontWeight: '900', color: bid.status === 'ACCEPTED' ? '#2fe39b' : '#22d3ee' }}>₹{bid.bid_amount}</div>
                              {load.status === 'OPEN' && (
                                <button onClick={() => handleAwardBid(load.load_id, bid.id, bid.vendor_name)} style={{ background: '#10b981', color: 'white', border: 'none', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', marginTop: '5px' }}>Award Load</button>
                              )}
                              {bid.status === 'ACCEPTED' && <span style={{color:'#2fe39b', fontSize:'10px', fontWeight:'bold'}}>✅ WINNER</span>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* TAB 2: FLEET RADAR */}
      {activeTab === 'RADAR_MAP' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '30px' }}>
          <div style={{ background: '#121c38', padding: '30px', borderRadius: '20px', border: '1px solid #18244a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <h3 style={{ color: '#2fe39b', margin: '0 0 30px 0' }}>Live Fleet Monitor</h3>
            <div className="radar-container">
              <div className="radar-sweep"></div>
              <div className="radar-dot" style={{ top: '40%', left: '30%' }}></div>
              <div className="radar-dot" style={{ top: '60%', left: '70%', animationDelay: '0.5s' }}></div>
              <div className="radar-dot" style={{ top: '20%', left: '60%', animationDelay: '1s' }}></div>
              <div className="radar-dot" style={{ top: '70%', left: '40%', animationDelay: '1.5s' }}></div>
              <div className="radar-dot" style={{ top: '50%', left: '50%', background: '#f59e0b', boxShadow: '0 0 10px #ffb224' }}></div>
            </div>
          </div>
          <div style={{ background: '#121c38', padding: '20px', borderRadius: '20px', border: '1px solid #18244a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#fff' }}>Available Empty Vehicles</h3>
              <div style={{ display: 'flex', gap: '10px' }}>
                <select className="glass-input" style={{ width: '150px', padding: '8px' }} value={mapStateFilter} onChange={e=>setMapStateFilter(e.target.value)}>
                  <option value="ALL">-- All States --</option>
                  <option value="AS">Assam (AS)</option>
                  <option value="NL">Nagaland (NL)</option>
                  <option value="WB">West Bengal (WB)</option>
                  <option value="MH">Maharashtra (MH)</option>
                </select>
                <input className="glass-input" style={{ width: '150px', padding: '8px' }} placeholder="Search City..." value={mapCityFilter} onChange={e=>setMapCityFilter(e.target.value)} />
              </div>
            </div>
            <div style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '10px' }}>
              {filteredMapTrucks.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#5d7196' }}>No empty vehicles found in this region.</div>
              ) : (
                filteredMapTrucks.map(truck => (
                  <div key={truck.id} style={{ background: '#0a1024', padding: '15px', borderRadius: '10px', border: '1px solid #18244a', marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#22d3ee' }}>{truck.registration_no}</div>
                      <div style={{ fontSize: '12px', color: '#9aadd4', marginTop: '4px' }}>{truck.vehicle_class || 'Open Truck'} • Cap: {truck.capacity || 'N/A'} Ton</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '10px', color: '#2fe39b', fontWeight: 'bold', background: 'rgba(47, 227, 155,0.1)', padding: '4px 8px', borderRadius: '6px', display: 'inline-block' }}>🟢 READY TO LOAD</div>
                      <div style={{ fontSize: '11px', color: '#ffb224', marginTop: '6px' }}>{truck.vendor_agency}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: SETTLEMENTS — award → deposit → advance → POD → balance */}
      {activeTab === 'ESCROW' && (
        settLoading ? (
          <div style={{ color: '#ffb224', fontSize: '18px', fontWeight: 'bold' }}>Loading settlements…</div>
        ) : setts.length === 0 ? (
          <div style={{ textAlign: 'center', marginTop: '100px' }}>
            <div style={{ fontSize: '50px', marginBottom: '15px' }}>🏦</div>
            <h2 style={{ color: '#fff', margin: 0 }}>No settlements yet</h2>
            <p style={{ color: '#9aadd4', maxWidth: '460px', margin: '10px auto' }}>
              The moment a load is awarded — by a customer, by Book-Now, or from this desk — its money
              lifecycle appears here: trip-lock deposit, advance at loading, POD check, balance release.
              Every rupee posts through TARA into the books.
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: '25px' }}>
            {setts.map((s) => {
              const open = openSett === s.id;
              const SETT_COLORS = {
                AWAITING_CONFIRM: '#ffb224', CONFIRMED: '#22d3ee', VEHICLE_ASSIGNED: '#22d3ee',
                ADVANCE_PAID: '#2fe39b', POD_SUBMITTED: '#ffb224', POD_VERIFIED: '#2fe39b',
                SETTLED: '#2fe39b', CANCELLED: '#ff6b81',
              };
              const col = SETT_COLORS[s.status] ?? '#9aadd4';
              const due = Number(s.awarded_amount) - Number(s.advance_amount ?? 0);
              const editable = !['SETTLED', 'CANCELLED'].includes(s.status);
              return (
                <div key={s.id} style={{ background: '#121c38', border: `1px solid ${col}55`, borderRadius: '15px', overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                  <div style={{ padding: '18px 20px', borderBottom: '1px solid #18244a', cursor: 'pointer' }}
                       onClick={() => { setOpenSett(open ? null : s.id); setSf({}); }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: '12px', color: '#9aadd4', fontWeight: 'bold' }}>
                          {s.load_id} · <span style={{ color: '#fff' }}>{s.vendor_name}</span>
                        </div>
                        <div style={{ fontSize: '15px', fontWeight: '900', color: '#fff', marginTop: '4px' }}>
                          {s.origin} <span style={{ color: '#ffb224' }}>➔</span> {s.destination}
                        </div>
                        <div style={{ fontSize: '11px', color: '#9aadd4', marginTop: '4px' }}>
                          {s.customer_name} · {s.vehicle_reg ? `🚛 ${s.vehicle_reg}` : 'truck not named'}
                          {s.driver_name_assigned ? ` · ${s.driver_name_assigned}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="status-badge" style={{ background: `${col}22`, color: col }}>{s.status.replaceAll('_', ' ')}</div>
                        <div style={{ fontSize: '16px', fontWeight: '900', color: '#fff', marginTop: '6px' }}>₹{Number(s.awarded_amount).toLocaleString('en-IN')}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '14px', marginTop: '10px', fontSize: '11px', color: '#9aadd4' }}>
                      <span>Deposit: <b style={{ color: s.deposit_amount ? '#2fe39b' : '#5d7196' }}>{s.deposit_amount ? `₹${Number(s.deposit_amount).toLocaleString('en-IN')}` : '—'}</b></span>
                      <span>Advance ({Number(s.advance_pct)}%): <b style={{ color: s.advance_amount ? '#2fe39b' : '#5d7196' }}>{s.advance_amount ? `₹${Number(s.advance_amount).toLocaleString('en-IN')}` : '—'}</b></span>
                      <span>Balance: <b style={{ color: s.balance_amount ? '#2fe39b' : '#5d7196' }}>{s.balance_amount ? `₹${Number(s.balance_amount).toLocaleString('en-IN')}` : `₹${due.toLocaleString('en-IN')} due`}</b></span>
                      <span>Firm: <b style={{ color: s.company_id ? '#22d3ee' : '#ff6b81' }}>{s.company_id ? (companies.find((c) => c.id === s.company_id)?.company_name ?? 'set') : 'NOT SET'}</b></span>
                    </div>
                  </div>

                  {open && (
                    <div style={{ padding: '16px 20px', background: '#0a1024', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {/* Firm + advance % — before money moves */}
                      {editable && (
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                          <div style={{ flex: 2 }}>
                            <label style={{ fontSize: '10px', color: '#9aadd4', fontWeight: 'bold' }}>FIRM (whose books)</label>
                            <select className="glass-input" value={s.company_id ?? ''}
                              onChange={(e) => settAction(s.id, '', { company_id: e.target.value || null })}>
                              <option value="">— not set —</option>
                              {companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                            </select>
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '10px', color: '#9aadd4', fontWeight: 'bold' }}>ADVANCE %</label>
                            <input className="glass-input" type="number" defaultValue={Number(s.advance_pct)}
                              onBlur={(e) => { const p = Number(e.target.value); if (p !== Number(s.advance_pct)) settAction(s.id, '', { advance_pct: p }); }} />
                          </div>
                        </div>
                      )}

                      {/* Shared money inputs */}
                      {editable && (
                        <div style={{ display: 'flex', gap: '10px' }}>
                          <div style={{ flex: 2 }}>
                            <label style={{ fontSize: '10px', color: '#9aadd4', fontWeight: 'bold' }}>BANK / CASH LEDGER (for the voucher)</label>
                            <input className="glass-input" placeholder="e.g. HDFC Bank / Cash" value={sf.account ?? ''}
                                   onChange={(e) => setSf((p) => ({ ...p, account: e.target.value }))} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '10px', color: '#9aadd4', fontWeight: 'bold' }}>AMOUNT ₹ (blank = auto)</label>
                            <input className="glass-input" type="number" value={sf.amount ?? ''}
                                   onChange={(e) => setSf((p) => ({ ...p, amount: e.target.value }))} />
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {editable && !s.vendor_deposit_voucher_id && (
                          <button onClick={() => settAction(s.id, '/deposit', { side: 'VENDOR', account: sf.account, amount: Number(sf.amount) || undefined }, 'Record the VENDOR trip-lock deposit received?')}
                            style={{ background: '#18244a', color: '#fcd34d', border: '1px solid #f59e0b55', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>🔒 Vendor deposit in</button>
                        )}
                        {editable && !s.customer_deposit_voucher_id && (
                          <button onClick={() => settAction(s.id, '/deposit', { side: 'CUSTOMER', account: sf.account, amount: Number(sf.amount) || undefined }, 'Record the CUSTOMER trip-lock deposit received?')}
                            style={{ background: '#18244a', color: '#fcd34d', border: '1px solid #f59e0b55', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>🔒 Customer deposit in</button>
                        )}
                        {s.vendor_deposit_voucher_id && !s.vendor_deposit_refund_voucher_id && (
                          <button onClick={() => settAction(s.id, '/deposit-refund', { side: 'VENDOR', account: sf.account }, 'Refund the VENDOR deposit?')}
                            style={{ background: '#18244a', color: '#9aadd4', border: '1px solid #27395f', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>↩ Refund vendor dep.</button>
                        )}
                        {s.customer_deposit_voucher_id && !s.customer_deposit_refund_voucher_id && (
                          <button onClick={() => settAction(s.id, '/deposit-refund', { side: 'CUSTOMER', account: sf.account }, 'Refund the CUSTOMER deposit?')}
                            style={{ background: '#18244a', color: '#9aadd4', border: '1px solid #27395f', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>↩ Refund customer dep.</button>
                        )}
                        {s.status === 'VEHICLE_ASSIGNED' && (
                          <button onClick={() => settAction(s.id, '/advance', { account: sf.account, amount: Number(sf.amount) || undefined }, `Release the advance (default ${Number(s.advance_pct)}% = ₹${Math.round(Number(s.awarded_amount) * Number(s.advance_pct) / 100).toLocaleString('en-IN')})?`)}
                            style={{ background: 'linear-gradient(135deg,#2fe39b,#2fe39b)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>💸 Release advance</button>
                        )}
                        {s.pod_file && (
                          <button onClick={() => setPodView(s)}
                            style={{ background: '#18244a', color: '#a78bfa', border: '1px solid #a78bfa55', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>📄 View POD</button>
                        )}
                        {s.pod_file && ['POD_SUBMITTED', 'ADVANCE_PAID'].includes(s.status) && (
                          <button onClick={() => settAction(s.id, '/pod/verify', { note: sf.note ?? null }, 'Confirm you have checked the POD? This unlocks the balance.')}
                            style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✅ Verify POD</button>
                        )}
                        {s.status === 'POD_VERIFIED' && (
                          <button onClick={() => settAction(s.id, '/balance', { account: sf.account, amount: Number(sf.amount) || undefined }, `Release the balance (₹${due.toLocaleString('en-IN')} due)?`)}
                            style={{ background: 'linear-gradient(135deg,#2fe39b,#2fe39b)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>💰 Release balance</button>
                        )}
                        {editable && (
                          <button onClick={() => { const reason = window.prompt('Why is this settlement being cancelled? (the load reopens for bids)'); if (reason) settAction(s.id, '/cancel', { reason }); }}
                            style={{ background: '#18244a', color: '#ff6b81', border: '1px solid #ef444455', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✖ Cancel</button>
                        )}
                      </div>

                      {/* The Smart Approval Desk for a POD: the paper in place, the verdict beside it. */}
                      {podView?.id === s.id && (
                        <ApprovalDrawer
                          open
                          onClose={() => setPodView(null)}
                          title={`POD · ${s.load_id} · ${s.vendor_name ?? 'partner'}`}
                          subtitle={`${s.origin ?? ''} → ${s.destination ?? ''} · ${s.customer_name ?? ''} · settlement ${s.status}`}
                          accent="#8b5cf6"
                          fileKey={s.pod_file}
                          fileLabel="Proof of delivery"
                          amount={due}
                          amountLabel="Balance due after verification"
                          chips={[{ label: s.status, tone: s.status === 'POD_VERIFIED' ? 'green' : ['POD_SUBMITTED', 'ADVANCE_PAID'].includes(s.status) ? 'violet' : 'slate' }]}
                          canDecide={['POD_SUBMITTED', 'ADVANCE_PAID'].includes(s.status)}
                          fields={[
                            { key: 'load', label: 'Load', value: s.load_id ?? '' },
                            { key: 'partner', label: 'Fleet partner', value: s.vendor_name ?? '' },
                            { key: 'vehicle', label: 'Truck', value: s.vehicle_reg ?? '' },
                            { key: 'driver', label: 'Driver named', value: s.driver_name_assigned ?? '' },
                            { key: 'awarded', label: 'Awarded (₹)', value: Number(s.awarded_amount ?? 0).toLocaleString('en-IN') },
                            { key: 'material', label: 'Material', value: `${s.material ?? ''}${s.weight ? ` · ${s.weight}` : ''}` },
                            { key: 'note', label: 'Verification note', value: sf.note ?? '', editable: true, wide: true, hint: 'Kept on the settlement with your name and the time.' },
                          ]}
                          approveLabel="✅ Verify POD"
                          onApprove={async (edits) => {
                            await settAction(s.id, '/pod/verify', { note: edits.note ?? sf.note ?? null }, null);
                            setPodView(null);
                          }}
                          footnote="Verifying the POD unlocks 'Release balance'. The rupees still move only through that button — a TARA voucher in the market-fleet segment, never the own-fleet books."
                        />
                      )}

                      <div style={{ fontSize: '10.5px', color: '#5d7196', lineHeight: 1.6 }}>
                        Advance releases only after the partner confirms and names an approved truck; the balance only
                        after the POD is verified — the server refuses anything else. Every button posts a TARA voucher
                        into the firm's books; nothing here keeps its own khata.
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* 📝 MEGA MODAL: POST SMART LOAD */}
      {isPostModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div style={{ background: '#121c38', width: '100%', maxWidth: '900px', borderRadius: '20px', border: '1px solid #ffb224', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 10px 50px rgba(255, 178, 36, 0.2)' }}>
            
            <div style={{ padding: '20px 30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #18244a', background: 'rgba(255, 178, 36, 0.1)' }}>
              <div>
                <h2 style={{ color: '#ffb224', margin: 0, fontSize: '22px' }}>Post New Smart Load</h2>
                <div style={{ fontSize: '11px', color: '#9aadd4', marginTop: '5px' }}>Calculate Route, Tolls, and publish immediately.</div>
              </div>
              <button onClick={() => setIsPostModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ padding: '30px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', overflowY: 'auto', maxHeight: '75vh' }}>
              
              {/* 🔥 ROUTE ENGINE & MAP VIEW 🔥 */}
              <div style={{ gridColumn: 'span 2', display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', background: '#0a1024', padding: '20px', borderRadius: '12px', border: '1px solid #18244a' }}>
                  <div>
                    <label style={{fontSize:'11px', color:'#2fe39b', fontWeight:'bold'}}>📍 Pickup Location (Origin) *</label>
                    <PlaceInput
                      className="glass-input"
                      value={loadForm.origin}
                      onChange={(v) => setLoadForm({ ...loadForm, origin: v })}
                      placeholder="e.g. BONGAIGAON" />
                  </div>
                  <div>
                    <label style={{fontSize:'11px', color:'#ff6b81', fontWeight:'bold'}}>📍 Drop Location (Destination) *</label>
                    <PlaceInput
                      className="glass-input"
                      value={loadForm.destination}
                      onChange={(v) => setLoadForm({ ...loadForm, destination: v })}
                      placeholder="e.g. GUWAHATI" />
                  </div>
                  
                  <button onClick={handleCalculateRoute} style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', padding: '12px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', marginTop: '5px', display: 'flex', justifyContent: 'center', gap: '10px' }}>
                    {loading ? '⏳ Analyzing Route & Tolls...' : '🔍 Analyze Route & Toll Data'}
                  </button>

                  <div style={{ background: 'linear-gradient(135deg, rgba(24, 36, 74,0.8), rgba(10, 16, 36,0.9))', border: '1px solid #27395f', padding: '15px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ textAlign: 'center', flex: 1, borderRight: '1px solid #27395f' }}>
                       <div style={{ fontSize: '10px', color: '#9aadd4', textTransform: 'uppercase', marginBottom: '5px' }}>Total Distance</div>
                       <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '5px' }}>
                          <input type="number" value={loadForm.distance_km} onChange={(e) => setLoadForm({...loadForm, distance_km: e.target.value})} style={{ width: '50px', background: 'transparent', border: 'none', borderBottom: '1px dashed #22d3ee', color: '#22d3ee', fontSize: '18px', fontWeight: '900', textAlign: 'center', outline: 'none' }} placeholder="0" />
                          <span style={{color: '#22d3ee', fontSize:'12px', fontWeight: 'bold'}}>KM</span>
                       </div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1, borderRight: '1px solid #27395f' }}>
                       <div style={{ fontSize: '10px', color: '#9aadd4', textTransform: 'uppercase', marginBottom: '5px' }}>Toll Plazas</div>
                       <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '5px' }}>
                          <input type="number" value={loadForm.toll_plazas} onChange={(e) => setLoadForm({...loadForm, toll_plazas: e.target.value})} style={{ width: '40px', background: 'transparent', border: 'none', borderBottom: '1px dashed #ffb224', color: '#ffb224', fontSize: '18px', fontWeight: '900', textAlign: 'center', outline: 'none' }} placeholder="0" />
                          <span style={{color: '#ffb224', fontSize:'16px'}}>🚧</span>
                       </div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                       <div style={{ fontSize: '10px', color: '#9aadd4', textTransform: 'uppercase', marginBottom: '5px' }}>Est. Toll Cost</div>
                       <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '5px' }}>
                          <span style={{color: '#ff6b81', fontSize:'14px', fontWeight: 'bold'}}>₹</span>
                          <input type="number" value={loadForm.toll_amount} onChange={(e) => setLoadForm({...loadForm, toll_amount: e.target.value})} style={{ width: '60px', background: 'transparent', border: 'none', borderBottom: '1px dashed #ff6b81', color: '#ff6b81', fontSize: '18px', fontWeight: '900', textAlign: 'center', outline: 'none' }} placeholder="0" />
                       </div>
                    </div>
                  </div>
                </div>

                {/* The iframe embed here was a picture of a route, not the route:
                    it re-queried Google from the browser with no key, could not
                    be styled, and had no relationship to the distance in the box
                    above it. This draws the ACTUAL polyline the analysis
                    returned, so the map and the number agree by construction. */}
                {!showMap ? (
                  <div style={{ position: 'relative', background: '#121c38', borderRadius: '12px', border: '1px solid #18244a', minHeight: '250px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '40px', marginBottom: '10px', filter: 'grayscale(1)', opacity: 0.5 }}>🗺️</div>
                      <div style={{ color: '#5d7196', fontSize: '12px' }}>Type locations & click<br/>'Analyze Route'</div>
                    </div>
                  </div>
                ) : (
                  <RouteMap height={250} polyline={analysis?.distance?.polyline} />
                )}

                {/* WHERE EACH NUMBER CAME FROM. The distance is Google's; the
                    toll is our own history or nothing at all. Saying which is
                    the difference between a figure an operator can sanity-check
                    and one they have to take on faith. */}
                {analysis && (
                  <div style={{ marginTop: '10px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(18, 28, 56,0.7)', border: '1px solid #18244a', fontSize: '11px', lineHeight: 1.6 }}>
                    {analysis.error && (
                      <div style={{ color: '#ffb224' }}>Analysis failed: {analysis.error}</div>
                    )}
                    {analysis.distance && (
                      <div style={{ color: analysis.distance.km != null ? '#22d3ee' : '#ffb224' }}>
                        {analysis.distance.km != null
                          ? <>Distance <b>{analysis.distance.km} km</b>{analysis.distance.duration_min ? ` · about ${Math.round(analysis.distance.duration_min / 60)}h ${analysis.distance.duration_min % 60}m` : ''} — Google Directions{analysis.distance.cached ? ' (cached, not re-billed)' : ''}</>
                          : <>Distance unavailable — {analysis.distance.detail || analysis.distance.error}. Enter it by hand.</>}
                      </div>
                    )}
                    {analysis.toll && (
                      <div style={{ color: analysis.toll.amount != null ? '#22c55e' : '#9aadd4' }}>
                        {analysis.toll.amount != null
                          ? <>Toll <b>₹{analysis.toll.amount}</b> across ~{analysis.toll.plazas} plazas — {analysis.toll.basis}</>
                          : <>No toll figure: {analysis.toll.basis}</>}
                      </div>
                    )}
                  </div>
                )}

              </div>

              {/* REST OF THE FORM */}
              <div style={{gridColumn: 'span 2'}}><label style={{fontSize:'11px', color:'#9aadd4'}}>Customer / Party Name (Optional)</label><input className="glass-input" placeholder="e.g. ABC Steel Corp" value={loadForm.customer_name} onChange={e=>setLoadForm({...loadForm, customer_name:e.target.value})} /></div>
              
              <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Material Description</label><input className="glass-input" placeholder="e.g. Iron Pipes, HSD, Gas" value={loadForm.material} onChange={e=>setLoadForm({...loadForm, material:e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#2fe39b', fontWeight:'bold'}}>Total Weight / Volume *</label><input className="glass-input" type="number" placeholder="e.g. 21" value={loadForm.weight} onChange={e=>setLoadForm({...loadForm, weight:e.target.value})} /></div>

              <div style={{ background: 'rgba(255, 178, 36, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(255, 178, 36, 0.2)' }}>
                <label style={{fontSize:'11px', color:'#fcd34d', fontWeight:'bold'}}>Required Vehicle Body Type *</label>
                {!isAddingCustomVehicle ? (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                    <select className="glass-input" style={{borderColor:'#ffb224', color:'#fcd34d', flex: 1, background: '#0a1024'}} value={loadForm.vehicle_type} onChange={e=>setLoadForm({...loadForm, vehicle_type:e.target.value})}>
                      <option value="Open Body Truck">Open Body Truck</option>
                      <option value="Container (Closed)">Container (Closed)</option>
                      <option value="Oil Tanker">Oil / Liquid Tanker</option>
                      <option value="Gas Tanker (Bullets)">Gas Tanker (Bullets)</option>
                      <option value="Flatbed Trailer">Flatbed Trailer</option>
                      <option value="Tipper / Dumper">Tipper / Dumper</option>
                    </select>
                    <button onClick={() => setIsAddingCustomVehicle(true)} style={{ background: '#f59e0b', color: 'white', border: 'none', borderRadius: '8px', padding: '0 15px', fontWeight: 'bold', cursor: 'pointer' }}>+</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                    <input className="glass-input" style={{borderColor:'#ffb224', color:'#fcd34d', flex: 1, background: '#0a1024'}} placeholder="e.g. JCB Trailer, Half Body..." value={customVehicleType} onChange={e=>setCustomVehicleType(e.target.value)} />
                    <button onClick={() => setIsAddingCustomVehicle(false)} style={{ background: 'transparent', color: '#ffb224', border: '1px solid #ffb224', borderRadius: '8px', padding: '0 15px', fontWeight: 'bold', cursor: 'pointer' }}>✖</button>
                  </div>
                )}
              </div>

              <div style={{ background: 'rgba(47, 227, 155, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(47, 227, 155, 0.2)' }}>
                <label style={{fontSize:'11px', color:'#6ee7b7', fontWeight:'bold'}}>Rate Type (Calculation Mode) *</label>
                <select className="glass-input" style={{borderColor:'#2fe39b', color:'#6ee7b7', background: '#0a1024', marginTop: '5px'}} value={loadForm.rate_type} onChange={e=>setLoadForm({...loadForm, rate_type:e.target.value})}>
                  <option value="Fixed Rate (Lumpsum)">Fixed Rate (Lumpsum)</option>
                  <option value="Rate Per MT (Ton)">Rate Per MT (Ton)</option>
                  <option value="Rate Per KL">Rate Per KL (Kiloliter)</option>
                  <option value="Rate Per KM">Rate Per KM</option>
                </select>
              </div>
              
              <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Target Rate (₹) [Optional]</label><input className="glass-input" type="number" placeholder={`e.g. 45000`} value={loadForm.target_rate} onChange={e=>setLoadForm({...loadForm, target_rate:e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#9aadd4'}}>Expected Loading Date</label><input className="glass-input" type="date" style={{colorScheme:'dark'}} value={loadForm.loading_date} onChange={e=>setLoadForm({...loadForm, loading_date:e.target.value})} /></div>
            </div>

            <div style={{ padding: '20px 30px', textAlign: 'right', background: '#0a1024', borderTop: '1px solid #18244a' }}>
              <button onClick={handlePostLoad} disabled={loading} style={{ background: 'linear-gradient(135deg, #ffb224, #d97706)', color: 'white', border: 'none', padding: '14px 35px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', boxShadow: '0 4px 15px rgba(255, 178, 36,0.4)' }}>
                {loading ? '⌛ POSTING...' : '🚀 BROADCAST LOAD'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}