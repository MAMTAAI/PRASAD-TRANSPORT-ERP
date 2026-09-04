// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// OWNER STATEMENT — every lorry one owner runs for us, on one sheet
//
// "Agar kisi vehicle ka owner ka attached/market ka max vehicle ho to ek report
// me har vehicle ka report aa jaye, IOCL ke jaisa." SANDEEP KUMAR PRASAD runs
// eleven; this is his statement, and the IOCL grouping one level up — owner,
// then lorry, then a subtotal, then the grand total.
//
// The column order follows the money as it moves: the freight arrives, our
// commission comes out, TDS is withheld, the diesel we advanced is taken back,
// and what remains is what we owe them. A lorry with no rate on file shows the
// gap instead of a zero, because a zero here would say we earned nothing.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';

const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const EXP = 'rgba(255,107,129,0.055)';
const INC = 'rgba(47,227,155,0.055)';
const EDGE = '2px solid #3d548a';

export default function OwnerStatement({ api, apiJson, periodFrom, onNeedRate }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [shut, setShut] = useState(() => new Set());

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      setData(await apiJson(`${api}/owner-statement?period_from=${periodFrom}`));
    } catch (e) { setErr(e?.message ?? 'statement nahi bani'); setData(null); }
    setBusy(false);
  }, [api, apiJson, periodFrom]);
  useEffect(() => { load(); }, [load]);

  const toggle = (k) => setShut((s) => {
    const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n;
  });

  const owners = data?.owners ?? [];
  const g = data?.grand ?? {};

  const th = (bg, align) => ({
    padding: '7px 9px', textAlign: align ?? 'left', fontSize: '9.5px', textTransform: 'uppercase',
    letterSpacing: '0.06em', color: '#8fa2c6', borderBottom: '1px solid #27395f',
    whiteSpace: 'nowrap', background: bg,
  });
  const td = (bg, align) => ({
    padding: '6px 9px', borderBottom: '1px solid #18244a', color: '#c4d1ea', background: bg,
    textAlign: align ?? 'left', whiteSpace: 'nowrap',
    fontVariantNumeric: align === 'right' ? 'tabular-nums' : 'normal',
  });
  const foot = (bg, align) => ({
    ...td(bg, align), borderTop: '2px solid #3d548a', borderBottom: 'none', fontWeight: 700,
  });

  return (
    <div className="glass-card" style={{ padding: '18px' }} id="pt-owner-statement">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #pt-owner-statement, #pt-owner-statement * { visibility: visible; }
          #pt-owner-statement { position: absolute; left: 0; top: 0; width: 100%; }
          .pt-noprint { display: none !important; }
          .pt-owner { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      <div style={{ borderBottom: '2px solid #27395f', paddingBottom: '12px', marginBottom: '14px',
                    display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '17px', fontWeight: 800, color: '#fff' }}>
            Vehicle Owner Statement
          </div>
          <div style={{ fontSize: '12px', color: '#9aadd4', marginTop: '3px' }}>
            Attached &amp; Market lorry · <b style={{ color: '#22d3ee' }}>{data?.period?.label ?? ''}</b>
          </div>
          <div style={{ fontSize: '11.5px', color: '#5d7196', marginTop: '2px', fontFamily: 'monospace' }}>
            Period: {data?.period?.from} to {data?.period?.to}
          </div>
        </div>
        <button className="pt-noprint" onClick={() => window.print()}
          style={{ background: 'rgba(34,211,238,0.13)', color: '#22d3ee',
                   border: '1px solid rgba(34,211,238,0.45)', borderRadius: '8px',
                   padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                   alignSelf: 'flex-start' }}>
          🖨️ Print
        </button>
      </div>

      {err && <p style={{ color: '#ff6b81', fontSize: '13px' }}>{err}</p>}
      {busy && <p style={{ color: '#ffb224', padding: '20px', textAlign: 'center' }}>Statement ban rahi hai…</p>}

      {!busy && owners.length === 0 && !err && (
        <p style={{ color: '#5d7196', textAlign: 'center', padding: '26px', fontSize: '13px' }}>
          Is cycle me koi attached ya market lorry nahi chali.
        </p>
      )}

      {/* The one thing that stops a statement being payable. */}
      {n2(g.without_rate) > 0 && (
        <div className="pt-noprint" style={{ border: '1px solid rgba(255,107,129,0.45)',
                      background: 'rgba(255,107,129,0.07)', borderRadius: '9px',
                      padding: '11px 14px', marginBottom: '14px', display: 'flex',
                      justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
                      alignItems: 'center' }}>
          <span style={{ color: '#ff6b81', fontSize: '13px', fontWeight: 700 }}>
            ⚠️ {g.without_rate} lorry ka commission rate darj nahi — unka hisaab adhoora hai
          </span>
          <button onClick={onNeedRate}
            style={{ background: 'rgba(47,227,155,0.14)', color: '#2fe39b',
                     border: '1px solid rgba(47,227,155,0.5)', borderRadius: '7px',
                     padding: '5px 12px', fontSize: '11.5px', fontWeight: 700, cursor: 'pointer' }}>
            Rate daalein →
          </button>
        </div>
      )}

      {owners.map((o) => {
        const closed = shut.has(o.owner_name);
        return (
          <div key={o.owner_name} className="pt-owner"
               style={{ border: '1px solid #27395f', borderRadius: '10px', overflow: 'hidden',
                        marginBottom: '12px' }}>
            <div onClick={() => toggle(o.owner_name)}
                 style={{ display: 'flex', justifyContent: 'space-between', gap: '12px',
                          alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer',
                          background: 'rgba(26,34,56,0.85)', padding: '10px 14px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span className="pt-noprint" style={{ color: '#5d7196', fontSize: '11px', width: '9px' }}>
                  {closed ? '▸' : '▾'}
                </span>
                <b style={{ color: '#fff', fontSize: '14.5px' }}>{o.owner_name}</b>
                <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 8px',
                               borderRadius: '5px',
                               background: o.fleet_class === 'MARKET' ? 'rgba(34,211,238,0.15)' : 'rgba(255,178,36,0.15)',
                               color: o.fleet_class === 'MARKET' ? '#22d3ee' : '#ffb224' }}>
                  {o.fleet_class}
                </span>
                <span style={{ color: '#9aadd4', fontSize: '11.5px' }}>
                  {o.lorries} lorry · {o.trips} trip
                </span>
                {n2(o.without_rate) > 0 && (
                  <span style={{ color: '#ff6b81', fontSize: '11px' }}>
                    ⚠️ {o.without_rate} ka rate nahi
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', gap: '15px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#9aadd4', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>
                  freight {inr(o.freight)}
                </span>
                <span style={{ color: '#2fe39b', fontSize: '12.5px', fontWeight: 700,
                               fontVariantNumeric: 'tabular-nums' }}>
                  hamara {inr(o.commission)}
                </span>
                <b style={{ color: '#c4b5fd', fontSize: '14px', fontVariantNumeric: 'tabular-nums',
                            minWidth: '110px', textAlign: 'right' }}>
                  dena {inr(o.payable)}
                </b>
              </span>
            </div>

            {!closed && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: '980px', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr>
                      <th style={th('rgba(26,34,56,0.5)')}>Lorry</th>
                      <th style={th('rgba(26,34,56,0.5)', 'right')}>Trip</th>
                      <th style={th(EXP, 'right')}>Kharch</th>
                      <th style={{ ...th(EXP, 'right'), borderRight: EDGE }}>Wapas kaata</th>
                      <th style={th(INC, 'right')}>Qty (KL)</th>
                      <th style={th(INC, 'right')}>Freight</th>
                      <th style={th(INC)}>Commission</th>
                      <th style={{ ...th(INC, 'right'), color: '#2fe39b' }}>Hamara</th>
                      <th style={th('rgba(26,34,56,0.5)', 'right')}>TDS</th>
                      <th style={{ ...th('rgba(26,34,56,0.5)', 'right'), color: '#c4b5fd' }}>Owner ko dena</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.vehicles.map((v) => (
                      <tr key={v.vehicle_key}>
                        <td style={{ ...td('rgba(26,34,56,0.35)'), fontFamily: 'monospace',
                                     color: '#fff', fontWeight: 600 }}>{v.vehicle_no}</td>
                        <td style={td('rgba(26,34,56,0.35)', 'right')}>{v.trips_count}</td>
                        <td style={td(EXP, 'right')}>{inr(v.expense_total)}</td>
                        <td style={{ ...td(EXP, 'right'), borderRight: EDGE }}>
                          {v.expenses_recovered === null ? '—' : inr(v.expenses_recovered)}
                        </td>
                        <td style={td(INC, 'right')}>{n2(v.loaded_qty).toFixed(3)}</td>
                        <td style={td(INC, 'right')}>{inr2(v.billed_amount)}</td>
                        <td style={td(INC)}>
                          {v.needs_rate ? (
                            <span style={{ color: '#ff6b81', fontWeight: 700 }}>rate darj nahi</span>
                          ) : (
                            <span style={{ color: '#9aadd4', fontSize: '11px' }}>
                              {n2(v.commission_rate)}{v.commission_basis === 'PCT' ? '%' : ''}
                              {v.commission_basis !== 'PCT' ? ` /${v.commission_basis === 'FLAT_TRIP' ? 'trip' : 'KL'}` : ''}
                            </span>
                          )}
                        </td>
                        <td style={{ ...td(INC, 'right'), color: '#2fe39b', fontWeight: 700 }}>
                          {v.commission_amount === null ? '—' : inr2(v.commission_amount)}
                        </td>
                        <td style={td('rgba(26,34,56,0.35)', 'right')}>
                          {v.tds_amount === null ? '—' : inr2(v.tds_amount)}
                        </td>
                        <td style={{ ...td('rgba(26,34,56,0.35)', 'right'), color: '#c4b5fd',
                                     fontWeight: 700 }}>
                          {v.payable_to_owner === null ? '—' : inr2(v.payable_to_owner)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} style={{ ...foot('rgba(26,34,56,0.9)'), color: '#eef3ff' }}>
                        Subtotal — {o.owner_name}
                      </td>
                      <td style={foot(EXP, 'right')}>{inr2(o.expenses)}</td>
                      <td style={{ ...foot(EXP, 'right'), borderRight: EDGE }}>{inr2(o.recovered)}</td>
                      <td style={foot(INC, 'right')}>{n2(o.loaded_qty).toFixed(3)}</td>
                      <td style={foot(INC, 'right')}>{inr2(o.freight)}</td>
                      <td style={foot(INC)} />
                      <td style={{ ...foot(INC, 'right'), color: '#2fe39b' }}>{inr2(o.commission)}</td>
                      <td style={foot('rgba(26,34,56,0.9)', 'right')}>{inr2(o.tds)}</td>
                      <td style={{ ...foot('rgba(26,34,56,0.9)', 'right'), color: '#c4b5fd',
                                   fontSize: '13px' }}>{inr2(o.payable)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {owners.length > 0 && (
        <div style={{ marginTop: '14px', border: '2px solid #3d548a', borderRadius: '11px',
                      overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px', background: INC, padding: '14px 17px',
                          borderRight: EDGE }}>
              <div style={{ fontSize: '10.5px', color: '#8fa2c6', textTransform: 'uppercase',
                            letterSpacing: '0.08em' }}>Kul freight (owner ka paisa)</div>
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#9aadd4',
                            fontVariantNumeric: 'tabular-nums', marginTop: '5px' }}>
                {inr2(g.freight)}
              </div>
            </div>
            <div style={{ flex: '1 1 200px', background: 'rgba(47,227,155,0.09)',
                          padding: '14px 17px', borderRight: EDGE }}>
              <div style={{ fontSize: '10.5px', color: '#8fa2c6', textTransform: 'uppercase',
                            letterSpacing: '0.08em' }}>Hamari aamdani — sirf commission</div>
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#2fe39b',
                            fontVariantNumeric: 'tabular-nums', marginTop: '5px' }}>
                {inr2(g.commission)}
              </div>
              <div style={{ fontSize: '10.5px', color: '#5d7196', marginTop: '5px' }}>
                yahi balance sheet ke profit me jaayega
              </div>
            </div>
            <div style={{ flex: '1 1 200px', background: 'rgba(167,139,250,0.09)', padding: '14px 17px' }}>
              <div style={{ fontSize: '10.5px', color: '#8fa2c6', textTransform: 'uppercase',
                            letterSpacing: '0.08em' }}>Owner ko dena</div>
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#c4b5fd',
                            fontVariantNumeric: 'tabular-nums', marginTop: '5px' }}>
                {inr2(g.payable)}
              </div>
              <div style={{ fontSize: '10.5px', color: '#5d7196', marginTop: '5px' }}>
                TDS {inr(g.tds)} kaatne ke baad
              </div>
            </div>
          </div>
          <div style={{ background: 'rgba(26,34,56,0.95)', padding: '12px 17px', display: 'flex',
                        justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
                        borderTop: '1px solid #3d548a', fontSize: '12px', color: '#9aadd4' }}>
            <b style={{ color: '#eef3ff', fontSize: '13px' }}>
              Total — {g.owners} owner · {g.lorries} lorry · {g.trips} trip
            </b>
            <span>
              freight {inr(g.freight)} − commission {inr(g.commission)} − TDS {inr(g.tds)}
              {' '}− wapas kaata {inr(g.recovered)} = <b style={{ color: '#c4b5fd' }}>{inr(g.payable)}</b>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
