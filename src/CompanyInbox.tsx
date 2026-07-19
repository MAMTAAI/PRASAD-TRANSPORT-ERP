// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '837828662164-e64fgi661n40e1f8luq9j31ofp9hlinp.apps.googleusercontent.com';

function InboxUI() {
  const [token, setToken] = useState<string | null>(null);
  const [emails, setEmails] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<any>(null);
  
  // 🗂️ States for Tabs & Settings
  const [activeTab, setActiveTab] = useState('inbox');
  const [showSettings, setShowSettings] = useState(false);
  const [signature, setSignature] = useState(
    localStorage.getItem('erp_email_signature') || 'Best Regards,\nMamta AI (Operations Assistant)\nPrasad Transport Group\nhttps://prasadtransport.com'
  );
  
  // ✍️ Compose Modal States
  const [showCompose, setShowCompose] = useState(false);
  const [composeData, setComposeData] = useState({ to: '', subject: '', body: '' });
  const [isComposing, setIsComposing] = useState(false);
  const [isComposingAI, setIsComposingAI] = useState(false); // Compose में AI के लिए

  // 🤖 AI States (Reply)
  const [aiDraft, setAiDraft] = useState('');
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const login = useGoogleLogin({
    onSuccess: (codeResponse) => {
      setToken(codeResponse.access_token);
      fetchEmails(codeResponse.access_token, 'inbox');
    },
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify',
    onError: (error) => console.log('Login Failed:', error)
  });

  // 📥 Fetch Emails 
  const fetchEmails = async (accessToken: string, tabType = activeTab) => {
    setLoading(true);
    setEmails([]);
    setSelectedEmail(null);
    
    const queryMap = {
      inbox: 'in:inbox',
      sent: 'in:sent',
      draft: 'in:draft',
      spam: 'in:spam',
      bin: 'in:trash'
    };
    const searchQuery = queryMap[tabType] || 'in:inbox';

    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=${searchQuery}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const data = await res.json();
      
      if (data.messages) {
        const emailDetails = await Promise.all(
          data.messages.map(async (msg: any) => {
            const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            const msgData = await msgRes.json();
            
            const headers = msgData.payload?.headers || [];
            const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(No Subject)';
            const from = headers.find((h: any) => h.name === (tabType === 'sent' || tabType === 'draft' ? 'To' : 'From'))?.value || 'Unknown';
            const date = headers.find((h: any) => h.name === 'Date')?.value || '';
            
            const cleanName = from.split('<')[0].trim().replace(/"/g, '');

            return { id: msg.id, subject, from: cleanName, fullFrom: from, date, snippet: msgData.snippet };
          })
        );
        setEmails(emailDetails);
      }
    } catch (err) {
      console.error("Error fetching emails", err);
    }
    setLoading(false);
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    if (token) fetchEmails(token, tab);
  };

  const saveSignature = () => {
    localStorage.setItem('erp_email_signature', signature);
    setShowSettings(false);
    alert('✅ Signature Saved Successfully!');
  };

  const openComposeModal = () => {
    setComposeData({ to: '', subject: '', body: `\n\n${signature}` });
    setShowCompose(true);
  };

  // 🧠 Compose AI - नया मेल लिखने वाला दिमाग
  const handleComposeAI = () => {
    if (!composeData.subject) {
      alert("⚠️ सर, कृपया पहले 'Subject' में लिखिए कि किस बारे में मेल भेजना है, फिर मैं मेल ड्राफ्ट करूँगी!");
      return;
    }
    setIsComposingAI(true);
    setTimeout(() => {
      const smartDraft = `Dear Sir/Madam,\n\nI am writing to you regarding "${composeData.subject}". \n\nPlease let us know if you require any further information or documents from our side to process this request. We look forward to your prompt response.\n\nThank you for your cooperation.\n\n${signature}`;
      setComposeData({ ...composeData, body: smartDraft });
      setIsComposingAI(false);
    }, 1500);
  };

  // 🚀 Send New Email (Compose)
  const sendNewEmail = async () => {
    if (!token || !composeData.to || !composeData.body) return alert("Please fill 'To' and 'Message' fields.");
    setIsComposing(true);

    try {
      const emailContent = [
        `To: ${composeData.to}`,
        `Subject: ${composeData.subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        composeData.body
      ].join('\n');

      const encodedEmail = btoa(unescape(encodeURIComponent(emailContent))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encodedEmail })
      });

      if (res.ok) {
        alert('🚀 शानदार! नया ईमेल भेज दिया गया!');
        setShowCompose(false);
        if (activeTab === 'sent') fetchEmails(token, 'sent');
      } else {
        alert('❌ ईमेल भेजने में फेल!');
      }
    } catch (error) {
      console.error(error);
      alert('❌ नेटवर्क एरर!');
    }
    setIsComposing(false);
  };

  // 🤖 AI Reply Generator
  const handleMamtaAiReply = (email: any) => {
    setIsAiThinking(true);
    setAiDraft('');
    setTimeout(() => {
      const senderName = email.from || 'Sir/Madam';
      const smartReply = `Dear ${senderName},\n\nThank you for your email regarding "${email.subject}".\n\nWe have received your message and our team at Prasad Transport ERP is reviewing it. We will process your request and get back to you with an update shortly.\n\nIf you have any urgent queries, please feel free to call our support line.\n\n${signature}`;
      setAiDraft(smartReply);
      setIsAiThinking(false);
    }, 1500);
  };

  // 🚀 Send Reply Email
  const sendRealEmail = async () => {
    if (!token || !selectedEmail || !aiDraft) return;
    setIsSending(true);

    try {
      const toEmailMatch = selectedEmail.fullFrom.match(/<(.+)>/);
      const toEmail = toEmailMatch ? toEmailMatch[1] : selectedEmail.fullFrom;
      const replySubject = selectedEmail.subject.startsWith('Re:') ? selectedEmail.subject : `Re: ${selectedEmail.subject}`;
      
      const emailContent = [
        `To: ${toEmail}`,
        `Subject: ${replySubject}`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        aiDraft
      ].join('\n');

      const encodedEmail = btoa(unescape(encodeURIComponent(emailContent))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encodedEmail })
      });

      if (res.ok) {
        alert('🚀 शानदार! रिप्लाई भेज दिया गया है!');
        setAiDraft('');
      } else {
        alert('❌ रिप्लाई भेजने में फेल!');
      }
    } catch (error) {
      console.error(error);
    }
    setIsSending(false);
  };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.5); border-radius: 10px; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }

        .glass-card { background: rgba(30, 41, 59, 0.6); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
        
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border: none; padding: 10px 20px; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; justify-content: center; }
        .glow-btn:hover:not(:disabled) { box-shadow: 0 0 20px rgba(99, 102, 241, 0.6); transform: translateY(-2px); }
        .glow-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        /* 🗂️ Fixed Tabs CSS */
        .tabs-container { display: flex; flex-wrap: wrap; background: rgba(15, 23, 42, 0.95); border-bottom: 2px solid rgba(255,255,255,0.05); border-radius: 20px 20px 0 0; }
        .tab-btn { flex: 1; min-width: 80px; padding: 15px 10px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 14px; text-align: center; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.05); }
        .tab-btn:hover:not(.active) { color: white; background: rgba(255,255,255,0.03); }

        .ai-btn { background: linear-gradient(135deg, #c084fc, #9333ea); color: white; border: none; padding: 10px 20px; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; }
        .ai-btn:hover:not(:disabled) { box-shadow: 0 0 20px rgba(192, 132, 252, 0.6); transform: scale(1.02); }
        .ai-btn:disabled { opacity: 0.6; cursor: wait; }
        
        .email-item { padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: all 0.3s ease; display: flex; gap: 15px; align-items: flex-start; }
        .email-item:hover { background: rgba(56, 189, 248, 0.08); transform: translateX(5px); }
        .email-item.active { background: linear-gradient(90deg, rgba(56, 189, 248, 0.15) 0%, rgba(30, 41, 59, 0) 100%); border-left: 4px solid #38bdf8; }
        
        .avatar { width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, #38bdf8, #818cf8); display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 18px; flex-shrink: 0; box-shadow: 0 4px 10px rgba(56, 189, 248, 0.3); }
        
        .modern-textarea { background: rgba(15, 23, 42, 0.6); border: 1px solid #c084fc; border-radius: 10px; color: white; padding: 15px; width: 100%; height: 200px; font-family: inherit; font-size: 14px; outline: none; box-sizing: border-box; resize: none; line-height: 1.5; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid #334155; border-radius: 10px; color: white; padding: 12px 15px; width: 100%; font-family: inherit; font-size: 14px; outline: none; box-sizing: border-box; margin-bottom: 15px; }
        .modern-input:focus, .modern-textarea:focus { box-shadow: 0 0 15px rgba(192, 132, 252, 0.3); border-color: #c084fc; }

        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(5px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
        .modal-content { background: #0f172a; border: 1px solid #334155; padding: 30px; border-radius: 20px; width: 650px; max-width: 90%; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
      `}</style>

      {/* ⚙️ Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2 style={{ margin: '0 0 20px 0', color: '#38bdf8' }}>⚙️ Signature Settings</h2>
            <textarea className="modern-textarea" style={{ height: '150px', borderColor: '#334155' }} value={signature} onChange={(e) => setSignature(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button className="glow-btn" style={{ background: 'transparent', border: '1px solid #64748b' }} onClick={() => setShowSettings(false)}>Cancel</button>
              <button className="glow-btn" style={{ background: '#10b981' }} onClick={saveSignature}>Save Signature</button>
            </div>
          </div>
        </div>
      )}

      {/* ✍️ Compose Modal (With AI) */}
      {showCompose && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '10px' }}>
                ✍️ New Message
              </h2>
              {/* 🧠 नया जादुई AI बटन */}
              <button className="ai-btn" onClick={handleComposeAI} disabled={isComposingAI}>
                {isComposingAI ? '🧠 Mamta AI is typing...' : '✨ Write with Mamta AI'}
              </button>
            </div>

            <input type="email" placeholder="To: party@email.com" className="modern-input" value={composeData.to} onChange={(e) => setComposeData({...composeData, to: e.target.value})} />
            <input type="text" placeholder="Subject (Enter subject to use AI)" className="modern-input" value={composeData.subject} onChange={(e) => setComposeData({...composeData, subject: e.target.value})} />
            
            <textarea className="modern-textarea" style={{ height: '250px' }} value={composeData.body} onChange={(e) => setComposeData({...composeData, body: e.target.value})} />
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button className="glow-btn" style={{ background: 'transparent', border: '1px solid #64748b' }} onClick={() => setShowCompose(false)}>Discard</button>
              <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }} onClick={sendNewEmail} disabled={isComposing}>
                {isComposing ? '📤 Sending...' : '📤 Send Email'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '35px', fontWeight: '900', background: 'linear-gradient(135deg, #38bdf8, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            📧 Advanced Webmail & AI Desk
          </h1>
          <p style={{ color: '#94a3b8', margin: '5px 0', fontSize: '14px' }}>Full Mailbox Access (Inbox, Sent, Drafts, Spam, Bin) & AI Replies</p>
        </div>
        {!token ? (
          <button className="glow-btn" onClick={() => login()}>🔗 Connect Official Gmail</button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #ec4899, #f43f5e)', padding: '10px 20px', fontSize: '15px' }} onClick={openComposeModal}>
              ➕ Compose
            </button>
            <span style={{ color: '#10b981', fontWeight: 'bold', background: 'rgba(16, 185, 129, 0.1)', padding: '8px 15px', borderRadius: '10px', border: '1px solid rgba(16,185,129,0.3)' }}>✅ Connected</span>
            <button className="glow-btn" style={{ background: '#334155' }} onClick={() => setShowSettings(true)}>⚙️</button>
            <button className="glow-btn" style={{ background: '#334155' }} onClick={() => fetchEmails(token, activeTab)}>🔄</button>
          </div>
        )}
      </div>

      {!token ? (
        <div className="glass-card" style={{ padding: '60px', textAlign: 'center', marginTop: '50px', maxWidth: '600px', margin: '50px auto' }}>
          <div style={{ fontSize: '80px', marginBottom: '20px' }}>🔐</div>
          <h2 style={{ color: '#f8fafc', fontSize: '28px' }}>Google Authentication Required</h2>
          <button className="glow-btn" style={{ fontSize: '18px', padding: '15px 40px', margin: '0 auto' }} onClick={() => login()}>Authenticate with Google</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.8fr', gap: '25px', height: '75vh' }}>
          
          {/* 📥 INBOX / FOLDERS LIST */}
          <div className="glass-card" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            
            {/* 🔄 MULTI-TABS (फिक्स कर दिए गए हैं, अब नहीं छुपेंगे) */}
            <div className="tabs-container">
              <button className={`tab-btn ${activeTab === 'inbox' ? 'active' : ''}`} onClick={() => handleTabChange('inbox')}>📥 Inbox</button>
              <button className={`tab-btn ${activeTab === 'sent' ? 'active' : ''}`} onClick={() => handleTabChange('sent')}>📤 Sent</button>
              <button className={`tab-btn ${activeTab === 'draft' ? 'active' : ''}`} onClick={() => handleTabChange('draft')}>📝 Drafts</button>
              <button className={`tab-btn ${activeTab === 'spam' ? 'active' : ''}`} onClick={() => handleTabChange('spam')}>🛑 Spam</button>
              <button className={`tab-btn ${activeTab === 'bin' ? 'active' : ''}`} onClick={() => handleTabChange('bin')}>🗑️ Bin</button>
            </div>
            
            {loading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#38bdf8', animation: 'pulse 1.5s infinite' }}>Loading folder... ⏳</div>
            ) : emails.length === 0 ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>No emails found in {activeTab}.</div>
            ) : (
              emails.map((email) => (
                <div key={email.id} className={`email-item ${selectedEmail?.id === email.id ? 'active' : ''}`} onClick={() => setSelectedEmail(email)}>
                  <div className="avatar">{email.from.charAt(0).toUpperCase()}</div>
                  <div style={{ overflow: 'hidden', flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <div style={{ fontWeight: 'bold', color: '#f8fafc', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {(activeTab === 'sent' || activeTab === 'draft') ? `To: ${email.from}` : email.from}
                      </div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>{new Date(email.date).toLocaleDateString()}</div>
                    </div>
                    <div style={{ color: '#38bdf8', fontSize: '13px', fontWeight: '600', marginBottom: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {email.subject}
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: '1.4' }}>
                      {email.snippet}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 📖 EMAIL READING & MAMTA AI DESK */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!selectedEmail ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b' }}>
                <div style={{ fontSize: '60px', opacity: 0.3, marginBottom: '15px' }}>✉️</div>
                <div style={{ fontSize: '18px' }}>Select an email from the list</div>
              </div>
            ) : (
              <>
                <div style={{ padding: '30px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(15, 23, 42, 0.7)' }}>
                  <h2 style={{ margin: '0 0 15px 0', color: '#fff', fontSize: '24px', lineHeight: '1.3' }}>{selectedEmail.subject}</h2>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#94a3b8', fontSize: '14px', background: 'rgba(0,0,0,0.2)', padding: '10px 15px', borderRadius: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div className="avatar" style={{ width: '30px', height: '30px', fontSize: '14px' }}>{selectedEmail.from.charAt(0).toUpperCase()}</div>
                      <div><b>{(activeTab === 'sent' || activeTab === 'draft') ? 'To:' : 'From:'}</b> <span style={{ color: '#e2e8f0' }}>{selectedEmail.fullFrom}</span></div>
                    </div>
                    <div style={{ color: '#64748b' }}>{new Date(selectedEmail.date).toLocaleString()}</div>
                  </div>
                </div>

                <div style={{ padding: '30px', color: '#cbd5e1', fontSize: '15px', lineHeight: '1.8', overflowY: 'auto', flex: 1 }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    {selectedEmail.snippet}...
                  </div>
                  
                  <div style={{ borderTop: '1px dashed #334155', margin: '30px 0' }}></div>
                  
                  {/* 🤖 MAMTA AI SECTION */}
                  <div style={{ background: 'linear-gradient(180deg, rgba(192, 132, 252, 0.05) 0%, rgba(15, 23, 42, 0) 100%)', border: '1px solid rgba(192, 132, 252, 0.3)', padding: '25px', borderRadius: '20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                      <h3 style={{ margin: 0, color: '#c084fc', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '20px' }}>
                        <span style={{ fontSize: '24px' }}>🤖</span> Mamta AI Smart Reply
                      </h3>
                      <button className="ai-btn" onClick={() => handleMamtaAiReply(selectedEmail)}>✨ Draft Auto-Reply</button>
                    </div>

                    {isAiThinking ? (
                      <div style={{ color: '#c084fc', padding: '30px', textAlign: 'center', animation: 'pulse 1s infinite' }}>Mamta AI is reading the email... 🧠</div>
                    ) : aiDraft ? (
                      <div style={{ animation: 'fadeIn 0.5s' }}>
                        <textarea className="modern-textarea" value={aiDraft} onChange={(e) => setAiDraft(e.target.value)}></textarea>
                        <div style={{ textAlign: 'right', marginTop: '15px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                          <button className="glow-btn" style={{ background: 'transparent', border: '1px solid #64748b' }} onClick={() => setAiDraft('')}>Cancel</button>
                          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }} onClick={sendRealEmail} disabled={isSending}>
                            {isSending ? '📤 Sending...' : '📤 Send Reply'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: '#64748b', fontSize: '14px', textAlign: 'center', padding: '20px', border: '1px dashed #334155', borderRadius: '10px' }}>
                        Click the ✨ <b>Draft Auto-Reply</b> button above to let Mamta AI analyze this email and write a response for you.
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

export default function CompanyInboxWrapper() {
  return (
    <GoogleOAuthProvider clientId={CLIENT_ID}>
      <InboxUI />
    </GoogleOAuthProvider>
  );
}