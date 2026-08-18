// server/modules/compliance.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// What is about to expire, and the compliance fees that were never posted.
//
// THE ALERT FEED IS NOT ONLY ABOUT LORRIES. vehicle_documents is empty — not
// one row for 49 trucks — so a compliance screen reading it alone truthfully
// reports nothing while six driver licences are already expired, three of them
// hazardous-goods endorsements. A driver whose HZD lapsed cannot legally take a
// petroleum load, which stops the lorry exactly as a lapsed fitness would. So
// the feed covers vehicle documents, the denormalised expiry columns, and
// driver licences together, at one threshold: v_compliance_alerts.
//
// THE RETROSPECTIVE POSTER HAS A HARD FLOOR. It posts compliance fees that were
// recorded without an accounting entry, but only for documents dated on or
// after the cut-off. Anything older is left alone deliberately: those costs
// belong to a closed year whose opening balances already absorb them, and
// posting them now would charge FY26-27 with expenses it did not incur. The
// floor is a parameter with no default that reaches the ledger — a caller has
// to say which year it means.
// ─────────────────────────────────────────────────────────────────────────────
import { createReadStream, existsSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { query, queryOne, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { parseDocumentText, normReg } from '../lib/docPatterns.js';
import { fileIntoStorage, driverDocKey, vehicleDocKey } from '../services/fileIntoStorage.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const COMPLIANCE_LEDGER = 'Vehicle Compliance & Docs';
const COMPLIANCE_GROUP = 'Direct Expenses (Vehicle Compliance & Docs)';
const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';

export async function registerComplianceRoutes(app) {
  // ── the dashboard feed ───────────────────────────────────────────────────
  app.get(
    '/alerts',
    { schema: { querystring: { type: 'object', properties: {
      within_days: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
      subject_kind: { type: ['string', 'null'], enum: ['VEHICLE', 'DRIVER', null] },
      include_valid: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = req.query;
      const { rows } = await query(
        `SELECT subject_kind, subject_id, subject, ownership, owner_name, branch,
                doc_type, doc_name, expires_on, days_left, status, amount,
                receipt_no, voucher_id, source
           FROM v_compliance_alerts
          WHERE ($1::int IS NULL OR days_left <= $1)
            AND ($2::text IS NULL OR subject_kind = $2)
            AND ($3::boolean OR status <> 'VALID')
          ORDER BY days_left ASC, subject
          LIMIT $4`,
        [q.within_days ?? null, q.subject_kind ?? null, q.include_valid === true, q.limit ?? 500]);

      // The window the view itself judges 'EXPIRING' by, so the dashboard can
      // say "10 days" without hardcoding a number the database might disagree
      // with later.
      const { rows: [{ days }] } = await query(`SELECT compliance_alert_days() AS days`);

      const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
      return {
        alert_window_days: Number(days),
        as_of: new Date().toISOString().slice(0, 10),
        counts: { EXPIRED: counts.EXPIRED ?? 0, EXPIRING: counts.EXPIRING ?? 0, VALID: counts.VALID ?? 0 },
        total: rows.length,
        alerts: rows,
      };
    }
  );

  // ── fees recorded but never posted ───────────────────────────────────────
  app.post(
    '/post-missing-expenses',
    { schema: { body: { type: 'object', required: ['from_date'], properties: {
      from_date: { type: 'string', format: 'date' },
      to_date: { type: ['string', 'null'], format: 'date' },
      account: { type: ['string', 'null'], maxLength: 120 },
      commit: { type: 'boolean', default: false },
      created_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { from_date, to_date = null, account = null, commit = false } = req.body ?? {};

      // inspected_on is this table's issue/payment date — the day the fee was
      // actually incurred. A document with no date at all cannot be placed in a
      // financial year, so it is reported rather than guessed into one.
      const { rows: docs } = await query(
        `SELECT d.id, d.doc_type, d.doc_name, d.inspected_on, d.amount, d.receipt_no,
                d.payment_mode, d.voucher_id,
                v.id AS vehicle_id, v.vehicle_no, v.branch, v.is_company_owned,
                l.ledger_name AS owner_ledger
           FROM vehicle_documents d
           JOIN vehicles v ON v.id = d.vehicle_id
           LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
          WHERE d.amount IS NOT NULL AND d.amount > 0
            AND d.voucher_id IS NULL
          ORDER BY d.inspected_on NULLS LAST, v.vehicle_no`);

      const posted = [], skipped = [], problems = [];
      for (const d of docs) {
        if (!d.inspected_on) {
          skipped.push({ vehicle: d.vehicle_no, doc: d.doc_type, why: 'no document date — cannot place it in a financial year' });
          continue;
        }
        const on = String(d.inspected_on).slice(0, 10);
        if (on < from_date) {
          skipped.push({ vehicle: d.vehicle_no, doc: d.doc_type, on,
                         why: `before the ${from_date} cut-off — belongs to a closed year` });
          continue;
        }
        if (to_date && on > to_date) {
          skipped.push({ vehicle: d.vehicle_no, doc: d.doc_type, on, why: `after ${to_date}` });
          continue;
        }

        const attached = !d.is_company_owned;
        if (attached && !d.owner_ledger) {
          problems.push({ vehicle: d.vehicle_no, doc: d.doc_type,
                          why: 'attached vehicle with no owner ledger — its cost has nowhere to go but P&L' });
          continue;
        }
        const debit = attached
          ? { ledger: d.owner_ledger, group: OWNER_GROUP }
          : { ledger: COMPLIANCE_LEDGER, group: COMPLIANCE_GROUP };

        const rec = { vehicle: d.vehicle_no, doc_type: d.doc_type, on,
                      amount: Number(d.amount), mode: attached ? 'ATTACHED' : 'OWNED',
                      debit: debit.ledger };
        if (!commit) { posted.push(rec); continue; }

        if (!account) {
          problems.push({ vehicle: d.vehicle_no, doc: d.doc_type,
                          why: 'a fee moves real money — name the bank or cash account it was paid from' });
          continue;
        }

        try {
          // Same reference shape the live hook uses, so a fee posted here and
          // the same fee re-saved through the document screen collide on TARA's
          // duplicate guard instead of being charged twice.
          const ref = `VEHDOC-${d.vehicle_id}-${d.doc_type}-${Number(d.amount).toFixed(2)}-${d.receipt_no ?? 'noref'}`;
          const voucher = await postVoucher({
            type: 'PAYMENT', account,
            party_ledger: debit.ledger, party_group: debit.group,
            amount: Number(d.amount), ref_no: ref, entry_date: on,
            narration: `${d.doc_name ?? d.doc_type} for ${d.vehicle_no}`
                     + `${d.receipt_no ? ` — receipt ${d.receipt_no}` : ''}`
                     + `${attached ? ' (attached — owner khata)' : ''}`,
            source_type: 'VEHICLE_COMPLIANCE',
            vehicle_id: d.vehicle_id, branch: d.branch,
            created_by: req.body.created_by ?? 'compliance-backfill',
          });
          await query(`UPDATE vehicle_documents SET voucher_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
            [d.id, voucher?.voucher_id ?? null]);
          posted.push({ ...rec, voucher_id: voucher?.voucher_id ?? null });
        } catch (e) {
          if (e.code === 'DUPLICATE_REF') { skipped.push({ ...rec, why: 'this exact fee is already posted' }); continue; }
          problems.push({ vehicle: d.vehicle_no, doc: d.doc_type, why: `${e.code ?? 'POST_FAILED'}: ${e.message}` });
        }
      }

      const sum = (l) => Number(l.reduce((a, x) => a + Number(x.amount || 0), 0).toFixed(2));
      return {
        ok: true, dry_run: !commit, cut_off: from_date,
        summary: {
          documents_with_unposted_fees: docs.length,
          postable: posted.length, posted_value: sum(posted),
          skipped: skipped.length, problems: problems.length,
          by_fleet: posted.reduce((a, p) => { a[p.mode] = (a[p.mode] ?? 0) + 1; return a; }, {}),
        },
        posted, skipped: skipped.slice(0, 50), problems: problems.slice(0, 50),
      };
    }
  );

  // ── what is MISSING, as opposed to what is expiring ──────────────────────
  // The alert feed cannot see absence: a lorry with no insurance row has no
  // date to pass, so it reads as green. Thirteen of forty-nine lorries were
  // green for exactly that reason. Absence and expiry are different failures —
  // "find this" versus "renew this" — so they are reported side by side.
  app.get(
    '/gaps',
    { schema: { querystring: { type: 'object', properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const limit = req.query?.limit ?? 100;
      const [{ rows: [summary] }, { rows: vehicles }, { rows: drivers }] = await Promise.all([
        query('SELECT * FROM v_compliance_gap_summary'),
        query(`SELECT vehicle_no, branch, owner_name, docs_held, missing_docs, undated_docs,
                      expired_count, expiring_count
                 FROM v_vehicle_gaps
                WHERE cardinality(missing_docs) > 0 OR expired_count > 0
                   OR expiring_count > 0 OR cardinality(undated_docs) > 0
                ORDER BY docs_held ASC, expired_count DESC, cardinality(missing_docs) DESC, vehicle_no
                LIMIT $1`, [limit]),
        query(`SELECT driver_id, name, mobile, missing_fields, licence_expired,
                      hazardous_expired, license_expiry, hzd_expiry
                 FROM v_driver_gaps
                WHERE cardinality(missing_fields) > 0 OR licence_expired OR hazardous_expired
                ORDER BY licence_expired DESC, hazardous_expired DESC,
                         cardinality(missing_fields) DESC, name
                LIMIT $1`, [limit]),
      ]);
      const { rows: [{ days }] } = await query('SELECT compliance_alert_days() AS days');
      return { alert_window_days: Number(days), summary, vehicles, drivers };
    }
  );

  // ── the unmapped queue ───────────────────────────────────────────────────
  // Paperwork the bulk importer could not place. It used to be skipped, which
  // made it invisible; invisible paperwork and paperwork nobody ever scanned
  // look identical from the screen. Now it queues here with a reason.
  app.get(
    '/unmapped',
    { schema: { querystring: { type: 'object', properties: {
      reason: { type: ['string', 'null'], enum: ['DRIVER_DOCUMENT', 'NO_VEHICLE_PROOF', 'MISFILED', 'UNCLASSIFIED', 'NO_EXPIRY', null] },
      // The question the clerk actually sorts by: not how it arrived, but what
      // is stopping it now.
      hold_reason: { type: ['string', 'null'], enum: ['WOULD_OVERWRITE', 'MULTIPLE_CANDIDATES', 'NO_COLUMN', 'NO_DRIVER', 'NEEDS_REVIEW', null] },
      status: { type: 'string', enum: ['PENDING', 'ASSIGNED', 'DISMISSED'], default: 'PENDING' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { reason = null, hold_reason = null, status = 'PENDING', limit = 200 } = req.query ?? {};
      const { rows } = await query(
        `SELECT u.id, u.source_path, u.file_hash, u.file_size, u.reason, u.reason_detail,
                COALESCE(u.hold_reason, 'NEEDS_REVIEW') AS hold_reason, u.hold_detail,
                u.suggested_scope, u.suggested_doc_type, u.suggested_doc_name,
                u.suggested_expiry, u.suggested_vehicle_id, v.vehicle_no AS suggested_vehicle_no,
                u.suggested_driver_id, d.name AS suggested_driver_name,
                -- What is already sitting in the slot this file would take, so
                -- the clerk can compare instead of overwriting blind.
                CASE u.suggested_doc_type
                  WHEN 'driver_dl'        THEN d.dl_photo_url
                  WHEN 'driver_hzd'       THEN d.hzd_photo_url
                  WHEN 'driver_aadhar'    THEN d.aadhar_photo_url
                  WHEN 'driver_pan'       THEN d.pan_photo_url
                  WHEN 'driver_bank'      THEN d.bank_photo_url
                  WHEN 'driver_photo'     THEN d.profile_pic_url
                  WHEN 'driver_police'    THEN d.police_verification_url
                  WHEN 'driver_voter'     THEN d.voter_id_url
                  WHEN 'driver_signature' THEN d.signature_url
                  WHEN 'driver_eye_test'  THEN d.eye_test_url
                END AS occupies_slot,
                u.scan_result, u.scanned_at, u.status, u.created_at
           FROM unmapped_documents u
           LEFT JOIN vehicles v ON v.id = u.suggested_vehicle_id
           LEFT JOIN drivers  d ON d.id = u.suggested_driver_id
          WHERE u.status = $1
            AND ($2::text IS NULL OR u.reason = $2)
            AND ($4::text IS NULL OR COALESCE(u.hold_reason, 'NEEDS_REVIEW') = $4)
          ORDER BY COALESCE(u.hold_reason, 'NEEDS_REVIEW'), d.name NULLS LAST, u.suggested_doc_type, u.source_path
          LIMIT $3`, [status, reason, limit, hold_reason]);
      const { rows: summary } = await query('SELECT * FROM v_unmapped_summary ORDER BY pending DESC');
      return { total: rows.length, summary, items: rows };
    }
  );

  // The queued file itself, so the browser can render it for the human and feed
  // it to the local scanner. Only ever serves the path this table recorded —
  // the id is looked up, never a caller-supplied path.
  app.get(
    '/unmapped/:id/file',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const doc = await queryOne('SELECT stored_path, source_path FROM unmapped_documents WHERE id = $1', [req.params.id]);
      if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (!existsSync(doc.stored_path)) {
        return reply.code(410).send({ error: 'FILE_GONE', detail: doc.stored_path });
      }
      const ext = extname(doc.stored_path).toLowerCase();
      const TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                      '.png': 'image/png', '.webp': 'image/webp' };
      reply.header('Content-Type', TYPES[ext] ?? 'application/octet-stream');
      reply.header('Content-Disposition', `inline; filename="${basename(doc.source_path).replace(/"/g, '')}"`);
      return reply.send(createReadStream(doc.stored_path));
    }
  );

  // ── Mamta AI Scan, server half ───────────────────────────────────────────
  // The browser does the reading (pdf.js -> Tesseract -> local LLM) and posts
  // the text here. The INTERPRETATION lives on the server, in docPatterns.js,
  // the same module the bulk importer uses. Two parsers would eventually
  // disagree about the same page, and a register nobody trusts is worse than a
  // register that is merely incomplete.
  app.post(
    '/unmapped/parse',
    { schema: { body: { type: 'object', required: ['text'], properties: {
      text: { type: 'string', maxLength: 200000 },
      id: { type: ['string', 'null'], format: 'uuid' },
      persist: { type: 'boolean', default: false },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { text, id = null, persist = false } = req.body ?? {};
      const { rows: vehicles } = await query('SELECT id, vehicle_no FROM vehicles');
      const known = new Map(vehicles.map((v) => [normReg(v.vehicle_no), v]));

      const parsed = parseDocumentText(text, known);
      const hits = parsed.vehicle_regs.map((r) => known.get(r)).filter(Boolean);
      // One registration on the page is a match. Two is a question for a human:
      // a permit naming both the lorry and its trailer must not be filed by
      // coin-toss.
      const vehicle = hits.length === 1 ? hits[0] : null;

      const result = {
        ...parsed,
        matched_vehicle: vehicle ? { id: vehicle.id, vehicle_no: vehicle.vehicle_no } : null,
        candidates: hits.map((v) => ({ id: v.id, vehicle_no: v.vehicle_no })),
        needs_human: !vehicle || !parsed.doc_type || !parsed.expiry_date,
      };

      if (id && persist) {
        await query(
          `UPDATE unmapped_documents
              SET scan_text = $2, scan_result = $3::jsonb, scanned_at = now(),
                  suggested_scope    = COALESCE($4, suggested_scope),
                  suggested_doc_type = COALESCE($5, suggested_doc_type),
                  suggested_doc_name = COALESCE($6, suggested_doc_name),
                  suggested_expiry   = COALESCE($7::date, suggested_expiry),
                  suggested_vehicle_id = COALESCE($8::uuid, suggested_vehicle_id),
                  updated_at = now()
            WHERE id = $1 AND status = 'PENDING'`,
          [id, text.slice(0, 100000), JSON.stringify(result), parsed.scope,
           parsed.doc_type, parsed.doc_name, parsed.expiry_date, vehicle?.id ?? null]);
      }
      return result;
    }
  );

  // ── accept a queued document ─────────────────────────────────────────────
  // A suggestion is written by the parser; an assignment is written by a
  // person. This is that second act, and it is the only path from the queue
  // into the register.
  app.post(
    '/unmapped/:id/assign',
    { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['scope'], properties: {
        scope: { type: 'string', enum: ['VEHICLE', 'DRIVER'] },
        vehicle_id: { type: ['string', 'null'], format: 'uuid' },
        driver_id: { type: ['string', 'null'], format: 'uuid' },
        doc_type: { type: ['string', 'null'], maxLength: 60 },
        doc_name: { type: ['string', 'null'], maxLength: 120 },
        expiry: { type: ['string', 'null'], format: 'date' },
        assigned_by: { type: ['string', 'null'], maxLength: 60 },
      } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { id } = req.params;
      const b = req.body ?? {};
      const doc = await queryOne('SELECT * FROM unmapped_documents WHERE id = $1', [id]);
      if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (doc.status !== 'PENDING') return reply.code(409).send({ error: 'ALREADY_RESOLVED', status: doc.status });

      if (b.scope === 'VEHICLE') {
        const vehicleId = b.vehicle_id ?? doc.suggested_vehicle_id;
        const docType = b.doc_type ?? doc.suggested_doc_type;
        if (!vehicleId || !docType) return reply.code(400).send({ error: 'NEED_VEHICLE_AND_TYPE' });
        // A date the operator typed is authoritative. A date the parser guessed
        // from an uncued line is not, and must never quietly replace one that is
        // already on the record: a scan that misreads an issue date as an expiry
        // would otherwise turn a valid document into an overdue one, and the
        // good date is gone with no way to tell it happened.
        const expiryTyped = Boolean(b.expiry);
        const scanCued = doc.scan_result?.expiry_cued === true;
        const expiryTrusted = expiryTyped || scanCued;
        const row = await queryOne(
          `INSERT INTO vehicle_documents (vehicle_id, doc_type, doc_name, next_due_date, document_url, remarks)
           VALUES ($1,$2,$3,$4::date,$5,$6)
           ON CONFLICT (vehicle_id, doc_type) DO UPDATE
             SET doc_name = EXCLUDED.doc_name,
                 next_due_date = CASE
                   WHEN $7::boolean THEN EXCLUDED.next_due_date
                   WHEN vehicle_documents.next_due_date IS NULL THEN EXCLUDED.next_due_date
                   ELSE vehicle_documents.next_due_date END,
                 document_url = EXCLUDED.document_url, remarks = EXCLUDED.remarks, updated_at = now()
           RETURNING id, next_due_date`,
          [vehicleId, docType, b.doc_name ?? doc.suggested_doc_name ?? docType,
           b.expiry ?? doc.suggested_expiry, doc.stored_path,
           `assigned from unmapped queue: ${doc.source_path}`, expiryTrusted]);
        await query(
          `UPDATE unmapped_documents SET status='ASSIGNED', resolved_kind='VEHICLE_DOCUMENT',
                  resolved_ref=$2, resolved_by=$3, resolved_at=now(), updated_at=now() WHERE id=$1`,
          [id, row.id, b.assigned_by ?? null]);
        const proposed = String(b.expiry ?? doc.suggested_expiry ?? '');
        return {
          ok: true, kind: 'VEHICLE_DOCUMENT', ref: row.id,
          next_due_date: row.next_due_date,
          // Say so out loud when a guessed date was refused, rather than letting
          // the screen display a value the database did not accept.
          expiry_kept_existing: !expiryTrusted && proposed !== '' &&
            String(row.next_due_date ?? '').slice(0, 10) !== proposed.slice(0, 10),
        };
      }

      // DRIVER: `drivers` already has a column per document, so the file goes
      // to the column it belongs in rather than a generic attachment bucket.
      const driverId = b.driver_id ?? doc.suggested_driver_id;
      if (!driverId) return reply.code(400).send({ error: 'NEED_DRIVER' });
      const COLUMN = {
        driver_dl: 'dl_photo_url', driver_hzd: 'hzd_photo_url', driver_aadhar: 'aadhar_photo_url',
        driver_pan: 'pan_photo_url', driver_bank: 'bank_photo_url', driver_photo: 'profile_pic_url',
        // Added in migration 093 — these four used to be readable but unfilable.
        driver_police: 'police_verification_url', driver_voter: 'voter_id_url',
        driver_signature: 'signature_url', driver_eye_test: 'eye_test_url',
      };
      const wanted = b.doc_type ?? doc.suggested_doc_type;
      const col = COLUMN[wanted];
      if (!col) {
        return reply.code(400).send({
          error: 'NO_COLUMN_FOR_TYPE',
          detail: `drivers has no column for '${wanted}'. Add one, or dismiss this with a note saying where it went.`,
        });
      }
      // Publish the bytes where the app serves documents from. Writing
      // doc.stored_path straight in sets the column and leaves it unopenable.
      let servedUrl;
      try {
        servedUrl = await fileIntoStorage(doc.stored_path, driverDocKey(driverId, col));
      } catch (e) {
        return reply.code(500).send({ error: 'STORAGE_FAILED', detail: e.message });
      }
      await query(`UPDATE drivers SET ${col} = $2 WHERE id = $1`, [driverId, servedUrl]);
      // The DATE columns are what the alert feed reads, so a document that
      // carries an expiry sets its own. A police verification records when it
      // was done instead: it is a point-in-time check, not a licence.
      const exp = b.expiry ?? doc.suggested_expiry;
      const expCol = { driver_dl: 'license_expiry', driver_hzd: 'hzd_expiry',
                       driver_eye_test: 'eye_test_expiry', driver_police: 'police_verified_on' }[wanted];
      if (exp && expCol) await query(`UPDATE drivers SET ${expCol} = $2::date WHERE id = $1`, [driverId, exp]);
      await query(
        `UPDATE unmapped_documents SET status='ASSIGNED', resolved_kind='DRIVER',
                resolved_ref=$2, resolved_by=$3, resolved_at=now(), updated_at=now() WHERE id=$1`,
        [id, driverId, b.assigned_by ?? null]);
      return { ok: true, kind: 'DRIVER', ref: driverId, column: col };
    }
  );

  app.post(
    '/unmapped/:id/dismiss',
    { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', properties: { note: { type: ['string', 'null'], maxLength: 300 },
                                            dismissed_by: { type: ['string', 'null'], maxLength: 60 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const r = await queryOne(
        `UPDATE unmapped_documents SET status='DISMISSED', dismiss_note=$2, resolved_by=$3,
                resolved_at=now(), updated_at=now()
          WHERE id=$1 AND status='PENDING' RETURNING id`,
        [req.params.id, req.body?.note ?? null, req.body?.dismissed_by ?? null]);
      if (!r) return reply.code(409).send({ error: 'NOT_PENDING' });
      return { ok: true };
    }
  );
}
