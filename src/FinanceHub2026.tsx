// 💠 FINANCE HUB 2026 — Unified Party Ledger Hub + Smart Voucher Modal
// Fully bound to the live PostgreSQL finance API (zero Firestore, zero fake data).
//
//   Voucher modal  glassmorphic, color-coded tabs (Emerald RECEIPT · Ruby
//                  PAYMENT · Sapphire CONTRA), predictive party search with
//                  category badges + live balances, driver/vendor auto-context,
//                  magic narration, deterministic TDS/GST panel, and TARA's
//                  server-side guards surfaced inline (overdraft, duplicate ref).
//   Ledger hub     live-balance table, statement drawer, WhatsApp statement,
//                  print/PDF via the browser.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const FIN = `${API}/api/v1/finance`;

const C = {
  bg: '#0f172a', line: '#334155', dim: '#94a3b8', text: '#e2e8f0',
  emerald: '#10b981', ruby: '#f43f5e', sapphire: '#38bdf8', purple: '#c084fc', warn: '#f59e0b',
};
const TABS = [
  { key: 'RECEIPT', label: '↓ RECEIVE', color: C.emerald, hint: 'Money IN — customer payment, advance return' },
  { key: 'PAYMENT', label: '↑ PAY', color: C.ruby, hint: 'Money OUT — vendor, driver advance, expense' },
  { key: 'CONTRA', label: '⇄ TRANSFER', color: C.sapphire, hint: 'Bank ↔ Cash / Bank ↔ Bank' },
] as const;

const glass: React.CSSProperties = {
  background: 'rgba(30,41,59,0.72)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid rgba(148,163,184,0.25)', borderRadius: 20,
};
const inp: React.CSSProperties = {
  width: '100%', padding: '11px 12px', background: 'rgba(15,23,42,0.85)', color: C.text,
  border: `1px solid ${C.line}`, borderRadius: 10, outline: 'none', fontSize: 13, boxSizing: 'border-box',
};
const kindColor: Record<string, string> = { CUSTOMER: C.emerald, VENDOR: C.warn, DRIVER: C.sapphire, ACCOUNT: C.purple };

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error, body: json });
  return json;
};

// ═══════════════════════════════════════════════════════════════════════════
// Smart Voucher Modal
// ═══════════════════════════════════════════════════════════════════════════
export function VoucherModal2026({ onClose, onPosted }: { onClose: () => void; onPosted?: () => void }) {
  const [tab, setTab] = useState<'RECEIPT' | 'PAYMENT' | 'CONTRA'>('RECEIPT');
  const theme = TABS.find((t) => t.key === tab)!;

  // party search
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [party, setParty] = useState<any>(null);
  const [ctx, setCtx] = useState<any>(null);
  const debounce = useRef<any>(null);

  // accounts + form
  const [accounts, setAccounts] = useState<any[]>([]);
  const [account, setAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [refNo, setRefNo] = useState('');
  const [narration, setNarration] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));

  // tax
  const [tdsSection, setTdsSection] = useState<'none' | '194C' | '194Q'>('none');
  const [deducteeType, setDeducteeType] = useState<'COMPANY' | 'INDIVIDUAL'>('COMPANY');
  const [transporterDecl, setTransporterDecl] = useState(false);
  const [gtaRcm, setGtaRcm] = useState(false);
  const [tax, setTax] = useState<any>(null);

  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetchJson(`${FIN}/accounts`).then((j) => {
      setAccounts(j.accounts);
      if (j.accounts[0]) setAccount(j.accounts[0].ledger_name);
    }).catch(() => setVerdict({ kind: 'err', text: 'Finance API unreachable — is npm run api running?' }));
  }, []);

  // predictive search (250ms debounce)
  useEffect(() => {
    if (!q || q.length < 2 || party) { setHits([]); return; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      fetchJson(`${FIN}/parties/search?q=${encodeURIComponent(q)}`).then((j) => setHits(j.results)).catch(() => {});
    }, 250);
  }, [q, party]);

  const pickParty = async (p: any) => {
    setParty(p); setQ(p.name); setHits([]);
    setCtx(null);
    if (p.kind !== 'ACCOUNT') {
      try { setCtx(await fetchJson(`${FIN}/party-context?kind=${p.kind}&id=${p.id}`)); } catch { /* context optional */ }
    }
  };

  // live tax preview
  useEffect(() => {
    const amt = Number(amount);
    if (tab !== 'PAYMENT' || !amt || (tdsSection === 'none' && !gtaRcm)) { setTax(null); return; }
    const u = new URLSearchParams({
      amount: String(amt), section: tdsSection, deductee_type: deducteeType,
      transporter_declaration: String(transporterDecl), gta_rcm: String(gtaRcm),
    });
    fetchJson(`${FIN}/tax/preview?${u}`).then(setTax).catch(() => setTax(null));
  }, [tab, amount, tdsSection, deducteeType, transporterDecl, gtaRcm]);

  const partyLedger = useMemo(() => {
    if (!party) return '';
    if (party.kind === 'CUSTOMER') return `Debtors: ${party.name}`;
    if (party.kind === 'VENDOR') return `Creditors: ${party.name}`;
    if (party.kind === 'DRIVER') return `Driver Advance: ${party.name}`;
    return party.name;
  }, [party]);

  // ── Magic narration — deterministic template, zero typing ────────────────
  const magicNarration = () => {
    const amt = Number(amount) ? `₹${Number(amount).toLocaleString('en-IN')}` : 'amount';
    const via = /cash/i.test(account) ? 'in cash' : `via ${account}`;
    let text = '';
    if (tab === 'RECEIPT') {
      text = `Being ${amt} received from ${party?.name ?? 'party'} ${via}` +
        (ctx?.current_outstanding ? ` against outstanding of ₹${Number(ctx.current_outstanding).toLocaleString('en-IN')}` : '') +
        (refNo ? ` (Ref: ${refNo})` : '');
    } else if (tab === 'PAYMENT') {
      const trip = ctx?.active_trip ? ` for Trip #${ctx.active_trip.trip_code ?? ctx.active_trip.id?.slice(0, 6)} (${ctx.active_trip.vehicle_no})` : '';
      const kind = party?.kind === 'DRIVER' ? 'driver advance' : party?.kind === 'VENDOR' ? 'payment against dues' : 'payment';
      text = `Being ${kind} of ${amt} paid to ${party?.name ?? 'party'}${trip} ${via}` +
        (tax?.tds ? ` less TDS ${tax.tds.section} ₹${tax.tds.amount}` : '') +
        (refNo ? ` (Ref: ${refNo})` : '');
    } else {
      text = `Being ${amt} transferred from ${account} to ${toAccount}${refNo ? ` (Ref: ${refNo})` : ''}`;
    }
    setNarration(text);
  };

  const submit = async (dryRun: boolean) => {
    setBusy(true); setVerdict(null);
    try {
      const body: any = {
        type: tab, account, amount: Number(amount),
        ref_no: refNo || null, narration: narration || null, entry_date: entryDate,
        created_by: localStorage.getItem('pt_user_name') ?? 'ADMIN', dry_run: dryRun,
      };
      if (tab === 'CONTRA') body.to_account = toAccount;
      else { body.party_ledger = partyLedger; body.party_group = party?.ledger_group; }
      if (tab === 'PAYMENT' && tax?.tds) body.tds = { ledger: tax.tds.ledger, amount: Number(tax.tds.amount) };

      const out = await fetchJson(`${FIN}/vouchers`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (out.posted) {
        setVerdict({ kind: 'ok', text: `✔ POSTED — balanced voucher ${out.voucher_id.slice(0, 8)} (${out.lines.length} lines, DB-verified ΣDr=ΣCr)` });
        onPosted?.();
      } else {
        setVerdict({ kind: 'ok', text: `✔ DRY RUN OK — would post ${out.lines.length} balanced lines. Nothing committed.` });
      }
    } catch (e: any) {
      const extra = e.code === 'OVERDRAFT' ? ` (available: ₹${e.body?.balance})` : '';
      setVerdict({ kind: 'err', text: `✖ TARA blocked: ${e.message}${extra}` });
    } finally { setBusy(false); }
  };

  const ready = Number(amount) > 0 && account && (tab === 'CONTRA' ? toAccount && toAccount !== account : !!party);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.75)', backdropFilter: 'blur(3px)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      onClick={onClose}>
      <div style={{ ...glass, width: 'min(680px, 96vw)', maxHeight: '94vh', overflowY: 'auto', padding: 22, boxShadow: `0 0 60px ${theme.color}33` }}
        onClick={(e) => e.stopPropagation()}>

        {/* tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key as any); setVerdict(null); }}
              style={{
                flex: 1, padding: '12px 0', fontSize: 13, fontWeight: 800, cursor: 'pointer', borderRadius: 12,
                border: `1.5px solid ${tab === t.key ? t.color : C.line}`,
                background: tab === t.key ? `${t.color}22` : 'transparent',
                color: tab === t.key ? t.color : C.dim,
                boxShadow: tab === t.key ? `0 0 18px ${t.color}44` : 'none',
                transform: tab === t.key ? 'translateY(-1px)' : 'none', transition: 'all .18s',
              }}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 14 }}>{theme.hint} · posted by AGENT_02 TARA · ΣDr=ΣCr enforced by PostgreSQL at COMMIT</div>

        {/* party search */}
        {tab !== 'CONTRA' && (
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: C.dim }}>BENEFICIARY / PARTY — search clients · vendors · drivers · pumps</label>
            <input style={{ ...inp, borderColor: party ? theme.color : C.line }} value={q}
              placeholder="Type 2+ letters… e.g. 'krishna', 'IOCL', 'jahir'"
              onChange={(e) => { setQ(e.target.value); setParty(null); setCtx(null); }} />
            {hits.length > 0 && (
              <div style={{ ...glass, position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, marginTop: 4, padding: 6, maxHeight: 260, overflowY: 'auto' }}>
                {hits.map((h) => (
                  <div key={h.kind + h.id} onClick={() => pickParty(h)}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: C.text }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(148,163,184,0.12)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    <span>
                      <span style={{ fontSize: 9.5, fontWeight: 800, color: kindColor[h.kind], border: `1px solid ${kindColor[h.kind]}`, borderRadius: 8, padding: '1px 6px', marginRight: 8 }}>{h.kind}</span>
                      {h.name}
                    </span>
                    <span style={{ color: Number(h.balance) ? C.warn : C.dim, whiteSpace: 'nowrap' }}>
                      ₹{Number(h.balance).toLocaleString('en-IN')} {h.balance_side === 'CR' ? 'Cr' : 'Dr'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* auto-context panel */}
        {ctx && (
          <div style={{ background: 'rgba(15,23,42,0.7)', border: `1px dashed ${theme.color}66`, borderRadius: 12, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: C.text }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: theme.color, letterSpacing: 1, marginBottom: 4 }}>⚡ AUTO-CONTEXT</div>
            {ctx.kind === 'DRIVER' && (<>
              <div>Active trip: {ctx.active_trip ? `${ctx.active_trip.trip_code ?? '—'} · ${ctx.active_trip.vehicle_no} · ${ctx.active_trip.status}` : 'none'}</div>
              <div>Pending advance: <b style={{ color: C.warn }}>₹{Number(ctx.pending_advance).toLocaleString('en-IN')}</b>
                {Number(ctx.pending_advance) > 0 &&
                  <button onClick={() => setAmount(String(Math.abs(Number(ctx.pending_advance))))}
                    style={{ marginLeft: 8, fontSize: 10, padding: '2px 8px', background: 'transparent', color: theme.color, border: `1px solid ${theme.color}`, borderRadius: 8, cursor: 'pointer' }}>
                    1-CLICK SETTLE →
                  </button>}
              </div>
              <div>Unsettled fuel slips: {ctx.unsettled_fuel_slips?.length ?? 0}
                {(ctx.unsettled_fuel_slips ?? []).slice(0, 2).map((f: any) =>
                  <span key={f.id} style={{ color: C.dim }}> · {f.memo_no ?? f.id.slice(0, 6)} ₹{f.amount}</span>)}
              </div>
            </>)}
            {ctx.kind === 'VENDOR' && (<>
              <div>Payable balance: <b style={{ color: C.warn }}>₹{Number(ctx.current_balance).toLocaleString('en-IN')} Cr</b>
                {Number(ctx.current_balance) > 0 &&
                  <button onClick={() => setAmount(String(Number(ctx.current_balance)))}
                    style={{ marginLeft: 8, fontSize: 10, padding: '2px 8px', background: 'transparent', color: theme.color, border: `1px solid ${theme.color}`, borderRadius: 8, cursor: 'pointer' }}>
                    1-CLICK SETTLE →
                  </button>}
              </div>
              <div>Unsettled fuel: ₹{Number(ctx.unsettled_fuel?.unbilled ?? 0).toLocaleString('en-IN')} across {ctx.unsettled_fuel?.slips ?? 0} slips</div>
              {ctx.warnings?.map((w: string) => <div key={w} style={{ color: C.ruby }}>⚠ {w}</div>)}
            </>)}
            {ctx.kind === 'CUSTOMER' && (<>
              <div>Outstanding: <b style={{ color: C.warn }}>₹{Number(ctx.current_outstanding).toLocaleString('en-IN')}</b> · Completed unsettled trips: {ctx.unsettled_trips}</div>
            </>)}
          </div>
        )}

        {/* accounts + amount row */}
        <div style={{ display: 'grid', gridTemplateColumns: tab === 'CONTRA' ? '1fr 1fr' : '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: C.dim }}>{tab === 'RECEIPT' ? 'INTO ACCOUNT' : 'FROM ACCOUNT'}</label>
            <select style={inp} value={account} onChange={(e) => setAccount(e.target.value)}>
              {accounts.map((a) => <option key={a.ledger_name} value={a.ledger_name}>{a.ledger_name} — ₹{Number(a.balance).toLocaleString('en-IN')}</option>)}
            </select>
          </div>
          {tab === 'CONTRA' ? (
            <div>
              <label style={{ fontSize: 11, color: C.dim }}>TO ACCOUNT</label>
              <select style={inp} value={toAccount} onChange={(e) => setToAccount(e.target.value)}>
                <option value="">— select —</option>
                {accounts.filter((a) => a.ledger_name !== account).map((a) => <option key={a.ledger_name} value={a.ledger_name}>{a.ledger_name} — ₹{Number(a.balance).toLocaleString('en-IN')}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <label style={{ fontSize: 11, color: C.dim }}>DATE</label>
              <input type="date" style={inp} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: C.dim }}>AMOUNT (₹)</label>
            <input type="number" min="1" style={{ ...inp, fontSize: 17, fontWeight: 800, color: theme.color }} value={amount}
              placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: C.dim }}>REF / CHEQUE / UTR (duplicate-checked)</label>
            <input style={inp} value={refNo} placeholder="optional" onChange={(e) => setRefNo(e.target.value)} />
          </div>
        </div>

        {/* tax panel */}
        {tab === 'PAYMENT' && (
          <div style={{ background: 'rgba(15,23,42,0.7)', border: `1px solid ${C.line}`, borderRadius: 12, padding: '10px 12px', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.purple, letterSpacing: 1, marginBottom: 6 }}>🧮 TDS / GST ENGINE (deterministic — no manual tax math)</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: C.text, alignItems: 'center' }}>
              <select style={{ ...inp, width: 'auto', padding: '6px 8px' }} value={tdsSection} onChange={(e) => setTdsSection(e.target.value as any)}>
                <option value="none">No TDS</option><option value="194C">194C (contractor/freight)</option><option value="194Q">194Q (goods purchase)</option>
              </select>
              <select style={{ ...inp, width: 'auto', padding: '6px 8px' }} value={deducteeType} onChange={(e) => setDeducteeType(e.target.value as any)}>
                <option value="COMPANY">Company/Firm</option><option value="INDIVIDUAL">Individual/HUF</option>
              </select>
              <label style={{ color: C.dim }}><input type="checkbox" checked={transporterDecl} onChange={(e) => setTransporterDecl(e.target.checked)} /> 194C(6) transporter decl.</label>
              <label style={{ color: C.dim }}><input type="checkbox" checked={gtaRcm} onChange={(e) => setGtaRcm(e.target.checked)} /> GTA RCM 5%</label>
            </div>
            {tax?.tds && (
              <div style={{ marginTop: 8, fontSize: 12, color: C.text }}>
                TDS {tax.tds.section} @ {tax.tds.pct}% = <b style={{ color: C.ruby }}>₹{tax.tds.amount}</b>
                {' '}→ net payable <b style={{ color: C.emerald }}>₹{tax.tds.net_payable}</b>
                <span style={{ color: C.dim }}> · {tax.tds.basis} · booked to "{tax.tds.ledger}"</span>
              </div>
            )}
            {tax?.gst_rcm && <div style={{ marginTop: 4, fontSize: 11.5, color: C.warn }}>GST RCM 5% memo: ₹{tax.gst_rcm.amount} — {tax.gst_rcm.note}</div>}
            {(tax?.notes ?? []).map((n: string) => <div key={n} style={{ marginTop: 4, fontSize: 11, color: C.dim }}>ℹ {n}</div>)}
          </div>
        )}

        {/* narration */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: C.dim, display: 'flex', justifyContent: 'space-between' }}>
            NARRATION
            <button onClick={magicNarration} disabled={!ready}
              style={{ fontSize: 10, fontWeight: 800, padding: '2px 10px', background: 'transparent', color: C.purple, border: `1px solid ${C.purple}`, borderRadius: 8, cursor: 'pointer' }}>
              ✨ MAGIC AUTO-FILL
            </button>
          </label>
          <textarea style={{ ...inp, minHeight: 54, resize: 'vertical' }} value={narration}
            placeholder='e.g. "Being freight advance paid for Trip #PT00689 via SBI (8490)"'
            onChange={(e) => setNarration(e.target.value)} />
        </div>

        {verdict && (
          <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 600,
            border: `1px solid ${verdict.kind === 'ok' ? C.emerald : C.ruby}`, color: verdict.kind === 'ok' ? C.emerald : C.ruby,
            background: verdict.kind === 'ok' ? 'rgba(16,185,129,0.08)' : 'rgba(244,63,94,0.08)' }}>
            {verdict.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button disabled={!ready || busy} onClick={() => submit(true)}
            style={{ padding: '13px 18px', fontSize: 12, fontWeight: 800, background: 'transparent', color: C.dim, border: `1px solid ${C.line}`, borderRadius: 12, cursor: 'pointer' }}>
            🧪 DRY RUN
          </button>
          <button disabled={!ready || busy} onClick={() => submit(false)}
            style={{ flex: 1, padding: '13px 0', fontSize: 14, fontWeight: 900, letterSpacing: 0.5, cursor: ready ? 'pointer' : 'not-allowed',
              background: ready ? theme.color : C.line, color: '#0f172a', border: 'none', borderRadius: 12,
              boxShadow: ready ? `0 0 22px ${theme.color}55` : 'none', transition: 'all .2s' }}>
            {busy ? '⏳ TARA VALIDATING…' : `POST ${tab} VOUCHER`}
          </button>
          <button onClick={onClose}
            style={{ padding: '13px 16px', background: 'transparent', color: C.dim, border: `1px solid ${C.line}`, borderRadius: 12, cursor: 'pointer' }}>✕</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Party Ledger Hub
// ═══════════════════════════════════════════════════════════════════════════
export default function FinanceHub2026() {
  const [rows, setRows] = useState<any[]>([]);
  const [tally, setTally] = useState<any>(null);
  useEffect(() => {
    const pull = () => fetchJson(`${API}/api/v1/tally/health`).then(setTally).catch(() => setTally({ up: false }));
    pull(); const t = setInterval(pull, 30000); return () => clearInterval(t);
  }, []);
  const masterCheck = async () => {
    try {
      const j = await fetchJson(`${API}/api/v1/tally/master-check`);
      const missing = j.missing_in_tally;
      alert(missing.length
        ? ['⚠ ' + missing.length + ' party ledgers missing in Tally:', '', ...missing.slice(0, 15), missing.length > 15 ? '…' : '', '', j.note].join('\n')
        : `✔ All ${j.our_party_ledgers} party ledgers exist in Tally (${j.tally_ledgers} total there).`);
    } catch (e: any) { alert(`Tally master check failed: ${e.message}`); }
  };
  const [q, setQ] = useState('');
  const [drawer, setDrawer] = useState<any>(null);   // { ledger, statement }
  const [modal, setModal] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetchJson(`${FIN}/ledgers?limit=150${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      setRows(j.data); setErr(null);
    } catch (e: any) { setErr(`Finance API unreachable at ${API} (${e.message})`); }
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const openDrawer = async (name: string) => {
    setDrawer({ ledger: name, statement: null });
    try {
      const statement = await fetchJson(`${FIN}/ledgers/statement?name=${encodeURIComponent(name)}`);
      // Tally badges for the voucher-era rows, one round trip.
      const vids = [...new Set(statement.entries.filter((e: any) => e.voucher_id).map((e: any) => `VOUCHER:${e.voucher_id}`))];
      let tallyMap: Record<string, any> = {};
      if (vids.length) {
        const st = await fetchJson(`${API}/api/v1/tally/status?sources=${vids.join(',')}`).catch(() => null);
        for (const r of st?.rows ?? []) tallyMap[r.source] = r;
      }
      setDrawer({ ledger: name, statement, tallyMap });
    }
    catch (e: any) { setDrawer({ ledger: name, error: e.message }); }
  };

  const syncVoucher = async (voucherId: string) => {
    try {
      const out = await fetchJson(`${API}/api/v1/tally/push/voucher/${voucherId}`, { method: 'POST' });
      alert(`✔ Synced to Tally Prime (guid ${out.tally_guid.slice(0, 8)}…, created: ${out.created})`);
      openDrawer(drawer.ledger);
    } catch (e: any) {
      alert(e.code === 'ALREADY_SYNCED' ? '✔ Already synced to Tally — double-push blocked.' : `✖ Tally push failed: ${e.message}
(Voucher stays PENDING — retry when Tally Prime is open.)`);
    }
  };

  return (
    <div style={{ padding: 20, background: C.bg, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ color: C.purple, margin: 0 }}>
          💠 Finance Hub <span style={{ fontSize: 11, color: C.emerald, border: `1px solid ${C.emerald}`, borderRadius: 10, padding: '1px 8px' }}>LIVE POSTGRESQL · TARA-GUARDED</span>
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span title={tally?.detail}
            style={{ fontSize: 10.5, fontWeight: 800, padding: '4px 10px', borderRadius: 10,
                     color: tally?.up ? C.emerald : C.warn, border: `1px solid ${tally?.up ? C.emerald : C.warn}` }}>
            {tally?.up ? '⬤ TALLY PRIME CONNECTED' : '◯ TALLY OFFLINE — open Tally with HTTP :9000'}
          </span>
          <button onClick={masterCheck}
            style={{ padding: '10px 14px', fontSize: 11, fontWeight: 800, background: 'transparent', color: C.sapphire, border: `1px solid ${C.sapphire}`, borderRadius: 12, cursor: 'pointer' }}>
            ⇄ VERIFY TALLY MASTERS
          </button>
          <button onClick={() => setModal(true)}
            style={{ padding: '12px 22px', fontSize: 13, fontWeight: 900, background: C.emerald, color: '#0f172a', border: 'none', borderRadius: 12, cursor: 'pointer', boxShadow: `0 0 20px ${C.emerald}44` }}>
            ＋ NEW VOUCHER
          </button>
        </div>
      </div>

      <input style={{ ...inp, maxWidth: 420, margin: '14px 0' }} value={q} placeholder="🔍 Search ledgers / groups… (live balances)"
        onChange={(e) => setQ(e.target.value)} />

      {err && <div style={{ padding: '10px 14px', border: `1px dashed ${C.warn}`, borderRadius: 10, color: C.warn, fontSize: 12, marginBottom: 12 }}>⚠️ {err}</div>}

      <div style={{ ...glass, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: C.dim, fontSize: 10.5, letterSpacing: 1, textAlign: 'left' }}>
              {['LEDGER', 'GROUP', 'ENTRIES', 'BALANCE', ''].map((h) => <th key={h} style={{ padding: '12px 14px', borderBottom: `1px solid ${C.line}` }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ledger_name} style={{ color: C.text, cursor: 'pointer' }}
                onClick={() => openDrawer(r.ledger_name)}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(148,163,184,0.07)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                <td style={{ padding: '10px 14px', fontWeight: 600 }}>{r.ledger_name}</td>
                <td style={{ padding: '10px 14px', color: C.dim }}>{r.group_head ?? '—'}</td>
                <td style={{ padding: '10px 14px' }}>{r.entries}<span style={{ color: C.dim, fontSize: 10 }}> · last {r.last_entry ?? '—'}</span></td>
                <td style={{ padding: '10px 14px', fontWeight: 800, color: Number(r.balance) >= 0 ? C.emerald : C.ruby }}>
                  ₹{Math.abs(Number(r.balance)).toLocaleString('en-IN')} {Number(r.balance) >= 0 ? 'Dr' : 'Cr'}
                </td>
                <td style={{ padding: '10px 14px', color: C.dim, fontSize: 11 }}>statement ▸</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* statement drawer */}
      {drawer && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(440px, 94vw)', ...glass, borderRadius: '20px 0 0 20px', zIndex: 250, padding: 18, overflowY: 'auto', boxShadow: '-20px 0 60px rgba(2,6,23,0.6)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ color: C.text, margin: 0, fontSize: 15 }}>{drawer.ledger}</h3>
            <button onClick={() => setDrawer(null)} style={{ background: 'transparent', color: C.dim, border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          {!drawer.statement && !drawer.error && <div style={{ color: C.dim, marginTop: 20 }}>loading…</div>}
          {drawer.error && <div style={{ color: C.ruby, marginTop: 20 }}>⚠ {drawer.error}</div>}
          {drawer.statement && (<>
            <div style={{ margin: '10px 0 12px', fontSize: 13, color: C.text }}>
              Closing: <b style={{ color: Number(drawer.statement.balance) >= 0 ? C.emerald : C.ruby }}>
                ₹{Math.abs(Number(drawer.statement.balance)).toLocaleString('en-IN')} {Number(drawer.statement.balance) >= 0 ? 'Dr' : 'Cr'}</b>
              <span style={{ color: C.dim, fontSize: 11 }}> · ΣDr ₹{Number(drawer.statement.total_dr).toLocaleString('en-IN')} · ΣCr ₹{Number(drawer.statement.total_cr).toLocaleString('en-IN')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <a href={`https://wa.me/?text=${drawer.statement.whatsapp_text}`} target="_blank" rel="noreferrer"
                style={{ flex: 1, textAlign: 'center', padding: '9px 0', fontSize: 11, fontWeight: 800, color: C.emerald, border: `1px solid ${C.emerald}`, borderRadius: 10, textDecoration: 'none' }}>
                💬 WHATSAPP STATEMENT
              </a>
              <button onClick={() => window.print()}
                style={{ flex: 1, padding: '9px 0', fontSize: 11, fontWeight: 800, background: 'transparent', color: C.sapphire, border: `1px solid ${C.sapphire}`, borderRadius: 10, cursor: 'pointer' }}>
                🖨 PDF / PRINT
              </button>
            </div>
            {drawer.statement.entries.map((e: any, i: number) => {
              const sync = e.voucher_id ? drawer.tallyMap?.[`VOUCHER:${e.voucher_id}`] : null;
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderTop: `1px solid ${C.line}`, fontSize: 11.5, alignItems: 'center' }}>
                  <span style={{ color: C.dim, whiteSpace: 'nowrap' }}>{e.entry_date}</span>
                  <span style={{ color: C.text, flex: 1 }}>
                    {e.particulars ?? e.source_type}
                    {e.voucher_id && (sync?.status === 'SYNCED'
                      ? <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, color: C.emerald, border: `1px solid ${C.emerald}`, borderRadius: 8, padding: '0 5px' }}>✔ SYNCED TO TALLY</span>
                      : <button onClick={(ev) => { ev.stopPropagation(); syncVoucher(e.voucher_id); }}
                          style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, color: C.warn, border: `1px solid ${C.warn}`, background: 'transparent', borderRadius: 8, padding: '1px 6px', cursor: 'pointer' }}>
                          {sync?.status === 'FAILED' ? '↻ RETRY TALLY' : '⇪ SYNC TO TALLY'}
                        </button>)}
                  </span>
                  <b style={{ color: e.dr_cr === 'DR' ? C.emerald : C.ruby, whiteSpace: 'nowrap' }}>{e.dr_cr === 'DR' ? '+' : '−'}₹{Number(e.amount).toLocaleString('en-IN')}</b>
                </div>
              );
            })}
          </>)}
        </div>
      )}

      {modal && <VoucherModal2026 onClose={() => setModal(false)} onPosted={load} />}
    </div>
  );
}
