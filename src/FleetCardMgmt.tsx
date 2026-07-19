// @ts-nocheck
// 💳 FLEET CARD & SETTLEMENT — the real fuel-money loop:
//   pump CREDIT (liability) → CARD SETTLEMENT (swipe clears pump) → WALLET
//   RECHARGE (freight deductions load the card). Plus the Mamta AI reconciler
//   that reads IOCL/HPCL/BPCL statements and catches missed/unknown swipes.
import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, setDoc, writeBatch, increment, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';
import { postEntry } from './lib/accounting/journal';
import { round2, toISODate } from './lib/accounting/tripMath';
import { CARD_PROVIDERS, extractCardStatement, reconcileStatement } from './lib/fleetCard';
import { classifyDocument } from './lib/billScanner';
import BottomSheet from './ui/BottomSheet';
import { useIsMobile } from './hooks/useIsMobile';

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().split('T')[0];

export default function FleetCardMgmt() {
  const { isMobile } = useIsMobile();
  const [cards, setCards] = useState([]);
  const [txns, setTxns] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Sheets
  const [rechargeSheet, setRechargeSheet] = useState(false);
  const [settleSheet, setSettleSheet] = useState(false);
  const [form, setForm] = useState({ card_id: '', amount: '', party: '', date: today(), ref: '' });

  // Reconciler
  const [reconProvider, setReconProvider] = useState('IOCL');
  const [reconFile, setReconFile] = useState(null);
  const [reconBusy, setReconBusy] = useState(false);
  const [reconProgress, setReconProgress] = useState('');
  const [stmt, setStmt] = useState(null);
  const [recon, setRecon] = useState(null);

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setLoading(true);
    try {
      let [cSnap, tSnap, vSnap, custSnap] = await Promise.all([
        getDocs(collection(db, 'FLEET_CARDS')).catch(() => ({ docs: [] })),
        getDocs(query(collection(db, 'CARD_TRANSACTIONS'), orderBy('date', 'desc'))).catch(() => getDocs(collection(db, 'CARD_TRANSACTIONS')).catch(() => ({ docs: [] }))),
        getDocs(collection(db, 'VENDORS')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'CUSTOMERS')).catch(() => ({ docs: [] })),
      ]);
      // First run: seed the three provider wallets (deterministic ids — idempotent)
      if (cSnap.docs.length === 0) {
        for (const [key, meta] of Object.entries(CARD_PROVIDERS)) {
          await setDoc(doc(db, 'FLEET_CARDS', key), { provider: key, name: meta.name, current_balance: 0, created_at: serverTimestamp() }, { merge: true });
        }
        cSnap = await getDocs(collection(db, 'FLEET_CARDS'));
      }
      setCards(cSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setTxns(tSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setVendors(vSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(v => v.vendor_name || v.agency_name));
      setCustomers(custSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const cardById = (id) => cards.find(c => c.id === id);
  const openSheet = (which) => {
    setForm({ card_id: cards[0]?.id || '', amount: '', party: '', date: today(), ref: '' });
    which === 'RECHARGE' ? setRechargeSheet(true) : setSettleSheet(true);
  };

  // 💰 RECHARGE: freight deduction (~40% advance cut from the bill) loads the wallet
  const saveRecharge = async () => {
    const amt = round2(parseFloat(form.amount));
    const card = cardById(form.card_id);
    if (!card || !Number.isFinite(amt) || amt <= 0) return alert('⚠️ Card aur sahi amount chunein!');
    setSaving(true);
    try {
      const txnRef = doc(collection(db, 'CARD_TRANSACTIONS'));
      const batch = writeBatch(db);
      batch.set(txnRef, {
        card_id: card.id, provider: card.provider, type: 'RECHARGE',
        amount: amt, date: form.date, party: form.party || '',
        narration: `Freight deduction recharge${form.party ? ' — ' + form.party : ''}${form.ref ? ' (' + form.ref + ')' : ''}`,
        ref: form.ref || '', createdAt: serverTimestamp(),
      });
      batch.update(doc(db, 'FLEET_CARDS', card.id), { current_balance: increment(amt) });
      await batch.commit();

      // Double-entry: wallet asset up; customer's receivable down (they kept the money)
      await postEntry({
        source_type: 'CARD_RECHARGE', source_ref: txnRef.id, date: form.date,
        narration: `Fleet card recharge via freight deduction — ${card.name}${form.party ? ' (' + form.party + ')' : ''}`,
        lines: [
          { ledger: CARD_PROVIDERS[card.provider].wallet, dr_cr: 'Dr', amount: amt },
          { ledger: form.party ? `Debtors: ${form.party}` : 'Freight Deductions Clearing', dr_cr: 'Cr', amount: amt },
        ],
      }).catch(e => alert('⚠️ Journal entry fail hui (data save hai): ' + e.message));

      alert(`✅ ${card.name} me ${inr(amt)} recharge darj!`);
      setRechargeSheet(false); fetchAll();
    } catch (e) { console.error(e); alert('❌ Save nahi hua: ' + (e.message || 'error')); }
    setSaving(false);
  };

  // 🤝 SETTLEMENT: card swipe clears the pump's credit (liability)
  const saveSettlement = async () => {
    const amt = round2(parseFloat(form.amount));
    const card = cardById(form.card_id);
    const vendor = vendors.find(v => v.id === form.party);
    if (!card || !vendor || !Number.isFinite(amt) || amt <= 0) return alert('⚠️ Card, pump aur sahi amount chunein!');
    const bal = round2(parseFloat(card.current_balance) || 0);
    if (amt > bal && !window.confirm(`⚠️ Card balance ${inr(bal)} se zyada settlement (${inr(amt)}). Phir bhi darj karein?`)) { return; }
    const vName = vendor.vendor_name || vendor.agency_name;
    setSaving(true);
    try {
      const txnRef = doc(collection(db, 'CARD_TRANSACTIONS'));
      const batch = writeBatch(db);
      batch.set(txnRef, {
        card_id: card.id, provider: card.provider, type: 'SETTLEMENT',
        amount: amt, date: form.date, party: vName, vendor_id: vendor.id,
        narration: `Pump bill settled by card swipe — ${vName}${form.ref ? ' (' + form.ref + ')' : ''}`,
        ref: form.ref || '', createdAt: serverTimestamp(),
      });
      batch.update(doc(db, 'FLEET_CARDS', card.id), { current_balance: increment(-amt) });
      // Legacy display balance is stored as mixed string/number — write computed number
      batch.update(doc(db, 'VENDORS', vendor.id), { current_balance: round2((parseFloat(vendor.current_balance) || 0) - amt) });
      await batch.commit();

      // Double-entry: pump liability cleared against the wallet asset
      await postEntry({
        source_type: 'CARD_SETTLEMENT', source_ref: txnRef.id, date: form.date,
        narration: `Pump credit settled via ${card.name} — ${vName}`,
        lines: [
          { ledger: `Creditors: ${vName}`, dr_cr: 'Dr', amount: amt },
          { ledger: CARD_PROVIDERS[card.provider].wallet, dr_cr: 'Cr', amount: amt },
        ],
      }).catch(e => alert('⚠️ Journal entry fail hui (data save hai): ' + e.message));

      alert(`✅ ${vName} ka ${inr(amt)} card se settle!`);
      setSettleSheet(false); fetchAll();
    } catch (e) { console.error(e); alert('❌ Save nahi hua: ' + (e.message || 'error')); }
    setSaving(false);
  };

  // 🤖 Reconciler
  const runRecon = async () => {
    if (!reconFile || reconBusy) return alert('⚠️ Statement PDF chunein!');
    setReconBusy(true); setStmt(null); setRecon(null);
    try {
      const s = await extractCardStatement(reconFile, reconProvider, setReconProgress);
      setStmt(s);
      const erpTxns = txns.filter(t => t.provider === reconProvider);
      setRecon(reconcileStatement(s, erpTxns));
      setReconProgress('');
    } catch (e) {
      const offline = e?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(e?.message || '');
      alert(offline ? '❌ Local AI engine (Ollama) band hai.' : `❌ Statement padha nahi gaya: ${e?.message || 'error'}`);
      setReconProgress('');
    }
    setReconBusy(false);
  };

  const totalWallet = useMemo(() => round2(cards.reduce((s, c) => s + (parseFloat(c.current_balance) || 0), 0)), [cards]);

  const S = {
    page: { padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white', fontFamily: "'Inter', sans-serif" },
    card: { background: 'rgba(30,41,59,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: 'clamp(14px,3vw,25px)', marginBottom: '18px' },
    input: { background: 'rgba(15,23,42,0.7)', border: '1px solid #334155', borderRadius: '10px', color: 'white', padding: '12px', width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: '44px', colorScheme: 'dark' },
    btn: (bg, dis) => ({ background: dis ? '#475569' : bg, color: 'white', border: 'none', borderRadius: '10px', padding: '14px 20px', fontWeight: 'bold', cursor: dis ? 'default' : 'pointer', minHeight: '48px', fontSize: '15px' }),
    label: { display: 'block', fontSize: '12px', color: '#94a3b8', fontWeight: 'bold', margin: '12px 0 6px' },
  };

  const sheetForm = (isSettle) => (
    <div>
      <label style={S.label}>Fleet Card</label>
      <select style={S.input} value={form.card_id} onChange={e => setForm({ ...form, card_id: e.target.value })}>
        {cards.map(c => <option key={c.id} value={c.id}>{c.name} — {inr(c.current_balance)}</option>)}
      </select>
      {isSettle ? (<>
        <label style={S.label}>Petrol Pump (jiska udhaar chukana hai)</label>
        <select style={S.input} value={form.party} onChange={e => setForm({ ...form, party: e.target.value })}>
          <option value="">-- Pump chunein --</option>
          {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name || v.agency_name} — Baaki: {inr(v.current_balance)}</option>)}
        </select>
      </>) : (<>
        <label style={S.label}>Customer (jisne freight se kaata) — optional</label>
        <input list="fc-cust" style={S.input} value={form.party} onChange={e => setForm({ ...form, party: e.target.value })} placeholder="e.g. IOCL AOD" />
        <datalist id="fc-cust">{customers.map(c => <option key={c.id} value={c.customer_name} />)}</datalist>
      </>)}
      <label style={S.label}>Amount (₹)</label>
      <input type="number" inputMode="decimal" style={{ ...S.input, fontSize: '22px', fontWeight: 900 }} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" />
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '140px' }}><label style={S.label}>Date</label><input type="date" style={S.input} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
        <div style={{ flex: 1, minWidth: '140px' }}><label style={S.label}>Ref / Bill No (optional)</label><input style={S.input} value={form.ref} onChange={e => setForm({ ...form, ref: e.target.value })} /></div>
      </div>
      <button onClick={isSettle ? saveSettlement : saveRecharge} disabled={saving} style={{ ...S.btn(isSettle ? '#10b981' : '#3b82f6', saving), width: '100%', marginTop: '18px' }}>
        {saving ? '⌛ Saving…' : isSettle ? '🤝 Pump Settle Karo (Card Swipe)' : '💰 Wallet Recharge Darj Karo'}
      </button>
    </div>
  );

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: '0 0 4px 0', color: '#38bdf8' }}>💳 Fleet Card & Settlement</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 18px 0', fontSize: '13px' }}>Pump udhaar → Card swipe settlement → Freight-deduction recharge. Mamta AI statement reconciler niche hai.</p>

      {/* Wallets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '14px', marginBottom: '18px' }}>
        {cards.map(c => (
          <div key={c.id} style={{ ...S.card, marginBottom: 0, borderLeft: `5px solid ${CARD_PROVIDERS[c.provider]?.color || '#38bdf8'}` }}>
            <div style={{ fontSize: '13px', color: '#94a3b8', fontWeight: 'bold' }}>{c.name}</div>
            <div style={{ fontSize: 'clamp(22px, 5vw, 30px)', fontWeight: 900, color: (parseFloat(c.current_balance) || 0) < 0 ? '#ef4444' : '#10b981' }}>{inr(c.current_balance)}</div>
          </div>
        ))}
        <div style={{ ...S.card, marginBottom: 0, borderLeft: '5px solid #8b5cf6', background: 'rgba(139,92,246,0.08)' }}>
          <div style={{ fontSize: '13px', color: '#c4b5fd', fontWeight: 'bold' }}>Total Wallet Balance</div>
          <div style={{ fontSize: 'clamp(22px, 5vw, 30px)', fontWeight: 900, color: '#c084fc' }}>{inr(totalWallet)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' }}>
        <button onClick={() => openSheet('RECHARGE')} style={{ ...S.btn('#3b82f6', false), flex: isMobile ? 1 : 'none' }}>💰 Recharge (Freight Deduction)</button>
        <button onClick={() => openSheet('SETTLE')} style={{ ...S.btn('#10b981', false), flex: isMobile ? 1 : 'none' }}>🤝 Pump Settlement (Card Swipe)</button>
      </div>

      {/* Transactions */}
      <div style={S.card}>
        <b style={{ color: '#38bdf8' }}>📒 Card Transactions</b>
        {loading ? <p style={{ color: '#64748b' }}>Loading…</p> : txns.length === 0 ? <p style={{ color: '#64748b', fontSize: '13px' }}>Abhi koi entry nahi. Upar ke buttons se recharge/settlement darj karein.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {txns.slice(0, 30).map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(15,23,42,0.6)', border: '1px solid #1e293b', borderRadius: '10px', padding: '10px 14px', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <b style={{ fontSize: '13px', color: t.type === 'RECHARGE' ? '#3b82f6' : '#10b981' }}>{t.type === 'RECHARGE' ? '💰 Recharge' : '🤝 Settlement'}</b>
                  <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: '8px' }}>{t.party || CARD_PROVIDERS[t.provider]?.name}</span>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>{toISODate(t.date)} · {CARD_PROVIDERS[t.provider]?.name}{t.ref ? ` · ${t.ref}` : ''}</div>
                </div>
                <b style={{ color: t.type === 'RECHARGE' ? '#3b82f6' : '#f59e0b', whiteSpace: 'nowrap' }}>{t.type === 'RECHARGE' ? '+' : '−'}{inr(t.amount)}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 🤖 AI Reconciler */}
      <div style={{ ...S.card, border: '1px solid #8b5cf6' }}>
        <b style={{ color: '#c084fc', fontSize: '15px' }}>🤖 Mamta AI — Statement Reconciler</b>
        <p style={{ color: '#94a3b8', fontSize: '12px', margin: '6px 0 12px' }}>IOCL / HPCL / BPCL ka monthly statement PDF daalein — Mamta AI har swipe ko aapki settlement entries se milayegi aur missing/unknown swipe pakdegi.</p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={{ ...S.input, width: 'auto', flex: isMobile ? 1 : 'none' }} value={reconProvider} onChange={e => setReconProvider(e.target.value)}>
            {Object.entries(CARD_PROVIDERS).map(([k, m]) => <option key={k} value={k}>{m.name}</option>)}
          </select>
          <input type="file" accept=".pdf,image/*" onChange={async e => {
            const f = e.target.files?.[0] || null; e.target.value = '';
            setReconFile(f);
            if (!f) return;
            // 🧭 Auto-detect the provider from the document itself
            try {
              const kind = await classifyDocument(f);
              if (kind === 'IOCL_STATEMENT') setReconProvider('IOCL');
              else if (kind === 'HPCL_DRIVETRACK') setReconProvider('HPCL');
              else if (kind === 'BPCL_STATEMENT') setReconProvider('BPCL');
              else if (kind === 'BPCL_FREIGHT_BILL') alert('🧭 Yeh BPCL ka AP210 FREIGHT BILL hai, card statement nahi.\nIse ACCOUNTS → 🤖 AI Bill Scanner me kholein — wahan freight + TDS + FLEET CARD DEBIT sab auto-file hoga.');
            } catch {}
          }} style={{ color: '#94a3b8', flex: 1, minWidth: '200px' }} />
          <button onClick={runRecon} disabled={reconBusy} style={S.btn('#8b5cf6', reconBusy)}>{reconBusy ? '⌛ Padh rahi hai…' : '🔍 Reconcile'}</button>
        </div>
        {reconFile && !reconBusy && <p style={{ fontSize: '12px', color: '#10b981', marginTop: '8px' }}>📎 {reconFile.name}</p>}
        {reconProgress && <p style={{ fontSize: '13px', color: '#c084fc', marginTop: '10px' }}>{reconProgress}</p>}

        {stmt && recon && (
          <div style={{ marginTop: '18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: '10px', marginBottom: '14px' }}>
              <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981', borderRadius: '10px', padding: '12px', textAlign: 'center' }}><div style={{ fontSize: '11px', color: '#6ee7b7' }}>Swipes Matched</div><b style={{ fontSize: '22px', color: '#10b981' }}>{recon.totals.swipesMatched}</b></div>
              <div style={{ background: recon.totals.swipesMissing ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.04)', border: `1px solid ${recon.totals.swipesMissing ? '#ef4444' : '#334155'}`, borderRadius: '10px', padding: '12px', textAlign: 'center' }}><div style={{ fontSize: '11px', color: '#fca5a5' }}>⚠️ ERP me Missing</div><b style={{ fontSize: '22px', color: recon.totals.swipesMissing ? '#ef4444' : '#64748b' }}>{recon.totals.swipesMissing}</b><div style={{ fontSize: '11px', color: '#fca5a5' }}>{recon.totals.missingAmount ? inr(recon.totals.missingAmount) : ''}</div></div>
              <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid #f59e0b', borderRadius: '10px', padding: '12px', textAlign: 'center' }}><div style={{ fontSize: '11px', color: '#fcd34d' }}>ERP entry, statement me nahi</div><b style={{ fontSize: '22px', color: '#f59e0b' }}>{recon.unmatchedErp.length}</b></div>
            </div>
            {stmt.balanceChecks.map((c, i) => (
              <p key={i} style={{ fontSize: '12px', color: c.ok ? '#10b981' : '#ef4444', margin: '4px 0' }}>{c.ok ? '✔' : '✖'} {c.label}: {c.detail}</p>
            ))}
            {stmt.warnings.map((w, i) => <p key={i} style={{ fontSize: '12px', color: '#f59e0b', margin: '4px 0' }}>⚠️ {w}</p>)}

            {recon.totals.swipesMissing > 0 && (
              <div style={{ marginTop: '12px' }}>
                <b style={{ color: '#ef4444', fontSize: '13px' }}>🚨 Statement me swipe hai, ERP me settlement entry NAHI (missed payment ya fraud check karein):</b>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                  {recon.swipes.filter(s => s.status === 'MISSING_IN_ERP').map((s, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', flexWrap: 'wrap' }}>
                      <span>{s.stmt.date} · <b>{s.stmt.description}</b>{s.stmt.vehicle_no ? ` · 🚛 ${s.stmt.vehicle_no}` : ''}</span>
                      <b style={{ color: '#ef4444' }}>{inr(s.stmt.amount)}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {recon.unmatchedErp.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <b style={{ color: '#f59e0b', fontSize: '13px' }}>🟡 ERP me entry hai par statement me nahi mili (galat card/amount/date ho sakta hai):</b>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                  {recon.unmatchedErp.map((u, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', flexWrap: 'wrap' }}>
                      <span>{u.label}</span><b style={{ color: '#f59e0b' }}>{inr(u.amount)}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <BottomSheet open={rechargeSheet} onClose={() => setRechargeSheet(false)} title="💰 Wallet Recharge (Freight Deduction)" accent="#3b82f6" maxWidth={520}>
        <p style={{ color: '#94a3b8', fontSize: '12px', marginTop: 0 }}>Company ne freight bill se jo ~40% advance kaata, woh card wallet me aata hai — yahan darj karein.</p>
        {sheetForm(false)}
      </BottomSheet>
      <BottomSheet open={settleSheet} onClose={() => setSettleSheet(false)} title="🤝 Pump Settlement (Card Swipe)" accent="#10b981" maxWidth={520}>
        <p style={{ color: '#94a3b8', fontSize: '12px', marginTop: 0 }}>Pump ka udhaar bill card swipe se chukaya — pump ka baaki ghatega, card ka balance bhi.</p>
        {sheetForm(true)}
      </BottomSheet>
    </div>
  );
}
