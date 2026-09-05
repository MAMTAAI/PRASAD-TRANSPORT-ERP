// server/modules/gst.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// GST (GTA) 360° — output under RCM / forward charge, input tax credit, net
// payable, GSTR-1 / GSTR-3B packs (migration 171).
//
//   GET  /overview                          per firm: profile, FY totals, gaps, last deep audit
//   POST /audit                             run the deep audit (classify customers, backfill bills, capture ITC, sync filings)
//   PATCH /firms/:id                        GSTIN, scheme (RCM / FCM_5 / FCM_12 / UNREGISTERED), filing, state, SAC, prefix
//   GET  /periods?firm                      month rows: output (RCM shown / FCM), ITC, net payable, filings
//   GET  /output?firm&period&customer       the documents the government will see (AC5 bills + our invoices)
//   PATCH /customers/:id                    treatment / rate / GSTIN (locks the choice; unlocked drafts refresh)
//   PUT  /docs/:kind/:no                    recipient GSTIN + place of supply for one document
//   GET  /itc?firm&period&all               the ITC register (monthly toll/diesel rows folded unless all=1)
//   POST /itc · PATCH /itc/:id              manual purchase invoice; invoice details / exclude
//   POST /itc/2b-upload                     multipart GSTR-2B (JSON / CSV / XLSX) → match the register
//   GET  /2b?firm&period                    uploaded 2B lines and the match
//   GET  /returns?firm                      filings with the month's numbers
//   PATCH /returns/:id                      status / ARN / filed date
//   GET  /export/gstr1?firm&period&format   csv (b2b) · json (portal) · xlsx (all sheets)
//   GET  /export/gstr3b?firm&period&format  csv · xlsx
//   GET  /export/itc?firm&period            csv
//   GET  /export/ca-pack?firm&period        one workbook for the CA
// ─────────────────────────────────────────────────────────────────────────────
import multipart from '@fastify/multipart';
import { query } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { gstr1Sheets, gstr1Json, gstr3bRows, itcRows, attentionRows, workbook, csvOf, parse2b, periodLabel } from '../lib/gstExport.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^(0[1-9]|1[0-2])\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export async function registerGstRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';
  const send = (reply, name, type, body) => reply.header('Content-Type', type).header('Content-Disposition', `attachment; filename="${name}"`).send(body);
  const sendCsv = (reply, name, rows) => send(reply, name, 'text/csv; charset=utf-8', '﻿' + csvOf(rows));
  const states = async () => Object.fromEntries((await query('SELECT code, name FROM gst_states')).rows.map((r) => [r.code, r.name]));
  const firmOf = async (id) => (await query('SELECT * FROM v_gst_overview WHERE company_id = $1::uuid', [id])).rows[0];
  const badFirm = (reply) => reply.code(400).send({ error: 'BAD_FIRM', detail: 'firm must be a company id' });
  const badPeriod = (reply) => reply.code(400).send({ error: 'BAD_PERIOD', detail: 'period must be MMYYYY, e.g. 082026' });
  try { await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }); } catch { /* registered upstream */ }

  const docsFor = async (firm, period, opts = {}) => {
    const where = ['d.company_id = $1::uuid']; const args = [firm];
    if (period) { args.push(period); where.push(`d.period = $${args.length}`); }
    if (opts.customer) { args.push(opts.customer); where.push(`d.customer_id = $${args.length}::uuid`); }
    if (!opts.includeDrafts) where.push(`d.doc_status = 'ISSUED'`);
    const { rows } = await query(`SELECT d.* FROM v_gst_output_docs d WHERE ${where.join(' AND ')} ORDER BY d.doc_date, d.doc_no`, args);
    return rows;
  };
  const monthRow = async (firm, period) => (await query(`SELECT * FROM v_gst_net_month WHERE company_id = $1::uuid AND period = $2`, [firm, period])).rows[0]
    ?? { fcm_taxable: 0, fcm_igst: 0, fcm_cgst: 0, fcm_sgst: 0, rcm_taxable: 0, rcm_tax: 0, exempt_taxable: 0, gst_purchases: 0, itc_igst: 0, itc_cgst: 0, itc_sgst: 0, itc_eligible: 0, itc_blocked: 0, exempt_inward: 0, non_gst_inward: 0, pay_igst: 0, pay_cgst: 0, pay_sgst: 0, net_payable: 0, carry_igst: 0, carry_cgst: 0, carry_sgst: 0 };
  const itcFor = async (firm, period, all = false) => (await query(`SELECT * FROM gst_itc_register WHERE company_id = $1::uuid AND ($2::text IS NULL OR period = $2) ${all ? '' : `AND source_kind <> 'LEDGER_MONTH'`} ORDER BY invoice_date DESC NULLS LAST, created_at DESC`, [firm, period ?? null])).rows;
  const markExported = async (firm, period, form, by) => query(`INSERT INTO gst_filings (company_id, period, form, due_date, status, exported_at, updated_by) VALUES ($1::uuid, $2, $3, gst_due($3, $2, (SELECT gst_filing FROM companies WHERE id = $1::uuid), (SELECT gst_state_code FROM companies WHERE id = $1::uuid)), 'EXPORTED', now(), $4)
    ON CONFLICT (company_id, period, form) DO UPDATE SET status = CASE WHEN gst_filings.status = 'DRAFT' THEN 'EXPORTED' ELSE gst_filings.status END, exported_at = now(), updated_by = $4, updated_at = now()`, [firm, period, form, by]).catch(() => {});

  // ── overview ──────────────────────────────────────────────────────────
  app.get('/overview', staff, async () => {
    const { rows: firms } = await query(`SELECT * FROM v_gst_overview ORDER BY company_name`);
    const { rows: months } = await query(`SELECT * FROM v_gst_net_month WHERE gst_period_start(period) >= '2026-04-01' ORDER BY period DESC`);
    const { rows: [last] } = await query(`SELECT ran_at, ran_by, summary FROM gst_audit_runs ORDER BY ran_at DESC LIMIT 1`);
    const { rows: filings } = await query(`SELECT f.*, c.company_name FROM gst_filings f JOIN companies c ON c.id = f.company_id ORDER BY f.due_date DESC, c.company_name, f.form`);
    const { rows: customers } = await query(`SELECT id, customer_name, gst_no, gst_mode, gst_pct, gst_registered, is_body_corporate, gst_state_code, gst_note, gst_mode_locked, gstin_valid(gst_no::text) AS gstin_valid, (SELECT count(*)::int FROM customer_bills b WHERE b.customer_id = customers.id AND b.status <> 'CANCELLED') AS bills FROM customers ORDER BY bills DESC, customer_name`);
    const cur = (await query(`SELECT gst_period_of(current_date) AS p, gst_period_of((current_date - interval '1 month')::date) AS prev`)).rows[0];
    return { today: new Date().toISOString().slice(0, 10), current_period: cur.p, previous_period: cur.prev, firms, months, filings, customers, last_audit: last ?? null,
      notes: ['GTA is exempt from e-invoicing (Notification 13/2020) — no IRN needed on these invoices.', 'Under reverse charge the invoice shows the GST the recipient pays; it never enters our receivable.', 'ITC is availed only under the 12% forward-charge option; under RCM / 5% it stays on record as blocked.'] };
  });

  app.post('/audit', admin, async (req) => {
    const { rows: [r] } = await query(`SELECT gst_deep_audit($1) AS summary`, [actor(req)]);
    return { summary: r.summary };
  });

  app.patch('/firms/:id', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return badFirm(reply);
    const b = req.body ?? {}; const sets = []; const args = [id]; const put = (c, v) => { args.push(v); sets.push(`${c} = $${args.length}`); };
    if (b.gstin !== undefined) {
      const g = String(b.gstin ?? '').trim().toUpperCase();
      if (g) {
        const { rows: [v] } = await query(`SELECT gstin_valid($1) AS ok, gstin_pan($1) AS pan, gstin_state($1) AS st`, [g]);
        if (!v.ok) return reply.code(400).send({ error: 'BAD_GSTIN', detail: 'Not a valid GSTIN (format or check digit)' });
        const { rows: [c] } = await query(`SELECT upper(btrim(pan_no)) AS pan FROM companies WHERE id = $1::uuid`, [id]);
        if (c?.pan && v.pan !== c.pan) return reply.code(400).send({ error: 'PAN_MISMATCH', detail: `The PAN inside this GSTIN (${v.pan}) is not the firm's PAN (${c.pan})` });
        put('gstin', g); put('gst_state_code', v.st); put('gstin_source', `entered by ${actor(req)}`);
      } else { put('gstin', null); }
    }
    if (['RCM', 'FCM_5', 'FCM_12', 'UNREGISTERED'].includes(b.gst_scheme)) put('gst_scheme', b.gst_scheme);
    if (['MONTHLY', 'QRMP'].includes(b.gst_filing)) put('gst_filing', b.gst_filing);
    if (b.gst_state_code !== undefined && /^\d{2}$/.test(String(b.gst_state_code))) put('gst_state_code', String(b.gst_state_code));
    if (b.gst_sac !== undefined && /^\d{6}$/.test(String(b.gst_sac))) put('gst_sac', String(b.gst_sac));
    if (b.gst_invoice_prefix !== undefined) put('gst_invoice_prefix', String(b.gst_invoice_prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || null);
    if (b.gst_scheme_note !== undefined) put('gst_scheme_note', b.gst_scheme_note || null);
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    sets.push('updated_at = now()');
    await query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1::uuid`, args);
    if (b.gst_scheme) await query(`SELECT gst_itc_capture()`).catch(() => {});
    await query(`SELECT gst_filings_sync()`).catch(() => {});
    return { firm: await firmOf(id) };
  });

  // ── periods / output ──────────────────────────────────────────────────
  app.get('/periods', staff, async (req, reply) => {
    const firm = req.query.firm; if (!UUID_RE.test(firm ?? '')) return badFirm(reply);
    const { rows } = await query(`SELECT m.*, gst_period_label(m.period) AS label,
        (SELECT jsonb_agg(jsonb_build_object('id', f.id, 'form', f.form, 'status', f.status, 'due_date', f.due_date, 'arn', f.arn, 'filed_at', f.filed_at, 'exported_at', f.exported_at) ORDER BY f.form) FROM gst_filings f WHERE f.company_id = m.company_id AND f.period = m.period) AS filings
       FROM v_gst_net_month m WHERE m.company_id = $1::uuid AND gst_period_start(m.period) >= '2026-04-01' ORDER BY m.period DESC`, [firm]);
    return { rows };
  });

  app.get('/output', staff, async (req, reply) => {
    const { firm, period, customer } = req.query; if (!UUID_RE.test(firm ?? '')) return badFirm(reply);
    if (period && !PERIOD_RE.test(period)) return badPeriod(reply);
    const rows = await docsFor(firm, period || null, { customer: UUID_RE.test(customer ?? '') ? customer : null, includeDrafts: true });
    const issued = rows.filter((r) => r.doc_status === 'ISSUED');
    const sum = (k, f = () => true) => r2(issued.filter(f).reduce((s, r) => s + Number(r[k] || 0), 0));
    return { rows, totals: { issued: issued.length, drafts: rows.length - issued.length, rcm_taxable: sum('taxable', (r) => r.treatment === 'RCM'), rcm_tax: sum('gst_amount', (r) => r.treatment === 'RCM'), fcm_taxable: sum('taxable', (r) => r.treatment === 'FORWARD'), fcm_tax: sum('gst_amount', (r) => r.treatment === 'FORWARD'), exempt_taxable: sum('taxable', (r) => r.treatment === 'EXEMPT'), attention: issued.filter((r) => r.needs).length } };
  });

  app.patch('/customers/:id', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {}; const sets = []; const args = [id]; const put = (c, v) => { args.push(v); sets.push(`${c} = $${args.length}`); };
    if (['RCM', 'FORWARD', 'EXEMPT'].includes(b.gst_mode)) { put('gst_mode', b.gst_mode); put('gst_mode_locked', true); put('gst_note', `${b.gst_mode} chosen by ${actor(req)}`); }
    if (b.gst_pct !== undefined && [0, 5, 12, 18].includes(Number(b.gst_pct))) put('gst_pct', Number(b.gst_pct));
    if (b.is_body_corporate !== undefined) put('is_body_corporate', !!b.is_body_corporate);
    if (b.gst_no !== undefined) {
      const g = String(b.gst_no ?? '').trim().toUpperCase();
      if (g) {
        const { rows: [v] } = await query(`SELECT gstin_valid($1) AS ok, gstin_state($1) AS st`, [g]);
        if (!v.ok) return reply.code(400).send({ error: 'BAD_GSTIN', detail: 'Not a valid GSTIN (format or check digit)' });
        put('gst_no', g); put('gst_state_code', v.st); put('gst_registered', true);
      } else { put('gst_no', null); put('gst_registered', false); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    sets.push('updated_at = now()');
    const { rows: [c] } = await query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING id, customer_name, gst_no, gst_mode, gst_pct, gst_state_code, gst_registered, is_body_corporate, gst_mode_locked`, args);
    const { rows: drafts } = await query(`SELECT id FROM customer_bills WHERE customer_id = $1::uuid AND locked_at IS NULL AND status <> 'CANCELLED'`, [id]);
    for (const d of drafts) await query(`SELECT customer_bill_refresh($1::uuid)`, [d.id]).catch(() => {});
    await query(`SELECT gst_bills_backfill()`).catch(() => {});
    return { customer: c, drafts_refreshed: drafts.length };
  });

  app.put('/docs/:kind/:no', admin, async (req, reply) => {
    const { kind, no } = req.params; if (!['AC5', 'BILL'].includes(kind)) return reply.code(400).send({ error: 'BAD_KIND' });
    const b = req.body ?? {}; const g = b.recipient_gstin ? String(b.recipient_gstin).trim().toUpperCase() : null;
    if (g) { const { rows: [v] } = await query(`SELECT gstin_valid($1) AS ok`, [g]); if (!v.ok) return reply.code(400).send({ error: 'BAD_GSTIN', detail: 'Not a valid GSTIN (format or check digit)' }); }
    const posv = b.place_of_supply ? String(b.place_of_supply).slice(0, 2) : (g ? g.slice(0, 2) : null);
    await query(`INSERT INTO gst_doc_overrides (doc_kind, doc_no, recipient_gstin, place_of_supply, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (doc_kind, doc_no) DO UPDATE SET recipient_gstin = EXCLUDED.recipient_gstin, place_of_supply = EXCLUDED.place_of_supply, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`, [kind, no, g, posv, b.note ?? null, actor(req)]);
    const { rows: [d] } = await query(`SELECT * FROM v_gst_output_docs WHERE doc_kind = $1 AND doc_no = $2`, [kind, no]);
    return { doc: d ?? null };
  });

  // ── ITC ───────────────────────────────────────────────────────────────
  app.get('/itc', staff, async (req, reply) => {
    const { firm, period } = req.query; if (!UUID_RE.test(firm ?? '')) return badFirm(reply);
    if (period && !PERIOD_RE.test(period)) return badPeriod(reply);
    const rows = await itcFor(firm, period || null, req.query.all === '1');
    const { rows: months } = await query(`SELECT * FROM v_gst_itc_month WHERE company_id = $1::uuid AND ($2::text IS NULL OR period = $2) ORDER BY period DESC`, [firm, period || null]);
    return { rows, months };
  });

  app.post('/itc', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!UUID_RE.test(b.company_id ?? '') || !b.category || b.amount_total === undefined) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'company_id, category and amount_total are required' });
    const gst = r2(num(b.gst_amount) ?? 0); const inter = !!b.inter_state;
    const { rows: [r] } = await query(`INSERT INTO gst_itc_register (company_id, source_kind, source_id, period, invoice_no, invoice_date, supplier_name, supplier_gstin, category, description, amount_total, taxable_value, gst_rate, cgst, sgst, igst, gst_amount, gst_known, edited_by, edited_at)
      VALUES ($1::uuid, 'MANUAL', gen_random_uuid()::text, gst_period_of(coalesce($5::date, current_date)), $2, $3, $4, $17, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now()) RETURNING *`,
      [b.company_id, b.invoice_no ?? null, DATE_RE.test(b.invoice_date ?? '') ? b.invoice_date : null, b.supplier_name ?? null, DATE_RE.test(b.invoice_date ?? '') ? b.invoice_date : null, b.category, b.description ?? null, r2(b.amount_total), num(b.taxable_value), num(b.gst_rate), inter ? 0 : r2(gst / 2), inter ? 0 : r2(gst - r2(gst / 2)), inter ? gst : 0, gst, gst > 0, actor(req), b.supplier_gstin ? String(b.supplier_gstin).toUpperCase() : null]);
    await query(`SELECT gst_itc_capture()`);
    return { row: (await query(`SELECT * FROM gst_itc_register WHERE id = $1`, [r.id])).rows[0] };
  });

  app.patch('/itc/:id', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {}; const sets = []; const args = [id]; const put = (c, v) => { args.push(v); sets.push(`${c} = $${args.length}`); };
    if (b.supplier_gstin !== undefined) put('supplier_gstin', b.supplier_gstin ? String(b.supplier_gstin).trim().toUpperCase() : null);
    if (b.supplier_name !== undefined) put('supplier_name', b.supplier_name || null);
    if (b.invoice_no !== undefined) put('invoice_no', b.invoice_no || null);
    if (b.invoice_date !== undefined && (b.invoice_date === null || DATE_RE.test(b.invoice_date))) { put('invoice_date', b.invoice_date); if (b.invoice_date) { args.push(b.invoice_date); sets.push(`period = gst_period_of($${args.length}::date)`); } }
    if (b.category !== undefined) put('category', String(b.category).toUpperCase());
    if (b.company_id !== undefined && UUID_RE.test(b.company_id)) put('company_id', b.company_id);
    if (b.taxable_value !== undefined) put('taxable_value', num(b.taxable_value));
    if (b.gst_rate !== undefined) put('gst_rate', num(b.gst_rate));
    if (b.gst_amount !== undefined) {
      const gst = r2(num(b.gst_amount) ?? 0); const inter = !!b.inter_state;
      put('gst_amount', gst); put('igst', inter ? gst : 0); put('cgst', inter ? 0 : r2(gst / 2)); put('sgst', inter ? 0 : r2(gst - r2(gst / 2))); put('gst_known', gst > 0);
    }
    if (b.status === 'EXCLUDED' || b.status === 'CAPTURED') put('status', b.status);
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    put('edited_by', actor(req)); sets.push('edited_at = now()', 'updated_at = now()');
    await query(`UPDATE gst_itc_register SET ${sets.join(', ')} WHERE id = $1::uuid`, args);
    await query(`UPDATE gst_itc_register r SET eligibility = e.eligibility, eligibility_reason = e.reason FROM (SELECT x.id, el.* FROM gst_itc_register x CROSS JOIN LATERAL gst_itc_eligibility(x.company_id, x.category, x.supplier_gstin, x.gst_known) el WHERE x.id = $1::uuid) e WHERE e.id = r.id`, [id]);
    return { row: (await query(`SELECT * FROM gst_itc_register WHERE id = $1::uuid`, [id])).rows[0] };
  });

  app.post('/itc/2b-upload', admin, async (req, reply) => {
    let part; try { part = await req.file(); } catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
    if (!part) return reply.code(400).send({ error: 'NO_FILE' });
    const fields = Object.fromEntries(Object.entries(part.fields ?? {}).map(([k, v]) => [k, v?.value]));
    const firm = fields.firm; const period = fields.period;
    if (!UUID_RE.test(firm ?? '')) return badFirm(reply); if (!PERIOD_RE.test(period ?? '')) return badPeriod(reply);
    const buf = await part.toBuffer();
    let lines; try { lines = parse2b(buf, part.filename ?? ''); } catch (e) { return reply.code(400).send({ error: 'PARSE_FAILED', detail: e.message }); }
    let inserted = 0;
    for (const l of lines) {
      const { rowCount } = await query(`INSERT INTO gst_2b_lines (company_id, period, supplier_gstin, supplier_name, invoice_no, invoice_date, invoice_value, taxable_value, igst, cgst, sgst, itc_available)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (company_id, period, supplier_gstin, invoice_no) DO UPDATE SET supplier_name = EXCLUDED.supplier_name, invoice_date = EXCLUDED.invoice_date, invoice_value = EXCLUDED.invoice_value, taxable_value = EXCLUDED.taxable_value, igst = EXCLUDED.igst, cgst = EXCLUDED.cgst, sgst = EXCLUDED.sgst, itc_available = EXCLUDED.itc_available, uploaded_at = now()`,
        [firm, period, l.supplier_gstin, l.supplier_name, l.invoice_no, l.invoice_date, l.invoice_value, l.taxable_value, l.igst, l.cgst, l.sgst, l.itc_available]);
      inserted += rowCount;
    }
    // match: same supplier GSTIN + invoice number (case/space-insensitive); amounts within ₹1 → MATCHED, else AMOUNT_DIFF
    await query(`UPDATE gst_2b_lines t SET matched_itc_id = m.id, match_state = CASE WHEN abs(coalesce(m.gst_amount, 0) - (t.igst + t.cgst + t.sgst)) <= 1 THEN 'MATCHED' ELSE 'AMOUNT_DIFF' END
      FROM gst_itc_register m WHERE t.company_id = $1::uuid AND t.period = $2 AND m.company_id = t.company_id AND m.supplier_gstin = t.supplier_gstin
        AND regexp_replace(upper(coalesce(m.invoice_no, '')), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(t.invoice_no), '[^A-Z0-9]', '', 'g')`, [firm, period]);
    await query(`UPDATE gst_itc_register m SET status = 'MATCHED_2B', gstr2b_ref = t.invoice_no, updated_at = now() FROM gst_2b_lines t WHERE t.matched_itc_id = m.id AND t.company_id = $1::uuid AND t.period = $2 AND m.status IN ('CAPTURED', 'NOT_IN_2B')`, [firm, period]);
    await query(`UPDATE gst_itc_register m SET status = 'NOT_IN_2B', updated_at = now() WHERE m.company_id = $1::uuid AND m.period = $2 AND m.eligibility = 'ELIGIBLE' AND m.status = 'CAPTURED' AND NOT EXISTS (SELECT 1 FROM gst_2b_lines t WHERE t.matched_itc_id = m.id)`, [firm, period]);
    const { rows: [s] } = await query(`SELECT count(*)::int AS lines, count(*) FILTER (WHERE match_state = 'MATCHED')::int AS matched, count(*) FILTER (WHERE match_state = 'AMOUNT_DIFF')::int AS amount_diff, count(*) FILTER (WHERE match_state = 'UNMATCHED')::int AS unmatched, coalesce(sum(igst + cgst + sgst), 0)::numeric(14,2) AS tax FROM gst_2b_lines WHERE company_id = $1::uuid AND period = $2`, [firm, period]);
    return { parsed: lines.length, upserted: inserted, ...s };
  });

  app.get('/2b', staff, async (req, reply) => {
    const { firm, period } = req.query; if (!UUID_RE.test(firm ?? '')) return badFirm(reply); if (!PERIOD_RE.test(period ?? '')) return badPeriod(reply);
    const { rows } = await query(`SELECT t.*, m.category, m.description AS book_description, m.gst_amount AS book_gst FROM gst_2b_lines t LEFT JOIN gst_itc_register m ON m.id = t.matched_itc_id WHERE t.company_id = $1::uuid AND t.period = $2 ORDER BY t.match_state, t.supplier_gstin, t.invoice_no`, [firm, period]);
    const { rows: notIn2b } = await query(`SELECT * FROM gst_itc_register WHERE company_id = $1::uuid AND period = $2 AND status = 'NOT_IN_2B' ORDER BY invoice_date`, [firm, period]);
    return { rows, not_in_2b: notIn2b };
  });

  // ── returns ───────────────────────────────────────────────────────────
  app.get('/returns', staff, async (req, reply) => {
    const firm = req.query.firm; if (firm && !UUID_RE.test(firm)) return badFirm(reply);
    await query(`SELECT gst_filings_sync()`).catch(() => {});
    const { rows } = await query(`SELECT f.*, c.company_name, gst_period_label(f.period) AS label, m.docs, m.docs_needing_attention, m.rcm_taxable, m.rcm_tax, m.fcm_taxable, m.output_tax, m.itc_eligible, m.itc_blocked, m.net_payable, m.needs_invoice, m.no_gstin,
        CASE WHEN f.status IN ('FILED','NIL') THEN 'DONE' WHEN f.due_date < current_date THEN 'OVERDUE' WHEN f.due_date <= current_date + 7 THEN 'DUE_SOON' ELSE 'OPEN' END AS urgency
       FROM gst_filings f JOIN companies c ON c.id = f.company_id LEFT JOIN v_gst_net_month m ON m.company_id = f.company_id AND m.period = f.period
      WHERE ($1::uuid IS NULL OR f.company_id = $1::uuid) ORDER BY f.period DESC, c.company_name, f.form`, [firm || null]);
    return { rows };
  });

  app.patch('/returns/:id', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {}; const sets = []; const args = [id]; const put = (c, v) => { args.push(v); sets.push(`${c} = $${args.length}`); };
    if (['DRAFT', 'EXPORTED', 'FILED', 'NIL'].includes(b.status)) put('status', b.status);
    if (b.arn !== undefined) put('arn', b.arn || null);
    if (b.filed_at !== undefined && (b.filed_at === null || DATE_RE.test(b.filed_at))) put('filed_at', b.filed_at);
    if (b.note !== undefined) put('note', b.note || null);
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    put('updated_by', actor(req)); sets.push('updated_at = now()');
    const { rows: [f] } = await query(`UPDATE gst_filings SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING *`, args);
    return { filing: f };
  });

  // ── exports ───────────────────────────────────────────────────────────
  const exportCtx = async (req, reply) => {
    const { firm, period } = req.query;
    if (!UUID_RE.test(firm ?? '')) { badFirm(reply); return null; }
    if (!PERIOD_RE.test(period ?? '')) { badPeriod(reply); return null; }
    const f = await firmOf(firm); if (!f) { reply.code(404).send({ error: 'NOT_FOUND' }); return null; }
    return { firm: f, period, states: await states(), tag: `${(f.gst_invoice_prefix ?? 'FIRM')}_${f.gstin ?? 'NOGSTIN'}_${period}` };
  };

  app.get('/export/gstr1', staff, async (req, reply) => {
    const c = await exportCtx(req, reply); if (!c) return;
    const docs = await docsFor(c.firm.company_id, c.period, { includeDrafts: req.query.include_drafts === '1' });
    if (req.query.include_drafts === '1') for (const d of docs) if (d.doc_status === 'DRAFT') d.doc_status = 'ISSUED';
    const format = String(req.query.format ?? 'xlsx').toLowerCase();
    await markExported(c.firm.company_id, c.period, 'GSTR1', actor(req));
    if (format === 'json') return send(reply, `GSTR1_${c.tag}.json`, 'application/json', JSON.stringify(gstr1Json(docs, c.firm, c.period, c.states), null, 2));
    const sh = gstr1Sheets(docs, c.firm, c.states);
    if (format === 'csv') return sendCsv(reply, `GSTR1_b2b_${c.tag}.csv`, sh.b2b);
    return send(reply, `GSTR1_${c.tag}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook({ b2b: sh.b2b, exemp: sh.exemp, hsn: sh.hsn, docs: sh.docs, attention: [['Document', 'Customer', 'Taxable', 'Needs'], ...sh.issues.map((i) => [i.doc, i.customer, i.taxable, i.needs])] }));
  });

  app.get('/export/gstr3b', staff, async (req, reply) => {
    const c = await exportCtx(req, reply); if (!c) return;
    const m = await monthRow(c.firm.company_id, c.period);
    const rows = gstr3bRows(m, c.firm, c.period);
    await markExported(c.firm.company_id, c.period, 'GSTR3B', actor(req));
    if (String(req.query.format ?? 'xlsx').toLowerCase() === 'csv') return sendCsv(reply, `GSTR3B_${c.tag}.csv`, rows);
    return send(reply, `GSTR3B_${c.tag}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook({ GSTR3B: rows }));
  });

  app.get('/export/itc', staff, async (req, reply) => {
    const c = await exportCtx(req, reply); if (!c) return;
    return sendCsv(reply, `ITC_${c.tag}.csv`, itcRows(await itcFor(c.firm.company_id, c.period, true)));
  });

  app.get('/export/ca-pack', staff, async (req, reply) => {
    const c = await exportCtx(req, reply); if (!c) return;
    const docs = await docsFor(c.firm.company_id, c.period, { includeDrafts: true });
    const issued = docs.filter((d) => d.doc_status === 'ISSUED');
    const sh = gstr1Sheets(issued, c.firm, c.states);
    const m = await monthRow(c.firm.company_id, c.period);
    const itc = await itcFor(c.firm.company_id, c.period, true);
    const { rows: twoB } = await query(`SELECT t.*, m.description AS book_description FROM gst_2b_lines t LEFT JOIN gst_itc_register m ON m.id = t.matched_itc_id WHERE t.company_id = $1::uuid AND t.period = $2 ORDER BY t.match_state, t.supplier_gstin`, [c.firm.company_id, c.period]);
    const summary = [['GST pack for the CA'], [`${c.firm.company_name}`, `GSTIN ${c.firm.gstin ?? 'NOT ON FILE'}`, `PAN ${c.firm.pan_no ?? ''}`], [`Period ${periodLabel(c.period)}`, `Scheme ${c.firm.gst_scheme}`, `Filing ${c.firm.gst_filing}`], [],
      ['Outward documents (issued)', issued.length], ['Outward under reverse charge — taxable', m.rcm_taxable], ['  GST shown, payable by the recipients', m.rcm_tax], ['Outward under forward charge — taxable', m.fcm_taxable], ['  Output tax (IGST / CGST / SGST)', m.fcm_igst, m.fcm_cgst, m.fcm_sgst], ['Exempt outward', m.exempt_taxable], ['Drafts not yet invoiced', docs.length - issued.length], [],
      ['Purchases carrying GST', m.gst_purchases], ['ITC eligible (IGST / CGST / SGST)', m.itc_igst, m.itc_cgst, m.itc_sgst], ['ITC on record but blocked under the scheme', m.itc_blocked], ['Exempt inward (toll)', m.exempt_inward], ['Non-GST inward (diesel)', m.non_gst_inward], ['Purchase entries awaiting their invoice', m.needs_invoice + m.no_gstin], [],
      ['NET GST PAYABLE IN CASH', m.net_payable], ['  IGST / CGST / SGST', m.pay_igst, m.pay_cgst, m.pay_sgst], ['  ITC carried forward', m.carry_igst, m.carry_cgst, m.carry_sgst], [],
      ['GSTR-1 due', ...(await query(`SELECT gst_due('GSTR1', $1, $2, $3)::text AS d`, [c.period, c.firm.gst_filing, c.firm.gst_state_code])).rows.map((r) => r.d)], ['GSTR-3B due', ...(await query(`SELECT gst_due('GSTR3B', $1, $2, $3)::text AS d`, [c.period, c.firm.gst_filing, c.firm.gst_state_code])).rows.map((r) => r.d)],
      [], ['Notes'], ['GTA is exempt from e-invoicing (Notification 13/2020).'], ['Reverse-charge supplies: GSTR-1 table 4B with reverse charge = Y; 3B placement of the RCM outward value to be confirmed by the CA.'], ['ITC under RCM / 5% is not availed (Sec 17(3), Notification 11/2017 condition); shown for the record.']];
    await markExported(c.firm.company_id, c.period, 'GSTR1', actor(req)); await markExported(c.firm.company_id, c.period, 'GSTR3B', actor(req));
    return send(reply, `GST_CA_PACK_${c.tag}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook({
      Summary: summary, 'GSTR1 b2b': sh.b2b, 'GSTR1 exemp': sh.exemp, 'GSTR1 hsn': sh.hsn, 'GSTR1 docs': sh.docs, GSTR3B: gstr3bRows(m, c.firm, c.period), 'ITC register': itcRows(itc),
      'GSTR2B recon': [['Match', 'Supplier GSTIN', 'Supplier', 'Invoice', 'Date', 'Taxable', 'IGST', 'CGST', 'SGST', 'ITC available', 'Book entry'], ...twoB.map((t) => [t.match_state, t.supplier_gstin, t.supplier_name ?? '', t.invoice_no, t.invoice_date ? String(t.invoice_date).slice(0, 10) : '', t.taxable_value, t.igst, t.cgst, t.sgst, t.itc_available === null ? '' : t.itc_available ? 'Y' : 'N', t.book_description ?? ''])],
      Attention: attentionRows(docs, itc),
      Documents: [['Kind', 'Document', 'Date', 'Customer', 'Recipient GSTIN', 'POS', 'Supply', 'Treatment', 'Rate', 'Taxable', 'IGST', 'CGST', 'SGST', 'GST', 'Payable by', 'Invoice value', 'Status', 'Needs'], ...docs.map((d) => [d.doc_kind, d.doc_no, d.doc_date ? String(d.doc_date).slice(0, 10) : '', d.customer_name, d.recipient_gstin ?? '', d.place_of_supply ?? '', d.supply_type, d.treatment, d.rate, d.taxable, d.igst, d.cgst, d.sgst, d.gst_amount, d.payable_by, d.invoice_value, d.doc_status, d.needs ?? ''])],
    }));
  });
}
