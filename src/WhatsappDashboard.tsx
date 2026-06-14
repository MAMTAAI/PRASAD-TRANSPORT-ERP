// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { db } from './firebase'; 
import { collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import MamtaChat from './MamtaChat';
import useIsMobile from './hooks/useIsMobile';

const WhatsappDashboard = () => {
  const { isMobile } = useIsMobile(); // 📱 responsive layout
  // 👤 USER SESSION
  const [activeUser, setActiveUser] = useState('Admin');
  const [tab, setTab] = useState('TRIP CHAT'); 
  const [isWa, setIsWa] = useState(false);
  const [qr, setQr] = useState('');
  const [engStatus, setEngStatus] = useState('WAITING');
  
  // 📡 FIREBASE DATA STATES
  const [waContacts, setWaContacts] = useState([]);
  const [sysDrivers, setSysDrivers] = useState([]);
  const [sysCustomers, setSysCustomers] = useState([]);
  const [sysVendors, setSysVendors] = useState([]);
  const [rules, setRules] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [leads, setLeads] = useState([]);
  const [logs, setLogs] = useState([]); 
  const [chatMsgs, setChatMsgs] = useState([]); 
  const [liveTrips, setLiveTrips] = useState([]);

  // 🌟 UI STATES
  const [selPhones, setSelPhones] = useState([]);
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState({ show: false, text: '', type: '' });
  const [searchContact, setSearchContact] = useState(''); 
  const [bcFilter, setBcFilter] = useState('All'); 

  // 💬 TRIP CHAT STATES
  const [activeTrip, setActiveTrip] = useState(null);
  const [chatRole, setChatRole] = useState('Driver'); // Driver | Customer
  const [chatInput, setChatInput] = useState('');
  const [fTrip, setFTrip] = useState({ tripId: '', driverPhone: '', customerPhone: '' });
  const chatEndRef = useRef(null); 

  // 📝 FORM STATES
  const [fC, setFC] = useState({ name: '', phone: '', category: 'Driver' });
  const [fR, setFR] = useState({ keyword: '', reply: '', action: 'Reply Only' });
  const [fS, setFS] = useState({ phone: '', message: '', datetime: '' });
  const [fL, setFL] = useState({ name: '', req: '', status: 'NEW LEAD' });
  const [qrGen, setQrGen] = useState({ phone: '91', text: 'Hi Prasad Transport, I want to connect.' });

  // 🎨 THEME
  const theme = { bg: '#020617', card: '#0F172A', inputBg: '#1E293B', border: '#334155', wa: '#10B981', sub: '#94A3B8', danger: '#F43F5E', accent: '#38bdf8', ai: '#c084fc' };

  // 🔔 HELPER FUNCTIONS
  const showToast = (text, type = 'success') => { 
      setStatus({ show: true, text, type }); 
      setTimeout(() => setStatus({ show: false, text: '', type: '' }), 4000); 
  };
  
  const contacts = [...waContacts, ...sysDrivers, ...sysCustomers, ...sysVendors];

  const logActivity = async (actionDesc) => { 
      try { await addDoc(collection(db, "WA_LOGS"), { user: activeUser, action: actionDesc, timestamp: new Date().toISOString() }); } catch(e) {} 
  };

  // 🔄 FETCH ALL DATA FROM FIREBASE
  useEffect(() => {
    const extractPhone = (d) => String(d.phone || d.mobile || d.contact || d.Phone || d.Mobile || d.Contact || '').replace(/\D/g, '').slice(-10);
    const extractName = (d, fallback) => d.name || d.driverName || d.customerName || d.companyName || d.Name || fallback;

    const unsubWa = onSnapshot(collection(db, "WA_CONTACTS"), s => setWaContacts(s.docs.map(d => ({ id: d.id, ...d.data(), phone: extractPhone(d.data()), isSystem: false }))));
    const unsubDr = onSnapshot(collection(db, "DRIVERS"), s => setSysDrivers(s.docs.map(d => { const data = d.data(); return { id: d.id, name: extractName(data, 'Driver'), phone: extractPhone(data), category: 'Driver', isSystem: true }; }).filter(c => c.phone.length >= 10)));
    const unsubCu = onSnapshot(collection(db, "CUSTOMERS"), s => setSysCustomers(s.docs.map(d => { const data = d.data(); return { id: d.id, name: extractName(data, 'Customer'), phone: extractPhone(data), category: 'Customer', isSystem: true }; }).filter(c => c.phone.length >= 10)));
    const unsubVe = onSnapshot(collection(db, "COMPANIES"), s => setSysVendors(s.docs.map(d => { const data = d.data(); return { id: d.id, name: extractName(data, 'Vendor'), phone: extractPhone(data), category: 'Vendor', isSystem: true }; }).filter(c => c.phone.length >= 10)));
    
    const unsubRu = onSnapshot(collection(db, "WA_RULES"), s => setRules(s.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubSc = onSnapshot(collection(db, "WA_SCHEDULES"), s => setSchedules(s.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubLe = onSnapshot(collection(db, "WA_LEADS"), s => setLeads(s.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubLogs = onSnapshot(collection(db, "WA_LOGS"), s => { const fetchedLogs = s.docs.map(d => ({ id: d.id, ...d.data() })); fetchedLogs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)); setLogs(fetchedLogs); });
    const unsubChats = onSnapshot(collection(db, "WA_CHATS"), s => { const fetchedChats = s.docs.map(d => ({ id: d.id, ...d.data() })); fetchedChats.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp)); setChatMsgs(fetchedChats); });
    const unsubTrips = onSnapshot(collection(db, "TRIPS"), s => { const activeErpTrips = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => t.trip_status !== 'COMPLETED' && t.trip_status !== 'UNLOADED'); setLiveTrips(activeErpTrips); });

    const checkServer = async () => { 
        try { 
            // 🚨 UPDATED TO LIVE SERVER
            const res = await fetch(`https://prasad-api.onrender.com/api/status/${activeUser}`); 
            const data = await res.json(); 
            setIsWa(data.connected); 
            setQr(data.qr); 
            setEngStatus(data.status); 
        } catch (e) { 
            setIsWa(false); 
            setEngStatus('OFFLINE'); 
        } 
    };
    checkServer(); 
    const interval = setInterval(checkServer, 3000);
    
    return () => { unsubWa(); unsubDr(); unsubCu(); unsubVe(); unsubRu(); unsubSc(); unsubLe(); unsubLogs(); unsubChats(); unsubTrips(); clearInterval(interval); };
  }, [activeUser]);

  // 🖱️ AUTO SCROLL CHAT
  useEffect(() => { 
      if(chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' }); 
  }, [chatMsgs, activeTrip, chatRole]);

  // 💾 CRUD OPERATIONS
  const save = async (col, data, reset) => { 
    if(!Object.values(data)[0]) return showToast("⚠️ फॉर्म खाली है!", "error");
    try { 
        await addDoc(collection(db, col), data); 
        showToast("✅ सफलतापूर्वक सेव हुआ!"); 
        logActivity(`Created record in ${col.replace('WA_', '')}`); 
        reset(); 
    } catch(e) { showToast("❌ सेव नहीं हुआ", "error"); }
  };

  const del = async (col, id) => { 
      if(confirm("डिलीट करना चाहते हैं?")) { 
          await deleteDoc(doc(db, col, id)); 
          showToast("🗑️ डिलीट हो गया!", "success"); 
          logActivity(`Deleted record from ${col.replace('WA_', '')}`); 
      } 
  };

  const handleCreateTrip = () => {
      if(!fTrip.tripId || !fTrip.driverPhone) return showToast("⚠️ Trip ID और Driver Phone ज़रूरी है!", "error");
      save('WA_LIVE_TRIPS', { ...fTrip, createdAt: new Date().toISOString() }, () => setFTrip({ tripId: '', driverPhone: '', customerPhone: '' }));
  };

  const handleScheduleSave = () => { 
      if(!fS.phone || !fS.datetime || !fS.message) return showToast("⚠️ कृपया नंबर, तारीख और मैसेज भरें!", "error"); 
      save('WA_SCHEDULES', fS, () => setFS({phone: '', message: '', datetime: ''})); 
  };

  // 📢 BROADCAST DISPATCH
  const startBulk = async () => {
    if(!msg || selPhones.length === 0) return showToast("⚠️ नंबर और मैसेज चुनें!", "error");
    showToast(`🚀 ${selPhones.length} लोगों को भेज रहे हैं...`, "accent"); 
    logActivity(`Broadcasted to ${selPhones.length} contacts.`);
    for (const p of selPhones) { 
        try { 
            // 🚨 UPDATED TO LIVE SERVER
            await fetch('https://prasad-api.onrender.com/api/send-whatsapp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ userId: activeUser, number: p, message: msg }) }); 
            await new Promise(r => setTimeout(r, 2000)); 
        } catch(e) {} 
    }
    showToast("✅ ब्रॉडकास्ट पूरा हुआ!", "success"); 
    setSelPhones([]); 
    setMsg('');
  };

  // 🔥 FIND DYNAMIC PHONE NUMBER FOR TRIP CHAT
  const getActivePhone = () => {
      if(!activeTrip) return null;
      if(chatRole === 'Driver') {
          const drv = sysDrivers.find(d => d.name === activeTrip.driver_name);
          return drv ? drv.phone : null;
      } else {
          const cst = sysCustomers.find(c => c.name === activeTrip.consignee_name);
          return cst ? cst.phone : null;
      }
  };

  // 💬 SINGLE TRIP CHAT DISPATCH
  const sendTripChat = async () => {
      if(!chatInput || !activeTrip) return;
      const targetPhone = getActivePhone();
      if(!targetPhone) return showToast(`⚠️ No phone number saved for ${chatRole}`, "error");

      const text = chatInput; 
      setChatInput(''); 
      try {
        // 🚨 UPDATED TO LIVE SERVER
        await fetch('https://prasad-api.onrender.com/api/send-whatsapp', { 
            method:'POST', headers:{'Content-Type':'application/json'}, 
            body:JSON.stringify({ userId: activeUser, number: targetPhone, message: text, tripId: activeTrip.trip_id, role: chatRole }) 
        });
        logActivity(`Sent Trip Msg to ${chatRole} (${activeTrip.trip_id})`);
      } catch(e) { showToast("❌ Error sending message", "error"); }
  };

  // 🔍 FILTERS
  const filteredContacts = contacts.filter(c => (c.name?.toLowerCase().includes(searchContact.toLowerCase()) || c.phone?.includes(searchContact)) && (bcFilter === 'All' || c.category === bcFilter));
  const activePhoneToView = getActivePhone();
  const currentChatHistory = chatMsgs.filter(c => c.phone === activePhoneToView);

  const handleSmartSelectAll = () => {
    const currentFilteredPhones = filteredContacts.map(c => c.phone);
    const allSelected = currentFilteredPhones.length > 0 && currentFilteredPhones.every(p => selPhones.includes(p));
    if (allSelected) setSelPhones(selPhones.filter(p => !currentFilteredPhones.includes(p))); 
    else setSelPhones([...new Set([...selPhones, ...currentFilteredPhones])]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', minHeight: '100vh', maxWidth: '100%', background: theme.bg, color: 'white', fontFamily: 'sans-serif' }}>

      {/* 🔔 TOAST NOTIFICATION */}
      {status.show && ( <div style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', background: status.type === 'error' ? theme.danger : status.type === 'accent' ? theme.accent : theme.wa, color: 'black', padding: '12px 25px', borderRadius: '30px', fontWeight: 'bold', zIndex: 1000, boxShadow: '0 5px 15px rgba(0,0,0,0.5)', maxWidth: '90vw' }}>{status.text}</div> )}

      {/* 🟢 SIDEBAR — vertical on desktop, horizontal scroll bar on mobile */}
      <div style={{ width: isMobile ? '100%' : '270px', padding: isMobile ? '12px' : '25px', borderRight: isMobile ? 'none' : `1px solid ${theme.border}`, borderBottom: isMobile ? `1px solid ${theme.border}` : 'none', display:'flex', flexDirection:'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
          <h2 style={{ color: theme.wa, marginBottom: isMobile ? '10px' : '20px', letterSpacing: '1px', fontSize: isMobile ? '18px' : '24px' }}>PRASAD <span style={{color:'white'}}>PRO</span></h2>
          <div style={{ fontSize: isMobile ? '11px' : '13px', color: isWa ? theme.wa : theme.danger, fontWeight:'bold', whiteSpace:'nowrap' }}>● {isWa ? 'Online' : 'Offline'}</div>
        </div>

        {!isMobile && (
        <div style={{marginBottom:'20px', background:theme.inputBg, padding:'15px', borderRadius:'12px', border:`1px solid ${theme.accent}`}}>
            <label style={{fontSize:'12px', color:theme.sub}}>Current User</label>
            <input value={activeUser} onChange={e => setActiveUser(e.target.value)} style={{width:'100%', background:'transparent', border:'none', color:'white', outline:'none', fontWeight:'bold', marginTop:'5px', fontSize:'16px'}} />
        </div>
        )}

        <div style={{ flex: isMobile ? '0 0 auto' : 1, overflowX: isMobile ? 'auto' : 'visible', overflowY: isMobile ? 'visible' : 'auto', display: 'flex', flexDirection: isMobile ? 'row' : 'column', gap: isMobile ? '6px' : '0', WebkitOverflowScrolling: 'touch' }} className="hide-scrollbar">
            {['MAMTA AI', 'DASHBOARD', 'CONNECT', 'TRIP CHAT', 'BROADCAST', 'KANBAN', 'CHATBOT', 'SCHEDULE', 'CONTACTS', 'QR GENERATOR', 'SYSTEM LOGS'].map(m => (
              <div key={m} onClick={() => setTab(m)} style={{ padding: isMobile ? '8px 12px' : '13px', cursor: 'pointer', borderRadius: '12px', marginBottom: isMobile ? '0' : '8px', background: tab === m ? 'rgba(16,185,129,0.15)' : 'transparent', color: tab === m ? theme.wa : theme.sub, fontWeight: tab === m ? 'bold' : 'normal', transition: '0.3s', whiteSpace: 'nowrap', fontSize: isMobile ? '13px' : '15px', flexShrink: 0 }}>
                {m === 'MAMTA AI' ? '🤖 MAMTA AI' : m === 'CONNECT' ? '🔗 Link WhatsApp' : m === 'DASHBOARD' ? '📊 AI Dashboard' : m === 'TRIP CHAT' ? '💬 Trip Manager' : m === 'KANBAN' ? '📋 Kanban Leads' : m === 'CHATBOT' ? '🤖 AI Chatbot' : m === 'SCHEDULE' ? '⏳ Scheduler' : m === 'QR GENERATOR' ? '📱 Public QR Code' : m === 'SYSTEM LOGS' ? '📝 System Logs' : m}
              </div>
            ))}
        </div>
      </div>

      {/* ⚪ MAIN CONTENT */}
      <div style={{ flex: 1, padding: isMobile ? '12px' : '30px', overflowY: 'auto', maxWidth: '100%' }}>
        <div style={{ background: theme.card, borderRadius: isMobile ? '14px' : '25px', padding: isMobile ? '14px' : '35px', minHeight: '85vh', border: `1px solid ${theme.border}` }}>
          
          {/* ======================= TAB: MAMTA AI (local RAG chat) ======================= */}
          {tab === 'MAMTA AI' && <MamtaChat />}

          {/* ======================= TAB 1: DASHBOARD ======================= */}
          {tab === 'DASHBOARD' && (
            <div>
              <h2 style={{ marginBottom: '10px', color: theme.wa }}>✨ Welcome, {activeUser}</h2>
              <p style={{ color: theme.sub, marginBottom: '25px' }}>Your Live Business Insights & AI Overview</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '20px', marginBottom: '40px' }}>
                {[{t: 'Total Contacts', c: contacts.length, col: theme.accent}, {t: 'Active Leads', c: leads.length, col: theme.ai}, {t: 'Bot Rules', c: rules.length, col: theme.wa}, {t: 'Scheduled Msgs', c: schedules.length, col: '#FACC15'}].map((st, i) => (
                  <div key={i} style={{ background: theme.bg, padding: '25px', borderRadius: '20px', border: `1px solid ${theme.border}`, borderLeft: `4px solid ${st.col}` }}>
                    <div style={{ fontSize: '13px', color: theme.sub }}>{st.t}</div>
                    <div style={{ fontSize: '32px', fontWeight: 'bold', color: 'white', marginTop: '10px' }}>{st.c}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ======================= TAB 2: CONNECT ======================= */}
          {tab === 'CONNECT' && (
            <div style={{ textAlign:'center', paddingTop:'40px' }}>
              <h2 style={{fontSize:'28px', marginBottom:'10px'}}>Personal WhatsApp Link</h2>
              <p style={{color:theme.sub, marginBottom:'40px'}}>Hello <b>{activeUser}</b>, अपना मोबाइल स्कैन करें।</p>
              {isWa ? ( <div style={{background:'rgba(16,185,129,0.1)', padding:'40px', borderRadius:'20px', border:`1px solid ${theme.wa}`, display:'inline-block'}}> <h2 style={{color:theme.wa}}>✅ Connected Successfully!</h2> </div>
              ) : qr ? ( <div style={{background:'white', padding:'25px', borderRadius:'20px', display:'inline-block'}}><QRCodeSVG value={qr} size={250} /><p style={{color:'#020617', marginTop:'15px', fontWeight:'bold', fontSize:'18px'}}>Scan with WhatsApp</p></div>
              ) : <div style={{color:theme.accent, fontSize:'18px'}}>⏳ {engStatus === 'STARTING' ? 'इंजन चालू हो रहा है...' : 'सर्वर कनेक्ट हो रहा है...'}</div>}
            </div>
          )}

          {/* ======================= TAB 3: TRIP CHAT ======================= */}
          {tab === 'TRIP CHAT' && (
            <div style={{display:'flex', flexDirection: isMobile ? 'column' : 'row', height: isMobile ? 'auto' : '75vh', minHeight: isMobile ? '78vh' : 'auto', gap:'20px'}}>
               <div style={{width: isMobile ? '100%' : '350px', maxHeight: isMobile ? '38vh' : 'none', background:theme.bg, borderRadius:'20px', border:`1px solid ${theme.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink: 0}}>
                  <div style={{padding:'20px', borderBottom:`1px solid ${theme.border}`, background:theme.inputBg}}>
                      <h3 style={{margin:0, color:theme.wa}}>🚚 Active ERP Trips</h3>
                      <p style={{fontSize:'12px', color:theme.sub, marginTop:'5px'}}>Auto-Synced from Trip Management</p>
                  </div>
                  <div style={{flex:1, overflowY:'auto', padding:'10px'}}>
                      {liveTrips.length === 0 && <div style={{textAlign:'center', color:theme.sub, marginTop:'30px', fontSize:'13px'}}>No Active Trips in ERP. <br/><br/>Start a trip from "Trip Command Center" to see it here!</div>}
                      {liveTrips.map(t => (
                          <div key={t.id} onClick={() => setActiveTrip(t)} style={{padding:'15px', background:activeTrip?.id === t.id ? 'rgba(56,189,248,0.1)' : 'transparent', borderRadius:'12px', cursor:'pointer', borderBottom:`1px solid ${theme.border}`, transition:'0.2s', borderLeft: activeTrip?.id === t.id ? `4px solid ${theme.accent}` : '4px solid transparent'}}>
                             <div style={{fontWeight:'bold', fontSize:'15px', color:theme.accent}}>{t.trip_id}</div>
                             <div style={{fontSize:'12px', color:'white', marginTop:'5px'}}>🚛 Vehicle: {t.vehicle_no}</div>
                             <div style={{fontSize:'11px', color:theme.sub, marginTop:'3px'}}>Driver: {t.driver_name} <br/>Cust: {t.consignee_name}</div>
                          </div>
                      ))}
                  </div>
               </div>

               <div style={{flex:1, background:theme.bg, borderRadius:'20px', border:`1px solid ${theme.border}`, display:'flex', flexDirection:'column', overflow:'hidden'}}>
                   {activeTrip ? (
                       <>
                          <div style={{padding:'20px', background:theme.inputBg, borderBottom:`1px solid ${theme.border}`, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                              <div>
                                  <h3 style={{margin:0, color:theme.accent}}>Trip: {activeTrip.trip_id}</h3>
                                  <div style={{fontSize:'12px', color:theme.sub, marginTop:'3px'}}>{activeTrip.loading_point} ➔ {activeTrip.consignee_name}</div>
                              </div>
                              <div style={{display:'flex', gap:'10px', background:theme.bg, padding:'5px', borderRadius:'10px'}}>
                                  <button onClick={() => setChatRole('Driver')} style={{padding:'8px 15px', background:chatRole === 'Driver' ? theme.wa : 'transparent', color:chatRole === 'Driver' ? 'black' : 'white', border:'none', borderRadius:'8px', cursor:'pointer', fontWeight:'bold'}}>🚛 Driver Chat</button>
                                  <button onClick={() => setChatRole('Customer')} style={{padding:'8px 15px', background:chatRole === 'Customer' ? theme.wa : 'transparent', color:chatRole === 'Customer' ? 'black' : 'white', border:'none', borderRadius:'8px', cursor:'pointer', fontWeight:'bold'}}>👤 Customer Chat</button>
                              </div>
                          </div>

                          <div style={{flex:1, overflowY:'auto', padding:'20px', display:'flex', flexDirection:'column', gap:'15px', backgroundImage:'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")', backgroundBlendMode:'overlay', backgroundColor:'rgba(2, 6, 23, 0.95)'}}>
                              {(!activeChatPhoneView) && <div style={{background:'rgba(244,63,94,0.2)', padding:'15px', borderRadius:'10px', color:theme.danger, textAlign:'center', border:`1px solid ${theme.danger}`}}>⚠️ {chatRole} का मोबाइल नंबर Master Directory में सेव नहीं है! कृपया पहले नंबर सेव करें।</div>}
                              
                              {currentChatHistory.length === 0 && activeChatPhoneView && <div style={{textAlign:'center', color:theme.sub, marginTop:'50px'}}>यहाँ मैसेज टाइप करें। यह सीधे {chatRole} ({activeChatPhoneView}) के WhatsApp पर जाएगा!</div>}
                              
                              {currentChatHistory.map(msg => (
                                  <div key={msg.id} style={{alignSelf: msg.type === 'outgoing' ? 'flex-end' : 'flex-start', maxWidth:'70%', background: msg.type === 'outgoing' ? theme.wa : theme.inputBg, color: msg.type === 'outgoing' ? 'black' : 'white', padding:'12px 18px', borderRadius: msg.type === 'outgoing' ? '20px 20px 0 20px' : '20px 20px 20px 0', border:`1px solid ${theme.border}`, boxShadow:'0 5px 15px rgba(0,0,0,0.1)'}}>
                                      {msg.type === 'outgoing' && <div style={{fontSize:'10px', fontWeight:'bold', color: msg.userId === 'Mamta AI' ? '#6B21A8' : '#064E3B', marginBottom:'3px'}}>✓ Sent by {msg.userId}</div>}
                                      <div style={{fontSize:'15px'}}>{msg.text}</div>
                                      <div style={{fontSize:'10px', textAlign:'right', marginTop:'5px', opacity:0.7}}>{new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                                  </div>
                              ))}
                              <div ref={chatEndRef} />
                          </div>

                          <div style={{padding:'20px', background:theme.inputBg, borderTop:`1px solid ${theme.border}`, display:'flex', gap:'15px'}}>
                              <input disabled={!activeChatPhoneView} value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyPress={e => e.key === 'Enter' && sendTripChat()} placeholder={activeChatPhoneView ? `Type message for ${chatRole}...` : 'Mobile number missing...'} style={{flex:1, background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'15px', borderRadius:'30px', outline:'none', fontSize:'15px', opacity: activeChatPhoneView ? 1 : 0.5}} />
                              <button disabled={!activeChatPhoneView} onClick={sendTripChat} style={{background:theme.wa, color:'black', border:'none', padding:'0 18px', borderRadius:'30px', fontWeight:'bold', cursor:'pointer', fontSize:'15px', opacity: activeChatPhoneView ? 1 : 0.5}}>Send 🚀</button>
                              {/* 📱 Free click-to-chat — opens YOUR own WhatsApp (mobile app/web) with msg + number prefilled, no server */}
                              <button disabled={!activeChatPhoneView} title="Apne WhatsApp se bhejein (free)" onClick={() => { const num = String(activeChatPhoneView).replace(/\D/g, ''); const n = num.length === 10 ? '91' + num : num; window.open(`https://wa.me/${n}?text=${encodeURIComponent(chatInput || '')}`, '_blank'); }} style={{ background:'#25D366', color:'white', border:'none', padding:'0 16px', borderRadius:'30px', fontWeight:'bold', cursor:'pointer', fontSize:'14px', opacity: activeChatPhoneView ? 1 : 0.5, whiteSpace:'nowrap' }}>📱 WhatsApp</button>
                          </div>
                       </>
                   ) : (
                       <div style={{flex:1, display:'flex', justifyContent:'center', alignItems:'center', color:theme.sub, flexDirection:'column'}}>
                           <h1 style={{fontSize:'50px', margin:0}}>💬</h1>
                           <h3>Select a Live Trip to start chatting</h3>
                           <p>Manage conversations with Drivers and Customers easily.</p>
                       </div>
                   )}
               </div>
            </div>
          )}

          {/* ======================= TAB 4: BROADCAST ======================= */}
          {tab === 'BROADCAST' && (
            <div>
              <div style={{display:'flex', justifyContent:'space-between', marginBottom:'25px', alignItems:'center'}}>
                <h2>Broadcast Center</h2>
                <div style={{display:'flex', gap:'8px'}}>{['All', 'Driver', 'Vendor', 'Customer'].map(c => <button key={c} onClick={()=>setBcFilter(c)} style={{padding:'10px 18px', background:bcFilter===c?theme.wa:theme.inputBg, border:`1px solid ${theme.border}`, color:bcFilter===c?'black':'white', borderRadius:'10px', cursor:'pointer', fontWeight:'bold'}}>{c}</button>)}</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                 <label style={{ fontSize: '13px', color: theme.sub }}>Total Selected: {selPhones.length}</label>
                 <button onClick={handleSmartSelectAll} style={{ background: 'transparent', border: `1px solid ${theme.accent}`, color: theme.accent, fontSize: '12px', padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}> {filteredContacts.length > 0 && filteredContacts.every(c => selPhones.includes(c.phone)) ? 'Unselect All Displayed' : 'Select All Displayed'} </button>
              </div>
              <input value={searchContact} onChange={e=>setSearchContact(e.target.value)} placeholder="🔍 नाम या नंबर से सर्च करें..." style={{width:'100%', background:theme.inputBg, border:`1px solid ${theme.border}`, padding:'15px', borderRadius:'12px', color:'white', marginBottom:'20px', outline:'none'}} />
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:'15px', maxHeight:'300px', overflowY:'auto', background:'#020617', padding:'20px', borderRadius:'15px', border:`1px solid ${theme.border}`}}>
                {filteredContacts.map(c => (
                  <div key={c.id} onClick={() => selPhones.includes(c.phone) ? setSelPhones(selPhones.filter(p=>p!==c.phone)) : setSelPhones([...selPhones, c.phone])} style={{padding:'15px', background:selPhones.includes(c.phone)?'rgba(16,185,129,0.15)':theme.inputBg, borderRadius:'12px', cursor:'pointer', border:`1px solid ${selPhones.includes(c.phone)?theme.wa:theme.border}`}}>
                    <div style={{fontWeight:'bold', fontSize:'15px'}}>{c.name} {c.isSystem && <span style={{fontSize:'10px', color:theme.accent, border:'1px solid', padding:'2px 5px', borderRadius:'5px', marginLeft:'8px'}}>ERP</span>}</div>
                    <div style={{fontSize:'12px', color:theme.sub, marginTop:'5px'}}>📞 {c.phone} | <span style={{color:theme.accent}}>{c.category}</span></div>
                  </div>
                ))}
              </div>
              <textarea value={msg} onChange={e=>setMsg(e.target.value)} placeholder="मैसेज यहाँ लिखें..." style={{width:'100%', height:'120px', background:theme.inputBg, border:`1px solid ${theme.border}`, borderRadius:'12px', color:'white', marginTop:'20px', padding:'15px', outline:'none', resize:'none'}} />
              <button onClick={startBulk} style={{width:'100%', marginTop:'15px', background:theme.wa, color:'black', padding:'18px', borderRadius:'12px', fontWeight:'bold', fontSize:'16px', border:'none', cursor:'pointer'}}>Dispatch via {activeUser} 🚀</button>
            </div>
          )}

          {/* ======================= TAB 5: KANBAN ======================= */}
          {tab === 'KANBAN' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
                <h2>📋 Workflow Manager</h2>
                <div style={{ display: 'flex', gap: '10px', background:theme.inputBg, padding:'10px', borderRadius:'12px', border:`1px solid ${theme.border}`}}>
                  <input value={fL.name} onChange={e=>setFL({...fL, name: e.target.value})} placeholder="Company Name" style={{background:'transparent', border:'none', color:'white', outline:'none', width: '150px'}} />
                  <input value={fL.req} onChange={e=>setFL({...fL, req: e.target.value})} placeholder="Requirement..." style={{background:'transparent', border:'none', color:'white', outline:'none', width: '200px', borderLeft:`1px solid ${theme.border}`, paddingLeft:'10px'}} />
                  <button onClick={()=>save('WA_LEADS', fL, ()=>setFL({name:'', req:'', status:'NEW LEAD'}))} style={{background:theme.wa, color:'black', border:'none', padding:'8px 15px', borderRadius:'8px', fontWeight:'bold', cursor:'pointer'}}>+ Add</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '20px', overflowX: 'auto', paddingBottom: '20px', minHeight: '60vh' }}>
                {['NEW LEAD', 'IN CONVERSATION', 'QUOTE SENT', 'CLOSED'].map(colStatus => (
                  <div key={colStatus} onDragOver={(e) => e.preventDefault()} onDrop={async (e) => { e.preventDefault(); const id = e.dataTransfer.getData("leadId"); if(id) { await updateDoc(doc(db, "WA_LEADS", id), { status: colStatus }); logActivity(`Moved Kanban Lead to ${colStatus}`); showToast(`Moved to ${colStatus}`); } }} style={{ minWidth: '300px', background: '#020617', padding: '20px', borderRadius: '15px', border: `1px dashed ${theme.border}`, display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    <h4 style={{ color: colStatus === 'CLOSED' ? theme.wa : theme.accent, borderBottom: `1px solid ${theme.border}`, paddingBottom: '10px' }}>{colStatus} ({leads.filter(l => l.status === colStatus).length})</h4>
                    {leads.filter(l => l.status === colStatus).map(lead => (
                      <div key={lead.id} draggable onDragStart={(e) => e.dataTransfer.setData("leadId", lead.id)} style={{ background: theme.inputBg, padding: '15px', borderRadius: '10px', borderLeft: `4px solid ${theme.accent}`, cursor: 'grab' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b style={{ fontSize: '15px' }}>{lead.name}</b><button onClick={()=>del('WA_LEADS', lead.id)} style={{ background:'none', border:'none', color:theme.danger, cursor:'pointer' }}>✖</button></div>
                        <p style={{ fontSize: '12px', color: theme.sub, margin: '5px 0 0 0' }}>{lead.req}</p>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ======================= TAB 6: CHATBOT ======================= */}
          {tab === 'CHATBOT' && (
            <div>
              <h2 style={{color:theme.ai, marginBottom:'25px'}}>🤖 AI Chatbot Automation</h2>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1.5fr 1fr auto', gap:'15px', marginBottom:'25px', background:theme.inputBg, padding:'20px', borderRadius:'15px', border:`1px solid ${theme.border}`}}>
                <div style={{flexDirection:'column', display:'flex', gap:'5px'}}><label style={{fontSize:'12px', color:theme.sub}}>Trigger Keyword</label><input value={fR.keyword} onChange={e=>setFR({...fR, keyword:e.target.value})} placeholder="उदा. Price" style={{background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', outline:'none'}} /></div>
                <div style={{flexDirection:'column', display:'flex', gap:'5px'}}><label style={{fontSize:'12px', color:theme.sub}}>AI Reply Message</label><input value={fR.reply} onChange={e=>setFR({...fR, reply:e.target.value})} placeholder="बॉट क्या जवाब देगा?" style={{background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', outline:'none'}} /></div>
                <div style={{flexDirection:'column', display:'flex', gap:'5px'}}><label style={{fontSize:'12px', color:theme.sub}}>Action</label><select value={fR.action} onChange={e=>setFR({...fR, action:e.target.value})} style={{background:theme.bg, color:'white', border:`1px solid ${theme.border}`, borderRadius:'8px', padding:'12px', outline:'none'}}><option>Reply Only</option><option>Add to Leads</option></select></div>
                <button onClick={()=>save('WA_RULES', fR, ()=>setFR({keyword:'', reply:'', action:'Reply Only'}))} style={{alignSelf:'flex-end', background:theme.ai, color:'white', border:'none', padding:'14px 25px', borderRadius:'8px', fontWeight:'bold', cursor:'pointer'}}>Add Rule</button>
              </div>
              <div style={{background:theme.inputBg, borderRadius:'15px', overflow:'hidden', border:`1px solid ${theme.border}`}}>
                <table style={{width:'100%', textAlign:'left', borderCollapse:'collapse'}}><thead style={{background:'rgba(255,255,255,0.05)'}}><tr style={{color:theme.sub, borderBottom:`1px solid ${theme.border}`}}><th style={{padding:'15px'}}>TRIGGER KEYWORD</th><th>AUTO REPLY</th><th>ACTION</th><th style={{textAlign:'center'}}>DEL</th></tr></thead><tbody>
                      {rules.map(r => (<tr key={r.id} style={{borderBottom:`1px solid ${theme.border}`}}><td style={{padding:'15px', color:theme.wa}}><b>{r.keyword}</b></td><td style={{fontSize:'14px'}}>{r.reply}</td><td style={{fontSize:'12px'}}><span style={{background:theme.card, padding:'5px 10px', borderRadius:'6px', border:`1px solid ${theme.border}`}}>{r.action}</span></td><td style={{textAlign:'center'}}><button onClick={()=>del('WA_RULES', r.id)} style={{background:'none', border:'none', color:theme.danger, cursor:'pointer', fontSize:'18px'}}>🗑️</button></td></tr>))}
                </tbody></table>
              </div>
            </div>
          )}

          {/* ======================= TAB 7: SCHEDULE ======================= */}
          {tab === 'SCHEDULE' && (
            <div>
              <h2 style={{color:'#FACC15', marginBottom:'25px'}}>⏳ Smart Message Scheduler</h2>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'15px', marginBottom:'25px', background:theme.inputBg, padding:'20px', borderRadius:'15px', border:`1px solid ${theme.border}`}}>
                <div style={{flexDirection:'column', display:'flex', gap:'5px'}}><label style={{fontSize:'12px', color:theme.sub}}>Target Mobile Number</label><input value={fS.phone} onChange={e=>setFS({...fS, phone:e.target.value})} placeholder="e.g. 98XXXXXXXX" style={{background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', outline:'none'}} /></div>
                <div style={{flexDirection:'column', display:'flex', gap:'5px'}}><label style={{fontSize:'12px', color:theme.sub}}>Delivery Date & Time</label><input type="datetime-local" value={fS.datetime} onChange={e=>setFS({...fS, datetime:e.target.value})} style={{background:theme.bg, color:'white', colorScheme:'dark', border:`1px solid ${theme.border}`, padding:'11px', borderRadius:'8px', outline:'none'}} /></div>
                <div style={{gridColumn:'span 2', display:'flex', flexDirection:'column', gap:'5px'}}><label style={{fontSize:'12px', color:theme.sub}}>Message Content</label><textarea value={fS.message} onChange={e=>setFS({...fS, message:e.target.value})} placeholder="क्या मैसेज भेजना है?" style={{background:theme.bg, border:`1px solid ${theme.border}`, borderRadius:'8px', color:'white', padding:'15px', height:'100px', outline:'none', resize:'none'}} /></div>
                <button onClick={handleScheduleSave} style={{gridColumn:'span 2', background:'#FACC15', color:'black', border:'none', padding:'15px', borderRadius:'10px', fontWeight:'bold', fontSize:'16px', cursor:'pointer', marginTop:'10px'}}>Save Scheduled Task ⏰</button>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:'15px'}}>
                {schedules.map(sch => (<div key={sch.id} style={{padding:'20px', background:theme.inputBg, borderRadius:'15px', borderLeft:`5px solid #FACC15`, borderTop:`1px solid ${theme.border}`, borderRight:`1px solid ${theme.border}`, borderBottom:`1px solid ${theme.border}`, display:'flex', justifyContent:'space-between', alignItems:'center'}}><div><div style={{fontWeight:'bold', fontSize:'16px'}}>📞 {sch.phone}</div><div style={{fontSize:'13px', color:theme.sub, marginTop:'6px'}}>🕒 {sch.datetime ? new Date(sch.datetime).toLocaleString() : 'Invalid Date'}</div><p style={{margin:'10px 0 0 0', fontSize:'14px', color:'white'}}>"{sch.message}"</p></div><button onClick={()=>del('WA_SCHEDULES', sch.id)} style={{background:'rgba(244,63,94,0.1)', border:'none', color:theme.danger, cursor:'pointer', padding:'10px', borderRadius:'10px', fontSize:'16px'}}>🗑️</button></div>))}
              </div>
            </div>
          )}

          {/* ======================= TAB 8: CONTACTS ======================= */}
          {tab === 'CONTACTS' && (
            <div>
              <h2 style={{marginBottom:'25px'}}>👤 System Directory (ERP + Custom)</h2>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap:'15px', marginBottom:'25px', background:theme.inputBg, padding:'20px', borderRadius:'15px', border:`1px solid ${theme.border}`}}>
                <input value={fC.name} onChange={e=>setFC({...fC, name:e.target.value})} placeholder="Name" style={{background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', outline:'none'}} />
                <input value={fC.phone} onChange={e=>setFC({...fC, phone:e.target.value})} placeholder="Phone" style={{background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', outline:'none'}} />
                <select value={fC.category} onChange={e=>setFC({...fC, category:e.target.value})} style={{background:theme.bg, color:'white', border:`1px solid ${theme.border}`, borderRadius:'8px', padding:'12px', outline:'none'}}><option>Driver</option><option>Vendor</option><option>Customer</option></select>
                <button onClick={()=>save('WA_CONTACTS', fC, ()=>setFC({name:'', phone:'', category:'Driver'}))} style={{background:theme.wa, color:'black', border:'none', padding:'12px 20px', borderRadius:'8px', fontWeight:'bold', cursor:'pointer'}}>Add New</button>
              </div>
              <div style={{background:theme.inputBg, borderRadius:'15px', overflow:'hidden', border:`1px solid ${theme.border}`}}>
                <table style={{width:'100%', textAlign:'left', borderCollapse:'collapse'}}><thead style={{background:'rgba(255,255,255,0.05)'}}><tr style={{color:theme.sub, borderBottom:`1px solid ${theme.border}`}}><th style={{padding:'15px'}}>NAME</th><th>CONTACT</th><th>CATEGORY</th><th style={{textAlign:'center'}}>ACTION</th></tr></thead><tbody>
                    {contacts.map(c => (<tr key={c.id} style={{borderBottom:`1px solid ${theme.border}`}}><td style={{padding:'15px', fontSize:'15px'}}><b>{c.name}</b></td><td style={{color:theme.sub}}>{c.phone}</td><td><span style={{background:'rgba(56,189,248,0.1)', color:theme.accent, padding:'5px 12px', borderRadius:'6px', fontSize:'12px', fontWeight:'bold'}}>{c.category}</span></td><td style={{textAlign:'center'}}>{c.isSystem ? <span style={{color:theme.wa, fontSize:'11px', fontWeight:'bold'}}>🔒 ERP Sync</span> : <button onClick={()=>del('WA_CONTACTS', c.id)} style={{color:theme.danger, background:'none', border:'none', cursor:'pointer', fontWeight:'bold'}}>Delete</button>}</td></tr>))}
                  </tbody></table>
              </div>
            </div>
          )}

          {/* ======================= TAB 9: QR GENERATOR ======================= */}
          {tab === 'QR GENERATOR' && (
            <div>
              <h2 style={{color:theme.wa, marginBottom:'10px'}}>📱 Public WhatsApp QR Code</h2>
              <div style={{display:'flex', gap:'30px', flexWrap:'wrap'}}>
                <div style={{flex:1, background:theme.inputBg, padding:'25px', borderRadius:'15px', border:`1px solid ${theme.border}`}}>
                  <div style={{marginBottom:'15px'}}><label style={{fontSize:'12px', color:theme.sub, display:'block', marginBottom:'5px'}}>Your WhatsApp Number</label><input value={qrGen.phone} onChange={e=>setQrGen({...qrGen, phone:e.target.value})} style={{width:'100%', background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', outline:'none'}} /></div>
                  <div><label style={{fontSize:'12px', color:theme.sub, display:'block', marginBottom:'5px'}}>Auto-Message</label><textarea value={qrGen.text} onChange={e=>setQrGen({...qrGen, text:e.target.value})} style={{width:'100%', background:theme.bg, border:`1px solid ${theme.border}`, color:'white', padding:'12px', borderRadius:'8px', height:'100px', outline:'none', resize:'none'}} /></div>
                </div>
                <div style={{width:'300px', background:'white', padding:'25px', borderRadius:'15px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center'}}>
                   <QRCodeSVG value={`https://wa.me/${qrGen.phone.replace(/\D/g, '')}?text=${encodeURIComponent(qrGen.text)}`} size={220} /><p style={{color:'#020617', fontWeight:'bold', marginTop:'20px', textAlign:'center'}}>Scan to Contact Us</p>
                </div>
              </div>
            </div>
          )}

          {/* ======================= TAB 10: SYSTEM LOGS ======================= */}
          {tab === 'SYSTEM LOGS' && (
            <div>
              <h2 style={{color:theme.accent, marginBottom:'10px'}}>📝 Administrator Logs</h2>
              <div style={{background:theme.inputBg, borderRadius:'15px', overflow:'hidden', border:`1px solid ${theme.border}`}}>
                <table style={{width:'100%', textAlign:'left', borderCollapse:'collapse'}}><thead style={{background:'rgba(255,255,255,0.05)'}}><tr style={{color:theme.sub, borderBottom:`1px solid ${theme.border}`}}><th style={{padding:'15px'}}>DATE & TIME</th><th>USER (STAFF)</th><th>ACTION PERFORMED</th></tr></thead><tbody>
                    {logs.map(log => (<tr key={log.id} style={{borderBottom:`1px solid ${theme.border}`}}><td style={{padding:'15px', fontSize:'12px', color:theme.sub}}>{new Date(log.timestamp).toLocaleString()}</td><td style={{fontWeight:'bold', color:theme.ai}}>{log.user}</td><td style={{fontSize:'14px', color:'white'}}>{log.action}</td></tr>))}
                  </tbody></table>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default WhatsappDashboard;