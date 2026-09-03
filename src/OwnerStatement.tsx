// @ts-nocheck
// ============================================================================
// 🧾 VEHICLE OWNER STATEMENT — IOCL e-TRP style, multi-entity aware.
//
// WHY THERE ARE TWO VIEWS AND NOT ONE NUMBER. 15 of 49 trucks run loads under
// more than one operating company, so an owner's fleet genuinely earns money
// inside separate sets of books. "What do we owe Santosh?" therefore has one
// answer per entity plus a total, and collapsing that to a single figure would
// hide which company's cash is actually paying him.
//
//   View A (Entity)       one company selected  → that company's books only
//   View B (Consolidated) no company selected   → every entity, split, + total
//
// UNBILLED TRIPS ARE SHOWN, NOT HIDDEN. Many trips carry no billed_amount yet,
// so their gross freight is genuinely zero and a statement can come out
// NEGATIVE — advances paid against freight not yet billed. That is the books
// telling the truth about a data-entry gap. Suppressing it would produce a
// statement that looks clean and is wrong; the count is printed next to the
// total instead, so whoever signs it knows what is missing.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from './lib/apiBase';
import { openWaDeepLink } from './lib/waSend';

const API = API_BASE;

const money = (n) => {
  const v = Number(n ?? 0);
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const dmy = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return String(d); }
};

export default function OwnerStatement() {
  const [owners, setOwners] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [owner, setOwner] = useState('');
  const [companyId, setCompanyId] = useState('');       // '' = consolidated
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [o, c] = await Promise.all([
          fetch(`${API}/api/v1/owners`).then((r) => r.json()),
          // Companies live under the finance prefix (cashbook.routes registers
          // there); /api/v1/masters/companies is a different, 404 path.
          fetch(`${API}/api/v1/finance/companies`).then((r) => r.json()).catch(() => ({ companies: [] })),
        ]);
        setOwners(o.owners ?? []);
        setCompanies(c.companies ?? c.rows ?? []);
        // Arriving from the dashboard's Owner Fleet Matrix: open on the owner
        // that was clicked instead of making them pick the same name again.
        let handed = null;
        try {
          handed = sessionStorage.getItem('pt_owner_statement_owner');
          if (handed) sessionStorage.removeItem('pt_owner_statement_owner');
        } catch { /* private mode */ }
        const known = (o.owners ?? []).some((x) => x.owner === handed);
        if (handed && known) setOwner(handed);
        else if (o.owners?.length) setOwner(o.owners[0].owner);
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!owner) return;
    setLoading(true); setErr(null);
    try {
      const q = new URLSearchParams({ owner });
      if (companyId) q.set('company_id', companyId);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      const res = await fetch(`${API}/api/v1/owners/statement?${q}`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      setData(await res.json());
    } catch (e) { setErr(e.message); setData(null); }
    finally { setLoading(false); }
  }, [owner, companyId, from, to]);

  useEffect(() => { load(); }, [load]);

  const g = data?.grand_total;
  const consolidated = !companyId;

  // ── CSV ───────────────────────────────────────────────────────────────────
  const exportCsv = () => {
    if (!data) return;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Statement Ref', data.statement_ref],
      ['Owner', data.owner],
      ['Scope', data.scope],
      ['Period', `${data.window.from ?? 'all'} to ${data.window.to ?? 'all'}`],
      [],
      ['Company', 'Vehicle', 'Trips', 'Unbilled', 'Gross Freight', 'Commission', 'Fuel', 'Toll', 'Advances', 'Shortage', 'Net Payable'],
      ...data.by_vehicle.map((v) => [
        v.company_name?.trim(), v.vehicle_no, v.trips, v.unbilled_trips,
        v.gross_freight, v.commission, v.fuel, v.toll, v.advances, v.shortage, v.net_payable,
      ]),
      [],
      ['GRAND TOTAL', '', g?.trips, g?.unbilled_trips, g?.gross_freight, g?.commission,
       g?.fuel, g?.toll, g?.advances, g?.shortage, g?.net_payable],
    ];
    const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.statement_ref.replace(/\//g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  // Sends the SUMMARY as text, not a PDF: there is no file transport to the
  // engine from here, and a link to a login-protected page is useless to an
  // owner who has no account. The numbers that matter travel in the message;
  // the printed statement follows on paper or as a PDF the office attaches.
  const shareWhatsApp = () => {
    if (!data) return;
    const lines = [
      `*${data.owner}* — Vehicle Owner Statement`,
      `Ref: ${data.statement_ref}`,
      `Period: ${data.window.from ?? 'beginning'} to ${data.window.to ?? 'date'}`,
      '',
      ...data.by_entity.map((e) => `${e.company_name.trim()}: ₹${money(e.net_payable)}`),
      '',
      `*NET PAYABLE: ₹${money(g?.net_payable)}*`,
      `(${g?.trips} trips${g?.unbilled_trips > 0 ? `, ${g.unbilled_trips} not yet billed` : ''})`,
      '',
      '— Prasad Transport',
    ];
    openWaDeepLink('', lines.join('\n'));
  };

  return (
    <div className="os-root" style={{ color: '#dde5f4', fontFamily: "'Inter', sans-serif", paddingBottom: 40 }}>
      <style>{`
        .os-tbl { width:100%; border-collapse:collapse; font-size:12px; }
        .os-tbl th { background:#18244a; color:#9aadd4; font-size:10px; text-transform:uppercase;
                     letter-spacing:.06em; padding:8px 6px; text-align:right; white-space:nowrap; }
        .os-tbl th:first-child, .os-tbl td:first-child { text-align:left; }
        .os-tbl td { padding:7px 6px; text-align:right; border-bottom:1px solid #18244a; white-space:nowrap; }
        .os-tbl tbody tr:hover { background:rgba(34, 211, 238,.06); }
        .os-total td { font-weight:900; background:rgba(47, 227, 155,.10); border-top:2px solid #2fe39b; }
        .os-scroll { overflow-x:auto; }

        /* ── A4 PRINT ────────────────────────────────────────────────────────
           The screen is dark and the page is not: printing the dark theme
           costs a full ink cartridge and reads badly. Everything is forced to
           black-on-white, the app chrome and controls are removed, and tables
           are told not to break a row across pages. */
        @media print {
          @page { size: A4; margin: 12mm 10mm; }
          body { background:#fff !important; }
          .no-print, .no-print * { display:none !important; }
          .os-root { color:#000 !important; padding:0 !important; }
          .os-root * { color:#000 !important; background:transparent !important;
                       box-shadow:none !important; }
          .os-tbl th { background:#eee !important; border-bottom:1px solid #000; font-size:8.5px; }
          .os-tbl td { border-bottom:1px solid #ddd; font-size:9px; padding:4px 3px; }
          .os-total td { background:#f2f2f2 !important; border-top:1.5px solid #000; }
          .os-card { border:1px solid #999 !important; border-radius:0 !important;
                     page-break-inside:avoid; margin-bottom:8mm; }
          .os-scroll { overflow:visible !important; }
          tr, .os-avoid-break { page-break-inside:avoid; }
          thead { display:table-header-group; }   /* repeat headers on every page */
          .os-print-only { display:block !important; }
        }
        .os-print-only { display:none; }
      `}</style>

      {/* ── controls (never printed) ─────────────────────────────────────── */}
      <div className="no-print" style={{ marginBottom: 22 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 26, fontWeight: 900, color: '#22d3ee' }}>
          🧾 Vehicle Owner Statement
        </h1>
        <p style={{ margin: '0 0 16px', color: '#9aadd4', fontSize: 13 }}>
          Owner khata across all operating entities — IOCL e-TRP style, print &amp; share ready.
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end',
                      background: 'rgba(24, 36, 74,.5)', padding: 16, borderRadius: 14, border: '1px solid #27395f' }}>
          <Field label="Owner">
            <select value={owner} onChange={(e) => setOwner(e.target.value)} style={inp}>
              {owners.map((o) => (
                <option key={o.owner} value={o.owner}>
                  {o.owner} ({o.trucks} trucks{o.attached_trucks > 0 ? `, ${o.attached_trucks} attached` : ''})
                </option>
              ))}
            </select>
          </Field>
          <Field label="View">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={inp}>
              <option value="">— Group Consolidated (all entities) —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{(c.company_name ?? c.name ?? '').trim()}</option>
              ))}
            </select>
          </Field>
          <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inp} /></Field>
          <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inp} /></Field>
          <button onClick={() => window.print()} style={btn('#22d3ee')}>🖨️ Print / PDF</button>
          <button onClick={exportCsv} style={btn('#2fe39b')}>⬇ CSV</button>
          <button onClick={shareWhatsApp} style={btn('#25D366')}>💬 WhatsApp</button>
        </div>
      </div>

      {loading && <p style={{ color: '#9aadd4' }}>Loading statement…</p>}
      {err && (
        <div style={{ padding: 14, border: '1px solid #ffb224', borderRadius: 10, color: '#fcd34d', background: 'rgba(255, 178, 36,.08)' }}>
          Statement unavailable — {err}
        </div>
      )}

      {data && !loading && (
        <>
          {/* ── letterhead ───────────────────────────────────────────────── */}
          <div className="os-card os-avoid-break" style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '.04em' }}>PRASAD TRANSPORT</div>
                <div style={{ fontSize: 11, color: '#9aadd4' }}>Bongaigaon, Assam · Transport &amp; Logistics</div>
                <div style={{ marginTop: 12, fontSize: 13 }}>
                  <b>Owner:</b> {data.owner}
                </div>
                <div style={{ fontSize: 11, color: '#9aadd4' }}>
                  {consolidated ? 'Group consolidated — all operating entities' : 'Entity-specific statement'}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 11.5 }}>
                <div style={{ fontSize: 15, fontWeight: 900, marginBottom: 6 }}>OWNER STATEMENT</div>
                <div><b>Ref:</b> {data.statement_ref}</div>
                <div><b>Period:</b> {data.window.from ? dmy(data.window.from) : 'Beginning'} — {data.window.to ? dmy(data.window.to) : 'To date'}</div>
                <div><b>Generated:</b> {dmy(data.generated_at)}</div>
              </div>
            </div>
          </div>

          {/* ── View B: entity split ─────────────────────────────────────── */}
          <div className="os-card os-avoid-break" style={card}>
            <SectionTitle>
              {consolidated ? 'Net Payable by Operating Entity' : 'Entity Summary'}
            </SectionTitle>
            <div className="os-scroll">
              <table className="os-tbl">
                <thead>
                  <tr>
                    <th>Operating Entity</th><th>Trips</th><th>Gross Freight</th><th>Commission</th>
                    <th>Fuel</th><th>Toll</th><th>Advances</th><th>Shortage</th><th>Net Payable</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_entity.map((e) => (
                    <tr key={e.company_id}>
                      <td>{e.company_name.trim()}</td>
                      <td>{e.trips}{e.unbilled_trips > 0 && <span style={{ color: '#ffb224' }}> ({e.unbilled_trips} unbilled)</span>}</td>
                      <td>{money(e.gross_freight)}</td>
                      <td>{money(e.commission)}</td>
                      <td>{money(e.fuel)}</td>
                      <td>{money(e.toll)}</td>
                      <td>{money(e.advances)}</td>
                      <td>{money(e.shortage)}</td>
                      <td style={{ fontWeight: 800, color: Number(e.net_payable) < 0 ? '#ff8b9c' : '#2fe39b' }}>
                        {money(e.net_payable)}
                      </td>
                    </tr>
                  ))}
                  {data.by_entity.length === 0 && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: '#5d7196', padding: 18 }}>
                      No trips for this owner in the selected period.
                    </td></tr>
                  )}
                  {g && (
                    <tr className="os-total">
                      <td>GRAND TOTAL PAYABLE</td>
                      <td>{g.trips}</td>
                      <td>{money(g.gross_freight)}</td><td>{money(g.commission)}</td>
                      <td>{money(g.fuel)}</td><td>{money(g.toll)}</td>
                      <td>{money(g.advances)}</td><td>{money(g.shortage)}</td>
                      <td>{money(g.net_payable)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {g?.unbilled_trips > 0 && (
              <p style={{ marginTop: 10, fontSize: 11, color: '#fcd34d' }}>
                ⚠ {g.unbilled_trips} of {g.trips} trips carry no billed freight yet, so their gross is nil.
                Any negative figure above is advances paid against freight that has not been billed —
                bill those trips and this statement corrects itself.
              </p>
            )}
          </div>

          {/* ── vehicle-wise grid ────────────────────────────────────────── */}
          <div className="os-card" style={card}>
            <SectionTitle>Vehicle-wise Summary</SectionTitle>
            <div className="os-scroll">
              <table className="os-tbl">
                <thead>
                  <tr>
                    <th>Vehicle No</th>{consolidated && <th style={{ textAlign: 'left' }}>Entity</th>}
                    <th>Type</th><th>Trips</th><th>Gross Freight</th><th>Commission</th>
                    <th>Fuel</th><th>Toll</th><th>Advances</th><th>Shortage</th><th>Net Payable</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_vehicle.map((v, i) => (
                    <tr key={`${v.company_id}-${v.vehicle_no}-${i}`}>
                      <td style={{ fontWeight: 700 }}>{v.vehicle_no}</td>
                      {consolidated && <td style={{ textAlign: 'left', fontSize: 10.5 }}>{v.company_name.trim()}</td>}
                      <td>{v.is_attached ? 'ATTACHED' : 'OWNED'}</td>
                      <td>{v.trips}</td>
                      <td>{money(v.gross_freight)}</td>
                      <td>{money(v.commission)}</td>
                      <td>{money(v.fuel)}</td>
                      <td>{money(v.toll)}</td>
                      <td>{money(v.advances)}</td>
                      <td>{money(v.shortage)}</td>
                      <td style={{ fontWeight: 800 }}>{money(v.net_payable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── itemised trip log ────────────────────────────────────────── */}
          <div className="os-card" style={card}>
            <SectionTitle>
              Itemised Trip Log{data.trips_truncated ? ` (first ${data.trips_limit} of more)` : ` (${data.trips.length})`}
            </SectionTitle>
            {data.trips_truncated && (
              <p className="no-print" style={{ fontSize: 11, color: '#fcd34d', marginBottom: 8 }}>
                ⚠ Only the most recent {data.trips_limit} trips are listed — narrow the date range for a complete log.
              </p>
            )}
            <div className="os-scroll">
              <table className="os-tbl">
                <thead>
                  <tr>
                    <th>Date</th><th style={{ textAlign: 'left' }}>Trip / LR</th><th style={{ textAlign: 'left' }}>Vehicle</th>
                    <th style={{ textAlign: 'left' }}>Route</th><th style={{ textAlign: 'left' }}>Diesel Slip</th>
                    <th>Freight</th><th>Comm.</th><th>Fuel</th><th>Toll</th><th>Advance</th><th>Shortage</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trips.map((t, i) => (
                    <tr key={`${t.trip_code}-${i}`}>
                      <td style={{ textAlign: 'left' }}>{dmy(t.loading_date)}</td>
                      <td style={{ textAlign: 'left' }}>{t.trip_code}{t.challan_no ? ` / ${t.challan_no}` : ''}</td>
                      <td style={{ textAlign: 'left' }}>{t.vehicle_no}</td>
                      <td style={{ textAlign: 'left', maxWidth: 220, whiteSpace: 'normal' }}>
                        {(t.loading_point ?? '?')} → {(t.destination ?? '?')}
                      </td>
                      <td style={{ textAlign: 'left' }}>{t.diesel_slips ?? '—'}</td>
                      <td>{money(t.gross_freight)}</td>
                      <td>{money(t.commission)}</td>
                      <td>{money(t.fuel)}</td>
                      <td>{money(t.toll)}</td>
                      <td>{money(t.advances)}</td>
                      <td>{money(t.shortage)}</td>
                    </tr>
                  ))}
                  {data.trips.length === 0 && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: '#5d7196', padding: 18 }}>No trips.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="os-print-only" style={{ marginTop: '14mm', fontSize: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Prepared by ______________</span>
              <span>Checked by ______________</span>
              <span>Owner acknowledgement ______________</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const card = {
  background: 'rgba(24, 36, 74,.45)', border: '1px solid #27395f',
  borderRadius: 14, padding: 18, marginBottom: 18,
};
const inp = {
  background: '#121c38', color: '#dde5f4', border: '1px solid #27395f',
  borderRadius: 9, padding: '9px 11px', fontSize: 13, minWidth: 170,
};
const btn = (c) => ({
  background: c, color: '#04121f', border: 'none', borderRadius: 9,
  padding: '10px 15px', fontWeight: 900, fontSize: 12.5, cursor: 'pointer',
});
const Field = ({ label, children }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', color: '#5d7196', textTransform: 'uppercase' }}>{label}</span>
    {children}
  </label>
);
const SectionTitle = ({ children }) => (
  <h2 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 900, letterSpacing: '.05em',
               textTransform: 'uppercase', color: '#22d3ee' }}>{children}</h2>
);
