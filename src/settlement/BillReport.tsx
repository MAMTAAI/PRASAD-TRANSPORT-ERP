// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// THE FORTNIGHT AS ONE BILL
//
// Laid out like the IOCL transportation bill the owner already reads every
// fortnight — 0011024699_7R01, PRASAD TRANSPORT, Bongaigaon RC, 16–30.06.2026:
// every trip listed under its lorry, a "Subtotal for Vehicle" closing each
// block, and one grand total at the foot. Reading their own money in the same
// shape as the document they check it against means nothing has to be
// translated in their head.
//
// EXPENSE ON THE LEFT, FREIGHT ON THE RIGHT, as asked. The two halves are
// tinted and split by a hard vertical rule, so a wide row still reads as two
// sides on a narrow screen or a printout.
//
// IT HAS TO HOLD THE WHOLE FLEET. 47 lorries and 170 trips in a busy
// fortnight, and the owner asked for it to work when they have the maximum
// number of vehicles. So: blocks collapse, the table scrolls sideways inside
// its own box rather than pushing the page, paging is BY LORRY so a subtotal
// never lands on a different page from the rows it totals, and the print rule
// keeps one lorry's block on one sheet.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import GlobalPagination, { usePagination } from '../components/GlobalPagination';

const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The two halves of the page. Named because they are used in about forty
// places below and a stray hex would silently break the fold.
const EXP = 'rgba(255,107,129,0.055)';
const INC = 'rgba(47,227,155,0.055)';
const EDGE = '2px solid #3d548a';
const HEAD = 'rgba(26,34,56,0.5)';
const CELL = 'rgba(26,34,56,0.35)';

export default function BillReport({ api, periodFrom, apiJson, onOpen, Badge }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [company, setCompany] = useState('');
  const [shut, setShut] = useState(() => new Set());     // collapsed lorries
  const [onlyLoss, setOnlyLoss] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const qs = new URLSearchParams({ period_from: periodFrom });
      if (company) qs.set('company', company);
      setData(await apiJson(`${api}/report?${qs}`));
    } catch (e) { setErr(e?.message ?? 'report nahi bani'); setData(null); }
    setBusy(false);
  }, [api, apiJson, periodFrom, company]);
  useEffect(() => { load(); }, [load]);

  const vehicles = useMemo(() => {
    const v = data?.vehicles ?? [];
    return onlyLoss ? v.filter((x) => n2(x.subtotal.net) < 0) : v;
  }, [data, onlyLoss]);

  const pg = usePagination(vehicles, { defaultSize: 10 });
  useEffect(() => { pg.setPage(1); }, [periodFrom, company, onlyLoss]);

  const toggle = (k) => setShut((s) => {
    const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n;
  });

  const g = data?.grand ?? {};

  const th = (bg, align) => ({
    padding: '7px 9px', textAlign: align ?? 'left', fontSize: '9.5px',
    textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8fa2c6',
    borderBottom: '1px solid #27395f', whiteSpace: 'nowrap', background: bg,
  });
  const td = (bg, align) => ({
    padding: '6px 9px', borderBottom: '1px solid #18244a', color: '#c4d1ea',
    background: bg, textAlign: align ?? 'left', whiteSpace: 'nowrap',
    fontVariantNumeric: align === 'right' ? 'tabular-nums' : 'normal',
  });
  const foot = (bg, align) => ({
    ...td(bg, align), borderTop: '2px solid #3d548a', borderBottom: 'none', fontWeight: 600,
  });

  return (
    <div className="glass-card" style={{ padding: '18px' }} id="pt-bill-report">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #pt-bill-report, #pt-bill-report * { visibility: visible; }
          #pt-bill-report { position: absolute; left: 0; top: 0; width: 100%; }
          .pt-noprint { display: none !important; }
          .pt-veh { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      {/* ── the bill's masthead ───────────────────────────────────────── */}
      <div style={{ borderBottom: '2px solid #27395f', paddingBottom: '13px', marginBottom: '15px',
                    display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '17px', fontWeight: 800, color: '#fff' }}>
            {company || 'SAARI COMPANY'}
          </div>
          <div style={{ fontSize: '12px', color: '#9aadd4', marginTop: '3px' }}>
            Vehicle-wise Settlement · <b style={{ color: '#22d3ee' }}>{data?.period?.label ?? ''}</b>
          </div>
          <div style={{ fontSize: '11.5px', color: '#5d7196', marginTop: '2px', fontFamily: 'monospace' }}>
            Period: {data?.period?.from} to {data?.period?.to}
          </div>
        </div>
        <div className="pt-noprint" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {(data?.companies?.length ?? 0) > 1 && (
            <select value={company} onChange={(e) => setCompany(e.target.value)}
              style={{ background: '#0a1024', border: '1px solid #3d548a', borderRadius: '8px',
                       color: '#eef3ff', padding: '7px 10px', fontSize: '12px' }}>
              <option value="">-- Saari company --</option>
              {data.companies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <button onClick={() => setOnlyLoss(!onlyLoss)}
            style={{ background: onlyLoss ? 'rgba(255,107,129,0.16)' : 'transparent',
                     color: onlyLoss ? '#ff6b81' : '#9aadd4',
                     border: '1px solid ' + (onlyLoss ? 'rgba(255,107,129,0.5)' : '#27395f'),
                     borderRadius: '8px', padding: '7px 12px', fontSize: '12px',
                     fontWeight: 700, cursor: 'pointer' }}>
            🔻 Sirf ghate wali
          </button>
          <button onClick={() => setShut((s) => (s.size ? new Set() : new Set(vehicles.map((v) => v.vehicle_key))))}
            style={{ background: 'transparent', color: '#9aadd4', border: '1px solid #27395f',
                     borderRadius: '8px', padding: '7px 12px', fontSize: '12px', cursor: 'pointer' }}>
            {shut.size ? '▾ Sab kholein' : '▸ Sab band karein'}
          </button>
          <button onClick={() => window.print()}
            style={{ background: 'rgba(34,211,238,0.13)', color: '#22d3ee',
                     border: '1px solid rgba(34,211,238,0.45)', borderRadius: '8px',
                     padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
            🖨️ Print
          </button>
        </div>
      </div>

      {err && <p style={{ color: '#ff6b81', fontSize: '13px' }}>{err}</p>}
      {busy && <p style={{ color: '#ffb224', padding: '20px', textAlign: 'center' }}>Bill ban rahi hai…</p>}

      {!busy && vehicles.length === 0 && !err && (
        <p style={{ color: '#5d7196', textAlign: 'center', padding: '26px', fontSize: '13px' }}>
          {onlyLoss ? 'Is cycle me koi lorry ghate me nahi hai.' : 'Is cycle me koi COMPLETED trip nahi mila.'}
        </p>
      )}

      {/* ── which half is which, said once ───────────────────────────── */}
      {vehicles.length > 0 && (
        <div style={{ display: 'flex', marginBottom: '10px', borderRadius: '8px',
                      overflow: 'hidden', border: '1px solid #27395f' }}>
          <div style={{ flex: 1, background: EXP, padding: '7px 12px', borderRight: EDGE }}>
            <b style={{ color: '#ff6b81', fontSize: '11.5px' }}>◀ KHARCH (EXPENSE)</b>
            <span style={{ color: '#5d7196', fontSize: '10.5px', marginLeft: '8px' }}>
              HSD · Toll · Anya
            </span>
          </div>
          <div style={{ flex: 1, background: INC, padding: '7px 12px', textAlign: 'right' }}>
            <span style={{ color: '#5d7196', fontSize: '10.5px', marginRight: '8px' }}>
              Qty · RTKM · Rate
            </span>
            <b style={{ color: '#2fe39b', fontSize: '11.5px' }}>FREIGHT / AAMDANI (INCOME) ▶</b>
          </div>
        </div>
      )}

      {/* ── lorry by lorry ───────────────────────────────────────────── */}
      {pg.slice.map((v) => {
        const st = v.subtotal;
        const closed = shut.has(v.vehicle_key);
        const net = n2(st.net);
        return (
          <div key={v.vehicle_key} className="pt-veh"
               style={{ border: '1px solid #27395f', borderRadius: '10px', overflow: 'hidden',
                        marginBottom: '11px' }}>

            <div onClick={() => toggle(v.vehicle_key)}
                 style={{ display: 'flex', justifyContent: 'space-between', gap: '12px',
                          alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer',
                          background: 'rgba(26,34,56,0.85)', padding: '9px 13px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flexWrap: 'wrap' }}>
                <span className="pt-noprint" style={{ color: '#5d7196', fontSize: '11px', width: '9px' }}>
                  {closed ? '▸' : '▾'}
                </span>
                <b style={{ color: '#fff', fontFamily: 'monospace', fontSize: '14px' }}>{v.vehicle_no}</b>
                <span style={{ color: '#5d7196', fontSize: '11px' }}>{v.operating_company}</span>
                <span style={{ color: '#9aadd4', fontSize: '11px' }}>{st.trips} trip</span>
                {v.status && Badge && <Badge status={v.status} small />}
              </span>
              <span style={{ display: 'flex', gap: '14px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#ff6b81', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                  ◀ {inr(st.expense_all)}
                </span>
                <span style={{ color: '#2fe39b', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                  {inr(st.income)} ▶
                </span>
                <b style={{ color: net >= 0 ? '#2fe39b' : '#ff6b81', fontSize: '14px',
                            fontVariantNumeric: 'tabular-nums', minWidth: '104px', textAlign: 'right' }}>
                  {net >= 0 ? '' : '−'}{inr(Math.abs(net))}
                </b>
                {v.settlement_id && (
                  <button className="pt-noprint"
                    onClick={(e) => { e.stopPropagation(); onOpen?.(v.settlement_id); }}
                    style={{ background: 'transparent', border: '1px solid #3d548a', color: '#22d3ee',
                             borderRadius: '6px', padding: '3px 9px', fontSize: '11px',
                             fontWeight: 700, cursor: 'pointer' }}>
                    Kholein →
                  </button>
                )}
              </span>
            </div>

            {!closed && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: '1010px', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr>
                      <th style={th(HEAD)}>SNo</th>
                      <th style={th(HEAD)}>Trip / Bill No.</th>
                      <th style={th(HEAD)}>Date</th>
                      {/* ◀ EXPENSE */}
                      <th style={th(EXP, 'right')}>HSD</th>
                      <th style={th(EXP, 'right')}>Toll</th>
                      <th style={th(EXP, 'right')}>Anya</th>
                      <th style={{ ...th(EXP, 'right'), borderRight: EDGE, color: '#ff6b81' }}>Kul kharch</th>
                      {/* INCOME ▶ */}
                      <th style={th(INC)}>Ship-to-party</th>
                      <th style={th(INC, 'right')}>Qty (KL)</th>
                      <th style={th(INC, 'right')}>RTKM</th>
                      <th style={th(INC, 'right')}>Rate</th>
                      <th style={{ ...th(INC, 'right'), color: '#2fe39b' }}>Freight (Rs.)</th>
                      <th style={th(HEAD, 'right')}>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.trips.map((t, i) => {
                      const other = n2(t.tyre) + n2(t.maintenance) + n2(t.other);
                      const tn = n2(t.billed) - n2(t.expense_total);
                      return (
                        <tr key={t.trip_id}>
                          <td style={td(CELL)}>{i + 1}</td>
                          <td style={{ ...td(CELL), fontFamily: 'monospace', color: '#22d3ee' }}>
                            {t.iocl_bill_no || t.trip_code}
                            {t.challan_no && (
                              <div style={{ fontSize: '9.5px', color: '#5d7196' }}>ch. {t.challan_no}</div>
                            )}
                          </td>
                          <td style={{ ...td(CELL), color: '#9aadd4' }}>
                            {t.unloading_date ?? t.loading_date}
                          </td>
                          <td style={td(EXP, 'right')}>{n2(t.hsd) ? inr(t.hsd) : '—'}</td>
                          <td style={td(EXP, 'right')}>{n2(t.toll) ? inr(t.toll) : '—'}</td>
                          <td style={td(EXP, 'right')}>{other ? inr(other) : '—'}</td>
                          <td style={{ ...td(EXP, 'right'), borderRight: EDGE, color: '#ff6b81' }}>
                            {inr(t.expense_total)}
                          </td>
                          <td style={{ ...td(INC), maxWidth: '210px', overflow: 'hidden',
                                       textOverflow: 'ellipsis' }}>
                            {t.customer_name}
                            {t.unloading_location && (
                              <div style={{ fontSize: '9.5px', color: '#5d7196' }}>{t.unloading_location}</div>
                            )}
                          </td>
                          <td style={td(INC, 'right')}>{n2(t.loaded_qty).toFixed(3)}</td>
                          <td style={td(INC, 'right')}>{n2(t.rtkm) || '—'}</td>
                          <td style={td(INC, 'right')}>{n2(t.rate) ? n2(t.rate).toFixed(4) : '—'}</td>
                          <td style={{ ...td(INC, 'right'), color: '#2fe39b', fontWeight: 600 }}>
                            {n2(t.billed) ? inr2(t.billed) : (
                              <span style={{ color: '#ffb224' }} title="Is trip ki billing abhi nahi hui">
                                billing baaki
                              </span>
                            )}
                          </td>
                          <td style={{ ...td(CELL, 'right'), fontWeight: 700,
                                       color: tn >= 0 ? '#2fe39b' : '#ff6b81' }}>
                            {tn >= 0 ? '' : '−'}{inr(Math.abs(tn))}
                          </td>
                        </tr>
                      );
                    })}

                    {/* A manual adjustment belongs to the LORRY, not to any one
                        trip — the same place the reviewer entered it. */}
                    {(n2(st.adj_expense) > 0 || n2(st.adj_income) > 0) && (
                      <tr>
                        <td style={td('rgba(167,139,250,0.07)')} />
                        <td colSpan={2} style={{ ...td('rgba(167,139,250,0.07)'), color: '#c4b5fd' }}>
                          ✏️ Manual adjustment
                        </td>
                        <td colSpan={3} style={td('rgba(167,139,250,0.07)')} />
                        <td style={{ ...td('rgba(167,139,250,0.07)', 'right'), borderRight: EDGE, color: '#c4b5fd' }}>
                          {n2(st.adj_expense) ? inr2(st.adj_expense) : '—'}
                        </td>
                        <td colSpan={4} style={td('rgba(167,139,250,0.07)')} />
                        <td style={{ ...td('rgba(167,139,250,0.07)', 'right'), color: '#c4b5fd' }}>
                          {n2(st.adj_income) ? inr2(st.adj_income) : '—'}
                        </td>
                        <td style={td('rgba(167,139,250,0.07)')} />
                      </tr>
                    )}
                  </tbody>

                  {/* ── Subtotal for Vehicle — the oil company's own line ── */}
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ ...foot('rgba(26,34,56,0.9)'), fontWeight: 700, color: '#eef3ff' }}>
                        Subtotal for Vehicle:{' '}
                        <span style={{ fontFamily: 'monospace' }}>{v.vehicle_no}</span>
                      </td>
                      <td style={foot(EXP, 'right')}>{inr2(st.hsd)}</td>
                      <td style={foot(EXP, 'right')}>{inr2(st.toll)}</td>
                      <td style={foot(EXP, 'right')}>{inr2(st.other)}</td>
                      <td style={{ ...foot(EXP, 'right'), borderRight: EDGE, color: '#ff6b81', fontWeight: 800 }}>
                        {inr2(st.expense_all)}
                      </td>
                      <td style={foot(INC)} />
                      <td style={foot(INC, 'right')}>{n2(st.qty).toFixed(3)}</td>
                      <td style={foot(INC, 'right')}>{n2(st.rtkm).toFixed(0)}</td>
                      <td style={foot(INC)} />
                      <td style={{ ...foot(INC, 'right'), color: '#2fe39b', fontWeight: 800 }}>
                        {inr2(st.income)}
                      </td>
                      <td style={{ ...foot('rgba(26,34,56,0.9)', 'right'), fontWeight: 800, fontSize: '13px',
                                   color: net >= 0 ? '#2fe39b' : '#ff6b81' }}>
                        {net >= 0 ? '' : '−'}{inr2(Math.abs(net))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {vehicles.length > 0 && (
        <div className="pt-noprint"><GlobalPagination {...pg} label="lorry" /></div>
      )}

      {/* ── Total of All Vehicles ────────────────────────────────────── */}
      {/* The whole fortnight, never just this page. A bill whose foot changes
          when you turn the page is not a bill. */}
      {vehicles.length > 0 && (
        <div style={{ marginTop: '14px', border: '2px solid #3d548a', borderRadius: '11px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 250px', background: EXP, padding: '14px 17px', borderRight: EDGE }}>
              <div style={{ fontSize: '10.5px', color: '#8fa2c6', textTransform: 'uppercase',
                            letterSpacing: '0.08em' }}>◀ Kul kharch</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: '#ff6b81',
                            fontVariantNumeric: 'tabular-nums', marginTop: '5px' }}>
                {inr2(g.expense_all)}
              </div>
              <div style={{ fontSize: '10.5px', color: '#5d7196', marginTop: '5px' }}>
                HSD {inr(g.hsd)} · Toll {inr(g.toll)}
                {n2(g.adj_expense) ? ` · manual ${inr(g.adj_expense)}` : ''}
              </div>
            </div>
            <div style={{ flex: '1 1 250px', background: INC, padding: '14px 17px', textAlign: 'right' }}>
              <div style={{ fontSize: '10.5px', color: '#8fa2c6', textTransform: 'uppercase',
                            letterSpacing: '0.08em' }}>Kul freight / aamdani ▶</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: '#2fe39b',
                            fontVariantNumeric: 'tabular-nums', marginTop: '5px' }}>
                {inr2(g.income)}
              </div>
              <div style={{ fontSize: '10.5px', color: '#5d7196', marginTop: '5px' }}>
                {n2(g.qty).toFixed(3)} KL · {n2(g.rtkm).toLocaleString('en-IN')} rtkm
              </div>
            </div>
          </div>
          <div style={{ background: 'rgba(26,34,56,0.95)', padding: '13px 17px', display: 'flex',
                        justifyContent: 'space-between', alignItems: 'center', gap: '12px',
                        flexWrap: 'wrap', borderTop: '1px solid #3d548a' }}>
            <b style={{ color: '#eef3ff', fontSize: '13.5px' }}>
              Total of All Vehicles
              <span style={{ color: '#5d7196', fontWeight: 400, fontSize: '11.5px', marginLeft: '9px' }}>
                {g.vehicles} lorry · {g.trips} trip · {data?.period?.label}
              </span>
            </b>
            <b style={{ fontSize: '25px', fontVariantNumeric: 'tabular-nums',
                        color: n2(g.net) >= 0 ? '#2fe39b' : '#ff6b81' }}>
              {n2(g.net) >= 0 ? '' : '−'}{inr2(Math.abs(n2(g.net)))}
            </b>
          </div>
        </div>
      )}
    </div>
  );
}
