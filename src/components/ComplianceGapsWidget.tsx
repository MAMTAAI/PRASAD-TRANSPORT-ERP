// ─────────────────────────────────────────────────────────────────────────────
// Compliance & Missing Data — what the alert feed structurally cannot tell you.
//
// The expiry feed answers "what lapses soon". It is silent about the lorry that
// has no insurance record at all, because a row that does not exist has no date
// to pass. Thirteen of forty-nine lorries carried no paperwork whatsoever and
// the compliance screen showed them green.
//
// So this widget reports ABSENCE beside EXPIRY, and keeps them apart: they are
// different jobs for the office. "Renew this" goes to the agent; "find this"
// goes to whoever has the folder. Merging them into one number would hide the
// second behind the first.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1/compliance`;

type Summary = {
  vehicles_total: number; vehicles_no_docs: number; vehicles_missing_docs: number;
  vehicles_undated_docs: number; vehicles_expired: number; vehicles_expiring: number;
  drivers_total: number; drivers_missing_data: number;
  drivers_licence_expired: number; drivers_hazardous_expired: number;
  queue_pending: number; queue_driver_pending: number;
};

const card: React.CSSProperties = {
  background: 'rgba(15,23,42,0.72)', border: '1px solid #1e293b', borderRadius: 12,
  padding: '12px 14px', minWidth: 150, flex: '1 1 150px',
};
const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid rgba(30,41,59,0.7)', verticalAlign: 'top' };
const pill = (tone: string): React.CSSProperties => ({
  display: 'inline-block', background: `${tone}22`, color: tone, border: `1px solid ${tone}55`,
  borderRadius: 6, padding: '1px 7px', fontSize: 11, marginRight: 4, marginBottom: 3, whiteSpace: 'nowrap',
});

function Stat({ label, value, tone, hint }: { label: string; value: number; tone: string; hint?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 26, fontWeight: 900, color: tone, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export default function ComplianceGapsWidget() {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'VEHICLE' | 'DRIVER'>('VEHICLE');
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`${API}/gaps?limit=200`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(`Could not load the gap report — ${e.message}`));
  }, []);

  if (err) return <div style={{ ...card, borderColor: '#ef4444', color: '#fca5a5', marginBottom: 20 }}>{err}</div>;
  if (!data) return null;
  const s: Summary = data.summary ?? {};
  const win = data.alert_window_days ?? 10;

  return (
    <div style={{ marginBottom: 22, background: 'rgba(168,85,247,0.06)', border: '1px solid #a855f7',
                  borderRadius: 16, padding: 'clamp(12px, 2.5vw, 18px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#c084fc' }}>🧾 Compliance &amp; Missing Data</div>
        <div style={{ color: '#94a3b8', fontSize: 12.5 }}>
          Absence and expiry are different problems. Expiry needs renewing; absence needs finding.
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setOpen((o) => !o)}
                style={{ background: open ? '#334155' : '#a855f7', border: 'none', borderRadius: 8,
                         color: '#fff', padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      {/* ── VEHICLES ── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', letterSpacing: '.06em',
                    textTransform: 'uppercase', margin: '4px 0 6px' }}>
        Vehicle alerts · {s.vehicles_total} lorries
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="No paperwork at all" value={s.vehicles_no_docs} tone="#f87171" hint="not one document on file" />
        <Stat label="Missing a required doc" value={s.vehicles_missing_docs} tone="#fb923c" hint="of insurance, fitness, permits, PUC, MV tax" />
        <Stat label="Held but undated" value={s.vehicles_undated_docs} tone="#facc15" hint="no expiry — will never alert" />
        <Stat label="Expired" value={s.vehicles_expired} tone="#ef4444" />
        <Stat label={`Expiring in ${win} days`} value={s.vehicles_expiring} tone="#fbbf24" />
      </div>

      {/* ── DRIVERS ── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', letterSpacing: '.06em',
                    textTransform: 'uppercase', margin: '16px 0 6px' }}>
        Driver alerts · {s.drivers_total} drivers
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Missing data" value={s.drivers_missing_data} tone="#fb923c" hint="licence, Aadhaar, PAN, bank, photo…" />
        <Stat label="Licence expired" value={s.drivers_licence_expired} tone="#ef4444" hint="cannot legally drive" />
        <Stat label="Hazardous expired" value={s.drivers_hazardous_expired} tone="#ef4444" hint="cannot take petroleum" />
        <Stat label="Files awaiting assignment" value={s.queue_pending} tone="#38bdf8"
              hint={`${s.queue_driver_pending} are driver papers`} />
      </div>

      {open && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {(['VEHICLE', 'DRIVER'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                      style={{ background: tab === t ? '#a855f7' : 'transparent',
                               border: '1px solid #a855f7', borderRadius: 8, color: tab === t ? '#fff' : '#c084fc',
                               padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                {t === 'VEHICLE' ? `Lorries (${data.vehicles?.length ?? 0})` : `Drivers (${data.drivers?.length ?? 0})`}
              </button>
            ))}
          </div>

          <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto',
                        border: '1px solid #1e293b', borderRadius: 10 }}>
            {tab === 'VEHICLE' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: '#cbd5e1' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#0f172a' }}>
                  <tr>
                    <th style={{ ...cell, textAlign: 'left' }}>Lorry</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Held</th>
                    <th style={{ ...cell, textAlign: 'left' }}>Missing</th>
                    <th style={{ ...cell, textAlign: 'left' }}>Undated</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Exp / Soon</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.vehicles ?? []).map((v: any) => (
                    <tr key={v.vehicle_no}>
                      <td style={{ ...cell, fontFamily: 'ui-monospace, monospace', color: '#fff' }}>
                        {v.vehicle_no}
                        {v.owner_name && <div style={{ color: '#64748b', fontSize: 11 }}>{v.owner_name}</div>}
                      </td>
                      <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                   color: v.docs_held === 0 ? '#f87171' : '#cbd5e1', fontWeight: 700 }}>{v.docs_held}</td>
                      <td style={cell}>{(v.missing_docs ?? []).map((m: string) => <span key={m} style={pill('#fb923c')}>{m}</span>)}</td>
                      <td style={cell}>{(v.undated_docs ?? []).map((m: string, i: number) => <span key={i} style={pill('#facc15')}>{m}</span>)}</td>
                      <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ color: v.expired_count ? '#ef4444' : '#475569' }}>{v.expired_count}</span>
                        {' / '}
                        <span style={{ color: v.expiring_count ? '#fbbf24' : '#475569' }}>{v.expiring_count}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: '#cbd5e1' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#0f172a' }}>
                  <tr>
                    <th style={{ ...cell, textAlign: 'left' }}>Driver</th>
                    <th style={{ ...cell, textAlign: 'left' }}>Status</th>
                    <th style={{ ...cell, textAlign: 'left' }}>Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.drivers ?? []).map((d: any) => (
                    <tr key={d.driver_id}>
                      <td style={{ ...cell, color: '#fff' }}>
                        {d.name}
                        {d.mobile && <div style={{ color: '#64748b', fontSize: 11 }}>{d.mobile}</div>}
                      </td>
                      <td style={cell}>
                        {d.licence_expired && <span style={pill('#ef4444')}>Licence expired</span>}
                        {d.hazardous_expired && <span style={pill('#ef4444')}>HZD expired</span>}
                        {!d.licence_expired && !d.hazardous_expired && <span style={{ color: '#475569' }}>—</span>}
                      </td>
                      <td style={cell}>
                        {(d.missing_fields ?? []).map((m: string) => <span key={m} style={pill('#fb923c')}>{m}</span>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
