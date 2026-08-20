// @ts-nocheck
// src/components/ActionRequired.tsx
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ ACTION REQUIRED — the staff pending-task board.
//
// WHY THIS IS A WIDGET AND NOT A FIX.
//
// The 20-08-2026 loading import surfaced three faults — 81 trips with no
// customer, a company master with no GSTIN and a bank account that disagrees
// with the owner's own signed invoice, and 64 HPCL/BPCL trips booked to the
// wrong legal entity. Every one of them COULD have been written by a script.
// None of them were, on the owner's explicit instruction, and that instruction
// is right: each needs somebody who knows the business to say what the correct
// value is. A script would have picked the most likely answer and been silently
// wrong on the rest, inside the fields that decide who gets invoiced and which
// firm's GSTIN is on the invoice.
//
// So the machine's job stops at "here is what is wrong, here is the evidence,
// here is the one field you need to fill". The person's job is the value.
//
// IT SHOWS EVERY OPEN EXCEPTION, NOT JUST THE THREE.
// A pending-task board that quietly hides ten CRITICAL duplicate-billing items
// worth ₹9.02 L is worse than no board, because it looks complete. The three
// editable kinds get an inline form; everything else gets a row and a pointer
// to the Exception Resolution screen, which is where those are resolved.
//
// THE BUTTON SENDS AN INTENT. Nothing here computes what will be written. The
// widget posts "set the customer to X on these trip ids" and the server decides
// what that means, re-reading preconditions inside a transaction — a trip that
// has been billed since the exception was raised is refused there, not here.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1`;

// The three kinds this board can edit in place. Anything else is listed and
// handed on rather than half-handled here.
const EDITABLE = {
  BLANK_CUSTOMER: {
    icon: '👤',
    heading: 'Customer missing',
    action: 'SET_CUSTOMER',
    blurb: 'Customer is the grouping key for every invoice — a trip without one never reaches a bill.',
  },
  MASTER_DATA_GAP: {
    icon: '🏢',
    heading: 'Company master incomplete',
    action: 'UPDATE_COMPANY',
    blurb: 'The invoice prints its seller block from here, so a blank field goes out on every bill.',
  },
  ENTITY_MISMATCH: {
    icon: '🔀',
    heading: 'Wrong billing company',
    action: 'SET_OPERATING_COMPANY',
    blurb: 'The operating company decides the GSTIN, letterhead, bank account and invoice series.',
  },
};

const KIND_LABEL = {
  DUPLICATE_BILLING: '🧾 Duplicate billing',
  DRIVER_MISMATCH: '🚚 Driver mismatch',
  PARSER_REJECT: '📄 Parser reject',
  UNMATCHED_TRIP: '🔗 Unmatched trip',
  AMOUNT_MISMATCH: '💰 Amount mismatch',
  LEDGER_DRIFT: '📚 Ledger drift',
  MISSING_MASTER: '🗂️ Missing master',
  SCAN_FAILURE: '🖨️ Scan failure',
  AI_FAILURE: '🤖 AI failure',
  AUTO_UPDATE_FAILURE: '♻️ Auto-update failure',
  INTEGRATION_FAILURE: '🔌 Integration failure',
  REQUEST_FAILURE: '💥 Request failure',
  OTHER: '❓ Other',
};

const C = {
  card: '#1e293b', line: '#334155', text: '#e2e8f0',
  dim: '#94a3b8', faint: '#64748b',
  amber: '#f59e0b', ruby: '#ef4444', emerald: '#10b981', sky: '#38bdf8',
};

const SEV = {
  CRITICAL: { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)', rank: 4 },
  HIGH: { fg: '#fdba74', bg: 'rgba(249,115,22,.16)', rank: 3 },
  MEDIUM: { fg: '#fcd34d', bg: 'rgba(245,158,11,.14)', rank: 2 },
  LOW: { fg: '#93c5fd', bg: 'rgba(59,130,246,.14)', rank: 1 },
};

const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, color: C.text };
const input = {
  background: '#0f172a', border: `1px solid ${C.line}`, borderRadius: 6,
  color: C.text, padding: '7px 9px', fontSize: 13, width: '100%', boxSizing: 'border-box',
};
const btn = (bg, disabled) => ({
  background: disabled ? '#334155' : bg, border: 'none', borderRadius: 6, color: '#0f172a',
  fontWeight: 700, fontSize: 13, padding: '8px 14px',
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
});

const dmy = (d) => {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const [y, m, dd] = s.split('-');
  return y && m && dd ? `${dd}-${m}-${y}` : s;
};
const inr = (v) => '₹' + Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

// The resolve and dismiss routes are admin-guarded. The bearer token is NOT
// injected globally anywhere in this app, so it has to be attached per call —
// without it every Update button returns 401 and looks like a broken screen.
const authHeaders = () => {
  const t = localStorage.getItem('prasad_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const jsonFetch = async (url, opts) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  }
  return json;
};

// No props. Every staff member who can reach the dashboard needs to see what is
// waiting; the guard that matters is on the server, where the writes happen.
export default function ActionRequired() {
  const [rows, setRows] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState({});     // per-exception form state
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = await jsonFetch(`${API}/exceptions?status=OPEN&limit=300`);
      setRows(q.exceptions ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Master list for the customer picker. Failing to load it must not break
    // the board — the field stays free text, and the server still validates.
    jsonFetch(`${API}/ops/masters`)
      .then((m) => setCustomers((m.customers ?? []).map((c) => c.customer_name).filter(Boolean).sort()))
      .catch(() => setCustomers([]));
  }, [load]);

  const editable = useMemo(() => rows.filter((r) => EDITABLE[r.kind]), [rows]);
  const others = useMemo(() => rows.filter((r) => !EDITABLE[r.kind]), [rows]);

  const sorted = useMemo(
    () => [...editable].sort((a, b) =>
      (SEV[b.severity]?.rank ?? 0) - (SEV[a.severity]?.rank ?? 0)
      || String(a.kind).localeCompare(String(b.kind))),
    [editable],
  );

  const otherMoney = useMemo(
    () => others.reduce((a, r) => a + Number(r.amount_at_risk ?? 0), 0),
    [others],
  );

  const setField = (id, patch) => setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? {}), ...patch } }));

  const runScan = async () => {
    setBusyId('scan'); setFlash(null); setError(null);
    try {
      const r = await jsonFetch(`${API}/exceptions/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: '{}',
      });
      const fresh = (r.detectors ?? []).reduce((a, d) => a + (d.new ?? 0), 0);
      setFlash(fresh ? `Scan complete — ${fresh} new task${fresh === 1 ? '' : 's'}.` : 'Scan complete — nothing new.');
      await load();
    } catch (e) {
      setError(`Scan failed: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const submit = async (exc) => {
    const cfg = EDITABLE[exc.kind];
    const d = draft[exc.id] ?? {};
    let params;

    if (exc.kind === 'BLANK_CUSTOMER') {
      const name = String(d.customer_name ?? '').trim();
      if (!name) { setError('Enter the customer name first.'); return; }
      params = { customer_name: name };
    } else if (exc.kind === 'ENTITY_MISMATCH') {
      const co = String(d.company ?? exc.evidence?.expected_company ?? '').trim();
      if (!co) { setError('Enter the company these trips belong to.'); return; }
      params = { company: co };
    } else {
      // MASTER_DATA_GAP — send only the boxes that were actually filled, so an
      // untouched field is never overwritten with an empty string.
      const fields = {};
      for (const [k, v] of Object.entries(d.fields ?? {})) {
        if (String(v ?? '').trim()) fields[k] = String(v).trim();
      }
      if (!Object.keys(fields).length) { setError('Fill in at least one field.'); return; }
      params = { fields };
    }

    setBusyId(exc.id); setError(null); setFlash(null);
    try {
      const r = await jsonFetch(`${API}/exceptions/${exc.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ action: cfg.action, params, note: d.note || null }),
      });
      const res = r.result ?? {};
      // Report what the SERVER did, never what was asked for. It refuses billed
      // trips, and a staff member who is not told that believes all 25 moved.
      const bits = [];
      if (res.updated != null) bits.push(`${res.updated} updated`);
      if (res.skipped) bits.push(`${res.skipped} skipped`);
      if (res.refused_billed) bits.push(`${res.refused_billed} refused (already billed)`);
      if (res.changed) bits.push(res.changed.map((c) => c.field).join(', ') + ' saved');
      if (res.blocking_bills?.length) bits.push(`bills: ${res.blocking_bills.join(', ')}`);
      setFlash(`✅ ${bits.join(' · ') || 'Done'}`);
      setOpenId(null);
      setDraft((x) => ({ ...x, [exc.id]: undefined }));
      await load();
    } catch (e) {
      setError(`${e.code ? e.code + ' — ' : ''}${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (exc) => {
    const note = String((draft[exc.id] ?? {}).note ?? '').trim();
    if (note.length < 5) { setError('Say why this is not a problem — a dismissal with no reason cannot be reviewed later.'); return; }
    setBusyId(exc.id); setError(null);
    try {
      await jsonFetch(`${API}/exceptions/${exc.id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ note }),
      });
      setFlash('Dismissed with a reason.');
      setOpenId(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div style={{ ...card, marginBottom: 20 }}><span style={{ color: C.dim }}>Loading pending tasks…</span></div>;
  }

  return (
    <div style={{ ...card, marginBottom: 20, borderColor: sorted.length ? C.amber : C.line }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: sorted.length ? C.amber : C.text }}>
          ⚠️ Action Required — Staff Pending Tasks
        </h3>
        <span style={{
          background: sorted.length ? 'rgba(245,158,11,.18)' : 'rgba(16,185,129,.15)',
          color: sorted.length ? C.amber : C.emerald,
          borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 700,
        }}>
          {sorted.length} to fix
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button style={btn(C.sky, busyId === 'scan')} disabled={busyId === 'scan'} onClick={runScan}>
            {busyId === 'scan' ? 'Scanning…' : '🔍 Re-scan'}
          </button>
        </div>
      </div>

      <p style={{ color: C.faint, fontSize: 12, margin: '0 0 12px', lineHeight: 1.6 }}>
        Ye teeno cheezein system ne <b>jaan-boojh kar apne aap theek nahi ki</b> — sahi value sirf aap bata
        sakte hain. Neeche edit karke <b>Update</b> dabayein. Jo trip pehle se bill par ja chuki hai use server
        khud mana kar dega.
      </p>

      {flash && (
        <div style={{ background: 'rgba(16,185,129,.12)', border: `1px solid ${C.emerald}`, color: '#a7f3d0',
                      borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10 }}>{flash}</div>
      )}
      {error && (
        <div style={{ background: 'rgba(239,68,68,.12)', border: `1px solid ${C.ruby}`, color: '#fecaca',
                      borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10 }}>{error}</div>
      )}

      {!sorted.length && (
        <p style={{ color: C.emerald, margin: '4px 0 0', fontSize: 13 }}>
          ✅ Nothing pending. Press Re-scan after the next import to check again.
        </p>
      )}

      {sorted.map((exc) => {
        const cfg = EDITABLE[exc.kind];
        const sev = SEV[exc.severity] ?? SEV.LOW;
        const ev = exc.evidence ?? {};
        const isOpen = openId === exc.id;
        const d = draft[exc.id] ?? {};
        const busy = busyId === exc.id;

        return (
          <div key={exc.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
            <button
              onClick={() => setOpenId(isOpen ? null : exc.id)}
              style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
                       color: C.text, padding: '11px 13px', cursor: 'pointer', display: 'flex',
                       alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
            >
              <span style={{ fontSize: 17 }}>{cfg.icon}</span>
              <span style={{ background: sev.bg, color: sev.fg, borderRadius: 4, padding: '1px 7px',
                             fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em' }}>
                {exc.severity}
              </span>
              <b style={{ fontSize: 13.5 }}>{exc.title}</b>
              <span style={{ marginLeft: 'auto', color: C.faint, fontSize: 18 }}>{isOpen ? '▾' : '▸'}</span>
            </button>

            {isOpen && (
              <div style={{ padding: '0 13px 14px', borderTop: `1px solid ${C.line}` }}>
                <p style={{ color: C.dim, fontSize: 12.5, lineHeight: 1.65, margin: '11px 0' }}>{exc.detail}</p>

                {/* ── the evidence, so the value is chosen from facts ───── */}
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11.5,
                              color: C.faint, marginBottom: 12 }}>
                  {ev.trips != null && <span>Trips: <b style={{ color: C.text }}>{ev.trips}</b></span>}
                  {ev.already_billed ? <span>Already billed: <b style={{ color: C.ruby }}>{ev.already_billed}</b></span> : null}
                  {ev.first_load && <span>{dmy(ev.first_load)} → {dmy(ev.last_load)}</span>}
                  {exc.amount_at_risk ? <span>At risk: <b style={{ color: C.amber }}>{inr(exc.amount_at_risk)}</b></span> : null}
                  {exc.department && <span>Desk: <b style={{ color: C.text }}>{exc.department}</b></span>}
                </div>

                {Array.isArray(ev.sample_trip_codes) && ev.sample_trip_codes.length > 0 && (
                  <div style={{ fontSize: 11, color: C.faint, marginBottom: 12, wordBreak: 'break-word' }}>
                    LR/Trip: {ev.sample_trip_codes.join(', ')}
                    {ev.trips > ev.sample_trip_codes.length ? ` … +${ev.trips - ev.sample_trip_codes.length} more` : ''}
                  </div>
                )}

                {/* ── BLANK CUSTOMER ───────────────────────────────────── */}
                {exc.kind === 'BLANK_CUSTOMER' && (
                  <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
                    <label style={{ fontSize: 11, color: C.dim, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      Customer (must already exist in the Customer master)
                    </label>
                    <input
                      style={input}
                      list={`cust-${exc.id}`}
                      placeholder={ev.suggested_customer || 'e.g. INDIAN OIL CORPORATION LTD'}
                      value={d.customer_name ?? ''}
                      onChange={(e) => setField(exc.id, { customer_name: e.target.value })}
                    />
                    <datalist id={`cust-${exc.id}`}>
                      {customers.map((c) => <option key={c} value={c} />)}
                    </datalist>
                    {ev.suggested_customer && (
                      <button
                        onClick={() => setField(exc.id, { customer_name: ev.suggested_customer })}
                        style={{ ...btn('#475569', false), color: C.text, justifySelf: 'start', fontWeight: 600 }}
                      >
                        Use suggested: {ev.suggested_customer}
                      </button>
                    )}
                  </div>
                )}

                {/* ── ENTITY MISMATCH ──────────────────────────────────── */}
                {exc.kind === 'ENTITY_MISMATCH' && (
                  <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
                    <label style={{ fontSize: 11, color: C.dim, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      Bill these trips under
                    </label>
                    <input
                      style={input}
                      value={d.company ?? ev.expected_company ?? ''}
                      onChange={(e) => setField(exc.id, { company: e.target.value })}
                    />
                    <span style={{ fontSize: 11, color: C.faint }}>
                      Rule: {ev.rule_source}
                    </span>
                  </div>
                )}

                {/* ── COMPANY MASTER ───────────────────────────────────── */}
                {exc.kind === 'MASTER_DATA_GAP' && (
                  <div style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
                    {(ev.missing ?? []).map((m) => (
                      <div key={m.field}>
                        <label style={{ fontSize: 11, color: C.amber, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          {m.label} — blank
                        </label>
                        <input
                          style={input}
                          value={(d.fields ?? {})[m.field] ?? ''}
                          onChange={(e) => setField(exc.id, { fields: { ...(d.fields ?? {}), [m.field]: e.target.value } })}
                        />
                      </div>
                    ))}
                    {(ev.conflicts ?? []).map((cf) => (
                      <div key={cf.field}>
                        <label style={{ fontSize: 11, color: C.ruby, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          {cf.field} — master says "{cf.in_master}", signed invoice says "{cf.on_document}"
                        </label>
                        <input
                          style={input}
                          placeholder={`keep "${cf.in_master}" or type the correct one`}
                          value={(d.fields ?? {})[cf.field] ?? ''}
                          onChange={(e) => setField(exc.id, { fields: { ...(d.fields ?? {}), [cf.field]: e.target.value } })}
                        />
                        <button
                          onClick={() => setField(exc.id, { fields: { ...(d.fields ?? {}), [cf.field]: cf.on_document } })}
                          style={{ ...btn('#475569', false), color: C.text, marginTop: 6, fontWeight: 600 }}
                        >
                          Use the invoice value
                        </button>
                      </div>
                    ))}
                    {ev.observed_source && (
                      <span style={{ fontSize: 11, color: C.faint }}>Compared against: {ev.observed_source}</span>
                    )}
                  </div>
                )}

                {/* ── note + actions ───────────────────────────────────── */}
                <div style={{ marginTop: 14, display: 'grid', gap: 8, maxWidth: 560 }}>
                  <input
                    style={input}
                    placeholder="Note (required to dismiss, optional to update)"
                    value={d.note ?? ''}
                    onChange={(e) => setField(exc.id, { note: e.target.value })}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button style={btn(C.emerald, busy)} disabled={busy} onClick={() => submit(exc)}>
                      {busy ? 'Saving…' : '💾 Update'}
                    </button>
                    <button
                      style={{ ...btn('#475569', busy), color: C.text }}
                      disabled={busy}
                      onClick={() => dismiss(exc)}
                    >
                      Not a problem
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* ── everything else that is open ────────────────────────────────── */}
      {others.length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
          <button
            onClick={() => setShowAll((v) => !v)}
            style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer',
                     fontSize: 12.5, padding: 0 }}
          >
            {showAll ? '▾' : '▸'} {others.length} other open exception{others.length === 1 ? '' : 's'}
            {otherMoney > 0 ? ` · ${inr(otherMoney)} at risk` : ''} — resolved on the Exception Resolution screen
          </button>
          {showAll && (
            <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
              {others.map((o) => (
                <div key={o.id} style={{ display: 'flex', gap: 10, alignItems: 'center',
                                         fontSize: 12.5, color: C.dim, flexWrap: 'wrap' }}>
                  <span style={{ background: (SEV[o.severity] ?? SEV.LOW).bg, color: (SEV[o.severity] ?? SEV.LOW).fg,
                                 borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 800 }}>
                    {o.severity}
                  </span>
                  <span style={{ color: C.faint }}>{KIND_LABEL[o.kind] ?? o.kind}</span>
                  <span style={{ color: C.text }}>{o.title}</span>
                  {o.amount_at_risk ? <span style={{ marginLeft: 'auto', color: C.amber }}>{inr(o.amount_at_risk)}</span> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
