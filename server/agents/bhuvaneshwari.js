// server/agents/bhuvaneshwari.js
// AGENT 04 — BHUVANESHWARI · Data Vault & Document OCR Parser
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { runIoclSync, SyncBusyError } from '../lib/ioclSyncRunner.js';
import { stmSet } from '../memory/okf.js';
import os from 'node:os';
import { query } from '../db/pool.js';
import { openStream } from '../lib/storage.js';
import { scanDocument } from '../services/universalScan.js';

const LIVE_TTL_MS = 15 * 60 * 1000;
// An invoice handed to TARA is not handed again for an hour. The parse stage
// re-reads the same mail every ten minutes and would otherwise re-propose an
// invoice TARA is still refusing (an unknown company, say) six times an hour.
const HANDOFF_TTL_MS = 60 * 60 * 1000;
const handedToTara = new Map();   // doc_no -> at

/**
 * Does not reinvent extraction. The ERP already has a working document
 * pipeline that this agent takes ownership of and moves server-side:
 *
 *   src/lib/billScanner.ts   (28 KB)  document classify + field extraction
 *   src/lib/tollParse.ts     (30 KB)  toll/FASTag statement parsing
 *   src/lib/aiScanner.ts               LLM vision wrapper
 *   SETTINGS.masterPrompt              the tuned "Mamta AI" extraction prompt
 *                                      already live in the database
 *
 * The prompt is deliberately data, not code — it has been tuned against real
 * IOCL challans and pump bills, and it must stay editable from the ERP UI
 * without a redeploy.
 *
 * The rule that matters here: OCR output is a PROPOSAL, never a posting. A
 * misread quantity on a petroleum challan is a ledger error measured in lakhs,
 * so extraction below the confidence threshold goes to human review and Tara is
 * never handed an unreviewed number.
 */
// ── DRIVER / PARTNER PAPERS (owner directive, 2026-09-02) ───────────────────
// Every photo a driver or partner stages (partner_documents, migration 132) is
// read HERE, off the request path: tesseract + patterns + the local model, one
// paper at a time, and only when the box has memory to spare (2 GB, shared
// with the WhatsApp engine). The result is a PROPOSAL written beside the photo
// (ocr_data) for the desk's side-by-side audit. Approve — a person — applies.
const OCR_MIN_FREE_MB = Number(process.env.OCR_MIN_FREE_MB ?? '220');
const OCR_MAX_PER_SWEEP = Number(process.env.OCR_MAX_PER_SWEEP ?? '3');
let ocrBusy = false;

async function readVaultFile(key) {
  const opened = await openStream(key);
  if (!opened?.stream) return null;
  const chunks = [];
  for await (const c of opened.stream) chunks.push(c);
  return Buffer.concat(chunks);
}

const NOISE = new Set(['ok', 'engine', 'engine_note', 'ocr_error', 'ocr_source', 'text_chars', 'text_excerpt', 'hash',
  'filename', 'matched_vehicle', 'vehicle_candidates', 'ai_filled_fields', 'needs_human', 'took_ms', 'all_dates', 'vehicle_regs']);
const firstOf = (obj, keys) => {
  for (const k of keys) { const v = obj[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return null;
};

/** Flatten a scan into { raw, suggest }: raw = every scalar the reader found,
 *  suggest = the ones the desk's fields understand, keyed by field name.
 *  Exported for the self-test; pure. */
export function proposalFor(docType, r) {
  const raw = {};
  const walk = (o, prefix) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (NOISE.has(k)) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined || v === '') continue;
      if (['string', 'number', 'boolean'].includes(typeof v)) raw[key] = v;
      else if (Array.isArray(v)) { if (v.length && ['string', 'number'].includes(typeof v[0])) raw[key] = v.slice(0, 6).join(', '); }
      else if (typeof v === 'object' && !prefix) walk(v, k);
    }
  };
  walk(r, '');
  const flat = { ...raw };
  for (const [k, v] of Object.entries(raw)) { const short = k.split('.').pop(); if (!(short in flat)) flat[short] = v; }
  const vehicle = r.matched_vehicle?.vehicle_no
    ?? (Array.isArray(r.vehicle_regs) && r.vehicle_regs.length === 1 ? r.vehicle_regs[0] : null);
  const suggest = {};
  const put = (field, v) => { if (v !== null && v !== undefined && v !== '') suggest[field] = v; };
  put('amount', firstOf(flat, ['total_amount', 'grand_total', 'net_amount', 'amount', 'total']));
  put('bill_no', firstOf(flat, ['invoice_no', 'bill_no', 'challan_no', 'gr_no', 'receipt_no', 'doc_number', 'number']));
  put('bill_date', firstOf(flat, ['document_date', 'bill_date', 'invoice_date', 'date']));
  put('vehicle_no', vehicle);
  put('qty', firstOf(flat, ['quantity', 'qty', 'net_qty', 'loaded_qty', 'gross_qty']));
  if (docType === 'DL') {
    put('license_no', firstOf(flat, ['licence_no', 'license_no', 'dl_no', 'number']));
    put('license_expiry', firstOf(flat, ['expiry', 'valid_upto', 'valid_till', 'expiry_date']));
  }
  if (docType === 'BANK_BOOK') {
    put('account_no', firstOf(flat, ['account_no', 'account_number', 'ac_no']));
    put('ifsc_code', firstOf(flat, ['ifsc', 'ifsc_code']));
    put('bank_name', firstOf(flat, ['bank_name', 'bank']));
  }
  if (docType === 'AADHAAR') {
    // Never propose the full number. The desk shows the last four; the admin
    // types the rest only if the office actually needs it on file.
    const a = String(firstOf(flat, ['aadhaar', 'aadhaar_no', 'aadhar_no', 'uid']) ?? '').replace(/\D/g, '');
    if (a.length === 12) suggest.aadhaar_last4 = a.slice(-4);
    for (const k of Object.keys(raw)) if (/aadha?ar|uid/i.test(k)) delete raw[k];
  }
  return {
    kind: r.kind ?? null, confident: !!r.confident, needs_human: !!r.needs_human,
    engine: r.engine ?? null, engine_note: r.engine_note ?? null, ocr_source: r.ocr_source ?? null,
    raw, suggest, took_ms: r.took_ms ?? null,
  };
}

// ── MILAN: the read against the records (owner's Tier 3, 2026-09-02) ───────
// Every check is a yes/no with a note the desk can show; the score is the
// share of checks that passed. A check that cannot run (no trip, no vehicle
// read) is simply not counted — a missing fact is not a failed match.
const normReg = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dayDiff = (a, b) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 864e5);
const BILL_KINDS = new Set(['HSD_BILL', 'TYRE_BILL', 'MAINTENANCE_BILL', 'TOLL_BILL', 'OTHER_BILL']);

export async function matchAgainstRecords(doc, data) {
  const checks = [];
  const add = (name, ok, note = null) => checks.push({ name, ok: !!ok, note });
  const S = data.suggest ?? {}; const R = data.raw ?? {};
  const veh = S.vehicle_no ?? null;
  const q = async (sql, params) => { try { return (await query(sql, params)).rows; } catch { return []; } };

  if (doc.trip_id) {
    const [t] = await q('SELECT trip_code, vehicle_no, loading_date, unloading_date, driver_name FROM trips WHERE id = $1::uuid', [doc.trip_id]);
    if (t) {
      if (veh) add('vehicle on the paper is the trip\'s lorry', normReg(veh) === normReg(t.vehicle_no), `${veh} vs ${t.vehicle_no ?? '—'} (${t.trip_code ?? 'trip'})`);
      const d = S.bill_date;
      if (d && t.loading_date && !Number.isNaN(new Date(d).getTime())) {
        const from = dayDiff(d, t.loading_date);
        const until = t.unloading_date ? dayDiff(t.unloading_date, d) : 15 - from;
        add('date falls in the trip window', from >= -2 && until >= -2,
            `${String(d).slice(0, 10)} vs ${String(t.loading_date).slice(0, 10)}${t.unloading_date ? ` → ${String(t.unloading_date).slice(0, 10)}` : ''}`);
      }
    }
  } else if (veh) {
    const rows = await q(`SELECT vehicle_no FROM vehicles WHERE regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') = $1 LIMIT 1`, [normReg(veh)]);
    add('vehicle is in the fleet master', rows.length > 0, veh);
  }

  const gst = firstOf(R, ['gst_no', 'gstin', 'gst', 'tax_id', 'seller_gstin', 'vendor_gstin']);
  if (gst) {
    const rows = await q('SELECT vendor_name FROM vendors WHERE upper(gst_no::text) = upper($1) LIMIT 1', [String(gst).trim()]);
    add('GST on the paper belongs to a known vendor', rows.length > 0, rows[0]?.vendor_name ?? String(gst));
  }

  if (BILL_KINDS.has(doc.doc_type)) {
    add('an amount was read', S.amount != null, S.amount != null ? `₹${S.amount}` : null);
    if (S.amount != null && doc.amount != null) {
      add('amount agrees with what the uploader typed', Math.abs(Number(S.amount) - Number(doc.amount)) < 1, `read ₹${S.amount} vs typed ₹${doc.amount}`);
    }
  }
  if (['LOADING_QTY', 'UNLOADING_QTY'].includes(doc.doc_type)) {
    add('a quantity was read', S.qty != null, S.qty != null ? String(S.qty) : null);
    if (S.qty != null && doc.qty != null) add('quantity agrees with what the driver typed', Math.abs(Number(S.qty) - Number(doc.qty)) < 0.01, `read ${S.qty} vs typed ${doc.qty}`);
  }
  if (doc.doc_type === 'DL' && doc.driver_id) {
    const [d] = await q('SELECT name, license_no FROM drivers WHERE id = $1::uuid', [doc.driver_id]);
    if (d?.license_no && S.license_no) add('licence number matches the driver on file', normReg(S.license_no) === normReg(d.license_no), `${S.license_no} vs ${d.license_no}`);
    if (d?.name) {
      const text = String(data.text_excerpt ?? '').toUpperCase();
      const tokens = String(d.name).toUpperCase().split(/\s+/).filter((w) => w.length > 2);
      if (tokens.length && text) add('driver\'s name appears on the licence', tokens.some((w) => text.includes(w)), d.name);
    }
  }
  const ok = checks.filter((c) => c.ok).length;
  return { score: checks.length ? Math.round((100 * ok) / checks.length) : null, passed: ok, total: checks.length, checks };
}

/** Read one staged paper. Returns 'done' | 'failed' | 'skipped' | 'busy' | 'lowmem'. */
export async function ocrPartnerDocument(id) {
  if (ocrBusy) return 'busy';
  const freeMb = Math.round(os.freemem() / 1048576);
  if (freeMb < OCR_MIN_FREE_MB) return 'lowmem';
  ocrBusy = true;
  try {
    const { rows } = await query(
      `UPDATE partner_documents SET ocr_status = 'RUNNING', ocr_at = now()
        WHERE id = $1::uuid
          AND (ocr_status IN ('PENDING', 'FAILED') OR (ocr_status = 'RUNNING' AND ocr_at < now() - interval '10 minutes'))
        RETURNING id, doc_type, file_key, uploader_name, uploader_role, trip_id, driver_id, amount, qty`, [id]);
    const doc = rows[0];
    if (!doc) return 'skipped';
    try {
      const buf = await readVaultFile(doc.file_key);
      if (!buf) throw new Error('file not in the vault');
      const r = await scanDocument(buf, {
        filename: doc.file_key.split('/').pop(),
        source: `partner_app:${doc.uploader_role.toLowerCase()}`,
        uploadedBy: doc.uploader_name,
      });
      const data = proposalFor(doc.doc_type, r);
      data.match = await matchAgainstRecords(doc, { ...data, text_excerpt: r.text_excerpt ?? '' });
      await query(
        `UPDATE partner_documents
            SET ocr_status = 'DONE', ocr_data = $2::jsonb, ocr_text = $3, ocr_engine = $4, ocr_at = now(), ocr_error = $5
          WHERE id = $1::uuid`,
        [id, JSON.stringify(data), r.text_excerpt ?? null,
         `${r.engine ?? 'patterns'}${r.ocr_source ? `/${r.ocr_source}` : ''}`, r.ocr_error ?? null]);
      return 'done';
    } catch (e) {
      await query(
        `UPDATE partner_documents SET ocr_status = 'FAILED', ocr_error = $2, ocr_at = now() WHERE id = $1::uuid`,
        [id, String(e.message).slice(0, 300)]);
      return 'failed';
    }
  } finally {
    ocrBusy = false;
  }
}

/** Catch-up: papers still unread (an event missed while the agent was down,
 *  a deferral for memory). Oldest first, a few per sweep, never in parallel. */
async function readUnreadPapers(limit = OCR_MAX_PER_SWEEP) {
  const { rows } = await query(
    `SELECT id, doc_type FROM partner_documents
      WHERE ocr_status = 'PENDING' OR (ocr_status = 'RUNNING' AND ocr_at < now() - interval '10 minutes')
      ORDER BY created_at LIMIT $1`, [limit]);
  let read = 0;
  for (const d of rows) {
    const r = await ocrPartnerDocument(d.id);
    if (r === 'done') read++;
    if (r === 'lowmem' || r === 'busy') break;
  }
  return { unread: rows.length, read };
}

export default defineAgent({
  id: 'AGENT_04',
  codename: 'BHUVANESHWARI',
  title: 'Data Vault & Document OCR Parser',
  domain: 'documents',
  mandate:
    'Owns every document that enters the ERP: E-Way bills, challans, driver licences, RCs, ' +
    'FASTag and toll statements, fuel slips, tyre and mechanic bills. Bhuvaneshwari ' +
    'classifies, extracts, stores the artefact in S3, and emits a structured proposal. ' +
    'It never posts financial data directly — extraction is always a proposal for review.',

  subscribes: [
    // A driver's or partner's photographed paper landed in partner_documents
    // (2026-09-02). Read it, write the proposal beside it, never post.
    'partner_document.submitted',
    'document.uploaded',
    'document.reparse.requested',
    'email.attachment.received',
    // THE BILLING CYCLE, FIRST HALF (owner's rule, 2-Sep-2026): every 10
    // minutes the graph asks Bhuvaneshwari to fetch and parse the AC5 freight
    // invoices from both IOCL mailboxes. Each one on no trip is handed to
    // TARA as invoice.parsed — a proposal. She never inserts the trip.
    'invoice.mail.sweep.requested',
  ],
  emits: [
    'document.classified',
    'document.extracted',
    'document.review.required',
    'document.extraction.failed',
    'fuel.slip.recorded',
    'toll.charge.recorded',
    'vehicle.document.updated',
    'driver.document.updated',
    'invoice.parsed',
    'invoice.sweep.completed',
  ],

  owns: {
    tables: ['documents', 'document_extractions', 'email_parsed_bills',
             // the OCR columns only (ocr_*); status / approval belong to the desk
             'partner_documents'],
    modules: ['BillScanner.tsx', 'CompanyInbox.tsx', 'lib/billScanner.ts',
              'lib/tollParse.ts', 'lib/aiScanner.ts'],
  },
  reads: ['vehicles', 'drivers', 'trips', 'vendors', 'settings'],

  mustNot: [
    'write a ledger entry from an extraction — it emits, TARA posts after review',
    'overwrite a human-corrected field with a re-parse; corrections win over OCR',
    'delete the source artefact after extraction (the S3 object is the evidence for an audit)',
    'accept an extraction below the confidence threshold without human review',
  ],

  guards: [
    { name: 'confidence_threshold',
      description: 'Extractions under OCR_MIN_CONFIDENCE (default 0.85) emit document.review.required instead of a value.' },
    { name: 'artefact_retained',
      description: 'The original file is persisted to S3 with its checksum before extraction runs.' },
    { name: 'no_silent_field_overwrite',
      description: 'A field marked human_verified is never replaced by a later parse.' },
    { name: 'vehicle_must_resolve',
      description: 'An extracted registration number must match an existing vehicle (normalised) or the doc goes to review.' },
  ],

  requires: ['documents', 'document_extractions', 'vehicles'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'document.uploaded': {
        const { doc_type, confidence, s3_key } = event.payload ?? {};
        if (!s3_key) return failed('document.uploaded carried no s3_key');

        const min = Number(process.env.OCR_MIN_CONFIDENCE ?? '0.85');
        if (confidence !== undefined && Number(confidence) < min) {
          await ctx.emit('document.review.required', {
            aggregate: 'document', aggregateId: event.aggregate_id,
            payload: { reason: `confidence ${confidence} below ${min}`, doc_type, s3_key },
            correlationId: event.correlation_id,
          });
          return blocked(`confidence ${confidence} < ${min} — routed to human review`);
        }
        return ok(`document accepted for extraction (${doc_type ?? 'unclassified'})`);
      }

      case 'document.reparse.requested':
        return ok('reparse queued — human-verified fields will be preserved');

      case 'partner_document.submitted': {
        const id = event.payload?.id ?? event.aggregate_id;
        if (!id) return failed('partner_document.submitted carried no id');
        const kind = event.payload?.doc_type ?? 'paper';
        const who = String(event.payload?.uploader_role ?? '').toLowerCase() || 'app';
        const r = await ocrPartnerDocument(id);
        if (r === 'lowmem') return blocked(`OCR deferred (box memory under ${OCR_MIN_FREE_MB} MB free) — the 10-minute sweep will read it`);
        if (r === 'busy') return blocked('OCR deferred (another paper is being read) — the 10-minute sweep will read it');
        if (r === 'failed') {
          stmSet('AGENT_04', 'live_action', `could not read a ${kind} from the ${who} app — desk shows the photo alone`, LIVE_TTL_MS);
          return failed(`OCR failed for ${kind} ${id}`);
        }
        stmSet('AGENT_04', 'live_action', `read a ${kind} from the ${who} app → proposal on the desk`, LIVE_TTL_MS);
        await ctx.emit('document.extracted', {
          aggregate: 'partner_document', aggregateId: id,
          payload: { id, doc_type: kind, uploader_role: event.payload?.uploader_role ?? null, result: r },
          correlationId: event.correlation_id,
        });
        return ok(`${kind} from the ${who} app read (${r})`);
      }

      case 'invoice.mail.sweep.requested': {
        // THE BILLING CYCLE, FIRST HALF. Fetch the AC5 freight invoices from
        // both IOCL mailboxes, parse the ones not yet on a trip, deduplicate
        // against the register — and INSERT NOTHING (apply: false). Every
        // new invoice goes to TARA as a proposal; she posts it into the trip
        // ledger. A truck-day a person typed with no invoice stays HELD for
        // that person, exactly as before. Same runner, same lock, same log
        // (/var/lib/prasad/logs/cron_sync.log, trigger 'bhuvaneshwari').
        // The driver / partner papers first: whatever is still unread.
        let papers = { unread: 0, read: 0 };
        try { papers = await readUnreadPapers(); }
        catch (err) { console.warn('[bhuvaneshwari] paper catch-up failed:', err.message); }

        let r;
        try {
          r = await runIoclSync({ stage: 'ac5', apply: false, trigger: 'bhuvaneshwari' });
        } catch (err) {
          if (err instanceof SyncBusyError) return blocked(`mail sync busy: ${err.message}`);
          const why = String(err.message).slice(0, 200);
          stmSet('AGENT_04', 'live_action', `AC5 parse failed: ${why.slice(0, 80)}`, LIVE_TTL_MS);
          return failed(`AC5 parse failed: ${why}`);
        }
        const now = Date.now();
        for (const [doc, at] of handedToTara) if (now - at > HANDOFF_TTL_MS) handedToTara.delete(doc);
        const fresh = [];
        for (const load of r.new_loads ?? []) {
          const doc = String(load.doc_no ?? '');
          if (!doc || handedToTara.has(doc)) continue;
          await ctx.emit('invoice.parsed', {
            aggregate: 'invoice',
            aggregateId: null,
            payload: { ...load, source: 'AC5', parsed_by: 'AGENT_04' },
            correlationId: event.correlation_id,
          });
          handedToTara.set(doc, now);
          fresh.push(doc);
        }
        const dead = r.mailboxes_failed ?? [];
        const line = `AC5 sweep: ${r.parsed ?? 0} parsed, ${r.duplicates ?? 0} already on trips, `
          + `${fresh.length} new → TARA, ${r.held_for_review ?? 0} held for a person`
          + (dead.length ? ` · mailbox down: ${dead.join(', ')}` : '')
          + (papers.read ? ` · ${papers.read} driver/partner paper(s) read` : '') + ` (${r.seconds}s)`;
        stmSet('AGENT_04', 'live_action', line, LIVE_TTL_MS);
        await ctx.emit('invoice.sweep.completed', {
          aggregate: 'invoices',
          payload: {
            parsed: r.parsed ?? 0, duplicates: r.duplicates ?? 0, new_to_tara: fresh,
            held_for_review: r.held_for_review ?? 0, mailboxes_failed: dead, seconds: r.seconds,
          },
          correlationId: event.correlation_id,
        });
        if (dead.length) return blocked(line);
        return ok(line);
      }

      default:
        return skipped(`no document rule for ${event.event_type}`);
    }
  },
});
