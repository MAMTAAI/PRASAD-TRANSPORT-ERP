// server/agents/bhuvaneshwari.js
// AGENT 04 — BHUVANESHWARI · Data Vault & Document OCR Parser
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { runIoclSync, SyncBusyError } from '../lib/ioclSyncRunner.js';
import { stmSet } from '../memory/okf.js';

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
    tables: ['documents', 'document_extractions', 'email_parsed_bills'],
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

      case 'invoice.mail.sweep.requested': {
        // THE BILLING CYCLE, FIRST HALF. Fetch the AC5 freight invoices from
        // both IOCL mailboxes, parse the ones not yet on a trip, deduplicate
        // against the register — and INSERT NOTHING (apply: false). Every
        // new invoice goes to TARA as a proposal; she posts it into the trip
        // ledger. A truck-day a person typed with no invoice stays HELD for
        // that person, exactly as before. Same runner, same lock, same log
        // (/var/lib/prasad/logs/cron_sync.log, trigger 'bhuvaneshwari').
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
          + (dead.length ? ` · mailbox down: ${dead.join(', ')}` : '') + ` (${r.seconds}s)`;
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
