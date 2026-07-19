// @ts-nocheck
// 🤖 AI BILL SCANNER & AUTO-FILING ENGINE (Mamta AI — 100% local Gemma vision)
// Mobile: camera capture / gallery. Desktop: drag & drop PDFs. Multi-page
// tabular bills → structured rows → trip/fuel matching → one-click filing
// into TRIPS / FUEL_ENTRIES + double-entry JOURNAL. Human reviews before
// anything is written — the AI proposes, the user files.
import React, { useState, useRef, useEffect } from 'react';
import { collection, getDocs, doc, writeBatch, increment, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { extractBill, matchRowsToTrips, matchRowsToFuelEntries, classifyDocument, extractBpclFreightBill } from './lib/billScanner';
import { getAiEngine, setAiEngine, AI_ENGINES } from './lib/llm';
import { CARD_PROVIDERS } from './lib/fleetCard';
import { postEntry } from './lib/accounting/journal';
import { round2, getTripFreight } from './lib/accounting/tripMath';
import { scopeCurrent } from './lib/rbac';
import { useIsMobile } from './hooks/useIsMobile';

const fmtINR = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

export default function BillScanner() {
  const { isMobile } = useIsMobile();
  const [kind, setKind] = useState('FREIGHT');           // FREIGHT | HSD
  // 🔀 DUAL-AI ENGINE: 'local' (Ollama) | 'cloud' (Claude Haiku via bridge).
  // localStorage me persist — user ka preferred engine hamesha yaad rahta hai.
  const [aiEngine, setAiEngineState] = useState(getAiEngine());
  const switchEngine = (e) => { setAiEngine(e); setAiEngineState(e); };
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState('');
  const [scanning, setScanning] = useState(false);
  const [bill, setBill] = useState(null);                // ExtractedBill
  const [bpcl, setBpcl] = useState(null);                // BpclFreightBill (AP210)
  const [rows, setRows] = useState([]);                  // editable copy
  const [matches, setMatches] = useState([]);            // RowMatch[]
  const [selected, setSelected] = useState({});          // rowIdx -> bool
  const [trips, setTrips] = useState([]);
  const [fuelEntries, setFuelEntries] = useState([]);
  const [filing, setFiling] = useState(false);
  const [filedSummary, setFiledSummary] = useState(null);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  useEffect(() => { fetchTargets(); }, []);
  const fetchTargets = async () => {
    try {
      const tSnap = await getDocs(collection(db, 'TRIPS'));
      setTrips(scopeCurrent(tSnap.docs.map(d => ({ id: d.id, ...d.data() }))) || []);
      const fSnap = await getDocs(query(collection(db, 'FUEL_ENTRIES'), where('bill_status', '==', 'UNBILLED'))).catch(() => ({ docs: [] }));
      setFuelEntries(fSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };

  // ── File intake ─────────────────────────────────────────────────────────
  const addFiles = (list) => {
    const accepted = Array.from(list).filter(f => /image\/|pdf$/.test(f.type) || /\.(pdf|jpe?g|png|webp)$/i.test(f.name));
    if (!accepted.length) return alert('⚠️ PDF ya photo (JPG/PNG) select karein.');
    setFiles(prev => [...prev, ...accepted]);
    setBill(null); setRows([]); setMatches([]); setFiledSummary(null);
  };
  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  // ── Scan ────────────────────────────────────────────────────────────────
  const runScan = async () => {
    if (!files.length || scanning) return;
    setScanning(true); setFiledSummary(null); setBill(null); setBpcl(null); setRows([]); setMatches([]);
    try {
      // 🧭 MULTI-SCHEMA ROUTER: classify first, then extract with the right brain.
      setProgress('🧭 Mamta AI document pehchan rahi hai…');
      const detected = await classifyDocument(files[0]);
      if (['IOCL_STATEMENT', 'HPCL_DRIVETRACK', 'BPCL_STATEMENT'].includes(detected)) {
        alert('🧭 Yeh fleet-card ka STATEMENT hai, freight bill nahi.\nIse ACCOUNTS → 💳 Fleet Card & Settlement ke AI Reconciler me kholein.');
        setScanning(false); setProgress(''); return;
      }
      let effKind = kind;
      if (detected === 'BPCL_FREIGHT_BILL') effKind = 'BPCL';
      else if (detected === 'HSD_PUMP_BILL') effKind = 'HSD';
      else if (detected === 'IOCL_FREIGHT_BILL') effKind = 'FREIGHT';
      if (effKind !== kind) setKind(effKind);

      if (effKind === 'BPCL') {
        const b = await extractBpclFreightBill(files[0], setProgress);
        setBpcl(b);
        setRows(b.rows.map(r => ({ ...r })));
        runMatch(b.rows, 'BPCL');
      } else {
        const result = await extractBill(files, effKind, setProgress);
        setBill(result);
        setRows(result.rows.map(r => ({ ...r })));
        runMatch(result.rows, effKind);
      }
      setProgress('');
    } catch (e) {
      const offline = e?.name === 'LLMOfflineError' || /ollama|engine|reach|bridge/i.test(e?.message || '');
      // Engine-specific offline message: "Ollama band hai" alert SIRF local mode me
      alert(offline
        ? (aiEngine === 'cloud'
          ? '❌ Cloud AI unavailable — bridge server (bridge.cjs) chalu hai? ANTHROPIC_API_KEY set hai? Ya Local AI par switch karein.'
          : '❌ Local AI engine (Ollama) band hai. Use chalu karke dobara try karein — ya upar se ☁️ Cloud AI select karein.')
        : `❌ Scan failed: ${e?.message || 'unknown error'}`);
      setProgress('');
    }
    setScanning(false);
  };

  const runMatch = (rowList, forKind = kind) => {
    const m = forKind === 'HSD' ? matchRowsToFuelEntries(rowList, fuelEntries) : matchRowsToTrips(rowList, trips);
    setMatches(m);
    const sel = {};
    m.forEach((mt, i) => { sel[i] = mt.status === 'MATCHED' && rowList[i]._review.length === 0; });
    setSelected(sel);
  };

  // ── Row editing (arithmetic stays in code) ──────────────────────────────
  const editRow = (i, field, value) => {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      const nr = { ...r, [field]: ['qty', 'shortage', 'rate', 'rtd', 'gross_amount', 'gst', 'penalty'].includes(field) ? (parseFloat(value) || 0) : value };
      if ((field === 'qty' || field === 'rate' || field === 'rtd') && kind !== 'BPCL') {
        // Same three billing bases as the engine: tonne-km (IOCL), per-KL, per-litre
        nr.gross_amount = nr.rtd > 0 ? round2(nr.qty * nr.rtd * nr.rate)
          : kind === 'FREIGHT' ? round2((nr.qty / 1000) * nr.rate)
          : round2(nr.qty * nr.rate);
      }
      nr._review = r._review.filter(f => f !== field); // user verified this field
      return nr;
    }));
  };
  const setMatchTarget = (i, targetId) => setMatches(prev => prev.map((m, idx) => idx === i ? { ...m, targetId, status: targetId ? 'MATCHED' : 'UNMATCHED' } : m));

  // ── Filing ──────────────────────────────────────────────────────────────
  const fileSelected = async () => {
    if (filing) return;
    const toFile = rows.map((r, i) => ({ r, m: matches[i], i })).filter(x => selected[x.i] && x.m?.targetId);
    if (!toFile.length) return alert('⚠️ Koi row select nahi hai (sirf matched rows file ho sakti hain).');
    const pendingReview = toFile.filter(x => x.r._review.length);
    if (pendingReview.length && !window.confirm(`${pendingReview.length} row(s) me review-flag fields hain. Phir bhi file karein?`)) return;

    setFiling(true);
    const billRef = bpcl?.clearing_doc || bill?.header?.bill_no || `SCAN-${Date.now()}`;
    let ok = 0, journalOk = 0; const errors = [];
    try {
      const batch = writeBatch(db);
      for (const { r, m } of toFile) {
        if (kind !== 'HSD') {
          const trip = trips.find(t => t.id === m.targetId);
          if (!trip) continue;
          const upd = {
            gross_freight: r.gross_amount,
            rate: r.rate,
            billing_status: 'BILLED',
            billed_bill_no: billRef,
            billed_at: new Date().toISOString(),
          };
          // 📥 Billed Quantity bhi trip record me (KL) — billing dashboards par
          // Qty × Rate poora bhara dikhe. Litre rows KL me convert; TO as-is.
          if (r.qty > 0) upd.qty = r.qty_unit === 'L' ? round2(r.qty / 1000) : r.qty;
          // Auto-fill unloading figures only where the trip doesn't have them —
          // the scan must never overwrite office-approved quantities.
          const hasUnloaded = parseFloat(trip.unloaded_qty || trip.Unloaded_Qty || 0) > 0;
          if (!hasUnloaded && r.qty > 0) {
            upd.unloaded_qty = String(round2(r.qty - (r.shortage || 0)));
            if (r.shortage > 0) upd.shortage_qty = String(r.shortage);
          }
          batch.update(doc(db, 'TRIPS', trip.id), upd);
        } else {
          const fe = fuelEntries.find(f => f.id === m.targetId);
          if (!fe) continue;
          const newAmount = round2(r.qty * r.rate);
          const oldAmount = round2(parseFloat(fe.amount) || 0);
          batch.update(doc(db, 'FUEL_ENTRIES', fe.id), {
            rate: String(r.rate), amount: newAmount.toFixed(2),
            bill_status: 'BILLED', billed_bill_no: billRef, billed_at: new Date().toISOString(),
          });
          // Diesel value correction flows into the trip's true expense.
          const trip = fe.trip_id ? trips.find(t => (t.trip_id || t.Trip_ID) === fe.trip_id) : null;
          if (trip && Math.abs(newAmount - oldAmount) > 0.01) {
            batch.update(doc(db, 'TRIPS', trip.id), { total_expense: increment(round2(newAmount - oldAmount)) });
          }
        }
        ok++;
      }
      await batch.commit();

      // Journal posting (idempotent per source_ref — re-filing overwrites, never duplicates)
      for (const { r, m } of toFile) {
        try {
          if (kind !== 'HSD') {
            const trip = trips.find(t => t.id === m.targetId);
            const ref = trip?.trip_id || trip?.Trip_ID || trip?.id;
            const cust = kind === 'BPCL' ? 'BPCL' : (bill?.header?.party_name || trip?.customer_name || trip?.Customer || 'Unknown Customer');
            const lines = [
              { ledger: `Debtors: ${cust}`, dr_cr: 'Dr', amount: round2(r.gross_amount + (r.gst || 0)) },
              { ledger: 'Direct Incomes (Freight/Trip Revenue)', dr_cr: 'Cr', amount: r.gross_amount },
            ];
            if (r.gst > 0) lines.push({ ledger: 'GST Output Payable', dr_cr: 'Cr', amount: r.gst });
            await postEntry({ source_type: 'TRIP_FREIGHT', source_ref: ref, date: r.date || bill?.header?.bill_date || '', narration: `Freight billed — trip ${ref} (bill ${billRef})`, company: trip?.operating_company || trip?.Operating_Company || '', lines });
          } else {
            const fe = fuelEntries.find(f => f.id === m.targetId);
            const pump = fe?.vendor_name || bill?.header?.party_name || 'Pump';
            const amount = round2(r.qty * r.rate);
            await postEntry({ source_type: 'FUEL', source_ref: fe?.memo_no || fe?.id, date: r.date || '', narration: `Diesel billed — ${pump} (${r.vehicle_no}, bill ${billRef})`, lines: [
              { ledger: 'Diesel / Fuel Expense', dr_cr: 'Dr', amount },
              { ledger: `Creditors: ${pump}`, dr_cr: 'Cr', amount },
            ]});
          }
          journalOk++;
        } catch (je) { errors.push(`Journal: ${je?.message || je}`); }
      }

      // 🛢️ BPCL AP210: one bill-level SETTLEMENT entry — the full money split.
      // Gross clears the debtor; net hits bank; TDS becomes receivable; the
      // FLEET CARD DEBIT recharges the BPCL wallet; the rest is loss recovery.
      if (kind === 'BPCL' && bpcl) {
        try {
          const lossOther = round2(Math.max(0, bpcl.loss_recovery - bpcl.fleet_card_debit));
          const lines = [
            { ledger: 'Debtors: BPCL', dr_cr: 'Cr', amount: bpcl.gross_amount },
            { ledger: 'Bank', dr_cr: 'Dr', amount: bpcl.net_payable },
          ];
          if (bpcl.tds_recovery > 0) lines.push({ ledger: 'TDS Receivable', dr_cr: 'Dr', amount: bpcl.tds_recovery });
          if (bpcl.fleet_card_debit > 0) lines.push({ ledger: CARD_PROVIDERS.BPCL.wallet, dr_cr: 'Dr', amount: bpcl.fleet_card_debit });
          if (lossOther > 0) lines.push({ ledger: 'Shortage / Loss Recovery', dr_cr: 'Dr', amount: lossOther });
          await postEntry({
            source_type: 'BPCL_AP210', source_ref: billRef, date: bpcl.clearing_date || '',
            narration: `BPCL AP210 settlement ${billRef} (${bpcl.period}) — net ${bpcl.net_payable.toLocaleString('en-IN')}, card debit ${bpcl.fleet_card_debit.toLocaleString('en-IN')}`,
            lines,
          });
          journalOk++;

          // Fleet card wallet recharge (idempotent doc id per clearing doc)
          if (bpcl.fleet_card_debit > 0) {
            const txnId = `AP210_${billRef}`.replace(/[^A-Za-z0-9_-]/g, '_');
            const already = await getDocs(query(collection(db, 'CARD_TRANSACTIONS'), where('ref', '==', txnId)));
            if (already.empty) {
              const b2 = writeBatch(db);
              b2.set(doc(db, 'CARD_TRANSACTIONS', txnId), {
                card_id: 'BPCL', provider: 'BPCL', type: 'RECHARGE',
                amount: bpcl.fleet_card_debit, date: bpcl.clearing_date || '', party: 'BPCL',
                narration: `FLEET CARD DEBIT via AP210 ${billRef}`, ref: txnId, createdAt: new Date().toISOString(),
              });
              b2.update(doc(db, 'FLEET_CARDS', 'BPCL'), { current_balance: increment(bpcl.fleet_card_debit) });
              await b2.commit();
            }
          }
        } catch (je) { errors.push(`AP210 settlement: ${je?.message || je}`); }
      }

      setFiledSummary({ ok, journalOk, total: toFile.length, errors, billRef });
      fetchTargets();
    } catch (e) {
      console.error(e);
      alert(`❌ Filing failed — kuch bhi save NahiN hua (atomic batch): ${e?.message || 'error'}`);
    }
    setFiling(false);
  };

  // ── Styles ──────────────────────────────────────────────────────────────
  const S = {
    page: { padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif" },
    card: { background: 'rgba(30,41,59,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: 'clamp(14px,3vw,25px)', marginBottom: '18px' },
    input: { background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: '8px', color: 'white', padding: '10px', width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: '42px' },
    btn: (bg, dis) => ({ background: dis ? '#475569' : bg, color: 'white', border: 'none', borderRadius: '8px', padding: '14px 22px', fontWeight: 'bold', cursor: dis ? 'default' : 'pointer', minHeight: '48px', fontSize: '15px' }),
    chip: (c) => ({ background: c + '22', color: c, border: `1px solid ${c}`, borderRadius: '999px', padding: '3px 10px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap' }),
  };
  const matchChip = (m) => !m ? null
    : m.status === 'MATCHED' ? <span style={S.chip('#10b981')}>✔ Matched</span>
    : m.status === 'AMBIGUOUS' ? <span style={S.chip('#f59e0b')}>? Choose</span>
    : <span style={S.chip('#ef4444')}>✖ No match</span>;

  const reviewStyle = (r, f) => r._review.includes(f) ? { borderColor: '#f59e0b', background: 'rgba(245,158,11,0.08)' } : {};

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: '0 0 4px 0', color: '#38bdf8' }}>🤖 AI Bill Scanner</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 14px 0', fontSize: '13px' }}>Mamta AI — freight invoice ya HSD pump bill scan karke seedha Trips + Ledger me file karein.</p>

      {/* 🔀 AI ENGINE SELECTION — Local (Ollama, free) vs Cloud (Claude Haiku) */}
      <div style={{ ...S.card, padding: '14px 18px', border: aiEngine === 'cloud' ? '1px solid #c084fc' : '1px solid #10b981', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '12px', fontWeight: 'bold', color: aiEngine === 'cloud' ? '#c084fc' : '#10b981', whiteSpace: 'nowrap' }}>
          🧠 AI Engine Selection
        </label>
        <select value={aiEngine} onChange={e => switchEngine(e.target.value)}
          style={{ ...S.input, width: isMobile ? '100%' : '340px', borderColor: aiEngine === 'cloud' ? '#c084fc' : '#10b981', fontWeight: 'bold' }}>
          {AI_ENGINES.map(e => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
        <span style={{ fontSize: '11px', color: '#64748b' }}>
          {aiEngine === 'cloud'
            ? '☁️ Scans Anthropic API (Claude Haiku) par jayenge — mobile/remote se bhi chalta hai, per-scan cost lagti hai. API key sirf bridge server par rehti hai.'
            : '💻 Scans isi computer par Ollama + Gemma se honge — bilkul free, data machine se bahar nahi jata.'}
        </span>
      </div>

      {/* Kind toggle */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[['FREIGHT', '🧾 Freight Invoice'], ['HSD', '⛽ HSD / Pump Bill'], ['BPCL', '🛢️ BPCL AP210']].map(([k, label]) => (
          <button key={k} onClick={() => { setKind(k); setBill(null); setBpcl(null); setRows([]); setMatches([]); }}
            style={{ ...S.btn(kind === k ? '#2563eb' : '#1e293b', false), flex: isMobile ? 1 : 'none', border: kind === k ? '1px solid #38bdf8' : '1px solid #334155' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Capture zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        style={{ ...S.card, border: dragOver ? '2px dashed #38bdf8' : '2px dashed #475569', textAlign: 'center', background: dragOver ? 'rgba(56,189,248,0.08)' : 'rgba(30,41,59,0.3)' }}
      >
        <div style={{ fontSize: '40px', marginBottom: '8px' }}>📄</div>
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button style={S.btn('#059669', false)} onClick={() => cameraRef.current?.click()}>📸 Photo Kheencho (Camera)</button>
            <button style={S.btn('#2563eb', false)} onClick={() => galleryRef.current?.click()}>🖼️ Gallery / PDF Upload</button>
          </div>
        ) : (
          <>
            <p style={{ color: '#cbd5e1', margin: '0 0 12px 0' }}>Bill PDF ya photos yahan <b>drag & drop</b> karein — ya</p>
            <button style={S.btn('#2563eb', false)} onClick={() => galleryRef.current?.click()}>📁 Browse Files (PDF / Image)</button>
          </>
        )}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <input ref={galleryRef} type="file" accept="image/*,.pdf" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <p style={{ color: '#64748b', fontSize: '11px', marginTop: '12px' }}>Multi-page bill? Har page ki photo add karte jaayein — sab ek saath scan honge.</p>
      </div>

      {/* Selected files */}
      {files.length > 0 && (
        <div style={S.card}>
          <b style={{ color: '#38bdf8', fontSize: '13px' }}>📎 {files.length} file(s) ready</b>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '10px 0' }}>
            {files.map((f, i) => (
              <span key={i} style={{ background: '#1e293b', borderRadius: '8px', padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {/pdf/i.test(f.type) ? '📄' : '🖼️'} {f.name.length > 24 ? f.name.slice(0, 22) + '…' : f.name}
                <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '14px', padding: '2px' }}>✕</button>
              </span>
            ))}
          </div>
          <button style={{ ...S.btn('#f59e0b', scanning), width: isMobile ? '100%' : 'auto' }} disabled={scanning} onClick={runScan}>
            {scanning ? '⌛ Mamta AI padh rahi hai…' : '🔍 Scan with Mamta AI'}
          </button>
          {progress && <p style={{ color: '#38bdf8', fontSize: '13px', marginTop: '10px' }}>{progress}</p>}
        </div>
      )}

      {/* Results */}
      {bpcl && (
        <div style={{ ...S.card, border: '1px solid #eab308' }}>
          <b style={{ color: '#eab308' }}>🛢️ BPCL AP210 — {bpcl.clearing_doc || '?'} ({bpcl.period})</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: '10px', marginTop: '12px' }}>
            {[['Gross Freight', bpcl.gross_amount, '#10b981'], ['TDS Recovery', bpcl.tds_recovery, '#f59e0b'], ['Loss Recovery', round2(Math.max(0, bpcl.loss_recovery - bpcl.fleet_card_debit)), '#ef4444'], ['💳 FLEET CARD DEBIT → Wallet', bpcl.fleet_card_debit, '#38bdf8'], ['Net Payable (Bank)', bpcl.net_payable, '#c084fc']].map(([label, v, c]) => (
              <div key={label} style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${c}55`, borderRadius: '10px', padding: '10px', textAlign: 'center' }}>
                <div style={{ fontSize: '10px', color: c, fontWeight: 'bold' }}>{label}</div>
                <b style={{ fontSize: '15px' }}>{fmtINR(v)}</b>
              </div>
            ))}
          </div>
          {bpcl.checks.map((c, i) => <p key={i} style={{ fontSize: '12px', color: c.ok ? '#10b981' : '#ef4444', margin: '8px 0 0 0' }}>{c.ok ? '✔' : '✖'} {c.label}: {c.detail}</p>)}
          {bpcl.warnings.map((w, i) => <p key={i} style={{ fontSize: '12px', color: '#f59e0b', margin: '6px 0 0 0' }}>⚠️ {w}</p>)}
          {bpcl.lossRows.length > 0 && <p style={{ fontSize: '11px', color: '#94a3b8', margin: '8px 0 0 0' }}>Loss-recovery rows: {bpcl.lossRows.map(l => `${l.vehicle_no || '?'} ${fmtINR(l.amount)}`).join(' · ')}</p>}
        </div>
      )}

      {(bill || bpcl) && (
        <>
          {bill && <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <div>
                <b style={{ color: '#10b981' }}>📋 {bill.header.party_name || 'Party ?'} — Bill {bill.header.bill_no || '?'}</b>
                <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#94a3b8' }}>
                  {bill.pages} page(s) · {rows.length} rows · Row total <b style={{ color: 'white' }}>{fmtINR(bill.rowSum)}</b>
                  {bill.header.total_amount > 0 && <> · Bill total <b style={{ color: bill.totalMatches ? '#10b981' : '#ef4444' }}>{fmtINR(bill.header.total_amount)}</b></>}
                </p>
              </div>
              {bill.totalMatches
                ? <span style={S.chip('#10b981')}>✔ Totals tally</span>
                : <span style={S.chip('#ef4444')}>⚠ Totals differ</span>}
            </div>
            {bill.warnings.map((w, i) => <p key={i} style={{ color: '#f59e0b', fontSize: '12px', margin: '8px 0 0 0' }}>⚠️ {w}</p>)}
          </div>}

          {/* Rows: cards on mobile, table on desktop */}
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
              <b style={{ color: '#38bdf8' }}>Extracted rows — verify & file</b>
              <button style={{ ...S.btn('#334155', false), padding: '8px 14px', minHeight: '38px', fontSize: '13px' }} onClick={() => runMatch(rows)}>🔁 Re-match</button>
            </div>

            {isMobile ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {rows.map((r, i) => (
                  <div key={i} style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid #334155', borderRadius: '12px', padding: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }}>
                        <input type="checkbox" style={{ width: '20px', height: '20px' }} checked={!!selected[i]} onChange={e => setSelected(p => ({ ...p, [i]: e.target.checked }))} />
                        Row {i + 1} <span style={{ color: '#64748b', fontWeight: 'normal', fontSize: '11px' }}>p{r.page}</span>
                      </label>
                      {matchChip(matches[i])}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      {[['vehicle_no', 'Vehicle'], ['date', 'Date'], ['qty', `Qty ${r.qty_unit || ''}`], ['shortage', 'Shortage'], ['rate', 'Rate ₹'], ...(kind !== 'HSD' ? [['rtd', 'RTD km']] : []), ['gross_amount', 'Gross ₹'], ['gst', 'GST ₹']].map(([f, label]) => (
                        <div key={f}>
                          <label style={{ fontSize: '10px', color: r._review.includes(f) ? '#f59e0b' : '#64748b' }}>{label}{r._review.includes(f) ? ' ⚠' : ''}</label>
                          <input style={{ ...S.input, padding: '8px', ...reviewStyle(r, f) }} inputMode={f === 'vehicle_no' ? 'text' : 'decimal'} value={r[f]} onChange={e => editRow(i, f, e.target.value)} />
                        </div>
                      ))}
                    </div>
                    {matches[i]?.candidates?.length > 0 && (
                      <select style={{ ...S.input, marginTop: '8px' }} value={matches[i].targetId} onChange={e => setMatchTarget(i, e.target.value)}>
                        <option value="">— {kind === 'FREIGHT' ? 'Trip' : 'Fuel memo'} select karein —</option>
                        {matches[i].candidates.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '900px' }}>
                  <thead><tr style={{ color: '#38bdf8', textAlign: 'left' }}>
                    {['✓', 'Vehicle', 'Date', 'Qty', 'Shortage', 'Rate ₹', ...(kind !== 'HSD' ? ['RTD km'] : []), 'Gross ₹', 'GST ₹', 'Match'].map(h => <th key={h} style={{ padding: '8px', borderBottom: '2px solid #334155' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '6px' }}><input type="checkbox" style={{ width: '18px', height: '18px' }} checked={!!selected[i]} onChange={e => setSelected(p => ({ ...p, [i]: e.target.checked }))} /></td>
                        {['vehicle_no', 'date', 'qty', 'shortage', 'rate', ...(kind !== 'HSD' ? ['rtd'] : []), 'gross_amount', 'gst'].map(f => (
                          <td key={f} style={{ padding: '6px' }}>
                            <input style={{ ...S.input, padding: '7px', minHeight: '34px', width: f === 'vehicle_no' ? '120px' : f === 'date' ? '110px' : '85px', ...reviewStyle(r, f) }} value={r[f]} onChange={e => editRow(i, f, e.target.value)} title={r._review.includes(f) ? 'AI unsure — verify' : ''} />
                          </td>
                        ))}
                        <td style={{ padding: '6px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {matchChip(matches[i])}
                            {matches[i]?.candidates?.length > 0 && (
                              <select style={{ ...S.input, padding: '5px', minHeight: '30px', fontSize: '11px', width: '180px' }} value={matches[i].targetId} onChange={e => setMatchTarget(i, e.target.value)}>
                                <option value="">— select —</option>
                                {matches[i].candidates.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                              </select>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: '16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <button style={{ ...S.btn('#10b981', filing), flex: isMobile ? 1 : 'none' }} disabled={filing} onClick={fileSelected}>
                {filing ? '⌛ Filing…' : `✅ File ${Object.values(selected).filter(Boolean).length} row(s) → ${kind === 'HSD' ? 'Fuel + Ledger' : 'Trips + Ledger'}`}
              </button>
              <span style={{ fontSize: '11px', color: '#64748b' }}>Sirf matched + ticked rows file hoti hain. Journal posting idempotent hai — dobara file karne par duplicate nahi banta.</span>
            </div>
          </div>
        </>
      )}

      {/* Filing summary */}
      {filedSummary && (
        <div style={{ ...S.card, border: '1px solid #10b981' }}>
          <h3 style={{ color: '#10b981', margin: '0 0 8px 0' }}>✅ Filed — Bill {filedSummary.billRef}</h3>
          <p style={{ margin: 0, fontSize: '14px', color: '#cbd5e1' }}>
            {filedSummary.ok}/{filedSummary.total} rows updated in {kind === 'FREIGHT' ? 'TRIPS' : 'FUEL_ENTRIES'} · {filedSummary.journalOk} journal entries posted.
          </p>
          {filedSummary.errors.map((e, i) => <p key={i} style={{ color: '#ef4444', fontSize: '12px', margin: '6px 0 0 0' }}>⚠️ {e}</p>)}
        </div>
      )}
    </div>
  );
}
