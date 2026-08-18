// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
// 🛠️ EXCEPTION RESOLUTION — the things the system refused to guess at.
//
// WHY THIS SCREEN EXISTS. The ERP is careful about refusing rather than
// guessing, and that care has been going nowhere. The AC5 loader rejects a file
// and writes a COUNT to a log. The IOCL matcher parks an AMBIGUOUS row in a
// view nobody opens. Every one of those is a decision waiting for a person, and
// invisible until somebody goes looking.
//
// The first scan found ten bills where one consignment had been charged twice —
// ₹9,02,095.89 to Bharat Petroleum, Indian Oil and Aadhar Green, none of it
// paid yet, the oldest sitting there since May. Nothing was broken; nothing had
// asked.
//
// ── WHAT THIS SCREEN WILL NOT DO ───────────────────────────────────────────
// It will not resolve anything on its own. Where two bill lines name different
// drivers, only the physical LR settles which trip was real, and no amount of
// data will tell you. So the resolve dialog REFUSES to submit until a line is
// chosen: a default here would be the system guessing under a staff member's
// login.
//
// It also does not do the work. The button sends an intent — "keep line 692" —
// and the server decides how that becomes a bill total, a ledger reversal and a
// deleted trip, in one transaction, against preconditions re-read at the moment
// of the write. Two people clicking at once would otherwise each read the bill,
// each subtract, and one correction would vanish.
import { API_BASE } from './lib/apiBase';

const API = `${API_BASE}/api/v1/exceptions`;

const inr = (v: any) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dmy = (d: any) => {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const [y, m, dd] = s.split('-');
  return y && m && dd ? `${dd}-${m}-${y}` : s;
};

// Severity is a colour AND a word. On a screen an operator scans in a hurry,
// colour alone is a guess about their eyesight.
const SEV: Record<string, { colour: string; bg: string }> = {
  CRITICAL: { colour: '#fca5a5', bg: 'rgba(239,68,68,0.15)' },
  HIGH:     { colour: '#fdba74', bg: 'rgba(249,115,22,0.15)' },
  MEDIUM:   { colour: '#fde047', bg: 'rgba(234,179,8,0.12)' },
  LOW:      { colour: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

const KIND_LABEL: Record<string, string> = {
  DUPLICATE_BILLING: '🧾 Duplicate billing',
  DRIVER_MISMATCH:   '🧑‍✈️ Driver mismatch',
  PARSER_REJECT:     '📄 Document unreadable',
  UNMATCHED_TRIP:    '🔗 Unmatched trip',
  AMOUNT_MISMATCH:   '💱 Amounts disagree',
  LEDGER_DRIFT:      '📚 Ledger drift',
  MISSING_MASTER:    '🗂️ Missing master',
  OTHER:             '❓ Other',
};

const card: React.CSSProperties = {
  background: '#0f172a', border: '1px solid #334155', borderRadius: 12,
  padding: 18, color: '#e2e8f0',
};
const label: React.CSSProperties = {
  color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', margin: 0,
};

const jsonFetch = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

export default function ExceptionResolution() {
  const [rows, setRows] = useState<any[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState<any>(null);     // the exception being resolved
  const [choice, setChoice] = useState<any>(null); // which bill line survives
  const [deleteTrips, setDeleteTrips] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      const j = await jsonFetch(`${API}/${q}`);
      setRows(j.exceptions ?? []);
      setTotals(j.totals ?? null);
    } catch (e: any) { setError(e.message); setRows([]); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kind]);

  const scan = async () => {
    setBusy(true); setError(null);
    try {
      const j = await jsonFetch(`${API}/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const found = (j.detectors ?? []).reduce((a: number, d: any) => a + d.found, 0);
      const fresh = (j.detectors ?? []).reduce((a: number, d: any) => a + d.new, 0);
      setFlash(`Scan complete — ${found} found, ${fresh} new.`);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  const kinds = useMemo(() => [...new Set(rows.map((r) => r.kind))], [rows]);

  const startResolve = (e: any) => {
    setOpen(e); setChoice(null); setNote(''); setDeleteTrips(true); setError(null);
  };

  const submitResolve = async () => {
    if (!open || !choice) return;
    setBusy(true); setError(null);
    try {
      const j = await jsonFetch(`${API}/${open.id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'KEEP_ONE_LINE',
          params: { keep_bill_line_id: choice.bill_line_id, delete_orphan_trips: deleteTrips },
          note: note || null,
        }),
      });
      const r = j.result ?? {};
      setFlash(`Resolved — ₹${inr(r.reversed_amount)} reversed on ${r.bill_no}. `
        + `Bill now ₹${inr(r.bill_total_net_now)}.`
        + (r.trips_deleted?.length ? ` Trips removed: ${r.trips_deleted.join(', ')}.` : '')
        + (r.trips_kept_because_referenced?.length
          ? ` Kept (still referenced): ${r.trips_kept_because_referenced.map((t: any) => t.trip_code).join(', ')}.` : ''));
      setOpen(null);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  const submitDismiss = async () => {
    if (!open) return;
    setBusy(true); setError(null);
    try {
      await jsonFetch(`${API}/${open.id}/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      setFlash('Dismissed.');
      setOpen(null);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        flexWrap: 'wrap', gap: 15, marginBottom: 20 }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: 32, fontWeight: 900 }}>
            Exception Resolution
          </h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>
            What the system found and would not decide on its own
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button className="glow-btn" onClick={scan} disabled={busy}
            style={{ background: '#334155', border: '1px solid #475569' }}>
            {busy ? '⏳ Working…' : '🔍 Run detectors'}
          </button>
          <button className="glow-btn" onClick={load} disabled={loading}
            style={{ background: 'linear-gradient(135deg,#6366f1,#4f46e5)' }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── the two numbers that decide whether anyone acts today ────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 20, marginBottom: 20 }}>
        <div className="glass-card" style={{ padding: 20,
          borderLeft: `5px solid ${rows.length ? '#ef4444' : '#10b981'}` }}>
          <h3 style={{ ...label, margin: '0 0 10px 0' }}>⚠️ Open exceptions</h3>
          <h1 style={{ color: rows.length ? '#ef4444' : '#10b981', margin: 0, fontSize: 30 }}>
            {totals?.open ?? rows.length}
          </h1>
          <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 8 }}>
            {rows.length ? 'each one is a decision nobody has taken yet' : 'nothing waiting'}
          </div>
        </div>
        <div className="glass-card" style={{ padding: 20, borderLeft: '5px solid #f59e0b' }}>
          <h3 style={{ ...label, margin: '0 0 10px 0' }}>💰 Money at risk</h3>
          <h1 style={{ color: '#f59e0b', margin: 0, fontSize: 30 }}>
            ₹{inr(totals?.amount_at_risk)}
          </h1>
          <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 8 }}>
            what is wrong in rupees — this is what sorts the list
          </div>
        </div>
      </div>

      {flash && (
        <div style={{ ...card, borderColor: '#10b981', marginBottom: 16, padding: 12 }}>
          <span style={{ color: '#10b981', fontWeight: 700 }}>✅ {flash}</span>
          <button onClick={() => setFlash(null)} style={{ float: 'right', background: 'transparent',
            border: 'none', color: '#94a3b8', cursor: 'pointer' }}>✕</button>
        </div>
      )}
      {error && !open && (
        <div style={{ ...card, borderColor: '#ef4444', marginBottom: 16, padding: 12, color: '#fca5a5' }}>
          ⚠️ {error}
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <select className="modern-input" value={kind} onChange={(e) => setKind(e.target.value)}
          style={{ background: '#1e293b', maxWidth: 320 }}>
          <option value="">All kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
        </select>
      </div>

      {loading && <p style={{ color: '#818cf8' }}>Loading…</p>}
      {!loading && !rows.length && (
        <div className="glass-card" style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
          Nothing open. Run the detectors to check again.
        </div>
      )}

      <div style={{ display: 'grid', gap: 14 }}>
        {rows.map((e) => {
          const sev = SEV[e.severity] ?? SEV.LOW;
          return (
            <div key={e.id} className="glass-card" style={{ padding: 18,
              borderLeft: `5px solid ${sev.colour}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'flex-start', gap: 15, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 420px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="badge" style={{ background: sev.bg, color: sev.colour,
                      border: `1px solid ${sev.colour}`, fontSize: 11, fontWeight: 700 }}>
                      {e.severity}
                    </span>
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <span style={{ color: '#64748b', fontSize: 11 }}>
                      · seen {e.seen_count}× · {e.age_days ?? 0}d old · {dmy(e.detected_at)}
                    </span>
                  </div>
                  <h3 style={{ margin: '8px 0 6px', fontSize: 16, color: '#f1f5f9' }}>{e.title}</h3>
                  <p style={{ margin: 0, fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6 }}>{e.detail}</p>
                </div>
                <div style={{ textAlign: 'right', minWidth: 180 }}>
                  <p style={label}>At risk</p>
                  <div style={{ fontSize: 22, fontWeight: 900, color: sev.colour }}>
                    ₹{inr(e.amount_at_risk)}
                  </div>
                  <button className="glow-btn" onClick={() => startResolve(e)}
                    style={{ marginTop: 10, background: 'linear-gradient(135deg,#0f766e,#14b8a6)' }}>
                    🛠️ Review &amp; resolve
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── the resolve dialog ───────────────────────────────────────────── */}
      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 30,
          overflowY: 'auto' }}
          onClick={(ev) => { if (ev.target === ev.currentTarget && !busy) setOpen(null); }}>
          <div style={{ ...card, maxWidth: 1000, width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>{open.title}</h2>
                <p style={{ margin: '6px 0 0', fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6 }}>
                  {open.detail}
                </p>
              </div>
              <button onClick={() => !busy && setOpen(null)} style={{ background: 'transparent',
                border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>

            {open.kind === 'DUPLICATE_BILLING' && (
              <>
                <div style={{ marginTop: 16, padding: 12, border: '1px solid #f59e0b',
                  borderRadius: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                  <b>Check the physical LR before choosing.</b> These lines are the same
                  consignment. Where they name different drivers, the paper is the only thing
                  that says which trip actually ran — and the driver you keep is the one whose
                  khata carries any shortage on this load.
                </div>

                <p style={{ ...label, marginTop: 16 }}>Which line is the real one?</p>
                <table className="lls-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase' }}>
                      <th style={{ padding: 8, textAlign: 'left' }}>Keep</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>Trip</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>Driver</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>Vehicle</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>Loading</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>Qty</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(open.evidence?.lines_detail ?? []).map((l: any) => {
                      const picked = choice?.bill_line_id === l.bill_line_id;
                      return (
                        <tr key={l.bill_line_id}
                          onClick={() => setChoice(l)}
                          style={{ cursor: 'pointer', borderBottom: '1px solid #334155',
                            background: picked ? 'rgba(20,184,166,0.15)' : undefined }}>
                          <td style={{ padding: 8 }}>
                            <input type="radio" readOnly checked={!!picked} />
                          </td>
                          <td style={{ padding: 8 }}>
                            {l.trip_code || <span style={{ color: '#ef4444' }}>no trip linked</span>}
                          </td>
                          <td style={{ padding: 8, fontWeight: 700 }}>{l.driver_name || '—'}</td>
                          <td style={{ padding: 8 }}>{l.vehicle_no || '—'}</td>
                          <td style={{ padding: 8 }}>{dmy(l.loading_date)}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>{l.qty ?? '—'}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>₹{inr(l.net_payable)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div style={{ marginTop: 14, fontSize: 12.5 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" checked={deleteTrips}
                      onChange={(e) => setDeleteTrips(e.target.checked)} style={{ marginTop: 3 }} />
                    <span>
                      Also delete the duplicate trip rows.
                      <span style={{ color: '#94a3b8' }}>
                        {' '}A trip carrying fuel, tolls, a settlement or another bill is kept
                        regardless — the server checks each one and reports what it kept.
                      </span>
                    </span>
                  </label>
                </div>

                {choice && (
                  <div style={{ marginTop: 14, padding: 12, border: '1px solid #14b8a6',
                    borderRadius: 8, fontSize: 12.5, lineHeight: 1.7 }}>
                    <b>This will:</b><br />
                    · keep <b>{choice.trip_code || 'the unlinked line'}</b>
                    {choice.driver_name ? <> (driver <b>{choice.driver_name}</b>)</> : null}<br />
                    · remove {(open.evidence?.lines_detail?.length ?? 1) - 1} duplicate line(s)
                    from <b>{open.evidence?.bill_no}</b><br />
                    · post a reversing journal for <b>₹{inr(open.amount_at_risk)}</b>{' '}
                    (Dr Freight Income / Cr {open.evidence?.customer_name})
                  </div>
                )}
              </>
            )}

            <div style={{ marginTop: 14 }}>
              <p style={label}>Note (required to dismiss, optional to resolve)</p>
              <input className="modern-input" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. checked physical LR 193660536 — Sader Rahman drove it"
                style={{ background: '#1e293b', width: '100%' }} />
            </div>

            {error && (
              <div style={{ marginTop: 12, padding: 10, border: '1px solid #ef4444',
                borderRadius: 6, color: '#fca5a5', fontSize: 12.5 }}>
                ⚠️ {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
              <button className="glow-btn" disabled={!choice || busy} onClick={submitResolve}
                style={{ background: choice ? 'linear-gradient(135deg,#0f766e,#14b8a6)' : '#334155',
                  opacity: choice ? 1 : 0.5, cursor: choice ? 'pointer' : 'not-allowed' }}>
                {busy ? '⏳ Applying…' : '✅ Apply correction'}
              </button>
              <button className="glow-btn" disabled={busy} onClick={submitDismiss}
                style={{ background: 'transparent', border: '1px solid #64748b', color: '#94a3b8' }}>
                Not a problem — dismiss
              </button>
              <button disabled={busy} onClick={() => setOpen(null)}
                style={{ background: 'transparent', border: '1px solid #475569', color: '#94a3b8',
                  padding: '8px 16px', borderRadius: 8, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
            {!choice && open.kind === 'DUPLICATE_BILLING' && (
              <p style={{ color: '#64748b', fontSize: 11, marginTop: 10, marginBottom: 0 }}>
                Pick a line first. There is no default — where the lines name different drivers,
                only the physical LR settles it, and a default here would be the system guessing
                under your login.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
