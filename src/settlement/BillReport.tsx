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

  // The tree, with the loss filter applied at the lorry level and any owner or
  // company that empties as a result dropped with it.
  const tree = useMemo(() => {
    const cs = data?.companies ?? [];
    if (!onlyLoss) return cs;
    return cs
      .map((c) => ({ ...c, owners: c.owners
        .map((o) => ({ ...o, vehicles: o.vehicles.filter((v) => n2(v.subtotal.net) < 0) }))
        .filter((o) => o.vehicles.length) }))
      .filter((c) => c.owners.length);
  }, [data, onlyLoss]);

  const vehicles = useMemo(
    () => tree.flatMap((c) => c.owners.flatMap((o) => o.vehicles)), [tree]);

  // Every key the tree can collapse, so "sab band karein" closes all three
  // levels rather than only the one it happens to know about.
  const allKeys = useMemo(() => {
    const k = [];
    for (const c of tree) {
      k.push('CO:' + c.company);
      for (const o of c.owners) {
        k.push('OW:' + c.company + '|' + o.owner_name);
        for (const v of o.vehicles) k.push(v.vehicle_key);
      }
    }
    return k;
  }, [tree]);

  // OPENS ON THE SHAPE THE OWNER ASKED FOR: company, then whose lorry. The
  // trips are one click away rather than 170 rows of them on arrival.
  useEffect(() => {
    if (!data) return;
    const shutV = new Set();
    for (const c of data.companies ?? []) {
      for (const o of c.owners) for (const v of o.vehicles) shutV.add(v.vehicle_key);
    }
    setShut(shutV);
  }, [data]);

  const toggle = (k) => setShut((s) => {
    const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n;
  });

  const g = data?.grand ?? {};

  /** One lorry's block on its own sheet — the row a person is looking at. */
  const printOne = (v) => {
    const w = window.open('', '_blank');
    if (!w) return;
    const st = v.subtotal;
    const rows = v.trips.map((t, i) => `<tr>
      <td>${i + 1}</td><td>${t.iocl_bill_no || t.trip_code || ''}</td>
      <td>${t.unloading_date ?? t.loading_date ?? ''}</td>
      <td class="r">${inr2(t.expense_total)}</td>
      <td>${(t.customer_name ?? '').slice(0, 34)}</td>
      <td class="r">${n2(t.loaded_qty).toFixed(3)}</td>
      <td class="r">${n2(t.rtkm) || '—'}</td>
      <td class="r">${n2(t.billed) ? inr2(t.billed) : 'billing baaki'}</td>
    </tr>`).join('');
    w.document.write(`<html><head><title>${v.vehicle_no} — ${data?.period?.label ?? ''}</title>
      <style>body{font-family:system-ui;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 3px}.sub{color:#666;font-size:12px;margin-bottom:14px}
      table{border-collapse:collapse;width:100%;font-size:12px}
      th{text-align:left;border-bottom:2px solid #333;padding:5px 7px;font-size:10px;
         text-transform:uppercase;letter-spacing:.06em;color:#444}
      td{padding:5px 7px;border-bottom:1px solid #e6e6e6}
      td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
      tfoot td{border-top:2px solid #333;border-bottom:none;font-weight:700}
      .note{margin-top:16px;font-size:11px;color:#666;line-height:1.5;max-width:70ch}</style>
      </head><body>
      <h1>${v.vehicle_no}</h1>
      <div class="sub">${v.operating_company ?? ''} · ${data?.period?.label ?? ''}
        · ${data?.period?.from} to ${data?.period?.to} · ${st.trips} trip</div>
      <table>
        <thead><tr><th>SNo</th><th>Trip / Bill No.</th><th>Date</th><th class="r">Kul kharch</th>
          <th>Ship-to-party</th><th class="r">Qty (KL)</th><th class="r">RTKM</th>
          <th class="r">Freight (Rs.)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="3">Subtotal for Vehicle: ${v.vehicle_no}</td>
          <td class="r">${inr2(st.expense_all)}</td><td></td>
          <td class="r">${n2(st.qty).toFixed(3)}</td><td class="r">${n2(st.rtkm).toFixed(0)}</td>
          <td class="r">${inr2(st.income)}</td>
        </tr></tfoot>
      </table>
      <div class="note">Net: ${inr2(st.net)}. Aamdani trip ke billed amount se li gayi hai.</div>
      </body></html>`);
    w.document.close(); w.focus(); w.print();
  };

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

  // ── ONE LORRY: its trips and its "Subtotal for Vehicle" ─────────────
  // Lifted out of the old flat list so it can be rendered at the bottom of
  // the company → owner → lorry tree without duplicating any of it.
  const renderVehicle = (v) => {
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
                {/* ── the staff's own controls, on the lorry itself ──────
                    The owner asked for edit / save / print / modify to be here
                    rather than only inside the drawer. Save is not offered on
                    this row: the figures a person edits are the expense buckets
                    and the adjustments, and those need the drawer's own fields.
                    A button that opens the right screen is honest; one that
                    pretends to save from a summary row is not.

                    MODIFY is what a locked settlement gets instead of EDIT.
                    Offering "edit" on an approved bill would offer a control
                    that the database refuses (P0409). */}
                <span className="pt-noprint" style={{ display: 'flex', gap: '5px' }}>
                  {v.settlement_id ? (
                    <>
                      <button onClick={(e) => { e.stopPropagation(); onOpen?.(v.settlement_id); }}
                        title={v.locked ? 'Bill locked hai — kholkar Reopen dabaiye'
                                        : 'Kharch aur adjustment badlein'}
                        style={{ background: v.locked ? 'rgba(255,178,36,0.13)' : 'rgba(47,227,155,0.13)',
                                 border: '1px solid ' + (v.locked ? 'rgba(255,178,36,0.5)' : 'rgba(47,227,155,0.5)'),
                                 color: v.locked ? '#ffb224' : '#2fe39b',
                                 borderRadius: '6px', padding: '3px 9px', fontSize: '11px',
                                 fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        {v.locked ? '🔓 Modify' : '✏️ Edit / Save'}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); printOne(v); }}
                        title="Sirf is lorry ka P&L print karein"
                        style={{ background: 'transparent', border: '1px solid #3d548a', color: '#9aadd4',
                                 borderRadius: '6px', padding: '3px 9px', fontSize: '11px',
                                 fontWeight: 700, cursor: 'pointer' }}>
                        🖨️
                      </button>
                    </>
                  ) : (
                    <span style={{ color: '#5d7196', fontSize: '10.5px' }}>draft nahi bana</span>
                  )}
                </span>
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
  };

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
          {(data?.companies_list?.length ?? 0) > 1 && (
            <select value={company} onChange={(e) => setCompany(e.target.value)}
              style={{ background: '#0a1024', border: '1px solid #3d548a', borderRadius: '8px',
                       color: '#eef3ff', padding: '7px 10px', fontSize: '12px' }}>
              <option value="">-- Saari company --</option>
              {data.companies_list.map((c) => <option key={c} value={c}>{c}</option>)}
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
          <button onClick={() => setShut((s) => (s.size ? new Set() : new Set(allKeys)))}
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


      {/* ── company → owner → lorry ──────────────────────────────────── */}
      {tree.map((c) => {
        const cShut = shut.has('CO:' + c.company);
        const cSt = c.subtotal;
        return (
          <div key={c.company} style={{ marginBottom: '18px' }}>

            {/* ── the FIRM whose books this is ──────────────────────── */}
            <div onClick={() => toggle('CO:' + c.company)}
                 style={{ display: 'flex', justifyContent: 'space-between', gap: '12px',
                          alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer',
                          background: 'linear-gradient(90deg, rgba(34,211,238,0.14), rgba(34,211,238,0.03))',
                          border: '1px solid rgba(34,211,238,0.4)', borderRadius: '10px',
                          padding: '11px 14px', marginBottom: '9px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span className="pt-noprint" style={{ color: '#22d3ee', fontSize: '11px', width: '9px' }}>
                  {cShut ? '▸' : '▾'}
                </span>
                <b style={{ color: '#fff', fontSize: '15.5px', letterSpacing: '0.01em' }}>{c.company}</b>
                <span style={{ color: '#5d7196', fontSize: '11px' }}>company / firm</span>
                <span style={{ color: '#9aadd4', fontSize: '11.5px' }}>
                  {c.owner_count} owner · {c.lorries} lorry · {cSt.trips} trip
                </span>
              </span>
              <span style={{ display: 'flex', gap: '15px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                <span className="num" style={{ color: '#ff6b81', fontSize: '12.5px' }}>
                  ◀ {inr(cSt.expense_all)}
                </span>
                <span className="num" style={{ color: '#2fe39b', fontSize: '12.5px' }}>
                  {inr(cSt.income)} ▶
                </span>
                <b style={{ color: n2(cSt.our_earning) >= 0 ? '#2fe39b' : '#ff6b81', fontSize: '15px',
                            fontVariantNumeric: 'tabular-nums', minWidth: '118px', textAlign: 'right' }}>
                  {inr(cSt.our_earning)}
                </b>
              </span>
            </div>

            {!cShut && c.owners.map((o) => {
              const oKey = 'OW:' + c.company + '|' + o.owner_name;
              const oShut = shut.has(oKey);
              const oSt = o.subtotal;
              const agency = o.fleet_classes?.some((f) => f === 'ATTACHED' || f === 'MARKET');
              return (
                <div key={oKey} style={{ marginLeft: '14px', marginBottom: '10px' }}>

                  {/* ── WHOSE LORRY it is ─────────────────────────────── */}
                  {/* The company above is whose BOOKS the trip is billed in;
                      this is whose LORRY ran it. AS 19C 8666 shows M/S PRASAD
                      TRANSPORT and belongs to SANTOSH PRASAD — two different
                      facts that the report used to fold into one line. */}
                  <div onClick={() => toggle(oKey)}
                       style={{ display: 'flex', justifyContent: 'space-between', gap: '12px',
                                alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer',
                                background: 'rgba(167,139,250,0.08)',
                                border: '1px solid rgba(167,139,250,0.32)',
                                borderRadius: '9px', padding: '9px 13px', marginBottom: '7px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
                      <span className="pt-noprint" style={{ color: '#c4b5fd', fontSize: '10.5px', width: '9px' }}>
                        {oShut ? '▸' : '▾'}
                      </span>
                      <span style={{ color: '#5d7196', fontSize: '10.5px' }}>👤 vehicle owner</span>
                      <b style={{ color: '#e9d5ff', fontSize: '13.5px' }}>{o.owner_name}</b>
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px',
                                     borderRadius: '5px',
                                     background: agency ? 'rgba(255,178,36,0.15)' : 'rgba(47,227,155,0.13)',
                                     color: agency ? '#ffb224' : '#2fe39b' }}>
                        {o.fleet_classes?.join(' + ') || '—'}
                      </span>
                      <span style={{ color: '#9aadd4', fontSize: '11px' }}>
                        {o.lorries} lorry · {oSt.trips} trip
                      </span>
                      {oSt.without_rate > 0 && (
                        <span style={{ color: '#ff6b81', fontSize: '10.5px' }}>
                          ⚠️ {oSt.without_rate} ka rate nahi
                        </span>
                      )}
                    </span>
                    <span style={{ display: 'flex', gap: '13px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <span className="num" style={{ color: '#9aadd4', fontSize: '11.5px' }}>
                        freight {inr(oSt.income)}
                      </span>
                      {agency ? (
                        <>
                          <span className="num" style={{ color: '#2fe39b', fontSize: '12px' }}>
                            hamara {inr(oSt.commission)}
                          </span>
                          <b className="num" style={{ color: '#c4b5fd', fontSize: '13.5px',
                                                      minWidth: '108px', textAlign: 'right' }}>
                            dena {inr(oSt.payable)}
                          </b>
                        </>
                      ) : (
                        <b className="num" style={{ color: n2(oSt.net) >= 0 ? '#2fe39b' : '#ff6b81',
                                                    fontSize: '13.5px', minWidth: '108px', textAlign: 'right' }}>
                          {inr(oSt.net)}
                        </b>
                      )}
                    </span>
                  </div>

                  {!oShut && o.vehicles.map((v) => renderVehicle(v))}
                </div>
              );
            })}
          </div>
        );
      })}

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
