// @ts-nocheck
import React, { useState, useEffect } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css'; 
import { collection, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function AiLetterPad() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [savedDocs, setSavedDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 📝 Flexible States (Manual Typing Enabled)
  const [letterhead, setLetterhead] = useState('PRASAD TRANSPORT GROUP'); 
  const [authority, setAuthority] = useState(''); 
  const [actionType, setActionType] = useState(''); 
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [selectedDriver, setSelectedDriver] = useState('');
  const [docTitle, setDocTitle] = useState('');
  
  // 🔍 Search State
  const [searchQuery, setSearchQuery] = useState('');

  // 🤖 AI & Editor States
  const [editorContent, setEditorContent] = useState('');
  const [isAiThinking, setIsAiThinking] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const dSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(dSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const docSnap = await getDocs(collection(db, "SAVED_DOCUMENTS"));
      setSavedDocs(docSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 📝 GENERATE BLANK LETTERPAD (MANUAL MODE)
  const handleBlankDocument = () => {
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const draftHTML = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #000;">
        <h2 style="text-align: center; color: #1e293b; margin-bottom: 5px; text-transform: uppercase;">${letterhead}</h2>
        <hr style="border: 1px solid #1e293b;" />
        <p style="text-align: right;"><strong>Date:</strong> ${today}</p>
        <p><strong>To,</strong><br/>${authority ? authority : '[Type Authority Name Here]'}</strong></p>
        <p><strong>Subject: ${actionType ? actionType : '[Type Subject Here]'}</strong></p>
        <p>Respected Sir/Madam,</p>
        <p><br/><br/>[Type your letter content here...]</p>
        <br/><br/>
        <p>Thanking you,</p>
        <p>Yours faithfully,<br/><strong>For ${letterhead}</strong></p>
      </div>
    `;
    setEditorContent(draftHTML);
    setDocTitle(actionType ? `${authority} - ${actionType}` : 'New Document');
  };

  // 🤖 GENERATE VIA MAMTA AI
  const handleMamtaAiDraft = () => {
    if (!authority || !actionType) {
      return alert("⚠️ Please type 'Authority/Company' and 'Action/Subject' for AI to draft!");
    }

    setIsAiThinking(true);
    setEditorContent('');

    setTimeout(() => {
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      let bodyText = "";

      const lowerAction = actionType.toLowerCase();
      
      if (lowerAction.includes('driver') || lowerAction.includes('auth')) {
        bodyText = `This is to certify and authorize our driver, <strong>Mr. ${selectedDriver || '[Driver Name]'}</strong>, to enter your esteemed premises for the loading/unloading operations.<br/><br/>He will be operating our tank truck bearing Registration Number: <strong>${selectedVehicle || '[Vehicle No]'}</strong>. All original documents have been verified by us and are attached herewith.`;
      } 
      else if (lowerAction.includes('replace') || lowerAction.includes('change')) {
        bodyText = `We kindly request you to allow the replacement of our vehicle for the upcoming operations. The new vehicle details are <strong>${selectedVehicle || '[Vehicle No]'}</strong> driven by <strong>${selectedDriver || '[Driver Name]'}</strong>.<br/><br/>All required documents (RC, Fitness, Insurance) are attached herewith for your verification.`;
      } 
      else {
        bodyText = `With reference to the subject cited above, we would like to bring to your kind attention regarding <strong>${actionType}</strong> for our vehicle <strong>${selectedVehicle || '[Vehicle No]'}</strong>.<br/><br/>We request you to kindly process this at the earliest and provide the necessary approvals.`;
      }

      const draftHTML = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #000;">
          <h2 style="text-align: center; color: #1e293b; margin-bottom: 5px; text-transform: uppercase;">${letterhead}</h2>
          <hr style="border: 1px solid #1e293b;" />
          <p style="text-align: right;"><strong>Date:</strong> ${today}</p>
          <p><strong>To,</strong><br/>The Concerned Authority,<br/><strong>${authority}</strong></p>
          <p><strong>Subject: ${actionType}</strong></p>
          <p>Respected Sir/Madam,</p>
          <p>${bodyText}</p>
          <p>Thanking you,</p>
          <p>Yours faithfully,<br/><strong>For ${letterhead}</strong></p>
        </div>
      `;
      
      setEditorContent(draftHTML);
      setDocTitle(`${authority} - ${actionType}`);
      setIsAiThinking(false);
    }, 1500);
  };

  // 💾 SAVE TO DOCUMENT LIBRARY
  const handleSaveDocument = async () => {
    if (!docTitle || !editorContent) return alert("Please type something and give a title before saving!");
    
    try {
      await addDoc(collection(db, "SAVED_DOCUMENTS"), {
        title: docTitle,
        authority: authority,
        vehicle_no: selectedVehicle || 'N/A',
        content: editorContent,
        createdAt: new Date().toISOString()
      });
      alert("✅ Document Saved to System Library Successfully!");
      setDocTitle('');
      setEditorContent('');
      fetchData();
    } catch (e) { alert("Error saving document."); }
  };

  // 🗑️ DELETE DOCUMENT
  const handleDelete = async (id: string, title: string) => {
    if (window.confirm(`Are you sure you want to permanently delete "${title}"?`)) {
      try {
        await deleteDoc(doc(db, "SAVED_DOCUMENTS", id));
        fetchData();
      } catch (e) { alert("Error deleting document."); }
    }
  };

  // 🖨️ DIRECT PRINT FUNCTION
  const handlePrint = (content: string) => {
    const printWindow = window.open('', '_blank');
    printWindow?.document.write(`
      <html>
        <head>
          <title>Print Document</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; margin: 0; }
            @media print {
              @page { margin: 20px; }
              body { padding: 20px; }
            }
          </style>
        </head>
        <body onload="window.print(); window.close();">
          ${content}
        </body>
      </html>
    `);
    printWindow?.document.close();
  };

  // 🔍 Filter Documents based on Search
  const filteredDocs = savedDocs.filter(doc => 
    doc.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    doc.authority?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    doc.vehicle_no?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: '#020617' }}>
      <style>{`
        .clean-card { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; }
        .btn-primary { background: #2563eb; color: white; border: none; padding: 12px 15px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px;}
        .btn-primary:hover { background: #1d4ed8; }
        .btn-success { background: #10b981; color: white; border: none; padding: 10px 15px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; font-size: 13px; }
        .btn-success:hover { background: #059669; }
        .btn-outline { background: transparent; color: #cbd5e1; border: 1px solid #475569; padding: 10px 15px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; font-size: 13px; display: flex; align-items: center; gap: 5px;}
        .btn-outline:hover { background: #1e293b; color: white; }
        
        .clean-input { background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: white; padding: 10px; width: 100%; box-sizing: border-box; font-size: 13px; }
        .clean-input:focus { border-color: #3b82f6; outline: none; }
        
        .ql-container { background: white; border-radius: 0 0 6px 6px; color: black; font-size: 15px; font-family: Arial, sans-serif; }
        .ql-toolbar { background: #f1f5f9; border-radius: 6px 6px 0 0; border: 1px solid #cbd5e1 !important; border-bottom: none !important; }
        .ql-editor { min-height: 500px; padding: 40px; border: 1px solid #cbd5e1; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', borderBottom: '1px solid #1e293b', paddingBottom: '15px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '24px' }}>Document Manager & Letter Pad</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0', fontSize: '14px' }}>Create, edit, print, and save official letters manually or using AI.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '25px' }}>
        
        {/* 📝 LEFT PANEL: WORKSPACE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          
          {/* SETUP FORM */}
          <div className="clean-card" style={{ padding: '20px' }}>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold' }}>1. Select Company Letterhead *</label>
              <select className="clean-input" style={{ border: '1px solid #38bdf8' }} value={letterhead} onChange={e=>setLetterhead(e.target.value)}>
                <option value="PRASAD TRANSPORT GROUP">PRASAD TRANSPORT GROUP</option>
                <option value="JAISWAL CAPITAL">JAISWAL CAPITAL</option>
                <option value="PRASAD LOGISTICS">PRASAD LOGISTICS</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>2. To (Authority / Company Name)</label>
                <input 
                  type="text" 
                  className="clean-input" 
                  list="auth-suggestions" 
                  placeholder="Type or select... e.g. IOCL Bongaigaon" 
                  value={authority} 
                  onChange={e=>setAuthority(e.target.value)} 
                />
                <datalist id="auth-suggestions">
                  <option value="IOCL Terminal" />
                  <option value="BPCL Depot" />
                  <option value="HPCL Location" />
                  <option value="Regional Transport Office (RTO)" />
                </datalist>
              </div>
              
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>3. Subject / Action Needed</label>
                <input 
                  type="text" 
                  className="clean-input" 
                  list="action-suggestions" 
                  placeholder="Type Subject... e.g. Gate Pass Request" 
                  value={actionType} 
                  onChange={e=>setActionType(e.target.value)} 
                />
                <datalist id="action-suggestions">
                  <option value="Driver Authorization Letter" />
                  <option value="Vehicle Replacement Request" />
                  <option value="Gate Pass Application" />
                  <option value="Fitness Certificate Submission" />
                </datalist>
              </div>

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Attach Vehicle (Optional)</label><select className="clean-input" value={selectedVehicle} onChange={e=>setSelectedVehicle(e.target.value)}><option value="">-- Choose Vehicle --</option>{vehicles.map(v => <option key={v.id} value={v.vehicle_no}>{v.vehicle_no}</option>)}</select></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Attach Driver (Optional)</label><select className="clean-input" value={selectedDriver} onChange={e=>setSelectedDriver(e.target.value)}><option value="">-- Choose Driver --</option>{drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}</select></div>
            </div>

            <div style={{ display: 'flex', gap: '15px' }}>
              <button className="btn-outline" style={{ flex: 1, justifyContent: 'center', borderColor: '#3b82f6', color: '#3b82f6' }} onClick={handleBlankDocument}>
                📄 Start Blank Letter (Manual Typing)
              </button>
              <button className="btn-primary" style={{ flex: 1 }} onClick={handleMamtaAiDraft}>
                ✨ Auto-Write with Mamta AI
              </button>
            </div>
          </div>

          {/* 📝 EDITOR AREA */}
          <div className="clean-card" style={{ padding: '20px' }}>
            {isAiThinking ? (
              <div style={{ textAlign: 'center', padding: '50px', color: '#94a3b8' }}>
                <div style={{ fontSize: '30px', marginBottom: '10px' }}>🧠</div>
                Drafting professional document... please wait.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '15px' }}>
                  <div style={{ flex: 1, marginRight: '15px' }}>
                    <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>File Name (For Saving)</label>
                    <input className="clean-input" placeholder="e.g. IOCL Driver Auth - AS01C1234" value={docTitle} onChange={e=>setDocTitle(e.target.value)} />
                  </div>
                  <button className="btn-success" style={{ background: '#f59e0b', display: 'flex', gap: '8px', alignItems: 'center' }} onClick={() => handlePrint(editorContent)}>
                    <span style={{ fontSize: '18px' }}>🖨️</span> Print Document
                  </button>
                </div>
                
                <div style={{ border: '2px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
                  <ReactQuill theme="snow" value={editorContent} onChange={setEditorContent} />
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button className="btn-success" style={{ flex: 1 }} onClick={handleSaveDocument}>💾 Save to System Library</button>
                  <button className="btn-outline" onClick={() => { setEditorContent(''); setDocTitle(''); }}>🗑️ Clear Editor</button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* 📚 RIGHT PANEL: SAVED DOCUMENT LIBRARY WITH SEARCH */}
        <div className="clean-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
          <div style={{ borderBottom: '1px solid #1e293b', paddingBottom: '10px', marginBottom: '15px' }}>
            <h3 style={{ color: '#f8fafc', margin: '0 0 10px 0', fontSize: '16px' }}>📁 Saved Documents</h3>
            {/* 🔍 THE NEW SEARCH BOX */}
            <div style={{ position: 'relative' }}>
              <input 
                className="clean-input" 
                placeholder="🔍 Search by name, vehicle, or auth..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: '30px' }}
              />
            </div>
          </div>
          
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? <p style={{ color: '#94a3b8', fontSize: '13px' }}>Loading library...</p> : filteredDocs.length === 0 ? <p style={{ color: '#64748b', fontSize: '13px' }}>No documents found.</p> : (
              filteredDocs.map((doc, i) => (
                <div key={i} style={{ background: '#1e293b', padding: '12px', borderRadius: '6px', marginBottom: '10px', position: 'relative' }}>
                  {/* 🗑️ DELETE ICON */}
                  <button 
                    onClick={() => handleDelete(doc.id, doc.title)}
                    style={{ position: 'absolute', top: '10px', right: '10px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '14px' }}
                    title="Delete Document"
                  >
                    ✕
                  </button>

                  <h4 style={{ margin: '0 0 4px 0', color: '#fff', fontSize: '14px', paddingRight: '20px' }}>{doc.title}</h4>
                  <p style={{ margin: '0 0 10px 0', fontSize: '11px', color: '#94a3b8' }}>
                    📅 {new Date(doc.createdAt).toLocaleDateString('en-IN')} | 🏢 {doc.authority}
                  </p>
                  
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button style={{ flex: 1, background: '#334155', color: '#fff', border: 'none', padding: '6px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }} onClick={() => {
                      setEditorContent(doc.content);
                      setDocTitle(doc.title);
                    }}>
                      ✏️ Edit
                    </button>
                    <button style={{ flex: 1, background: '#f59e0b', color: '#fff', border: 'none', padding: '6px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', fontWeight: 'bold' }} onClick={() => handlePrint(doc.content)}>
                      🖨️ Print
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}