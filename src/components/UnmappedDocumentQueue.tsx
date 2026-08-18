// ─────────────────────────────────────────────────────────────────────────────
// Unmapped Documents — the queue for paperwork the bulk importer could not file.
//
// The importer used to SKIP what it could not place. That is the failure this
// screen exists to end: a skipped file is invisible, and invisible paperwork is
// indistinguishable from paperwork nobody ever scanned. Everything unplaceable
// now lands here with the reason it could not be filed and whatever the parser
// did manage to read.
//
// A SUGGESTION IS NOT AN ASSIGNMENT. The parser fills the row; a person presses
// the button. Nothing reaches vehicle_documents or a driver record until it is
// accepted, because the point of a compliance register is that what it says is
// true — an auto-filed guess that puts a valid permit on the wrong lorry is
// worse than an empty row.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { API_BASE } from '../lib/apiBase';
import { extractDocument } from '../lib/aiScanner';

const API = `${API_BASE}/api/v1/compliance`;

type Item = {
  id: string;
  source_path: string;
  reason: 'DRIVER_DOCUMENT' | 'NO_VEHICLE_PROOF' | 'MISFILED' | 'UNCLASSIFIED' | 'NO_EXPIRY';
  reason_detail: string | null;
  hold_reason: 'WOULD_OVERWRITE' | 'MULTIPLE_CANDIDATES' | 'NO_COLUMN' | 'NO_DRIVER' | 'NEEDS_REVIEW';
  hold_detail: string | null;
  occupies_slot: string | null;
  suggested_scope: 'VEHICLE' | 'DRIVER' | null;
  suggested_doc_type: string | null;
  suggested_doc_name: string | null;
  suggested_expiry: string | null;
  suggested_vehicle_id: string | null;
  suggested_vehicle_no: string | null;
  suggested_driver_id: string | null;
  suggested_driver_name: string | null;
  scanned_at: string | null;
};

const REASON_LABEL: Record<string, string> = {
  DRIVER_DOCUMENT: "Driver's paperwork — needs a driver",
  NO_VEHICLE_PROOF: 'No registration found — needs a vehicle',
  MISFILED: 'Filed under the wrong lorry',
  UNCLASSIFIED: 'Document type not recognised',
  NO_EXPIRY: 'No expiry date found',
};

// WHY IT IS STILL HERE, which is a different question from how it arrived — and
// the one that decides what the clerk has to do about it. Each label says the
// action, not the state: "pick which one" is a job, "MULTIPLE_CANDIDATES" is a
// database value.
const HOLD_LABEL: Record<string, string> = {
  WOULD_OVERWRITE: 'Already has one on file — compare, then replace or drop',
  MULTIPLE_CANDIDATES: 'Several of this type queued — pick the current one',
  NO_COLUMN: 'No field exists for this document yet',
  NO_DRIVER: 'No driver could be suggested for this lorry',
  NEEDS_REVIEW: 'Needs a look',
};
const HOLD_TONE: Record<string, string> = {
  WOULD_OVERWRITE: '#f87171', MULTIPLE_CANDIDATES: '#fbbf24',
  NO_COLUMN: '#a78bfa', NO_DRIVER: '#fb923c', NEEDS_REVIEW: '#38bdf8',
};

const box: React.CSSProperties = {
  background: 'rgba(15,23,42,0.75)', border: '1px solid #1e293b',
  borderRadius: 12, padding: '10px 12px', color: '#e2e8f0', fontSize: 13,
};
const btn = (bg: string): React.CSSProperties => ({
  background: bg, border: 'none', borderRadius: 8, color: '#fff',
  padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
});

export default function UnmappedDocumentQueue({
  vehicles = [], drivers = [], onAssigned,
}: { vehicles?: any[]; drivers?: any[]; onAssigned?: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [hold, setHold] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [edits, setEdits] = useState<Record<string, any>>({});
  // When several copies of one document compete, the clerk needs them side by
  // side, not scattered through a list of forty. This narrows to that group.
  const [group, setGroup] = useState<{ driver: string; type: string } | null>(null);

  const load = async () => {
    try {
      const qs = hold ? `?hold_reason=${encodeURIComponent(hold)}` : '';
      const r = await fetch(`${API}/unmapped${qs}`);
      const j = await r.json();
      setItems(j.items ?? []);
      setSummary(j.summary ?? []);
    } catch (e: any) { setMsg(`Could not load the queue — ${e.message}`); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [hold]);

  const pending = summary.reduce((a, s) => a + (s.pending ?? 0), 0);
  const patch = (id: string, k: string, v: any) => setEdits((e) => ({ ...e, [id]: { ...e[id], [k]: v } }));
  const val = (it: Item, k: string, fallback: any) => edits[it.id]?.[k] ?? fallback;

  // Mamta AI Scan: the browser reads the page with the local pipeline
  // (pdf.js -> Tesseract -> local LLM), then the SERVER interprets the text
  // using the same patterns the bulk importer uses. One parser, one answer.
  const scan = async (it: Item) => {
    setBusy(it.id); setMsg('');
    try {
      const res = await fetch(`${API}/unmapped/${it.id}/file`);
      if (!res.ok) throw new Error(`file unavailable (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], it.source_path.split(/[\\/]/).pop() || 'document', { type: blob.type });

      const read = await extractDocument(file, it.suggested_doc_name ?? 'compliance document');
      const text = [read?.document_number, read?.expiry_date, read?.issue_date, read?.holder_name,
                    (read as any)?._rawText].filter(Boolean).join('\n');
      if (!text.trim()) throw new Error('the scanner read nothing from this page');

      const p = await fetch(`${API}/unmapped/parse`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, id: it.id, persist: true }),
      }).then((r) => r.json());

      setEdits((e) => ({ ...e, [it.id]: {
        ...e[it.id],
        doc_type: p.doc_type ?? it.suggested_doc_type,
        expiry: p.expiry_date ?? it.suggested_expiry,
        vehicle_id: p.matched_vehicle?.id ?? it.suggested_vehicle_id,
        scope: p.scope ?? it.suggested_scope,
      } }));
      setMsg(p.needs_human
        ? `Scanned ${it.source_path.split(/[\\/]/).pop()} — the scan is incomplete, check the fields before filing.`
        : `Scanned: ${p.doc_name} for ${p.matched_vehicle?.vehicle_no}, expires ${p.expiry_date}.`);
      await load();
    } catch (e: any) {
      setMsg(`Scan failed — ${e.message}`);
    } finally { setBusy(null); }
  };

  const assign = async (it: Item) => {
    setBusy(it.id); setMsg('');
    const scope = val(it, 'scope', it.suggested_scope);
    const body: any = {
      scope,
      doc_type: val(it, 'doc_type', it.suggested_doc_type),
      expiry: val(it, 'expiry', it.suggested_expiry) || null,
    };
    if (scope === 'VEHICLE') body.vehicle_id = val(it, 'vehicle_id', it.suggested_vehicle_id);
    else body.driver_id = val(it, 'driver_id', it.suggested_driver_id);
    try {
      const r = await fetch(`${API}/unmapped/${it.id}/assign`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setMsg(`Filed as ${j.kind === 'DRIVER' ? `driver record (${j.column})` : 'vehicle document'}.`);
      await load(); onAssigned?.();
    } catch (e: any) { setMsg(`Could not file it — ${e.message}`); }
    finally { setBusy(null); }
  };

  const dismiss = async (it: Item) => {
    const note = window.prompt('Why is this being dismissed? (kept on the record)');
    if (note === null) return;
    setBusy(it.id);
    try {
      await fetch(`${API}/unmapped/${it.id}/dismiss`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }),
      });
      await load();
    } finally { setBusy(null); }
  };

  if (!pending && !open) return null;

  return (
    <div style={{ marginBottom: 22, background: 'rgba(56,189,248,0.06)', border: '1px solid #0ea5e9',
                  borderRadius: 16, padding: 'clamp(12px, 2.5vw, 18px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#38bdf8' }}>
          📥 Unmapped Documents
          <span style={{ marginLeft: 10, background: '#0ea5e9', color: '#001018', borderRadius: 999,
                         padding: '2px 10px', fontSize: 13 }}>{pending}</span>
        </div>
        <div style={{ flex: 1 }} />
        <select value={hold} onChange={(e) => setHold(e.target.value)}
                style={{ ...box, padding: '7px 10px', maxWidth: 340 }}>
          <option value="">Everything waiting ({pending})</option>
          {Object.entries(
            summary.filter((s: any) => s.pending > 0).reduce((m: any, s: any) => {
              m[s.hold_reason] = (m[s.hold_reason] ?? 0) + s.pending; return m;
            }, {})
          ).map(([h, n]) => (
            <option key={h} value={h}>{HOLD_LABEL[h] ?? h} ({n as number})</option>
          ))}
        </select>
        <button style={btn(open ? '#334155' : '#0ea5e9')} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Review'}
        </button>
      </div>

      <div style={{ marginTop: 8, color: '#94a3b8', fontSize: 12.5 }}>
        Nothing here has been filed. Each row shows what the parser read; you decide where it goes.
      </div>
      {msg && <div style={{ marginTop: 8, ...box, borderColor: '#0ea5e9' }}>{msg}</div>}

      {open && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 560, overflowY: 'auto' }}>
          {group && (
            <div style={{ ...box, borderColor: '#fbbf24', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span>Showing only the competing copies of <b>{group.type}</b> for <b>{group.driver}</b> — approve one, dismiss the rest.</span>
              <div style={{ flex: 1 }} />
              <button style={btn('#475569')} onClick={() => setGroup(null)}>Show everything again</button>
            </div>
          )}
          {items.length === 0 && <div style={box}>Nothing pending in this filter.</div>}
          {items
            .filter((it) => !group || (it.suggested_driver_name === group.driver && it.suggested_doc_name === group.type))
            .map((it) => {
            const scope = val(it, 'scope', it.suggested_scope);
            const fileName = it.source_path.split(/[\\/]/).pop();
            return (
              <div key={it.id} style={{ ...box, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ color: HOLD_TONE[it.hold_reason] ?? '#94a3b8', fontWeight: 700, fontSize: 11.5,
                                 textTransform: 'uppercase', letterSpacing: '.06em' }}>
                    {HOLD_LABEL[it.hold_reason] ?? it.hold_reason}
                  </span>
                  <a href={`${API}/unmapped/${it.id}/file`} target="_blank" rel="noreferrer"
                     style={{ color: '#e2e8f0', fontWeight: 600 }}>{fileName}</a>
                  {it.scanned_at && <span style={{ color: '#4ade80', fontSize: 11 }}>✓ scanned</span>}
                </div>
                <div style={{ color: '#64748b', fontSize: 11.5 }}>{it.source_path}</div>
                {it.hold_detail && <div style={{ color: '#e2e8f0', fontSize: 12.5 }}>{it.hold_detail}</div>}
                {it.occupies_slot && (
                  <div style={{ fontSize: 12 }}>
                    <span style={{ color: '#94a3b8' }}>already on file: </span>
                    <a href={`${API_BASE}/api/v1/files/${encodeURIComponent(String(it.occupies_slot))}`}
                       target="_blank" rel="noreferrer" style={{ color: '#fbbf24' }}>
                      open the existing one to compare
                    </a>
                  </div>
                )}
                {/* How it arrived, under why it is stuck — the second line gives
                    the first one context without competing with it. */}
                <div style={{ color: '#64748b', fontSize: 11.5 }}>
                  {REASON_LABEL[it.reason] ?? it.reason}
                  {it.reason_detail ? ` · ${it.reason_detail}` : ''}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={scope ?? ''} onChange={(e) => patch(it.id, 'scope', e.target.value)}
                          style={{ ...box, padding: '6px 8px' }}>
                    <option value="">— belongs to —</option>
                    <option value="VEHICLE">Vehicle</option>
                    <option value="DRIVER">Driver</option>
                  </select>

                  {scope === 'DRIVER' ? (
                    <select value={val(it, 'driver_id', it.suggested_driver_id) ?? ''}
                            onChange={(e) => patch(it.id, 'driver_id', e.target.value)}
                            style={{ ...box, padding: '6px 8px', minWidth: 190 }}>
                      <option value="">— pick the driver —</option>
                      {drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  ) : (
                    <select value={val(it, 'vehicle_id', it.suggested_vehicle_id) ?? ''}
                            onChange={(e) => patch(it.id, 'vehicle_id', e.target.value)}
                            style={{ ...box, padding: '6px 8px', minWidth: 190 }}>
                      <option value="">— pick the lorry —</option>
                      {vehicles.map((v: any) => (
                        <option key={v.id} value={v.id}>{v.vehicle_no ?? v.vehicleNo}</option>
                      ))}
                    </select>
                  )}

                  <input value={val(it, 'doc_type', it.suggested_doc_type) ?? ''}
                         onChange={(e) => patch(it.id, 'doc_type', e.target.value)}
                         placeholder="document type" style={{ ...box, padding: '6px 8px', width: 170 }} />
                  <input type="date" value={(val(it, 'expiry', it.suggested_expiry) ?? '').slice(0, 10)}
                         onChange={(e) => patch(it.id, 'expiry', e.target.value)}
                         style={{ ...box, padding: '6px 8px' }} />

                  <div style={{ flex: 1 }} />
                  <button disabled={busy === it.id} style={btn('#7c3aed')} onClick={() => scan(it)}>
                    {busy === it.id ? '…' : '🤖 Mamta AI Scan'}
                  </button>

                  {/* Two different jobs, so two different buttons. Approving over
                      an existing file is a decision; filling an empty slot is
                      data entry, and calling both "File it" hid the difference. */}
                  {it.hold_reason === 'MULTIPLE_CANDIDATES' && !group && (
                    <button style={btn('#d97706')}
                            onClick={() => setGroup({ driver: it.suggested_driver_name ?? '', type: it.suggested_doc_name ?? '' })}>
                      Compare the copies
                    </button>
                  )}
                  <button disabled={busy === it.id} style={btn('#16a34a')} onClick={() => assign(it)}>
                    {it.occupies_slot ? 'Compare & Approve' : 'Manual Update'}
                  </button>
                  <button disabled={busy === it.id} style={btn('#475569')} onClick={() => dismiss(it)}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
