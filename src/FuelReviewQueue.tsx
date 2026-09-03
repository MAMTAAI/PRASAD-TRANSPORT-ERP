// @ts-nocheck
// ============================================================================
// ⛽ FUEL IMPORT — MANUAL VERIFICATION QUEUE
//
// Every pump-bill row the importer REFUSED to post, with the reason it refused.
// Nothing on this screen has touched a ledger and nothing on it can: resolving
// a row marks it handled, it does not book money. Correcting a row means fixing
// it at the source and re-running the import, which is the only path into
// ledger_entries.
//
// WHY THE REASONS ARE SPELLED OUT RATHER THAN COUNTED. "137 rows failed" tells
// an operator nothing they can act on. "12 bills print the lorry number
// truncated to AS26C" tells them to ring that pump. The reasons are grouped and
// explained in the language of the problem, not the parser.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from './lib/apiBase';

const API = API_BASE;

// What each machine reason actually means for the person reading it, and what
// they are supposed to do about it.
const REASONS = {
  NO_VEHICLE: {
    label: 'No vehicle number on the line',
    fix: 'The bill line did not carry a registration the parser could read. Check the PDF; the pump may have left it blank.',
    tone: '#ff8b9c',
  },
  TRUNCATED_VEHICLE: {
    label: 'Lorry number printed incomplete',
    fix: 'The pump prints only the series (e.g. "AS26C") with no digits. Ask that pump to print full registrations — nobody can tell which of the 49 trucks it was.',
    tone: '#fbbf24',
  },
  POSSIBLE_DUPLICATE_SAME_DAY: {
    label: 'Same truck, same day, different amount',
    fix: 'Fuel already exists for this truck on this date for another amount. Either it is a second fill (import it) or the same fill recorded twice (discard).',
    tone: '#fbbf24',
  },
  AMOUNT_MISMATCH: {
    label: 'Amount does not equal qty × rate',
    fix: 'The three printed numbers disagree. Check the bill and correct whichever is wrong before importing.',
    tone: '#fbbf24',
  },
  DATE_OUT_OF_PERIOD: {
    label: 'Date falls outside the bill period',
    fix: 'A row dated outside the bill’s own From–To window — usually a typo on the bill itself.',
    tone: '#fbbf24',
  },
  VEHICLE_NOT_IN_MASTER: {
    label: 'Registration not in the fleet',
    fix: 'No truck in the master matches, and it is not one character away from one either. Add the vehicle, or correct the bill.',
    tone: '#ff8b9c',
  },
  AMBIGUOUS_VEHICLE: {
    label: 'Could be two different trucks',
    fix: 'The registration is one character away from MORE than one truck, so a machine cannot choose. Pick the right one by hand.',
    tone: '#ff8b9c',
  },
  ALREADY_IMPORTED: {
    label: 'Already in the books',
    fix: 'Identical vehicle, date and amount already exist. Safe to discard.',
    tone: '#9aadd4',
  },
  PARSER_REVIEW: {
    label: 'Parser could not trust the row',
    fix: 'The bill layout produced an incomplete row. Needs reading by eye.',
    tone: '#9aadd4',
  },
  NO_PUMP_LEDGER: {
    label: 'No creditor account for this pump',
    fix: 'Create the pump’s ledger under Sundry Creditors (Fuel Pumps), then re-import.',
    tone: '#ff8b9c',
  },
  ATTACHED_WITHOUT_OWNER_LEDGER: {
    label: 'Attached truck has no owner khata',
    fix: 'This truck is marked attached but has no owner ledger, so its diesel has nowhere to go. Set it in the Vehicle Master.',
    tone: '#ff8b9c',
  },
};

const money = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

export default function FuelReviewQueue() {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [detail, setDetail] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/v1/fuel/review-queue`);
      if (!res.ok) { setState('error'); setDetail(`API ${res.status}`); return; }
      setData(await res.json());
      setState('ok');
    } catch (e) { setState('error'); setDetail(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const resolve = async (id, status) => {
    setBusy(id);
    try {
      await fetch(`${API}/api/v1/fuel/review-queue/${id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, by: 'office' }),
      });
      await load();
    } finally { setBusy(null); }
  };

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return filter ? all.filter((r) => (r.reasons ?? []).includes(filter)) : all;
  }, [data, filter]);

  if (state === 'error') {
    return <Shell><p style={{ color: '#fcd34d' }}>Queue unavailable — {detail}</p></Shell>;
  }

  const byReason = data?.by_reason ?? {};
  const total = data?.count ?? 0;

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: 26, fontWeight: 900, color: '#ffb224' }}>
            ⛽ Fuel Import — Manual Verification
          </h1>
          <p style={{ margin: 0, color: '#9aadd4', fontSize: 13 }}>
            Pump-bill rows the importer refused to post. <b style={{ color: '#dde5f4' }}>None of these has touched a ledger.</b>
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 30, fontWeight: 900, color: total ? '#fbbf24' : '#2fe39b' }}>{total}</div>
          <div style={{ fontSize: 10, letterSpacing: '.1em', color: '#5d7196', fontWeight: 800 }}>AWAITING REVIEW</div>
        </div>
      </div>

      {/* reason cards — the actionable summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 20 }}>
        {Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([code, n]) => {
          const meta = REASONS[code] ?? { label: code, fix: '', tone: '#9aadd4' };
          const on = filter === code;
          return (
            <button key={code} onClick={() => setFilter(on ? '' : code)}
              style={{
                textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 14,
                background: on ? 'rgba(255, 178, 36,.14)' : 'rgba(24, 36, 74,.5)',
                border: `1px solid ${on ? meta.tone : '#27395f'}`, color: '#dde5f4',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: meta.tone }}>{meta.label}</span>
                <span style={{ fontSize: 16, fontWeight: 900 }}>{n}</span>
              </div>
              {meta.fix && <p style={{ margin: '6px 0 0', fontSize: 10.5, color: '#9aadd4', lineHeight: 1.5 }}>{meta.fix}</p>}
            </button>
          );
        })}
      </div>

      {filter && (
        <p style={{ marginBottom: 10, fontSize: 12, color: '#22d3ee' }}>
          Showing <b>{REASONS[filter]?.label ?? filter}</b> only ·{' '}
          <button onClick={() => setFilter('')} style={{ background: 'none', border: 'none', color: '#9aadd4', cursor: 'pointer', textDecoration: 'underline' }}>
            show all
          </button>
        </p>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid #27395f', borderRadius: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#18244a' }}>
              {['Pump', 'Bill file', 'Date', 'Vehicle (as printed)', 'Qty', 'Rate', 'Amount', 'Why', ''].map((h) => (
                <th key={h} style={{ padding: '9px 8px', textAlign: h === 'Qty' || h === 'Rate' || h === 'Amount' ? 'right' : 'left',
                                     fontSize: 9.5, letterSpacing: '.07em', color: '#9aadd4', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state === 'loading' && <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: '#5d7196' }}>Loading…</td></tr>}
            {state === 'ok' && rows.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: '#2fe39b' }}>
                Nothing waiting — every parsed row was either posted or already handled.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #18244a' }}>
                <td style={{ padding: '8px', fontWeight: 700 }}>{r.pump}</td>
                <td style={{ padding: '8px', color: '#5d7196', fontSize: 10.5, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.source_file}</td>
                <td style={{ padding: '8px' }}>{r.entry_date ?? <span style={{ color: '#ff8b9c' }}>none</span>}</td>
                <td style={{ padding: '8px', fontFamily: 'ui-monospace, monospace' }}>
                  {r.vehicle_raw ?? <span style={{ color: '#ff8b9c' }}>blank</span>}
                </td>
                <td style={{ padding: '8px', textAlign: 'right' }}>{money(r.qty)}</td>
                <td style={{ padding: '8px', textAlign: 'right' }}>{money(r.rate)}</td>
                <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700 }}>{money(r.amount)}</td>
                <td style={{ padding: '8px' }}>
                  {(r.reasons ?? []).map((x) => (
                    <span key={x} style={{
                      display: 'inline-block', margin: '1px 3px 1px 0', padding: '2px 6px', borderRadius: 6,
                      background: 'rgba(255, 178, 36,.14)', color: REASONS[x]?.tone ?? '#9aadd4', fontSize: 9, fontWeight: 800,
                    }}>{REASONS[x]?.label ?? x}</span>
                  ))}
                </td>
                <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                  <button disabled={busy === r.id} onClick={() => resolve(r.id, 'RESOLVED')}
                    style={btn('#2fe39b')}>Handled</button>
                  <button disabled={busy === r.id} onClick={() => resolve(r.id, 'DISCARDED')}
                    style={{ ...btn('#3d548a'), marginLeft: 6 }}>Discard</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 12, fontSize: 10.5, color: '#5d7196', lineHeight: 1.6 }}>
        “Handled” and “Discard” only clear the row from this queue — neither books anything.
        To bring a row into the accounts, fix it at source and re-run the pump-bill import;
        that is the only path that writes to a ledger.
      </p>
    </Shell>
  );
}

const btn = (bg) => ({
  background: bg, color: '#04121f', border: 'none', borderRadius: 7,
  padding: '5px 9px', fontSize: 10.5, fontWeight: 900, cursor: 'pointer',
});

const Shell = ({ children }) => (
  <div style={{ color: '#dde5f4', fontFamily: "'Inter', sans-serif", paddingBottom: 40 }}>{children}</div>
);
