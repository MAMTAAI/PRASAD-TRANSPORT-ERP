// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// PAYOUT DRAWER — the multi-company payout screen (migration 177).
//
// Owner, 6-Sep-2026, against the design approved before this was written:
//   · the PAYING ENTITY may differ from the entity that owes the money, and
//     when it does the payment posts inter-company legs so neither firm
//     absorbs the other's expense. It is never a silent dropdown — the banner
//     and the second factor are the point.
//   · the QR encodes the PAYING entity's own VPA. A global handle here would
//     quietly route three firms' money through one account.
//   · SBI 1934 is Gautam Prasad's personal savings account: driver advances and
//     personal withdrawals only. The rule lives in the database
//     (bank_accounts.allowed_beneficiary_kinds); this screen only reflects it,
//     so it cannot drift from what the server will actually accept.
//
// The idempotency key is minted when the drawer OPENS, not when Pay is pressed.
// A key minted on submit is a new key on every retry and guards nothing.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { API, apiJson, n2, inr2, C, btn, sel, inp, panel } from './payrollShared';

const P = API.replace(/\/payroll$/, '/payouts');
const AUTHAPI = API.replace(/\/payroll$/, '/auth');
const RAILS = [['UPI_QR', 'UPI QR'], ['IMPS', 'IMPS'], ['NEFT', 'NEFT'], ['CASH', 'Cash']];

const Label = ({ children }) => (
  <div style={{ fontSize: '10px', letterSpacing: '.13em', textTransform: 'uppercase', color: C.dim, marginBottom: '4px' }}>{children}</div>
);
const Banner = ({ tone, children }) => (
  <div style={{
    display: 'flex', gap: '8px', fontSize: '12px', fontWeight: 600, lineHeight: 1.5,
    padding: '9px 11px', borderRadius: '8px', color: tone, whiteSpace: 'normal',
    border: `1px solid ${tone}`, background: `${tone}14`,
  }}>{children}</div>
);

export default function PayoutDrawer({
  beneficiaryKind, beneficiaryId, beneficiaryName,
  owingCompanyId, amount, sourceType, sourceRef, title, onClose, onDone,
}) {
  // LOCK 1 — minted once, on open. Every retry below reuses it.
  const [idemKey] = useState(() => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now())));
  // A payout raised against a document carries its amount and must not be
  // editable; a free-standing one (an advance, a vendor payment) has to be
  // typed. `amountFixed` decides which, so one drawer serves both.
  const amountFixed = n2(amount) > 0;
  const [amt, setAmt] = useState(amountFixed ? n2(amount) : '');
  const value = amountFixed ? n2(amount) : n2(amt);
  const [entities, setEntities] = useState([]);
  const [payingId, setPayingId] = useState(owingCompanyId ?? '');
  const [acctId, setAcctId] = useState('');
  const [rail, setRail] = useState('IMPS');
  const [step, setStep] = useState('FORM');      // FORM → AUTH → RESULT
  const [payout, setPayout] = useState(null);
  const [upi, setUpi] = useState(null);
  const [pin, setPin] = useState('');
  const [otp, setOtp] = useState('');
  const [mobile, setMobile] = useState('');
  const [utr, setUtr] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    apiJson(`${P}/paying-entities`).then((r) => {
      setEntities(r.rows ?? []);
      if (!payingId && r.rows?.length) setPayingId(owingCompanyId ?? r.rows[0].id);
    }).catch((e) => setErr(e.message));
  }, []);                                          // eslint-disable-line react-hooks/exhaustive-deps

  const paying = useMemo(() => entities.find((e) => e.id === payingId) ?? null, [entities, payingId]);
  const owing = useMemo(() => entities.find((e) => e.id === owingCompanyId) ?? null, [entities, owingCompanyId]);
  const interco = !!(payingId && owingCompanyId && payingId !== owingCompanyId);

  // Only accounts of the paying entity that are ALLOWED to pay this kind. The
  // server refuses the rest anyway (payout_account_policy); showing them would
  // just be a button that fails.
  const accounts = useMemo(
    () => (paying?.accounts ?? []).filter((a) => (a.allows ?? []).includes(beneficiaryKind)),
    [paying, beneficiaryKind]);
  const blocked = useMemo(
    () => (paying?.accounts ?? []).filter((a) => !(a.allows ?? []).includes(beneficiaryKind)),
    [paying, beneficiaryKind]);

  useEffect(() => { setAcctId(accounts[0]?.id ?? ''); }, [payingId, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsAccount = rail === 'IMPS' || rail === 'NEFT';
  const canContinue = payingId && owingCompanyId && value > 0 && (!needsAccount || acctId);

  const create = useCallback(async () => {
    setErr(''); setBusy('create');
    try {
      const r = await apiJson(P, {
        method: 'POST',
        body: JSON.stringify({
          idempotency_key: idemKey,
          paying_company_id: payingId, owing_company_id: owingCompanyId,
          bank_account_id: needsAccount ? acctId : (acctId || null),
          rail, beneficiary_kind: beneficiaryKind, beneficiary_id: beneficiaryId ?? null,
          beneficiary_name: beneficiaryName, amount: value,
          source_type: sourceType ?? null, source_ref: sourceRef ?? null,
        }),
      });
      setPayout(r.payout);
      setStep(r.payout.status === 'DRAFT' ? 'AUTH' : 'RESULT');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }, [idemKey, payingId, owingCompanyId, acctId, rail, beneficiaryKind, beneficiaryId, beneficiaryName, amount, sourceType, sourceRef, needsAccount]);

  const sendOtp = async () => {
    setErr(''); setBusy('otp');
    try {
      await apiJson(`${AUTHAPI}/otp/request`, { method: 'POST', body: JSON.stringify({ mobile }) });
      setErr('');
      alert('If that number has an account, a code has been sent to it.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const authorizeAndExecute = async () => {
    setErr(''); setBusy('auth');
    try {
      await apiJson(`${P}/${payout.id}/authorize`, { method: 'POST', body: JSON.stringify({ pin, otp: otp || undefined }) });
      const done = await apiJson(`${P}/${payout.id}/execute`, { method: 'POST', body: JSON.stringify({}) });
      setPayout(done.payout);
      if (done.payout.rail === 'UPI_QR') {
        try { setUpi(await apiJson(`${P}/${payout.id}/upi`)); } catch (e) { setErr(e.message); }
      }
      setStep('RESULT');
      onDone?.();
    } catch (e) { setErr(e.message); } finally { setBusy(''); setPin(''); setOtp(''); }
  };

  const settle = async () => {
    setErr(''); setBusy('settle');
    try {
      const r = await apiJson(`${P}/${payout.id}/settle`, { method: 'POST', body: JSON.stringify({ utr }) });
      setPayout(r.payout); onDone?.();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const shell = {
    position: 'fixed', inset: 0, background: 'rgba(4,8,20,.72)', zIndex: 90,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
  };
  const card = { ...panel, width: 'min(880px, 96vw)', maxHeight: '92vh', overflowY: 'auto', padding: '18px 20px' };

  return (
    <div style={shell} onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' }}>
          <div>
            <div style={{ fontSize: '10px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>Payout</div>
            <div style={{ fontSize: '19px', fontWeight: 800, color: C.ink }}>{inr2(value)} → {beneficiaryName}</div>
            {title && <div style={{ fontSize: '11.5px', color: C.mut, marginTop: '2px' }}>{title}</div>}
          </div>
          <button onClick={onClose} style={{ ...btn('crit'), marginLeft: 'auto' }}>✕ Close</button>
        </div>

        {err && <div style={{ marginBottom: '12px' }}><Banner tone={C.crit}>⛔<span>{err}</span></Banner></div>}

        {/* ── step 1: who pays, from where, how ── */}
        {step === 'FORM' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px' }}>
            <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
              <div>
                <Label>Owed by (from the document)</Label>
                <div style={{ ...inp, background: '#0d1428', color: C.mut }}>{owing?.company_name ?? '—'}</div>
              </div>
              {!amountFixed && (
                <div>
                  <Label>Amount</Label>
                  <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="0.00" style={{ ...inp, width: '100%', fontSize: '18px', fontVariantNumeric: 'tabular-nums' }} />
                </div>
              )}
              <div>
                <Label>Paying entity</Label>
                <select value={payingId} onChange={(e) => setPayingId(e.target.value)} style={{ ...sel, width: '100%' }}>
                  {entities.map((e) => <option key={e.id} value={e.id}>{e.company_name}</option>)}
                </select>
              </div>
              <div>
                <Label>Rail</Label>
                <select value={rail} onChange={(e) => setRail(e.target.value)} style={{ ...sel, width: '100%' }}>
                  {RAILS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <Label>Pay from</Label>
                <select value={acctId} onChange={(e) => setAcctId(e.target.value)} style={{ ...sel, width: '100%' }} disabled={!accounts.length}>
                  {!accounts.length && <option value="">— no account of this entity may pay a {beneficiaryKind.toLowerCase()} —</option>}
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.bank} {a.tail} · {a.kind}</option>)}
                </select>
                {blocked.length > 0 && (
                  <div style={{ fontSize: '11px', color: C.warn, marginTop: '6px', whiteSpace: 'normal' }}>
                    Not listed: {blocked.map((b) => `${b.bank} ${b.tail}`).join(', ')} — may only pay {[...new Set(blocked.flatMap((b) => b.allows ?? []))].join(', ').toLowerCase()}.
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
              {interco ? (
                <>
                  <Banner tone={C.warn}>⚠<span>Cross-entity payment. <b>{paying?.company_name}</b> pays a <b>{owing?.company_name}</b> liability. Two ledger legs will be posted so neither firm's books absorb the other's expense.</span></Banner>
                  <div style={{ ...panel, background: '#0d1428' }}>
                    <Label>Ledger effect</Label>
                    {[
                      [`${paying?.company_name} — bank`, 'Cr', C.crit],
                      [`${paying?.company_name} — Due from ${owing?.company_name}`, 'Dr', C.cyan],
                      [`${owing?.company_name} — ${beneficiaryKind.toLowerCase()} payable`, 'Dr', C.cyan],
                      [`${owing?.company_name} — Due to ${paying?.company_name}`, 'Cr', C.crit],
                    ].map(([l, s, col]) => (
                      <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11.5px', padding: '4px 0', borderBottom: '1px dotted #1b2a4e' }}>
                        <span style={{ color: C.mut, whiteSpace: 'normal' }}>{l}</span>
                        <b style={{ color: col, fontVariantNumeric: 'tabular-nums' }}>{s} {inr2(value)}</b>
                      </div>
                    ))}
                    <div style={{ fontSize: '10.5px', color: C.dim, marginTop: '7px', whiteSpace: 'normal' }}>Four entries, two vouchers, one transaction. If any leg fails, none of them exist.</div>
                  </div>
                </>
              ) : (
                <Banner tone={C.good}>✓<span>Same entity pays and owes — a single voucher, no inter-company leg.</span></Banner>
              )}
              {rail === 'UPI_QR' && !paying?.upi_vpa && (
                <Banner tone={C.crit}>⛔<span>{paying?.company_name} has no UPI VPA set. Add one in Masters → Companies before using a QR.</span></Banner>
              )}
              {rail === 'UPI_QR' && paying?.upi_vpa && (
                <div style={{ fontSize: '11.5px', color: C.mut }}>QR will encode <b style={{ color: C.cyan, fontFamily: 'monospace' }}>{paying.upi_vpa}</b></div>
              )}
              <button disabled={!canContinue || busy === 'create'} onClick={create} style={{ ...btn('solid', canContinue && busy !== 'create'), width: '100%', padding: '11px' }}>
                {busy === 'create' ? 'Creating…' : 'Continue → authorise'}
              </button>
            </div>
          </div>
        )}

        {/* ── step 2: PIN, and OTP inside the 24h window ── */}
        {step === 'AUTH' && payout && (
          <div style={{ maxWidth: '440px', margin: '0 auto', display: 'grid', gap: '12px' }}>
            <Banner tone={C.cyan}>🔐<span>Authorising <b>{inr2(payout.amount)}</b> to {payout.beneficiary_name} from <b>{payout.paying_company}</b>{payout.account_tail ? ` · ${payout.bank_name} ${payout.account_tail}` : ''}.</span></Banner>
            {payout.otp_required && (
              <Banner tone={C.crit}>⛔<span>This beneficiary's bank or UPI details changed in the last 24 hours. An OTP is required as well as your PIN.</span></Banner>
            )}
            <div>
              <Label>Admin PIN</Label>
              <input type="password" inputMode="numeric" autoComplete="off" value={pin} maxLength={6}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                style={{ ...inp, width: '100%', fontSize: '20px', letterSpacing: '.4em', textAlign: 'center', padding: '10px' }} />
              <div style={{ fontSize: '10.5px', color: C.dim, marginTop: '4px' }}>3 wrong attempts locks the PIN for 15 minutes. Set or change it in Profile.</div>
            </div>
            {payout.otp_required && (
              <div style={{ display: 'grid', gap: '8px' }}>
                <div>
                  <Label>Your registered mobile</Label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10 digits" style={{ ...inp, flex: 1 }} />
                    <button disabled={mobile.length !== 10 || busy === 'otp'} onClick={sendOtp} style={btn('cyan', mobile.length === 10 && busy !== 'otp')}>Send code</button>
                  </div>
                </div>
                <div>
                  <Label>OTP</Label>
                  <input inputMode="numeric" value={otp} maxLength={6} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                    style={{ ...inp, width: '100%', fontSize: '18px', letterSpacing: '.3em', textAlign: 'center' }} />
                </div>
              </div>
            )}
            <button disabled={pin.length < 4 || busy === 'auth' || (payout.otp_required && otp.length < 4)}
              onClick={authorizeAndExecute}
              style={{ ...btn('solid', pin.length >= 4 && busy !== 'auth'), width: '100%', padding: '11px' }}>
              {busy === 'auth' ? 'Posting…' : `Authorise & post ${inr2(payout.amount)}`}
            </button>
            <button onClick={() => setStep('FORM')} style={btn('mut')}>← Back</button>
          </div>
        )}

        {/* ── step 3: the QR, or the UTR a person enters ── */}
        {step === 'RESULT' && payout && (
          <div style={{ display: 'grid', gridTemplateColumns: upi ? '1fr 1fr' : '1fr', gap: '18px' }}>
            <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
              <Banner tone={payout.status === 'SETTLED' ? C.good : C.warn}>
                {payout.status === 'SETTLED' ? '✓' : '⏳'}
                <span>
                  Ledger posted{payout.intercompany ? ' (both entities)' : ''}. Status <b>{payout.status}</b>.
                  {payout.status === 'PENDING_BANK' && ' No payout provider is connected — complete the transfer in net-banking, then enter the UTR below.'}
                </span>
              </Banner>
              <div style={{ ...panel, background: '#0d1428' }}>
                {[['Paying entity', payout.paying_company], ['Owed by', payout.owing_company],
                  ['Account', payout.account_tail ? `${payout.bank_name} ${payout.account_tail}` : '—'],
                  ['Rail', payout.rail], ['Amount', inr2(payout.amount)],
                  ['Idempotency key', String(payout.idempotency_key).slice(0, 8) + '…'],
                  ['UTR', payout.utr ?? '—']].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px', padding: '4px 0', borderBottom: '1px dotted #1b2a4e' }}>
                    <span style={{ color: C.dim }}>{k}</span><b style={{ color: C.ink2, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
                  </div>
                ))}
              </div>
              {payout.status === 'PENDING_BANK' && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="Bank reference / UTR" style={{ ...inp, flex: 1 }} />
                  <button disabled={utr.trim().length < 6 || busy === 'settle'} onClick={settle} style={btn('good', utr.trim().length >= 6 && busy !== 'settle')}>Mark sent</button>
                </div>
              )}
              <button onClick={onClose} style={btn('mut')}>Done</button>
            </div>

            {upi && (
              <div style={{ ...panel, background: '#0d1428', textAlign: 'center' }}>
                <Label>Scan to pay from {upi.paying_company}</Label>
                <div style={{ background: '#fff', padding: '12px', borderRadius: '10px', display: 'inline-block', margin: '8px 0' }}>
                  <QRCodeSVG value={upi.uri} size={168} level="M" />
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'monospace', color: C.cyan }}>{upi.vpa}</div>
                <div style={{ fontSize: '22px', fontWeight: 900, color: C.ink, marginTop: '6px' }}>{inr2(upi.amount)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
