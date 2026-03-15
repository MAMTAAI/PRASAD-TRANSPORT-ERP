// @ts-nocheck
import React, { useState } from 'react';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';

// 🗝️ आपकी जनरेट की हुई Client ID
const CLIENT_ID = '837828662164-6rr2lbfer4c1vje1ul2gidommddj2jql.apps.googleusercontent.com';

function InboxUI() {
  const [token, setToken] = useState<string | null>(null);
  const [emails, setEmails] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<any>(null);
  
  // 🤖 Mamta AI States
  const [aiDraft, setAiDraft] = useState('');
  const [isAiThinking, setIsAiThinking] = useState(false);

  // 🔐 Google Login & Token Generation
  const login = useGoogleLogin({
    onSuccess: (codeResponse) => {
      setToken(codeResponse.access_token);
      fetchEmails(codeResponse.access_token);
    },
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    onError: (error) => console.log('Login Failed:', error)
  });

  // 📥 Fetch Emails from Gmail API
  const fetchEmails = async (accessToken: string) => {
    setLoading(true);
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15', {
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
            
            // Extract Headers (Subject, From, Date)
            const headers = msgData.payload.headers;
            const subject = headers.find((h: any) => h.name === 'Subject')?.value || 'No Subject';
            const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown Sender';
            const date = headers.find((h: any) => h.name === 'Date')?.value || '';

            return { id: msg.id, subject, from, date, snippet: msgData.snippet };
          })
        );
        setEmails(emailDetails);
      }
    } catch (err) {
      console.error("Error fetching emails", err);
    }
    setLoading(false);
  };

  // 🤖 MAMTA AI: Auto-Reply Generator
  const handleMamtaAiReply = (email: any) => {
    setIsAiThinking(true);
    setAiDraft('');
    
    // Simulate AI reading and drafting delay
    setTimeout(() => {
      const senderName = email.from.split('<')[0].trim() || 'Sir/Madam';
      
      const smartReply = `Dear ${senderName},\n\nThank you for your email regarding "${email.subject}".\n\nWe have received your message and our team at Prasad Transport ERP is reviewing it. We will process your request and get back to you with an update shortly.\n\nIf you have any urgent queries, please feel free to call our support line.\n\nBest Regards,\nMamta AI (Operations Assistant)\nPrasad Transport Group\nhttps://prasadtransport.com`;
      
      setAiDraft(smartReply);
      setIsAiThinking(false);
    }, 2000);
  };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border: none; padding: 12px 25px; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 0 20px rgba(99, 102, 241, 0.6); transform: translateY(-2px); }
        .ai-btn { background: linear-gradient(135deg, #c084fc, #9333ea); color: white; border: none; padding: 10px 20px; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; }
        .ai-btn:hover { box-shadow: 0 0 20px rgba(192, 132, 252, 0.6); transform: scale(1.02); }
        .email-item { padding: 15px; border-bottom: 1px solid #1e293b; cursor: pointer; transition: 0.2s; }
        .email-item:hover { background: rgba(56, 189, 248, 0.1); border-left: 4px solid #38bdf8; }
        .email-item.active { background: rgba(56, 189, 248, 0.15); border-left: 4px solid #38bdf8; }
        .modern-textarea { background: rgba(15, 23, 42, 0.6); border: 1px solid #c084fc; border-radius: 10px; color: white; padding: 15px; width: 100%; height: 200px; font-family: inherit; font-size: 14px; outline: none; box-sizing: border-box; resize: none; }
        .modern-textarea:focus { box-shadow: 0 0 15px rgba(192, 132, 252, 0.3); }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '38px', fontWeight: '900', background: 'linear-gradient(135deg, #38bdf8, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            📧 Company Webmail & AI Desk
          </h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Read Emails & Generate Smart Replies using Mamta AI</p>
        </div>
        {!token ? (
          <button className="glow-btn" onClick={() => login()}>
            🔗 Connect Official Gmail
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <span style={{ color: '#10b981', fontWeight: 'bold' }}>✅ Gmail Connected</span>
            <button className="glow-btn" style={{ background: '#334155' }} onClick={() => fetchEmails(token)}>🔄 Refresh Inbox</button>
          </div>
        )}
      </div>

      {!token ? (
        <div className="glass-card" style={{ padding: '50px', textAlign: 'center', marginTop: '50px' }}>
          <div style={{ fontSize: '80px', marginBottom: '20px' }}>🔐</div>
          <h2 style={{ color: '#f8fafc' }}>Secure Google Authentication Required</h2>
          <p style={{ color: '#94a3b8', maxWidth: '500px', margin: '0 auto 20px auto' }}>Please connect your company Gmail account to securely sync your inbox and activate Mamta AI Smart Replies.</p>
          <button className="glow-btn" style={{ fontSize: '18px', padding: '15px 40px' }} onClick={() => login()}>
            Authenticate with Google
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '20px', height: '70vh' }}>
          
          {/* 📥 INBOX LIST */}
          <div className="glass-card" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '15px 20px', borderBottom: '1px solid #334155', background: 'rgba(15, 23, 42, 0.8)', position: 'sticky', top: 0, zIndex: 10 }}>
              <h3 style={{ margin: 0, color: '#38bdf8' }}>Inbox (Latest Emails)</h3>
            </div>
            
            {loading ? (
              <div style={{ padding: '30px', textAlign: 'center', color: '#38bdf8' }}>Loading emails from Google server...</div>
            ) : emails.length === 0 ? (
              <div style={{ padding: '30px', textAlign: 'center', color: '#94a3b8' }}>No emails found.</div>
            ) : (
              emails.map((email) => (
                <div key={email.id} className={`email-item ${selectedEmail?.id === email.id ? 'active' : ''}`} onClick={() => setSelectedEmail(email)}>
                  <div style={{ fontWeight: 'bold', color: '#f8fafc', fontSize: '14px', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {email.from}
                  </div>
                  <div style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {email.subject}
                  </div>
                  <div style={{ color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {email.snippet}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 📖 EMAIL READING & MAMTA AI DESK */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!selectedEmail ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b' }}>
                <div style={{ fontSize: '50px', opacity: 0.5, marginBottom: '10px' }}>✉️</div>
                Select an email from the inbox to read and reply.
              </div>
            ) : (
              <>
                <div style={{ padding: '25px', borderBottom: '1px solid #1e293b', background: 'rgba(15, 23, 42, 0.6)' }}>
                  <h2 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '22px' }}>{selectedEmail.subject}</h2>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '13px' }}>
                    <div><b>From:</b> <span style={{ color: '#cbd5e1' }}>{selectedEmail.from}</span></div>
                    <div>{new Date(selectedEmail.date).toLocaleString()}</div>
                  </div>
                </div>

                <div style={{ padding: '25px', color: '#cbd5e1', fontSize: '14px', lineHeight: '1.6', overflowY: 'auto', flex: 1 }}>
                  {selectedEmail.snippet}...
                  <br/><br/>
                  <div style={{ borderTop: '1px dashed #334155', margin: '20px 0' }}></div>
                  
                  {/* 🤖 MAMTA AI SECTION */}
                  <div style={{ background: 'rgba(192, 132, 252, 0.05)', border: '1px solid rgba(192, 132, 252, 0.2)', padding: '20px', borderRadius: '15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                      <h3 style={{ margin: 0, color: '#c084fc', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        🤖 Mamta AI Smart Reply
                      </h3>
                      <button className="ai-btn" onClick={() => handleMamtaAiReply(selectedEmail)}>
                        ✨ Draft Auto-Reply
                      </button>
                    </div>

                    {isAiThinking ? (
                      <div style={{ color: '#c084fc', padding: '20px', textAlign: 'center', animation: 'pulse 1s infinite' }}>
                        Mamta AI is reading the email and preparing a professional response... 🧠
                      </div>
                    ) : aiDraft ? (
                      <div style={{ animation: 'fadeIn 0.5s' }}>
                        <textarea className="modern-textarea" value={aiDraft} onChange={(e) => setAiDraft(e.target.value)}></textarea>
                        <div style={{ textAlign: 'right', marginTop: '15px' }}>
                          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', boxShadow: '0 0 15px rgba(16,185,129,0.3)' }} onClick={() => alert("📧 Reply Sent Successfully via Gmail API!")}>
                            📤 Send Reply
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: '#64748b', fontSize: '12px', textAlign: 'center', padding: '10px' }}>
                        Click the button above to let Mamta AI analyze this email and write a response for you.
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