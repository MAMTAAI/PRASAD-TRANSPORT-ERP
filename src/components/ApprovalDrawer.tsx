// @ts-nocheck
// ============================================================================
// SMART APPROVAL DESK — the drawer (2026-09-02)
//
// One component behind every "View" on the approval desks: the document
// rendered IN PLACE (a PDF in an iframe, a photo as an image — token-fetched
// from the vault, never a bare <a href> that would 401), the row's fields
// editable beside it, and the decisions next to the paper: Approve (with the
// edits), Reject (reason mandatory), Print, Open in new tab.
//
// It owns no business rule. The caller says what the fields are, whether the
// viewer may decide, and what Approve / Reject / Save actually call. Used by
// PendingExpenses (expense bills + app uploads) and BazaarAdmin (POD verify).
// ============================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

const CSS = `
@keyframes adFade { from { opacity: 0 } to { opacity: 1 } }
@keyframes adSlide { from { transform: translateX(40px); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes adPop { from { transform: scale(.96); opacity: 0 } to { transform: none; opacity: 1 } }
.ad-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(2,6,23,.72); backdrop-filter: blur(6px); animation: adFade .18s ease; display: flex; justify-content: flex-end; }
.ad-panel { width: min(1180px, 100vw); height: 100%; background: #0b1220; border-left: 1px solid #1e293b; display: grid; grid-template-rows: auto 1fr; animation: adSlide .22s cubic-bezier(.2,.8,.2,1); color: #e2e8f0; font-family: 'Inter', system-ui, sans-serif; }
.ad-head { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid #1e293b; background: linear-gradient(180deg, #0f172a, #0b1220); }
.ad-body { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, .9fr); min-height: 0; }
.ad-viewer { position: relative; background: #020617; border-right: 1px solid #1e293b; display: flex; flex-direction: column; min-height: 0; }
.ad-viewer iframe, .ad-viewer img { flex: 1; width: 100%; height: 100%; border: 0; object-fit: contain; background: #0b1220; }
.ad-side { overflow: auto; padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 14px; }
.ad-tool { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #1e293b; background: #0b1220; font-size: 12px; color: #94a3b8; }
.ad-btn { min-height: 40px; padding: 0 14px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-weight: 700; font-size: 12.5px; cursor: pointer; transition: transform .12s ease, background .15s, border-color .15s, opacity .15s; display: inline-flex; align-items: center; gap: 6px; }
.ad-btn:hover { transform: translateY(-1px); border-color: #475569; }
.ad-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.ad-btn--ok { background: linear-gradient(135deg, #10b981, #059669); border-color: transparent; color: #fff; }
.ad-btn--no { background: rgba(239,68,68,.1); border-color: rgba(239,68,68,.45); color: #fca5a5; }
.ad-btn--ghost { background: transparent; }
.ad-field { display: grid; gap: 4px; }
.ad-label { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: #64748b; font-weight: 700; }
.ad-val { font-size: 14px; color: #f1f5f9; min-height: 22px; word-break: break-word; }
.ad-input { width: 100%; box-sizing: border-box; background: #020617; border: 1px solid #334155; color: #f1f5f9; border-radius: 9px; padding: 9px 11px; font-size: 14px; color-scheme: dark; transition: border-color .15s, box-shadow .15s; }
.ad-input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,.18); }
.ad-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .04em; border: 1px solid transparent; }
.ad-amount { font-size: 34px; font-weight: 900; letter-spacing: -.02em; line-height: 1.1; }
.ad-reason { animation: adPop .16s ease; background: rgba(239,68,68,.06); border: 1px dashed rgba(239,68,68,.5); border-radius: 12px; padding: 12px; display: grid; gap: 8px; }
.ad-note { font-size: 11.5px; color: #64748b; line-height: 1.55; }
.ad-milan { border: 1px solid rgba(139,92,246,.4); background: rgba(139,92,246,.07); border-radius: 12px; padding: 10px 12px; display: grid; gap: 8px; }
.ad-mhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; font-weight: 900; color: #c4b5fd; }
.ad-mrow { display: grid; grid-template-columns: minmax(70px, .8fr) 1fr 1fr auto; gap: 8px; align-items: center; font-size: 12px; padding: 6px 8px; border-radius: 9px; background: rgba(2,6,23,.45); }
.ad-mrow .k { color: #94a3b8; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
.ad-mrow .v { color: #f1f5f9; word-break: break-word; }
.ad-mrow .ocr { color: #c4b5fd; font-weight: 700; word-break: break-word; }
.ad-mbtn { min-height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid rgba(139,92,246,.5); background: rgba(139,92,246,.15); color: #e9d5ff; font-size: 11px; font-weight: 800; cursor: pointer; }
.ad-mbtn:disabled { opacity: .4; cursor: not-allowed; }
.ad-raw { font-size: 11px; color: #94a3b8; white-space: pre-wrap; max-height: 160px; overflow: auto; background: rgba(2,6,23,.5); border-radius: 8px; padding: 8px; }
@media (max-width: 860px) { .ad-body { grid-template-columns: 1fr; grid-template-rows: 46vh 1fr } .ad-viewer { border-right: 0; border-bottom: 1px solid #1e293b } .ad-panel { width: 100vw } }
`;

const TONES = {
  green: { color: '#34d399', background: 'rgba(16,185,129,.12)', borderColor: 'rgba(16,185,129,.35)' },
  amber: { color: '#fbbf24', background: 'rgba(245,158,11,.12)', borderColor: 'rgba(245,158,11,.35)' },
  red:   { color: '#f87171', background: 'rgba(239,68,68,.12)', borderColor: 'rgba(239,68,68,.35)' },
  cyan:  { color: '#38bdf8', background: 'rgba(56,189,248,.12)', borderColor: 'rgba(56,189,248,.35)' },
  violet:{ color: '#a78bfa', background: 'rgba(139,92,246,.12)', borderColor: 'rgba(139,92,246,.35)' },
  slate: { color: '#94a3b8', background: 'rgba(148,163,184,.12)', borderColor: 'rgba(148,163,184,.3)' },
};
export const Pill = ({ tone = 'slate', children }) => <span className="ad-pill" style={TONES[tone] ?? TONES.slate}>{children}</span>;

let cssMounted = false;
function useCss() {
  useEffect(() => {
    if (cssMounted) return;
    const s = document.createElement('style'); s.setAttribute('data-approval-drawer', '1'); s.textContent = CSS;
    document.head.appendChild(s); cssMounted = true;
  }, []);
}

/** Token-fetch a vault key → { url, kind: 'pdf'|'image'|'other', error }. */
function useVaultBlob(fileKey, open) {
  const [state, setState] = useState({ url: null, kind: null, error: null, loading: false });
  useEffect(() => {
    if (!open || !fileKey) { setState({ url: null, kind: null, error: null, loading: false }); return; }
    let url = null; let alive = true;
    setState({ url: null, kind: null, error: null, loading: true });
    (async () => {
      try {
        const token = localStorage.getItem('prasad_token');
        const r = await fetch(`${API_BASE}/api/v1/files/${fileKey}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!r.ok) throw new Error(`file ${r.status}`);
        const blob = await r.blob();
        url = URL.createObjectURL(blob);
        const type = blob.type || '';
        const kind = type.includes('pdf') || /\.pdf$/i.test(fileKey) ? 'pdf' : type.startsWith('image/') ? 'image' : 'other';
        if (alive) setState({ url, kind, error: null, loading: false });
      } catch (e) {
        if (alive) setState({ url: null, kind: null, error: e.message, loading: false });
      }
    })();
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [fileKey, open]);
  return state;
}

export default function ApprovalDrawer({
  open, onClose,
  title, subtitle, accent = '#38bdf8',
  fileKey = null, fileLabel = 'Document',
  amount = null, amountLabel = 'Amount',
  chips = [],                 // [{ label, tone }]
  fields = [],                // [{ key, label, value, editable, type: 'text'|'number'|'date'|'select', options: [{value,label}] , hint }]
  canDecide = false,
  approveLabel = '✅ Approve',
  rejectLabel = '✖ Reject',
  onApprove,                  // async (edits) => void   — edits = { key: value } for editable fields that changed
  onReject,                   // async (reason) => void
  onSaveEdits,                // optional async (edits) => void — "Save changes" without deciding
  footnote,
  children,                   // extra side content
  // THE "MILAN" (audit) PANEL — what BHUVANESHWARI read on the paper, shown
  // against the fields so the admin matches by eye and takes a value with one
  // click: { status, engine, at, error, kind, confident, suggest: {field: value}, raw: {k: v}, text }
  ocr = null,
}) {
  useCss();
  const blob = useVaultBlob(fileKey, open);
  const iframeRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [rawOpen, setRawOpen] = useState(false);   // the Milan panel's "everything the reader saw"

  useEffect(() => {
    if (!open) return;
    setEditing(false); setRejecting(false); setReason(''); setBusy(''); setErr('');
    setDraft(Object.fromEntries(fields.map((f) => [f.key, f.value ?? ''])));
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, title]);

  const edits = useMemo(() => {
    const out = {};
    for (const f of fields) {
      if (!f.editable) continue;
      const a = String(f.value ?? ''); const b = String(draft[f.key] ?? '');
      if (a !== b) out[f.key] = f.type === 'number' ? Number(draft[f.key]) : draft[f.key];
    }
    return out;
  }, [draft, fields]);
  const dirty = Object.keys(edits).length > 0;

  const run = async (name, fn) => {
    setBusy(name); setErr('');
    try { await fn(); }
    catch (e) { setErr(e?.message || 'failed'); }
    finally { setBusy(''); }
  };

  const print = () => {
    try {
      if (blob.kind === 'pdf' && iframeRef.current?.contentWindow) { iframeRef.current.contentWindow.focus(); iframeRef.current.contentWindow.print(); return; }
      if (blob.url) {
        const w = window.open('', '_blank', 'noopener');
        if (!w) return;
        w.document.write(`<html><head><title>${title ?? 'Print'}</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;background:#fff">`
          + (blob.kind === 'image' ? `<img src="${blob.url}" style="max-width:100%;max-height:100vh" onload="window.print()">` : `<iframe src="${blob.url}" style="width:100vw;height:100vh;border:0" onload="window.print()"></iframe>`)
          + '</body></html>');
        w.document.close();
      } else {
        window.print();
      }
    } catch { /* browser refused — the toolbar's Open still works */ }
  };

  if (!open) return null;
  const liveAmount = fields.find((f) => f.key === 'amount' && f.editable) ? Number(draft.amount) : amount;

  // ── Milan: OCR proposal vs the admin's values ──
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const sameValue = (a, b) => {
    if (a === '' || a == null || b === '' || b == null) return false;
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return Math.abs(na - nb) < 0.005;
    return norm(a) === norm(b);
  };
  const ocrRows = ocr?.status === 'DONE'
    ? Object.entries(ocr.suggest ?? {}).map(([key, value]) => {
        const f = fields.find((x) => x.key === key);
        return { key, value, label: f?.label ?? key.replace(/_/g, ' '), editable: !!f?.editable, current: f ? (draft[key] ?? f.value ?? '') : null };
      })
    : [];
  const useOcr = (key, value) => { setDraft((d) => ({ ...d, [key]: value })); setEditing(true); };
  const useAllOcr = () => {
    const next = {};
    for (const r of ocrRows) if (r.editable && !sameValue(r.current, r.value)) next[r.key] = r.value;
    if (Object.keys(next).length) { setDraft((d) => ({ ...d, ...next })); setEditing(true); }
  };
  const OCR_TONE = { DONE: 'violet', PENDING: 'slate', RUNNING: 'cyan', FAILED: 'red', SKIPPED: 'slate' };

  return (
    <div className="ad-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="ad-panel" role="dialog" aria-modal="true">
        <div className="ad-head">
          <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 4, background: accent }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: '#94a3b8' }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {chips.map((c, i) => <Pill key={i} tone={c.tone}>{c.label}</Pill>)}
          </div>
          <button className="ad-btn ad-btn--ghost" onClick={onClose} aria-label="Close" style={{ fontSize: 18, padding: '0 10px' }}>✕</button>
        </div>

        <div className="ad-body">
          {/* ── The paper ── */}
          <div className="ad-viewer">
            <div className="ad-tool">
              <span style={{ fontWeight: 700, color: '#cbd5e1' }}>📎 {fileLabel}</span>
              <span style={{ flex: 1 }} />
              {blob.url && <button className="ad-btn" style={{ minHeight: 32 }} onClick={() => window.open(blob.url, '_blank', 'noopener')}>↗ Open</button>}
              {blob.url && <button className="ad-btn" style={{ minHeight: 32 }} onClick={print}>🖨 Print</button>}
            </div>
            {!fileKey && (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#475569', fontSize: 13, padding: 24, textAlign: 'center' }}>
                <div><div style={{ fontSize: 40 }}>📄</div>No document attached to this row.<br />Manual and AI-scanned entries carry only their fields.</div>
              </div>
            )}
            {fileKey && blob.loading && <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#94a3b8', fontSize: 13 }}>Fetching from the vault…</div>}
            {fileKey && blob.error && <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#f87171', fontSize: 13 }}>Could not open the file ({blob.error})</div>}
            {blob.url && blob.kind === 'pdf' && <iframe ref={iframeRef} title="pdf" src={blob.url} />}
            {blob.url && blob.kind === 'image' && <img src={blob.url} alt={fileLabel} />}
            {blob.url && blob.kind === 'other' && (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#94a3b8', fontSize: 13 }}>
                This file type has no inline preview. <button className="ad-btn" onClick={() => window.open(blob.url, '_blank', 'noopener')}>Open it</button>
              </div>
            )}
          </div>

          {/* ── The facts and the decision ── */}
          <div className="ad-side">
            {liveAmount != null && Number.isFinite(Number(liveAmount)) && (
              <div>
                <div className="ad-label">{amountLabel}</div>
                <div className="ad-amount" style={{ color: accent }}>₹{Number(liveAmount).toLocaleString('en-IN')}</div>
              </div>
            )}

            {ocr && (
              <div className="ad-milan">
                <div className="ad-mhead">
                  <span>🔍 Milan — OCR vs paper</span>
                  <Pill tone={OCR_TONE[ocr.status] ?? 'slate'}>{ocr.status ?? 'PENDING'}</Pill>
                  {ocr.kind && <span className="ad-note">read as {String(ocr.kind).toLowerCase().replace(/_/g, ' ')}</span>}
                  {ocr.engine && <span className="ad-note">· {ocr.engine}</span>}
                  {ocr.at && <span className="ad-note">· {new Date(ocr.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                  <span style={{ flex: 1 }} />
                  {canDecide && ocrRows.some((r) => r.editable && !sameValue(r.current, r.value)) && (
                    <button className="ad-mbtn" onClick={useAllOcr}>Use all OCR values</button>
                  )}
                </div>
                {ocr.status === 'DONE' && ocr.match && ocr.match.total > 0 && (
                  <div style={{ display: 'grid', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ fontWeight: 900, color: ocr.match.score >= 80 ? '#34d399' : ocr.match.score >= 50 ? '#fbbf24' : '#f87171' }}>
                        Milan score {ocr.match.score}%
                      </span>
                      <span className="ad-note">{ocr.match.passed}/{ocr.match.total} checks against the trip and the masters</span>
                    </div>
                    {ocr.match.checks.map((c, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11.5, alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 900, color: c.ok ? '#34d399' : '#f87171' }}>{c.ok ? '✓' : '✗'}</span>
                        <span style={{ color: '#e2e8f0' }}>{c.name}</span>
                        {c.note && <span className="ad-note">— {c.note}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {(ocr.status === 'PENDING' || ocr.status === 'RUNNING') && (
                  <div className="ad-note">BHUVANESHWARI has not read this paper yet — papers are read one at a time off the request path. Refresh in a minute; the photo and the fields are already here to decide on.</div>
                )}
                {ocr.status === 'FAILED' && <div className="ad-note" style={{ color: '#fca5a5' }}>The reader could not read this paper{ocr.error ? ` — ${ocr.error}` : ''}. Decide from the photo; the fields are yours to fill.</div>}
                {ocr.status === 'DONE' && ocrRows.length === 0 && <div className="ad-note">The reader found no field it could name on this paper{ocr.confident === false ? '' : ''}. Everything it saw is below.</div>}
                {ocrRows.length > 0 && (
                  <div style={{ display: 'grid', gap: 5 }}>
                    <div className="ad-mrow" style={{ background: 'transparent', padding: '0 8px' }}>
                      <span className="k">field</span><span className="k">OCR read</span><span className="k">your value</span><span className="k" />
                    </div>
                    {ocrRows.map((r) => {
                      const match = sameValue(r.current, r.value);
                      const empty = r.current === '' || r.current == null;
                      return (
                        <div key={r.key} className="ad-mrow">
                          <span className="k">{r.label}</span>
                          <span className="ocr">{String(r.value)}</span>
                          <span className="v">{empty ? <span style={{ color: '#475569' }}>—</span> : String(r.current)}</span>
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <span title={match ? 'matches' : empty ? 'not filled yet' : 'differs from OCR'} style={{ fontWeight: 900, color: match ? '#34d399' : empty ? '#94a3b8' : '#fbbf24' }}>{match ? '✓' : empty ? '·' : '⚠'}</span>
                            {canDecide && r.editable && !match && <button className="ad-mbtn" onClick={() => useOcr(r.key, r.value)}>Use</button>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {ocr.status === 'DONE' && (Object.keys(ocr.raw ?? {}).length > 0 || ocr.text) && (
                  <div>
                    <button className="ad-btn ad-btn--ghost" style={{ minHeight: 26, fontSize: 11 }} onClick={() => setRawOpen((v) => !v)}>
                      {rawOpen ? '▴ hide' : '▾ everything the reader saw'} ({Object.keys(ocr.raw ?? {}).length} values{ocr.text ? ' + text' : ''})
                    </button>
                    {rawOpen && (
                      <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                        {Object.keys(ocr.raw ?? {}).length > 0 && (
                          <div className="ad-raw">{Object.entries(ocr.raw).map(([k, v]) => `${k}: ${v}`).join('\n')}</div>
                        )}
                        {ocr.text && <div className="ad-raw">{ocr.text}</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="ad-label" style={{ flex: 1 }}>Details</div>
              {canDecide && fields.some((f) => f.editable) && (
                <button className="ad-btn ad-btn--ghost" style={{ minHeight: 30, fontSize: 11.5 }} onClick={() => setEditing((v) => !v)}>
                  {editing ? '✓ Done editing' : '✎ Edit amount / details'}
                </button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {fields.map((f) => (
                <div key={f.key} className="ad-field" style={f.wide ? { gridColumn: '1 / -1' } : undefined}>
                  <div className="ad-label">{f.label}{f.editable && dirty && f.key in edits ? <span style={{ color: '#fbbf24' }}> · edited</span> : null}</div>
                  {editing && f.editable ? (
                    f.type === 'select' ? (
                      <select className="ad-input" value={draft[f.key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                        {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input className="ad-input" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                        inputMode={f.type === 'number' ? 'decimal' : undefined}
                        value={draft[f.key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
                    )
                  ) : (
                    <div className="ad-val">{f.render ? f.render(draft[f.key] ?? f.value) : (draft[f.key] ?? f.value ?? '') === '' ? <span style={{ color: '#475569' }}>—</span> : String(draft[f.key] ?? f.value)}</div>
                  )}
                  {f.hint && <div className="ad-note">{f.hint}</div>}
                </div>
              ))}
            </div>

            {children}

            {err && <div style={{ color: '#fca5a5', fontSize: 12.5, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)', borderRadius: 10, padding: '8px 10px' }}>❌ {err}</div>}

            {canDecide ? (
              <div style={{ display: 'grid', gap: 10, marginTop: 4 }}>
                {onSaveEdits && dirty && (
                  <button className="ad-btn" disabled={!!busy} onClick={() => run('save', async () => { await onSaveEdits(edits); setEditing(false); })}>
                    {busy === 'save' ? 'Saving…' : '💾 Save changes (stay pending)'}
                  </button>
                )}
                <div style={{ display: 'flex', gap: 10 }}>
                  {onApprove && (
                    <button className="ad-btn ad-btn--ok" style={{ flex: 2, minHeight: 48, fontSize: 14 }} disabled={!!busy || rejecting}
                      onClick={() => run('approve', () => onApprove(edits))}>
                      {busy === 'approve' ? 'Posting…' : dirty ? `${approveLabel} with edits` : approveLabel}
                    </button>
                  )}
                  {onReject && !rejecting && (
                    <button className="ad-btn ad-btn--no" style={{ flex: 1, minHeight: 48 }} disabled={!!busy} onClick={() => setRejecting(true)}>{rejectLabel}</button>
                  )}
                </div>
                {rejecting && (
                  <div className="ad-reason">
                    <div className="ad-label" style={{ color: '#fca5a5' }}>Reject — why? (the uploader is told this reason)</div>
                    <textarea className="ad-input" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. bill unclear / duplicate / amount does not match the slip" />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="ad-btn ad-btn--no" style={{ flex: 1 }} disabled={!reason.trim() || !!busy}
                        onClick={() => run('reject', () => onReject(reason.trim()))}>
                        {busy === 'reject' ? 'Rejecting…' : 'Confirm reject'}
                      </button>
                      <button className="ad-btn ad-btn--ghost" onClick={() => { setRejecting(false); setReason(''); }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#f59e0b', textAlign: 'center', padding: 12, background: 'rgba(245,158,11,0.08)', borderRadius: 10 }}>
                🔒 Only an Admin can decide this row. You can view and print.
              </div>
            )}
            {footnote && <div className="ad-note">{footnote}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
