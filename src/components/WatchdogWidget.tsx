// ─────────────────────────────────────────────────────────────────────────────
// Live Watchdog — what is broken right now, and what was done about it.
//
// The self-healer has been detecting crashes, drafting fixes and proposing them
// for months, into a JSON file and a log. From a desk, a healer that is working
// and a healer that died three weeks ago produce exactly the same view: nothing.
// This is that work made visible.
//
// ONE WIDGET, ONE COMPANY. `company` is a required prop with no default. Prasad
// and Jaiswal share no books, no drives and no boxes, and a board that could
// show the wrong firm's incident is worse than no board.
//
// THE HEARTBEAT LINE MATTERS MORE THAN THE ALERTS. An empty board is only good
// news if something is still watching, so a stopped watchdog is reported louder
// than a quiet one — silence is the failure mode of every monitor ever written.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1/watchdog`;

type Alert = {
  id: string; company: string; environment: 'LOCAL' | 'AWS';
  host: string | null; service: string | null;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'RED' | 'DIAGNOSING' | 'FIX_PROPOSED' | 'GREEN';
  kind: string; title: string;
  error_type: string | null; error_message: string | null;
  source_file: string | null; source_line: number | null;
  fix_report: string | null; fixed_by: string | null; fixed_at: string | null;
  proposal_status: string | null;
  occurrences: number; first_seen_at: string; last_seen_at: string;
  minutes_since_seen: number;
};

const STATUS_TONE: Record<string, string> = {
  RED: '#ef4444', DIAGNOSING: '#fbbf24', FIX_PROPOSED: '#a78bfa', GREEN: '#22c55e',
};
const STATUS_LABEL: Record<string, string> = {
  RED: 'Broken', DIAGNOSING: 'Being looked at', FIX_PROPOSED: 'Fix waiting for approval', GREEN: 'Resolved',
};

const box: React.CSSProperties = {
  background: 'rgba(15,23,42,0.72)', border: '1px solid #1e293b',
  borderRadius: 12, padding: '12px 14px', color: '#e2e8f0', fontSize: 13,
};
const btn = (bg: string): React.CSSProperties => ({
  background: bg, border: 'none', borderRadius: 8, color: '#fff',
  padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
});

export default function WatchdogWidget({
  company, pollMs = 20000,
}: { company: 'PRASAD' | 'JAISWAL'; pollMs?: number }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const timer = useRef<any>(null);

  const load = async () => {
    try {
      const j = await (await fetch(`${API}/board?company=${company}`)).json();
      setAlerts(j.alerts ?? []);
      setSummary(j.summary ?? []);
      setWarning(j.watchdog_warning ?? null);
      setErr('');
    } catch (e: any) {
      // The board failing to load is itself worth showing: a blank widget would
      // read as "all clear".
      setErr(`Watchdog board unreachable — ${e.message}`);
    }
  };

  useEffect(() => {
    load();
    timer.current = setInterval(load, pollMs);
    return () => clearInterval(timer.current);
    // eslint-disable-next-line
  }, [company, pollMs]);

  const live = alerts.filter((a) => a.status !== 'GREEN');
  const red = live.filter((a) => a.status === 'RED').length;
  const critical = live.filter((a) => a.severity === 'CRITICAL').length;
  const resolved24 = summary.reduce((a, s) => a + (s.resolved_24h ?? 0), 0);

  const ack = async (a: Alert) => {
    setBusy(a.id);
    try {
      await fetch(`${API}/alert/${a.id}/acknowledge`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by: 'staff' }),
      });
      await load();
    } finally { setBusy(null); }
  };

  if (err) return <div style={{ ...box, borderColor: '#ef4444', color: '#fca5a5', marginBottom: 20 }}>{err}</div>;
  if (!live.length && !warning && !resolved24) return null;

  const headerTone = red ? '#ef4444' : live.length ? '#fbbf24' : '#22c55e';

  return (
    <div style={{ marginBottom: 22, background: `${headerTone}12`, border: `1px solid ${headerTone}`,
                  borderRadius: 16, padding: 'clamp(12px, 2.5vw, 18px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: headerTone }}>
          {red ? '🔴' : live.length ? '🟡' : '🟢'} System Watchdog
          <span style={{ marginLeft: 8, fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>
            {company === 'PRASAD' ? 'Prasad Transport' : 'Jaiswal Capital'}
          </span>
        </div>
        {live.length > 0 && (
          <span style={{ background: headerTone, color: '#0b1220', borderRadius: 999,
                         padding: '2px 10px', fontSize: 13, fontWeight: 800 }}>
            {live.length} open{critical ? ` · ${critical} critical` : ''}
          </span>
        )}
        {resolved24 > 0 && (
          <span style={{ color: '#4ade80', fontSize: 12 }}>{resolved24} resolved in 24h</span>
        )}
        <div style={{ flex: 1 }} />
        {/* Per-environment counts: the same crash on both boxes is two problems. */}
        {summary.map((s) => (
          <span key={s.environment} style={{ ...box, padding: '5px 10px', fontSize: 11.5 }}>
            <b>{s.environment}</b>
            <span style={{ color: s.red ? '#f87171' : '#4ade80', marginLeft: 6 }}>{s.red} red</span>
            <span style={{ color: '#64748b', marginLeft: 6 }}>
              {s.watchdogs_alive}/{s.watchdogs} watching
            </span>
          </span>
        ))}
      </div>

      {warning && (
        <div style={{ ...box, marginTop: 10, borderColor: '#fb923c', color: '#fdba74' }}>
          ⚠ {warning}
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 9,
                    maxHeight: 480, overflowY: 'auto' }}>
        {alerts.map((a) => {
          const open = openRow === a.id;
          const tone = STATUS_TONE[a.status];
          return (
            <div key={a.id} style={{ ...box, borderLeft: `3px solid ${tone}` }}>
              <div style={{ display: 'flex', gap: 9, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: tone, fontWeight: 800, fontSize: 11, letterSpacing: '.05em' }}>
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
                <span style={{ color: '#94a3b8', fontSize: 11 }}>{a.environment}</span>
                {a.service && <span style={{ color: '#64748b', fontSize: 11 }}>{a.service}</span>}
                {a.severity === 'CRITICAL' && (
                  <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 700 }}>CRITICAL</span>
                )}
                {a.occurrences > 1 && (
                  <span style={{ color: '#fbbf24', fontSize: 11 }}>{a.occurrences}× </span>
                )}
                {a.proposal_status && (
                  <span style={{ color: '#a78bfa', fontSize: 11 }}>proposal: {a.proposal_status}</span>
                )}
              </div>

              <div style={{ fontWeight: 700, color: '#fff', margin: '4px 0' }}>{a.title}</div>
              {a.source_file && (
                <div style={{ color: '#64748b', fontSize: 11.5, fontFamily: 'ui-monospace, monospace' }}>
                  {a.source_file}{a.source_line ? `:${a.source_line}` : ''}
                </div>
              )}
              {a.error_message && a.status !== 'GREEN' && (
                <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 4 }}>{a.error_message}</div>
              )}

              {/* The fix report is the point of the green state. Shown inline,
                  not behind a click: a resolution nobody reads is a colour. */}
              {a.status === 'GREEN' && a.fix_report && (
                <div style={{ ...box, marginTop: 8, borderColor: '#22c55e', background: 'rgba(34,197,94,0.06)' }}>
                  <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase',
                                color: '#4ade80', marginBottom: 4 }}>
                    Fix report{a.fixed_by ? ` · ${a.fixed_by}` : ''}
                    {a.fixed_at ? ` · ${new Date(a.fixed_at).toLocaleString('en-IN')}` : ''}
                  </div>
                  <div style={{ color: '#dcfce7', whiteSpace: 'pre-wrap' }}>{a.fix_report}</div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: '#475569', fontSize: 11 }}>
                  last seen {a.minutes_since_seen < 1 ? 'just now' : `${a.minutes_since_seen} min ago`}
                </span>
                <div style={{ flex: 1 }} />
                {a.status === 'RED' && (
                  <button disabled={busy === a.id} style={btn('#fbbf24')} onClick={() => ack(a)}>
                    I am on it
                  </button>
                )}
                <button style={btn('#334155')} onClick={() => setOpenRow(open ? null : a.id)}>
                  {open ? 'Hide detail' : 'Detail'}
                </button>
              </div>

              {open && (
                <pre style={{ ...box, marginTop: 8, fontSize: 11, maxHeight: 220,
                              overflow: 'auto', whiteSpace: 'pre-wrap' }}>
{`kind        ${a.kind}
host        ${a.host ?? '—'}
error       ${a.error_type ?? '—'}
first seen  ${new Date(a.first_seen_at).toLocaleString('en-IN')}
last seen   ${new Date(a.last_seen_at).toLocaleString('en-IN')}
occurrences ${a.occurrences}`}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
