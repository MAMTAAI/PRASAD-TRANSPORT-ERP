// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// LORRIES THAT ARE IN NO MASTER
//
// A trip whose registration reaches neither the vehicle master nor the market
// list has no class — so no commission rule applies and its settlement cannot
// be finished. Today there is exactly one: trip PT00100 carrying "9803", which
// is a truncated AS26C9803 (the master holds 9801 through 9816).
//
// The match is SUGGESTED and never applied on its own. What a clerk typed on a
// trip is evidence; overwriting it from a guess puts the register and the
// paperwork out of step with nobody able to say which is right. A person
// confirms, and then the trips and their diesel memos move together.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';

const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function UnmappedVehicles({ api, apiJson }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await apiJson(`${api}/unmapped-vehicles`)); }
    catch (e) { setErr(e?.message ?? 'list nahi aayi'); setData(null); }
    setBusy(false);
  }, [api, apiJson]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows ?? [];
  const t = data?.totals ?? {};

  const th = { padding: '9px 11px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase',
               letterSpacing: '0.08em', color: '#5d7196', borderBottom: '1px solid #27395f',
               whiteSpace: 'nowrap' };
  const td = { padding: '10px 11px', borderBottom: '1px solid #18244a', color: '#c4d1ea' };

  return (
    <div className="glass-card" style={{ padding: '18px' }}>
      <h3 style={{ margin: 0, color: '#fff', fontSize: '17px' }}>
        🔍 Bina master ki lorry
      </h3>
      <p style={{ color: '#9aadd4', fontSize: '12.5px', margin: '5px 0 14px', maxWidth: '74ch',
                  lineHeight: 1.55 }}>
        Jin trip ka vehicle number na Vehicle Master me hai, na Market list me. In ka
        <b style={{ color: '#eef3ff' }}> class pata nahi chalta</b>, isliye na commission lagta hai
        aur na settlement pura hota hai. Neeche jo suggestion hai wo
        <b style={{ color: '#eef3ff' }}> number ke aakhri hisse</b> se mila hai — confirm aap karenge.
      </p>

      {err && <p style={{ color: '#ff6b81', fontSize: '13px' }}>{err}</p>}
      {busy && <p style={{ color: '#ffb224', padding: '18px', textAlign: 'center' }}>Dekh raha hoon…</p>}

      {!busy && rows.length === 0 && !err && (
        <p style={{ color: '#2fe39b', textAlign: 'center', padding: '26px', fontSize: '13.5px' }}>
          ✅ Har trip ki lorry master me mil rahi hai — koi orphan nahi.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '13px' }}>
            {[['Lorry', t.vehicles, '#ff6b81'], ['Trip', t.trips, '#ffb224'],
              ['Diesel memo', t.fuel_memos, '#c4b5fd']].map((x) => (
              <div key={x[0]} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #27395f',
                                       borderRadius: '8px', padding: '7px 13px' }}>
                <span style={{ color: x[2], fontWeight: 800, fontSize: '15px' }}>{x[1] ?? 0}</span>
                <span style={{ color: '#9aadd4', fontSize: '11.5px', marginLeft: '7px' }}>{x[0]}</span>
              </div>
            ))}
            <div style={{ color: '#5d7196', fontSize: '11.5px', alignSelf: 'center' }}>
              ₹{Math.round(n2(t.expense)).toLocaleString('en-IN')} kharch phansa hua hai
            </div>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid #27395f', borderRadius: '10px' }}>
            <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  <th style={th}>Trip par likha</th><th style={th}>Trip</th>
                  <th style={th}>Driver</th><th style={th}>Kab</th>
                  <th style={{ ...th, textAlign: 'right' }}>Kharch</th>
                  <th style={th}>Master me kya milta hai</th><th style={th} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.k}>
                    <td style={{ ...td, fontFamily: 'monospace', color: '#ff6b81', fontWeight: 700 }}>
                      {r.vehicle_no}
                    </td>
                    <td style={td}>
                      <span style={{ fontFamily: 'monospace', color: '#22d3ee' }}>{r.trip_codes}</span>
                      <div style={{ fontSize: '10px', color: '#5d7196' }}>
                        {r.trips} trip · {r.fuel_memos} memo {n2(r.fuel_amount) ? `· ${inr(r.fuel_amount)}` : ''}
                      </div>
                    </td>
                    <td style={{ ...td, fontSize: '12px' }}>{r.drivers ?? '—'}</td>
                    <td style={{ ...td, fontSize: '11.5px', whiteSpace: 'nowrap' }}>
                      {r.first_trip}{r.last_trip !== r.first_trip ? ` → ${r.last_trip}` : ''}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {inr(r.expense)}
                    </td>
                    <td style={td}>
                      {r.suggested_vehicle_id ? (
                        <>
                          <span style={{ color: '#2fe39b', fontFamily: 'monospace', fontWeight: 700 }}>
                            {r.suggested_vehicle_no}
                          </span>
                          <div style={{ fontSize: '10.5px', color: '#5d7196' }}>
                            {r.suggested_ownership} · {r.suggested_owner}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: '#ffb224', fontSize: '12px' }}>{r.advice}</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {r.suggested_vehicle_id ? (
                        <button onClick={() => setOpen(r)}
                          style={{ background: 'rgba(47,227,155,0.14)', color: '#2fe39b',
                                   border: '1px solid rgba(47,227,155,0.5)', borderRadius: '7px',
                                   padding: '4px 11px', fontSize: '11.5px', fontWeight: 700,
                                   cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          🔗 Jod dein
                        </button>
                      ) : (
                        <span style={{ color: '#5d7196', fontSize: '11px' }}>Vehicle Master me banaiye</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {open && (
        <Confirm row={open} api={api} apiJson={apiJson}
          onClose={() => setOpen(null)}
          onDone={() => { setOpen(null); load(); }} />
      )}
    </div>
  );
}

// ══ THE CONFIRMATION — it says exactly what will move ═══════════════════════
function Confirm({ row, api, apiJson, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [choice, setChoice] = useState(row.suggested_vehicle_id);
  const [cands, setCands] = useState([]);

  useEffect(() => {
    apiJson(`${api}/unmapped-vehicles/${encodeURIComponent(row.k)}/candidates`)
      .then((j) => setCands(j.candidates ?? [])).catch(() => setCands([]));
  }, [api, apiJson, row.k]);

  const go = async () => {
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${api}/unmapped-vehicles/resolve`, {
        method: 'POST',
        body: JSON.stringify({ from_vehicle_no: row.k, vehicle_id: choice }),
      });
      alert(`✅ ${j.note}`);
      onDone?.();
    } catch (e) {
      setErr(e?.code === 'FORBIDDEN' ? 'Yeh sirf admin kar sakte hain.'
        : e?.code === 'SETTLEMENT_LOCKED' ? e.message
        : (e?.message ?? 'nahi hua'));
    }
    setBusy(false);
  };

  const picked = cands.find((c) => c.id === choice);

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,0.85)', zIndex: 960,
               display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
               padding: '34px 16px', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass-card"
        style={{ width: '100%', maxWidth: '560px', padding: '20px', borderTop: '3px solid #2fe39b' }}>

        <h3 style={{ margin: 0, color: '#fff', fontSize: '17px' }}>Lorry jodein</h3>
        <p style={{ color: '#9aadd4', fontSize: '12.5px', margin: '6px 0 0', lineHeight: 1.6 }}>
          Trip par likha hai <b style={{ color: '#ff6b81', fontFamily: 'monospace' }}>{row.vehicle_no}</b>.
          Ye kis lorry ki hai?
        </p>

        <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {cands.map((c) => (
            <label key={c.id}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px',
                       borderRadius: '8px', cursor: 'pointer',
                       background: choice === c.id ? 'rgba(47,227,155,0.1)' : 'rgba(10,16,36,0.5)',
                       border: '1px solid ' + (choice === c.id ? 'rgba(47,227,155,0.5)' : '#27395f') }}>
              <input type="radio" checked={choice === c.id} onChange={() => setChoice(c.id)}
                     style={{ accentColor: '#2fe39b' }} />
              <span style={{ fontFamily: 'monospace', color: '#eef3ff', fontWeight: 700 }}>
                {c.vehicle_no}
              </span>
              <span style={{ color: '#5d7196', fontSize: '11.5px' }}>
                {c.ownership} · {c.owner_name ?? '—'}
              </span>
              {c.suffix_match && (
                <span style={{ marginLeft: 'auto', color: '#2fe39b', fontSize: '10.5px' }}>
                  number milta hai
                </span>
              )}
            </label>
          ))}
        </div>

        {/* Exactly what moves, before it moves. */}
        <div style={{ marginTop: '15px', border: '1px solid #27395f', borderRadius: '9px',
                      padding: '12px 14px', background: 'rgba(10,16,36,0.5)', fontSize: '12.5px',
                      color: '#c4d1ea', lineHeight: 1.7 }}>
          <b style={{ color: '#eef3ff' }}>Ye hilega:</b><br />
          • {row.trips} trip ({row.trip_codes}) →{' '}
          <b style={{ color: '#2fe39b', fontFamily: 'monospace' }}>{picked?.vehicle_no ?? '…'}</b><br />
          • {row.fuel_memos} diesel memo {n2(row.fuel_amount) ? `(${inr(row.fuel_amount)})` : ''} bhi
          saath me — memo peeche chhoot gaya to diesel bina lorry ke reh jaata<br />
          • Us fortnight ka draft dobara banega
          <div style={{ color: '#5d7196', fontSize: '11.5px', marginTop: '7px' }}>
            Pump ka bill aur uska voucher nahi chhue jaate — sirf yeh badalta hai ki
            diesel kis lorry me gaya.
          </div>
        </div>

        {err && <p style={{ color: '#ff6b81', fontSize: '12.5px', marginTop: '12px' }}>{err}</p>}

        <div style={{ display: 'flex', gap: '8px', marginTop: '17px', flexWrap: 'wrap' }}>
          <button onClick={go} disabled={busy || !choice}
            style={{ background: choice ? '#2fe39b' : 'transparent', color: choice ? '#0a1024' : '#5d7196',
                     border: '1px solid ' + (choice ? '#2fe39b' : '#27395f'), borderRadius: '8px',
                     padding: '9px 16px', fontSize: '13px', fontWeight: 700,
                     cursor: choice ? 'pointer' : 'not-allowed' }}>
            {busy ? '⏳ ho raha hai…' : '🔗 Haan, jod dein'}
          </button>
          <button onClick={onClose}
            style={{ background: 'transparent', color: '#9aadd4', border: '1px solid #27395f',
                     borderRadius: '8px', padding: '9px 15px', fontSize: '13px', cursor: 'pointer' }}>
            Rehne dein
          </button>
        </div>
      </div>
    </div>
  );
}
