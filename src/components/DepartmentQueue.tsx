// ─────────────────────────────────────────────────────────────────────────────
// Department Queue — the Zero-Gap board.
//
// Everything the system tried and could not finish, routed to the desk that can
// act on it. Before this, a failed scan, a dead embedding call or a crashed
// request produced a console line nobody read — and from the office floor "the
// system did nothing", "it ran and found nothing" and "it broke" looked
// identical. The manager found out when a customer asked.
//
// Every row answers three questions, in the order a person actually asks them:
//   WHY DID IT STOP    the failure, in words
//   HOW DID IT GET HERE  the process and the input, not a stack trace
//   WHAT DO I DO       one sentence, imperative
//
// And then gives a button that does it. A queue that explains a problem and
// leaves the reader to invent the fix is a log with a nicer font.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1/exceptions`;

type Item = {
  id: string; department: string; kind: string; severity: string; status: string;
  title: string;
  why_it_stopped: string | null;
  how_it_got_here: Record<string, any> | null;
  what_to_do: string | null;
  options: { action: string; label: string }[] | null;
  evidence: Record<string, any> | null;
  amount_at_risk: string | null;
  subject_type: string | null; subject_id: string | null;
  detected_by: string; detected_at: string; last_seen_at: string; seen_count: number;
};

const DEPTS = ['OPERATIONS', 'ACCOUNTING', 'COMPLIANCE', 'CRM', 'IT'] as const;
const DEPT_LABEL: Record<string, string> = {
  OPERATIONS: 'Operations', ACCOUNTING: 'Accounting',
  COMPLIANCE: 'Compliance', CRM: 'CRM', IT: 'IT',
};
const SEV_TONE: Record<string, string> = {
  CRITICAL: '#ef4444', HIGH: '#fb923c', MEDIUM: '#fbbf24', LOW: '#38bdf8',
};

const money = (v: any) =>
  v == null ? null : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const box: React.CSSProperties = {
  background: 'rgba(15,23,42,0.72)', border: '1px solid #1e293b',
  borderRadius: 12, padding: '12px 14px', color: '#e2e8f0', fontSize: 13,
};
const btn = (bg: string): React.CSSProperties => ({
  background: bg, border: 'none', borderRadius: 8, color: '#fff',
  padding: '7px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
});
const qLabel: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace', fontSize: 10.5, letterSpacing: '.08em',
  textTransform: 'uppercase', color: '#64748b', marginBottom: 2,
};

export default function DepartmentQueue({ only }: { only?: string }) {
  const [dept, setDept] = useState<string>(only ?? '');
  const [items, setItems] = useState<Item[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = async () => {
    try {
      const qs = dept ? `?department=${encodeURIComponent(dept)}` : '';
      const j = await (await fetch(`${API}/departments${qs}`)).json();
      setItems(j.items ?? []);
      setSummary(j.summary ?? []);
    } catch (e: any) { setMsg(`Could not load the queue — ${e.message}`); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dept]);

  const total = summary.reduce((a, s) => a + (s.open_items ?? 0), 0);
  const atRisk = summary.reduce((a, s) => a + Number(s.amount_at_risk ?? 0), 0);
  const stale = summary.reduce((a, s) => a + (s.stale_over_7d ?? 0), 0);
  const countFor = (d: string) => summary.find((s) => s.department === d)?.open_items ?? 0;

  const act = async (it: Item, action: string) => {
    const note = window.prompt(`Note for "${action}" (optional — kept on the record)`) ?? null;
    setBusy(it.id); setMsg('');
    try {
      const r = await fetch(`${API}/${it.id}/${action === 'DISMISS' ? 'dismiss' : 'resolve'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'DISMISS' ? { note } : { action, note }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setMsg(`Closed: ${it.title}`);
      await load();
    } catch (e: any) { setMsg(`Could not close it — ${e.message}`); }
    finally { setBusy(null); }
  };

  if (!total && !msg) return null;

  return (
    <div style={{ marginBottom: 22, background: 'rgba(239,68,68,0.05)', border: '1px solid #ef4444',
                  borderRadius: 16, padding: 'clamp(12px, 2.5vw, 18px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#f87171' }}>
          🛠️ Needs a person
          <span style={{ marginLeft: 10, background: '#ef4444', color: '#fff', borderRadius: 999,
                         padding: '2px 10px', fontSize: 13 }}>{total}</span>
        </div>
        <div style={{ color: '#94a3b8', fontSize: 12.5 }}>
          Everything the system tried and could not finish. Nothing here failed quietly.
        </div>
        <div style={{ flex: 1 }} />
        {atRisk > 0 && (
          <div style={{ ...box, borderColor: '#ef4444', padding: '6px 12px' }}>
            <span style={{ color: '#94a3b8' }}>at risk </span>
            <b style={{ color: '#fca5a5', fontVariantNumeric: 'tabular-nums' }}>₹{money(atRisk)}</b>
          </div>
        )}
        {stale > 0 && (
          <div style={{ ...box, borderColor: '#fb923c', padding: '6px 12px', color: '#fdba74' }}>
            {stale} untouched for over a week
          </div>
        )}
      </div>

      {/* Department tabs — the routing made visible. */}
      {!only && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setDept('')} style={btn(dept === '' ? '#ef4444' : '#334155')}>
            All ({total})
          </button>
          {DEPTS.map((d) => (
            <button key={d} onClick={() => setDept(d)}
                    style={{ ...btn(dept === d ? '#ef4444' : '#334155'), opacity: countFor(d) ? 1 : 0.45 }}>
              {DEPT_LABEL[d]} ({countFor(d)})
            </button>
          ))}
        </div>
      )}

      {msg && <div style={{ ...box, marginTop: 10, borderColor: '#ef4444' }}>{msg}</div>}

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10,
                    maxHeight: 620, overflowY: 'auto' }}>
        {items.length === 0 && <div style={box}>Nothing waiting for this desk.</div>}
        {items.map((it) => {
          const expanded = openRow === it.id;
          return (
            <div key={it.id} style={{ ...box, borderLeft: `3px solid ${SEV_TONE[it.severity] ?? '#334155'}` }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: SEV_TONE[it.severity], fontWeight: 800, fontSize: 11,
                               letterSpacing: '.06em' }}>{it.severity}</span>
                <span style={{ color: '#94a3b8', fontSize: 11 }}>{DEPT_LABEL[it.department] ?? it.department}</span>
                <span style={{ color: '#64748b', fontSize: 11 }}>{it.kind}</span>
                {it.seen_count > 1 && (
                  <span style={{ color: '#fbbf24', fontSize: 11 }}>seen {it.seen_count}×</span>
                )}
                {it.amount_at_risk && (
                  <span style={{ color: '#fca5a5', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                    ₹{money(it.amount_at_risk)}
                  </span>
                )}
              </div>

              <div style={{ fontWeight: 700, color: '#fff', margin: '4px 0 8px' }}>{it.title}</div>

              {/* The three questions, in the order they get asked. */}
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <div>
                  <div style={qLabel}>Why it stopped</div>
                  <div style={{ color: '#e2e8f0' }}>{it.why_it_stopped ?? '—'}</div>
                </div>
                <div>
                  <div style={qLabel}>How it got here</div>
                  <div style={{ color: '#94a3b8', fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>
                    {it.how_it_got_here && Object.keys(it.how_it_got_here).length
                      ? Object.entries(it.how_it_got_here).map(([k, v]) => `${k}=${v}`).join('  ')
                      : `${it.detected_by} · ${new Date(it.detected_at).toLocaleString('en-IN')}`}
                  </div>
                </div>
                <div>
                  <div style={qLabel}>What to do</div>
                  <div style={{ color: '#bbf7d0' }}>{it.what_to_do ?? 'Review the evidence and decide.'}</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {it.evidence && Object.keys(it.evidence).length > 0 && (
                  <button style={btn('#334155')} onClick={() => setOpenRow(expanded ? null : it.id)}>
                    {expanded ? 'Hide evidence' : 'Show evidence'}
                  </button>
                )}
                <div style={{ flex: 1 }} />
                {/* The options the detector itself offered — the fix, not a
                    generic "mark done". */}
                {(it.options ?? []).map((o) => (
                  <button key={o.action} disabled={busy === it.id} style={btn('#16a34a')}
                          onClick={() => act(it, o.action)}>
                    {o.label || o.action}
                  </button>
                ))}
                {(!it.options || it.options.length === 0) && (
                  <button disabled={busy === it.id} style={btn('#16a34a')} onClick={() => act(it, 'ACKNOWLEDGE')}>
                    Manual Update
                  </button>
                )}
                <button disabled={busy === it.id} style={btn('#475569')} onClick={() => act(it, 'DISMISS')}>
                  Dismiss
                </button>
              </div>

              {expanded && (
                <pre style={{ ...box, marginTop: 8, maxHeight: 240, overflow: 'auto',
                              fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(it.evidence, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
