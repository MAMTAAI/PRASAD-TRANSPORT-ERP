import React, { useState } from 'react';

export default function WhatsappDashboard() {
  const [activeChat, setActiveChat] = useState('Driver: Ramesh Kumar');
  const [message, setMessage] = useState('');

  // Dummy Contacts (Drivers, Parties, Vendors)
  const contacts = [
    { name: 'Driver: Ramesh Kumar', role: 'Driver - AS26C9808', status: 'Online', lastMsg: 'Bilty received sir.', time: '10:42 AM' },
    { name: 'IOCL Corporation', role: 'Customer / Party', status: 'Offline', lastMsg: 'Please send yesterday invoice.', time: '09:15 AM' },
    { name: 'Sharma Auto Garage', role: 'Vendor', status: 'Online', lastMsg: 'Truck maintenance done.', time: 'Yesterday' },
    { name: 'Driver: Ali Khan', role: 'Driver - NL01AB1234', status: 'Offline', lastMsg: 'Loading complete.', time: 'Yesterday' },
  ];

  // Dummy Chat History
  const chatHistory = [
    { sender: 'me', text: 'Ramesh, gadi load ho gayi?', time: '10:30 AM' },
    { sender: 'them', text: 'Haan sir, nikal raha hu.', time: '10:32 AM' },
    { sender: 'me', text: 'Bilty PDF bhej raha hu, check kar lo.', time: '10:35 AM' },
    { sender: 'me', text: '📄 AS26C9808_Bilty.pdf', time: '10:35 AM', isDoc: true },
    { sender: 'them', text: 'Bilty received sir.', time: '10:42 AM' },
  ];

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", height: '85vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="30" alt="WA" />
            Master WhatsApp Center
          </h2>
          <p style={{ margin: '5px 0 0 0', color: '#25D366', fontSize: '14px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Official Cloud API Connected 🟢
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: '15px' }}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', padding: '10px 20px', borderRadius: '8px', textAlign: 'center' }}>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>Today's Messages</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#fff' }}>142 / 1000</div>
          </div>
          <button style={{ background: '#25D366', color: '#000', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
            ⚙️ API Settings
          </button>
        </div>
      </div>

      {/* WHATSAPP LAYOUT (2 Columns) */}
      <div style={{ display: 'flex', flex: 1, background: '#0f172a', borderRadius: '15px', border: '1px solid #334155', overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
        
        {/* LEFT COLUMN: CONTACTS */}
        <div style={{ width: '350px', background: '#1e293b', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '15px', background: '#0f172a', borderBottom: '1px solid #334155' }}>
            <input type="text" placeholder="🔍 Search Driver or Party..." style={{ width: '100%', padding: '10px 15px', borderRadius: '20px', border: 'none', background: '#334155', color: '#fff', outline: 'none' }} />
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {contacts.map((c, i) => (
              <div key={i} onClick={() => setActiveChat(c.name)} style={{ padding: '15px', borderBottom: '1px solid #334155', cursor: 'pointer', background: activeChat === c.name ? '#334155' : 'transparent', transition: '0.2s', display: 'flex', gap: '15px', alignItems: 'center' }}>
                <div style={{ width: '45px', height: '45px', borderRadius: '50%', background: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', position: 'relative' }}>
                  👤
                  {c.status === 'Online' && <span style={{ position: 'absolute', bottom: 2, right: 2, width: '10px', height: '10px', background: '#25D366', borderRadius: '50%', border: '2px solid #1e293b' }}></span>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                    <strong style={{ color: '#fff', fontSize: '15px' }}>{c.name}</strong>
                    <span style={{ color: '#94a3b8', fontSize: '11px' }}>{c.time}</span>
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px' }}>{c.lastMsg}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: ACTIVE CHAT */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: "url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')", backgroundSize: 'cover' }}>
          
          {/* Chat Header */}
          <div style={{ padding: '15px 25px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>👤</div>
              <div>
                <strong style={{ color: '#fff', fontSize: '16px', display: 'block' }}>{activeChat}</strong>
                <span style={{ color: '#25D366', fontSize: '12px' }}>Online</span>
              </div>
            </div>
            
            {/* Quick ERP Actions */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>📄 Send Bilty</button>
              <button style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid #10b981', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>💸 Advance Slip</button>
              <button style={{ background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', border: '1px solid #f59e0b', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>🧾 Invoice</button>
            </div>
          </div>

          {/* Chat Messages */}
          <div style={{ flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(2, 6, 23, 0.85)' }}>
            <div style={{ textAlign: 'center', margin: '10px 0' }}>
              <span style={{ background: '#1e293b', color: '#94a3b8', padding: '5px 12px', borderRadius: '15px', fontSize: '11px' }}>TODAY</span>
            </div>
            {chatHistory.map((msg, i) => (
              <div key={i} style={{ alignSelf: msg.sender === 'me' ? 'flex-end' : 'flex-start', maxWidth: '60%', minWidth: '150px' }}>
                <div style={{ background: msg.sender === 'me' ? '#005c4b' : '#1e293b', padding: '10px 15px', borderRadius: msg.sender === 'me' ? '12px 0 12px 12px' : '0 12px 12px 12px', color: '#fff', fontSize: '14px', position: 'relative', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>
                  {msg.isDoc && <div style={{ fontSize: '20px', marginBottom: '5px' }}>📄</div>}
                  {msg.text}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '5px', marginTop: '5px' }}>
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)' }}>{msg.time}</span>
                    {msg.sender === 'me' && <span style={{ color: '#38bdf8', fontSize: '12px' }}>✓✓</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Message Input Box */}
          <div style={{ padding: '15px 20px', background: '#1e293b', borderTop: '1px solid #334155', display: 'flex', gap: '15px', alignItems: 'center' }}>
            <button style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '24px', cursor: 'pointer' }}>📎</button>
            <input 
              type="text" 
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type a message..." 
              style={{ flex: 1, padding: '12px 20px', borderRadius: '25px', border: 'none', background: '#334155', color: '#fff', outline: 'none', fontSize: '15px' }} 
            />
            <button style={{ background: '#25D366', border: 'none', width: '45px', height: '45px', borderRadius: '50%', color: '#000', fontSize: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              ➤
            </button>
          </div>

        </div>
      </div>

    </div>
  );
}