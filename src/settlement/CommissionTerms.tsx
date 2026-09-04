// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// COMMISSION TERMS — what we charge an attached or market lorry
//
// 16 of 49 lorries are ATTACHED: the family's. In one fortnight they carried
// Rs18,66,187 of Rs41,08,389. On those the freight is the OWNER'S money and
// only our commission is income — but nothing in the database recorded what
// that commission is. Every one of them settles to "rate darj nahi" until a
// rate is entered here, and cannot be approved. That is deliberate: a blank
// rate treated as zero would claim we earned nothing on lakhs of freight, and
// the claim would post to the books.
//
// THE DATE MATTERS AND THE SCREEN SAYS SO. A rate keyed in today does not
// price a fortnight worked in July. So the date box is pre-filled with the
// start of the fortnight being settled, and it is spelled out beside it.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import GlobalPagination, { usePagination } from '../components/GlobalPagination';

const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const BASES = [
  ['PCT', '% of freight', 'freight ka pratishat'],
  ['PER_KL', '₹ per KL', 'har kilolitre par'],
  ['PER_TON', '₹ per ton', 'har ton par'],
  ['FLAT_TRIP', '₹ per trip', 'har trip par ek rakam'],
];
const basisLabel = (b) => BASES.find((x) => x[0] === b)?.[1] ?? b;

export default function CommissionTerms({ api, apiJson, defaultFrom }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);   // the row being priced
  const [onlyMissing, setOnlyMissing] = useState(true);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await apiJson(`${api}/terms`)); }
    catch (e) { setErr(e?.message ?? 'terms nahi aaye'); setData(null); }
    setBusy(false);
  }, [api, apiJson]);
  useEffect(() => { load(); }, [load]);

  const rows = (data?.rows ?? []).filter((r) => (onlyMissing ? !r.term_id : true));
  const pg = usePagination(rows, { defaultSize: 10 });
  useEffect(() => { pg.setPage(1); }, [onlyMissing]);
  const t = data?.totals ?? {};

  const th = { padding: '9px 11px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase',
               letterSpacing: '0.08em', color: '#5d7196', borderBottom: '1px solid #27395f',
               whiteSpace: 'nowrap' };
  const td = { padding: '10px 11px', borderBottom: '1px solid #18244a', color: '#c4d1ea' };

  return (
    <div className="glass-card" style={{ padding: '18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px',
                    flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <h3 style={{ margin: 0, color: '#fff', fontSize: '17px' }}>
            💼 Commission &amp; TDS ke rate
          </h3>
          <p style={{ color: '#9aadd4', fontSize: '12.5px', margin: '5px 0 0', maxWidth: '72ch',
                      lineHeight: 1.55 }}>
            Attached aur market lorry ka freight <b style={{ color: '#eef3ff' }}>owner ka paisa</b> hai —
            usme se sirf hamara <b style={{ color: '#2fe39b' }}>commission</b> hamari aamdani hai.
            Jab tak rate darj nahi, us lorry ka settlement approve nahi hoga.
          </p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '7px', color: '#9aadd4',
                        fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)}
                 style={{ accentColor: '#ff6b81', width: '15px', height: '15px', cursor: 'pointer' }} />
          Sirf jinka rate nahi hai
        </label>
      </div>

      {/* what is at stake, in money */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                    gap: '1px', background: '#27395f', border: '1px solid #27395f',
                    borderRadius: '11px', overflow: 'hidden', marginBottom: '15px' }}>
        {[['Lorry', t.vehicles, '#eef3ff'], ['Rate darj hai', t.with_rate, '#2fe39b'],
          ['Rate nahi hai', t.without_rate, '#ff6b81']].map((x) => (
          <div key={x[0]} style={{ background: 'rgba(18,28,56,0.75)', padding: '13px 15px' }}>
            <div style={{ fontSize: '22px', fontWeight: 800, color: x[2],
                          fontVariantNumeric: 'tabular-nums' }}>{x[1] ?? 0}</div>
            <div style={{ fontSize: '10.5px', color: '#5d7196', marginTop: '4px' }}>{x[0]}</div>
          </div>
        ))}
        <div style={{ background: 'rgba(255,107,129,0.09)', padding: '13px 15px' }}>
          <div style={{ fontSize: '19px', fontWeight: 800, color: '#ff6b81',
                        fontVariantNumeric: 'tabular-nums' }}>{inr(t.freight_at_risk)}</div>
          <div style={{ fontSize: '10.5px', color: '#8a5c6a', marginTop: '4px' }}>
            itna freight bina rate ke pada hai
          </div>
        </div>
      </div>

      {err && <p style={{ color: '#ff6b81', fontSize: '13px' }}>{err}</p>}
      {busy && <p style={{ color: '#ffb224', padding: '18px', textAlign: 'center' }}>Khul raha hai…</p>}

      {!busy && rows.length === 0 && (
        <p style={{ color: '#2fe39b', textAlign: 'center', padding: '24px', fontSize: '13px' }}>
          {onlyMissing ? '✅ Har attached/market lorry ka rate darj hai.' : 'Koi lorry nahi mili.'}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ overflowX: 'auto', border: '1px solid #27395f', borderRadius: '10px' }}>
            <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  <th style={th}>Lorry</th><th style={th}>Owner</th><th style={th}>Kism</th>
                  <th style={{ ...th, textAlign: 'right' }}>Trip</th>
                  <th style={{ ...th, textAlign: 'right' }}>Ab tak freight</th>
                  <th style={th}>Commission</th><th style={{ ...th, textAlign: 'right' }}>TDS</th>
                  <th style={th}>Kab se</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {pg.slice.map((r) => (
                  <tr key={r.vehicle_key}>
                    <td style={{ ...td, fontFamily: 'monospace', color: '#fff', fontWeight: 700 }}>
                      {r.vehicle_no}
                    </td>
                    <td style={td}>{r.owner_name ?? <span style={{ color: '#5d7196' }}>—</span>}</td>
                    <td style={td}>
                      <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 8px',
                                     borderRadius: '5px',
                                     background: r.fleet_class === 'MARKET' ? 'rgba(34,211,238,0.15)' : 'rgba(255,178,36,0.15)',
                                     color: r.fleet_class === 'MARKET' ? '#22d3ee' : '#ffb224' }}>
                        {r.fleet_class === 'MARKET' ? 'MARKET' : 'ATTACHED'}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {r.trips_ever || '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {n2(r.freight_ever) ? inr(r.freight_ever) : '—'}
                    </td>
                    <td style={td}>
                      {r.term_id ? (
                        <span style={{ color: '#2fe39b', fontWeight: 600 }}>
                          {n2(r.rate)}{r.basis === 'PCT' ? '%' : ''}{' '}
                          <span style={{ color: '#5d7196', fontWeight: 400, fontSize: '11px' }}>
                            {basisLabel(r.basis)}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: '#ff6b81', fontWeight: 700 }}>⚠️ rate darj nahi</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {r.term_id ? `${n2(r.tds_pct)}%` : '—'}
                    </td>
                    <td style={{ ...td, color: '#9aadd4', fontSize: '11.5px', whiteSpace: 'nowrap' }}>
                      {r.effective_from ?? '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button onClick={() => setEditing(r)}
                        style={{ background: r.term_id ? 'transparent' : 'rgba(47,227,155,0.14)',
                                 color: r.term_id ? '#9aadd4' : '#2fe39b',
                                 border: '1px solid ' + (r.term_id ? '#3d548a' : 'rgba(47,227,155,0.5)'),
                                 borderRadius: '7px', padding: '4px 11px', fontSize: '11.5px',
                                 fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        {r.term_id ? '✏️ Badlein' : '+ Rate daalein'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <GlobalPagination {...pg} label="lorry" />
        </>
      )}

      {editing && (
        <TermEditor row={editing} api={api} apiJson={apiJson} defaultFrom={defaultFrom}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

// ══ ONE LORRY'S TERM ════════════════════════════════════════════════════════
function TermEditor({ row, api, apiJson, defaultFrom, onClose, onSaved }) {
  const [basis, setBasis] = useState(row.basis ?? 'PCT');
  const [rate, setRate] = useState(row.rate ?? '');
  const [tds, setTds] = useState(row.tds_pct ?? 1);
  const [recover, setRecover] = useState(row.recover_expenses !== false);
  // The fortnight being settled, not today. A rate dated today would not price
  // the fortnight the desk is looking at, and nothing would appear to happen.
  const [from, setFrom] = useState(defaultFrom ?? new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState([]);

  useEffect(() => {
    apiJson(`${api}/terms/${row.vehicle_key}/history`)
      .then((j) => setHistory(j.terms ?? [])).catch(() => setHistory([]));
  }, [api, apiJson, row.vehicle_key]);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${api}/terms`, {
        method: 'POST',
        body: JSON.stringify({
          vehicle_key: row.vehicle_key, vehicle_no: row.vehicle_no,
          basis, rate: Number(rate), tds_pct: Number(tds),
          recover_expenses: recover, owner_name: row.owner_name,
          effective_from: from, note,
        }),
      });
      const NL = String.fromCharCode(10);
      alert(`✅ Rate darj ho gaya.` + NL
        + (j.drafts_refreshed ? `${j.drafts_refreshed} draft dobara bane.` : ''));
      onSaved?.();
    } catch (e) {
      setErr(e?.code === 'FORBIDDEN' ? 'Rate sirf admin daal sakte hain.' : (e?.message ?? 'save nahi hua'));
    }
    setBusy(false);
  };

  const field = { background: '#0a1024', border: '1px solid #3d548a', borderRadius: '7px',
                  color: '#eef3ff', padding: '8px 10px', fontSize: '13px', width: '100%' };
  const label = { fontSize: '11px', color: '#9aadd4', display: 'block', marginBottom: '4px' };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,0.85)', zIndex: 950,
               display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
               padding: '30px 16px', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass-card"
        style={{ width: '100%', maxWidth: '620px', padding: '20px', borderTop: '3px solid #2fe39b' }}>

        <h3 style={{ margin: 0, color: '#fff', fontFamily: 'monospace', fontSize: '18px' }}>
          {row.vehicle_no}
        </h3>
        <div style={{ color: '#9aadd4', fontSize: '12px', marginTop: '4px' }}>
          {row.owner_name ?? 'owner darj nahi'} · {row.fleet_class}
          {n2(row.freight_ever) ? ` · ab tak ${inr(row.freight_ever)} freight` : ''}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: '12px', marginTop: '18px' }}>
          <div>
            <label style={label}>Commission kis hisaab se</label>
            <select value={basis} onChange={(e) => setBasis(e.target.value)} style={field}>
              {BASES.map((b) => <option key={b[0]} value={b[0]}>{b[1]} — {b[2]}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Rate {basis === 'PCT' ? '(%)' : '(₹)'}</label>
            <input value={rate} onChange={(e) => setRate(e.target.value)} style={field}
                   placeholder={basis === 'PCT' ? 'jaise 8' : 'jaise 150'} />
          </div>
          <div>
            <label style={label}>TDS (%) — 194C</label>
            <select value={tds} onChange={(e) => setTds(e.target.value)} style={field}>
              <option value="0">0% — declaration hai</option>
              <option value="1">1% — vyakti / HUF</option>
              <option value="2">2% — firm / company</option>
            </select>
          </div>
          <div>
            <label style={label}>Kis tareekh se lagega</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                   style={{ ...field, colorScheme: 'dark' }} />
          </div>
        </div>

        {/* The one thing that silently goes wrong if it is not said. */}
        <p style={{ color: '#ffb224', fontSize: '11.5px', marginTop: '9px', lineHeight: 1.5,
                    background: 'rgba(255,178,36,0.07)', border: '1px solid rgba(255,178,36,0.3)',
                    borderRadius: '7px', padding: '9px 11px' }}>
          ⚠️ Rate <b>isi tareekh se</b> lagega. Isse purane fortnight par nahi lagega — agar
          purana hisaab bhi is rate par karna hai to tareekh peeche kar dijiye.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px',
                        color: '#c4d1ea', fontSize: '12.5px', cursor: 'pointer' }}>
          <input type="checkbox" checked={recover} onChange={(e) => setRecover(e.target.checked)}
                 style={{ accentColor: '#2fe39b', width: '15px', height: '15px' }} />
          Diesel aur toll owner ke paise se wapas kaatein
        </label>

        <div style={{ marginTop: '12px' }}>
          <label style={label}>Note</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} style={field}
                 placeholder="kuch likhna ho to…" />
        </div>

        {history.length > 0 && (
          <div style={{ marginTop: '16px', borderTop: '1px solid #27395f', paddingTop: '12px' }}>
            <div style={{ fontSize: '11px', color: '#5d7196', textTransform: 'uppercase',
                          letterSpacing: '0.08em', marginBottom: '7px' }}>Purane rate</div>
            {history.map((h) => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px',
                                       fontSize: '12px', color: '#9aadd4', padding: '3px 0' }}>
                <span>{n2(h.rate)}{h.basis === 'PCT' ? '%' : ''} {basisLabel(h.basis)} · TDS {n2(h.tds_pct)}%</span>
                <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  {h.effective_from} → {h.effective_to ?? 'abhi tak'}
                </span>
              </div>
            ))}
          </div>
        )}

        {err && <p style={{ color: '#ff6b81', fontSize: '12.5px', marginTop: '12px' }}>{err}</p>}

        <div style={{ display: 'flex', gap: '8px', marginTop: '18px', flexWrap: 'wrap' }}>
          <button onClick={save} disabled={busy || !rate}
            style={{ background: rate ? '#2fe39b' : 'transparent', color: rate ? '#0a1024' : '#5d7196',
                     border: '1px solid ' + (rate ? '#2fe39b' : '#27395f'), borderRadius: '8px',
                     padding: '9px 16px', fontSize: '13px', fontWeight: 700,
                     cursor: rate ? 'pointer' : 'not-allowed' }}>
            💾 Rate save karein
          </button>
          <button onClick={onClose}
            style={{ background: 'transparent', color: '#9aadd4', border: '1px solid #27395f',
                     borderRadius: '8px', padding: '9px 15px', fontSize: '13px', cursor: 'pointer' }}>
            Band karein
          </button>
        </div>
      </div>
    </div>
  );
}
