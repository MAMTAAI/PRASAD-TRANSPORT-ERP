// @ts-nocheck
// 💳 FLEET CARD & SETTLEMENT — the real fuel-money loop:
//   pump CREDIT (liability) → CARD SETTLEMENT (swipe clears pump) → WALLET
//   RECHARGE (freight deductions load the card). Plus the Mamta AI reconciler
//   that reads IOCL/HPCL/BPCL statements and catches missed/unknown swipes.
//
// Live PostgreSQL (`fleet_cards` / `card_transactions`, migration 030).
//
// THE BALANCE IS DERIVED NOW. The old version kept `current_balance` on the
// card and moved it with increment() in the same batch as the transaction, and
// posted the double entry separately through the Firestore journal helper. Two
// records of one rupee, maintained by two different mechanisms — the wallet
// could disagree with both its own transactions and the ledger. `card_balance`
// below comes from v_fleet_card_balance: opening + loads − spends, recomputed
// on every read, so it cannot drift.
//
// The VOUCHER is now posted by the API through TARA, in the same request that
// writes the transaction — not by this screen afterwards, where a failed
// journal used to leave the money recorded and the books untouched.
import FleetCardSettlement from './mastercontrol/FleetCardSettlement';
import React, { useState, useEffect, useMemo } from 'react';
import { API_BASE } from './lib/apiBase';
const API_ROOT = API_BASE;
const TOLL_API = `${API_ROOT}/api/v1/toll`;
const MASTERS_API = `${API_ROOT}/api/v1/masters`;
const apiFetch = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
const mastersFetch = (path: string, opts?: RequestInit) => apiFetch(`${MASTERS_API}${path}`, opts);

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
      const [cardsRes, vendorsRes, custRes] = await Promise.all([
        apiFetch(`${TOLL_API}/cards`),
        mastersFetch('/vendors?limit=1000').catch(() => ({ vendors: [] })),
        mastersFetch('/customers?limit=1000').catch(() => ({ customers: [] })),
      ]);
      // The three provider wallets are seeded on first run, same as before, but
      // through the API so the row lands in the table the balance view reads.
      let list = cardsRes.cards ?? [];
      if (!list.length) {
        for (const [key, meta] of Object.entries(CARD_PROVIDERS)) {
          await apiFetch(`${TOLL_API}/cards`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: meta.name, provider: key, opening_balance: 0 }),
          }).catch(() => {});
        }
        list = (await apiFetch(`${TOLL_API}/cards`)).cards ?? [];
      }
      setCards(list);

      // Transactions for every card, newest first. Small volumes; one request
      // per card keeps the endpoint simple and the list is card-scoped anyway.
      const perCard = await Promise.all(
        list.map((c: any) => apiFetch(`${TOLL_API}/cards/${c.id}/txns`)
          .then(r => (r.transactions ?? []).map((t: any) => ({ ...t, type: t.txn_type, date: t.txn_date })))
          .catch(() => [])));
      setTxns(perCard.flat().sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))));

      // running_balance is the DERIVED figure (opening + vendor_txns); the raw
      // current_balance column is the frozen migration-time marker. The picker
      // must show the live one or it quotes a stale payable back at the operator.
      setVendors((vendorsRes.vendors ?? [])
        .filter((v: any) => v.vendor_name)
        .map((v: any) => ({ ...v, current_balance: v.running_balance ?? v.current_balance ?? '0' })));
      setCustomers(custRes.customers ?? []);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const cardById = (id) => cards.find(c => c.id === id);
  const openSheet = (which) => {
    setForm({ card_id: cards[0]?.id || '', amount: '', party: '', date: today(), ref: '' });
    which === 'RECHARGE' ? setRechargeSheet(true) : setSettleSheet(true);
  };

  // 💰 RECHARGE: freight deduction (~40% advance cut from the bill) loads the
  // wallet. funded_by=DEDUCTION tells the API this is Dr wallet / Cr the
  // customer's receivable — no bank account moves, because none did.
  const saveRecharge = async () => {
    const amt = round2(parseFloat(form.amount));
    const card = cardById(form.card_id);
    if (!card || !Number.isFinite(amt) || amt <= 0) return alert('⚠️ Card aur sahi amount chunein!');
    if (!form.party) return alert('🏢 Kis customer ki freight deduction se recharge hua? Party chunein — uska receivable isi se ghatta hai.');
    setSaving(true);
    try {
      const j = await apiFetch(`${TOLL_API}/cards/${card.id}/txns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_type: 'LOAD', funded_by: 'DEDUCTION',
          amount: amt, txn_date: form.date, party: form.party,
          ref: form.ref || null,
          narration: `Freight deduction recharge — ${form.party}${form.ref ? ` (${form.ref})` : ''}`,
          created_by: (JSON.parse(localStorage.getItem('prasad_user') || '{}').email) || null,
        }),
      });
      alert(`✅ ${card.name} me ${inr(amt)} recharge darj!` + (j.ledger_note ? `\n\n⚠️ Ledger: ${j.ledger_note}` : ''));
      setRechargeSheet(false); fetchAll();
    } catch (e: any) {
      const said = { DUPLICATE: 'Yeh reference pehle hi darj ho chuka hai.', DUPLICATE_REF: 'Yeh reference pehle hi post ho chuka hai.' }[e?.code];
      console.error(e); alert('❌ Save nahi hua: ' + (said || e?.message || 'error'));
    }
    setSaving(false);
  };

  // 🤝 SETTLEMENT: card swipe clears the pump's credit (liability)
  //
  // ONE request now does all three things the old version did in three places:
  // it writes the card transaction, posts the JOURNAL (Dr Creditors: pump /
  // Cr card wallet) through TARA, and returns the recomputed wallet balance.
  // Before, the transaction went into a Firestore batch, the balance was
  // increment()ed alongside it, and the journal was posted afterwards over the
  // network — so a failed journal left the money spent and the books silent,
  // and the alert said "data save hai" as if that were fine.
  const saveSettlement = async () => {
    const amt = round2(parseFloat(form.amount));
    const card = cardById(form.card_id);
    const vendor = vendors.find(v => v.id === form.party);
    if (!card || !vendor || !Number.isFinite(amt) || amt <= 0) return alert('⚠️ Card, pump aur sahi amount chunein!');
    const bal = round2(parseFloat(card.current_balance) || 0);
    if (amt > bal && !window.confirm(`⚠️ Card balance ${inr(bal)} se zyada settlement (${inr(amt)}). Phir bhi darj karein?`)) { return; }
    const vName = vendor.vendor_name;
    setSaving(true);
    try {
      const j = await apiFetch(`${TOLL_API}/cards/${card.id}/txns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_type: 'SETTLEMENT',
          amount: amt,
          txn_date: form.date,
          party: vName,
          vendor_id: vendor.id,
          ref: form.ref || null,
          narration: `Pump bill settled by card swipe — ${vName}${form.ref ? ` (${form.ref})` : ''}`,
          created_by: (JSON.parse(localStorage.getItem('prasad_user') || '{}').email) || null,
        }),
      });

      // The pump's own subsidiary khata still needs the row. post_to_ledger is
      // false because the JOURNAL above already cleared the creditor — posting
      // again here would double-count the payment.
      await mastersFetch(`/vendors/${vendor.id}/ledger`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_type: 'PAYMENT_GIVEN', amount: amt, txn_date: form.date,
          payment_mode: `Fleet card — ${card.name}`,
          remarks: `Card settlement${form.ref ? ' ' + form.ref : ''}`,
          post_to_ledger: false,
        }),
      }).catch(e => console.error('vendor khata:', e));

      alert(`✅ ${vName} ka ${inr(amt)} card se settle!` + (j.ledger_note ? `

⚠️ Ledger: ${j.ledger_note}` : ''));
      setSettleSheet(false); fetchAll();
    } catch (e: any) {
      const said = {
        DUPLICATE: 'Yeh reference pehle hi darj ho chuka hai.',
        DUPLICATE_REF: 'Yeh reference pehle hi post ho chuka hai.',
        NO_PARTY: 'Pump chunein.',
      }[e?.code];
      console.error(e); alert('❌ Save nahi hua: ' + (said || e?.message || 'error'));
    }
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
    page: { padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #121c38, #0a1024)', color: 'white', fontFamily: "'Inter', sans-serif" },
    card: { background: 'rgba(24, 36, 74,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px', padding: 'clamp(14px,3vw,25px)', marginBottom: '18px' },
    input: { background: 'rgba(18, 28, 56,0.7)', border: '1px solid #27395f', borderRadius: '10px', color: 'white', padding: '12px', width: '100%', boxSizing: 'border-box', outline: 'none', minHeight: '44px', colorScheme: 'dark' },
    btn: (bg, dis) => ({ background: dis ? '#3d548a' : bg, color: 'white', border: 'none', borderRadius: '10px', padding: '14px 20px', fontWeight: 'bold', cursor: dis ? 'default' : 'pointer', minHeight: '48px', fontSize: '15px' }),
    label: { display: 'block', fontSize: '12px', color: '#9aadd4', fontWeight: 'bold', margin: '12px 0 6px' },
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
      <button onClick={isSettle ? saveSettlement : saveRecharge} disabled={saving} style={{ ...S.btn(isSettle ? '#2fe39b' : '#3b82f6', saving), width: '100%', marginTop: '18px' }}>
        {saving ? '⌛ Saving…' : isSettle ? '🤝 Pump Settle Karo (Card Swipe)' : '💰 Wallet Recharge Darj Karo'}
      </button>
    </div>
  );

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 'clamp(20px,5vw,30px)', margin: '0 0 4px 0', color: '#22d3ee' }}>💳 Fleet Card & Settlement</h1>
      <p style={{ color: '#9aadd4', margin: '0 0 18px 0', fontSize: '13px' }}>Oil company ke statement, unka milan, aur jo abhi clearing me pada hai.</p>

      {/* ── THE LIVE STATEMENT DESK ──────────────────────────────────────────
          Everything below this block is the older MANUAL card book: wallet
          balances someone typed in, and the Mamta AI statement reader. It is
          kept because it is still the only way to record a recharge by hand,
          but it is not where the money is any more — the imported statements
          are, and they lead. */}
      <FleetCardSettlement />

      <div style={{ height: '28px' }} />
      <div style={{ borderTop: '1px solid #27395f', paddingTop: '18px', marginBottom: '14px' }}>
        <b style={{ color: '#9aadd4', fontSize: '13px', letterSpacing: '0.08em' }}>MANUAL CARD BOOK &amp; AI READER</b>
        <p style={{ color: '#5d7196', fontSize: '12px', margin: '4px 0 0' }}>
          Haath se darj ki gayi wallet entries. Upar wala hissa oil company ke asli statement se aata hai.
        </p>
      </div>

      {/* Wallets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '14px', marginBottom: '18px' }}>
        {cards.map(c => (
          <div key={c.id} style={{ ...S.card, marginBottom: 0, borderLeft: `5px solid ${CARD_PROVIDERS[c.provider]?.color || '#22d3ee'}` }}>
            <div style={{ fontSize: '13px', color: '#9aadd4', fontWeight: 'bold' }}>{c.name}</div>
            <div style={{ fontSize: 'clamp(22px, 5vw, 30px)', fontWeight: 900, color: (parseFloat(c.current_balance) || 0) < 0 ? '#ff6b81' : '#2fe39b' }}>{inr(c.current_balance)}</div>
          </div>
        ))}
        <div style={{ ...S.card, marginBottom: 0, borderLeft: '5px solid #8b5cf6', background: 'rgba(139,92,246,0.08)' }}>
          <div style={{ fontSize: '13px', color: '#c4b5fd', fontWeight: 'bold' }}>Total Wallet Balance</div>
          <div style={{ fontSize: 'clamp(22px, 5vw, 30px)', fontWeight: 900, color: '#a78bfa' }}>{inr(totalWallet)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' }}>
        <button onClick={() => openSheet('RECHARGE')} style={{ ...S.btn('#3b82f6', false), flex: isMobile ? 1 : 'none' }}>💰 Recharge (Freight Deduction)</button>
        <button onClick={() => openSheet('SETTLE')} style={{ ...S.btn('#2fe39b', false), flex: isMobile ? 1 : 'none' }}>🤝 Pump Settlement (Card Swipe)</button>
      </div>

      {/* Transactions */}
      <div style={S.card}>
        <b style={{ color: '#22d3ee' }}>📒 Card Transactions</b>
        {loading ? <p style={{ color: '#5d7196' }}>Loading…</p> : txns.length === 0 ? <p style={{ color: '#5d7196', fontSize: '13px' }}>Abhi koi entry nahi. Upar ke buttons se recharge/settlement darj karein.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {txns.slice(0, 30).map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(18, 28, 56,0.6)', border: '1px solid #18244a', borderRadius: '10px', padding: '10px 14px', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <b style={{ fontSize: '13px', color: t.type === 'RECHARGE' ? '#3b82f6' : '#2fe39b' }}>{t.type === 'RECHARGE' ? '💰 Recharge' : '🤝 Settlement'}</b>
                  <span style={{ fontSize: '12px', color: '#9aadd4', marginLeft: '8px' }}>{t.party || CARD_PROVIDERS[t.provider]?.name}</span>
                  <div style={{ fontSize: '11px', color: '#5d7196' }}>{toISODate(t.date)} · {CARD_PROVIDERS[t.provider]?.name}{t.ref ? ` · ${t.ref}` : ''}</div>
                </div>
                <b style={{ color: t.type === 'RECHARGE' ? '#3b82f6' : '#ffb224', whiteSpace: 'nowrap' }}>{t.type === 'RECHARGE' ? '+' : '−'}{inr(t.amount)}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 🤖 AI Reconciler */}
      <div style={{ ...S.card, border: '1px solid #8b5cf6' }}>
        <b style={{ color: '#a78bfa', fontSize: '15px' }}>🤖 Mamta AI — Statement Reconciler</b>
        <p style={{ color: '#9aadd4', fontSize: '12px', margin: '6px 0 12px' }}>IOCL / HPCL / BPCL ka monthly statement PDF daalein — Mamta AI har swipe ko aapki settlement entries se milayegi aur missing/unknown swipe pakdegi.</p>
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
          }} style={{ color: '#9aadd4', flex: 1, minWidth: '200px' }} />
          <button onClick={runRecon} disabled={reconBusy} style={S.btn('#8b5cf6', reconBusy)}>{reconBusy ? '⌛ Padh rahi hai…' : '🔍 Reconcile'}</button>
        </div>
        {reconFile && !reconBusy && <p style={{ fontSize: '12px', color: '#2fe39b', marginTop: '8px' }}>📎 {reconFile.name}</p>}
        {reconProgress && <p style={{ fontSize: '13px', color: '#a78bfa', marginTop: '10px' }}>{reconProgress}</p>}

        {stmt && recon && (
          <div style={{ marginTop: '18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: '10px', marginBottom: '14px' }}>
              <div style={{ background: 'rgba(47, 227, 155,0.1)', border: '1px solid #2fe39b', borderRadius: '10px', padding: '12px', textAlign: 'center' }}><div style={{ fontSize: '11px', color: '#6ee7b7' }}>Swipes Matched</div><b style={{ fontSize: '22px', color: '#2fe39b' }}>{recon.totals.swipesMatched}</b></div>
              <div style={{ background: recon.totals.swipesMissing ? 'rgba(255, 107, 129,0.1)' : 'rgba(255,255,255,0.04)', border: `1px solid ${recon.totals.swipesMissing ? '#ff6b81' : '#27395f'}`, borderRadius: '10px', padding: '12px', textAlign: 'center' }}><div style={{ fontSize: '11px', color: '#fca5a5' }}>⚠️ ERP me Missing</div><b style={{ fontSize: '22px', color: recon.totals.swipesMissing ? '#ff6b81' : '#5d7196' }}>{recon.totals.swipesMissing}</b><div style={{ fontSize: '11px', color: '#fca5a5' }}>{recon.totals.missingAmount ? inr(recon.totals.missingAmount) : ''}</div></div>
              <div style={{ background: 'rgba(255, 178, 36,0.08)', border: '1px solid #ffb224', borderRadius: '10px', padding: '12px', textAlign: 'center' }}><div style={{ fontSize: '11px', color: '#fcd34d' }}>ERP entry, statement me nahi</div><b style={{ fontSize: '22px', color: '#ffb224' }}>{recon.unmatchedErp.length}</b></div>
            </div>
            {stmt.balanceChecks.map((c, i) => (
              <p key={i} style={{ fontSize: '12px', color: c.ok ? '#2fe39b' : '#ff6b81', margin: '4px 0' }}>{c.ok ? '✔' : '✖'} {c.label}: {c.detail}</p>
            ))}
            {stmt.warnings.map((w, i) => <p key={i} style={{ fontSize: '12px', color: '#ffb224', margin: '4px 0' }}>⚠️ {w}</p>)}

            {recon.totals.swipesMissing > 0 && (
              <div style={{ marginTop: '12px' }}>
                <b style={{ color: '#ff6b81', fontSize: '13px' }}>🚨 Statement me swipe hai, ERP me settlement entry NAHI (missed payment ya fraud check karein):</b>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                  {recon.swipes.filter(s => s.status === 'MISSING_IN_ERP').map((s, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', background: 'rgba(255, 107, 129,0.08)', border: '1px solid rgba(255, 107, 129,0.4)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', flexWrap: 'wrap' }}>
                      <span>{s.stmt.date} · <b>{s.stmt.description}</b>{s.stmt.vehicle_no ? ` · 🚛 ${s.stmt.vehicle_no}` : ''}</span>
                      <b style={{ color: '#ff6b81' }}>{inr(s.stmt.amount)}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {recon.unmatchedErp.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <b style={{ color: '#ffb224', fontSize: '13px' }}>🟡 ERP me entry hai par statement me nahi mili (galat card/amount/date ho sakta hai):</b>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                  {recon.unmatchedErp.map((u, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', background: 'rgba(255, 178, 36,0.06)', border: '1px solid rgba(255, 178, 36,0.35)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', flexWrap: 'wrap' }}>
                      <span>{u.label}</span><b style={{ color: '#ffb224' }}>{inr(u.amount)}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <BottomSheet open={rechargeSheet} onClose={() => setRechargeSheet(false)} title="💰 Wallet Recharge (Freight Deduction)" accent="#3b82f6" maxWidth={520}>
        <p style={{ color: '#9aadd4', fontSize: '12px', marginTop: 0 }}>Company ne freight bill se jo ~40% advance kaata, woh card wallet me aata hai — yahan darj karein.</p>
        {sheetForm(false)}
      </BottomSheet>
      <BottomSheet open={settleSheet} onClose={() => setSettleSheet(false)} title="🤝 Pump Settlement (Card Swipe)" accent="#2fe39b" maxWidth={520}>
        <p style={{ color: '#9aadd4', fontSize: '12px', marginTop: 0 }}>Pump ka udhaar bill card swipe se chukaya — pump ka baaki ghatega, card ka balance bhi.</p>
        {sheetForm(true)}
      </BottomSheet>
    </div>
  );
}
