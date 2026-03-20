// @ts-nocheck
import React, { useState, useEffect } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css'; 
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
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
  
  // 💾 Document Control States
  const [docTitle, setDocTitle] = useState('');
  const [editingDocId, setEditingDocId] = useState<string | null>(null); // ✅ Track if updating an old doc
  
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
      <div style="font-family: 'Times New Roman', Times, serif; line-height: 1.6; color: #000; max-width: 800px; margin: 0 auto;">
        <h2 style="text-align: center; color: #000; margin-bottom: 5px; text-transform: uppercase; font-size: 24px; letter-spacing: 2px;">${letterhead}</h2>
        <hr style="border: 1px solid #000;" />
        <p style="text-align: right; margin-top: 20px;"><strong>Date:</strong> ${today}</p>
        <p style="margin-top: 30px;"><strong>To,</strong><br/>${authority ? authority : '[Type Authority Name Here]'}</p>
        <p style="margin-top: 20px; font-weight: bold; text-decoration: underline;">Subject: ${actionType ? actionType : '[Type Subject Here]'}</p>
        <p style="margin-top: 20px;">Respected Sir/Madam,</p>
        <p style="margin-top: 15px; text-indent: 50px;">[Type your letter content here...]</p>
        <br/><br/><br/>
        <p style="margin-top: 40px;">Thanking you,</p>
        <p style="margin-top: 20px;">Yours faithfully,<br/><br/><br/><strong>For ${letterhead}</strong><br/>(Authorized Signatory)</p>
      </div>
    `;
    setEditorContent(draftHTML);
    setDocTitle(actionType ? `${authority} - ${actionType}` : 'New Document');
    setEditingDocId(null); // Reset ID for new doc
  };

  // 🤖 GENERATE VIA MAMTA AI
  const handleMamtaAiDraft = () => {
    if (!authority || !actionType) {
      return alert("⚠️ Please type 'Authority/Company' and 'Action/Subject' for AI to draft!");
    }

    setIsAiThinking(true);
    setEditorContent('');
    setEditingDocId(null); // Reset ID

    setTimeout(() => {
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      let bodyText = "";

      const lowerAction = actionType.toLowerCase();
      
      if (lowerAction.includes('driver') || lowerAction.includes('auth')) {
        bodyText = `This is to certify and authorize our driver, <strong>Mr. ${selectedDriver || '[Driver Name]'}</strong>, to enter your esteemed premises for the loading/unloading operations.<br/><br/>He will be operating our tank truck bearing Registration Number: <strong>${selectedVehicle || '[Vehicle No]'}</strong>. All original documents of the vehicle and the driver have been verified by us and copies are attached herewith for your kind perusal.`;
      } 
      else if (lowerAction.includes('replace') || lowerAction.includes('change')) {
        bodyText = `We kindly request you to allow the replacement of our vehicle for the upcoming operations. The new vehicle details are <strong>${selectedVehicle || '[Vehicle No]'}</strong> driven by <strong>${selectedDriver || '[Driver Name]'}</strong>.<br/><br/>All required valid documents (RC, Fitness, Insurance, Pollution, etc.) are attached herewith for your verification and record.`;
      } 
      else {
        bodyText = `With reference to the subject cited above, we would like to bring to your kind attention regarding <strong>${actionType}</strong> for our vehicle <strong>${selectedVehicle || '[Vehicle No]'}</strong>.<br/><br/>We request you to kindly process this at your earliest convenience and provide the necessary approvals.`;
      }

      const draftHTML = `
        <div style="font-family: 'Times New Roman', Times, serif; line-height: 1.6; color: #000; max-width: 800px; margin: 0 auto;">
          <h2 style="text-align: center; color: #000; margin-bottom: 5px; text-transform: uppercase; font-size: 24px; letter-spacing: 2px;">${letterhead}</h2>
          <hr style="border: 1px solid #000;" />
          <p style="text-align: right; margin-top: 20px;"><strong>Date:</strong> ${today}</p>
          <p style="margin-top: 30px;"><strong>To,</strong><br/>The Concerned Authority,<br/><strong>${authority}</strong></p>
          <p style="margin-top: 20px; font-weight: bold; text-decoration: underline;">Subject: ${actionType}</p>
          <p style="margin-top: 20px;">Respected Sir/Madam,</p>
          <p style="margin-top: 15px; text-align: justify;">${bodyText}</p>
          <br/><br/>
          <p style="margin-top: 40px;">Thanking you,</p>
          <p style="margin-top: 20px;">Yours faithfully,<br/><br/><br/><strong>For ${letterhead}</strong><br/>(Authorized Signatory)</p>
        </div>
      `;
      
      setEditorContent(draftHTML);
      setDocTitle(`${authority} - ${actionType}`);
      setIsAiThinking(false);
    }, 1500);
  };

  // 💾 SAVE OR UPDATE TO DOCUMENT LIBRARY
  const handleSaveDocument = async () => {
    if (!docTitle || !editorContent) return alert("⚠️ Please type something and give a title before saving!");
    
    try {
      if (editingDocId) {
        // ✅ UPDATE Existing Document
        await updateDoc(doc(db, "SAVED_DOCUMENTS", editingDocId), {
          title: docTitle,
          content: editorContent,
          updatedAt: serverTimestamp() // keep original createdAt
        });
        alert("✅ Document Updated Successfully!");
      } else {
        // 🆕 ADD New Document
        await addDoc(collection(db, "SAVED_DOCUMENTS"), {
          title: docTitle,
          authority: authority || 'General',
          vehicle_no: selectedVehicle || 'N/A',
          content: editorContent,
          createdAt: new Date().toISOString()
        });
        alert("✅ New Document Saved to Library!");
      }
      
      setDocTitle('');
      setEditorContent('');
      setEditingDocId(null);
      fetchData();
    } catch (e) { alert("❌ Error saving document."); }
  };

  // 🗑️ DELETE DOCUMENT
  const handleDelete = async (id: string, title: string) => {
    if (window.confirm(`⚠️ Are you sure you want to permanently delete "${title}"?`)) {
      try {
        await deleteDoc(doc(db, "SAVED_DOCUMENTS", id));
        if (editingDocId === id) {
          setEditorContent('');
          setDocTitle('');
          setEditingDocId(null);
        }
        fetchData();
      } catch (e) { alert("❌ Error deleting document."); }
    }
  };

  // 🖨️ DIRECT PRINT FUNCTION (Optimized for A4)
  const handlePrint = (content: string) => {
    const printWindow = window.open('', '_blank');
    printWindow?.document.write(`
      <html>
        <head>
          <title>Print Document - Prasad ERP</title>
          <style>
            body { font-family: 'Times New Roman', Times, serif; padding: 0; margin: 0; color: #000; }
            .print-container { width: 100%; max-width: 210mm; margin: 0 auto; padding: 20mm; box-sizing: border-box; }
            @page { size: A4; margin: 0; }
            @media print {
              body { -webkit-print-color-adjust: exact; padding: 0; margin: 0; }
              .print-container { padding: 25mm 20mm; } /* Extra top margin for physical letterheads if needed */
            }
          </style>
        </head>
        <body onload="window.print(); window.close();">
          <div class="print-container">
            ${content}
          </div>
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
    <div style={{ padding: '30px', minHeight: '100vh', background: '#020617', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .clean-card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; box-shadow: 0 10px 20px rgba(0,0,0,0.5); }
        .btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; border: none; padding: 12px 15px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px;}
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); }
        .btn-success { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 12px 15px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 13px; }
        .btn-success:hover { transform: translateY(-2px); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); }
        .btn-outline { background: transparent; color: #cbd5e1; border: 1px solid #475569; padding: 12px 15px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px;}
        .btn-outline:hover { background: #1e293b; color: white; }
        
        .clean-input { background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; font-size: 13px; outline: none; transition: 0.3s;}
        .clean-input:focus { border-color: #38bdf8; background: #0f172a; }
        
        .ql-container { background: white; border-radius: 0 0 8px 8px; color: black; font-size: 15px; font-family: 'Times New Roman', Times, serif; }
        .ql-toolbar { background: #f1f5f9; border-radius: 8px 8px 0 0; border: 1px solid #cbd5e1 !important; border-bottom: none !important; }
        .ql-editor { min-height: 500px; padding: 40px; border: 1px solid #cbd5e1; box-shadow: inset 0 0 10px rgba(0,0,0,0.05); }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', borderBottom: '1px solid #1e293b', paddingBottom: '15px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px', display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '900' }}>
            <span style={{ fontSize: '36px', filter: 'drop-shadow(0 0 10px rgba(192,132,252,0.8))' }}>📝</span> Document & Letter Pad
          </h1>
          <p style={{ color: '#94a3b8', margin: '5px 0 0 0', fontSize: '14px' }}>Create, edit, print, and save official letters manually or using <b style={{color: '#c084fc'}}>Mamta AI</b>.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '25px' }}>
        
        {/* 📝 LEFT PANEL: WORKSPACE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* SETUP FORM */}
          <div className="clean-card" style={{ padding: '25px', borderTop: '4px solid #38bdf8' }}>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>1. Select Company Letterhead *</label>
              <select className="clean-input" style={{ border: '1px solid #38bdf8', fontWeight: 'bold', color: '#38bdf8' }} value={letterhead} onChange={e=>setLetterhead(e.target.value)}>
                <option value="PRASAD TRANSPORT GROUP">PRASAD TRANSPORT GROUP</option>
                <option value="JAISWAL CAPITAL">JAISWAL CAPITAL</option>
                <option value="PRASAD LOGISTICS">PRASAD LOGISTICS</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>2. To (Authority / Company Name)</label>
                <input 
                  type="text" className="clean-input" list="auth-suggestions" 
                  placeholder="e.g. IOCL Bongaigaon" value={authority} onChange={e=>setAuthority(e.target.value)} 
                />
                <datalist id="auth-suggestions">
                  <option value="IOCL Terminal" />
                  <option value="BPCL Depot" />
                  <option value="HPCL Location" />
                  <option value="Regional Transport Office (RTO)" />
                </datalist>
              </div>
              
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>3. Subject / Action Needed</label>
                <input 
                  type="text" className="clean-input" list="action-suggestions" 
                  placeholder="e.g. Gate Pass Request" value={actionType} onChange={e=>setActionType(e.target.value)} 
                />
                <datalist id="action-suggestions">
                  <option value="Driver Authorization Letter" />
                  <option value="Vehicle Replacement Request" />
                  <option value="Gate Pass Application" />
                  <option value="Fitness Certificate Submission" />
                </datalist>
              </div>

              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', display: 'block', marginBottom: '5px' }}>Attach Vehicle (Optional)</label>
                <select className="clean-input" value={selectedVehicle} onChange={e=>setSelectedVehicle(e.target.value)}>
                  <option value="">-- Choose Vehicle --</option>
                  {vehicles.map(v => <option key={v.id} value={v.vehicle_no || v.vehical_no}>{v.vehicle_no || v.vehical_no}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', display: 'block', marginBottom: '5px' }}>Attach Driver (Optional)</label>
                <select className="clean-input" value={selectedDriver} onChange={e=>setSelectedDriver(e.target.value)}>
                  <option value="">-- Choose Driver --</option>
                  {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '15px' }}>
              <button className="btn-outline" style={{ flex: 1, borderColor: '#3b82f6', color: '#38bdf8' }} onClick={handleBlankDocument}>
                📄 Start Blank Letter (Manual)
              </button>
              <button className="btn-primary" style={{ flex: 1, background: 'linear-gradient(135deg, #c084fc, #9333ea)', boxShadow: '0 4px 15px rgba(192, 132, 252, 0.4)' }} onClick={handleMamtaAiDraft}>
                ✨ Auto-Write with Mamta AI
              </button>
            </div>
          </div>

          {/* 📝 EDITOR AREA */}
          <div className="clean-card" style={{ padding: '25px', borderTop: '4px solid #10b981' }}>
            {isAiThinking ? (
              <div style={{ textAlign: 'center', padding: '100px 20px', color: '#c084fc' }}>
                <div style={{ fontSize: '50px', marginBottom: '15px', animation: 'bounce 2s infinite' }}>🧠</div>
                <h3 style={{ margin: 0 }}>Mamta AI is Drafting...</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px' }}>Analyzing authority and generating professional legal text.</p>
                <style>{`@keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }`}</style>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '15px' }}>
                  <div style={{ flex: 1, marginRight: '15px' }}>
                    <label style={{ fontSize:'12px', color:'#10b981', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>File Name (For Saving) *</label>
                    <input className="clean-input" placeholder="e.g. IOCL Driver Auth - AS01C1234" value={docTitle} onChange={e=>setDocTitle(e.target.value)} style={{ border: '1px solid #10b981' }} />
                  </div>
                  <button className="btn-success" style={{ background: '#f59e0b', display: 'flex', gap: '8px', alignItems: 'center', padding: '12px 20px' }} onClick={() => handlePrint(editorContent)}>
                    <span style={{ fontSize: '18px' }}>🖨️</span> Print A4
                  </button>
                </div>
                
                <div style={{ border: '2px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
                  <ReactQuill theme="snow" value={editorContent} onChange={setEditorContent} />
                </div>

                <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
                  <button className="btn-success" style={{ flex: 2, fontSize: '15px' }} onClick={handleSaveDocument}>
                    {editingDocId ? '🔄 Update Existing Document' : '💾 Save to System Library'}
                  </button>
                  <button className="btn-outline" style={{ flex: 1, borderColor: '#ef4444', color: '#ef4444' }} onClick={() => { setEditorContent(''); setDocTitle(''); setEditingDocId(null); }}>
                    🗑️ Clear Editor
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* 📚 RIGHT PANEL: SAVED DOCUMENT LIBRARY WITH SEARCH */}
        <div className="clean-card" style={{ padding: '25px', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', borderTop: '4px solid #f59e0b' }}>
          <div style={{ borderBottom: '1px solid #1e293b', paddingBottom: '15px', marginBottom: '15px' }}>
            <h3 style={{ color: '#f59e0b', margin: '0 0 15px 0', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              📁 Saved Documents Lib
            </h3>
            {/* 🔍 SEARCH BOX */}
            <div style={{ position: 'relative' }}>
              <input 
                className="clean-input" 
                placeholder="🔍 Search by name, vehicle, or authority..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: '35px', borderRadius: '20px' }}
              />
              <span style={{ position: 'absolute', left: '12px', top: '12px', opacity: 0.5 }}>🔍</span>
            </div>
          </div>
          
          <div style={{ flex: 1, overflowY: 'auto', paddingRight: '5px' }}>
            {loading ? <p style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>Loading library...</p> : filteredDocs.length === 0 ? <p style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>No documents found.</p> : (
              filteredDocs.map((doc, i) => (
                <div key={i} style={{ background: '#1e293b', padding: '15px', borderRadius: '10px', marginBottom: '12px', position: 'relative', borderLeft: '3px solid #38bdf8', transition: '0.2s' }} onMouseOver={e=>e.currentTarget.style.transform='translateX(5px)'} onMouseOut={e=>e.currentTarget.style.transform='translateX(0)'}>
                  
                  {/* 🗑️ DELETE ICON */}
                  <button 
                    onClick={() => handleDelete(doc.id, doc.title)}
                    style={{ position: 'absolute', top: '10px', right: '10px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px', fontWeight: 'bold' }}
                    title="Delete Document"
                  >✕</button>

                  <h4 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '15px', paddingRight: '25px', lineHeight: '1.3' }}>{doc.title}</h4>
                  <p style={{ margin: '0 0 12px 0', fontSize: '11px', color: '#94a3b8' }}>
                    📅 {new Date(doc.createdAt).toLocaleDateString('en-IN')} | 🏢 {doc.authority || 'General'}
                  </p>
                  
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button style={{ flex: 1, background: '#334155', color: '#38bdf8', border: '1px solid #475569', padding: '8px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', transition: '0.2s' }} onMouseOver={e=>e.currentTarget.style.background='#475569'} onMouseOut={e=>e.currentTarget.style.background='#334155'} onClick={() => {
                      setEditorContent(doc.content);
                      setDocTitle(doc.title);
                      setEditingDocId(doc.id); // ✅ Set ID so it updates instead of duplicating
                    }}>
                      ✏️ Edit / Load
                    </button>
                    <button style={{ flex: 1, background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', border: '1px solid #f59e0b', padding: '8px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', transition: '0.2s' }} onMouseOver={e=>{e.currentTarget.style.background='#f59e0b'; e.currentTarget.style.color='#fff';}} onMouseOut={e=>{e.currentTarget.style.background='rgba(245, 158, 11, 0.1)'; e.currentTarget.style.color='#f59e0b';}} onClick={() => handlePrint(doc.content)}>
                      🖨️ Quick Print
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