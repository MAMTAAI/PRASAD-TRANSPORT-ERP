// @ts-nocheck
// ============================================================================
// OPERATIONS — COMMAND DECK (Home) · THE MARKET FLEET
//
// The owner's dual-fleet rule (2026-09-02): two businesses inside one company,
// two screens, no crossover.
//
//   Master Control v5.0   the OWN + permanently attached fleet — dispatch,
//                         loading register, unloading, maintenance, drivers.
//   Command Deck (this)   the MARKET fleet — fleet partners (vendors), market
//                         vehicles, Load Bazaar bidding, awards, settlements,
//                         and the market side of the books.
//
// Until this rewrite the deck showed the own fleet's trips and revenue under a
// market heading; today there is not one market vehicle in the database, and
// the honest deck says so rather than borrowing the other fleet's numbers.
// One read: GET /api/v1/bazaar/overview (staff). Nothing here is company-
// scoped because bazaar loads are not — the settlement carries the firm, and
// a settlement without one is flagged.
// ============================================================================
import React, { useEffect, useState, useCallback } from 'react';
import { API_BASE } from './lib/apiBase';
// The same drawer Master Control's tiles open: rows straight from the metric
// registry (server/lib/drilldownRegistry.js), paged, exportable as CSV, and
// counted by the same query that lists them.
import DrillDownViewer from './mastercontrol/DrillDownViewer';

const API = API_BASE;
const rs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const rL = (n) => {                                   // ₹ in lakh/crore, compact
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
  return rs(v);
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const day = (d) => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—');

// The settlement lifecycle (bazaarSettlement.routes.js), with what a person
// does next at each stage. Shown on every row so the desk never has to guess.
const STAGE = {
  AWAITING_CONFIRM: { l: 'Awaiting partner confirm', tone: 'warn', next: 'partner confirms in app' },
  CONFIRMED:        { l: 'Confirmed',                tone: 'info', next: 'partner assigns truck + driver' },
  VEHICLE_ASSIGNED: { l: 'Truck assigned',           tone: 'info', next: 'desk: release advance' },
  ADVANCE_PAID:     { l: 'Advance paid',             tone: 'ok',   next: 'partner uploads POD' },
  POD_SUBMITTED:    { l: 'POD uploaded',             tone: 'warn', next: 'desk: verify POD' },
  POD_VERIFIED:     { l: 'POD verified',             tone: 'ok',   next: 'desk: release balance' },
  SETTLED:          { l: 'Settled',                  tone: 'ok',   next: '' },
  CANCELLED:        { l: 'Cancelled',                tone: 'bad',  next: '' },
};

export default function OperationsDeck2026({ currentUser, onOpenConsole }) {
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(null);
  // A tile is a question; its drawer is the answer. `expected` is the number
  // on the tile, so the drawer says so if its rows disagree with it.
  const [drill, setDrill] = useState(null);
  const [flash, setFlash] = useState(null);
  const openTile = (metric, expected, panelId) => {
    const el = panelId ? document.getElementById(panelId) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setFlash(panelId);
      setTimeout(() => setFlash((f) => (f === panelId ? null : f)), 1800);
    }
    setDrill({ metric, expected });
  };
  const tileKeys = (fn) => ({
    role: 'button', tabIndex: 0, onClick: fn,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } },
  });

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`${API}/api/v1/bazaar/overview`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setOv(await r.json()); setAt(new Date());
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const L = ov?.loads ?? {};
  const S = ov?.settlements ?? {};
  const F = ov?.market_fleet ?? {};
  const P = ov?.partners ?? {};
  const M = ov?.money ?? {};
  const inProgress = S.in_progress ?? [];
  const board = L.board ?? [];
  const awardReq = L.award_requests ?? [];
  const nothingYet = !loading && ov && (F.active ?? 0) + (F.pending ?? 0) === 0
    && (L.open ?? 0) + (L.pending_review ?? 0) + (L.award_requested ?? 0) === 0 && inProgress.length === 0;

  // The queues a person clears, each with the screen that clears it.
  const desk = [
    { k: 'award', n: L.award_requested ?? 0, label: 'Award requests', hint: 'customer / partner chose — desk confirms', go: 'BAZAAR_ADMIN' },
    { k: 'review', n: L.pending_review ?? 0, label: 'Loads to review', hint: 'customer-posted, not yet open', go: 'BAZAAR_ADMIN' },
    { k: 'kyc', n: (P.kyc_vendor ?? 0) + (P.kyc_customer ?? 0), label: 'KYC', hint: `${P.kyc_vendor ?? 0} partner · ${P.kyc_customer ?? 0} customer`, go: 'BAZAAR_ADMIN' },
    { k: 'trucks', n: F.pending ?? 0, label: 'Market trucks', hint: 'awaiting approval', go: 'MARKET_VEHICLE' },
    { k: 'drivers', n: F.drivers_pending ?? 0, label: 'Market drivers', hint: 'awaiting approval', go: 'BAZAAR_ADMIN' },
    { k: 'docs', n: P.docs_pending ?? 0, label: 'Partner uploads', hint: 'documents from the partner app', go: 'EXPENSE_APPROVALS' },
    { k: 'firm', n: S.no_firm ?? 0, label: 'Settlements without a firm', hint: 'no money moves until named', go: 'BAZAAR_ADMIN' },
  ];
  const deskTotal = desk.reduce((s, d) => s + d.n, 0);

  return (
    <div className="od-root">
      <style>{`
        .od-root { --ground:#0b1220; --surface:#131c2e; --surface2:#0f1727; --line:#22304a; --line2:#33455f;
          --ink:#e6edf7; --ink2:#a9b8ce; --ink3:#6b7c96; --accent:#ffb020; --accent-soft:#2a2013;
          --good:#34d399; --good-soft:#10281f; --warn:#f5b445; --crit:#ff7777; --crit-soft:#2c1618;
          --violet:#a78bfa; --violet-soft:#1f1a33; --sky:#38bdf8; --sky-soft:#0f2233;
          --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
          background:var(--ground); color:var(--ink); min-height:100vh; padding:clamp(14px,2.5vw,28px);
          font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
        .od-root *{box-sizing:border-box;}
        .od-num{font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .od-mast{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:16px;}
        .od-mast h1{font-size:20px;font-weight:750;letter-spacing:-.01em;margin:0;}
        .od-mast p{margin:2px 0 0;font-size:12px;color:var(--ink3);display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
        .od-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;border:1px solid transparent;}
        .od-pill.ok{background:var(--good-soft);color:var(--good);border-color:color-mix(in oklab,var(--good) 30%,var(--line));}
        .od-pill.bad{background:var(--crit-soft);color:var(--crit);border-color:color-mix(in oklab,var(--crit) 35%,var(--line));}
        .od-pill.link{background:var(--surface2);color:var(--ink2);border-color:var(--line);cursor:pointer;}
        .od-pill.link:hover{color:var(--ink);border-color:var(--line2);}
        .od-scope{display:flex;gap:6px;background:var(--surface);border:1px solid var(--line);padding:5px;border-radius:12px;}
        .od-scope button{font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;border:0;background:transparent;color:var(--ink2);padding:7px 14px;border-radius:8px;display:flex;align-items:center;gap:7px;}
        .od-scope button[data-on="1"]{background:var(--violet-soft);color:var(--ink);}
        .od-scope button:hover{color:var(--ink);}
        .od-dot{width:8px;height:8px;border-radius:50%;flex:none;}
        .od-strip{display:flex;flex-wrap:wrap;align-items:center;gap:9px 18px;border-radius:12px;padding:11px 16px;margin-bottom:16px;
          background:var(--crit-soft);border:1px solid color-mix(in oklab,var(--crit) 35%,var(--line));}
        .od-strip .lk{font-weight:700;font-size:13px;color:var(--crit);}
        .od-strip .it{font-size:12.5px;color:var(--ink2);}
        .od-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:14px;}
        .od-kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px;position:relative;overflow:hidden;}
        .od-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--violet);opacity:.9;}
        .od-kpi.sky::before{background:var(--sky);} .od-kpi.gold::before{background:var(--accent);} .od-kpi.good::before{background:var(--good);}
        .od-kpi .l{font-size:11.5px;color:var(--ink3);font-weight:600;}
        .od-kpi .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:26px;font-weight:650;letter-spacing:-.02em;margin:6px 0 2px;}
        .od-kpi .v small{font-size:13px;color:var(--ink3);font-weight:500;}
        .od-kpi .s{font-size:11.5px;color:var(--ink3);}
        .od-kpi.click{cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s;}
        .od-kpi.click:hover,.od-kpi.click:focus-visible{border-color:var(--line2);transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.25);outline:none;}
        .od-kpi .go{position:absolute;right:12px;top:11px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);}
        .od-kpi.click:hover .go{color:var(--ink2);}
        .od-panel.flash{box-shadow:0 0 0 2px var(--violet),0 0 24px rgba(167,139,250,.35);transition:box-shadow .3s;}
        .od-panel>header .m button{font:inherit;font-size:11px;cursor:pointer;background:none;border:0;color:var(--ink2);text-decoration:underline;padding:0;}
        .od-desk{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin-bottom:16px;}
        .od-desk .t{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);font-weight:700;margin-right:6px;}
        .od-desk button{font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--surface2);color:var(--ink2);padding:7px 12px;border-radius:10px;font-size:12.5px;font-weight:600;transition:.15s;}
        .od-desk button:hover{border-color:var(--line2);color:var(--ink);}
        .od-desk button b{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:14px;color:var(--ink);}
        .od-desk button[data-hot="1"]{border-color:color-mix(in oklab,var(--accent) 45%,var(--line));background:var(--accent-soft);color:var(--ink);}
        .od-desk button[data-hot="1"] b{color:var(--accent);}
        .od-desk button span.h{font-size:10.5px;color:var(--ink3);font-weight:500;}
        .od-desk .clear{font-size:12.5px;color:var(--good);font-weight:600;}
        .od-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;margin-bottom:16px;}
        .od-panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
        .od-panel>header{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:14px 16px 11px;border-bottom:1px solid var(--line);}
        .od-panel>header h2{font-size:13.5px;font-weight:700;margin:0;letter-spacing:-.01em;}
        .od-panel>header .m{font-size:11px;color:var(--ink3);text-align:right;}
        .od-body{padding:6px 16px 14px;}
        table.od-tb{width:100%;border-collapse:collapse;font-size:12.5px;}
        table.od-tb th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);font-weight:600;padding:7px 6px 7px 0;border-bottom:1px solid var(--line);}
        table.od-tb td{padding:8px 6px 8px 0;border-bottom:1px solid var(--line);color:var(--ink2);vertical-align:top;}
        table.od-tb tr:last-child td{border-bottom:0;}
        table.od-tb td.r,table.od-tb th.r{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;}
        table.od-tb td b{color:var(--ink);font-weight:650;}
        table.od-tb td .sub{display:block;font-size:11px;color:var(--ink3);margin-top:2px;}
        .od-chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-block;white-space:nowrap;}
        .od-chip.ok{background:var(--good-soft);color:var(--good);} .od-chip.warn{background:var(--accent-soft);color:var(--accent);}
        .od-chip.bad{background:var(--crit-soft);color:var(--crit);} .od-chip.info{background:var(--sky-soft);color:var(--sky);}
        .od-chip.n{background:var(--surface2);color:var(--ink3);border:1px solid var(--line);}
        .od-scroll{overflow-x:auto;} .od-empty{color:var(--ink3);font-size:12.5px;padding:14px 0;text-align:center;}
        .od-money{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:12px 16px 16px;}
        .od-money .box{background:var(--surface2);border:1px solid var(--line);border-radius:12px;padding:12px 14px;}
        .od-money .box .l{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);font-weight:700;}
        .od-money .box .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:20px;font-weight:650;margin-top:4px;}
        .od-money .box .s{font-size:11px;color:var(--ink3);margin-top:2px;}
        .od-note{font-size:11.5px;color:var(--ink3);padding:0 16px 14px;line-height:1.5;}
        .od-zero{background:linear-gradient(135deg,var(--violet-soft),var(--surface));border:1px solid color-mix(in oklab,var(--violet) 35%,var(--line));border-radius:16px;padding:22px 24px;margin-bottom:16px;display:flex;gap:18px;align-items:center;flex-wrap:wrap;}
        .od-zero .big{font-size:34px;line-height:1;}
        .od-zero h3{margin:0 0 4px;font-size:15px;font-weight:750;}
        .od-zero p{margin:0;font-size:12.5px;color:var(--ink2);max-width:720px;line-height:1.5;}
        .od-zero button{font:inherit;font-weight:650;font-size:12.5px;cursor:pointer;border:1px solid var(--violet);color:var(--violet);background:transparent;padding:8px 14px;border-radius:10px;margin-left:auto;white-space:nowrap;}
        .od-console{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--line2);border-radius:14px;padding:12px 16px;margin-top:4px;}
        .od-console b{font-size:13px;} .od-console p{margin:2px 0 0;font-size:11.5px;color:var(--ink3);}
        .od-console button{font:inherit;font-weight:650;font-size:12.5px;cursor:pointer;border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft);padding:8px 14px;border-radius:10px;white-space:nowrap;}
        .od-foot{margin-top:16px;font-size:11.5px;color:var(--ink3);display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;}
        .od-foot button{font:inherit;font-size:11.5px;cursor:pointer;background:none;border:0;color:var(--ink2);text-decoration:underline;padding:0;}
        @media (max-width:900px){.od-kpis{grid-template-columns:repeat(2,1fr);}.od-grid{grid-template-columns:1fr;}.od-money{grid-template-columns:1fr;}}
      `}</style>

      <header className="od-mast">
        <div>
          <h1>Operations — Command Deck</h1>
          <p>
            <span>Market fleet · Fleet partners · Load Bazaar · {currentUser?.full_name ?? 'Prasad Transport'}</span>
            <span className="od-pill ok" title={M.segment_rule ?? ''}>Market books: separate, DB-enforced</span>
          </p>
        </div>
        {/* THE TWO FLEETS, NAMED. This deck is the market side; one click to the other. */}
        <nav className="od-scope" aria-label="Fleet">
          <button data-on="1"><span className="od-dot" style={{ background: 'var(--violet)' }} />Market fleet</button>
          <button data-on="0" onClick={() => onOpenConsole?.('MASTER_CONTROL_V5')} title="Own & permanently attached vehicles — Master Control v5.0">
            <span className="od-dot" style={{ background: 'var(--sky)' }} />Own fleet → Master Control
          </button>
        </nav>
      </header>

      {err && <div className="od-strip"><span className="lk">Could not load the market overview</span><span className="it">{err}</span></div>}

      {nothingYet && (
        <div className="od-zero">
          <div className="big">🚚</div>
          <div>
            <h3>Market fleet: nothing on the board yet</h3>
            <p>
              No market vehicle is registered and no bazaar load is open. Every truck and every trip in transit today
              belongs to the own and attached fleet, and lives in Master Control v5.0 — this deck shows only what fleet partners bring.
              It fills the moment a partner completes KYC, registers a truck, or a customer posts a load.
            </p>
          </div>
          <button onClick={() => onOpenConsole?.('BAZAAR_ADMIN')}>Open Bazaar Admin →</button>
        </div>
      )}

      {/* EVERY TILE OPENS ITS ROWS — the same drawer as Master Control, and a
          scroll to the panel beneath. The number on the tile is the count of
          the rows the drawer lists; the drawer flags it if not. */}
      <section className="od-kpis">
        <div className="od-kpi click" title="Every open or under-review load, with live bids and L1"
          {...tileKeys(() => openTile('market.loads_open', (L.open ?? 0) + (L.pending_review ?? 0), 'panel-board'))}>
          <span className="go">rows ↗</span>
          <div className="l">Loads on the board</div>
          <div className="v od-num">{loading && !ov ? '—' : (L.open ?? 0) + (L.pending_review ?? 0)} <small>{L.open ?? 0} open</small></div>
          <div className="s">{L.pending_review ?? 0} awaiting review · {L.award_requested ?? 0} award requested · {L.awarded ?? 0} awarded</div>
        </div>
        <div className="od-kpi gold click" title="Every award request waiting for the desk"
          {...tileKeys(() => openTile('market.award_requests', L.award_requested ?? 0, 'panel-award'))}>
          <span className="go">rows ↗</span>
          <div className="l">Award requests — desk decides</div>
          <div className="v od-num">{loading && !ov ? '—' : (L.award_requested ?? 0)}</div>
          <div className="s">{awardReq.length ? `oldest ${when(awardReq[0]?.award_requested_at)}` : 'nothing waiting'}</div>
        </div>
        <div className="od-kpi good click" title="Every open settlement, with the money at each stage"
          {...tileKeys(() => openTile('market.settlements_open', S.committed ?? 0, 'panel-settle'))}>
          <span className="go">rows ↗</span>
          <div className="l">Settlements in progress</div>
          <div className="v od-num">{loading && !ov ? '—' : inProgress.length} <small>{rL(S.committed)} committed</small></div>
          <div className="s">advance due {rL(S.advance_due)} · balance due {rL(S.balance_due)}</div>
        </div>
        <div className="od-kpi sky click" title="Every partner truck — active, pending, blocked, rejected"
          {...tileKeys(() => openTile('market.fleet', (F.active ?? 0) + (F.pending ?? 0) + (F.blocked ?? 0) + (F.rejected ?? 0), 'panel-fleet'))}>
          <span className="go">rows ↗</span>
          <div className="l">Market fleet</div>
          <div className="v od-num">{loading && !ov ? '—' : (F.active ?? 0)} <small>trucks active</small></div>
          <div className="s">{F.pending ?? 0} awaiting approval · {F.drivers_active ?? 0} market drivers · {P.vendors_portal ?? 0}/{P.vendors_total ?? 0} partners on portal</div>
        </div>
      </section>

      <section className="od-desk" aria-label="Approval desk">
        <span className="t">Approval desk</span>
        {!ov && <span className="od-chip n">{loading ? 'loading…' : 'unavailable'}</span>}
        {ov && deskTotal === 0 && <span className="clear">Sab clear — market side par koi faisla pending nahi.</span>}
        {ov && deskTotal > 0 && desk.filter((d) => d.n > 0).map((d) => (
          <button key={d.k} data-hot="1" onClick={() => onOpenConsole?.(d.go)} title={d.hint}>
            <b>{d.n}</b> {d.label} <span className="h">{d.hint}</span>
          </button>
        ))}
      </section>

      <div className="od-grid">
        <section className={'od-panel' + (flash === 'panel-award' ? ' flash' : '')} id="panel-award">
          <header><h2>Award requests</h2><span className="m">customer chose a bid · partner pressed Book-Now · <button onClick={() => openTile('market.award_requests', L.award_requested ?? 0, null)}>all rows ↗</button></span></header>
          <div className="od-body od-scroll">
            {awardReq.length === 0 ? <div className="od-empty">{loading && !ov ? 'Loading…' : 'Nothing waiting for a decision.'}</div> : (
              <table className="od-tb"><thead><tr><th>Load</th><th>Requested</th><th className="r">Offer</th></tr></thead>
                <tbody>{awardReq.slice(0, 8).map((r) => (
                  <tr key={r.load_id}>
                    <td><b>{r.load_id}</b><span className="sub">{r.origin} → {r.destination} · {r.customer_name ?? 'staff-posted'}</span></td>
                    <td>{r.award_requested_by === 'VENDOR' ? 'Partner Book-Now' : 'Customer accept'}<span className="sub">{when(r.award_requested_at)}</span></td>
                    <td className="r"><b>{rs(r.bid_amount)}</b><span className="sub">{r.vendor_name ?? '—'}</span></td>
                  </tr>
                ))}</tbody></table>
            )}
          </div>
        </section>

        <section className={'od-panel' + (flash === 'panel-board' ? ' flash' : '')} id="panel-board">
          <header><h2>Load board</h2><span className="m">{L.open ?? 0} open · L1 is staff-only · <button onClick={() => openTile('market.loads_open', (L.open ?? 0) + (L.pending_review ?? 0), null)}>all rows ↗</button></span></header>
          <div className="od-body od-scroll">
            {board.length === 0 ? <div className="od-empty">{loading && !ov ? 'Loading…' : 'No load posted. Customers post from their app; staff from Bazaar Admin.'}</div> : (
              <table className="od-tb"><thead><tr><th>Load</th><th>Bids</th><th className="r">L1 / Book-Now</th><th className="r">Closes</th></tr></thead>
                <tbody>{board.slice(0, 8).map((l) => (
                  <tr key={l.load_id}>
                    <td><b>{l.load_id}</b> <span className={'od-chip ' + (l.status === 'OPEN' ? 'info' : 'warn')}>{l.status === 'OPEN' ? 'open' : 'review'}</span>
                      <span className="sub">{l.origin} → {l.destination} · {l.material ?? ''} {l.weight ? `· ${l.weight}` : ''} · {day(l.loading_date)}</span></td>
                    <td className="od-num">{l.bids}</td>
                    <td className="r">{l.l1_amount ? rs(l.l1_amount) : '—'}<span className="sub">{l.book_now_rate ? `Book-Now ${rs(l.book_now_rate)}` : 'no Book-Now'}</span></td>
                    <td className="r">{l.bid_close_at ? when(l.bid_close_at) : 'open-ended'}</td>
                  </tr>
                ))}</tbody></table>
            )}
          </div>
        </section>
      </div>

      <div className="od-grid">
        <section className={'od-panel' + (flash === 'panel-settle' ? ' flash' : '')} id="panel-settle">
          <header><h2>Settlements in progress</h2><span className="m">award → confirm → truck → advance → POD → balance · <button onClick={() => openTile('market.settlements_open', S.committed ?? 0, null)}>all rows ↗</button></span></header>
          <div className="od-body od-scroll">
            {inProgress.length === 0 ? <div className="od-empty">{loading && !ov ? 'Loading…' : 'No settlement open. One opens the moment the desk approves an award.'}</div> : (
              <table className="od-tb"><thead><tr><th>Load · partner</th><th>Stage</th><th className="r">Awarded</th></tr></thead>
                <tbody>{inProgress.slice(0, 8).map((s) => {
                  const st = STAGE[s.status] ?? { l: s.status, tone: 'n', next: '' };
                  return (
                    <tr key={s.id}>
                      <td><b>{s.load_id}</b><span className="sub">{s.vendor_name ?? '—'}{s.registration_no ? ` · ${s.registration_no}` : ''} · {s.origin} → {s.destination}</span></td>
                      <td><span className={'od-chip ' + st.tone}>{st.l}</span><span className="sub">{st.next}{!s.company_id ? ' · ⚠ firm not set' : ''}</span></td>
                      <td className="r"><b>{rs(s.awarded_amount)}</b><span className="sub">{s.advance_amount ? `adv ${rs(s.advance_amount)}` : `adv ${s.advance_pct}% due`}</span></td>
                    </tr>
                  );
                })}</tbody></table>
            )}
          </div>
        </section>

        <section className="od-panel">
          <header><h2>Market money</h2><span className="m">its own groups in the chart of accounts</span></header>
          <div className="od-money">
            <div className="box"><div className="l">Payable to partners</div><div className="v od-num">{rL(M.partner_payables)}</div><div className="s">Market Fleet Payables (Partners)</div></div>
            <div className="box"><div className="l">Deposits held</div><div className="v od-num">{rL(M.deposits_held)}</div><div className="s">trip-lock deposits, both sides</div></div>
            <div className="box"><div className="l">Advance due now</div><div className="v od-num">{rL(S.advance_due)}</div><div className="s">trucks assigned, advance not yet released</div></div>
            <div className="box"><div className="l">Balance due after POD</div><div className="v od-num">{rL(S.balance_due)}</div><div className="s">released only on a verified POD</div></div>
          </div>
          <div className="od-note">
            Every market rupee is a TARA voucher into a Market Fleet group; the database refuses a posting that would
            cross into own-fleet ledgers, and the own fleet cannot post into these.
            {M.this_month && Object.keys(M.this_month).length > 0 && (
              <> This month: {Object.entries(M.this_month).map(([k, v]) => `${k.replace('BAZAAR_', '').toLowerCase()} ${rL(v.amount)}`).join(' · ')}.</>
            )}
          </div>
        </section>
      </div>

      {/* THE PARTNER FLEET. Where market vehicles and fleet partners' truck
          details live on this deck (owner, 2-Sep-2026): every registered
          partner truck, pending approvals first, with its partner, class,
          driver and whether it is on a load. Empty today, by the numbers. */}
      <div className="od-grid">
        <section className={'od-panel' + (flash === 'panel-fleet' ? ' flash' : '')} id="panel-fleet">
          <header>
            <h2>Partner trucks — market fleet</h2>
            <span className="m">{F.active ?? 0} active · {F.pending ?? 0} pending · {F.rejected ?? 0} rejected · <button onClick={() => openTile('market.fleet', (F.active ?? 0) + (F.pending ?? 0) + (F.blocked ?? 0) + (F.rejected ?? 0), null)}>all rows ↗</button></span>
          </header>
          <div className="od-body od-scroll">
            {(F.trucks ?? []).length === 0 ? (
              <div className="od-empty">
                {loading && !ov ? 'Loading…' : 'No partner truck registered yet. Partners add trucks from their app; the office can set one up under Market Vehicles (Vendors).'}
                {ov && <div style={{ marginTop: 8 }}><button className="od-pill link" onClick={() => onOpenConsole?.('MARKET_VEHICLE')}>Open Market Vehicles → Setup vendor / truck</button></div>}
              </div>
            ) : (
              <table className="od-tb"><thead><tr><th>Truck</th><th>Partner</th><th>Class · driver</th><th className="r">Status</th></tr></thead>
                <tbody>{F.trucks.slice(0, 10).map((v) => (
                  <tr key={v.id}>
                    <td><b>{v.registration_no}</b><span className="sub">since {day(v.created_at)}{v.on_load ? ` · on ${v.on_load} load${v.on_load === 1 ? '' : 's'}` : ''}</span></td>
                    <td>{v.vendor_agency}<span className="sub">{v.vendor_mobile ?? ''}</span></td>
                    <td>{v.vehicle_class ?? '—'}{v.capacity ? ` · ${v.capacity}` : ''}<span className="sub">{v.market_driver ?? v.driver_name ?? 'no driver linked'}</span></td>
                    <td className="r">
                      <span className={'od-chip ' + (v.system_status === 'System Active' ? 'ok' : v.system_status === 'PENDING APPROVAL' ? 'warn' : 'bad')}>
                        {v.system_status === 'System Active' ? 'active' : v.system_status === 'PENDING APPROVAL' ? 'awaiting approval' : v.system_status.toLowerCase()}
                      </span>
                    </td>
                  </tr>
                ))}</tbody></table>
            )}
          </div>
        </section>

        <section className="od-panel">
          <header><h2>Fleet partners</h2><span className="m">{P.vendors_portal ?? 0} of {P.vendors_total ?? 0} vendors on the portal</span></header>
          <div className="od-money">
            <div className="box"><div className="l">KYC — partners</div><div className="v od-num">{P.kyc_vendor ?? 0}</div><div className="s">fleet-partner applications waiting</div></div>
            <div className="box"><div className="l">KYC — customers</div><div className="v od-num">{P.kyc_customer ?? 0}</div><div className="s">customer applications waiting</div></div>
            <div className="box"><div className="l">Market drivers</div><div className="v od-num">{F.drivers_active ?? 0} <small style={{ fontSize: 12, color: 'var(--ink3)' }}>/ {F.drivers_pending ?? 0} pending</small></div><div className="s">partners' drivers, approved by the desk</div></div>
            <div className="box"><div className="l">Partner uploads</div><div className="v od-num">{P.docs_pending ?? 0}</div><div className="s">documents from the partner app</div></div>
          </div>
          <div className="od-note">Approve a KYC and the partner's portal login exists in the same click; a truck goes live only after its papers are checked here.</div>
        </section>
      </div>

      <div className="od-console">
        <div>
          <b>Bazaar Admin</b>
          <p>Loads, bids, awards, KYC, market trucks and drivers, settlements — the desk behind every number above.</p>
        </div>
        <button onClick={() => onOpenConsole?.('BAZAAR_ADMIN')}>Open Bazaar Admin →</button>
      </div>

      {drill && (
        <DrillDownViewer metric={drill.metric} expected={drill.expected} filterQs="" onClose={() => setDrill(null)} />
      )}

      <footer className="od-foot">
        <span>{at ? `Live · updated ${at.toLocaleTimeString('en-IN')}` : 'Loading…'} · GET /api/v1/bazaar/overview</span>
        <span>Own fleet, trips, loading and unloading: <button onClick={() => onOpenConsole?.('MASTER_CONTROL_V5')}>Master Control v5.0</button></span>
      </footer>
    </div>
  );
}
